// --- kalender ---
// Monatsraster, darunter der gewaehlte Tag. Keine Wochenansicht: dafuer gibt es den Stundenplan.
//
// Uebereinander liegen mehrere Ebenen - eigene Termine, Pruefungen, Hausaufgaben, abonnierte und
// schulweite Kalender. Jede hat ihre Farbe; welche, entscheidet der Server (er kennt die
// Einstellung), gezeichnet wird hier.

import {
  $, addDays, api, bestaetigen, dmy, entwurf, entwurfWeg, h, heuteIso, kopieren, oops,
  rueckgaengig, setzeKinder, state, stunden, teilenFenster, toast,
} from './kern.js';

/**
 * Die Felder eines Eintrags, wie POST und PATCH sie erwarten - fuer Rueckgaengig: alte Werte
 * zurueckschreiben oder einen geloeschten Eintrag neu anlegen (der bekommt eine neue ID).
 */
export const eintragFelder = e => ({
  titel: e.titel, ort: e.ort ?? '', text: e.text ?? '', art: e.art, fuer_kurs: !!e.fuer_kurs,
  erinnerung_tage: e.erinnerung_tage ?? null, ganztags: !!e.ganztags, von: e.von, bis: e.bis ?? undefined,
  ...(e.von_stunde && { von_stunde: e.von_stunde, bis_stunde: e.bis_stunde ?? e.von_stunde,
    course_id: e.course_id ?? null }),
});

const zz = n => String(n).padStart(2, '0');
const heute = () => heuteIso();
const monatsName = m => new Date(m + '-01T00:00:00Z')
  .toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

let monat = heute().slice(0, 7);
let gewaehlt = heute();          // null = kein Tag gewaehlt, unten steht dann der ganze Monat
let daten = { kalender: [], farben: {}, eintraege: [], ohne: [] };
// Monatsraster oder Ereignisliste - gemerkt wie der Reiter.
let kalAnsicht = 'monat';
try { kalAnsicht = localStorage.getItem('kalAnsicht') || 'monat'; } catch { /* Privatmodus */ }

const tagVon = e => String(e.von).slice(0, 10);
const tagBis = e => String(e.bis || e.von).slice(0, 10);
const zeitVon = e => (e.ganztags ? '' : String(e.von).slice(11, 16));

/** Alle Tage eines Monats - und davor/danach so viele, dass volle Wochen entstehen. */
function rasterTage(m) {
  const erster = new Date(m + '-01T00:00:00Z');
  const start = new Date(erster);
  start.setUTCDate(1 - ((erster.getUTCDay() + 6) % 7));       // zurueck bis Montag
  const tage = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    tage.push(d.toISOString().slice(0, 10));
    // Sechs Wochen sind das Maximum; fuenf reichen meist - dann hoeren wir frueher auf.
    if (i >= 27 && d.toISOString().slice(0, 7) > m && (i + 1) % 7 === 0) break;
  }
  return tage;
}

// Der Filter: alles, nur Hausaufgaben, nur Pruefungen, nur Termine - gemerkt wie der Reiter.
const KAL_FILTER = [['', 'Alle'], ['hausaufgabe', 'Hausaufgaben'], ['pruefung', 'Prüfungen'], ['termin', 'Termine'], ['ferien', 'Ferien']];
let kalFilter = '';
try { kalFilter = localStorage.getItem('kalFilter') || ''; } catch { /* Privatmodus */ }

function maleKalFilter() {
  setzeKinder($('#kalFilter'), ...KAL_FILTER.map(([k, t]) => h('button', {
    type: 'button', textContent: t, className: k === kalFilter ? 'active' : '',
    onclick: () => {
      kalFilter = k;
      try { localStorage.setItem('kalFilter', k); } catch { /* Privatmodus */ }
      maleKalFilter(); maleAlles();
    },
  })));
  $('#kalAnsicht').replaceChildren(...[['monat', 'Monat'], ['liste', 'Liste']].map(([k, t]) => h('button', {
    type: 'button', textContent: t, className: k === kalAnsicht ? 'an' : '',
    onclick: () => {
      kalAnsicht = k;
      try { localStorage.setItem('kalAnsicht', k); } catch { /* Privatmodus */ }
      maleKalFilter(); maleAlles();
    },
  })));
}

/** Raster und Liste neu zeichnen - je nach Ansicht. */
function maleAlles() {
  $('#monatsRaster').hidden = kalAnsicht !== 'monat';
  if (kalAnsicht === 'monat') maleMonat();
  maleTag();
}

const anTag = tag => daten.eintraege
  .filter(e => tagVon(e) <= tag && tagBis(e) >= tag)
  .filter(e => !kalFilter || (e.art ?? 'termin') === kalFilter)
  .sort((a, b) => (a.ganztags === b.ganztags ? String(a.von).localeCompare(String(b.von))
    : (a.ganztags ? -1 : 1)));

function maleMonat() {
  $('#monatLabel').textContent = monatsName(monat);
  const tage = rasterTage(monat);
  const kopf = h('tr', {}, ...['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
    .map(t => h('th', { textContent: t })));

  const zeilen = [];
  for (let i = 0; i < tage.length; i += 7) {
    zeilen.push(h('tr', {}, ...tage.slice(i, i + 7).map(tag => {
      const drin = anTag(tag);
      // Text statt Punkte: die ersten Titel als Zeile mit Farbbalken, der Rest als "+N".
      const zeile = e => {
        const z = h('span', { className: 'kal-eintrag' + (e.erledigt ? ' gone' : ''), textContent: e.titel, title: e.titel });
        z.style.borderLeftColor = e.farbe;
        return z;
      };
      const td = h('td', {
        className: ['kal-tag', tag.slice(0, 7) !== monat && 'fremd', tag === heute() && 'heute',
          tag === gewaehlt && 'gewaehlt'].filter(Boolean).join(' '),
      }, h('button', {
        // Noch einmal auf den gewaehlten Tag: die Wahl aufheben, unten steht wieder der Monat.
        onclick: () => { gewaehlt = gewaehlt === tag ? null : tag; maleMonat(); maleTag(); },
      },
        h('span', { className: 'nr', textContent: String(Number(tag.slice(8, 10))) }),
        h('span', { className: 'kal-zeilen' }, ...drin.slice(0, 3).map(zeile),
          drin.length > 3 ? h('span', { className: 'kal-mehr', textContent: `+${drin.length - 3}` }) : null)));
      return td;
    })));
  }
  $('#monatsRaster').replaceChildren(h('table', { className: 'kal-monat' },
    h('thead', {}, kopf), h('tbody', {}, ...zeilen)));
}

/** Eine Eintragszeile - in der Tagesliste wie in der Monatsliste dieselbe. */
function eintragZeile(e) {
  // Farbe ueber das CSSOM, nicht als style-Attribut: das verbietet die CSP.
  const strich = h('span', { className: 'kal-strich' });
  strich.style.background = e.farbe;
  return h('li', { className: e.erledigt ? 'gone' : '' },
        strich,
        h('span', { className: 'grow' }, e.titel,
          h('small', { className: 'sub', textContent: [
            e.ganztags ? 'ganztägig' : `${zeitVon(e)}–${String(e.bis ?? '').slice(11, 16)} Uhr`,
            e.ort, e.kalender,
            e.art === 'pruefung' && e.von_stunde
              ? stunden(e.von_stunde, e.bis_stunde) : null,
          ].filter(Boolean).join(' · ') })),
        e.darf_aendern ? h('button', {
          className: 'tiny ghost', textContent: 'Ändern', onclick: () => terminFenster(e),
        }) : null,
        e.darf_aendern ? h('button', {
          className: 'tiny ghost', textContent: '×', title: 'Löschen',
          // Keine Rueckfrage mehr: Rueckgaengig legt den Eintrag wieder an.
          onclick: async () => {
            try {
              await api('DELETE', `/api/kalender/eintraege/${e.id}`);
              state.plan = null;
              await loadKalender();
              rueckgaengig(`„${e.titel}" gelöscht.`, async () => {
                await api('POST', `/api/kalender/${e.kalender_id}/eintraege`, eintragFelder(e));
                state.plan = null;
                await loadKalender();
              });
            } catch (err) { oops(err); }
          },
        }) : null);
}

const tagTitel = (tag, lang = true) => new Date(tag + 'T00:00:00Z')
  .toLocaleDateString('de-DE', lang
    ? { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }
    : { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });

function maleTag() {
  // Ein gewaehlter Tag: seine Liste. Sonst (oder in der Listenansicht) der ganze Monat, nach
  // Tagen gruppiert - so sieht man in einem fremden Monat, was ansteht, ohne einen Tag zu raten.
  if (gewaehlt && kalAnsicht === 'monat') {
    const drin = anTag(gewaehlt);
    $('#tagesListe').replaceChildren(
      h('h3', { textContent: tagTitel(gewaehlt) }),
      drin.length ? h('ul', { className: 'list' }, ...drin.map(eintragZeile))
        : h('p', { className: 'meta', textContent: 'Nichts an diesem Tag.' }));
    return;
  }
  const teile = [h('h3', { textContent: `Termine im ${monatsName(monat)}` })];
  let leer = true;
  const erster = monat + '-01', letzter = verschiebe(monat, 1) + '-01';
  for (let tag = erster; tag < letzter; tag = addDays(tag, 1)) {
    const drin = anTag(tag);
    if (!drin.length) continue;
    leer = false;
    teile.push(h('h4', { className: tag === heute() ? 'heute' : '', textContent: tagTitel(tag, false) }),
      h('ul', { className: 'list' }, ...drin.map(eintragZeile)));
  }
  if (leer) teile.push(h('p', { className: 'meta', textContent: 'Nichts in diesem Monat.' }));
  $('#tagesListe').replaceChildren(...teile);
}

/** Ein Termin anlegen oder aendern. Pruefungen tragen zusaetzlich ihre Schulstunden. */
export async function terminFenster(e = null, vorgabe = {}) {
  const dlg = $('#terminDlg');
  // Aus dem Stundenplan heraus ist die Liste leer, solange der Kalender-Reiter nie offen war -
  // dann stand hier "Kein Kalender", obwohl jeder einen hat. Also erst holen.
  if (!daten.kalender.length) {
    try {
      const k = await api('GET', '/api/kalender');
      daten = { ...daten, kalender: k.kalender, farben: k.farben };
    } catch (err) { return oops(err); }
  }
  const schreibbar = daten.kalender.filter(k => k.darf_aendern && k.quelle !== 'abo' && k.quelle !== 'untis');
  if (!schreibbar.length) return toast('Kein Kalender, in den du schreiben darfst.');

  const titel = h('input', { maxLength: 200, value: e?.titel ?? vorgabe.titel ?? '', required: true });
  // Ein angefangener Termin ueberlebt das Schliessen - nur beim Neuanlegen ohne Vorgabe aus dem Plan.
  const merken = !e && !vorgabe.titel;
  if (merken) entwurf('termin:titel', titel);
  const kalWahl = h('select', {}, ...schreibbar.map(k => h('option', {
    value: String(k.id), textContent: k.name, selected: k.id === e?.kalender_id,
  })));
  const ganztags = h('input', { type: 'checkbox', checked: !!e?.ganztags });
  const pruefung = h('input', { type: 'checkbox',
    checked: e ? e.art === 'pruefung' : !!vorgabe.pruefung });
  const von = h('input', { type: 'datetime-local',
    value: (e?.von ?? vorgabe.von ?? `${gewaehlt} 08:00`).replace(' ', 'T').slice(0, 16) });
  const bis = h('input', { type: 'datetime-local',
    value: (e?.bis ?? vorgabe.bis ?? `${gewaehlt} 09:00`).replace(' ', 'T').slice(0, 16) });
  const ort = h('input', { maxLength: 200, value: e?.ort ?? '' });
  const text = h('textarea', { rows: 2, maxLength: 2000, value: e?.text ?? '' });
  if (merken) { entwurf('termin:von', von, true); entwurf('termin:bis', bis, true); entwurf('termin:ort', ort); entwurf('termin:text', text); }
  // Nur bei Pruefungen: fuer den ganzen Kurs (braucht einen Kurs, also aus dem Plan heraus) und
  // die eigene Erinnerung - leer heisst "wie im Profil".
  const kursId = vorgabe.course_id ?? e?.course_id ?? null;
  const fuerKurs = h('input', { type: 'checkbox', checked: !!e?.fuer_kurs });
  const erinnerung = h('input', { type: 'number', min: 0, max: 60, className: 'kurz',
    value: e?.erinnerung_tage ?? '', placeholder: String(state.me?.pruefung_vorlauf_tage ?? 7) });
  const pruefungsZeilen = h('div', { className: 'stack' },
    kursId ? h('label', { className: 'check' }, fuerKurs, ' für den ganzen Kurs sichtbar (alle, die den Kurs in dieser Stunde haben)') : null,
    h('label', { className: 'field' }, 'Erinnern',
      h('span', { className: 'row' }, erinnerung, h('small', { className: 'muted', textContent: 'Tage vorher (leer = wie im Profil, 0 = nie)' }))));

  // Aus dem Stundenplan heraus: dann zaehlen Schulstunden statt Uhrzeiten.
  const stundenFeld = vorgabe.von_stunde || e?.von_stunde
    ? h('label', { className: 'field' }, 'Stunden',
      h('span', { className: 'row' },
        h('input', { type: 'number', min: 0, max: 20, className: 'kurz',
          value: String(e?.von_stunde ?? vorgabe.von_stunde ?? 1), name: 'vonStd' }),
        h('small', { textContent: 'bis' }),
        h('input', { type: 'number', min: 0, max: 20, className: 'kurz',
          value: String(e?.bis_stunde ?? vorgabe.bis_stunde ?? vorgabe.von_stunde ?? 1), name: 'bisStd' })))
    : null;

  const zeitZeile = h('div', { className: 'stack' },
    h('label', { className: 'field' }, 'Beginn', von),
    h('label', { className: 'field' }, 'Ende', bis));
  const sync = () => {
    zeitZeile.hidden = !!stundenFeld;
    bis.disabled = ganztags.checked;
    pruefungsZeilen.hidden = !pruefung.checked;
  };
  ganztags.onchange = sync;
  pruefung.onchange = sync;
  sync();

  const speichern = h('button', { className: 'primary', textContent: 'Speichern' });
  speichern.onclick = async () => {
    const koerper = {
      titel: titel.value.trim(), ort: ort.value, text: text.value,
      art: pruefung.checked ? 'pruefung' : 'termin',
      fuer_kurs: pruefung.checked && fuerKurs.checked,
      erinnerung_tage: pruefung.checked && erinnerung.value !== '' ? Number(erinnerung.value) : null,
      ganztags: ganztags.checked,
      von: stundenFeld ? (e?.von ?? vorgabe.von ?? gewaehlt).slice(0, 10) : von.value,
      bis: stundenFeld ? undefined : bis.value,
      ...(stundenFeld && {
        von_stunde: Number(stundenFeld.querySelector('[name=vonStd]').value) || 1,
        bis_stunde: Number(stundenFeld.querySelector('[name=bisStd]').value) || 1,
        course_id: vorgabe.course_id ?? e?.course_id ?? null,
      }),
    };
    if (!koerper.titel) return toast('Titel fehlt.');
    // Nach dem Speichern alles neu zeichnen, was den Eintrag zeigt - auch beim Rueckgaengig.
    const frisch = async () => { state.plan = null; await loadKalender().catch(() => {}); if (vorgabe.danach) vorgabe.danach(); };
    try {
      if (e) {
        await api('PATCH', `/api/kalender/eintraege/${e.id}`, koerper);
        dlg.close();
        await frisch();
        rueckgaengig('Gespeichert.', async () => { await api('PATCH', `/api/kalender/eintraege/${e.id}`, eintragFelder(e)); await frisch(); });
      } else {
        const neu = await api('POST', `/api/kalender/${kalWahl.value}/eintraege`, koerper);
        entwurfWeg('termin');
        dlg.close();
        await frisch();
        rueckgaengig(`„${neu.titel}" eingetragen.`, async () => { await api('DELETE', `/api/kalender/eintraege/${neu.id}`); await frisch(); });
      }
    } catch (err) { oops(err); }
  };

  dlg.replaceChildren(
    h('h2', { textContent: (e ? e.art : vorgabe.pruefung ? 'pruefung' : '') === 'pruefung'
      ? (e ? 'Prüfung ändern' : 'Neue Prüfung') : (e ? 'Termin ändern' : 'Neuer Termin') }),
    h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Titel', titel),
      e ? null : h('label', { className: 'field' }, 'Kalender', kalWahl),
      h('label', { className: 'check' }, pruefung, ' Prüfung (eigene Farbe im Kalender)'),
      pruefungsZeilen,
      stundenFeld,
      stundenFeld ? null : h('label', { className: 'check' }, ganztags, ' ganztägig'),
      zeitZeile,
      h('label', { className: 'field' }, 'Ort', ort),
      h('label', { className: 'field' }, 'Notiz', text)),
    h('div', { className: 'row end' },
      speichern,
      h('button', { className: 'ghost', textContent: 'Abbrechen', onclick: () => dlg.close() })));
  dlg.showModal();
  titel.focus();
}

/** Kalender, Farben, Abos und der Link fuers Handy. */
async function kalenderVerwalten() {
  const dlg = $('#kalVerwaltung');
  const token = (await api('GET', '/api/me/ics-token').catch(() => ({}))).token;

  const zeile = k => {
    const farbe = h('input', { type: 'color', value: k.farbe || '#3b82d6', disabled: !k.darf_aendern });
    farbe.onchange = async () => {
      try { await api('PATCH', `/api/kalender/${k.id}`, { farbe: farbe.value }); await loadKalender(); }
      catch (err) { oops(err); }
    };
    const an = h('input', { type: 'checkbox', checked: !!k.sichtbar && !daten.aus?.includes(k.id) });
    an.onchange = async () => {
      try { await api('PATCH', `/api/kalender/${k.id}`, { sichtbar: an.checked }); await loadKalender(); }
      catch (err) { oops(err); }
    };
    return h('li', {},
      farbe,
      h('span', { className: 'grow' }, k.name,
        h('small', { className: 'sub', textContent: [
          { eigen: 'eigener Kalender', abo: 'abonniert', schule: 'von der Schule',
            untis: 'Prüfungen aus WebUntis' }[k.quelle],
          k.geteilt ? 'mit dir geteilt' : null,
          k.sync_fehler ? `Fehler: ${k.sync_fehler}` : null,
        ].filter(Boolean).join(' · ') })),
      h('label', { className: 'check' }, an, ' zeigen'),
      k.quelle === 'abo' && k.darf_aendern ? h('button', {
        className: 'tiny ghost', textContent: 'Jetzt holen',
        onclick: async () => {
          try { toast('Hole …'); await api('POST', `/api/kalender/${k.id}/sync`); await loadKalender(); toast('Geholt.', true); }
          catch (err) { oops(err); }
        },
      }) : null,
      k.darf_aendern && !k.geteilt && k.quelle !== 'untis' ? h('button', {
        className: 'tiny ghost', textContent: 'Teilen …',
        onclick: () => kalenderTeilen(k).catch(oops),
      }) : null,
      k.darf_aendern && !k.geteilt ? h('button', {
        className: 'tiny ghost', textContent: '×', title: 'Kalender löschen',
        onclick: async () => {
          if (!await bestaetigen(`„${k.name}" löschen? Die Termine darin gehen mit.`)) return;
          try { await api('DELETE', `/api/kalender/${k.id}`); await loadKalender(); await kalenderVerwalten(); }
          catch (err) { oops(err); }
        },
      }) : null);
  };

  const neuName = h('input', { maxLength: 60, placeholder: 'Name' });
  const neuUrl = h('input', { maxLength: 500, placeholder: 'https://… .ics (leer = eigener Kalender)' });
  const neuSchule = state.me?.is_admin
    ? h('label', { className: 'check' }, h('input', { type: 'checkbox' }), ' für alle (schulweit)')
    : null;

  const farbFeld = (schluessel, beschriftung) => {
    const f = h('input', { type: 'color', value: daten.farben[schluessel] ?? '#888888' });
    f.onchange = async () => {
      try {
        state.me = await api('PATCH', '/api/me',
          { kalender_farben: { ...daten.farben, [schluessel]: f.value } });
        await loadKalender();
      } catch (err) { oops(err); }
    };
    return h('label', { className: 'check' }, f, ' ' + beschriftung);
  };

  dlg.replaceChildren(
    h('h2', { textContent: 'Kalender & Farben' }),
    h('ul', { className: 'list' }, ...daten.kalender.map(zeile)),
    h('h3', { textContent: 'Ebenen' }),
    h('div', { className: 'row' },
      farbFeld('hausaufgabe', 'Hausaufgaben'), farbFeld('pruefung', 'Prüfungen'), farbFeld('ferien', 'Ferien')),
    (() => {
      // Ferien und Feiertage der Schule - wer sie nicht sehen will, blendet sie hier aus.
      const an = h('input', { type: 'checkbox', checked: !(daten.ohne ?? []).includes('ferien') });
      an.onchange = async () => {
        try {
          await api('PATCH', '/api/me', { kalender_ohne: an.checked ? [] : ['ferien'] });
          await loadKalender();
        } catch (err) { oops(err); }
      };
      return h('label', { className: 'check' }, an, ' Ferien & Feiertage der Schule zeigen');
    })(),
    h('h3', { textContent: 'Neuer Kalender' }),
    h('div', { className: 'stack' },
      h('label', { className: 'field' }, 'Name', neuName),
      h('label', { className: 'field' }, 'iCal-Adresse zum Abonnieren', neuUrl),
      neuSchule,
      h('div', { className: 'row end' }, h('button', {
        className: 'primary', textContent: 'Anlegen',
        onclick: async () => {
          try {
            await api('POST', '/api/kalender', {
              name: neuName.value, ical_url: neuUrl.value.trim(),
              schulweit: !!neuSchule?.querySelector('input')?.checked,
            });
            neuName.value = ''; neuUrl.value = '';
            await loadKalender();
            await kalenderVerwalten();
          } catch (err) { oops(err); }
        },
      }))),
    h('h3', { textContent: 'Kalender-Abo fürs Handy' }),
    aboKarte(token),
    h('div', { className: 'row' },
      h('button', {
        className: 'tiny ghost', textContent: 'Neu würfeln',
        onclick: async () => {
          if (!await bestaetigen('Neuen Link erzeugen?\n\nBestehende Abos auf Handys hören dann auf zu laden.')) return;
          try { await api('POST', '/api/me/ics-token'); await kalenderVerwalten(); toast('Neuer Link.', true); }
          catch (err) { oops(err); }
        },
      })),
    h('div', { className: 'row end' },
      h('button', { className: 'ghost', textContent: 'Schließen', onclick: () => dlg.close() })));
  dlg.showModal();
}

/**
 * Das Abo fuers Handy: was hinein soll (Pruefungen, Hausaufgaben, Termine, Ferien - einzeln oder
 * zusammen), daraus der Link, und je Kalender-App der passende Weg. Mehrere Abos gehen: einmal
 * nur Pruefungen, einmal nur Hausaufgaben - einfach zweimal mit anderen Haken hinzufuegen.
 *
 * Der Samsung Kalender kann eine Adresse nicht selbst abonnieren; er zeigt, was ueber das
 * Google-Konto kommt. Deshalb steht der Google-Knopf vorn und der Hinweis direkt darunter.
 */
function aboKarte(token) {
  if (!token) return h('p', { className: 'muted small', textContent: 'Keine Verbindung.' });
  const TEILE = [['pruefungen', 'Prüfungen'], ['hausaufgaben', 'Hausaufgaben'], ['termine', 'eigene Termine'], ['ferien', 'Ferien']];
  let gemerkt = null;
  try { gemerkt = JSON.parse(localStorage.getItem('aboAuswahl') ?? 'null'); } catch { /* egal */ }
  const haken = TEILE.map(([k, t]) => [k, h('input', { type: 'checkbox', checked: gemerkt ? gemerkt.includes(k) : true }), t]);
  const feld = h('input', { readOnly: true, className: 'grow' });
  const google = h('a', { className: 'knopf tiny primary', target: '_blank', rel: 'noopener noreferrer', textContent: 'In Google Kalender hinzufügen' });
  const webcal = h('a', { className: 'knopf tiny ghost', textContent: 'iPhone / Outlook' });
  const male = () => {
    const an = haken.filter(([, x]) => x.checked).map(([k]) => k);
    try { localStorage.setItem('aboAuswahl', JSON.stringify(an)); } catch { /* egal */ }
    const teil = an.length === TEILE.length || !an.length ? 'alles' : an.join('-');
    const link = `${location.origin}/kal/${token}/${teil}.ics`;
    const wc = link.replace(/^https?:/, 'webcal:');
    feld.value = link;
    webcal.href = wc;
    google.href = 'https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(wc);
  };
  haken.forEach(([, x]) => (x.onchange = male));
  male();
  return h('div', { className: 'stack' },
    h('div', { className: 'row' }, ...haken.map(([, x, t]) => h('label', { className: 'check' }, x, ' ' + t))),
    h('div', { className: 'row' }, feld,
      h('button', { type: 'button', className: 'tiny ghost', textContent: 'Kopieren',
        onclick: () => kopieren(feld.value) })),
    h('div', { className: 'row' }, google, webcal),
    h('p', { className: 'muted small', textContent:
      'Samsung Kalender: der kann Links nicht selbst abonnieren. Tippe auf „In Google Kalender '
      + 'hinzufügen" — ist dein Google-Konto im Samsung Kalender eingeschaltet, erscheint das Abo dort '
      + 'von allein. Google holt Neues nur alle paar Stunden. Mehrere Abos gehen: z. B. einmal nur '
      + 'Prüfungen und einmal nur Hausaufgaben. Wer den Link hat, sieht die Einträge — gib ihn nicht weiter.' }));
}

/** Einen Kalender mit Freunden teilen - dasselbe Fenster wie beim Projekt. */
const kalenderTeilen = k => teilenFenster({
  titel: `„${k.name}" teilen`,
  hinweis: 'Wer den Kalender hat, sieht seine Termine — auch im eigenen Handy-Abo.',
  drin: async () => (await api('GET', `/api/kalender/geteilt/${k.id}`).catch(() => [])),
  hinzu: p => api('POST', `/api/kalender/${k.id}/teilen`, { user_id: p.id, darf_aendern: false }),
  weg: p => api('DELETE', `/api/kalender/${k.id}/teilen/${p.id}`),
  danach: () => loadKalender().catch(() => {}),
});

// Wie beim Stundenplan: raus in die eine Richtung, rein aus der anderen. Und dieselbe Wischgeste.
async function monatWechseln(richtung) {
  const el = $('#kalWisch');
  const raus = richtung > 0 ? 'raus-links' : 'raus-rechts';
  el.classList.add(raus);
  monat = verschiebe(monat, richtung);
  try { await loadKalender(); } catch (err) { el.classList.remove(raus); return oops(err); }
  el.classList.remove(raus);
  el.classList.add(richtung > 0 ? 'rein-rechts' : 'rein-links');
  void el.offsetHeight;
  setTimeout(() => el.classList.remove('rein-rechts', 'rein-links'), 20);
}
$('#monatZurueck').onclick = () => monatWechseln(-1);
$('#monatVor').onclick = () => monatWechseln(1);
$('#monatHeute').onclick = () => {
  monat = heute().slice(0, 7); gewaehlt = heute(); loadKalender().catch(oops);
};
{
  let x0 = 0, y0 = 0, zeit = 0;
  const el = $('#kalWisch');
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; zeit = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!zeit || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    const dauer = Date.now() - zeit;
    zeit = 0;
    if (dauer > 800 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    monatWechseln(dx < 0 ? 1 : -1);
  }, { passive: true });
}
$('#terminNeu').onclick = () => terminFenster();
$('#kalenderVerwalten').onclick = () => kalenderVerwalten().catch(oops);

const verschiebe = (m, n) => {
  const d = new Date(m + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

export async function loadKalender() {
  const erster = monat + '-01';
  const letzter = verschiebe(monat, 1) + '-01';
  daten = await api('GET', `/api/kalender/eintraege?von=${erster}&bis=${letzter}`);
  // Die Wahl gehoert zum Monat: liegt heute darin, ist heute gewaehlt - sonst nichts. Frueher
  // sprang die Markierung auf den 1. und blieb dort, auch nach dem Zurueckblaettern.
  if (!gewaehlt || gewaehlt.slice(0, 7) !== monat) gewaehlt = heute().slice(0, 7) === monat ? heute() : null;
  maleKalFilter();
  maleAlles();
}
