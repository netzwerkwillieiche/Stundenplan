// --- freunde ---
// Freunde suchen und verwalten, Abmeldung fuer einzelne Tage.
import { $, WEEKDAY, api, avatarEl, bestaetigen, dmy, h, nameOf, oops, rueckgaengig, state, stunden, toast } from './kern.js';
import { friends, show } from './plan.js';
import { malFreundeBadge } from './chat.js';

// --- Freunde ----------------------------------------------------------------

// Suchen statt exakt tippen: den Username kennt man oft nicht, den Namen schon.
const STAND_TEXT = { freund: 'Schon befreundet', angefragt: 'Anfrage läuft', wartet: 'Wartet auf dich' };

async function freundeSuchen(q) {
  const liste = $('#freundTreffer');
  liste.replaceChildren(h('li', { className: 'muted', textContent: 'Suche läuft …' }));
  let treffer;
  try {
    treffer = await api('GET', '/api/users/search?q=' + encodeURIComponent(q));
  } catch (err) {
    return liste.replaceChildren(h('li', { className: 'muted fehler', textContent: err.message }));
  }
  if (!treffer.length) {
    return liste.replaceChildren(h('li', { className: 'muted', textContent: 'Niemanden gefunden.' }));
  }

  liste.replaceChildren(...treffer.map(u => {
    const senden = h('button', { className: 'tiny primary', textContent: 'Anfrage senden' });
    senden.onclick = async () => {
      try {
        const r = await api('POST', '/api/friends', { username: u.username });
        toast(r.status === 'accepted' ? 'Ihr seid jetzt befreundet.' : 'Anfrage gesendet.', true);
        liste.replaceChildren();
        $('#addFriend').reset();
        state.friends = null;
        await loadFriends();
      } catch (err) { oops(err); }
    };
    return h('li', {}, avatarEl(u),
      h('span', { className: 'grow' }, nameOf(u),
        h('small', { className: 'sub', textContent: '@' + u.username })),
      // Bekannte werden gekennzeichnet statt versteckt - sonst sucht man jemanden und findet ihn
      // scheinbar nicht.
      u.stand ? h('em', { className: 'muted', textContent: STAND_TEXT[u.stand] }) : senden);
  }));
}

$('#addFriend').onsubmit = e => {
  e.preventDefault();
  freundeSuchen(e.target.username.value.trim()).catch(oops);
};

const act = (method, path) => async () => {
  try { await api(method, path); state.friends = null; await loadFriends(); malFreundeBadge(); }
  catch (err) { oops(err); }
};

export async function loadFriends() {
  const d = await api('GET', '/api/friends');
  state.friends = d.friends;

  const group = (title, users, actions) => users.length
    ? [h('h3', { textContent: title }),
       h('ul', { className: 'list' }, ...users.map(u => h('li', {},
         avatarEl(u),
         // @username nur dann, wenn der Anzeigename davon abweicht - sonst steht es doppelt da.
         h('span', { className: 'grow' }, nameOf(u), u.display_name ? h('small', { className: 'sub', textContent: '@' + u.username }) : null),
         ...actions(u))))]
    : [];

  const parts = [
    ...group('Offene Anfragen an dich', d.incoming, u => [
      h('button', { className: 'tiny primary', textContent: 'Annehmen', onclick: act('POST', `/api/friends/${u.id}/accept`) }),
      h('button', { className: 'tiny ghost', textContent: 'Ablehnen', onclick: act('DELETE', `/api/friends/${u.id}`) })]),
    ...group('Von dir gesendet', d.outgoing, u => [
      h('button', { className: 'tiny ghost', textContent: 'Zurückziehen', onclick: act('DELETE', `/api/friends/${u.id}`) })]),
    ...group('Freunde', d.friends, u => [
      h('button', { className: 'tiny ghost', textContent: 'Plan ansehen', onclick: () => { state.target = u.id; show('plan'); } }),
      // Mit Rueckfrage: danach sieht keiner mehr den Plan des anderen, und zurueck geht es nur
      // ueber eine neue Anfrage, die der andere erst annehmen muss.
      h('button', { className: 'tiny ghost', textContent: 'Entfernen', onclick: async () => {
        if (await bestaetigen(`${nameOf(u)} als Freund entfernen? Ihr seht danach gegenseitig keinen Plan mehr und könnt nicht mehr chatten.`))
          await act('DELETE', `/api/friends/${u.id}`)();
      } })]),
  ];
  if (!parts.length) parts.push(h('div', { className: 'empty' },
    h('p', { textContent: 'Noch keine Freunde.' }),
    h('p', { className: 'muted small', textContent: 'Oben einen Username eingeben und eine Anfrage schicken.' })));
  $('#friendLists').replaceChildren(...parts);
}

// --- Abmeldung --------------------------------------------------------------

// "Von" setzt "Bis" gleich mit - ein Tag ist der haeufigste Fall, mehrere aendert man nach hinten.
$('#addAbsence').from.onchange = () => {
  const f = $('#addAbsence');
  if (!f.to.value || f.to.value < f.from.value) f.to.value = f.from.value;
};

$('#addAbsence').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    // Vorher merken, was an diesen Tagen stand: Rueckgaengig stellt je Tag den alten Eintrag
    // wieder her oder nimmt den neuen weg.
    const vorher = new Map(abmeldungen.map(a => [a.date, a]));
    const r = await api('POST', '/api/absences', {
      from: f.from.value, to: f.to.value,
      von_stunde: Number(f.von_stunde.value) || null,
      bis_stunde: Number(f.bis_stunde.value) || null,
      grund: f.grund.value, grund_sichtbar: f.grund_sichtbar.checked,
    });
    bearbeitenEnde();
    await loadAbsences();
    rueckgaengig(`${r.dates.length} Tag(e) abgemeldet` + (r.von ? `, ${stunden(r.von, r.bis)}.` : '.'), async () => {
      for (const d of r.dates) {
        const alt = vorher.get(d);
        if (alt) await api('POST', '/api/absences', abmeldungFelder(alt));
        else await api('DELETE', '/api/absences/' + d);
      }
      await loadAbsences();
    });
  } catch (err) { oops(err); }
};

/** Eine Abmeldung, wie POST sie erwartet - fuer Rueckgaengig. */
const abmeldungFelder = a => ({ from: a.date, to: a.date, von_stunde: a.von, bis_stunde: a.bis,
  grund: a.grund ?? '', grund_sichtbar: !!a.grund_sichtbar });

// Bearbeiten abbrechen: sonst blieb das Formular im "Speichern"-Zustand stehen, ohne Ausweg.
function bearbeitenEnde() {
  const f = $('#addAbsence');
  f.reset();
  f.querySelector('button.primary').textContent = 'Abmelden';
  $('#abwAbbrechen').hidden = true;
}
$('#abwAbbrechen').onclick = bearbeitenEnde;

/** Eine Abmeldung ins Formular holen - gespeichert wird sie ueber denselben Weg (Upsert je Tag). */
function abmeldungBearbeiten(a) {
  const f = $('#addAbsence');
  f.from.value = a.date; f.to.value = a.date;
  f.von_stunde.value = a.von ?? ''; f.bis_stunde.value = a.bis ?? '';
  f.grund.value = a.grund ?? ''; f.grund_sichtbar.checked = !!a.grund_sichtbar;
  f.querySelector('button.primary').textContent = 'Speichern';
  $('#abwAbbrechen').hidden = false;
  f.scrollIntoView({ block: 'center', behavior: 'smooth' });
  f.from.focus();
}

/** Die Stundenauswahl der Abmeldung - leer heisst "ganzer Tag". */
async function fuelleStunden() {
  const f = $('#addAbsence');
  if (f.von_stunde.options.length) return;
  const cfg = await api('GET', '/api/config').catch(() => ({ periods: [] }));
  for (const feld of [f.von_stunde, f.bis_stunde])
    feld.replaceChildren(h('option', { value: '', textContent: '—' }),
      ...cfg.periods.map(p => h('option', { value: String(p.nr), textContent: `${p.nr}.` })));
}

// Vergangenes ist erledigt - wer es sehen will, hakt an. Gemerkt wie "Erledigte anzeigen".
try { $('#abwVergangene').checked = localStorage.getItem('abwVergangene') === '1'; } catch { /* Privatmodus */ }
$('#abwVergangene').onchange = () => {
  try { localStorage.setItem('abwVergangene', $('#abwVergangene').checked ? '1' : '0'); } catch { /* egal */ }
  loadAbsences().catch(oops);
};

// Die zuletzt geholten eigenen Abmeldungen - fuer die Suche und fuer Rueckgaengig.
let abmeldungen = [];
$('#abwSuche').oninput = () => maleAbmeldungen();

export async function loadAbsences() {
  await fuelleStunden();
  abmeldungen = await api('GET', '/api/absences');
  maleAbmeldungen();
  await freundeAbwesend().catch(() => {});
}

function maleAbmeldungen() {
  const heute = new Date().toISOString().slice(0, 10);
  const alle = abmeldungen;
  const q = $('#abwSuche').value.trim().toLowerCase();
  const wochentag = a => WEEKDAY[new Date(a.date + 'T00:00:00Z').getUTCDay()];
  const trifft = a => !q || [wochentag(a), dmy(a.date), a.grund ?? ''].join(' ').toLowerCase().includes(q);
  const tage = ($('#abwVergangene').checked ? alle : alle.filter(a => a.date >= heute)).filter(trifft);
  $('#absenceList').replaceChildren(...(tage.length
    ? tage.map(a => h('li', { className: a.date < heute ? 'gone' : '' },
        h('span', { className: 'grow' },
          `${WEEKDAY[new Date(a.date + 'T00:00:00Z').getUTCDay()]}, ${dmy(a.date)}`,
          h('small', { className: 'sub', textContent: [a.von ? stunden(a.von, a.bis) : 'ganzer Tag',
            a.grund ? `${a.grund} (${a.grund_sichtbar ? 'für Freunde sichtbar' : 'nur für dich'})` : null]
            .filter(Boolean).join(' · ') })),
        h('button', { className: 'tiny ghost', textContent: 'Ändern', onclick: () => abmeldungBearbeiten(a) }),
        h('button', {
          className: 'tiny ghost', textContent: '×', title: 'Abmeldung zurücknehmen',
          onclick: async () => {
            try {
              await api('DELETE', '/api/absences/' + a.date); await loadAbsences();
              rueckgaengig(`Abmeldung am ${dmy(a.date)} zurückgenommen.`, async () => {
                await api('POST', '/api/absences', abmeldungFelder(a)); await loadAbsences();
              });
            } catch (err) { oops(err); }
          },
        })))
    : [h('li', {}, h('span', { className: 'muted', textContent: q ? 'Nichts gefunden.' : alle.length
        ? 'Keine kommenden Abmeldungen.' : 'Keine Abmeldungen.' }))]));
}

/** Wer aus dem Freundeskreis wann fehlt - als Spannen, heute Laufendes mit Plakette. */
async function freundeAbwesend() {
  const spannen = await api('GET', '/api/friends/absences');
  const heute = new Date().toISOString().slice(0, 10);
  const tagKurz = iso => `${WEEKDAY[new Date(iso + 'T00:00:00Z').getUTCDay()].slice(0, 2)} ${dmy(iso).slice(0, 6)}`;
  $('#freundeAbwesend').replaceChildren(...(spannen.length
    ? spannen.map(s => h('li', {
        className: 'klick', title: `Stundenplan von ${nameOf(s)} ansehen`,
        onclick: () => { state.target = s.id; show('plan'); },
      },
        avatarEl(s),
        h('span', { className: 'grow' }, nameOf(s),
          h('small', { className: 'sub', textContent:
            (s.tage > 1 ? `${tagKurz(s.von)} – ${tagKurz(s.bis)} · ${s.tage} Tage` : tagKurz(s.von))
            + (s.von_stunde ? ` · ${stunden(s.von_stunde, s.bis_stunde)}` : ' · ganzer Tag')
            + (s.grund ? ` · ${s.grund}` : '') })),
        s.von <= heute && s.bis >= heute ? h('span', { className: 'lage', textContent: 'jetzt' }) : null,
        h('span', { className: 'muted small', textContent: 'Plan ›' })))
    : [h('li', {}, h('span', { className: 'muted', textContent: 'Niemand abgemeldet.' }))]));
}
