import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dbFile } from './db.js';
import { htmlZuText } from './rss.js';

// --- Passwoerter -------------------------------------------------------------
// WebUntis kennt kein Token mit langer Laufzeit, das wir statt des Passworts speichern koennten -
// fuer den automatischen Abgleich muss das Geheimnis entschluesselbar liegen.
//
// Der Schluessel dafuer steht bewusst NICHT in der Datenbank, sondern in einer eigenen Datei
// neben ihr (oder in UNTIS_KEY). Das ist kein Selbstzweck: die Sicherungsfunktion laedt die
// Datenbank als Datei herunter, und die landet in Downloads und E-Mails. Laege der Schluessel
// darin, truege jede Sicherung die Untis-Zugaenge aller Nutzer im Klartext-Aequivalent mit sich.
//
// Einrichten muss man nichts: fehlt die Datei, wird sie beim ersten Bedarf erzeugt.

const alsSchluessel = roh => {
  const text = String(roh ?? '').trim();
  if (!text) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  return key.length === 32 ? key : null;
};

let ausDatei; // null = schon erfolglos versucht, sonst der Schluessel

function schluesselDatei() {
  if (ausDatei !== undefined) return ausDatei;
  const pfad = `${dbFile}.untis-key`;
  try {
    if (existsSync(pfad)) return (ausDatei = alsSchluessel(readFileSync(pfad, 'utf8')));
    const neu = randomBytes(32);
    writeFileSync(pfad, neu.toString('hex'), { mode: 0o600 });
    console.warn(`! WebUntis-Schluessel erzeugt: ${pfad}`);
    console.warn('  Nicht loeschen - sonst muessen sich alle Nutzer neu mit WebUntis verbinden.');
    return (ausDatei = neu);
  } catch (err) {
    console.warn(`! WebUntis-Schluessel ${pfad} nicht nutzbar (${err.message}).`);
    return (ausDatei = null);
  }
}

export const untisKey = () => alsSchluessel(process.env.UNTIS_KEY)
  // Ohne Datei daneben (Tests mit :memory:) bleibt nur die Umgebungsvariable.
  ?? (dbFile === ':memory:' ? null : schluesselDatei());

export function verschluesseln(text) {
  const key = untisKey();
  if (!key) throw new Error('Kein Schlüssel zum Verschlüsseln verfügbar');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), daten.toString('hex')].join(':');
}

export function entschluesseln(gespeichert) {
  const key = untisKey();
  if (!key) throw new Error('Kein Schlüssel zum Verschlüsseln verfügbar');
  const [iv, tag, daten] = String(gespeichert).split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(daten, 'hex')), d.final()]).toString('utf8');
}

// --- JSON-RPC ----------------------------------------------------------------

const RPC_TIMEOUT = 15_000;

async function rpc(url, method, params, cookie) {
  // "fetch failed" sagt einem Schueler nichts - Netzfehler bekommen einen lesbaren Text.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: JSON.stringify({ id: 'stundenplan', method, params, jsonrpc: '2.0' }),
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  }).catch(err => {
    throw new Error(err.name === 'TimeoutError'
      ? 'WebUntis antwortet nicht (Zeitüberschreitung)'
      : 'WebUntis ist nicht erreichbar — stimmt der Server der Schule?');
  });
  if (!res.ok) throw new Error(`WebUntis antwortet mit ${res.status}`);
  const daten = await res.json().catch(() => { throw new Error('WebUntis antwortet nicht mit JSON'); });
  // WebUntis meldet Fachfehler mit HTTP 200 und einem error-Objekt - ohne diese Pruefung liefe
  // ein falsches Passwort als "leerer Stundenplan" durch.
  if (daten.error) throw new Error(daten.error.message || `WebUntis-Fehler ${daten.error.code}`);
  return { ergebnis: daten.result, cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] ?? cookie };
}

// --- Anmeldung mit dem Schluessel aus der Untis-App ---------------------------
// WebUntis kennt keinen API-Key, aber einen Zugriffsschluessel: WebUntis -> Profil -> Freigaben ->
// "Zugriff über andere Apps". Daraus wird ein Einmalcode gerechnet (TOTP, RFC 6238). Das ist
// deutlich besser, als das Schulpasswort zu speichern: der Schluessel gibt nur Lesezugriff auf den
// Plan und lässt sich in WebUntis widerrufen, ohne das Passwort zu ändern.

const base32 = text => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const z of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += abc.indexOf(z).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
};

export function totp(schluessel, zeit = Date.now(), schritt = 30) {
  const geheim = base32(schluessel);
  if (!geheim.length) throw new Error('Der Schlüssel ist kein gültiger Untis-Zugriffsschlüssel');
  const zaehler = Buffer.alloc(8);
  zaehler.writeBigUInt64BE(BigInt(Math.floor(zeit / 1000 / schritt)));
  const mac = createHmac('sha1', geheim).update(zaehler).digest();
  const stelle = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(stelle) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Alles, was die Aufrufe danach brauchen. Der schoolname-Cookie ist kein Beiwerk: die
// REST-Endpunkte (/WebUntis/api/...) kennen die Schule nur daraus, im Query-String steht sie
// dort nicht. Ohne ihn antwortet WebUntis auf die Hausaufgaben mit einem Fehler.
const sitzungBauen = (server, schule, cookie, personId, personType) => ({
  url: rpcUrl(server, schule),
  host: `https://${ohneSchema(server).toLowerCase()}`,
  schule,
  cookie: `${cookie}; schoolname=_${Buffer.from(String(schule), 'utf8').toString('base64')}`,
  personId,
  personType,
});

export const rpcUrl = (server, schule) => {
  if (!untisHostOk(server)) throw new Error('Kein gültiger WebUntis-Server');
  return `https://${ohneSchema(server).toLowerCase()}`
    + `/WebUntis/jsonrpc.do?school=${encodeURIComponent(schule)}`;
};

export async function login(server, schule, user, passwort) {
  const url = rpcUrl(server, schule);
  const { ergebnis, cookie } = await rpc(url, 'authenticate',
    { user, password: passwort, client: 'stundenplan-app' });
  if (!ergebnis?.sessionId) throw new Error('Anmeldung abgelehnt (kein sessionId)');
  return sitzungBauen(server, schule, cookie ?? `JSESSIONID=${ergebnis.sessionId}`,
    ergebnis.personId, ergebnis.personType);
}

export async function loginMitSchluessel(server, schule, user, schluessel) {
  if (!untisHostOk(server)) throw new Error('Kein gültiger WebUntis-Server');
  const host = `https://${ohneSchema(server).toLowerCase()}`;
  const intern = `${host}/WebUntis/jsonrpc_intern.do`
    + `?m=getUserData2017&school=${encodeURIComponent(schule)}&v=i2.2`;
  const { cookie } = await rpc(intern, 'getUserData2017',
    [{ auth: { clientTime: Date.now(), user, otp: totp(schluessel) } }]);
  if (!cookie) throw new Error('Anmeldung abgelehnt (keine Sitzung erhalten)');

  // Wer man ist, steht nicht in der Antwort der Anmeldung, sondern in der App-Konfiguration -
  // und ohne personId/personType laesst sich kein Stundenplan abrufen.
  const res = await fetch(`${host}/WebUntis/api/app/config`, {
    headers: { cookie }, signal: AbortSignal.timeout(RPC_TIMEOUT),
  }).catch(() => { throw new Error('WebUntis ist nicht erreichbar'); });
  if (!res.ok) throw new Error(`WebUntis antwortet mit ${res.status}`);
  const nutzer = (await res.json().catch(() => ({})))?.data?.loginServiceConfig?.user;
  const person = nutzer?.persons?.find(p => p.id === nutzer.personId);
  if (!nutzer?.personId) throw new Error('WebUntis nennt keine Person zu diesem Schlüssel');

  return sitzungBauen(server, schule, cookie, nutzer.personId, person?.type ?? 5);
}

const alsUntisDatum = iso => Number(iso.replaceAll('-', ''));

/**
 * Lehrstoff und Notizen zur Stunde.
 *
 * Die holt JSON-RPC nicht: 'showLsText' wird zwar mitgeschickt, aber fuer Schuelerkonten liefert
 * WebUntis 'lstext' und 'bkText' leer zurueck - 'info' und 'substText' dagegen schon. Genau das
 * war zu sehen: die Info zur Stunde kam an, der Lehrstoff nicht.
 *
 * Dieselben Texte stehen in der REST-Schnittstelle, die auch die WebUntis-Weboberflaeche des
 * Schuelers benutzt - dort heissen sie 'lessonText' (Lehrstoff), 'periodText' (Notizen fuer
 * Schueler*innen) und 'periodInfo' (Information zur Stunde).
 *
 * Die Abfrage geht wochenweise; fuer jeden Montag im Zeitraum eine. Schlaegt sie fehl, bleibt es
 * beim Plan ohne Texte - der Stundenplan selbst haengt nicht daran.
 */
/**
 * Beide Textabrufe laufen wochenweise und nur ueber dieses Fenster, nicht ueber den ganzen
 * Abgleichsbereich (-28/+140 Tage). Lehrstoff traegt der Lehrer NACH der Stunde ein, fuer den Mai
 * gibt es keinen - 25 Wochen abzufragen waere reine Last ohne Ertrag.
 */
const TEXT_ZURUECK = 28, TEXT_VORAUS = 21;

/** Montage im gewuenschten Fenster, auf TEXT_ZURUECK/TEXT_VORAUS um heute herum beschnitten. */
function textWochen(vonIso, bisIso) {
  const tagIso = (d, n) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const heute = new Date();
  const von = [vonIso, tagIso(heute, -TEXT_ZURUECK)].sort().at(-1);   // der spaetere gewinnt
  const bis = [bisIso, tagIso(heute, TEXT_VORAUS)].sort().at(0);      // der fruehere gewinnt
  if (von > bis) return [];

  const wochen = [];
  const tag = new Date(von + 'T12:00:00Z');
  tag.setUTCDate(tag.getUTCDate() - ((tag.getUTCDay() + 6) % 7));     // auf Montag zurueck
  for (const ende = new Date(bis + 'T12:00:00Z'); tag <= ende; tag.setUTCDate(tag.getUTCDate() + 7))
    wochen.push(tag.toISOString().slice(0, 10));
  return wochen;
}

export async function stundentexte(sitzung, vonIso, bisIso) {
  const texte = new Map();
  for (const woche of textWochen(vonIso, bisIso)) {
    const basis = `/WebUntis/api/public/timetable/weekly/data`
      + `?elementType=${sitzung.personType}&elementId=${sitzung.personId}&date=${woche}`;
    // Ohne formatId antwortet die Schnittstelle je nach Instanz mit der Standardansicht oder gar
    // nicht - deshalb im zweiten Anlauf die 1. Mehr als zwei Versuche waeren Rateraten.
    let perioden = null;
    for (const pfad of [basis, basis + '&formatId=1']) {
      perioden = periodenAusRest(await rest(sitzung, pfad).catch(() => null));
      if (perioden) break;
    }
    for (const p of perioden ?? []) {
      const schluessel = restSchluessel(p);
      if (schluessel) texte.set(schluessel, p);
    }
  }
  return texte;
}

/**
 * Der Zellzustand aus der REST-Wochenabfrage, uebersetzt in die Sprache von JSON-RPC.
 *
 * Bekannte Werte: STANDARD, SUBSTITUTION, ROOMSUBSTITUTION, CANCEL, ADDITIONAL, SHIFT, FREE, EXAM.
 * Geprueft wird auf Teilzeichenketten, weil Instanzen die Liste erweitern - ein unbekannter Wert
 * soll nichts kaputtmachen, sondern nur nichts aussagen.
 */
export function ausZellzustand(zustand) {
  const z = String(zustand ?? '').toUpperCase();
  if (z.includes('CANCEL')) return 'cancelled';
  // ROOMSUBSTITUTION enthaelt 'SUBSTITUT' und galt deshalb als Vertretung - eine blosse
  // Raumaenderung stand mit orangem Pfeil im Plan, als waere ein anderer Lehrer da. Sie ist
  // etwas Eigenes: derselbe Unterricht, nur woanders.
  if (z.includes('ROOM')) return 'roomchange';
  if (/SUBSTITUT|SHIFT|ADDITIONAL/.test(z)) return 'irregular';
  return null;
}

const restSchluessel = p =>
  p?.id ? `id:${p.id}` : (p?.date && p?.startTime ? `zeit:${p.date}-${p.startTime}` : null);

/**
 * Der Lehrstoff.
 *
 * Er steht NICHT in der Wochenabfrage: dort kommen 'periodText' (Notizen fuer Schueler*innen) und
 * 'periodInfo' an, 'lessonText' bleibt bei manchen Instanzen leer - genau das war zu sehen. Der
 * Lehrstoff haengt an dem Endpunkt, den die WebUntis-Oberflaeche fuer das Stundendetail benutzt,
 * und heisst dort 'teachingContent'.
 *
 * Rueckgabe: Liste von { date, von, bis, text } - 'date' als JJJJMMTT und die Zeiten als HHMM-Zahl,
 * dieselbe Form, in der JSON-RPC 'date' und 'startTime' liefert. Ueber die Zeit statt ueber IDs,
 * weil die IDs dieses Endpunkts andere sind als die der Stundenplan-Perioden. Mit Ende, nicht nur
 * Anfang: eine Doppelstunde kommt hier als EIN Eintrag 08:00-09:30, bei uns sind es zwei Stunden -
 * und die zweite bekam den Lehrstoff bisher nie.
 */
const tagIso = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() + n * 86_400_000)
  .toISOString().slice(0, 10);

/** Die Stundendetails fuer einen Zeitraum - v2 ist der heutige Pfad, v1 der aeltere. */
async function stundenDetails(sitzung, vonIso, bisIso, zeiten = ['T00:00:00Z', 'T23:59:59Z']) {
  const frage = `?elementType=${sitzung.personType}&elementId=${sitzung.personId}`
    + `&startDateTime=${vonIso}${zeiten[0]}&endDateTime=${bisIso}${zeiten[1]}&homeworkOption=DUE`;
  for (const v of ['v2', 'v1']) {
    const eintraege = eintraegeAusRest(
      await rest(sitzung, `/WebUntis/api/rest/view/${v}/calendar-entry/detail` + frage)
        .catch(() => null));
    if (eintraege) return eintraege;
  }
  return null;
}

/** Der Lehrstoff eines Eintrags - als Text, als Objekt mit Text, oder unter einem Nachbarnamen. */
const lehrstoffAus = e => {
  const tc = e?.teachingContent;
  return echterText(typeof tc === 'object' && tc ? (tc.text ?? tc.content ?? '') : tc)
    || echterText(e?.teachingContentText) || echterText(e?.notesAll);
};

export async function lehrstoff(sitzung, vonIso, bisIso) {
  const texte = [];
  for (const woche of textWochen(vonIso, bisIso)) {
    let eintraege = await stundenDetails(sitzung, woche, tagIso(woche, 6));
    // Liefert die Woche nichts, dann Tag fuer Tag: manche Instanzen beantworten nur kurze
    // Zeitraeume - sieben Anfragen statt einer, aber nur in diesem Fall.
    if (!eintraege?.length) {
      eintraege = [];
      for (let i = 0; i < 7; i++)
        eintraege.push(...(await stundenDetails(sitzung, tagIso(woche, i), tagIso(woche, i)) ?? []));
    }
    for (const e of eintraege) {
      const text = lehrstoffAus(e);
      const anfang = zeitpunkt(e.startDateTime ?? e.start ?? e.startTime);
      if (text && anfang) texte.push({ ...anfang, bis: zeitpunkt(e.endDateTime ?? e.end ?? e.endTime)?.von ?? null, text });
    }
  }
  return texte;
}

/**
 * Der Lehrstoff je Stunde - so, wie die WebUntis-Oberflaeche ihn holt: ein Aufruf mit exakter
 * Start- und Endzeit, ohne Sekunden, ohne Z. Bereichsanfragen (Woche, Tag) beantwortet mancher
 * Server mit 404 - genau das stand im Bericht einer Schule: 36 Stunden in der Woche, 404 fuer
 * jeden Bereich, bei v1 wie v2. Deshalb nur fuer ein enges Fenster und nur stuendlich.
 *
 * Rueckgabe wie lehrstoff(); null, wenn der Endpunkt gar nicht antwortet (fuenf Fehlschlaege in
 * Folge, ohne einen Treffer) - dann bleibt der gespeicherte Lehrstoff stehen.
 */
export async function lehrstoffJeStunde(sitzung, perioden) {
  const texte = [];
  let version = null, fehlschlaege = 0, treffer = 0;
  for (const p of perioden) {
    if (!p?.date || !p?.startTime || !p?.endTime) continue;
    const tag = String(p.date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const frage = `?elementType=${sitzung.personType}&elementId=${sitzung.personId}`
      + `&startDateTime=${tag}T${hhmm(p.startTime)}&endDateTime=${tag}T${hhmm(p.endTime)}&homeworkOption=DUE`;
    let eintraege = null;
    // Welche Version antwortet, entscheidet der erste Treffer - danach nur noch die.
    for (const v of version ? [version] : ['v2', 'v1']) {
      eintraege = eintraegeAusRest(
        await rest(sitzung, `/WebUntis/api/rest/view/${v}/calendar-entry/detail` + frage).catch(() => null));
      if (eintraege) { version = v; break; }
    }
    if (!eintraege) {
      if (++fehlschlaege >= 5 && !treffer) return null;
      continue;
    }
    treffer++;
    for (const e of eintraege) {
      const text = lehrstoffAus(e);
      // Die Zeit der Stunde, nach der gefragt wurde - nicht die des Eintrags: eine Doppelstunde
      // kommt als ein Eintrag, und beide Haelften sollen ihn tragen.
      if (text) texte.push({ date: String(p.date), von: Number(p.startTime), bis: Number(p.endTime), text });
    }
  }
  // Gefragt, aber nie eine Antwort: der Endpunkt fehlt - nichts ueberschreiben.
  return treffer || !fehlschlaege ? texte : null;
}

// --- Diagnose: was kommt an Texten wirklich zurueck? ------------------------------------
// Welcher Endpunkt an welcher Schule den Lehrstoff traegt, ist ohne echte Daten nicht zu wissen -
// bei IServ hat erst der Bericht die Anmeldung geklaert. Hier dasselbe: fuer EINEN Tag alles
// durchprobieren und aufschreiben, was zurueckkam - Status, Schluessel, und jedes Textfeld mit
// seinem Pfad, egal wie es heisst.

/** Alle Strings ab drei Zeichen, die nicht nach ID, Datum, Farbe oder Adresse aussehen - mit Pfad. */
export function textFelder(obj, pfad = '', raus = [], tiefe = 0) {
  if (tiefe > 5 || !obj || typeof obj !== 'object' || raus.length > 40) return raus;
  for (const [k, v] of Object.entries(obj)) {
    const p = pfad ? `${pfad}.${k}` : k;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length >= 3 && !/^[\d.:T Z+-]+$/.test(t) && !/^#?[0-9a-f]{6}$/i.test(t) && !/^https?:/.test(t)
        && !/^[A-Z_]{3,}$/.test(t))
        raus.push(`${p}: "${t.replace(/\s+/g, ' ').slice(0, 60)}${t.length > 60 ? '…' : ''}"`);
    } else if (v && typeof v === 'object') textFelder(v, p, raus, tiefe + 1);
  }
  return raus;
}

/** Ein Abruf fuer den Bericht: Status statt Ausnahme, Nutzlast wenn JSON. */
async function abruf(sitzung, pfad) {
  const res = await fetch(sitzung.host + pfad, {
    headers: { cookie: sitzung.cookie, 'x-requested-with': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  }).catch(err => ({ status: err.name === 'TimeoutError' ? 'Zeitüberschreitung' : 'nicht erreichbar' }));
  const daten = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  return { status: res.status, daten };
}

const hhmm = n => String(n).padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1:$2');

export async function texteDiagnose(sitzung, tagIsoWert) {
  const zeilen = [`Textdiagnose für ${tagIsoWert} (Person ${sitzung.personId}, Typ ${sitzung.personType})`];
  const block = (titel, ...z) => zeilen.push('', `## ${titel}`, ...z);
  // Eine Fehlerantwort in einem Satz: requestId und traceId helfen niemandem.
  const nutzlast = d => !d || typeof d !== 'object' ? 'kein JSON'
    : d.errorMessage ? `Fehler: ${d.errorMessage}`
      : `Schlüssel: ${Object.keys(d).join(', ') || '–'}`;
  const felder = (d, max = 25) => {
    const f = textFelder(d);
    return f.length ? f.slice(0, max).map(x => '  ' + x) : ['  (keine Textfelder)'];
  };

  // 1. JSON-RPC: die Stunden des Tages, mit dem, was dort an Text steht.
  let perioden = [];
  try {
    const { ergebnis } = await rpc(sitzung.url, 'getTimetable', {
      options: {
        element: { id: sitzung.personId, type: sitzung.personType },
        startDate: alsUntisDatum(tagIsoWert), endDate: alsUntisDatum(tagIsoWert),
        showInfo: true, showSubstText: true, showLsText: true, showLsNumber: true,
        showStudentgroup: true, showBooking: true,
      },
    }, sitzung.cookie);
    perioden = (ergebnis ?? []).sort((a, b) => a.startTime - b.startTime);
    block('JSON-RPC getTimetable', `${perioden.length} Stunden`,
      ...perioden.map(p => `  ${hhmm(p.startTime)}–${hhmm(p.endTime)} ${p.su?.[0]?.name ?? '?'} (id ${p.id}, ls ${p.lsnumber ?? '–'})`
        + ' Text: ' + (['lstext', 'bkText', 'bkRemark', 'info', 'substText']
          .filter(k => echterText(p[k])).map(k => `${k}="${String(p[k]).slice(0, 40)}"`).join(', ') || 'keins')));
  } catch (err) {
    block('JSON-RPC getTimetable', `Fehler: ${err.message}`);
  }
  const erste = perioden[0] ?? null;
  const woche = new Date(tagIsoWert + 'T12:00:00Z');
  woche.setUTCDate(woche.getUTCDate() - ((woche.getUTCDay() + 6) % 7));
  const montag = woche.toISOString().slice(0, 10);
  const tag = alsUntisDatum(tagIsoWert);

  // 2. Die Wochenabfrage - so, wie sie der Abgleich benutzt.
  for (const zusatz of ['', '&formatId=1']) {
    const pfad = `/WebUntis/api/public/timetable/weekly/data?elementType=${sitzung.personType}`
      + `&elementId=${sitzung.personId}&date=${montag}${zusatz}`;
    const { status, daten } = await abruf(sitzung, pfad);
    const alle = periodenAusRest(daten) ?? [];
    const heute = alle.filter(p => Number(p.date) === tag);
    block(`REST Woche${zusatz || ' (ohne formatId)'}`, `Status ${status}, ${nutzlast(daten)}`,
      `${alle.length} Perioden in der Woche, ${heute.length} an diesem Tag`,
      ...(heute[0] ? [`  Schlüssel einer Periode: ${Object.keys(heute[0]).join(', ')}`] : []),
      ...heute.map(p => `  ${hhmm(p.startTime)} ` + (textFelder(p).join(' | ') || 'kein Text')));
  }

  // 3. Das Stundendetail: Woche, Tag, exakt eine Stunde - je v2 und v1.
  const spannen = [['Woche', montag, tagIso(montag, 6), ['T00:00:00Z', 'T23:59:59Z']],
    ['Tag', tagIsoWert, tagIsoWert, ['T00:00:00Z', 'T23:59:59Z']]];
  // Die exakte Stunde in drei Schreibweisen - die Oberflaeche schickt die erste.
  if (erste) {
    const [a, e] = [hhmm(erste.startTime), hhmm(erste.endTime)];
    spannen.push(['erste Stunde', tagIsoWert, tagIsoWert, [`T${a}`, `T${e}`]],
      ['erste Stunde, mit Sekunden', tagIsoWert, tagIsoWert, [`T${a}:00`, `T${e}:00`]],
      ['erste Stunde, UTC', tagIsoWert, tagIsoWert, [`T${a}:00Z`, `T${e}:00Z`]]);
  }
  for (const v of ['v2', 'v1']) {
    for (const [name, von, bis, zeiten] of spannen) {
      const pfad = `/WebUntis/api/rest/view/${v}/calendar-entry/detail?elementType=${sitzung.personType}`
        + `&elementId=${sitzung.personId}&startDateTime=${von}${zeiten[0]}&endDateTime=${bis}${zeiten[1]}&homeworkOption=DUE`;
      const { status, daten } = await abruf(sitzung, pfad);
      const eintraege = eintraegeAusRest(daten) ?? [];
      block(`calendar-entry/detail ${v}, ${name}`, `Status ${status}, ${nutzlast(daten)}`,
        ...(daten?.errorMessage ? [] : [`${eintraege.length} Einträge`]),
        ...eintraege.slice(0, 12).flatMap(e => [
          `  ${e.startDateTime ?? e.start ?? '?'} – ${e.endDateTime ?? e.end ?? '?'}  Schlüssel: ${Object.keys(e).slice(0, 30).join(', ')}`,
          ...felder(e, 12)]));
    }
  }

  // 4. Der klassische Stundendetail-Endpunkt fuer die erste Stunde.
  if (erste) {
    const pfad = `/WebUntis/api/public/period/info?date=${tag}&starttime=${erste.startTime}`
      + `&endtime=${erste.endTime}&elemType=${sitzung.personType}&elemId=${sitzung.personId}`;
    const { status, daten } = await abruf(sitzung, pfad);
    block('period/info (klassisch), erste Stunde', `Status ${status}, ${nutzlast(daten)}`,
      ...(daten?.errorMessage ? [] : felder(daten)));
  }

  // 5. Die neue Plan-API - in beiden Versionen und beiden Plan-Arten.
  for (const v of ['v1', 'v2']) {
    for (const art of ['MY_TIMETABLE', 'STANDARD']) {
      const pfad = `/WebUntis/api/rest/view/${v}/timetable/entries?start=${tagIsoWert}&end=${tagIsoWert}`
        + `&format=2&resourceType=${sitzung.personType === 2 ? 'TEACHER' : 'STUDENT'}`
        + `&resources=${sitzung.personId}&periodTypes=&timetableType=${art}`;
      const { status, daten } = await abruf(sitzung, pfad);
      block(`timetable/entries ${v}, ${art}`, `Status ${status}, ${nutzlast(daten)}`,
        ...(daten?.errorMessage ? [] : felder(daten, 40)));
    }
  }
  return zeilen.join('\n');
}

/** "2026-09-02T08:45:00Z" wird zu { date: '20260902', von: 845 } - wie JSON-RPC die Stunde nennt. */
function zeitpunkt(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? { date: `${m[1]}${m[2]}${m[3]}`, von: Number(m[4] + m[5]) } : null;
}

/**
 * Der Lehrstoff zu einer JSON-RPC-Stunde: der Eintrag desselben Tages, dessen Zeitspanne die
 * Stunde ueberlappt. Ohne Ende zaehlt nur die gleiche Anfangszeit - wie bisher.
 */
export function stoffFuer(liste, p) {
  const von = Number(p?.startTime), bis = Number(p?.endTime) || von + 1;
  return liste.find(e => e.date === String(p?.date)
    && (e.bis == null ? e.von === von : e.von < bis && e.bis > von))?.text ?? '';
}

/** Wie bei den Wochentexten: die Nutzlast suchen statt annehmen, sie liegt je nach Version anders. */
function eintraegeAusRest(roh) {
  let gefunden = null;
  const suche = (o, tiefe) => {
    if (gefunden || !o || typeof o !== 'object' || tiefe > 6) return;
    if (Array.isArray(o.calendarEntries)) {
      // Eine Stunde kann als ein Eintrag mit mehreren Einzelstunden kommen - beide Ebenen zaehlen.
      gefunden = o.calendarEntries.flatMap(e =>
        Array.isArray(e?.singleEntries) && e.singleEntries.length
          ? e.singleEntries.map(s => ({ ...e, ...s }))
          : [e]).filter(e => e && typeof e === 'object');
      return;
    }
    for (const wert of Object.values(o)) suche(wert, tiefe + 1);
  };
  suche(roh, 0);
  return gefunden;
}

/** Die Nutzlast liegt je nach Version unterschiedlich tief - deshalb suchen statt annehmen. */
function periodenAusRest(roh) {
  let gefunden = null;
  const suche = (o, tiefe) => {
    if (gefunden || !o || typeof o !== 'object' || tiefe > 6) return;
    if (o.elementPeriods && typeof o.elementPeriods === 'object') {
      gefunden = Object.values(o.elementPeriods).flat().filter(p => p && typeof p === 'object');
      return;
    }
    for (const wert of Object.values(o)) suche(wert, tiefe + 1);
  };
  suche(roh, 0);
  return gefunden;
}

export async function stundenplan(sitzung, vonIso, bisIso, { lehrstoff: jeStunde = false } = {}) {
  const { ergebnis } = await rpc(sitzung.url, 'getTimetable', {
    options: {
      element: { id: sitzung.personId, type: sitzung.personType },
      startDate: alsUntisDatum(vonIso),
      endDate: alsUntisDatum(bisIso),
      showInfo: true,
      showSubstText: true,
      showLsText: true,
      showLsNumber: true,
      showStudentgroup: true,
      showBooking: true,
      klasseFields: ['id', 'name'],
      roomFields: ['id', 'name', 'longname'],
      subjectFields: ['id', 'name', 'longname'],
      teacherFields: ['id', 'name', 'longname'],
    },
  }, sitzung.cookie);
  const perioden = Array.isArray(ergebnis) ? ergebnis : [];

  // Die Texte sind eine Zugabe: geht ein Abruf schief, steht der Plan trotzdem. Deshalb beide
  // einzeln abgesichert - der Lehrstoff darf die Notizen nicht mitreissen und umgekehrt.
  let [texte, stoff] = await Promise.all([
    stundentexte(sitzung, vonIso, bisIso).catch(() => new Map()),
    lehrstoff(sitzung, vonIso, bisIso).catch(() => []),
  ]);
  // Fuer welche Stunden der Lehrstoff wirklich geholt wurde: nur dort darf "kein Text" den
  // gespeicherten ueberschreiben. Kam der billige Weg (Woche/Tag) mit etwas zurueck, gilt er fuer
  // alle; sonst - und nur wenn der Aufrufer es will - der Abruf je Stunde fuer -7..+7 Tage.
  const geholt = new Set(stoff.length ? perioden : []);
  if (!stoff.length && jeStunde) {
    const heute = new Date().toISOString().slice(0, 10);
    const [von, bis] = [alsUntisDatum(tagIso(heute, -7)), alsUntisDatum(tagIso(heute, 7))];
    const imFenster = perioden.filter(p => Number(p.date) >= von && Number(p.date) <= bis);
    const je = await lehrstoffJeStunde(sitzung, imFenster).catch(() => null);
    if (je) { stoff = je; imFenster.forEach(p => geholt.add(p)); }
  }
  for (const p of perioden) {
    const r = texte.get(restSchluessel(p));
    // Schon hier filtern, nicht erst beim Zusammenbau: sonst gewinnt ein blosser Strich aus
    // JSON-RPC gegen den echten Text aus REST.
    if (r) {
      p.lstext = echterText(p.lstext) || echterText(r.lessonText);
      p.bkText = echterText(p.bkText) || echterText(r.periodText);
      p.info = echterText(p.info) || echterText(r.periodInfo);
      p.substText = echterText(p.substText) || echterText(r.substText);
      // Die Wochenabfrage sagt selbst, was mit der Stunde ist - dieselbe Antwort, die den
      // Lehrstoff gebracht hat. Sie lag hier schon im Speicher und wurde bisher weggeworfen.
      // JSON-RPC hat Vorrang: wenn es sich festgelegt hat, bleibt es dabei.
      const zustand = r.cellState ? ausZellzustand(r.cellState) : null;
      // EXAM: hier wird geschrieben - der Plan zeigt diese Stunde dann vor einer ausgefallenen.
      if (/EXAM/i.test(String(r.cellState ?? ''))) p.istPruefung = true;
      if (zustand === 'roomchange') p.raumWechsel = true;
      else if (!p.code && zustand) p.code = zustand;
    }
    // Getrennt vom Unterrichtstext: eine Stunde mit "Klausur" als Text verlor sonst ihren Lehrstoff.
    // null heisst: nicht geholt - der gespeicherte bleibt. '' heisst: geholt, und es gibt keinen.
    p.lehrstoff = geholt.has(p) ? stoffFuer(stoff, p) : null;
  }
  perioden.lehrstoffGefunden = stoff.length;
  perioden.lehrstoffGeholt = geholt.size > 0;
  return perioden;
}

/**
 * Ferien und Feiertage. Schulweit, nicht pro Person - wer sie abruft, holt sie fuer alle.
 * Ohne sie sieht eine Ferienwoche aus wie eine, deren Plan die Schule noch nicht veroeffentlicht
 * hat: leer, und niemand weiss warum.
 */
/**
 * Die "Nachrichten zum Tag" der Schule - dieselbe Anfrage, die die Heute-Seite stellt.
 *
 * Rueckgabe: { nachrichten: [{ id, titel, text }], rssUrl } - die Adresse des Feeds liefert die
 * Seite gleich mit, dann muss sie niemand von Hand eintragen. Text kommt als HTML und wird zu
 * Zeilen; Links bleiben als Markdown erhalten.
 */
export async function tagesNachrichten(sitzung, tagIsoWert) {
  const roh = await rest(sitzung, `/WebUntis/api/public/news/newsWidgetData?date=${alsUntisDatum(tagIsoWert)}`);
  let daten = null;
  const suche = (o, tiefe) => {
    if (daten || !o || typeof o !== 'object' || tiefe > 4) return;
    if (Array.isArray(o.messagesOfDay)) { daten = o; return; }
    for (const wert of Object.values(o)) suche(wert, tiefe + 1);
  };
  suche(roh, 0);
  return {
    nachrichten: (daten?.messagesOfDay ?? []).filter(m => m && typeof m === 'object').map(m => ({
      id: String(m.id ?? m.messageId ?? `${m.subject}|${tagIsoWert}`),
      titel: htmlZuText(m.subject ?? m.title ?? '') || 'Nachricht zum Tag',
      text: htmlZuText(m.text ?? m.body ?? ''),
    })),
    rssUrl: typeof daten?.rssUrl === 'string' && /^https:/i.test(daten.rssUrl) ? daten.rssUrl : null,
  };
}

export async function ferien(sitzung) {
  const { ergebnis } = await rpc(sitzung.url, 'getHolidays', {}, sitzung.cookie);
  return (Array.isArray(ergebnis) ? ergebnis : [])
    .filter(f => f?.startDate && f?.endDate)
    .map(f => ({
      name: String(f.longName || f.name || 'Ferien').slice(0, 60),
      von: datum(f.startDate),
      bis: datum(f.endDate),
    }));
}

/**
 * Das Stundenraster der Schule: wann die 1., 2., ... Stunde beginnt und endet.
 *
 * Gebraucht wird es, seit sich Leute von verschiedenen Schulen anmelden koennen - eine Schule, die
 * um 7:30 anfaengt, faellt sonst durch die Rasterzuordnung und haette einen leeren Plan.
 *
 * Antwort: [{ day, timeUnits: [{ name, startTime, endTime }] }] - je Wochentag dasselbe Raster,
 * an manchen Schulen fehlen aber am Samstag Stunden. Genommen wird deshalb der Tag mit den MEISTEN
 * Einheiten.
 *
 * Die Nummer kommt aus dem Namen, aber nur wenn er an JEDER Einheit eine eigene Zahl ist: Schulen
 * mit einer 0. Stunde zaehlen sonst um eins verschoben, und im Plan staende an der Stunde eine
 * Nummer, die im Haus niemand benutzt. Sobald ein "1a" dabei ist oder eine Zahl doppelt vorkommt,
 * zaehlt die Reihenfolge - die ist immer eindeutig, und zwei Stunden mit derselben Nummer wuerde
 * die Datenbank stillschweigend zu einer machen.
 */
export async function raster(sitzung) {
  const { ergebnis } = await rpc(sitzung.url, 'getTimegridUnits', {}, sitzung.cookie);
  const tage = (Array.isArray(ergebnis) ? ergebnis : [])
    .map(t => (Array.isArray(t?.timeUnits) ? t.timeUnits : []).filter(u => u?.startTime && u?.endTime))
    .filter(u => u.length);
  if (!tage.length) return [];
  const beste = tage.reduce((a, b) => (b.length > a.length ? b : a));
  const namen = beste.map(u => Number(u.name));
  const ausNamen = namen.every(Number.isInteger) && new Set(namen).size === namen.length;
  return beste.map((u, i) => ({
    nr: ausNamen ? namen[i] : i + 1,
    start_time: zeit(u.startTime),
    end_time: zeit(u.endTime),
  }));
}

/**
 * Von Lehrern eingetragene Hausaufgaben. Anders als der Stundenplan laeuft das nicht ueber
 * JSON-RPC, sondern ueber die REST-Schnittstelle - und die will die Schule im Cookie sehen,
 * nicht im Query-String. Genau daran waere es sonst gescheitert.
 *
 * Antwort: { data: { homeworks: [{ id, lessonId, date, dueDate, text, remark, completed }] } }
 * Wie Fach und Lehrer daran haengen, ist nicht dokumentiert; lessonId entspricht der lsnumber
 * aus dem Stundenplan, darueber laesst sich der Kurs zuordnen.
 */
async function rest(sitzung, pfad) {
  const res = await fetch(sitzung.host + pfad, {
    headers: { cookie: sitzung.cookie, 'x-requested-with': 'XMLHttpRequest' },
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  }).catch(() => { throw new Error('WebUntis ist nicht erreichbar'); });
  if (!res.ok) throw new Error(`WebUntis antwortet mit ${res.status}`);
  return res.json().catch(() => null);
}

export async function hausaufgaben(sitzung, vonIso, bisIso) {
  const roh = await rest(sitzung, `/WebUntis/api/homeworks/lessons`
    + `?startDate=${alsUntisDatum(vonIso)}&endDate=${alsUntisDatum(bisIso)}`);
  const liste = roh?.data?.homeworks;
  if (!Array.isArray(liste)) return [];

  return liste
    .filter(h => h && h.dueDate)
    .map(h => ({
      untis_id: Number(h.id) || null,
      lesson_id: Number(h.lessonId) || null,
      date: datum(h.date ?? h.dueDate),
      due_date: datum(h.dueDate),
      text: echterText(h.text).slice(0, 500),
      remark: echterText(h.remark).slice(0, 300) || null,
    }))
    .filter(h => h.text || h.remark);
}

/**
 * Der Pruefungskalender der Schule.
 *
 * Zwei Wege, weil die Instanzen verschieden sind: erst die REST-Schnittstelle, die auch die
 * Weboberflaeche benutzt, sonst JSON-RPC. Gibt die Schule ihn Schuelerkonten nicht heraus, kommt
 * nichts - und der Abgleich laeuft trotzdem weiter. Ein leerer Pruefungskalender ist kein Grund,
 * den Stundenplan fallen zu lassen.
 */
export async function pruefungen(sitzung, vonIso, bisIso) {
  const form = e => ({
    untis_id: Number(e.id ?? e.examId) || null,
    date: datum(e.examDate ?? e.date),
    start: zeit(e.startTime ?? e.startDateTime ?? 0),
    end: zeit(e.endTime ?? e.endDateTime ?? 0),
    titel: echterText(e.name ?? e.text ?? e.examType ?? '') || 'Prüfung',
    fach: ersterName(e.subject ? [{ name: e.subject }] : e.subjects) ?? null,
  });
  const brauchbar = e => e && (e.examDate ?? e.date);

  const roh = await rest(sitzung,
    `/WebUntis/api/exams?startDate=${alsUntisDatum(vonIso)}&endDate=${alsUntisDatum(bisIso)}`)
    .catch(() => null);
  const ausRest = roh?.data?.exams ?? roh?.exams;
  if (Array.isArray(ausRest) && ausRest.length) return ausRest.filter(brauchbar).map(form);

  const { ergebnis } = await rpc(sitzung.url, 'getExams', {
    id: sitzung.personId, type: sitzung.personType,
    startDate: alsUntisDatum(vonIso), endDate: alsUntisDatum(bisIso),
  }, sitzung.cookie).catch(() => ({ ergebnis: null }));
  return (Array.isArray(ergebnis) ? ergebnis : []).filter(brauchbar).map(form);
}

export const logout = sitzung =>
  rpc(sitzung.url, 'logout', {}, sitzung.cookie).catch(() => {});

// --- Aufbereitung ------------------------------------------------------------

const datum = n => {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

// WebUntis liefert 800 fuer 08:00 und 1350 fuer 13:50.
const zeit = n => String(n).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2');

/**
 * Text, der wirklich etwas sagt - sonst der leere String.
 *
 * In WebUntis ist ein einzelner Strich die uebliche Art, "nichts eingetragen" zu schreiben.
 * Ungefiltert wurde daraus ein "Lehrstoff:\n-", ein ℹ an der Stunde und ein angehaengtes " -" im
 * Ausfallhinweis - also ein Zeichen, das eine Notiz verspricht und keine hat.
 *
 * Nur Strich, Schraegstrich, Punkt und Unterstrich zaehlen als leer; sobald ein Buchstabe oder
 * eine Ziffer dabei ist, bleibt der Text stehen ("-1 bis -5" ueberlebt).
 */
export const echterText = t =>
  (/^[\s\-–—_./\\]*$/.test(String(t ?? '')) ? '' : String(t).trim());

const ersterName = (liste, feld = 'name') =>
  Array.isArray(liste) && liste.length ? (liste[0][feld] ?? liste[0].name ?? null) : null;

// Wird ein Raum getauscht, nennt WebUntis den urspruenglichen in 'orgname' - beim Lehrer genauso.
const orgName = liste =>
  (Array.isArray(liste) ? liste : []).map(e => e?.orgname).find(Boolean) ?? null;

// Eine stabile Kurs-ID ist die Voraussetzung dafuer, dass gemeinsame Stunden und die kursweiten
// Hausaufgaben weiter funktionieren: zwei Leute im selben WebUntis-Kurs muessen dieselbe ID
// bekommen. lsnumber ist genau die Kursnummer; ohne sie bleibt nur Fach+Lehrer, und dann koennen
// zwei verschiedene Kurse desselben Lehrers im selben Fach zusammenfallen.
// Das Praefix trennt die Schulen: dieselbe lsnumber gibt es an jeder Schule, und ohne Praefix
// teilten wildfremde Leute Kurs, Farbe und Hausaufgaben. Die Standardschule bekommt KEINS - ihre
// IDs stehen so in jeder bestehenden Datenbank.
export function kursId(p, praefix = '') {
  if (p.lsnumber) return `${praefix}UNTIS-${p.lsnumber}`;
  const fach = ersterName(p.su) ?? 'X';
  const lehrer = ersterName(p.te) ?? 'X';
  // Die Klasse gehoert mit hinein: ohne sie fielen "Mathe bei Frau Klein" im 12. und im 13.
  // Jahrgang zu EINEM Kurs zusammen - mit gemeinsamen Hausaufgaben. Wo WebUntis eine Kursnummer
  // liefert, spielt das ohnehin keine Rolle.
  const klasse = ersterName(p.kl);
  return `${praefix}UNTIS-${fach}-${lehrer}${klasse ? '-' + klasse : ''}`.slice(0, 48);
}

/** Rohe WebUntis-Perioden in ein flaches, geprueftes Format bringen. */
export function aufbereiten(perioden, praefix = '') {
  return perioden
    .filter(p => p && p.date && p.startTime)
    .map(p => ({
      date: datum(p.date),
      start: zeit(p.startTime),
      end: zeit(p.endTime ?? p.startTime),
      course_id: kursId(p, praefix),
      subject: ersterName(p.su, 'longname') ?? ersterName(p.su),
      subject_short: ersterName(p.su),
      teacher: ersterName(p.te, 'longname') ?? ersterName(p.te),
      room: ersterName(p.ro),
      // Der Raum, in dem die Stunde eigentlich waere. Drei Faelle, und alle drei sind
      // unterscheidbar: null heisst "kein Wechsel", ein Name heisst "statt DIESEM Raum", und der
      // leere Text heisst "gewechselt, aber WebUntis sagt nicht, woher" - das ist der Fall, in dem
      // nur der Zellzustand ROOMSUBSTITUTION vorliegt.
      room_regulaer: orgName(p.ro) ?? (p.raumWechsel ? '' : null),
      // Der Status haengt NICHT allein an 'code'. Viele Instanzen setzen ihn bei einer Vertretung
      // gar nicht und tauschen nur den Lehrer aus, mit einem Hinweis in 'substText' - so eine
      // Stunde galt bisher als voellig regulaer, und die Vertretung war nirgends zu sehen.
      // Ausfall gewinnt vor Vertretung: eine Stunde, die entfaellt, wird nicht vertreten.
      status: p.code === 'cancelled' ? 'cancelled'
        : p.code === 'irregular' || echterText(p.substText) ? 'irregular' : 'regular',
      // Zwei Sorten Text, absichtlich getrennt: 'info' ist kurz und sagt, was mit der STUNDE ist
      // (Vertretung, Ausfall) - das gehoert in die Zelle. 'lesson_text' ist, was der Lehrer
      // hineingeschrieben hat: Lehrstoff und Notizen, oft mehrzeilig und oft mit den eigentlichen
      // Hausaufgaben darin. Frueher wurde beides mit " · " verklebt und die Struktur war hin.
      info: [echterText(p.substText), echterText(p.info)].filter(Boolean).join(' · ') || null,
      // Der Lehrstoff hat sein eigenes Feld und seinen eigenen Takt (stuendlich, je Stunde ein
      // Aufruf): null = in diesem Lauf nicht geholt, dann bleibt der gespeicherte stehen.
      lehrstoff: p.lehrstoff == null ? null : echterText(p.lehrstoff),
      lesson_text: [
        // Der Text am Unterricht selbst - nur, wenn er nicht bloss den Lehrstoff wiederholt.
        ['Unterrichtstext', echterText(p.lstext) !== echterText(p.lehrstoff) ? echterText(p.lstext) : ''],
        ['Notizen für Schüler*innen', echterText(p.bkText)],
        ['Bemerkung', echterText(p.bkRemark)],
      ].filter(([, t]) => t).map(([titel, t]) => `${titel}:\n${t}`).join('\n\n') || null,
      gruppe: p.sg ?? null,
      // Eine Pruefung (JSON-RPC: lstype 'ex', REST: Zellzustand EXAM). Reicht eine Klausur in die
      // naechste Stunde hinein, steht sie dort neben der eigentlichen - und soll gewinnen.
      pruefung: p.lstype === 'ex' || !!p.istPruefung,
    }))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// --- Schulsuche ---------------------------------------------------------------
// Die Schule steht in der Anmelde-URL als ?school=<Anmeldename>, und den kennt kaum jemand - er
// ist nicht der Anzeigename. WebUntis beantwortet die Suche oeffentlich und ohne Anmeldung; damit
// braucht es fuer die Einrichtung keinen Admin-Zugang, jeder Schueler findet seine Schule selbst.

const SUCHE_URL = 'https://mobile.webuntis.com/ms/schoolquery2';

export const ohneSchema = s =>
  String(s ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

// Der Servername kommt aus einem Formularfeld und landet direkt in der URL, an die wir gleich
// Schulpasswoerter schicken. Ohne diese Pruefung koennte jemand die App auf seinen eigenen Server
// zeigen lassen und die Zugaenge aller anderen einsammeln - und nebenbei liesse sich damit jede
// interne Adresse anfragen. Untis hostet ausschliesslich unter webuntis.com.
export const untisHostOk = server => /^[a-z0-9][a-z0-9-]*\.webuntis\.com$/.test(ohneSchema(server).toLowerCase());

export const schulenAufbereiten = ergebnis =>
  (ergebnis?.schools ?? [])
    .map(s => ({
      name: s.displayName || s.loginName,
      ort: s.address ?? '',
      server: ohneSchema(s.server),
      schule: s.loginName,
    }))
    .filter(s => s.server && s.schule);

export async function schulenSuchen(text) {
  const suche = String(text ?? '').trim();
  if (suche.length < 3) throw new Error('Bitte mit mindestens drei Zeichen suchen');
  try {
    const { ergebnis } = await rpc(SUCHE_URL, 'searchSchool', [{ search: suche }]);
    return schulenAufbereiten(ergebnis);
  } catch (err) {
    // WebUntis liefert bei zu vielen Treffern einen Fachfehler statt einer gekuerzten Liste.
    if (/too many/i.test(err.message)) throw new Error('Zu viele Treffer — bitte genauer suchen');
    throw err;
  }
}
