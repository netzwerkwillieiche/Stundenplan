// --- ical ---
// .ics schreiben und lesen. Eine Zustaendigkeit: Text hinein, Termine heraus - und umgekehrt.
// Von Express, der Datenbank und den Nutzern weiss diese Datei nichts.
//
// Bewusst ohne Fremdpaket: die App haengt an Express und sonst an nichts, und ein Kalenderformat
// aus den Neunzigern ist Textarbeit, keine Raketentechnik. Was hier NICHT verstanden wird, faellt
// weg statt geraten zu werden - ein erfundener Termin waere schlimmer als ein fehlender.
//
// Zeiten sind "schwebend": geschrieben wird ohne Zeitzone, gelesen wird alles als Ortszeit (ein
// angehaengtes Z wird umgerechnet). Fuer eine Schule in EINER Zeitzone ist das richtig; eine
// vollstaendige VTIMEZONE-Behandlung waere das Vielfache an Code fuer einen Fall, den es hier
// nicht gibt.

const zz = n => String(n).padStart(2, '0');

// --- Zeit ---------------------------------------------------------------------

/** '2026-09-07 08:00' oder '2026-09-07' -> '20260907T080000' bzw. '20260907'. */
const alsIcs = (wert, ganztags) => (ganztags
  ? String(wert).slice(0, 10).replaceAll('-', '')
  : `${String(wert).slice(0, 10).replaceAll('-', '')}T${String(wert).slice(11, 16).replace(':', '')}00`);

const tagPlus = (iso, n) => {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Eine Ortszeit als 'JJJJ-MM-TT HH:MM'. */
const alsText = d => `${d.getFullYear()}-${zz(d.getMonth() + 1)}-${zz(d.getDate())} `
  + `${zz(d.getHours())}:${zz(d.getMinutes())}`;

/**
 * Ein DTSTART/DTEND lesen: '20260907', '20260907T080000' oder '20260907T060000Z'.
 * Zurueck kommt { wert, ganztags } in der Schreibweise der Datenbank.
 */
export function lesZeit(roh, params = '') {
  const t = String(roh ?? '').trim();
  const nurDatum = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (nurDatum || /VALUE=DATE(?!-TIME)/i.test(params)) {
    const m = nurDatum ?? /^(\d{4})(\d{2})(\d{2})/.exec(t);
    return m ? { wert: `${m[1]}-${m[2]}-${m[3]}`, ganztags: true } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(t);
  if (!m) return null;
  const [, j, mo, tg, st, mi, , z] = m;
  if (!z) return { wert: `${j}-${mo}-${tg} ${st}:${mi}`, ganztags: false };
  // Mit Z ist es UTC - der Kalender zeigt Ortszeit.
  const d = new Date(Date.UTC(+j, +mo - 1, +tg, +st, +mi, 0));
  return { wert: alsText(d), ganztags: false };
}

// --- Schreiben -----------------------------------------------------------------

const esc = t => String(t ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

/**
 * Zeilen auf 75 Oktette falten - so verlangt es RFC 5545, und Google Calendar besteht darauf.
 * Gezaehlt wird in Bytes, nicht in Zeichen: ein Umlaut ist zwei.
 */
function falten(zeile) {
  const bytes = Buffer.from(zeile, 'utf8');
  if (bytes.length <= 75) return [zeile];
  const raus = [];
  let rest = bytes;
  let grenze = 75;
  while (rest.length > grenze) {
    // Nicht mitten in ein Mehrbyte-Zeichen schneiden.
    let schnitt = grenze;
    while (schnitt > 1 && (rest[schnitt] & 0xc0) === 0x80) schnitt--;
    raus.push(rest.subarray(0, schnitt).toString('utf8'));
    rest = rest.subarray(schnitt);
    grenze = 74;   // Fortsetzungszeilen beginnen mit einem Leerzeichen
  }
  raus.push(rest.toString('utf8'));
  return raus.map((z, i) => (i ? ' ' + z : z));
}

const stempel = d => `${d.getUTCFullYear()}${zz(d.getUTCMonth() + 1)}${zz(d.getUTCDate())}`
  + `T${zz(d.getUTCHours())}${zz(d.getUTCMinutes())}${zz(d.getUTCSeconds())}Z`;

// Die Zeitzone der Schule, einmal fest ausgeschrieben (MEZ/MESZ, letzter Sonntag im Maerz und
// Oktober). Ohne sie lesen Google und Outlook die schwebenden Zeiten als UTC - dann stand die
// Klausur um 8 im Handy um 10.
const BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * Eine .ics-Datei bauen.
 *
 * `termine`: { uid, titel, von, bis, ganztags, ort, text }. DTEND ist bei ganztaegigen Terminen
 * AUSSCHLIESSEND - ein eintaegiger Termin endet am Folgetag, sonst zeigen ihn manche Kalender
 * einen Tag zu kurz an. Zeiten mit Uhrzeit tragen die Zeitzone der Schule; dazu die Bitte, das
 * Abo stuendlich aufzufrischen (Google haelt sich nicht daran, Apple und Outlook schon).
 */
export function schreibe(termine, name = 'Stundenplan') {
  const zeilen = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Stundenplan//DE', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H', ...BERLIN,
  ];
  const jetzt = stempel(new Date());
  for (const t of termine ?? []) {
    if (!t?.von || !t?.titel) continue;
    zeilen.push('BEGIN:VEVENT', `UID:${esc(t.uid ?? `${t.von}-${t.titel}`)}`, `DTSTAMP:${jetzt}`);
    if (t.ganztags) {
      zeilen.push(`DTSTART;VALUE=DATE:${alsIcs(t.von, true)}`);
      zeilen.push(`DTEND;VALUE=DATE:${alsIcs(tagPlus(t.bis ?? t.von, 1), true)}`);
    } else {
      zeilen.push(`DTSTART;TZID=Europe/Berlin:${alsIcs(t.von)}`, `DTEND;TZID=Europe/Berlin:${alsIcs(t.bis ?? t.von)}`);
    }
    zeilen.push(`SUMMARY:${esc(t.titel)}`);
    if (t.ort) zeilen.push(`LOCATION:${esc(t.ort)}`);
    if (t.text) zeilen.push(`DESCRIPTION:${esc(t.text)}`);
    zeilen.push('END:VEVENT');
  }
  zeilen.push('END:VCALENDAR');
  return zeilen.flatMap(falten).join('\r\n') + '\r\n';
}

// --- Lesen ---------------------------------------------------------------------

const entesc = t => String(t ?? '')
  .replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

const WOCHENTAG = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_TERMINE = 2000;      // ein Abo darf die Datenbank nicht fluten
const MAX_FOLGE = 400;         // je Serie

/** 'FREQ=WEEKLY;BYDAY=MO,WE' -> { FREQ: 'WEEKLY', BYDAY: 'MO,WE' } */
const teile = regel => Object.fromEntries(String(regel ?? '').split(';')
  .map(p => p.split('='))
  .filter(p => p.length === 2)
  .map(([k, v]) => [k.toUpperCase(), v]));

/**
 * Eine Serie in einzelne Termine aufloesen - im gefragten Fenster, nicht bis in alle Ewigkeit.
 *
 * Unterstuetzt wird, was in Schul- und Vereinskalendern vorkommt: taeglich, woechentlich (auch mit
 * mehreren Wochentagen), monatlich und jaehrlich, mit INTERVAL, COUNT und UNTIL. Alles andere
 * (BYSETPOS, BYMONTHDAY-Listen, RECURRENCE-ID-Ausnahmen) waere geraten - dann bleibt es beim
 * ersten Termin.
 */
function serie(start, regel, exdates, fenster) {
  const r = teile(regel);
  const freq = (r.FREQ ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [start];

  const schritt = Math.max(1, Number(r.INTERVAL) || 1);
  const anzahl = Number(r.COUNT) || 0;
  const bis = r.UNTIL ? lesZeit(r.UNTIL)?.wert?.slice(0, 10) : null;
  const tage = (r.BYDAY ?? '').split(',').map(d => WOCHENTAG[d.trim().slice(-2).toUpperCase()])
    .filter(n => n !== undefined);

  const raus = [];
  // Getrennt gezaehlt wird, weil COUNT alle Vorkommen meint - auch die per EXDATE ausgelassenen
  // und die ausserhalb des gefragten Fensters. Sonst laege eine Serie mit COUNT=4 und einer
  // Ausnahme um einen Termin daneben.
  let gezaehlt = 0;
  const erster = new Date(start.slice(0, 10) + 'T12:00:00Z');   // Mittag: keine Zeitumstellungs-Fallen
  let d = new Date(erster);
  for (let i = 0; i < MAX_FOLGE && raus.length < MAX_FOLGE; i++) {
    let kandidaten = [new Date(d)];
    if (freq === 'WEEKLY' && tage.length) {
      // Der Wochenanfang ist Montag - so zaehlt auch der Rest der App.
      const montag = new Date(d);
      montag.setUTCDate(montag.getUTCDate() - ((montag.getUTCDay() + 6) % 7));
      kandidaten = tage.map(w => {
        const x = new Date(montag);
        x.setUTCDate(x.getUTCDate() + ((w + 6) % 7));
        return x;
      });
    }
    for (const k of kandidaten.sort((a, b) => a - b)) {
      const tag = k.toISOString().slice(0, 10);
      if (tag < start.slice(0, 10)) continue;
      if (bis && tag > bis) return raus;
      if (anzahl && gezaehlt >= anzahl) return raus;
      gezaehlt++;
      if (exdates.includes(tag)) continue;
      if (tag > fenster.bis) return raus;
      if (tag >= fenster.von) raus.push(tag + start.slice(10));
    }
    if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + schritt);
    else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * schritt);
    else if (freq === 'MONTHLY') {
      // Monatsende ehrlich behandeln: der 31. springt nicht in den naechsten Monat.
      const tagImMonat = erster.getUTCDate();
      d = new Date(Date.UTC(erster.getUTCFullYear(), erster.getUTCMonth() + schritt * (i + 1), 1, 12));
      const letzter = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).getUTCDate();
      d.setUTCDate(Math.min(tagImMonat, letzter));
    } else {
      d = new Date(erster);
      d.setUTCFullYear(erster.getUTCFullYear() + schritt * (i + 1));
    }
  }
  return raus;
}

/**
 * Eine .ics-Datei lesen. `fenster` = { von, bis } als 'JJJJ-MM-TT'.
 *
 * Gefaltete Zeilen werden zuerst wieder zusammengesetzt - ohne das zerfaellt jeder laengere Titel.
 */
export function lese(text, fenster = {}) {
  const von = fenster.von ?? '1900-01-01', bis = fenster.bis ?? '2999-12-31';
  const zeilen = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');

  const raus = [];
  let e = null;
  for (const zeile of zeilen) {
    const trenner = zeile.indexOf(':');
    if (trenner < 0) continue;
    const links = zeile.slice(0, trenner);
    const wert = zeile.slice(trenner + 1).trim();
    const [name, ...params] = links.split(';');
    const feld = name.trim().toUpperCase();

    if (feld === 'BEGIN' && wert.toUpperCase() === 'VEVENT') { e = { exdates: [] }; continue; }
    if (!e) continue;
    if (feld === 'END' && wert.toUpperCase() === 'VEVENT') {
      if (e.von && e.titel && raus.length < MAX_TERMINE) {
        const dauer = e.bis && !e.ganztags
          ? new Date(e.bis.replace(' ', 'T')) - new Date(e.von.replace(' ', 'T')) : 0;
        for (const start of serie(e.von, e.rrule, e.exdates, { von, bis })) {
          const ende = e.ganztags ? (e.bis ?? start)
            : alsText(new Date(new Date(start.replace(' ', 'T')).getTime() + dauer));
          raus.push({ uid: e.uid ?? null, titel: e.titel, ort: e.ort ?? null, text: e.text ?? null,
            von: start, bis: ende, ganztags: !!e.ganztags });
          if (raus.length >= MAX_TERMINE) break;
        }
      }
      e = null;
      continue;
    }

    const p = params.join(';');
    if (feld === 'UID') e.uid = wert.slice(0, 200);
    else if (feld === 'SUMMARY') e.titel = entesc(wert).slice(0, 200);
    else if (feld === 'LOCATION') e.ort = entesc(wert).slice(0, 200) || null;
    else if (feld === 'DESCRIPTION') e.text = entesc(wert).slice(0, 2000) || null;
    else if (feld === 'RRULE') e.rrule = wert;
    else if (feld === 'DTSTART') {
      const z = lesZeit(wert, p);
      if (z) { e.von = z.wert; e.ganztags = z.ganztags; }
    } else if (feld === 'DTEND') {
      const z = lesZeit(wert, p);
      // Bei ganztaegigen Terminen ist DTEND ausschliessend - der letzte Tag ist der davor.
      if (z) e.bis = z.ganztags ? tagPlus(z.wert, -1) : z.wert;
    } else if (feld === 'EXDATE') {
      for (const d of wert.split(',')) {
        const z = lesZeit(d.trim(), p);
        if (z) e.exdates.push(z.wert.slice(0, 10));
      }
    }
  }
  return raus;
}
