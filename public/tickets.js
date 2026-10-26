// --- tickets ---
// Bugs und Vorschlaege. Gemeldet wird hier, bearbeitet wird bei VNW - fuer den Schueler ist das
// unsichtbar: er sieht seine Tickets, den Stand und die Unterhaltung mit dem Team.
//
// Zwei Zustaende in derselben Sektion, bewusst KEIN <dialog>: ein Gespraechsfaden ist auf dem
// Handy in einer Seite besser aufgehoben, und das close-Ereignis von <dialog> hat in dieser App
// schon zweimal still verschluckt, was jemand eingetippt hatte.
import { $, api, bestaetigen, dmy, entwurf, entwurfWeg, h, oops, rueckgaengig, state, toast } from './kern.js';
import { malTicketBadge } from './chat.js';

let offenes = null;   // null = Liste, sonst die Nummer des gezeigten Tickets

const zeit = at => {
  const iso = String(at ?? '').replace(' ', 'T');
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${dmy(iso.slice(0, 10))} ${iso.slice(11, 16)}`.trim() : '';
};

/**
 * Die eigenen Felder eines Ticket-Typs als Eingaben.
 *
 * Die Beschreibung kommt aus VNW (Feldtypen: text, textarea, number, date, email, url, checkbox,
 * select, choice, file). Gebaut wird je Feld ein Element - und dazu eine Funktion, die seinen Wert
 * liefert. So bleibt das Einsammeln beim Absenden eine Zeile.
 */
function feldEingaben(felder, typId = null) {
  const bau = f => {
    if (f.typ === 'textarea') return h('textarea', { rows: 3, maxLength: 2000 });
    if (f.typ === 'checkbox') return h('input', { type: 'checkbox' });
    if (f.typ === 'file') return h('input', { type: 'file' });
    if (f.typ === 'select' || (f.typ === 'choice' && !f.mehrfach)) {
      return h('select', {},
        ...(f.pflicht ? [] : [h('option', { value: '', textContent: '— keine Angabe —' })]),
        ...f.optionen.map(o => h('option', { value: o, textContent: o })));
    }
    if (f.typ === 'choice') {   // mehrfach
      return h('div', { className: 'stack' }, ...f.optionen.map(o =>
        h('label', { className: 'check' }, h('input', { type: 'checkbox', value: o }), ' ' + o)));
    }
    const art = { number: 'number', date: 'date', email: 'email', url: 'url' }[f.typ] ?? 'text';
    return h('input', { type: art, maxLength: 2000 });
  };

  return felder.map(f => {
    const el = bau(f);
    // Auch die Felder des Typs bleiben als Entwurf - ausser Dateien, die kann man nicht merken.
    if (typId && f.typ !== 'file' && !(f.typ === 'choice' && f.mehrfach)) entwurf(`ticket:feld:${typId}:${f.key}`, el);
    const beschriftung = f.label + (f.pflicht ? ' *' : '');
    return {
      feld: f,
      // Ein Kontrollkaestchen gehoert hinter seine Beschriftung, alles andere darunter.
      knoten: f.typ === 'checkbox'
        ? h('label', { className: 'check' }, el, ' ' + beschriftung)
        : h('label', { className: 'field' }, beschriftung, el),
      async wert() {
        if (f.typ === 'checkbox') return el.checked || null;
        if (f.typ === 'choice' && f.mehrfach) {
          const an = [...el.querySelectorAll('input')].filter(x => x.checked).map(x => x.value);
          return an.length ? an : null;
        }
        if (f.typ === 'file') {
          const datei = el.files?.[0];
          if (!datei) return null;
          const upload = await new Promise((ok, weg) => {
            const leser = new FileReader();
            leser.onload = () => ok(leser.result);
            leser.onerror = () => weg(leser.error);
            leser.readAsDataURL(datei);
          });
          return { upload, file_name: datei.name, mime_type: datei.type };
        }
        return el.value.trim() || null;
      },
    };
  });
}

/** Alle Feldwerte einsammeln - leere bleiben weg, der Server prueft die Pflichtfelder. */
async function feldWerteLesen(eingaben) {
  const raus = {};
  for (const e of eingaben) {
    const w = await e.wert();
    if (w !== null && w !== '') raus[e.feld.key] = w;
  }
  return raus;
}

export async function loadTickets() {
  return offenes === null ? zeigeListe() : zeigeTicket(offenes);
}

const zurueck = () => { offenes = null; zeigeListe().catch(oops); };

async function zeigeListe() {
  const ziel = $('#ticketPanel');
  const daten = await api('GET', '/api/tickets');

  if (!daten.eingerichtet) {
    return ziel.replaceChildren(h('div', { className: 'card narrow' },
      h('h3', { textContent: 'Bugs und Vorschläge' }),
      h('p', { className: 'muted small', textContent: state.me?.is_admin
        ? 'Noch nicht eingerichtet: Admin → Tickets.'
        : 'Das Ticketsystem ist noch nicht eingerichtet. Sag es der Schulleitung oder dem Admin.' })));
  }

  // Die Art der Meldung. Bei genau einem eingerichteten Typ erscheint das Feld nicht - eine
  // Auswahl ohne Wahl ist nur ein Klick mehr.
  const arten = daten.typen ?? [];
  const art = h('select', {}, ...arten.map(t =>
    h('option', { value: String(t.id), textContent: t.name })));
  entwurf('ticket:art', art);   // die gewaehlte Art gehoert zum Entwurf - sonst steht wieder die erste da
  const artFeld = arten.length > 1 ? h('label', { className: 'field' }, 'Art', art) : null;

  // Die eigenen Felder des gewaehlten Typs. Beim Wechsel der Art werden sie neu gezeichnet -
  // jeder Typ bringt seine eigenen mit.
  const extraKasten = h('div', { className: 'stack' });
  let extra = [];
  const maleFelder = () => {
    const gewaehlt = arten.find(t => String(t.id) === art.value) ?? arten[0];
    extra = feldEingaben(gewaehlt?.fields ?? [], gewaehlt?.id);
    extraKasten.replaceChildren(...extra.map(e => e.knoten));
  };
  art.onchange = maleFelder;
  maleFelder();

  // Die Liste wird bei jedem Oeffnen neu gebaut - ohne Entwurf war ein halber Bericht nach dem
  // Wechsel in den Plan weg.
  const titel = entwurf('ticket:titel', h('input', { maxLength: 120, placeholder: 'Kurz: worum geht es?' }));
  const text = entwurf('ticket:text', h('textarea', { rows: 4, maxLength: 4000,
    placeholder: 'Was ist passiert? Was hast du erwartet? Wo genau?' }));
  const senden = h('button', {
    className: 'primary', textContent: 'Melden',
    onclick: async () => {
      if (!titel.value.trim()) return toast('Titel fehlt');
      senden.disabled = true;
      try {
        const neu = await api('POST', '/api/tickets', {
          title: titel.value, text: text.value, type_id: art.value || null,
          extra_fields: await feldWerteLesen(extra),
        });
        titel.value = text.value = '';
        entwurfWeg('ticket:titel'); entwurfWeg('ticket:text'); entwurfWeg('ticket:feld');
        maleFelder();
        offenes = neu.id;
        await zeigeTicket(neu.id);
        rueckgaengig('Danke, ist angekommen.', async () => { await api('DELETE', `/api/tickets/${neu.id}`); zurueck(); });
      } catch (err) { oops(err); }
      finally { senden.disabled = false; }
    },
  });

  const liste = daten.tickets.length
    ? h('ul', { className: 'list' }, ...daten.tickets.map(t => h('li', {},
        t.neu ? h('span', { className: 'ticket-neu', title: 'Neue Antwort' }) : null,
        t.type_name ? h('span', { className: 'tag', textContent: t.type_name }) : null,
        h('button', {
          className: 'grow linkknopf', textContent: t.title,
          onclick: () => { offenes = t.id; zeigeTicket(t.id).catch(oops); },
        }),
        h('span', { className: 'lage ' + t.status, textContent: t.status_text }),
        // Zurueckziehen geht, solange niemand geantwortet hat - danach ist es der Vorgang des Teams.
        t.status !== 'closed' && !t.antworten ? h('button', {
          className: 'tiny ghost', textContent: 'Zurückziehen',
          onclick: () => zurueckziehen(t.id).catch(oops),
        }) : null)))
    : h('p', { className: 'meta', textContent: 'Noch nichts gemeldet.' });

  ziel.replaceChildren(
    h('div', { className: 'card narrow' },
      h('h3', { textContent: 'Etwas melden' }),
      h('p', { className: 'muted small', textContent:
        'Fehler oder Vorschlag — beides hier. Du bekommst die Antwort an derselben Stelle.' }),
      h('div', { className: 'stack' },
        artFeld,
        h('label', { className: 'field' }, 'Titel', titel),
        h('label', { className: 'field' }, 'Beschreibung (optional)', text),
        extraKasten),
      h('div', { className: 'row end' }, senden)),
    h('div', { className: 'card narrow' },
      h('h3', { textContent: 'Deine Meldungen' }),
      daten.fehler
        ? h('p', { className: 'meta', textContent: `Stand von vorhin — ${daten.fehler}.` }) : null,
      liste));
}

async function zurueckziehen(id) {
  if (!await bestaetigen('Ticket zurückziehen? Es wird auch beim Team gelöscht.')) return;
  await api('DELETE', `/api/tickets/${id}`);
  toast('Zurückgezogen.', true);
  zurueck();
}

async function zeigeTicket(id) {
  const ziel = $('#ticketPanel');
  let t;
  try { t = await api('GET', `/api/tickets/${id}`); }
  catch (err) { offenes = null; throw err; }
  // Aufgemacht heisst gelesen - die Zahl am Reiter soll nicht bis zum naechsten Takt stehen.
  malTicketBadge();

  const feld = entwurf(`ticket:antwort:${id}`, h('textarea', { rows: 3, maxLength: 4000, placeholder: 'Antwort schreiben …' }));
  const senden = h('button', {
    className: 'primary', textContent: 'Antworten',
    onclick: async () => {
      if (!feld.value.trim()) return;
      senden.disabled = true;
      try {
        await api('POST', `/api/tickets/${id}/replies`, { text: feld.value });
        feld.value = '';
        entwurfWeg(`ticket:antwort:${id}`);
        await zeigeTicket(id);
      } catch (err) { oops(err); }
      finally { senden.disabled = false; }
    },
  });

  ziel.replaceChildren(h('div', { className: 'card narrow' },
    h('div', { className: 'row' },
      h('button', { className: 'ghost', textContent: '← Zurück', onclick: zurueck }),
      h('span', { className: 'grow' }),
      h('span', { className: 'lage ' + t.status, textContent: t.status_text })),
    h('h3', { textContent: t.title }),
    h('p', { className: 'meta', textContent:
      [t.type_name, 'Gemeldet am ' + zeit(t.created_at)].filter(Boolean).join(' · ') }),
    h('p', { className: 'fliesstext', textContent: t.text }),

    // Was in den eigenen Feldern des Ticket-Typs steht.
    ...(t.felder?.length ? [h('dl', {}, ...t.felder.flatMap(f => [
      h('dt', { textContent: f.label }), h('dd', { textContent: f.wert })]))] : []),

    h('h4', { textContent: t.replies.length ? 'Antworten' : 'Noch keine Antwort' }),
    ...t.replies.map(r => h('div', { className: 'ticket-antwort' },
      h('p', { className: 'meta', textContent: [r.name, zeit(r.at)].filter(Boolean).join(' · ') }),
      h('p', { className: 'fliesstext', textContent: r.text }))),

    // Ein geschlossenes Ticket nimmt bei VNW nichts mehr an - dann gibt es hier auch kein Feld,
    // das so tut, als ginge es noch.
    ...(t.antwortbar
      ? [h('div', { className: 'stack' }, h('label', { className: 'field' }, 'Deine Antwort', feld)),
         h('div', { className: 'row end' },
           t.replies.length ? null : h('button', { className: 'ghost', textContent: 'Zurückziehen',
             title: 'Solange noch niemand geantwortet hat', onclick: () => zurueckziehen(id).catch(oops) }),
           senden)]
      // Erledigt ist erledigt: dann darf es aus der eigenen Liste verschwinden. Bei den Admins
      // bleibt der Vorgang stehen - deshalb sagt die Rueckfrage genau das.
      : [h('p', { className: 'meta', textContent: 'Dieses Ticket ist geschlossen.' }),
         h('div', { className: 'row end' }, h('button', {
           className: 'ghost', textContent: 'Aus meiner Liste entfernen',
           onclick: async () => {
             if (!await bestaetigen('Aus deiner Liste entfernen?\n\nBei den Admins bleibt das Ticket erhalten.')) return;
             try {
               await api('DELETE', `/api/tickets/${id}`);
               toast('Entfernt.', true);
               zurueck();
             } catch (err) { oops(err); }
           },
         }))])));
}
