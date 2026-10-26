// --- hausaufgaben ---
// Hausaufgaben (kursweit) und ToDos (persoenlich).
import {
  $, $$, addDays, api, avatarEl, bestaetigen, courseLabel, dmy, eingabe, entwurf, entwurfWeg, h,
  heuteIso, istFrei, jetztLokal, md, nameOf, oops, rueckgaengig, setzeKinder, state, stunden, teilenFenster,
  toast, WEEKDAY,
} from './kern.js';
import { eintragFelder, loadKalender, terminFenster } from './kalender.js';
import { malHwBadge } from './chat.js';

// --- Hausaufgaben -----------------------------------------------------------

const hwFach = h => h.subject_short || h.subject || h.course_title || h.course_id;

// "Heute"/"Morgen" statt eines Datums - danach denkt man bei Hausaufgaben.
function faelligLabel(iso) {
  const heute = heuteIso();
  if (iso === heute) return 'Heute';
  if (iso === addDays(heute, 1)) return 'Morgen';
  if (iso < heute) return `Überfällig · ${dmy(iso)}`;
  return `${WEEKDAY[new Date(iso + 'T00:00:00Z').getUTCDay()]}, ${dmy(iso)}`;
}

async function toggleDone(hw, danach) {
  const war = hw.done;
  await api(war ? 'DELETE' : 'POST', `/api/homework/${hw.id}/done`);
  malHwBadge();   // die rote Zahl sofort, nicht erst beim naechsten Takt
  await danach();
  rueckgaengig(war ? 'Haken entfernt.' : 'Abgehakt.', async () => {
    await api(war ? 'POST' : 'DELETE', `/api/homework/${hw.id}/done`);
    malHwBadge();
    await danach();
  });
}

// Die Felder einer Hausaufgabe, wie POST und PUT sie erwarten - fuer Rueckgaengig. `leise`: die
// wiederhergestellte Aufgabe wird dem Kurs nicht noch einmal angekuendigt.
const hwFelder = hw => ({ course_id: hw.course_id, due_date: hw.due_date, text: hw.text,
  day_id: hw.day_id ?? undefined, period_id: hw.period_id ?? undefined, leise: true });

// Eine Hausaufgaben-Zeile, wiederverwendet in der Liste und im Stunden-Detail.
export function hwZeile(hw, danach, mitFach = true) {
  // Was aus WebUntis kommt, gehoert der Schule: abhaken ja, aendern und loeschen nein.
  const darfAendern = !hw.von_untis && (hw.by?.id === state.me.id || state.me.is_admin);
  const box = h('input', { type: 'checkbox', checked: hw.done, title: 'Erledigt' });
  box.onchange = async () => {
    try { await toggleDone(hw, danach); } catch (err) { oops(err); box.checked = hw.done; }
  };

  const li = h('li', { className: hw.done ? 'gone' : '' },
    box,
    h('span', { className: 'grow' },
      mitFach ? h('span', { className: 'tag' }, hwFach(hw)) : null,
      ' ' + hw.text,
      h('small', { className: 'sub', textContent:
        [faelligLabel(hw.due_date), hw.von_untis ? 'von der Schule (WebUntis)'
          : hw.by ? 'von ' + nameOf(hw.by) : 'von einem gelöschten Konto',
          hw.ohne_slot ? 'keiner Stunde zugeordnet — nur du siehst sie' : null]
          .filter(Boolean).join(' · ') })));

  // Die Glocke hat jeder - die Erinnerung gilt nur fuer den, der sie stellt.
  li.append(h('button', {
    className: 'tiny ghost', textContent: '🔔', title: 'Mich vorher erinnern',
    onclick: () => erinnernDialog(hw).catch(oops),
  }));

  if (darfAendern) {
    li.append(h('button', {
      className: 'tiny ghost', textContent: 'Bearbeiten',
      onclick: () => bearbeiten(hw, danach),
    }));
    li.append(h('button', {
      className: 'tiny ghost', textContent: '×', title: 'Löschen',
      // Keine Rueckfrage mehr: Rueckgaengig legt sie wieder an (neue ID, Haken der anderen sind weg).
      onclick: async () => {
        try {
          await api('DELETE', `/api/homework/${hw.id}`); malHwBadge(); await danach();
          rueckgaengig('Hausaufgabe gelöscht.', async () => {
            await api('POST', '/api/homework', hwFelder(hw)); malHwBadge(); await danach();
          });
        } catch (err) { oops(err); }
      },
    }));
  }
  return li;
}

/**
 * Die eigene Erinnerung an eine Hausaufgabe.
 *
 * Kein close-Ereignis: darauf ist in dieser App kein Verlass, deshalb haengt alles an den
 * Knoepfen. Zwei freie Felder statt einer Auswahlliste - wer 26 Stunden vorher erinnert werden
 * will, soll das eintragen koennen.
 */
async function erinnernDialog(hw) {
  const dlg = $('#erinnernDlg'), f = $('#erinnernForm');
  const stand = await api('GET', `/api/homework/${hw.id}/erinnerung`).catch(() => ({}));
  const vor = state.me?.hw_erinnerung_min ?? 0;
  f.std.value = String(Math.floor(vor / 60));
  f.min.value = String(vor % 60);
  $('#erinnernText').textContent = `${hwFach(hw)} · ${hw.text}`;
  $('#erinnernStand').textContent = stand.faellig
    ? `Zurzeit eingestellt: ${stand.faellig.replace(' ', ', ')} Uhr`
    : 'Zurzeit keine Erinnerung.';

  const setzen = async min => {
    try {
      await api('PUT', `/api/homework/${hw.id}/erinnerung`, { min });
      dlg.close();
      toast(min ? 'Erinnerung gesetzt.' : 'Erinnerung aus.', true);
    } catch (err) { oops(err); }
  };
  $('#erinnernAus').onclick = () => setzen(0);
  f.onsubmit = e => {
    e.preventDefault();
    setzen((Number(f.std.value) || 0) * 60 + (Number(f.min.value) || 0));
  };
  dlg.showModal();
}

/**
 * Bearbeiten in einem richtigen Fenster statt in einem `prompt`. Der Grund ist nicht Schoenheit:
 * ueber `prompt` liess sich nur der Text aendern, und wer eine Aufgabe beim falschen Fach
 * eingetragen hatte, musste sie loeschen und neu anlegen.
 */
async function bearbeiten(hw, danach) {
  const dlg = $('#hwEdit'), f = $('#hwEditForm');
  const kurse = (await api('GET', '/api/my-courses').catch(() => []))
    .filter(c => !istFrei(c))
    .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b), 'de'));

  f.course_id.replaceChildren(...kurse.map(c =>
    h('option', { value: c.id, textContent: courseLabel(c) })));
  // Der Kurs der Aufgabe muss auswaehlbar bleiben, auch wenn er nicht mehr im eigenen Plan steht -
  // sonst waere beim Oeffnen still ein anderer vorausgewaehlt.
  if (!kurse.some(c => c.id === hw.course_id))
    f.course_id.prepend(h('option', { value: hw.course_id, textContent: hwFach(hw) + ' (nicht im Plan)' }));
  f.course_id.value = hw.course_id;
  f.due_date.value = hw.due_date;
  f.text.value = hw.text;

  // Am Absenden haengen, nicht am 'close'-Ereignis des Dialogs: das feuert nicht ueberall
  // zuverlaessig, und dann verschwaende das Fenster, ohne dass gespeichert wird - schlimmer als
  // gar kein Bearbeiten, weil es so aussieht, als haette es geklappt.
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('PUT', `/api/homework/${hw.id}`, {
        course_id: f.course_id.value, due_date: f.due_date.value, text: f.text.value,
      });
      dlg.close();
      await danach();
      rueckgaengig('Gespeichert.', async () => { await api('PUT', `/api/homework/${hw.id}`, hwFelder(hw)); await danach(); });
    } catch (err) { oops(err); }
  };
  $('#hwEditAbbruch').onclick = () => dlg.close();
  dlg.showModal();
}

// Zwei Haken, beide gemerkt: "Erledigte" zeigt Abgehaktes ab heute, "Abgelaufene" holt die
// vergangenen Tage dazu - sonst standen alte Aufgaben zwischen dem, was wirklich ansteht.
for (const id of ['#hwZeigeErledigt', '#hwZeigeAbgelaufen']) {
  try { $(id).checked = localStorage.getItem(id) === '1'; } catch { /* Privatmodus */ }
  $(id).onchange = () => {
    try { localStorage.setItem(id, $(id).checked ? '1' : '0'); } catch { /* egal */ }
    loadHomework().catch(oops);
  };
}

$('#hwForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const neu = await api('POST', '/api/homework', {
      course_id: f.course_id.value, due_date: f.due_date.value, text: f.text.value,
      // Die eigene Erinnerung fuer genau diese Aufgabe - alle anderen im Kurs bekommen ihre
      // nach ihrer eigenen Voreinstellung.
      erinnerung_min: (Number(f.erinnerung_std.value) || 0) * 60
        + (Number(f.erinnerung_min.value) || 0),
    });
    f.text.value = '';
    malHwBadge();
    await loadHomework();
    rueckgaengig('Hausaufgabe eingetragen.', async () => {
      await api('DELETE', `/api/homework/${neu.id}`); malHwBadge(); await loadHomework();
    });
  } catch (err) { oops(err); }
};

// Von aussen (eigenes Menue): den Unterreiter setzen, bevor loadHomework laeuft.
export function hwReiterSetzen(k) {
  if (!['hausaufgaben', 'todos', 'kalender', 'nachrichten'].includes(k)) return;
  hwReiter = k;
  try { localStorage.setItem(HW_REITER_KEY, k); } catch { /* Privatmodus */ }
}

// Suchen filtert das zuletzt Geholte - je Tastendruck den Server zu fragen waere Unsinn.
let hwDaten = null;
$('#hwSuche').oninput = () => { if (hwDaten) maleHausaufgaben(); };

export async function loadHomework() {
  paintHwReiter();
  if (hwReiter === 'todos') return loadTodos();
  if (hwReiter === 'kalender') return loadKalender();
  if (hwReiter === 'nachrichten') return loadNachrichten();

  const liste = await api('GET', '/api/homework');

  // Kurse aus dem eigenen Plan - nur dafuer darf man ueberhaupt eintragen.
  // Alle Kurse, die ueberhaupt im eigenen Plan vorkommen - nicht nur die der gerade angezeigten
  // Woche. Sonst war die Auswahl leer, sobald man in einer Woche stand, fuer die noch nichts
  // eingetragen oder abgeglichen ist.
  const meine = (await api('GET', '/api/my-courses').catch(() => []))
    .filter(c => !istFrei(c))
    .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b), 'de'));

  // Die Voreinstellung aus dem Profil steht im Formular - aenderbar fuer diese eine Aufgabe.
  const vor = state.me?.hw_erinnerung_min ?? 0;
  $('#hwForm').erinnerung_std.value = String(Math.floor(vor / 60));
  $('#hwForm').erinnerung_min.value = String(vor % 60);

  const sel = $('#hwForm').course_id;
  const vorher = sel.value;
  sel.replaceChildren(...meine.map(c => h('option', { value: c.id, textContent: courseLabel(c) })));
  if (vorher) sel.value = vorher;
  $('#hwForm').querySelector('button').disabled = !meine.length;
  if (!$('#hwForm').due_date.value) $('#hwForm').due_date.value = heuteIso();

  hwDaten = { liste, meine };
  maleHausaufgaben();
  await naechstePruefungen().catch(() => {});
}

function maleHausaufgaben() {
  const { liste, meine } = hwDaten;
  const zeigeErledigt = $('#hwZeigeErledigt').checked;
  const zeigeAbgelaufen = $('#hwZeigeAbgelaufen').checked;
  const heute = heuteIso();
  const q = $('#hwSuche').value.trim().toLowerCase();
  const trifft = x => !q || [x.text, hwFach(x), x.course_title, x.by ? nameOf(x.by) : '']
    .join(' ').toLowerCase().includes(q);
  const sichtbar = liste.filter(x => (zeigeErledigt || !x.done) && (zeigeAbgelaufen || x.due_date >= heute) && trifft(x));
  const nachTag = new Map();
  for (const hw of sichtbar) {
    if (!nachTag.has(hw.due_date)) nachTag.set(hw.due_date, []);
    nachTag.get(hw.due_date).push(hw);
  }

  const teile = [];
  for (const [tag, gruppe] of nachTag) {
    teile.push(h('h3', { textContent: faelligLabel(tag) }));
    teile.push(h('ul', { className: 'list' }, ...gruppe.map(hw => hwZeile(hw, loadHomework))));
  }
  if (!teile.length) teile.push(h('div', { className: 'empty' },
    h('p', { textContent: q ? 'Nichts gefunden.' : meine.length ? 'Nichts offen.' : 'Du hast noch keine Kurse im Stundenplan.' }),
    h('p', { className: 'muted small', textContent: q ? 'Kein Text, Fach oder Name passt dazu.' : meine.length
      ? 'Hausaufgaben deiner Kurse für die nächsten vier Wochen erscheinen hier.'
      : 'Trag zuerst im Plan deine Stunden ein — oder verbinde dich im Profil mit WebUntis.' })));
  $('#hwList').replaceChildren(...teile);
}

/** Die naechsten Pruefungen - eigene, Kurs und Schule - aus dem Kalender, 60 Tage voraus. */
async function naechstePruefungen() {
  const heute = heuteIso();
  const { eintraege } = await api('GET', `/api/kalender/eintraege?von=${heute}&bis=${addDays(heute, 60)}`);
  // Weg ist sie, wenn sie vorbei ist - nicht erst um Mitternacht. Wie pruefungVorbei() im Server:
  // mit Uhrzeit ab ihrem Ende, ganztags ab dem naechsten Tag.
  const jetzt = jetztLokal();
  const vorbei = e => {
    const ende = String(e.bis || e.von || '');
    return e.ganztags || ende.length <= 10 ? ende.slice(0, 10) < heute : ende <= jetzt;
  };
  const pruefungen = eintraege.filter(e => e.art === 'pruefung' && !vorbei(e))
    .sort((a, b) => a.von.localeCompare(b.von)).slice(0, 12);
  const wann = iso => {
    const tage = Math.round((new Date(iso + 'T00:00:00Z') - new Date(heute + 'T00:00:00Z')) / 86_400_000);
    const datum = `${WEEKDAY[new Date(iso + 'T00:00:00Z').getUTCDay()].slice(0, 2)} ${dmy(iso)}`;
    return tage === 0 ? `Heute · ${datum}` : tage === 1 ? `Morgen · ${datum}` : `in ${tage} Tagen · ${datum}`;
  };
  const zumKalender = () => { hwReiter = 'kalender'; try { localStorage.setItem(HW_REITER_KEY, hwReiter); } catch { /* egal */ } loadHomework().catch(oops); };
  setzeKinder($('#hwPruefungen'), ...(pruefungen.length
    ? pruefungen.map(p => {
        const strich = h('span', { className: 'kal-strich' });
        strich.style.background = p.farbe;
        // Der Text fuehrt zum Kalender; eigene Pruefungen lassen sich hier aendern und loeschen,
        // wie Hausaufgaben - dasselbe Fenster wie beim Eintragen.
        return h('li', {},
          strich,
          h('span', { className: 'grow klick', onclick: zumKalender, title: 'Im Kalender ansehen' }, p.titel,
            h('small', { className: 'sub', textContent: wann(p.von.slice(0, 10))
              + (p.von_stunde ? ` · ${stunden(p.von_stunde, p.bis_stunde)}` : '')
              + (p.ort ? ` · Raum ${p.ort}` : '')
              + (p.aus_untis ? ' · aus WebUntis' : p.quelle === 'kurs' ? ` · Kurs, von ${p.von_name}` : '') })),
          // Aendern und × bleiben zusammen oben rechts - vorher rutschte das × allein in eine
          // eigene Zeile unter den Text.
          p.darf_aendern ? h('span', { className: 'knoepfe' }, h('button', { className: 'tiny ghost', textContent: 'Ändern',
            onclick: () => terminFenster(p, { danach: () => loadHomework().catch(oops) }) }),
          h('button', { className: 'tiny ghost', textContent: '×', title: 'Löschen',
            onclick: async () => {
              try {
                await api('DELETE', `/api/kalender/eintraege/${p.id}`); state.plan = null; await loadHomework();
                rueckgaengig(`„${p.titel}" gelöscht.`, async () => {
                  await api('POST', `/api/kalender/${p.kalender_id}/eintraege`, eintragFelder(p));
                  state.plan = null; await loadHomework();
                });
              } catch (err) { oops(err); }
            } })) : null);
      })
    : [h('li', {}, h('span', { className: 'muted', textContent: 'Keine Prüfungen in den nächsten 60 Tagen.' }))]));
}

// --- ToDos -------------------------------------------------------------------
// Eigener Reiter neben den Hausaufgaben. Der Unterschied in einem Satz: Hausaufgaben haengen an
// einem Kurs und sehen alle, die ihn haben; ToDos haengen an einer Uhrzeit und sieht nur man selbst.

const HW_REITER_KEY = 'hwReiter';
let hwReiter = 'hausaufgaben';
try { hwReiter = localStorage.getItem(HW_REITER_KEY) || hwReiter; } catch { /* Privatmodus */ }

const VORLAUF_TEXT = { 0: 'zur Fälligkeit', 60: '1 Stunde vorher', 480: '8 Stunden vorher',
  1440: '1 Tag vorher' };

function paintHwReiter() {
  $$('#hwReiter button').forEach(b => b.classList.toggle('active', b.dataset.hw === hwReiter));
  $('#todoBereich').hidden = hwReiter !== 'todos';
  $('#hwBereich').hidden = hwReiter !== 'hausaufgaben';
  $('#kalenderBereich').hidden = hwReiter !== 'kalender';
  $('#nachrichtenBereich').hidden = hwReiter !== 'nachrichten';
}

// --- Nachrichten der Schule ---------------------------------------------------
// Karten, neueste zuerst. Der Text kommt als Markdown-faehiger Klartext vom Server - Links aus
// dem Feed stehen als [Text](Adresse) drin und werden hier klickbar.
async function loadNachrichten() {
  const ziel = $('#nachrichtenListe');
  const liste = await api('GET', '/api/nachrichten');
  if (!liste.length) {
    setzeKinder(ziel, h('div', { className: 'card leer' },
      h('p', { textContent: 'Keine Nachrichten.' }),
      h('p', { className: 'muted small', textContent:
        'Hier erscheint, was die Schule bei WebUntis unter „Nachrichten zum Tag" und im RSS-Feed veröffentlicht.' })));
    return;
  }
  setzeKinder(ziel, liste.map(nachrichtKarte));
}

const nachrichtKarte = n => h('article', { className: 'card nachricht' },
  h('div', { className: 'row nachricht-kopf' },
    h('span', { className: 'muted small', textContent: dmy(n.datum) }),
    h('span', { className: 'pille', textContent: n.quelle === 'rss' ? 'RSS' : 'WebUntis' })),
  h('h3', { textContent: n.titel }),
  n.text ? md(n.text) : null,
  n.link ? h('a', { href: n.link, target: '_blank', rel: 'noopener noreferrer',
    className: 'small', textContent: 'Öffnen ↗' }) : null);

/**
 * Neue Nachrichten der Schule seit dem letzten Oeffnen - einmal als Fenster. Beim allerersten
 * Mal wird still aufgeholt: 60 Tage alte Nachrichten nachzureichen hilft niemandem. Gemerkt wird
 * beim Zeigen, nicht beim Schliessen - auf das close-Ereignis ist kein Verlass, und ein Fenster,
 * das wiederkommt, waere genau das Falsche.
 */
export async function nachrichtenZeigen() {
  const gesehen = state.me?.nachrichten_gesehen;
  const liste = await api('GET', '/api/nachrichten');
  const max = Math.max(0, ...liste.map(n => n.id));
  const merke = () => {
    if (state.me) state.me.nachrichten_gesehen = max;
    api('POST', '/api/me/nachrichten-gelesen', { id: max }).catch(() => {});
  };
  if (gesehen == null) return merke();
  const neue = liste.filter(n => n.id > gesehen);
  if (!neue.length) return;
  merke();
  const d = $('#nachrichtenDlg');
  d.replaceChildren(
    h('h2', { textContent: neue.length === 1 ? 'Neue Nachricht der Schule' : `${neue.length} neue Nachrichten der Schule` }),
    h('div', { className: 'stack' }, ...neue.map(nachrichtKarte)),
    h('div', { className: 'row end' },
      h('button', { className: 'primary', textContent: 'Gelesen', onclick: () => d.close() })));
  d.showModal();
}

$$('#hwReiter button').forEach(b => (b.onclick = () => {
  hwReiter = b.dataset.hw;
  try { localStorage.setItem(HW_REITER_KEY, hwReiter); } catch { /* Privatmodus */ }
  paintHwReiter();
  loadHomework().catch(oops);
}));



const todoFaellig = due => {
  const [tag, zeit] = due.split(' ');
  return `${faelligLabel(tag)}, ${zeit} Uhr`;
};

/**
 * Abhaken mit Rueckgaengig. Der Server antwortet dreierlei: erledigt, bei Wiederholung "nicht
 * erledigt, aber weitergerueckt" (naechst), bei der Projektregel "loeschen" ist die Aufgabe weg -
 * die Umkehrung ist jedes Mal eine andere.
 */
async function todoAbhaken(t) {
  const war = t.done;
  const r = await api(war ? 'DELETE' : 'POST', `/api/todos/${t.id}/done`);
  const zurueck = war ? () => api('POST', `/api/todos/${t.id}/done`)
    : r.geloescht ? () => api('POST', '/api/todos', aendere(t))
    : r.naechst ? () => api('PUT', `/api/todos/${t.id}`, aendere(t))
    : async () => { await api('DELETE', `/api/todos/${t.id}/done`); await api('PUT', `/api/todos/${t.id}`, aendere(t)); };
  malHwBadge();
  await loadTodos();
  rueckgaengig(war ? 'Haken entfernt.' : r.naechst ? `Erledigt – das nächste Mal: ${todoFaellig(r.naechst)}.` : 'Erledigt.',
    async () => { await zurueck(); malHwBadge(); await loadTodos(); });
}

// Loeschen ohne Rueckfrage: Rueckgaengig legt die Aufgabe neu an (neue ID).
async function todoLoeschen(t) {
  await api('DELETE', `/api/todos/${t.id}`);
  malHwBadge();
  await loadTodos();
  rueckgaengig('Aufgabe gelöscht.', async () => {
    const neu = await api('POST', '/api/todos', aendere(t));
    if (t.done) await api('POST', `/api/todos/${neu.id}/done`);
    malHwBadge();
    await loadTodos();
  });
}

function todoZeile(t) {
  const box = h('input', { type: 'checkbox', checked: t.done, title: 'Erledigt' });
  box.onchange = async () => {
    try { await todoAbhaken(t); } catch (err) { oops(err); box.checked = t.done; }
  };

  return h('li', { className: t.done ? 'gone' : '' },
    box,
    h('span', { className: 'grow' }, (PRIO[t.prioritaet] ? PRIO[t.prioritaet] + ' ' : '') + t.text,
      h('small', { className: 'sub', textContent:
        // Eine Aufgabe darf ohne Frist sein - dann steht das auch so da.
        [t.due_at ? todoFaellig(t.due_at) : 'ohne Frist',
          t.due_at ? (VORLAUF_TEXT[t.remind_min] ?? null) : null,
          t.erinnert ? 'erinnert' : null].filter(Boolean).join(' · ') })),
    h('button', {
      className: 'tiny ghost', textContent: 'Ändern', onclick: () => aufgabeFenster(t, {}),
    }),
    h('button', {
      className: 'tiny ghost', textContent: '×', title: 'Löschen',
      onclick: async () => { try { await todoLoeschen(t); } catch (err) { oops(err); } },
    }));
}

// --- ToDo: Projekte und Boards --------------------------------------------------
// Links der Projektbaum, rechts das Board des gewaehlten Projekts - oder die eigenen losen
// Aufgaben, wenn keins gewaehlt ist. Alles, was man selten braucht (Spalten, Kategorien, Regel,
// Teilen, Loeschen), steckt hinter dem Punkte-Menue: eine Leiste voller Knoepfe war das, was
// unuebersichtlich wirkte.

let ordner = [];
let aktiv = null;             // ID des gewaehlten Projekts, null = eigene lose Aufgaben
let board = null;             // Spalten, Bereiche, Mitglieder des gewaehlten Projekts
let zeigeGeplant = false;
let zeigeErledigt = false;
// Beide Haken werden gemerkt: wer erledigte sehen will, will das auch morgen.
try { zeigeGeplant = localStorage.getItem('todoGeplant') === '1'; zeigeErledigt = localStorage.getItem('todoErledigt') === '1'; } catch { /* Privatmodus */ }

const PRIO = ['', '❗', '‼️'];
const AKTIV_KEY = 'todoProjekt';
try { aktiv = Number(localStorage.getItem(AKTIV_KEY)) || null; } catch { /* Privatmodus */ }

export function boardSchliessen() { aktiv = null; }

/** Ein Projekt teilen - dasselbe Fenster wie beim Kalender. */
const ordnerTeilen = o => teilenFenster({
  titel: `„${o.name}" teilen`,
  hinweis: 'Wer das Projekt hat, sieht alle Aufgaben darin, trägt ein und hakt ab — für alle. '
    + 'Unterprojekte sind mitgeteilt.',
  drin: async () => ((await api('GET', '/api/todo-ordner').catch(() => []))
    .find(x => x.id === o.id)?.geteilt_mit ?? []),
  hinzu: p => api('POST', `/api/todo-ordner/${o.id}/teilen`, { user_id: p.id }),
  weg: p => api('DELETE', `/api/todo-ordner/${o.id}/teilen/${p.id}`),
  danach: () => loadTodos().catch(() => {}),
});

// --- Der Projektbaum ---------------------------------------------------------

function maleBaum() {
  const kinder = eltern => ordner.filter(o => (o.parent_id ?? null) === eltern);
  const knopf = (o, tiefe) => h('button', {
    type: 'button',
    className: 'projekt' + ((o?.id ?? null) === aktiv ? ' aktiv' : ''),
    style: tiefe ? `padding-left:${.6 + tiefe * .9}rem` : '',
    onclick: () => waehle(o?.id ?? null),
  },
    h('span', { className: 'projekt-name', textContent: o ? o.name : 'Eigene Aufgaben' }),
    o?.offen ? h('small', { className: 'projekt-zahl', textContent: String(o.offen) }) : null,
    o && !o.meiner ? h('small', { className: 'projekt-geteilt', textContent: '↗', title: 'mit dir geteilt' }) : null);
  const baum = (eltern = null, tiefe = 0) => kinder(eltern)
    .flatMap(o => [knopf(o, tiefe), ...baum(o.id, tiefe + 1)]);
  $('#projektBaum').replaceChildren(knopf(null, 0), ...baum());
}

async function waehle(id) {
  aktiv = id;
  try { localStorage.setItem(AKTIV_KEY, String(id ?? '')); } catch { /* Privatmodus */ }
  await loadTodos();
}

// --- Das Board ---------------------------------------------------------------

/** Aus einer Aufgabe die Felder machen, die PUT /api/todos erwartet. */
const aendere = (t, neu = {}) => ({
  text: t.text, due_at: t.due_at ?? '', remind_min: t.remind_min, ordner_id: t.ordner_id,
  spalte_id: t.spalte_id, zustaendige: t.zustaendige ?? [], wiederholung: t.wiederholung,
  wiederholung_einheit: t.wiederholung_einheit, sichtbar_ab: t.sichtbar_ab ?? '',
  prioritaet: t.prioritaet, ...neu,
});

let todoSuche = '';
const sichtbar = t => (zeigeGeplant || !t.geparkt) && (zeigeErledigt || !t.done)
  && (!todoSuche || t.text.toLowerCase().includes(todoSuche));
// Suchen zeichnet nur neu - mit dem, was zuletzt geholt wurde.
let todoStand = null;
$('#todoSuche').oninput = () => {
  todoSuche = $('#todoSuche').value.trim().toLowerCase();
  if (!todoStand) return;
  if (todoStand.o && board) maleBoard(todoStand.o, todoStand.alle); else maleListe(todoStand.alle);
};

function karte(t, wer) {
  const box = h('input', { type: 'checkbox', checked: t.done, title: 'Erledigt' });
  box.onchange = async () => {
    try { await todoAbhaken(t); } catch (err) { oops(err); box.checked = t.done; }
  };
  // Zustaendig: Mitglieder als Gesichter (bis drei, dann +n), freie Namen klein darunter.
  const leute = (t.zustaendige ?? []).filter(z => z.id).map(z => wer.get(z.id)).filter(Boolean);
  const namen = (t.zustaendige ?? []).filter(z => z.name).map(z => z.name);
  const k = h('div', {
    className: ['karte', t.done && 'gone', t.geparkt && 'geparkt', t.prioritaet && `prio-${t.prioritaet}`]
      .filter(Boolean).join(' '),
    draggable: !!board?.darf_aendern,
  },
    h('div', { className: 'karte-zeile' }, box,
      h('span', { className: 'grow', textContent: t.text }),
      leute.length ? h('span', { className: 'zust-avatare', title: 'Zuständig: ' + [...leute.map(nameOf), ...namen].join(', ') },
        ...leute.slice(0, 3).map(m => avatarEl(m, 'mini')),
        leute.length > 3 ? h('span', { className: 'avatar mini mehr', textContent: '+' + (leute.length - 3) }) : null) : null),
    (t.due_at || t.wiederholung || t.geparkt || namen.length) ? h('div', { className: 'karte-meta' },
      namen.length ? h('span', { className: 'pille', title: 'Zuständig, ohne Konto', textContent: '👤 ' + namen.join(', ') }) : null,
      t.due_at ? h('span', { className: 'pille', textContent: todoFaellig(t.due_at) }) : null,
      t.wiederholung ? h('span', { className: 'pille', textContent:
        `↻ ${t.wiederholung} ${{ tag: 'T', woche: 'W', monat: 'M' }[t.wiederholung_einheit]}` }) : null,
      t.geparkt ? h('span', { className: 'pille', textContent: 'ab ' + todoFaellig(t.sichtbar_ab) }) : null) : null);
  k.ondragstart = e => e.dataTransfer.setData('text/plain', String(t.id));
  k.onclick = e => { if (e.target.tagName !== 'INPUT') aufgabeFenster(t, {}); };
  return k;
}

function spalteEl(sp, aufgaben, alle, wer) {
  const drin = aufgaben.filter(t => t.spalte_id === sp.id).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const kasten = h('div', { className: 'spalte' },
    h('div', { className: 'spalte-kopf' },
      h('span', { className: 'grow', textContent: sp.name }),
      h('small', { className: 'spalte-zahl', textContent: String(drin.length) })),
    h('div', { className: 'spalte-karten' }, ...drin.map(t => karte(t, wer))),
    board.darf_aendern ? h('button', {
      className: 'tiny ghost neu', textContent: '+',
      title: 'Aufgabe in dieser Spalte',
      onclick: () => aufgabeFenster(null, { ordner_id: aktiv, spalte_id: sp.id }),
    }) : null);

  // Ziehen: am Rechner der schnellste Weg. Auf dem Handy passiert hier nichts - dafuer laesst
  // sich die Spalte im Fenster der Aufgabe waehlen.
  kasten.ondragover = e => { e.preventDefault(); kasten.classList.add('ueber'); };
  kasten.ondragleave = () => kasten.classList.remove('ueber');
  kasten.ondrop = async e => {
    e.preventDefault();
    kasten.classList.remove('ueber');
    const tid = Number(e.dataTransfer.getData('text/plain'));
    const t = alle.find(x => x.id === tid);
    if (!t || t.spalte_id === sp.id) return;
    try {
      await api('PUT', `/api/todos/${tid}`, aendere(t, { spalte_id: sp.id })); await loadTodos();
      rueckgaengig(`Nach „${sp.name}" verschoben.`, async () => { await api('PUT', `/api/todos/${tid}`, aendere(t)); await loadTodos(); });
    } catch (err) { oops(err); }
  };
  return kasten;
}

function maleBoard(o, alle) {
  const aufgaben = alle.filter(t => t.ordner_id === o.id && sichtbar(t));
  const wer = new Map(board.mitglieder.map(m => [m.id, m]));
  const ohneSpalte = aufgaben.filter(t => !t.spalte_id);

  const teile = [];
  for (const b of board.bereiche) {
    const spalten = board.spalten.filter(sp => sp.bereich_id === b.id);
    teile.push(h('div', { className: 'bereich' },
      h('div', { className: 'bereich-kopf', textContent: b.name }),
      h('div', { className: 'spalten' }, ...spalten.map(sp => spalteEl(sp, aufgaben, alle, wer)))));
  }
  const lose = board.spalten.filter(sp => !sp.bereich_id);
  if (lose.length) teile.push(h('div', { className: 'spalten' }, ...lose.map(sp => spalteEl(sp, aufgaben, alle, wer))));
  if (ohneSpalte.length) teile.push(h('div', { className: 'spalten' },
    h('div', { className: 'spalte blass' },
      h('div', { className: 'spalte-kopf' }, h('span', { className: 'grow', textContent: 'Ohne Spalte' })),
      h('div', { className: 'spalte-karten' }, ...ohneSpalte.map(t => karte(t, wer))))));
  if (!board.spalten.length && !ohneSpalte.length)
    teile.push(h('p', { className: 'meta', textContent: 'Noch keine Spalte — im Menü „⋯" anlegen.' }));
  $('#board').replaceChildren(...teile);
}

// --- Lose Aufgaben: die Liste, wie es sie immer gab -------------------------

function maleListe(alle) {
  const meine = alle.filter(t => !t.ordner_id && sichtbar(t));
  if (!meine.length) {
    $('#todoListe').replaceChildren(h('div', { className: 'empty' },
      h('p', { textContent: todoSuche ? 'Nichts gefunden.' : 'Nichts offen.' }),
      h('p', { className: 'muted small', textContent: todoSuche ? 'Keine Aufgabe passt dazu.'
        : 'Aufgaben ohne Projekt landen hier — mit Uhrzeit und Erinnerung, nur für dich.' })));
    return;
  }
  const nachTag = new Map();
  for (const t of meine) {
    const tag = t.due_at ? t.due_at.slice(0, 10) : '';
    if (!nachTag.has(tag)) nachTag.set(tag, []);
    nachTag.get(tag).push(t);
  }
  const teile = [];
  for (const [tag, gruppe] of [...nachTag].sort(([a], [b]) => (a || '9').localeCompare(b || '9'))) {
    teile.push(h('h4', { textContent: tag ? faelligLabel(tag) : 'Ohne Frist' }));
    teile.push(h('ul', { className: 'list' }, ...gruppe.map(todoZeile)));
  }
  $('#todoListe').replaceChildren(...teile);
}

// --- Das Fenster einer Aufgabe ----------------------------------------------

function aufgabeFenster(t, vorgabe) {
  const dlg = $('#aufgabeDlg');
  const imBoard = !!board && (t?.ordner_id ?? vorgabe.ordner_id) === aktiv && aktiv !== null;
  const text = h('input', { maxLength: 300, value: t?.text ?? '', required: true });
  if (!t) entwurf('aufgabe:neu', text);   // ein angefangener Text ueberlebt das Schliessen
  const faellig = h('input', { type: 'datetime-local', value: (t?.due_at ?? '').replace(' ', 'T') });
  if (!t) entwurf('aufgabe:neu:faellig', faellig, true);
  const erinnerung = h('select', {}, ...Object.entries(VORLAUF_TEXT).map(([v, txt]) =>
    h('option', { value: v, textContent: txt, selected: Number(v) === (t?.remind_min ?? 60) })));
  const spalte = h('select', {}, h('option', { value: '', textContent: '— ohne Spalte —' }),
    ...(board?.spalten ?? []).map(sp => h('option', {
      value: String(sp.id), textContent: sp.name,
      selected: sp.id === (t?.spalte_id ?? vorgabe.spalte_id),
    })));
  // Zustaendig: mehrere Mitglieder per Haken, dazu Namen ohne Konto - die sind nur zur Uebersicht
  // fuer die, die eins haben.
  const bisher = t?.zustaendige ?? [];
  const haken = (board?.mitglieder ?? []).map(m => ({ m,
    x: h('input', { type: 'checkbox', checked: bisher.some(z => z.id === m.id) }) }));
  const freieNamen = h('input', { maxLength: 300, placeholder: 'z. B. Lisa, Herr Maier',
    value: bisher.filter(z => z.name).map(z => z.name).join(', ') });
  const zustaendig = h('div', { className: 'field' },
    h('span', { textContent: 'Zuständig' }),
    haken.length ? h('div', { className: 'zust-wahl' }, ...haken.map(({ m, x }) =>
      h('label', { className: 'check' }, x, avatarEl(m, 'mini'), nameOf(m)))) : null,
    h('label', { className: 'field' }, 'Weitere Namen (ohne Konto)', freieNamen,
      h('small', { className: 'muted', textContent: 'Mit Komma getrennt. Nur zur Übersicht – sie bekommen nichts mit.' })));
  const prio = h('select', {}, ...['keine', 'wichtig', 'sehr wichtig'].map((n, i) =>
    h('option', { value: String(i), textContent: n, selected: i === (t?.prioritaet ?? 0) })));
  const wdh = h('input', { type: 'number', min: 0, max: 365, className: 'kurz',
    value: String(t?.wiederholung ?? 0) });
  const einheit = h('select', {}, ...[['tag', 'Tage'], ['woche', 'Wochen'], ['monat', 'Monate']]
    .map(([v, n]) => h('option', { value: v, textContent: n,
      selected: v === (t?.wiederholung_einheit ?? 'woche') })));
  const sichtbarAb = h('input', { type: 'datetime-local', value: (t?.sichtbar_ab ?? '').replace(' ', 'T') });

  const koerper = () => ({
    text: text.value.trim(), due_at: faellig.value, remind_min: Number(erinnerung.value),
    ordner_id: t?.ordner_id ?? vorgabe.ordner_id ?? null,
    spalte_id: Number(spalte.value) || null,
    // Nur im Board gibt es das Feld - sonst bleibt, was war.
    ...(imBoard && { zustaendige: [
      ...haken.filter(({ x }) => x.checked).map(({ m }) => ({ id: m.id })),
      ...freieNamen.value.split(',').map(n => n.trim()).filter(Boolean).map(name => ({ name })),
    ] }),
    prioritaet: Number(prio.value), wiederholung: Number(wdh.value) || 0,
    wiederholung_einheit: einheit.value, sichtbar_ab: sichtbarAb.value,
  });

  // Nur das Noetige oben; Erinnerung, Wichtigkeit, Wiederholen und Parken hinter "Mehr" - offen,
  // wenn bei einer bestehenden Aufgabe etwas davon gesetzt ist.
  const mehrOffen = !!t && (t.remind_min !== 60 || !!t.prioritaet || !!t.wiederholung || !!t.sichtbar_ab);
  dlg.replaceChildren(
    h('h2', { textContent: t ? 'Aufgabe' : 'Neue Aufgabe' }),
    h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Was', text),
      imBoard ? h('label', { className: 'field' }, 'Spalte', spalte) : null,
      imBoard ? zustaendig : null,
      h('label', { className: 'field' }, 'Fällig am (darf leer bleiben)', faellig),
      h('details', { open: mehrOffen },
        h('summary', { textContent: 'Mehr: Erinnerung, Wichtigkeit, Wiederholen, Parken' }),
        h('div', { className: 'stack' },
          h('label', { className: 'field' }, 'Erinnerung', erinnerung),
          h('label', { className: 'field' }, 'Wichtigkeit', prio),
          h('label', { className: 'field' }, 'Wiederholen: alle',
            h('span', { className: 'row' }, wdh, einheit),
            h('small', { className: 'muted', textContent: 'Ohne Fälligkeit zählt der Rhythmus ab heute, 08:00 Uhr.' })),
          h('label', { className: 'field' }, 'Erst zeigen ab (geparkt)', sichtbarAb)))),
    h('div', { className: 'row end' },
      t ? h('button', {
        className: 'ghost', textContent: 'Löschen',
        onclick: async () => {
          try { dlg.close(); await todoLoeschen(t); } catch (err) { oops(err); }
        },
      }) : null,
      h('button', {
        className: 'primary', textContent: 'Speichern',
        onclick: async () => {
          if (!koerper().text) return toast('Text fehlt.');
          try {
            let zurueck;
            if (t) { await api('PUT', `/api/todos/${t.id}`, koerper()); zurueck = () => api('PUT', `/api/todos/${t.id}`, aendere(t)); }
            else {
              const neu = await api('POST', '/api/todos', koerper());
              entwurfWeg('aufgabe:neu');
              zurueck = () => api('DELETE', `/api/todos/${neu.id}`);
            }
            dlg.close();
            malHwBadge();
            await loadTodos();
            rueckgaengig(t ? 'Gespeichert.' : 'Aufgabe angelegt.', async () => { await zurueck(); malHwBadge(); await loadTodos(); });
          } catch (err) { oops(err); }
        },
      }),
      h('button', { className: 'ghost', textContent: 'Schließen', onclick: () => dlg.close() })));
  dlg.showModal();
  text.focus();
}

// --- Das Punkte-Menue --------------------------------------------------------

const frage = async (text, vorgabe = '') => {
  const wert = await eingabe(text, vorgabe);
  return wert?.trim() ? wert.trim() : null;
};

function maleMenue(o) {
  const eintrag = (text, tun) => h('button', { type: 'button', textContent: text,
    onclick: async () => { schliesseMenue(); try { await tun(); } catch (err) { oops(err); } } });
  const haken = (text, an, setze) => eintrag((an ? '✓ ' : '   ') + text, async () => { setze(); await loadTodos(); });

  const merk = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* egal */ } };
  const punkte = [
    haken('Geplante zeigen', zeigeGeplant, () => { zeigeGeplant = !zeigeGeplant; merk('todoGeplant', zeigeGeplant); }),
    haken('Erledigte zeigen', zeigeErledigt, () => { zeigeErledigt = !zeigeErledigt; merk('todoErledigt', zeigeErledigt); }),
    // Endgueltig, ohne Rueckgaengig: wer das waehlt, will Platz. Nur wo man aendern darf.
    !o || board?.darf_aendern ? eintrag('Erledigte löschen …', async () => {
      const n = todoStand?.alle.filter(t => t.done && (o ? t.ordner_id === o.id : !t.ordner_id)).length ?? 0;
      if (!n) return toast('Nichts Erledigtes da.', true);
      if (!await bestaetigen(`${n} erledigte Aufgabe(n) endgültig löschen?`)) return;
      const r = await api('DELETE', '/api/todos/erledigt' + (o ? `?ordner=${o.id}` : ''));
      toast(`${r.n} gelöscht.`, true);
      malHwBadge();
      await loadTodos();
    }) : null,
  ];
  if (o && board?.darf_aendern) punkte.push(
    h('hr'),
    eintrag('+ Spalte', async () => {
      const name = await frage('Name der Spalte:');
      if (name) { await api('POST', `/api/todo-ordner/${o.id}/spalten`, { name }); await loadTodos(); }
    }),
    eintrag('+ Kategorie', async () => {
      const name = await frage('Name der Kategorie (eine Etage über den Spalten):');
      if (name) { await api('POST', `/api/todo-ordner/${o.id}/bereiche`, { name }); await loadTodos(); }
    }),
    eintrag('Spalte entfernen …', async () => {
      if (!board.spalten.length) return toast('Keine Spalte da.');
      const nr = Number(await frage('Welche Spalte? ' + board.spalten.map((sp, i) => `${i + 1}=${sp.name}`).join(', ')));
      const sp = board.spalten[nr - 1];
      if (!sp) return;
      if (!await bestaetigen(`Spalte „${sp.name}" entfernen? Die Aufgaben darin bleiben, sie liegen dann in keiner Spalte.`)) return;
      await api('DELETE', `/api/todo-spalten/${sp.id}`);
      await loadTodos();
    }),
    eintrag('Erledigt-Regel …', () => regelFenster(o)),
  );
  if (o?.meiner) punkte.push(
    h('hr'),
    eintrag('Teilen …', () => ordnerTeilen(o)),
    eintrag('+ Unterprojekt', async () => {
      const name = await frage(`Unterprojekt in „${o.name}":`);
      if (name) { await api('POST', '/api/todo-ordner', { name, parent_id: o.id }); await loadTodos(); }
    }),
    eintrag('Umbenennen', async () => {
      const name = await frage('Neuer Name:', o.name);
      if (name) { await api('PUT', `/api/todo-ordner/${o.id}`, { name }); await loadTodos(); }
    }),
    eintrag('Projekt löschen', async () => {
      if (!await bestaetigen(`„${o.name}" löschen? Die Aufgaben darin gehen mit — Unterprojekte rücken eine Ebene hoch.`)) return;
      await api('DELETE', `/api/todo-ordner/${o.id}`);
      await waehle(null);
    }),
  );
  if (o && !o.meiner) punkte.push(
    h('hr'),
    eintrag('Projekt verlassen', async () => {
      if (!await bestaetigen(`„${o.name}" verlassen?`)) return;
      await api('DELETE', `/api/todo-ordner/${o.id}`);
      await waehle(null);
    }),
  );
  $('#boardMenue').replaceChildren(...punkte);
}

const schliesseMenue = () => { $('#boardMenue').hidden = true; };
$('#boardMehr').onclick = e => { e.stopPropagation(); $('#boardMenue').hidden = !$('#boardMenue').hidden; };
addEventListener('click', e => { if (!e.target.closest('#boardMenue')) schliesseMenue(); });

async function regelFenster(o) {
  const dlg = $('#aufgabeDlg');
  const regel = h('select', {}, ...[['nichts', 'liegen lassen'], ['verschieben', 'in eine Spalte schieben'],
    ['loeschen', 'löschen']].map(([v, n]) =>
    h('option', { value: v, textContent: n, selected: v === o.fertig_regel })));
  const ziel = h('select', {}, ...board.spalten.map(sp => h('option', {
    value: String(sp.id), textContent: sp.name, selected: sp.id === o.fertig_spalte_id })));
  dlg.replaceChildren(
    h('h2', { textContent: 'Wenn eine Aufgabe erledigt ist' }),
    h('p', { className: 'meta', textContent:
      'Gilt für einmalige Aufgaben. Wiederkehrende rücken stattdessen zum nächsten Termin weiter.' }),
    h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Dann', regel),
      h('label', { className: 'field' }, 'Zielspalte', ziel)),
    h('div', { className: 'row end' }, h('button', {
      className: 'primary', textContent: 'Speichern',
      onclick: async () => {
        // Die Rueckfrage kommt hier, beim Einstellen - nicht bei jedem Haken.
        if (regel.value === 'loeschen'
          && !await bestaetigen('Erledigte Aufgaben werden dann sofort gelöscht. Sicher?')) return;
        try {
          await api('PUT', `/api/todo-ordner/${o.id}`,
            { fertig_regel: regel.value, fertig_spalte_id: Number(ziel.value) || null });
          dlg.close();
          toast('Gespeichert.', true);
          await loadTodos();
        } catch (err) { oops(err); }
      },
    }), h('button', { className: 'ghost', textContent: 'Abbrechen', onclick: () => dlg.close() })));
  dlg.showModal();
}

// --- Laden -------------------------------------------------------------------

async function loadTodos() {
  const [liste, alle] = await Promise.all([
    api('GET', '/api/todo-ordner').catch(() => []),
    api('GET', '/api/todos'),
  ]);
  ordner = liste;
  // Ein Projekt, das es nicht mehr gibt (geloescht, Freigabe weg), faellt auf die eigenen zurueck.
  const o = aktiv ? ordner.find(x => x.id === aktiv) : null;
  if (aktiv && !o) aktiv = null;
  board = o ? await api('GET', `/api/todo-ordner/${o.id}/board`).catch(() => null) : null;

  maleBaum();
  $('#boardTitel').textContent = o ? o.name : 'Eigene Aufgaben';
  $('#aufgabeNeu').hidden = !!(o && !board?.darf_aendern);
  $('#board').hidden = !o;
  $('#todoListe').hidden = !!o;
  maleMenue(o);
  todoStand = { o, alle };
  if (o && board) maleBoard(o, alle);
  else maleListe(alle);
}

$('#aufgabeNeu').onclick = () => aufgabeFenster(null,
  { ordner_id: aktiv, spalte_id: board?.spalten?.[0]?.id ?? null });

$('#ordnerForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const neu = await api('POST', '/api/todo-ordner', { name: f.name.value });
    f.name.value = '';
    await waehle(neu.id);
  } catch (err) { oops(err); }
};
