// --- buero ---
// Der Reiter "Buero": Notizen, Ideenbaum, Abstimmungen - und die Umfragen (umfragen.js). Alles
// wird bei jedem Oeffnen neu gezeichnet; geteilt wird mit Freunden und mit ganzen Kursen.
import {
  $, api, bestaetigen, eingabe, entwurf, entwurfWeg, h, md, nameOf, ohneMd, oops, rueckgaengig,
  scrollHinweis, setzeKinder, toast,
} from './kern.js';
import { dlg, freigabeFenster, knopf, zeit } from './freigabe.js';
import { loadUmfragen } from './umfragen.js';

const REITER_KEY = 'bueroReiter';
const REITER = [['notizen', 'Notizen'], ['ideen', 'Ideen'], ['abstimmungen', 'Abstimmungen'], ['umfragen', 'Umfragen']];
let reiter = 'notizen';
try { reiter = localStorage.getItem(REITER_KEY) || reiter; } catch { /* Privatmodus */ }

// Von aussen (eigenes Menue, Hash): den Unterreiter setzen, bevor loadBuero laeuft.
export function bueroReiterSetzen(k) {
  if (!REITER.some(([r]) => r === k)) return;
  reiter = k;
  try { localStorage.setItem(REITER_KEY, k); } catch { /* Privatmodus */ }
}

export async function loadBuero() {
  setzeKinder($('#bueroReiter'), ...REITER.map(([k, t]) => h('button', {
    type: 'button', textContent: t, className: k === reiter ? 'active' : '',
    onclick: () => { bueroReiterSetzen(k); loadBuero().catch(oops); },
  })));
  scrollHinweis($('#bueroReiter'));
  const ziel = $('#bueroInhalt');
  if (reiter !== 'notizen') notizLiveAus();
  if (reiter === 'notizen') return loadNotizen(ziel);
  if (reiter === 'ideen') return loadIdeen(ziel);
  if (reiter === 'abstimmungen') return loadAbstimmungen(ziel);
  return loadUmfragen(ziel);
}

const geteiltText = x => (x.geteilt ? `von ${nameOf(x.besitzer)}` : null);

// =============================================================================================
// Notizen
// =============================================================================================

let nz = { ordner: 'alle', tag: '', suche: '', archiv: false, offen: null };
try { Object.assign(nz, JSON.parse(localStorage.getItem('notizFilter') ?? '{}'), { offen: null }); } catch { /* egal */ }
const merkNz = () => { try { localStorage.setItem('notizFilter', JSON.stringify({ ...nz, offen: null })); } catch { /* egal */ } };

// Live: solange die Notizen offen sind, meldet der Server jede Aenderung, die man sehen darf - nur
// die ID, geholt wird wie immer. Beim Verlassen des Reiters oder der Ansicht geht die Leitung zu.
let quelle = null, beiLive = null, liveTakt = null, liveIds = new Set();
export function notizLiveAus() { quelle?.close(); quelle = null; beiLive = null; }
function notizLive(fn) {
  beiLive = fn;
  if (quelle || typeof EventSource === 'undefined') return;
  quelle = new EventSource('/api/notizen/live');
  let erstesMal = true;
  // Nach einem Abriss (Funkloch, Handy im Schlaf) fehlt, was dazwischen kam - dann einmal alles.
  quelle.onopen = () => { if (!erstesMal) liveMelden(null); erstesMal = false; };
  // Abgewiesen (abgemeldet, zu viele Verbindungen): nicht festhalten, beim naechsten Oeffnen neu.
  quelle.onerror = () => { if (quelle?.readyState === EventSource.CLOSED) quelle = null; };
  quelle.addEventListener('notizen', e => {
    let id = null;
    try { id = JSON.parse(e.data).id; } catch { /* dann eben alles */ }
    liveMelden(id);
  });
}
// Kurz sammeln: dreimal "Todo angehakt" hintereinander ist EIN Neuzeichnen.
function liveMelden(id) {
  liveIds.add(id);
  clearTimeout(liveTakt);
  liveTakt = setTimeout(() => { const ids = liveIds; liveIds = new Set(); beiLive?.(ids); }, 300);
}

async function loadNotizen(ziel) {
  const daten = await api('GET', '/api/notizen');
  if (nz.offen) return notizOeffnen(ziel, nz.offen, daten).catch(err => { nz.offen = null; oops(err); loadNotizen(ziel); });
  const eigeneOrdner = daten.ordner.filter(o => !o.geteilt);
  const tags = [...new Set(daten.notizen.flatMap(n => n.tags))].sort();

  const imOrdner = (n, oid) => {
    for (let o = daten.ordner.find(x => x.id === n.ordner_id), i = 0; o && i < 20; i++) {
      if (o.id === oid) return true;
      o = daten.ordner.find(x => x.id === o.parent_id);
    }
    return false;
  };
  const q = nz.suche.trim().toLowerCase();
  const sichtbar = daten.notizen.filter(n => n.archiviert === nz.archiv
    && (nz.ordner === 'alle' || (nz.ordner === 'geteilt' ? n.geteilt : imOrdner(n, nz.ordner)))
    && (!nz.tag || n.tags.includes(nz.tag))
    && (!q || `${n.titel} ${n.inhalt} ${n.tags.join(' ')}`.toLowerCase().includes(q)));

  const ordnerKnopf = (id, text, tiefe = 0, extra = null) => h('div', { className: 'ordner-zeile' + (nz.ordner === id ? ' aktiv' : '') },
    h('button', { type: 'button', className: 'linkknopf grow', textContent: text,
      onclick: () => { nz.ordner = id; merkNz(); loadNotizen(ziel).catch(oops); } }), extra);
  const baum = (parent, tiefe) => daten.ordner.filter(o => o.parent_id === parent || (tiefe === 0 && o.geteilt && !daten.ordner.some(p => p.id === o.parent_id)))
    .filter((o, i, a) => a.indexOf(o) === i)
    .flatMap(o => [(() => {
      const z = ordnerKnopf(o.id, `${'　'.repeat(tiefe)}📁 ${o.name}${o.geteilt ? ' 👥' : ''}`, tiefe,
        o.geteilt ? null : h('span', { className: 'mehr' },
          knopf('👥', () => freigabeFenster('notiz_ordner', o.id, `Ordner „${o.name}" teilen`, () => loadNotizen(ziel)), 'tiny ghost', { title: 'Teilen' }),
          knopf('✎', async () => {
            const name = await eingabe('Neuer Name', o.name);
            if (!name?.trim()) return;
            try { await api('PATCH', `/api/notizen-ordner/${o.id}`, { name }); await loadNotizen(ziel); } catch (err) { oops(err); }
          }, 'tiny ghost', { title: 'Umbenennen' }),
          knopf('×', async () => {
            if (!await bestaetigen(`Ordner „${o.name}" löschen? Die Notizen darin bleiben (ohne Ordner).`)) return;
            try { await api('DELETE', `/api/notizen-ordner/${o.id}`); if (nz.ordner === o.id) nz.ordner = 'alle'; await loadNotizen(ziel); } catch (err) { oops(err); }
          }, 'tiny ghost', { title: 'Löschen' })));
      return z;
    })(), ...(tiefe < 6 ? baum(o.id, tiefe + 1) : [])]);

  const suche = h('input', { type: 'search', className: 'suche', placeholder: '🔍 Notizen durchsuchen …', value: nz.suche });
  suche.oninput = () => { nz.suche = suche.value; merkNz(); malKarten(); };
  const archiv = h('input', { type: 'checkbox', checked: nz.archiv });
  archiv.onchange = () => { nz.archiv = archiv.checked; merkNz(); loadNotizen(ziel).catch(oops); };
  const karten = h('div', { className: 'notiz-karten' });
  const malKarten = () => {
    const q2 = nz.suche.trim().toLowerCase();
    const liste = sichtbar.filter(n => !q2 || `${n.titel} ${n.inhalt} ${n.tags.join(' ')}`.toLowerCase().includes(q2));
    setzeKinder(karten, ...(liste.length ? liste.map(n => {
      const k = h('button', { type: 'button', className: 'notiz-karte', onclick: () => { nz.offen = n.id; loadNotizen(ziel).catch(oops); } },
        h('strong', { textContent: (n.angeheftet ? '📌 ' : '') + (n.titel || 'Ohne Titel') }),
        // Der Auszug ohne Markdown-Zeichen - sonst stand dort "**Membran**" und "# Kopf".
        h('p', { className: 'muted small auszug', textContent: ohneMd(n.inhalt).slice(0, 180) }),
        h('small', { className: 'sub', textContent: [n.tags.map(t => '#' + t).join(' '), n.todos ? `☑ ${n.todos - n.todos_offen}/${n.todos}` : null,
          geteiltText(n), zeit(n.updated_at)].filter(Boolean).join(' · ') }));
      if (n.farbe) k.style.borderLeftColor = n.farbe;
      return k;
    }) : [h('div', { className: 'empty' }, h('p', { textContent: nz.archiv ? 'Nichts im Archiv.' : 'Keine Notizen hier.' }),
      h('p', { className: 'muted small', textContent: 'Oben rechts „+ Notiz" – mit Markdown, Todo-Liste und Kommentaren, teilbar mit Freunden und Kursen.' }))]));
  };
  malKarten();

  setzeKinder(ziel, h('div', { className: 'notiz-seite' },
    h('aside', { className: 'card notiz-leiste' },
      ordnerKnopf('alle', '🗒 Alle Notizen'),
      ordnerKnopf('geteilt', '👥 Mit mir geteilt'),
      ...baum(null, 0),
      knopf('+ Ordner', async () => {
        const name = await eingabe('Name des Ordners');
        if (!name?.trim()) return;
        const parent = typeof nz.ordner === 'number' && eigeneOrdner.some(o => o.id === nz.ordner) && await bestaetigen('Als Unterordner des gewählten Ordners?') ? nz.ordner : null;
        try { await api('POST', '/api/notizen-ordner', { name, parent_id: parent }); await loadNotizen(ziel); } catch (err) { oops(err); }
      }),
      tags.length ? h('div', { className: 'tag-wolke' }, ...tags.map(t => h('button', {
        type: 'button', className: 'tag' + (nz.tag === t ? ' aktiv' : ''), textContent: '#' + t,
        onclick: () => { nz.tag = nz.tag === t ? '' : t; merkNz(); loadNotizen(ziel).catch(oops); } }))) : null),
    h('div', { className: 'notiz-haupt' },
      h('div', { className: 'bar' }, suche, h('label', { className: 'check' }, archiv, ' Archiv'),
        h('span', { className: 'grow' }),
        knopf('+ Notiz', () => { nz.offen = 'neu'; loadNotizen(ziel).catch(oops); }, 'tiny primary')),
      karten)));

  // Live: die Liste folgt von selbst. Wer gerade sucht, behaelt den Cursor im Suchfeld.
  notizLive(() => {
    if (nz.offen) return;
    const suchte = document.activeElement === suche;
    loadNotizen(ziel).then(() => { if (suchte) ziel.querySelector('input.suche')?.focus(); }).catch(() => {});
  });
}

async function notizOeffnen(ziel, id, daten) {
  const neu = id === 'neu';
  const n = neu ? { titel: '', inhalt: '', tags: [], farbe: null, ordner_id: typeof nz.ordner === 'number' ? nz.ordner : null,
    darf_aendern: true, rolle: 'besitzer', todo_liste: [], kommentare: [] } : await api('GET', `/api/notizen/${id}`);
  const weg = () => { nz.offen = null; loadNotizen(ziel).catch(oops); };
  const besitzer = n.rolle === 'besitzer';
  const titel = h('input', { value: n.titel, maxLength: 200, placeholder: 'Titel', className: 'notiz-titel', readOnly: !n.darf_aendern });
  const inhalt = h('textarea', { value: n.inhalt, rows: 14, maxLength: 50000, placeholder: 'Text – Markdown geht: # Überschrift, **fett**, - Liste, [Link](https://…)', readOnly: !n.darf_aendern });
  if (neu) { entwurf('notiz:titel', titel); entwurf('notiz:inhalt', inhalt); }
  const tags = h('input', { value: n.tags.join(', '), placeholder: 'Tags, mit Komma', readOnly: !n.darf_aendern });
  const farbe = h('input', { type: 'color', value: n.farbe || '#ef9f27', disabled: !n.darf_aendern });
  const ordner = h('select', { disabled: !besitzer }, h('option', { value: '', textContent: '— kein Ordner —' }),
    ...daten.ordner.filter(o => !o.geteilt).map(o => h('option', { value: String(o.id), textContent: o.name, selected: o.id === n.ordner_id })));
  const vorschau = h('div', { className: 'notiz-vorschau', hidden: n.darf_aendern });
  const malVorschau = () => setzeKinder(vorschau, md(inhalt.value || '*leer*'));
  malVorschau();
  const vorschauKnopf = knopf('Vorschau', () => {
    const an = vorschau.hidden;
    malVorschau(); vorschau.hidden = !an; inhalt.hidden = an;
    vorschauKnopf.textContent = an ? 'Bearbeiten' : 'Vorschau';
  });
  if (!n.darf_aendern) inhalt.hidden = true;

  // Ungespeichertes ueberlebt das Neuzeichnen: Anheften, ein Todo oder ein Kommentar laden die
  // Notiz neu - und warfen dabei weg, was man gerade am Text geaendert hatte.
  const stand = () => ({ id: n.id, titel: titel.value, inhalt: inhalt.value, tags: tags.value, farbe: farbe.value, ordner: ordner.value });
  const ursprung = { ...stand(), farbe: n.farbe || '#ef9f27' };
  const geaendert = () => !neu && n.darf_aendern && Object.entries(stand()).some(([k, v]) => v !== ursprung[k]);
  if (!neu && nz.ungespeichert?.id === n.id) {
    const s = nz.ungespeichert;
    titel.value = s.titel; inhalt.value = s.inhalt; tags.value = s.tags; farbe.value = s.farbe; ordner.value = s.ordner;
    malVorschau();
  }
  nz.ungespeichert = null;
  const neuLaden = () => { if (geaendert()) nz.ungespeichert = stand(); return loadNotizen(ziel); };
  const zurueck = async () => {
    if (geaendert() && !(await bestaetigen('Deine Änderungen an der Notiz sind noch nicht gespeichert. Verwerfen?', { ja: 'Verwerfen', gefahr: true }))) return;
    weg();
  };

  const koerper = () => ({ titel: titel.value, inhalt: inhalt.value, tags: tags.value.split(','), farbe: farbe.value,
    ...(besitzer && { ordner_id: ordner.value ? Number(ordner.value) : null }) });
  const speichern = async () => {
    try {
      if (neu) {
        const r = await api('POST', '/api/notizen', koerper());
        entwurfWeg('notiz');
        nz.offen = r.id;
        toast('Angelegt.', true);
      } else { await api('PATCH', `/api/notizen/${n.id}`, koerper()); toast('Gespeichert.', true); }
      await loadNotizen(ziel);
    } catch (err) { oops(err); }
  };

  // Todo-Liste der Notiz
  const todoFeld = h('input', { placeholder: 'Neuer Punkt …', maxLength: 500 });
  const todos = neu ? null : h('div', { className: 'stack' },
    h('h3', { textContent: 'Todo-Liste' }),
    h('ul', { className: 'list' }, ...n.todo_liste.map(t => {
      const x = h('input', { type: 'checkbox', checked: t.done, disabled: !n.darf_aendern });
      x.onchange = async () => { try { await api('PATCH', `/api/notizen/todos/${t.id}`, { done: x.checked }); } catch (err) { oops(err); x.checked = t.done; } };
      return h('li', { className: t.done ? 'gone' : '' }, x, h('span', { className: 'grow', textContent: t.text }),
        n.darf_aendern ? knopf('×', async () => { try { await api('DELETE', `/api/notizen/todos/${t.id}`); await neuLaden(); } catch (err) { oops(err); } }) : null);
    })),
    n.darf_aendern ? h('form', { className: 'row', onsubmit: async e => {
      e.preventDefault();
      if (!todoFeld.value.trim()) return;
      try { await api('POST', `/api/notizen/${n.id}/todos`, { text: todoFeld.value }); await neuLaden(); } catch (err) { oops(err); }
    } }, todoFeld, h('button', { className: 'tiny primary', textContent: '+' })) : null);

  // Kommentare
  const kFeld = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Kommentar …' });
  if (!neu) entwurf(`notiz:kommentar:${n.id}`, kFeld);
  const kommentare = neu ? null : h('div', { className: 'stack' },
    h('h3', { textContent: 'Kommentare' }),
    ...n.kommentare.map(k => h('div', { className: 'kommentar' },
      h('p', { className: 'meta', textContent: `${k.von ? nameOf(k.von) : 'gelöscht'} · ${zeit(k.at)}` }),
      h('p', { className: 'fliesstext', textContent: k.text }),
      k.darf_loeschen ? knopf('Löschen', async () => { try { await api('DELETE', `/api/notizen/kommentare/${k.id}`); await neuLaden(); } catch (err) { oops(err); } }) : null)),
    h('div', { className: 'row' }, kFeld, knopf('Senden', async () => {
      if (!kFeld.value.trim()) return;
      try { await api('POST', `/api/notizen/${n.id}/kommentare`, { text: kFeld.value }); entwurfWeg(`notiz:kommentar:${n.id}`); await neuLaden(); } catch (err) { oops(err); }
    }, 'tiny primary')));

  const loeschen = async () => {
    try {
      await api('DELETE', `/api/notizen/${n.id}`);
      weg();
      // Rueckgaengig legt sie neu an - samt Todo-Liste; Kommentare sind dann weg.
      rueckgaengig('Notiz gelöscht.', async () => {
        const r = await api('POST', '/api/notizen', { titel: n.titel, inhalt: n.inhalt, tags: n.tags, farbe: n.farbe, ordner_id: n.ordner_id });
        for (const t of n.todo_liste) {
          const neuT = await api('POST', `/api/notizen/${r.id}/todos`, { text: t.text });
          if (t.done) await api('PATCH', `/api/notizen/todos/${neuT.id}`, { done: true });
        }
        await loadNotizen(ziel);
      });
    } catch (err) { oops(err); }
  };

  // Live: wer nur liest, sieht Aenderungen sofort. Wer gerade schreibt, wird nicht ueberfahren -
  // er bekommt diese Leiste und entscheidet selbst.
  // ponytail: beim Speichern gewinnt weiter die letzte Aenderung; eine echte Konfliktpruefung
  // (409 bei veraltetem updated_at) erst, wenn die Leiste nicht reicht.
  const liveLeiste = h('div', { className: 'live-leiste', hidden: true },
    h('span', { className: 'grow', textContent: 'Diese Notiz wurde gerade woanders geändert.' }),
    knopf('Neu laden', async () => {
      if (geaendert() && !(await bestaetigen('Deine ungespeicherten Änderungen gehen dabei verloren. Neu laden?', { ja: 'Neu laden', gefahr: true }))) return;
      loadNotizen(ziel).catch(oops);
    }, 'tiny'));
  notizLive(ids => {
    if (neu || nz.offen !== n.id || !(ids.has(n.id) || ids.has(null))) return;
    if (geaendert() || todoFeld.value.trim() || kFeld.value.trim()) { liveLeiste.hidden = false; return; }
    loadNotizen(ziel).catch(() => {});
  });

  setzeKinder(ziel, h('div', { className: 'card notiz-editor' },
    h('div', { className: 'row' }, knopf('← Zurück', zurueck), h('span', { className: 'grow' }),
      !neu && n.geteilt ? h('span', { className: 'muted small', textContent: `${geteiltText(n)} · ${n.darf_aendern ? 'darfst bearbeiten' : 'nur lesen'}` }) : null,
      !neu && besitzer ? knopf(n.angeheftet ? '📌 Lösen' : '📌 Anheften', async () => { try { await api('POST', `/api/notizen/${n.id}/anheften`); await neuLaden(); } catch (err) { oops(err); } }) : null,
      !neu && besitzer ? knopf(n.archiviert ? 'Aus dem Archiv' : 'Archivieren', async () => { try { if (geaendert()) await api('PATCH', `/api/notizen/${n.id}`, koerper()); await api('POST', `/api/notizen/${n.id}/archiv`); weg(); } catch (err) { oops(err); } }) : null,
      !neu && besitzer ? knopf('Teilen …', () => freigabeFenster('notiz', n.id, `„${n.titel || 'Notiz'}" teilen`, neuLaden)) : null,
      !neu && besitzer ? knopf('Löschen', loeschen) : null),
    liveLeiste,
    titel,
    h('div', { className: 'row' }, h('label', { className: 'check' }, farbe, ' Farbe'), tags, besitzer ? ordner : null),
    inhalt, vorschau,
    n.darf_aendern ? h('div', { className: 'row end' }, vorschauKnopf, knopf(neu ? 'Anlegen' : 'Speichern', speichern, 'primary')) : null,
    todos, kommentare));
  if (neu) titel.focus();
}

// =============================================================================================
// Ideenbaum
// =============================================================================================

let offenesBoard = null;
let gewaehlt = null;   // gewaehlter Knoten im Board
const ARTEN = { heading: ['🗂', 'Überschrift'], idea: ['💡', 'Idee'], todo: ['☑', 'Aufgabe'] };
const MODI = { open: 'offen – alles sofort drin', moderated: 'moderiert – Vorschläge warten auf das Team', strict: 'streng – alles wartet, auch vom Team' };

async function loadIdeen(ziel) {
  if (offenesBoard) return boardOeffnen(ziel, offenesBoard).catch(err => { offenesBoard = null; oops(err); loadIdeen(ziel); });
  const [boards, ablehnungen] = await Promise.all([api('GET', '/api/ideen'), api('GET', '/api/ideen-ablehnungen').catch(() => [])]);
  setzeKinder(ziel,
    h('div', { className: 'bar' }, h('strong', { className: 'grow', textContent: 'Ideenbäume' }),
      knopf('+ Ideenbaum', () => boardFenster(null, () => loadIdeen(ziel)), 'tiny primary')),
    boards.length ? h('div', { className: 'cards' }, ...boards.map(b => h('button', {
      type: 'button', className: 'card board-karte' + (b.archiviert ? ' gone' : ''),
      onclick: () => { offenesBoard = b.id; gewaehlt = null; loadIdeen(ziel).catch(oops); },
    }, h('strong', { textContent: (b.gesperrt ? '🔒 ' : '') + b.name }),
      b.beschreibung ? h('p', { className: 'muted small', textContent: ohneMd(b.beschreibung).slice(0, 140) }) : null,
      h('small', { className: 'sub', textContent: [`${b.knoten} Ideen`, b.team && b.wartend ? `${b.wartend} warten` : null,
        b.rolle === 'besitzer' ? null : `von ${nameOf(b.besitzer)} · ${b.team ? 'Team' : 'macht mit'}`, b.archiviert ? 'archiviert' : null]
        .filter(Boolean).join(' · ') }))))
      : h('div', { className: 'empty' }, h('p', { textContent: 'Noch kein Ideenbaum.' }),
        h('p', { className: 'muted small', textContent: 'Sammelt Ideen als Baum: Überschriften, Ideen, Aufgaben. Mitmachende schlagen vor, das Team gibt frei; gesperrt wird abgestimmt.' })),
    ablehnungen.length ? h('div', { className: 'card narrow' }, h('h3', { textContent: 'Deine abgelehnten Vorschläge' }),
      h('ul', { className: 'list' }, ...ablehnungen.map(a => h('li', {}, h('span', { className: 'grow' }, a.titel,
        h('small', { className: 'sub', textContent: `${a.board} · ${a.von ?? ''}: ${a.grund}` })))))) : null);
}

function boardFenster(b, danach) {
  const d = dlg();
  const name = h('input', { value: b?.name ?? '', maxLength: 120, required: true });
  const text = h('textarea', { value: b?.beschreibung ?? '', rows: 3, maxLength: 2000 });
  const modus = h('select', {}, ...Object.entries(MODI).map(([k, t]) => h('option', { value: k, textContent: t, selected: (b?.modus ?? 'moderated') === k })));
  d.replaceChildren(h('h2', { textContent: b ? 'Ideenbaum ändern' : 'Neuer Ideenbaum' }),
    h('div', { className: 'stack' }, h('label', { className: 'field' }, 'Name', name), h('label', { className: 'field' }, 'Worum geht es? (optional)', text),
      h('label', { className: 'field' }, 'Freigabe', modus)),
    h('div', { className: 'row end' }, knopf('Speichern', async () => {
      try {
        const r = b ? await api('PATCH', `/api/ideen/${b.id}`, { name: name.value, beschreibung: text.value, modus: modus.value })
          : await api('POST', '/api/ideen', { name: name.value, beschreibung: text.value, modus: modus.value });
        d.close();
        if (!b) { offenesBoard = r.id; gewaehlt = null; }
        await danach();
      } catch (err) { oops(err); }
    }, 'primary'), knopf('Abbrechen', () => d.close(), 'ghost')));
  d.showModal();
  name.focus();
}

function knotenFenster(board, parent, danach, k = null) {
  const d = dlg();
  const titel = h('input', { value: k?.titel ?? '', maxLength: 200 });
  const text = h('textarea', { value: k?.text ?? '', rows: 5, maxLength: 5000, placeholder: 'Beschreibung (Markdown geht)' });
  if (!k) { entwurf(`idee:${board.id}:titel`, titel); entwurf(`idee:${board.id}:text`, text); }
  const art = h('select', {}, ...Object.entries(ARTEN).map(([a, [i, t]]) => h('option', { value: a, textContent: `${i} ${t}`, selected: (k?.art ?? 'idea') === a })));
  d.replaceChildren(h('h2', { textContent: k ? 'Idee ändern' : parent ? `Unter „${parent.titel}"` : 'Neue Idee' }),
    h('div', { className: 'stack' }, h('label', { className: 'field' }, 'Art', art), h('label', { className: 'field' }, 'Titel', titel), h('label', { className: 'field' }, 'Text', text)),
    // Das Team postet (ausser im strengen Modus) direkt - dann heisst der Knopf nicht "Vorschlagen".
    h('div', { className: 'row end' }, knopf(k ? 'Speichern' : board.team && board.modus !== 'strict' ? 'Hinzufügen' : 'Vorschlagen', async () => {
      try {
        if (k) await api('PATCH', `/api/ideen/knoten/${k.id}`, { titel: titel.value, text: text.value, art: art.value });
        else {
          const r = await api('POST', `/api/ideen/${board.id}/knoten`, { titel: titel.value, text: text.value, art: art.value, parent_id: parent?.id ?? null });
          entwurfWeg(`idee:${board.id}`);
          gewaehlt = r.id;
          toast(r.status === 'pending' ? 'Vorgeschlagen – das Team schaut drüber.' : 'Hinzugefügt.', true);
        }
        d.close();
        await danach();
      } catch (err) { oops(err); }
    }, 'primary'), knopf('Abbrechen', () => d.close(), 'ghost')));
  d.showModal();
  titel.focus();
}

async function boardOeffnen(ziel, id) {
  const b = await api('GET', `/api/ideen/${id}`);
  const neu = () => loadIdeen(ziel).catch(oops);
  const kinder = new Map();
  for (const k of b.knoten) (kinder.get(k.parent_id) ?? kinder.set(k.parent_id, []).get(k.parent_id)).push(k);
  const zuKey = `ideenZu:${b.id}`;
  let zu = new Set();
  try { zu = new Set(JSON.parse(localStorage.getItem(zuKey) ?? '[]')); } catch { /* egal */ }
  const baumBox = h('div', { className: 'ideen-baum' });

  const karte = k => {
    const [icon] = ARTEN[k.art] ?? ARTEN.idea;
    const kids = kinder.get(k.id) ?? [];
    const klapp = kids.length ? h('button', { type: 'button', className: 'klapp', textContent: zu.has(k.id) ? '▸' : '▾', title: 'Ein-/Ausklappen',
      onclick: e => { e.stopPropagation(); zu.has(k.id) ? zu.delete(k.id) : zu.add(k.id); try { localStorage.setItem(zuKey, JSON.stringify([...zu])); } catch { /* egal */ } neu(); } }) : h('span', { className: 'klapp' });
    const el = h('div', { className: ['idee-karte', k.status === 'pending' && 'wartet', k.id === gewaehlt && 'gewaehlt', k.done && 'gone', k.art].filter(Boolean).join(' '),
      onclick: () => { gewaehlt = k.id; neu(); } },
      klapp, h('span', { className: 'grow', textContent: `${icon} ${k.titel}` }),
      k.status === 'pending' ? h('span', { className: 'pille', textContent: 'wartet' }) : null,
      k.abstimmung ? h('span', { className: 'pille' + (k.abstimmung === 'open' ? ' offen' : ''), textContent: `👍 ${k.stimmen.yes} · 👎 ${k.stimmen.no}` }) : null,
      k.kommentare ? h('small', { className: 'muted', textContent: `💬 ${k.kommentare}` }) : null,
      k.gesperrt ? h('small', { textContent: '🔒' }) : null);
    el.id = `idee-${k.id}`;
    return h('li', {}, el, kids.length && !zu.has(k.id) ? h('ul', {}, ...kids.map(karte)) : null);
  };
  const wurzeln = kinder.get(null) ?? [];
  setzeKinder(baumBox, wurzeln.length ? h('ul', { className: 'baum-wurzel' }, ...wurzeln.map(karte))
    : h('p', { className: 'meta', textContent: 'Noch leer – oben „+ Idee".' }));

  const wartend = b.knoten.filter(k => k.status === 'pending');
  const kopf = h('div', { className: 'bar' },
    knopf('← Alle', () => { offenesBoard = null; neu(); }),
    h('strong', { className: 'grow', textContent: (b.gesperrt ? '🔒 ' : '') + b.name }),
    !b.gesperrt || b.team ? knopf('+ Idee', () => knotenFenster(b, null, neu), 'tiny primary') : null,
    b.team ? knopf(b.gesperrt ? 'Entsperren' : 'Sperren & abstimmen', async () => {
      if (!b.gesperrt && !await bestaetigen('Ideenbaum sperren? Dann wird über alle freigegebenen Ideen abgestimmt, Neues geht nur noch vom Team.')) return;
      try { await api('POST', `/api/ideen/${b.id}/sperren`, { an: !b.gesperrt }); await neu(); } catch (err) { oops(err); }
    }) : null,
    b.rolle === 'besitzer' ? knopf('Teilen …', () => freigabeFenster('idee', b.id, `„${b.name}" teilen`, neu)) : null,
    b.rolle === 'besitzer' ? knopf('Ändern', () => boardFenster(b, neu)) : null,
    b.rolle === 'besitzer' ? knopf(b.archiviert ? 'Zurückholen' : 'Archivieren', async () => {
      try { await api('PATCH', `/api/ideen/${b.id}`, { archiviert: !b.archiviert }); await neu(); } catch (err) { oops(err); }
    }) : null,
    b.rolle === 'besitzer' ? knopf('Löschen', async () => {
      if (!await bestaetigen(`„${b.name}" mit allen Ideen löschen?`)) return;
      try { await api('DELETE', `/api/ideen/${b.id}`); offenesBoard = null; await neu(); } catch (err) { oops(err); }
    }) : null);

  const detail = h('aside', { className: 'card ideen-detail' });
  const k = b.knoten.find(x => x.id === gewaehlt);
  if (k) await knotenDetail(detail, b, k, neu);
  else setzeKinder(detail, h('p', { className: 'meta', textContent: 'Eine Idee anklicken, um sie zu sehen, zu kommentieren und abzustimmen.' }),
    b.beschreibung ? md(b.beschreibung) : null, h('p', { className: 'muted small', textContent: `Freigabe: ${MODI[b.modus]}` }));

  setzeKinder(ziel, kopf,
    b.team && wartend.length ? h('div', { className: 'card warteschlange' }, h('h3', { textContent: `Warteschlange (${wartend.length})` }),
      h('ul', { className: 'list' }, ...wartend.map(w => h('li', { className: 'klick', onclick: () => { gewaehlt = w.id; neu(); } },
        h('span', { className: 'grow', textContent: w.titel }), h('small', { className: 'muted', textContent: w.von ? nameOf(w.von) : '' }))))) : null,
    h('div', { className: 'ideen-seite' }, h('div', { className: 'card ideen-flaeche' }, baumBox), detail));

  // Querverbindungen als Linien ueber dem Baum - gemessen an den tatsaechlichen Kartenpositionen.
  if (b.kanten.length) {
    const linien = () => {
      baumBox.querySelector('svg.kanten')?.remove();
      const r = baumBox.getBoundingClientRect();
      const teile = b.kanten.map(e => {
        const a = $(`#idee-${e.von}`)?.getBoundingClientRect(), c = $(`#idee-${e.nach}`)?.getBoundingClientRect();
        if (!a || !c || !a.width || !c.width) return '';
        const x1 = a.right - r.left + baumBox.scrollLeft, y1 = a.top + a.height / 2 - r.top + baumBox.scrollTop;
        const x2 = c.right - r.left + baumBox.scrollLeft, y2 = c.top + c.height / 2 - r.top + baumBox.scrollTop;
        const bogen = Math.max(30, Math.abs(y2 - y1) / 3);
        return `<path d="M${x1},${y1} C${x1 + bogen},${y1} ${x2 + bogen},${y2} ${x2},${y2}" fill="none" stroke="#e67e22" stroke-width="2" stroke-dasharray="5 4"/>`;
      }).join('');
      const svg = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" class="kanten" width="${baumBox.scrollWidth}" height="${baumBox.scrollHeight}">${teile}</svg>`, 'image/svg+xml').documentElement;
      baumBox.append(document.importNode(svg, true));
    };
    requestAnimationFrame(linien);
    new ResizeObserver(() => requestAnimationFrame(linien)).observe(baumBox);
  }
}

async function knotenDetail(box, b, k, neu) {
  const [kommentare, versionen] = await Promise.all([
    api('GET', `/api/ideen/knoten/${k.id}/kommentare`).catch(() => []),
    b.team || k.eigen ? api('GET', `/api/ideen/knoten/${k.id}/versionen`).catch(() => []) : []]);
  const darfAendern = (b.team || k.eigen) && (!k.gesperrt || b.team);
  const tu = (f, ok) => async () => { try { await f(); if (ok) toast(ok, true); await neu(); } catch (err) { oops(err); } };
  const post = (weg, body) => api('POST', `/api/ideen/knoten/${k.id}/${weg}`, body);
  const regel = { null: 'erbt', 1: 'Freigabe immer', 0: 'Freigabe nie' };

  const stimmen = k.abstimmung ? h('div', { className: 'stack' },
    h('h3', { textContent: k.abstimmung === 'open' ? 'Abstimmung läuft' : 'Abstimmung beendet' }),
    h('div', { className: 'row' }, ...[['yes', '👍 Ja'], ['no', '👎 Nein'], ['abstain', '😐 Enthaltung']].map(([w, t]) =>
      h('button', { type: 'button', className: 'tiny ' + (k.meine_stimme === w ? 'primary' : 'ghost'), disabled: k.abstimmung !== 'open',
        textContent: `${t} · ${k.stimmen[w]}`, onclick: tu(() => post('stimme', { wahl: k.meine_stimme === w ? null : w })) })))) : null;

  const kFeld = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Kommentar …' });
  let antwortAuf = null;
  const wurzel = kommentare.filter(c => !c.parent_id);
  const kommentarEl = c => h('div', { className: 'kommentar' + (c.parent_id ? ' antwort' : '') },
    h('p', { className: 'meta', textContent: `${c.von ? nameOf(c.von) : 'gelöscht'} · ${zeit(c.at)}` }),
    h('p', { className: 'fliesstext', textContent: c.text }),
    h('div', { className: 'row' },
      !c.parent_id ? knopf('Antworten', () => { antwortAuf = c.id; kFeld.placeholder = `Antwort an ${c.von ? nameOf(c.von) : '…'}`; kFeld.focus(); }) : null,
      c.darf_loeschen ? knopf('Löschen', tu(() => api('DELETE', `/api/ideen/kommentare/${c.id}`))) : null));

  const andere = b.knoten.filter(x => x.id !== k.id && x.status === 'approved');
  const verbZiel = h('select', {}, h('option', { value: '', textContent: 'verbinden mit …' }), ...andere.map(x => h('option', { value: String(x.id), textContent: x.titel })));
  const verbLabel = h('input', { placeholder: 'Beschriftung (optional)', maxLength: 60 });
  const verbunden = b.kanten.filter(e => e.von === k.id || e.nach === k.id);

  setzeKinder(box,
    h('div', { className: 'row' }, h('strong', { className: 'grow', textContent: `${ARTEN[k.art]?.[0] ?? ''} ${k.titel}` }),
      k.art === 'todo' && darfAendern ? h('label', { className: 'check' }, (() => {
        const x = h('input', { type: 'checkbox', checked: k.done });
        x.onchange = tu(() => api('PATCH', `/api/ideen/knoten/${k.id}`, { done: x.checked }));
        return x;
      })(), ' erledigt') : null),
    h('p', { className: 'meta', textContent: [k.von ? `von ${nameOf(k.von)}` : null, k.status === 'pending' ? 'wartet auf Freigabe' : null, k.gesperrt ? 'gesperrt' : null].filter(Boolean).join(' · ') }),
    k.text ? md(k.text) : null,
    k.status === 'pending' && b.team ? h('div', { className: 'row' },
      knopf('Freigeben', tu(() => post('freigeben'), 'Freigegeben.'), 'tiny primary'),
      knopf('Ablehnen …', async () => {
        const grund = await eingabe('Warum abgelehnt? (Pflicht – die Begründung sieht, wer es vorgeschlagen hat)');
        if (!grund?.trim()) return;
        await tu(() => post('ablehnen', { grund }), 'Abgelehnt.')();
        gewaehlt = null;
      })) : null,
    h('div', { className: 'row' },
      k.status === 'approved' && (!b.gesperrt || b.team) && !k.gesperrt ? knopf('+ darunter', () => knotenFenster(b, k, neu)) : null,
      darfAendern ? knopf('Ändern', () => knotenFenster(b, null, neu, k)) : null,
      b.team || k.eigen ? knopf('Löschen', async () => {
        if (!await bestaetigen(`„${k.titel}" mit allem darunter löschen?`)) return;
        await tu(() => api('DELETE', `/api/ideen/knoten/${k.id}`))(); gewaehlt = null;
      }) : null),
    b.team ? h('details', {}, h('summary', { textContent: 'Team: Regeln für diesen Ast' }), h('div', { className: 'row' },
      knopf(`Vorschläge darunter: ${regel[k.braucht_freigabe]}`, tu(() => api('PATCH', `/api/ideen/knoten/${k.id}`,
        { braucht_freigabe: k.braucht_freigabe == null ? true : k.braucht_freigabe ? false : null }))),
      knopf(k.gesperrt ? '🔓 Entsperren' : '🔒 Sperren', tu(() => api('PATCH', `/api/ideen/knoten/${k.id}`, { gesperrt: !k.gesperrt }))),
      knopf(k.ausgenommen ? 'Wieder abstimmen lassen' : 'Von Abstimmung ausnehmen', tu(() => api('PATCH', `/api/ideen/knoten/${k.id}`, { ausgenommen: !k.ausgenommen }))),
      k.status === 'approved' ? knopf(k.abstimmung === 'open' ? 'Abstimmung schließen' : 'Abstimmung öffnen', tu(() => post('abstimmung', { offen: k.abstimmung !== 'open' }))) : null)) : null,
    stimmen,
    h('h3', { textContent: 'Verbindungen' }),
    verbunden.length ? h('ul', { className: 'list' }, ...verbunden.map(e => {
      const anderer = b.knoten.find(x => x.id === (e.von === k.id ? e.nach : e.von));
      return h('li', {}, h('button', { type: 'button', className: 'linkknopf grow', textContent: `${e.von === k.id ? '→' : '←'} ${anderer?.titel ?? '?'}${e.label ? ` (${e.label})` : ''}`,
        onclick: () => { gewaehlt = anderer?.id ?? null; neu(); } }),
        b.team || k.eigen ? knopf('×', tu(() => api('DELETE', `/api/ideen/kanten/${e.id}`))) : null);
    })) : h('p', { className: 'meta', textContent: 'Keine.' }),
    (b.team || k.eigen) && !b.gesperrt && andere.length ? h('div', { className: 'row' }, verbZiel, verbLabel,
      knopf('Verbinden', async () => {
        if (!verbZiel.value) return;
        await tu(() => api('POST', `/api/ideen/${b.id}/kanten`, { von: k.id, nach: Number(verbZiel.value), label: verbLabel.value }))();
      })) : null,
    h('h3', { textContent: `Kommentare (${kommentare.length})` }),
    ...wurzel.flatMap(c => [kommentarEl(c), ...kommentare.filter(x => x.parent_id === c.id).map(kommentarEl)]),
    !k.gesperrt || b.team ? h('div', { className: 'row' }, kFeld, knopf('Senden', async () => {
      if (!kFeld.value.trim()) return;
      await tu(() => post('kommentare', { text: kFeld.value, parent_id: antwortAuf }))();
    }, 'tiny primary')) : null,
    versionen.length ? h('details', {}, h('summary', { textContent: `Frühere Fassungen (${versionen.length})` }),
      h('ul', { className: 'list' }, ...versionen.map(v => h('li', {}, h('span', { className: 'grow' }, v.titel,
        h('small', { className: 'sub', textContent: `${v.von_name ?? ''} · ${zeit(v.at)}` })),
        darfAendern ? knopf('Zurückholen', tu(() => api('POST', `/api/ideen/versionen/${v.id}/zurueck`), 'Zurückgeholt.')) : null)))) : null);
}

// =============================================================================================
// Abstimmungen
// =============================================================================================

let abFilter = 'laufend';
const ANONYM = { oeffentlich: 'mit Namen', anonym: 'anonym', selbst: 'jeder entscheidet selbst' };

async function loadAbstimmungen(ziel) {
  const alle = await api('GET', '/api/abstimmungen');
  const liste = alle.filter(a => abFilter === 'meine' ? a.rolle === 'besitzer' : abFilter === 'archiv' ? !a.laeuft : a.laeuft);
  const neu = () => loadAbstimmungen(ziel).catch(oops);
  setzeKinder(ziel,
    h('div', { className: 'bar' },
      h('div', { className: 'reiter klein' }, ...[['laufend', 'Laufend'], ['archiv', 'Archiv'], ['meine', 'Meine']].map(([k, t]) =>
        h('button', { type: 'button', textContent: t, className: k === abFilter ? 'active' : '', onclick: () => { abFilter = k; neu(); } }))),
      h('span', { className: 'grow' }),
      knopf('+ Abstimmung', () => abstimmungFenster(null, neu), 'tiny primary')),
    liste.length ? h('div', { className: 'cards' }, ...liste.map(a => abstimmungKarte(a, neu)))
      : h('div', { className: 'empty' }, h('p', { textContent: abFilter === 'archiv' ? 'Noch nichts beendet.' : 'Keine Abstimmung.' }),
        h('p', { className: 'muted small', textContent: 'Eine Frage, ein paar Antworten – für Freunde oder einen ganzen Kurs.' })));
}

function abstimmungKarte(a, neu) {
  const besitzer = a.rolle === 'besitzer';
  const typ = a.mehrfach ? 'checkbox' : 'radio';
  const name = `ab-${a.id}`;
  const haken = a.optionen.map(o => ({ o, x: h('input', { type: typ, name, value: String(o.id), checked: a.meine_wahl.includes(o.id), disabled: !a.laeuft }) }));
  const nameZeigen = h('input', { type: 'checkbox', checked: a.mein_name_zeigen });
  const tu = (f, ok) => async () => { try { await f(); if (ok) toast(ok, true); await neu(); } catch (err) { oops(err); } };
  const ende = a.endet_at ? (a.laeuft ? `läuft bis ${zeit(a.endet_at)}` : `beendet ${zeit(a.endet_at)}`) : 'ohne Ende';
  const erg = a.ergebnis;
  const max = erg ? Math.max(1, ...erg.optionen.map(o => o.anzahl)) : 1;
  return h('div', { className: 'card abstimmung' },
    h('strong', { textContent: a.titel }),
    h('p', { className: 'meta', textContent: [besitzer ? 'von dir' : `von ${nameOf(a.besitzer)}`, ende, a.schliessen_angefragt ? 'wird geschlossen' : null,
      ANONYM[a.anonym], a.mehrfach ? (a.max_wahl ? `bis zu ${a.max_wahl} Antworten` : 'mehrere Antworten') : null].filter(Boolean).join(' · ') }),
    a.beschreibung ? md(a.beschreibung) : null,
    a.laeuft ? h('div', { className: 'stack' },
      ...haken.map(({ o, x }) => h('label', { className: 'check' }, x, ' ' + o.text)),
      a.anonym === 'selbst' ? h('label', { className: 'check muted small' }, nameZeigen, ' meinen Namen zeigen') : null,
      h('div', { className: 'row' },
        knopf(a.meine_wahl.length ? 'Stimme ändern' : 'Abstimmen', tu(async () => {
          const wahl = haken.filter(z => z.x.checked).map(z => z.o.id);
          if (!wahl.length) throw new Error('Erst etwas auswählen');
          await api('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: wahl, name_zeigen: nameZeigen.checked });
        }, 'Abgestimmt.'), 'tiny primary'),
        a.meine_wahl.length ? knopf('Stimme zurückziehen', tu(() => api('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [] }), 'Zurückgezogen.')) : null)) : null,
    erg ? h('div', { className: 'stack' }, h('small', { className: 'muted', textContent: `${erg.stimmen} ${erg.stimmen === 1 ? 'Person hat' : 'Personen haben'} abgestimmt` }),
      ...erg.optionen.map(o => {
        const balken = h('span', { className: 'balken' });
        balken.style.width = `${Math.round(o.anzahl / max * 100)}%`;
        return h('div', { className: 'umfrage-option' + (a.meine_wahl.includes(o.id) ? ' gewaehlt' : '') }, balken,
          h('span', { className: 'grow', textContent: o.text }), h('small', { textContent: String(o.anzahl) }),
          o.namen.length ? h('small', { className: 'muted', textContent: ` ${o.namen.join(', ')}${o.ohne_namen ? ` +${o.ohne_namen}` : ''}` }) : null);
      })) : h('p', { className: 'muted small', textContent: a.ergebnis_fuer === 'ich' ? 'Das Ergebnis sieht nur, wer die Abstimmung angelegt hat.' : 'Das Ergebnis gibt es nach dem Ende.' }),
    besitzer ? h('div', { className: 'row' },
      knopf('Teilen …', () => freigabeFenster('abstimmung', a.id, `„${a.titel}" teilen`, neu)),
      knopf('Ändern', () => abstimmungFenster(a, neu)),
      a.laeuft ? knopf(a.endet_at ? 'Jetzt beenden' : 'Schließen', tu(() => api('POST', `/api/abstimmungen/${a.id}/schliessen`),
        a.endet_at ? 'Beendet.' : 'Läuft noch 24 Stunden, dann ist Schluss.'))
        : knopf('Wieder öffnen', tu(() => api('POST', `/api/abstimmungen/${a.id}/oeffnen`), 'Wieder offen.')),
      knopf('Löschen', async () => { if (await bestaetigen(`„${a.titel}" löschen?`)) await tu(() => api('DELETE', `/api/abstimmungen/${a.id}`))(); })) : null);
}

function abstimmungFenster(a, danach) {
  const d = dlg();
  const titel = h('input', { value: a?.titel ?? '', maxLength: 200 });
  const text = h('textarea', { value: a?.beschreibung ?? '', rows: 2, maxLength: 2000 });
  const optionen = h('textarea', { rows: 5, value: (a?.optionen ?? []).map(o => o.text).join('\n'), placeholder: 'Eine Antwort je Zeile (2 bis 20)' });
  if (a?.hat_stimmen) optionen.readOnly = true;
  const mehrfach = h('input', { type: 'checkbox', checked: !!a?.mehrfach });
  const maxWahl = h('input', { type: 'number', min: 0, max: 20, value: String(a?.max_wahl ?? 0), className: 'kurz' });
  const anonym = h('select', {}, ...Object.entries(ANONYM).map(([k, t]) => h('option', { value: k, textContent: t, selected: (a?.anonym ?? 'oeffentlich') === k })));
  const ende = h('select', {}, ...[['', 'offen (von Hand schließen)'], ['24', '24 Stunden'], ['72', '3 Tage'], ['168', '1 Woche'], ['datum', 'bis Datum …']]
    .map(([v, t]) => h('option', { value: v, textContent: t })));
  const datum = h('input', { type: 'datetime-local', value: (a?.endet_at ?? '').replace(' ', 'T').slice(0, 16), hidden: true });
  if (a?.endet_at) { ende.value = 'datum'; datum.hidden = false; }
  ende.onchange = () => (datum.hidden = ende.value !== 'datum');
  const live = h('input', { type: 'checkbox', checked: a ? a.ergebnis_live : true });
  const fuer = h('select', {}, h('option', { value: 'alle', textContent: 'alle, die mitstimmen' }), h('option', { value: 'ich', textContent: 'nur ich' }));
  fuer.value = a?.ergebnis_fuer ?? 'alle';
  d.replaceChildren(h('h2', { textContent: a ? 'Abstimmung ändern' : 'Neue Abstimmung' }),
    h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Frage', titel), h('label', { className: 'field' }, 'Erklärung (optional)', text),
      h('label', { className: 'field' }, a?.hat_stimmen ? 'Antworten (nach der ersten Stimme fest)' : 'Antworten', optionen),
      h('div', { className: 'row' }, h('label', { className: 'check' }, mehrfach, ' mehrere Antworten'), h('small', { textContent: 'höchstens' }), maxWahl, h('small', { className: 'muted', textContent: '(0 = beliebig)' })),
      h('label', { className: 'field' }, 'Namen', anonym),
      h('label', { className: 'field' }, 'Ende', h('div', { className: 'row' }, ende, datum)),
      h('label', { className: 'check' }, live, ' Ergebnis schon während der Abstimmung zeigen'),
      h('label', { className: 'field' }, 'Ergebnis sehen', fuer)),
    h('div', { className: 'row end' }, knopf('Speichern', async () => {
      const body = { titel: titel.value, beschreibung: text.value, mehrfach: mehrfach.checked, max_wahl: Number(maxWahl.value) || 0,
        anonym: anonym.value, ergebnis_live: live.checked, ergebnis_fuer: fuer.value,
        ...(a?.hat_stimmen ? {} : { optionen: optionen.value.split('\n').map(s => s.trim()).filter(Boolean) }),
        ...(ende.value === 'datum' ? { endet_at: datum.value } : ende.value ? { dauer_stunden: Number(ende.value) } : { endet_at: null }) };
      try {
        const r = a ? await api('PATCH', `/api/abstimmungen/${a.id}`, body) : await api('POST', '/api/abstimmungen', body);
        d.close();
        await danach();
        // Neu angelegt: gleich fragen, wer mitstimmt - ohne Freigabe sieht sie niemand ausser mir.
        if (!a) await freigabeFenster('abstimmung', r.id, `Wer stimmt ab? „${r.titel}"`, danach);
      } catch (err) { oops(err); }
    }, 'primary'), knopf('Abbrechen', () => d.close(), 'ghost')));
  d.showModal();
  titel.focus();
}
