// --- iserv ---
// Der Draht zu einem IServ der Schule. Eine Zustaendigkeit: HTTP und Aufbereitung. Von Express,
// der Datenbank und den Nutzern weiss diese Datei nichts.
//
// IServ hat fuer den Stundenplan KEINE Schnittstelle. Das Modul importiert Untis-, DaVinci- oder
// svPlaner-Dateien und zeigt sie an - es gibt kein REST, kein iCal, keinen Export. Gelesen wird
// deshalb die Seite, die auch ein Mensch sieht, mit seinem Konto und seiner Sitzung.
//
// Alles hier ist bewusst tolerant: wie diese Seite aussieht, ist von Schule zu Schule verschieden.
// Wo etwas nicht passt, kommt lieber nichts heraus als etwas Erfundenes - und was wirklich ankam,
// sagt der Bericht, den 'stundenplan' mitliefert.

import { netz, ohneSchema, nurHost, hostOk, adresseErlaubt, KOPF } from './netz.js';

// Die Adresspruefung steht in netz.js - die abonnierten Kalender brauchen dieselbe. Hier bleiben
// die alten Namen stehen, damit von aussen nichts umzulernen ist.
export { netz, ohneSchema, adresseErlaubt };
export const iservHostOk = hostOk;

const TIMEOUT = 12_000;

/** Fehler, die einem Menschen etwas sagen - ohne URLs, Stacktraces oder Rohantworten. */
export class IservFehler extends Error {}

const basisUrl = server => 'https://' + nurHost(server);

// --- HTTP ---------------------------------------------------------------------

async function hole(url, opt = {}) {
  try {
    return await fetch(url, { ...opt, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new IservFehler(err?.name === 'TimeoutError'
      ? 'IServ antwortet nicht' : 'IServ ist nicht erreichbar — stimmt die Adresse der Schule?');
  }
}

// Set-Cookie einsammeln und mit dem bisherigen Stand zusammenfuehren: IServ setzt beim Anmelden
// eine neue Sitzung, und ohne das Zusammenfuehren ginge unterwegs eine verloren.
function kekse(res, bisher = '') {
  const alle = new Map(bisher ? bisher.split('; ').filter(Boolean).map(c => [c.split('=')[0], c]) : []);
  for (const k of res.headers.getSetCookie?.() ?? []) {
    const paar = k.split(';')[0];
    if (paar.includes('=')) alle.set(paar.split('=')[0], paar);
  }
  return [...alle.values()].join('; ');
}

const MAX_SPRUENGE = 5;

/**
 * Abrufen und Weiterleitungen folgen - wie ein Browser, nur misstrauischer.
 *
 * JEDES Ziel wird neu geprueft. Ohne das waere das Folgen genau das Loch, das die Adresspruefung
 * schliessen soll: eine Adresse, die auf 169.254.169.254 weiterleitet, fuehrte den Server sonst
 * dorthin. Nach einer Weiterleitung wird gelesen statt noch einmal gesendet - so macht es ein
 * Browser bei 302 auch.
 */
async function holeFolgend(url, opt = {}, cookie = '', schritte = []) {
  let ziel = url, mit = opt, keks = cookie;
  for (let i = 0; i < MAX_SPRUENGE; i++) {
    const u = new URL(ziel);
    if (u.protocol !== 'https:' || !hostOk(u.hostname) || !(await adresseErlaubt(u.hostname))) {
      schritte.push({ url: `${u.protocol}//${u.hostname}${u.pathname}`, status: 0,
        fehler: 'Ziel abgewiesen' });
      throw new IservFehler(`Die Weiterleitung führt nach ${u.protocol}//${u.hostname} — abgebrochen`);
    }
    const res = await hole(ziel, {
      ...mit,
      headers: { ...KOPF, ...mit.headers, ...(keks && { cookie: keks }) },
    });
    keks = kekse(res, keks);
    const ort = res.headers.get('location');
    schritte.push({ url: u.pathname, status: res.status, weiter: ort ?? null,
      keks: keks ? keks.split('; ').map(c => c.split('=')[0]).join(', ') : null });
    if (!(res.status >= 300 && res.status < 400 && ort))
      return { res, url: ziel, cookie: keks };
    ziel = new URL(ort, ziel).href;
    mit = { method: 'GET' };
  }
  throw new IservFehler('IServ leitet im Kreis');
}

// --- Das Anmeldeformular lesen -------------------------------------------------

const attrWert = (attr, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attr);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};

/**
 * Das Anmeldeformular einer Seite - Ziel, Feldnamen und alles Versteckte.
 *
 * Geraten wurde vorher: POST auf dieselbe Adresse mit `_username`/`_password`. Dabei steht im
 * Formular, wohin es geht und wie die Felder heissen - samt Schutzfeld gegen Fremdanfragen. Wer
 * das liest, kommt auch mit einer Instanz zurecht, die es anders nennt.
 */
export function formularAus(html, seitenUrl) {
  for (const [, attr, inhalt] of String(html ?? '').matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const felder = {};
    let userFeld = null, passFeld = null;
    for (const [, iattr] of inhalt.matchAll(/<input\b([^>]*)>/gi)) {
      const name = attrWert(iattr, 'name');
      if (!name) continue;
      const typ = (attrWert(iattr, 'type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'image', 'reset', 'file'].includes(typ)) continue;
      // Ein Haken zaehlt nur, wenn er gesetzt ist ("angemeldet bleiben").
      if ((typ === 'checkbox' || typ === 'radio') && !/\bchecked\b/i.test(iattr)) continue;
      felder[name] = attrWert(iattr, 'value') ?? '';
      if (typ === 'password') passFeld ??= name;
      // Das Benutzerfeld ist das erste Textfeld VOR dem Passwortfeld.
      else if (!passFeld && ['text', 'email', 'tel'].includes(typ)) userFeld ??= name;
    }
    if (!passFeld) continue;
    return {
      action: new URL(attrWert(attr, 'action') || seitenUrl, seitenUrl).href,
      felder, userFeld: userFeld ?? '_username', passFeld,
    };
  }
  return null;
}

const fehler = (text, bericht) => Object.assign(new IservFehler(text), { bericht });

/** Wo die Anmeldung liegen kann. Der erste Weg ist der von IServ, die anderen sind Rueckfall. */
export const LOGIN_PFADE = ['/iserv/app/login', '/iserv/login', '/login'];

/**
 * Anmelden - so, wie es ein Browser tut: der Weiterleitung folgen, das Formular lesen, genau das
 * senden, was darin steht.
 *
 * Der Bericht faellt dabei immer an, auch im Fehlerfall. Ohne ihn ist "Anmeldung fehlgeschlagen"
 * eine Sackgasse: von aussen sieht man nicht, ob die Seite fehlte, das Formular anders heisst oder
 * das Passwort falsch ist.
 */
export async function anmelden(server, user, passwort) {
  const bericht = { server: nurHost(server), schritte: [], formular: null, angemeldet: false };
  if (!hostOk(server))
    throw fehler('Das sieht nicht nach der Adresse einer Schule aus', bericht);
  if (!(await adresseErlaubt(server)))
    throw fehler('Diese Adresse führt nicht ins offene Netz', bericht);

  const basis = basisUrl(server);
  let seite = null, form = null;
  for (const pfad of LOGIN_PFADE) {
    const antwort = await holeFolgend(basis + pfad, {}, '', bericht.schritte);
    if (antwort.res.status !== 200) continue;
    const html = await antwort.res.text().catch(() => '');
    const gefunden = formularAus(html, antwort.url);
    if (gefunden) { seite = antwort; form = gefunden; break; }
  }
  if (!form) {
    const beste = bericht.schritte.at(-1)?.status ?? 0;
    throw fehler(beste === 200
      ? 'Die Anmeldeseite hat kein Anmeldeformular — ist das wirklich ein IServ?'
      : `Die Anmeldeseite war nicht zu finden (Status ${beste})`, bericht);
  }
  bericht.formular = {
    action: new URL(form.action).pathname,
    user: form.userFeld, pass: form.passFeld,
    versteckt: Object.keys(form.felder).filter(k => k !== form.userFeld && k !== form.passFeld),
  };

  const daten = new URLSearchParams({
    ...form.felder, [form.userFeld]: user, [form.passFeld]: passwort,
  });
  const nach = await holeFolgend(form.action, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: seite.url,
      origin: new URL(seite.url).origin,
    },
    body: daten.toString(),
  }, seite.cookie, bericht.schritte);

  if (nach.res.status >= 400)
    throw fehler(`Die Anmeldung wurde abgewiesen (Status ${nach.res.status})`, bericht);

  // Steht am Ende wieder ein Anmeldeformular, hat es nicht geklappt - so sagt es IServ auch einem
  // Menschen.
  const endeHtml = nach.res.status === 200 ? await nach.res.text().catch(() => '') : '';
  if (formularAus(endeHtml, nach.url))
    throw fehler('Die Seite zeigt weiter das Anmeldeformular — stimmen Benutzername und Passwort?',
      bericht);
  if (!nach.cookie) throw fehler('Angemeldet, aber ohne Sitzung — IServ hat keinen Keks gesetzt', bericht);

  bericht.angemeldet = true;
  return { basis, cookie: nach.cookie, bericht };
}

export const abmelden = sitzung =>
  hole(sitzung.basis + '/iserv/app/logout', { headers: { ...KOPF, cookie: sitzung.cookie } })
    .catch(() => {});

/** Wo der Stundenplan wohnen koennte. Was einmal geklappt hat, merkt sich der Aufrufer. */
export const PLAN_PFADE = ['/iserv/plan', '/iserv/timetable', '/iserv/stundenplan'];

export async function seiteHolen(sitzung, pfad) {
  const { res, url } = await holeFolgend(sitzung.basis + pfad, {}, sitzung.cookie);
  // Landet man auf der Anmeldung, ist die Sitzung abgelaufen oder das Modul gesperrt.
  if (/login/i.test(new URL(url).pathname)) return { status: 401, html: '' };
  const html = res.status === 200 ? await res.text().catch(() => '') : '';
  return { status: res.status, html };
}

// --- HTML lesen ----------------------------------------------------------------
// Ein winziger Tabellenleser statt eines Fremdpakets: die App hat ausser Express keine
// Abhaengigkeit, und dabei bleibt es. Er muss nicht jedes HTML koennen - nur Tabellen.

const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  ndash: '–', mdash: '—' };

export const entitaeten = t => String(t)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-zA-Z]+);/g, (ganz, name) => ENTITAETEN[name] ?? ganz);

/** Der Inhalt einer Zelle als Zeilen: <br> und Blockenden trennen, Tags fliegen raus. */
export function zellZeilen(roh) {
  return entitaeten(String(roh ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|span|h\d)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .split('\n')
    // Viele Plaene schreiben "Fach / Lehrer / Raum" in eine Zeile.
    .flatMap(z => z.split(/\s+[/|·]\s+/))
    .map(z => z.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Alle Tabellen einer Seite, jede als Liste von Zeilen, jede Zeile als Liste von Zellen.
 *
 * Verschachtelte Tabellen erwischt der nicht-gierige Ausdruck als eigene Tabelle - kein Schaden:
 * welche davon der Stundenplan ist, entscheidet 'planTabelle' ohnehin am Inhalt.
 */
export function tabellen(html) {
  const raus = [];
  for (const [, inhalt] of String(html ?? '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const zeilen = [];
    for (const [, zeileRoh] of inhalt.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const zellen = [];
      for (const [, tag, attr, zelle] of zeileRoh.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
        const spannweite = Math.min(Number(/colspan\s*=\s*"?(\d+)/i.exec(attr)?.[1]) || 1, 12);
        const eintrag = { zeilen: zellZeilen(zelle), roh: zelle, kopf: tag.toLowerCase() === 'th' };
        // Eine Zelle ueber mehrere Spalten steht so oft in der Liste, wie sie Spalten deckt -
        // sonst verrutschen alle Tage dahinter.
        for (let i = 0; i < spannweite; i++) zellen.push(eintrag);
      }
      if (zellen.length) zeilen.push(zellen);
    }
    if (zeilen.length) raus.push(zeilen);
  }
  return raus;
}

const ZEITSPANNE = /(\d{1,2})[:.](\d{2})\s*(?:[-–—]|bis)\s*(\d{1,2})[:.](\d{2})/;
const zz = n => String(n).padStart(2, '0');

/** Die Zeitspanne einer Zeile, wenn in ihrer ersten Zelle eine steht. */
export function spanneAus(zelle) {
  const m = ZEITSPANNE.exec((zelle?.zeilen ?? []).join(' '));
  return m ? { start: `${zz(m[1])}:${m[2]}`, ende: `${zz(m[3])}:${m[4]}` } : null;
}

const TAGE = { mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6, so: 7 };

/** Aus einer Kopfzeile die Wochentage lesen: Spaltennummer -> ISO-Tag (1 = Montag). */
export function tageAus(zeile) {
  const raus = new Map();
  (zeile ?? []).forEach((z, i) => {
    const t = (z?.zeilen ?? []).join(' ').toLowerCase().replace(/[^a-zäöü]/g, '');
    const iso = TAGE[t.slice(0, 2)];
    // Jeden Tag nur einmal: eine Zelle mit colspan steht mehrfach in der Liste.
    if (iso && ![...raus.values()].includes(iso)) raus.set(i, iso);
  });
  return raus;
}

/**
 * Der Montag der Woche, die die Tabelle zeigt - wenn in der Kopfzeile ein Datum steht.
 *
 * Ohne Datumsparameter wissen wir nicht, welche Woche IServ gerade anzeigt: samstags kann es die
 * alte sein oder schon die naechste. Steht "Mo 07.09." im Kopf, ist die Frage beantwortet; sonst
 * bleibt es bei der Annahme des Aufrufers.
 */
export function montagAus(zeile) {
  for (const z of zeile ?? []) {
    const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})?/.exec((z?.zeilen ?? []).join(' '));
    if (!m) continue;
    const heute = Date.now(), jahr = new Date().getFullYear();
    // Ohne Jahr das naechstliegende - um Neujahr zeigt "05.01." sonst ins falsche Jahr.
    const jahre = m[3] ? [Number(m[3])] : [jahr - 1, jahr, jahr + 1];
    const d = jahre.map(j => new Date(Date.UTC(j, Number(m[2]) - 1, Number(m[1]))))
      .sort((x, y) => Math.abs(x - heute) - Math.abs(y - heute))[0];
    if (Number.isNaN(d.getTime())) continue;
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Die Tabelle, die nach Stundenplan aussieht: Wochentage im Kopf, Zeiten in der ersten Spalte. */
export function planTabelle(alle) {
  let beste = null, punkte = 0;
  for (const zeilen of alle ?? []) {
    const tage = tageAus(zeilen[0]);
    const mitZeit = zeilen.filter(z => spanneAus(z[0])).length;
    const p = tage.size * 10 + mitZeit;
    if (tage.size >= 2 && mitZeit >= 1 && p > punkte) { punkte = p; beste = zeilen; }
  }
  return beste;
}

/** Das Stundenraster, wie es in der ersten Spalte steht. */
export function zeitenAus(zeilen) {
  const raus = [];
  for (const z of zeilen ?? []) {
    const s = spanneAus(z[0]);
    if (s) raus.push({ nr: raus.length + 1, start_time: s.start, end_time: s.ende });
  }
  return raus;
}

const plusTage = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const kuerzel = t => String(t ?? '').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 12) || 'X';

/**
 * Aus der Tabelle Stunden machen - in derselben Form, die auch `untis.js aufbereiten()` liefert.
 * Dadurch braucht der Rest der App keinen Sonderfall fuer IServ.
 *
 * Was in einer Zelle steht, ist nicht festgelegt. Angenommen wird die uebliche Reihenfolge Fach,
 * Lehrer, Raum; als Raum gilt, was eine Ziffer enthaelt (A12, 2.14) - das trifft den Normalfall
 * und faellt sonst auf "kein Raum" zurueck, statt einen zu erfinden.
 */
export function ausTabelle(zeilen, montag, praefix = '') {
  const plan = zeilen ?? [];
  const tage = tageAus(plan[0]);
  const raus = [];

  for (const zeile of plan) {
    const spanne = spanneAus(zeile[0]);
    if (!spanne) continue;
    for (const [spalte, iso] of tage) {
      if (iso > 5) continue;                       // Mo-Fr, mehr hat der Plan der App nicht
      const zelle = zeile[spalte];
      const zeilenText = zelle?.zeilen ?? [];
      if (!zeilenText.length) continue;

      const roh = String(zelle.roh ?? '');
      const text = zeilenText.join(' ');
      const faellt = /entf[äa]ll|f[äa]llt\s+aus|ausfall|kein unterricht|frei\b/i.test(text)
        || /\b(cancel|entfall)/i.test(roh);
      const vertretung = /vertret|substitut/i.test(text) || /\bsubst/i.test(roh);

      const fach = zeilenText[0];
      const rest = zeilenText.slice(1);
      const raum = rest.find(t => /\d/.test(t) && t.length <= 14) ?? null;
      const lehrer = rest.find(t => t !== raum) ?? null;

      raus.push({
        date: plusTage(montag, iso - 1),
        start: spanne.start,
        end: spanne.ende,
        course_id: `${praefix}ISERV-${kuerzel(fach)}-${kuerzel(lehrer)}`,
        subject: fach,
        subject_short: fach.length <= 6 ? fach : null,
        teacher: faellt ? null : lehrer,
        room: raum,
        room_regulaer: null,
        status: faellt ? 'cancelled' : vertretung ? 'irregular' : 'regular',
        info: faellt || vertretung ? text.slice(0, 120) : null,
        lesson_text: null,
        gruppe: null,
      });
    }
  }
  return raus.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/**
 * Den Plan der Woche holen.
 *
 * Nur diese eine Woche: IServ zeigt, was auf der Seite steht, und ein Datumsparameter ist nirgends
 * dokumentiert. Fuer alles andere bleibt der selbst gebaute Plan stehen - genau dafuer ist er da.
 *
 * Zurueck kommt immer auch ein Bericht: welcher Pfad wie geantwortet hat und was gefunden wurde.
 * Ohne den waere ein leerer Plan nicht von einer falschen Adresse zu unterscheiden.
 */
export async function stundenplan(sitzung, montag, praefix = '', pfad = null) {
  const wege = pfad ? [pfad, ...PLAN_PFADE.filter(p => p !== pfad)] : PLAN_PFADE;
  const versucht = [];

  for (const weg of wege) {
    const { status, html } = await seiteHolen(sitzung, weg);
    const alle = status === 200 ? tabellen(html) : [];
    const plan = planTabelle(alle);
    versucht.push({
      pfad: weg, status, groesse: html.length, tabellen: alle.length,
      // Die ersten Zeilen als Text: damit laesst sich von aussen sehen, was wirklich ankam.
      probe: (plan ?? alle[0] ?? []).slice(0, 4).map(z => z.map(c => c.zeilen.join(' / '))),
    });
    if (!plan) continue;
    // Steht ein Datum im Kopf, zaehlt es - sonst die Woche, die der Aufrufer annimmt.
    const woche = montagAus(plan[0]) ?? montag;
    return { pfad: weg, montag: woche, stunden: ausTabelle(plan, woche, praefix),
      raster: zeitenAus(plan), versucht };
  }
  return { pfad: null, montag, stunden: [], raster: [], versucht };
}
