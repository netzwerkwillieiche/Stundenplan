// --- vnw ---
// Der Draht zum Ticketsystem der VNW-Plattform. Eine Zustaendigkeit: HTTP zu VNW und lesbare
// Fehler. Von Express, der Datenbank und den Nutzern weiss diese Datei nichts.
//
// Der Weg ist bewusst zweigeteilt:
//   - Angelegt und aufgelistet wird MIT dem API-Token der Schule (ein Konto fuer die ganze App).
//   - Gelesen und geantwortet wird ueber den `view_token` des einzelnen Tickets - der geht ganz
//     ohne Anmeldung und ist genau der Weg, den VNW fuer Melder ohne Konto vorsieht.
// Damit braucht kein Schueler ein VNW-Konto, und trotzdem gehoert ihm sein Ticket.

const TIMEOUT = 12_000;

/** Fehler von VNW, die einem Menschen etwas sagen - ohne Pfade, Stacktraces oder Rohantworten. */
export class VnwFehler extends Error {
  constructor(nachricht, status = 0, recht = null) {
    super(nachricht);
    this.status = status;
    this.recht = recht;   // bei 403 nennt VNW das fehlende Recht - das gehoert in den Admin
  }
}

export const ohneSchraegstrich = url => String(url ?? '').trim().replace(/\/+$/, '');

async function ruf(cfg, pfad, { method = 'GET', body, token } = {}) {
  const basis = ohneSchraegstrich(cfg?.url);
  if (!basis) throw new VnwFehler('Für die Tickets ist noch keine VNW-Adresse hinterlegt');
  if (token === undefined && !cfg?.token) throw new VnwFehler('Es ist noch kein VNW-Token hinterlegt');

  let res;
  try {
    res = await fetch(basis + pfad, {
      method,
      // token === null heisst ausdruecklich: ohne Anmeldung (der view_token steckt im Pfad).
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token ?? cfg.token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    // "fetch failed" sagt niemandem etwas.
    throw new VnwFehler(err?.name === 'TimeoutError'
      ? 'VNW antwortet nicht' : 'VNW ist nicht erreichbar');
  }

  const daten = await res.json().catch(() => ({}));
  if (!res.ok) {
    const text = String(daten?.error ?? '').slice(0, 200) || `Fehler ${res.status}`;
    throw new VnwFehler(text, res.status, daten?.required ?? null);
  }
  return daten;
}

/** Die Ticket-Typen der Instanz - daraus waehlt der Admin einen aus. Zugleich der Verbindungstest. */
export const typen = async cfg =>
  (await ruf(cfg, '/api/tickets/types')).types ?? [];

/**
 * Das Schlagwort anlegen, falls es fehlt, und seine ID zurueckgeben.
 *
 * Zurueckgegeben wird die ID und nicht der Slug: VNW haengt bei einer Kollision eine Zahl an den
 * Slug an ("stundenplan-2"), und ein unbekanntes Schlagwort wird beim Anlegen eines Tickets
 * STILL verworfen. Dann fehlte es am Ticket, ohne dass irgendwo ein Fehler auftaucht.
 */
export async function tagSicherstellen(cfg, name = 'Stundenplan') {
  const klein = name.toLowerCase();
  const vorhanden = ((await ruf(cfg, '/api/tickets/tags')).tags ?? [])
    .find(t => String(t.name).toLowerCase() === klein || String(t.slug).toLowerCase() === klein);
  if (vorhanden) return vorhanden.id;

  try {
    const { tag } = await ruf(cfg, '/api/tickets/tags', {
      method: 'POST',
      body: { name, color: '#3b6fd4', description: 'Aus der Stundenplan-App' },
    });
    return tag?.id ?? null;
  } catch (err) {
    // 409 heisst "gibt es schon" - zwischen Nachschlagen und Anlegen war jemand schneller.
    if (err.status === 409) {
      const nochmal = ((await ruf(cfg, '/api/tickets/tags')).tags ?? [])
        .find(t => String(t.name).toLowerCase() === klein);
      if (nochmal) return nochmal.id;
    }
    throw err;
  }
}

export async function ticketAnlegen(cfg, { titel, text, typId, tagId, felder }) {
  const { ticket, view_token } = await ruf(cfg, '/api/tickets', {
    method: 'POST',
    body: {
      ticket_type_id: typId,
      title: titel,
      description: text,
      priority: 'medium',
      ...(tagId ? { tags: [tagId] } : {}),
      // Die eigenen Felder des Ticket-Typs. VNW legt Dateien selbst auf der Platte ab und
      // speichert nur eine Referenz - hier geht base64 hinaus.
      ...(felder && Object.keys(felder).length ? { extra_fields: felder } : {}),
    },
  });
  if (!view_token) throw new VnwFehler('VNW hat kein Ticket zurückgegeben');
  return { id: ticket?.id ?? null, view_token, status: ticket?.status ?? 'open' };
}

/**
 * Ein Ticket bei VNW loeschen - zum Zurueckziehen, solange niemand geantwortet hat. Geht nur mit
 * dem Recht `tickets.close` am Token; fehlt es, kommt 403 mit `required`, und der Admin sieht,
 * was zu tun ist.
 */
export const loeschen = (cfg, id) =>
  ruf(cfg, `/api/tickets/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Alle Tickets mit unserem Schlagwort - EIN Aufruf haelt die ganze Liste aktuell (Status und
 * Antwortzahl stehen je Zeile drin).
 *
 * ACHTUNG: gehoert der Token einem Konto mit der Rolle "Admin", liefert VNW hier ALLE Tickets,
 * nicht nur unsere. Der Aufrufer ordnet deshalb ueber die gespeicherten IDs zu und uebernimmt
 * nichts, was er nicht selbst angelegt hat.
 */
export async function liste(cfg, tagId) {
  const frage = tagId ? `?tag=${encodeURIComponent(tagId)}&limit=200` : '?limit=200';
  return (await ruf(cfg, '/api/tickets' + frage)).tickets ?? [];
}

/** Das Ticket aus Sicht des Melders: oeffentliche Antworten, keine internen Notizen. */
export const ansehen = (cfg, viewToken) =>
  ruf(cfg, `/api/tickets/view/${encodeURIComponent(viewToken)}`, { token: null });

/**
 * Derselbe Vorgang, aber mit dem Token der Schule.
 *
 * Der Melder-Weg gibt die ausgefuellten Formularfelder nicht ueberall mit - dieser hier schon.
 * Gebraucht wird also nur der Datensatz, nicht die Antworten.
 */
export const holen = async (cfg, id) => {
  const daten = await ruf(cfg, `/api/tickets/${encodeURIComponent(id)}`);
  return daten?.ticket ?? daten ?? null;
};

/** Als Melder antworten. Der Name ist frei waehlbar - so steht der Schueler im Faden, nicht die App. */
export const antworten = (cfg, viewToken, name, nachricht) =>
  ruf(cfg, `/api/tickets/view/${encodeURIComponent(viewToken)}/reply`, {
    method: 'POST', token: null, body: { message: nachricht, author_name: name },
  });
