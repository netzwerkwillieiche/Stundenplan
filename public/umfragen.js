// --- umfragen ---
// Umfragen im Buero: Baukasten, Ausfuellen (eine Komponente fuer intern, Vorschau und Gaeste) und
// die Auswertung - Diagramme, Zusammenhaenge, Personengruppen. Gerechnet wird hier im Browser aus
// Antworten ohne Identitaet; die Regeln (Fragen, Pruefung, k-means) stehen in umfrage-logik.js,
// die der Server genauso laedt.
import { $, api, bestaetigen, eingabe, h, kopieren, md, nameOf, ohneMd, oops, setzeKinder, toast } from './kern.js';
import { dlg, freigabeFenster, knopf, zeit } from './freigabe.js';
import { MIT_OPTIONEN, TYPEN, antwortText, dimensionen, kmeans, kreuztabelle, pruefeAntworten, zeilenMitIds } from './umfrage-logik.js';

let liste = 'laufend';
let offen = null;          // ID der geoeffneten Umfrage
let ansicht = 'ausfuellen';
const FARBEN = ['#3b6fd4', '#e67e22', '#17916a', '#c0392b', '#8e44ad', '#16a085', '#d4a017', '#7f8c8d', '#e84393', '#2d3436'];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svgEl = text => document.importNode(new DOMParser().parseFromString(text, 'image/svg+xml').documentElement, true);
const STATUS = { draft: 'Entwurf', open: 'offen', closed: 'beendet' };

export async function loadUmfragen(ziel) {
  if (offen) return umfrageOeffnen(ziel, offen).catch(err => { offen = null; oops(err); loadUmfragen(ziel).catch(oops); });
  const alle = await api('GET', '/api/umfragen');
  const passt = u => ({ laufend: u.status === 'open', entwuerfe: u.status === 'draft', archiv: u.status === 'closed', meine: u.rolle === 'besitzer' }[liste]);
  const neu = () => loadUmfragen(ziel).catch(oops);
  const sichtbar = alle.filter(passt);
  setzeKinder(ziel,
    h('div', { className: 'bar' },
      h('div', { className: 'reiter klein' }, ...[['laufend', 'Laufend'], ['entwuerfe', 'Entwürfe'], ['archiv', 'Archiv'], ['meine', 'Meine']].map(([k, t]) =>
        h('button', { type: 'button', textContent: t, className: k === liste ? 'active' : '', onclick: () => { liste = k; neu(); } }))),
      h('span', { className: 'grow' }),
      knopf('+ Umfrage', async () => {
        const titel = await eingabe('Titel der Umfrage');
        if (!titel?.trim()) return;
        try { const u = await api('POST', '/api/umfragen', { titel }); offen = u.id; ansicht = 'aufbau'; await neu(); } catch (err) { oops(err); }
      }, 'tiny primary')),
    sichtbar.length ? h('div', { className: 'cards' }, ...sichtbar.map(u => h('button', {
      type: 'button', className: 'card board-karte', onclick: () => { offen = u.id; ansicht = u.rolle === 'besitzer' ? (u.status === 'draft' ? 'aufbau' : 'auswertung') : 'ausfuellen'; neu(); },
    }, h('strong', { textContent: u.titel }),
      // In der Vorschau ohne Markdown-Zeichen - sonst stuende da "**Mensa**".
      u.beschreibung ? h('p', { className: 'muted small', textContent: ohneMd(u.beschreibung).slice(0, 140) }) : null,
      h('small', { className: 'sub', textContent: [STATUS[u.status], u.rolle === 'besitzer' ? `${u.antworten} Antworten` : `von ${nameOf(u.besitzer)}`,
        u.beantwortet ? '✓ beantwortet' : null, u.endet_at ? `bis ${zeit(u.endet_at)}` : null].filter(Boolean).join(' · ') }))))
      : h('div', { className: 'empty' }, h('p', { textContent: 'Keine Umfrage hier.' }),
        h('p', { className: 'muted small', textContent: 'Fragebögen mit acht Fragetypen, für Freunde, Kurse und auf Wunsch per Link auch für Gäste ohne Konto – mit Auswertung.' })));
}

async function umfrageOeffnen(ziel, id) {
  const u = await api('GET', `/api/umfragen/${id}`);
  const besitzer = u.rolle === 'besitzer';
  const neu = () => loadUmfragen(ziel).catch(oops);
  const reiter = besitzer ? [['aufbau', 'Aufbau'], ['vorschau', 'Vorschau'], ['ausfuellen', 'Ausfüllen'], ['auswertung', 'Auswertung'], ['antworten', 'Antworten'], ['einstellungen', 'Einstellungen']]
    : [['ausfuellen', 'Ausfüllen'], ...(u.darf_ergebnis ? [['auswertung', 'Auswertung']] : [])];
  if (!reiter.some(([k]) => k === ansicht)) ansicht = reiter[0][0];
  const inhalt = h('div', { className: 'stack' });
  setzeKinder(ziel,
    h('div', { className: 'bar' }, knopf('← Alle', () => { offen = null; neu(); }),
      h('strong', { className: 'grow', textContent: u.titel }), h('span', { className: 'pille', textContent: STATUS[u.status] })),
    h('div', { className: 'reiter klein' }, ...reiter.map(([k, t]) =>
      h('button', { type: 'button', textContent: t, className: k === ansicht ? 'active' : '', onclick: () => { ansicht = k; neu(); } }))),
    inhalt);
  if (ansicht === 'aufbau') return aufbau(inhalt, u, neu);
  if (ansicht === 'einstellungen') return einstellungen(inhalt, u, neu);
  if (ansicht === 'auswertung') return auswertung(inhalt, u);
  if (ansicht === 'antworten') return antwortenListe(inhalt, u, neu);
  if (ansicht === 'vorschau') return setzeKinder(inhalt, h('p', { className: 'hinweis', textContent: 'Vorschau – so sieht es aus, abgeschickt wird nichts.' }),
    ausfuellen(u, { vorschau: true }));
  // Ausfuellen (angemeldet)
  if (u.status !== 'open') return setzeKinder(inhalt, h('p', { className: 'meta', textContent: u.status === 'draft' ? 'Noch ein Entwurf – erst unter Einstellungen öffnen.' : 'Die Umfrage ist beendet.' }));
  setzeKinder(inhalt, ausfuellen(u, {
    absenden: async antworten => { await api('POST', `/api/umfragen/${u.id}/antwort`, { antworten }); toast(u.mehrfach ? 'Danke, gespeichert.' : 'Danke – ändern geht bis zum Ende.', true); await neu(); },
    zurueckziehen: u.meine ? async () => { await api('DELETE', `/api/umfragen/${u.id}/antwort`); toast('Antwort zurückgezogen.', true); await neu(); } : null,
  }));
}

// --- Ausfuellen: eine Komponente fuer intern, Vorschau und Gast ---------------------------------

/**
 * Baut das Formular. `absenden(antworten)` bekommt die bereinigten Antworten; vorher prueft
 * pruefeAntworten dasselbe wie der Server - damit der Fehler an der Frage steht, nicht in einer Meldung.
 */
export function ausfuellen(u, { absenden, zurueckziehen, vorschau = false, nameFeld = null } = {}) {
  const werte = {};
  const alt = u.meine?.antworten ?? {};
  const fehlerAn = new Map();
  const frageEl = f => {
    const c = f.config ?? {};
    const box = h('div', { className: 'frage' });
    const fehler = h('p', { className: 'fehler-text', hidden: true });
    fehlerAn.set(f.id, fehler);
    const setze = v => { werte[f.id] = v; };
    let feld;
    if (f.typ === 'single') {
      feld = h('div', { className: 'stack' }, ...c.options.map(o => {
        const x = h('input', { type: 'radio', name: `f${f.id}`, checked: alt[f.id] === o.id });
        x.onchange = () => setze(o.id);
        return h('label', { className: 'check' }, x, ' ' + o.label);
      }));
      if (alt[f.id]) setze(alt[f.id]);
    } else if (f.typ === 'multi') {
      const gewaehlt = new Set(alt[f.id] ?? []);
      feld = h('div', { className: 'stack' }, ...c.options.map(o => {
        const x = h('input', { type: 'checkbox', checked: gewaehlt.has(o.id) });
        x.onchange = () => { x.checked ? gewaehlt.add(o.id) : gewaehlt.delete(o.id); setze([...gewaehlt]); };
        return h('label', { className: 'check' }, x, ' ' + o.label);
      }), c.max ? h('small', { className: 'muted', textContent: `höchstens ${c.max}` }) : null);
      setze([...gewaehlt]);
    } else if (f.typ === 'points') {
      const v = { ...(alt[f.id] ?? {}) };
      const rest = h('small', { className: 'muted' });
      const malRest = () => { const s = Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0); rest.textContent = `${s} von ${c.total} Punkten verteilt`; rest.classList.toggle('fehler-text', s > c.total); };
      feld = h('div', { className: 'stack' }, ...c.options.map(o => {
        const x = h('input', { type: 'number', min: 0, max: c.total, value: String(v[o.id] ?? 0), className: 'kurz' });
        x.oninput = () => {
          const n = Math.max(0, Math.trunc(Number(x.value) || 0));
          if (n) v[o.id] = n; else delete v[o.id];
          setze({ ...v }); malRest();
        };
        return h('label', { className: 'row' }, x, ' ' + o.label);
      }), rest);
      malRest();
      setze(v);
    } else if (f.typ === 'text' || f.typ === 'text_limited') {
      const max = f.typ === 'text' ? 5000 : c.max_length;
      const eingabeFeld = h(max > 300 ? 'textarea' : 'input', { maxLength: max, value: alt[f.id] ?? '', rows: 4 });
      const zaehler = h('small', { className: 'muted', textContent: `${eingabeFeld.value.length} / ${max}` });
      eingabeFeld.oninput = () => { setze(eingabeFeld.value); zaehler.textContent = `${eingabeFeld.value.length} / ${max}`; };
      if (alt[f.id]) setze(alt[f.id]);
      feld = h('div', { className: 'stack' }, eingabeFeld, zaehler);
    } else if (f.typ === 'slider') {
      const start = alt[f.id] ?? Math.round((c.min + c.max) / 2);
      const x = h('input', { type: 'range', min: c.min, max: c.max, step: 1, value: String(start) });
      const zahl = h('strong', { textContent: String(start) });
      const beruehrt = h('small', { className: 'muted', textContent: alt[f.id] != null ? '' : 'noch nicht gewählt – Regler bewegen' });
      x.oninput = () => { zahl.textContent = x.value; setze(Number(x.value)); beruehrt.textContent = ''; };
      if (alt[f.id] != null) setze(alt[f.id]);
      feld = h('div', { className: 'stack' }, h('div', { className: 'regler' }, h('small', { textContent: c.min_label || String(c.min) }), x,
        h('small', { textContent: c.max_label || String(c.max) }), zahl), beruehrt);
    } else if (f.typ === 'slider_multi') {
      const v = { ...(alt[f.id] ?? {}) };
      feld = h('div', { className: 'stack' }, ...c.items.map(it => {
        // Erst beim Bewegen gesetzt - sonst zaehlte eine nie angefasste Pflichtfrage als beantwortet.
        const start = v[it.id] ?? Math.round((c.min + c.max) / 2);
        const x = h('input', { type: 'range', min: c.min, max: c.max, step: 1, value: String(start) });
        const zahl = h('strong', { textContent: v[it.id] != null ? String(start) : '–', title: 'noch nicht gewählt' });
        x.oninput = () => { zahl.textContent = x.value; v[it.id] = Number(x.value); setze({ ...v }); };
        return h('div', { className: 'stack eng' }, h('span', { textContent: it.label }),
          h('div', { className: 'regler' }, h('small', { textContent: c.min_label || String(c.min) }), x, h('small', { textContent: c.max_label || String(c.max) }), zahl));
      }));
      if (Object.keys(v).length) setze({ ...v });
    } else if (f.typ === 'slider2d') {
      // Ein Feld 0-10 x 0-10, y = 0 oben. Klick setzt den Punkt.
      let p = alt[f.id] ?? null;
      const flaeche = h('div', { className: 'feld2d' });
      const mal = () => setzeKinder(flaeche, svgEl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="feld2d-svg">
        <rect x="0" y="0" width="100" height="100" fill="#f4f6fa" stroke="#ccd3de"/>
        <line x1="50" y1="0" x2="50" y2="100" stroke="#dde2ea"/><line x1="0" y1="50" x2="100" y2="50" stroke="#dde2ea"/>
        <text x="2" y="52" font-size="5" fill="#6a7382">${esc(c.x_left)}</text><text x="98" y="52" font-size="5" text-anchor="end" fill="#6a7382">${esc(c.x_right)}</text>
        <text x="50" y="6" font-size="5" text-anchor="middle" fill="#6a7382">${esc(c.y_top)}</text><text x="50" y="98" font-size="5" text-anchor="middle" fill="#6a7382">${esc(c.y_bottom)}</text>
        ${p ? `<circle cx="${p.x * 10}" cy="${p.y * 10}" r="3.5" fill="#3b6fd4" stroke="#fff" stroke-width="1"/>` : ''}</svg>`));
      flaeche.onclick = e => {
        const r = flaeche.getBoundingClientRect();
        p = { x: Math.round(Math.min(10, Math.max(0, (e.clientX - r.left) / r.width * 10)) * 10) / 10,
          y: Math.round(Math.min(10, Math.max(0, (e.clientY - r.top) / r.height * 10)) * 10) / 10 };
        setze(p); mal();
      };
      if (p) setze(p);
      mal();
      feld = h('div', { className: 'stack' }, flaeche, h('small', { className: 'muted', textContent: 'Tippe in das Feld, um deinen Punkt zu setzen.' }));
    }
    box.append(h('p', { className: 'frage-text' }, f.text, f.pflicht ? h('span', { className: 'pflicht', textContent: ' *' }) : null), feld, fehler);
    return box;
  };

  const teile = [];
  if (u.beschreibung) teile.push(md(u.beschreibung));
  if (nameFeld) teile.push(nameFeld);
  const ohne = u.fragen.filter(f => !f.abschnitt_id || !u.abschnitte.some(a => a.id === f.abschnitt_id));
  teile.push(...ohne.map(frageEl));
  for (const a of u.abschnitte) {
    const drin = u.fragen.filter(f => f.abschnitt_id === a.id);
    if (drin.length) teile.push(h('h3', { className: 'abschnitt', textContent: a.titel }), ...drin.map(frageEl));
  }
  if (!u.fragen.length) teile.push(h('p', { className: 'meta', textContent: 'Noch keine Fragen.' }));
  const senden = knopf(u.meine ? 'Antwort ändern' : 'Absenden', async () => {
    for (const el of fehlerAn.values()) el.hidden = true;
    const r = pruefeAntworten(u.fragen, werte);
    if (r.fehler) {
      const el = fehlerAn.get(r.frage_id);
      // Der Fehler steht an der Frage, und dorthin wird gescrollt - eine Meldung dazu legte sich auf
      // dem Handy nur ueber den Absenden-Knopf.
      if (el) { el.textContent = r.fehler; el.hidden = false; el.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      return toast(r.fehler);
    }
    if (vorschau) return toast('Vorschau: alles gültig.', true);
    senden.disabled = true;
    try { await absenden(r.antworten); } catch (err) { oops(err); } finally { senden.disabled = false; }
  }, 'primary');
  teile.push(h('div', { className: 'row end' },
    zurueckziehen ? knopf('Antwort zurückziehen', async () => { if (await bestaetigen('Deine Antwort löschen?')) { try { await zurueckziehen(); } catch (err) { oops(err); } } }, 'ghost') : null,
    senden),
  u.meine ? h('p', { className: 'muted small', textContent: `Du hast am ${zeit(u.meine.at)} geantwortet (${u.meine.public_id}).` }) : null,
  u.identitaet === 'mit_namen' ? h('p', { className: 'muted small', textContent: 'Diese Umfrage ist nicht anonym: wer sie angelegt hat, sieht deinen Namen.' })
    : h('p', { className: 'muted small', textContent: 'Anonym: niemand sieht, was du geantwortet hast – auch nicht, wer die Umfrage angelegt hat.' }));
  return h('div', { className: 'card umfrage-ausfuellen' }, ...teile);
}

// --- Baukasten -------------------------------------------------------------------------------

function aufbau(ziel, u, neu) {
  const tu = f => async () => { try { await f(); await neu(); } catch (err) { oops(err); } };
  const zeile = (f, i, n) => h('li', {},
    h('span', { className: 'grow' }, `${f.text}${f.pflicht ? ' *' : ''}`, h('small', { className: 'sub', textContent: TYPEN[f.typ] + (MIT_OPTIONEN.has(f.typ) ? ` · ${f.config.options.length} Antworten` : '') })),
    knopf('↑', tu(() => api('POST', `/api/umfragen/fragen/${f.id}/verschieben`, { richtung: -1 })), 'tiny ghost', { disabled: i === 0 }),
    knopf('↓', tu(() => api('POST', `/api/umfragen/fragen/${f.id}/verschieben`, { richtung: 1 })), 'tiny ghost', { disabled: i === n - 1 }),
    knopf('Ändern', () => frageFenster(u, f, neu)),
    knopf('⧉', tu(() => api('POST', `/api/umfragen/fragen/${f.id}/duplizieren`)), 'tiny ghost', { title: 'Duplizieren' }),
    knopf('×', async () => { if (await bestaetigen('Frage löschen?')) await tu(() => api('DELETE', `/api/umfragen/fragen/${f.id}`))(); }, 'tiny ghost', { title: 'Löschen' }));
  const gruppe = (titel, fragen, a = null) => h('div', { className: 'card' },
    h('div', { className: 'row' }, h('strong', { className: 'grow', textContent: titel }),
      a ? knopf('↑', tu(() => api('POST', `/api/umfragen/abschnitte/${a.id}/verschieben`, { richtung: -1 }))) : null,
      a ? knopf('↓', tu(() => api('POST', `/api/umfragen/abschnitte/${a.id}/verschieben`, { richtung: 1 }))) : null,
      a ? knopf('Umbenennen', async () => { const t = await eingabe('Abschnitt', a.titel); if (t?.trim()) await tu(() => api('PATCH', `/api/umfragen/abschnitte/${a.id}`, { titel: t }))(); }) : null,
      a ? knopf('×', async () => { if (await bestaetigen('Abschnitt löschen? Die Fragen bleiben (ohne Abschnitt).')) await tu(() => api('DELETE', `/api/umfragen/abschnitte/${a.id}`))(); }) : null,
      knopf('+ Frage', () => frageFenster(u, null, neu, a?.id ?? null), 'tiny primary')),
    fragen.length ? h('ul', { className: 'list' }, ...fragen.map((f, i) => zeile(f, i, fragen.length)))
      : h('p', { className: 'meta', textContent: 'Noch keine Fragen.' }));
  const ohne = u.fragen.filter(f => !f.abschnitt_id);
  setzeKinder(ziel,
    u.antworten ? h('p', { className: 'hinweis', textContent: `Es gibt schon ${u.antworten} Antworten: Texte ändern und Neues hinzufügen geht; Typ wechseln, Antworten entfernen oder Grenzen ändern erst nach dem Zurücksetzen.` }) : null,
    gruppe(u.abschnitte.length ? 'Ohne Abschnitt' : 'Fragen', ohne),
    ...u.abschnitte.map(a => gruppe(a.titel, u.fragen.filter(f => f.abschnitt_id === a.id), a)),
    h('div', { className: 'row' }, knopf('+ Abschnitt', async () => {
      const t = await eingabe('Titel des Abschnitts');
      if (t?.trim()) await tu(() => api('POST', `/api/umfragen/${u.id}/abschnitte`, { titel: t }))();
    }), u.status === 'draft' ? knopf('Umfrage öffnen', tu(async () => {
      await api('POST', `/api/umfragen/${u.id}/oeffnen`);
      toast('Offen.', true);
    }), 'tiny primary') : null));
}

/** Frage anlegen oder aendern - die Felder je nach Typ. */
function frageFenster(u, f, neu, abschnittId = null) {
  const d = dlg();
  let typ = f?.typ ?? 'single';
  const c = f?.config ?? {};
  const typWahl = h('select', { disabled: !!f && !!u.antworten }, ...Object.entries(TYPEN).map(([k, t]) => h('option', { value: k, textContent: t, selected: k === typ })));
  const text = h('input', { value: f?.text ?? '', maxLength: 500 });
  const pflicht = h('input', { type: 'checkbox', checked: !!f?.pflicht });
  const abschnitt = h('select', {}, h('option', { value: '', textContent: '— ohne Abschnitt —' }),
    ...u.abschnitte.map(a => h('option', { value: String(a.id), textContent: a.titel, selected: a.id === (f?.abschnitt_id ?? abschnittId) })));
  const optionen = h('textarea', { rows: 6, value: (c.options ?? []).map(o => o.label).join('\n'), placeholder: 'Eine Antwort je Zeile (2–30)' });
  const items = h('textarea', { rows: 4, value: (c.items ?? []).map(o => o.label).join('\n'), placeholder: 'Ein Regler je Zeile' });
  const zahl = (wert, min, max) => h('input', { type: 'number', min, max, value: String(wert), className: 'kurz' });
  // `max` heisst bei "Mehrfach" hoechstens-so-viele, bei Reglern das rechte Ende - die Vorgabe also
  // nur vom passenden Typ nehmen, sonst stuende nach einem Typwechsel eine 10 bei "hoechstens".
  const regler = t => t === 'slider' || t === 'slider_multi';
  const max = zahl(f?.typ === 'multi' ? c.max ?? 0 : 0, 0, 30), total = zahl(c.total ?? 10, 1, 1000), maxLen = zahl(c.max_length ?? 280, 10, 5000);
  const vMin = zahl(regler(f?.typ) ? c.min ?? 0 : 0, -1000, 1000), vMax = zahl(regler(f?.typ) ? c.max ?? 10 : 10, -1000, 1000);
  const lMin = h('input', { value: c.min_label ?? '', maxLength: 60, placeholder: 'links (z. B. gar nicht)' });
  const lMax = h('input', { value: c.max_label ?? '', maxLength: 60, placeholder: 'rechts (z. B. sehr)' });
  const achsen = ['x_left', 'x_right', 'y_top', 'y_bottom'].map((k, i) => h('input', { value: c[k] ?? '', maxLength: 40, placeholder: ['links', 'rechts', 'oben', 'unten'][i] }));
  const extra = h('div', { className: 'stack' });
  const malExtra = () => {
    typ = typWahl.value;
    setzeKinder(extra,
      MIT_OPTIONEN.has(typ) ? h('label', { className: 'field' }, 'Antworten', optionen) : null,
      typ === 'multi' ? h('label', { className: 'row' }, 'höchstens', max, h('small', { className: 'muted', textContent: '(0 = beliebig viele)' })) : null,
      typ === 'points' ? h('label', { className: 'row' }, 'Punkte insgesamt', total) : null,
      typ === 'text_limited' ? h('label', { className: 'row' }, 'höchstens', maxLen, 'Zeichen') : null,
      typ === 'slider' || typ === 'slider_multi' ? h('div', { className: 'row' }, 'von', vMin, 'bis', vMax) : null,
      typ === 'slider' || typ === 'slider_multi' ? h('div', { className: 'row' }, lMin, lMax) : null,
      typ === 'slider_multi' ? h('label', { className: 'field' }, 'Regler', items) : null,
      typ === 'slider2d' ? h('div', { className: 'stack' }, h('small', { className: 'muted', textContent: 'Beschriftung der Achsen' }), h('div', { className: 'row' }, ...achsen)) : null);
  };
  typWahl.onchange = malExtra;
  malExtra();
  // Bestehende Optionen behalten ihre ID, solange die Zeile gleich lautet - Antworten haengen daran.
  const mitIds = (roh, alt) => zeilenMitIds(roh.value, alt);
  d.replaceChildren(h('h2', { textContent: f ? 'Frage ändern' : 'Neue Frage' }),
    h('div', { className: 'stack' }, h('label', { className: 'field' }, 'Fragetyp', typWahl), h('label', { className: 'field' }, 'Frage', text),
      h('label', { className: 'check' }, pflicht, ' Pflichtfrage'), u.abschnitte.length ? h('label', { className: 'field' }, 'Abschnitt', abschnitt) : null, extra),
    h('div', { className: 'row end' }, knopf('Speichern', async () => {
      const config = { options: mitIds(optionen, c.options), items: mitIds(items, c.items), max: Number(max.value), total: Number(total.value),
        max_length: Number(maxLen.value), min: Number(vMin.value), min_label: lMin.value, max_label: lMax.value,
        ...Object.fromEntries(['x_left', 'x_right', 'y_top', 'y_bottom'].map((k, i) => [k, achsen[i].value])) };
      if (regler(typ)) config.max = Number(vMax.value);
      const body = { typ, text: text.value, pflicht: pflicht.checked, config, abschnitt_id: abschnitt.value ? Number(abschnitt.value) : null };
      try {
        if (f) await api('PATCH', `/api/umfragen/fragen/${f.id}`, body);
        else await api('POST', `/api/umfragen/${u.id}/fragen`, body);
        d.close();
        await neu();
      } catch (err) { oops(err); }
    }, 'primary'), knopf('Abbrechen', () => d.close(), 'ghost')));
  d.showModal();
  text.focus();
}

// --- Einstellungen, Status, Gast-Link --------------------------------------------------------

function einstellungen(ziel, u, neu) {
  // Jede Aktion hier zeichnet neu - Geaendertes unter "Allgemein" wird vorher mitgespeichert,
  // sonst war ein neuer Titel weg, sobald man z. B. den Gast-Link erzeugte.
  const tu = (f, ok) => async () => {
    try {
      if (JSON.stringify(allgemein()) !== anfang) await api('PATCH', `/api/umfragen/${u.id}`, allgemein());
      await f(); if (ok) toast(ok, true); await neu();
    } catch (err) { oops(err); }
  };
  const titel = h('input', { value: u.titel, maxLength: 200 });
  const text = h('textarea', { value: u.beschreibung ?? '', rows: 3, maxLength: 2000 });
  const ende = h('input', { type: 'datetime-local', value: (u.endet_at ?? '').replace(' ', 'T').slice(0, 16) });
  const identitaet = h('select', {}, h('option', { value: 'anonym', textContent: 'anonym – niemand sieht, wer was geantwortet hat' }),
    h('option', { value: 'mit_namen', textContent: 'mit Namen – ich sehe, wer geantwortet hat' }));
  identitaet.value = u.identitaet;
  const mehrfach = h('input', { type: 'checkbox', checked: u.mehrfach });
  const live = h('input', { type: 'checkbox', checked: u.ergebnis_live });
  const fuer = h('select', {}, h('option', { value: 'ich', textContent: 'nur ich' }), h('option', { value: 'teilnehmer', textContent: 'alle, die teilnehmen' }));
  fuer.value = u.ergebnis_fuer;
  const allgemein = () => ({ titel: titel.value, beschreibung: text.value, endet_at: ende.value || null, identitaet: identitaet.value,
    mehrfach: mehrfach.checked, ergebnis_live: live.checked, ergebnis_fuer: fuer.value });
  const anfang = JSON.stringify(allgemein());
  const link = u.gast_key ? `${location.origin}/umfrage/${u.gast_key}` : '';
  setzeKinder(ziel,
    h('div', { className: 'card' }, h('h3', { textContent: 'Allgemein' }),
      h('div', { className: 'stack' }, h('label', { className: 'field' }, 'Titel', titel), h('label', { className: 'field' }, 'Einleitung (Markdown)', text),
        h('label', { className: 'field' }, 'Endet (leer = von Hand schließen)', ende), h('label', { className: 'field' }, 'Namen', identitaet),
        h('label', { className: 'check' }, mehrfach, ' mehrfach teilnehmen (jede Teilnahme einzeln, dann nicht bearbeitbar)'),
        h('label', { className: 'check' }, live, ' Ergebnis schon während der Umfrage zeigen'),
        h('label', { className: 'field' }, 'Ergebnis sehen', fuer),
        h('div', { className: 'row end' }, knopf('Speichern', tu(async () => {}, 'Gespeichert.'), 'primary')))),
    h('div', { className: 'card' }, h('h3', { textContent: 'Teilnehmen' }),
      h('p', { className: 'muted small', textContent: 'Freunde und ganze Kurse – und auf Wunsch per Link Gäste ohne Konto (z. B. Eltern).' }),
      h('div', { className: 'row' }, knopf('Freunde & Kurse …', tu(async () => freigabeFenster('umfrage', u.id, `Wer nimmt teil? „${titel.value}"`, neu)), 'tiny primary')),
      link ? h('div', { className: 'stack' }, h('div', { className: 'row' }, h('input', { value: link, readOnly: true, className: 'grow' }),
        knopf('Kopieren', () => kopieren(link))),
      h('div', { className: 'row' },
        knopf('Neuen Link', async () => { if (await bestaetigen('Neuen Link erzeugen? Der alte geht dann nicht mehr.')) await tu(() => api('POST', `/api/umfragen/${u.id}/gastlink`, { erneuern: true }), 'Neuer Link.')(); }),
        knopf('Gast-Link aus', tu(() => api('DELETE', `/api/umfragen/${u.id}/gastlink`), 'Gäste können nicht mehr teilnehmen.'))))
        : knopf('Link für Gäste erzeugen', tu(() => api('POST', `/api/umfragen/${u.id}/gastlink`), 'Link erzeugt.'))),
    h('div', { className: 'card' }, h('h3', { textContent: 'Status' }),
      h('p', { className: 'meta', textContent: `${STATUS[u.status]} · ${u.antworten} Antworten` }),
      h('div', { className: 'row' },
        u.status !== 'open' ? knopf(u.status === 'draft' ? 'Öffnen' : 'Wieder öffnen', tu(() => api('POST', `/api/umfragen/${u.id}/oeffnen`), 'Offen.'), 'tiny primary')
          : knopf('Beenden', tu(() => api('POST', `/api/umfragen/${u.id}/schliessen`), 'Beendet.')),
        knopf('Duplizieren', async () => { try { const k = await api('POST', `/api/umfragen/${u.id}/duplizieren`); offen = k.id; ansicht = 'aufbau'; await neu(); } catch (err) { oops(err); } }),
        knopf('Antworten zurücksetzen', async () => { if (await bestaetigen(`Alle ${u.antworten} Antworten löschen?`)) await tu(() => api('POST', `/api/umfragen/${u.id}/zuruecksetzen`), 'Zurückgesetzt.')(); }),
        knopf('Löschen', async () => { if (await bestaetigen(`„${u.titel}" mit allen Antworten löschen?`)) { try { await api('DELETE', `/api/umfragen/${u.id}`); offen = null; await neu(); } catch (err) { oops(err); } } }))));
}

// --- Antworten (Besitzer) -------------------------------------------------------------------

async function antwortenListe(ziel, u, neu) {
  const e = await api('GET', `/api/umfragen/${u.id}/ergebnis`);
  // Die Datei kommt vom Server (Content-Disposition) - ein blob:-Link laedt in der Android-App nichts.
  setzeKinder(ziel,
    h('div', { className: 'row' }, h('span', { className: 'grow meta', textContent: `${e.antworten.length} Antworten` }),
      h('a', { className: 'knopf tiny', href: `/api/umfragen/${u.id}/csv`, download: `umfrage-${u.id}.csv`, textContent: 'CSV herunterladen' })),
    e.mit_namen ? null : h('p', { className: 'muted small', textContent: 'Anonym: ohne Uhrzeit und in zufälliger Reihenfolge – sonst ließe sich zuordnen, wer was geantwortet hat.' }),
    ...e.antworten.map(a => h('details', { className: 'card antwort' },
      h('summary', { textContent: [a.public_id, a.name, a.zeit ? zeit(a.zeit) : null].filter(Boolean).join(' · ') }),
      h('dl', {}, ...u.fragen.flatMap(f => [h('dt', { textContent: f.text }), h('dd', { textContent: antwortText(f, a.antworten[f.id]) || '—' })])),
      knopf('Diese Antwort löschen', async () => { if (await bestaetigen('Antwort löschen?')) { try { await api('DELETE', `/api/umfragen/${u.id}/antworten/${encodeURIComponent(a.public_id)}`); await neu(); } catch (err) { oops(err); } } }))));
}

// --- Auswertung --------------------------------------------------------------------------------

let auswertReiter = 'uebersicht';

async function auswertung(ziel, u) {
  const e = await api('GET', `/api/umfragen/${u.id}/ergebnis`);
  const antworten = e.antworten;
  const inhalt = h('div', { className: 'stack' });
  const male = () => {
    if (!antworten.length) return setzeKinder(inhalt, h('p', { className: 'meta', textContent: 'Noch keine Antworten.' }));
    if (auswertReiter === 'uebersicht') return setzeKinder(inhalt, ...u.fragen.map(f => diagrammKarte(f, antworten)));
    if (auswertReiter === 'zusammenhaenge') return zusammenhaenge(inhalt, u, antworten);
    return personengruppen(inhalt, u, antworten);
  };
  setzeKinder(ziel,
    h('div', { className: 'row' }, h('div', { className: 'reiter klein' }, ...[['uebersicht', 'Übersicht'], ['zusammenhaenge', 'Zusammenhänge'], ['gruppen', 'Personengruppen']]
      .map(([k, t]) => h('button', { type: 'button', textContent: t, className: k === auswertReiter ? 'active' : '',
        onclick: () => { auswertReiter = k; auswertung(ziel, u).catch(oops); } }))),
    h('span', { className: 'grow meta', textContent: `${antworten.length} Antworten` })),
    inhalt);
  male();
}

// Diagramme als SVG-Text - ohne Bibliothek. Werte sind Zaehlungen; Beschriftungen maskiert.
// Balken als HTML statt SVG: die Schrift waechst mit dem Geraet (im SVG schrumpfte sie am Handy auf
// 8 px), und Text und Farben folgen dem Theme. Breite und Farbe per CSSOM - das erlaubt die CSP.
function balken(zeilen, { einheit = '' } = {}) {
  const max = Math.max(1, ...zeilen.map(z => z.wert));
  return h('div', { className: 'balken-liste' }, ...zeilen.map((z, i) => {
    const bar = h('span', { className: 'balken-bar' });
    bar.style.width = `${Math.max(0, z.wert) / max * 100}%`;
    bar.style.background = FARBEN[i % FARBEN.length];
    return h('div', { className: 'balken-zeile' },
      h('span', { className: 'balken-label', textContent: z.label, title: z.label }),
      h('span', { className: 'balken-spur' }, bar),
      h('span', { className: 'balken-wert', textContent: `${z.text ?? z.wert}${einheit}` }));
  }));
}

function torte(zeilen) {
  const summe = zeilen.reduce((s, z) => s + z.wert, 0) || 1;
  let winkel = -Math.PI / 2;
  const stuecke = zeilen.map((z, i) => {
    const w = z.wert / summe * Math.PI * 2;
    if (!z.wert) return '';
    const x1 = 60 + 55 * Math.cos(winkel), y1 = 60 + 55 * Math.sin(winkel);
    winkel += w;
    const x2 = 60 + 55 * Math.cos(winkel), y2 = 60 + 55 * Math.sin(winkel);
    return w >= Math.PI * 2 - 1e-6 ? `<circle cx="60" cy="60" r="55" fill="${FARBEN[i % FARBEN.length]}"/>`
      : `<path d="M60,60 L${x1},${y1} A55,55 0 ${w > Math.PI ? 1 : 0},1 ${x2},${y2} Z" fill="${FARBEN[i % FARBEN.length]}"/>`;
  }).join('');
  // Die Legende als HTML daneben - am Handy darunter (CSS .torte).
  const legende = h('ul', { className: 'legende' }, ...zeilen.map((z, i) => {
    const punkt = h('span', { className: 'legende-punkt' });
    punkt.style.background = FARBEN[i % FARBEN.length];
    return h('li', {}, punkt, h('span', { textContent: `${z.label} – ${z.wert} (${Math.round(z.wert / summe * 100)} %)` }));
  }));
  return h('div', { className: 'torte' },
    svgEl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" class="torte-svg">${stuecke}</svg>`), legende);
}

function streuung(punkte, c) {
  const kreise = punkte.map(p => `<circle cx="${p.x * 20 + 10}" cy="${p.y * 20 + 10}" r="4" fill="#3b6fd4" fill-opacity=".55"/>`).join('');
  return svgEl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" class="diagramm quadrat">
    <rect x="10" y="10" width="200" height="200" fill="#f4f6fa" stroke="#ccd3de"/><line x1="110" y1="10" x2="110" y2="210" stroke="#dde2ea"/><line x1="10" y1="110" x2="210" y2="110" stroke="#dde2ea"/>
    <text x="12" y="108" font-size="9" fill="#6a7382">${esc(c.x_left)}</text><text x="208" y="108" font-size="9" text-anchor="end" fill="#6a7382">${esc(c.x_right)}</text>
    <text x="110" y="20" font-size="9" text-anchor="middle" fill="#6a7382">${esc(c.y_top)}</text><text x="110" y="206" font-size="9" text-anchor="middle" fill="#6a7382">${esc(c.y_bottom)}</text>${kreise}</svg>`);
}

function diagrammKarte(f, antworten) {
  const c = f.config ?? {};
  const werte = antworten.map(a => a.antworten[f.id]).filter(v => v != null);
  const kopf = h('p', { className: 'frage-text' }, f.text, h('small', { className: 'muted', textContent: ` · ${werte.length} Antworten` }));
  let inhalt;
  if (f.typ === 'single') inhalt = torte(c.options.map(o => ({ label: o.label, wert: werte.filter(v => v === o.id).length })));
  else if (f.typ === 'multi') inhalt = balken(c.options.map(o => ({ label: o.label, wert: werte.filter(v => v.includes(o.id)).length })));
  else if (f.typ === 'points') inhalt = balken(c.options.map(o => {
    const s = werte.reduce((x, v) => x + (v[o.id] ?? 0), 0);
    return { label: o.label, wert: s, text: (s / Math.max(1, werte.length)).toFixed(1) + ' Ø' };
  }));
  else if (f.typ === 'slider') {
    // Verteilung: je Wert ein Balken, bei grossen Spannen in hoechstens 12 Stufen.
    const stufen = Math.min(12, c.max - c.min + 1), breite = (c.max - c.min + 1) / stufen;
    const zeilen = Array.from({ length: stufen }, (_, i) => {
      const von = Math.round(c.min + i * breite), bis = Math.round(c.min + (i + 1) * breite) - 1;
      return { label: von === bis ? String(von) : `${von}–${bis}`, wert: werte.filter(v => v >= von && v <= bis).length };
    });
    const mittel = werte.reduce((s, v) => s + v, 0) / Math.max(1, werte.length);
    inhalt = h('div', { className: 'stack' }, h('small', { className: 'muted', textContent: `Durchschnitt ${mittel.toFixed(1)} (${c.min_label || c.min} … ${c.max_label || c.max})` }), balken(zeilen));
  } else if (f.typ === 'slider_multi') inhalt = balken(c.items.map(it => {
    const w = werte.map(v => v?.[it.id]).filter(x => x != null);
    if (!w.length) return { label: it.label, wert: 0, text: '–' };
    const m = w.reduce((s, x) => s + x, 0) / w.length;
    return { label: it.label, wert: Math.max(0, m - c.min), text: m.toFixed(1) };
  }));
  else if (f.typ === 'slider2d') inhalt = streuung(werte, c);
  else inhalt = h('ul', { className: 'list zitate' }, ...werte.slice(-30).reverse().map(t => h('li', {}, h('span', { className: 'grow fliesstext', textContent: `„${t}"` }))),
    werte.length > 30 ? h('li', {}, h('span', { className: 'muted', textContent: `… und ${werte.length - 30} weitere (alle im CSV)` })) : null);
  return h('div', { className: 'card' }, kopf, inhalt);
}

function zusammenhaenge(ziel, u, antworten) {
  const single = u.fragen.filter(f => f.typ === 'single');
  if (single.length < 2) return setzeKinder(ziel, h('p', { className: 'meta', textContent: 'Für Zusammenhänge braucht es mindestens zwei Einfachauswahl-Fragen.' }));
  const wahl = (i) => h('select', {}, ...single.map((f, j) => h('option', { value: String(j), textContent: f.text, selected: i === j })));
  const a = wahl(0), b = wahl(1);
  const tabelle = h('div', { className: 'kreuz' });
  const gruppeFrage = wahl(0), gruppeOpt = h('select', {});
  const vergleich = h('div', { className: 'stack' });
  const mal = () => {
    const k = kreuztabelle(antworten, single[Number(a.value)], single[Number(b.value)]);
    const max = Math.max(1, ...k.zellen.flat());
    const kopf = h('tr', {}, h('th', {}), ...k.spalten.map(s => h('th', { textContent: s.label })));
    setzeKinder(tabelle, h('table', { className: 'kreuztabelle' }, h('thead', {}, kopf),
      h('tbody', {}, ...k.zeilen.map((z, i) => h('tr', {}, h('th', { textContent: z.label }), ...k.zellen[i].map((n, j) => {
        const td = h('td', { textContent: String(n) });
        td.style.background = `rgba(59, 111, 212, ${(n / max * 0.7).toFixed(2)})`;
        // Diagonale hervorheben, wenn beide Fragen dieselben Antworten haben.
        if (k.zeilen[i].label === k.spalten[j]?.label) td.classList.add('diagonal');
        return td;
      }))))));
    // Untergruppe: wer bei Frage X "Y" gesagt hat - im Vergleich zu allen, bei jeder anderen Einfachauswahl.
    const gf = single[Number(gruppeFrage.value)];
    if (gruppeOpt.dataset.frage !== gruppeFrage.value) {
      setzeKinder(gruppeOpt, ...gf.config.options.map(o => h('option', { value: o.id, textContent: o.label })));
      gruppeOpt.dataset.frage = gruppeFrage.value;
    }
    const gruppe = antworten.filter(x => x.antworten[gf.id] === gruppeOpt.value);
    setzeKinder(vergleich, h('small', { className: 'muted', textContent: `${gruppe.length} von ${antworten.length} Antworten in der Gruppe` }),
      ...single.filter(f => f !== gf).map(f => h('div', { className: 'card' }, h('p', { className: 'frage-text', textContent: f.text }),
        balken(f.config.options.flatMap(o => {
          const anteil = liste => Math.round(liste.filter(x => x.antworten[f.id] === o.id).length / Math.max(1, liste.length) * 100);
          return [{ label: `${o.label} – Gruppe`, wert: anteil(gruppe), text: `${anteil(gruppe)} %` }, { label: `${o.label} – alle`, wert: anteil(antworten), text: `${anteil(antworten)} %` }];
        })))));
  };
  a.onchange = b.onchange = gruppeFrage.onchange = gruppeOpt.onchange = mal;
  setzeKinder(ziel, h('div', { className: 'card' }, h('h3', { textContent: 'Kreuztabelle' }), h('div', { className: 'row' }, a, h('span', { textContent: '×' }), b), tabelle),
    h('div', { className: 'card' }, h('h3', { textContent: 'Untergruppe gegen alle' }), h('div', { className: 'row' }, gruppeFrage, h('span', { textContent: '=' }), gruppeOpt), vergleich));
  mal();
}

function radar(mitte, labels) {
  const n = mitte.length, r = 80, cx = 110, cy = 100;
  const punkt = (i, w) => [cx + Math.sin(i / n * Math.PI * 2) * r * w / 10, cy - Math.cos(i / n * Math.PI * 2) * r * w / 10];
  const netz = [2.5, 5, 7.5, 10].map(w => `<polygon points="${mitte.map((_, i) => punkt(i, w).join(',')).join(' ')}" fill="none" stroke="#dde2ea"/>`).join('');
  const achsen = mitte.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${punkt(i, 10)[0]}" y2="${punkt(i, 10)[1]}" stroke="#dde2ea"/>`
    + `<text x="${punkt(i, 12.5)[0]}" y="${punkt(i, 12.5)[1]}" font-size="9" text-anchor="middle" fill="#6a7382">${esc(labels[i].slice(0, 22))}</text>`).join('');
  const form = `<polygon points="${mitte.map((w, i) => punkt(i, w).join(',')).join(' ')}" fill="#3b6fd4" fill-opacity=".3" stroke="#3b6fd4"/>`;
  return svgEl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 210" class="diagramm quadrat">${netz}${achsen}${form}</svg>`);
}

function personengruppen(ziel, u, antworten) {
  let k = 3;
  const inhalt = h('div', { className: 'cards' });
  const mal = () => {
    const r = kmeans(antworten, u.fragen, k);
    if (r.hinweis) return setzeKinder(inhalt, h('p', { className: 'meta', textContent: r.hinweis }));
    const single = u.fragen.filter(f => f.typ === 'single');
    const texte = u.fragen.filter(f => f.typ === 'text' || f.typ === 'text_limited');
    setzeKinder(inhalt, ...r.gruppen.map((g, i) => {
      const drin = g.mitglieder.map(j => antworten[j]);
      // Typisch fuer die Gruppe: die haeufigste Antwort je Einfachauswahl, dazu ein Beispielzitat.
      const modus = single.map(f => {
        const zaehl = new Map();
        for (const a of drin) { const v = a.antworten[f.id]; if (v) zaehl.set(v, (zaehl.get(v) ?? 0) + 1); }
        const [best] = [...zaehl.entries()].sort((x, y) => y[1] - x[1]);
        return best ? `${f.text}: ${f.config.options.find(o => o.id === best[0])?.label} (${best[1]}/${drin.length})` : null;
      }).filter(Boolean);
      const zitat = texte.map(f => drin.map(a => a.antworten[f.id]).find(Boolean)).find(Boolean);
      return h('div', { className: 'card' }, h('h3', { textContent: `Gruppe ${i + 1} · ${g.mitglieder.length} ${g.mitglieder.length === 1 ? 'Person' : 'Personen'}` }),
        radar(g.mitte, r.dimensionen),
        modus.length ? h('ul', { className: 'muted small' }, ...modus.map(t => h('li', { textContent: t }))) : null,
        zitat ? h('p', { className: 'fliesstext small', textContent: `„${zitat}"` }) : null);
    }));
  };
  setzeKinder(ziel, h('div', { className: 'row' }, h('span', { className: 'meta', textContent: `Nach ${dimensionen(u.fragen).length} Regler-Werten gruppiert:` }),
    ...[3, 4, 5].map(n => knopf(`${n} Gruppen`, e => { k = n; for (const b of e.target.parentElement.querySelectorAll('button')) b.className = 'tiny ghost'; e.target.className = 'tiny primary'; mal(); }, n === 3 ? 'tiny primary' : 'tiny ghost'))),
    h('p', { className: 'muted small', textContent: 'Wer ähnlich geantwortet hat, landet in derselben Gruppe (k-means). Die Form zeigt den Durchschnitt der Gruppe je Regler, 0–10.' }),
    inhalt);
  mal();
}

// --- Gaeste: nur Ausfuellen, ohne Konto -----------------------------------------------------------

// Die Kennung des Gastes: zufaellig, nur in diesem Browser. Damit findet er seine Antwort wieder
// und kann sie aendern - der Server kennt sie nur gehasht.
function gastId() {
  let g = null;
  try { g = localStorage.getItem('gastId'); } catch { /* Privatmodus */ }
  if (!g) {
    g = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => (b % 36).toString(36)).join('');
    try { localStorage.setItem('gastId', g); } catch { /* dann eben nur fuer diesen Besuch */ }
  }
  return g;
}
async function gastApi(method, key, body) {
  const res = await fetch(`/api/gast/umfragen/${encodeURIComponent(key)}`, {
    method, headers: { 'content-type': 'application/json', 'x-gast': gastId() },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const daten = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(daten.error ?? `Fehler ${res.status}`);
  return daten;
}

/** Die Seite unter /umfrage/<key>: kein Login, kein Menue, nur die Umfrage. */
export async function gastUmfrage(key) {
  const ziel = $('#gast');
  ziel.hidden = false;
  const male = async () => {
    let u;
    try { u = await gastApi('GET', key); } catch (err) {
      return setzeKinder(ziel, h('div', { className: 'card narrow' }, h('h2', { textContent: 'Umfrage' }), h('p', { textContent: err.message })));
    }
    const kopf = h('div', { className: 'card narrow' }, h('h2', { textContent: u.titel }),
      h('p', { className: 'muted small', textContent: u.laeuft ? (u.endet_at ? `läuft bis ${zeit(u.endet_at)}` : 'Du nimmst als Gast teil – ohne Konto.') : 'Diese Umfrage ist beendet.' }));
    if (!u.laeuft) return setzeKinder(ziel, kopf);
    const name = u.identitaet === 'mit_namen' ? h('input', { maxLength: 80, placeholder: 'Dein Name (optional)' }) : null;
    setzeKinder(ziel, kopf, ausfuellen(u, {
      nameFeld: name ? h('label', { className: 'field' }, 'Name', name) : null,
      absenden: async antworten => {
        await gastApi('POST', key, { antworten, name: name?.value });
        toast(u.mehrfach ? 'Danke, gespeichert.' : 'Danke! Ändern geht mit diesem Gerät bis zum Ende.', true);
        await male();
      },
      zurueckziehen: u.meine ? async () => { await gastApi('DELETE', key); toast('Antwort zurückgezogen.', true); await male(); } : null,
    }));
  };
  await male();
}
