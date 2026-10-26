// --- umfrage-logik ---
// Was Server und Browser bei Umfragen gleich rechnen muessen: die Fragetypen, das Saeubern einer
// Frage, die Pruefung einer Antwort, und die Auswertung (Kreuztabelle, Personengruppen, CSV).
// Ohne DOM und ohne Importe - der Server laedt genau diese Datei, damit die Regeln nicht zweimal
// (und irgendwann verschieden) dastehen. Verbindlich ist die Pruefung auf dem Server; der Browser
// nutzt sie, damit man den Fehler sieht, bevor man abschickt.

export const TYPEN = {
  single: 'Einfachauswahl',
  multi: 'Mehrfachauswahl',
  points: 'Punkte verteilen',
  text: 'Freitext',
  text_limited: 'Kurztext',
  slider: 'Schieberegler',
  slider_multi: 'Mehrere Regler',
  slider2d: '2D-Regler',
};
export const MIT_OPTIONEN = new Set(['single', 'multi', 'points']);
export const ZAHLEN_TYPEN = new Set(['slider', 'slider_multi', 'slider2d']);

const ganz = (v, min, max, vorgabe) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : vorgabe;
};
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
// IDs bleiben, wie sie sind: Antworten haengen an ihnen, nicht an der Position.
const neueId = () => Math.random().toString(36).slice(2, 8);
const liste = (roh, min, max) => {
  const gesehen = new Set();
  return (Array.isArray(roh) ? roh : []).slice(0, max)
    .map(o => ({ id: txt(o?.id, 12) || neueId(), label: txt(o?.label ?? o, 200) }))
    .filter(o => o.label && !gesehen.has(o.id) && gesehen.add(o.id));
};

/**
 * Eine Frage in Form bringen. Zurueck: { typ, text, pflicht, config } oder { fehler }.
 * Grenzen wie in VNW: 2-30 Optionen, 1-30 Regler, Punktesumme 1-1000, Kurztext 10-5000 Zeichen,
 * Regler zwischen -1000 und 1000.
 */
export function frageSaeubern(roh) {
  const typ = String(roh?.typ ?? '');
  if (!TYPEN[typ]) return { fehler: 'Unbekannter Fragetyp' };
  const text = txt(roh?.text, 500);
  if (!text) return { fehler: 'Fragetext fehlt' };
  const c = roh?.config ?? {};
  let config = {};
  if (MIT_OPTIONEN.has(typ)) {
    const optionen = liste(c.options, 2, 30);
    if (optionen.length < 2) return { fehler: 'Mindestens zwei Antwortmöglichkeiten' };
    config = { options: optionen };
    if (typ === 'multi') config.max = ganz(c.max, 0, optionen.length, 0);
    if (typ === 'points') config.total = ganz(c.total, 1, 1000, 10);
  } else if (typ === 'text_limited') {
    config = { max_length: ganz(c.max_length, 10, 5000, 280) };
  } else if (typ === 'slider' || typ === 'slider_multi') {
    const min = ganz(c.min, -1000, 1000, 0), max = ganz(c.max, -1000, 1000, 10);
    if (min >= max) return { fehler: 'Das Minimum muss kleiner als das Maximum sein' };
    config = { min, max, min_label: txt(c.min_label, 60), max_label: txt(c.max_label, 60) };
    if (typ === 'slider_multi') {
      config.items = liste(c.items, 1, 30);
      if (!config.items.length) return { fehler: 'Mindestens ein Regler' };
    }
  } else if (typ === 'slider2d') {
    config = { x_left: txt(c.x_left, 40), x_right: txt(c.x_right, 40), y_top: txt(c.y_top, 40), y_bottom: txt(c.y_bottom, 40) };
  }
  return { typ, text, pflicht: !!roh?.pflicht, config };
}

/**
 * Darf sich die Frage noch so aendern, obwohl schon Antworten da sind? Texte ja, Neues dazu ja;
 * Typ wechseln, Optionen/Regler entfernen, Grenzen oder Punktesumme verschieben nein - sonst
 * passen gespeicherte Antworten nicht mehr zur Frage.
 */
export function aenderungErlaubt(alt, neu) {
  if (alt.typ !== neu.typ) return false;
  const ids = x => new Set([...(x.options ?? []), ...(x.items ?? [])].map(o => o.id));
  const neuIds = ids(neu.config);
  if ([...ids(alt.config)].some(id => !neuIds.has(id))) return false;
  for (const k of ['min', 'max', 'total']) if (alt.config[k] !== neu.config[k]) return false;
  return true;
}

const leer = v => v == null || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/**
 * Die einzige Vertrauensgrenze: jede Antwort (angemeldet oder Gast) laeuft hier durch.
 * Zurueck: { antworten } (nur bekannte Fragen, bereinigt) oder { fehler, frage_id }.
 */
/**
 * Antwortzeilen (eine je Zeile) -> [{ id, label }]. Bestehende Optionen behalten ihre ID - daran
 * haengen die Antworten. Erst ueber den gleichen Text, dann ueber die Position, aber nur mit einer
 * ID, die noch frei ist: sonst bekaemen zwei Optionen dieselbe, und Antworten wanderten.
 */
export function zeilenMitIds(text, alt = []) {
  const zeilen = String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  const vergeben = new Set();
  const ids = zeilen.map(label => {
    const o = (alt ?? []).find(x => x.label === label && !vergeben.has(x.id));
    if (o) vergeben.add(o.id);
    return o?.id;
  });
  return zeilen.map((label, i) => {
    let id = ids[i];
    if (id == null) {
      const frei = (alt ?? [])[i];
      if (frei && !vergeben.has(frei.id) && !zeilen.includes(frei.label)) { id = frei.id; vergeben.add(id); }
    }
    return { id, label };
  });
}

export function pruefeAntworten(fragen, roh) {
  const eingabe = roh && typeof roh === 'object' ? roh : {};
  const raus = {};
  for (const f of fragen) {
    const v = eingabe[f.id];
    const c = f.config ?? {};
    const fehler = t => ({ fehler: `„${f.text}": ${t}`, frage_id: f.id });
    if (leer(v)) { if (f.pflicht) return fehler('bitte beantworten'); continue; }
    const optIds = new Set((c.options ?? []).map(o => o.id));
    switch (f.typ) {
      case 'single':
        if (!optIds.has(String(v))) return fehler('unbekannte Auswahl');
        raus[f.id] = String(v); break;
      case 'multi': {
        const a = [...new Set((Array.isArray(v) ? v : [v]).map(String))];
        if (a.some(x => !optIds.has(x))) return fehler('unbekannte Auswahl');
        if (c.max && a.length > c.max) return fehler(`höchstens ${c.max} auswählen`);
        raus[f.id] = a; break;
      }
      case 'points': {
        if (typeof v !== 'object' || Array.isArray(v)) return fehler('ungültig');
        const o = {}; let summe = 0;
        for (const [k, n] of Object.entries(v)) {
          if (!optIds.has(k)) return fehler('unbekannte Auswahl');
          const z = Number(n);
          if (!Number.isInteger(z) || z < 0) return fehler('nur ganze Zahlen ab 0');
          if (z) o[k] = z;
          summe += z;
        }
        // Alles wieder auf 0 gestellt heisst: nicht beantwortet - nicht "falsche Summe".
        if (!summe) { if (f.pflicht) return fehler('bitte beantworten'); continue; }
        if (summe !== c.total) return fehler(`die Punkte müssen genau ${c.total} ergeben (sind ${summe})`);
        raus[f.id] = o; break;
      }
      case 'text': case 'text_limited': {
        const t = String(v).trim();
        const max = f.typ === 'text' ? 5000 : c.max_length;
        if (t.length > max) return fehler(`höchstens ${max} Zeichen`);
        if (!t) { if (f.pflicht) return fehler('bitte beantworten'); continue; }
        raus[f.id] = t; break;
      }
      case 'slider': {
        const z = Number(v);
        if (!Number.isInteger(z) || z < c.min || z > c.max) return fehler(`Wert zwischen ${c.min} und ${c.max}`);
        raus[f.id] = z; break;
      }
      case 'slider_multi': {
        if (typeof v !== 'object' || Array.isArray(v)) return fehler('ungültig');
        const o = {};
        for (const it of c.items ?? []) {
          if (v[it.id] == null) return fehler(`„${it.label}" noch nicht eingestellt – Regler bewegen`);
          const z = Number(v[it.id]);
          if (!Number.isInteger(z) || z < c.min || z > c.max) return fehler(`„${it.label}" zwischen ${c.min} und ${c.max}`);
          o[it.id] = z;
        }
        raus[f.id] = o; break;
      }
      case 'slider2d': {
        const x = Number(v?.x), y = Number(v?.y);
        if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 10)) return fehler('Punkt außerhalb');
        raus[f.id] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }; break;
      }
      default: return fehler('unbekannter Fragetyp');
    }
  }
  return { antworten: raus };
}

// --- Auswertung ------------------------------------------------------------------

/** Kreuztabelle zweier Einfachwahl-Fragen: zellen[zeile][spalte] = Anzahl. */
export function kreuztabelle(antworten, fa, fb) {
  const za = fa.config.options, sb = fb.config.options;
  const zellen = za.map(() => sb.map(() => 0));
  for (const a of antworten) {
    const i = za.findIndex(o => o.id === a.antworten?.[fa.id]);
    const j = sb.findIndex(o => o.id === a.antworten?.[fb.id]);
    if (i >= 0 && j >= 0) zellen[i][j]++;
  }
  return { zeilen: za, spalten: sb, zellen };
}

/**
 * Die Zahlen-Dimensionen einer Umfrage fuer die Personengruppen: jeder Regler einzeln, beim
 * 2D-Regler beide Achsen - alles auf 0-10 normiert, damit ein Regler bis 1000 nicht alles erdrueckt.
 */
export function dimensionen(fragen) {
  const d = [];
  for (const f of fragen) {
    const c = f.config ?? {};
    const norm = w => (w - c.min) / (c.max - c.min) * 10;
    if (f.typ === 'slider') d.push({ label: f.text, wert: a => (a[f.id] == null ? null : norm(a[f.id])) });
    if (f.typ === 'slider_multi') for (const it of c.items) d.push({ label: `${f.text}: ${it.label}`, wert: a => (a[f.id]?.[it.id] == null ? null : norm(a[f.id][it.id])) });
    if (f.typ === 'slider2d') {
      d.push({ label: `${f.text} (${c.x_left || 'links'} → ${c.x_right || 'rechts'})`, wert: a => a[f.id]?.x ?? null });
      d.push({ label: `${f.text} (${c.y_top || 'oben'} → ${c.y_bottom || 'unten'})`, wert: a => a[f.id]?.y ?? null });
    }
  }
  return d;
}

// Ein kleiner, fester Zufall: gleicher Seed, gleiche Gruppen - sonst sieht die Auswertung bei
// jedem Oeffnen anders aus.
function zufall(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Personengruppen: k-means ueber die Zahlen-Dimensionen. Fehlende Werte = Mittelwert der
 * Dimension, dann z-standardisiert. Sechs Starts mit Seed 4242+k, der mit der kleinsten Streuung
 * gewinnt. Erst ab 2 Dimensionen und 6 Antworten - darunter sind "Gruppen" nur Rauschen.
 * Zurueck: { gruppen: [{ mitglieder: [index], mitte: [Werte 0-10] }] } oder { hinweis }.
 */
export function kmeans(antworten, fragen, k = 3) {
  const dims = dimensionen(fragen);
  if (dims.length < 2) return { hinweis: 'Dafür braucht es mindestens zwei Regler-Werte (Schieberegler oder 2D).' };
  if (antworten.length < 6) return { hinweis: 'Dafür braucht es mindestens 6 Antworten.' };
  const roh = antworten.map(a => dims.map(d => d.wert(a.antworten ?? {})));
  const mittel = dims.map((_, j) => { const w = roh.map(r => r[j]).filter(x => x != null); return w.length ? w.reduce((s, x) => s + x, 0) / w.length : 5; });
  const voll = roh.map(r => r.map((x, j) => (x == null ? mittel[j] : x)));
  const sd = dims.map((_, j) => Math.sqrt(voll.reduce((s, r) => s + (r[j] - mittel[j]) ** 2, 0) / voll.length) || 1);
  const z = voll.map(r => r.map((x, j) => (x - mittel[j]) / sd[j]));
  const abstand = (a, b) => a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
  k = Math.min(Math.max(2, k), z.length);

  let bestes = null;
  for (let start = 0; start < 6; start++) {
    const r = zufall(4242 + k + start * 1000);
    // k-means++: erster Mittelpunkt zufaellig, weitere mit Abstand gewichtet.
    const mitten = [z[Math.floor(r() * z.length)]];
    while (mitten.length < k) {
      const d = z.map(p => Math.min(...mitten.map(m => abstand(p, m))));
      const summe = d.reduce((s, x) => s + x, 0);
      let ziel = r() * summe, i = 0;
      while (i < d.length - 1 && (ziel -= d[i]) > 0) i++;
      mitten.push(z[i]);
    }
    let zu = new Array(z.length).fill(0);
    for (let runde = 0; runde < 50; runde++) {
      const neu = z.map(p => { let b = 0; mitten.forEach((m, i) => { if (abstand(p, m) < abstand(p, mitten[b])) b = i; }); return b; });
      const fertig = neu.every((x, i) => x === zu[i]) && runde > 0;
      zu = neu;
      for (let i = 0; i < k; i++) {
        const drin = z.filter((_, j) => zu[j] === i);
        if (drin.length) mitten[i] = drin[0].map((_, d) => drin.reduce((s, p) => s + p[d], 0) / drin.length);
      }
      if (fertig) break;
    }
    const streuung = z.reduce((s, p, i) => s + abstand(p, mitten[zu[i]]), 0);
    if (!bestes || streuung < bestes.streuung) bestes = { streuung, zu };
  }
  const gruppen = [];
  for (let i = 0; i < k; i++) {
    const mitglieder = bestes.zu.map((g, j) => (g === i ? j : -1)).filter(j => j >= 0);
    if (!mitglieder.length) continue;
    gruppen.push({ mitglieder,
      mitte: dims.map((_, d) => mitglieder.reduce((s, j) => s + voll[j][d], 0) / mitglieder.length) });
  }
  return { gruppen: gruppen.sort((a, b) => b.mitglieder.length - a.mitglieder.length), dimensionen: dims.map(d => d.label) };
}

/** Eine Antwort als lesbarer Text - fuer CSV und Zitatlisten. */
export function antwortText(f, v) {
  if (v == null) return '';
  const c = f.config ?? {};
  const label = id => c.options?.find(o => o.id === id)?.label ?? id;
  switch (f.typ) {
    case 'single': return label(v);
    case 'multi': return v.map(label).join('; ');
    case 'points': return Object.entries(v).map(([id, n]) => `${label(id)}: ${n}`).join('; ');
    case 'slider_multi': return (c.items ?? []).map(it => `${it.label}: ${v[it.id]}`).join('; ');
    case 'slider2d': return `x=${v.x}, y=${v.y}`;
    default: return String(v);
  }
}

/**
 * CSV mit Semikolon (Excel in Deutschland). Zellen, die mit = + - @ oder Tab/CR beginnen, bekommen
 * ein ' davor - sonst fuehrt eine Tabellenkalkulation "=HYPERLINK(...)" aus einer Antwort aus.
 */
export function csv(fragen, antworten, mitNamen = false) {
  const zelle = t => {
    let s = String(t ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Zeit nur mit Namen: anonym liefert der Server keine (sie verriete, wer wann geantwortet hat).
  const kopf = ['Teilnahme', ...(mitNamen ? ['Name', 'Zeit'] : []), ...fragen.map(f => f.text)];
  const zeilen = antworten.map(a => [a.public_id, ...(mitNamen ? [a.name ?? '', a.zeit ?? ''] : []),
    ...fragen.map(f => antwortText(f, a.antworten?.[f.id]))]);
  return [kopf, ...zeilen].map(z => z.map(zelle).join(';')).join('\r\n');
}
