// --- freigabe ---
// Was Buero und Umfragen teilen: das Fenster "wer darf mit?" (Freunde einzeln, ganze Kurse) und
// ein paar Kleinteile. Eigene Datei, damit buero.js und umfragen.js sich nicht gegenseitig
// importieren muessen.
import { $, api, avatarEl, courseLabel, dmy, h, istFrei, nameOf, oops, toast } from './kern.js';

export const zeit = at => (at ? `${dmy(at.slice(0, 10))} ${at.slice(11, 16)}`.trim() : '');
export const dlg = () => $('#bueroDlg');
export const knopf = (text, onclick, cls = 'tiny ghost', extra = {}) =>
  h('button', { type: 'button', className: cls, textContent: text, onclick, ...extra });

// --- Freigabe: Freunde und Kurse ---------------------------------------------------------------

/**
 * Wer darf mit? Freunde einzeln (mit Rolle, wo es eine gibt) und ganze Kurse aus dem eigenen Plan.
 * Gespeichert wird alles auf einmal - das Fenster zeigt immer den ganzen Stand.
 */
export async function freigabeFenster(art, id, titel, danach) {
  const ROLLEN = {
    notiz: [['lesen', 'lesen'], ['aendern', 'bearbeiten']], notiz_ordner: [['lesen', 'lesen'], ['aendern', 'bearbeiten']],
    idee: [['member', 'macht mit'], ['team', 'Team']], abstimmung: [['member', 'stimmt ab']], umfrage: [['member', 'nimmt teil']],
  }[art];
  const [freundeRoh, kurseRoh, jetzt] = await Promise.all([
    api('GET', '/api/friends').catch(() => ({})), api('GET', '/api/my-courses').catch(() => []),
    api('GET', `/api/buero/${art}/${id}/freigabe`)]);
  const freunde = freundeRoh.friends ?? [];
  const kurse = kurseRoh.filter(c => !istFrei(c));
  const hat = new Map(jetzt.filter(z => z.person).map(z => [z.person.id, z.rolle]));
  const kursDrin = new Set(jetzt.filter(z => z.course_id).map(z => z.course_id.toLowerCase()));

  const wahl = freunde.map(f => {
    const s = h('select', {}, h('option', { value: '', textContent: '—' }),
      ...ROLLEN.map(([v, t]) => h('option', { value: v, textContent: t, selected: hat.get(f.id) === v })));
    return { f, s };
  });
  const kurshaken = kurse.map(c => ({ c, x: h('input', { type: 'checkbox', checked: kursDrin.has(String(c.id).toLowerCase()) }) }));
  const d = dlg();
  d.replaceChildren(
    h('h2', { textContent: titel }),
    h('p', { className: 'muted small', textContent: 'Einzelne Freunde und/oder ganze Kurse: dann sind alle dabei, die den Kurs in derselben Stunde haben wie du.'
      + (art === 'notiz_ordner' ? ' Alles im Ordner wird mitgeteilt – auch Unterordner und Notizen, die später dazukommen.' : '') }),
    h('h3', { textContent: 'Freunde' }),
    freunde.length ? h('div', { className: 'stack wahl-liste' }, ...wahl.map(({ f, s }) =>
      h('div', { className: 'wahl-zeile' }, avatarEl(f, 'mini'), h('span', { className: 'grow', textContent: nameOf(f) }), s)))
      : h('p', { className: 'meta', textContent: 'Noch keine Freunde.' }),
    h('h3', { textContent: 'Kurse' }),
    kurse.length ? h('div', { className: 'stack' }, ...kurshaken.map(({ c, x }) =>
      h('label', { className: 'check' }, x, ' ' + courseLabel(c))))
      : h('p', { className: 'meta', textContent: 'Keine Kurse im Stundenplan.' }),
    h('div', { className: 'row end' },
      knopf('Speichern', async () => {
        try {
          const r = await api('PUT', `/api/buero/${art}/${id}/freigabe`, {
            freunde: wahl.filter(w => w.s.value).map(w => ({ id: w.f.id, rolle: w.s.value })),
            kurse: kurshaken.filter(k => k.x.checked).map(k => k.c.id),
          });
          d.close();
          toast(r.anzahl ? `Geteilt (${r.anzahl}).` : 'Nicht mehr geteilt.', true);
          if (danach) await danach();
        } catch (err) { oops(err); }
      }, 'primary'),
      knopf('Abbrechen', () => d.close(), 'ghost')));
  d.showModal();
}

