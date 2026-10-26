import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { db, dbFile, hash, verify, scryptAsync, getSetting, setSetting, standardSchule, FREI, WEG, sql, transaktion } from './db.js';
import { iconPng } from './icon.js';
import { pushKey, anstupsen } from './push.js';
import { untisKey, verschluesseln, entschluesseln, login, loginMitSchluessel, stundenplan, logout,
         aufbereiten, schulenSuchen, ohneSchema, untisHostOk, ferien, raster,
         hausaufgaben, pruefungen as untisPruefungen, texteDiagnose, tagesNachrichten } from './untis.js';
import { lese as rssLese } from './rss.js';
import { saeubern as raumplanSaeubern } from './public/raumplan.js';
import { IservFehler, anmelden as iservAnmelden, abmelden as iservAbmelden,
         stundenplan as iservPlan, iservHostOk, ohneSchema as iservOhneSchema } from './iserv.js';
import { schreibe as icsSchreibe, lese as icsLese } from './ical.js';
import { buero } from './buero.js';
import { hostOk, adresseErlaubt, holeGeprueft, KOPF as NETZ_KOPF, ohneSchema as netzOhneSchema } from './netz.js';
import { VnwFehler, ohneSchraegstrich, typen, tagSicherstellen, ticketAnlegen,
  liste as ticketListe, ansehen, holen as ticketHolen, antworten, loeschen as ticketLoeschen } from './vnw.js';

const app = express();
app.disable('x-powered-by');

// Hinter dem Reverse Proxy von VNW ist req.ip sonst fuer alle dieselbe: zehn Fehlversuche von
// irgendwem wuerden die ganze Schule aussperren, und ein Angreifer teilte sich den Zaehler mit
// allen anderen. Setzt der Proxy X-Forwarded-For nicht selbst, gehoert TRUST_PROXY auf 0.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

// Avatar- und Banner-Data-URLs sprengen die 100kb-Vorgabe. Chat-Anhaenge sprengen auch 1 MB -
// die bekommen ihren eigenen Parser, und der globale muss sie durchlassen: er wuerde sonst schon
// mit 413 antworten, bevor die Route ueberhaupt drankommt.
const jsonParser = express.json({ limit: '1mb' });
const GROSSE_ROUTE = /^\/api\/((chats|groups)\/\d+|kurschats\/[^/]+)\/datei$/;
app.use((req, res, next) => (GROSSE_ROUTE.test(req.path) ? next() : jsonParser(req, res, next)));

// Die App laedt nichts von fremden Hosts und hat kein einziges Inline-Script - eine strenge CSP
// kostet hier also nichts und faengt ab, was ein hochgeladenes Bild sonst anrichten koennte.
app.use((req, res, next) => {
  res.set({
    // blob: ist fuer die Chat-Anhaenge noetig: sie werden im Browser entschluesselt und als Blob
    // angezeigt. Ohne diese Erlaubnis bleibt jedes Bild leer - stumm, denn ein blockiertes <img>
    // meldet sich nur in der Konsole. Eine Blob-URL entsteht ausschliesslich im eigenen Code.
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; "
      + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    // Die laufende Version an jeder Antwort: daran merkt ein offener Tab, dass er alt ist - ohne
    // eine einzige zusaetzliche Anfrage. (VERSION steht weiter unten; gelesen wird sie erst zur
    // Laufzeit, dann ist sie da.)
    'X-Version': VERSION,
  });
  // Einmal ueber https gekommen, immer ueber https (hinter dem VNW-Proxy: X-Forwarded-Proto).
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  // Zweite Leine neben SameSite=Lax: eine fremde Seite darf nichts aendern. Browser ohne den
  // Header (alt) schickt Lax trotzdem kein Cookie mit.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site')
    return res.status(403).json({ error: 'Anfrage von einer fremden Seite abgewiesen' });
  next();
});

// Immer nachfragen, nie raten: ohne Cache-Control darf der Browser eine Datei nach Heuristik
// tagelang fuer frisch halten - und dann laeuft nach einem Deploy weiter das alte JS, auch durch
// den Service Worker hindurch. Mit ETag ist die Nachfrage ein 304, also fast umsonst.
app.use(express.static(join(import.meta.dirname, 'public'),
  { setHeaders: res => res.set('Cache-Control', 'no-cache') }));

// Die Datenschutzerklaerung unter einer festen Adresse: dieselbe Seite, die App oeffnet dort das
// Fenster mit dem Reiter Datenschutz (profil.js).
// Umfragen fuer Gaeste (/umfrage/<key>): dieselbe Seite, start.js zeigt dann nur das Ausfuellen.
app.get('/umfrage/:key', (req, res) =>
  res.set('Cache-Control', 'no-cache').sendFile(join(import.meta.dirname, 'public', 'index.html')));
// Der Einladungslink der Admins (/registrieren?key=…): dieselbe Seite, login.js traegt den Key ein.
app.get(['/registrieren', '/registrieren/'], (req, res) =>
  res.set('Cache-Control', 'no-cache').sendFile(join(import.meta.dirname, 'public', 'index.html')));
app.get(['/datenschutz', '/datenschutz/'], (req, res) =>
  res.set('Cache-Control', 'no-cache').sendFile(join(import.meta.dirname, 'public', 'index.html')));

// PWA-Icons werden erzeugt statt mitgeliefert - so bleiben keine Binaerdateien im Paket und das
// Icon passt immer zum Code. Einmal pro Groesse rechnen, danach aus dem Speicher.
const icons = new Map();
for (const [pfad, size] of [['/icon-192.png', 192], ['/icon-512.png', 512], ['/apple-touch-icon.png', 180]]) {
  app.get(pfad, (req, res) => {
    if (!icons.has(size)) icons.set(size, iconPng(size));
    res.set('Cache-Control', 'public, max-age=604800').type('png').send(icons.get(size));
  });
}

// --- Auth -------------------------------------------------------------------

const cookies = req => Object.fromEntries(
  (req.headers.cookie ?? '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), c.slice(i + 1)];
  }));

// Ohne maxAge waere das ein reines Sitzungscookie und beim Schliessen des Browsers weg - auf dem
// Handy meldete sich die App dauernd ab. Ein halbes Jahr deckt ein Schuljahr grob ab.
const SESSION_TAGE = 180;
db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', ?)").run(`-${SESSION_TAGE} days`);

// Gespeichert wird nur der Hash des Tokens. Grund: die Sicherung laedt die ganze Datenbank als
// Datei herunter (Downloads, E-Mail). Standen die Tokens im Klartext darin, koennte jeder, der sie
// in die Haende bekommt, jedes sid-Cookie nachbauen - ohne ein einziges Passwort zu brechen.
// Ein zufaelliges 128-Bit-Token braucht kein Salt und kein langsames Verfahren.
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');

// --- Zugangsdaten mit dem eigenen Passwort (Wahl im Profil, Vorgabe aus) ---------------------
// K entsteht aus Passwort + Salz und liegt nie in der Datenbank - nur verpackt in der Sitzung, und
// zwar mit einem Schluessel aus dem Cookie-Token. Vom Token kennt der Server bloss den Hash: K
// auspacken kann also nur eine Anfrage, die das Cookie des Nutzers mitbringt. Admin, Sicherung
// und Server-Schluessel allein reichen nicht. Der Preis: ohne den Nutzer kein Abgleich.
const versiegeln = (key, text) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), daten.toString('hex')].join(':');
};
const entsiegeln = (key, gespeichert) => {
  const [iv, tag, daten] = String(gespeichert).split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(daten, 'hex')), d.final()]).toString('utf8');
};
// scrypt ist teuer - es laeuft nur beim Anmelden, Einschalten und Passwortwechsel.
const zugangsSchluessel = (pw, salz) => scryptAsync(String(pw ?? '').slice(0, PW_MAX), 'zugang:' + salz);
const tokenSchluessel = token => createHash('sha256').update('zugang:' + String(token)).digest();

/** K in die Sitzung legen (oder herausnehmen) - verpackt mit dem Cookie-Token. */
const schluesselInSitzung = (token, K) => sql('UPDATE sessions SET zugang_k = ? WHERE token = ?')
  .run(K ? versiegeln(tokenSchluessel(token), K.toString('hex')) : null, tokenHash(token));

/** K dieser Anfrage - oder null (Option aus, oder diese Sitzung hat ihn nicht). */
function sitzungsSchluessel(req) {
  const token = cookies(req).sid;
  if (!token || !req.user?.zugang_eigen) return null;
  const verpackt = sql('SELECT zugang_k FROM sessions WHERE token = ?').get(tokenHash(token))?.zugang_k;
  if (!verpackt) return null;
  try { return Buffer.from(entsiegeln(tokenSchluessel(token), verpackt), 'hex'); } catch { return null; }
}

class OhneSchluessel extends Error {
  constructor() {
    super('Deine Zugangsdaten sind mit deinem Passwort verschlüsselt – melde dich einmal ab und wieder an, dann geht der Abgleich wieder.');
    this.status = 409;
  }
}

/** Das Passwort fuer WebUntis/IServ. 'u1:' heisst: mit dem eigenen Passwort verschluesselt. */
function zugangsPasswort(konto, K) {
  const s = String(konto?.secret ?? '');
  if (!s.startsWith('u1:')) return entschluesseln(s);
  if (!K) throw new OhneSchluessel();
  return entsiegeln(K, s.slice(3));
}
/** Zum Speichern: mit K, wenn der Nutzer das will - sonst wie immer mit dem Server-Schluessel. */
const zugangVerschluesseln = (u, K, passwort) =>
  (u.zugang_eigen ? 'u1:' + versiegeln(K, passwort) : verschluesseln(passwort));

function startSession(res, userId, K = null) {
  const token = randomUUID();
  db.prepare('INSERT INTO sessions(token, user_id) VALUES(?, ?)').run(tokenHash(token), userId);
  if (K) schluesselInSitzung(token, K);
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TAGE * 86_400_000,
    // Ohne secure schickt der Browser das 180-Tage-Token bei einem versehentlichen http://-Aufruf
    // im Klartext durchs Schul-WLAN. Lokal ohne TLS laeuft nur die Entwicklung.
    secure: process.env.NODE_ENV === 'production',
  });
}

// Alle Spalten ausser den Bildern (Avatar bis 100 KB, Banner bis 400 KB): die liess sonst JEDE
// Anfrage mitlesen. pub() braucht nur, OB es sie gibt - dafuer steht dann 0/1 unter demselben Namen.
const OHNE_BILDER = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  .filter(n => n !== 'avatar' && n !== 'banner').map(n => `u.${n}`).join(', ')
  + ', (u.avatar IS NOT NULL) AS avatar, (u.banner IS NOT NULL) AS banner';

const auth = (req, res, next) => {
  const token = cookies(req).sid;
  // Das Alter gehoert in die Abfrage: aufgeraeumt wird nur beim Start, ein Server laeuft aber
  // Monate durch - sonst waere ein erbeutetes Token unbegrenzt gueltig.
  const user = token && sql(`SELECT ${OHNE_BILDER} FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.created_at >= datetime('now', ?)`).get(tokenHash(token), `-${SESSION_TAGE} days`);
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  req.user = user;
  next();
};

const admin = (req, res, next) =>
  req.user.is_admin ? next() : res.status(403).json({ error: 'Nur für Admins' });

// Profilfelder begleiten jede Person, die irgendwo auftaucht. Das Bild bleibt draußen - die
// Antwort traegt nur has_avatar, das Bild holt der Browser einzeln und cached es per ETag.
const USER_COLS = `u.id, u.username, u.display_name, u.color, u.emoji, u.school_id, u.bild_v,
                   (u.avatar IS NOT NULL) AS has_avatar, (u.banner IS NOT NULL) AS has_banner`;
// Wie jemand heisst, wenn man ihn benennen muss - Anzeigename, sonst der Username.
const nameVon = u => u.display_name?.trim() || u.username;

const person = r => ({
  id: r.id, username: r.username, display_name: r.display_name,
  color: r.color, emoji: r.emoji, has_avatar: !!r.has_avatar, has_banner: !!r.has_banner,
  bild_v: r.bild_v ?? null,
});
// Die Menuepunkte, die sich sortieren lassen. 'admin' fehlt mit Absicht: wer sich den Zugang aus
// dem Blickfeld schiebt, kommt schlechter wieder heran. 'absence' steht hinten, weil es nur eine
// Info an Freunde ist und keine Krankmeldung.
const ANSICHTEN = ['plan', 'friends', 'chat', 'homework', 'buero', 'profile', 'absence', 'tickets'];

// Unbekanntes fliegt raus, Fehlendes wird angehaengt: eine gespeicherte Reihenfolge geht dadurch
// nicht kaputt, wenn spaeter ein Menuepunkt dazukommt oder verschwindet.
const navOrder = roh => {
  const gewaehlt = String(roh ?? '').split(',').filter(v => ANSICHTEN.includes(v));
  const eindeutig = [...new Set(gewaehlt)];
  return [...eindeutig, ...ANSICHTEN.filter(v => !eindeutig.includes(v))];
};

// Die Seiten, aus denen sich das Menue bauen laesst: die Ansichten und ihre Unterreiter. Der
// Server kennt sie, damit im Menue nur steht, was es auch gibt.
const SEITEN = [...ANSICHTEN, 'admin',
  'chat/dm', 'chat/gruppen', 'chat/kurs',
  'homework/hausaufgaben', 'homework/todos', 'homework/kalender', 'homework/nachrichten',
  'buero/notizen', 'buero/ideen', 'buero/abstimmungen', 'buero/umfragen',
  'profile/profil', 'profile/ansicht', 'profile/kurse', 'profile/nachrichten', 'profile/konto', 'profile/menue',
  'admin/raster', 'admin/stamm', 'admin/nutzer', 'admin/system', 'admin/texte', 'admin/raumplan'];

// Das eigene Menue: Seiten und Gruppen mit Seiten darin, eine Ebene tief. Unbekanntes und
// Doppeltes fliegt raus (das erste zaehlt), Admin-Seiten nur fuer Admins. Leere Gruppen bleiben:
// im Editor legt man erst die Gruppe an und dann die Seiten hinein. Ohne Eintrag gilt die
// Reihenfolge von frueher (nav_order) - eine gespeicherte Sortierung geht nicht verloren.
// Oben nur der Alltag; alles andere steht im Seitenmenue hinter ☰ (menue.js), das es immer gibt.
// Kein 'profile': das Profil oeffnet auch der eigene Name oben rechts.
const MENUE_VORGABE = ['plan', 'homework', 'tickets'];
const menue = u => {
  let roh = null;
  try { roh = JSON.parse(u.menue); } catch { /* keins oder kaputt */ }
  // Ohne eigenes Menue: wer frueher selbst sortiert hat, behaelt seine flache Reihenfolge. Alle
  // anderen bekommen den Alltag oben und den Rest unter "Mehr".
  if (!Array.isArray(roh)) roh = u.nav_order ? [...navOrder(u.nav_order), 'admin'] : MENUE_VORGABE;
  const gesehen = new Set();
  const seite = s => typeof s === 'string' && SEITEN.includes(s) && !gesehen.has(s)
    && (!!u.is_admin || !s.startsWith('admin')) && !!gesehen.add(s);
  const raus = [];
  for (const e of roh.slice(0, 40)) {
    if (seite(e)) raus.push(e);
    else if (e && typeof e === 'object' && !Array.isArray(e)) {
      const name = String(e.name ?? '').trim().slice(0, 30);
      if (!name) continue;
      raus.push({ name, icon: [...String(e.icon ?? '').trim()].slice(0, 8).join('') || '📁',
        kinder: (Array.isArray(e.kinder) ? e.kinder : []).filter(seite) });
    }
  }
  return raus;
};

const pub = u => ({
  ...person({ ...u, has_avatar: !!u.avatar, has_banner: !!u.banner }),
  is_admin: !!u.is_admin,
  nav_style: u.nav_style === 'icons' ? 'icons' : 'text',
  design: u.design === 'klassisch' ? 'klassisch' : 'modern',
  menue: menue(u),
  nachrichten_gesehen: u.nachrichten_gesehen ?? null,
  jetzt_stil: ['zeit', 'linie', 'tag'].includes(u.jetzt_stil) ? u.jetzt_stil : 'zeit',
  plan_stil: u.plan_stil === 'untis' ? 'untis' : 'standard',
  stunden_form: u.stunden_form === 'rund' ? 'rund' : 'eckig',
  ausfall_stil: u.ausfall_stil === 'klassisch' ? 'klassisch' : 'deutlich',
  pruefung_doppelt: u.pruefung_doppelt === 'untis' ? 'untis' : 'meine',
  zugang_eigen: !!u.zugang_eigen,
  pruefung_vorlauf_tage: Number.isInteger(u.pruefung_vorlauf_tage) ? u.pruefung_vorlauf_tage : 7,
  hw_erledigt_zeigen: u.hw_erledigt_zeigen === 1,
  dialog_hintergrund: u.dialog_hintergrund !== 0,
  toast_sekunden: Number.isInteger(u.toast_sekunden) ? u.toast_sekunden : 3,
  toast_fehler_bleibt: u.toast_fehler_bleibt !== 0,
  status_farben: statusFarben(u),
  nav_order: navOrder(u.nav_order),
  push_chat: u.push_chat !== 0,
  push_ausfall: u.push_ausfall !== 0,
  push_vertretung: u.push_vertretung !== 0,
  push_freunde: u.push_freunde !== 0,
  push_todo: u.push_todo !== 0,
  push_aenderung: u.push_aenderung !== 0,
  zeige_info: u.zeige_info === 1,
  hinweis_gesehen: u.hinweis_gesehen ?? null,
  push_plan: pushPlan(u),
  hw_erinnerung_min: Number(u.hw_erinnerung_min) || 0,
  frei_hinweis: u.frei_hinweis === 1,
  hw_badge: u.hw_badge !== 0,
  hw_loeschen_tage: Number.isInteger(u.hw_loeschen_tage) ? u.hw_loeschen_tage : 7,
  todo_loeschen_tage: Number.isInteger(u.todo_loeschen_tage) ? u.todo_loeschen_tage : 30,
  kalender_farben: kalAnsicht(u).farben,
  digest_zeit: /^([01]\d|2[0-3]):[0-5]\d$/.test(u.digest_zeit ?? '') ? u.digest_zeit : '19:00',
});
const byId = id => sql(`SELECT ${OHNE_BILDER} FROM users u WHERE u.id = ?`).get(id);

// Der Registrierungs-Key ist ein Zugangsmerkmal - Digests vergleichen statt ===.
const digest = s => createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

// ponytail: Fehlversuchszaehler im Prozessspeicher - faellt beim Neustart auf 0 und gilt nur fuer
// diesen Prozess. Reicht fuer eine Schul-Instanz; bei mehreren Prozessen gehoert er in die DB.
// Ein Zaehler je Schluessel, 15-Minuten-Fenster. Bewusst zwei Schluessel beim Login: die IP allein
// reicht nicht (hinter dem Proxy teilen sich viele eine), der Ziel-Username allein auch nicht
// (dann sperrt ein Angreifer fremde Konten aus). Und ein erfolgreicher Login raeumt nur seinen
// eigenen Schluessel ab - sonst genuegte ein eigenes Konto, um unbegrenzt weiterzuraten.
const fails = new Map();
const FAIL_MAX = 10, FAIL_WINDOW = 15 * 60_000;
// Registrierungen je IP und Viertelstunde (auch erfolgreiche). Eine Klasse im Schul-WLAN teilt sich
// eine IP - reicht 60 nicht, laesst es sich ueber REG_MAX anheben.
const REG_MAX = Number(process.env.REG_MAX ?? 60);
const fresh = e => e && Date.now() - e.first <= FAIL_WINDOW;

function zaehle(schluessel) {
  const e = fails.get(schluessel);
  if (fresh(e)) e.n++;
  else fails.set(schluessel, { n: 1, first: Date.now() });
  if (fails.size > 5000) for (const [k, v] of fails) if (!fresh(v)) fails.delete(k);
}
const zuOft = (schluessel, max = FAIL_MAX) => {
  const e = fails.get(schluessel);
  return fresh(e) && e.n >= max;
};
const vergiss = (...schluessel) => schluessel.forEach(k => fails.delete(k));

// Die Obergrenze ist kein Komfortlimit: scrypt rechnet ueber die volle Laenge, und ohne Deckel
// legt ein 1-MB-"Passwort" den einzigen Thread lahm.
const PW_MIN = 4, PW_MAX = 128;

// Fehler von WebUntis sind fuer den Nutzer gedacht, nicht als Fenster in unseren Server: Pfade,
// Stacktraces und Roh-Antworten bleiben draussen.
const kurzerFehler = err => {
  const t = String(err?.message ?? '').replace(/\s+/g, ' ').trim();
  // Alles, was nach Pfad, Port oder Stacktrace aussieht, bleibt draussen.
  return !t || /[\\/]|:\d{2,5}\b/.test(t) ? 'unbekannter Fehler' : t.slice(0, 120);
};
const passwortFehler = pw => {
  const t = String(pw ?? '');
  if (t.length < PW_MIN) return `Passwort ist zu kurz (mindestens ${PW_MIN} Zeichen)`;
  if (t.length > PW_MAX) return `Passwort ist zu lang (max. ${PW_MAX} Zeichen)`;
  return null;
};

// Zwei Zaehler mit verschiedenen Grenzen. Die IP ist die eigentliche Bremse (10). Der
// Ziel-Username bremst zusaetzlich verteiltes Raten ueber viele IPs, aber mit hoeherer Grenze
// (30): sonst koennte jemand ein fremdes Konto mit zehn Fehlversuchen absichtlich aussperren.
const KONTO_MAX = 30;
const authSchluessel = (req, username) =>
  [[`ip:${req.ip}`, FAIL_MAX], [`user:${String(username ?? '').trim().toLowerCase()}`, KONTO_MAX]];
const throttled = (req, res, username) =>
  authSchluessel(req, username).some(([k, max]) => zuOft(k, max))
  && !!res.status(429).json({ error: 'Zu viele Versuche, bitte später erneut' });

// Fuer die Routen, die nach draussen gehen oder Arbeit machen: zaehlt jeden Aufruf, nicht nur
// Fehlversuche. Ohne das ist die App ein unbegrenzter Proxy auf WebUntis.
function bremse(name, max) {
  return (req, res, next) => {
    const k = `${name}:${req.user.id}`;
    if (zuOft(k, max)) return res.status(429).json({ error: 'Zu viele Anfragen, bitte kurz warten' });
    zaehle(k);
    next();
  };
}

app.get('/api/public-config', (req, res) =>
  res.json({ registration: getSetting('registration_mode', 'open') }));

// Version, Neuigkeiten und Datenschutzerklaerung - bewusst ohne Anmeldung: eine
// Datenschutzerklaerung, die man erst nach dem Anmelden lesen kann, ist keine.
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')).version;
const TEXTE = ['news', 'privacy', 'hinweis'];

app.get('/api/info', (req, res) => res.json({
  version: VERSION,
  // Fuer die Android-App: "Verbunden mit: Gymnasium X" - und ob unter der Adresse ueberhaupt ein
  // Stundenplan laeuft. Bewusst ohne Anmeldung, wie der Rest hier.
  app: 'stundenplan',
  schule: standardSchule()?.name ?? null,
  news: getSetting('news', ''),
  privacy: getSetting('privacy', ''),
  news_at: getSetting('news_at', null),
  privacy_at: getSetting('privacy_at', null),
  // Die einmalige Nachricht, dazu ihre Fassung. Bewusst aus dem TEXT gerechnet und nicht der
  // Zeitstempel: der steht nur auf die Minute genau, und eine Tippfehlerkorrektur eine halbe
  // Minute spaeter waere fuer alle, die schon weggeklickt haben, nie erschienen.
  hinweis: getSetting('hinweis', ''),
  hinweis_at: getSetting('hinweis_at', null),
  hinweis_ver: hinweisFassung(),
}));

// Die Fassung der einmaligen Nachricht: ihr eigener Text, kurz zusammengefasst. Gleicher Text =
// gleiche Fassung, jede Aenderung eine neue - genau das, was "einmal zeigen" braucht.
const hinweisFassung = () => {
  const t = getSetting('hinweis', '');
  return t ? createHash('sha256').update(t).digest('hex').slice(0, 16) : null;
};

// Feste Liste statt beliebigem Schluessel: sonst waere das ein Schreibzugriff auf alle
// Einstellungen, inklusive Registrierungs-Key und WebUntis-Schule.
app.put('/api/settings/text', auth, admin, (req, res) => {
  const key = String(req.body?.key ?? '');
  if (!TEXTE.includes(key)) return res.status(400).json({ error: 'Unbekannter Text' });
  const text = String(req.body?.text ?? '').slice(0, 20_000);
  setSetting(key, text);
  setSetting(`${key}_at`, new Date().toISOString().slice(0, 16).replace('T', ', '));
  res.json({ ok: true, at: getSetting(`${key}_at`) });
});

app.post('/api/register', async (req, res) => {
  const { username, password, key } = req.body ?? {};
  if (throttled(req, res, username)) return;
  // Auch erfolgreiche Registrierungen zaehlen - sonst legt ein Skript beliebig viele Konten an.
  // 60 je Viertelstunde und IP: eine ganze Klasse im Schul-WLAN kommt noch durch.
  if (zuOft(`reg:${req.ip}`, REG_MAX)) return res.status(429).json({ error: 'Zu viele Versuche, bitte später erneut' });
  const mode = getSetting('registration_mode', 'open');
  if (mode === 'off') return res.status(403).json({ error: 'Registrierung ist deaktiviert' });
  if (mode === 'key') {
    // Ohne hinterlegten Key waere safeEqual('', '') wahr und jeder käme ohne Key durch.
    const expected = getSetting('registration_key', '');
    if (!expected || !safeEqual(key ?? '', expected)) {
      zaehle(`ip:${req.ip}`);
      return res.status(403).json({ error: 'Falscher Registrierungs-Key' });
    }
  }
  const name = String(username ?? '').trim();
  if (!name || !password) return res.status(400).json({ error: 'Username und Passwort nötig' });
  if (name.length > 40) return res.status(400).json({ error: 'Username ist zu lang (max. 40 Zeichen)' });
  const pwFehler = passwortFehler(password);
  if (pwFehler) return res.status(400).json({ error: pwFehler });
  try {
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO users(username, pw, created_at) VALUES(?, ?, datetime('now'))")
      .run(name, await hash(String(password)));
    zaehle(`reg:${req.ip}`);
    startSession(res, Number(lastInsertRowid));
    res.json(pub(byId(Number(lastInsertRowid))));
  } catch {
    res.status(409).json({ error: 'Username schon vergeben' });
  }
});

let attrappe = null;
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (throttled(req, res, username)) return;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
  // Ohne Nutzer trotzdem einmal scrypt rechnen - sonst verriete die Antwortzeit, welche Namen es gibt.
  if (!user) await verify(String(password ?? '').slice(0, PW_MAX), attrappe ??= await hash(randomUUID()));
  if (!user || !await verify(String(password ?? '').slice(0, PW_MAX), user.pw)) {
    authSchluessel(req, username).forEach(([k]) => zaehle(k));
    return res.status(401).json({ error: 'Falscher Username oder falsches Passwort' });
  }
  vergiss(...authSchluessel(req, username).map(([k]) => k));
  startSession(res, user.id, user.zugang_eigen && user.zugang_salt
    ? await zugangsSchluessel(password, user.zugang_salt) : null);
  // Erstinstallation ohne ADMIN_PW legt admin/admin an - daran erinnern, bis es geaendert ist.
  res.json({ ...pub(user), standard_passwort: !!user.is_admin && String(password) === 'admin' });
});

app.post('/api/logout', (req, res) => {
  const token = cookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
  res.clearCookie('sid', { path: '/' }).json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ ...pub(req.user),
  // Nur mit eigener Verschluesselung interessant: kann DIESE Sitzung abgleichen?
  zugang_bereit: !req.user.zugang_eigen || !!sitzungsSchluessel(req) }));

/**
 * Zugangsdaten nur mit dem eigenen Passwort verschluesseln - ein- und ausschalten.
 *
 * Das Passwort braucht es so oder so: daraus entsteht K. Ein vorhandener Zugang wird umgepackt,
 * damit niemand ihn neu eingeben muss.
 */
app.post('/api/me/zugang', auth, bremse('zugang', 10), async (req, res) => {
  const pw = String(req.body?.password ?? '').slice(0, PW_MAX);
  if (!await verify(pw, req.user.pw)) return res.status(401).json({ error: 'Passwort stimmt nicht' });
  const an = !!req.body?.an;
  const konto = db.prepare('SELECT secret FROM untis_accounts WHERE user_id = ?').get(req.user.id);
  const token = cookies(req).sid;
  try {
    if (an) {
      const salz = randomBytes(16).toString('hex');
      const K = await zugangsSchluessel(pw, salz);
      // Schon an: erst mit dem alten K auspacken (gleiches Passwort, altes Salz).
      const altK = req.user.zugang_eigen && req.user.zugang_salt ? await zugangsSchluessel(pw, req.user.zugang_salt) : null;
      const klar = konto?.secret ? zugangsPasswort(konto, altK) : null;
      transaktion(() => {
        db.prepare('UPDATE users SET zugang_eigen = 1, zugang_salt = ? WHERE id = ?').run(salz, req.user.id);
        if (klar !== null) db.prepare('UPDATE untis_accounts SET secret = ? WHERE user_id = ?')
          .run('u1:' + versiegeln(K, klar), req.user.id);
        // Andere Geraete haben K nicht - dort geht der Abgleich nach dem naechsten Anmelden wieder.
        db.prepare('UPDATE sessions SET zugang_k = NULL WHERE user_id = ?').run(req.user.id);
      });
      schluesselInSitzung(token, K);
    } else {
      const K = req.user.zugang_salt ? await zugangsSchluessel(pw, req.user.zugang_salt) : null;
      const klar = konto?.secret ? zugangsPasswort(konto, K) : null;
      if (klar !== null && !untisKey()) return res.status(400).json({ error: untisStatus().hinweis });
      transaktion(() => {
        db.prepare('UPDATE users SET zugang_eigen = 0, zugang_salt = NULL WHERE id = ?').run(req.user.id);
        if (klar !== null) db.prepare('UPDATE untis_accounts SET secret = ? WHERE user_id = ?')
          .run(verschluesseln(klar), req.user.id);
        db.prepare('UPDATE sessions SET zugang_k = NULL WHERE user_id = ?').run(req.user.id);
      });
    }
  } catch {
    return res.status(409).json({ error: 'Die gespeicherten Zugangsdaten ließen sich nicht umpacken – trag sie im Profil neu ein' });
  }
  const u = byId(req.user.id);
  res.json({ ...pub(u), zugang_bereit: true });
});

// --- Eigenes Profil ---------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
const AVATAR = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Der behauptete Typ ist nur eine Behauptung - geprueft wird, womit die Datei wirklich anfaengt.
// Sonst laege beliebiger Inhalt unter einem Content-Type unserer Wahl auf unserem eigenen Origin.
const MAGIE = {
  png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

// Trust-Boundary: was hier reinkommt, liefern wir spaeter als Bild wieder aus.
function badImage(v, maxLen) {
  if (typeof v !== 'string' || v.length > maxLen) return `Bild ist zu groß (max. ${Math.round(maxLen / 1000)} KB)`;
  const m = AVATAR.exec(v);
  if (!m) return 'Nur PNG, JPEG oder WebP als Data-URL';
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return 'Bild ist leer';
  if (bytes.length < 12 || !MAGIE[m[1]](bytes)) return `Das ist kein ${m[1].toUpperCase()}-Bild`;
  return null;
}

// Bild aus einer Data-URL binaer ausliefern. no-cache heisst "immer neu validieren", nicht "nie
// cachen" - Express' ETag macht daraus 304er, und ein neues Bild ist sofort sichtbar.
const sendImage = (res, dataUrl) => {
  const m = dataUrl && AVATAR.exec(dataUrl);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'no-cache').type(`image/${m[1]}`).send(Buffer.from(m[2], 'base64'));
};
// Mit ?v= (die Bild-Version aus person()) aendert sich die Adresse bei jedem neuen Bild - dann darf
// der Browser es behalten, statt fuer jeden Avatar in jeder Liste nachzufragen.
const sendBild = (req, res, dataUrl) => {
  if (req.query.v) res.set('Cache-Control', 'private, max-age=31536000, immutable');
  const m = dataUrl && AVATAR.exec(dataUrl);
  if (!m) return res.status(404).end();
  if (!req.query.v) res.set('Cache-Control', 'no-cache');
  res.type(`image/${m[1]}`).send(Buffer.from(m[2], 'base64'));
};

app.patch('/api/me', auth, (req, res) => {
  const b = req.body ?? {};
  const sets = [], args = [];
  if ('display_name' in b) {
    sets.push('display_name = ?');
    args.push(String(b.display_name ?? '').trim().slice(0, 40) || null);
  }
  if ('color' in b) {
    if (b.color && !HEX.test(b.color)) return res.status(400).json({ error: 'Farbe muss #rrggbb sein' });
    sets.push('color = ?'); args.push(b.color || null);
  }
  if ('emoji' in b) {
    const v = String(b.emoji ?? '').trim();
    if ([...v].length > 2) return res.status(400).json({ error: 'Höchstens ein Emoji' });
    sets.push('emoji = ?'); args.push(v || null);
  }
  if ('nav_style' in b) {
    if (!['text', 'icons'].includes(b.nav_style))
      return res.status(400).json({ error: 'Navigation: nur text oder icons' });
    sets.push('nav_style = ?'); args.push(b.nav_style);
  }
  if ('design' in b) {
    if (!['modern', 'klassisch'].includes(b.design))
      return res.status(400).json({ error: 'Design: nur modern oder klassisch' });
    sets.push('design = ?'); args.push(b.design);
  }
  if ('jetzt_stil' in b) {
    if (!['zeit', 'linie', 'tag'].includes(b.jetzt_stil))
      return res.status(400).json({ error: 'Zeitstrich: nur zeit, linie oder tag' });
    sets.push('jetzt_stil = ?'); args.push(b.jetzt_stil);
  }
  if ('stunden_form' in b) {
    if (!['eckig', 'rund'].includes(b.stunden_form))
      return res.status(400).json({ error: 'Stunden: nur eckig oder rund' });
    sets.push('stunden_form = ?'); args.push(b.stunden_form);
  }
  if ('ausfall_stil' in b) {
    if (!['deutlich', 'klassisch'].includes(b.ausfall_stil))
      return res.status(400).json({ error: 'Ausfall: nur deutlich oder klassisch' });
    sets.push('ausfall_stil = ?'); args.push(b.ausfall_stil);
  }
  if ('pruefung_doppelt' in b) {
    if (!['meine', 'untis'].includes(b.pruefung_doppelt))
      return res.status(400).json({ error: 'Doppelte Prüfung: nur meine oder untis' });
    sets.push('pruefung_doppelt = ?'); args.push(b.pruefung_doppelt);
  }
  if ('plan_stil' in b) {
    if (!['standard', 'untis'].includes(b.plan_stil))
      return res.status(400).json({ error: 'Darstellung: nur standard oder untis' });
    sets.push('plan_stil = ?'); args.push(b.plan_stil);
  }
  // Wie die Kalenderfarben: Unbekanntes und Unfarbiges wird verworfen, der Rest mit dem Alten
  // zusammengefuehrt - so kann eine Farbe allein geschickt werden.
  if ('status_farben' in b) {
    const neu = statusFarben({ status_farben: JSON.stringify({ ...statusFarben(req.user), ...(b.status_farben ?? {}) }) });
    sets.push('status_farben = ?'); args.push(JSON.stringify(neu));
  }
  for (const feld of ['push_chat', 'push_ausfall', 'push_vertretung', 'push_freunde', 'push_todo', 'push_aenderung']) {
    if (!(feld in b)) continue;
    sets.push(`${feld} = ?`); args.push(b[feld] ? 1 : 0);
  }
  if ('zeige_info' in b) { sets.push('zeige_info = ?'); args.push(b.zeige_info ? 1 : 0); }
  // Standardmaessig aus: die Meldung nennt Namen, und das soll niemand ungefragt verschicken.
  if ('frei_hinweis' in b) { sets.push('frei_hinweis = ?'); args.push(b.frei_hinweis ? 1 : 0); }
  if ('hw_badge' in b) { sets.push('hw_badge = ?'); args.push(b.hw_badge ? 1 : 0); }
  if ('hw_erledigt_zeigen' in b) { sets.push('hw_erledigt_zeigen = ?'); args.push(b.hw_erledigt_zeigen ? 1 : 0); }
  if ('dialog_hintergrund' in b) { sets.push('dialog_hintergrund = ?'); args.push(b.dialog_hintergrund ? 1 : 0); }
  if ('toast_fehler_bleibt' in b) { sets.push('toast_fehler_bleibt = ?'); args.push(b.toast_fehler_bleibt ? 1 : 0); }
  if ('toast_sekunden' in b) {
    sets.push('toast_sekunden = ?');
    args.push(Math.min(Math.max(Math.trunc(Number(b.toast_sekunden)) || 0, 1), 30));
  }
  if ('pruefung_vorlauf_tage' in b) {
    sets.push('pruefung_vorlauf_tage = ?');
    args.push(Math.min(Math.max(Math.trunc(Number(b.pruefung_vorlauf_tage) || 0), 0), 60));
  }
  // 0 = nie; nach oben gedeckelt, damit "99999" nicht zum Nie mit wachsender Tabelle wird.
  if ('hw_loeschen_tage' in b) {
    sets.push('hw_loeschen_tage = ?');
    args.push(Math.min(Math.max(Math.trunc(Number(b.hw_loeschen_tage) || 0), 0), 365));
  }
  if ('todo_loeschen_tage' in b) {
    sets.push('todo_loeschen_tage = ?');
    args.push(Math.min(Math.max(Math.trunc(Number(b.todo_loeschen_tage) || 0), 0), 365));
  }
  // Die Farben der Kalender-Ebenen. Was nicht durch kalAnsicht() kommt, wird verworfen - der
  // Client schlaegt vor, er bestimmt nicht.
  if ('kalender_farben' in b) {
    const alt = kalAnsicht(req.user);
    const sauber = kalAnsicht({ kalender_farben: JSON.stringify({ farben: b.kalender_farben ?? {} }) });
    sets.push('kalender_farben = ?');
    args.push(JSON.stringify({ farben: sauber.farben, aus: alt.aus, ohne: alt.ohne }));
  }
  // Ebenen ein- und ausblenden (Ferien) - dieselbe Ablage wie die Farben.
  if ('kalender_ohne' in b) {
    const alt = kalAnsicht(req.user);
    const ohne = kalAnsicht({ kalender_farben: JSON.stringify({ ohne: b.kalender_ohne ?? [] }) }).ohne;
    sets.push('kalender_farben = ?');
    args.push(JSON.stringify({ farben: alt.farben, aus: alt.aus, ohne }));
  }
  // Der Benachrichtigungsplan wird durch pushPlan() gefiltert, bevor er gespeichert wird -
  // was der Client schickt, ist ein Vorschlag, kein Befehl.
  if ('push_plan' in b) {
    const sauber = pushPlan({ push_plan: JSON.stringify(b.push_plan ?? {}) });
    sets.push('push_plan = ?'); args.push(JSON.stringify(sauber));
  }
  if ('hw_erinnerung_min' in b) {
    sets.push('hw_erinnerung_min = ?');
    args.push(Math.min(Math.max(Number(b.hw_erinnerung_min) || 0, 0), 7 * 24 * 60));
  }
  if ('digest_zeit' in b) {
    const t = String(b.digest_zeit ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))
      return res.status(400).json({ error: 'Uhrzeit als HH:MM' });
    sets.push('digest_zeit = ?'); args.push(t);
  }
  if ('nav_order' in b) {
    const liste = Array.isArray(b.nav_order) ? b.nav_order : String(b.nav_order ?? '').split(',');
    if (liste.some(v => !ANSICHTEN.includes(v)))
      return res.status(400).json({ error: 'Unbekannter Menüpunkt' });
    sets.push('nav_order = ?'); args.push(navOrder(liste.join(',')).join(','));
  }
  // Das ganze Menue auf einmal, durch denselben Filter wie beim Lesen; null = zurueck zur Vorgabe.
  if ('menue' in b) {
    if (b.menue !== null && !Array.isArray(b.menue)) return res.status(400).json({ error: 'Menü ist keine Liste' });
    sets.push('menue = ?');
    args.push(b.menue === null ? null : JSON.stringify(menue({ ...req.user, menue: JSON.stringify(b.menue) })));
  }
  for (const [feld, max] of [['avatar', 100_000], ['banner', 400_000]]) {
    if (!(feld in b)) continue;
    const err = b[feld] ? badImage(b[feld], max) : null;
    if (err) return res.status(400).json({ error: err });
    sets.push(`${feld} = ?`); args.push(b[feld] || null);
    if (!sets.includes('bild_v = ?')) { sets.push('bild_v = ?'); args.push(Date.now()); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nichts zu ändern' });
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.user.id);
  res.json(pub(byId(req.user.id)));
});

// Was hier gespeichert wird, bestimmt der Server: der Client soll nicht behaupten koennen, er
// habe eine Nachricht gesehen, die es noch gar nicht gibt.
app.post('/api/me/hinweis-gelesen', auth, (req, res) => {
  const ver = hinweisFassung() ?? '';
  db.prepare('UPDATE users SET hinweis_gesehen = ? WHERE id = ?').run(ver, req.user.id);
  res.json({ hinweis_gesehen: ver });
});

// Die hoechste gesehene Schul-Nachricht: nur aufwaerts, und nie ueber das hinaus, was es gibt.
// Ohne `id` alles bis heute - so holt das erste Oeffnen still auf, statt 60 Tage nachzureichen.
app.post('/api/me/nachrichten-gelesen', auth, (req, res) => {
  const max = db.prepare('SELECT max(id) m FROM nachrichten WHERE school_id = ?')
    .get(schuleVon(req.user.id).id).m ?? 0;
  const wunsch = req.body?.id == null ? max : Math.trunc(Number(req.body.id)) || 0;
  const id = Math.min(Math.max(wunsch, Number(req.user.nachrichten_gesehen) || 0), max);
  db.prepare('UPDATE users SET nachrichten_gesehen = ? WHERE id = ?').run(id, req.user.id);
  res.json({ nachrichten_gesehen: id });
});

// --- Schluessel fuer den Ende-zu-Ende-Chat ----------------------------------
// Der Server verwahrt sie nur. Entschluesseln kann er nichts: der private Schluessel ist mit dem
// Login-Passwort verschlossen, und das sieht er nur beim Anmelden, ohne es zu speichern.

app.get('/api/me/keys', auth, (req, res) => res.json({
  pub_key: req.user.pub_key ?? null,
  priv_key_enc: req.user.priv_key_enc ?? null,
}));

app.put('/api/me/keys', auth, (req, res) => {
  const pub = String(req.body?.pub_key ?? '').slice(0, 2000);
  const priv = String(req.body?.priv_key_enc ?? '').slice(0, 4000);
  if (!pub || !priv) return res.status(400).json({ error: 'Beide Schlüsselteile nötig' });
  // Ein bestehendes Paar zu ersetzen macht rueckwirkend JEDE Nachricht unlesbar - auch fuer die
  // Gegenueber, weil das gemeinsame Geheimnis am oeffentlichen Schluessel haengt. Das darf nicht
  // aus Versehen passieren, also verlangt der Server es ausdruecklich. Nur der Notausgang schickt
  // das Flag; das normale Einrichten kommt hier gar nicht erst an.
  if (req.user.pub_key && !req.body?.ersetzen)
    return res.status(409).json({ error: 'Es gibt schon einen Chat-Schlüssel für dieses Konto' });
  db.prepare('UPDATE users SET pub_key = ?, priv_key_enc = ? WHERE id = ?').run(pub, priv, req.user.id);
  res.json({ ok: true });
});

// Unter Freunden - und unter Leuten, die eine Gruppe teilen (auch wenn die Einladung noch offen
// ist: wer einlaedt, muss den Gruppenschluessel fuer den Eingeladenen verpacken koennen, und dafuer
// braucht er dessen OEFFENTLICHEN Schluessel). Oeffentlich ist er ohnehin - die Beschraenkung
// verraet nur nicht, wer ueberhaupt einen hat.
const teiltGruppe = (a, b) => !!db.prepare(`SELECT 1 FROM group_members x JOIN group_members y
  ON y.group_id = x.group_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1`).get(a, b);

app.get('/api/keys/:id', auth, (req, res) => {
  const other = Number(req.params.id);
  if (other !== req.user.id && !istFreund(req.user.id, other) && !teiltGruppe(req.user.id, other))
    return res.status(403).json({ error: 'Ihr seid nicht befreundet' });
  res.json({ pub_key: db.prepare('SELECT pub_key FROM users WHERE id = ?').get(other)?.pub_key ?? null });
});

// Nur pruefen, nichts aendern. Der Notausgang im Chat verpackt ein neues Schluesselpaar mit einem
// Passwort, das der Nutzer eintippt - stimmt es nicht, laesst sich auch das NEUE Paar nie wieder
// oeffnen, und der Tippfehler ist genauso teuer wie der Schaden, den er reparieren sollte.
app.post('/api/me/passwort-pruefen', auth, bremse('pwpruef', 20), async (req, res) => {
  const ok = await verify(String(req.body?.password ?? '').slice(0, PW_MAX), req.user.pw);
  res.status(ok ? 200 : 401).json(ok ? { ok: true } : { error: 'Passwort stimmt nicht' });
});

app.post('/api/me/password', auth, bremse('passwort', 10), async (req, res) => {
  const { current, new: next } = req.body ?? {};
  if (!await verify(String(current ?? '').slice(0, PW_MAX), req.user.pw))
    return res.status(401).json({ error: 'Aktuelles Passwort stimmt nicht' });
  const fehler = passwortFehler(next);
  if (fehler) return res.status(400).json({ error: fehler });

  // Der private Chat-Schluessel haengt am Passwort: er liegt mit dem ALTEN verschlossen beim
  // Server, der Browser packt ihn neu ein und schickt ihn mit. Kommt er nicht mit, waere der
  // Schluessel danach mit einem Passwort verschlossen, das es nicht mehr gibt - unwiederbringlich,
  // ohne dass es jemand merkt. Genau so sind Verlaeufe verlorengegangen. Deshalb muss der Browser
  // sich hier entscheiden: entweder den neu verpackten Schluessel mitschicken, oder ausdruecklich
  // sagen, dass er verworfen werden soll.
  const neuerKey = req.body?.priv_key_enc ? String(req.body.priv_key_enc).slice(0, 4000) : null;
  const verwerfen = !!req.body?.chat_key_verwerfen;
  if (req.user.priv_key_enc && !neuerKey && !verwerfen)
    return res.status(409).json({ error: 'Der Chat-Schlüssel konnte nicht mit übernommen werden' });

  // Ein Statement, damit es keinen halben Zustand geben kann.
  if (verwerfen && !neuerKey)
    db.prepare('UPDATE users SET pw = ?, pub_key = NULL, priv_key_enc = NULL WHERE id = ?')
      .run(await hash(String(next)), req.user.id);
  else if (neuerKey)
    db.prepare('UPDATE users SET pw = ?, priv_key_enc = ? WHERE id = ?')
      .run(await hash(String(next)), neuerKey, req.user.id);
  else
    db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(await hash(String(next)), req.user.id);
  // Mit dem eigenen Passwort verschluesselte Zugangsdaten werden mitgenommen: das alte Passwort
  // ist hier bekannt, also auspacken und mit dem neuen wieder einpacken. Verloren sind sie nur
  // bei einem Reset, bei dem niemand das alte Passwort kennt.
  if (req.user.zugang_eigen) {
    const salz = randomBytes(16).toString('hex');
    const neuK = await zugangsSchluessel(next, salz);
    const konto = db.prepare('SELECT secret FROM untis_accounts WHERE user_id = ?').get(req.user.id);
    let klar = null;
    try {
      klar = konto?.secret ? zugangsPasswort(konto, await zugangsSchluessel(current, req.user.zugang_salt)) : null;
    } catch { klar = null; }
    db.prepare('UPDATE users SET zugang_salt = ? WHERE id = ?').run(salz, req.user.id);
    if (klar !== null) db.prepare('UPDATE untis_accounts SET secret = ? WHERE user_id = ?')
      .run('u1:' + versiegeln(neuK, klar), req.user.id);
    else if (konto) db.prepare("DELETE FROM untis_accounts WHERE user_id = ? AND secret LIKE 'u1:%'").run(req.user.id);
    schluesselInSitzung(cookies(req).sid, neuK);
  }
  // Alle anderen Sitzungen abmelden, die eigene behalten.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
    .run(req.user.id, tokenHash(cookies(req).sid));
  res.json({ ok: true });
});

for (const feld of ['avatar', 'banner']) {
  app.get(`/api/users/:id/${feld}`, auth, (req, res) =>
    sendBild(req, res, db.prepare(`SELECT ${feld} FROM users WHERE id = ?`).get(Number(req.params.id))?.[feld]));
}

// --- Nutzerverwaltung (Admin) ------------------------------------------------

const adminCount = () => db.prepare('SELECT count(*) AS c FROM users WHERE is_admin = 1').get().c;

app.get('/api/users', auth, admin, (req, res) => res.json(
  db.prepare(`SELECT ${USER_COLS}, u.is_admin, u.created_at FROM users u ORDER BY u.username`).all()
    .map(r => ({ ...person(r), is_admin: !!r.is_admin, created_at: r.created_at }))));

app.post('/api/users', auth, admin, async (req, res) => {
  const { username, password, is_admin } = req.body ?? {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Username und Passwort nötig' });
  try {
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO users(username, pw, is_admin, created_at) VALUES(?, ?, ?, datetime('now'))")
      .run(username.trim(), await hash(String(password)), is_admin ? 1 : 0);
    res.json(pub(byId(Number(lastInsertRowid))));
  } catch { res.status(409).json({ error: 'Username schon vergeben' }); }
});

app.patch('/api/users/:id', auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const target = byId(id);
  if (!target) return res.status(404).json({ error: 'User nicht gefunden' });
  const b = req.body ?? {};
  if ('is_admin' in b) {
    const next = b.is_admin ? 1 : 0;
    // Ohne diese zwei Sperren kann sich die Instanz selbst unbedienbar machen.
    if (!next && id === req.user.id)
      return res.status(409).json({ error: 'Du kannst dir nicht selbst die Adminrechte nehmen' });
    if (!next && target.is_admin && adminCount() <= 1)
      return res.status(409).json({ error: 'Es muss mindestens ein Admin übrig bleiben' });
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(next, id);
  }
  if (b.password) {
    const fehler = passwortFehler(b.password);
    if (fehler) return res.status(400).json({ error: fehler });
    // Der hinterlegte Chat-Schluessel ist mit dem alten Passwort verpackt, das hier gerade
    // verschwindet - er ist ab sofort nicht mehr zu oeffnen. Ihn stehen zu lassen hilft niemandem:
    // der Nutzer haengt dann in "Passwort stimmt nicht" fest, obwohl es stimmt. Also weg damit,
    // dann legt sein Browser beim naechsten Anmelden sauber ein neues Paar an.
    db.prepare('UPDATE users SET pw = ?, pub_key = NULL, priv_key_enc = NULL WHERE id = ?')
      .run(await hash(String(b.password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // Reset meldet den User ab
    // Mit dem eigenen (alten) Passwort verschluesselte Zugangsdaten sind ab jetzt nicht mehr zu
    // oeffnen - weg damit, der Nutzer traegt sie neu ein.
    db.prepare("DELETE FROM untis_accounts WHERE user_id = ? AND secret LIKE 'u1:%'").run(id);
  }
  if ('username' in b) {
    const name = String(b.username ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Username nötig' });
    try { db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, id); }
    catch { return res.status(409).json({ error: 'Username schon vergeben' }); }
  }
  if ('display_name' in b) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(String(b.display_name ?? '').trim().slice(0, 40) || null, id);
  }
  res.json(pub(byId(id)));
});

app.delete('/api/users/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(409).json({ error: 'Dich selbst kannst du nicht löschen' });
  const target = byId(id);
  if (!target) return res.status(404).json({ error: 'User nicht gefunden' });
  if (target.is_admin && adminCount() <= 1)
    return res.status(409).json({ error: 'Es muss mindestens ein Admin übrig bleiben' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/settings', auth, admin, (req, res) => res.json({
  registration_mode: getSetting('registration_mode', 'open'),
  registration_key: getSetting('registration_key', ''),
  rss_url: standardSchule()?.rss_url ?? '',
}));

// Zwei Karten, eine Route: jede schickt nur ihre Felder, der Rest bleibt unangetastet.
app.put('/api/settings', auth, admin, async (req, res) => {
  const b = req.body ?? {};
  if ('registration_mode' in b) {
    const mode = b.registration_mode;
    if (!['open', 'key', 'off'].includes(mode))
      return res.status(400).json({ error: 'Modus muss open, key oder off sein' });
    const key = String(b.registration_key ?? '').trim();
    if (mode === 'key' && key.length < 4)
      return res.status(400).json({ error: 'Der Key braucht mindestens 4 Zeichen' });
    setSetting('registration_mode', mode);
    setSetting('registration_key', key);
  }
  if ('rss_url' in b) {
    // Der Feed der Standardschule - dieselbe Sperre wie bei Kalender-Abos: der Server holt ihn.
    const rss = String(b.rss_url ?? '').trim().slice(0, 500);
    if (rss) {
      if (!/^https:\/\//i.test(rss) || !hostOk(netzOhneSchema(rss)))
        return res.status(400).json({ error: 'Nur https, und keine Adresse aus dem internen Netz' });
      if (!(await adresseErlaubt(netzOhneSchema(rss))))
        return res.status(400).json({ error: 'Diese Adresse führt nicht ins offene Netz' });
    }
    // Neue Adresse: beim naechsten Abgleich sofort holen, nicht erst in einer Stunde.
    db.prepare('UPDATE schools SET rss_url = ?, nachrichten_geholt = NULL WHERE standard = 1')
      .run(rss || null);
  }
  res.json({
    registration_mode: getSetting('registration_mode', 'open'),
    registration_key: getSetting('registration_key', ''),
    rss_url: standardSchule()?.rss_url ?? '',
  });
});

// --- Stammdaten (lesen: alle, schreiben: Admin) ------------------------------

app.get('/api/config', auth, (req, res) => {
  // Das Raster gehoert zur Schule: wer woanders zur Schule geht, hat andere Klingelzeiten.
  const schule = schuleVon(req.user.id);
  res.json({
    days: db.prepare('SELECT * FROM days ORDER BY iso').all(),
    periods: periodsFuer(schule.id),
    schule: schuleNachAussen(schule),
  });
});

// subjects/rooms/teachers sind bis auf das Fach-Kuerzel gleich gebaut -> eine Schleife ueber die
// jeweiligen Spalten statt drei Routenblöcke.
for (const [table, felder] of [['subjects', ['name', 'short']], ['rooms', ['name']], ['teachers', ['name']]]) {
  const werte = b => felder.map(f => String(b?.[f] ?? '').trim().slice(0, 40) || null);
  const lade = id => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

  // Was aus WebUntis kam, bleibt draussen: die Listen sind fuer alle sichtbar, und die Kurse
  // einer Schule verraten, wer was belegt. Fuer den eigenen Plan kommt das ueber /api/timetable.
  app.get(`/api/${table}`, auth, (req, res) =>
    res.json(db.prepare(`SELECT * FROM ${table} WHERE from_untis = 0 ORDER BY name`).all()));

  app.post(`/api/${table}`, auth, admin, (req, res) => {
    const v = werte(req.body);
    if (!v[0]) return res.status(400).json({ error: 'Name nötig' });
    try {
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO ${table}(${felder.join(', ')}) VALUES(${felder.map(() => '?').join(', ')})`).run(...v);
      res.json(lade(Number(lastInsertRowid)));
    } catch { res.status(409).json({ error: `"${v[0]}" gibt es schon` }); }
  });

  app.put(`/api/${table}/:id`, auth, admin, (req, res) => {
    const id = Number(req.params.id);
    const v = werte(req.body);
    if (!v[0]) return res.status(400).json({ error: 'Name nötig' });
    if (lade(id)?.from_untis) return res.status(409).json({ error: 'Kommt aus WebUntis' });
    try {
      const { changes } = db.prepare(
        `UPDATE ${table} SET ${felder.map(f => `${f} = ?`).join(', ')} WHERE id = ?`).run(...v, id);
      if (!changes) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
      res.json(lade(id));
    } catch { res.status(409).json({ error: `"${v[0]}" gibt es schon` }); }
  });

  app.delete(`/api/${table}/:id`, auth, admin, (req, res) => {
    const id = Number(req.params.id);
    if (lade(id)?.from_untis) return res.status(409).json({ error: 'Kommt aus WebUntis' });
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    res.json({ ok: true });
  });
}

// Validierung je Entitaet einmal, damit POST und PUT nicht auseinanderlaufen.
const dayArgs = b => {
  const iso = Number(b?.iso), name = b?.name?.trim();
  return (iso >= 1 && iso <= 7 && name)
    ? { args: [iso, name] }
    : { error: 'Wochentag 1-7 und Name nötig' };
};

app.post('/api/days', auth, admin, (req, res) => {
  const { args, error } = dayArgs(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO days(iso, name) VALUES(?, ?)').run(...args);
    res.json({ id: Number(lastInsertRowid), iso: args[0], name: args[1] });
  } catch { res.status(409).json({ error: 'Diesen Wochentag gibt es schon' }); }
});

app.put('/api/days/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  const { args, error } = dayArgs(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { changes } = db.prepare('UPDATE days SET iso = ?, name = ? WHERE id = ?').run(...args, id);
    if (!changes) return res.status(404).json({ error: 'Tag nicht gefunden' });
    res.json({ id, iso: args[0], name: args[1] });
  } catch { res.status(409).json({ error: 'Diesen Wochentag gibt es schon' }); }
});

app.delete('/api/days/:id', auth, admin, (req, res) => {
  db.prepare('DELETE FROM days WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const periodArgs = b => {
  const nr = Number(b?.nr);
  const { start_time, end_time } = b ?? {};
  // Die 0. Stunde ist an vielen Schulen die Fruehstunde - und kam aus WebUntis auch so herein.
  // Wuerde sie hier durchfallen, waere ausgerechnet diese Zeile die einzige, die sich nicht mehr
  // korrigieren laesst.
  if (!Number.isInteger(nr) || nr < 0 || nr > 20
    || !TIME.test(start_time ?? '') || !TIME.test(end_time ?? ''))
    return { error: 'Nummer (0–20) und Zeiten als HH:MM nötig' };
  if (end_time <= start_time) return { error: 'Ende muss nach dem Beginn liegen' };
  return { args: [nr, start_time, end_time] };
};

app.post('/api/periods', auth, admin, (req, res) => {
  const { args, error } = periodArgs(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO periods(school_id, nr, start_time, end_time) VALUES(?, ?, ?, ?)')
      .run(schuleVon(req.user.id).id, ...args);
    res.json({ id: Number(lastInsertRowid), nr: args[0], start_time: args[1], end_time: args[2] });
  } catch { res.status(409).json({ error: `Stunde ${args[0]} gibt es schon` }); }
});

// Wichtig, weil Loeschen einer Stunde per Cascade die Eintraege aller Nutzer mitnimmt -
// eine falsche Uhrzeit muss korrigierbar sein, ohne den Slot wegzuwerfen.
app.put('/api/periods/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  const { args, error } = periodArgs(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { changes } = db.prepare(
      'UPDATE periods SET nr = ?, start_time = ?, end_time = ? WHERE id = ? AND school_id = ?')
      .run(...args, id, schuleVon(req.user.id).id);
    if (!changes) return res.status(404).json({ error: 'Stunde nicht gefunden' });
    res.json({ id, nr: args[0], start_time: args[1], end_time: args[2] });
  } catch { res.status(409).json({ error: `Stunde ${args[0]} gibt es schon` }); }
});

app.delete('/api/periods/:id', auth, admin, (req, res) => {
  db.prepare('DELETE FROM periods WHERE id = ? AND school_id = ?')
    .run(Number(req.params.id), schuleVon(req.user.id).id);
  res.json({ ok: true });
});

// Kein Raum am Kurs - der haengt am Stundenplan-Eintrag, siehe PUT /api/entry.
const COURSE_COLS = `c.id, c.title, c.subject_id, c.teacher_id,
                     s.name AS subject, s.short AS subject_short, t.name AS teacher`;
const COURSE_JOINS = `LEFT JOIN subjects s ON s.id = c.subject_id
                      LEFT JOIN teachers t ON t.id = c.teacher_id`;
const COURSE_BY_ID = `SELECT ${COURSE_COLS} FROM courses c ${COURSE_JOINS} WHERE c.id = ?`;

// Die selbst gepflegten Kurse - plus die WebUntis-Kurse, die der Anfragende SELBST im Plan hat.
//
// Frueher blieb alles Importierte draussen. Wessen Plan vollstaendig aus WebUntis kommt, bekam
// damit eine Fachauswahl mit genau zwei Eintraegen ("nichts eintragen" und "Frei") und konnte in
// seinem eigenen Plan nichts eintragen und nichts ueberarbeiten.
//
// Die Datenschutzgrenze bleibt, sie liegt nur an der richtigen Stelle: FREMDE Untis-Kurse taucht
// hier weiterhin niemand auf. Eine vollstaendige Kursliste der Schule verriete, wer was belegt.
app.get('/api/courses', auth, (req, res) =>
  res.json(db.prepare(`SELECT ${COURSE_COLS}, c.from_untis FROM courses c ${COURSE_JOINS}
    WHERE c.id <> ? AND (c.school_id IS NULL OR c.school_id = ?)
      AND (c.from_untis = 0 OR c.id IN (${MEINE_KURSE}))
    ORDER BY c.id`).all(WEG, schuleVon(req.user.id).id, req.user.id, req.user.id)));

const courseArgs = b => [String(b?.id ?? '').trim(), b?.title?.trim(),
  Number(b?.subject_id) || null, Number(b?.teacher_id) || null];

app.post('/api/courses', auth, admin, (req, res) => {
  const args = courseArgs(req.body);
  if (!args[0] || !args[1]) return res.status(400).json({ error: 'Kürzel und Titel nötig' });
  try {
    db.prepare('INSERT INTO courses(id, title, subject_id, teacher_id) VALUES(?, ?, ?, ?)').run(...args);
    res.json(db.prepare(COURSE_BY_ID).get(args[0]));
  } catch { res.status(409).json({ error: `Kurs "${args[0]}" gibt es schon` }); }
});

// Die Freistunde gehoert der App, nicht dem Admin - sonst reisst ein Loeschen allen Nutzern ihre
// Freistunden aus dem Plan.
const istFrei = id => String(id ?? '').toLowerCase() === FREI;
// Beide gehoeren der App: anlegen, umbenennen und loeschen sind gesperrt, und in Listen tauchen
// sie nicht auf.
const RESERVIERT = new Set([FREI, WEG]);
const istReserviert = id => RESERVIERT.has(String(id ?? '').toLowerCase());
const schuetzeFrei = (req, res, next) => {
  if (istReserviert(req.params.id))
    return res.status(409).json({ error: 'Dieser Eintrag ist fest eingebaut und lässt sich nicht ändern' });
  // Importierte Kurse gehoeren WebUntis: sie hier zu aendern, wuerde beim naechsten Abgleich
  // ueberschrieben und macht die Kurs-IDs zwischen Nutzern uneinheitlich.
  if (db.prepare('SELECT from_untis FROM courses WHERE id = ?').get(req.params.id)?.from_untis)
    return res.status(409).json({ error: 'Dieser Kurs kommt aus WebUntis' });
  next();
};

// Kürzel umbenennen: entries haengen per ON UPDATE CASCADE dran und ziehen mit.
app.put('/api/courses/:id', auth, admin, schuetzeFrei, (req, res) => {
  const args = courseArgs(req.body);
  if (!args[0] || !args[1]) return res.status(400).json({ error: 'Kürzel und Titel nötig' });
  try {
    const { changes } = db.prepare(
      'UPDATE courses SET id = ?, title = ?, subject_id = ?, teacher_id = ? WHERE id = ?')
      .run(...args, req.params.id);
    if (!changes) return res.status(404).json({ error: 'Kurs nicht gefunden' });
    res.json(db.prepare(COURSE_BY_ID).get(args[0]));
  } catch { res.status(409).json({ error: `Kurs "${args[0]}" gibt es schon` }); }
});

app.delete('/api/courses/:id', auth, admin, schuetzeFrei, (req, res) => {
  db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Eigene Kursnamen und -farben -------------------------------------------
// Rein persoenlich. Freunde sehen im geteilten Plan weiter die Originalnamen - sonst koennte
// einer der ganzen Stufe den Plan verstellen.

// Alle Kurse, die im eigenen Plan vorkommen: selbst eingetragen oder aus WebUntis.
const meineKurse = userId => db.prepare(`
  SELECT ${COURSE_COLS}, p.name AS pref_name, p.color AS pref_color, p.short AS pref_short
  FROM courses c ${COURSE_JOINS}
  LEFT JOIN course_prefs p ON p.course_id = c.id AND p.user_id = ?
  WHERE c.id NOT IN (?, ?) AND c.id IN (${MEINE_KURSE})
  ORDER BY coalesce(s.name, c.title)`).all(userId, FREI, WEG, userId, userId);

app.get('/api/my-courses', auth, (req, res) => res.json(meineKurse(req.user.id)));

app.put('/api/my-courses/:id', auth, (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 40) || null;
  const short = String(req.body?.short ?? '').trim().slice(0, 6) || null;
  const color = String(req.body?.color ?? '').trim() || null;
  if (color && !HEX.test(color)) return res.status(400).json({ error: 'Farbe muss #rrggbb sein' });
  if (!db.prepare('SELECT 1 FROM courses WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Kurs nicht gefunden' });
  db.prepare(`INSERT INTO course_prefs(user_id, course_id, name, short, color) VALUES(?, ?, ?, ?, ?)
              ON CONFLICT(user_id, course_id) DO UPDATE SET
                name = excluded.name, short = excluded.short, color = excluded.color`)
    .run(req.user.id, req.params.id, name, short, color);
  res.json({ ok: true });
});

app.delete('/api/my-courses/:id', auth, (req, res) => {
  db.prepare('DELETE FROM course_prefs WHERE user_id = ? AND course_id = ? COLLATE NOCASE')
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});

// --- Veraltete Kurse ---------------------------------------------------------
// Aendert WebUntis die Kursnummer (die 'lsnumber'), entsteht eine NEUE Kurs-ID - der alte Kurs
// bleibt aber stehen, weil der Abgleich 'untis_lessons' nur im Sync-Fenster loescht. Das Fach steht
// dann doppelt in der Liste, Farbe und Umbenennung haengen an der alten ID und sind weg, und alte
// Hausaufgaben verschwinden aus der Ansicht, weil die alte ID nicht mehr in MEINE_SLOTS steht.

// Kurse, die JETZT noch im Plan stehen. Ein Kurs, den es nur in der Vergangenheit gibt, ist
// veraltet - alles andere waere raten.
const AKTUELLE_KURSE = `
  SELECT course_id FROM entries WHERE user_id = ?
  UNION SELECT course_id FROM untis_lessons
        WHERE user_id = ? AND course_id IS NOT NULL AND date >= date('now')`;

/** Wo liegt welcher Kurs bei diesem Nutzer? Map Kurs-ID -> Menge von "tag|stunde". */
function slotsJeKurs(userId) {
  const map = new Map();
  for (const s of db.prepare(MEINE_SLOTS).all(userId, userId)) {
    if (!map.has(s.course_id)) map.set(s.course_id, new Set());
    map.get(s.course_id).add(`${s.day_id}|${s.period_id}`);
  }
  return map;
}

/**
 * Veraltete Kurse samt moeglicher Nachfolger.
 *
 * Ein Nachfolger muss drei Dinge erfuellen: gleiches Fach, gleicher Lehrer UND mindestens eine
 * gemeinsame Stunde im Wochenraster. Die dritte Bedingung ist die wichtige - erst sie macht das
 * automatische Uebernehmen ungefaehrlich, denn zwei Jahrgaenge beim selben Lehrer im selben Fach
 * sitzen nie in derselben Stunde.
 */
function kursVorschlaege(userId) {
  const kurse = meineKurse(userId);
  if (kurse.length < 2) return [];
  const aktuell = new Set(db.prepare(AKTUELLE_KURSE).all(userId, userId).map(r => r.course_id));
  const slots = slotsJeKurs(userId);
  const zukunft = new Map(db.prepare(`SELECT course_id, count(*) AS n FROM untis_lessons
    WHERE user_id = ? AND course_id IS NOT NULL AND date >= date('now')
    GROUP BY course_id`).all(userId).map(r => [r.course_id, r.n]));

  const gemeinsameStunde = (a, b) => {
    const sa = slots.get(a.id) ?? new Set();
    return [...(slots.get(b.id) ?? [])].some(s => sa.has(s));
  };
  // Bei einem Paar soll nur EINE Seite als Vorschlag erscheinen, sonst steht jedes Duplikat
  // zweimal da. Die staerkere ist die mit mehr Stunden in der Zukunft.
  const staerker = (a, b) => {
    const za = zukunft.get(a.id) ?? 0, zb = zukunft.get(b.id) ?? 0;
    return za !== zb ? za > zb : a.id < b.id;
  };

  const raus = [];
  for (const k of kurse) {
    const veraltet = !aktuell.has(k.id);
    // Fuer die Auswahlliste reicht dasselbe Fach und eine gemeinsame Stunde. Der Lehrer bleibt
    // aussen vor: er ist unzuverlaessig - bei einer Vertretung schreibt der Abgleich den Vertreter
    // an den Kurs, und "KLE" und "Klein" sind fuer die Datenbank zwei verschiedene Lehrer.
    const partner = kurse.filter(x => x.id !== k.id
      && k.subject_id && x.subject_id === k.subject_id && gemeinsameStunde(k, x));
    const staerkere = partner.filter(x => staerker(x, k));
    if (!veraltet && !staerkere.length) continue;

    // Ohne Rueckfrage zusammenfuehren nur, was zweifelsfrei ist: veraltet, und genau ein
    // Nachfolger, bei dem auch der Lehrer stimmt.
    const streng = veraltet ? partner.filter(x => aktuell.has(x.id)
      && k.teacher_id && x.teacher_id === k.teacher_id) : [];

    raus.push({
      ...k,
      grund: veraltet ? 'veraltet' : 'doppelt',
      hausaufgaben: db.prepare('SELECT count(*) AS n FROM homework WHERE user_id = ? AND course_id = ? COLLATE NOCASE')
        .get(userId, k.id).n,
      nachfolger: (veraltet ? partner.filter(x => aktuell.has(x.id)) : staerkere).map(n => n.id),
      eindeutig: streng.length === 1 ? streng[0].id : null,
    });
  }
  return raus;
}

/**
 * Alles, was dieser Nutzer an dem alten Kurs haengen hat, auf den neuen umhaengen.
 *
 * Bewusst pro Nutzer und nicht als globales Umbenennen des Kurses: die Kurszeile teilen sich alle,
 * die den Kurs haben - fuer die anderen darf sich nichts aendern.
 */
function kurseZusammenfuehren(userId, altId, neuId) {
  if (altId === neuId) return { verschoben: 0 };
  const neuerSlot = slotFuerKurs(userId, neuId);

  // node:sqlite kennt kein db.transaction() - hier wie ueberall sonst von Hand geklammert.
  db.exec('BEGIN');
  try {
    // Erst die Einstellungen: der Primaerschluessel (user_id, course_id) kollidiert, wenn fuer
    // beide IDs schon etwas hinterlegt ist - dann gewinnt das Bestehende am neuen Kurs.
    db.prepare(`INSERT INTO course_prefs(user_id, course_id, name, short, color)
                SELECT user_id, ?, name, short, color FROM course_prefs
                WHERE user_id = ? AND course_id = ? COLLATE NOCASE
                ON CONFLICT(user_id, course_id) DO NOTHING`).run(neuId, userId, altId);
    db.prepare('DELETE FROM course_prefs WHERE user_id = ? AND course_id = ? COLLATE NOCASE').run(userId, altId);

    // Die Stunde muss mitwandern, sonst sieht die Hausaufgabe niemand mehr - an ihr haengt die
    // Sichtbarkeit.
    const hw = db.prepare(`UPDATE homework SET course_id = ?, day_id = ?, period_id = ?
                           WHERE user_id = ? AND course_id = ? COLLATE NOCASE`)
      .run(neuId, neuerSlot.day_id ?? null, neuerSlot.period_id ?? null, userId, altId).changes;
    // Ohne OR IGNORE: der Primaerschluessel ist (user_id, day_id, period_id), 'course_id' gehoert
    // nicht dazu - eine Kollision kann es hier gar nicht geben. Schluege es doch einmal fehl, soll
    // die ganze Zusammenfuehrung zurueckrollen statt still eine Zeile am alten Kurs zu lassen.
    db.prepare('UPDATE entries SET course_id = ? WHERE user_id = ? AND course_id = ? COLLATE NOCASE')
      .run(neuId, userId, altId);
    db.prepare('UPDATE untis_lessons SET course_id = ? WHERE user_id = ? AND course_id = ? COLLATE NOCASE')
      .run(neuId, userId, altId);
    db.prepare('UPDATE untis_homework SET course_id = ? WHERE user_id = ? AND course_id = ? COLLATE NOCASE')
      .run(neuId, userId, altId);
    db.exec('COMMIT');
    return { verschoben: hw };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

app.get('/api/my-courses/aufraeumen', auth, (req, res) => res.json(kursVorschlaege(req.user.id)));

app.post('/api/my-courses/:id/zusammenfuehren', auth, (req, res) => {
  const alt = req.params.id, neu = String(req.body?.ziel ?? '').trim();
  if (!neu || alt === neu) return res.status(400).json({ error: 'Zielkurs nötig' });
  if (!hatKurs(req.user.id, alt) || !hatKurs(req.user.id, neu))
    return res.status(403).json({ error: 'Einer der beiden Kurse gehört nicht zu deinem Plan' });
  res.json(kurseZusammenfuehren(req.user.id, alt, neu));
});

// Nur die eigenen Reste - die Kurszeile selbst bleibt stehen, sie kann anderen noch gehoeren.
app.delete('/api/my-courses/:id/reste', auth, (req, res) => {
  const id = req.params.id;
  if (!hatKurs(req.user.id, id))
    return res.status(403).json({ error: 'Der Kurs gehört nicht zu deinem Plan' });
  db.exec('BEGIN');
  try {
    const n = db.prepare('DELETE FROM homework WHERE user_id = ? AND course_id = ? COLLATE NOCASE')
      .run(req.user.id, id).changes;
    for (const t of ['course_prefs', 'entries', 'untis_lessons', 'untis_homework'])
      db.prepare(`DELETE FROM ${t} WHERE user_id = ? AND course_id = ? COLLATE NOCASE`).run(req.user.id, id);
    db.exec('COMMIT');
    res.json({ hausaufgaben: n });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// --- Hausaufgaben -----------------------------------------------------------
// Anders als der Stundenplan haengen sie nicht an der Freundschaft: Hausaufgaben sind Kursinhalt,
// also sieht sie jeder, der den Kurs im Plan hat. Mit Freundschaftspflicht saehe jemand ohne
// Freunde nie eine Hausaufgabe.

// "Meine Kurse" heisst: selbst eingetragen ODER aus dem eigenen WebUntis-Abgleich. Beides zaehlt,
// sonst haette wer seinen Plan aus WebUntis bezieht ueberhaupt keine Hausaufgaben - weder eintragen
// noch sehen. Eine Stelle dafuer, damit die drei Verwendungen nicht auseinanderlaufen.
const MEINE_KURSE = `SELECT course_id FROM entries WHERE user_id = ?
                     UNION SELECT course_id FROM untis_lessons WHERE user_id = ? AND course_id IS NOT NULL`;

// Dasselbe mit Slot: welcher Kurs liegt bei mir an welchem Wochentag in welcher Stunde. Fuer
// WebUntis wird das Datum ueber days.iso auf den Wochentag zurueckgerechnet - dort haengen die
// Stunden am Datum, unsere eigenen am Wochentag.
const MEINE_SLOTS = `
  SELECT course_id, day_id, period_id FROM entries WHERE user_id = ?
  UNION
  SELECT u.course_id, d.id AS day_id, u.period_id
  FROM untis_lessons u
  JOIN days d ON d.iso = CAST(strftime('%u', u.date) AS INTEGER)
  WHERE u.user_id = ? AND u.course_id IS NOT NULL`;

// Ueber `courses` gefuehrt, damit die kanonische Schreibweise herauskommt: MEINE_KURSE liest die
// Kindspalten, und deren Wert kann davon abweichen. Wer die Rohwerte weitergibt, vergleicht sie
// spaeter BINARY gegen `homework.course_id` - und findet nichts.
const meineKursIds = userId => db.prepare(
  `SELECT DISTINCT c.id FROM courses c WHERE c.id IN (${MEINE_KURSE})`).all(userId, userId)
  .map(r => r.id);

/**
 * Die eine gueltige Schreibweise einer Kurs-ID - oder null, wenn es den Kurs nicht gibt.
 *
 * `courses.id` ist COLLATE NOCASE (db.js), die Kindspalten `entries.course_id` und
 * `untis_lessons.course_id` sind BINARY. Dadurch konnte ein Kurs in der Auswahlliste stehen (die
 * vergleicht ueber `c.id`, also NOCASE) und trotzdem von `hatKurs` abgelehnt werden (das vergleicht
 * ueber die Kindspalte, also BINARY): "Du hast diesen Kurs nicht im Stundenplan", obwohl er im Plan
 * steht. Der Fremdschluessel merkt davon nichts, weil er mit der Collation des Elterns prueft.
 *
 * Deshalb wird jede von aussen kommende oder zu speichernde Kurs-ID hier hindurchgeschickt.
 */
const kanonischerKurs = id =>
  sql('SELECT id FROM courses WHERE id = ?').get(String(id ?? ''))?.id ?? null;

// Die Vergleiche selbst laufen zusaetzlich NOCASE - so sind auch Zeilen harmlos, die vor der
// Kanonisierung entstanden sind.
const hatKurs = (userId, courseId) =>
  !!db.prepare(`SELECT 1 FROM (${MEINE_KURSE}) WHERE course_id = ? COLLATE NOCASE LIMIT 1`)
    .get(userId, userId, courseId);

/**
 * Haben zwei Menschen diesen Kurs in derselben Stunde? Das heisst: wirklich derselbe Kurs. Die
 * Kurs-ID allein reicht nicht - zwei Jahrgaenge teilen sich manchmal eine, und einen Kurs kann sich
 * jeder selbst in den Plan legen.
 */
const kursGemeinsam = (a, b, courseId) => !!db.prepare(`
  SELECT 1 FROM (${MEINE_SLOTS}) x JOIN (${MEINE_SLOTS}) y
    ON y.day_id = x.day_id AND y.period_id = x.period_id AND y.course_id = x.course_id COLLATE NOCASE
  WHERE x.course_id = ? COLLATE NOCASE LIMIT 1`).get(a, a, b, b, courseId);

/** Liegt dieser Kurs bei mir genau an diesem Wochentag in dieser Stunde? */
const hatKursImSlot = (userId, courseId, dayId, periodId) =>
  !!db.prepare(`SELECT 1 FROM (${MEINE_SLOTS})
                WHERE course_id = ? COLLATE NOCASE AND day_id = ? AND period_id = ? LIMIT 1`)
    .get(userId, userId, courseId, dayId, periodId);

/**
 * Wo liegt dieser Kurs bei mir? Frueheste Stelle der Woche. Wird gebraucht, wenn jemand eine
 * Hausaufgabe ueber das Menue eintraegt - dann steht nur der Kurs fest, nicht die Stunde, und der
 * Server soll den Slot selbst finden statt zurueckzufragen.
 */
const slotFuerKurs = (userId, courseId) => db.prepare(`
  SELECT s.day_id, s.period_id FROM (${MEINE_SLOTS}) s
  JOIN days d ON d.id = s.day_id
  JOIN periods p ON p.id = s.period_id
  WHERE s.course_id = ? COLLATE NOCASE
  ORDER BY d.iso, p.nr LIMIT 1`).get(userId, userId, courseId) ?? {};

// h.id heisst bewusst hw_id: USER_COLS bringt ein u.id mit, und bei gleichnamigen Spalten
// gewinnt in SQLite die letzte - die Hausaufgaben-ID waere sonst still die des Verfassers.
const shapeHomework = r => ({
  id: r.hw_id,
  // Ohne Stunde sieht sie nur der Verfasser - das gehoert in die Zeile, sonst wundert er sich,
  // warum sein Kurs nichts davon mitbekommt.
  ohne_slot: !r.day_id || !r.period_id,
  // Der Slot gehoert mit hinaus: an ihm haengt, wer die Aufgabe sieht, und der Bearbeiten-Dialog
  // soll zeigen koennen, wo sie gelandet ist.
  day_id: r.day_id ?? null, period_id: r.period_id ?? null,
  course_id: r.course_id, due_date: r.due_date, text: r.text,
  course_title: r.course_title, subject: r.subject, subject_short: r.subject_short,
  by: r.id === null ? null : person(r),
  done: !!r.done,
});

/**
 * Was der Lehrer selbst in WebUntis eingetragen hat - in derselben Form wie die eigenen Aufgaben,
 * damit beide durch dieselbe Anzeige laufen. Sie gehoeren der Schule: abhaken ja, aendern nein.
 *
 * Sie haben keinen eigenen Slot; die Zuordnung zur Stunde passiert im Plan ueber Kurs und Datum,
 * genau wie bei den eigenen. Ohne aufloesbaren Kurs (WebUntis liefert nicht zu jeder Stunde eine
 * Kursnummer) bleiben sie in der Liste, ohne Fach.
 */
function untisHausaufgaben(userId, from, to) {
  return db.prepare(`
    SELECT u.untis_id, u.course_id, u.due_date, u.text, u.remark,
           c.title AS course_title, s.name AS subject, s.short AS subject_short,
           EXISTS(SELECT 1 FROM untis_homework_done d
                  WHERE d.untis_id = u.untis_id AND d.user_id = u.user_id) AS done
    FROM untis_homework u
    LEFT JOIN courses c ON c.id = u.course_id
    LEFT JOIN subjects s ON s.id = c.subject_id
    WHERE u.user_id = ? AND u.due_date BETWEEN ? AND ?`).all(userId, from, to)
    .map(r => ({
      // Negative IDs, damit sich eigene und importierte Aufgaben in der Oberflaeche nicht in die
      // Quere kommen - abgehakt wird in einer eigenen Tabelle.
      id: -r.untis_id,
      course_id: r.course_id, due_date: r.due_date, ohne_slot: false,
      text: [r.text, r.remark].filter(Boolean).join(' — '),
      course_title: r.course_title, subject: r.subject, subject_short: r.subject_short,
      by: null, done: !!r.done, von_untis: true,
    }));
}

/**
 * Das aelteste Faelligkeitsdatum, das jemand noch sehen will - oder null, wenn nichts weg soll.
 * Ueberfaelliges ist nach ein paar Tagen nur noch Ballast; die Frist stellt jeder selbst ein.
 */
function hwGrenze(u) {
  const tage = Number(u?.hw_loeschen_tage);
  return tage > 0 ? addDays(new Date().toISOString().slice(0, 10), -tage) : null;
}
const hwVon = (u, from) => { const g = hwGrenze(u); return g && g > from ? g : from; };

/**
 * Was laenger als die eigene Frist ueberfaellig ist, fliegt raus - je Nutzer nur das Eigene.
 *
 * Eine geteilte Aufgabe loescht nur, wer sie eingetragen hat; wer sie mitliest, blendet sie ueber
 * hwVon() aus. Sonst entschiede die kuerzeste Frist im Kurs fuer alle. Laeuft im Zehn-Minuten-
 * Takt und nach jedem WebUntis-Import, weil der die alten Aufgaben sonst wieder mitbraechte.
 */
export function hausaufgabenAufraeumen(nurUser = null) {
  const nutzer = db.prepare(`SELECT id, hw_loeschen_tage FROM users
    WHERE hw_loeschen_tage > 0 AND (? IS NULL OR id = ?)`).all(nurUser, nurUser);
  const hw = db.prepare('DELETE FROM homework WHERE user_id = ? AND due_date < ?');
  const untis = db.prepare('DELETE FROM untis_homework WHERE user_id = ? AND due_date < ?');
  transaktion(() => {
    for (const u of nutzer) {
      const grenze = hwGrenze(u);
      hw.run(u.id, grenze);
      untis.run(u.id, grenze);
    }
  });
}

/**
 * Erledigte ToDos nach der eigenen Frist wegwerfen - nur die eigenen losen und die in eigenen
 * Projekten. In einem fremden Board raeumt dessen Besitzer auf, nicht die kuerzeste Frist im Team.
 * Vor dieser Fassung abgehakte ToDos haben kein done_at; dann zaehlt das Anlegedatum.
 */
export function todosAufraeumen(nurUser = null) {
  const nutzer = db.prepare(`SELECT id, todo_loeschen_tage FROM users
    WHERE todo_loeschen_tage > 0 AND (? IS NULL OR id = ?)`).all(nurUser, nurUser);
  for (const u of nutzer) {
    db.prepare(`DELETE FROM todos WHERE done = 1
      AND COALESCE(done_at, created_at) < datetime('now', ?)
      AND ((user_id = ? AND ordner_id IS NULL) OR ordner_id IN (SELECT id FROM todo_ordner WHERE user_id = ?))`)
      .run(`-${u.todo_loeschen_tage} days`, u.id, u.id);
  }
}

function homeworkFuer(viewerId, courseIds, from, to) {
  // Kanonisch vergleichen: `homework.course_id` ist BINARY, ein roher Kindwert faende nichts.
  courseIds = [...new Set(courseIds.map(id => kanonischerKurs(id) ?? id))];
  if (!courseIds.length) return [];
  return db.prepare(`
    SELECT h.id AS hw_id, h.course_id, h.due_date, h.text, h.created_at, h.day_id, h.period_id,
           c.title AS course_title, s.name AS subject, s.short AS subject_short, ${USER_COLS},
           EXISTS(SELECT 1 FROM homework_done d WHERE d.homework_id = h.id AND d.user_id = ?) AS done
    FROM homework h
    JOIN courses c ON c.id = h.course_id
    LEFT JOIN subjects s ON s.id = c.subject_id
    LEFT JOIN users u ON u.id = h.user_id
    WHERE h.course_id IN (${courseIds.map(() => '?').join(',')}) AND h.due_date BETWEEN ? AND ?
      -- Der Slot muss passen. Zwei Jahrgaenge koennen sich eine Kurs-ID teilen; ohne diese
      -- Bedingung sah der 13er mit "G4" in der 8. die Hausaufgaben des 12ers mit "G4" in der 4.
      --
      -- Ohne Slot (Altbestand, dem die Migration keine Stunde zuordnen konnte) sieht sie nur der
      -- Verfasser - lieber eine alte Aufgabe zu wenig zeigen als sie dem falschen Jahrgang.
      AND (EXISTS(
            SELECT 1 FROM (${MEINE_SLOTS}) s
            WHERE s.course_id = h.course_id COLLATE NOCASE
              AND s.day_id = h.day_id AND s.period_id = h.period_id)
        OR ((h.day_id IS NULL OR h.period_id IS NULL) AND h.user_id = ?))
    ORDER BY h.due_date, h.id`)
    .all(viewerId, ...courseIds, from, to, viewerId, viewerId, viewerId)
    .map(shapeHomework);
}

app.get('/api/homework', auth, (req, res) => {
  const heute = new Date().toISOString().slice(0, 10);
  // Auch rueckwaerts schauen: Ueberfaelliges ist genau das, was man sehen will. Wer aus dem Plan
  // heraus eintraegt, trifft ohnehin oft einen Tag, der schon vorbei ist.
  const from = hwVon(req.user,
    ISO_DATE.test(req.query.from ?? '') ? req.query.from : addDays(heute, -30));
  const to = ISO_DATE.test(req.query.to ?? '') ? req.query.to : addDays(heute, 28);
  // Eigene und die der Schule zusammen - die aus WebUntis sind gekennzeichnet und nicht
  // aenderbar, damit klar ist, wer sie eingetragen hat.
  const eigene = homeworkFuer(req.user.id, meineKursIds(req.user.id), from, to);
  res.json([...eigene, ...untisHausaufgaben(req.user.id, from, to)]
    .sort((a, b) => a.due_date.localeCompare(b.due_date)));
});

function hwEingabe(b) {
  // Kanonisch speichern, damit Aufgabe und Stunde nicht in verschiedenen Schreibweisen liegen.
  const roh = String(b?.course_id ?? '').trim();
  const course_id = kanonischerKurs(roh) ?? roh;
  const due_date = String(b?.due_date ?? '');
  const text = String(b?.text ?? '').trim();
  if (!ISO_DATE.test(due_date)) return { error: 'Fälligkeitsdatum als JJJJ-MM-TT nötig' };
  if (!text) return { error: 'Text nötig' };
  if (text.length > 500) return { error: 'Text ist zu lang (max. 500 Zeichen)' };
  return { data: { course_id, due_date, text } };
}

/**
 * Kurs pruefen und die Stunde bestimmen - fuer Anlegen und Aendern dieselbe Stelle, damit beide
 * nicht auseinanderlaufen. Gibt entweder `{ status, error }` oder `{ slot }` zurueck.
 *
 * Aus dem Plan heraus kommt der angeklickte Slot mit; ueber das Menue steht nur der Kurs fest,
 * dann sucht der Server die Stelle selbst. So kann man eine Mathe-Hausaufgabe auch an einem Tag
 * eintragen, an dem man gar kein Mathe hat.
 */
function hwSlot(userId, courseId, body) {
  if (istReserviert(courseId))
    return { status: 400, error: 'Dafür gibt es keine Hausaufgaben' };
  if (!db.prepare('SELECT 1 FROM courses WHERE id = ?').get(courseId))
    return { status: 404, error: 'Kurs nicht gefunden' };
  if (!hatKurs(userId, courseId))
    return { status: 403, error: 'Du hast diesen Kurs nicht im Stundenplan' };

  const tag = Number(body?.day_id), stunde = Number(body?.period_id);
  // Ohne mitgeschickten Slot sucht der Server selbst - das ist der Weg ueber das Menue.
  if (!tag || !stunde) return { slot: slotFuerKurs(userId, courseId) };

  // Mit Slot heisst: aus dem Plan heraus, die Stunde steht fest. Passt sie nicht zum eigenen Plan,
  // kam der Klick aus dem Plan eines Freundes. Frueher wurde die Aufgabe dann still auf die
  // frueheste eigene Stelle geschoben - und tauchte danach dort, wo man geklickt hatte, gar nicht
  // auf. Es sah aus, als sei nichts passiert, obwohl ein Eintrag entstanden war.
  if (!hatKursImSlot(userId, courseId, tag, stunde))
    return { status: 400, error: 'Diese Stunde hast du so nicht im Stundenplan' };
  return { slot: { day_id: tag, period_id: stunde } };
}

app.post('/api/homework', auth, bremse('hw', 30), (req, res) => {
  const { data, error } = hwEingabe(req.body);
  if (error) return res.status(400).json({ error });

  const { slot: gewaehlt, status, error: fehler } = hwSlot(req.user.id, data.course_id, req.body);
  if (fehler) return res.status(status).json({ error: fehler });

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO homework(course_id, due_date, text, user_id, day_id, period_id, created_at)
    VALUES(?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(data.course_id, data.due_date, data.text, req.user.id,
      gewaehlt.day_id ?? null, gewaehlt.period_id ?? null);
  const hwId = Number(lastInsertRowid);

  // Wer denselben Kurs hat, erfaehrt davon - bisher musste man selbst nachsehen. Der Verfasser
  // nicht: er weiss es. `leise` ist das Rueckgaengig nach dem Loeschen: dieselbe Hausaufgabe ein
  // zweites Mal anzukuendigen waere nur Laerm.
  // Gemeldet wird nur, wer die Aufgabe auch SIEHT: derselbe Kurs in derselben Stunde (wie in
  // homeworkFuer). Nur die Kurs-ID schickte den Push auch an den anderen Jahrgang mit derselben ID.
  const imKurs = db.prepare(`SELECT DISTINCT u.id, u.hw_erinnerung_min
      FROM users u WHERE ? COLLATE NOCASE IN (
        SELECT course_id FROM entries WHERE user_id = u.id
        UNION SELECT course_id FROM untis_lessons WHERE user_id = u.id AND course_id IS NOT NULL)`)
    .all(data.course_id)
    .filter(u => u.id === req.user.id || (gewaehlt.day_id != null && gewaehlt.period_id != null
      && hatKursImSlot(u.id, data.course_id, gewaehlt.day_id, gewaehlt.period_id)));
  for (const { id } of req.body?.leise ? [] : imKurs.filter(u => u.id !== req.user.id)) {
    benachrichtige(id, 'hausaufgaben', `Neue Hausaufgabe: ${data.course_id}`,
      data.text.slice(0, 120), '/', { datum: data.due_date, zeit: schulbeginn(schuleVon(id).id) });
  }

  // Und jeder im Kurs bekommt seine EIGENE Erinnerung vorher - nach seiner Voreinstellung, die
  // er fuer diese eine Hausaufgabe gleich hier oder spaeter ueber die Glocke aendern kann.
  for (const { id, hw_erinnerung_min } of imKurs) {
    const eigene = id === req.user.id && 'erinnerung_min' in (req.body ?? {})
      ? Number(req.body.erinnerung_min) || 0
      : Number(hw_erinnerung_min) || 0;
    hwErinnerung(id, hwId, data, eigene);
  }

  res.json(homeworkFuer(req.user.id, [data.course_id], data.due_date, data.due_date)
    .find(h => h.id === Number(lastInsertRowid)));
});

// Aendern und Loeschen bleiben beim Verfasser (und bei Admins) - sonst raeumt einer dem ganzen
// Kurs die Eintraege weg.
const meineHausaufgabe = (req, res, next) => {
  const row = db.prepare('SELECT * FROM homework WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Hausaufgabe nicht gefunden' });
  if (row.user_id !== req.user.id && !req.user.is_admin)
    return res.status(403).json({ error: 'Das ist nicht deine Hausaufgabe' });
  req.hw = row;
  next();
};

// Das Fach laesst sich mitaendern. Frueher wurde `course_id` hier stur ueberschrieben: wer eine
// Hausaufgabe beim falschen Kurs angelegt hatte - oder bei einem ohne Stunde, den dann niemand
// sah - konnte sie nur loeschen und neu eintragen. Die Stunde wird dabei neu bestimmt, denn an
// ihr haengt, wer die Aufgabe ueberhaupt zu sehen bekommt.
/**
 * Die persoenliche Erinnerung an eine Hausaufgabe setzen (oder abschalten).
 *
 * Sie ist eine wartende Meldung in derselben Warteschlange, die auch Vorlauf und Sammlung
 * benutzt - dafuer braucht es keine eigene Tabelle, nur einen Zeitpunkt und eine Referenz.
 * Und sie gilt NUR fuer den Einzelnen: eine Hausaufgabe ist kursweit, eine Erinnerung nicht.
 */
function hwErinnerung(userId, hwId, data, minVorher) {
  const ref = 'hw:' + hwId;
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND ref = ? AND delivered_at IS NULL')
    .run(userId, ref);
  const min = Math.min(Math.max(Number(minVorher) || 0, 0), 7 * 24 * 60);
  if (!min) return null;

  const d = new Date(`${data.due_date}T${schulbeginn(schuleVon(userId).id)}:00`);
  d.setMinutes(d.getMinutes() - min);
  // Eine Erinnerung an einen Zeitpunkt, der schon vorbei ist, waere keine.
  if (d <= new Date()) return null;

  const z = n => String(n).padStart(2, '0');
  const faellig = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} `
    + `${z(d.getHours())}:${z(d.getMinutes())}`;
  db.prepare(`INSERT INTO notifications(user_id, kind, title, body, url, created_at, faellig_at, ref)
              VALUES(?, 'hausaufgaben', ?, ?, '/', datetime('now'), ?, ?)`)
    .run(userId, `Denk dran: ${data.course_id}`,
      `${data.text.slice(0, 120)} · fällig ${tagKurz(data.due_date)}`, faellig, ref);
  return faellig;
}

/** Die eigene Erinnerung zu einer Hausaufgabe - jeder fuer sich, je Hausaufgabe. */
app.put('/api/homework/:id/erinnerung', auth, (req, res) => {
  const hw = db.prepare('SELECT * FROM homework WHERE id = ?').get(Number(req.params.id) || 0);
  // Erinnern lassen darf sich, wer die Hausaufgabe ueberhaupt sieht.
  if (!hw || !hatKurs(req.user.id, hw.course_id))
    return res.status(404).json({ error: 'Hausaufgabe nicht gefunden' });

  const faellig = hwErinnerung(req.user.id, hw.id, hw, req.body?.min);
  res.json({ min: Math.min(Math.max(Number(req.body?.min) || 0, 0), 7 * 24 * 60), faellig });
});

/** Wann werde ich an diese Hausaufgabe erinnert? (leer = gar nicht) */
app.get('/api/homework/:id/erinnerung', auth, (req, res) => {
  const zeile = db.prepare(`SELECT faellig_at FROM notifications
    WHERE user_id = ? AND ref = ? AND delivered_at IS NULL`)
    .get(req.user.id, 'hw:' + (Number(req.params.id) || 0));
  res.json({ faellig: zeile?.faellig_at ?? null });
});

app.put('/api/homework/:id', auth, meineHausaufgabe, (req, res) => {
  const gewuenscht = String(req.body?.course_id ?? '').trim() || req.hw.course_id;
  const { data, error } = hwEingabe({ ...req.body, course_id: gewuenscht });
  if (error) return res.status(400).json({ error });

  // Bleibt der Kurs derselbe, wird er NICHT geprueft. Sonst liesse sich eine Aufgabe, deren Kurs
  // inzwischen aus dem Plan gefallen ist (WebUntis hat die Kursnummer gewechselt), nicht einmal
  // mehr im Text korrigieren - nur noch loeschen. Slot und Kurs bleiben dann, wie sie sind.
  const wechsel = data.course_id.toLowerCase() !== String(req.hw.course_id).toLowerCase();
  let slot = { day_id: req.hw.day_id, period_id: req.hw.period_id };

  if (wechsel) {
    // Geprueft wird gegen den Plan des VERFASSERS, nicht des Bearbeiters: sonst verschoebe ein
    // Admin die Aufgabe in eine Stunde, die es beim Verfasser gar nicht gibt.
    const wessen = req.hw.user_id ?? req.user.id;
    const r = hwSlot(wessen, data.course_id, req.body);
    if (r.error) return res.status(r.status).json({
      error: r.status === 403 && wessen !== req.user.id
        ? 'Der Verfasser hat diesen Kurs nicht im Stundenplan' : r.error,
    });
    slot = r.slot;
  }

  db.prepare('UPDATE homework SET course_id = ?, due_date = ?, text = ?, day_id = ?, period_id = ? WHERE id = ?')
    .run(data.course_id, data.due_date, data.text, slot.day_id ?? null, slot.period_id ?? null, req.hw.id);
  res.json(homeworkFuer(req.user.id, [data.course_id], data.due_date, data.due_date)
    .find(h => h.id === req.hw.id));
});

app.delete('/api/homework/:id', auth, meineHausaufgabe, (req, res) => {
  db.prepare('DELETE FROM homework WHERE id = ?').run(req.hw.id);
  res.json({ ok: true });
});

// Abhaken ist rein persoenlich - jeder nur fuer sich.
app.post('/api/homework/:id/done', auth, (req, res) => {
  const id = Number(req.params.id);
  // Negative IDs sind Hausaufgaben aus WebUntis (siehe /api/homework). Abhaken bleibt auch dort
  // persoenlich - nur aendern und loeschen geht nicht, die gehoeren der Schule.
  if (id < 0) {
    if (!db.prepare('SELECT 1 FROM untis_homework WHERE user_id = ? AND untis_id = ?')
      .get(req.user.id, -id)) return res.status(404).json({ error: 'Hausaufgabe nicht gefunden' });
    db.prepare('INSERT OR IGNORE INTO untis_homework_done(user_id, untis_id) VALUES(?, ?)')
      .run(req.user.id, -id);
    return res.json({ done: true });
  }
  if (!db.prepare('SELECT 1 FROM homework WHERE id = ?').get(id))
    return res.status(404).json({ error: 'Hausaufgabe nicht gefunden' });
  db.prepare('INSERT OR IGNORE INTO homework_done(homework_id, user_id) VALUES(?, ?)')
    .run(id, req.user.id);
  res.json({ done: true });
});

app.delete('/api/homework/:id/done', auth, (req, res) => {
  const id = Number(req.params.id);
  if (id < 0) db.prepare('DELETE FROM untis_homework_done WHERE untis_id = ? AND user_id = ?')
    .run(-id, req.user.id);
  else db.prepare('DELETE FROM homework_done WHERE homework_id = ? AND user_id = ?')
    .run(id, req.user.id);
  res.json({ done: false });
});

// --- ToDos -------------------------------------------------------------------
// Rein persoenlich: jede Abfrage haengt an req.user.id, es gibt keinen Weg an fremde ToDos.
// Anders als Hausaufgaben haengen sie an keinem Kurs - deshalb auch keine Slot-Pruefung.

const VORLAUF = [0, 60, 480, 1440];   // zur Faelligkeit, 1 h, 8 h, 1 Tag
const FAELLIG = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const EINHEITEN = ['tag', 'woche', 'monat'];

function todoEingabe(b) {
  const text = String(b?.text ?? '').trim();
  const due_at = String(b?.due_at ?? '').replace('T', ' ').slice(0, 16);
  const remind_min = Number(b?.remind_min ?? 0);
  if (!text) return { error: 'Text nötig' };
  if (text.length > 300) return { error: 'Text ist zu lang (max. 300 Zeichen)' };
  // Eine Aufgabe im Board hat oft keine Frist - "irgendwann, aber nicht vergessen". Steht eine da,
  // muss sie stimmen.
  if (due_at && !FAELLIG.test(due_at)) return { error: 'Fälligkeit als JJJJ-MM-TT HH:MM nötig' };
  // Feste Liste statt beliebiger Zahl: die Oberflaeche bietet vier Werte an, und ein Vorlauf von
  // einer Million Minuten waere nur eine Einladung, die Warteschlange vollzuschreiben.
  if (!VORLAUF.includes(remind_min)) return { error: 'Unbekannter Vorlauf' };

  const wdh = Math.min(Math.max(Number(b?.wiederholung) || 0, 0), 365);
  const einheit = EINHEITEN.includes(b?.wiederholung_einheit) ? b.wiederholung_einheit : 'woche';
  // Wiederholen ohne Frist: der Rhythmus zaehlt ab heute, 08:00 Uhr - "alle Woche" heisst dann
  // naechste Woche um acht, und danach wie jede wiederkehrende Aufgabe. Frueher wurde das
  // abgelehnt, dabei ist "erinnere mich woechentlich" genau der Alltagsfall.
  const faellig = wdh && !due_at ? naechsteFaelligkeit(`${heuteLokal()} 08:00`, wdh, einheit) : due_at;
  const sichtbar = String(b?.sichtbar_ab ?? '').replace('T', ' ').slice(0, 16);
  if (sichtbar && !FAELLIG.test(sichtbar)) return { error: 'Sichtbar ab als JJJJ-MM-TT HH:MM nötig' };

  return { data: { text, due_at: faellig || null, remind_min,
    wiederholung: wdh, wiederholung_einheit: wdh ? einheit : null,
    sichtbar_ab: sichtbar || null,
    prioritaet: Math.min(Math.max(Number(b?.prioritaet) || 0, 0), 2) } };
}

/**
 * Der naechste Termin einer wiederkehrenden Aufgabe - gerechnet vom ALTEN, nicht von heute.
 *
 * Sonst wandert der Rhythmus: wer die Muellabfuhr am Mittwoch drei Tage zu spaet abhakt, haette
 * sie kuenftig samstags. Die Schleife holt nach langer Abwesenheit gleich den naechsten
 * zukuenftigen Termin, statt einundzwanzig Einzelschritte zu machen.
 */
/** Heute in Ortszeit als JJJJ-MM-TT - die ToDo-Fristen rechnen lokal, nicht in UTC. */
function heuteLokal() {
  const d = new Date(), z = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function naechsteFaelligkeit(due, n, einheit) {
  const [tag, zeit = '00:00'] = String(due).split(' ');
  let d = new Date(`${tag}T${zeit}:00`);
  const jetzt = new Date();
  for (let i = 0; i < 400; i++) {
    if (einheit === 'tag') d.setDate(d.getDate() + n);
    else if (einheit === 'monat') {
      // Monatsende ehrlich: der 31.01. wird zum 28.02., nicht zum 03.03.
      const tagImMonat = Number(tag.slice(8, 10));
      const ziel = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
      const letzter = new Date(ziel.getFullYear(), ziel.getMonth() + 1, 0).getDate();
      ziel.setDate(Math.min(tagImMonat, letzter));
      d = ziel;
    } else d.setDate(d.getDate() + 7 * n);
    if (d > jetzt) break;
  }
  const z = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** Die Zustaendigen vieler Aufgaben in EINER Abfrage, nach Aufgabe gruppiert: {id} oder {name}. */
function zustaendigeVon(ids) {
  const nach = new Map();
  if (!ids.length) return nach;
  for (const z of db.prepare(`SELECT todo_id, user_id, name FROM todo_zustaendige
      WHERE todo_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids)) {
    if (!nach.has(z.todo_id)) nach.set(z.todo_id, []);
    nach.get(z.todo_id).push(z.user_id ? { id: z.user_id } : { name: z.name });
  }
  return nach;
}

const todoZeile = (r, zust = zustaendigeVon([r.id]).get(r.id) ?? []) => ({
  id: r.id, text: r.text, due_at: r.due_at, remind_min: r.remind_min,
  done: !!r.done, erinnert: !!r.notified_at,
  ordner_id: r.ordner_id ?? null, spalte_id: r.spalte_id ?? null,
  // Mehrere, Mitglieder und freie Namen. zustaendig_id bleibt fuer alte Clients: das erste Konto.
  zustaendige: zust,
  zustaendig_id: zust.find(z => z.id)?.id ?? null,
  wiederholung: r.wiederholung ?? 0, wiederholung_einheit: r.wiederholung_einheit ?? null,
  sichtbar_ab: r.sichtbar_ab ?? null, prioritaet: r.prioritaet ?? 0, sort: r.sort ?? 0,
  // Geparkt: es gibt sie, sie ist nur noch nicht dran.
  geparkt: !!(r.sichtbar_ab && r.sichtbar_ab > alsLokal(new Date())),
});

// --- ToDo-Ordner ---
// Geteilt heisst gemeinsam: wer den Ordner hat, sieht und aendert die ToDos darin, und das
// Abhaken gilt fuer alle. Bei Hausaufgaben ist es umgekehrt (dort hakt jeder fuer sich ab) - eine
// Hausaufgabe macht jeder selbst, eine gemeinsame Liste nicht.

/** Ordner, die mir gehoeren oder direkt mit mir geteilt sind. */
const MEINE_ORDNER = `SELECT id FROM todo_ordner WHERE user_id = ?
                      UNION SELECT ordner_id FROM todo_ordner_geteilt WHERE user_id = ?`;

/**
 * Welche Projekte jemand sehen darf - samt geerbter Freigaben.
 *
 * Die Vererbung wird bei JEDEM Lesen gerechnet, nicht beim Teilen kopiert: ein Unterprojekt, das
 * spaeter entsteht, ist damit automatisch mitgeteilt. Eine direkte Freigabe schlaegt die geerbte -
 * so laesst sich einem Unterprojekt gezielt mehr oder weniger geben.
 *
 * ponytail: liest alle Projektzeilen ein und rechnet in JS. Bei einer Schule sind das ein paar
 * Dutzend; wenn es je Tausende werden, gehoert hier eine rekursive Abfrage hin.
 */
function meineOrdner(userId) {
  const alle = db.prepare('SELECT id, user_id, parent_id FROM todo_ordner').all();
  const nach = new Map(alle.map(o => [o.id, o]));
  const direkt = new Map(db.prepare(
    'SELECT ordner_id, darf_aendern, rekursiv FROM todo_ordner_geteilt WHERE user_id = ?')
    .all(userId).map(r => [r.ordner_id, r]));

  const raus = new Map();
  for (const o of alle) {
    if (o.user_id === userId) { raus.set(o.id, { darf_aendern: 1, meiner: 1 }); continue; }
    const d = direkt.get(o.id);
    if (d) { raus.set(o.id, { darf_aendern: d.darf_aendern, meiner: 0 }); continue; }
    let p = o.parent_id ? nach.get(o.parent_id) : null;
    for (let tiefe = 0; p && tiefe < 20; tiefe++) {
      const g = direkt.get(p.id);
      if (g?.rekursiv) { raus.set(o.id, { darf_aendern: g.darf_aendern, meiner: 0 }); break; }
      p = p.parent_id ? nach.get(p.parent_id) : null;
    }
  }
  return raus;
}

const darfOrdner = (userId, ordnerId, aendern = false) => {
  const e = meineOrdner(userId).get(Number(ordnerId) || 0);
  return !!e && (!aendern || !!e.darf_aendern);
};

const ordnerZeile = (r, userId, zugriff = null) => ({
  id: r.id, name: r.name, meiner: r.user_id === userId,
  parent_id: r.parent_id ?? null, ist_ordner: !!r.ist_ordner,
  fertig_regel: r.fertig_regel ?? 'nichts', fertig_spalte_id: r.fertig_spalte_id ?? null,
  darf_aendern: zugriff ? !!zugriff.darf_aendern : r.user_id === userId,
  // Beim eigenen Projekt steht, mit wem es geteilt ist; beim fremden nur, DASS es geteilt wurde.
  geteilt_mit: r.user_id === userId
    ? db.prepare(`SELECT ${USER_COLS}, g.darf_aendern FROM todo_ordner_geteilt g
        JOIN users u ON u.id = g.user_id WHERE g.ordner_id = ?`).all(r.id)
      .map(x => ({ ...person(x), darf_aendern: !!x.darf_aendern }))
    : [],
  offen: db.prepare('SELECT count(*) AS n FROM todos WHERE ordner_id = ? AND done = 0').get(r.id).n,
  spalten: db.prepare('SELECT count(*) AS n FROM todo_spalten WHERE ordner_id = ?').get(r.id).n,
});

app.get('/api/todo-ordner', auth, (req, res) => {
  const zugriff = meineOrdner(req.user.id);
  const ids = [...zugriff.keys()];
  const platz = ids.map(() => '?').join(',') || '0';
  res.json(db.prepare(`SELECT * FROM todo_ordner WHERE id IN (${platz})
      ORDER BY name COLLATE NOCASE`).all(...ids)
    .map(r => ordnerZeile(r, req.user.id, zugriff.get(r.id))));
});

app.post('/api/todo-ordner', auth, (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  // Ein Unterprojekt geht nur dort hinein, wo man auch schreiben darf.
  const eltern = Number(req.body?.parent_id) || null;
  if (eltern && !darfOrdner(req.user.id, eltern, true))
    return res.status(404).json({ error: 'Übergeordnete Liste nicht gefunden' });
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO todo_ordner(user_id, name, parent_id, ist_ordner, created_at)
     VALUES(?, ?, ?, ?, datetime('now'))`)
    .run(req.user.id, name, eltern, req.body?.ist_ordner ? 1 : 0);
  const neu = db.prepare('SELECT * FROM todo_ordner WHERE id = ?').get(Number(lastInsertRowid));
  // Ein frisches Board bekommt drei Spalten - ein leeres Brett sagt niemandem, was es sein will.
  if (!neu.ist_ordner) {
    const sp = db.prepare('INSERT INTO todo_spalten(ordner_id, name, sort) VALUES(?, ?, ?)');
    ['Offen', 'Dran', 'Fertig'].forEach((n, i) => sp.run(neu.id, n, i));
  }
  res.status(201).json(ordnerZeile(neu, req.user.id));
});

/** Ist `ziel` ein Nachfahre von `id`? Schutz davor, ein Projekt in sich selbst zu schieben. */
function istNachfahre(id, ziel) {
  const nach = new Map(db.prepare('SELECT id, parent_id FROM todo_ordner').all().map(o => [o.id, o.parent_id]));
  let p = ziel;
  for (let i = 0; p && i < 20; i++) {
    if (p === id) return true;
    p = nach.get(p) ?? null;
  }
  return false;
}

app.put('/api/todo-ordner/:id', auth, (req, res) => {
  const id = Number(req.params.id) || 0;
  const o = db.prepare('SELECT * FROM todo_ordner WHERE id = ? AND user_id = ?').get(id, req.user.id);
  // Umbenennen, Verschieben und Loeschen bleiben beim Besitzer - wer geteilt bekommt, arbeitet
  // darin, aber verfuegt nicht darueber.
  if (!o) return res.status(404).json({ error: 'Liste nicht gefunden' });
  const b = req.body ?? {};
  const name = String(b.name ?? o.name).trim().slice(0, 60) || o.name;

  let eltern = o.parent_id;
  if ('parent_id' in b) {
    eltern = Number(b.parent_id) || null;
    if (eltern === id || (eltern && istNachfahre(id, eltern)))
      return res.status(400).json({ error: 'Eine Liste kann nicht in sich selbst liegen' });
    if (eltern && !darfOrdner(req.user.id, eltern, true))
      return res.status(404).json({ error: 'Übergeordnete Liste nicht gefunden' });
  }
  const regel = ['nichts', 'verschieben', 'loeschen'].includes(b.fertig_regel)
    ? b.fertig_regel : o.fertig_regel;
  const spalte = 'fertig_spalte_id' in b ? spalteImOrdner(b.fertig_spalte_id, id) : o.fertig_spalte_id;

  db.prepare(`UPDATE todo_ordner SET name = ?, parent_id = ?, fertig_regel = ?, fertig_spalte_id = ?
              WHERE id = ?`).run(name, eltern, regel, spalte, id);
  res.json(ordnerZeile(db.prepare('SELECT * FROM todo_ordner WHERE id = ?').get(id), req.user.id));
});

app.delete('/api/todo-ordner/:id', auth, (req, res) => {
  const id = Number(req.params.id) || 0;
  const meiner = db.prepare('SELECT * FROM todo_ordner WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  // Unterprojekte gehen nicht mit unter: sie ruecken eine Ebene hoch. Ein Klick darf nicht einen
  // ganzen Baum mitnehmen.
  if (meiner) db.prepare('UPDATE todo_ordner SET parent_id = ? WHERE parent_id = ?')
    .run(meiner.parent_id ?? null, id);
  if (meiner) {
    // Die ToDos gehen mit - ein Ordner ist kein Etikett, sondern der Ort, an dem sie liegen.
    db.prepare('DELETE FROM todo_ordner WHERE id = ?').run(id);
    return res.json({ ok: true });
  }
  // Wer nur geteilt bekommen hat, nimmt sich selbst heraus.
  const { changes } = db.prepare('DELETE FROM todo_ordner_geteilt WHERE ordner_id = ? AND user_id = ?')
    .run(id, req.user.id);
  if (!changes) return res.status(404).json({ error: 'Ordner nicht gefunden' });
  res.json({ ok: true });
});

/** Teilen - mit Freunden, wie ueberall sonst in der App. */
app.post('/api/todo-ordner/:id/teilen', auth, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT 1 FROM todo_ordner WHERE id = ? AND user_id = ?').get(id, req.user.id))
    return res.status(404).json({ error: 'Ordner nicht gefunden' });
  const wen = Number(req.body?.user_id) || 0;
  if (!istFreund(req.user.id, wen))
    return res.status(403).json({ error: 'Teilen geht nur mit Freunden' });

  db.prepare(`INSERT INTO todo_ordner_geteilt(ordner_id, user_id, darf_aendern, rekursiv)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(ordner_id, user_id) DO UPDATE SET darf_aendern = excluded.darf_aendern,
        rekursiv = excluded.rekursiv`)
    .run(id, wen, req.body?.darf_aendern === false ? 0 : 1, req.body?.rekursiv === false ? 0 : 1);
  benachrichtige(wen, 'todo', `${nameVon(req.user)} teilt eine Liste mit dir`, null, '/');
  res.status(201).json({ ok: true });
});

app.delete('/api/todo-ordner/:id/teilen/:wen', auth, (req, res) => {
  const id = Number(req.params.id) || 0;
  const wen = Number(req.params.wen) || 0;
  const meiner = db.prepare('SELECT 1 FROM todo_ordner WHERE id = ? AND user_id = ?')
    .get(id, req.user.id);
  if (!meiner && wen !== req.user.id) return res.status(403).json({ error: 'Nicht dein Ordner' });
  db.prepare('DELETE FROM todo_ordner_geteilt WHERE ordner_id = ? AND user_id = ?').run(id, wen);
  res.json({ ok: true });
});

// Eigene ToDos UND alles, was in einem Ordner liegt, den ich habe.
app.get('/api/todos', auth, (req, res) => {
  const ids = [...meineOrdner(req.user.id).keys()];
  const platz = ids.map(() => '?').join(',') || '0';
  const zeilen = db.prepare(`SELECT * FROM todos
    WHERE user_id = ? OR ordner_id IN (${platz})
    ORDER BY COALESCE(due_at, '9999'), sort, id`).all(req.user.id, ...ids);
  const zust = zustaendigeVon(zeilen.map(r => r.id));
  res.json(zeilen.map(r => todoZeile(r, zust.get(r.id) ?? [])));
});

app.post('/api/todos', auth, (req, res) => {
  const { data, error } = todoEingabe(req.body);
  if (error) return res.status(400).json({ error });
  const ordner = Number(req.body?.ordner_id) || null;
  if (ordner && !darfOrdner(req.user.id, ordner, true))
    return res.status(404).json({ error: 'Liste nicht gefunden' });
  const spalte = spalteImOrdner(req.body?.spalte_id, ordner);
  const zust = zustaendigeAus(req.body, ordner, req.user.id) ?? [];
  if (zust === false) return res.status(400).json({ error: 'Diese Person ist nicht dabei' });
  let id;
  transaktion(() => {
    id = Number(db.prepare(`
      INSERT INTO todos(user_id, text, due_at, remind_min, ordner_id, spalte_id,
        wiederholung, wiederholung_einheit, sichtbar_ab, prioritaet, sort, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(req.user.id, data.text, data.due_at, data.remind_min, ordner, spalte,
        data.wiederholung, data.wiederholung_einheit, data.sichtbar_ab, data.prioritaet,
        naechsterPlatz(spalte)).lastInsertRowid);
    zustaendigeSetzen(id, zust);
  });
  res.json(todoZeile(db.prepare('SELECT * FROM todos WHERE id = ?').get(id)));
});

/**
 * Darf ich an dieses ToDo? Meines - oder eines in einem Ordner, den ich habe.
 *
 * Ohne die zweite Haelfte waere ein geteilter Ordner nur zum Zuschauen da: sehen ja, abhaken nein.
 */
const meinTodo = (id, userId, aendern = false) => {
  const t = db.prepare('SELECT * FROM todos WHERE id = ?').get(Number(id) || 0);
  if (!t) return null;
  if (t.user_id === userId && !t.ordner_id) return t;
  if (t.ordner_id) {
    const e = meineOrdner(userId).get(t.ordner_id);
    if (e && (!aendern || e.darf_aendern)) return t;
  }
  return t.user_id === userId ? t : null;
};

app.put('/api/todos/:id', auth, (req, res) => {
  const { data, error } = todoEingabe(req.body);
  if (error) return res.status(400).json({ error });
  if (!meinTodo(req.params.id, req.user.id, true))
    return res.status(404).json({ error: 'ToDo nicht gefunden' });
  const ordner = 'ordner_id' in (req.body ?? {}) ? (Number(req.body.ordner_id) || null) : undefined;
  if (ordner && !darfOrdner(req.user.id, ordner, true))
    return res.status(404).json({ error: 'Liste nicht gefunden' });

  const alt = meinTodo(req.params.id, req.user.id);
  const zielOrdner = ordner === undefined ? alt.ordner_id : ordner;
  const spalte = 'spalte_id' in (req.body ?? {})
    ? spalteImOrdner(req.body.spalte_id, zielOrdner) : alt.spalte_id;
  let zust = zustaendigeAus(req.body, zielOrdner, req.user.id);
  if (zust === false) return res.status(400).json({ error: 'Diese Person ist nicht dabei' });
  // Nicht mitgeschickt, aber in ein anderes Projekt verschoben: wer dort nicht dabei ist, faellt
  // heraus - freie Namen bleiben.
  if (zust === undefined && zielOrdner !== alt.ordner_id)
    zust = (zustaendigeVon([alt.id]).get(alt.id) ?? [])
      .map(z => (z.id ? { user_id: zustaendigOk(z.id, zielOrdner, req.user.id) || null, name: null }
        : { user_id: null, name: z.name }))
      .filter(z => z.user_id || z.name);

  transaktion(() => {
    // notified_at zuruecksetzen: wer den Termin verschiebt, will auch neu erinnert werden.
    db.prepare(`UPDATE todos SET text = ?, due_at = ?, remind_min = ?,
        ordner_id = CASE WHEN ? THEN ? ELSE ordner_id END,
        spalte_id = ?, zustaendig_id = NULL, wiederholung = ?, wiederholung_einheit = ?,
        sichtbar_ab = ?, prioritaet = ?,
        notified_at = CASE WHEN due_at IS ? AND remind_min = ? THEN notified_at ELSE NULL END
      WHERE id = ?`)
      .run(data.text, data.due_at, data.remind_min,
        ordner === undefined ? 0 : 1, ordner ?? null,
        spalte, data.wiederholung, data.wiederholung_einheit, data.sichtbar_ab, data.prioritaet,
        data.due_at, data.remind_min, Number(req.params.id));
    if (zust !== undefined) zustaendigeSetzen(alt.id, zust);
  });
  res.json(todoZeile(db.prepare('SELECT * FROM todos WHERE id = ?').get(Number(req.params.id))));
});

// Alle erledigten auf einmal weg - die eigenen losen oder die eines Projekts, in dem man aendern
// darf. Endgueltig, ohne Rueckgaengig: wer das waehlt, will Platz, keine Rueckversicherung.
app.delete('/api/todos/erledigt', auth, (req, res) => {
  const ordner = Number(req.query.ordner) || null;
  if (ordner && !darfOrdner(req.user.id, ordner, true))
    return res.status(404).json({ error: 'Liste nicht gefunden' });
  const { changes } = ordner
    ? db.prepare('DELETE FROM todos WHERE done = 1 AND ordner_id = ?').run(ordner)
    : db.prepare('DELETE FROM todos WHERE done = 1 AND user_id = ? AND ordner_id IS NULL').run(req.user.id);
  res.json({ n: Number(changes) });
});

app.delete('/api/todos/:id', auth, (req, res) => {
  if (!meinTodo(req.params.id, req.user.id, true))
    return res.status(404).json({ error: 'ToDo nicht gefunden' });
  db.prepare('DELETE FROM todos WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

for (const [methode, wert] of [['post', 1], ['delete', 0]]) {
  app[methode]('/api/todos/:id/done', auth, (req, res) => {
    // In einem geteilten Ordner gilt das Abhaken fuer alle - eine Liste, an der jeder fuer sich
    // abhakt, waere keine Liste, sondern fuenf.
    const t = meinTodo(req.params.id, req.user.id, true);
    if (!t) return res.status(404).json({ error: 'ToDo nicht gefunden' });
    if (!wert) {
      db.prepare('UPDATE todos SET done = 0, done_at = NULL WHERE id = ?').run(t.id);
      return res.json({ done: false });
    }

    // Wiederkehrend: nicht erledigen, sondern weiterruecken - sonst waere die Serie nach dem
    // ersten Haken zu Ende.
    if (t.wiederholung > 0 && t.due_at) {
      const naechst = naechsteFaelligkeit(t.due_at, t.wiederholung, t.wiederholung_einheit ?? 'woche');
      db.prepare(`UPDATE todos SET done = 0, due_at = ?, sichtbar_ab = ?, notified_at = NULL
                  WHERE id = ?`).run(naechst, naechst, t.id);
      return res.json({ done: false, naechst });
    }

    // Sonst gilt die Regel des Projekts: liegen lassen, wegschieben oder loeschen.
    const o = t.ordner_id ? db.prepare('SELECT * FROM todo_ordner WHERE id = ?').get(t.ordner_id) : null;
    if (o?.fertig_regel === 'loeschen') {
      db.prepare('DELETE FROM todos WHERE id = ?').run(t.id);
      return res.json({ done: true, geloescht: true });
    }
    if (o?.fertig_regel === 'verschieben' && o.fertig_spalte_id)
      db.prepare("UPDATE todos SET done = 1, done_at = datetime('now'), spalte_id = ? WHERE id = ?").run(o.fertig_spalte_id, t.id);
    else db.prepare("UPDATE todos SET done = 1, done_at = datetime('now') WHERE id = ?").run(t.id);
    res.json({ done: true });
  });
}

// --- Das Board: Bereiche, Spalten, Reihenfolge -------------------------------

/** Eine Spalte gehoert immer zu ihrem Projekt - sonst laege die Aufgabe in einem fremden Board. */
function spalteImOrdner(spalteId, ordnerId) {
  const id = Number(spalteId) || 0;
  if (!id || !ordnerId) return null;
  return db.prepare('SELECT 1 FROM todo_spalten WHERE id = ? AND ordner_id = ?').get(id, ordnerId)
    ? id : null;
}

/** Zustaendig kann nur sein, wer das Projekt ueberhaupt sieht. `false` heisst: abgelehnt. */
function zustaendigOk(wen, ordnerId, userId) {
  const id = Number(wen) || 0;
  if (!id) return null;
  if (!ordnerId) return id === userId ? id : false;
  const o = db.prepare('SELECT user_id FROM todo_ordner WHERE id = ?').get(ordnerId);
  if (!o) return false;
  const kreis = new Set([o.user_id, ...db.prepare(
    'SELECT user_id FROM todo_ordner_geteilt WHERE ordner_id = ?').all(ordnerId).map(r => r.user_id)]);
  return kreis.has(id) ? id : false;
}

/**
 * Die Zustaendigen aus der Eingabe: [{id}] fuer Mitglieder, [{name}] fuer Leute ohne Konto (nur zur
 * Uebersicht). `false` heisst abgelehnt, `undefined` heisst: nicht mitgeschickt, bleibt wie es ist.
 * `zustaendig_id` ist der alte Weg mit genau einer Person - ein alter Client geht damit weiter.
 */
function zustaendigeAus(b, ordnerId, userId) {
  if (b && 'zustaendige' in b) {
    if (b.zustaendige == null) return [];
    if (!Array.isArray(b.zustaendige)) return false;
    const raus = [], gesehen = new Set();
    for (const z of b.zustaendige.slice(0, 20)) {
      if (z?.id != null) {
        const id = zustaendigOk(z.id, ordnerId, userId);
        if (!id) return false;
        if (!gesehen.has(`u${id}`)) { gesehen.add(`u${id}`); raus.push({ user_id: id, name: null }); }
      } else {
        const name = String(z?.name ?? '').trim().slice(0, 40);
        if (name && !gesehen.has(`n${name.toLowerCase()}`)) {
          gesehen.add(`n${name.toLowerCase()}`);
          raus.push({ user_id: null, name });
        }
      }
    }
    return raus;
  }
  if (b && 'zustaendig_id' in b) {
    const id = zustaendigOk(b.zustaendig_id, ordnerId, userId);
    return id === false ? false : id ? [{ user_id: id, name: null }] : [];
  }
  return undefined;
}

function zustaendigeSetzen(todoId, liste) {
  db.prepare('DELETE FROM todo_zustaendige WHERE todo_id = ?').run(todoId);
  const ein = db.prepare('INSERT INTO todo_zustaendige(todo_id, user_id, name) VALUES(?, ?, ?)');
  for (const z of liste) ein.run(todoId, z.user_id, z.name);
}

const naechsterPlatz = spalteId => (spalteId
  ? (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM todos WHERE spalte_id = ?')
    .get(spalteId).n) : 0);

app.get('/api/todo-ordner/:id/board', auth, (req, res) => {
  const id = Number(req.params.id) || 0;
  const zugriff = meineOrdner(req.user.id).get(id);
  if (!zugriff) return res.status(404).json({ error: 'Liste nicht gefunden' });
  res.json({
    darf_aendern: !!zugriff.darf_aendern,
    bereiche: db.prepare('SELECT * FROM todo_bereiche WHERE ordner_id = ? ORDER BY sort, id').all(id),
    spalten: db.prepare('SELECT * FROM todo_spalten WHERE ordner_id = ? ORDER BY sort, id').all(id),
    mitglieder: db.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id IN (
        SELECT user_id FROM todo_ordner WHERE id = ?
        UNION SELECT user_id FROM todo_ordner_geteilt WHERE ordner_id = ?)`)
      .all(id, id).map(person),
  });
});

for (const [was, tabelle] of [['bereiche', 'todo_bereiche'], ['spalten', 'todo_spalten']]) {
  app.post(`/api/todo-ordner/:id/${was}`, auth, (req, res) => {
    const id = Number(req.params.id) || 0;
    if (!darfOrdner(req.user.id, id, true))
      return res.status(404).json({ error: 'Liste nicht gefunden' });
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Name nötig' });
    const bereich = tabelle === 'todo_spalten' && Number(req.body?.bereich_id)
      ? (db.prepare('SELECT 1 FROM todo_bereiche WHERE id = ? AND ordner_id = ?')
        .get(Number(req.body.bereich_id), id) ? Number(req.body.bereich_id) : null)
      : null;
    const sort = db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM ${tabelle} WHERE ordner_id = ?`)
      .get(id).n;
    const { lastInsertRowid } = tabelle === 'todo_spalten'
      ? db.prepare('INSERT INTO todo_spalten(ordner_id, bereich_id, name, sort) VALUES(?, ?, ?, ?)')
        .run(id, bereich, name, sort)
      : db.prepare('INSERT INTO todo_bereiche(ordner_id, name, sort) VALUES(?, ?, ?)')
        .run(id, name, sort);
    res.status(201).json(db.prepare(`SELECT * FROM ${tabelle} WHERE id = ?`).get(Number(lastInsertRowid)));
  });

  app.patch(`/api/todo-${was === 'bereiche' ? 'bereiche' : 'spalten'}/:id`, auth, (req, res) => {
    const z = db.prepare(`SELECT * FROM ${tabelle} WHERE id = ?`).get(Number(req.params.id) || 0);
    if (!z || !darfOrdner(req.user.id, z.ordner_id, true))
      return res.status(404).json({ error: 'Nicht gefunden' });
    const name = String(req.body?.name ?? z.name).trim().slice(0, 60) || z.name;
    const sort = Number.isInteger(Number(req.body?.sort)) ? Number(req.body.sort) : z.sort;
    if (tabelle === 'todo_spalten' && 'bereich_id' in (req.body ?? {})) {
      const b = Number(req.body.bereich_id) || null;
      const gut = !b || db.prepare('SELECT 1 FROM todo_bereiche WHERE id = ? AND ordner_id = ?')
        .get(b, z.ordner_id);
      db.prepare('UPDATE todo_spalten SET bereich_id = ? WHERE id = ?').run(gut ? b : null, z.id);
    }
    db.prepare(`UPDATE ${tabelle} SET name = ?, sort = ? WHERE id = ?`).run(name, sort, z.id);
    res.json(db.prepare(`SELECT * FROM ${tabelle} WHERE id = ?`).get(z.id));
  });

  app.delete(`/api/todo-${was === 'bereiche' ? 'bereiche' : 'spalten'}/:id`, auth, (req, res) => {
    const z = db.prepare(`SELECT * FROM ${tabelle} WHERE id = ?`).get(Number(req.params.id) || 0);
    if (!z || !darfOrdner(req.user.id, z.ordner_id, true))
      return res.status(404).json({ error: 'Nicht gefunden' });
    // Aufgaben und Spalten gehen nicht mit unter: sie rutschen eine Ebene hoch. Eine geloeschte
    // Spalte darf keine Arbeit mitnehmen.
    if (tabelle === 'todo_spalten') db.prepare('UPDATE todos SET spalte_id = NULL WHERE spalte_id = ?').run(z.id);
    else db.prepare('UPDATE todo_spalten SET bereich_id = NULL WHERE bereich_id = ?').run(z.id);
    db.prepare(`DELETE FROM ${tabelle} WHERE id = ?`).run(z.id);
    res.json({ ok: true });
  });
}

/**
 * Die Reihenfolge einer Spalte in einem Rutsch setzen.
 *
 * Nicht N einzelne Aenderungen: bricht die Reihe in der Mitte ab, bliebe eine halb sortierte
 * Spalte zurueck, und niemand wuesste, welche Haelfte stimmt.
 */
app.put('/api/todo-spalten/:id/reihenfolge', auth, (req, res) => {
  const sp = db.prepare('SELECT * FROM todo_spalten WHERE id = ?').get(Number(req.params.id) || 0);
  if (!sp || !darfOrdner(req.user.id, sp.ordner_id, true))
    return res.status(404).json({ error: 'Spalte nicht gefunden' });
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 300);

  db.exec('BEGIN');
  try {
    const setz = db.prepare('UPDATE todos SET spalte_id = ?, sort = ? WHERE id = ? AND ordner_id = ?');
    ids.forEach((id, i) => setz.run(sp.id, i, id, sp.ordner_id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

/**
 * Faellige Erinnerungen verschicken. Laeuft im selben Zehn-Minuten-Takt wie der WebUntis-Abgleich
 * - eine Stelle fuer alles Periodische ist leichter zu ueberblicken als zwei Timer.
 *
 * ponytail: dadurch kann eine Erinnerung bis zu zehn Minuten zu spaet kommen. Bei "einen Tag
 * vorher" faellt das niemandem auf, bei "zur Faelligkeit" schon. Ein Timer je ToDo waere die
 * Alternative und den Aufwand nicht wert.
 */
export function todoErinnerungen() {
  const faellig = db.prepare(`SELECT * FROM todos
    WHERE done = 0 AND notified_at IS NULL
      AND datetime(due_at, '-' || remind_min || ' minutes') <= datetime('now', 'localtime')`).all();

  for (const t of faellig) {
    db.prepare("UPDATE todos SET notified_at = datetime('now') WHERE id = ?").run(t.id);
    const [tag, zeit] = t.due_at.split(' ');
    const wann = new Date(tag + 'T00:00:00Z')
      .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    // Liegt das ToDo in einem geteilten Ordner, erinnert es alle, die ihn haben - sonst waere das
    // Teilen halb: gemeinsam eintragen, aber nur einer wird erinnert.
    let wer = t.ordner_id
      ? db.prepare(`SELECT user_id FROM todo_ordner WHERE id = ?
                    UNION SELECT user_id FROM todo_ordner_geteilt WHERE ordner_id = ?`)
          .all(t.ordner_id, t.ordner_id).map(r => r.user_id)
      : [t.user_id];
    // Ist jemand zustaendig, betrifft es nur ihn - die anderen muessen es nicht erledigen.
    const zust = db.prepare('SELECT user_id FROM todo_zustaendige WHERE todo_id = ? AND user_id IS NOT NULL')
      .all(t.id).map(r => r.user_id).filter(id => wer.includes(id));
    if (zust.length) wer = zust;
    for (const uid of wer)
      benachrichtige(uid, 'todo', t.text, `Fällig ${wann}, ${zeit} Uhr`, '/', { datum: tag, zeit });
  }
}

// --- Freunde ----------------------------------------------------------------

const friendIds = me => db.prepare(`
  SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS id
  FROM friendships WHERE status = 'accepted' AND (from_id = ? OR to_id = ?)`)
  .all(me, me, me).map(r => r.id).filter((id, i, a) => a.indexOf(id) === i);

app.get('/api/friends', auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT f.from_id, f.to_id, f.status, ${USER_COLS}
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.from_id = ? THEN f.to_id ELSE f.from_id END
    WHERE f.from_id = ? OR f.to_id = ?
    ORDER BY u.username`).all(me, me, me);
  // Der Schulname kommt mit: die Planauswahl gruppiert danach, und wer nur Freunde an einer
  // Schule hat, bekommt die andere gar nicht zu sehen.
  const std = standardSchule();
  const schulen = new Map(db.prepare('SELECT id, name FROM schools').all().map(x => [x.id, x.name]));
  // Je Person einmal - alte Datenbanken koennen eine Freundschaft in beiden Richtungen haben.
  const pick = fn => [...new Map(rows.filter(fn).map(r => [r.id, {
    ...person(r), school: schulen.get(r.school_id ?? std.id) ?? std.name,
  }])).values()];
  res.json({
    friends: pick(r => r.status === 'accepted'),
    incoming: pick(r => r.status === 'pending' && r.to_id === me),
    outgoing: pick(r => r.status === 'pending' && r.from_id === me),
  });
});

// Suche nach Username ODER Anzeigename. Zurueck kommt nur, was fuer jeden Angemeldeten ohnehin
// sichtbar ist (Name, Farbe, Bild-Kennzeichen) - und ohne einen selbst.
app.get('/api/users/search', auth, bremse('suche', 60), (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Bitte mit mindestens zwei Zeichen suchen' });
  // % und _ sind LIKE-Platzhalter. Statt sie zu maskieren (und dafuer eine ESCAPE-Klausel zu
  // brauchen) fliegen sie raus - in Namen kommen sie ohnehin nicht vor, und "%" als Suche wuerde
  // sonst schlicht alle Nutzer auflisten.
  const wie = `%${q.replace(/[%_]/g, ' ')}%`;
  const treffer = db.prepare(`SELECT ${USER_COLS} FROM users u
    WHERE u.id <> ? AND (u.username LIKE ? OR u.display_name LIKE ?)
    ORDER BY u.username LIMIT 20`).all(req.user.id, wie, wie);

  // Wer schon Freund ist oder eine offene Anfrage hat, wird gekennzeichnet statt versteckt -
  // sonst sucht man jemanden und findet ihn scheinbar nicht.
  const stand = new Map(db.prepare(`SELECT
      CASE WHEN from_id = ? THEN to_id ELSE from_id END AS id, status, from_id
    FROM friendships WHERE from_id = ? OR to_id = ?`).all(req.user.id, req.user.id, req.user.id)
    .map(r => [r.id, r.status === 'accepted' ? 'freund'
      : r.from_id === req.user.id ? 'angefragt' : 'wartet']));

  res.json(treffer.map(u => ({ ...person(u), stand: stand.get(u.id) ?? null })));
});

app.post('/api/friends', auth, bremse('freunde', 30), (req, res) => {
  const me = req.user.id;
  const other = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username ?? '').trim());
  if (!other) return res.status(404).json({ error: 'Diesen User gibt es nicht' });
  if (other.id === me) return res.status(400).json({ error: 'Du kannst dich nicht selbst hinzufügen' });
  // Läuft schon eine Anfrage in die Gegenrichtung, ist das hier das Annehmen - keine zweite Anfrage.
  const back = db.prepare("SELECT 1 FROM friendships WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .get(other.id, me);
  if (back) {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE from_id = ? AND to_id = ?").run(other.id, me);
    benachrichtige(other.id, 'freunde', `${nameVon(req.user)} hat deine Anfrage angenommen`, null, '/');
    return res.json({ status: 'accepted' });
  }
  // Schon befreundet (egal, wer damals gefragt hat)? Dann keine zweite Zeile in Gegenrichtung -
  // sonst stand derselbe Freund zweimal in jeder Liste.
  const schon = db.prepare(`SELECT status FROM friendships
    WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`).get(me, other.id, other.id, me);
  if (schon) return res.status(409).json({ error: schon.status === 'accepted' ? 'Ihr seid schon befreundet' : 'Anfrage läuft schon' });
  try {
    db.prepare("INSERT INTO friendships(from_id, to_id, status) VALUES(?, ?, 'pending')").run(me, other.id);
    benachrichtige(other.id, 'freunde', `${nameVon(req.user)} möchte dein Freund werden`, null, '/');
    res.json({ status: 'pending' });
  } catch {
    // Die UNIQUE-Verletzung trifft beide Faelle - "Anfrage laeuft schon" waere bei einer laengst
    // bestaetigten Freundschaft schlicht falsch.
    const stand = db.prepare(`SELECT status FROM friendships
      WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`).get(me, other.id, other.id, me);
    res.status(409).json({ error: stand?.status === 'accepted'
      ? 'Ihr seid schon befreundet' : 'Anfrage läuft schon' });
  }
});

app.post('/api/friends/:id/accept', auth, (req, res) => {
  const anfrager = Number(req.params.id);
  const { changes } = db.prepare(
    "UPDATE friendships SET status = 'accepted' WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .run(anfrager, req.user.id);
  if (!changes) return res.status(404).json({ error: 'Keine offene Anfrage' });
  benachrichtige(anfrager, 'freunde', `${nameVon(req.user)} hat deine Anfrage angenommen`, null, '/');
  res.json({ ok: true });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const me = req.user.id, other = Number(req.params.id);
  db.prepare('DELETE FROM friendships WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)')
    .run(me, other, other, me);
  res.json({ ok: true });
});

// --- WebUntis ---------------------------------------------------------------
// Der Abgleich schreibt in untis_lessons (datumsbezogen) und legt Faecher, Lehrer und Kurse in den
// vorhandenen Tabellen an. Nur so bleiben gemeinsame Stunden, Hausaufgaben und Notizen unveraendert
// funktionsfaehig - WebUntis liegt nicht daneben, sondern wird auf das bestehende Modell abgebildet.

// Kein WebUntis-Admin-Zugang noetig: die Schule wird gesucht, jeder meldet sich mit seinem
// eigenen Schuelerkonto an. Server und Schule stehen einmal global - alle sind an derselben
// Schule -, und gesetzt werden sie von dem, dessen Anmeldung dort als Erstes klappt.

// --- Schulen -----------------------------------------------------------------
// Die eingestellte Schule ist die Vorgabe (users.school_id IS NULL), aber wer woanders zur Schule
// geht, meldet sich ueber sein Profil mit seiner eigenen an. Alles, was von Schule zu Schule
// verschieden ist - Stundenraster, Ferien, Kurs-IDs -, haengt ab hier daran.

const schuleVon = userId => db.prepare(`SELECT * FROM schools WHERE id = COALESCE(
    (SELECT school_id FROM users WHERE id = ?), (SELECT id FROM schools WHERE standard = 1))`)
  .get(userId) ?? standardSchule();

const periodsFuer = schoolId =>
  db.prepare('SELECT * FROM periods WHERE school_id = ? ORDER BY nr').all(schoolId);

// Die Kurs-IDs der Standardschule bleiben ohne Praefix - sie stehen so in jeder bestehenden
// Datenbank. Jede weitere Schule bekommt eins, sonst fielen zwei Kurse mit derselben lsnumber
// zusammen und wildfremde Leute teilten Farbe und Hausaufgaben.
const kursPraefix = schule => (schule.standard ? '' : `S${schule.id}-`);

// Nach aussen gehoert der Name. Server und Anmeldename sind Innereien.
const schuleNachAussen = s => (s
  ? { id: s.id, name: s.name, standard: !!s.standard, quelle: s.quelle ?? 'untis' }
  : null);

/**
 * Die Schule zu einer Anmeldung finden oder anlegen.
 *
 * Auf einer frischen Instanz fuellt die erste erfolgreiche Anmeldung die Standardschule - so war
 * es immer, und ohne WebUntis-Admin gibt es keinen anderen Weg, sie zu setzen.
 */
function schuleSichern(server, school, name, quelle = 'untis') {
  const anzeige = String(name ?? '').trim().slice(0, 80) || school || server;

  // Erst nachsehen, ob es die Schule schon gibt. Anders herum waere es ein Fehler: hat der Admin
  // die Standardschule zurueckgesetzt, waehrend jemand mit seiner eigenen angemeldet ist, und
  // meldet sich dann jemand bei genau dieser an, liefe die Zeile unten in den UNIQUE-Schluessel -
  // und der Nutzer laese "Anmeldung bei WebUntis fehlgeschlagen", obwohl sie geklappt hat.
  const da = db.prepare('SELECT * FROM schools WHERE server = ? AND school = ?').get(server, school);
  if (da) {
    // Der Anzeigename aus der Schulsuche gewinnt: bei der Umstellung auf mehrere Schulen stand in
    // der Standardschule nur ihr Anmeldename ("gym-nordhorn"), und den will niemand lesen.
    if (name && da.name !== anzeige)
      db.prepare('UPDATE schools SET name = ? WHERE id = ?').run(anzeige, da.id);
    return db.prepare('SELECT * FROM schools WHERE id = ?').get(da.id);
  }

  // Auf einer frischen Instanz fuellt die erste erfolgreiche Anmeldung die Standardschule - so war
  // es immer, und ohne WebUntis-Admin gibt es keinen anderen Weg, sie zu setzen. Eine IServ-Schule
  // wird das nie: die Standardschule ist die der Instanz, und die haengt an WebUntis.
  const std = standardSchule();
  if (quelle === 'untis' && !std.server && !std.school) {
    db.prepare('UPDATE schools SET server = ?, school = ?, name = ? WHERE id = ?')
      .run(server, school, anzeige, std.id);
    setSetting('untis_server', server);
    setSetting('untis_school', school);
    return standardSchule();
  }

  const { lastInsertRowid } = db.prepare(
    `INSERT INTO schools(server, school, name, quelle, created_at) VALUES(?, ?, ?, ?, datetime('now'))`)
    .run(server, school, anzeige, quelle);
  return db.prepare('SELECT * FROM schools WHERE id = ?').get(Number(lastInsertRowid));
}

const untisAn = (userId = null) => {
  if (!untisKey()) return false;
  const s = userId ? schuleVon(userId) : standardSchule();
  // Bei IServ gibt es keinen Anmeldenamen der Schule - die Adresse ist alles.
  return s?.quelle === 'iserv' ? !!s.server : !!(s?.server && s?.school);
};

// Zwei Wege hinein: der Schluessel aus der Untis-App (TOTP) oder das Schulpasswort. Der Schluessel
// ist der bessere - er gibt nur Lesezugriff und laesst sich in WebUntis einzeln widerrufen.
const untisAnmelden = (server, school, username, geheim, typ) =>
  (typ === 'secret' ? loginMitSchluessel : login)(server, school, username, geheim);

const untisStatus = (userId = null) => ({
  moeglich: !!untisKey(),
  aktiv: untisAn(userId),
  server: (userId ? schuleVon(userId) : standardSchule())?.server ?? '',
  school: (userId ? schuleVon(userId) : standardSchule())?.school ?? '',
  // Der Anzeigename der eigenen Schule - "hektor.webuntis.com / gym-nord" sagt niemandem etwas.
  schule: schuleNachAussen(userId ? schuleVon(userId) : standardSchule()),
  quelle: (userId ? schuleVon(userId) : standardSchule())?.quelle ?? 'untis',
  // Der Schluessel legt sich normalerweise selbst an; hierher kommt man nur, wenn das schiefging.
  hinweis: untisKey() ? null : 'Der Schlüssel zum Verschlüsseln der Zugänge ließ sich nicht anlegen. '
    + 'Darf die App neben der Datenbank schreiben?',
});

app.get('/api/untis/status', auth, (req, res) => {
  const konto = db.prepare(`SELECT username, auth_typ, last_sync, last_error, text_stat, von, bis,
                           lehrstoff_geholt FROM untis_accounts WHERE user_id = ?`).get(req.user.id);
  if (konto) {
    try { konto.texte = JSON.parse(konto.text_stat ?? 'null'); } catch { konto.texte = null; }
    delete konto.text_stat;
  }
  res.json({ ...untisStatus(req.user.id), konto: konto ?? null });
});

/**
 * Was kommt an Texten wirklich zurueck? Ein Tag, alle Wege - als Bericht zum Kopieren.
 *
 * Der Lehrstoff fehlte an einer Schule bei jeder Stunde, obwohl er in WebUntis steht. Welcher
 * Endpunkt ihn dort traegt, laesst sich nur mit echten Daten sehen - wie bei IServ ist der
 * Bericht der Weg dahin. Das Passwort steht in keiner Zeile.
 */
app.get('/api/untis/texte', auth, bremse('untislogin', 10), async (req, res) => {
  const schule = schuleVon(req.user.id);
  const konto = db.prepare('SELECT * FROM untis_accounts WHERE user_id = ?').get(req.user.id);
  if (schule.quelle !== 'untis' || !konto || !untisKey())
    return res.status(400).json({ error: 'WebUntis ist nicht eingerichtet' });
  // Vorgabe: heute, am Wochenende der naechste Schultag.
  const heute = new Date().toISOString().slice(0, 10);
  const tag = ISO_DATE.test(req.query.date ?? '') ? req.query.date
    : [0, 6].includes(new Date(heute + 'T12:00:00Z').getUTCDay()) ? weekStart() : heute;
  try {
    const sitzung = await untisAnmelden(schule.server, schule.school,
      konto.username, zugangsPasswort(konto, sitzungsSchluessel(req)), konto.auth_typ);
    const bericht = await texteDiagnose(sitzung, tag).finally(() => logout(sitzung).catch(() => {}));
    res.json({ tag, bericht });
  } catch (err) {
    res.status(502).json({ error: 'WebUntis: ' + err.message });
  }
});

app.get('/api/untis/schools', auth, bremse('schulsuche', 20), async (req, res) => {
  if (!untisKey()) return res.status(400).json({ error: untisStatus().hinweis });
  try { res.json(await schulenSuchen(req.query.q)); }
  catch (err) { res.status(400).json({ error: 'Schulsuche fehlgeschlagen: ' + kurzerFehler(err) }); }
});

// Nur zum Korrigieren einer falsch gesetzten Schule. Zugaenge und abgeglichene Stunden zeigen auf
// die alte Schule und waeren danach Muell - deshalb raeumt das hier mit auf.
app.delete('/api/untis/school', auth, admin, (req, res) => {
  // Nur die Standardschule: wer sich mit seiner eigenen Schule angemeldet hat, hat damit nichts
  // zu tun und behaelt seinen Zugang.
  const std = standardSchule();
  const drin = db.prepare('SELECT id FROM users WHERE COALESCE(school_id, ?) = ?').all(std.id, std.id)
    .map(r => r.id);
  const platz = drin.map(() => '?').join(',') || '0';
  db.prepare(`DELETE FROM untis_lessons WHERE user_id IN (${platz})`).run(...drin);
  db.prepare(`DELETE FROM untis_accounts WHERE user_id IN (${platz})`).run(...drin);
  db.prepare('DELETE FROM holidays WHERE school_id = ?').run(std.id);
  db.prepare("UPDATE schools SET server = '', school = '', name = 'Meine Schule' WHERE id = ?")
    .run(std.id);
  setSetting('untis_server', '');
  setSetting('untis_school', '');
  res.json(untisStatus());
});

// Fach oder Lehrer nachschlagen, sonst anlegen. Vorhandene Namen werden wiederverwendet, damit
// aus dem Abgleich keine Dubletten entstehen. Was hier neu entsteht, traegt seine Herkunft.
function ensureNamed(table, name, ausUntis = false) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const row = sql(`SELECT id FROM ${table} WHERE name = ?`).get(n);
  if (row) return row.id;
  return Number(db.prepare(`INSERT INTO ${table}(name, from_untis) VALUES(?, ?)`)
    .run(n, ausUntis ? 1 : 0).lastInsertRowid);
}

// Zeit auf die naechstgelegene Stunde des Rasters abbilden. Exakt ist der Normalfall; die
// Naeherung faengt Faelle ab, in denen WebUntis auf die Minute abweicht.
function passendeStunde(perioden, start) {
  const genau = perioden.find(p => p.start_time === start);
  if (genau) return genau;
  const min = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  let beste = null, abstand = Infinity;
  for (const p of perioden) {
    const d = Math.abs(min(p.start_time) - min(start));
    if (d < abstand) { abstand = d; beste = p; }
  }
  return abstand <= 15 ? beste : null;
}

// Wie weit der Abgleich standardmaessig reicht. Vorher waren es zwei Wochen vorwaerts - danach
// stand ploetzlich wieder der selbst gebaute Plan da, was aussah, als sei der Import kaputt.
const SYNC_ZURUECK = 28, SYNC_VORAUS = 140;

/**
 * Das Stundenraster einer Schule, die noch keins hat.
 *
 * Ohne das faellt eine Schule, die um 7:30 anfaengt, komplett durch passendeStunde() - und der
 * Plan bliebe leer, ohne dass irgendwo stuende, warum.
 */
function rasterAnlegen(schule, gefunden) {
  // Kam nichts an, wird das Raster der Standardschule kopiert: ein grob passendes ist besser als
  // gar keins - und besser als ein Plan, der wortlos leer bleibt.
  const zeiten = gefunden?.length ? gefunden
    : periodsFuer(standardSchule().id)
      .map(p => ({ nr: p.nr, start_time: p.start_time, end_time: p.end_time }));
  const ein = db.prepare(
    'INSERT OR IGNORE INTO periods(school_id, nr, start_time, end_time) VALUES(?, ?, ?, ?)');
  for (const z of zeiten.slice(0, 20)) ein.run(schule.id, z.nr, z.start_time, z.end_time);
  return periodsFuer(schule.id);
}

/**
 * Stunden schreiben und melden, was sich geaendert hat - fuer WebUntis und IServ dasselbe.
 *
 * Die beiden Quellen unterscheiden sich nur darin, WOHER die Stundenliste kommt. Alles danach -
 * Kurse anlegen, ins Raster einpassen, mit dem letzten Stand vergleichen, benachrichtigen - ist
 * identisch und stand deshalb nur einmal da.
 */
export function stundenSchreiben({ userId, schule, perioden, stunden, von, bis, vollstaendig }) {
  let ohneRaster = 0, uebernommen = 0;

  const heuteIso = new Date().toISOString().slice(0, 10);
  // Der Stand des letzten Abgleichs, vollstaendig. Frueher standen hier nur die auffaelligen
  // Stunden (`status <> 'regular'`) und verglichen wurde nur der Status - eine reine
  // Raumaenderung war damit doppelt unsichtbar. Gemeldet wird weiterhin nur der WECHSEL, sonst
  // kaeme alle zehn Minuten dieselbe Meldung.
  const vorher = new Map(db.prepare(`SELECT date, period_id, status, course_id, room, info, teacher, lehrstoff, stand
    FROM untis_lessons WHERE user_id = ?`).all(userId)
    .map(r => [`${r.date}|${r.period_id}`, r]));
  const neueLage = [];

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM untis_lessons WHERE user_id = ? AND date BETWEEN ? AND ?').run(userId, von, bis);
    // Ein VOLLER Abgleich raeumt auch alles ausserhalb weg. Wer einmal in den Februar blaettert,
    // laesst dort Stunden zurueck, die danach kein Abgleich je wieder anfasst: der Hintergrundtakt
    // deckt nur die laufende Woche ±2, der volle nur ±140 Tage. Die Kurs-IDs von damals bleiben
    // dann fuer immer stehen, liegen in der Zukunft und gelten deshalb als aktuell - genau daher
    // die Kurse, die "erst im Februar" doppelt auftauchen. Blaettert jemand wieder hin, holt
    // 'vielleichtAbgleichen' die Woche frisch.
    if (vollstaendig)
      db.prepare('DELETE FROM untis_lessons WHERE user_id = ? AND (date < ? OR date > ?)')
        .run(userId, von, bis);
    const einfuegen = db.prepare(`
      INSERT INTO untis_lessons(user_id, date, period_id, course_id, room, status, info, lesson_text, teacher, room_regulaer, lehrstoff, stand)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date, period_id) DO UPDATE SET
        course_id = excluded.course_id, room = excluded.room, status = excluded.status,
        info = excluded.info, lesson_text = excluded.lesson_text, teacher = excluded.teacher,
        room_regulaer = excluded.room_regulaer, lehrstoff = excluded.lehrstoff, stand = excluded.stand`);

    // Alle Stunden je Slot, je Kurs eine. WebUntis schickt oft mehrere fuer denselben Slot
    // (Religion/Ethik, Wahlpflicht ohne Kurszuordnung, Ausfall plus Ersatz). Angezeigt und in den
    // Spalten gespeichert wird wie immer die letzte - verglichen wird aber JEDE mit ihrem eigenen
    // Vorstand: demselben Kurs im selben Slot. Bis 3.0.0 lief jede gegen die eine gespeicherte
    // ("Raum: B104 -> A213" alle zehn Minuten), in 3.0.1 zaehlte nur noch die letzte - und wessen
    // Kurs nicht zufaellig hinten stand, erfuhr von keinem Ausfall mehr.
    const slots = new Map();
    for (const s of stunden) {
      const p = passendeStunde(perioden, s.start);
      if (!p) { ohneRaster++; continue; }
      const fachId = s.subject ? ensureNamed('subjects', s.subject, true) : null;
      if (fachId && s.subject_short)
        sql('UPDATE subjects SET short = ? WHERE id = ? AND (short IS NULL OR short = ?)')
          .run(s.subject_short, fachId, '');
      // Bei einer Vertretung steht in 'teacher' der Vertreter. Wuerde er an den Kurs geschrieben,
      // klebte er dort dauerhaft - fuer JEDEN, der den Kurs hat, bis eine regulaere Stunde ihn
      // zuruecksetzt. Genau daran ist auch die Nachfolger-Erkennung beim Zusammenfuehren
      // gescheitert. Der Lehrer eines Kurses ist der, der ihn regulaer haelt.
      const lehrerId = s.teacher && s.status === 'regular'
        ? ensureNamed('teachers', s.teacher, true) : null;
      // sql(): je Stunde ein Aufruf - bei einem Halbjahr sind das weit ueber tausend.
      sql(`INSERT INTO courses(id, title, subject_id, teacher_id, from_untis, school_id)
                  VALUES(?, ?, ?, ?, 1, ?)
                  ON CONFLICT(id) DO UPDATE SET subject_id = COALESCE(excluded.subject_id, courses.subject_id),
                                                teacher_id = COALESCE(excluded.teacher_id, courses.teacher_id)`)
        .run(s.course_id, s.subject ?? s.course_id, fachId, lehrerId, schule.id);
      // Der Upsert oben trifft wegen NOCASE eine bestehende Kurszeile und laesst deren
      // Schreibweise stehen. Wuerde hier `s.course_id` landen, lägen Kurs und Stunde in
      // verschiedenen Schreibweisen - und der Kurs waere sichtbar, aber nicht benutzbar.
      const kursId = kanonischerKurs(s.course_id) ?? s.course_id;
      const k = `${s.date}|${p.id}`;
      const slot = slots.get(k) ?? slots.set(k, { p, kurse: new Map() }).get(k);
      // Derselbe Kurs zweimal im Slot (Ausfall plus Ersatz mit derselben Kursnummer) ist eine
      // Vertretung - der Ausfall verdraengt die Ersatzstunde nicht.
      const da = slot.kurse.get(kursId);
      if (!(da && s.status === 'cancelled' && da.status !== 'cancelled')) slot.kurse.set(kursId, s);
      // Angezeigt wird, was stattfindet: eine Pruefung vor allem, ein Ausfall nach allem. Bei
      // gleichem Rang die letzte, wie immer. Vorher gewann stur die letzte - und eine Klausur, die in
      // die naechste Stunde hineinreicht, verschwand hinter der dort ausgefallenen Stunde.
      if (!slot.zeige || rang(s) >= rang(slot.zeige.s)) slot.zeige = { s, kursId };
      uebernommen++;
    }

    // Was der Nutzer selbst festgelegt hat: entfernte oder ersetzte Stunden (je Wochentag). Dort
    // meldet nur der Kurs, den er behalten hat - eine entfernte Stunde meldet gar nichts mehr.
    const festgehalten = new Map(sql(`SELECT d.iso, e.period_id, e.course_id FROM entries e
      JOIN days d ON d.id = e.day_id WHERE e.user_id = ? AND e.vorrang = 1`).all(userId)
      .map(r => [`${r.iso}|${r.period_id}`, String(r.course_id).toLowerCase()]));
    const wochentag = datum => new Date(datum + 'T00:00:00Z').getUTCDay() || 7;

    for (const [k, { p, kurse, zeige: { s, kursId } }] of slots) {
      const zeile = vorher.get(k);
      // Der Vergleichsstand ALLER Stunden des Slots - daran misst sich der naechste Abgleich.
      const stand = {};
      for (const [id, x] of kurse)
        stand[id] = { status: x.status, room: x.room ?? null, teacher: x.teacher ?? null, info: x.info ?? null };
      // Lehrstoff nur ueberschreiben, wenn dieser Lauf ihn geholt hat - sonst loeschte jeder
      // Zehn-Minuten-Takt, was der stuendliche Abruf gebracht hat.
      einfuegen.run(userId, s.date, p.id, kursId, s.room, s.status, s.info, s.lesson_text, s.teacher,
        s.room_regulaer ?? null, s.lehrstoff ?? zeile?.lehrstoff ?? null, JSON.stringify(stand));
      // Nur was in der Zukunft liegt und sich gegenueber dem letzten Abgleich geaendert hat -
      // sonst meldet der erste Abgleich das halbe Halbjahr auf einmal.
      if (s.date < heuteIso) continue;
      const fest = festgehalten.get(`${wochentag(s.date)}|${p.id}`);
      for (const [kurs, x] of kurse) {
        if (fest && fest !== kurs.toLowerCase()) continue;   // entfernt oder ersetzt: nicht melden
        const alt = vorstand(zeile, kurs, kurse.size);
        if (alt === null) continue;   // unbekannt: nur merken
        const gemeinsam = { datum: x.date, nr: p.nr, fach: x.subject ?? x.course_id, info: x.info, kurs,
          // Fuer den Vorlauf: wann diese Stunde beginnt.
          start: p.start_time,
          // Fuer "wer hat dann auch frei": der Slot, um den es geht.
          periodId: p.id,
          ohneLehrer: x.status === 'irregular' && !x.teacher };
        if (x.status !== 'regular' && alt?.status !== x.status) {
          neueLage.push({ ...gemeinsam, status: x.status });
        } else {
          // Mit der gespeicherten Schreibweise der Kurs-ID vergleichen - sonst hiesse ein
          // Unterschied in Gross/Klein bei jedem Abgleich "Anderer Kurs".
          const was = stundenAenderung(alt, { ...x, course_id: kurs });
          if (was) neueLage.push({ ...gemeinsam, aenderung: was });
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Der abgedeckte Bereich waechst nur - so weiss die Plan-Route, wann sie nachladen muss.
  // Erst nach dem COMMIT: eine Benachrichtigung zu etwas, das gar nicht gespeichert wurde,
  // waere schlimmer als keine.
  // Wer will, bekommt dazugesagt, wer in der freien Stunde ebenfalls frei hat. Standardmaessig
  // nicht: die Meldung nennt Namen.
  const nennen = byId(userId)?.frei_hinweis === 1;
  // Dieselbe Meldung zu derselben Stunde geht nur EINMAL hinaus. Ein Hinweistext, der wegen eines
  // gescheiterten Abrufs kurz fehlt und dann wiederkommt, galt sonst jedes Mal als neu.
  const schonGemeldet = sql(`SELECT 1 FROM notifications WHERE user_id = ? AND ref = ?
    AND created_at > datetime('now', '-14 days') LIMIT 1`);
  for (const a of neueLage.slice(0, 10)) {
    // Der Kurs gehoert hinein: sonst schluckte die Sperre den Ausfall des zweiten Kurses im Slot.
    const ref = `lage:${a.datum}|${a.periodId}|${a.kurs}|${a.status ?? 'aenderung'}|${a.aenderung ?? ''}|${a.info ?? ''}`;
    if (schonGemeldet.get(userId, ref)) continue;
    const tag = tagKurz(a.datum);
    const wo = [`${tag}, ${a.nr}. Stunde`, a.info].filter(Boolean).join(' · ');
    const wann = { datum: a.datum, zeit: a.start };
    // Ausfall und Vertretung ohne Lehrer sind beides freie Zeit - beide bekommen den Nachsatz.
    const freieZeit = a.status === 'cancelled' || (a.status && a.ohneLehrer);
    const nachsatz = nennen && freieZeit ? auchFrei(userId, a.datum, a.periodId, schule) : '';
    if (a.aenderung)
      benachrichtige(userId, 'aenderung', `${a.fach} geändert`,
        [`${tag}, ${a.nr}. Stunde`, a.aenderung].join(' · '), '/', wann, ref);
    else if (a.status === 'cancelled')
      benachrichtige(userId, 'ausfall', `${a.fach} fällt aus`, wo + nachsatz, '/', wann, ref);
    // Eine Vertretung, fuer die niemand eingetragen ist, wird beim Namen genannt - "Vertretung:
    // Physik" liest sich sonst, als stuende jemand davor.
    else benachrichtige(userId, 'vertretung',
      a.ohneLehrer ? `${a.fach}: Vertretung ohne Lehrer` : `Vertretung: ${a.fach}`,
      wo + nachsatz, '/', wann, ref);
  }

  return { uebernommen, ohneRaster };
}

/**
 * Der Abgleich mit IServ - nur die laufende Woche.
 *
 * IServ zeigt, was auf der Seite steht; ein Datumsparameter ist nirgends dokumentiert. Fuer alle
 * anderen Wochen bleibt deshalb der selbst gebaute Plan stehen - genau dafuer ist er da.
 */
async function iservAbgleich(userId, schule, K = null) {
  const konto = db.prepare('SELECT * FROM untis_accounts WHERE user_id = ?').get(userId);
  if (!konto) throw new Error('Kein IServ-Zugang hinterlegt');
  if (!schule.server) throw new Error('Für diese Schule ist keine IServ-Adresse hinterlegt');

  const sitzung = await iservAnmelden(schule.server, konto.username, zugangsPasswort(konto, K));
  // Dieselbe Woche, die der Plan zeigt: am Wochenende ist das schon die kommende. Steht in der
  // Tabelle ein Datum, gewinnt das - dann wissen wir, welche Woche IServ wirklich meint.
  const { pfad, montag, stunden, raster: zeiten, versucht } =
    await iservPlan(sitzung, weekStart(), kursPraefix(schule), schule.iserv_pfad);
  await iservAbmelden(sitzung);

  if (!pfad) {
    const wo = versucht.map(v => `${v.pfad} → ${v.status}`).join(', ');
    throw new Error(`Angemeldet, aber der Stundenplan war nicht zu finden (${wo}). `
      + 'Im Profil zeigt „Was kommt von IServ zurück?", was wirklich ankommt.');
  }
  // Was einmal geklappt hat, wird gemerkt - der naechste Abgleich geht direkt dorthin.
  if (pfad !== schule.iserv_pfad)
    db.prepare('UPDATE schools SET iserv_pfad = ? WHERE id = ?').run(pfad, schule.id);

  // Das Raster steht in der ersten Spalte der Tabelle - damit regeln sich die Zeiten auch hier
  // von selbst.
  const perioden = periodsFuer(schule.id).length
    ? periodsFuer(schule.id) : rasterAnlegen(schule, zeiten);

  const von = montag, bis = addDays(montag, 6);
  const { uebernommen, ohneRaster } = stundenSchreiben({
    userId, schule, perioden, stunden, von, bis, vollstaendig: false });

  db.prepare(`UPDATE untis_accounts SET last_sync = datetime('now'), last_voll = datetime('now'),
      last_error = NULL, last_error_at = NULL, text_stat = NULL, von = ?, bis = ?
      WHERE user_id = ?`).run(von, bis, userId);
  return { uebernommen, ohneRaster, von, bis };
}

export async function untisAbgleich(userId, fenster = null, K = null) {
  const schule = schuleVon(userId);
  // Zwei Quellen, ein Weg: welche gilt, sagt die Schule des Nutzers.
  if (schule.quelle === 'iserv') return iservAbgleich(userId, schule, K);

  if (!untisAn(userId)) throw new Error('WebUntis ist nicht eingerichtet');
  const konto = db.prepare('SELECT * FROM untis_accounts WHERE user_id = ?').get(userId);
  if (!konto) throw new Error('Kein WebUntis-Zugang hinterlegt');

  const praefix = kursPraefix(schule);
  // Der Lehrstoff je Stunde kostet einen Aufruf je Stunde - deshalb hoechstens stuendlich, und
  // auf Knopfdruck ("Jetzt abgleichen", ohne Fenster) immer.
  const mitLehrstoff = !fenster || !db.prepare(`SELECT 1 FROM untis_accounts
    WHERE user_id = ? AND lehrstoff_geholt > datetime('now', '-60 minutes')`).get(userId);
  const sitzung = await untisAnmelden(schule.server, schule.school,
    konto.username, entschluesseln(konto.secret), konto.auth_typ);
  db.prepare('UPDATE untis_accounts SET person_id = ?, person_type = ? WHERE user_id = ?')
    .run(sitzung.personId ?? null, sitzung.personType ?? null, userId);

  const heute = new Date().toISOString().slice(0, 10);
  // Auf ganze Wochen einrasten: sonst liegt die Grenze mitten in einer Woche, und die Anzeige
  // waere dort halb WebUntis, halb selbst gebaut.
  const von = weekStart(fenster?.von ?? addDays(weekStart(heute), -SYNC_ZURUECK));
  const bis = addDays(weekStart(fenster?.bis ?? addDays(weekStart(heute), SYNC_VORAUS)), 6);
  const roh = await stundenplan(sitzung, von, bis, { lehrstoff: mitLehrstoff });
  if (roh.lehrstoffGeholt)
    db.prepare("UPDATE untis_accounts SET lehrstoff_geholt = datetime('now') WHERE user_id = ?").run(userId);
  // Ferien sind schulweit - einer holt sie, alle haben sie. Scheitert es, ist das kein Grund,
  // den ganzen Abgleich fallen zu lassen.
  const feien = await ferien(sitzung).catch(() => null);
  // Von Lehrern eingetragene Hausaufgaben. Scheitert der Abruf, laeuft der Rest weiter - eine
  // unbekannte Antwortform der Schule darf nicht den ganzen Stundenplan verhindern.
  const untisHa = await hausaufgaben(sitzung, von, bis).catch(() => null);
  // Pruefungen kommen seit 3.1.0 nur noch auf Knopfdruck (POST /api/untis/pruefungen/import) -
  // als eigene, aenderbare Eintraege. Vorher legte jeder Abgleich sie neu an, mit neuer ID, und die
  // Erinnerung "Pruefung in X Tagen", die an der ID haengt, kam immer wieder.
  // Die Nachrichten der Schule sind schulweit und aendern sich selten: hoechstens stuendlich,
  // und wer gerade dran ist, holt sie fuer alle. Scheitert es, laeuft der Rest.
  await nachrichtenHolen(schule, sitzung).catch(err => console.error('Nachrichten:', err.message));
  await logout(sitzung);

  if (untisHa) {
    // Fuer den geholten Zeitraum ersetzen statt zusammenfuehren: was die Schule geloescht hat,
    // soll auch bei uns verschwinden.
    db.prepare('DELETE FROM untis_homework WHERE user_id = ? AND due_date BETWEEN ? AND ?')
      .run(userId, von, bis);
    const setz = db.prepare(`INSERT INTO untis_homework(user_id, untis_id, course_id, date, due_date, text, remark)
      VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, untis_id) DO UPDATE SET
        course_id = excluded.course_id, due_date = excluded.due_date,
        text = excluded.text, remark = excluded.remark`);
    for (const h of untisHa) {
      // lessonId entspricht der lsnumber - darueber haengt die Aufgabe an unserem Kurs. Passt
      // nichts, bleibt der Kurs leer und die Aufgabe wird trotzdem angezeigt.
      const kurs = h.lesson_id
        && db.prepare('SELECT id FROM courses WHERE id = ?').get(`${praefix}UNTIS-${h.lesson_id}`)?.id;
      setz.run(userId, h.untis_id, kurs ?? null, h.date, h.due_date, h.text, h.remark);
    }
    hausaufgabenAufraeumen(userId);
  }

  if (feien?.length) {
    const setz = db.prepare(`INSERT INTO holidays(school_id, von, bis, name) VALUES(?, ?, ?, ?)
      ON CONFLICT(school_id, von, bis) DO UPDATE SET name = excluded.name`);
    for (const f of feien) setz.run(schule.id, f.von, f.bis, f.name);
  }

  // Eine Schule ohne eigenes Raster bekommt es hier von WebUntis.
  const perioden = periodsFuer(schule.id).length
    ? periodsFuer(schule.id)
    : rasterAnlegen(schule, await raster(sitzung).catch(() => []));
  const stunden = aufbereiten(roh, praefix);
  const { uebernommen, ohneRaster } = stundenSchreiben({
    userId, schule, perioden, stunden, von, bis, vollstaendig: !fenster });

  // Zaehlen, was an Texten wirklich ankam. Ohne das bleibt "der Lehrstoff fehlt" eine Vermutung -
  // mit dem Zaehler steht im Profil, ob die Schule das Feld ueberhaupt herausgibt.
  // 'gefunden' zaehlt die Eintraege mit Text, 'lehrstoff' die Stunden, die einen abbekommen haben.
  // Klafft das auseinander, liegt es an der Zuordnung - das sieht man dann, statt es zu raten.
  const textStat = JSON.stringify({
    lehrstoff: roh.filter(p => p?.lehrstoff).length,
    lehrstoff_gefunden: roh.lehrstoffGefunden ?? null,
    unterrichtstext: roh.filter(p => p?.lstext).length,
    notizen: roh.filter(p => p?.bkText).length,
    info: roh.filter(p => p?.info || p?.substText).length,
    stunden: roh.length,
  });

  db.prepare(`UPDATE untis_accounts SET last_sync = datetime('now'), last_error = NULL,
      last_voll = CASE WHEN ? THEN datetime('now') ELSE last_voll END, last_error_at = NULL,
      text_stat = ?,
      -- Beim vollen Abgleich wird der Bereich neu gesetzt statt erweitert: er beschreibt jetzt
      -- genau das, was auch wirklich in der Datenbank steht. Vorher wuchs er nur und behauptete
      -- danach, der Februar sei abgedeckt - obwohl dort nur ein alter Stand lag.
      von = CASE WHEN ? THEN ? ELSE min(coalesce(von, ?), ?) END,
      bis = CASE WHEN ? THEN ? ELSE max(coalesce(bis, ?), ?) END
      WHERE user_id = ?`)
    .run(fenster ? 0 : 1, textStat,
      fenster ? 0 : 1, von, von, von,
      fenster ? 0 : 1, bis, bis, bis, userId);

  // Hat WebUntis eine Kursnummer geaendert, steht das Fach jetzt doppelt im Plan: einmal alt (nur
  // in der Vergangenheit) und einmal neu. Wo der Nachfolger eindeutig ist - gleiches Fach, gleicher
  // Lehrer, dieselbe Stunde - wandert alles von selbst hinueber. Farbe, Kuerzel und Hausaufgaben
  // bleiben so erhalten, statt still zu verschwinden. Alles Uneindeutige bleibt fuer die Karte im
  // Profil liegen.
  let zusammengefuehrt = 0;
  for (const k of kursVorschlaege(userId)) {
    if (!k.eindeutig) continue;
    kurseZusammenfuehren(userId, k.id, k.eindeutig);
    zusammengefuehrt++;
  }
  return { uebernommen, ohneRaster, von, bis, zusammengefuehrt,
    ohneKursnummer: stunden.some(s => !s.course_id.match(/^UNTIS-\d+$/)) };
}

// Welche von mehreren Stunden eines Slots der Plan zeigt: Pruefung > findet statt > faellt aus.
const rang = s => (s.pruefung ? 2 : s.status === 'cancelled' ? 0 : 1);

/**
 * Der Stand einer Stunde beim letzten Abgleich: derselbe Kurs im selben Slot.
 *
 * undefined heisst "neu im Slot" (ein Ausfall wird dann gemeldet), null heisst "unbekannt": eine
 * Zeile von vor 3.0.2 kannte nur die EINE angezeigte Stunde. Dann wird nichts gemeldet, nur
 * gemerkt - sonst kaeme nach dem Update jeder laengst bekannte Ausfall paralleler Kurse noch einmal.
 */
function vorstand(zeile, kurs, anzahl) {
  if (!zeile) return undefined;
  if (zeile.stand) {
    const alt = (zeile.alt ??= JSON.parse(zeile.stand));
    if (alt[kurs]) return { ...alt[kurs], course_id: kurs };
    const ids = Object.keys(alt);
    // Eine Stunde war da, eine ist da, nur der Kurs ist ein anderer: das ist "Anderer Kurs".
    return ids.length === 1 && anzahl === 1 ? { ...alt[ids[0]], course_id: ids[0] } : undefined;
  }
  return anzahl === 1 || zeile.course_id?.toLowerCase() === kurs.toLowerCase() ? zeile : null;
}

/**
 * Was hat sich an einer Stunde geaendert, deren Status gleich geblieben ist? Gibt den Text fuer
 * die Meldung zurueck oder null.
 *
 * Ohne Vorzustand wird NICHTS gemeldet: beim ersten Abgleich ist jede Stunde neu, und eine
 * Meldung fuer jede waere Laerm statt Nachricht. Frueher wurde ueberhaupt nur der Status
 * verglichen, eine reine Raumaenderung war damit unsichtbar.
 */
export function stundenAenderung(alt, neu) {
  if (!alt || alt.status !== neu.status) return null;
  if ((alt.room ?? null) !== (neu.room ?? null))
    return `Raum: ${alt.room ?? '–'} → ${neu.room ?? '–'}`;
  // Der Lehrer gehoert hierher, sonst bleibt der wichtigste Fall stumm: eine Vertretung, bei der
  // aus "Frau Ersatz" ein "niemand" wird. Der Status bleibt dabei 'irregular' - die Statusmeldung
  // greift also nicht, und ohne diesen Vergleich erfaehrt es keiner.
  if ((alt.teacher ?? null) !== (neu.teacher ?? null))
    return `Lehrer: ${alt.teacher ?? 'niemand'} → ${neu.teacher ?? 'niemand'}`;
  if (alt.course_id !== neu.course_id) return 'Anderer Kurs';
  if ((alt.info ?? '') !== (neu.info ?? '') && neu.info) return neu.info;
  return null;
}

/**
 * Wer aus dem Freundeskreis in dieser Stunde ebenfalls frei hat - als Satzende fuer die Meldung.
 *
 * Nur dieselbe Schule, nur wer an dem Tag ueberhaupt Unterricht hat (sonst ist er nicht "auch
 * frei", sondern woanders) und nicht, wer abgemeldet ist: krank ist nicht frei.
 */
export function auchFrei(userId, datum, periodId, schule) {
  const wochentag = new Date(datum + 'T00:00:00Z').getUTCDay() || 7;
  const tag = db.prepare('SELECT * FROM days WHERE iso = ?').get(wochentag);
  if (!tag || !periodId) return '';
  const days = [{ ...tag, date: datum }];
  const perioden = periodsFuer(schule.id);
  const namen = [];
  for (const fid of friendIds(userId)) {
    if (namen.length >= 5) break;
    if (schuleVon(fid).id !== schule.id) continue;
    // Wer nur in dieser Stunde abgemeldet ist, hat nicht frei - wer spaeter weg ist, schon.
    const ab = db.prepare('SELECT von_stunde, bis_stunde FROM absences WHERE user_id = ? AND date = ?')
      .get(fid, datum);
    const nr = perioden.find(x => x.id === periodId)?.nr;
    if (ab && (!ab.von_stunde
      || (nr !== undefined && nr >= ab.von_stunde && nr <= (ab.bis_stunde ?? ab.von_stunde)))) continue;
    const plan = planFuer(fid, perioden, days);
    if (!plan.some(e => !freiGrund(e))) continue;
    if (!freiGrund(plan.find(e => e.period_id === periodId))) continue;
    namen.push(nameVon(db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(fid)));
  }
  if (!namen.length) return '';
  const wer = namen.length === 1 ? namen[0]
    : `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
  return ` · ${wer} ${namen.length === 1 ? 'hat' : 'haben'} dann auch frei.`;
}

const merkeFehler = (userId, err) =>
  db.prepare("UPDATE untis_accounts SET last_error = ?, last_error_at = datetime('now') WHERE user_id = ?")
    .run(String(err.message).slice(0, 300), userId);

app.put('/api/untis/account', auth, bremse('untislogin', 10), async (req, res) => {
  if (!untisKey()) return res.status(400).json({ error: untisStatus().hinweis });
  const username = String(req.body?.username ?? '').trim();
  const schluessel = String(req.body?.secret ?? '').trim();
  const typ = schluessel ? 'secret' : 'password';
  const geheim = schluessel || String(req.body?.password ?? '');
  if (!username || !geheim)
    return res.status(400).json({ error: 'Benutzername und Schlüssel oder Passwort nötig' });

  // Ohne Schulwahl im Formular bleibt es bei der eigenen Schule; mit Schulwahl meldet man sich bei
  // einer anderen an. Gespeichert wird erst nach erfolgreicher Anmeldung, damit ein Vertipper
  // niemanden auf eine falsche Schule stellt.
  const meine = schuleVon(req.user.id);
  const gewaehlt = ohneSchema(req.body?.server) && String(req.body?.school ?? '').trim();
  const server = gewaehlt ? ohneSchema(req.body.server) : meine.server;
  const school = gewaehlt ? String(req.body.school).trim() : meine.school;
  if (!server || !school) return res.status(400).json({ error: 'Bitte zuerst die Schule auswählen' });
  // Sonst koennte der erste Beliebige die App auf einen fremden Server zeigen lassen und die
  // Schulpasswoerter aller anderen einsammeln - der Wert gilt ab hier fuer die ganze Instanz.
  if (!untisHostOk(server))
    return res.status(400).json({ error: 'Diese Schule stammt nicht aus der Schulsuche' });
  // Mit eigener Verschluesselung braucht das Speichern K - den hat nur eine frisch angemeldete Sitzung.
  const K = sitzungsSchluessel(req);
  if (req.user.zugang_eigen && !K) return res.status(409).json({ error: new OhneSchluessel().message });

  // Erst anmelden, dann speichern - sonst liegt ein unbrauchbares Passwort in der Datenbank.
  try {
    const sitzung = await untisAnmelden(server, school, username, geheim, typ);
    await logout(sitzung);
    const schule = schuleSichern(server, school, req.body?.name);
    if (schule.id !== meine.id) {
      // Schulwechsel: die abgeglichenen Stunden zeigen auf die alte Schule und waeren danach
      // Muell. Selbst gebaute Eintraege bleiben stehen - sie sind im fremden Raster unsichtbar
      // und beim Zurueckwechseln wieder da.
      db.prepare('DELETE FROM untis_lessons WHERE user_id = ?').run(req.user.id);
      db.prepare('UPDATE users SET school_id = ? WHERE id = ?').run(schule.id, req.user.id);
    }
    db.prepare(`INSERT INTO untis_accounts(user_id, username, secret, auth_typ, person_id, person_type)
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, secret = excluded.secret,
                  auth_typ = excluded.auth_typ, person_id = excluded.person_id,
                  person_type = excluded.person_type, last_error = NULL`)
      .run(req.user.id, username, zugangVerschluesseln(req.user, K, geheim), typ,
        sitzung.personId ?? null, sitzung.personType ?? null);
  } catch (err) {
    return res.status(400).json({ error: 'Anmeldung bei WebUntis fehlgeschlagen: ' + kurzerFehler(err) });
  }

  try {
    res.json({ ok: true, ...(await untisAbgleich(req.user.id, null, K)) });
  } catch (err) {
    merkeFehler(req.user.id, err);
    res.status(502).json({ error: 'Zugang gespeichert, aber der Abgleich schlug fehl: ' + err.message });
  }
});

/**
 * Mit IServ verbinden.
 *
 * Dieselbe Form wie bei WebUntis, nur mit der Adresse der Schule statt einer Schulsuche - die gibt
 * es bei IServ nicht. Die Schule wird dabei zu einer EIGENEN Zeile: Raster, Kurse und Ferien
 * passen zwischen IServ und WebUntis nicht zusammen.
 */
app.put('/api/iserv/account', auth, bremse('untislogin', 10), async (req, res) => {
  if (!untisKey()) return res.status(400).json({ error: untisStatus().hinweis });
  const username = String(req.body?.username ?? '').trim();
  const passwort = String(req.body?.password ?? '');
  const meine = schuleVon(req.user.id);
  const server = iservOhneSchema(req.body?.server)
    || (meine.quelle === 'iserv' ? meine.server : '');
  if (!username || !passwort)
    return res.status(400).json({ error: 'Benutzername und Passwort nötig' });
  if (!server)
    return res.status(400).json({ error: 'Bitte die Adresse eurer IServ-Schule eintragen' });
  if (!iservHostOk(server))
    return res.status(400).json({ error: 'Das sieht nicht nach der Adresse einer Schule aus' });
  // Mit eigener Verschluesselung braucht das Speichern K - den hat nur eine frisch angemeldete Sitzung.
  const K = sitzungsSchluessel(req);
  if (req.user.zugang_eigen && !K) return res.status(409).json({ error: new OhneSchluessel().message });

  // Erst anmelden, dann speichern - sonst liegt ein unbrauchbares Passwort in der Datenbank.
  try {
    const sitzung = await iservAnmelden(server, username, passwort);
    await iservAbmelden(sitzung);
    const schule = schuleSichern(server, '', req.body?.name, 'iserv');
    if (schule.id !== meine.id) {
      // Schulwechsel: die abgeglichenen Stunden zeigen auf die alte Schule.
      db.prepare('DELETE FROM untis_lessons WHERE user_id = ?').run(req.user.id);
      db.prepare('UPDATE users SET school_id = ? WHERE id = ?').run(schule.id, req.user.id);
    }
    db.prepare(`INSERT INTO untis_accounts(user_id, username, secret, auth_typ)
                VALUES(?, ?, ?, 'password')
                ON CONFLICT(user_id) DO UPDATE SET username = excluded.username,
                  secret = excluded.secret, auth_typ = 'password',
                  person_id = NULL, person_type = NULL, last_error = NULL`)
      .run(req.user.id, username, zugangVerschluesseln(req.user, K, passwort));
  } catch (err) {
    return res.status(400).json({
      error: (err instanceof IservFehler ? err.message : 'Anmeldung bei IServ fehlgeschlagen')
        + ' — „Verbindung testen" zeigt, an welcher Stelle es hakt.',
    });
  }

  try {
    res.json({ ok: true, ...(await untisAbgleich(req.user.id, null, K)) });
  } catch (err) {
    merkeFehler(req.user.id, err);
    res.status(502).json({ error: 'Zugang gespeichert, aber der Abgleich schlug fehl: ' + err.message });
  }
});

/**
 * Die Verbindung testen, ohne etwas zu speichern.
 *
 * Scheitert die Anmeldung, gab es bisher nichts als "fehlgeschlagen" - die Diagnose war erst nach
 * einer geglueckten Anmeldung erreichbar, also genau dann nicht, wenn man sie braucht. Hier faellt
 * der Bericht immer an: welcher Weg welchen Status hatte, ob ein Formular gefunden wurde und wie
 * seine Felder heissen.
 *
 * Auch der Fehlerfall antwortet mit 200: der Bericht IST das Ergebnis. Das Passwort steht in
 * keiner Antwort - der Bericht kennt nur Pfade, Status und Feldnamen.
 */
app.post('/api/iserv/test', auth, bremse('untislogin', 10), async (req, res) => {
  const server = iservOhneSchema(req.body?.server);
  const username = String(req.body?.username ?? '').trim();
  const passwort = String(req.body?.password ?? '');
  if (!server || !username || !passwort)
    return res.status(400).json({ error: 'Adresse, Benutzername und Passwort nötig' });

  try {
    const sitzung = await iservAnmelden(server, username, passwort);
    const { pfad, stunden, versucht } = await iservPlan(sitzung, weekStart(), '');
    await iservAbmelden(sitzung);
    res.json({ ok: true, bericht: sitzung.bericht, pfad, gefunden: stunden.length, versucht });
  } catch (err) {
    res.json({ ok: false, fehler: err.message, bericht: err.bericht ?? null });
  }
});

/**
 * Was kommt von IServ eigentlich zurueck?
 *
 * Weil die Plan-Seite von Schule zu Schule anders aussieht, ist ein leerer Plan sonst nicht von
 * einer falschen Adresse zu unterscheiden. Gezeigt wird nur die eigene Seite des eigenen Kontos.
 */
app.get('/api/iserv/diagnose', auth, bremse('untislogin', 10), async (req, res) => {
  const schule = schuleVon(req.user.id);
  const konto = db.prepare('SELECT * FROM untis_accounts WHERE user_id = ?').get(req.user.id);
  if (schule.quelle !== 'iserv' || !konto)
    return res.status(400).json({ error: 'Für dich ist kein IServ-Zugang eingerichtet' });

  try {
    const sitzung = await iservAnmelden(schule.server, konto.username, zugangsPasswort(konto, sitzungsSchluessel(req)));
    const { pfad, stunden, versucht } =
      await iservPlan(sitzung, weekStart(), kursPraefix(schule), schule.iserv_pfad);
    await iservAbmelden(sitzung);
    res.json({ server: schule.server, angemeldet: true, pfad, gefunden: stunden.length,
      versucht, beispiel: stunden.slice(0, 5) });
  } catch (err) {
    res.status(502).json({ error: err.message, server: schule.server, angemeldet: false });
  }
});

app.post('/api/untis/sync', auth, bremse('untissync', 5), async (req, res) => {
  try {
    res.json(await untisAbgleich(req.user.id, null, sitzungsSchluessel(req)));
  } catch (err) {
    // Fehlt nur der Schluessel dieser Sitzung, ist der Zugang nicht kaputt - nicht als Fehler merken.
    if (err instanceof OhneSchluessel) return res.status(409).json({ error: err.message });
    merkeFehler(req.user.id, err);
    res.status(502).json({ error: err.message });
  }
});

app.delete('/api/untis/account', auth, (req, res) => {
  db.prepare('DELETE FROM untis_lessons WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM untis_accounts WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Im Hintergrund nachziehen. Bewusst nicht abgewartet - die Antwort des Stundenplans darf nicht
// an WebUntis hängen.
//
// Zwei Takte, weil sich Nahes und Fernes verschieden schnell ändert: Vertretungen und Ausfälle
// betreffen die nächsten Tage und sollen zeitnah da sein, der Plan in vier Monaten praktisch nie.
// Alle zehn Minuten den ganzen Halbjahresplan zu holen wäre nur unhöflich gegenüber dem
// Schulserver - und langsam.
const SYNC_KURZ_MIN = 10;        // laufende Woche ± 2, das ist der Bereich, der sich ändert
const SYNC_VOLL_STUNDEN = 6;     // der ganze Zeitraum
const laufend = new Set();

const zuLange = (wann, ausdruck) => !wann
  || !!db.prepare("SELECT ? < datetime('now', ?) AS ja").get(wann, ausdruck).ja;

/**
 * Stösst an, wenn nötig; gibt zurück, ob gerade etwas läuft - die Oberfläche lädt dann in ein
 * paar Sekunden noch einmal nach.
 */
function vielleichtAbgleichen(userId, woche = null, K = null) {
  if (!untisAn(userId)) return false;
  if (laufend.has(userId)) return true;
  const konto = db.prepare('SELECT last_sync, last_voll, von, bis, secret FROM untis_accounts WHERE user_id = ?')
    .get(userId);
  if (!konto) return false;
  // Mit dem eigenen Passwort verschluesselt und diese Sitzung hat K nicht: nichts anfangen.
  if (String(konto.secret ?? '').startsWith('u1:') && !K) return false;

  const heute = new Date().toISOString().slice(0, 10);
  const voll = zuLange(konto.last_voll, `-${SYNC_VOLL_STUNDEN} hours`);
  const kurz = zuLange(konto.last_sync, `-${SYNC_KURZ_MIN} minutes`);
  // Die gefragte Woche liegt ausserhalb dessen, wofür wir Daten haben - dann wird genau dort
  // nachgeholt, statt den Nutzer auf den nächsten vollen Abgleich warten zu lassen.
  // IServ liefert nur die laufende Woche - "ausserhalb" waere dort immer wahr, und jedes
  // Blaettern loeste einen Abruf beim Schulserver aus.
  const nurWoche = schuleVon(userId).quelle === 'iserv';
  const ausserhalb = !nurWoche && woche
    && (!konto.von || !konto.bis || woche < konto.von || woche > konto.bis);
  if (!voll && !kurz && !ausserhalb) return false;

  const fenster = voll ? null
    : ausserhalb ? { von: addDays(woche, -7), bis: addDays(woche, 21) }
      : { von: addDays(weekStart(heute), -7), bis: addDays(weekStart(heute), 14) };

  laufend.add(userId);
  untisAbgleich(userId, fenster, K).catch(err => merkeFehler(userId, err)).finally(() => laufend.delete(userId));
  return true;
}

// Auch ohne dass jemand die App offen hat: sonst käme die Meldung über eine ausgefallene Stunde
// erst, wenn man ohnehin schon nachsieht. Nacheinander statt alle auf einmal - dreissig
// gleichzeitige Anmeldungen sind für den Schulserver ein Lastspitze ohne Not.
const SWEEP_MS = SYNC_KURZ_MIN * 60_000;
async function reihumAbgleichen() {
  // Laeuft unabhaengig von WebUntis - ToDos hat auch, wer die Anbindung nicht nutzt.
  try { todoErinnerungen(); } catch (err) { console.error('ToDo-Erinnerungen:', err); }
  try { pruefungsErinnerungen(); } catch (err) { console.error('Prüfungs-Erinnerungen:', err); }
  try { hausaufgabenAufraeumen(); } catch (err) { console.error('Hausaufgaben aufräumen:', err); }
  try { todosAufraeumen(); } catch (err) { console.error('ToDos aufräumen:', err); }
  try { restAufraeumen(); } catch (err) { console.error('Aufräumen:', err); }
  // Abonnierte Kalender: hoechstens stuendlich je Kalender, und Fehler bleiben an der Zeile.
  try { await aboTakt(); } catch (err) { console.error('Kalender-Abos:', err); }
  // Antworten auf Tickets: sonst erfuehre man davon erst, wenn man ohnehin nachsieht.
  try { await ticketsAuffrischen(); } catch (err) { console.error('Tickets:', err.message); }
  // Nicht mehr global: die Standardschule kann leer sein, waehrend jemand mit seiner eigenen
  // Schule angemeldet ist. Ob es fuer den Einzelnen passt, prueft untisAbgleich selbst.
  if (!untisKey()) return;
  // Konten, deren letzter Versuch scheiterte, werden nur stuendlich noch einmal probiert. Sonst
  // liefe ein falsches Passwort alle zehn Minuten in einen Fehlversuch - und WebUntis sperrt
  // Konten nach einigen davon. Der Nutzer sieht den Fehler ohnehin in seinem Profil.
  // Mit dem eigenen Passwort verschluesselte Zugaenge ('u1:') kann der Server ohne den Nutzer nicht
  // oeffnen - genau das ist ihr Sinn. Sie gleichen ab, wenn der Nutzer die App benutzt.
  const konten = db.prepare(`SELECT user_id FROM untis_accounts
    WHERE secret NOT LIKE 'u1:%' AND (last_sync IS NULL OR last_sync < datetime('now', ?))
      AND (last_error_at IS NULL OR last_error_at < datetime('now', '-1 hour'))`)
    .all(`-${SYNC_KURZ_MIN} minutes`);
  for (const { user_id } of konten) {
    if (laufend.has(user_id)) continue;
    laufend.add(user_id);
    try { await untisAbgleich(user_id, naheWoche()); }
    catch (err) { merkeFehler(user_id, err); }
    finally { laufend.delete(user_id); }
  }
}

/**
 * Liegengebliebenes: Anhaenge, die nie abgeschickt wurden (die leere Platzhalter-Nachricht samt
 * Datei, bis 8 MB), und zugestellte Meldungen nach 30 Tagen. Beides wuchs sonst ewig.
 */
export function restAufraeumen() {
  db.prepare("DELETE FROM messages WHERE text = '' AND created_at < datetime('now', '-1 hour')").run();
  db.prepare("DELETE FROM notifications WHERE delivered_at IS NOT NULL AND created_at < datetime('now', '-30 days')").run();
}

const naheWoche = () => {
  const heute = new Date().toISOString().slice(0, 10);
  return { von: addDays(weekStart(heute), -7), bis: addDays(weekStart(heute), 14) };
};

// unref: ein Timer soll den Prozess nicht am Leben halten, wenn er sich sonst beenden würde.
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    reihumAbgleichen().catch(() => {});
    try { faelligeMeldungen(); } catch (err) { console.error('Meldungen:', err.message); }
  }, SWEEP_MS).unref();
}

// --- Benachrichtigungen ------------------------------------------------------
// Der Push selbst trägt keinen Inhalt (siehe push.js). Hier steht, was gemeldet wird und wer es
// bekommt; abgeholt wird es vom Service Worker über /api/notifications/pending.

app.get('/api/push/key', auth, (req, res) => res.json({ key: pushKey() }));

app.post('/api/push/subscribe', auth, (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '');
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 500)
    return res.status(400).json({ error: 'Kein gültiger Push-Endpunkt' });
  db.prepare(`INSERT INTO push_subscriptions(endpoint, user_id, created_at)
              VALUES(?, ?, datetime('now'))
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`)
    .run(endpoint, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', auth, (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '');
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND (endpoint = ? OR ? = "")')
    .run(req.user.id, endpoint, endpoint);
  res.json({ ok: true });
});

// Holt der Service Worker beim push-Ereignis - mit Cookie, deshalb sieht er nur die eigenen.
app.get('/api/notifications/pending', auth, (req, res) => {
  const offen = db.prepare(`SELECT id, kind, title, body, url FROM notifications
    WHERE user_id = ? AND delivered_at IS NULL AND faellig_at IS NULL ORDER BY id`).all(req.user.id);
  if (offen.length) db.prepare(`UPDATE notifications SET delivered_at = datetime('now')
    WHERE user_id = ? AND delivered_at IS NULL AND faellig_at IS NULL`).run(req.user.id);
  res.json(offen);
});

// --- Benachrichtigungen nach Plan -------------------------------------------
// Je Art entscheidet der Nutzer, WANN er etwas erfaehrt:
//
//   sofort     - im Moment des Entstehens (so war es immer)
//   vorlauf    - eine einstellbare Zeit VOR dem Ereignis ("30 Minuten vor Stundenbeginn")
//   gesammelt  - alles zusammen zu einer festen Uhrzeit, mit Vorschau auf den naechsten Schultag
//   aus        - gar nicht
//
// Umgesetzt ueber `notifications.faellig_at`: was nicht sofort hinausgeht, wartet dort, bis der
// Zehn-Minuten-Takt es faellig findet. Die Tabelle war ohnehin schon die Warteschlange fuer den
// Service Worker - sie wird jetzt auch zum Kalender.

const PUSH_ARTEN = ['chat', 'ausfall', 'vertretung', 'aenderung', 'freunde', 'todo', 'hausaufgaben', 'ticket', 'pruefung', 'buero', 'kurschat'];
// Nur wo es einen Zeitpunkt gibt, ergibt ein Vorlauf Sinn.
const MIT_VORLAUF = new Set(['ausfall', 'vertretung', 'aenderung', 'hausaufgaben']);
const ALT_SCHALTER = { chat: 'push_chat', ausfall: 'push_ausfall', vertretung: 'push_vertretung',
  freunde: 'push_freunde', todo: 'push_todo', aenderung: 'push_aenderung' };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Der Plan eines Nutzers, mit Rueckfall auf die alten Ein/Aus-Schalter.
 *
 * Ohne den Rueckfall waere nach dem Update jede bisherige Einstellung verloren - und wer
 * Chat-Meldungen abgeschaltet hatte, bekaeme sie wieder.
 */
// Mehr als vier Regeln je Art baut sich niemand mit Absicht - danach ist es keine Einstellung
// mehr, sondern ein Trommelfeuer.
const MAX_REGELN = 4;

/** Eine einzelne Regel pruefen und in Form bringen. */
function pushRegel(e, art, vorgabe) {
  let modus = ['sofort', 'gesammelt', 'vorlauf', 'aus'].includes(e?.modus) ? e.modus : vorgabe;
  // 'meldung' braucht keinen Zeitpunkt im Stundenplan - es zaehlt ab dem Moment, in dem die
  // Meldung entsteht. Deshalb geht dieser Bezug auch bei Chat und Freundschaftsanfragen.
  const bezug = ['stunde', 'schultag', 'meldung'].includes(e?.bezug) ? e.bezug : 'stunde';
  if (modus === 'vorlauf' && !MIT_VORLAUF.has(art) && bezug !== 'meldung') modus = 'sofort';
  return {
    modus,
    zeit: HHMM.test(e?.zeit ?? '') ? e.zeit : '',
    // Bis zu einer Woche - mehr ist keine Erinnerung mehr, sondern ein Kalender.
    vorlauf_min: Math.min(Math.max(Number(e?.vorlauf_min) || 0, 0), 7 * 24 * 60),
    bezug,
  };
}

export function pushPlan(u) {
  let roh = {};
  try { roh = JSON.parse(u?.push_plan ?? '{}') ?? {}; } catch { roh = {}; }
  const plan = {};
  for (const art of PUSH_ARTEN) {
    const altAn = ALT_SCHALTER[art] ? u?.[ALT_SCHALTER[art]] !== 0 : true;
    // Jeder Kurs hat einen Chat - einzeln gemeldet waere das ein Trommelfeuer. Deshalb gesammelt.
    const vorgabe = art === 'kurschat' ? 'gesammelt' : altAn ? 'sofort' : 'aus';
    // Je Art mehrere Regeln nebeneinander: "bei Ausfall sofort UND nochmal 30 Minuten vor der
    // Stunde". Ein einzelnes Objekt bleibt gueltig - so, wie es bisher gespeichert wurde.
    const liste = Array.isArray(roh[art]) ? roh[art] : roh[art] ? [roh[art]] : [];
    plan[art] = liste.length
      ? liste.slice(0, MAX_REGELN).map(e => pushRegel(e, art, vorgabe))
      : [pushRegel({}, art, vorgabe)];
  }
  return plan;
}

const digestZeit = u => (HHMM.test(u?.digest_zeit ?? '') ? u.digest_zeit : '19:00');

/** Ein Datum kurz und lesbar: "Di, 08.09.". */
const tagKurz = iso => new Date(iso + 'T00:00:00Z')
  .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });

/** Wann der Schultag beginnt: die erste Stunde des Rasters DIESER Schule. */
const schulbeginn = (schoolId = standardSchule().id) =>
  db.prepare('SELECT start_time FROM periods WHERE school_id = ? ORDER BY nr LIMIT 1')
    .get(schoolId)?.start_time ?? '08:00';

/** Ortszeit als 'YYYY-MM-DD HH:MM' - dieselbe Schreibweise wie datetime('now','localtime'). */
function alsLokal(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} `
    + `${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** Der naechste Zeitpunkt mit dieser Uhrzeit - heute, wenn er noch kommt, sonst morgen. */
function naechsteUhrzeit(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return alsLokal(d);
}

/**
 * Wann soll diese Meldung hinausgehen? `null` heisst sofort, `false` heisst gar nicht.
 *
 * `wann` ist der Zeitpunkt des Ereignisses als 'YYYY-MM-DD HH:MM' (Stundenbeginn, Faelligkeit).
 * Fehlt er, kann es keinen Vorlauf geben - dann gilt der Eintrag als sofort.
 */
function faelligAm(p, u, wann) {
  if (p.modus === 'aus') return false;
  if (p.modus === 'sofort') return null;

  if (p.modus === 'vorlauf') {
    // Ab jetzt gerechnet: "eine Stunde nachdem die Meldung entsteht". Braucht keinen Stundenplan
    // und gilt deshalb fuer jede Art - auch fuer Chat, wenn man beim Lernen Ruhe haben will.
    if (p.bezug === 'meldung') {
      if (!p.vorlauf_min) return null;   // ohne Verzoegerung ist es einfach sofort
      const d = new Date();
      d.setMinutes(d.getMinutes() + p.vorlauf_min);
      return alsLokal(d);
    }
    if (!wann?.datum) return null;
    const tag = wann.datum;
    // "Vor Schulbeginn" heisst: vor der ersten Stunde des Rasters an diesem Tag. Wer lieber vor
    // der betroffenen Stunde erinnert werden will, waehlt den anderen Bezug.
    const beginn = schulbeginn(schuleVon(u.id).id);
    const zeit = p.bezug === 'schultag' ? beginn : (wann.zeit || beginn);
    const d = new Date(`${tag}T${zeit}:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setMinutes(d.getMinutes() - p.vorlauf_min);
    // Ein Vorlauf, der schon vorbei ist, wird nicht nachgeholt: eine Erinnerung an eine Stunde,
    // die laeuft, hilft niemandem mehr.
    return d <= new Date() ? null : alsLokal(d);
  }
  return naechsteUhrzeit(p.zeit || digestZeit(u));   // gesammelt
}

/**
 * Alle Zeitpunkte, zu denen diese Meldung hinausgehen soll - einer je Regel.
 *
 * Zwei Regeln, die auf denselben Zeitpunkt fallen ("sofort" und "0 Minuten vorher"), sind EINE
 * Meldung. Ohne das kaeme dieselbe Nachricht doppelt, und schuld waere eine Einstellung, die
 * voellig vernuenftig aussieht.
 */
function faelligeZeiten(u, kind, wann) {
  const raus = [];
  for (const p of pushPlan(u)[kind] ?? []) {
    const faellig = faelligAm(p, u, wann);
    if (faellig === false) continue;
    if (raus.some(r => r.faellig === faellig)) continue;
    raus.push({ faellig, gesammelt: faellig !== null && p.modus === 'gesammelt' ? 1 : 0 });
  }
  return raus;
}

// Anstupsen, ohne auf die Antwort eines Push-Dienstes irgendwo auf der Welt zu warten.
function stupseAlle(userId) {
  for (const { endpoint } of db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(userId)) {
    anstupsen(endpoint)
      .then(ok => {
        // false heisst: das Abo gibt es beim Dienst nicht mehr. null heisst nur "gerade nicht
        // erreichbar" - das waere ein schlechter Grund, jemandem die Benachrichtigungen zu nehmen.
        if (ok === false) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
      })
      .catch(() => {});
  }
}

/**
 * Eintragen und - je nach Plan - anstupsen.
 *
 * `wann` ist der Zeitpunkt, auf den sich die Meldung bezieht ('YYYY-MM-DD HH:MM'). Nur damit kann
 * ein Vorlauf ausgerechnet werden.
 */
function benachrichtige(userId, kind, title, body, url = '/', wann = null, ref = null) {
  // Ohne diese Zeile wird aus einem unbekannten `kind` ein stiller Unsinn statt eines Nichts.
  if (!PUSH_ARTEN.includes(kind)) return;
  const u = byId(userId);
  if (!u) return;

  const zeiten = faelligeZeiten(u, kind, wann);
  if (!zeiten.length) return;

  const ein = db.prepare(`INSERT INTO notifications(user_id, kind, title, body, url, created_at, faellig_at, gesammelt, ref)
              VALUES(?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`);
  for (const z of zeiten) ein.run(userId, kind, title, body ?? null, url, z.faellig, z.gesammelt, ref);

  // Was wartet, stupst spaeter der Takt an.
  if (zeiten.some(z => z.faellig === null)) stupseAlle(userId);
}

/**
 * Faellige Meldungen zustellen. Laeuft im selben Zehn-Minuten-Takt wie der WebUntis-Abgleich.
 *
 * Vorlauf-Meldungen gehen einzeln hinaus; Gesammeltes wird zu EINEM Anstupsen zusammengefasst -
 * fuenf Vibrationen hintereinander sind keine Sammlung.
 */
export function faelligeMeldungen(jetzt = alsLokal(new Date())) {
  const dran = db.prepare(`SELECT DISTINCT user_id FROM notifications
    WHERE delivered_at IS NULL AND faellig_at IS NOT NULL AND faellig_at <= ?`).all(jetzt);

  for (const { user_id } of dran) {
    const meine = db.prepare(`SELECT id, gesammelt FROM notifications
      WHERE user_id = ? AND delivered_at IS NULL AND faellig_at IS NOT NULL AND faellig_at <= ?`)
      .all(user_id, jetzt);
    // Sichtbar werden sie fuer den Service Worker, indem faellig_at wegfaellt - abgeholt wird
    // weiter ueber /api/notifications/pending, das nur auf delivered_at schaut.
    const frei = db.prepare('UPDATE notifications SET faellig_at = NULL WHERE id = ?');
    for (const m of meine) frei.run(m.id);

    // Der gesammelte Hinweis bekommt eine eigene Zeile mit der Vorschau auf den naechsten
    // Schultag - genau das, wofuer man abends aufs Handy schaut.
    if (meine.some(m => m.gesammelt)) {
      const n = meine.filter(m => m.gesammelt).length;
      const vorschau = tagesVorschau(user_id);
      db.prepare(`INSERT INTO notifications(user_id, kind, title, body, url, created_at)
                  VALUES(?, 'sammlung', ?, ?, '/', datetime('now'))`)
        .run(user_id, `${n} ${n === 1 ? 'Hinweis' : 'Hinweise'} für dich`, vorschau);
    }
    stupseAlle(user_id);
  }
  return dran.length;
}

/**
 * Was am naechsten Schultag ansteht: Hausaufgaben, Ausfaelle, Vertretungen.
 *
 * "Naechster Schultag" ist der naechste Tag, fuer den es ueberhaupt Stunden gibt - in den Ferien
 * und am Wochenende ist das nicht morgen.
 */
export function tagesVorschau(userId) {
  const heute = new Date().toISOString().slice(0, 10);
  const naechster = db.prepare(`SELECT date FROM untis_lessons
    WHERE user_id = ? AND date > ? AND course_id IS NOT NULL ORDER BY date LIMIT 1`)
    .get(userId, heute)?.date;
  if (!naechster) return null;

  const stunden = db.prepare(`SELECT u.status, COALESCE(s.name, u.course_id) AS fach, p.nr
    FROM untis_lessons u
    JOIN periods p ON p.id = u.period_id
    LEFT JOIN courses c ON c.id = u.course_id
    LEFT JOIN subjects s ON s.id = c.subject_id
    WHERE u.user_id = ? AND u.date = ? AND u.status <> 'regular'
      -- Selbst entfernt oder durch einen anderen Kurs ersetzt: gehoert nicht in die Vorschau.
      AND NOT EXISTS (SELECT 1 FROM entries e JOIN days d ON d.id = e.day_id
        WHERE e.user_id = u.user_id AND e.vorrang = 1 AND e.period_id = u.period_id
          AND d.iso = CAST(strftime('%u', u.date) AS INTEGER) AND e.course_id <> u.course_id COLLATE NOCASE)
    ORDER BY p.nr`)
    .all(userId, naechster);

  const hw = homeworkFuer(userId, meineKursIds(userId), naechster, naechster)
    .filter(h => !h.done).length;

  const tag = new Date(naechster + 'T00:00:00Z')
    .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const zeilen = [
    hw ? `${hw} ${hw === 1 ? 'Hausaufgabe' : 'Hausaufgaben'} fällig` : null,
    ...stunden.map(x => `${x.fach}: ${x.status === 'cancelled' ? 'fällt aus' : 'Vertretung'} (${x.nr}. Stunde)`),
  ].filter(Boolean);
  return zeilen.length ? `${tag}: ` + zeilen.join(' · ') : null;
}

// --- Chat -------------------------------------------------------------------
// Nur zwischen bestaetigten Freunden, Text, kein WebSocket: die Ansicht pollt mit ?since=.
// Fuer eine Schule reicht das und haelt die App bei ihrer einen Dependency.

const istFreund = (me, other) => friendIds(me).includes(other);

const nachricht = r => ({
  id: r.id, from_id: r.from_id, to_id: r.to_id, group_id: r.group_id ?? null,
  text: r.text, enc: !!r.enc,
  created_at: r.created_at, read: r.read_at !== null,
  // Nur die Nummer und die Groesse - die Daten holt der Browser einzeln, wenn er sie zeigt.
  datei: r.datei_id ? { id: r.datei_id, bytes: r.datei_bytes } : null,
  // Anzahl der Antwortmoeglichkeiten. Was sie bedeuten, steht verschluesselt im Text.
  umfrage_n: r.umfrage_n ?? 0,
});

/** Die Stimmen zu einer Umfrage - Nummern, keine Texte. */
const stimmenZu = r => (r.umfrage_n
  ? db.prepare('SELECT user_id, wahl FROM poll_votes WHERE message_id = ?').all(r.id)
  : null);

/**
 * Eine Nachricht anlegen - fuer Einzelchat und Gruppe derselbe Weg.
 *
 * Antwortet bei Fehlern SELBST und gibt dann null zurueck; der Aufrufer bricht damit ab. Zwei
 * getrennte Wege waeren zwei Stellen, an denen Anhang, Umfrage und Platzhalter stimmen muessen.
 */
function neueNachricht({ from, to = null, group = null, text, enc, datei_id, umfrage_n = 0, res }) {
  // Ein Anhang ohne Nachricht ist Muell in der Datenbank: er wird nur angenommen, wenn er wirklich
  // dem Absender gehoert, noch an keiner Nachricht haengt und in DIESE Unterhaltung sollte.
  if (datei_id) {
    const frei = db.prepare(`SELECT 1 FROM chat_files f JOIN messages m ON m.id = f.message_id
      WHERE f.id = ? AND m.from_id = ? AND m.text = ''
        AND IFNULL(m.to_id, 0) = ? AND IFNULL(m.group_id, 0) = ?`)
      .get(datei_id, from, to ?? 0, group ?? 0);
    if (!frei) {
      res.status(400).json({ error: 'Der Anhang gehört nicht zu dieser Nachricht' });
      return null;
    }
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO messages(from_id, to_id, group_id, text, enc, umfrage_n, created_at)
    VALUES(?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(from, to, group, text, enc ? 1 : 0, Math.min(Math.max(umfrage_n, 0), 20));

  if (datei_id) {
    const platz = db.prepare('SELECT message_id FROM chat_files WHERE id = ?').get(datei_id).message_id;
    db.prepare('UPDATE chat_files SET message_id = ? WHERE id = ?').run(Number(lastInsertRowid), datei_id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(platz);
  }
  return nachricht(db.prepare(`SELECT ${MSG_COLS} FROM messages m ${MSG_JOIN} WHERE m.id = ?`)
    .get(Number(lastInsertRowid)));
}

/**
 * Einen Anhang entgegennehmen. Er kommt bereits VERSCHLUESSELT an - der Server sieht nur base64.
 *
 * Zwei Schritte, weil die Nummer des Anhangs im verschluesselten Nachrichtentext stehen muss
 * (dort stehen auch Dateiname und Typ): erst die Datei, dann die Nachricht, die sie nennt. Bis
 * dahin haengt der Anhang an einer leeren Platzhalter-Nachricht, die beim Absenden verschwindet.
 */
function dateiAnnehmen({ from, to = null, group = null, kurs = null, daten, res }) {
  if (!daten) return res.status(400).json({ error: 'Keine Daten' });
  // base64 ist ein Drittel groesser als die Datei selbst.
  const bytes = Math.floor(daten.length * 3 / 4);
  if (bytes > MAX_ANHANG)
    return res.status(413).json({ error: `Zu groß (max. ${MAX_ANHANG / 1024 / 1024} MB)` });

  db.exec('BEGIN');
  try {
    const { lastInsertRowid: platz } = db.prepare(
      `INSERT INTO messages(from_id, to_id, group_id, kurs_id, text, enc, created_at)
       VALUES(?, ?, ?, ?, '', ?, datetime('now'))`).run(from, to, group, kurs, kurs ? 0 : 1);
    // Im Kurschat kommt die Datei im Klartext an (kein Ende-zu-Ende) - dann verschluesselt der Server.
    const { lastInsertRowid: datei } = db.prepare(
      "INSERT INTO chat_files(message_id, bytes, data, created_at) VALUES(?, ?, ?, datetime('now'))")
      .run(Number(platz), bytes, kurs ? verschluesseln(daten) : daten);
    db.exec('COMMIT');
    res.status(201).json({ datei_id: Number(datei), bytes });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Verlaufszeilen samt Anhang-Nummer. Der Anhang selbst bleibt draussen: eine Verlaufsabfrage
// zoege sonst jedes Bild der letzten Wochen mit.
const MSG_COLS = `m.*, f.id AS datei_id, f.bytes AS datei_bytes`;
const MSG_JOIN = `LEFT JOIN chat_files f ON f.message_id = m.id`;

// ponytail: 8 MB je Anhang, base64 in der Datenbank. Fuer eine Schule reicht das; wird die
// Datenbank dadurch unhandlich, gehoeren die Anhaenge auf die Platte (wie bei VNW) - dann aber mit
// eigener Aufraeum-Logik, denn geloeschte Nachrichten muessten ihre Dateien mitnehmen.
const MAX_ANHANG = 8 * 1024 * 1024;

app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id;
  const freunde = friendIds(me);
  if (!freunde.length) return res.json([]);
  const platz = freunde.map(() => '?').join(',');

  // Nur die letzte Nachricht je Freund - vorher kam alle 30 Sekunden der ganze Verlauf.
  const letzte = db.prepare(`
    SELECT ${MSG_COLS}, x.partner FROM (
      SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS partner, max(id) AS mid
      FROM messages
      WHERE ((from_id = ? AND to_id IN (${platz})) OR (to_id = ? AND from_id IN (${platz})))
        -- Das + haelt SQLite davon ab, ueber group_id (fast alles NULL) zu suchen statt ueber die Paare.
        AND text <> '' AND +group_id IS NULL
      GROUP BY partner) x
    JOIN messages m ON m.id = x.mid ${MSG_JOIN}`).all(me, me, ...freunde, me, ...freunde);

  const jeFreund = new Map(letzte.map(m => [m.partner, m]));

  const ungelesen = new Map(db.prepare(`
    SELECT from_id, count(*) AS n FROM messages
    WHERE to_id = ? AND read_at IS NULL AND from_id IN (${platz})
    GROUP BY from_id`).all(me, ...freunde).map(r => [r.from_id, r.n]));

  res.json(db.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id IN (${platz}) ORDER BY u.username`)
    .all(...freunde)
    .map(u => ({
      ...person(u),
      last: jeFreund.has(u.id) ? nachricht(jeFreund.get(u.id)) : null,
      unread: ungelesen.get(u.id) ?? 0,
    }))
    // Wer zuletzt geschrieben hat, steht oben - Freunde ohne Verlauf danach.
    .sort((a, b) => (b.last?.id ?? -1) - (a.last?.id ?? -1)));
});

app.get('/api/chats/:id', auth, (req, res) => {
  const me = req.user.id, other = Number(req.params.id);
  if (!istFreund(me, other)) return res.status(403).json({ error: 'Ihr seid nicht befreundet' });
  const since = Number(req.query.since) || 0;

  const rows = db.prepare(`
    SELECT ${MSG_COLS} FROM messages m ${MSG_JOIN}
    WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND m.id > ?
      AND m.text <> '' AND m.group_id IS NULL
    ORDER BY m.id`).all(me, other, other, me, since);

  // Die Suche liest alle Chats durch - das darf keinen ungelesenen Zaehler loeschen.
  if (!req.query.nurLesen)
    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE to_id = ? AND from_id = ? AND read_at IS NULL")
      .run(me, other);
  res.json(rows.map(r => ({ ...nachricht(r), stimmen: stimmenZu(r) })));
});

app.post('/api/chats/:id', auth, bremse('chat', 60), (req, res) => {
  const me = req.user.id, other = Number(req.params.id);
  if (!istFreund(me, other)) return res.status(403).json({ error: 'Ihr seid nicht befreundet' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Nachricht ist leer' });
  // Eine bereits hochgeladene Datei an diese Nachricht haengen (siehe POST .../datei).
  const anhang = Number(req.body?.datei_id) || null;
  // Das Chiffrat ist laenger als der Klartext; die 2000 Zeichen prueft der Browser vor dem
  // Verschluesseln. Hier steht nur die Obergrenze, damit niemand die Datenbank vollschreibt.
  if (text.length > 6000) return res.status(400).json({ error: 'Nachricht ist zu lang' });

  const neu = neueNachricht({
    from: me, to: other, text, enc: !!req.body?.enc, datei_id: anhang,
    umfrage_n: Number(req.body?.umfrage_n) || 0, res,
  });
  if (!neu) return;   // neueNachricht hat schon geantwortet

  // Ohne Text: bei Ende-zu-Ende kennt der Server ihn nicht, und die Vorschau auf dem Sperrbildschirm
  // waere ohnehin die Stelle, an der Vertraulichkeit als Erstes verloren geht.
  benachrichtige(other, 'chat', `Neue Nachricht von ${nameVon(req.user)}`, null, '/');
  res.json(neu);
});

/**
 * Einen Anhang hochladen. Er kommt bereits VERSCHLUESSELT an - der Server sieht nur base64.
 *
 * Zwei Schritte, weil die Nummer des Anhangs im verschluesselten Nachrichtentext stehen muss
 * (dort stehen auch Dateiname und Typ, damit der Server sie nicht kennt): erst die Datei, dann
 * die Nachricht, die sie nennt. Bis dahin haengt der Anhang an einer leeren Platzhalter-Nachricht,
 * die beim Absenden verschwindet.
 */
app.post('/api/chats/:id/datei', auth, bremse('chat-datei', 30),
  express.json({ limit: '12mb' }), (req, res) => {
    const me = req.user.id, other = Number(req.params.id);
    if (!istFreund(me, other)) return res.status(403).json({ error: 'Ihr seid nicht befreundet' });

    dateiAnnehmen({ from: me, to: other, daten: String(req.body?.data ?? ''), res });
  });

/** Den Anhang holen - nur wer an der Unterhaltung beteiligt ist, bekommt ihn. */
app.get('/api/chats/datei/:id', auth, (req, res) => {
  const me = req.user.id;
  // In einer Gruppe steht kein to_id - dort darf jedes Mitglied, das drin ist.
  const kursZeile = sql(`SELECT f.data, f.bytes, m.kurs_id, m.kurs_slots, m.from_id FROM chat_files f
    JOIN messages m ON m.id = f.message_id WHERE f.id = ? AND m.kurs_id IS NOT NULL`).get(Number(req.params.id) || 0);
  if (kursZeile) {
    // Kurschat: serverseitig verschluesselt - wer die Nachricht sieht, bekommt die Datei im Klartext.
    if (kursZeile.from_id !== me && !kursSichtbar(kursZeile, meineSlotsImKurs(me, kursZeile.kurs_id)))
      return res.status(404).json({ error: 'Anhang nicht gefunden' });
    return res.json({ data: entschluesseln(kursZeile.data), bytes: kursZeile.bytes, klar: true });
  }
  const zeile = db.prepare(`SELECT f.data, f.bytes FROM chat_files f
                            JOIN messages m ON m.id = f.message_id
                            WHERE f.id = ? AND (m.from_id = ? OR m.to_id = ? OR (m.group_id IS NOT NULL
                              AND EXISTS (SELECT 1 FROM group_members g WHERE g.group_id = m.group_id
                                AND g.user_id = ? AND g.status = 'drin')))`)
    .get(Number(req.params.id) || 0, me, me, me);
  if (!zeile) return res.status(404).json({ error: 'Anhang nicht gefunden' });
  res.json({ data: zeile.data, bytes: zeile.bytes });
});

/**
 * Abstimmen. Erlaubt ist eine Stimme je Person - wer sich umentscheidet, ersetzt sie.
 *
 * Der Server kennt nur die NUMMER der Antwort. Was sie bedeutet, steht verschluesselt im Text der
 * Nachricht; er kann also zaehlen, ohne die Umfrage zu kennen.
 */
app.post('/api/messages/:id/stimme', auth, (req, res) => {
  const m = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(Number(req.params.id) || 0);
  const darf = m && (m.kurs_id ? kursSichtbar(m, meineSlotsImKurs(req.user.id, m.kurs_id))
    : m.group_id ? gruppeVon(m.group_id, req.user.id)?.status === 'drin'
      : (m.from_id === req.user.id || m.to_id === req.user.id));
  if (!m || !darf) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
  if (!m.umfrage_n) return res.status(400).json({ error: 'Das ist keine Umfrage' });

  const wahl = Number(req.body?.wahl);
  if (!Number.isInteger(wahl) || wahl < 0 || wahl >= m.umfrage_n)
    return res.status(400).json({ error: 'Diese Antwort gibt es nicht' });

  db.prepare(`INSERT INTO poll_votes(message_id, user_id, wahl) VALUES(?, ?, ?)
              ON CONFLICT(message_id, user_id) DO UPDATE SET wahl = excluded.wahl`)
    .run(m.id, req.user.id, wahl);
  res.json({ stimmen: stimmenZu(m) });
});

// Nachrichten wegwerfen, die niemand mehr lesen kann. Welche das sind, weiss nur der Browser -
// der Server sieht bei Ende-zu-Ende nur Chiffrat. Deshalb schickt er die IDs mit; hier wird
// lediglich geprueft, dass sie zu genau dieser Unterhaltung gehoeren.
app.post('/api/chats/:id/aufraeumen', auth, (req, res) => {
  const me = req.user.id, other = Number(req.params.id);
  if (!istFreund(me, other)) return res.status(403).json({ error: 'Ihr seid nicht befreundet' });

  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number).filter(Number.isInteger).slice(0, 500);
  if (!ids.length) return res.json({ geloescht: 0 });

  const { changes } = db.prepare(`
    DELETE FROM messages
    WHERE id IN (${ids.map(() => '?').join(',')}) AND enc = 1
      AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`)
    .run(...ids, me, other, other, me);
  res.json({ geloescht: changes });
});

// --- Sicherung (Admin) -------------------------------------------------------

const BACKUP_TABELLEN = ['users', 'entries', 'courses', 'periods', 'days'];

app.get('/api/backup', auth, admin, (req, res) => {
  // VACUUM INTO schreibt einen konsistenten Schnappschuss, auch waehrend die App laeuft.
  const ziel = join(tmpdir(), `stundenplan-${randomUUID()}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(ziel);
    res.download(ziel, `stundenplan-${new Date().toISOString().slice(0, 10)}.db`,
      () => rmSync(ziel, { force: true }));
  } catch (err) {
    rmSync(ziel, { force: true });
    res.status(500).json({ error: 'Sicherung fehlgeschlagen: ' + err.message });
  }
});

app.post('/api/backup/restore', auth, admin, express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
  const daten = req.body;
  if (!Buffer.isBuffer(daten) || daten.length < 100)
    return res.status(400).json({ error: 'Keine Datei empfangen' });
  if (daten.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0')
    return res.status(400).json({ error: 'Das ist keine SQLite-Datenbank' });

  // Erst in eine Pruefkopie schreiben und wirklich oeffnen - eine Datei mit richtigem Header, aber
  // falschem Inhalt wuerde die App sonst beim naechsten Start lahmlegen. Die Pruefung kommt vor
  // allem anderen, damit die Meldung immer den echten Grund nennt.
  const pruef = join(tmpdir(), `pruef-${randomUUID()}.db`);
  try {
    writeFileSync(pruef, daten);
    const test = new DatabaseSync(pruef, { readOnly: true });
    const vorhanden = test.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    test.close();
    const fehlt = BACKUP_TABELLEN.filter(t => !vorhanden.includes(t));
    if (fehlt.length) return res.status(400).json({ error: `Das sieht nicht nach dieser App aus (fehlt: ${fehlt.join(', ')})` });
    if (dbFile === ':memory:') return res.status(400).json({ error: 'Ohne Datenbankdatei nicht möglich' });

    renameSync(pruef, `${dbFile}.incoming`);
    res.json({ ok: true, hinweis: 'Sicherung übernommen. Die App muss jetzt neu gestartet werden.' });
  } catch (err) {
    res.status(400).json({ error: 'Datei ist unbrauchbar: ' + err.message });
  } finally {
    rmSync(pruef, { force: true });
  }
});

// --- Stundenplan ------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function weekStart(s) {
  if (ISO_DATE.test(s ?? '')) {
    const d = new Date(s + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // zurück auf Montag
    return d.toISOString().slice(0, 10);
  }
  // Ohne Angabe: am Wochenende die kommende Woche, sonst die laufende. Samstags die gerade
  // beendete Woche zu zeigen hilft niemandem - und alles, was man dort einträgt, wäre sofort
  // überfällig.
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  const woTag = (d.getUTCDay() + 6) % 7; // Mo=0 … So=6
  d.setUTCDate(d.getUTCDate() + (woTag >= 5 ? 7 - woTag : -woTag));
  return d.toISOString().slice(0, 10);
}

const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Plan einer Person fuer die Woche: echte Eintraege plus automatische Freistunden in den Luecken
// zwischen der ersten und letzten belegten Stunde eines Tages. Die Freistunden werden nur
// berechnet, nicht gespeichert - sonst muesste man sie bei jeder Planaenderung nachfuehren.
// Welche Tage dieser Woche in Ferien oder auf einem Feiertag liegen - je Datum der Name.
function ferienFuer(days, schoolId) {
  if (!days.length) return {};
  const treffer = {};
  for (const f of db.prepare('SELECT von, bis, name FROM holidays WHERE school_id = ?').all(schoolId))
    for (const d of days) if (d.date >= f.von && d.date <= f.bis) treffer[d.date] = f.name;
  return treffer;
}

// Wie viel dieser Woche wirklich aus WebUntis kommt: 'ganz', 'teils' oder null.
function untisDeckung(userId, days) {
  if (!days.length) return null;
  const n = db.prepare(`SELECT count(DISTINCT date) AS n FROM untis_lessons
    WHERE user_id = ? AND course_id IS NOT NULL AND date IN (${days.map(() => '?').join(',')})`)
    .get(userId, ...days.map(d => d.date)).n;
  return n === 0 ? null : n === days.length ? 'ganz' : 'teils';
}

function planFuer(userId, periods, days) {
  const manuell = db.prepare(`
    SELECT e.day_id, e.period_id, e.room_id, e.vorrang, r.name AS room, ${COURSE_COLS}
    FROM entries e
    JOIN courses c ON c.id = e.course_id
    ${COURSE_JOINS}
    LEFT JOIN rooms r ON r.id = e.room_id
    WHERE e.user_id = ?`).all(userId);

  const proSlot = new Map();
  const festgehalten = new Set(); // Slots, die WebUntis nicht mehr ueberschreiben darf
  for (const e of manuell) {
    proSlot.set(`${e.day_id}|${e.period_id}`, { ...e, source: 'manuell', status: 'regular', vorrang: !!e.vorrang });
    if (e.vorrang) festgehalten.add(`${e.day_id}|${e.period_id}`);
  }

  // Entschieden wird pro TAG, nicht pro Stunde. Vorher gewann WebUntis nur dort, wo es etwas
  // lieferte - dadurch stand in einer Woche mal der Untis-Plan und mal der selbst gebaute
  // nebeneinander, je nachdem, wie weit der letzte Abgleich reichte. Ein Flickenteppich, den
  // niemand deuten kann.
  //
  // Jetzt gilt: liegt der Tag im abgeglichenen Zeitraum, ist WebUntis die Wahrheit - auch dort,
  // wo es nichts liefert (dann ist eben frei). Liegt er ausserhalb, wissen wir nichts, und der
  // selbst gebaute Plan bleibt vollstaendig stehen.
  // Entscheidend ist, ob WebUntis fuer diesen Tag *wirklich etwas geliefert hat* - nicht, ob der
  // Tag im abgeglichenen Zeitraum liegt. Der Unterschied ist der ganze Punkt: eine Woche, deren
  // Plan die Schule noch nicht veroeffentlicht hat, liegt zwar im Zeitraum, hat aber keine
  // Stunden. Wuerde sie als "WebUntis sagt: frei" gelten, waere der selbst gebaute Plan dort
  // schlagartig verschwunden.
  const mitDaten = new Set(days.length
    ? db.prepare(`SELECT DISTINCT date FROM untis_lessons
        WHERE user_id = ? AND course_id IS NOT NULL AND date IN (${days.map(() => '?').join(',')})`)
      .all(userId, ...days.map(d => d.date)).map(r => r.date)
    : []);

  // Fuer einen Tag MIT Daten gilt WebUntis dann aber ganz: die Schule kennt den ganzen Tag, und
  // eine 5. Stunde aus dem alten Plan neben vier Untis-Stunden waere wieder der Flickenteppich.
  // An Ferientagen ist ohnehin nichts - da waere der eigene Wochenplan schlicht falsch.
  const istFerien = ferienFuer(days, schuleVon(userId).id);

  for (const d of days) {
    if (!mitDaten.has(d.date) && !istFerien[d.date]) continue;
    for (const p of periods) {
      const k = `${d.id}|${p.id}`;
      if (!festgehalten.has(k)) proSlot.delete(k); // Ersetztes bleibt ersetzt
    }
  }

  const tagVonDatum = new Map(days.map(d => [d.date, d.id]));
  if (days.length) {
    for (const u of db.prepare(`
      SELECT u.date, u.period_id, u.course_id, u.room, u.status, u.info, u.lesson_text, u.lehrstoff,
             u.teacher AS stunden_lehrer, u.room_regulaer,
             -- c.id statt u.course_id: der Join laeuft ueber die NOCASE-Spalte und liefert damit
             -- die kanonische Schreibweise. Gaebe der Plan die rohe heraus, faenden Farbe, Name
             -- und Hausaufgaben ihren Kurs nicht wieder.
             c.id AS kanon, c.title, s.name AS subject, s.short AS subject_short, t.name AS teacher
      FROM untis_lessons u
      LEFT JOIN courses c ON c.id = u.course_id
      LEFT JOIN subjects s ON s.id = c.subject_id
      LEFT JOIN teachers t ON t.id = c.teacher_id
      WHERE u.user_id = ? AND u.date IN (${days.map(() => '?').join(',')})`)
      .all(userId, ...days.map(d => d.date))) {
      const day_id = tagVonDatum.get(u.date);
      if (!day_id || !u.course_id) continue;
      // Wer eine falsch importierte Stunde ersetzt hat, will sie nicht beim naechsten Abgleich
      // zurueckbekommen.
      if (festgehalten.has(`${day_id}|${u.period_id}`)) continue;
      proSlot.set(`${day_id}|${u.period_id}`, {
        day_id, period_id: u.period_id, id: u.kanon ?? u.course_id, title: u.title ?? u.course_id,
        subject: u.subject, subject_short: u.subject_short,
        // Wer wirklich davorsteht. Am Kurs haengt bewusst der regulaere Lehrer - waehrend einer
        // Vertretung stand deshalb der Falsche im Plan.
        //
        // Bei einer Vertretung gilt AUSSCHLIESSLICH der Lehrer dieser Stunde: nennt WebUntis
        // keinen, ist auch keiner da (meist heisst das: absitzen). Wuerde hier der Kurslehrer
        // einspringen, behauptete der Plan das Gegenteil.
        teacher: u.status === 'irregular'
          ? (u.stunden_lehrer ?? null)
          : (u.stunden_lehrer ?? u.teacher),
        // Der regulaere, damit die Oberflaeche "statt Frau Klein" schreiben kann.
        teacher_regulaer: u.teacher ?? null,
        room: u.room, room_id: null, source: 'untis', status: u.status, info: u.info,
        // NULL heisst: kein Wechsel. Der leere Text heisst: gewechselt, Herkunft unbekannt.
        room_regulaer: u.room_regulaer ?? null,
        // Fuer den Client ein Text: der Lehrstoff voran, dann der Rest - so, wie es immer war.
        lesson_text: [u.lehrstoff ? `Lehrstoff:\n${u.lehrstoff}` : null, u.lesson_text]
          .filter(Boolean).join('\n\n') || null,
      });
    }
  }

  const rows = [...proSlot.values()];
  const platz = new Map(periods.map((p, i) => [p.id, i]));
  const proTag = new Map();
  for (const e of rows) {
    if (!proTag.has(e.day_id)) proTag.set(e.day_id, new Map());
    proTag.get(e.day_id).set(e.period_id, e);
  }

  const alle = [...rows];
  for (const [day_id, belegte] of proTag) {
    for (const [pid, e] of belegte) if (e.id === WEG) belegte.delete(pid);
    const indizes = [...belegte.keys()].map(id => platz.get(id)).filter(i => i !== undefined);
    if (indizes.length < 2) continue; // eine einzelne Stunde hat keine Luecke
    for (let i = Math.min(...indizes) + 1; i < Math.max(...indizes); i++) {
      const p = periods[i];
      if (belegte.has(p.id)) continue;
      alle.push({
        day_id, period_id: p.id, id: FREI, title: 'Freistunde',
        subject: null, subject_short: null, teacher: null, room: null, room_id: null,
        auto: true, source: 'auto', status: 'regular',
      });
    }
  }
  return alle;
}

/**
 * Warum jemand in diesem Slot frei hat - oder null, wenn er Unterricht hat.
 *
 * Eine Vertretung, vor der niemand steht, zaehlt mit: das ist Absitzen, also frei. Genau dafuer
 * gibt es im Plan schon das eigene Zeichen.
 */
function freiGrund(e) {
  if (!e || e.id === WEG) return 'kein_unterricht';
  if (e.id === FREI) return 'freistunde';
  if (e.status === 'cancelled') return 'ausfall';
  if (e.status === 'irregular' && !e.teacher) return 'ohne_lehrer';
  return null;
}

/**
 * Alles fuer die Homescreen-Widgets der Android-App in einem Aufruf: die Stunden eines Tages,
 * offene Hausaufgaben, die naechsten Pruefungen. Jedes Handy fragt alle 15 Minuten - deshalb
 * gebremst, ohne Cache, nur die noetigen Felder, und ohne den WebUntis-Abgleich anzustossen:
 * den macht die App selbst, wenn sie offen ist.
 */
/**
 * Ist eine Pruefung vorbei? Mit Uhrzeit ab ihrem Ende (sonst ab ihrem Beginn), ganztags ab dem
 * naechsten Tag. Vorher galt nur das Datum - eine Klausur von 8 Uhr stand bis Mitternacht unter
 * "kommende Pruefungen".
 */
const pruefungVorbei = (e, jetzt = alsLokal(new Date())) => {
  const ende = String(e.bis || e.von || '');
  return e.ganztags || ende.length <= 10 ? ende.slice(0, 10) < jetzt.slice(0, 10) : ende <= jetzt;
};

app.get('/api/widget', auth, bremse('widget', 30), (req, res) => {
  const me = req.user.id;
  const heute = new Date().toISOString().slice(0, 10);
  if (req.query.tag !== undefined && !ISO_DATE.test(req.query.tag))
    return res.status(400).json({ error: 'tag als JJJJ-MM-TT' });
  // Ohne Angabe heute - am Wochenende der kommende Montag, wie im Plan.
  const woTag = (new Date(heute + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const tag = req.query.tag ?? (woTag >= 5 ? weekStart() : heute);
  const kurz = s => (s == null ? null : String(s).slice(0, 200));

  const monday = weekStart(tag);
  const days = db.prepare('SELECT * FROM days ORDER BY iso').all()
    .map(d => ({ ...d, date: addDays(monday, d.iso - 1) }));
  const periods = periodsFuer(schuleVon(me).id);
  const periodVon = new Map(periods.map(p => [p.id, p]));
  const tagId = days.find(d => d.date === tag)?.id ?? null;
  const prefs = new Map(db.prepare('SELECT course_id, name, short, color FROM course_prefs WHERE user_id = ?')
    .all(me).map(p => [p.course_id, p]));
  const stunden = planFuer(me, periods, days)
    .filter(e => e.day_id === tagId && !RESERVIERT.has(e.id))
    .map(e => {
      const p = periodVon.get(e.period_id), pref = prefs.get(e.id);
      return { nr: p.nr, start_time: p.start_time, end_time: p.end_time,
        kurz: kurz(pref?.short || e.subject_short || e.id), name: kurz(pref?.name || e.title),
        raum: kurz(e.room), lehrer: kurz(e.teacher), status: e.status, info: kurz(e.info ?? null),
        farbe: pref?.color ?? null };
    })
    .sort((a, b) => a.nr - b.nr);

  const hausaufgaben = [...homeworkFuer(me, meineKursIds(me), heute, addDays(heute, 400)),
    ...untisHausaufgaben(me, heute, addDays(heute, 400))]
    .filter(h => !h.done)
    .sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 20)
    .map(h => ({ id: h.id, quelle: h.von_untis ? 'untis' : 'eigene',
      kurz: kurz(h.subject_short || h.course_id), text: kurz(h.text), due_date: h.due_date, done: h.done }));

  const pruefungen = kalenderEintraege(req.user, heute, addDays(heute, 200)).eintraege
    .filter(e => e.art === 'pruefung' && !pruefungVorbei(e))
    .sort((a, b) => a.von.localeCompare(b.von)).slice(0, 10)
    .map(e => ({ id: e.id, titel: kurz(e.titel), von: e.von, bis: e.bis ?? null }));

  res.set('Cache-Control', 'no-store');
  res.json({ heute, tag, stunden, hausaufgaben, pruefungen });
});

app.get('/api/timetable', auth, (req, res) => {
  const me = req.user.id;
  const target = req.query.user ? Number(req.query.user) : me;
  const friends = friendIds(me);
  if (target !== me && !friends.includes(target))
    return res.status(403).json({ error: 'Du bist mit diesem User nicht befreundet' });

  const owner = db.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).get(target);
  if (!owner) return res.status(404).json({ error: 'User nicht gefunden' });

  const monday = weekStart(req.query.week);
  const days = db.prepare('SELECT * FROM days ORDER BY iso').all()
    .map(d => ({ ...d, date: addDays(monday, d.iso - 1) }));
  // Das Raster des ANGEZEIGTEN Plans, nicht das eigene: eine andere Schule klingelt anders.
  const zielSchule = schuleVon(target);
  const periods = periodsFuer(zielSchule.id);
  const dateOf = new Map(days.map(d => [d.id, d.date]));

  // Nur fuer den eigenen Plan: sonst loeste das Ansehen eines Freundesplans dessen Anmeldung bei
  // WebUntis mit dessen Zugangsdaten aus.
  const syncLaeuft = target === me && vielleichtAbgleichen(me, monday, sitzungsSchluessel(req));
  const entries = planFuer(target, periods, days);
  const prefs = new Map(db.prepare('SELECT course_id, name, short, color FROM course_prefs WHERE user_id = ?')
    .all(me).map(p => [p.course_id, p]));
  const notizen = new Map(db.prepare('SELECT day_id, period_id, text FROM notes WHERE user_id = ?')
    .all(target).map(n => [`${n.day_id}|${n.period_id}`, n.text]));

  // Wer aus meinem Umfeld sitzt in denselben Stunden? Beim Freundesplan gehöre ich selbst dazu.
  // Der Vergleich laeuft in JS statt als SQL-Join, weil automatische Freistunden nicht in der
  // Datenbank stehen - sonst wuerde eine gemeinsame Luecke nicht erkannt.
  // Nur dieselbe Schule: ueber Schulgrenzen hinweg passen weder Kurse noch Klingelzeiten
  // zusammen, und "gemeinsam" waere dann eine Behauptung.
  const pool = [me, ...friends]
    .filter(id => id !== target && schuleVon(id).id === zielSchule.id);
  // Eine entfernte Stunde ist keine gemeinsame Stunde - zwei Leute, die dieselbe Untis-Stunde
  // weggeklickt haben, sitzen deshalb nirgends zusammen.
  const meins = new Map(entries.filter(e => e.id !== WEG)
    .map(e => [`${e.day_id}|${e.period_id}`, e.id.toLowerCase()]));

  const people = [target, ...pool];
  // Abgemeldet kann jemand den ganzen Tag sein oder nur ein paar Stunden - deshalb ein Bereich
  // statt eines Hakens. NULL heisst weiterhin "ganzer Tag".
  // Bis 60 Tage ueber die Woche hinaus: "abgemeldet bis Freitag" braucht die Tage danach.
  const abwesenheiten = new Map(db.prepare(`
    SELECT user_id, date, von_stunde, bis_stunde, grund, grund_sichtbar FROM absences
    WHERE date BETWEEN ? AND ? AND user_id IN (${people.map(() => '?').join(',')})`)
    .all(monday, addDays(monday, 66), ...people)
    .map(a => [`${a.user_id}|${a.date}`, { von: a.von_stunde, bis: a.bis_stunde,
      grund: a.grund_sichtbar === 1 ? a.grund : null }]));
  /** Der letzte Tag der zusammenhaengenden Abmeldung ab diesem Tag (gleicher Stundenbereich). */
  const abwesendBis = (uid, datum) => {
    const a = abwesenheiten.get(`${uid}|${datum}`);
    let bis = datum;
    for (let d = addDays(datum, 1); ; d = addDays(d, 1)) {
      const n = abwesenheiten.get(`${uid}|${d}`);
      if (!n || n.von !== a.von || n.bis !== a.bis) break;
      bis = d;
    }
    return bis;
  };
  const nrVon = new Map(periods.map(p => [p.id, p.nr]));
  /** Ist der in dieser Stunde weg? Ohne Stunde: ist er den Tag ueber weg? */
  const abwesend = (uid, datum, periodId = null) => {
    const a = abwesenheiten.get(`${uid}|${datum}`);
    if (!a) return false;
    if (!a.von) return true;                       // ganzer Tag
    if (periodId === null) return false;           // Tagesansicht: ein Teil ist kein ganzer Tag
    const nr = nrVon.get(periodId);
    return nr !== undefined && nr >= a.von && nr <= (a.bis ?? a.von);
  };

  // Die Stunden, in denen ICH frei habe. Nur dort wird gezeigt, wer sonst noch frei hat - eine
  // leere Zelle nach Schulschluss braucht kein Zeichen.
  const meineFrei = new Map(entries.filter(e => freiGrund(e))
    .map(e => [`${e.day_id}|${e.period_id}`, e.day_id]));

  const shared = [];
  const frei = [];
  for (const uid of pool) {
    const wer = db.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).get(uid);
    const seins = new Map();
    const tageMitPlan = new Set();
    for (const e of planFuer(uid, periods, days)) {
      const key = `${e.day_id}|${e.period_id}`;
      seins.set(key, e);
      if (!freiGrund(e)) tageMitPlan.add(e.day_id);
      if (e.id !== WEG && meins.get(key) === e.id.toLowerCase())
        shared.push({ ...wer, day_id: e.day_id, period_id: e.period_id });
    }
    for (const [key, day_id] of meineFrei) {
      // Wer an dem Tag gar keinen Unterricht hat, ist nicht "auch frei" - der ist woanders. Und
      // wer abgemeldet ist, ist krank und nicht frei.
      if (!tageMitPlan.has(day_id)) continue;
      const [, pid] = key.split('|').map(Number);
      if (abwesend(uid, dateOf.get(day_id), pid)) continue;
      const e = seins.get(key);
      const grund = freiGrund(e);
      if (!grund) continue;
      frei.push({ ...wer, day_id, period_id: pid, grund, fach: e?.subject ?? e?.title ?? null });
    }
  }
  const nachNamen = (a, b) => String(a.username).localeCompare(String(b.username), 'de');
  shared.sort(nachNamen);
  frei.sort(nachNamen);

  const bySlot = new Map();
  for (const s of shared) {
    const key = `${s.day_id}|${s.period_id}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    const datum = dateOf.get(s.day_id);
    const absent = abwesend(s.id, datum, s.period_id);
    bySlot.get(key).push({ ...person(s), absent,
      // Bis wann, und warum - den Grund nur, wenn er ihn freigegeben hat.
      abwesend_bis: absent ? abwesendBis(s.id, datum) : null,
      grund: absent ? abwesenheiten.get(`${s.id}|${datum}`)?.grund ?? null : null });
  }

  const freiSlot = new Map();
  for (const f of frei) {
    const key = `${f.day_id}|${f.period_id}`;
    if (!freiSlot.has(key)) freiSlot.set(key, []);
    freiSlot.get(key).push({ ...person(f), grund: f.grund, fach: f.fach });
  }

  // Pruefungen des angezeigten Plans - sie markieren JEDE Stunde, die sie belegen. Auch im Plan
  // eines Freundes, samt Notiz: "was schreibt der wann" ist genau, wofuer man dort nachsieht.
  // Seine uebrigen Termine bleiben privat - hier kommt nur art = 'pruefung'.
  const pruefungen = [
    ...db.prepare(`
      SELECT e.id, e.kalender_id, e.titel, e.ort, e.text, e.von, e.bis, e.ganztags, e.art,
             e.course_id, e.von_stunde, e.bis_stunde, e.fuer_kurs, e.erinnerung_tage, k.quelle
      FROM kalender_eintraege e JOIN kalender k ON k.id = e.kalender_id
      WHERE k.user_id = ? AND e.art = 'pruefung' AND substr(e.von, 1, 10) BETWEEN ? AND ?`)
      .all(target, monday, addDays(monday, 6)),
    // Was Mitschueler fuer den ganzen Kurs eingetragen haben - mit Namen, nicht loeschbar.
    ...kursPruefungen(target, monday, addDays(monday, 6)).map(r => ({
      id: r.id, titel: r.titel, ort: r.ort, text: r.text, von: r.von, bis: r.bis,
      von_stunde: r.von_stunde, bis_stunde: r.bis_stunde, quelle: 'kurs', von_name: r.von_name })),
  ];
  const pruefungenIn = (day_id, period_id) => {
    const datum = dateOf.get(day_id), nr = nrVon.get(period_id);
    return pruefungen.filter(pr => pr.von.slice(0, 10) === datum && pr.von_stunde
      && nr >= pr.von_stunde && nr <= (pr.bis_stunde ?? pr.von_stunde));
  };

  // Faellige Hausaufgaben der Kurse dieses Plans. Kommt derselbe Kurs an einem Tag zweimal vor,
  // haengt die Aufgabe nur an der ersten Stunde - sonst stuende derselbe Marker doppelt im Plan.
  const hw = [
    ...homeworkFuer(me, [...new Set(entries.map(e => e.id))], monday, addDays(monday, 6)),
    // Auch die des Lehrers: sie sollen an ihrer Stunde stehen und nicht nur in der Liste. Nur im
    // eigenen Plan - sie gehoeren zum Konto dessen, der sie abgeglichen hat.
    ...(target === me ? untisHausaufgaben(me, monday, addDays(monday, 6)) : []),
  ].filter(x => x.course_id);
  const perioden = new Map(periods.map((p, i) => [p.id, i]));
  const sortiert = [...entries].sort((a, b) => perioden.get(a.period_id) - perioden.get(b.period_id));
  const belegt = new Set();
  const hwProSlot = new Map();
  for (const e of sortiert) {
    const datum = dateOf.get(e.day_id);
    const schluessel = `${datum}|${e.id}`;
    if (belegt.has(schluessel)) continue;
    const treffer = hw.filter(x => x.course_id.toLowerCase() === e.id.toLowerCase() && x.due_date === datum);
    if (!treffer.length) continue;
    belegt.add(schluessel);
    hwProSlot.set(`${e.day_id}|${e.period_id}`, treffer);
  }

  res.json({
    me, owner: person(owner), week: monday, days, periods, syncLaeuft,
    // Sagt der Oberflaeche, ob diese Woche ueberhaupt aus WebUntis kommt - sonst sieht der eigene
    // Plan dort aus wie ein Fehler.
    untisWoche: untisDeckung(target, days),
    ferien: ferienFuer(days, zielSchule.id),
    schule: schuleNachAussen(zielSchule),
    entries: entries.map(e => ({
      ...e,
      // Die Einstellungen des Betrachters, nicht die des Plan-Inhabers: ich will meine eigenen
      // Namen wiedererkennen, auch wenn ich in den Plan eines Freundes schaue.
      pref_name: prefs.get(e.id)?.name ?? null,
      pref_short: prefs.get(e.id)?.short ?? null,
      pref_color: prefs.get(e.id)?.color ?? null,
      // Notizen sind privat, auch vor Freunden
      note: target === me ? (notizen.get(`${e.day_id}|${e.period_id}`) ?? null) : null,
      shared: bySlot.get(`${e.day_id}|${e.period_id}`) ?? [],
      // Wer in dieser Stunde auch frei hat - leer, wo ich selbst Unterricht habe.
      frei: freiSlot.get(`${e.day_id}|${e.period_id}`) ?? [],
      pruefungen: pruefungenIn(e.day_id, e.period_id),
      homework: hwProSlot.get(`${e.day_id}|${e.period_id}`) ?? [],
    })),
    // Ganztags oder stundenweise - die Oberflaeche macht daraus eine blasse Spalte oder eine
    // blasse Zelle.
    absences: days.map(d => abwesenheiten.get(`${target}|${d.date}`)
      && { date: d.date, von: abwesenheiten.get(`${target}|${d.date}`).von,
        bis: abwesenheiten.get(`${target}|${d.date}`).bis }).filter(Boolean),
  });
});

// Notizen haengen am Wochentags-Slot und sind damit unabhaengig davon, ob die Stunde selbst
// eingetragen wurde oder aus WebUntis kommt.
app.put('/api/note', auth, (req, res) => {
  const { day_id, period_id } = req.body ?? {};
  if (!day_id || !period_id) return res.status(400).json({ error: 'Tag und Stunde nötig' });
  const text = String(req.body?.text ?? '').trim().slice(0, 300);
  if (text) {
    db.prepare(`INSERT INTO notes(user_id, day_id, period_id, text) VALUES(?, ?, ?, ?)
                ON CONFLICT(user_id, day_id, period_id) DO UPDATE SET text = excluded.text`)
      .run(req.user.id, Number(day_id), Number(period_id), text);
  } else {
    db.prepare('DELETE FROM notes WHERE user_id = ? AND day_id = ? AND period_id = ?')
      .run(req.user.id, Number(day_id), Number(period_id));
  }
  res.json({ text: text || null });
});

app.put('/api/entry', auth, (req, res) => {
  const { day_id, period_id, course_id, room_id, vorrang } = req.body ?? {};
  if (!day_id || !period_id) return res.status(400).json({ error: 'Tag und Stunde nötig' });
  try {
    // Der Raum gehoert hierher und nicht an den Kurs: derselbe Kurs kann montags in A213 und
    // mittwochs in B104 stattfinden, und das entscheidet jeder fuer seinen eigenen Plan.
    const kurs = course_id ? kanonischerKurs(course_id) ?? String(course_id) : null;
    const tag = Number(day_id), stunde = Number(period_id);

    // Einen Untis-Kurs darf eintragen, wer ihn selbst hat - in eine andere Stunde legen, eine
    // falsch importierte ersetzen. Wer ihn NICHT hat, darf es nicht: sonst koennte man sich in
    // fremde Kurse eintragen und ueber die gemeinsamen Stunden sehen, wer darin sitzt.
    if (kurs && db.prepare('SELECT from_untis FROM courses WHERE id = ?').get(kurs)?.from_untis
        && !hatKurs(req.user.id, kurs))
      return res.status(403).json({ error: 'Diesen WebUntis-Kurs hast du nicht im Stundenplan' });

    // An einem Tag, fuer den WebUntis Stunden liefert, loescht planFuer jeden eigenen Eintrag
    // OHNE Vorrang wieder weg. Ein selbst eingetragener Kurs entstand dort, verschwand beim
    // naechsten Laden und niemand erfuhr warum. Wer selbst etwas eintraegt, will es behalten -
    // zurueck geht es mit "WebUntis wieder uebernehmen".
    // Der Wochentag-Bezug wie in MEINE_SLOTS: entries haengen am Wochentag, untis_lessons am Datum.
    const untisTag = kurs && db.prepare(`SELECT 1 FROM untis_lessons u
      JOIN days d ON d.iso = CAST(strftime('%u', u.date) AS INTEGER)
      WHERE u.user_id = ? AND d.id = ? AND u.course_id IS NOT NULL LIMIT 1`).get(req.user.id, tag);

    if (kurs) db.prepare(`
      INSERT INTO entries(user_id, day_id, period_id, course_id, room_id, vorrang) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day_id, period_id)
      DO UPDATE SET course_id = excluded.course_id, room_id = excluded.room_id,
                    vorrang = excluded.vorrang`)
      .run(req.user.id, tag, stunde, kurs,
        Number(room_id) || null, vorrang || untisTag ? 1 : 0);
    else db.prepare('DELETE FROM entries WHERE user_id = ? AND day_id = ? AND period_id = ?')
      .run(req.user.id, tag, stunde);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Kurs, Tag oder Stunde existiert nicht' }); }
});

// --- Abmeldungen ------------------------------------------------------------

app.get('/api/absences', auth, (req, res) =>
  res.json(db.prepare(`SELECT date, von_stunde, bis_stunde, grund, grund_sichtbar FROM absences
    WHERE user_id = ? ORDER BY date`).all(req.user.id)
    .map(r => ({ date: r.date, von: r.von_stunde, bis: r.bis_stunde,
      grund: r.grund ?? null, grund_sichtbar: r.grund_sichtbar === 1 }))));

/**
 * Die Abmeldungen der Freunde ab heute, je Freund zu Spannen zusammengefasst: aufeinander
 * folgende Tage mit demselben Stundenbereich werden eine Zeile - "Mo bis Mi" statt drei Zeilen.
 */
app.get('/api/friends/absences', auth, (req, res) => {
  const freunde = friendIds(req.user.id);
  if (!freunde.length) return res.json([]);
  const heute = new Date().toISOString().slice(0, 10);
  const zeilen = db.prepare(`SELECT a.user_id, a.date, a.von_stunde, a.bis_stunde,
      CASE WHEN a.grund_sichtbar = 1 THEN a.grund END AS grund, ${USER_COLS}
    FROM absences a JOIN users u ON u.id = a.user_id
    WHERE a.user_id IN (${freunde.map(() => '?').join(',')}) AND a.date BETWEEN ? AND ?
    ORDER BY a.user_id, a.date`).all(...freunde, heute, addDays(heute, 60));
  const spannen = [];
  for (const z of zeilen) {
    const letzte = spannen.at(-1);
    if (letzte && letzte.id === z.user_id && addDays(letzte.bis, 1) === z.date
      && letzte.von_stunde === z.von_stunde && letzte.bis_stunde === z.bis_stunde
      && (letzte.grund ?? null) === (z.grund ?? null)) {
      letzte.bis = z.date; letzte.tage++;
    } else {
      spannen.push({ ...person(z), von: z.date, bis: z.date, tage: 1,
        von_stunde: z.von_stunde, bis_stunde: z.bis_stunde, grund: z.grund ?? null });
    }
  }
  res.json(spannen.sort((a, b) => a.von.localeCompare(b.von) || a.id - b.id));
});

app.post('/api/absences', auth, (req, res) => {
  const from = req.body?.from, to = req.body?.to || req.body?.from;
  if (!ISO_DATE.test(from ?? '') || !ISO_DATE.test(to ?? '') || to < from)
    return res.status(400).json({ error: 'Zeitraum als JJJJ-MM-TT, Ende nicht vor Beginn' });
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (dates.length >= 365) return res.status(400).json({ error: 'Höchstens 365 Tage am Stück' });
    dates.push(d);
  }
  // Stundenweise: leer heisst weiterhin "ganzer Tag". Ein Bereich je Tag reicht - "die ersten
  // beiden" oder "ab der fuenften" ist der Fall, zwei getrennte Bloecke am selben Tag nicht.
  // Nur "ab 5." heisst: bis zum Ende des Tages; nur "bis 2." heisst: ab der ersten Stunde.
  // Vorher wurde ein fehlendes Feld still zum ganzen Tag - genau das hat niemand gemeint.
  const letzte = periodsFuer(schuleVon(req.user.id).id).reduce((m, p) => Math.max(m, p.nr), 0) || null;
  const vonRoh = Number(req.body?.von_stunde) || null, bisRoh = Number(req.body?.bis_stunde) || null;
  const vonStd = vonRoh ?? (bisRoh ? 1 : null);
  const bisStd = bisRoh ?? (vonRoh ? (letzte ?? vonRoh) : null);
  if (vonStd && bisStd < vonStd)
    return res.status(400).json({ error: 'Die letzte Stunde liegt vor der ersten' });

  // Der Grund ist eine Notiz fuer einen selbst - Freunde sehen ihn nur mit dem Haken.
  const grund = String(req.body?.grund ?? '').trim().slice(0, 120) || null;
  const sichtbar = grund && req.body?.grund_sichtbar ? 1 : 0;
  const ins = db.prepare(`INSERT INTO absences(user_id, date, von_stunde, bis_stunde, grund, grund_sichtbar)
    VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, date)
    DO UPDATE SET von_stunde = excluded.von_stunde, bis_stunde = excluded.bis_stunde,
      grund = excluded.grund, grund_sichtbar = excluded.grund_sichtbar`);
  for (const d of dates) ins.run(req.user.id, d, vonStd, bisStd, grund, sichtbar);
  res.json({ dates, von: vonStd, bis: bisStd, grund, grund_sichtbar: sichtbar === 1 });
});

app.delete('/api/absences/:date', auth, (req, res) => {
  db.prepare('DELETE FROM absences WHERE user_id = ? AND date = ?').run(req.user.id, req.params.date);
  res.json({ ok: true });
});

/**
 * Wie viele Hausaufgaben noch offen sind - fuer die rote Zahl am Reiter.
 *
 * Gezaehlt wird, was ab heute faellig und nicht abgehakt ist; Vergangenes zaehlt nicht mit, sonst
 * stuende dort auf ewig eine Zahl, die niemand mehr kleinkriegt.
 */
app.get('/api/homework/offen', auth, (req, res) => {
  if (req.user.hw_badge === 0) return res.json({ n: 0, hausaufgaben: 0, todos: 0 });
  const heute = new Date().toISOString().slice(0, 10);
  const kurse = db.prepare(MEINE_KURSE).all(req.user.id, req.user.id).map(r => r.course_id);
  const hausaufgaben = [...homeworkFuer(req.user.id, kurse, heute, addDays(heute, 400)),
    ...untisHausaufgaben(req.user.id, heute, addDays(heute, 400))].filter(h => !h.done).length;
  // ToDos: alle offenen, auch ohne Frist - nur geparkte nicht, die sind noch nicht dran. (Erst
  // zaehlten nur faellige; das kam den Leuten wie "kein Punkt" vor.)
  const ids = [...meineOrdner(req.user.id).keys()];
  const platz = ids.map(() => '?').join(',') || '0';
  // Im Projekt zaehlt nur, was niemandem zugewiesen ist - oder mir. Was nur andere (oder nur freie
  // Namen ohne Konto) haben, muss ich nicht erledigen.
  const todos = db.prepare(`SELECT count(*) n FROM todos t
    WHERE (t.user_id = ? OR t.ordner_id IN (${platz})) AND t.done = 0
      AND (t.sichtbar_ab IS NULL OR t.sichtbar_ab <= ?)
      AND (t.ordner_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM todo_zustaendige z WHERE z.todo_id = t.id)
        OR EXISTS (SELECT 1 FROM todo_zustaendige z WHERE z.todo_id = t.id AND z.user_id = ?))`)
    .get(req.user.id, ...ids, alsLokal(new Date()), req.user.id).n;
  res.json({ n: hausaufgaben + todos, hausaufgaben, todos });
});

// --- Raumplan ----------------------------------------------------------------
// Ein Plan je Schule, als JSON in `schools`. Gebaut vom Admin; sichtbar fuer alle erst nach der
// Freigabe - vorher zum Testen nur fuer Admins. Die Wegsuche laeuft im Browser (raumplan.js).

app.get('/api/raumplan', auth, (req, res) => {
  const schule = schuleVon(req.user.id);
  const frei = schule.raumplan_frei === 1;
  let plan = null;
  if (schule.raumplan && (frei || req.user.is_admin === 1)) {
    try { plan = raumplanSaeubern(JSON.parse(schule.raumplan)); } catch { plan = null; }
  }
  res.json({ plan, frei });
});

app.put('/api/raumplan', auth, admin, (req, res) => {
  if (!req.body?.plan || typeof req.body.plan !== 'object' || !Array.isArray(req.body.plan.etagen))
    return res.status(400).json({ error: 'Ein Plan braucht Etagen' });
  const plan = raumplanSaeubern(req.body.plan);
  const frei = req.body.frei ? 1 : 0;
  db.prepare('UPDATE schools SET raumplan = ?, raumplan_frei = ? WHERE id = ?')
    .run(JSON.stringify(plan), frei, schuleVon(req.user.id).id);
  res.json({ plan, frei: !!frei });
});

// --- Nachrichten der Schule ----------------------------------------------------
// "Nachrichten zum Tag" von der Heute-Seite und der RSS-Feed - beides schulweit. Einfuegen mit
// Nachziehen: geaendert wird uebernommen, geloescht bleibt stehen (ein Feed vergisst, wir nicht).

const nachrichtSetzen = db.prepare(`INSERT INTO nachrichten
  (school_id, quelle, ext_id, datum, titel, text, link, created_at)
  VALUES(?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(school_id, quelle, ext_id) DO UPDATE SET titel = excluded.titel, text = excluded.text`);

async function feedHolen(schule) {
  if (!schule.rss_url) return 0;
  const adresse = netzOhneSchema(schule.rss_url);
  if (!hostOk(adresse) || !(await adresseErlaubt(adresse)))
    throw new Error('Die Feed-Adresse führt nicht ins offene Netz');
  const res = await holeGeprueft(schule.rss_url, {
    headers: { ...NETZ_KOPF, accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(15_000),
  }).catch(e => { throw new Error(/offene Netz|Weiterleitungen/.test(e.message) ? e.message : 'Der Feed ist nicht erreichbar'); });
  if (!res.ok) throw new Error(`Der Feed antwortet mit ${res.status}`);
  const eintraege = rssLese((await res.text()).slice(0, 2_000_000));
  const heute = new Date().toISOString().slice(0, 10);
  for (const e of eintraege)
    nachrichtSetzen.run(schule.id, 'rss', e.id, e.datum ?? heute, e.titel, e.text || null, e.link);
  return eintraege.length;
}

/** Hoechstens stuendlich je Schule: die Tagesnachrichten der naechsten Woche, dann der Feed. */
async function nachrichtenHolen(schule, sitzung) {
  const frisch = db.prepare(`SELECT 1 FROM schools WHERE id = ?
    AND nachrichten_geholt > datetime('now', '-60 minutes')`).get(schule.id);
  if (frisch) return;
  db.prepare("UPDATE schools SET nachrichten_geholt = datetime('now') WHERE id = ?").run(schule.id);

  const heute = new Date().toISOString().slice(0, 10);
  let rssUrl = null;
  for (let i = 0; i < 7; i++) {
    const tag = addDays(heute, i);
    const { nachrichten, rssUrl: gemeldet } = await tagesNachrichten(sitzung, tag).catch(() => ({ nachrichten: [] }));
    rssUrl ??= gemeldet ?? null;
    for (const n of nachrichten) nachrichtSetzen.run(schule.id, 'untis', n.id, tag, n.titel, n.text || null, null);
  }
  // Die Feed-Adresse merkt sich die Schule beim ersten Fund - der Admin muss sie nicht suchen.
  if (rssUrl && !schule.rss_url) {
    db.prepare('UPDATE schools SET rss_url = ? WHERE id = ? AND rss_url IS NULL').run(rssUrl, schule.id);
    schule = { ...schule, rss_url: rssUrl };
  }
  await feedHolen(schule);
}

app.get('/api/nachrichten', auth, (req, res) => {
  const schule = schuleVon(req.user.id);
  const ab = addDays(new Date().toISOString().slice(0, 10), -60);
  res.json(db.prepare(`SELECT id, quelle, datum, titel, text, link FROM nachrichten
    WHERE school_id = ? AND datum >= ? ORDER BY datum DESC, id DESC LIMIT 100`).all(schule.id, ab));
});

// --- Kalender ----------------------------------------------------------------
// Termine, Pruefungen und abonnierte Kalender liegen in denselben zwei Tabellen; Hausaufgaben
// werden als Ebene daruebergelegt, statt sie zu kopieren. Eine Pruefung ist ein Termin mit
// anderer Art - und mit Schulstunden, damit der Plan sie markieren kann.

const KAL_SPALTEN = 'id, user_id, name, farbe, quelle, ical_url, letzter_sync, sync_fehler, sichtbar';

// Die Vorgabefarben: dieselben, die der Plan schon benutzt. Wer sie aendert, aendert sie fuer sich.
const KAL_FARBEN = { hausaufgabe: '#d98b2b', pruefung: '#d95f5f', termin: '#3b82d6', ferien: '#6fb36f' };
// Ebenen, die sich ausblenden lassen (Kalender haben dafuer ihre id in `aus`).
const KAL_EBENEN = ['ferien'];

// Die Farben der Stundenzustaende - die Vorgaben sind die, die der Plan immer hatte: Ausfall rot,
// alles "heute anders" bernsteinfarben. Wer sie aendert, aendert sie fuer sich.
const STATUS_FARBEN = { entfaellt: '#c0392b', vertretung: '#d98b2b', ohne_lehrer: '#d98b2b', raum: '#d98b2b',
  // Eine Pruefung: fett gelb umrandet, damit sie im Plan nicht zu uebersehen ist.
  pruefung: '#f5c400' };

function statusFarben(u) {
  let roh = {};
  try { roh = JSON.parse(u?.status_farben ?? '{}') ?? {}; } catch { roh = {}; }
  const farben = { ...STATUS_FARBEN };
  for (const [k, v] of Object.entries(roh)) if (k in STATUS_FARBEN && HEX.test(String(v))) farben[k] = v;
  return farben;
}

/** Die Ansicht-Einstellungen eines Nutzers: Farben der Ebenen und ausgeblendete Kalender. */
function kalAnsicht(u) {
  let roh = {};
  try { roh = JSON.parse(u?.kalender_farben ?? '{}') ?? {}; } catch { roh = {}; }
  const farben = { ...KAL_FARBEN };
  for (const [k, v] of Object.entries(roh.farben ?? {}))
    if (k in KAL_FARBEN && HEX.test(String(v))) farben[k] = v;
  return { farben, aus: (Array.isArray(roh.aus) ? roh.aus : []).map(Number).filter(Boolean),
    ohne: (Array.isArray(roh.ohne) ? roh.ohne : []).filter(k => KAL_EBENEN.includes(k)) };
}

/**
 * Alle Kalender, die jemand sehen darf: die eigenen, die mit ihm geteilten und die schulweiten.
 *
 * Schulweit heisst user_id IS NULL - sichtbar fuer alle, aenderbar nur fuer Admins. Ausblenden
 * kann sie jeder fuer sich (`aus` in der Ansicht), ohne sie jemandem wegzunehmen.
 */
function kalenderFuer(userId, istAdmin = false) {
  const eigene = db.prepare(`SELECT ${KAL_SPALTEN}, 1 AS darf_aendern, 0 AS geteilt
    FROM kalender WHERE user_id = ?`).all(userId);
  const geteilt = db.prepare(`SELECT ${KAL_SPALTEN.split(', ').map(c => 'k.' + c).join(', ')},
      g.darf_aendern, 1 AS geteilt
    FROM kalender k JOIN kalender_geteilt g ON g.kalender_id = k.id WHERE g.user_id = ?`).all(userId);
  const schule = db.prepare(`SELECT ${KAL_SPALTEN}, ? AS darf_aendern, 0 AS geteilt
    FROM kalender WHERE user_id IS NULL`).all(istAdmin ? 1 : 0);
  // Die Abo-Adresse ist oft ein geheimer Link (Google "privat") - sie sieht nur, wem der Kalender gehoert.
  return [...eigene, ...geteilt.map(k => ({ ...k, ical_url: null })),
    ...schule.map(k => (istAdmin ? k : { ...k, ical_url: null }))];
}

/** Jeder bekommt beim ersten Blick seinen eigenen Kalender - sonst gaebe es nichts einzutragen. */
function standardKalender(userId) {
  const da = db.prepare("SELECT * FROM kalender WHERE user_id = ? AND quelle = 'eigen' ORDER BY id LIMIT 1")
    .get(userId);
  if (da) return da;
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO kalender(user_id, name, farbe, quelle, created_at)
     VALUES(?, 'Mein Kalender', ?, 'eigen', datetime('now'))`).run(userId, KAL_FARBEN.termin);
  return db.prepare('SELECT * FROM kalender WHERE id = ?').get(Number(lastInsertRowid));
}

// --- Pruefungen aus WebUntis: nur auf Knopfdruck ----------------------------
// Uebernommen wird in den eigenen Kalender - danach sind es eigene Eintraege: aenderbar,
// loeschbar, mit Erinnerung und einer festen ID. Die uid 'untis-exam-…' verraet die Herkunft und
// verhindert Doppelte beim naechsten Import.

/** Die Stunde, in der eine Pruefung endet: die letzte, die vor dem Ende beginnt. */
const endStunde = (perioden, ende) => [...perioden].reverse().find(p => p.start_time < ende) ?? null;

/** Was WebUntis liefert, in die Form fuer pruefungenUebernehmen - mit Schulstunden fuer den Plan. */
export const untisPruefungsListe = (roh, perioden) => roh.filter(pr => pr?.date).map(pr => {
  const a = passendeStunde(perioden, pr.start);
  const e = endStunde(perioden, pr.end) ?? a;
  const bisNr = Math.max(e?.nr ?? a?.nr ?? 0, a?.nr ?? 0) || null;
  return {
    uid: pr.untis_id ? `untis-exam-${pr.untis_id}` : `untis-exam-${pr.date}-${pr.start}-${pr.fach ?? ''}`,
    titel: [pr.fach, pr.titel].filter(Boolean).join(': ').slice(0, 200), fach: pr.fach ?? null,
    von: `${pr.date} ${a?.start_time ?? pr.start}`, bis: `${pr.date} ${e?.end_time ?? pr.end}`,
    von_stunde: a?.nr ?? null, bis_stunde: bisNr,
  };
});

/**
 * Ist das dieselbe Pruefung? Gleicher Tag, und dann: ueberschneidende Stunden - oder, wo die
 * fehlen, ueberschneidende Uhrzeiten - oder, wo auch die fehlen, das Fach als Wort im Titel oder
 * als Fach des Kurses. Zwei Pruefungen zur selben Zeit schreibt niemand.
 */
export function gleichePruefung(m, pr) {
  if (String(m.von).slice(0, 10) !== String(pr.von).slice(0, 10)) return false;
  if (m.von_stunde && pr.von_stunde)
    return m.von_stunde <= (pr.bis_stunde ?? pr.von_stunde) && pr.von_stunde <= (m.bis_stunde ?? m.von_stunde);
  const mitZeit = x => !x.ganztags && String(x.von).length > 10;
  if (mitZeit(m) && mitZeit(pr)) return m.von < (pr.bis ?? pr.von) && pr.von < (m.bis ?? m.von);
  const fach = String(pr.fach ?? '').trim().toLowerCase();
  if (!fach) return false;
  const wort = new RegExp(`(^|[^\\p{L}\\p{N}])${fach.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u');
  return [m.titel, m.fach_name, m.fach_kurz, m.course_id].some(t => t && wort.test(String(t).toLowerCase()));
}

/**
 * Pruefungen in den eigenen Kalender uebernehmen.
 *
 * - schon importiert (dieselbe uid): nur das WANN nachziehen - Titel, Notiz und Erinnerung hat der
 *   Nutzer vielleicht geaendert, die bleiben.
 * - selbst geloescht: ueberspringen (ausser `auchGeloeschte`).
 * - schon selbst eingetragen: `regel` 'meine' laesst sie stehen, 'untis' uebernimmt Titel und Zeit
 *   von WebUntis in die eigene Zeile (Notiz, Erinnerung, "fuer den Kurs" bleiben).
 */
export function pruefungenUebernehmen(userId, liste, { regel = 'meine', auchGeloeschte = false } = {}) {
  const kal = standardKalender(userId);
  if (auchGeloeschte) db.prepare('DELETE FROM untis_pruefung_weg WHERE user_id = ?').run(userId);
  const weg = new Set(db.prepare('SELECT uid FROM untis_pruefung_weg WHERE user_id = ?').all(userId).map(r => r.uid));
  // Alle eigenen Pruefungen - aus jedem eigenen Kalender, nicht nur dem Standard. Der alte
  // automatische Kalender ('untis') zaehlt nicht: aus ihm wird gerade uebernommen.
  const meine = db.prepare(`SELECT e.*, s.name AS fach_name, s.short AS fach_kurz
    FROM kalender_eintraege e JOIN kalender k ON k.id = e.kalender_id
    LEFT JOIN courses c ON c.id = e.course_id LEFT JOIN subjects s ON s.id = c.subject_id
    WHERE k.user_id = ? AND k.quelle <> 'untis' AND e.art = 'pruefung'`).all(userId);
  const ergebnis = { neu: 0, aktualisiert: 0, doppelt: 0, geloescht: 0 };
  const wann = db.prepare('UPDATE kalender_eintraege SET von = ?, bis = ?, von_stunde = ?, bis_stunde = ? WHERE id = ?');
  const ganz = db.prepare(`UPDATE kalender_eintraege SET titel = ?, von = ?, bis = ?, von_stunde = ?, bis_stunde = ?,
    ganztags = 0, uid = ? WHERE id = ?`);
  const ein = db.prepare(`INSERT INTO kalender_eintraege
    (kalender_id, uid, titel, von, bis, ganztags, art, von_stunde, bis_stunde, created_at)
    VALUES(?, ?, ?, ?, ?, 0, 'pruefung', ?, ?, datetime('now'))`);
  transaktion(() => {
    for (const pr of liste) {
      if (weg.has(pr.uid)) { ergebnis.geloescht++; continue; }
      const schon = meine.find(m => m.uid === pr.uid);
      if (schon) {
        if (schon.von !== pr.von || schon.bis !== pr.bis || schon.von_stunde !== pr.von_stunde
            || schon.bis_stunde !== pr.bis_stunde) {
          wann.run(pr.von, pr.bis, pr.von_stunde, pr.bis_stunde, schon.id);
          ergebnis.aktualisiert++;
        }
        continue;
      }
      const gleich = meine.find(m => !String(m.uid ?? '').startsWith('untis-exam-') && gleichePruefung(m, pr));
      if (gleich) {
        if (regel !== 'untis') { ergebnis.doppelt++; continue; }
        ganz.run(pr.titel, pr.von, pr.bis, pr.von_stunde, pr.bis_stunde, pr.uid, gleich.id);
        gleich.uid = pr.uid;
        ergebnis.aktualisiert++;
        continue;
      }
      ein.run(kal.id, pr.uid, pr.titel, pr.von, pr.bis, pr.von_stunde, pr.bis_stunde);
      ergebnis.neu++;
    }
  });
  return ergebnis;
}

/**
 * Einmalig: die alten, automatisch gefuellten Kalender "Pruefungen (Schule)" in den eigenen
 * Kalender uebernehmen (Doppelte bleiben draussen) und dann loeschen. So verschwindet beim Update
 * nichts, was man vorher sah - und die Erinnerungen, die schon kamen, kommen nicht noch einmal.
 */
export function altePruefungskalenderUebernehmen() {
  for (const kal of db.prepare("SELECT * FROM kalender WHERE quelle = 'untis'").all()) {
    const alt = db.prepare("SELECT * FROM kalender_eintraege WHERE kalender_id = ? AND art = 'pruefung'").all(kal.id);
    const liste = alt.map(e => ({
      uid: e.uid ?? `untis-exam-alt-${e.id}`, titel: e.titel,
      fach: e.titel.includes(':') ? e.titel.split(':')[0].trim() : null,
      von: e.von, bis: e.bis, von_stunde: e.von_stunde, bis_stunde: e.bis_stunde,
    }));
    if (kal.user_id) {
      const erinnert = db.prepare(`SELECT p.user_id, e.uid, e.id FROM pruefung_erinnert p
        JOIN kalender_eintraege e ON e.id = p.eintrag_id WHERE e.kalender_id = ?`).all(kal.id);
      pruefungenUebernehmen(kal.user_id, liste, { regel: 'meine' });
      for (const r of erinnert) {
        const neu = db.prepare(`SELECT e.id FROM kalender_eintraege e JOIN kalender k ON k.id = e.kalender_id
          WHERE k.user_id = ? AND e.uid = ?`).get(kal.user_id, r.uid ?? `untis-exam-alt-${r.id}`);
        if (neu) db.prepare('INSERT OR IGNORE INTO pruefung_erinnert(user_id, eintrag_id) VALUES(?, ?)').run(r.user_id, neu.id);
      }
    }
    db.prepare('DELETE FROM kalender_eintraege WHERE kalender_id = ?').run(kal.id);
    db.prepare('DELETE FROM kalender WHERE id = ?').run(kal.id);
  }
}

const kalDarf = (userId, kalId, istAdmin = false) =>
  kalenderFuer(userId, istAdmin).find(k => k.id === (Number(kalId) || 0));

const ISO_TAG = /^\d{4}-\d{2}-\d{2}$/;
const tagOder = (wert, ersatz) => (ISO_TAG.test(String(wert ?? '')) ? String(wert) : ersatz);

/** Ein Eintrag, wie ihn die Oberflaeche braucht - mit Farbe und Herkunft. */
const eintragZeile = (r, kal, ansicht) => ({
  id: r.id, kalender_id: r.kalender_id, kalender: kal?.name ?? '', titel: r.titel,
  ort: r.ort, text: r.text, von: r.von, bis: r.bis, ganztags: !!r.ganztags, art: r.art,
  course_id: r.course_id, von_stunde: r.von_stunde, bis_stunde: r.bis_stunde,
  fuer_kurs: !!r.fuer_kurs, erinnerung_tage: r.erinnerung_tage ?? null,
  quelle: kal?.quelle ?? 'eigen',
  aus_untis: String(r.uid ?? '').startsWith('untis-exam-'),
  darf_aendern: !!kal?.darf_aendern && kal?.quelle !== 'abo' && kal?.quelle !== 'untis',
  farbe: r.art === 'pruefung' ? ansicht.farben.pruefung : (kal?.farbe || ansicht.farben.termin),
});

/**
 * Alles, was in einem Zeitraum ansteht - Termine, Pruefungen UND Hausaufgaben.
 *
 * Die Hausaufgaben werden nicht in den Kalender kopiert, sondern als Ebene darueber gelegt: sonst
 * gaebe es sie zweimal und zwei Wege, sie abzuhaken.
 */
function kalenderEintraege(u, von, bis, { nurPruefungen = false } = {}) {
  // Auch hier: wer noch keinen eigenen Kalender hat, bekommt ihn. Sonst gaebe es beim ersten Blick
  // nichts, in das sich etwas eintragen liesse.
  standardKalender(u.id);
  const ansicht = kalAnsicht(u);
  const kal = kalenderFuer(u.id, u.is_admin === 1);
  const sichtbar = kal.filter(k => k.sichtbar && !ansicht.aus.includes(k.id));
  const nach = new Map(sichtbar.map(k => [k.id, k]));

  const raus = [];
  if (nach.size) {
    const platz = [...nach.keys()].map(() => '?').join(',');
    for (const r of db.prepare(`SELECT * FROM kalender_eintraege
        WHERE kalender_id IN (${platz}) AND substr(von, 1, 10) <= ?
          AND substr(COALESCE(bis, von), 1, 10) >= ?${nurPruefungen ? " AND art = 'pruefung'" : ''}
        ORDER BY von`).all(...nach.keys(), bis, von))
      raus.push(eintragZeile(r, nach.get(r.kalender_id), ansicht));
  }

  // Pruefungen, die Mitschueler fuer den ganzen Kurs eingetragen haben - nur ansehen.
  for (const r of kursPruefungen(u.id, von, bis)) {
    raus.push({
      ...eintragZeile(r, { name: 'Prüfungen (Kurs)', quelle: 'kurs', darf_aendern: 0 }, ansicht),
      quelle: 'kurs', darf_aendern: false, von_name: r.von_name,
    });
  }
  if (nurPruefungen) return { eintraege: raus };

  // Hausaufgaben als ganztaegige Eintraege - eigene und die von der Schule.
  const kurse = db.prepare(MEINE_KURSE).all(u.id, u.id).map(r => r.course_id);
  const hwAb = hwVon(u, von);
  const hw = [...homeworkFuer(u.id, kurse, hwAb, bis), ...untisHausaufgaben(u.id, hwAb, bis)];
  for (const h of hw) {
    raus.push({
      id: `hw${h.id}`, kalender_id: null, kalender: 'Hausaufgaben',
      titel: `${h.subject_short || h.subject || h.course_id}: ${h.text}`,
      ort: null, text: null, von: h.due_date, bis: h.due_date, ganztags: true,
      art: 'hausaufgabe', quelle: 'hausaufgabe', darf_aendern: false,
      erledigt: !!h.done, farbe: ansicht.farben.hausaufgabe,
    });
  }
  // Ferien und Feiertage der eigenen Schule - ganztaegig, nur ansehen, abschaltbar.
  if (!ansicht.ohne.includes('ferien')) {
    for (const f of db.prepare(`SELECT von, bis, name FROM holidays
        WHERE school_id = ? AND von <= ? AND bis >= ? ORDER BY von`).all(schuleVon(u.id).id, bis, von)) {
      raus.push({
        id: `fe${f.von}`, kalender_id: null, kalender: 'Ferien', titel: f.name,
        ort: null, text: null, von: f.von, bis: f.bis, ganztags: true,
        art: 'ferien', quelle: 'ferien', darf_aendern: false, farbe: ansicht.farben.ferien,
      });
    }
  }
  return { kalender: kal, farben: ansicht.farben, aus: ansicht.aus, ohne: ansicht.ohne, eintraege: raus };
}

/**
 * Vor Pruefungen erinnern - je Nutzer nach seinen Tagen (Profil), je Pruefung ueberschreibbar.
 *
 * Laeuft im Zehn-Minuten-Takt ueber alles, was der Nutzer im Kalender sieht: eigene, geteilte,
 * Kurs- und Schulpruefungen. Jede Pruefung genau einmal (pruefung_erinnert); Vergangenes nie.
 */
export function pruefungsErinnerungen() {
  const heute = new Date().toISOString().slice(0, 10);
  const bis = addDays(heute, 60);
  const schon = db.prepare('SELECT 1 FROM pruefung_erinnert WHERE user_id = ? AND eintrag_id = ?');
  const merk = db.prepare('INSERT OR IGNORE INTO pruefung_erinnert(user_id, eintrag_id) VALUES(?, ?)');
  // Alle zehn Minuten fuer jeden: nur Pruefungen, und die Nutzer ohne ihre Bilder.
  for (const u of db.prepare(`SELECT ${OHNE_BILDER} FROM users u`).all()) {
    const vorgabe = Number(u.pruefung_vorlauf_tage) || 0;
    let eintraege;
    try { eintraege = kalenderEintraege(u, heute, bis, { nurPruefungen: true }).eintraege; } catch { continue; }
    for (const e of eintraege) {
      if (e.art !== 'pruefung' || typeof e.id !== 'number') continue;
      // Die Tage an der Pruefung selbst gelten fuer den, dem der Kalender gehoert (und wer ihn
      // teilt) - eine Kurs-Pruefung erinnert jeden nach seiner eigenen Vorgabe.
      const tage = e.quelle === 'eigen' && e.erinnerung_tage != null ? e.erinnerung_tage : vorgabe;
      const datum = e.von.slice(0, 10);
      if (!tage || datum < heute || addDays(datum, -tage) > heute) continue;
      if (schon.get(u.id, e.id)) continue;
      merk.run(u.id, e.id);
      const inTagen = Math.round((new Date(datum) - new Date(heute)) / 86_400_000);
      const stunden = e.von_stunde
        ? ` · ${e.von_stunde}.${e.bis_stunde && e.bis_stunde !== e.von_stunde ? `–${e.bis_stunde}.` : ''} Stunde` : '';
      benachrichtige(u.id, 'pruefung',
        inTagen === 0 ? `Heute: ${e.titel}` : inTagen === 1 ? `Morgen: ${e.titel}` : `Prüfung in ${inTagen} Tagen: ${e.titel}`,
        tagKurz(datum) + stunden + (e.von_name ? ` · von ${e.von_name}` : ''), '/');
    }
  }
}

app.get('/api/kalender', auth, (req, res) => {
  standardKalender(req.user.id);
  const ansicht = kalAnsicht(req.user);
  res.json({ kalender: kalenderFuer(req.user.id, req.user.is_admin === 1), ...ansicht });
});

app.post('/api/kalender', auth, bremse('kalender', 20), async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name nötig' });
  const url = String(req.body?.ical_url ?? '').trim();
  // Ein schulweiter Kalender ist Adminsache: er landet bei allen.
  const schulweit = !!req.body?.schulweit && req.user.is_admin === 1;

  if (url) {
    if (!/^https:\/\//i.test(url) || !hostOk(netzOhneSchema(url)))
      return res.status(400).json({ error: 'Nur https, und keine Adresse aus dem internen Netz' });
    if (!(await adresseErlaubt(netzOhneSchema(url))))
      return res.status(400).json({ error: 'Diese Adresse führt nicht ins offene Netz' });
  }
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO kalender(user_id, name, farbe, quelle, ical_url, created_at)
     VALUES(?, ?, ?, ?, ?, datetime('now'))`)
    .run(schulweit ? null : req.user.id, name,
      HEX.test(req.body?.farbe ?? '') ? req.body.farbe : KAL_FARBEN.termin,
      url ? 'abo' : (schulweit ? 'schule' : 'eigen'), url || null);
  const neu = db.prepare('SELECT * FROM kalender WHERE id = ?').get(Number(lastInsertRowid));
  if (url) abonnementHolen(neu).catch(() => {});
  res.status(201).json(neu);
});

app.patch('/api/kalender/:id', auth, (req, res) => {
  const k = kalDarf(req.user.id, req.params.id, req.user.is_admin === 1);
  if (!k) return res.status(404).json({ error: 'Kalender nicht gefunden' });
  const b = req.body ?? {};
  // Sichtbarkeit ist Ansichtssache und gilt nur fuer den, der sie setzt - deshalb nicht an der
  // Zeile, sondern in der eigenen Ansicht.
  if ('sichtbar' in b && (k.user_id !== req.user.id)) {
    const ansicht = kalAnsicht(req.user);
    const aus = new Set(ansicht.aus);
    if (b.sichtbar) aus.delete(k.id); else aus.add(k.id);
    db.prepare('UPDATE users SET kalender_farben = ? WHERE id = ?')
      .run(JSON.stringify({ farben: ansicht.farben, aus: [...aus], ohne: ansicht.ohne }), req.user.id);
    return res.json({ ok: true });
  }
  if (!k.darf_aendern) return res.status(403).json({ error: 'Nur ansehen' });

  const sets = [], args = [];
  if ('name' in b) { sets.push('name = ?'); args.push(String(b.name).trim().slice(0, 60) || k.name); }
  if ('farbe' in b && HEX.test(String(b.farbe))) { sets.push('farbe = ?'); args.push(b.farbe); }
  if ('sichtbar' in b) { sets.push('sichtbar = ?'); args.push(b.sichtbar ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true });
  db.prepare(`UPDATE kalender SET ${sets.join(', ')} WHERE id = ?`).run(...args, k.id);
  res.json(db.prepare('SELECT * FROM kalender WHERE id = ?').get(k.id));
});

app.delete('/api/kalender/:id', auth, (req, res) => {
  const id = Number(req.params.id) || 0;
  const eigen = db.prepare('SELECT * FROM kalender WHERE id = ? AND user_id = ?').get(id, req.user.id);
  const schulweit = db.prepare('SELECT * FROM kalender WHERE id = ? AND user_id IS NULL').get(id);
  if (!eigen && !(schulweit && req.user.is_admin === 1))
    return res.status(404).json({ error: 'Kalender nicht gefunden' });
  // sql.js/node:sqlite raeumen CASCADE nicht immer zuverlaessig - von Hand ist es sicher.
  db.prepare('DELETE FROM kalender_geteilt WHERE kalender_id = ?').run(id);
  db.prepare('DELETE FROM kalender_eintraege WHERE kalender_id = ?').run(id);
  db.prepare('DELETE FROM kalender WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** Teilen - mit Freunden, wie ueberall in der App. */
app.post('/api/kalender/:id/teilen', auth, (req, res) => {
  const k = db.prepare('SELECT * FROM kalender WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id) || 0, req.user.id);
  if (!k) return res.status(404).json({ error: 'Kalender nicht gefunden' });
  const wen = Number(req.body?.user_id) || 0;
  if (!istFreund(req.user.id, wen)) return res.status(403).json({ error: 'Teilen geht nur mit Freunden' });
  db.prepare(`INSERT INTO kalender_geteilt(kalender_id, user_id, darf_aendern) VALUES(?, ?, ?)
              ON CONFLICT(kalender_id, user_id) DO UPDATE SET darf_aendern = excluded.darf_aendern`)
    .run(k.id, wen, req.body?.darf_aendern ? 1 : 0);
  benachrichtige(wen, 'todo', `${nameVon(req.user)} teilt einen Kalender mit dir`, k.name, '/');
  res.status(201).json({ ok: true });
});

app.delete('/api/kalender/:id/teilen/:wen', auth, (req, res) => {
  const id = Number(req.params.id) || 0, wen = Number(req.params.wen) || 0;
  const meiner = db.prepare('SELECT 1 FROM kalender WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!meiner && wen !== req.user.id) return res.status(403).json({ error: 'Nicht dein Kalender' });
  db.prepare('DELETE FROM kalender_geteilt WHERE kalender_id = ? AND user_id = ?').run(id, wen);
  res.json({ ok: true });
});

app.get('/api/kalender/geteilt/:id', auth, (req, res) => {
  const k = db.prepare('SELECT * FROM kalender WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id) || 0, req.user.id);
  if (!k) return res.status(404).json({ error: 'Kalender nicht gefunden' });
  res.json(db.prepare(`SELECT ${USER_COLS}, g.darf_aendern FROM kalender_geteilt g
    JOIN users u ON u.id = g.user_id WHERE g.kalender_id = ?`).all(k.id)
    .map(r => ({ ...person(r), darf_aendern: !!r.darf_aendern })));
});

app.get('/api/kalender/eintraege', auth, (req, res) => {
  const heute = new Date().toISOString().slice(0, 10);
  const von = tagOder(req.query.von, addDays(heute, -40));
  const bis = tagOder(req.query.bis, addDays(heute, 200));
  res.json(kalenderEintraege(req.user, von, bis));
});

/**
 * Einen Termin anlegen. Bei einer Pruefung rechnet der Server die Uhrzeiten aus dem Raster der
 * eigenen Schule - eingetragen wird sie schliesslich aus einer Schulstunde heraus.
 */
app.post('/api/kalender/:id/eintraege', auth, (req, res) => {
  const k = kalDarf(req.user.id, req.params.id, req.user.is_admin === 1);
  if (!k) return res.status(404).json({ error: 'Kalender nicht gefunden' });
  if (!k.darf_aendern || k.quelle === 'abo' || k.quelle === 'untis')
    return res.status(403).json({ error: 'In diesen Kalender kannst du nicht schreiben' });

  const daten = eintragDaten(req.body, req.user);
  if (daten.error) return res.status(400).json({ error: daten.error });
  const { lastInsertRowid } = db.prepare(`INSERT INTO kalender_eintraege
      (kalender_id, titel, ort, text, von, bis, ganztags, art, course_id, von_stunde, bis_stunde,
       fuer_kurs, erinnerung_tage, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(k.id, daten.titel, daten.ort, daten.text, daten.von, daten.bis, daten.ganztags,
      daten.art, daten.course_id, daten.von_stunde, daten.bis_stunde, daten.fuer_kurs, daten.erinnerung_tage);
  res.status(201).json(db.prepare('SELECT * FROM kalender_eintraege WHERE id = ?')
    .get(Number(lastInsertRowid)));
});

app.patch('/api/kalender/eintraege/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM kalender_eintraege WHERE id = ?').get(Number(req.params.id) || 0);
  const k = e && kalDarf(req.user.id, e.kalender_id, req.user.is_admin === 1);
  if (!e || !k) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (!k.darf_aendern) return res.status(403).json({ error: 'Nur ansehen' });

  const daten = eintragDaten({ ...e, ...req.body }, req.user);
  if (daten.error) return res.status(400).json({ error: daten.error });
  db.prepare(`UPDATE kalender_eintraege SET titel = ?, ort = ?, text = ?, von = ?, bis = ?,
      ganztags = ?, art = ?, course_id = ?, von_stunde = ?, bis_stunde = ?, fuer_kurs = ?,
      erinnerung_tage = ? WHERE id = ?`)
    .run(daten.titel, daten.ort, daten.text, daten.von, daten.bis, daten.ganztags, daten.art,
      daten.course_id, daten.von_stunde, daten.bis_stunde, daten.fuer_kurs, daten.erinnerung_tage, e.id);
  res.json(db.prepare('SELECT * FROM kalender_eintraege WHERE id = ?').get(e.id));
});

app.delete('/api/kalender/eintraege/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM kalender_eintraege WHERE id = ?').get(Number(req.params.id) || 0);
  const k = e && kalDarf(req.user.id, e.kalender_id, req.user.is_admin === 1);
  if (!e || !k) return res.status(404).json({ error: 'Termin nicht gefunden' });
  if (!k.darf_aendern) return res.status(403).json({ error: 'Nur ansehen' });
  db.prepare('DELETE FROM kalender_eintraege WHERE id = ?').run(e.id);
  // Eine aus WebUntis uebernommene Pruefung bleibt geloescht - der naechste Import holt sie nicht
  // zurueck (ausser man will es ausdruecklich).
  if (String(e.uid ?? '').startsWith('untis-exam-'))
    db.prepare('INSERT OR IGNORE INTO untis_pruefung_weg(user_id, uid) VALUES(?, ?)').run(req.user.id, e.uid);
  res.json({ ok: true });
});

app.post('/api/untis/pruefungen/import', auth, bremse('untis-import', 10), async (req, res) => {
  const u = req.user;
  const schule = schuleVon(u.id);
  if (schule.quelle === 'iserv' || !untisAn(u.id))
    return res.status(400).json({ error: 'Prüfungen gibt es nur aus WebUntis – verbinde dich zuerst im Profil' });
  const konto = db.prepare('SELECT * FROM untis_accounts WHERE user_id = ?').get(u.id);
  if (!konto) return res.status(400).json({ error: 'Kein WebUntis-Zugang hinterlegt' });
  try {
    const sitzung = await untisAnmelden(schule.server, schule.school,
      konto.username, zugangsPasswort(konto, sitzungsSchluessel(req)), konto.auth_typ);
    const heute = new Date().toISOString().slice(0, 10);
    let roh;
    try { roh = await untisPruefungen(sitzung, heute, addDays(heute, SYNC_VORAUS)); }
    finally { await logout(sitzung); }
    const liste = untisPruefungsListe(roh ?? [], periodsFuer(schule.id));
    res.json({ gefunden: liste.length, ...pruefungenUebernehmen(u.id, liste, {
      regel: u.pruefung_doppelt === 'untis' ? 'untis' : 'meine', auchGeloeschte: !!req.body?.auch_geloeschte }) });
  } catch (err) {
    res.status(err.status ?? 502).json({ error: kurzerFehler(err) });
  }
});

/** Ein Termin aus dem Formular - gepruefft und in die Schreibweise der Datenbank gebracht. */
function eintragDaten(b, u) {
  const titel = String(b?.titel ?? '').trim().slice(0, 200);
  if (!titel) return { error: 'Titel nötig' };
  const art = b?.art === 'pruefung' ? 'pruefung' : 'termin';
  const ganztags = b?.ganztags ? 1 : 0;
  // Nur Pruefungen erinnern und gelten fuer den Kurs. NULL heisst "wie im Profil", 0 "gar nicht".
  const erinnerung_tage = art !== 'pruefung' || b?.erinnerung_tage == null || b.erinnerung_tage === ''
    ? null : Math.min(Math.max(Math.trunc(Number(b.erinnerung_tage) || 0), 0), 60);

  // Aus dem Stundenplan heraus: Datum plus Stundenbereich. Die Uhrzeiten kommen aus dem Raster
  // der eigenen Schule - dadurch steht die Pruefung im Kalender und im Handy-Abo richtig.
  const stunden = periodsFuer(schuleVon(u.id).id);
  const vonNr = Number(b?.von_stunde) || null;
  const bisNr = Number(b?.bis_stunde) || vonNr;
  if (vonNr) {
    const tag = tagOder(String(b?.von ?? '').slice(0, 10), null);
    if (!tag) return { error: 'Datum nötig' };
    const a = stunden.find(p => p.nr === vonNr), e = stunden.find(p => p.nr === bisNr) ?? a;
    if (!a) return { error: 'Diese Stunde gibt es im Raster nicht' };
    const course_id = b?.course_id ? (kanonischerKurs(b.course_id) ?? String(b.course_id)) : null;
    // Der Raum der Pruefung - er steht dann auch in der Stunde.
    return { titel, ort: String(b?.ort ?? '').slice(0, 200) || null, text: String(b?.text ?? '').slice(0, 2000) || null,
      von: `${tag} ${a.start_time}`, bis: `${tag} ${e.end_time}`, ganztags: 0, art,
      course_id, von_stunde: vonNr, bis_stunde: bisNr, erinnerung_tage,
      // Fuer den Kurs geht nur, was an einem Kurs haengt - sonst wuesste niemand, wer es sehen soll.
      // Und nur mit einem eigenen Kurs - sonst landete die Pruefung in fremden Plaenen.
      fuer_kurs: art === 'pruefung' && course_id && b?.fuer_kurs && hatKurs(u.id, course_id) ? 1 : 0 };
  }

  const von = String(b?.von ?? '').trim().replace('T', ' ').slice(0, 16);
  if (!ISO_TAG.test(von.slice(0, 10))) return { error: 'Beginn als JJJJ-MM-TT nötig' };
  const bis = String(b?.bis ?? '').trim().replace('T', ' ').slice(0, 16) || von;
  return { titel, ort: String(b?.ort ?? '').slice(0, 200) || null,
    text: String(b?.text ?? '').slice(0, 2000) || null,
    von: ganztags ? von.slice(0, 10) : von, bis: ganztags ? bis.slice(0, 10) : bis,
    ganztags, art, course_id: null, von_stunde: null, bis_stunde: null, erinnerung_tage, fuer_kurs: 0 };
}

/**
 * Pruefungen, die andere fuer den ganzen Kurs eingetragen haben - sichtbar wie Hausaufgaben: fuer
 * den, der den Kurs in genau dieser Stunde hat (Wochentag des Datums, Stundenbereich). Die eigenen
 * kommen ueber den eigenen Kalender, deshalb hier nur fremde.
 */
function kursPruefungen(userId, von, bis) {
  return db.prepare(`
    SELECT e.*, u.username, u.display_name
    FROM kalender_eintraege e
    JOIN kalender k ON k.id = e.kalender_id
    JOIN users u ON u.id = k.user_id
    WHERE e.fuer_kurs = 1 AND e.art = 'pruefung' AND e.course_id IS NOT NULL AND k.user_id <> ?
      AND substr(e.von, 1, 10) BETWEEN ? AND ?
      AND EXISTS (
        SELECT 1 FROM (${MEINE_SLOTS}) s
        JOIN periods p ON p.id = s.period_id
        JOIN days d ON d.id = s.day_id
        WHERE s.course_id = e.course_id COLLATE NOCASE
          AND d.iso = CAST(strftime('%u', substr(e.von, 1, 10)) AS INTEGER)
          AND p.nr BETWEEN e.von_stunde AND COALESCE(e.bis_stunde, e.von_stunde))
    ORDER BY e.von`).all(userId, von, bis, userId, userId)
    .map(r => ({ ...r, von_name: r.display_name || r.username }));
}

// --- Abonnierte Kalender -------------------------------------------------------

/**
 * Ein Abo holen und einarbeiten.
 *
 * Ersetzt wird nur, was aus dem Abo stammt (`uid` gesetzt) - von Hand angelegte Termine im selben
 * Kalender bleiben unangetastet. Dasselbe Muster wie beim Ersetzen der Untis-Hausaufgaben.
 */
async function abonnementHolen(kal) {
  if (!kal?.ical_url) return { neu: 0 };
  const adresse = netzOhneSchema(kal.ical_url);
  if (!hostOk(adresse) || !(await adresseErlaubt(adresse)))
    throw new Error('Diese Adresse führt nicht ins offene Netz');

  const res = await holeGeprueft(kal.ical_url, {
    headers: { ...NETZ_KOPF, accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(15_000),
  }).catch(e => { throw new Error(/offene Netz|Weiterleitungen/.test(e.message) ? e.message : 'Der Kalender ist nicht erreichbar'); });
  if (!res.ok) throw new Error(`Der Kalender antwortet mit ${res.status}`);
  const text = (await res.text()).slice(0, 4_000_000);
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Das ist keine Kalenderdatei (.ics)');

  const heute = new Date().toISOString().slice(0, 10);
  const fenster = { von: addDays(heute, -60), bis: addDays(heute, 365) };
  const termine = icsLese(text, fenster);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM kalender_eintraege WHERE kalender_id = ? AND uid IS NOT NULL').run(kal.id);
    const ein = db.prepare(`INSERT INTO kalender_eintraege
      (kalender_id, uid, titel, ort, text, von, bis, ganztags, art, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'termin', datetime('now'))`);
    for (const t of termine)
      ein.run(kal.id, t.uid ?? `${t.von}|${t.titel}`, t.titel, t.ort, t.text, t.von, t.bis,
        t.ganztags ? 1 : 0);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.prepare("UPDATE kalender SET letzter_sync = datetime('now'), sync_fehler = NULL WHERE id = ?")
    .run(kal.id);
  return { neu: termine.length };
}

app.post('/api/kalender/:id/sync', auth, bremse('kalsync', 20), async (req, res) => {
  const k = db.prepare('SELECT * FROM kalender WHERE id = ? AND user_id = ?')
    .get(Number(req.params.id) || 0, req.user.id);
  if (!k?.ical_url) return res.status(404).json({ error: 'Kein abonnierter Kalender' });
  try {
    res.json(await abonnementHolen(k));
  } catch (err) {
    db.prepare('UPDATE kalender SET sync_fehler = ? WHERE id = ?')
      .run(String(err.message).slice(0, 200), k.id);
    res.status(502).json({ error: err.message });
  }
});

/** Im Zehn-Minuten-Takt, aber je Kalender hoechstens stuendlich - ein Abo aendert sich selten. */
async function aboTakt() {
  const faellig = db.prepare(`SELECT * FROM kalender WHERE ical_url IS NOT NULL
    AND (letzter_sync IS NULL OR letzter_sync < datetime('now', '-60 minutes')) LIMIT 5`).all();
  for (const k of faellig) {
    try { await abonnementHolen(k); } catch (err) {
      db.prepare("UPDATE kalender SET sync_fehler = ?, letzter_sync = datetime('now') WHERE id = ?")
        .run(String(err.message).slice(0, 200), k.id);
    }
  }
}

// --- Der Abo-Link fuers Handy --------------------------------------------------

const icsToken = userId => {
  const da = db.prepare('SELECT ics_token FROM users WHERE id = ?').get(userId)?.ics_token;
  if (da) return da;
  const neu = randomUUID().replaceAll('-', '');
  db.prepare('UPDATE users SET ics_token = ? WHERE id = ?').run(neu, userId);
  return neu;
};

app.get('/api/me/ics-token', auth, (req, res) => res.json({ token: icsToken(req.user.id) }));

app.post('/api/me/ics-token', auth, (req, res) => {
  const neu = randomUUID().replaceAll('-', '');
  db.prepare('UPDATE users SET ics_token = ? WHERE id = ?').run(neu, req.user.id);
  res.json({ token: neu });
});

/**
 * Der Kalender als .ics - ohne Anmeldung, dafuer mit geheimem Token.
 *
 * Das ist der Weg aufs Handy: iPhone, Google und Outlook koennen eine solche Adresse abonnieren.
 * Wer den Link hat, sieht die Termine - deshalb steht im Profil, dass er geheim bleiben muss, und
 * daneben ein Knopf, ihn neu zu wuerfeln.
 */
// Was ein Abo enthalten darf. Getrennt abonnierbar: /kal/<token>/pruefungen.ics fuer die Klausuren,
// /kal/<token>/hausaufgaben.ics fuer die Hausaufgaben - oder beides, mit Bindestrich verbunden. Im
// Pfad statt als ?nur=, weil manche Kalender-Apps den Query-String beim Abonnieren abschneiden.
const ABO_TEILE = { pruefungen: 'pruefung', hausaufgaben: 'hausaufgabe', termine: 'termin', ferien: 'ferien' };
const ABO_NAME = { pruefungen: 'Prüfungen', hausaufgaben: 'Hausaufgaben', termine: 'Termine', ferien: 'Ferien' };

function kalenderAbo(req, res, token, auswahl = 'alles') {
  const u = token.length >= 16
    ? db.prepare('SELECT * FROM users WHERE ics_token = ?').get(token) : null;
  if (!u) return res.status(404).type('text/plain').send('Kalender nicht gefunden');
  const teile = auswahl === 'alles' ? null : auswahl.split('-');
  if (teile && (!teile.length || teile.some(t => !ABO_TEILE[t])))
    return res.status(404).type('text/plain').send('Unbekannte Auswahl');
  const arten = teile && new Set(teile.map(t => ABO_TEILE[t]));

  const heute = new Date().toISOString().slice(0, 10);
  const { eintraege } = kalenderEintraege(u, addDays(heute, -60), addDays(heute, 365));
  // Erledigte Hausaufgaben gehoeren nicht mehr aufs Handy - dort laesst sich nichts abhaken.
  const drin = eintraege.filter(e => !e.erledigt && (!arten || arten.has(e.art)));
  const name = teile ? `Stundenplan – ${teile.map(t => ABO_NAME[t]).join(' & ')}` : 'Stundenplan';
  const ics = icsSchreibe(drin.map(e => ({
    uid: `${e.id}@stundenplan`, titel: e.titel, ort: e.ort, text: e.text,
    von: e.von, bis: e.bis, ganztags: e.ganztags,
  })), name);
  res.type('text/calendar; charset=utf-8')
    .set('content-disposition', `inline; filename="stundenplan${teile ? '-' + auswahl : ''}.ics"`)
    .set('Cache-Control', 'no-cache')
    .send(ics);
}

app.get('/kal/:token', (req, res) =>
  kalenderAbo(req, res, String(req.params.token ?? '').replace(/\.ics$/i, '')));
app.get('/kal/:token/:auswahl', (req, res) =>
  kalenderAbo(req, res, String(req.params.token ?? ''), String(req.params.auswahl ?? '').replace(/\.ics$/i, '').toLowerCase()));

// --- Tickets (VNW) -----------------------------------------------------------
// Gemeldet wird in der App, bearbeitet wird in VNW. Der Schueler braucht dort kein Konto: die
// App legt das Ticket mit IHREM API-Token an und bekommt einen `view_token` zurueck - damit
// laesst sich das einzelne Ticket ohne Anmeldung lesen und beantworten.
//
// Dieser view_token ist ein SCHLUESSEL, kein Bezeichner: wer ihn hat, darf hineinschreiben. Er
// verlaesst den Server deshalb nie. Der Browser kennt nur die Nummer der lokalen Zeile, und jede
// Route holt sie mit `AND user_id = ?` - ein fremdes Ticket ist ein 404, kein 403. Dass es die
// Nummer ueberhaupt gibt, geht niemanden etwas an.

const TICKET_TAG = 'Stundenplan';
const STATUS_TEXT = { open: 'Offen', in_progress: 'In Bearbeitung', closed: 'Geschlossen' };

// Der Token liegt verschluesselt in den Einstellungen - mit demselben Schluessel wie die
// WebUntis-Passwoerter und aus demselben Grund: die Sicherung laedt die Datenbank als Datei
// herunter, und ein Token im Klartext waere danach ein Token in Downloads und E-Mails.
function vnwConfig() {
  const url = getSetting('vnw_url', '');
  const roh = getSetting('vnw_token', '');
  let token = '';
  try { token = roh ? entschluesseln(roh) : ''; } catch { token = ''; }
  return {
    url, token,
    typen: gewaehlteTypen(),
    tagId: Number(getSetting('vnw_tag_id', 0)) || null,
  };
}
const vnwBereit = cfg => !!(cfg.url && cfg.token && cfg.typen.length);

// --- Tickets in der App (ohne VNW, seit 3.1.0) ---
// Fuer Installationen ohne VNW - etwa nach dem Open-Source-Release. Das Ticket bleibt in der
// Datenbank, die Admins beantworten es im Admin-Bereich. Jede Zeile weiss selbst, wohin sie
// gehoert: mit vnw_id laeuft sie ueber VNW, ohne bleibt sie hier. Umschalten nimmt also keinem
// alten Ticket etwas weg.
const APP_TYPEN = [{ id: 1, name: 'Vorschlag', fields: [] }, { id: 2, name: 'Fehler', fields: [] }];

/** Wohin neue Tickets gehen. Ohne Einstellung: VNW, wenn eingerichtet - so aendert das Update nichts. */
function ticketZiel(cfg = vnwConfig()) {
  const z = getSetting('tickets_ziel', '');
  return z === 'app' || z === 'vnw' ? z : vnwBereit(cfg) ? 'vnw' : 'app';
}
const istAppTicket = t => t.vnw_id == null;
const adminIds = () => db.prepare('SELECT id FROM users WHERE is_admin = 1').all().map(r => r.id);
const antwortZeilen = ticketId => db.prepare(`SELECT a.id, a.text, a.created_at, a.vom_team,
    u.username, u.display_name FROM ticket_antworten a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.ticket_id = ? ORDER BY a.id`).all(ticketId)
  .map(r => ({ id: r.id, text: r.text, at: r.created_at, vom_team: !!r.vom_team,
    name: (r.username ? nameVon(r) : 'gelöscht') + (r.vom_team ? ' (Team)' : '') }));

/**
 * Die freigegebenen Ticket-Typen, mit Namen.
 *
 * Der Name steht bewusst mit in den Einstellungen: sonst braeuchte das Meldeformular bei jedem
 * Oeffnen einen VNW-Aufruf, nur um "Bug-Report" beschriften zu koennen. Frisch geholt wird er,
 * sooft der Admin die Karte oeffnet oder speichert.
 */
function gewaehlteTypen() {
  try {
    const roh = JSON.parse(getSetting('vnw_typen', '[]'));
    if (Array.isArray(roh) && roh.length)
      return roh.map(t => ({
        id: Number(t.id), name: String(t.name ?? 'Meldung'),
        // Die eigenen Felder des Typs, so wie VNW sie beschreibt. Sie kommen bei
        // GET /api/tickets/types ohnehin mit - frueher wurden sie hier weggeworfen, und das
        // Meldeformular kannte nur Titel und Beschreibung.
        fields: Array.isArray(t.fields) ? t.fields : [],
      })).filter(t => t.id);
  } catch { /* kaputter Eintrag zaehlt wie keiner */ }
  // Altbestand aus 1.7.0: ein einzelner Typ ohne Namen. Beim naechsten Speichern im Admin steht
  // er richtig da - dafuer braucht es keine Migration.
  const alt = Number(getSetting('vnw_type_id', 0)) || null;
  return alt ? [{ id: alt, name: 'Meldung' }] : [];
}

// Fehler von VNW sind fuer den Nutzer gedacht. Ein fehlendes Recht wird benannt - sonst sucht der
// Admin im Dunkeln, warum "verboten" herauskommt.
const vnwFehlerText = err => (err instanceof VnwFehler)
  ? err.message + (err.recht ? ` (fehlendes Recht: ${err.recht})` : '')
  : kurzerFehler(err);

// Die Feldbeschreibung eines Ticket-Typs, auf das Noetige eingedampft. Was VNW sonst noch an
// einem Feld haengen hat (Sortierung, Hilfetexte, Bedingungen), braucht das Formular nicht - und
// alles, was hier hineinkommt, landet in den Einstellungen.
const FELD_TYPEN = ['text', 'textarea', 'number', 'date', 'email', 'url', 'checkbox',
  'select', 'choice', 'file'];

const feldListe = roh => (Array.isArray(roh) ? roh : [])
  .map(f => ({
    key: String(f?.key ?? f?.name ?? f?.id ?? '').trim(),
    label: String(f?.label ?? f?.key ?? '').trim(),
    typ: FELD_TYPEN.includes(f?.type) ? f.type : 'text',
    pflicht: !!f?.required,
    mehrfach: !!f?.multiple,
    optionen: (Array.isArray(f?.options) ? f.options : []).map(o => String(o?.value ?? o)).slice(0, 50),
  }))
  .filter(f => f.key)
  .slice(0, 30);

// Eine Datei kommt als base64 herein. Das Format stammt aus dem VNW-Quelltext
// (server/utils/fieldFiles.js): { upload, file_name, mime_type }. Die API-Beschreibung nennt
// stattdessen '__file' - das ist das Format der gespeicherten Referenz, die zurueckkommt.
// ponytail: 600 KB je Datei. Der Body-Parser der App nimmt 1 MB (siehe oben), base64 blaeht um ein
// Drittel auf. VNW selbst erlaubt 10 MB - fuer mehr braucht es hier ein Verkleinern im Browser.
const MAX_FELD_DATEI = 600 * 1024;

/**
 * Die Antworten auf die Felder eines Ticket-Typs pruefen und auf das Erlaubte eindampfen.
 *
 * Pflichtfelder werden HIER geprueft: VNW tut es nicht (POST /api/tickets schaut nur auf `title`
 * und `ticket_type_id`). Ohne diese Pruefung ginge ein Ticket mit leerem Pflichtfeld hinaus, und
 * niemand merkte es - am wenigsten der Melder.
 */
function feldAntworten(felder, roh) {
  const rein = roh && typeof roh === 'object' ? roh : {};
  const raus = {};
  for (const f of felder) {
    const wert = rein[f.key];
    let sauber = null;

    if (f.typ === 'checkbox') sauber = wert === true || wert === 'true' ? true : null;
    else if (f.typ === 'file') {
      if (wert && typeof wert === 'object' && typeof wert.upload === 'string' && wert.upload) {
        const bytes = Math.floor(wert.upload.replace(/^data:[^;]+;base64,/, '').length * 3 / 4);
        if (bytes > MAX_FELD_DATEI)
          return { fehler: `„${f.label || f.key}" ist zu groß (max. ${Math.round(MAX_FELD_DATEI / 1024)} KB)` };
        sauber = {
          upload: wert.upload,
          file_name: String(wert.file_name ?? 'datei').slice(0, 160),
          mime_type: String(wert.mime_type ?? 'application/octet-stream').slice(0, 120),
        };
      }
    } else if (f.typ === 'choice' && f.mehrfach) {
      const liste = (Array.isArray(wert) ? wert : []).map(v => String(v)).filter(Boolean);
      sauber = liste.length ? liste.slice(0, 50) : null;
    } else {
      const text = String(wert ?? '').trim();
      sauber = text ? text.slice(0, 2000) : null;
    }

    if (sauber === null || sauber === '') {
      if (f.pflicht) return { fehler: `„${f.label || f.key}" ist ein Pflichtfeld` };
      continue;   // Leeres gar nicht erst mitschicken
    }
    raus[f.key] = sauber;
  }
  return { felder: raus };
}

const meinTicket = (id, userId) =>
  db.prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ? AND versteckt = 0').get(Number(id) || 0, userId);

const ticketNachAussen = t => ({
  id: t.id, title: t.title, status: t.status,
  status_text: STATUS_TEXT[t.status] ?? t.status,
  type_name: t.type_name ?? null,
  created_at: t.created_at, antworten: t.antworten,
  neu: t.antworten > t.gesehen,
});

/**
 * Status und Antwortzahl der Tickets auffrischen - EIN Aufruf fuer die ganze Liste, fuer einen
 * Nutzer (beim Oeffnen der Ansicht) oder fuer alle (im Zehn-Minuten-Takt).
 *
 * Zugeordnet wird ausschliesslich ueber die gespeicherte `vnw_id`. Gehoert der Token einem Konto
 * mit der Rolle "Admin", liefert VNW naemlich ALLE Tickets der Plattform (siehe vnw.js) - nichts
 * davon darf hier hereinrutschen.
 *
 * Kommt eine Antwort dazu, die noch niemand gesehen hat, gibt es eine Meldung - die eigene zaehlt
 * nicht, sie steht schon beim Absenden als gesehen in der Zeile.
 */
export async function ticketsAuffrischen(userId = null) {
  const cfg = vnwConfig();
  if (!vnwBereit(cfg)) return;
  // Im Takt nur, was noch laufen kann: ein geschlossenes Ticket bekommt keine Antwort mehr.
  const meine = db.prepare(`SELECT id, user_id, vnw_id, title, antworten, gesehen FROM tickets
    WHERE vnw_id IS NOT NULL AND (? IS NULL OR user_id = ?) AND (? IS NOT NULL OR status <> 'closed')`)
    .all(userId, userId, userId);
  if (!meine.length) return;

  const draussen = new Map((await ticketListe(cfg, cfg.tagId)).map(t => [Number(t.id), t]));
  // Der Typname steht in derselben Antwort - das kostet keinen zusaetzlichen Aufruf, und ein in
  // VNW umbenannter Typ heisst danach auch hier richtig.
  const setz = db.prepare(`UPDATE tickets SET status = ?, antworten = ?,
                           type_name = coalesce(?, type_name) WHERE id = ?`);
  for (const zeile of meine) {
    const t = draussen.get(Number(zeile.vnw_id));
    if (!t) continue;
    const antworten = Number(t.reply_count) || 0;
    setz.run(String(t.status ?? 'open'), antworten, t.type_name ?? null, zeile.id);
    if (antworten > zeile.antworten && antworten > zeile.gesehen)
      benachrichtige(zeile.user_id, 'ticket', 'Antwort auf dein Ticket', zeile.title, '/');
  }
}

/** Die rote Zahl am Reiter: Tickets mit Antworten, die noch niemand aufgemacht hat. */
app.get('/api/tickets/neu', auth, (req, res) => res.json({
  n: db.prepare('SELECT count(*) AS n FROM tickets WHERE user_id = ? AND antworten > gesehen AND versteckt = 0')
    .get(req.user.id).n,
}));

app.get('/api/tickets', auth, async (req, res) => {
  // Auffrischen ist eine Zugabe: ist VNW gerade nicht da, steht die Liste trotzdem - mit dem
  // Stand von vorhin. Eine leere Seite waere die schlechtere Antwort.
  let fehler = null;
  try { await ticketsAuffrischen(req.user.id); }
  catch (err) { fehler = vnwFehlerText(err); }

  const cfg = vnwConfig();
  const ziel = ticketZiel(cfg);
  res.json({
    eingerichtet: ziel === 'app' || vnwBereit(cfg),
    typen: ziel === 'app' ? APP_TYPEN : cfg.typen,
    ziel,
    fehler,
    tickets: db.prepare('SELECT * FROM tickets WHERE user_id = ? AND versteckt = 0 ORDER BY id DESC').all(req.user.id)
      .map(ticketNachAussen),
  });
});

app.post('/api/tickets', auth, bremse('ticket', 10), async (req, res) => {
  const cfg = vnwConfig();
  const ziel = ticketZiel(cfg);
  if (ziel === 'vnw' && !vnwBereit(cfg))
    return res.status(400).json({ error: 'Das Ticketsystem ist noch nicht eingerichtet' });

  const titel = String(req.body?.title ?? '').trim().slice(0, 120);
  const text = String(req.body?.text ?? '').trim().slice(0, 4000);
  // Pflicht ist nur der Titel - ein Vorschlag erklaert sich oft schon selbst.
  if (!titel) return res.status(400).json({ error: 'Titel nötig' });

  if (ziel === 'app') {
    const typ = APP_TYPEN.find(t => t.id === (Number(req.body?.type_id) || APP_TYPEN[0].id));
    if (!typ) return res.status(400).json({ error: 'Diese Art von Meldung gibt es hier nicht' });
    // Ortszeit wie im Buero: die Oberflaeche zeigt den Text, wie er hier steht.
    const { lastInsertRowid } = db.prepare(`INSERT INTO tickets(user_id, title, text, status, type_name, created_at)
      VALUES(?, ?, ?, 'open', ?, datetime('now', 'localtime'))`).run(req.user.id, titel, text, typ.name);
    for (const a of adminIds()) if (a !== req.user.id)
      benachrichtige(a, 'ticket', `Neues Ticket: ${titel}`, `${typ.name} von ${nameVon(req.user)}`, '/#admin');
    return res.status(201).json(ticketNachAussen(db.prepare('SELECT * FROM tickets WHERE id = ?').get(lastInsertRowid)));
  }

  // Ohne Angabe der erste eingerichtete Typ - so bleibt der Weg ueber die API unveraendert
  // nutzbar. Ein NICHT freigegebener Typ ist dagegen ein Fehler: still auf einen anderen
  // auszuweichen schoebe die Meldung in eine fremde Zustaendigkeit, ohne dass es jemand merkt.
  const gewuenscht = Number(req.body?.type_id) || null;
  const typ = gewuenscht ? cfg.typen.find(t => t.id === gewuenscht) : cfg.typen[0];
  if (!typ) return res.status(400).json({ error: 'Diese Art von Meldung gibt es hier nicht' });

  // Die eigenen Felder des Typs. Unbekannte Schluessel fallen weg - der Client soll nicht
  // bestimmen koennen, was am Ticket haengt.
  const { felder, fehler } = feldAntworten(typ.fields ?? [], req.body?.extra_fields);
  if (fehler) return res.status(400).json({ error: fehler });

  // Ohne diese Zeile stuenden ALLE Tickets unter dem Namen des Token-Besitzers, und das Team
  // wuesste nicht, wem es antwortet.
  const wer = req.user.display_name || req.user.username;
  const beschreibung = `${text ? text + '\n\n' : ''}— gemeldet von ${wer} (@${req.user.username}) · Stundenplan ${VERSION}`;

  try {
    const neu = await ticketAnlegen(cfg, {
      titel, text: beschreibung, typId: typ.id, tagId: cfg.tagId, felder,
    });
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tickets(user_id, vnw_id, view_token, title, status, type_name, created_at)
      VALUES(?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(req.user.id, Number(neu.id) || 0, neu.view_token, titel, neu.status, typ.name);
    res.status(201).json(ticketNachAussen(
      db.prepare('SELECT * FROM tickets WHERE id = ?').get(lastInsertRowid)));
  } catch (err) {
    res.status(502).json({ error: 'VNW: ' + vnwFehlerText(err) });
  }
});

// --- Einrichtung (Admin) ---
// Der Token wird NIE zurueckgegeben, nur ob einer hinterlegt ist.

app.get('/api/tickets/config', auth, admin, async (req, res) => {
  const cfg = vnwConfig();
  const antwort = {
    url: cfg.url, token_gesetzt: !!cfg.token, type_ids: cfg.typen.map(t => t.id),
    tag: TICKET_TAG, tag_id: cfg.tagId, eingerichtet: vnwBereit(cfg),
    // `typen` ist die Auswahl, die VNW anbietet - `type_ids` sind die davon freigegebenen.
    typen: cfg.typen, fehler: null, ziel: ticketZiel(cfg),
  };
  if (cfg.url && cfg.token) {
    try { antwort.typen = (await typen(cfg)).map(t => ({ id: t.id, name: t.name })); }
    catch (err) { antwort.fehler = vnwFehlerText(err); }
  }
  res.json(antwort);
});

app.put('/api/tickets/config', auth, admin, async (req, res) => {
  const alt = vnwConfig();
  const url = ohneSchraegstrich(req.body?.url);
  // Ein leeres Token-Feld heisst "unveraendert" - sonst loescht das Speichern der Typ-Auswahl
  // den Token, und niemand versteht, warum danach nichts mehr geht.
  const token = String(req.body?.token ?? '').trim() || alt.token;
  const gewuenscht = (Array.isArray(req.body?.type_ids) ? req.body.type_ids : [])
    .map(Number).filter(Boolean);

  if (!url) {
    setSetting('vnw_url', '');
    return res.json({ url: '', token_gesetzt: !!alt.token,
      type_ids: alt.typen.map(t => t.id), typen: alt.typen,
      tag: TICKET_TAG, eingerichtet: false });
  }
  if (!/^https?:\/\//i.test(url))
    return res.status(400).json({ error: 'Adresse muss mit http:// oder https:// beginnen' });
  if (!token) return res.status(400).json({ error: 'Ohne API-Token geht es nicht' });
  if (!untisKey()) return res.status(400).json({ error: 'Kein Schlüssel zum Verschlüsseln verfügbar' });

  const cfg = { url, token, tagId: null };
  let verfuegbar;
  try { verfuegbar = await typen(cfg); }
  catch (err) { return res.status(400).json({ error: 'VNW: ' + vnwFehlerText(err) }); }

  // Das Schlagwort ist der Sinn der Sache - ohne es sieht niemand, woher das Ticket kommt.
  // Fehlt dem Token 'tickets.tags', ist das kein Abbruch: dann legt der Admin es von Hand an.
  let tagId = null, hinweis = null;
  try { tagId = await tagSicherstellen(cfg, TICKET_TAG); }
  catch (err) {
    hinweis = `Das Schlagwort "${TICKET_TAG}" konnte nicht angelegt werden (${vnwFehlerText(err)}). `
      + 'Leg es in VNW von Hand an und speichere hier erneut.';
  }

  // Gespeichert wird nur, was VNW auch wirklich kennt - samt Namen. Ein Typ, den es dort nicht
  // (mehr) gibt, faellt hier raus, statt spaeter beim Anlegen einen 404 zu erzeugen.
  const erlaubt = verfuegbar
    .filter(t => gewuenscht.includes(Number(t.id)))
    .map(t => ({ id: Number(t.id), name: String(t.name), fields: feldListe(t.fields) }));

  setSetting('vnw_url', url);
  setSetting('vnw_token', verschluesseln(token));
  setSetting('vnw_typen', JSON.stringify(erlaubt));
  setSetting('vnw_type_id', '');   // der einzelne Typ aus 1.7.0 hat ausgedient
  setSetting('vnw_tag_id', String(tagId ?? ''));

  res.json({
    url, token_gesetzt: true, type_ids: erlaubt.map(t => t.id),
    tag: TICKET_TAG, tag_id: tagId, hinweis,
    eingerichtet: vnwBereit(vnwConfig()),
    typen: verfuegbar.map(t => ({ id: t.id, name: t.name })),
  });
});

// Wohin neue Tickets gehen. Eigene Route: PUT /api/tickets/config ohne url schaltet VNW ab.
app.put('/api/tickets/ziel', auth, admin, (req, res) => {
  const ziel = req.body?.ziel;
  if (!['vnw', 'app'].includes(ziel)) return res.status(400).json({ error: 'Ziel: nur vnw oder app' });
  if (ziel === 'vnw' && !vnwBereit(vnwConfig()))
    return res.status(400).json({ error: 'VNW ist noch nicht eingerichtet – erst Adresse, Token und Typ speichern' });
  setSetting('tickets_ziel', ziel);
  res.json({ ziel });
});

// --- Postfach fuer Admins: Tickets, die in der App bleiben ---
app.get('/api/admin/tickets', auth, admin, (req, res) => res.json(db.prepare(`
  SELECT t.*, u.username, u.display_name,
    (SELECT vom_team FROM ticket_antworten a WHERE a.ticket_id = t.id ORDER BY a.id DESC LIMIT 1) AS zuletzt_team
  FROM tickets t JOIN users u ON u.id = t.user_id
  WHERE t.vnw_id IS NULL ORDER BY (t.status = 'closed'), t.id DESC`).all()
  .map(t => ({ ...ticketNachAussen(t), von: nameVon(t),
    // Wartet auf das Team: offen, und das letzte Wort hatte der Melder (oder noch niemand).
    wartet: t.status !== 'closed' && !t.zuletzt_team }))));

const appTicket = id => db.prepare('SELECT * FROM tickets WHERE id = ? AND vnw_id IS NULL').get(Number(id) || 0);

app.get('/api/admin/tickets/:id', auth, admin, (req, res) => {
  const t = appTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  const u = byId(t.user_id);
  res.json({ ...ticketNachAussen(t), von: u ? nameVon(u) : 'gelöscht', text: t.text ?? '', replies: antwortZeilen(t.id) });
});

app.post('/api/admin/tickets/:id/replies', auth, admin, bremse('ticket-antwort', 60), (req, res) => {
  const t = appTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  const text = String(req.body?.text ?? '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Nachricht nötig' });
  db.prepare(`INSERT INTO ticket_antworten(ticket_id, user_id, text, vom_team, created_at)
    VALUES(?, ?, ?, 1, datetime('now', 'localtime'))`).run(t.id, req.user.id, text);
  // Eine Antwort des Teams ist fuer den Melder neu - der Punkt am Reiter zaehlt antworten > gesehen.
  db.prepare("UPDATE tickets SET antworten = antworten + 1, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = ?").run(t.id);
  if (t.user_id !== req.user.id) benachrichtige(t.user_id, 'ticket', 'Antwort auf dein Ticket', t.title, '/');
  res.status(201).json({ ok: true });
});

app.put('/api/admin/tickets/:id/status', auth, admin, (req, res) => {
  const t = appTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  const status = req.body?.status;
  if (!Object.hasOwn(STATUS_TEXT, status)) return res.status(400).json({ error: 'Unbekannter Status' });
  db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, t.id);
  if (status !== t.status && t.user_id !== req.user.id)
    benachrichtige(t.user_id, 'ticket', `Dein Ticket: ${STATUS_TEXT[status]}`, t.title, '/');
  res.json({ ok: true, status, status_text: STATUS_TEXT[status] });
});

// Diese beiden stehen bewusst VOR '/api/tickets/:id': Express 5 kennt keine Regex in
// Routen mehr, ':id' passt damit auch auf 'config' - und die Einrichtung waere ein 404.
app.get('/api/tickets/:id', auth, async (req, res) => {
  const zeile = meinTicket(req.params.id, req.user.id);
  if (!zeile) return res.status(404).json({ error: 'Ticket nicht gefunden' });

  if (istAppTicket(zeile)) {
    db.prepare('UPDATE tickets SET gesehen = antworten WHERE id = ?').run(zeile.id);
    return res.json({
      ...ticketNachAussen({ ...zeile, gesehen: zeile.antworten }),
      felder: [], text: zeile.text ?? '', antwortbar: zeile.status !== 'closed',
      replies: antwortZeilen(zeile.id).map(({ id, name, text, at }) => ({ id, name, text, at })),
    });
  }

  try {
    const cfg = vnwConfig();
    const { ticket, replies = [] } = await ansehen(cfg, zeile.view_token);
    // Der Melder-Weg liefert die ausgefuellten Felder nicht ueberall mit. Dann dasselbe Ticket
    // noch einmal mit dem Token der Schule lesen - klappt auch das nicht, bleibt es bei dem, was
    // da ist: ein Ticket muss lesbar sein, auch ohne seine Felder.
    let felder = feldWerte(cfg, ticket);
    if (!felder.length)
      felder = feldWerte(cfg, await ticketHolen(cfg, zeile.vnw_id).catch(() => null));
    // Gelesen ist gelesen: der Punkt in der Liste verschwindet.
    db.prepare('UPDATE tickets SET status = ?, antworten = ?, gesehen = ? WHERE id = ?')
      .run(String(ticket?.status ?? zeile.status), replies.length, replies.length, zeile.id);

    res.json({
      ...ticketNachAussen({ ...zeile, status: ticket?.status ?? zeile.status,
        antworten: replies.length, gesehen: replies.length }),
      type_name: ticket?.type_name ?? zeile.type_name ?? null,
      // Was in den Feldern des Typs steht - mit Label, damit es nicht bei "ingame_name" bleibt.
      felder,
      text: String(ticket?.description ?? ''),
      antwortbar: (ticket?.status ?? zeile.status) !== 'closed',
      replies: replies.map(r => ({
        id: r.id, name: r.author_name, text: r.message, at: r.created_at,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: 'VNW: ' + vnwFehlerText(err) });
  }
});

/**
 * Die ausgefuellten Felder eines Ticket-Typs, lesbar aufbereitet.
 *
 * VNW nennt sie je nach Weg verschieden - deshalb werden alle gebraeuchlichen Namen angenommen.
 * Ein Feld, dessen Beschriftung wir nicht kennen, wird mit seinem Schluessel gezeigt statt
 * weggelassen: lieber "ingame_name" als gar nichts.
 */
function feldWerte(cfg, ticket) {
  const werte = ticket?.extra_fields ?? ticket?.custom_fields ?? ticket?.form_data ?? ticket?.fields;
  if (!werte || typeof werte !== 'object' || Array.isArray(werte)) return [];
  const typId = Number(ticket?.ticket_type_id ?? ticket?.type_id ?? ticket?.type?.id) || 0;
  const felder = cfg.typen.find(t => t.id === typId)?.fields ?? [];
  const label = new Map(felder.map(f => [f.key, f.label || f.key]));
  return Object.entries(werte)
    .map(([key, wert]) => ({
      label: label.get(key) ?? key,
      // Eine hochgeladene Datei kommt als Referenz zurueck - dann steht der Dateiname da.
      wert: wert && typeof wert === 'object'
        ? (wert.file_name ?? (Array.isArray(wert) ? wert.join(', ') : JSON.stringify(wert)))
        : wert === true ? 'ja' : String(wert),
    }))
    .filter(f => f.wert);
}

/**
 * Ein Ticket zurueckziehen - oder ein abgeschlossenes aus der eigenen Liste nehmen.
 *
 * Offen und noch ohne Antwort: bei VNW loeschen (das braucht `tickets.close` am Token der App),
 * dann hier. Sobald das Team geantwortet hat, ist es dessen Vorgang - dann bleibt es stehen, bis
 * es abgeschlossen ist, und verschwindet danach nur hier: der view_token ist ein Lese- und
 * Antwortrecht, kein Loeschrecht.
 */
app.delete('/api/tickets/:id', auth, async (req, res) => {
  const zeile = meinTicket(req.params.id, req.user.id);
  if (!zeile) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  if (istAppTicket(zeile)) {
    if (zeile.status !== 'closed'
        && db.prepare('SELECT 1 FROM ticket_antworten WHERE ticket_id = ? AND vom_team = 1').get(zeile.id))
      return res.status(409).json({ error: 'Das Team hat schon geantwortet – zurückziehen geht nicht mehr' });
    // Geschlossen: nur aus der eigenen Liste - das Postfach der Admins behaelt den Vorgang, so wie
    // es die Rueckfrage verspricht. Zurueckgezogen (noch offen, ohne Antwort): ganz weg.
    if (zeile.status === 'closed') db.prepare('UPDATE tickets SET versteckt = 1 WHERE id = ?').run(zeile.id);
    else db.prepare('DELETE FROM tickets WHERE id = ? AND user_id = ?').run(zeile.id, req.user.id);
    return res.json({ ok: true });
  }
  if (zeile.status !== 'closed') {
    if (zeile.antworten > 0)
      return res.status(409).json({ error: 'Das Team hat schon geantwortet – zurückziehen geht nicht mehr' });
    try { await ticketLoeschen(vnwConfig(), zeile.vnw_id); }
    catch (err) {
      if (err instanceof VnwFehler && err.status === 403)
        return res.status(403).json({ error: 'Zurückziehen ist nicht eingerichtet – der Admin muss dem VNW-Token das Recht tickets.close geben' });
      if (!(err instanceof VnwFehler && err.status === 404))   // bei VNW schon weg: dann auch hier
        return res.status(502).json({ error: 'VNW: ' + vnwFehlerText(err) });
    }
  }
  db.prepare('DELETE FROM tickets WHERE id = ? AND user_id = ?').run(zeile.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/tickets/:id/replies', auth, bremse('ticket-antwort', 30), async (req, res) => {
  const zeile = meinTicket(req.params.id, req.user.id);
  if (!zeile) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  const text = String(req.body?.text ?? '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Nachricht nötig' });

  if (istAppTicket(zeile)) {
    if (zeile.status === 'closed') return res.status(409).json({ error: 'Das Ticket ist geschlossen' });
    db.prepare(`INSERT INTO ticket_antworten(ticket_id, user_id, text, vom_team, created_at)
      VALUES(?, ?, ?, 0, datetime('now', 'localtime'))`).run(zeile.id, req.user.id, text);
    db.prepare('UPDATE tickets SET antworten = antworten + 1, gesehen = antworten + 1 WHERE id = ?').run(zeile.id);
    for (const a of adminIds()) if (a !== req.user.id)
      benachrichtige(a, 'ticket', `Rückfrage zum Ticket: ${zeile.title}`, text.slice(0, 120), '/#admin');
    return res.status(201).json({ ok: true });
  }

  try {
    await antworten(vnwConfig(), zeile.view_token,
      req.user.display_name || req.user.username, text);
    // Die eigene Antwort zaehlt mit und gilt sofort als gelesen - sonst leuchtete der Punkt
    // wegen der eigenen Nachricht.
    db.prepare('UPDATE tickets SET antworten = antworten + 1, gesehen = antworten + 1 WHERE id = ?')
      .run(zeile.id);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'VNW: ' + vnwFehlerText(err) });
  }
});

// --- Gruppenchats ------------------------------------------------------------
// Anlegen darf jeder. Wer dazugeholt wird, bekommt eine ANFRAGE und entscheidet selbst - niemand
// findet sich ungefragt in einer Gruppe wieder. Verwaltet wird nach Admin-Prinzip: nur Admins
// laden ein, entfernen und ernennen.
//
// Verschluesselt wird weiter Ende-zu-Ende, ohne neues Verfahren: die Gruppe hat einen Schluessel,
// und der liegt fuer JEDES Mitglied einzeln verpackt (mit dem Paar-Geheimnis aus dem Einzelchat).
// Der Server verwahrt nur Chiffrat - wie beim privaten Schluessel im Profil.

const gruppeVon = (id, userId) => db.prepare(`
  SELECT g.*, m.rolle, m.status, m.key_enc FROM chat_groups g
  JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
  WHERE g.id = ?`).get(userId, Number(id) || 0);

const istGruppenAdmin = z => z?.status === 'drin' && z?.rolle === 'admin';

const gruppeNachAussen = (z, userId) => ({
  id: z.id, name: z.name, rolle: z.rolle, status: z.status,
  mitglieder: db.prepare(`SELECT ${USER_COLS}, m.rolle, m.status FROM group_members m
    JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.created_at`)
    .all(z.id).map(u => ({ ...person(u), rolle: u.rolle, status: u.status })),
  eingeladen_von: z.eingeladen_von ?? null,
  // Der verpackte Schluessel gehoert nur dem, fuer den er verpackt wurde.
  key_enc: z.status === 'drin' ? z.key_enc : null,
  unread: db.prepare(`SELECT count(*) AS n FROM messages
    WHERE group_id = ? AND from_id <> ? AND text <> ''`).get(z.id, userId).n,
});

app.get('/api/groups', auth, (req, res) => {
  const meine = db.prepare(`SELECT g.*, m.rolle, m.status, m.key_enc, m.eingeladen_von
    FROM chat_groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ?
    ORDER BY g.id DESC`).all(req.user.id);
  res.json(meine.map(z => gruppeNachAussen(z, req.user.id)));
});

app.post('/api/groups', auth, bremse('gruppe', 20), (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  // Der eigene Schluessel kommt fertig verpackt vom Browser - der Server erzeugt ihn nicht und
  // kennt ihn nicht.
  const key = String(req.body?.key_enc ?? '').slice(0, 4000) || null;

  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO chat_groups(name, created_by, created_at) VALUES(?, ?, datetime('now'))")
      .run(name, req.user.id);
    db.prepare(`INSERT INTO group_members(group_id, user_id, rolle, status, key_enc, created_at)
                VALUES(?, ?, 'admin', 'drin', ?, datetime('now'))`)
      .run(Number(lastInsertRowid), req.user.id, key);
    db.exec('COMMIT');
    res.status(201).json(gruppeNachAussen(gruppeVon(lastInsertRowid, req.user.id), req.user.id));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

app.patch('/api/groups/:id', auth, (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (!istGruppenAdmin(z)) return res.status(403).json({ error: 'Nur Admins der Gruppe' });
  const name = String(req.body?.name ?? '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  db.prepare('UPDATE chat_groups SET name = ? WHERE id = ?').run(name, z.id);
  res.json(gruppeNachAussen(gruppeVon(z.id, req.user.id), req.user.id));
});

/** Einladen. Der Schluessel kommt fuer den Eingeladenen verpackt mit - sonst koennte er nichts lesen. */
app.post('/api/groups/:id/mitglieder', auth, bremse('gruppe-einladen', 60), (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (!istGruppenAdmin(z)) return res.status(403).json({ error: 'Nur Admins der Gruppe' });

  const wen = Number(req.body?.user_id) || 0;
  if (!byId(wen)) return res.status(404).json({ error: 'Diesen Nutzer gibt es nicht' });
  if (db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(z.id, wen))
    return res.status(409).json({ error: 'Ist schon in der Gruppe oder eingeladen' });

  db.prepare(`INSERT INTO group_members(group_id, user_id, rolle, status, key_enc, eingeladen_von, created_at)
              VALUES(?, ?, 'mitglied', 'eingeladen', ?, ?, datetime('now'))`)
    .run(z.id, wen, String(req.body?.key_enc ?? '').slice(0, 4000) || null, req.user.id);
  benachrichtige(wen, 'freunde', `${nameVon(req.user)} lädt dich in „${z.name}" ein`, null, '/');
  res.status(201).json({ ok: true });
});

/** Annehmen oder ablehnen - die Entscheidung des Eingeladenen, sonst niemandes. */
app.post('/api/groups/:id/beitreten', auth, (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z || z.status !== 'eingeladen') return res.status(404).json({ error: 'Keine offene Einladung' });
  db.prepare("UPDATE group_members SET status = 'drin' WHERE group_id = ? AND user_id = ?")
    .run(z.id, req.user.id);
  res.json(gruppeNachAussen(gruppeVon(z.id, req.user.id), req.user.id));
});

app.delete('/api/groups/:id/mitglieder/:wen', auth, (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  const wen = Number(req.params.wen) || 0;
  // Sich selbst herausnehmen darf jeder - andere nur ein Admin.
  if (wen !== req.user.id && !istGruppenAdmin(z))
    return res.status(403).json({ error: 'Nur Admins der Gruppe' });

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(z.id, wen);

  // Ohne Admin waere die Gruppe eingefroren: niemand koennte mehr einladen. Das dienstaelteste
  // Mitglied rueckt nach.
  const nochAdmin = db.prepare(
    "SELECT 1 FROM group_members WHERE group_id = ? AND rolle = 'admin' AND status = 'drin'").get(z.id);
  if (!nochAdmin) {
    const naechster = db.prepare(
      "SELECT user_id FROM group_members WHERE group_id = ? AND status = 'drin' ORDER BY created_at LIMIT 1")
      .get(z.id);
    if (naechster) {
      db.prepare("UPDATE group_members SET rolle = 'admin' WHERE group_id = ? AND user_id = ?")
        .run(z.id, naechster.user_id);
    } else {
      // Niemand mehr da - die Gruppe samt Nachrichten geht mit.
      db.prepare('DELETE FROM chat_groups WHERE id = ?').run(z.id);
    }
  }
  res.json({ ok: true });
});

/** Zum Admin machen (oder zurueckstufen). */
app.patch('/api/groups/:id/mitglieder/:wen', auth, (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  if (!istGruppenAdmin(z)) return res.status(403).json({ error: 'Nur Admins der Gruppe' });
  const rolle = req.body?.rolle === 'admin' ? 'admin' : 'mitglied';
  const wen = Number(req.params.wen) || 0;
  const { changes } = db.prepare('UPDATE group_members SET rolle = ? WHERE group_id = ? AND user_id = ?')
    .run(rolle, z.id, wen);
  if (!changes) return res.status(404).json({ error: 'Nicht in der Gruppe' });
  res.json({ ok: true });
});

/** Der Verlauf einer Gruppe - erst nach der Zusage. */
app.get('/api/groups/:id/nachrichten', auth, (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z || z.status !== 'drin') return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  const since = Number(req.query.since) || 0;
  const rows = db.prepare(`SELECT ${MSG_COLS} FROM messages m ${MSG_JOIN}
    WHERE m.group_id = ? AND m.id > ? AND m.text <> '' ORDER BY m.id`).all(z.id, since);
  res.json(rows.map(r => ({ ...nachricht(r), stimmen: stimmenZu(r) })));
});

app.post('/api/groups/:id/nachrichten', auth, bremse('chat', 60), (req, res) => {
  const z = gruppeVon(req.params.id, req.user.id);
  if (!z || z.status !== 'drin') return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Nachricht ist leer' });
  if (text.length > 6000) return res.status(400).json({ error: 'Nachricht ist zu lang' });

  const neu = neueNachricht({
    from: req.user.id, to: null, group: z.id, text, enc: !!req.body?.enc,
    datei_id: Number(req.body?.datei_id) || null, umfrage_n: Number(req.body?.umfrage_n) || 0,
    res,
  });
  if (!neu) return;   // neueNachricht hat schon geantwortet

  for (const m of db.prepare(
    "SELECT user_id FROM group_members WHERE group_id = ? AND status = 'drin' AND user_id <> ?")
    .all(z.id, req.user.id)) {
    benachrichtige(m.user_id, 'chat', `${nameVon(req.user)} in „${z.name}"`, null, '/');
  }
  res.json(neu);
});

// Anhaenge in der Gruppe: derselbe Weg wie im Einzelchat, nur mit Gruppenpruefung.
app.post('/api/groups/:id/datei', auth, bremse('chat-datei', 30),
  express.json({ limit: '12mb' }), (req, res) => {
    const z = gruppeVon(req.params.id, req.user.id);
    if (!z || z.status !== 'drin') return res.status(404).json({ error: 'Gruppe nicht gefunden' });
    dateiAnnehmen({ from: req.user.id, to: null, group: z.id, daten: String(req.body?.data ?? ''), res });
  });

// --- Kurschat -----------------------------------------------------------------
// Jeder Kurs hat einen Chat, befreundet muss niemand sein. Wer mitliest, entscheiden die Stunden:
// eine Nachricht traegt die Stunden, in denen der Absender den Kurs beim Senden hatte, und sieht
// sie jeder, der den Kurs jetzt in einer dieser Stunden hat. So bleiben zwei Jahrgaenge mit
// derselben Kurs-ID getrennt, ein neues Mitglied sieht den Verlauf, und wer den Kurs verlaesst,
// nimmt seine Nachrichten nicht mit. Nicht Ende-zu-Ende (die Mitglieder wechseln und kennen sich
// nicht) - der Text liegt serverseitig verschluesselt, wie die Umfrage-Antworten.

/** Meine Stunden in diesem Kurs als Menge "tag|stunde". */
const meineSlotsImKurs = (me, kurs) => new Set(sql(`SELECT day_id, period_id FROM (${MEINE_SLOTS})
  WHERE course_id = ? COLLATE NOCASE`).all(me, me, kurs).map(s => `${s.day_id}|${s.period_id}`));
const kursSichtbar = (m, slots) => String(m.kurs_slots ?? '').split(',').some(s => slots.has(s));
// Dasselbe als SQL-Bedingung - gefiltert werden muss VOR dem LIMIT: sonst verdraengten die
// Nachrichten eines anderen Jahrgangs mit gleicher Kurs-ID den eigenen Verlauf.
const kursSlotsSql = slots => ({ wo: `(${[...slots].map(() => "(',' || m.kurs_slots || ',') LIKE ?").join(' OR ')})`,
  args: [...slots].map(s => `%,${s},%`) });

/** Alle, die den Kurs in einer meiner Stunden haben - Mitgliederliste und Empfaenger. */
function kursMitgliedIds(kurs, slots) {
  if (!slots.size) return [];
  const ids = new Set();
  for (const z of sql(`SELECT user_id, day_id, period_id FROM entries WHERE course_id = ? COLLATE NOCASE
      UNION SELECT u.user_id, d.id, u.period_id FROM untis_lessons u
        JOIN days d ON d.iso = CAST(strftime('%u', u.date) AS INTEGER)
      WHERE u.course_id = ? COLLATE NOCASE`).all(kurs, kurs))
    if (slots.has(`${z.day_id}|${z.period_id}`)) ids.add(z.user_id);
  return [...ids];
}

const kursText = t => { try { return t ? entschluesseln(t) : ''; } catch { return '[nicht lesbar]'; } };

/** Personen je Anfrage einmal holen - im Verlauf schreibt meist eine Handvoll Leute. */
function personenCache() {
  const cache = new Map();
  return id => {
    if (!cache.has(id)) {
      const u = sql(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).get(id);
      cache.set(id, u ? person(u) : null);
    }
    return cache.get(id);
  };
}
const kursNachricht = (r, von) => ({ ...nachricht({ ...r, text: kursText(r.text) }), kurs_id: r.kurs_id,
  von: von(r.from_id), stimmen: stimmenZu(r) });

/** Der Kurs aus der Adresse - nur, wenn er bei mir in mindestens einer Stunde liegt. */
function meinKurschat(req, res) {
  const kurs = kanonischerKurs(req.params.kurs);
  const slots = kurs ? meineSlotsImKurs(req.user.id, kurs) : new Set();
  if (!kurs || RESERVIERT.has(kurs) || !slots.size) { res.status(404).json({ error: 'Kurschat nicht gefunden' }); return null; }
  return { kurs, slots };
}

// Liste: meine Kurse mit Vorschau und ungelesen. Wer einen Kurs zum ersten Mal sieht, startet bei
// "alles gelesen" - sonst kaemen mit dem Beitritt zweitausend alte Nachrichten als ungelesen.
app.get('/api/kurschats', auth, (req, res) => {
  const me = req.user.id;
  const stumm = new Set(sql('SELECT kurs_id FROM kurschat_stumm WHERE user_id = ?').all(me).map(r => r.kurs_id));
  const gelesen = new Map(sql('SELECT kurs_id, bis_id FROM kurschat_gelesen WHERE user_id = ?').all(me).map(r => [r.kurs_id, r.bis_id]));
  const merk = sql(`INSERT INTO kurschat_gelesen(user_id, kurs_id, bis_id) VALUES(?, ?, ?)
    ON CONFLICT(user_id, kurs_id) DO NOTHING`);
  const von = personenCache();
  const raus = [];
  for (const k of meineKurse(me)) {
    const slots = meineSlotsImKurs(me, k.id);
    if (!slots.size) continue;
    if (!gelesen.has(k.id)) {
      const hoechste = sql('SELECT max(id) AS m FROM messages WHERE kurs_id = ?').get(k.id).m ?? 0;
      merk.run(me, k.id, hoechste);
      gelesen.set(k.id, hoechste);
    }
    const f = kursSlotsSql(slots);
    // Ungelesen: nur das Neue seit "gelesen bis" - klein, egal wie lang der Verlauf ist.
    const unread = sql(`SELECT count(*) AS n FROM messages m WHERE m.kurs_id = ? AND m.id > ? AND m.text <> ''
      AND m.from_id <> ? AND ${f.wo}`).get(k.id, gelesen.get(k.id), me, ...f.args).n;
    // Die Vorschau: die letzte Nachricht, die ich sehen darf.
    const letzte = sql(`SELECT ${MSG_COLS} FROM messages m ${MSG_JOIN} WHERE m.kurs_id = ? AND m.text <> ''
      AND ${f.wo} ORDER BY m.id DESC LIMIT 1`).get(k.id, ...f.args);
    raus.push({ id: k.id, title: k.title, subject: k.subject, subject_short: k.subject_short,
      pref_name: k.pref_name, pref_color: k.pref_color, pref_short: k.pref_short,
      last: letzte ? kursNachricht(letzte, von) : null, unread, stumm: stumm.has(k.id) });
  }
  raus.sort((a, b) => (b.last?.id ?? -1) - (a.last?.id ?? -1));
  res.json(raus);
});

app.get('/api/kurschats/:kurs', auth, (req, res) => {
  const z = meinKurschat(req, res); if (!z) return;
  const since = Number(req.query.since) || 0;
  // Die neuesten 300 - aeltere holt niemand mehr durch Hochscrollen in einer Schulklasse.
  const f = kursSlotsSql(z.slots);
  const rows = sql(`SELECT ${MSG_COLS} FROM messages m ${MSG_JOIN} WHERE m.kurs_id = ? AND m.id > ? AND m.text <> ''
    AND ${f.wo} ORDER BY m.id DESC LIMIT 300`).all(z.kurs, since, ...f.args).reverse();
  if (!req.query.nurLesen) sql(`INSERT INTO kurschat_gelesen(user_id, kurs_id, bis_id)
      VALUES(?, ?, (SELECT coalesce(max(id), 0) FROM messages WHERE kurs_id = ?))
      ON CONFLICT(user_id, kurs_id) DO UPDATE SET bis_id = max(bis_id, excluded.bis_id)`).run(req.user.id, z.kurs, z.kurs);
  const von = personenCache();
  res.json(rows.map(r => kursNachricht(r, von)));
});

app.post('/api/kurschats/:kurs', auth, bremse('kurschat', 60), (req, res) => {
  const z = meinKurschat(req, res); if (!z) return;
  const me = req.user.id;
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Nachricht ist leer' });
  // 2000 Zeichen Text; Anhang und Umfrage tragen dazu ein kleines JSON.
  if (text.length > 4000) return res.status(400).json({ error: 'Nachricht ist zu lang' });
  const umfrage_n = Math.min(Math.max(Number(req.body?.umfrage_n) || 0, 0), 10);
  const datei_id = Number(req.body?.datei_id) || null;
  if (datei_id && !sql(`SELECT 1 FROM chat_files f JOIN messages m ON m.id = f.message_id
      WHERE f.id = ? AND m.from_id = ? AND m.text = '' AND m.kurs_id = ?`).get(datei_id, me, z.kurs))
    return res.status(400).json({ error: 'Der Anhang gehört nicht zu dieser Nachricht' });
  // Anders als bei Ende-zu-Ende sieht der Server hier den Inhalt - dann prueft er auch, dass Umfrage
  // und Anhang stimmig sind. Eine "Umfrage" ohne Antworten oder mit Datei-Text legte sonst die
  // Anzeige des ganzen Kurschats lahm, und hier schreiben auch Leute, die man nicht kennt.
  if (umfrage_n || datei_id) {
    let j = null;
    try { j = JSON.parse(text); } catch { /* unten abgewiesen */ }
    const umfrageOk = umfrage_n && !datei_id && j?.t === 'umfrage' && typeof j.frage === 'string'
      && Array.isArray(j.optionen) && j.optionen.length === umfrage_n && j.optionen.every(o => typeof o === 'string');
    const dateiOk = datei_id && !umfrage_n && j?.t === 'datei' && typeof j.name === 'string';
    if (!umfrageOk && !dateiOk) return res.status(400).json({ error: 'Umfrage oder Anhang passt nicht' });
  }

  const id = transaktion(() => {
    const { lastInsertRowid } = sql(`INSERT INTO messages(from_id, to_id, group_id, kurs_id, kurs_slots, text, enc, umfrage_n, created_at)
      VALUES(?, NULL, NULL, ?, ?, ?, 0, ?, datetime('now'))`).run(me, z.kurs, [...z.slots].join(','), verschluesseln(text), umfrage_n);
    if (datei_id) {
      const platz = sql('SELECT message_id FROM chat_files WHERE id = ?').get(datei_id).message_id;
      sql('UPDATE chat_files SET message_id = ? WHERE id = ?').run(Number(lastInsertRowid), datei_id);
      sql('DELETE FROM messages WHERE id = ?').run(platz);
    }
    // Die eigene Nachricht gilt als gelesen.
    sql(`INSERT INTO kurschat_gelesen(user_id, kurs_id, bis_id) VALUES(?, ?, ?)
      ON CONFLICT(user_id, kurs_id) DO UPDATE SET bis_id = max(bis_id, excluded.bis_id)`).run(me, z.kurs, Number(lastInsertRowid));
    return Number(lastInsertRowid);
  });

  // Melden: ohne Inhalt, und je Kurs hoechstens EINE wartende Meldung - gesammelt heisst sonst
  // abends "37 Hinweise" fuer einen einzigen Kurs.
  const kursName = sql('SELECT title FROM courses WHERE id = ?').get(z.kurs)?.title ?? z.kurs;
  const stumm = new Set(sql('SELECT user_id FROM kurschat_stumm WHERE kurs_id = ?').all(z.kurs).map(r => r.user_id));
  const wartet = sql('SELECT 1 FROM notifications WHERE user_id = ? AND ref = ? AND delivered_at IS NULL');
  // Wer den Kurschat noch nie geoeffnet hat, bekommt jetzt seinen Lesestand - sonst gaelte beim
  // ersten Oeffnen alles als gelesen, auch diese Nachricht.
  const lesestand = sql(`INSERT INTO kurschat_gelesen(user_id, kurs_id, bis_id) VALUES(?, ?, ?)
    ON CONFLICT(user_id, kurs_id) DO NOTHING`);
  for (const uid of kursMitgliedIds(z.kurs, z.slots)) {
    if (uid === me) continue;
    lesestand.run(uid, z.kurs, id - 1);
    if (stumm.has(uid) || wartet.get(uid, `kurs:${z.kurs}`)) continue;
    benachrichtige(uid, 'kurschat', `Neue Nachrichten im Kurschat ${kursName}`, null, '/#chat', null, `kurs:${z.kurs}`);
  }
  res.json(kursNachricht(sql(`SELECT ${MSG_COLS} FROM messages m ${MSG_JOIN} WHERE m.id = ?`).get(id), personenCache()));
});

app.post('/api/kurschats/:kurs/datei', auth, bremse('chat-datei', 30), express.json({ limit: '12mb' }), (req, res) => {
  const z = meinKurschat(req, res); if (!z) return;
  dateiAnnehmen({ from: req.user.id, kurs: z.kurs, daten: String(req.body?.data ?? ''), res });
});

// Loeschen: nur die eigene Nachricht. Anhang und Stimmen gehen per Fremdschluessel mit.
app.delete('/api/kurschats/nachricht/:id', auth, (req, res) => {
  const r = sql('DELETE FROM messages WHERE id = ? AND kurs_id IS NOT NULL AND from_id = ?')
    .run(Number(req.params.id) || 0, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
  res.json({ ok: true });
});

app.get('/api/kurschats/:kurs/mitglieder', auth, (req, res) => {
  const z = meinKurschat(req, res); if (!z) return;
  const von = personenCache();
  res.json(kursMitgliedIds(z.kurs, z.slots).map(von).filter(Boolean)
    .sort((a, b) => nameVon(a).localeCompare(nameVon(b), 'de')));
});

app.put('/api/kurschats/:kurs/stumm', auth, (req, res) => {
  const z = meinKurschat(req, res); if (!z) return;
  if (req.body?.an) sql('INSERT OR IGNORE INTO kurschat_stumm(user_id, kurs_id) VALUES(?, ?)').run(req.user.id, z.kurs);
  else sql('DELETE FROM kurschat_stumm WHERE user_id = ? AND kurs_id = ?').run(req.user.id, z.kurs);
  res.json({ stumm: !!req.body?.an });
});

// --- Buero: Notizen, Ideenbaum, Abstimmungen, Umfragen (buero.js) ---
// Gaeste haben kein Konto - gebremst wird dann je IP.
// Im Minutenfenster: eine Klasse im Schul-WLAN hat eine IP, und 30 je Viertelstunde hielt sie auf.
const gastBremse = (name, max) => (req, res, next) => {
  const k = `${name}:ip:${req.ip}:${Math.floor(Date.now() / 60000)}`;
  if (zuOft(k, max)) return res.status(429).json({ error: 'Zu viele Anfragen, bitte kurz warten' });
  zaehle(k);
  next();
};
buero(app, { auth, bremse, gastBremse, benachrichtige, istFreund, meineKursIds, hatKurs, kanonischerKurs,
  kursGemeinsam, person, verschluesseln, entschluesseln, nameVon });

// Ohne eigenen Handler schickt Express bei jedem unbehandelten Fehler den Stacktrace an den
// Client - also den halben Serverpfad. Geloggt wird er weiterhin, nur eben hier.
app.use((err, req, res, next) => {
  console.error('Unbehandelter Fehler:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Serverfehler' });
});

const port = Number(process.env.PORT ?? 3120);

// Einmalig mit 3.1.0: die automatisch gefuellten Kalender "Pruefungen (Schule)" werden zu eigenen
// Eintraegen - danach kommen Pruefungen nur noch auf Knopfdruck.
if (!getSetting('migration_untis_pruefungen')) {
  altePruefungskalenderUebernehmen();
  setSetting('migration_untis_pruefungen', '1');
}

export const server = app.listen(port, function () {
  // address() ist null, wenn das Zuhoeren gescheitert ist - dann kommt die Erklaerung aus dem
  // error-Handler darunter, und hier waere nur ein nichtssagender TypeError zu holen.
  const adresse = this.address();
  if (adresse) console.log(`Stundenplan läuft auf http://localhost:${adresse.port}`);
});

// Ohne diesen Handler wirft ein belegter Port einen TypeError aus der Erfolgsmeldung heraus
// (this.address() ist dann null) - der Stacktrace sagt nichts über die Ursache. Beim Neustart
// eines Deploys ist der alte Prozess aber genau der Normalfall.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`! Port ${port} ist belegt. Läuft die App noch aus einem früheren Start?`);
    console.error('  Alten Prozess beenden oder mit PORT einen anderen Port setzen.');
  } else if (err.code === 'EACCES') {
    console.error(`! Keine Berechtigung für Port ${port}. Ports unter 1024 brauchen mehr Rechte.`);
  } else {
    console.error('! Server konnte nicht starten:', err.message);
  }
  process.exit(1);
});
