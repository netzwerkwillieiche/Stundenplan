// --- kern ---
// Gemeinsame Grundlage: DOM-Helfer, API-Zugriff, Zustand, Datums- und
// Personen-Werkzeuge. Diese Datei importiert bewusst NICHTS aus den anderen -
// alle haengen an ihr, sie haengt an keiner. Damit kann hier kein Ring entstehen.

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];

export function h(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.flat().filter(k => k != null && k !== false));
  return n;
}

/**
 * Kinder eines vorhandenen Elements setzen - wie h(), also ohne null und false.
 *
 * replaceChildren() macht aus einem null den TEXT "null". Genau so stand im Chat neben dem Namen
 * ploetzlich "null": der Knopf "Mitglieder" gibt es nur in Gruppen, und im Einzelchat stand an
 * seiner Stelle ein null. h() filtert das weg, replaceChildren nicht - deshalb hier dasselbe.
 */
export const setzeKinder = (el, ...kids) =>
  el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Kein Server erreichbar - das muss vom "Server sagt nein" unterscheidbar sein, sonst kann
    // der Offline-Fallback nicht greifen.
    const err = new Error('Keine Verbindung');
    err.offline = true;
    throw err;
  }
  pruefeVersion(res.headers.get('x-version'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Fehler ${res.status}`);
  return data;
}

// --- Selbst aktualisieren ---------------------------------------------------
// Eine installierte App laedt sich nie von selbst neu: wer sie vor drei Wochen geoeffnet hat,
// sitzt auf dem Code von damals, waehrend der Server laengst weiter ist. Jede Antwort traegt die
// Version im Kopf; weicht sie von der ab, mit der diese Sitzung begann, wird neu geladen - sofort,
// wenn nichts verloren gehen kann, sonst ueber den Balken.
let startVersion = null;

function pruefeVersion(v) {
  if (!v) return;
  startVersion ??= v;
  if (v === startVersion) return;
  let schonNeu = false;
  try { schonNeu = sessionStorage.getItem('neuGeladen') === v; } catch { /* Privatmodus */ }
  // Ein offenes Fenster oder ein angefangener Text ueberlebt kein Neuladen - dann nur der Balken.
  // Eine angefangene Umfrage auch: Kreuze und Regler sind keine Textfelder.
  const beschaeftigt = document.querySelector('dialog[open], .umfrage-ausfuellen')
    || $$('textarea, input[name="text"]').some(e => e.value.trim());
  if (!beschaeftigt && !schonNeu) {
    // Einmal je Version: kaeme aus dem Cache trotzdem der alte Code, wuerde es sonst ewig kreisen.
    try { sessionStorage.setItem('neuGeladen', v); } catch { /* Privatmodus */ }
    return location.reload();
  }
  const b = $('#updateBalken');
  b.querySelector('span').textContent = v;
  b.hidden = false;
}

// Die Tests laden diese Datei in Node - dort gibt es kein Dokument.
if (typeof document !== 'undefined') {
  $('#updateBalken button').onclick = () => location.reload();
  // Beim Hervorholen der App sofort nachsehen, nicht erst beim naechsten Takt der Zaehler.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') api('GET', '/api/info').catch(() => {});
  });
}

// --- Meldungen ---------------------------------------------------------------
// Ein Stapel: jede Meldung ist ein eigenes Element im Behaelter #toasts, und der liegt als
// Popover im Top-Layer des Browsers, also UEBER jedem modalen Fenster (mit z-index allein lag
// die Fehlermeldung hinter dem geblurrten Hintergrund). Neue kommen oben dazu; verschwindet
// eine, klappt sie zusammen und die darueber rutschen sichtbar nach. Ein × je Meldung; Fehler
// bleiben stehen, bis man es tut (Profil: Fenster & Meldungen).
//
// Gibt die Schliess-Funktion zurueck. `aktion`/`onclick` ist der Knopf in der Meldung
// ("Rueckgaengig"); `sekunden` hebt die Mindestdauer an, damit man ihn auch erwischt.
export function toast(msg, ok = false, { aktion, onclick, sekunden = 0 } = {}) {
  const box = $('#toasts');
  let timer, weg = false;
  const zu = () => {
    if (weg) return;
    weg = true;
    clearTimeout(timer);
    // Erst die Hoehe festhalten, dann auf null: so gibt es etwas zu animieren, und die Meldungen
    // darueber rutschen nach statt zu springen.
    t.style.height = t.offsetHeight + 'px';
    requestAnimationFrame(() => t.classList.add('weg'));
    setTimeout(() => {
      t.remove();
      if (!box.children.length) { box.classList.remove('show'); try { box.hidePopover?.(); } catch { /* war nicht offen */ } }
    }, 300);
  };
  const t = h('div', { className: 'toast' + (ok ? ' ok' : '') },
    h('span', { textContent: msg }),
    aktion ? h('button', { type: 'button', className: 'aktion', textContent: aktion,
      onclick: () => { zu(); onclick?.(); } }) : null,
    h('button', { type: 'button', className: 'zu', textContent: '×', title: 'Schließen', onclick: zu }));
  box.prepend(t);
  while (box.children.length > 5) box.lastChild.remove();   // mehr liest keiner
  box.classList.add('show');
  try { box.showPopover?.(); } catch { /* schon offen */ }
  const dauer = Math.min(Math.max(Number(state.me?.toast_sekunden) || 3, 1), 30);
  const bleibt = !ok && state.me?.toast_fehler_bleibt !== false;
  if (!bleibt) timer = setTimeout(zu, Math.max(dauer, sekunden) * 1000);
  return zu;
}
export const oops = e => toast(e.message);

// Das Design ('modern' oder 'klassisch') haengt als data-design an <html>. Gemerkt im Browser, damit
// schon der Login-Bildschirm und der erste Frame stimmen - vor der Antwort von /api/me.
export function setzeDesign(d) {
  const wert = d === 'klassisch' ? 'klassisch' : 'modern';
  document.documentElement.dataset.design = wert;
  try { localStorage.setItem('design', wert); } catch { /* Privatmodus */ }
}
if (typeof document !== 'undefined') {
  try { const d = localStorage.getItem('design'); if (d) document.documentElement.dataset.design = d; } catch { /* Privatmodus */ }
}

// --- Rueckfragen und Eingaben -------------------------------------------------
// Eigene Fenster statt window.prompt/confirm: die liefern im Android-WebView (ohne onJsPrompt)
// und in manchen Browsern stillschweigend null bzw. false - "+ Umfrage" tat dort einfach nichts.
// Ein eigenes <dialog>, das auch ueber einem schon offenen Fenster aufgeht. Die Antwort haengt an
// den Knoepfen (onclick) - auf das close-Ereignis ist im Vorschau-Browser kein Verlass.
function frageFenster(bau) {
  return new Promise(fertig => {
    const d = $('#frageDlg');
    let erledigt = false;
    const ende = wert => { if (erledigt) return; erledigt = true; try { d.close(); } catch { /* war zu */ } fertig(wert); };
    // Kein Schliessen per Klick daneben (der showModal-Patch haengt sich sonst an): wer tippt,
    // soll nicht aus Versehen alles wegklicken.
    d.dataset.klick = '1';
    d.oncancel = e => { e.preventDefault(); ende(null); };
    // Das close-Ereignis kommt verspaetet. Folgt ein Fenster direkt auf das naechste (erst
    // bestaetigen, dann eingeben), traf das "zu" des ersten das zweite und schloss es sofort
    // wieder. Ist das Fenster beim Eintreffen schon wieder offen, gehoert es nicht zu uns.
    d.onclose = () => { if (!d.open) ende(null); };
    d.replaceChildren(h('button', { type: 'button', className: 'tiny ghost zu', textContent: '×', title: 'Abbrechen', onclick: () => ende(null) }),
      ...bau(ende));
    d.showModal();
    d.querySelector('input, textarea')?.focus();
    d.querySelector('input')?.select?.();
  });
}

/** Ja/Nein. Zurueck: true oder false. */
export function bestaetigen(text, { ja = 'OK', nein = 'Abbrechen', gefahr = false } = {}) {
  // Loeschen & Co.: der Knopf sagt, was passiert, und ist rot - "OK" liest man zu schnell weg.
  const verb = ja === 'OK' && /(löschen|entfernen|zurücksetzen|zurückziehen|verlassen)\?/i.exec(text)?.[1];
  if (verb) { ja = verb[0].toUpperCase() + verb.slice(1).toLowerCase(); gefahr = true; }
  return frageFenster(ende => [
    h('p', { className: 'fliesstext', textContent: text }),
    h('div', { className: 'row end' },
      h('button', { type: 'button', className: 'ghost', textContent: nein, onclick: () => ende(false) }),
      h('button', { type: 'button', className: gefahr ? 'primary gefahr' : 'primary', textContent: ja, onclick: () => ende(true) })),
  ]).then(x => x === true);
}

/** Ein Textfeld. Zurueck: der Text (getrimmt) oder null bei Abbruch. */
export function eingabe(text, vorgabe = '', { passwort = false, platzhalter = '', ok = 'OK', mehrzeilig = false } = {}) {
  return frageFenster(ende => {
    const feld = mehrzeilig ? h('textarea', { rows: 3, value: vorgabe ?? '', placeholder: platzhalter })
      : h('input', { type: passwort ? 'password' : 'text', value: vorgabe ?? '', placeholder: platzhalter, autocomplete: passwort ? 'current-password' : 'off' });
    const los = () => ende(passwort ? feld.value : feld.value.trim());
    if (!mehrzeilig) feld.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); los(); } };
    return [
      h('label', { className: 'field' }, text, feld),
      h('div', { className: 'row end' },
        h('button', { type: 'button', className: 'ghost', textContent: 'Abbrechen', onclick: () => ende(null) }),
        h('button', { type: 'button', className: 'primary', textContent: ok, onclick: los })),
    ];
  });
}

/** In die Zwischenablage - und wenn es die nicht gibt (http, manche WebViews), zum Abschreiben zeigen. */
export async function kopieren(text) {
  try {
    if (!navigator.clipboard) throw new Error('keine Zwischenablage');
    await navigator.clipboard.writeText(text);
    toast('Kopiert.', true);
  } catch {
    await frageFenster(ende => {
      const feld = h('input', { value: text, readOnly: true });
      setTimeout(() => feld.select(), 0);
      return [h('label', { className: 'field' }, 'Zum Kopieren: markieren und kopieren', feld),
        h('div', { className: 'row end' }, h('button', { type: 'button', className: 'primary', textContent: 'Fertig', onclick: () => ende(true) }))];
    });
  }
}

// --- Rueckgaengig --------------------------------------------------------------
// Kurz nach einer Aktion laesst sie sich zuruecknehmen: Knopf in der Meldung oder Strg+Z. Nur
// kurz - 30 Sekunden -, danach ist der Eintrag weg; wer eine Stunde spaeter Strg+Z drueckt,
// erwartet nicht, dass eine laengst vergessene Hausaufgabe wieder auftaucht. Die Umkehrung ist
// eine Schliessung des Aufrufers samt Neuladen - diese Datei kennt keine Ansichten.
const RUECK_MS = 30_000;
const rueckStapel = [];
export function rueckgaengig(text, mach) {
  const e = { mach, bis: Date.now() + RUECK_MS };
  rueckStapel.push(e);
  if (rueckStapel.length > 20) rueckStapel.shift();
  e.zu = toast(text, true, { aktion: 'Rückgängig', onclick: () => zurueck(e), sekunden: 6 });
}
async function zurueck(e) {
  const i = rueckStapel.indexOf(e);
  if (i < 0) return;   // schon zurueckgenommen
  rueckStapel.splice(i, 1);
  e.zu?.();   // die Meldung mit dem Knopf ist erledigt (bei Strg+Z steht sie sonst noch)
  if (e.bis < Date.now()) return toast('Dafür ist es zu spät – das ist über 30 Sekunden her.');
  try { await e.mach(); toast('Rückgängig gemacht.', true); } catch (err) { oops(err); }
}
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', ev => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'z') return;
    // Im Textfeld macht der Browser sein eigenes Undo - da mischen wir uns nicht ein.
    if (ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const jetzt = Date.now();
    while (rueckStapel.length && rueckStapel[0].bis < jetzt) rueckStapel.shift();   // die aeltesten vorn
    const e = rueckStapel.at(-1);
    if (!e) return;
    ev.preventDefault();
    zurueck(e);
  });
}

// --- Fenster -------------------------------------------------------------------
// Jedes Fenster bekommt beim Oeffnen ein × oben rechts, und ein Klick auf den Hintergrund
// schliesst es (abschaltbar im Profil). Einmal hier, statt in vierzehn Dialogen einzeln - der
// Umweg ueber showModal, weil viele Dialoge ihren Inhalt bei jedem Oeffnen neu bauen.
if (typeof HTMLDialogElement !== 'undefined') {
  const echt = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    if (!this.querySelector(':scope > .zu'))
      this.prepend(h('button', { type: 'button', className: 'tiny ghost zu', textContent: '×',
        title: 'Schließen', onclick: () => this.close() }));
    if (!this.dataset.klick) {
      this.dataset.klick = '1';
      this.addEventListener('click', e => {
        if (e.target !== this || state.me?.dialog_hintergrund === false) return;
        // Das Fenster selbst ist auch das Padding - nur ein Klick ausserhalb des Rechtecks zaehlt.
        const r = this.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.close();
      });
    }
    return echt.call(this);
  };
}

// --- Entwuerfe -----------------------------------------------------------------
// Ein halb getippter Text ueberlebt den Ansichtswechsel - fuer die Sitzung, nicht fuer immer.
// Felder, die bei jedem Laden neu gebaut werden (Tickets, Chat-Eingabe je Chat, Fenster),
// haengen sich hier ein; statische Formulare brauchen das nicht.
//
// Auch Auswahlfelder: ein Select ist nie leer und ein Kaestchen auch nicht - dort zaehlt der
// Entwurf immer; bei Textfeldern nur, wenn noch nichts drinsteht (eine Vorgabe aus dem Plan geht vor).
// `immer` erzwingt das auch bei einem vorbelegten Feld (Datum mit Vorgabe "heute").
export function entwurf(schluessel, feld, immer = false) {
  const k = 'entwurf:' + schluessel;
  const kasten = feld.type === 'checkbox';
  const lies = () => (kasten ? (feld.checked ? '1' : '') : feld.value);
  try {
    const alt = sessionStorage.getItem(k);
    if (alt !== null) {
      if (kasten) feld.checked = alt === '1';
      else if (feld.tagName === 'SELECT') { if ([...feld.options].some(o => o.value === alt)) feld.value = alt; }
      else if (immer || !feld.value) feld.value = alt;
    }
  } catch { /* Privatmodus */ }
  const merke = () => { try { lies() ? sessionStorage.setItem(k, lies()) : sessionStorage.removeItem(k); } catch { /* egal */ } };
  feld.addEventListener('input', merke);
  feld.addEventListener('change', merke);
  return feld;
}
// Loescht den Schluessel und alles darunter ('termin' raeumt auch 'termin:von' weg).
export const entwurfWeg = schluessel => {
  try {
    const k = 'entwurf:' + schluessel;
    for (const name of Object.keys(sessionStorage))
      if (name === k || name.startsWith(k + ':')) sessionStorage.removeItem(name);
  } catch { /* egal */ }
};

export const dm = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
/** "5. Stunde" oder "5.–6. Stunde" - "5.–5." liest sich wie ein Tippfehler. */
export const stunden = (von, bis) => (bis == null || Number(bis) === Number(von)
  ? `${von}. Stunde` : `${von}.–${bis}. Stunde`);
export const dmy = iso => dm(iso) + iso.slice(0, 4);
export const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/**
 * Das heutige Datum in der Zeitzone des Nutzers.
 *
 * `toISOString()` rechnet nach UTC - oestlich von Greenwich ist das zwischen Mitternacht und
 * ein, zwei Uhr noch der Vortag. Der Plan markierte dann die falsche Spalte als "heute", eine
 * Hausaufgabe fuer heute stand als "Überfällig" da, und der Live-Cursor haette sich in der
 * Nacht zum Montag versteckt.
 */
export const heuteIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
    + String(d.getDate()).padStart(2, '0');
};

/** Jetzt in Ortszeit als 'JJJJ-MM-TT HH:MM' - dieselbe Schreibweise wie Termine und Pruefungen. */
export const jetztLokal = () => {
  const d = new Date();
  return `${heuteIso()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Einer waagerecht scrollenden Leiste ansehen, dass es weitergeht.
 *
 * Auf dem Handy passen weder die Navigation noch die Reiterzeile in die Breite - sie scrollen,
 * aber nichts verraet das: die letzte Schaltflaeche endet einfach am Rand, als waere dort Schluss.
 * Die Klassen `mehr-links`/`mehr-rechts` setzen einen weichen Verlauf an die betroffene Seite.
 *
 * CSS allein kann das nicht: "ist dieses Element ueberhaupt scrollbar" ist keine Frage, die eine
 * Regel beantworten kann. Ein Verlauf, der IMMER da ist, wuerde auch dann etwas versprechen, wenn
 * nichts mehr kommt.
 */
export function scrollHinweis(el) {
  if (!el || el.dataset.scrollHinweis) return;
  el.dataset.scrollHinweis = '1';
  const pruefe = () => {
    const rest = el.scrollWidth - el.clientWidth - el.scrollLeft;
    el.classList.toggle('mehr-rechts', rest > 4);
    el.classList.toggle('mehr-links', el.scrollLeft > 4);
  };
  el.addEventListener('scroll', pruefe, { passive: true });
  // ResizeObserver statt eines resize-Listeners am Fenster: er feuert auch, wenn das Element
  // ueberhaupt erst eine Groesse BEKOMMT. Genau das ist der Normalfall - eine Leiste in einem
  // noch versteckten Panel ist null Pixel breit, und ein einmaliger Blick nach dem Zeichnen
  // faende dort nie etwas zu scrollen.
  new ResizeObserver(pruefe).observe(el);
  // Und wenn sich der Inhalt aendert (andere Reiter, umsortiertes Menue).
  new MutationObserver(() => requestAnimationFrame(pruefe)).observe(el, { childList: true });
  requestAnimationFrame(pruefe);
}

export const WEEKDAY = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

// --- Ein sehr kleines Markdown ----------------------------------------------
// Genug fuer Ankuendigungen: Ueberschriften, Listen, fett, kursiv, Code und Links. Bewusst OHNE
// innerHTML - die Texte kommen aus einem Admin-Feld, und ein Feld, das HTML rendert, waere genau
// die Luecke, die die App sonst nirgends hat. Hier entstehen nur Elemente mit textContent.

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/;

function inline(text, ziel) {
  for (const teil of String(text).split(INLINE)) {
    if (!teil) continue;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(teil);
    // Nur http, https und mailto: 'javascript:' in einem href waere dieselbe Luecke, nur anders
    // buchstabiert.
    if (link && /^(https?:|mailto:)/i.test(link[2]))
      ziel.append(h('a', { href: link[2], target: '_blank', rel: 'noopener noreferrer', textContent: link[1] }));
    else if (teil.startsWith('**') && teil.endsWith('**'))
      ziel.append(h('strong', { textContent: teil.slice(2, -2) }));
    else if ((teil.startsWith('*') && teil.endsWith('*')) || (teil.startsWith('_') && teil.endsWith('_')))
      ziel.append(h('em', { textContent: teil.slice(1, -1) }));
    else if (teil.startsWith('`') && teil.endsWith('`'))
      ziel.append(h('code', { textContent: teil.slice(1, -1) }));
    else ziel.append(teil);
  }
  return ziel;
}

const AUFZAEHLUNG = /^\s*([-*]|\d+\.)\s+/;

/** Markdown als schlichter Text - fuer Auszuege in Listen, wo "**fett**" sonst roh dastuende. */
export const ohneMd = (text = '') => String(text).replace(/^\s*(#+|[-*>]|\d+\.)\s+/gm, '')
  .replace(/[*_`]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

export function md(text) {
  const wurzel = h('div', { className: 'md' });
  for (const block of String(text ?? '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)) {
    let zeilen = block.split('\n');
    // Ueberschriften zuerst abtragen: sie stehen oft ohne Leerzeile vor ihrem Absatz.
    while (zeilen.length && /^#{1,3}\s+/.test(zeilen[0])) {
      const [, raute, titel] = /^(#{1,3})\s+(.*)$/.exec(zeilen[0]);
      wurzel.append(inline(titel, h('h' + (raute.length + 2))));
      zeilen = zeilen.slice(1);
    }
    if (!zeilen.length || !zeilen.join('').trim()) continue;
    // Eine Liste ist ein Block, in dem JEDE Zeile ein Punkt ist - sonst waere sie mitten im
    // Absatz auseinandergerissen.
    if (zeilen.every(z => AUFZAEHLUNG.test(z))) {
      wurzel.append(h(/^\s*\d+\./.test(zeilen[0]) ? 'ol' : 'ul', { className: 'md-liste' },
        ...zeilen.map(z => inline(z.replace(AUFZAEHLUNG, ''), h('li')))));
      continue;
    }
    // Der Umbruch wird selbst gesetzt, statt ihn 'white-space: pre-wrap' zu ueberlassen: sonst
    // haengt er daran, in welchem Element der Absatz spaeter landet - und genau dort ging er
    // verloren.
    const absatz = h('p', { className: 'fliesstext' });
    zeilen.forEach((z, i) => {
      if (i) absatz.append(h('br'));
      inline(z, absatz);
    });
    wurzel.append(absatz);
  }
  return wurzel;
}

/**
 * Etwas mit Freunden teilen - ein Fenster fuer Projekte, Kalender und was noch kommt.
 *
 * Es zeigt beide Seiten: wer es schon hat (und wieder herausfliegen kann) und wer noch dazu
 * koennte. Die Aufrufer geben nur, was sich unterscheidet: woher die Liste kommt und was beim
 * Hinzufuegen und Entziehen passiert.
 */
export async function teilenFenster({ titel, hinweis, drin, hinzu, weg, danach }) {
  const dlg = $('#teilenDlg');
  const freunde = (await api('GET', '/api/friends').catch(() => ({}))).friends ?? [];
  let aktuell = await drin();
  const treffer = h('div', { className: 'stack wahl-liste' });

  const frisch = async () => {
    aktuell = await drin();
    male();
    if (danach) danach();
  };

  const zeile = (p, istDrin) => h('div', { className: 'wahl-zeile' },
    avatarEl(p, 'mini'),
    h('span', { className: 'grow' }, nameOf(p),
      h('small', { className: 'sub', textContent: '@' + p.username })),
    h('button', {
      className: istDrin ? 'tiny ghost' : 'tiny primary',
      textContent: istDrin ? 'Entfernen' : 'Hinzufügen',
      onclick: async e => {
        e.currentTarget.disabled = true;
        try {
          await (istDrin ? weg(p) : hinzu(p));
          toast(istDrin ? 'Entfernt.' : 'Geteilt.', true);
          await frisch();
        } catch (err) { oops(err); e.currentTarget.disabled = false; }
      },
    }));

  const suche = h('input', { type: 'search', placeholder: 'Namen suchen …', autocomplete: 'off' });
  const male = () => {
    const q = suche.value.trim().toLowerCase();
    const passt = f => !q || nameOf(f).toLowerCase().includes(q)
      || String(f.username).toLowerCase().includes(q);
    const habenEs = aktuell.filter(passt);
    const offen = freunde.filter(f => !aktuell.some(g => g.id === f.id)).filter(passt);
    treffer.replaceChildren(
      ...(habenEs.length ? [h('p', { className: 'meta wahl-schule', textContent: 'Geteilt mit' })] : []),
      ...habenEs.map(p => zeile(p, true)),
      ...(offen.length ? [h('p', { className: 'meta wahl-schule', textContent: 'Freunde' })] : []),
      ...offen.map(p => zeile(p, false)),
      ...(habenEs.length || offen.length ? [] : [h('p', { className: 'meta', textContent: freunde.length
        ? 'Niemanden gefunden.' : 'Du hast noch keine Freunde, mit denen du teilen könntest.' })]));
  };
  suche.oninput = male;
  // Enter nimmt den ersten Treffer - so geht das Teilen ganz ohne Maus.
  suche.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    treffer.querySelector('.wahl-zeile button')?.click();
  };
  male();

  dlg.replaceChildren(
    h('h2', { textContent: titel }),
    hinweis ? h('p', { className: 'meta', textContent: hinweis }) : null,
    suche, treffer,
    h('div', { className: 'row end' },
      h('button', { className: 'ghost', textContent: 'Fertig', onclick: () => dlg.close() })));
  dlg.showModal();
  suche.focus();
}

export const state = { me: null, target: null, week: null, courses: [], rooms: [], friends: null, registration: 'open' };

// --- Personen & Farben ------------------------------------------------------

const hashCode = s => { let n = 0; for (const c of String(s)) n = (n * 31 + c.codePointAt(0)) | 0; return Math.abs(n); };
const PALETTE = ['#d95f5f', '#d9853c', '#c9a72e', '#5aa85a', '#35a79b', '#3b82d6', '#6b5ce0', '#c04ec0', '#a9694c', '#5b7080'];

export const colorOf = p => p.color || PALETTE[hashCode('u' + p.id) % PALETTE.length];
export const nameOf = p => p.display_name || p.username;
const initials = n => String(n).trim().split(/\s+/).slice(0, 2).map(w => [...w][0] ?? '').join('').toUpperCase() || '?';
export const courseHue = id => hashCode(id) % 360;

/**
 * Ton und Saettigung einer selbst gewaehlten Farbe, fuer die --hue/--sat-Mechanik des Plans.
 *
 * Frueher kam hier nur der Farbton heraus. Damit war Grau ROT: ohne Buntanteil gibt es keinen
 * Ton, und der Rueckfallwert 0 ist Rot. Pastellrosa, Dunkelrot und Signalrot waren zudem
 * dieselbe Farbe, weil die Saettigung fest im Stylesheet stand.
 *
 * Die HELLIGKEIT bleibt bewusst beim Design (--tint-l, --code-l): sie haelt den Plan im Hell-
 * wie im Dunkelmodus lesbar. Dunkelblau wird deshalb ein sattes Blau in der Helligkeit des
 * jeweiligen Modus - und kein unsichtbares Schwarz auf Schwarz.
 */
export function tonAus(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return { h: 0, s: 0 };   // grau, weiss, schwarz - und das soll auch grau bleiben
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  // Buntanteil bezogen auf den hellsten Kanal (die Saettigung aus HSV, nicht aus HSL). HSL wuerde
  // hier luegen: Pastellrosa hat dort die volle Saettigung 100 und kaeme kraeftig heraus, obwohl
  // es blass gewaehlt wurde. So bleibt Blasses blass und Kraeftiges kraeftig.
  return { h: Math.round(h * 60), s: Math.round(100 * d / max) };
}

// Eigener Name schlaegt den aus der Schule - "G2_DE" heisst dort halt so.
export const kursName = e => e?.pref_name || e?.subject || e?.title;

// Die Freistunde ist serverseitig ein reservierter Kurs - hier nur die Anzeige davon.
export const FREI = '__frei__';
export const WEG = '__weg__';   // von Hand entfernte WebUntis-Stunde - die Zelle bleibt leer
export const istWeg = e => (typeof e === 'string' ? e : e?.id) === WEG;
export const istFrei = c => String(c?.id ?? '').toLowerCase() === FREI;

// Fach — Lehrer — Kursnummer: so sucht man einen Kurs, die Nummer ist nur die Feinunterscheidung.
// Der eigene Name gewinnt - wer den Kurs "Deutsch GK" genannt hat, will ihn ueberall so sehen.
export const courseLabel = c => istFrei(c)
  ? 'Frei'
  : c && [c.pref_name || c.subject || c.title, c.teacher, c.id].filter(Boolean).join(' — ');

const fallbackZeichen = p => h('span', { textContent: p.emoji || initials(nameOf(p)) });

export function avatarEl(p, cls = '') {
  const el = h('span', { className: ('avatar ' + cls).trim() });
  el.style.background = colorOf(p);
  if (p.has_avatar) {
    const img = h('img', { src: `/api/users/${p.id}/avatar${p.bild_v ? `?v=${p.bild_v}` : ''}`, alt: '' });
    // Bilder liegen unter /api/ und sind bewusst nicht im Service-Worker-Cache - offline also
    // zurueck auf Emoji bzw. Initialen statt eines kaputten Bildsymbols.
    img.onerror = () => el.replaceChildren(fallbackZeichen(p));
    el.append(img);
  } else {
    el.append(fallbackZeichen(p));
  }
  return el;
}

// Ohne eigenes Bild ein Verlauf aus der Profilfarbe - so sieht die Flaeche nie leer aus.
export function paintBanner(el, p, untertitel = '') {
  const c = colorOf(p);
  const verlauf = `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 45%, #101418))`;
  // Verlauf bleibt als zweite Ebene darunter - laedt das Bild nicht (offline), ist die Flaeche
  // trotzdem gefuellt.
  el.style.backgroundImage = p.has_banner ? `url(/api/users/${p.id}/banner${p.bild_v ? `?v=${p.bild_v}` : ''}), ${verlauf}` : verlauf;
  el.replaceChildren(h('div', { className: 'who' },
    avatarEl(p, 'big-sm'),
    h('div', {},
      h('strong', { textContent: nameOf(p) }),
      untertitel ? h('small', { textContent: untertitel }) : null)));
}
