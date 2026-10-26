// --- admin ---
// Admin-Bereich mit seinen Reitern und das Info-Fenster hinter der Version.
import {
  $, api, avatarEl, bestaetigen, dmy, eingabe, h, istFrei, kopieren, md, nameOf, oops,
  scrollHinweis, setzeKinder, state, toast,
} from './kern.js';
import { infoDaten, vergissInfo } from './profil.js';
import { ARTEN, GRENZEN, ZUGANG, leererPlan, raumNamen, raumplanLaden, saeubern, svgElement, weg, zeichnen }
  from './raumplan.js';

// --- Admin ------------------------------------------------------------------

const PANELS = [
  { key: 'days', title: 'Tage', editable: true, cascades: true,
    fields: [{ name: 'iso', type: 'number', min: 1, max: 7, placeholder: '1 = Mo … 7 = So' }, { name: 'name', placeholder: 'Montag' }],
    label: r => `${r.name} (Tag ${r.iso})` },
  { key: 'periods', title: 'Stunden & Zeiten', editable: true, cascades: true,
    fields: [{ name: 'nr', type: 'number', min: 1, placeholder: 'Nr.' }, { name: 'start_time', type: 'time' }, { name: 'end_time', type: 'time' }],
    label: r => `${r.nr}. Stunde · ${r.start_time}–${r.end_time}` },
  { key: 'subjects', title: 'Fächer', editable: true,
    fields: [{ name: 'name', placeholder: 'Mathematik' },
             { name: 'short', placeholder: 'Kürzel, z. B. MA', maxLength: 6, optional: true }],
    label: r => r.short ? `${r.name} (${r.short})` : r.name },
  { key: 'teachers', title: 'Lehrer', editable: true, fields: [{ name: 'name', placeholder: 'Frau Müller' }], label: r => r.name },
  { key: 'rooms', title: 'Räume', editable: true, fields: [{ name: 'name', placeholder: 'A213' }], label: r => r.name },
  { key: 'courses', title: 'Kurse', editable: true, cascades: true,
    // Kein Raum am Kurs - den setzt jeder selbst pro Stunde in seinem Plan.
    fields: [{ name: 'id', placeholder: 'Q1GEG06' }, { name: 'title', placeholder: 'Geschichte GK' },
             { name: 'subject_id', src: 'subjects', placeholder: 'Fach …' },
             { name: 'teacher_id', src: 'teachers', placeholder: 'Lehrer …' }],
    label: r => [r.id + ' — ' + r.title, r.subject, r.teacher].filter(Boolean).join(' · ') },
];

// Zehn Karten untereinander waren nicht mehr zu ueberblicken. Eine Reiterzeile, immer nur eine
// Gruppe sichtbar - die Wahl wird gemerkt wie die zuletzt geoeffnete Ansicht.
const ADMIN_GRUPPEN = [
  { key: 'raster', titel: 'Stundenraster', panels: ['days', 'periods'] },
  { key: 'stamm', titel: 'Stammdaten', panels: ['subjects', 'teachers', 'rooms', 'courses'] },
  { key: 'nutzer', titel: 'Nutzer', panels: ['__users', '__registration'] },
  { key: 'system', titel: 'System', panels: ['__untis', '__nachrichten', '__sicherung'] },
  // Postfach (Tickets, die in der App bleiben) und - falls genutzt - die Anbindung an VNW.
  { key: 'tickets', titel: 'Tickets', panels: ['__postfach', '__vnw'] },
  { key: 'texte', titel: 'Texte', panels: ['__news', '__privacy', '__hinweis'] },
  { key: 'raumplan', titel: 'Raumplan', panels: ['__raumplan'] },
];
const ADMIN_KEY = 'adminGruppe';
let adminGruppe = 'raster';
try { adminGruppe = localStorage.getItem(ADMIN_KEY) || adminGruppe; } catch { /* Privatmodus */ }
// Von aussen (eigenes Menue): die Gruppe setzen, bevor loadAdmin laeuft.
export function adminReiterSetzen(k) {
  if (!ADMIN_GRUPPEN.some(g => g.key === k)) return;
  adminGruppe = k;
  try { localStorage.setItem(ADMIN_KEY, k); } catch { /* Privatmodus */ }
}

// Ein Textfeld, das sich selbst speichert, mit Vorschau - damit man sieht, was daraus wird,
// bevor es oeffentlich steht. Geschrieben wird Markdown, gerendert wird es ohne HTML.
const MD_HILFE = 'Markdown: # Überschrift, **fett**, *kursiv*, - Aufzählung, [Text](https://…).';

function textPanel(key, titel, hilfe, info) {
  const feld = h('textarea', { rows: 10, value: info?.[key] ?? '' });
  const stand = h('p', { className: 'meta',
    textContent: info?.[`${key}_at`] ? `Zuletzt geändert: ${info[`${key}_at`]} Uhr` : 'Noch nie geändert.' });
  const vorschau = h('div', {}, md(feld.value));
  feld.oninput = () => vorschau.replaceChildren(md(feld.value));

  return h('section', { className: 'card wide' },
    h('h3', { textContent: titel }),
    h('p', { className: 'muted small', textContent: hilfe }),
    h('p', { className: 'muted small', textContent: MD_HILFE }),
    feld,
    h('div', { className: 'row' },
      h('button', {
        className: 'primary', textContent: 'Speichern',
        onclick: async () => {
          try {
            const r = await api('PUT', '/api/settings/text', { key, text: feld.value });
            stand.textContent = `Zuletzt geändert: ${r.at} Uhr`;
            vergissInfo(); // beim naechsten Oeffnen frisch holen
            toast('Gespeichert.', true);
          } catch (err) { oops(err); }
        },
      }),
      stand),
    h('h4', { textContent: 'So sieht es aus' }),
    vorschau);
}

export async function loadAdmin() {
  const [subjects, rooms, teachers, courses, config, users, settings, untis, info] = await Promise.all(
    ['/api/subjects', '/api/rooms', '/api/teachers', '/api/courses', '/api/config', '/api/users',
     '/api/settings', '/api/untis/status', '/api/info'].map(p => api('GET', p)));
  state.courses = courses;
  // Die Freistunde gehoert der App - im Kurs-Panel hat sie nichts verloren. Und Importiertes
  // gehoert WebUntis: der Server liefert die eigenen Untis-Kurse jetzt mit (fuer die Kursauswahl
  // im Plan), aendern laesst sich daran ohnehin nichts - schuetzeFrei weist es ab.
  const rows = {
    subjects, rooms, teachers, days: config.days, periods: config.periods,
    courses: courses.filter(c => !istFrei(c) && !c.from_untis),
  };

  const fest = {
    __registration: () => registrationPanel(settings),
    __untis: () => untisPanel(untis),
    __nachrichten: () => nachrichtenPanel(settings),
    __raumplan: () => raumplanPanel(rooms),
    __vnw: () => vnwPanel(),
    __postfach: () => postfachPanel(),
    __sicherung: () => sicherungPanel(),
    __users: () => usersPanel(users),
    __news: () => textPanel('news', 'Neuigkeiten',
      'Erscheint hinter der Versionsnummer ganz unten.', info),
    __privacy: () => textPanel('privacy', 'Datenschutzerklärung',
      'Ebenfalls hinter der Versionsnummer — und auch ohne Anmeldung lesbar.', info),
    __hinweis: () => textPanel('hinweis', 'Einmalige Nachricht',
      'Erscheint jedem beim nächsten Öffnen als Fenster — einmal. Wer sie weggeklickt hat, '
      + 'sieht sie nicht wieder. Änderst du den Text, ist es eine neue Nachricht und alle sehen '
      + 'sie erneut. Leeres Feld: kein Fenster.', info),
  };

  $('#adminReiter').replaceChildren(...ADMIN_GRUPPEN.map(g => h('button', {
    type: 'button',
    textContent: g.titel,
    className: g.key === adminGruppe ? 'active' : '',
    onclick: () => {
      adminGruppe = g.key;
      try { localStorage.setItem(ADMIN_KEY, g.key); } catch { /* Privatmodus */ }
      loadAdmin().catch(oops);
    },
  })));

  scrollHinweis($('#adminReiter'));

  const gruppe = ADMIN_GRUPPEN.find(g => g.key === adminGruppe) ?? ADMIN_GRUPPEN[0];
  $('#adminPanels').replaceChildren(...gruppe.panels.map(name => fest[name]
    ? fest[name]()
    : panel(PANELS.find(p => p.key === name), rows[name], { subjects, rooms, teachers })));
}

const reload = (method, path, body) => async () => {
  try { await api(method, path, body); await loadAdmin(); } catch (err) { oops(err); }
};

function registrationPanel(s) {
  const mode = h('select', { name: 'registration_mode' },
    ...[['open', 'Offen für alle'], ['key', 'Nur mit Key'], ['off', 'Geschlossen']]
      .map(([v, t]) => h('option', { value: v, textContent: t, selected: s.registration_mode === v })));
  const key = h('input', { value: s.registration_key ?? '', placeholder: 'mindestens 4 Zeichen' });
  const keyField = h('label', { className: 'field' }, 'Key', key);
  // Der Einladungslink traegt den GESPEICHERTEN Key - es wird nichts neu erzeugt, und er ist
  // beliebig oft verwendbar, bis der Key geaendert wird.
  const link = s.registration_key ? `${location.origin}/registrieren?key=${encodeURIComponent(s.registration_key)}` : '';
  const linkFeld = h('input', { value: link, readOnly: true, className: 'grow' });
  const einladung = h('div', { className: 'field' }, 'Einladungslink (Key schon eingetragen)',
    h('div', { className: 'row' }, linkFeld,
      h('button', { type: 'button', className: 'tiny ghost', textContent: 'Kopieren',
        onclick: () => kopieren(link) }),
      navigator.share ? h('button', { type: 'button', className: 'tiny ghost', textContent: 'Teilen',
        onclick: () => navigator.share({ title: 'Stundenplan', text: 'Hier kannst du dir ein Konto anlegen:', url: link }).catch(() => {}) }) : null),
    h('small', { className: 'muted', textContent: 'Beliebig oft verwendbar. Änderst du den Key, gilt der alte Link nicht mehr.' }));
  const sync = () => {
    keyField.hidden = mode.value !== 'key';
    // Nur fuer den gespeicherten Key - ein gerade getippter waere noch nicht gueltig.
    einladung.hidden = mode.value !== 'key' || s.registration_mode !== 'key' || !link;
  };
  mode.onchange = sync;
  sync();
  const form = h('form', { className: 'stack' }, mode, keyField, einladung,
    h('button', { className: 'primary', textContent: 'Speichern' }));
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', { registration_mode: mode.value, registration_key: key.value });
      toast('Registrierung gespeichert.', true);
      await loadAdmin();
    } catch (err) { oops(err); }
  };

  return h('section', { className: 'card' },
    h('h3', { textContent: 'Registrierung' }),
    h('p', { className: 'muted small', textContent: 'Wer darf sich selbst ein Konto anlegen?' }),
    form);
}

// Der Nachrichten-Feed der Schule. Meist meldet WebUntis die Adresse selbst (Heute-Seite,
// "Nachrichten zum Tag"); hier fuer den Fall, dass nicht - oder dass die Schule ihre Nachrichten
// woanders veroeffentlicht.
function nachrichtenPanel(s) {
  const rss = h('input', { value: s.rss_url ?? '', placeholder: 'https://… (optional)' });
  const form = h('form', { className: 'stack' },
    h('label', { className: 'field' }, 'RSS-Feed der Standardschule', rss),
    h('button', { className: 'primary', textContent: 'Speichern' }));
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', { rss_url: rss.value.trim() });
      toast('Gespeichert — beim nächsten Abgleich wird der Feed geholt.', true);
      await loadAdmin();
    } catch (err) { oops(err); }
  };
  return h('section', { className: 'card' },
    h('h3', { textContent: 'Nachrichten der Schule' }),
    h('p', { className: 'muted small', textContent:
      'Erscheinen unter Hausaufgaben/ToDo → Nachrichten: die „Nachrichten zum Tag" aus WebUntis und der RSS-Feed. '
      + 'Die Feed-Adresse meldet WebUntis meist selbst — dann kann das Feld leer bleiben.' }),
    form);
}

// Hier ist nichts einzurichten: die Schule setzt der erste Nutzer, dessen WebUntis-Anmeldung
// klappt. Der Admin braucht nur einen Weg, eine falsch gesetzte Schule wieder loszuwerden.
// Tickets gehen an die VNW-Plattform. Hier steht, wohin und mit welchem Token - der Token wird
// nie zurueckgegeben, das Feld ist deshalb immer leer und "leer" heisst "unveraendert lassen".
function vnwPanel() {
  const karte = h('section', { className: 'card wide' },
    h('h3', { textContent: 'Tickets (VNW)' }),
    h('p', { className: 'muted small', textContent: 'Wird geladen …' }));

  const zeichnen = cfg => {
    const url = h('input', { value: cfg.url ?? '', placeholder: 'https://vnw.example.org' });
    const token = h('input', { type: 'password', placeholder: cfg.token_gesetzt
      ? 'hinterlegt — leer lassen, um ihn zu behalten' : 'vnw_…' });
    // Ankreuzliste statt Auswahlfeld: mehrere Typen duerfen freigegeben sein, und beim Melden
    // waehlt der Schueler aus genau diesen.
    const gewaehlt = new Set((cfg.type_ids ?? []).map(Number));
    const kaesten = (cfg.typen ?? []).map(t => h('input', {
      type: 'checkbox', value: String(t.id), checked: gewaehlt.has(Number(t.id)) }));
    const typFeld = cfg.typen?.length
      ? h('div', { className: 'stack' }, ...cfg.typen.map((t, i) =>
          h('label', { className: 'check' }, kaesten[i], ' ' + t.name)))
      : h('p', { className: 'muted small', textContent:
          'Ticket-Typen erscheinen hier, sobald Adresse und Token gespeichert sind.' });

    const stand = h('p', { className: 'muted small', textContent: cfg.fehler
      ? `VNW meldet: ${cfg.fehler}`
      : cfg.eingerichtet
        ? `Läuft. Jedes Ticket bekommt das Schlagwort „${cfg.tag}"; gemeldet wird als `
          + (cfg.typen ?? []).filter(t => (cfg.type_ids ?? []).includes(t.id))
            .map(t => t.name).join(' oder ') + '.'
        : 'Noch nicht vollständig: Adresse, Token und mindestens ein Ticket-Typ werden gebraucht.' });
    if (cfg.fehler) stand.classList.add('fehler');

    const speichern = h('button', {
      className: 'primary', textContent: 'Speichern und prüfen',
      onclick: async () => {
        speichern.disabled = true;
        try {
          const neu = await api('PUT', '/api/tickets/config', {
            url: url.value, token: token.value,
            type_ids: kaesten.filter(k => k.checked).map(k => Number(k.value)),
          });
          toast(neu.hinweis ?? 'Gespeichert.', !neu.hinweis);
          zeichnen(neu);
        } catch (err) { oops(err); }
        finally { speichern.disabled = false; }
      },
    });

    // Wohin NEUE Tickets gehen. Alte bleiben, wo sie sind - jedes kennt seinen Weg.
    const ziel = h('select', {},
      h('option', { value: 'app', textContent: 'hier in der App (Postfach oben)', selected: cfg.ziel === 'app' }),
      h('option', { value: 'vnw', textContent: 'in VNW', selected: cfg.ziel === 'vnw' }));
    ziel.onchange = async () => {
      try { await api('PUT', '/api/tickets/ziel', { ziel: ziel.value }); cfg.ziel = ziel.value; toast('Gespeichert.', true); }
      catch (err) { oops(err); ziel.value = cfg.ziel; }
    };

    karte.replaceChildren(
      h('h3', { textContent: 'Wohin Tickets gehen' }),
      h('label', { className: 'field' }, 'Neue Tickets landen', ziel),
      h('h4', { textContent: 'VNW (optional)' }),
      h('p', { className: 'muted small', textContent:
        'Aus „Bugs/Vorschläge" wird ein Ticket in VNW. Der Token braucht die Rechte '
        + 'tickets.create und tickets.view; tickets.tags nur, damit das Schlagwort automatisch '
        + 'angelegt werden kann.' }),
      h('div', { className: 'stack' },
        h('label', { className: 'field' }, 'Adresse der VNW-Instanz', url),
        h('label', { className: 'field' }, 'API-Token', token),
        h('div', { className: 'field' },
          h('span', { textContent: 'Erlaubte Ticket-Typen' }), typFeld)),
      h('div', { className: 'row' }, speichern, stand));
  };

  api('GET', '/api/tickets/config').then(zeichnen).catch(err => karte.replaceChildren(
    h('h3', { textContent: 'Tickets (VNW)' }),
    h('p', { className: 'muted small fehler', textContent: err.message })));

  return karte;
}

// Das Postfach: Tickets, die in der App bleiben (ohne VNW). Lesen, antworten, Status setzen -
// der Melder bekommt zu jeder Antwort und jedem neuen Status eine Meldung.
const STATUS_WAHL = [['open', 'Offen'], ['in_progress', 'In Bearbeitung'], ['closed', 'Geschlossen']];
const wann = s => (s ? `${dmy(s.slice(0, 10))} ${s.slice(11, 16)}` : '');

function postfachPanel() {
  const karte = h('section', { className: 'card wide' },
    h('h3', { textContent: 'Postfach' }), h('p', { className: 'muted small', textContent: 'Wird geladen …' }));

  const liste = async () => {
    const tickets = await api('GET', '/api/admin/tickets');
    setzeKinder(karte,
      h('h3', { textContent: 'Postfach' }),
      h('p', { className: 'muted small', textContent: 'Tickets aus „Vorschläge & Bugs", die in der App bleiben. '
        + '● heißt: wartet auf eine Antwort. Wohin neue Tickets gehen, steht in der Karte darunter.' }),
      tickets.length
        ? h('ul', { className: 'list' }, ...tickets.map(t => h('li', { className: t.status === 'closed' ? 'gone' : '' },
            h('button', { type: 'button', className: 'linkknopf grow', onclick: () => zeige(t.id).catch(oops) },
              h('strong', { textContent: (t.wartet ? '● ' : '') + t.title }),
              h('small', { className: 'sub', textContent: [t.type_name, t.von, t.status_text, wann(t.created_at)].filter(Boolean).join(' · ') })))))
        : h('p', { className: 'muted', textContent: 'Noch keine Tickets.' }));
  };

  const zeige = async id => {
    const t = await api('GET', `/api/admin/tickets/${id}`);
    const feld = h('textarea', { rows: 3, maxLength: 4000, placeholder: 'Antwort an den Melder …' });
    const status = h('select', { title: 'Status' },
      ...STATUS_WAHL.map(([v, text]) => h('option', { value: v, textContent: text, selected: t.status === v })));
    status.onchange = async () => {
      try { await api('PUT', `/api/admin/tickets/${id}/status`, { status: status.value }); toast('Status gesetzt.', true); }
      catch (err) { oops(err); status.value = t.status; }
    };
    const senden = h('button', { className: 'primary', textContent: 'Antworten', onclick: async () => {
      if (!feld.value.trim()) return;
      senden.disabled = true;
      try { await api('POST', `/api/admin/tickets/${id}/replies`, { text: feld.value }); toast('Gesendet.', true); await zeige(id); }
      catch (err) { oops(err); senden.disabled = false; }
    } });
    setzeKinder(karte,
      h('div', { className: 'row' },
        h('button', { type: 'button', className: 'tiny ghost', textContent: '← Postfach', onclick: () => liste().catch(oops) }),
        h('span', { className: 'grow' }), status),
      h('h3', { textContent: t.title }),
      h('p', { className: 'meta', textContent: [t.type_name, `von ${t.von}`, wann(t.created_at)].filter(Boolean).join(' · ') }),
      t.text ? h('p', { className: 'fliesstext', textContent: t.text }) : null,
      h('h4', { textContent: t.replies.length ? 'Verlauf' : 'Noch keine Antwort' }),
      ...t.replies.map(r => h('div', { className: 'ticket-antwort' },
        h('p', { className: 'meta', textContent: `${r.name} · ${wann(r.at)}` }),
        h('p', { className: 'fliesstext', textContent: r.text }))),
      h('label', { className: 'field' }, 'Antwort', feld),
      h('div', { className: 'row end' }, senden));
  };

  liste().catch(err => setzeKinder(karte, h('h3', { textContent: 'Postfach' }),
    h('p', { className: 'muted small fehler', textContent: err.message })));
  return karte;
}

// --- Raumplan: der Editor ---------------------------------------------------
// Etagen aus Rechtecken auf einem Kachelraster. Ziehen zeichnet ein Feld mit der gewaehlten Art,
// Klick waehlt eines aus. Alles bleibt im Speicher, bis "Speichern" es an den Server gibt - und
// sichtbar ist der Plan erst fuer alle, wenn der Haken gesetzt ist. Bis dahin sehen ihn nur Admins.
function raumplanPanel(rooms) {
  const karte = h('section', { className: 'card wide' },
    h('h3', { textContent: 'Raumplan' }),
    h('p', { className: 'muted small', textContent:
      'Art wählen, dann mit der Maus ein Rechteck aufziehen. Räume und Treppen brauchen einen Namen — '
      + 'Räume so, wie sie im Stundenplan heißen; Treppen gleichen Namens verbinden die Etagen. '
      + 'Eine Treppe kann „bis" zu einer höheren Etage reichen: dann steht sie auf jeder Etage dazwischen '
      + 'an derselben Stelle (gestrichelt). Die Etagen gehören in der Reihenfolge von unten nach oben — '
      + 'mit ◀ ▶ lassen sie sich umsortieren. '
      + 'Klick auf ein Feld wählt es aus. Wege laufen über Flur, Treppe, Freizeit, Hof und Sport, nie durch Räume.' }),
    h('p', { className: 'muted small', textContent: 'Lade …' }));
  raumplanLaden(true)
    .then(({ plan, frei }) => raumplanEditor(karte, plan ?? leererPlan(), frei, rooms))
    .catch(oops);
  return karte;
}

function raumplanEditor(karte, planStart, freiStart, rooms) {
  let plan = saeubern(planStart);
  let etage = 0, auswahl = -1, pfad = null;
  const werkzeug = { art: 'raum', name: '', gesperrt: false, zugang: 'beide' };
  const undo = [];
  const merke = () => { undo.push(JSON.stringify(plan)); if (undo.length > 20) undo.shift(); auswahl = -1; };
  const et = () => plan.etagen[etage];

  const etagenLeiste = h('div', { className: 'row rp-etagen' });
  const etagenForm = h('div', { className: 'row' });
  const werkzeuge = h('div', { className: 'rp-werkzeuge' });
  const auswahlBox = h('div', { className: 'rp-auswahl' });
  const flaeche = h('div', { className: 'raumplan-flaeche editor', tabIndex: 0 });
  const hinweis = h('p', { className: 'muted small' });
  const frei = h('input', { type: 'checkbox', checked: !!freiStart });
  const raumListe = h('datalist', { id: 'rpAdminRaeume' });
  const namenListe = () => {
    const alle = new Set([...rooms.map(r => r.name), ...raumNamen(plan),
      ...(state.plan?.entries ?? []).map(e => e.room).filter(Boolean)]);
    raumListe.replaceChildren(...[...alle].sort().map(n => h('option', { value: n })));
  };
  const mitListe = f => { f.setAttribute('list', 'rpAdminRaeume'); return f; };

  function maleEtagen() {
    const e = et();
    setzeKinder(etagenLeiste, 
      ...plan.etagen.map((x, i) => h('button', {
        type: 'button', className: 'tiny ' + (i === etage ? 'primary' : 'ghost'), textContent: x.name,
        // Der getestete Weg bleibt beim Etagenwechsel stehen - er fuehrt ja gerade ueber Etagen.
        onclick: () => { etage = i; auswahl = -1; male(); },
      })),
      plan.etagen.length < GRENZEN.etagen ? h('button', {
        type: 'button', className: 'tiny ghost', textContent: '+ Etage',
        onclick: () => {
          merke();
          plan.etagen.push({ name: `Etage ${plan.etagen.length + 1}`, b: e.b, h: e.h, felder: [] });
          etage = plan.etagen.length - 1; male();
        },
      }) : null);
    const name = h('input', { value: e.name, maxLength: 30, className: 'kurz', title: 'Name der Etage' });
    name.onchange = () => { merke(); e.name = name.value.trim() || e.name; male(); };
    const b = h('input', { type: 'number', min: 5, max: GRENZEN.breite, value: e.b, className: 'kurz', title: 'Breite in Kacheln' });
    const hh = h('input', { type: 'number', min: 5, max: GRENZEN.hoehe, value: e.h, className: 'kurz', title: 'Höhe in Kacheln' });
    b.onchange = hh.onchange = () => {
      merke(); e.b = Number(b.value) || e.b; e.h = Number(hh.value) || e.h; plan = saeubern(plan); male();
    };
    // Umsortieren: die Reihenfolge der Etagen ist die von unten nach oben - Treppen zaehlen in ihr.
    const tausche = mit => {
      merke(); [plan.etagen[etage], plan.etagen[mit]] = [plan.etagen[mit], plan.etagen[etage]]; etage = mit; male();
    };
    setzeKinder(etagenForm,
      h('small', { className: 'muted', textContent: 'Etage:' }), name,
      h('button', { type: 'button', className: 'tiny ghost', textContent: '◀', title: 'eine Etage nach unten (vor)',
        disabled: etage === 0, onclick: () => tausche(etage - 1) }),
      h('button', { type: 'button', className: 'tiny ghost', textContent: '▶', title: 'eine Etage nach oben (zurück)',
        disabled: etage === plan.etagen.length - 1, onclick: () => tausche(etage + 1) }),
      h('small', { className: 'muted', textContent: 'Kacheln:' }), b, h('small', { textContent: '×' }), hh,
      plan.etagen.length > 1 ? h('button', {
        type: 'button', className: 'tiny ghost', textContent: 'Etage löschen',
        onclick: async () => {
          if (!await bestaetigen(`Etage „${e.name}" mit allen Feldern löschen?`)) return;
          merke(); plan.etagen.splice(etage, 1); etage = Math.max(0, etage - 1); male();
        },
      }) : null);
  }

  function maleWerkzeuge() {
    const nameFeld = mitListe(h('input', { placeholder: 'Name (Raum, Treppe)', value: werkzeug.name, maxLength: 30 }));
    nameFeld.oninput = () => (werkzeug.name = nameFeld.value);
    const gesperrt = h('input', { type: 'checkbox', checked: werkzeug.gesperrt });
    gesperrt.onchange = () => (werkzeug.gesperrt = gesperrt.checked);
    const zugang = h('select', {}, ...Object.entries(ZUGANG).map(([k, t]) =>
      h('option', { value: k, textContent: t, selected: k === werkzeug.zugang })));
    zugang.onchange = () => (werkzeug.zugang = zugang.value);
    setzeKinder(werkzeuge, 
      ...Object.entries(ARTEN).map(([k, a]) => {
        // Farbe ueber das CSSOM, nicht als style-Attribut: das verbietet die CSP.
        const b = h('button', {
          type: 'button', textContent: a.name, className: 'art' + (k === werkzeug.art ? ' aktiv' : ''),
          onclick: () => { werkzeug.art = k; maleWerkzeuge(); },
        });
        b.style.background = a.farbe;
        return b;
      }),
      nameFeld,
      h('label', { className: 'check' }, gesperrt, ' gesperrt'),
      werkzeug.art === 'treppe' ? zugang : null,
      h('button', {
        type: 'button', className: 'tiny ghost', textContent: 'Rückgängig', disabled: !undo.length,
        onclick: () => { if (undo.length) { plan = JSON.parse(undo.pop()); etage = Math.min(etage, plan.etagen.length - 1); auswahl = -1; male(); } },
      }));
  }

  function maleAuswahl() {
    const f = et().felder[auswahl];
    auswahlBox.hidden = !f;
    if (!f) return;
    const art = h('select', {}, ...Object.entries(ARTEN).map(([k, a]) => h('option', { value: k, textContent: a.name, selected: k === f.art })));
    const name = mitListe(h('input', { value: f.name, maxLength: 30, placeholder: 'Name' }));
    const gesperrt = h('input', { type: 'checkbox', checked: !!f.gesperrt });
    const zugang = h('select', {}, ...Object.entries(ZUGANG).map(([k, t]) => h('option', { value: k, textContent: t, selected: k === f.zugang })));
    // Bis wohin die Treppe reicht: eine der Etagen darueber (oder nur diese).
    const bis = h('select', { title: 'Die Treppe reicht bis zu dieser Etage' },
      ...plan.etagen.slice(etage).map((x, i) => h('option', { value: String(i), selected: i === (f.hoch ?? 0),
        textContent: i ? `bis ${x.name}` : 'nur diese Etage' })));
    const aendern = () => {
      merke(); const g = et().felder[auswahlIndex];
      Object.assign(g, { art: art.value, name: name.value.trim(), gesperrt: gesperrt.checked ? 1 : 0, zugang: zugang.value,
        hoch: art.value === 'treppe' ? Number(bis.value) || 0 : 0 });
      auswahl = auswahlIndex; male();
    };
    const auswahlIndex = auswahl;
    art.onchange = name.onchange = gesperrt.onchange = zugang.onchange = bis.onchange = aendern;
    setzeKinder(auswahlBox, h('div', { className: 'row' },
      h('strong', { textContent: 'Ausgewählt:' }), art, name,
      h('label', { className: 'check' }, gesperrt, ' gesperrt'),
      f.art === 'treppe' ? zugang : null,
      f.art === 'treppe' && plan.etagen.length > etage + 1 ? bis : null,
      h('button', { type: 'button', className: 'tiny ghost', textContent: 'nach vorn',
        onclick: () => { merke(); const [g] = et().felder.splice(auswahlIndex, 1); et().felder.push(g); auswahl = et().felder.length - 1; male(); } }),
      h('button', { type: 'button', className: 'tiny ghost', textContent: 'Löschen (Entf)',
        onclick: () => { merke(); et().felder.splice(auswahlIndex, 1); auswahl = -1; male(); } })));
  }

  function maleFlaeche() {
    const svg = svgElement(zeichnen(plan, etage, pfad, { raster: true }));
    const k = plan.kachel, e = et();
    if (auswahl >= 0 && e.felder[auswahl]) {
      const f = e.felder[auswahl];
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [a, v] of Object.entries({ x: f.x * k, y: f.y * k, width: f.w * k, height: f.h * k,
        fill: 'none', stroke: '#1e90ff', 'stroke-width': 3, 'stroke-dasharray': '6 3' })) r.setAttribute(a, v);
      svg.append(r);
    }
    const zelle = ev => {
      const r = svg.getBoundingClientRect();
      return { x: Math.min(e.b - 1, Math.max(0, Math.floor((ev.clientX - r.left) / r.width * e.b))),
        y: Math.min(e.h - 1, Math.max(0, Math.floor((ev.clientY - r.top) / r.height * e.h))) };
    };
    let start = null, band = null;
    const rechteck = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 });
    svg.onmousedown = ev => { if (ev.button === 0) { start = zelle(ev); ev.preventDefault(); } };
    svg.onmousemove = ev => {
      if (!start) return;
      const rc = rechteck(start, zelle(ev));
      if (!band) { band = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); svg.append(band); }
      for (const [a, v] of Object.entries({ x: rc.x * k, y: rc.y * k, width: rc.w * k, height: rc.h * k,
        fill: ARTEN[werkzeug.art].farbe, 'fill-opacity': .6, stroke: '#1e90ff', 'stroke-width': 2 })) band.setAttribute(a, v);
    };
    svg.onmouseup = ev => {
      if (!start) return;
      const ende = zelle(ev);
      const rc = rechteck(start, ende);
      start = null;
      if (band) { band.remove(); band = null; }
      if (rc.w === 1 && rc.h === 1 && !ev.shiftKey) {
        // Ein Klick: das oberste Feld unter dem Zeiger auswaehlen (oder nichts).
        auswahl = e.felder.findLastIndex(f => rc.x >= f.x && rc.x < f.x + f.w && rc.y >= f.y && rc.y < f.y + f.h);
        pfad = null; male();
        return;
      }
      if (e.felder.length >= GRENZEN.felder) return toast('Zu viele Felder auf dieser Etage.');
      merke();
      e.felder.push({ ...rc, art: werkzeug.art, name: werkzeug.name.trim(), gesperrt: werkzeug.gesperrt ? 1 : 0, zugang: werkzeug.zugang });
      auswahl = e.felder.length - 1;
      pfad = null; male();
    };
    svg.onmouseleave = () => { if (band) { band.remove(); band = null; } start = null; };
    flaeche.replaceChildren(svg);
  }
  flaeche.onkeydown = ev => {
    if (ev.key === 'Delete' && auswahl >= 0) { merke(); et().felder.splice(auswahl, 1); auswahl = -1; male(); }
  };

  function male() { namenListe(); maleEtagen(); maleWerkzeuge(); maleAuswahl(); maleFlaeche(); }

  // Weg testen und speichern.
  const von = mitListe(h('input', { placeholder: 'Start (Raum)' })), nach = mitListe(h('input', { placeholder: 'Ziel (Raum)' }));
  const testen = () => {
    pfad = weg(plan, von.value, nach.value);
    hinweis.textContent = pfad ? `${pfad.length} Schritte` : 'Kein Weg — sind beide Räume da, und führt ein Flur zur Treppe?';
    if (pfad) etage = pfad[0].etage;
    male();
  };
  const speichern = h('button', { type: 'button', className: 'primary', textContent: 'Speichern' });
  speichern.onclick = async () => {
    try {
      const r = await api('PUT', '/api/raumplan', { plan, frei: frei.checked });
      plan = r.plan;
      await raumplanLaden(true);
      toast(frei.checked ? 'Gespeichert — für alle sichtbar.' : 'Gespeichert — nur für Admins sichtbar.', true);
      male();
    } catch (err) { oops(err); }
  };

  setzeKinder(karte, 
    karte.firstChild, karte.children[1],
    etagenLeiste, etagenForm, werkzeuge, auswahlBox, flaeche, raumListe,
    h('div', { className: 'row rp-fuss' },
      h('small', { className: 'muted', textContent: 'Weg testen:' }), von, nach,
      h('button', { type: 'button', className: 'tiny ghost', textContent: 'Weg zeigen', onclick: testen }), hinweis),
    h('div', { className: 'row rp-fuss' },
      h('label', { className: 'check' }, frei, ' Für alle sichtbar (vorher nur Admins — zum Testen)'),
      speichern));
  male();
}

function untisPanel(s) {
  if (!s.moeglich) return h('section', { className: 'card' },
    h('h3', { textContent: 'WebUntis' }),
    h('p', { className: 'muted small fehler', textContent:
      'UNTIS_KEY ist nicht gesetzt. Ohne diesen Schlüssel bleibt die Anbindung abgeschaltet — '
      + 'sonst lägen die WebUntis-Passwörter ungeschützt in der Datenbank.' }));

  const weg = h('button', { className: 'ghost', textContent: 'Schule zurücksetzen' });
  weg.onclick = async () => {
    if (!await bestaetigen(`Schule "${s.school}" zurücksetzen?

Alle gespeicherten WebUntis-Zugänge und `
      + 'abgeglichenen Stunden werden gelöscht. Die selbst gebauten Pläne bleiben.')) return;
    try { await api('DELETE', '/api/untis/school'); toast('Schule zurückgesetzt.', true); }
    catch (err) { oops(err); }
    await loadAdmin();
  };

  return h('section', { className: 'card' },
    h('h3', { textContent: 'WebUntis' }),
    h('p', { className: 'muted small', textContent: s.aktiv
      ? `Schule: ${s.school} (${s.server}). Jeder meldet sich im Profil mit seinem eigenen `
        + 'WebUntis-Zugang an — ein Admin-Zugang bei WebUntis wird nicht gebraucht.'
      : 'Noch keine Schule hinterlegt. Wer sich im Profil als Erster erfolgreich mit seinem '
        + 'WebUntis-Zugang anmeldet, legt sie für alle fest.' }),
    ...(s.aktiv ? [weg] : []));
}

function sicherungPanel() {
  const datei = h('input', { type: 'file', accept: '.db,application/octet-stream', hidden: true });

  datei.onchange = async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!await bestaetigen(`"${f.name}" einspielen?\n\nDie gesamte Datenbank wird ersetzt: alle Nutzer, Pläne, `
      + 'Hausaufgaben und Nachrichten. Die bisherige Datei bleibt als .vorher liegen.')) return;
    try {
      const res = await fetch('/api/backup/restore', {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? `Fehler ${res.status}`);
      toast(d.hinweis ?? 'Übernommen.', true);
      alert(d.hinweis ?? 'Die App muss jetzt neu gestartet werden.');
    } catch (err) { oops(err); }
  };

  return h('section', { className: 'card' },
    h('h3', { textContent: 'Sicherung' }),
    h('p', { className: 'muted small', textContent:
      'Die Sicherung enthält alles: Nutzer, Pläne, Hausaufgaben, Nachrichten und Bilder.' }),
    h('div', { className: 'row' },
      // Kein fetch: der Browser soll die Datei direkt speichern.
      h('a', { className: 'knopf', href: '/api/backup', download: '', textContent: 'Herunterladen' }),
      h('button', { type: 'button', className: 'ghost', textContent: 'Einspielen …', onclick: () => datei.click() }),
      datei),
    h('p', { className: 'muted small', textContent:
      'Nach dem Einspielen muss die App einmal neu gestartet werden — eine laufende Datenbank lässt '
      + 'sich nicht gefahrlos austauschen.' }));
}

function usersPanel(users) {
  const form = h('form', { className: 'row' },
    h('input', { name: 'username', placeholder: 'Username', required: true }),
    h('input', { name: 'password', placeholder: 'Startpasswort', required: true }),
    h('label', { className: 'check' }, h('input', { name: 'is_admin', type: 'checkbox' }), 'Admin'),
    h('button', { className: 'primary', textContent: 'Anlegen' }));

  form.onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/users', {
        username: f.username.value, password: f.password.value, is_admin: f.is_admin.checked,
      });
      toast('Nutzer angelegt.', true);
      await loadAdmin();
    } catch (err) { oops(err); }
  };

  const row = u => h('li', {},
    avatarEl(u),
    h('span', { className: 'grow' }, nameOf(u),
      h('small', { className: 'sub', textContent: '@' + u.username + (u.created_at ? ' · seit ' + dmy(u.created_at.slice(0, 10)) : '') })),
    u.is_admin ? h('span', { className: 'tag', textContent: 'Admin' }) : null,
    h('button', {
      className: 'tiny ghost',
      textContent: u.is_admin ? 'Admin entziehen' : 'Zum Admin machen',
      onclick: reload('PATCH', `/api/users/${u.id}`, { is_admin: !u.is_admin }),
    }),
    h('button', {
      className: 'tiny ghost', textContent: 'Umbenennen',
      onclick: async () => {
        const name = await eingabe(`Neuer Username für ${u.username}:`, u.username);
        if (!name || name === u.username) return;
        try { await api('PATCH', `/api/users/${u.id}`, { username: name }); await loadAdmin(); }
        catch (err) { oops(err); }
      },
    }),
    h('button', {
      className: 'tiny ghost', textContent: 'Passwort', title: 'Passwort zurücksetzen',
      onclick: async () => {
        // Der Chat-Schluessel haengt am Passwort und ist danach weg. Das gehoert vorher gesagt,
        // nicht hinterher entdeckt.
        if (!await bestaetigen(`Passwort für "${u.username}" zurücksetzen?\n\n`
          + 'Der Chat-Verlauf dieses Kontos wird damit endgültig unlesbar — auch für alle, die ihm '
          + 'geschrieben haben. Ein neuer Schlüssel entsteht beim nächsten Anmelden von selbst.')) return;
        const pw = await eingabe(`Neues Passwort für ${u.username}:`, '', { passwort: true });
        if (!pw) return;
        try {
          await api('PATCH', `/api/users/${u.id}`, { password: pw });
          toast(`Passwort für ${u.username} gesetzt. Der Chat fängt für dieses Konto neu an.`, true);
        } catch (err) { oops(err); }
      },
    }),
    h('button', {
      className: 'tiny ghost', textContent: '×', title: 'Löschen',
      onclick: async () => {
        if (!await bestaetigen(`"${u.username}" löschen?\n\nStundenplan, Abmeldungen und Freundschaften verschwinden mit.`)) return;
        try { await api('DELETE', `/api/users/${u.id}`); await loadAdmin(); } catch (err) { oops(err); }
      },
    }));

  return h('section', { className: 'card wide' },
    h('h3', { textContent: 'Nutzer' }), form,
    h('ul', { className: 'list' }, ...users.map(row)));
}

function panel(p, rows, options) {
  const inputs = p.fields.map(({ src, optional, ...attr }) => src
    ? h('select', { name: attr.name }, h('option', { value: '', textContent: attr.placeholder }),
        ...options[src].map(o => h('option', { value: o.id, textContent: o.name })))
    : h('input', { ...attr, required: !optional }));

  const submit = h('button', { className: 'primary', textContent: '+', title: 'Hinzufügen' });
  const cancel = h('button', { type: 'button', className: 'ghost', textContent: 'Abbrechen', hidden: true });
  const form = h('form', { className: 'row' }, ...inputs, submit, cancel);
  let editing = null;
  let list;

  const stopEditing = () => {
    editing = null;
    form.reset();
    submit.textContent = '+';
    submit.title = 'Hinzufügen';
    cancel.hidden = true;
    list?.querySelectorAll('li.editing').forEach(li => li.classList.remove('editing'));
  };
  cancel.onclick = stopEditing;

  const startEditing = (r, li) => {
    stopEditing();
    editing = r.id;
    inputs.forEach(i => (i.value = r[i.name] ?? ''));
    submit.textContent = 'Speichern';
    submit.title = 'Änderung speichern';
    cancel.hidden = false;
    li.classList.add('editing');
    inputs[0].focus();
  };

  form.onsubmit = async e => {
    e.preventDefault();
    const path = `/api/${p.key}` + (editing !== null ? '/' + encodeURIComponent(editing) : '');
    try {
      await api(editing !== null ? 'PUT' : 'POST', path, Object.fromEntries(new FormData(form)));
      toast(editing !== null ? 'Änderung gespeichert.' : 'Angelegt.', true);
      await loadAdmin();
    } catch (err) { oops(err); }
  };

  const row = r => {
    const li = h('li', {}, h('span', { className: 'grow', textContent: p.label(r) }));
    if (p.editable) li.append(h('button', {
      className: 'tiny ghost', textContent: 'Bearbeiten',
      onclick: () => startEditing(r, li),
    }));
    li.append(h('button', {
      className: 'tiny ghost', textContent: '×', title: 'Löschen',
      onclick: async () => {
        const warn = p.cascades ? '\n\nAchtung: betroffene Stundenplan-Einträge aller User verschwinden mit.' : '';
        if (!await bestaetigen(`"${p.label(r)}" löschen?` + warn)) return;
        try { await api('DELETE', `/api/${p.key}/${encodeURIComponent(r.id)}`); await loadAdmin(); }
        catch (err) { oops(err); }
      },
    }));
    return li;
  };

  list = rows.length ? h('ul', { className: 'list' }, ...rows.map(row))
                     : h('p', { className: 'muted small', textContent: 'Noch nichts angelegt.' });
  return h('section', { className: 'card' }, h('h3', { textContent: p.title }), form, list);
}
