// --- menue ---
// Die obere Leiste aus dem eigenen Menue des Nutzers: Seiten und Gruppen mit Seiten darin (eine
// Ebene Untermenue). Welche Seite geoeffnet wird, sagt diese Datei plan.js ueber den Oeffner -
// sie selbst kennt keine Ansichten und importiert nur kern.js, damit kein Ring entsteht.
import { $, h, scrollHinweis, state } from './kern.js';

// Alle Seiten: Beschriftung und Symbol. Ein Unterreiter traegt seine Ansicht im Namen
// ('homework/kalender'), so weiss show(), was zu oeffnen ist. Die Liste muss mit SEITEN in
// index.js uebereinstimmen - der Server laesst nur das ins Menue, was er kennt.
export const SEITEN = {
  plan: ['Plan', '🗓️'], friends: ['Freunde', '👥'], chat: ['Chat', '💬'],
  homework: ['ToDo & Prüfungen', '📝'], buero: ['Büro', '🗂️'], profile: ['Profil', '👤'], absence: ['Abmeldung', '🚫'],
  tickets: ['Vorschläge & Bugs', '🐞'], admin: ['Admin', '⚙️'],
  'chat/dm': ['Direktnachrichten', '💬'], 'chat/gruppen': ['Gruppenchats', '👥'], 'chat/kurs': ['Kurschats', '🏫'],
  'homework/hausaufgaben': ['Hausaufgaben', '📝'], 'homework/todos': ['ToDo', '☑️'],
  'homework/kalender': ['Kalender', '📅'], 'homework/nachrichten': ['Nachrichten', '📰'],
  'buero/notizen': ['Notizen', '🗒️'], 'buero/ideen': ['Ideenbaum', '💡'],
  'buero/abstimmungen': ['Abstimmungen', '🗳️'], 'buero/umfragen': ['Umfragen', '📋'],
  'profile/profil': ['Mein Profil', '👤'], 'profile/ansicht': ['Ansicht', '🎨'],
  'profile/kurse': ['Kurse', '📚'], 'profile/nachrichten': ['Benachrichtigungen', '🔔'],
  'profile/konto': ['Konto', '🔑'], 'profile/menue': ['Menü', '☰'],
  'admin/raster': ['Admin: Stundenraster', '⚙️'], 'admin/stamm': ['Admin: Stammdaten', '⚙️'],
  'admin/nutzer': ['Admin: Nutzer', '⚙️'], 'admin/system': ['Admin: System', '⚙️'],
  'admin/texte': ['Admin: Texte', '⚙️'], 'admin/raumplan': ['Admin: Raumplan', '🗺️'],
};
export const beschriftung = s => SEITEN[s]?.[0] ?? s;
const ansichtVon = s => s.split('/')[0];

let oeffne = () => {};
export const setzeOeffner = fn => (oeffne = fn);

let aktuell = 'plan';          // die zuletzt geoeffnete Seite
let gruppeGewaehlt = null;     // Index der zuletzt angeklickten Gruppe
const zuletzt = {};            // Gruppenindex -> Kind, das dort zuletzt offen war

// Leere Gruppen gibt es (im Editor), im Menue stehen sie nicht.
const eintraege = () => (state.me?.menue ?? []).filter(e => typeof e === 'string' || e.kinder?.length);
const kinder = e => (typeof e === 'string' ? [e] : e.kinder);
// 'homework' deckt 'homework/kalender' mit ab und umgekehrt: dieselbe Ansicht.
const passt = (a, b) => a === b || ansichtVon(a) === ansichtVon(b);

// Ein Knopf der Leiste. Der Name bleibt immer als Titel und aria-label erhalten - ein blosses
// Emoji sagt weder einem Screenreader noch jemandem, der es nicht kennt, irgendetwas.
// Jeder Punkt traegt sein Piktogramm; "Nur Symbole" laesst den Text weg.
function knopf(label, icon, seiten) {
  const symbole = state.me?.nav_style === 'icons';
  const b = h('button', { type: 'button', className: symbole ? 'nur-symbol' : '', title: label },
    h('span', { className: 'nav-icon', textContent: icon }),
    symbole ? null : h('span', { className: 'nav-text', textContent: label }));
  b.setAttribute('aria-label', label);
  const badge = h('span', { className: 'badge-zahl', hidden: true });
  badge.dataset.badge = seiten.join(' ');
  b.append(badge);
  return b;
}

// Eine Gruppe klappt auf (Popover: Esc und ein Klick daneben schliessen es von selbst) und zeigt
// ihre Seiten samt roten Zahlen. Ohne Popover-Unterstuetzung (alte Browser) oeffnet sie wie frueher
// die zuletzt offene Seite der Gruppe.
let aufGruppe = null;
function aufklappen(e, i, b, ev) {
  const pop = $('#menueAufklapp');
  const offen = pop.matches(':popover-open');
  // Dieselbe Gruppe noch einmal: der Browser schliesst (popovertarget). Eine andere: offen lassen
  // und nur den Inhalt tauschen - sonst braeuchte der Wechsel zwei Klicks.
  if (offen && aufGruppe === i) return;
  if (offen) ev.preventDefault();
  aufGruppe = i;
  pop.replaceChildren(h('strong', { className: 'aufklapp-titel', textContent: e.name }), ...e.kinder.map(k => {
    const [label, icon] = SEITEN[k] ?? [k, ''];
    const badge = h('span', { className: 'badge-zahl', hidden: true });
    badge.dataset.badge = k;
    return h('button', { type: 'button', className: passt(k, aktuell) ? 'active' : '',
      onclick: () => { pop.hidePopover(); gruppeGewaehlt = i; oeffne(k); } },
    h('span', { className: 'symbol', textContent: icon }), h('span', { textContent: label }), badge);
  }));
  // Unter den Knopf, nicht ueber den Rand hinaus. Auf dem Handy (modern) liegt es per CSS als Blatt unten.
  const r = b.getBoundingClientRect();
  pop.style.setProperty('--x', `${Math.max(8, Math.min(r.left, innerWidth - 248))}px`);
  pop.style.setProperty('--y', `${r.bottom + 6}px`);
  malBadges();
}

export function paintNav() {
  const nav = $('header nav');
  const pop = $('#menueAufklapp');
  const mitPopover = typeof pop?.showPopover === 'function';
  nav.replaceChildren(...eintraege().map((e, i) => {
    const gruppe = typeof e !== 'string';
    const b = gruppe ? knopf(e.name, e.icon, e.kinder) : knopf(...(SEITEN[e] ?? [e, '']), [e]);
    if (gruppe && mitPopover) {
      b.popoverTargetElement = pop;
      b.onclick = ev => aufklappen(e, i, b, ev);
    } else b.onclick = () => {
      gruppeGewaehlt = gruppe ? i : null;
      oeffne(gruppe ? (zuletzt[i] ?? e.kinder[0]) : e);
    };
    return b;
  }), burgerKnopf());
  markiere(aktuell);
}

// --- Das Seitenmenue (☰) ----------------------------------------------------------------------
// Drei Striche am Ende der Leiste: ein Menue faehrt von der Seite herein, mit ALLEN Hauptpunkten.
// Ein Pfeil klappt die Unterpunkte eines Punktes auf und zu. So steht oben nur der Alltag, und
// der Rest ist trotzdem mit zwei Tipps erreichbar.
const HAUPT = ['plan', 'homework', 'tickets', 'chat', 'friends', 'buero', 'absence', 'profile', 'admin'];
const hauptpunkte = () => HAUPT.filter(s => s !== 'admin' || state.me?.is_admin);
const unterpunkte = s => Object.keys(SEITEN).filter(k => k.startsWith(`${s}/`));
const auf = new Set();   // aufgeklappte Hauptpunkte - bleibt beim naechsten Oeffnen so

function burgerKnopf() {
  // Die Zahl am ☰: alles, was nicht schon als eigener Knopf in der Leiste steht.
  const inLeiste = new Set(eintraege().flatMap(kinder).map(ansichtVon));
  const b = knopf('Menü', '', hauptpunkte().filter(s => !inLeiste.has(s)));
  b.classList.add('burger');
  b.querySelector('.nav-icon').replaceChildren(h('span', { className: 'striche' }));
  b.onclick = seitenmenue;
  return b;
}

function seitenmenue() {
  const d = $('#menueSeite');
  const zeile = s => {
    const [label, icon] = SEITEN[s] ?? [s, ''];
    const unter = unterpunkte(s);
    const badge = h('span', { className: 'badge-zahl', hidden: true });
    badge.dataset.badge = s;
    const link = h('button', { type: 'button', className: 'sm-link' + (ansichtVon(aktuell) === s ? ' active' : ''),
      onclick: () => { d.close(); gruppeGewaehlt = null; oeffne(s); } },
    h('span', { className: 'nav-icon', textContent: icon }), h('span', { className: 'grow', textContent: label }), badge);
    if (!unter.length) return h('li', {}, h('div', { className: 'sm-zeile' }, link));
    const liste = h('ul', { className: 'sm-unter', hidden: !auf.has(s) }, ...unter.map(k => {
      const [ul, ui] = SEITEN[k];
      const ub = h('span', { className: 'badge-zahl', hidden: true });
      ub.dataset.badge = k;
      return h('li', {}, h('button', { type: 'button', className: 'sm-link klein' + (aktuell === k ? ' active' : ''),
        onclick: () => { d.close(); gruppeGewaehlt = null; oeffne(k); } },
      h('span', { className: 'nav-icon', textContent: ui }), h('span', { className: 'grow', textContent: ul.replace(/^Admin: /, '') }), ub));
    }));
    const pfeil = h('button', { type: 'button', className: 'sm-pfeil', title: 'Unterpunkte', textContent: '›',
      onclick: () => {
        liste.hidden = !liste.hidden;
        liste.hidden ? auf.delete(s) : auf.add(s);
        pfeil.setAttribute('aria-expanded', String(!liste.hidden));
      } });
    pfeil.setAttribute('aria-expanded', String(!liste.hidden));
    pfeil.setAttribute('aria-label', `Unterpunkte von ${label}`);
    return h('li', {}, h('div', { className: 'sm-zeile' }, link, pfeil), liste);
  };
  // Der Punkt, auf dem man gerade steht, ist aufgeklappt.
  if (unterpunkte(ansichtVon(aktuell)).length) auf.add(ansichtVon(aktuell));
  d.replaceChildren(h('h2', { textContent: 'Menü' }), h('ul', { className: 'sm-liste' }, ...hauptpunkte().map(zeile)));
  d.showModal();
  malBadges();
}

/** Nach show(): den passenden Eintrag hervorheben und die Unterleiste seiner Gruppe zeigen. */
export function markiere(seite) {
  aktuell = seite;
  const liste = eintraege();
  // Erst die angeklickte Gruppe, dann ein genauer Treffer, dann dieselbe Ansicht.
  let idx = gruppeGewaehlt != null && liste[gruppeGewaehlt]
    && kinder(liste[gruppeGewaehlt]).some(k => passt(k, seite)) ? gruppeGewaehlt : -1;
  if (idx < 0) idx = liste.findIndex(e => kinder(e).includes(seite));
  if (idx < 0) idx = liste.findIndex(e => kinder(e).some(k => passt(k, seite)));
  [...$('header nav').children].forEach((b, i) => b.classList.toggle('active', i === idx || (idx < 0 && b.classList.contains('burger'))));
  // Auf dem Handy scrollt die Leiste: der aktive Eintrag soll zu sehen sein.
  $('header nav').children[idx]?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });

  const e = liste[idx];
  const unter = $('#unterMenue');
  if (!e || typeof e === 'string') { unter.hidden = true; unter.replaceChildren(); malBadges(); return; }
  const kind = e.kinder.find(k => k === seite) ?? e.kinder.find(k => passt(k, seite));
  if (kind) zuletzt[idx] = kind;
  unter.replaceChildren(...e.kinder.map(k => {
    const b = knopf(...(SEITEN[k] ?? [k, '']), [k]);
    b.classList.toggle('active', k === kind);
    b.onclick = () => { gruppeGewaehlt = idx; oeffne(k); };
    return b;
  }));
  unter.hidden = false;
  scrollHinweis(unter);
  malBadges();
}

// --- Die roten Zahlen ----------------------------------------------------------
// chat.js holt sie (alle 30 Sekunden und nach Aktionen) und legt sie hier ab; gemalt wird an
// jede Stelle, die die Seite zeigt: Menue, Unterleiste, die Unterreiter der Hausaufgaben. Ein
// Gruppenknopf zeigt die Summe seiner Kinder.
export const zahlen = {};
export function malBadges() {
  for (const s of document.querySelectorAll('[data-badge]')) {
    const n = s.dataset.badge.split(' ').reduce((sum, k) => sum + (zahlen[k] ?? 0), 0);
    s.textContent = n > 99 ? '99+' : String(n);
    s.hidden = !n;
  }
}
