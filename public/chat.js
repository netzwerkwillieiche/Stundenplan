// --- chat ---
// Ende-zu-Ende-verschluesselter Chat samt Schluesselverwaltung. Alles
// Kryptografische passiert hier im Browser - der Server sieht nur Kauderwelsch.
import { $, $$, api, avatarEl, bestaetigen, courseHue, dmy, eingabe, h, kursName, nameOf, oops, setzeKinder, state, toast } from './kern.js';
import { emojiGruppen, letzteEmoji, merkeEmoji } from './emoji.js';
import { malBadges, zahlen } from './menue.js';

// --- Ende-zu-Ende-Verschluesselung fuer den Chat ----------------------------
// Alles Kryptografische passiert hier im Browser. Der Server bekommt nur Kauderwelsch zu sehen -
// und den oeffentlichen Schluessel, den er weitergeben muss.
//
// Aufbau: jeder hat ein ECDH-P-256-Paar. Der oeffentliche Teil liegt offen beim Server, der
// private mit AES-GCM verschlossen; der Schluessel dafuer kommt per PBKDF2 aus dem Login-Passwort.
// Nach dem Entpacken liegt der private Schluessel als *nicht exportierbarer* CryptoKey in
// IndexedDB - dadurch bleibt der Chat nach dem Neuladen lesbar, ohne dass das Passwort irgendwo
// gespeichert wird.
//
// ponytail: ein Paar pro Nutzer, kein Forward Secrecy. Wer alte Chiffrate mitgeschnitten hat und
// spaeter an den privaten Schluessel kommt, kann sie lesen. Fuer einen Klassenchat angemessen;
// das Upgrade waere ein Doppelratchet mit Schluesseln pro Nachricht.

const PBKDF2_RUNDEN = 210_000;
const KEY_DB = 'stundenplan-keys';

// Stueckweise: `String.fromCharCode(...bytes)` reicht fuer ein paar hundert Zeichen, sprengt bei
// einem Bild aber den Aufrufstapel (RangeError bei rund 100 KB). Mit Anhaengen ist das kein
// Sonderfall mehr, sondern der Normalfall.
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
const vonB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// IndexedDB als schmaler Schluesselspeicher - localStorage kann keine CryptoKeys halten, und
// genau darauf beruht, dass der private Schluessel nicht auslesbar ist.
const keyStore = (modus, arbeit) => new Promise((ok, weg) => {
  const anfrage = indexedDB.open(KEY_DB, 1);
  anfrage.onupgradeneeded = () => anfrage.result.createObjectStore('keys');
  anfrage.onerror = () => weg(anfrage.error);
  anfrage.onsuccess = () => {
    const tx = anfrage.result.transaction('keys', modus);
    const r = arbeit(tx.objectStore('keys'));
    tx.oncomplete = () => { anfrage.result.close(); ok(r.result); };
    tx.onerror = () => { anfrage.result.close(); weg(tx.error); };
  };
});

// Der oeffentliche Schluessel wird mit abgelegt. Klingt ueberfluessig - er steht ja beim Server -
// ist aber der einzige Weg zu erkennen, ob der private hier noch DAZU passt. Genau daran hing der
// Chat fest: eine aeltere Fassung hat das Paar bei jedem Passwortwechsel ersetzt, in der
// IndexedDB blieb der alte private Schluessel liegen, und "ein Schluessel ist da" galt als
// entsperrt. Ergebnis: jede Nachricht unlesbar, in beide Richtungen, ohne Hinweis.
const merkeKey = (id, key, pub) => keyStore('readwrite', s => {
  s.put(key, 'priv-' + id);
  return s.put(pub, 'pub-' + id);
});
const holeKey = id => keyStore('readonly', s => s.get('priv-' + id));
const holePub = id => keyStore('readonly', s => s.get('pub-' + id));
export const vergissKeys = () => keyStore('readwrite', s => s.clear());

// Aus dem Passwort einen Schluessel machen, mit dem der private Schluessel verpackt wird.
async function passwortKey(passwort, salt) {
  const roh = await crypto.subtle.importKey('raw', new TextEncoder().encode(passwort),
    'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_RUNDEN, hash: 'SHA-256' },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Ein- und Auspacken getrennt von der Schluesselerzeugung: nur so laesst sich beim
// Passwortwechsel derselbe Schluessel neu verpacken, statt ein neues Paar zu erzeugen.
async function einpacken(rohPkcs8, passwort) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const huelle = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
    await passwortKey(passwort, salt), rohPkcs8);
  return [b64(salt), b64(iv), b64(huelle)].join(':');
}

async function auspacken(priv_key_enc, passwort) {
  const [salt, iv, daten] = String(priv_key_enc).split(':');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: vonB64(iv) },
    await passwortKey(passwort, vonB64(salt)), vonB64(daten));
}

// Nicht exportierbar einlesen: was in der IndexedDB liegt, soll kein Skript herausholen koennen.
const alsPrivatKey = roh => crypto.subtle.importKey('pkcs8', roh,
  { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);

async function paarErzeugen(passwort) {
  const paar = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true,
    ['deriveKey', 'deriveBits']);
  const pub = await crypto.subtle.exportKey('jwk', paar.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', paar.privateKey);
  return {
    pub_key: JSON.stringify(pub),
    priv_key_enc: await einpacken(priv, passwort),
    privateKey: await alsPrivatKey(priv),
  };
}

const paarOeffnen = async (priv_key_enc, passwort) =>
  alsPrivatKey(await auspacken(priv_key_enc, passwort));

// Schluessel einrichten: oeffnen, wenn es schon einen gibt, sonst anlegen. Beides braucht das
// Passwort - der private Teil liegt nur damit verschlossen beim Server.
//
// Frueher lief das ausschliesslich beim ausdruecklichen Anmelden. Wer angemeldet blieb (also fast
// jeder, das Cookie haelt 180 Tage) hatte auf seinem Geraet nie einen Schluessel und konnte
// deshalb keine einzige Nachricht lesen. Deshalb laesst sich das jetzt jederzeit nachholen.
export async function schluesselEinrichten(passwort) {
  if (!globalThis.crypto?.subtle) return { moeglich: false };
  try {
    const { pub_key, priv_key_enc } = await api('GET', '/api/me/keys');
    if (pub_key && priv_key_enc) {
      try {
        await merkeKey(state.me.id, await paarOeffnen(priv_key_enc, passwort), pub_key);
        pubCache.clear(); nachgeholt.clear();
        return { moeglich: true, neu: false };
      } catch {
        // Falsches Passwort - oder ein Admin hat es zurueckgesetzt, dann passt der hinterlegte
        // Schluessel nicht mehr dazu. Von hier aus ist beides nicht zu unterscheiden, deshalb
        // wird NICHT einfach ein neues Paar erzeugt: bei einem Tippfehler waere sonst der ganze
        // Verlauf weg. Die Entscheidung trifft der Nutzer.
        return { moeglich: true, falsch: true };
      }
    }
    const paar = await paarErzeugen(passwort);
    await api('PUT', '/api/me/keys', { pub_key: paar.pub_key, priv_key_enc: paar.priv_key_enc });
    await merkeKey(state.me.id, paar.privateKey, paar.pub_key);
    return { moeglich: true, neu: true };
  } catch {
    return { moeglich: false };
  }
}

/**
 * Bewusst von vorn: neues Paar, der alte Verlauf bleibt unlesbar. Nur nach Rueckfrage.
 *
 * Das Passwort wird ZUERST geprueft. Ohne die Pruefung wird ein Tippfehler mit eingebacken - das
 * neue Paar waere dann genauso wenig zu oeffnen wie das alte, und der Notausgang haette den
 * Schaden verdoppelt statt ihn zu beheben.
 */
export async function chatNeuAnfangen(passwort) {
  await api('POST', '/api/me/passwort-pruefen', { password: passwort });
  const paar = await paarErzeugen(passwort);
  await api('PUT', '/api/me/keys',
    { pub_key: paar.pub_key, priv_key_enc: paar.priv_key_enc, ersetzen: true });
  await merkeKey(state.me.id, paar.privateKey, paar.pub_key);
  pubCache.clear(); nachgeholt.clear();
}

/**
 * Liegt auf diesem Geraet ein Schluessel, der zum aktuellen Konto passt? Die zweite Haelfte der
 * Frage ist die wichtige: ein veralteter Schluessel ist schlimmer als gar keiner, weil er sich
 * wie "alles in Ordnung" anfuehlt und trotzdem nichts entschluesselt.
 */
async function chatEntsperrt() {
  const id = state.me?.id;
  if (!id) return false;
  const priv = await holeKey(id).catch(() => null);
  if (!priv) return false;

  const { pub_key } = await api('GET', '/api/me/keys').catch(() => ({ pub_key: undefined }));
  // Konnte der Server nicht gefragt werden, wissen wir nichts - und werfen dann auch nichts weg.
  // Sonst kostet ein Funkloch den Schluessel auf dem Geraet und man muss neu entsperren.
  if (pub_key === undefined) return true;
  const lokal = await holePub(id).catch(() => null);
  if (pub_key && lokal && lokal === pub_key) return true;

  // Passt nicht - dann lieber neu entsperren als still nichts lesen.
  await keyStore('readwrite', s => { s.delete('priv-' + id); return s.delete('pub-' + id); })
    .catch(() => {});
  return false;
}

// Beim Passwortwechsel wird derselbe Schluessel neu eingepackt, nicht ersetzt. Frueher entstand
// hier ein frisches Paar - damit war der Verlauf auf allen anderen Geraeten schlagartig unlesbar,
// obwohl nichts verloren war. Das Formular kennt beide Passwoerter, also geht es einfach.
// Drei Ausgaenge, und die muessen unterschieden werden: frueher lief alles in dasselbe `null`, der
// Aufrufer liess das Feld dann weg, und das Passwort wurde trotzdem geaendert. Ab da war der
// Schluessel mit einem Passwort verschlossen, das es nicht mehr gab. Ein Funkloch hat gereicht.
export async function schluesselUmpacken(altesPasswort, neuesPasswort) {
  let priv_key_enc;
  try {
    ({ priv_key_enc } = await api('GET', '/api/me/keys'));
  } catch {
    return { netzfehler: true };
  }
  if (!priv_key_enc) return { nichts: true };   // noch kein Schluessel - nichts zu verlieren
  try {
    return { key: await einpacken(await auspacken(priv_key_enc, altesPasswort), neuesPasswort) };
  } catch {
    return { passtNicht: true };
  }
}

// Gemeinsamer Schluessel aus meinem privaten und dem oeffentlichen des Gegenuebers. Beide Seiten
// rechnen denselben aus - deshalb genuegt ein Chiffrat pro Nachricht.
const pubCache = new Map();
const nachgeholt = new Set();
async function chatSchluessel(anderer, frisch = false) {
  const priv = await holeKey(state.me.id);
  if (!priv) return null;
  if (frisch || !pubCache.has(anderer)) {
    const { pub_key } = await api('GET', `/api/keys/${anderer}`);
    pubCache.set(anderer, pub_key ? JSON.parse(pub_key) : null);
  }
  const jwk = pubCache.get(anderer);
  if (!jwk) return null;
  const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** In einer Gruppe gilt der Gruppenschluessel, sonst der des Paares. */
async function verschluesselnFuer(ziel, text) {
  if (ziel?.kurs) return null;   // Kurschat: nicht Ende-zu-Ende, der Server verschluesselt
  if (ziel?.gruppe) return mitKey(ziel, text);
  return chatVerschluesseln(ziel.id, text);
}

async function entschluesselnVon(ziel, blob) {
  if (!ziel?.gruppe) return chatEntschluesseln(ziel.id, blob);
  const key = await gruppenKey(ziel.gruppe);
  if (!key) return null;
  const [iv, daten] = String(blob).split(':');
  try {
    const roh = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vonB64(iv) }, key, vonB64(daten));
    return new TextDecoder().decode(roh);
  } catch { return null; }
}

async function chatVerschluesseln(anderer, text) {
  // Immer frisch: der Zwischenspeicher wird nur geleert, wenn ICH meinen Schluessel wechsle - nie,
  // wenn das Gegenueber es tut. Wer den Chat offen hat, waehrend der andere neu anfaengt, schrieb
  // sonst Nachrichten, die nur er selbst lesen kann. Ein GET pro Nachricht ist bei dieser Menge
  // nichts; beim Entschluesseln bleibt der Zwischenspeicher, dort wirkt er.
  const key = await chatSchluessel(anderer, true);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(text));
  return b64(iv) + ':' + b64(daten);
}

/** Rohe Bytes mit demselben Schluessel verschluesseln wie der Text. */
async function dateiVerschluesseln(ziel, bytes) {
  if (ziel?.kurs) return b64(bytes);   // Kurschat: im Klartext hoch, der Server verschluesselt
  const key = ziel?.gruppe ? await gruppenKey(ziel.gruppe) : await chatSchluessel(ziel.id, true);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return b64(iv) + ':' + b64(daten);
}

async function dateiEntschluesseln(ziel, blob) {
  const [iv, daten] = String(blob).split(':');
  const key = ziel?.gruppe ? await gruppenKey(ziel.gruppe) : await chatSchluessel(ziel.id, false);
  if (!key) return null;
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: vonB64(iv) }, key, vonB64(daten));
}

async function chatEntschluesseln(anderer, blob) {
  const [iv, daten] = String(blob).split(':');
  // Zweimal: beim zweiten Mal wird der oeffentliche Schluessel des Gegenuebers frisch geholt.
  // Der Zwischenspeicher haelt so lange, wie die Seite offen ist - wer den Chat offen hat,
  // waehrend das Gegenueber seinen Schluessel neu anlegt, rechnet sonst bis zum Neuladen mit dem
  // alten weiter und liest nichts mehr. Genau das faellt als "geht nicht" auf.
  for (const frisch of [false, true]) {
    if (frisch && nachgeholt.has(anderer)) return null;   // einmal pro Sitzung genuegt
    try {
      const key = await chatSchluessel(anderer, frisch);
      if (frisch) nachgeholt.add(anderer);
      if (!key) return null;
      const roh = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vonB64(iv) }, key, vonB64(daten));
      return new TextDecoder().decode(roh);
    } catch {
      if (frisch) return null;
    }
  }
  return null;
}

// --- Gruppenschluessel ------------------------------------------------------
// Eine Gruppe hat EINEN AES-Schluessel. Fuer jedes Mitglied wird er mit dem Paar-Geheimnis aus
// dem Einzelchat verpackt - dasselbe ECDH, das es schon gibt, nur einmal mehr angewandt. Der
// Server verwahrt Chiffrat und weiss nicht, was darin steht.

/** Einen frischen Gruppenschluessel erzeugen (exportierbar - er muss ja verpackt werden). */
const gruppenKeyNeu = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

/** Den Gruppenschluessel fuer ein Mitglied verpacken. */
async function keyVerpacken(fuerId, key) {
  const paar = await chatSchluessel(fuerId, true);
  if (!paar) return null;
  const roh = await crypto.subtle.exportKey('raw', key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, paar, roh);
  return b64(iv) + ':' + b64(daten);
}

/** Und wieder auspacken - der Absender ist der, der ihn verpackt hat. */
async function keyAuspacken(vonId, blob) {
  const [iv, daten] = String(blob ?? '').split(':');
  if (!daten) return null;
  const paar = await chatSchluessel(vonId, false);
  if (!paar) return null;
  const roh = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vonB64(iv) }, paar, vonB64(daten));
  return crypto.subtle.importKey('raw', roh, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// Fertig ausgepackte Gruppenschluessel, solange die Seite offen ist.
const gruppenKeys = new Map();

async function gruppenKey(g) {
  if (gruppenKeys.has(g.id)) return gruppenKeys.get(g.id);
  // Verpackt hat ihn, wer eingeladen hat - beim Ersteller er selbst.
  const von = g.eingeladen_von ?? state.me.id;
  const key = await keyAuspacken(von, g.key_enc).catch(() => null);
  gruppenKeys.set(g.id, key);
  return key;
}

const mitKey = async (ziel, text) => {
  const key = ziel.gruppe ? await gruppenKey(ziel.gruppe) : await chatSchluessel(ziel.id, true);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(text));
  return b64(iv) + ':' + b64(daten);
};

// --- Chat -------------------------------------------------------------------
// Kein WebSocket: die offene Unterhaltung fragt alle 5 s nach Neuem, der Zaehler in der
// Navigation alle 30 s. Beide Timer laufen nur, solange sie gebraucht werden.

// Das Ziel einer Unterhaltung: entweder ein Freund oder eine Gruppe. Alles danach - Verlauf,
// Verschluesseln, Anhaenge, Umfragen - arbeitet mit diesem einen Objekt, statt an zwanzig Stellen
// zwischen "Freund" und "Gruppe" zu unterscheiden.
let ziel = null;         // { id, name, gruppe }  gruppe = null im Einzelchat; { id, name, kurs: true } im Kurschat
const artVon = z => (z?.kurs ? 'kurs' : z?.gruppe ? 'gruppen' : 'dm');
let letzteKurse = null;  // zuletzt geholte Kurschats, fuer die Suche
let chatLetzte = 0;      // hoechste bereits geholte Nachrichten-id
export let chatTimer = null;
let badgeTimer = null;
let gruppen = [];        // zuletzt geholte Gruppen, fuer Kopfzeile und Mitgliederliste

const REITER_KEY = 'chatReiter';
let reiter = 'dm';
try { reiter = localStorage.getItem(REITER_KEY) || reiter; } catch { /* Privatmodus */ }
// Von aussen (eigenes Menue): den Reiter setzen, bevor loadChat laeuft.
export function chatReiterSetzen(k) {
  if (!['dm', 'gruppen', 'kurs'].includes(k)) return;
  reiter = k;
  try { localStorage.setItem(REITER_KEY, k); } catch { /* Privatmodus */ }
}

const uhrzeit = iso => new Date(iso.replace(' ', 'T') + 'Z')
  .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

const pfad = () => (ziel?.kurs ? `/api/kurschats/${encodeURIComponent(ziel.id)}`
  : ziel?.gruppe ? `/api/groups/${ziel.id}/nachrichten` : `/api/chats/${ziel.id}`);

// Die roten Zahlen. Geholt wird hier, gemalt in menue.js - an jede Stelle, die die Seite zeigt.
// Alle haengen am selben Takt: eine Stelle, die alle dreissig Sekunden nachsieht, statt vier Timer.
async function malBadge() {
  try {
    const [chats, grp, kurse] = await Promise.all([
      api('GET', '/api/chats'), api('GET', '/api/groups').catch(() => []), api('GET', '/api/kurschats').catch(() => [])]);
    letzteKurse = kurse;
    zahlen['chat/dm'] = chats.reduce((n, c) => n + c.unread, 0);
    zahlen['chat/gruppen'] = grp.filter(g => g.status === 'eingeladen').length;
    // Stummgeschaltete Kurse zaehlen in der Liste, aber nicht in der Zahl am Menue.
    zahlen['chat/kurs'] = kurse.filter(k => !k.stumm).reduce((n, k) => n + k.unread, 0);
    zahlen.chat = zahlen['chat/dm'] + zahlen['chat/gruppen'] + zahlen['chat/kurs'];
    malBadges();
  } catch { /* offline - beim naechsten Mal wieder */ }
}

/** Hausaufgaben (offen, ab heute) plus faellige ToDos - und die beiden einzeln fuer die Unterreiter. */
export async function malHwBadge() {
  try {
    const { n, hausaufgaben, todos } = await api('GET', '/api/homework/offen');
    zahlen.homework = n;
    zahlen['homework/hausaufgaben'] = hausaufgaben ?? n;
    zahlen['homework/todos'] = todos ?? 0;
    malBadges();
  } catch { /* offline - beim naechsten Mal wieder */ }
}

/** Tickets mit Antworten, die man noch nicht gelesen hat. */
export async function malTicketBadge() {
  try {
    zahlen.tickets = (await api('GET', '/api/tickets/neu')).n;
    malBadges();
  } catch { /* offline - beim naechsten Mal wieder */ }
}

/** Offene Freundschaftsanfragen an mich. */
export async function malFreundeBadge() {
  try {
    zahlen.friends = (await api('GET', '/api/friends')).incoming.length;
    malBadges();
  } catch { /* offline - beim naechsten Mal wieder */ }
}

export function starteBadge() {
  clearInterval(badgeTimer);
  const alle = () => { malBadge(); malHwBadge(); malTicketBadge(); malFreundeBadge(); };
  alle();
  badgeTimer = setInterval(alle, 30_000);
}

/** Die Vorschau entschluesselt der Browser selbst - der Server kann es nicht. */
async function vorschauZu(c, alsZiel) {
  if (!c.last) return null;
  const klar = c.last.enc ? await entschluesselnVon(alsZiel, c.last.text).catch(() => null) : c.last.text;
  if (!klar) return null;
  if (!(c.last.datei || c.last.umfrage_n)) return klar;
  // Datei- und Umfrage-Nachrichten tragen im Text ein JSON - in der Liste steht dafuer der
  // Dateiname bzw. die Frage. Sonst stuende dort `{"t":"datei","name":...` in voller Laenge.
  try {
    const a = JSON.parse(klar);
    if (a?.t === 'datei') return `${a.bild ? '🖼' : '📄'} ${a.name}` + (a.text ? ` · ${a.text}` : '');
    if (a?.t === 'umfrage') return `📊 ${a.frage}`;
  } catch { /* gewoehnlicher Text */ }
  return klar;
}

function maleChatReiter() {
  $('#chatReiter').replaceChildren(...[['dm', 'Direkt'], ['gruppen', 'Gruppen'], ['kurs', 'Kurs']].map(([k, t]) =>
    h('button', {
      type: 'button', textContent: t, className: k === reiter ? 'active' : '',
      onclick: () => {
        reiter = k;
        try { localStorage.setItem(REITER_KEY, k); } catch { /* Privatmodus */ }
        maleChatReiter();
        // Ein offener Chat der anderen Art geht zu - sonst stand unter "Gruppen" noch der
        // Direkt-Chat, und auf dem Handy war die Gruppenliste dahinter gar nicht zu sehen.
        if (ziel && artVon(ziel) !== k) schliesseChat();
        else loadChats().catch(oops);
      },
    })));
}

// --- Suche -------------------------------------------------------------------
// Zwei Stufen: der Name filtert beim Tippen die Liste; Enter durchsucht die Nachrichten. Das geht
// nur im Browser - die Nachrichten sind Ende-zu-Ende verschluesselt, der Server sieht Chiffrat.
let suchtext = '';
let suchErgebnis = null;   // { q, treffer } - bleibt stehen, bis das Feld sich aendert
let letzteDirekte = null;
const passtName = (...namen) => !suchtext || namen.some(n => String(n ?? '').toLowerCase().includes(suchtext));

$('#chatSuche').oninput = () => {
  suchtext = $('#chatSuche').value.trim().toLowerCase();
  if (suchErgebnis && suchErgebnis.q !== suchtext) suchErgebnis = null;
  loadChats().catch(oops);
};
$('#chatSuche').onkeydown = e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (suchtext.length >= 2) sucheInhalte(suchtext).catch(oops);
  else toast('Mindestens zwei Zeichen.');
};

/** Text einer Nachricht, wie ihn die Liste zeigt: Datei und Umfrage als Name bzw. Frage. */
function klartextVon(m, klar) {
  if (!(m.datei || m.umfrage_n)) return klar;
  try {
    const a = JSON.parse(klar);
    if (a?.t === 'datei') return [a.name, a.text].filter(Boolean).join(' · ');
    if (a?.t === 'umfrage') return a.frage;
  } catch { /* gewoehnlicher Text */ }
  return klar;
}

async function sucheInhalte(q) {
  const liste = $('#chatListe');
  const chats = letzteDirekte ?? await api('GET', '/api/chats');
  const grp = gruppen.length ? gruppen : await api('GET', '/api/groups').catch(() => []);
  const quellen = [
    ...chats.filter(c => c.last).map(c => ({
      ziel: { id: c.id, name: nameOf(c), person: c, gruppe: null },
      pfad: `/api/chats/${c.id}?since=0&nurLesen=1` })),
    ...grp.filter(g => g.status === 'drin').map(g => ({
      ziel: { id: g.id, name: g.name, gruppe: g }, pfad: `/api/groups/${g.id}/nachrichten?since=0` })),
    ...(letzteKurse ?? await api('GET', '/api/kurschats').catch(() => [])).filter(k => k.last).map(k => ({
      ziel: kursZiel(k), pfad: `/api/kurschats/${encodeURIComponent(k.id)}?since=0&nurLesen=1` })),
  ];
  const treffer = [];
  for (const [i, quelle] of quellen.entries()) {
    liste.replaceChildren(h('p', { className: 'muted small', textContent: `Durchsuche ${i + 1} von ${quellen.length} …` }));
    // Die letzten 300 je Chat: mehr dauert, und aeltere findet man ohnehin nicht mehr wieder.
    const nachrichten = (await api('GET', quelle.pfad).catch(() => [])).slice(-300);
    for (const m of nachrichten) {
      const klar = m.enc ? await entschluesselnVon(quelle.ziel, m.text).catch(() => null) : m.text;
      if (!klar) continue;
      const text = klartextVon(m, klar);
      if (text.toLowerCase().includes(q)) treffer.push({ ziel: quelle.ziel, m, text });
    }
    if ($('#chatSuche').value.trim().toLowerCase() !== q) return;   // inzwischen etwas anderes getippt
  }
  treffer.sort((a, b) => b.m.id - a.m.id);
  suchErgebnis = { q, treffer };
  maleTreffer();
}

function maleTreffer() {
  const { q, treffer } = suchErgebnis;
  const schnipsel = text => {
    const i = text.toLowerCase().indexOf(q);
    const von = Math.max(0, i - 40);
    return (von ? '…' : '') + text.slice(von, i + q.length + 60) + (i + q.length + 60 < text.length ? '…' : '');
  };
  $('#chatListe').replaceChildren(
    h('p', { className: 'muted small', textContent: treffer.length
      ? `${treffer.length} Treffer für „${q}"` : `Nichts gefunden für „${q}".` }),
    ...treffer.slice(0, 100).map(t => {
      const b = h('button', { className: 'chat-eintrag treffer' },
        t.ziel.kurs ? kursAvatar(t.ziel.k) : t.ziel.gruppe ? h('span', { className: 'avatar gruppe', textContent: '👥' }) : avatarEl(t.ziel.person),
        h('span', { className: 'grow' }, t.ziel.name,
          h('small', { className: 'sub', textContent: schnipsel(t.text) })),
        h('small', { className: 'muted', textContent: dmy(t.m.created_at.slice(0, 10)) }));
      b.onclick = async () => {
        await oeffneChat(t.ziel);
        // Zur Nachricht springen und sie kurz hervorheben - sonst sucht man sie im Verlauf erneut.
        const blase = $(`#chatVerlauf .blase[data-id="${t.m.id}"]`);
        if (!blase) return;
        blase.scrollIntoView({ block: 'center' });
        blase.classList.add('treffer');
        setTimeout(() => blase.classList.remove('treffer'), 2500);
      };
      return b;
    }));
}

async function loadChats() {
  maleChatReiter();
  if (suchErgebnis?.q === suchtext && suchtext) return maleTreffer();
  return reiter === 'kurs' ? ladeKurse() : reiter === 'gruppen' ? ladeGruppen() : ladeDirekte();
}

// --- Kurschat -------------------------------------------------------------------
// Jeder Kurs hat einen Chat - fuer alle mit dem Kurs in derselben Stunde, befreundet oder nicht.
// Nicht Ende-zu-Ende: der Server verschluesselt, und die Oberflaeche sagt das auch.
const kursZiel = k => ({ id: k.id, name: kursName(k) || k.id, kurs: true, stumm: !!k.stumm, k });
function kursAvatar(k) {
  // Kurzform: eigenes Kuerzel, Fach, sonst der Anfang der Kurs-ID bis zum ersten Trenner ("MA-LK" -> "MA").
  const kurz = k.pref_short || k.subject_short || k.id.split(/[^\p{L}\p{N}]/u)[0] || k.id;
  const a = h('span', { className: 'avatar kurs', textContent: kurz.slice(0, 3) });
  a.style.background = k.pref_color || `hsl(${courseHue(k.id)} 55% 42%)`;
  return a;
}

async function ladeKurse() {
  const kurse = await api('GET', '/api/kurschats');
  letzteKurse = kurse;
  const sichtbar = kurse.filter(k => passtName(kursName(k), k.id));
  $('#chatListe').replaceChildren(...(sichtbar.length
    ? await Promise.all(sichtbar.map(async k => {
        const vorschau = await vorschauZu(k, kursZiel(k));
        const b = h('button', { className: 'chat-eintrag' + (ziel?.kurs && ziel.id === k.id ? ' aktiv' : '') },
          kursAvatar(k),
          h('span', { className: 'grow' }, `${kursName(k) || k.id}${k.stumm ? ' 🔕' : ''}`,
            h('small', { className: 'sub', textContent: k.last ? `${k.last.von ? nameOf(k.last.von) + ': ' : ''}${vorschau ?? ''}` : 'Noch keine Nachricht' })),
          k.unread ? h('span', { className: 'badge-zahl', textContent: k.unread }) : null);
        b.onclick = () => oeffneChat(kursZiel(k));
        return b;
      }))
    : [h('p', { className: 'muted small', textContent: suchtext ? 'Kein Kurs gefunden.'
        : 'Noch kein Kurs mit Stunde im Plan. Sobald ein Kurs in deinem Stundenplan steht, gibt es hier seinen Chat.' })]));
  malBadge();
}

/** Wer ist im Kurschat? Alle mit dem Kurs in einer meiner Stunden. */
async function kursMitgliederFenster() {
  const d = $('#kursDlg');
  const leute = await api('GET', `${pfad()}/mitglieder`);
  ziel.mitglieder = leute;
  d.replaceChildren(h('h2', { textContent: `Kurschat ${ziel.name}` }),
    h('p', { className: 'muted small', textContent: `${leute.length} ${leute.length === 1 ? 'Person hat' : 'Personen haben'} den Kurs in derselben Stunde wie du. Befreundet müsst ihr dafür nicht sein.` }),
    h('ul', { className: 'list' }, ...leute.map(p => h('li', {}, avatarEl(p), h('span', { className: 'grow', textContent: nameOf(p) })))),
    h('div', { className: 'row end' }, h('button', { type: 'button', className: 'primary', textContent: 'Schließen', onclick: () => d.close() })));
  d.showModal();
}

async function kursStumm(knopf) {
  try {
    const r = await api('PUT', `${pfad()}/stumm`, { an: !ziel.stumm });
    ziel.stumm = r.stumm;
    knopf.textContent = ziel.stumm ? '🔕' : '🔔';
    knopf.title = ziel.stumm ? 'Stumm – keine Meldungen aus diesem Kurs' : 'Meldungen an – antippen zum Stummschalten';
    toast(ziel.stumm ? 'Stumm – keine Meldungen mehr aus diesem Kurschat.' : 'Meldungen wieder an.', true);
    await loadChats();
  } catch (err) { oops(err); }
}

async function ladeDirekte() {
  const alle = await api('GET', '/api/chats');
  await Promise.all(alle.map(async c => {
    c.vorschau = await vorschauZu(c, { id: c.id, gruppe: null });
  }));
  letzteDirekte = alle;
  const chats = alle.filter(c => passtName(nameOf(c), c.username));
  $('#chatListe').replaceChildren(...(chats.length
    ? chats.map(c => {
        const b = h('button', {
          className: 'chat-eintrag' + (!ziel?.gruppe && c.id === ziel?.id ? ' aktiv' : ''),
        },
          avatarEl(c),
          h('span', { className: 'grow' }, nameOf(c),
            h('small', { className: 'sub', textContent: !c.last ? 'Noch keine Nachricht'
              : c.last.enc ? (c.vorschau ?? '🔒 Nicht lesbar') : c.last.text })),
          c.unread ? h('span', { className: 'badge-zahl', textContent: c.unread }) : null);
        b.onclick = () => oeffneChat({ id: c.id, name: nameOf(c), person: c, gruppe: null });
        return b;
      })
    : [h('p', { className: 'muted small', textContent: suchtext
        ? 'Niemand gefunden.' : 'Du hast noch keine Freunde zum Schreiben.' })]));
  malBadge();
}

async function ladeGruppen() {
  gruppen = await api('GET', '/api/groups');
  const offen = gruppen.filter(g => g.status === 'eingeladen' && passtName(g.name));
  const meine = gruppen.filter(g => g.status === 'drin' && passtName(g.name));

  const einladung = g => h('div', { className: 'chat-eintrag' },
    h('span', { className: 'grow' }, `„${g.name}"`,
      h('small', { className: 'sub', textContent: 'Einladung — du entscheidest' })),
    h('button', {
      className: 'tiny primary', textContent: 'Beitreten',
      onclick: async () => {
        try { await api('POST', `/api/groups/${g.id}/beitreten`); await loadChats(); }
        catch (err) { oops(err); }
      },
    }),
    h('button', {
      className: 'tiny ghost', textContent: 'Ablehnen',
      onclick: async () => {
        try {
          await api('DELETE', `/api/groups/${g.id}/mitglieder/${state.me.id}`);
          await loadChats();
        } catch (err) { oops(err); }
      },
    }));

  $('#chatListe').replaceChildren(
    h('button', {
      className: 'tiny primary', textContent: '+ Neue Gruppe',
      onclick: () => gruppeAnlegen().catch(oops),
    }),
    ...offen.map(einladung),
    ...meine.map(g => {
      const b = h('button', {
        className: 'chat-eintrag' + (ziel?.gruppe && g.id === ziel.id ? ' aktiv' : ''),
      },
        h('span', { className: 'avatar gruppe', textContent: '👥' }),
        h('span', { className: 'grow' }, g.name,
          h('small', { className: 'sub',
            textContent: `${g.mitglieder.filter(m => m.status === 'drin').length} Mitglieder` })));
      b.onclick = () => oeffneChat({ id: g.id, name: g.name, gruppe: g });
      return b;
    }),
    ...(meine.length || offen.length ? [] : [h('p', { className: 'muted small',
      textContent: suchtext ? 'Keine Gruppe gefunden.' : 'Noch keine Gruppe. Leg eine an und lade deine Freunde ein.' })]));
  malBadge();
}

// --- Suche im offenen Chat ----------------------------------------------------
// Der Verlauf steht komplett im DOM - gesucht wird in den Blasen, Treffer werden markiert und
// mit ‹ › angesprungen. Die chatuebergreifende Suche ist die ueber der Liste; das hier ist die
// Lupe im Gespraech.
function sucheImChat() {
  const kopf = $('#chatKopf');
  const alt = kopf.querySelector('.chat-suche');
  if (alt) { alt.querySelector('input').focus(); return; }
  const feld = h('input', { type: 'search', placeholder: 'Im Chat suchen …', autocomplete: 'off' });
  const zaehler = h('small', { className: 'muted' });
  let treffer = [], aktuell = -1;
  const raeumen = () => $$('#chatVerlauf .blase.treffer').forEach(b => b.classList.remove('treffer', 'aktuell'));
  const zeige = () => {
    treffer.forEach((b, i) => b.classList.toggle('aktuell', i === aktuell));
    zaehler.textContent = treffer.length ? `${aktuell + 1} / ${treffer.length}` : feld.value.trim() ? '0' : '';
    treffer[aktuell]?.scrollIntoView({ block: 'center' });
  };
  const suchen = () => {
    raeumen();
    const q = feld.value.trim().toLowerCase();
    // Nur der Text der Blase, nicht die Uhrzeit darunter.
    treffer = !q ? [] : $$('#chatVerlauf .blase').filter(b =>
      [...b.querySelectorAll('span')].map(s => s.textContent).join(' ').toLowerCase().includes(q));
    treffer.forEach(b => b.classList.add('treffer'));
    aktuell = treffer.length ? treffer.length - 1 : -1;   // der neueste zuerst
    zeige();
  };
  const spring = richtung => {
    if (!treffer.length) return;
    aktuell = (aktuell + richtung + treffer.length) % treffer.length;
    zeige();
  };
  const zu = () => { raeumen(); zeile.remove(); };
  feld.oninput = suchen;
  feld.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); spring(e.shiftKey ? 1 : -1); }
    if (e.key === 'Escape') { e.preventDefault(); zu(); }
  };
  const zeile = h('div', { className: 'chat-suche row' }, feld, zaehler,
    h('button', { type: 'button', className: 'tiny ghost', textContent: '‹', title: 'Älterer Treffer', onclick: () => spring(-1) }),
    h('button', { type: 'button', className: 'tiny ghost', textContent: '›', title: 'Neuerer Treffer', onclick: () => spring(1) }),
    h('button', { type: 'button', className: 'tiny ghost', textContent: '×', title: 'Suche schließen', onclick: zu }));
  kopf.append(zeile);
  feld.focus();
}

async function oeffneChat(neuesZiel) {
  // Zuerst den alten Takt anhalten. Stand das frueher hinter dem `await holeNeue()`, lief der
  // Timer des vorigen Chats noch, waehrend das Ziel schon das neue und `chatLetzte` schon 0 war -
  // dann holten zwei Abrufe den kompletten Verlauf und er erschien doppelt.
  clearInterval(chatTimer);
  gibBlobsFrei();
  // Der angefangene Text gehoert zum Chat: beim Wechsel merken, beim Oeffnen zurueckholen.
  if (ziel) merkeEntwurf();
  ziel = neuesZiel;
  try { $('#chatForm').text.value = sessionStorage.getItem('entwurf:' + entwurfSchluessel()) ?? ''; } catch { /* Privatmodus */ }
  chatLetzte = 0;
  unlesbar = new Set();
  gezeigt = new Set();
  $('#chatVerlauf').replaceChildren();
  // setzeKinder statt replaceChildren: der Knopf unten gibt es nur in Gruppen, und ein null
  // wuerde hier sonst als Text "null" neben dem Namen stehen.
  setzeKinder($('#chatKopf'),
    h('button', { className: 'tiny ghost zurueck', textContent: '‹', title: 'Zurück', onclick: schliesseChat }),
    ziel.kurs ? kursAvatar(ziel.k) : ziel.gruppe ? h('span', { className: 'avatar gruppe', textContent: '👥' }) : avatarEl(ziel.person),
    h('strong', { className: 'grow', textContent: ziel.name }),
    h('button', { className: 'tiny ghost', textContent: '🔍', title: 'Im Chat suchen', onclick: () => sucheImChat() }),
    ziel.gruppe ? h('button', {
      className: 'tiny ghost', textContent: 'Mitglieder',
      onclick: () => gruppeVerwalten(ziel.gruppe).catch(oops),
    }) : null,
    ziel.kurs ? h('button', { className: 'tiny ghost', textContent: 'Mitglieder', onclick: () => kursMitgliederFenster().catch(oops) }) : null,
    ziel.kurs ? h('button', {
      className: 'tiny ghost', textContent: ziel.stumm ? '🔕' : '🔔',
      title: ziel.stumm ? 'Stumm – keine Meldungen aus diesem Kurs' : 'Meldungen an – antippen zum Stummschalten',
      onclick: e => kursStumm(e.currentTarget),
    }) : null);
  // Ehrlich sagen, was dieser Chat ist - er verhaelt sich anders als Direkt und Gruppen.
  if (ziel.kurs) $('#chatVerlauf').append(h('p', { className: 'kurs-hinweis', textContent:
    'Kurschat · alle mit diesem Kurs in derselben Stunde · auf dem Server verschlüsselt, nicht Ende-zu-Ende' }));
  document.querySelector('.chat').classList.add('offen');
  await holeNeue();
  chatTimer = setInterval(() => holeNeue().catch(() => {}), 5000);
  await loadChats();
}

const entwurfSchluessel = () => `chat:${artVon(ziel)}:${ziel?.id}`;
function merkeEntwurf() {
  if (!ziel) return;
  const text = $('#chatForm').text.value;
  try { text ? sessionStorage.setItem('entwurf:' + entwurfSchluessel(), text) : sessionStorage.removeItem('entwurf:' + entwurfSchluessel()); } catch { /* egal */ }
}
$('#chatForm').text.addEventListener('input', merkeEntwurf);

function schliesseChat() {
  merkeEntwurf();
  ziel = null;
  $('#chatForm').text.value = '';
  clearInterval(chatTimer);
  gibBlobsFrei();
  document.querySelector('.chat').classList.remove('offen');
  loadChats().catch(oops);
}

// Nachrichten aus der Zeit vor dem jetzigen Schluessel. Der passende private Schluessel existiert
// nicht mehr, das ist nicht zu reparieren - wohl aber, dass es dauerhaft nach kaputtem Chat
// aussieht. Deshalb eine Zeile mit dem Grund und der Moeglichkeit, sie wegzuraeumen.
let unlesbar = new Set();

function malUnlesbar() {
  const alt = $('#chatAlt');
  if (alt) alt.remove();
  if (!unlesbar.size) return;

  const n = unlesbar.size;
  const imDm = !ziel?.gruppe && !ziel?.kurs;
  const karte = h('div', { className: 'chat-alt', id: 'chatAlt' },
    h('p', { textContent: `${n} ${n === 1 ? 'ältere Nachricht lässt' : 'ältere Nachrichten lassen'}`
      + ' sich nicht mehr entschlüsseln. Sie wurden mit einem Schlüssel verschlüsselt, den es nicht'
      + ' mehr gibt — das passiert, wenn ein Passwort zurückgesetzt wurde. Was ihr euch ab jetzt'
      + ' schreibt, ist davon nicht betroffen.' }),
    // Aufraeumen gibt es nur im Einzelchat - die Route prueft das Paar. In einer Gruppe hat es
    // frueher den Einzelchat mit dem gleichnamigen Freund getroffen.
    !imDm ? null : h('button', {
      className: 'tiny ghost', textContent: 'Aufräumen',
      onclick: async e => {
        if (!await bestaetigen(`${n} unlesbare ${n === 1 ? 'Nachricht' : 'Nachrichten'} löschen? `
          + 'Das gilt für euch beide und lässt sich nicht rückgängig machen.')) return;
        e.target.disabled = true;
        try {
          await api('POST', `/api/chats/${ziel.id}/aufraeumen`, { ids: [...unlesbar] });
          unlesbar = new Set();
          gezeigt = new Set();
          chatLetzte = 0;
          $('#chatVerlauf').replaceChildren();
          await holeNeue();
          toast('Aufgeräumt.', true);
        } catch (err) { oops(err); e.target.disabled = false; }
      },
    }));
  $('#chatVerlauf').prepend(karte);
}

/**
 * Neue Nachrichten holen und anhaengen.
 *
 * Zwei Sicherungen gegen Doppelungen, weil hier drei Dinge gleichzeitig hereinlaufen koennen: der
 * 5-Sekunden-Takt, das Absenden und der Aufraeumen-Knopf.
 *
 *  1. Laeuft schon ein Abruf, bekommt der zweite Aufrufer dieselbe Zusage zurueck statt eine zweite
 *     Abfrage zu starten. Noetig, weil `chatLetzte` erst NACH dem Netz-Roundtrip hochgezaehlt wird -
 *     zwei ueberlappende Abrufe fragen sonst mit demselben `since` und rendern beide dasselbe.
 *  2. Und selbst dann haengt nichts doppelt an: gezeigte IDs werden gemerkt.
 */
let holtGerade = null;
let gezeigt = new Set();

const holeNeue = () => (holtGerade ??= holenJetzt().finally(() => { holtGerade = null; }));

async function holenJetzt() {
  if (!ziel) return;
  const fuer = ziel;
  const neue = await api('GET', `${pfad()}${ziel.gruppe ? '?' : '?'}since=${chatLetzte}`);
  // Waehrend des Abrufs kann jemand den Chat gewechselt haben - dann gehoert das hier nicht mehr
  // in den Verlauf, der jetzt auf dem Schirm steht.
  if (!neue.length || fuer !== ziel) return;
  const verlauf = $('#chatVerlauf');
  const unten = verlauf.scrollHeight - verlauf.scrollTop - verlauf.clientHeight < 60;
  for (const m of neue) {
    chatLetzte = Math.max(chatLetzte, m.id);
    if (gezeigt.has(m.id)) continue;
    gezeigt.add(m.id);
    const klar = m.enc ? await entschluesselnVon(ziel, m.text) : m.text;
    // Unlesbares bekommt keine eigene Blase mehr. Eine Reihe gleichlautender "nicht lesbar"-Zeilen
    // sieht aus, als sei der Chat kaputt - dabei betrifft es nur Nachrichten von vor einem
    // Schluesselwechsel. Sie werden gezaehlt und oben in EINER Zeile erklaert.
    if (klar === null) { unlesbar.add(m.id); continue; }

    // Ein Anhang steckt als JSON im verschluesselten Text: der Server kennt weder Dateiname noch
    // Typ, nur die Groesse. Alles andere ist gewoehnlicher Text.
    let inhalt = null;
    if (m.datei || m.umfrage_n) { try { inhalt = JSON.parse(klar); } catch { inhalt = null; } }

    const blase = h('div', { className: 'blase ' + (m.from_id === state.me.id ? 'ich' : 'du') });
    blase.dataset.id = m.id;   // fuer den Sprung aus der Suche
    // In Gruppe und Kurs steht dabei, wer schreibt - sonst raet man. Im Kurs liefert der Server
    // die Person mit: das sind keine Freunde, der Browser kennt sie sonst nicht.
    if ((ziel.gruppe || ziel.kurs) && m.from_id !== state.me.id) {
      const wer = m.von ?? ziel.gruppe?.mitglieder.find(x => x.id === m.from_id);
      blase.append(h('small', { className: 'wer', textContent: wer ? nameOf(wer) : 'Jemand' }));
    }
    // Nur Stimmiges zeichnen: eine "Datei" ohne Anhang oder eine "Umfrage" ohne Antwortliste
    // brach sonst die ganze Anzeige ab - dann stand der Chat fuer alle leer.
    if (inhalt?.t === 'datei' && m.datei && typeof inhalt.name === 'string') {
      blase.append(dateiBlase(m, inhalt));
      // Wer zum Bild etwas geschrieben hat, soll es auch lesen koennen.
      if (inhalt.text) blase.append(h('span', { textContent: String(inhalt.text) }));
    } else if (inhalt?.t === 'umfrage' && m.umfrage_n && Array.isArray(inhalt.optionen)) {
      blase.append(umfrageBlase(m, inhalt));
    } else blase.append(h('span', { textContent: klar }));
    blase.append(h('small', { textContent: uhrzeit(m.created_at) }));
    // Im Kurschat laesst sich die eigene Nachricht zuruecknehmen - dort lesen auch Nicht-Freunde mit.
    if (ziel.kurs && m.from_id === state.me.id) blase.append(h('button', {
      type: 'button', className: 'blase-weg', textContent: '×', title: 'Nachricht löschen',
      onclick: async () => {
        if (!await bestaetigen('Deine Nachricht im Kurschat löschen? Sie verschwindet für alle.')) return;
        try { await api('DELETE', `/api/kurschats/nachricht/${m.id}`); blase.remove(); await loadChats(); }
        catch (err) { oops(err); }
      },
    }));
    verlauf.append(blase);
  }
  malUnlesbar();
  // Nur mitscrollen, wer ohnehin unten stand - sonst reisst es einen aus dem Nachlesen.
  if (unten) verlauf.scrollTop = verlauf.scrollHeight;
  malBadge();
}

const KB = n => n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Ein Anhang im Verlauf. Geholt und entschluesselt wird er erst hier - eine Verlaufsabfrage
 * schleppt die Bytes nicht mit.
 *
 * Der Speicher wird wieder freigegeben: eine Objekt-URL haelt die Daten sonst, bis die Seite neu
 * laedt, und bei einem Verlauf voller Bilder ist das irgendwann das ganze Album.
 */
// Blob-URLs leben, solange der Chat offen ist. Sie im onload freizugeben klingt sparsam, ist aber
// falsch: Chrome braucht die Ressource beim naechsten Zeichnen erneut, und das Bild wird zum
// kaputten Platzhalter. Aufgeraeumt wird beim Wechsel der Unterhaltung.
let blobUrls = [];
export function gibBlobsFrei() {
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls = [];
}

function dateiBlase(m, info) {
  const kasten = h('div', { className: 'anhang' });
  const laden = h('button', {
    className: 'tiny ghost',
    textContent: `${info.bild ? '🖼' : '📄'} ${info.name} · ${KB(m.datei.bytes)}`,
  });
  laden.onclick = async () => {
    laden.disabled = true;
    laden.textContent = 'Wird geladen …';
    try {
      const { data, klar } = await api('GET', `/api/chats/datei/${m.datei.id}`);
      const roh = klar ? vonB64(data) : await dateiEntschluesseln(ziel, data);
      if (!roh) throw new Error('Lässt sich nicht entschlüsseln');
      // Den Typ nennt der Absender. Als Bild nur echte Rasterbilder - HTML oder SVG in einer
      // blob:-Adresse liefe sonst auf unserem eigenen Origin.
      const bildTyp = /^image\/(png|jpeg|gif|webp|avif)$/.test(info.mime ?? '');
      const url = URL.createObjectURL(new Blob([roh], { type: bildTyp ? info.mime : 'application/octet-stream' }));
      blobUrls.push(url);
      kasten.replaceChildren(info.bild && bildTyp
        ? h('a', { href: url, target: '_blank', rel: 'noopener', title: 'Groß ansehen' },
            h('img', { src: url, alt: info.name, className: 'anhang-bild' }))
        : h('a', { href: url, download: info.name, className: 'anhang-datei',
            textContent: `📄 ${info.name} · ${KB(m.datei.bytes)}` }));
    } catch (err) {
      laden.disabled = false;
      laden.textContent = `📄 ${info.name} · ${KB(m.datei.bytes)}`;
      oops(err);
    }
  };
  kasten.append(laden);
  // Bilder zeigt man, ohne zu fragen - eine Datei bleibt ein Knopf, damit niemand ungefragt
  // Megabytes durch sein Mobilfunknetz zieht.
  if (info.bild && m.datei.bytes < 400_000) laden.click();
  return kasten;
}

// --- Anhang auswaehlen ------------------------------------------------------
// Bilder werden vorher verkleinert: ein Handyfoto hat 4 MB und 4000 Pixel Kantenlaenge, und
// niemand braucht das in einem Chatfenster. 1600 Pixel und JPEG-Qualitaet 0.82 reichen und
// sparen den Faktor zehn - in der Leitung wie in der Datenbank.
const MAX_KANTE = 1600;
const MAX_ANHANG = 8 * 1024 * 1024;

async function verkleinern(datei) {
  if (!datei.type.startsWith('image/') || datei.type === 'image/gif') return null;
  const bild = await createImageBitmap(datei).catch(() => null);
  if (!bild) return null;
  const faktor = Math.min(1, MAX_KANTE / Math.max(bild.width, bild.height));
  // Kleine Bilder bleiben, wie sie sind - neu zu kodieren macht sie oft nur groesser.
  if (faktor === 1 && datei.size < 400_000) return null;
  const leinwand = new OffscreenCanvas(Math.round(bild.width * faktor), Math.round(bild.height * faktor));
  leinwand.getContext('2d').drawImage(bild, 0, 0, leinwand.width, leinwand.height);
  bild.close();
  return leinwand.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}

// Mehrere Anhaenge auf einmal. Verschickt wird je Datei eine eigene Nachricht - so machen es
// gaengige Messenger, und `messages` bleibt bei einem Anhang je Zeile.
let anhaenge = [];   // [{ blob, name, mime, bild }]

function zeigeAnhang() {
  const leiste = $('#chatAnhang');
  leiste.hidden = !anhaenge.length;
  if (!anhaenge.length) return;
  leiste.replaceChildren(...anhaenge.map((a, i) => h('span', { className: 'anhang-chip' },
    `${a.bild ? '🖼' : '📄'} ${a.name} · ${KB(a.blob.size)}`,
    h('button', {
      className: 'tiny ghost', textContent: '×', title: 'Entfernen',
      onclick: () => { anhaenge.splice(i, 1); $('#chatDatei').value = ''; zeigeAnhang(); },
    }))));
}

$('#dateiKnopf').onclick = () => { schliesseMehr(); $('#chatDatei').click(); };
$('#chatDatei').onchange = async e => {
  const dateien = [...(e.target.files ?? [])];
  if (!dateien.length) return;
  try {
    for (const datei of dateien) {
      const klein = await verkleinern(datei);
      const blob = klein ?? datei;
      if (blob.size > MAX_ANHANG) {
        toast(`„${datei.name}" ist zu groß (max. ${MAX_ANHANG / 1024 / 1024} MB)`);
        continue;
      }
      anhaenge.push({
        blob,
        name: datei.name,
        mime: klein ? 'image/jpeg' : (datei.type || 'application/octet-stream'),
        bild: (klein ? 'image/jpeg' : datei.type).startsWith('image/'),
      });
    }
    zeigeAnhang();
  } catch (err) { oops(err); }
};

// --- Emoji ------------------------------------------------------------------

let emojiGebaut = false;

function baueEmoji() {
  if (emojiGebaut) return;
  emojiGebaut = true;
  const kasten = $('#emojiWahl');
  const einfuegen = zeichen => {
    const feld = $('#chatForm').text;
    feld.value += zeichen;
    feld.focus();
    merkeEmoji(zeichen);
  };
  const gruppe = (titel, zeichen) => h('div', { className: 'emoji-gruppe' },
    h('h4', { textContent: titel }),
    h('div', { className: 'emoji-gitter' }, ...zeichen.map(z =>
      h('button', { type: 'button', textContent: z, onclick: () => einfuegen(z) }))));

  const letzte = letzteEmoji();
  kasten.replaceChildren(
    ...(letzte.length ? [gruppe('Zuletzt', letzte)] : []),
    ...emojiGruppen().map(g => gruppe(g.titel, g.zeichen)));
}

$('#emojiKnopf').onclick = () => {
  schliesseMehr();
  baueEmoji();
  $('#emojiWahl').hidden = !$('#emojiWahl').hidden;
};

// --- Das Menue hinter den drei Punkten --------------------------------------
// Drei Knoepfe nebeneinander lassen auf einem schmalen Display kaum Platz zum Schreiben. Ein
// Menue statt einer zweiten Zeile: dieselbe Bedienung auf jedem Geraet.
const schliesseMehr = () => { $('#mehrWahl').hidden = true; };

$('#mehrKnopf').onclick = e => {
  e.stopPropagation();
  $('#mehrWahl').hidden = !$('#mehrWahl').hidden;
};
addEventListener('click', e => {
  if (!$('#mehrWahl').hidden && !e.target.closest('.mehr-menue')) schliesseMehr();
});
addEventListener('keydown', e => { if (e.key === 'Escape') schliesseMehr(); });

// --- Umfragen ---------------------------------------------------------------
// Frage und Antworten sind verschluesselt wie jede Nachricht. Der Server bekommt nur die ANZAHL
// der Antworten - genug, um eine Stimme zu pruefen, zu wenig, um die Umfrage zu kennen.

function umfrageBlase(m, u) {
  const kasten = h('div', { className: 'umfrage' }, h('strong', { textContent: u.frage }));
  const stimmen = m.stimmen ?? [];
  const gesamt = stimmen.length;
  const meine = stimmen.find(x => x.user_id === state.me.id)?.wahl;

  u.optionen.forEach((text, i) => {
    const dafuer = stimmen.filter(x => x.wahl === i);
    const anteil = gesamt ? Math.round(dafuer.length * 100 / gesamt) : 0;
    const namen = dafuer
      .map(x => (ziel.gruppe?.mitglieder ?? ziel.mitglieder ?? []).find(mm => mm.id === x.user_id))
      .map(p => (p ? nameOf(p) : null)).filter(Boolean);
    const zeile = h('button', {
      className: 'umfrage-option' + (meine === i ? ' gewaehlt' : ''),
      onclick: async () => {
        try {
          const r = await api('POST', `/api/messages/${m.id}/stimme`, { wahl: i });
          m.stimmen = r.stimmen;
          kasten.replaceWith(umfrageBlase(m, u));
        } catch (err) { oops(err); }
      },
    },
      h('span', { className: 'balken', style: `width:${anteil}%` }),
      h('span', { className: 'grow', textContent: text }),
      h('small', { textContent: String(dafuer.length) }));
    kasten.append(zeile);
    if (namen.length) kasten.append(h('small', { className: 'wer', textContent: namen.join(', ') }));
  });
  kasten.append(h('small', { className: 'meta',
    textContent: `${gesamt} ${gesamt === 1 ? 'Stimme' : 'Stimmen'}` }));
  return kasten;
}

$('#umfrageKnopf').onclick = () => {
  schliesseMehr();
  const feld = () => h('input', { name: 'option', maxLength: 80, placeholder: 'Antwort' });
  $('#umfrageOptionen').replaceChildren(feld(), feld());
  $('#umfrageForm').frage.value = '';
  $('#umfrageDlg').showModal();
};
$('#umfrageMehr').onclick = () => {
  const liste = $('#umfrageOptionen');
  if (liste.children.length >= 10) return toast('Höchstens zehn Antworten');
  liste.append(h('input', { name: 'option', maxLength: 80, placeholder: 'Antwort' }));
};
$('#umfrageAb').onclick = () => $('#umfrageDlg').close();

$('#umfrageForm').onsubmit = async e => {
  e.preventDefault();
  const frage = e.target.frage.value.trim();
  const optionen = [...$('#umfrageOptionen').querySelectorAll('input')]
    .map(x => x.value.trim()).filter(Boolean);
  if (!frage || optionen.length < 2) return toast('Frage und mindestens zwei Antworten');

  try {
    const json = JSON.stringify({ t: 'umfrage', frage, optionen });
    if (ziel.kurs) await api('POST', pfad(), { text: json, umfrage_n: optionen.length });
    else {
      const geheim = await verschluesselnFuer(ziel, json);
      if (!geheim) throw new Error('Ohne Schlüssel geht keine Umfrage');
      await api('POST', pfad(), { text: geheim, enc: true, umfrage_n: optionen.length });
    }
    $('#umfrageDlg').close();
    await holeNeue();
    await loadChats();
  } catch (err) { oops(err); }
};

// --- Gruppen anlegen und verwalten ------------------------------------------

async function gruppeAnlegen() {
  const name = await eingabe('Name der Gruppe:');
  if (!name?.trim()) return;
  // Der Schluessel entsteht hier im Browser und geht nur verpackt hinaus.
  const key = await gruppenKeyNeu();
  const fuerMich = await keyVerpacken(state.me.id, key);
  const g = await api('POST', '/api/groups', { name: name.trim(), key_enc: fuerMich });
  gruppenKeys.set(g.id, key);
  await loadChats();
  await gruppeVerwalten(g);
}

async function gruppeVerwalten(g) {
  const frisch = (await api('GET', '/api/groups')).find(x => x.id === g.id) ?? g;
  const binAdmin = frisch.rolle === 'admin';
  const dlg = $('#gruppeDlg');
  $('#gruppeTitel').textContent = frisch.name;
  $('#gruppeForm').name.value = frisch.name;
  $('#gruppeForm').name.disabled = !binAdmin;

  // Einladen kann man Freunde, die noch nicht dabei sind. /api/friends antwortet mit
  // { friends, incoming, outgoing } - nur die bestaetigten stehen unter `friends`.
  const antwort = await api('GET', '/api/friends').catch(() => ({}));
  const freunde = (antwort.friends ?? [])
    .filter(f => !frisch.mitglieder.some(m => m.id === f.id));

  const einladen = h('select', {}, h('option', { value: '', textContent: '— jemanden einladen —' }),
    ...freunde.map(f => h('option', { value: String(f.id), textContent: nameOf(f) })));
  einladen.onchange = async () => {
    if (!einladen.value) return;
    try {
      const key = await gruppenKey(frisch);
      if (!key) throw new Error('Dein Gruppenschlüssel fehlt auf diesem Gerät');
      const verpackt = await keyVerpacken(Number(einladen.value), key);
      if (!verpackt) throw new Error(`${nameOf(freunde.find(f => f.id === Number(einladen.value)) ?? {})} hat sich noch nie in der App angemeldet – erst danach lässt sich die Einladung verschlüsseln.`);
      await api('POST', `/api/groups/${frisch.id}/mitglieder`,
        { user_id: Number(einladen.value), key_enc: verpackt });
      toast('Eingeladen.', true);
      await gruppeVerwalten(frisch);
      await loadChats();
    } catch (err) { oops(err); }
  };

  $('#gruppeMitglieder').replaceChildren(
    h('h4', { textContent: 'Mitglieder' }),
    h('ul', { className: 'list' }, ...frisch.mitglieder.map(m => h('li', {},
      h('span', { className: 'grow', textContent: nameOf(m) }),
      h('small', { className: 'sub', textContent:
        (m.rolle === 'admin' ? 'Admin' : 'Mitglied') + (m.status === 'eingeladen' ? ' · eingeladen' : '') }),
      ...(binAdmin && m.id !== state.me.id ? [
        h('button', {
          className: 'tiny ghost', textContent: m.rolle === 'admin' ? 'Zum Mitglied' : 'Zum Admin',
          onclick: async () => {
            try {
              await api('PATCH', `/api/groups/${frisch.id}/mitglieder/${m.id}`,
                { rolle: m.rolle === 'admin' ? 'mitglied' : 'admin' });
              await gruppeVerwalten(frisch);
            } catch (err) { oops(err); }
          },
        }),
        h('button', {
          className: 'tiny ghost', textContent: '×', title: 'Entfernen',
          onclick: async () => {
            try {
              await api('DELETE', `/api/groups/${frisch.id}/mitglieder/${m.id}`);
              await gruppeVerwalten(frisch);
              await loadChats();
            } catch (err) { oops(err); }
          },
        })] : [])))),
    ...(binAdmin ? [h('label', { className: 'field' }, 'Einladen', einladen)] : []),
    h('button', {
      type: 'button', className: 'tiny ghost', textContent: 'Gruppe verlassen',
      onclick: async () => {
        if (!await bestaetigen(`„${frisch.name}" wirklich verlassen?`)) return;
        try {
          await api('DELETE', `/api/groups/${frisch.id}/mitglieder/${state.me.id}`);
          dlg.close();
          schliesseChat();
        } catch (err) { oops(err); }
      },
    }));
  dlg.showModal();
}

$('#gruppeAb').onclick = () => $('#gruppeDlg').close();
$('#gruppeForm').onsubmit = async e => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name || !ziel?.gruppe) return $('#gruppeDlg').close();
  try {
    await api('PATCH', `/api/groups/${ziel.id}`, { name });
    ziel.name = name;
    $('#gruppeDlg').close();
    await loadChats();
  } catch (err) { oops(err); }
};

$('#chatForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const text = f.text.value.trim();
  if (!ziel) return;
  if (!text && !anhaenge.length) return;
  if (text.length > 2000) return toast('Nachricht ist zu lang (max. 2000 Zeichen)');
  f.text.value = '';
  merkeEntwurf();   // abgeschickt = kein Entwurf mehr
  $('#emojiWahl').hidden = true;
  schliesseMehr();
  // Verschluesseln und Senden dauern zusammen ein paar hundert Millisekunden - lange genug fuer
  // einen zweiten Klick, und der schickt dieselbe Nachricht noch einmal.
  const knopf = f.querySelector('button.primary');
  if (knopf) knopf.disabled = true;
  const dateien = anhaenge;
  try {
    if (dateien.length) {
      // Je Datei eine Nachricht - der Begleittext haengt an der ersten. Eine Datei geht nur
      // verschluesselt hinaus: ein Bild im Klartext auf dem Server waere das Gegenteil dessen,
      // was der Chat verspricht.
      anhaenge = [];
      $('#chatDatei').value = '';
      zeigeAnhang();
      for (const [i, a] of dateien.entries()) {
        const chiffrat = await dateiVerschluesseln(ziel, await a.blob.arrayBuffer());
        if (!chiffrat) throw new Error('Anhänge gehen nur mit Chat-Schlüssel auf beiden Seiten');
        const { datei_id } = await api('POST',
          ziel.kurs ? `${pfad()}/datei` : ziel.gruppe ? `/api/groups/${ziel.id}/datei` : `/api/chats/${ziel.id}/datei`,
          { data: chiffrat });
        // Name und Typ stehen im verschluesselten Text - der Server soll sie nicht kennen. Im
        // Kurschat verschluesselt der Server selbst, dort geht das JSON im Klartext hin.
        const json = JSON.stringify({ t: 'datei', name: a.name, mime: a.mime, bild: a.bild, text: i === 0 ? text : '' });
        await api('POST', pfad(), ziel.kurs ? { text: json, datei_id }
          : { text: await verschluesselnFuer(ziel, json), enc: true, datei_id });
      }
    } else {
      // Wenn beide Seiten einen Schluessel haben, geht nur das Chiffrat hinaus. Sonst - etwa weil
      // das Gegenueber sich seit der Umstellung noch nicht angemeldet hat - bleibt es beim
      // Klartext, und die Oberflaeche sagt das auch. In einer Gruppe gibt es diesen Rueckfall
      // nicht: dort haengt der Schluessel an der Gruppe, nicht am Paar.
      const geheim = await verschluesselnFuer(ziel, text).catch(() => null);
      if (!geheim && ziel.gruppe) throw new Error('Dein Gruppenschlüssel fehlt auf diesem Gerät');
      await api('POST', pfad(), geheim ? { text: geheim, enc: true } : { text });
    }
    await holeNeue();
    await loadChats();
  } catch (err) { oops(err); f.text.value = text; anhaenge = dateien; zeigeAnhang(); }
  finally { if (knopf) knopf.disabled = false; }
};

// Ohne Schluessel auf diesem Geraet bleibt der Chat gesperrt - lesen koennte man ohnehin nichts,
// und ein Klartext-Fallback waere still das Gegenteil dessen, was versprochen ist.
async function paintChatSperre() {
  const offen = await chatEntsperrt();
  $('#chatSperre').hidden = offen;
  document.querySelector('.chat').hidden = !offen;
  if (offen) return true;

  const { pub_key } = await api('GET', '/api/me/keys').catch(() => ({}));
  $('#chatSperreText').textContent = pub_key
    ? 'Auf diesem Gerät fehlt dein Chat-Schlüssel. Gib einmal dein Passwort ein, dann kannst du '
      + 'hier lesen und schreiben.'
    : 'Beim ersten Mal wird dein Schlüsselpaar angelegt. Dafür einmal dein Passwort eingeben.';
  return false;
}

$('#chatEntsperren').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const r = await schluesselEinrichten(f.password.value).catch(() => ({ moeglich: false }));
  f.password.value = '';

  if (!r.moeglich) return toast('Verschlüsselung geht in diesem Browser nicht.');
  if (r.falsch) {
    // Falsches Passwort oder ein Admin-Reset - unterscheidbar ist das hier nicht, deshalb fragen
    // statt entscheiden: ein neues Paar wirft den alten Verlauf endgueltig weg.
    const frage = [
      'Das Passwort passt nicht zu deinem hinterlegten Chat-Schlüssel.',
      'Hast du dich vertippt? Dann brich hier ab und versuch es erneut.',
      'Wurde dein Passwort von einem Admin zurückgesetzt, kannst du neu anfangen — der bisherige '
        + 'Verlauf bleibt dann für immer unlesbar.',
    ].join('\n\n');
    if (!await bestaetigen(frage)) return;
    const nochmal = await eingabe('Zum Neuanfangen dein aktuelles Passwort:', '', { passwort: true }) || '';
    if (!nochmal) return;
    try { await chatNeuAnfangen(nochmal); }
    catch (err) { return oops(err); }
    toast('Neu angefangen. Alte Nachrichten bleiben verschlüsselt.', true);
  } else {
    toast(r.neu ? 'Schlüssel angelegt.' : 'Entsperrt.', true);
  }
  await loadChat();
};

export async function loadChat() {
  if (!await paintChatSperre()) return;
  await loadChats();
  if (ziel) {
    clearInterval(chatTimer);
    chatTimer = setInterval(() => holeNeue().catch(() => {}), 5000);
  }
}
