// --- raumplan ---
// Der Gebaeudeplan der Schule: Etagen aus Rechtecken auf einem Kachelraster - Raeume, Flure,
// Treppen, Freizeitbereiche, Hof, Sport, Waende. Hier steht alles, was ohne Browser geht: das
// Rastern, die Wegsuche und das Zeichnen als SVG-Text. Der Editor (admin.js) und das Fenster
// (plan.js) haengen daran. Die Tests laden diese Datei in Node - deshalb kein DOM.

import { $, api, h, oops, toast } from './kern.js';

export const ARTEN = {
  raum: { name: 'Raum', farbe: '#dbe7ff', rand: '#7a9bd6' },
  flur: { name: 'Flur', farbe: '#f1f1f1', rand: '#cfcfcf' },
  treppe: { name: 'Treppe', farbe: '#ffe7b3', rand: '#d9a53a' },
  freizeit: { name: 'Freizeit', farbe: '#d9f2d9', rand: '#6fb36f' },
  hof: { name: 'Hof', farbe: '#e9f5c8', rand: '#a6c455' },
  sport: { name: 'Sport', farbe: '#fbd9d9', rand: '#d97b7b' },
  wand: { name: 'Wand', farbe: '#555', rand: '#333' },
};
export const ZUGANG = { beide: 'beide Richtungen', nur_rein: 'nur hinein', nur_raus: 'nur heraus' };
const BEGEHBAR = new Set(['flur', 'treppe', 'freizeit', 'hof', 'sport']);
export const GRENZEN = { etagen: 12, breite: 120, hoehe: 80, felder: 400 };

const norm = s => String(s ?? '').trim().toLowerCase();

/** Leerer Plan mit einer Etage. */
export const leererPlan = () => ({ kachel: 24, etagen: [{ name: 'EG', b: 40, h: 25, felder: [] }] });

/**
 * Den Plan in Form bringen: Zahlen als Zahlen, Arten bekannt, Groessen gedeckelt. Was nicht
 * passt, fliegt raus statt zu stoeren - der Server pruefft damit, der Editor auch.
 */
export function saeubern(roh) {
  const p = roh && typeof roh === 'object' ? roh : {};
  const etagen = (Array.isArray(p.etagen) ? p.etagen : []).slice(0, GRENZEN.etagen).map((e, i) => {
    const b = Math.min(Math.max(Math.trunc(Number(e?.b) || 40), 5), GRENZEN.breite);
    const h = Math.min(Math.max(Math.trunc(Number(e?.h) || 25), 5), GRENZEN.hoehe);
    const felder = (Array.isArray(e?.felder) ? e.felder : []).slice(0, GRENZEN.felder)
      .map(f => ({
        x: Math.trunc(Number(f?.x) || 0), y: Math.trunc(Number(f?.y) || 0),
        w: Math.max(1, Math.trunc(Number(f?.w) || 1)), h: Math.max(1, Math.trunc(Number(f?.h) || 1)),
        art: f?.art in ARTEN ? f.art : 'flur',
        name: String(f?.name ?? '').trim().slice(0, 30),
        gesperrt: f?.gesperrt ? 1 : 0,
        zugang: f?.zugang in ZUGANG ? f.zugang : 'beide',
        // Eine Treppe reicht ueber so viele Etagen nach oben (0 = nur diese) - einmal gezeichnet,
        // auf jeder Etage dazwischen an derselben Stelle da.
        hoch: f?.art === 'treppe' ? Math.min(Math.max(Math.trunc(Number(f?.hoch) || 0), 0), GRENZEN.etagen - 1) : 0,
      }))
      .filter(f => f.x >= 0 && f.y >= 0 && f.x < b && f.y < h)
      .map(f => ({ ...f, w: Math.min(f.w, b - f.x), h: Math.min(f.h, h - f.y) }));
    return { name: String(e?.name ?? `Etage ${i + 1}`).trim().slice(0, 30) || `Etage ${i + 1}`, b, h, felder };
  });
  if (!etagen.length) return leererPlan();
  return { kachel: Math.min(Math.max(Math.trunc(Number(p.kachel) || 24), 10), 60), etagen };
}

/**
 * Die Felder einer Etage samt der Treppen, die von tieferen Etagen bis hierher reichen. Die
 * Kopie traegt `von` (Index der Etage, auf der sie gezeichnet ist) und ist in beide Richtungen
 * offen - die Richtung gilt nur dort, wo die Treppe gezeichnet wurde. Gezaehlt wird in Etagen,
 * nicht in Namen: wer die Etagen umsortiert, sortiert damit auch die Treppen richtig.
 */
export function felderAuf(plan, e) {
  const etagen = plan?.etagen ?? [];
  const eigene = etagen[e]?.felder ?? [];
  const kopien = [];
  for (let k = 0; k < e; k++)
    for (const f of etagen[k].felder)
      if (f.art === 'treppe' && (f.hoch ?? 0) >= e - k) kopien.push({ ...f, zugang: 'beide', von: k });
  return [...eigene, ...kopien];
}

/** Das Kachelgitter einer Etage: je Kachel das oberste Feld, leer = null (= Wand). */
export function rastern(etage, felder = etage.felder) {
  const gitter = Array.from({ length: etage.h }, () => Array(etage.b).fill(null));
  for (const f of felder)
    for (let y = f.y; y < Math.min(etage.h, f.y + f.h); y++)
      for (let x = f.x; x < Math.min(etage.b, f.x + f.w); x++) gitter[y][x] = f;
  return gitter;
}

/** Alle Raumnamen des Plans, einmal je Name, wie eingetragen. */
export function raumNamen(plan) {
  const namen = new Map();
  for (const e of plan?.etagen ?? [])
    for (const f of e.felder) if (f.art === 'raum' && f.name && !namen.has(norm(f.name))) namen.set(norm(f.name), f.name);
  return [...namen.values()].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

/** Auf welchen Etagen ein Raum liegt - Index der ersten, oder -1. */
export function etageVon(plan, raum) {
  return (plan?.etagen ?? []).findIndex(e => e.felder.some(f => f.art === 'raum' && norm(f.name) === norm(raum)));
}

/**
 * Der Weg von Raum zu Raum: Breitensuche ueber (Etage, x, y).
 *
 * Begehbar sind Flur, Treppe, Freizeit, Hof und Sport; Raeume nur als Start oder Ziel - durch einen
 * Klassenraum laeuft niemand hindurch. Gesperrtes nie. Treppen gleichen Namens verbinden die
 * Etagen - immer zur naechsten Etage darueber und darunter, die diese Treppe hat, nicht quer
 * ueber alle: so geht der Weg EG → 1. OG → 2. OG, und ein Plan mit Treppe nur im EG und 2. OG
 * bleibt trotzdem verbunden. "nur hinein" heisst: von dieser Etage in die Treppe, aber nicht aus
 * ihr heraus auf diese Etage, "nur heraus" umgekehrt. Ergebnis: Liste { etage, x, y } - oder null.
 */
export function weg(plan, startRaum, zielRaum) {
  const etagen = plan?.etagen ?? [];
  if (!etagen.length || !norm(startRaum) || !norm(zielRaum)) return null;
  // Je Etage einmal die Felder samt durchgehender Treppen - dieselben Objekte fuer Gitter und
  // Treppen-Index, sonst erkennt der Vergleich unten die Kopien nicht wieder.
  const felder = etagen.map((et, e) => felderAuf(plan, e));
  const gitter = etagen.map((et, e) => rastern(et, felder[e]));
  const istRaum = (f, name) => f?.art === 'raum' && norm(f.name) === norm(name);
  const key = (e, x, y) => `${e}|${x}|${y}`;
  // Start: alle Kacheln des Startraums, Ziel: alle des Zielraums.
  const start = [], ziel = new Set();
  etagen.forEach((et, e) => {
    for (let y = 0; y < et.h; y++) for (let x = 0; x < et.b; x++) {
      const f = gitter[e][y][x];
      if (istRaum(f, startRaum) && !f.gesperrt) start.push({ e, x, y });
      if (istRaum(f, zielRaum) && !f.gesperrt) ziel.add(key(e, x, y));
    }
  });
  if (!start.length || !ziel.size) return null;
  if (norm(startRaum) === norm(zielRaum)) return [{ etage: start[0].e, x: start[0].x, y: start[0].y }];

  // Treppen je Name je Etage, fuer den Etagenwechsel.
  const treppen = new Map();   // name -> [{ e, x, y, f }]
  etagen.forEach((et, e) => {
    for (const f of felder[e]) if (f.art === 'treppe' && f.name && !f.gesperrt)
      for (let y = f.y; y < Math.min(et.h, f.y + f.h); y++) for (let x = f.x; x < Math.min(et.b, f.x + f.w); x++)
        if (gitter[e][y][x] === f) (treppen.get(norm(f.name)) ?? treppen.set(norm(f.name), []).get(norm(f.name))).push({ e, x, y, f });
  });
  // Die naechste Etage ueber und unter e, auf der die Treppe steht.
  const nachbarEtagen = (name, e) => {
    const es = [...new Set((treppen.get(name) ?? []).map(t => t.e))];
    const oben = es.filter(x => x > e), unten = es.filter(x => x < e);
    return [oben.length ? Math.min(...oben) : -1, unten.length ? Math.max(...unten) : -1].filter(x => x >= 0);
  };

  const darfBetreten = (f, von) => {
    if (!f || f.gesperrt) return false;
    if (f.art === 'raum') return istRaum(f, zielRaum) || istRaum(f, startRaum);
    if (f.art === 'treppe' && von?.art !== 'treppe' && f.zugang === 'nur_raus') return false;
    return BEGEHBAR.has(f.art);
  };
  const darfVerlassen = (f, nach) => !(f?.art === 'treppe' && nach?.art !== 'treppe' && f.zugang === 'nur_rein');

  const vor = new Map();
  const queue = [];
  for (const s of start) { vor.set(key(s.e, s.x, s.y), null); queue.push(s); }
  let gefunden = null;
  while (queue.length && !gefunden) {
    const c = queue.shift();
    const hier = gitter[c.e][c.y][c.x];
    const nachbarn = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = c.x + dx, y = c.y + dy;
      if (x < 0 || y < 0 || x >= etagen[c.e].b || y >= etagen[c.e].h) continue;
      const f = gitter[c.e][y][x];
      if (f === hier || (darfVerlassen(hier, f) && darfBetreten(f, hier))) nachbarn.push({ e: c.e, x, y });
    }
    // Etagenwechsel: von einer Treppenkachel zur gleichnamigen auf der naechsten Etage darueber
    // oder darunter.
    if (hier?.art === 'treppe' && hier.name) {
      const ziele = nachbarEtagen(norm(hier.name), c.e);
      for (const t of treppen.get(norm(hier.name)) ?? []) if (ziele.includes(t.e)) nachbarn.push({ e: t.e, x: t.x, y: t.y });
    }
    for (const n of nachbarn) {
      const k = key(n.e, n.x, n.y);
      if (vor.has(k)) continue;
      vor.set(k, c);
      if (ziel.has(k)) { gefunden = n; break; }
      queue.push(n);
    }
  }
  if (!gefunden) return null;
  const pfad = [];
  for (let c = gefunden; c; c = vor.get(key(c.e, c.x, c.y))) pfad.push({ etage: c.e, x: c.x, y: c.y });
  return pfad.reverse();
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Eine Etage als SVG-Text: Felder in ihrer Farbe mit Namen, Gesperrtes schraffiert, Treppen mit
 * Richtung, der Weg als Linie. `hervor` hebt einen Raum hervor (Suche), `start`/`ziel` die Enden.
 */
export function zeichnen(plan, etageIndex, pfad = null, { start = '', ziel = '', hervor = '', raster = false } = {}) {
  const et = plan.etagen[etageIndex];
  if (!et) return '';
  const k = plan.kachel ?? 24;
  const W = et.b * k, H = et.h * k;
  const teile = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="raumplan-svg">`,
    `<defs><pattern id="rp-sperre" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`
    + `<line x1="0" y1="0" x2="0" y2="8" stroke="#c0392b" stroke-width="3"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="#fafafa"/>`];
  if (raster) {
    for (let x = 0; x <= et.b; x++) teile.push(`<line x1="${x * k}" y1="0" x2="${x * k}" y2="${H}" stroke="#eee"/>`);
    for (let y = 0; y <= et.h; y++) teile.push(`<line x1="0" y1="${y * k}" x2="${W}" y2="${y * k}" stroke="#eee"/>`);
  }
  // Kopien durchgehender Treppen (von tieferen Etagen) gestrichelt, mit Herkunft im Namen.
  felderAuf(plan, etageIndex).forEach((f, i) => {
    const a = ARTEN[f.art] ?? ARTEN.flur;
    const istZiel = f.art === 'raum' && f.name && [start, ziel, hervor].some(n => n && norm(n) === norm(f.name));
    const kopie = f.von != null;
    teile.push(`<g data-feld="${kopie ? -1 : i}"><rect x="${f.x * k}" y="${f.y * k}" width="${f.w * k}" height="${f.h * k}"`
      + ` fill="${a.farbe}" stroke="${istZiel ? '#1e90ff' : a.rand}" stroke-width="${istZiel ? 4 : 1.5}"${kopie ? ' stroke-dasharray="6 4"' : ''}/>`);
    if (f.gesperrt) teile.push(`<rect x="${f.x * k}" y="${f.y * k}" width="${f.w * k}" height="${f.h * k}" fill="url(#rp-sperre)" opacity=".6"/>`);
    const text = f.art === 'treppe'
      ? `${f.name || 'Treppe'} ${f.zugang === 'nur_rein' ? '⇥' : f.zugang === 'nur_raus' ? '⇤' : '⇅'}`
        + (kopie ? ` · von ${plan.etagen[f.von]?.name ?? ''}` : f.hoch ? ` · bis ${plan.etagen[Math.min(etageIndex + f.hoch, plan.etagen.length - 1)]?.name ?? ''}` : '')
      : f.name || (f.art === 'raum' ? '' : a.name);
    if (text && f.w * k >= 18 && f.h * k >= 12) {
      const gross = Math.max(9, Math.min(14, Math.floor(Math.min(f.w * k / Math.max(3, text.length * .6), f.h * k * .5))));
      teile.push(`<text x="${(f.x + f.w / 2) * k}" y="${(f.y + f.h / 2) * k}" font-size="${gross}" text-anchor="middle"`
        + ` dominant-baseline="middle" fill="${f.art === 'wand' ? '#ddd' : '#222'}" font-family="system-ui, sans-serif">${esc(text)}</text>`);
    }
    teile.push('</g>');
  });
  if (pfad?.length) {
    const hier = pfad.filter(p => p.etage === etageIndex);
    // Der Weg auf dieser Etage kann in Stuecken liegen (rauf, runter, wieder her) - jedes Stueck
    // eine Linie.
    let stueck = [];
    const stuecke = [];
    for (let i = 0; i < pfad.length; i++) {
      if (pfad[i].etage === etageIndex) stueck.push(pfad[i]);
      if (pfad[i].etage !== etageIndex || i === pfad.length - 1) { if (stueck.length) stuecke.push(stueck); stueck = []; }
    }
    for (const s of stuecke) {
      const punkte = s.map(p => `${(p.x + .5) * k},${(p.y + .5) * k}`).join(' ');
      teile.push(`<polyline points="${punkte}" fill="none" stroke="#1e90ff" stroke-width="${Math.max(3, k / 5)}"`
        + ` stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`);
    }
    const erster = pfad[0], letzter = pfad[pfad.length - 1];
    const punkt = (p, farbe, text) => `<circle cx="${(p.x + .5) * k}" cy="${(p.y + .5) * k}" r="${k * .32}" fill="${farbe}" stroke="#fff" stroke-width="2"/>`
      + `<text x="${(p.x + .5) * k}" y="${(p.y + .5) * k}" font-size="${Math.max(8, k * .4)}" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-weight="700">${text}</text>`;
    if (erster.etage === etageIndex) teile.push(punkt(erster, '#2e9e4f', 'S'));
    if (letzter.etage === etageIndex) teile.push(punkt(letzter, '#c0392b', 'Z'));
    // Wo der Weg die Etage verlaesst oder betritt: ein Hinweis auf die andere Etage.
    // Unter die Treppe, nicht hinein - sonst liegt der Hinweis auf dem Treppennamen. Am unteren
    // Rand dann darueber.
    const hinweisY = p => (p.y >= et.h - 2 ? p.y - .6 : p.y + 1.7) * k;
    for (let i = 0; i < pfad.length - 1; i++) {
      const a = pfad[i], b = pfad[i + 1];
      if (a.etage === etageIndex && b.etage !== etageIndex)
        teile.push(`<text x="${(a.x + .5) * k}" y="${hinweisY(a)}" font-size="${Math.max(8, k * .38)}" text-anchor="middle" fill="#1e90ff" font-weight="700">${b.etage > a.etage ? '↑' : '↓'} ${esc(plan.etagen[b.etage]?.name ?? '')}</text>`);
      if (a.etage !== etageIndex && b.etage === etageIndex && !hier.includes(a))
        teile.push(`<text x="${(b.x + .5) * k}" y="${hinweisY(b)}" font-size="${Math.max(8, k * .38)}" text-anchor="middle" fill="#1e90ff" font-weight="700">von ${esc(plan.etagen[a.etage]?.name ?? '')}</text>`);
    }
  }
  teile.push('</svg>');
  return teile.join('');
}

/** SVG-Text als Element - ueber den Parser statt innerHTML, wie ueberall in der App. */
export const svgElement = text =>
  new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;

// --- Das Fenster fuer alle: Karte, Raumsuche, Weg -------------------------------------------
let geladen = null;   // { plan, frei } - einmal je Sitzung, der Plan aendert sich selten

export async function raumplanLaden(frisch = false) {
  if (!geladen || frisch) geladen = await api('GET', '/api/raumplan').catch(() => ({ plan: null, frei: false }));
  return geladen;
}

/**
 * Die Karte mit Etagen-Reitern, einer Raumsuche und - wahlweise - Start und Ziel. Aus der Stunde
 * heraus sind beide vorbelegt und der Weg steht schon; sonst sieht man einfach den Plan.
 */
export async function raumplanFenster({ start = '', ziel = '' } = {}) {
  const { plan } = await raumplanLaden();
  if (!plan) return toast('Kein Raumplan hinterlegt.');
  const dlg = $('#raumplanDlg');
  const namen = raumNamen(plan);
  const liste = h('datalist', { id: 'rpRaeume' }, ...namen.map(n => h('option', { value: n })));
  const feld = (platzhalter, wert = '') => {
    const f = h('input', { placeholder: platzhalter, value: wert, autocomplete: 'off' });
    f.setAttribute('list', 'rpRaeume');
    return f;
  };
  const suche = feld('Raum suchen …');
  suche.type = 'search';
  const von = feld('Start (Raum)', start), nach = feld('Ziel (Raum)', ziel);
  const tabs = h('div', { className: 'reiter rp-etagen' });
  const flaeche = h('div', { className: 'raumplan-flaeche' });
  const hinweis = h('p', { className: 'muted small' });
  let etage = 0, pfad = null;

  const male = () => {
    tabs.replaceChildren(...plan.etagen.map((e, i) => h('button', {
      type: 'button', textContent: e.name, className: i === etage ? 'active' : '',
      onclick: () => { etage = i; male(); },
    })));
    flaeche.replaceChildren(svgElement(zeichnen(plan, etage, pfad,
      { start: von.value, ziel: nach.value, hervor: suche.value })));
  };
  const rechne = () => {
    if (von.value.trim() && nach.value.trim()) {
      pfad = weg(plan, von.value, nach.value);
      if (pfad) {
        const etagen = [...new Set(pfad.map(p => plan.etagen[p.etage]?.name))];
        hinweis.textContent = `${pfad.length} Schritte` + (etagen.length > 1 ? ` · über ${etagen.join(' → ')}` : '');
        etage = pfad[0].etage;
      } else hinweis.textContent = 'Kein Weg gefunden — sind beide Räume im Plan (Name wie im Stundenplan)?';
    } else { pfad = null; hinweis.textContent = ''; }
    male();
  };
  suche.oninput = () => { const e = etageVon(plan, suche.value); if (e >= 0) etage = e; male(); };
  von.onchange = nach.onchange = rechne;

  dlg.replaceChildren(
    h('h2', { textContent: 'Raumplan' }),
    h('div', { className: 'row rp-felder' }, suche, von, nach,
      h('button', { type: 'button', className: 'primary', textContent: 'Weg zeigen', onclick: rechne })),
    tabs, hinweis, flaeche, liste,
    h('div', { className: 'row end' },
      h('button', { className: 'ghost', textContent: 'Schließen', onclick: () => dlg.close() })));
  dlg.showModal();
  rechne();
}
