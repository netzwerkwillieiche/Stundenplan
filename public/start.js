// --- start ---
// Bindet alles zusammen und startet die App.
import { $, api, oops, state } from './kern.js';
import { applyRegMode, enter } from './login.js';
import { compactStart, readCache, setzeKompakt } from './plan.js';
import { gastUmfrage } from './umfragen.js';

// --- Start ------------------------------------------------------------------

setzeKompakt(compactStart());

// Gaeste einer Umfrage (/umfrage/<key>) brauchen kein Konto und sehen nur die Umfrage.
const gast = /^\/umfrage\/([^/]+)\/?$/.exec(location.pathname);
if (gast) gastUmfrage(decodeURIComponent(gast[1])).catch(oops);
else api('GET', '/api/me')
  .then(me => { state.me = me; return enter(); })
  .catch(async err => {
    // Ohne Netz mit gemerkter Sitzung weiter in die App - sonst landet man in der installierten
    // App auf einem Login-Formular, das ohne Verbindung ohnehin nicht funktioniert.
    const c = err.offline && readCache();
    if (c?.me) { state.me = c.me; return enter(); }
    // Ein echter Programmfehler sah hier bisher aus wie "nicht angemeldet" und blieb unsichtbar.
    if (!err.offline && err.message !== 'Nicht eingeloggt') console.error('Start fehlgeschlagen:', err);
    await applyRegMode();
    $('#login').hidden = false;
  });
