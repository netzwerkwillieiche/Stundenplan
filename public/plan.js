// --- plan ---
// Der Stundenplan: Raster, Zellen, Detailfenster, Wochenwechsel und Wischen.
import {
  $, $$, addDays, api, avatarEl, courseHue, courseLabel, dm, dmy, FREI, h, heuteIso,
  istFrei, istWeg, kursName, nameOf, oops, paintBanner, rueckgaengig, state, stunden, toast, tonAus, WEG,
} from './kern.js';
import { loadAbsences, loadFriends } from './freunde.js';
import { chatReiterSetzen, chatTimer, loadChat, malHwBadge } from './chat.js';
import { hwReiterSetzen, hwZeile, loadHomework } from './hausaufgaben.js';
import { loadProfile, profilReiterSetzen } from './profil.js';
import { adminReiterSetzen, loadAdmin } from './admin.js';
import { loadTickets } from './tickets.js';
import { eintragFelder, terminFenster } from './kalender.js';
import { raumplanFenster, raumplanLaden } from './raumplan.js';
import { markiere, setzeOeffner } from './menue.js';
import { bueroReiterSetzen, loadBuero, notizLiveAus } from './buero.js';

// --- Views ------------------------------------------------------------------

const LOADERS = {
  plan: loadPlan, friends: loadFriends, absence: loadAbsences,
  chat: loadChat, homework: loadHomework, profile: loadProfile, admin: loadAdmin,
  tickets: loadTickets, buero: loadBuero,
};

// Die zuletzt geöffnete Ansicht merken - nach dem Neuladen (oder beim Start der installierten
// App) landet man sonst immer wieder auf dem Plan, egal wo man war.
const VIEW_KEY = 'view';

// Die Unterreiter der Ansichten, die welche haben - fuer Menuepunkte wie 'homework/kalender'.
const UNTERREITER = { homework: hwReiterSetzen, profile: profilReiterSetzen, chat: chatReiterSetzen, admin: adminReiterSetzen,
  buero: bueroReiterSetzen };

export function show(view, sub) {
  if (!LOADERS[view] || (view === 'admin' && !state.me?.is_admin)) view = 'plan';
  if (view !== 'chat') clearInterval(chatTimer); // nicht im Hintergrund weiterfragen
  if (view !== 'buero') notizLiveAus();          // ebenso die Live-Leitung der Notizen
  if (view === 'plan') starteJetzt(); else stoppeJetzt();
  if (sub) UNTERREITER[view]?.(sub);
  markiere(sub ? `${view}/${sub}` : view);
  $$('section[data-panel]').forEach(s => (s.hidden = s.dataset.panel !== view));
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* Privatmodus */ }
  LOADERS[view]().catch(oops);
}
setzeOeffner(seite => show(...seite.split('/')));

// Die Widgets der Android-App oeffnen die App direkt im Chat oder bei den Hausaufgaben: als
// #chat, #homework usw. in der Adresse. Der Hash gewinnt ueber die gemerkte Ansicht und wird
// danach entfernt - ein Neuladen soll nicht wieder dorthin springen. Er bleibt stehen, bis
// startAnsicht() ihn liest, also auch ueber den Login hinweg.
function hashAnsicht() {
  const view = location.hash.slice(1);
  if (!view) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return LOADERS[view] && (view !== 'admin' || state.me?.is_admin) ? view : null;
}

export function startAnsicht() {
  const ausHash = hashAnsicht();
  if (ausHash) return ausHash;
  let view;
  try { view = localStorage.getItem(VIEW_KEY); } catch { /* Privatmodus */ }
  if (!view || !LOADERS[view]) return 'plan';
  return view === 'admin' && !state.me.is_admin ? 'plan' : view;
}
// Ist die App schon offen, setzt der WebView beim Tipp aufs Widget nur den Hash, ohne Neuladen.
// Noch nicht angemeldet: den Hash stehen lassen - startAnsicht() liest ihn nach dem Login.
addEventListener('hashchange', () => { if (!state.me) return; const view = hashAnsicht(); if (view) show(view); });
$('#raumplanKnopf').onclick = () => raumplanFenster().catch(oops);

// --- Stundenplan ------------------------------------------------------------

// Woche wechseln mit einer kurzen Bewegung in die Richtung, in die es geht. Ohne sie tauscht der
// Plan seinen Inhalt lautlos aus, und man sieht nicht, ob und wohin etwas passiert ist.
//
// Die Animation laeuft WAEHREND geladen wird, nicht davor - sonst wuerde die Bewegung das
// Umblaettern kuenstlich verlangsamen.
function wocheWechseln(richtung) {
  if (!state.week) return;
  state.week = addDays(state.week, richtung * 7);
  const grid = $('#grid');
  grid.classList.remove('rein-links', 'rein-rechts');
  grid.classList.add(richtung > 0 ? 'raus-links' : 'raus-rechts');
  loadPlan()
    .then(() => {
      grid.classList.remove('raus-links', 'raus-rechts');
      // Ohne Uebergang auf die andere Seite setzen ...
      grid.classList.add(richtung > 0 ? 'rein-rechts' : 'rein-links');
      void grid.offsetHeight;   // ... einmal zeichnen lassen, sonst sieht man den Zwischenschritt nie
      // setTimeout statt requestAnimationFrame: rAF laeuft nicht, solange das Fenster nicht
      // gezeichnet wird (anderer Tab, Hintergrund). Der Plan bliebe dann blass und verschoben
      // stehen, bis man zurueckkommt.
      setTimeout(() => grid.classList.remove('rein-links', 'rein-rechts'), 20);
    })
    .catch(err => {
      grid.classList.remove('raus-links', 'raus-rechts');
      oops(err);
    });
}

$('#prevWeek').onclick = () => wocheWechseln(-1);
$('#nextWeek').onclick = () => wocheWechseln(1);
$('#thisWeek').onclick = () => { state.week = null; loadPlan().catch(oops); };

// Wischen statt Knoepfe. Drei Bedingungen, damit die Geste nicht das normale Scrollen kapert:
// mindestens 60 px waagerecht, deutlich mehr waagerecht als senkrecht - und der Plan darf sich
// dabei nicht selbst zur Seite bewegt haben. Ausgeloest wird dieselbe Funktion wie beim Knopf -
// keine zweite Logik, die auseinanderlaufen kann.
{
  let x0 = 0, y0 = 0, zeit = 0, links0 = 0;
  const grid = $('#grid');
  grid.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; zeit = Date.now();
    links0 = grid.scrollLeft;
  }, { passive: true });

  grid.addEventListener('touchend', e => {
    if (!zeit || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    const dauer = Date.now() - zeit;
    zeit = 0;
    // In der vollen Ansicht ist #grid selbst der Scroll-Container (die Tabelle ist breiter als das
    // Handy). Hat er sich waehrend der Geste bewegt, wollte man zum Mittwoch scrollen und nicht in
    // die naechste Woche. Nur wenn nichts gescrollt ist - kompakte Ansicht oder schon am Rand -
    // gilt der Wisch als Wochenwechsel.
    if (grid.scrollLeft !== links0) return;
    // Langsames Ziehen ist meist Scrollen oder ein Versehen, kein Wischen.
    if (dauer > 800 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    wocheWechseln(dx < 0 ? 1 : -1);
  }, { passive: true });
}
$('#whosePlan').onclick = () => planWahl().catch(oops);

// Zurueck zum eigenen Plan. Ohne den Knopf fuehrt der Weg nur ueber die Auswahl - zwei Klicks
// fuer das, was man am haeufigsten will.
// Die Woche bleibt dabei stehen: wer im Plan eines Freundes zwei Wochen vorgeblaettert hat,
// will beim Zurueckwechseln dieselbe Woche sehen - zum Vergleichen. "Heute" setzt zurueck.
$('#meinPlan').onclick = () => {
  if (state.target === state.me.id) return;
  state.target = state.me.id;
  loadPlan().catch(oops);
};

/**
 * Wessen Plan? Ein Fenster mit Suchfeld statt einer Auswahlliste.
 *
 * Auf dem Handy oeffnet ein <select> die Liste des Betriebssystems - ein Suchfeld daneben kann
 * dort niemand benutzen. Deshalb ein eigenes Fenster, auf jeder Breite dasselbe.
 */
async function planWahl() {
  const dlg = $('#planWahl');
  const liste = await friends();
  const treffer = h('div', { className: 'stack wahl-liste' });

  const waehle = id => {
    dlg.close();
    if (id === state.target) return;
    state.target = id;
    loadPlan().catch(oops);
  };

  const zeile = p => h('button', {
    className: 'wahl-zeile' + (p.id === state.target ? ' aktiv' : ''),
    onclick: () => waehle(p.id),
  }, avatarEl(p, 'mini'),
    h('span', { className: 'grow' }, nameOf(p),
      p.id === state.me.id
        ? h('small', { className: 'sub', textContent: 'dein eigener Plan' })
        : h('small', { className: 'sub', textContent: '@' + p.username })));

  const suche = h('input', { type: 'search', placeholder: 'Name suchen …', autocomplete: 'off' });
  const male = () => {
    const q = suche.value.trim().toLowerCase();
    const passt = f => !q || nameOf(f).toLowerCase().includes(q) || String(f.username).toLowerCase().includes(q);
    const ich = { ...state.me, id: state.me.id };
    const meine = passt({ ...ich, username: state.me.username }) || 'mein plan'.includes(q) ? [ich] : [];
    const gefunden = liste.filter(passt);
    // Nach Schule gruppieren, sobald mehr als eine vorkommt - wie in der alten Auswahlliste.
    const schulen = [...new Set(gefunden.map(f => f.school).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'de'));
    treffer.replaceChildren(
      ...meine.map(zeile),
      ...(schulen.length > 1
        ? schulen.flatMap(name => [
          h('p', { className: 'meta wahl-schule', textContent: name }),
          ...gefunden.filter(f => f.school === name).map(zeile)])
        : gefunden.map(zeile)),
      ...(meine.length || gefunden.length ? []
        : [h('p', { className: 'meta', textContent: 'Niemanden gefunden.' })]));
  };
  suche.oninput = male;
  // Enter nimmt den ersten Treffer - dann geht die Auswahl ohne Maus.
  suche.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    treffer.querySelector('.wahl-zeile')?.click();
  };
  male();

  dlg.replaceChildren(
    h('h2', { textContent: 'Wessen Plan?' }),
    suche,
    treffer,
    h('div', { className: 'row end' },
      h('button', { className: 'ghost', textContent: 'Schließen', onclick: () => dlg.close() })));
  dlg.showModal();
  suche.focus();
}

// Kompakte Ansicht: die ganze Woche ohne seitliches Scrollen, Faecher nur als Kuerzel. Auf
// schmalen Displays voreingestellt, die eigene Wahl gewinnt und wird gemerkt.
const COMPACT_KEY = 'compact';
export function compactStart() {
  try {
    const v = localStorage.getItem(COMPACT_KEY);
    if (v !== null) return v === '1';
  } catch { /* Privatmodus */ }
  return matchMedia('(max-width: 700px)').matches;
}
// merken nur beim echten Klick: sonst friert der erste Aufruf die zufaellige Fensterbreite als
// vermeintliche Entscheidung ein, und ein Desktop-Nutzer haengt fuer immer in der Kompaktansicht.
export function setzeKompakt(an, merken = false) {
  state.compact = an;
  if (merken) {
    try { localStorage.setItem(COMPACT_KEY, an ? '1' : '0'); } catch { /* Privatmodus */ }
  }
  $('#compact').textContent = an ? 'Volle Ansicht' : 'Kompakt';
  $('#compact').classList.toggle('an', an);
}
$('#compact').onclick = () => { setzeKompakt(!state.compact, true); if (state.plan) renderPlan(state.plan); };

// Ohne gepflegtes Kuerzel die ersten zwei Buchstaben - besser als gar nichts anzuzeigen.
const abk = s => String(s ?? '').trim().slice(0, 2).toUpperCase();
// Ein selbst gesetztes Kuerzel gewinnt, danach ein aus dem eigenen Namen abgeleitetes - erst
// dann das der Schule. In der kompakten Ansicht ist das die einzige Stelle, an der ueberhaupt
// etwas steht, also soll es das sein, was man erkennt.
const kuerzel = e => e.pref_short || (e.pref_name ? abk(e.pref_name) : null)
  || e.subject_short || abk(e.subject) || abk(e.title) || e.id.slice(0, 4);

export async function friends() {
  if (!state.friends) state.friends = (await api('GET', '/api/friends')).friends;
  return state.friends;
}

// Nur der eigene Plan der zuletzt gesehenen Woche, damit die installierte App auch ohne Netz
// etwas zeigt. Beim Ausloggen wieder weg - auf einem geteilten Handy hat er nichts zu suchen.
export const PLAN_CACHE = 'plan-cache';
const cachePlan = data => {
  try { localStorage.setItem(PLAN_CACHE, JSON.stringify({ at: Date.now(), me: state.me, data })); }
  catch { /* voll oder Privatmodus */ }
};
export function readCache() {
  try { return JSON.parse(localStorage.getItem(PLAN_CACHE) ?? 'null'); }
  catch { return null; }
}
function cachedPlan(userId, week) {
  const c = readCache();
  return c?.data?.owner.id === userId && (!week || c.data.week === week) ? c : null;
}

async function loadPlan() {
  const q = new URLSearchParams();
  if (state.target !== state.me.id) q.set('user', state.target);
  if (state.week) q.set('week', state.week);
  let data;
  try {
    data = await api('GET', '/api/timetable?' + q);
  } catch (err) {
    if (err.offline && state.target === state.me.id) {
      const c = cachedPlan(state.me.id, state.week);
      if (c) {
        state.week = c.data.week;
        renderPlan(c.data);
        toast(`Offline — Stand von ${new Date(c.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`);
        return;
      }
    }
    // Freundschaft weg? Zurück auf den eigenen Plan statt Sackgasse.
    if (state.target === state.me.id) throw err;
    state.target = state.me.id;
    state.friends = null;
    toast(err.message);
    return loadPlan();
  }
  state.week = data.week;
  if (state.target === state.me.id) cachePlan(data);
  // Der Raumplan-Knopf: sobald die Schule einen hat (Admins immer, andere nach der Freigabe).
  raumplanLaden().then(r => { state.raumplanDa = !!r.plan; $('#raumplanKnopf').hidden = !r.plan; }).catch(() => {});

  // Der Knopf sagt, wessen Plan gerade zu sehen ist - die Auswahl steckt im Fenster dahinter.
  const fremd = state.target !== state.me.id;
  $('#whosePlan').textContent = fremd ? nameOf(data.owner) : 'Mein Plan';
  $('#meinPlan').hidden = !fremd;

  renderPlan(data);

  // Der Abgleich mit WebUntis wird angestossen, nicht abgewartet - sonst haenge die ganze Seite
  // an der Antwort der Schule. Deshalb hoechstens zweimal nachladen, wenn im Hintergrund etwas
  // lief.
  //
  // Die Begrenzung ist der Punkt: ohne sie hat sich der Plan endlos alle vier Sekunden neu
  // gebaut, weil im Hintergrund fast immer ein Abgleich lief. Auf dem Handy sah das aus, als
  // haenge die App.
  if (data.syncLaeuft && nachladeReste > 0) { nachladeReste--; nachladen(); }
  else nachladeReste = NACHLADEN_MAX;
}

const NACHLADEN_MAX = 2;
let nachladeReste = NACHLADEN_MAX;
let nachladeUhr = null;
function nachladen() {
  clearTimeout(nachladeUhr);
  nachladeUhr = setTimeout(() => {
    if (!$('section[data-panel="plan"]').hidden) loadPlan().catch(() => {});
  }, 5000);
}

function renderPlan(d) {
  state.plan = d;
  const own = d.owner.id === d.me;
  const kurz = state.compact;
  $('#grid').classList.toggle('compact', kurz);
  $('#grid').classList.toggle('untis', state.me?.plan_stil === 'untis');
  $('#grid').classList.toggle('rund', state.me?.stunden_form === 'rund');
  // Ausfall deutlich (rot hinterlegt, gestrichelt, durchgestrichen) - "klassisch" ist der alte Strich.
  $('#grid').classList.toggle('ausfall-deutlich', state.me?.ausfall_stil !== 'klassisch');
  // Die Zustandsfarben als Variablen am Dokument: Plan und Detailfenster lesen dieselben.
  for (const [k, v] of Object.entries(state.me?.status_farben ?? {}))
    document.documentElement.style.setProperty('--st-' + k.replace('_', '-'), v);
  paintBanner($('#planBanner'), d.owner, own ? 'Dein Stundenplan' : 'Stundenplan');

  if (!d.days.length || !d.periods.length) {
    $('#weekLabel').textContent = '';
    $('#grid').replaceChildren(h('div', { className: 'empty' },
      h('p', { textContent: 'Es sind noch keine Tage oder Stunden angelegt.' }),
      h('p', { className: 'muted small', textContent: 'Ein Admin legt das unter "Admin" fest.' })));
    return;
  }
  $('#weekLabel').textContent = `${dm(d.days[0].date)} – ${dmy(d.days.at(-1).date)}`;
  // Ein neuer Nutzer sah nur ein Gitter voller "+" - ohne Wort, wie er zu seinem Plan kommt.
  $('#planLeer').hidden = !(own && !d.entries.length && !d.days.some(t => d.ferien?.[t.date]));

  const bySlot = new Map(d.entries.map(e => [`${e.day_id}|${e.period_id}`, e]));
  // Abgemeldet ist entweder der ganze Tag (von === null) oder ein Stundenbereich. Nur der ganze
  // Tag faerbt die Spalte; ein Bereich faerbt nur seine Zellen.
  const ab = new Map((d.absences ?? []).map(a => [a.date, a]));
  const ganzerTag = tag => !!ab.get(tag) && !ab.get(tag).von;
  const abInStunde = (tag, nr) => {
    const a = ab.get(tag);
    if (!a) return false;
    return !a.von || (nr >= a.von && nr <= (a.bis ?? a.von));
  };
  const off = { has: tag => ganzerTag(tag) };
  const today = heuteIso();

  // Ohne diesen Hinweis sieht der eigene Plan in einer noch nicht abgeglichenen Woche aus wie ein
  // Fehler - "warum steht da mein alter Plan?".
  const hinweis = d.untisWoche === null && state.target === state.me.id && state.untisAktiv
    ? h('p', { className: 'meta wochenhinweis',
      textContent: 'Für diese Woche liegen noch keine WebUntis-Daten vor — angezeigt wird dein '
        + 'selbst gebauter Plan. Sie werden gerade nachgeladen.' })
    : null;

  $('#grid').replaceChildren(...[hinweis, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { className: 'time' }),
      ...d.days.map(day => h('th', {
        className: [off.has(day.date) && 'off', day.date === today && 'today',
          d.ferien?.[day.date] && 'ferien'].filter(Boolean).join(' '),
        title: d.ferien?.[day.date] || (kurz ? day.name : ''),
      },
        kurz ? day.name.slice(0, 2) : day.name,
        h('small', { textContent: kurz
          ? dm(day.date)
          : dm(day.date)
            + (d.ferien?.[day.date] ? ' · ' + d.ferien[day.date] : '')
            + (off.has(day.date) ? ' · abgemeldet' : '') }))))),
    h('tbody', {}, ...d.periods.map(p => h('tr', {},
      // Kompakt stehen Anfang und Ende ueber und unter der Nummer - ohne sie muss man raten,
      // welche Stunde gerade laeuft, und wann sie vorbei ist.
      h('th', { className: 'time', title: `${p.start_time}–${p.end_time}` },
        ...(kurz
          ? [h('small', { textContent: p.start_time }), String(p.nr),
             h('small', { textContent: p.end_time })]
          : [`${p.nr}.`, h('small', { textContent: `${p.start_time}–${p.end_time}` })])),
      ...d.days.map(day => cell(d, day, p, bySlot.get(`${day.id}|${p.id}`),
        abInStunde(day.date, p.nr), own, d.ferien?.[day.date]))))))]
    .filter(Boolean));

  pruefungsKaesten();
  malJetzt();
}

/**
 * Eine Pruefung ueber mehrere Stunden ist EIN gelber Kasten, nicht drei: liegen zwei Zellen
 * derselben Pruefung untereinander, verliert die obere ihre Unterkante und die untere ihre Oberkante.
 */
function pruefungsKaesten() {
  const zeilen = [...$$('#grid tbody tr')];
  const ids = td => (td?.dataset.pr ? td.dataset.pr.split(',') : []);
  for (let r = 0; r + 1 < zeilen.length; r++) {
    for (let c = 1; c < zeilen[r].cells.length; c++) {
      const oben = zeilen[r].cells[c], unten = zeilen[r + 1].cells[c];
      if (ids(oben).some(id => ids(unten).includes(id))) {
        oben.classList.add('pr-weiter');
        unten.classList.add('pr-fort');
      }
    }
  }
}

// --- Live-Cursor -------------------------------------------------------------
// Ein roter Strich auf der aktuellen Uhrzeit, wie in WebUntis. Er beantwortet zwei Fragen auf
// einmal: wie spaet ist es, und in welcher Stunde sitze ich gerade.

let jetztUhr = null;

const alsMinuten = hhmm => {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Den Strich setzen (oder entfernen).
 *
 * Gerechnet wird nicht ueber die Uhrzeit, sondern ueber die Zeilen: die Zeitachse der Tabelle ist
 * nicht linear, weil Pausen keine eigene Zeile haben. Innerhalb der laufenden Stunde sitzt der
 * Strich anteilig, in einer Pause auf der Kante zwischen den beiden Zeilen.
 */
function malJetzt() {
  const d = state.plan;
  $('#jetzt')?.remove();
  $$('#grid tr.jetzt-stunde').forEach(tr => tr.classList.remove('jetzt-stunde'));
  if (!d?.periods?.length) return;

  // Nur in der Woche, in der wir gerade stehen - sonst zeigte der Strich eine Uhrzeit an einem
  // Tag, den er gar nicht meint.
  const heute = heuteIso();
  if (!d.days.some(t => t.date === heute)) return;

  const jetzt = new Date();
  const min = jetzt.getHours() * 60 + jetzt.getMinutes();
  const zeilen = $$('#grid tbody tr');
  if (zeilen.length !== d.periods.length) return;

  const zeit = d.periods.map(p => ({ von: alsMinuten(p.start_time), bis: alsMinuten(p.end_time) }));
  if (zeit.some(z => z.von === null || z.bis === null || z.bis <= z.von)) return;

  // Vor dem ersten und nach dem letzten Gong gibt es nichts zu zeigen. Ohne diese Schranke saesse
  // nachts um halb eins ein roter Strich an der Oberkante des Plans und behauptete, es sei acht.
  if (min < Math.min(...zeit.map(z => z.von)) || min > Math.max(...zeit.map(z => z.bis))) return;

  let i = zeit.findIndex(z => min >= z.von && min < z.bis);
  let anteil = 1;
  if (i >= 0) {
    anteil = (min - zeit[i].von) / (zeit[i].bis - zeit[i].von);
  } else {
    // In einer Pause: an die Unterkante der Stunde, die gerade vorbei ist.
    i = zeit.reduce((best, z, n) => (z.bis <= min && (best < 0 || z.bis > zeit[best].bis) ? n : best), -1);
    if (i < 0) return;
  }

  const pos = { tr: zeilen[i], anteil, laufend: anteil < 1 };
  if (pos.laufend) pos.tr.classList.add('jetzt-stunde');
  // Drei Darstellungen zur Wahl; die laufende Stunde wird in allen dreien markiert.
  const stil = state.me?.jetzt_stil ?? 'zeit';
  // Absolut im Scroll-Container: so wandert der Strich beim seitlichen Scrollen mit der Tabelle
  // mit, statt stehen zu bleiben.
  const style = [`top:${pos.tr.offsetTop + pos.anteil * pos.tr.offsetHeight}px`];

  // "tag": der Strich laeuft nur durch die heutige Spalte. Die Masse kommen aus deren Kopfzelle -
  // die liegt im selben Bezugssystem, also genuegen offsetLeft und offsetWidth. Ohne heutige
  // Spalte gaebe es ohnehin keinen Strich; der Fall ist weiter oben schon abgefangen.
  if (stil === 'tag') {
    const kopf = $('#grid thead th.today');
    if (!kopf) return;
    style.push(`left:${kopf.offsetLeft}px`, `width:${kopf.offsetWidth}px`, 'min-width:0');
  }

  $('#grid').append(h('div', { id: 'jetzt', className: 'jetzt', style: style.join(';') },
    stil === 'zeit'
      ? h('span', { className: 'jetzt-zeit', textContent:
        `${String(jetzt.getHours()).padStart(2, '0')}:${String(jetzt.getMinutes()).padStart(2, '0')}` })
      : null));
}

export function starteJetzt() {
  clearInterval(jetztUhr);
  jetztUhr = setInterval(() => { if (state.plan) malJetzt(); }, 30_000);
}

export const stoppeJetzt = () => clearInterval(jetztUhr);

// Wer mit drin sitzt, als kleine Gesichterreihe in der Zelle - sagt mehr als eine Zahl.
// Ab vier Personen wird gekuerzt, sonst frisst die Reihe die Zelle auf.
function gesichter(shared, max = 3, titel = 'Mit: ') {
  const reihe = h('span', {
    className: 'faces',
    title: titel + shared.map(s => nameOf(s) + (s.absent ? ' (abgemeldet)' : '')).join(', '),
  });
  // Waere der Rest genau einer, wird er gezeigt: ein "+1" ist so breit wie ein Gesicht und sagt
  // weniger. Gekuerzt wird deshalb erst, wenn wirklich zwei uebrig blieben.
  const zeigen = shared.length === max + 1 ? shared.length : max;
  for (const s of shared.slice(0, zeigen)) {
    const a = avatarEl(s, 'mini');
    if (s.absent) a.classList.add('weg');
    reihe.append(a);
  }
  if (shared.length > zeigen) {
    const mehr = h('span', { className: 'avatar mini mehr', textContent: '+' + (shared.length - zeigen) });
    reihe.append(mehr);
  }
  return reihe;
}

// Warum jemand in dieser Stunde frei hat. Der Grund gehoert dazu: "Freistunde" und "faellt auch
// aus" sind zwei verschiedene Nachrichten.
const FREI_TEXT = { freistunde: 'Freistunde', kein_unterricht: 'kein Unterricht',
  ausfall: 'fällt aus', ohne_lehrer: 'ohne Lehrer' };
const freiText = s => (s.fach && (s.grund === 'ausfall' || s.grund === 'ohne_lehrer'))
  ? `${s.fach} ${FREI_TEXT[s.grund]}`
  : (FREI_TEXT[s.grund] ?? 'frei');

// Freie Zeit ist mehr als die Freistunde: ein Ausfall und eine Vertretung, vor der niemand steht,
// sind es auch. Genau dort wird gezeigt, wer sonst noch frei hat.
const istFreieZeit = entry => !!entry
  && (istFrei(entry) || entry.status === 'cancelled' || ohneLehrer(entry));

/** Ist diese Stunde schon vorbei? Frueherer Tag, oder heute und der Gong ist durch. */
const istVorbei = (day, period) => {
  const heute = heuteIso();
  if (day.date < heute) return true;
  if (day.date !== heute) return false;
  const jetzt = new Date();
  const bis = alsMinuten(period.end_time);
  return bis !== null && bis <= jetzt.getHours() * 60 + jetzt.getMinutes();
};

/**
 * Eine Vertretung, fuer die WebUntis niemanden nennt.
 *
 * Das ist etwas Drittes: kein gewoehnlicher Lehrertausch, aber auch kein Ausfall - die Schule
 * sagt selbst, dass die Stunde stattfindet, man sitzt sie nur ab. Mit demselben Zeichen wie eine
 * normale Vertretung war das nicht zu unterscheiden.
 */
const ohneLehrer = entry => entry?.status === 'irregular' && !entry.teacher;

/** Wer steht davor? Bei einer Vertretung ohne Lehrer wird das ausdruecklich gesagt. */
const lehrerText = entry => {
  if (entry?.teacher) return entry.teacher;
  return ohneLehrer(entry) ? 'ohne Lehrer' : null;
};

/** Ist der Raum getauscht? '' heisst: ja, aber WebUntis nennt den urspruenglichen nicht. */
const raumGetauscht = entry => entry?.room_regulaer != null;
const raumHinweis = entry => raumGetauscht(entry)
  ? 'Raum geändert' + (entry.room_regulaer ? ` (statt ${entry.room_regulaer})` : '')
  : null;

function cell(d, day, period, entry, dayOff, own, ferien) {
  // Entfernt heisst: hier soll nichts stehen. Die Zelle sieht aus wie eine leere, nur ein
  // winziger Punkt verraet, dass hier mal etwas war - sonst findet man den Weg zurueck nicht.
  const weg = istWeg(entry);
  const td = h('td', {
    className: ['slot', entry && !weg && 'filled', weg && 'entfernt',
      istFrei(entry) && 'frei', entry?.auto && 'auto',
      entry?.status === 'cancelled' && 'entfaellt', entry?.status === 'irregular' && 'vertretung',
      ohneLehrer(entry) && 'ohne-lehrer',
      entry?.shared.length && 'shared', entry?.frei?.length && 'frei-auch', dayOff && 'absent',
      entry?.pruefungen?.length && 'pruefung',
      istVorbei(day, period) && 'vorbei',
      ferien && 'ferientag'].filter(Boolean).join(' '),
  });
  // Welche Pruefungen hier liegen - daran erkennt pruefungsKaesten(), was zusammengehoert.
  if (entry?.pruefungen?.length) td.dataset.pr = entry.pruefungen.map(x => x.id).join(',');

  // In den Ferien gibt es nichts einzutragen - ein Plus, das zu einem Eintrag einlaedt, waere
  // hier nur irrefuehrend. Der Name steht einmal oben in der Spalte.
  if (ferien) return td;

  if (weg) {
    if (!own) return td;
    td.append(h('button', {
      title: 'Von dir entfernt — klick zum Zurückholen',
      onclick: () => openDetail(d, day, period, entry, own),
    }));
    return td;
  }

  const frei = istFrei(entry);
  if (!entry && !own) return td;
  if (entry && !frei) {
    // Ton UND Saettigung aus der gewaehlten Farbe: ohne die Saettigung war Grau rot und
    // Pastellrosa sah aus wie Signalrot. Die Helligkeit bleibt beim Design, siehe tonAus.
    const ton = tonAus(entry.pref_color);
    td.style.setProperty('--hue', ton?.h ?? courseHue(entry.id));
    if (ton) td.style.setProperty('--sat', ton.s + '%');
  }

  // Gross das Fach - danach sucht man im Plan. Darunter Lehrer und Raum, ganz klein die Kursnummer.
  // Bei einer Freistunde gibt es weder Lehrer noch Raum noch Nummer zu zeigen.
  // Kompakt: nur Kuerzel und Raum, gemeinsame Stunden als Punkt statt Gesichterreihe.
  // Bei einer Vertretung ohne Lehrer sagt WebUntis damit meist: die Stunde faellt in dieser Form
  // aus, ihr sitzt sie ab. Das gehoert hingeschrieben - eine Zelle, in der nur der Raum steht,
  // sieht aus wie eine ganz normale Stunde.
  const lehrer = lehrerText(entry);
  const raum = entry?.room
    ? h('span', { className: raumGetauscht(entry) ? 'raum-neu' : '', textContent: entry.room })
    : null;
  const offeneHa = (entry?.homework ?? []).filter(x => !x.done).length;
  // Erledigte auf Wunsch weiter zeigen - ausgegraut. Vorgabe: weg ist weg.
  const erledigteHa = state.me?.hw_erledigt_zeigen && !offeneHa
    ? (entry?.homework ?? []).filter(x => x.done).length : 0;
  const haMarker = () => offeneHa ? h('span', { className: 'ha-marker', textContent: '📝' })
    : erledigteHa ? h('span', { className: 'ha-marker erledigt', textContent: '📝', title: 'erledigt' }) : null;
  const pruefungen = entry?.pruefungen ?? [];
  // In einer freien Stunde gewinnt "wer hat auch frei": wer dieselbe Freistunde hat, steht dort
  // ohnehin mit drin, und die anderen kommen dazu. Sonst zeigte die Zelle die kleinere Liste.
  const auchFrei = entry?.frei ?? [];
  const zeigeFrei = istFreieZeit(entry) && auchFrei.length > 0;
  let kids;
  if (!entry) kids = [h('span', { className: 'plus', textContent: '+' })];
  // Wie WebUntis: Lehrer zuerst, dann Fach, dann Raum - und was heute anders ist, hinterlegt.
  else if (state.me?.plan_stil === 'untis' && !state.compact) kids = [
    h('span', { className: 'zeile1' },
      frei ? h('span', { className: 'code', textContent: 'Frei' })
        : h('span', { className: 'lehrer' + (ohneLehrer(entry) ? ' ohne' : entry.status === 'irregular' ? ' neu' : ''),
          textContent: lehrer ?? '–' }),
      zeigeFrei ? gesichter(auchFrei, 3, 'Haben auch frei: ')
        : entry.shared.length ? gesichter(entry.shared)
        : auchFrei.length ? gesichter(auchFrei, 3, 'Haben auch frei: ') : null),
    ...(frei ? [] : [
      h('span', { className: 'code', textContent: kursName(entry) }),
      raum ? h('span', { className: 'sub' }, raum) : null,
      h('span', { className: 'ecke' },
        pruefungen.length ? h('span', { className: 'ha-marker pruefung', textContent: '📕',
          title: pruefungen.map(x => x.titel).join(', ') }) : null,
        haMarker(),
        entry.note ? h('span', { className: 'ha-marker notiz', textContent: '✎' }) : null,
        // Hier gehoert das Zeichen zum Bild: WebUntis setzt es, sobald zur Stunde etwas steht.
        entry.info || entry.lesson_text ? h('span', { className: 'ha-marker info', textContent: 'ℹ' }) : null)]),
  ];
  else if (state.compact) kids = [
    // Vertretung und Ausfall muessen auch hier zu sehen sein. Die vier Ecken sind mit Freunden,
    // Hausaufgabe, Notiz und Schultext belegt - also traegt das Kuerzel selbst die Kennzeichnung.
    // Es ist ohnehin das, worauf man schaut.
    h('span', { className: 'code' + (entry.status === 'irregular' ? ' vertreten' : ''),
      textContent: (ohneLehrer(entry) || (entry.status === 'cancelled' && state.me?.ausfall_stil !== 'klassisch')
        ? '⊘ ' : entry.status === 'irregular' ? '↻ ' : '')
        + (frei ? 'Frei' : kuerzel(entry)) }),
    raum && !frei ? h('span', { className: 'sub' }, raum) : null,
    !zeigeFrei && entry.shared.length ? h('span', { className: 'punkt' }) : null,
    // Wer sonst frei hat, bekommt einen eigenen Punkt - sonst waere er in der kompakten Ansicht
    // gar nicht zu sehen.
    zeigeFrei || (!entry.shared.length && auchFrei.length)
      ? h('span', { className: 'punkt frei-auch' }) : null,
    pruefungen.length ? h('span', { className: 'punkt pruefung' }) : null,
    offeneHa ? h('span', { className: 'punkt ha' }) : erledigteHa ? h('span', { className: 'punkt ha erledigt' }) : null,
    // Drei Ecken, drei Bedeutungen - sonst waere die Notiz in der kompakten Ansicht unsichtbar.
    entry.note ? h('span', { className: 'punkt notiz' }) : null,
    entry.lesson_text && state.me?.zeige_info ? h('span', { className: 'punkt info' }) : null,
  ];
  else kids = [
    h('span', { className: 'zeile1' },
      h('span', { className: 'code', textContent: frei ? 'Frei' : kursName(entry) }),
      entry.status === 'cancelled' ? h('span', { className: 'lage', textContent: 'entfällt' })
        : ohneLehrer(entry) ? h('span', { className: 'lage vertretung', textContent: 'ohne Lehrer' })
        : entry.status === 'irregular' ? h('span', { className: 'lage vertretung', textContent: 'Vertretung' }) : null,
      pruefungen.length ? h('span', { className: 'ha-marker pruefung', textContent: '📕',
        title: pruefungen.map(x => x.titel).join(', ') }) : null,
      haMarker(),
      entry.note ? h('span', { className: 'ha-marker notiz', textContent: '✎' }) : null,
      // Standardmaessig aus: wo an jeder Stunde ein Lehrstoff steht, markiert das Symbol nichts
      // mehr. Wer es will, schaltet es im Profil an.
      entry.lesson_text && state.me?.zeige_info
        ? h('span', { className: 'ha-marker info', textContent: 'ℹ' }) : null,
      zeigeFrei ? gesichter(auchFrei, 3, 'Haben auch frei: ')
        : entry.shared.length ? gesichter(entry.shared)
        : auchFrei.length ? gesichter(auchFrei, 3, 'Haben auch frei: ') : null),
    ...(frei ? [] : [
      lehrer || raum ? h('span', { className: 'sub' },
        lehrer ?? '', lehrer && raum ? ' · ' : '', raum) : null,
      h('span', { className: 'sub nr', textContent: entry.id })]),
  ];

  td.append(h('button', {
    title: [courseLabel(entry),
      raumHinweis(entry),
      entry?.info,
      entry?.lesson_text,
      entry?.note && '✎ ' + entry.note,
      !zeigeFrei && entry?.shared.length && 'Mit: ' + entry.shared.map(nameOf).join(', '),
      auchFrei.length && 'Haben auch frei: '
        + auchFrei.map(f => `${nameOf(f)} (${freiText(f)})`).join(', '),
      offeneHa && `${offeneHa} offene Hausaufgabe${offeneHa > 1 ? 'n' : ''}`,
      erledigteHa && `${erledigteHa} erledigte Hausaufgabe${erledigteHa > 1 ? 'n' : ''}`,
      pruefungen.length && 'Prüfung: ' + pruefungen.map(x => x.titel).join(', '),
      dayOff && 'abgemeldet']
      .filter(Boolean).join('\n'),
    onclick: () => openDetail(d, day, period, entry, own),
  }, kids));
  return td;
}

const tagKurz = iso => new Date(iso + 'T00:00:00Z')
  .toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });

/** Eine Personenzeile im Stundenfenster, die zum Plan der Person fuehrt - dieselbe Woche bleibt. */
function zuPlan(s, li) {
  if (s.id === state.me.id) return li;
  li.classList.add('klick');
  li.title = `Stundenplan von ${nameOf(s)} ansehen`;
  li.append(h('span', { className: 'muted small', textContent: 'Plan ›' }));
  li.onclick = () => {
    $('#detail').close();
    state.target = s.id;
    loadPlan().catch(oops);
  };
  return li;
}

function openDetail(d, day, period, entry, own) {
  const dlg = $('#detail');
  const shared = entry?.shared ?? [];
  const frei = istFrei(entry);
  const body = [
    h('h2', { textContent: !entry ? 'Nichts eingetragen'
      : istWeg(entry) ? 'Entfernt' : frei ? 'Freistunde' : kursName(entry) }),
    entry?.auto ? h('p', { className: 'meta',
      textContent: 'Automatisch, weil zwischen zwei Stunden. Du kannst hier etwas eintragen.' }) : null,
    h('p', { className: 'meta',
      textContent: `${day.name}, ${dmy(day.date)} · ${period.nr}. Stunde ${period.start_time}–${period.end_time}` }),
  ];

  if (entry?.status === 'cancelled' || entry?.status === 'irregular') body.push(
    h('p', { className: 'hinweis ' + entry.status },
      entry.status === 'cancelled' ? 'Diese Stunde entfällt.'
        : ohneLehrer(entry) ? 'Vertretung, aber ohne Lehrer.' : 'Vertretung.',
      entry.info ? ' ' + entry.info : ''));
  // Auch an einer regulaeren Stunde kann ein Hinweis haengen - etwa eine Raumaenderung. Der stand
  // bisher nur bei Ausfall und Vertretung da und war sonst nirgends zu sehen.
  else if (entry?.info) body.push(h('p', { className: 'hinweis', textContent: entry.info }));

  // Was der Lehrer zur Stunde geschrieben hat - Lehrstoff, Notizen, oft die eigentlichen
  // Hausaufgaben. Stand bisher nur bei Ausfall und Vertretung da und war sonst unsichtbar,
  // obwohl genau hier das Interessante steht.
  if (entry?.lesson_text) body.push(
    h('h3', { textContent: 'Von der Schule' }),
    h('p', { className: 'fliesstext', textContent: entry.lesson_text }));

  if (entry && !frei && !istWeg(entry)) body.push(h('dl', {},
    h('dt', { textContent: 'Kurs' }), h('dd', { textContent: entry.title }),
    h('dt', { textContent: 'Kursnummer' }), h('dd', { textContent: entry.id }),
    h('dt', { textContent: 'Lehrer' }),
    h('dd', { textContent: entry.teacher
      ? entry.teacher + (entry.teacher_regulaer && entry.teacher_regulaer !== entry.teacher
        ? ` (statt ${entry.teacher_regulaer})` : '')
      : entry.status === 'irregular' ? 'ohne Lehrer' : '–' }),
    h('dt', { textContent: 'Raum' }),
    h('dd', { className: raumGetauscht(entry) ? 'raum-neu' : '',
      textContent: (entry.room ?? '–')
        + (entry.room_regulaer ? ` (statt ${entry.room_regulaer})`
          : raumGetauscht(entry) ? ' (geändert)' : '') }),
    ...(entry.note
      ? [h('dt', { textContent: 'Notiz' }),
         h('dd', { className: 'fliesstext', textContent: entry.note })]
      : [])));

  // Der Weg dorthin: vom Raum der vorherigen Stunde des Tages zum Raum dieser - beide vorbelegt,
  // beide aenderbar. Nur, wenn die Schule einen Raumplan hat.
  if (entry?.room && state.raumplanDa) {
    const i = d.periods.findIndex(p => p.id === period.id);
    let start = '';
    for (let j = i - 1; j >= 0 && !start; j--) {
      const vorher = d.entries.find(e => e.day_id === day.id && e.period_id === d.periods[j].id);
      if (vorher?.room && !istWeg(vorher) && !istFrei(vorher)) start = vorher.room;
    }
    body.push(h('div', { className: 'row end' }, h('button', {
      className: 'tiny ghost', textContent: 'Weg zum Raum',
      onclick: () => { dlg.close(); raumplanFenster({ start, ziel: entry.room }).catch(oops); },
    })));
  }

  // In einer Freistunde waeren beide Listen dieselben Leute - dort sagt die zweite mehr, weil
  // der Grund dabeisteht.
  if (entry && !istWeg(entry) && !frei) {
    body.push(h('h3', { textContent: own ? 'Freunde in dieser Stunde' : 'Wer noch in dieser Stunde ist' }));
    // Kompakt: der Hinweis steht klein unter dem Namen, "Plan ›" bleibt in der Zeile - vorher
    // rutschte es in eine zweite, und das Fenster wurde lang und breit.
    body.push(shared.length
      ? h('ul', { className: 'list kompakt' }, ...shared.map(s => zuPlan(s, h('li', { className: s.absent ? 'gone' : '' },
          avatarEl(s),
          h('span', { className: 'grow' }, nameOf(s) + (s.id === d.me ? ' (du)' : ''),
            // Bis wann, und - wenn freigegeben - warum.
            s.absent ? h('small', { className: 'frei-status', textContent: 'abgemeldet'
              + (s.abwesend_bis && s.abwesend_bis !== day.date ? ` bis ${tagKurz(s.abwesend_bis)}` : '')
              + (s.grund ? ` · ${s.grund}` : '') }) : null)))))
      : h('p', { className: 'meta', textContent: 'Niemand aus deiner Freundesliste.' }));
  }

  // Freie Zeit: wer aus dem Freundeskreis dann ebenfalls nichts hat - mit dem Grund, denn
  // "Freistunde" und "bei dem faellt auch was aus" sind zwei verschiedene Nachrichten.
  if (istFreieZeit(entry)) {
    const auchFrei = entry.frei ?? [];
    body.push(h('h3', { textContent: own ? 'Haben auch frei' : 'Wer dann auch frei hat' }));
    body.push(auchFrei.length
      ? h('ul', { className: 'list kompakt' }, ...auchFrei.map(s => zuPlan(s, h('li', {},
          avatarEl(s),
          h('span', { className: 'grow' }, nameOf(s), h('small', { className: 'frei-status', textContent: freiText(s) }))))))
      : h('p', { className: 'meta', textContent: 'Sonst hat gerade niemand frei.' }));
  }

  // Pruefungen liegen im Kalender, markieren aber den Plan - eingetragen werden sie deshalb auch
  // von hier aus, mit Stundenbereich statt Uhrzeit. Im Plan eines Freundes stehen seine
  // Pruefungen zum Ansehen da - aendern, loeschen und eintragen nur im eigenen.
  const fremdePruefungen = !own && entry?.pruefungen?.length;
  if (entry && !istWeg(entry) && (own || fremdePruefungen)) {
    const pruefungen = entry.pruefungen ?? [];
    const eigene = pr => own && pr.quelle !== 'untis' && pr.quelle !== 'kurs';
    body.push(h('h3', { textContent: 'Prüfungen' }));
    body.push(pruefungen.length
      ? h('ul', { className: 'list' }, ...pruefungen.map(pr => h('li', {},
        h('span', { className: 'grow' }, pr.titel,
          h('small', { className: 'sub', textContent: [
            stunden(pr.von_stunde, pr.bis_stunde),
            pr.ort ? `Raum ${pr.ort}` : null,
            pr.quelle === 'untis' ? 'von der Schule' : pr.quelle === 'kurs' ? `für den Kurs, von ${pr.von_name}` : null,
          ].filter(Boolean).join(' · ') }),
          pr.text ? h('small', { className: 'sub fliesstext', textContent: pr.text }) : null),
        // Eigene Pruefungen lassen sich aendern wie Hausaufgaben - im selben Fenster wie beim Eintragen.
        !eigene(pr) ? null : h('button', {
          className: 'tiny ghost', textContent: 'Ändern',
          onclick: () => { dlg.close(); terminFenster(pr, { danach: () => loadPlan().catch(oops) }); },
        }),
        !eigene(pr) ? null : h('button', {
          className: 'tiny ghost', textContent: '×', title: 'Prüfung löschen',
          onclick: async () => {
            try {
              await api('DELETE', `/api/kalender/eintraege/${pr.id}`);
              dlg.close();
              await loadPlan();
              rueckgaengig(`„${pr.titel}" gelöscht.`, async () => {
                await api('POST', `/api/kalender/${pr.kalender_id}/eintraege`, eintragFelder(pr));
                await loadPlan();
              });
            } catch (err) { oops(err); }
          },
        }))))
      : h('p', { className: 'meta', textContent: 'Keine Prüfung in dieser Stunde.' }));
    if (own) body.push(h('div', { className: 'row end' }, h('button', {
      className: 'tiny ghost', textContent: '+ Prüfung eintragen',
      onclick: () => {
        dlg.close();
        terminFenster(null, {
          titel: `${kursName(entry)}-Klausur`, pruefung: true,
          von: day.date, von_stunde: period.nr, bis_stunde: period.nr,
          course_id: entry.id, danach: () => loadPlan().catch(oops),
        });
      },
    })));
  }

  // Hausaufgaben zu genau dieser Stunde. Die LISTE gehoert auch in den Plan eines Freundes - zu
  // sehen, was zu einer Stunde aufgegeben ist, ist der Sinn der Sache. Das EINGABEFELD nicht:
  // eingetragen wurde damit ohnehin in den eigenen Plan, nur schien es, als sei nichts passiert.
  if (entry && !frei && !istWeg(entry)) {
    const neu = () => { dlg.close(); loadPlan().catch(oops); };
    body.push(h('h3', { textContent: 'Hausaufgaben' }));
    body.push(entry.homework.length
      ? h('ul', { className: 'list' }, ...entry.homework.map(hw => hwZeile(hw, neu, false)))
      : h('p', { className: 'meta', textContent: 'Keine für diesen Tag.' }));

    // Fuer einen vergangenen Tag waere die Aufgabe schon faellig gewesen - sie verschwand sofort
    // wieder (Aufraeumen nach x Tagen), obwohl "eingetragen" kam.
    if (own && day.date < heuteIso()) {
      body.push(h('p', { className: 'muted small', textContent: 'Der Tag ist vorbei – neue Hausaufgaben trägst du an der nächsten Stunde ein.' }));
    } else if (own) {
      const feld = h('input', { maxLength: 500, placeholder: 'Neue Aufgabe …' });
      feld.onkeydown = e => { if (e.key === 'Enter') speichern.click(); };
      const speichern = h('button', {
        className: 'tiny primary', textContent: 'Eintragen',
        onclick: async () => {
          if (!feld.value.trim()) return feld.focus();
          try {
            // Slot mitgeben: aus dem Plan heraus ist genau bekannt, welche Stunde gemeint ist.
            // Das trennt zwei Jahrgaenge, die sich eine Kurs-ID teilen.
            const hw = await api('POST', '/api/homework', {
              course_id: entry.id, due_date: day.date, text: feld.value,
              day_id: day.id, period_id: period.id,
            });
            malHwBadge();
            neu();
            rueckgaengig('Hausaufgabe eingetragen.', async () => {
              await api('DELETE', `/api/homework/${hw.id}`); malHwBadge(); await loadPlan();
            });
          } catch (err) { oops(err); }
        },
      });
      body.push(h('div', { className: 'row' }, feld, speichern));
    }
  }

  const buttons = [];

  // Die Notiz haengt am Slot, nicht am Eintrag - sie bleibt deshalb auch bedienbar, wenn die
  // Stunde aus WebUntis kommt und der Kurs selbst nicht geaendert werden soll.
  const notiz = own && entry && !istWeg(entry)
    ? h('input', { maxLength: 300, placeholder: 'z. B. Buch mitbringen', value: entry?.note ?? '' })
    : null;

  // Rueckgaengig fuer alles, was PUT /api/entry aendert: eine selbst gesetzte Stunde (auch eine
  // "entfernte") kommt mit ihren Werten zurueck, alles andere (WebUntis, Freistunde, leer) heisst
  // "kein eigener Eintrag". Die Notiz haengt am Slot und kommt getrennt zurueck.
  const alteNotiz = entry?.note ?? '';
  const stundeZurueck = async (mitNotiz = false) => {
    await api('PUT', '/api/entry', entry?.source === 'manuell'
      ? { day_id: day.id, period_id: period.id, course_id: entry.id, room_id: entry.room_id ?? null, vorrang: !!entry.vorrang }
      : { day_id: day.id, period_id: period.id, course_id: null });
    if (mitNotiz) await api('PUT', '/api/note', { day_id: day.id, period_id: period.id, text: alteNotiz });
    await loadPlan();
  };

  // Kommt die Stunde aus WebUntis, wird sie beim naechsten Abgleich sonst wieder ueberschrieben.
  // Ersetzen heisst deshalb: eigenen Eintrag mit Vorrang - und der gilt fuer jede Woche, nicht
  // nur fuer die gerade sichtbare.
  const ausUntis = own && entry?.source === 'untis';
  let ersetzen = own && entry?.vorrang === true && !istWeg(entry);

  // Die Erklaerung steht hinter einem ⓘ neben den Knoepfen, die sie erklaert - vorher nahm der
  // Absatz bei jeder WebUntis-Stunde drei Zeilen weg. Antippen statt Hover: auf dem Handy gibt
  // es kein Hover.
  let erklaerung = null;
  if (ausUntis && !ersetzen) {
    erklaerung = h('p', { className: 'meta erklaerung', hidden: true,
      textContent: 'Diese Stunde kommt aus WebUntis. Stimmt sie nicht, kannst du sie dauerhaft '
        + 'ersetzen oder ganz entfernen — für alle Wochen, nicht nur für diese.' });
    const info = h('button', { type: 'button', className: 'tiny info-rund', textContent: 'i',
      title: 'Was heißt das?', onclick: () => {
        erklaerung.hidden = !erklaerung.hidden;
        info.setAttribute('aria-expanded', String(!erklaerung.hidden));
      } });
    info.setAttribute('aria-expanded', 'false');
    info.setAttribute('aria-label', 'Erklärung zu Dauerhaft ersetzen und Stunde entfernen');
    buttons.push(info);
    buttons.push(h('button', {
      textContent: 'Dauerhaft ersetzen',
      onclick: () => { ersetzen = true; openDetail(d, day, period, { ...entry, vorrang: true }, own); },
    }));
    buttons.push(h('button', {
      textContent: 'Stunde entfernen',
      onclick: async () => {
        try {
          await api('PUT', '/api/entry',
            { day_id: day.id, period_id: period.id, course_id: WEG, vorrang: true });
          dlg.close();
          await loadPlan();
          rueckgaengig('Stunde entfernt.', () => stundeZurueck());
        } catch (err) { oops(err); }
      },
    }));
  }

  if (own && istWeg(entry)) {
    body.push(h('p', { className: 'hinweis',
      textContent: 'Du hast diese Stunde entfernt. Sie bleibt leer, auch wenn WebUntis sie weiter '
        + 'liefert — in jeder Woche.' }));
  }

  if (own && entry?.vorrang) {
    body.push(h('p', { className: 'hinweis',
      textContent: 'Du hast diese Stunde selbst gesetzt — WebUntis überschreibt sie nicht mehr.' }));
    buttons.push(h('button', {
      className: 'ghost', textContent: 'WebUntis wieder übernehmen',
      onclick: async () => {
        try {
          await api('PUT', '/api/entry', { day_id: day.id, period_id: period.id, course_id: null });
          dlg.close();
          await loadPlan();
          rueckgaengig('WebUntis wieder übernommen.', () => stundeZurueck());
        } catch (err) { oops(err); }
      },
    }));
  }

  if (own && !istWeg(entry) && (!ausUntis || ersetzen)) {
    // Zwei Schritte: erst das Fach, dann nur dessen Kurse. Eine Liste mit allen Kursen der Schule
    // wird sonst schnell unuebersichtlich.
    const echte = state.courses.filter(c => !istFrei(c));
    const OHNE = ' ohne';
    const faecher = [...new Map(echte.map(c => [c.subject ?? OHNE, c.subject])).entries()]
      .sort((a, b) => String(a[1] ?? 'ZZZ').localeCompare(String(b[1] ?? 'ZZZ'), 'de'));

    const fach = h('select', {},
      h('option', { value: '', textContent: '— nichts eintragen —' }),
      h('option', { value: FREI, textContent: 'Frei (Freistunde)', selected: frei }),
      ...faecher.map(([wert, name]) => h('option', {
        value: wert,
        textContent: name ?? 'Ohne Fach',
        selected: !frei && entry != null && (entry.subject ?? OHNE) === wert,
      })));

    const kurs = h('select', {});
    const kursFeld = h('label', { className: 'field' }, 'Kurs', kurs);
    const fuelleKurse = () => {
      const gewaehlt = echte
        .filter(c => (c.subject ?? OHNE) === fach.value)
        .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b), 'de'));
      kurs.replaceChildren(...gewaehlt.map(c => h('option', {
        value: c.id,
        textContent: [c.teacher, c.id].filter(Boolean).join(' — ') || c.title,
        selected: c.id === entry?.id,
      })));
      kursFeld.hidden = !gewaehlt.length;
    };

    // Raum pro Eintrag: derselbe Kurs kann an anderen Tagen woanders stattfinden.
    const raum = h('select', {},
      h('option', { value: '', textContent: '— kein Raum —' }),
      ...state.rooms.map(r => h('option', { value: r.id, textContent: r.name, selected: r.id === entry?.room_id })));
    const raumFeld = h('label', { className: 'field' }, 'Raum', raum);

    // Eine Freistunde hat keinen Raum und keinen Kurs.
    const sync = () => {
      const leer = !fach.value;
      const istFreiWahl = fach.value === FREI;
      kursFeld.hidden = leer || istFreiWahl;
      if (!kursFeld.hidden) fuelleKurse();
      raumFeld.hidden = leer || istFreiWahl;
    };
    fach.onchange = sync;
    sync();

    body.push(h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Fach', fach), kursFeld, raumFeld));

    buttons.push(h('button', {
      className: 'primary',
      textContent: 'Speichern',
      onclick: async () => {
        const course_id = !fach.value ? null : fach.value === FREI ? FREI : kurs.value || null;
        try {
          await api('PUT', '/api/entry', {
            day_id: day.id, period_id: period.id, course_id, room_id: raum.value || null,
            vorrang: ersetzen,
          });
          if (notiz) await api('PUT', '/api/note',
            { day_id: day.id, period_id: period.id, text: notiz.value });
          dlg.close();
          await loadPlan();
          rueckgaengig(course_id ? 'Stunde gespeichert.' : 'Stunde entfernt.', () => stundeZurueck(!!notiz));
        } catch (err) { oops(err); }
      },
    }));
  }
  if (notiz) {
    body.push(h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Notiz (nur für dich)', notiz)));
    // Ohne Kurs-Block gibt es sonst keinen Weg, die Notiz zu speichern.
    if (ausUntis && !ersetzen) buttons.push(h('button', {
      className: 'primary', textContent: 'Notiz speichern',
      onclick: async () => {
        try {
          await api('PUT', '/api/note', { day_id: day.id, period_id: period.id, text: notiz.value });
          dlg.close();
          await loadPlan();
          rueckgaengig('Notiz gespeichert.', async () => {
            await api('PUT', '/api/note', { day_id: day.id, period_id: period.id, text: alteNotiz });
            await loadPlan();
          });
        } catch (err) { oops(err); }
      },
    }));
  }

  buttons.push(h('button', { className: 'ghost', textContent: 'Schließen', onclick: () => dlg.close() }));

  // Die ⓘ-Erklaerung direkt ueber der Knopfzeile - dort, wo man gerade hinschaut.
  dlg.replaceChildren(...body.filter(Boolean), ...(erklaerung ? [erklaerung] : []), h('div', { className: 'row end' }, ...buttons));
  dlg.showModal();
}
