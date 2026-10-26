// --- login ---
// Anmelden, Registrieren, Passwort anzeigen und die Installation als App.
import { $, $$, api, avatarEl, h, nameOf, oops, scrollHinweis, setzeDesign, state, toast } from './kern.js';
import { PLAN_CACHE, show, startAnsicht } from './plan.js';
import { schluesselEinrichten, starteBadge, vergissKeys } from './chat.js';
import { hinweisZeigen } from './profil.js';
import { nachrichtenZeigen } from './hausaufgaben.js';
import { paintNav } from './menue.js';

// --- Login ------------------------------------------------------------------

// Anmelden und Registrieren teilten sich frueher ein Formular, mit dem Key-Feld immer sichtbar -
// das war die Verwirrung. Jetzt zwei Reiter: sichtbar ist nur, was zum gewaehlten Reiter gehoert.
let authModus = 'login';

// Einladungslink: /registrieren?key=… oeffnet gleich "Neues Konto" mit eingetragenem Key. Der Key
// verschwindet sofort aus der Adresse - er soll nicht im Verlauf oder auf einem Screenshot stehen.
const einladungsKey = new URLSearchParams(location.search).get('key');
if (einladungsKey) history.replaceState(null, '', location.pathname.startsWith('/registrieren') ? '/' : location.pathname);

export async function applyRegMode() {
  const { registration } = await api('GET', '/api/public-config').catch(() => ({ registration: 'off' }));
  state.registration = registration;
  $('#authReiter').querySelector('[data-auth="register"]').hidden = registration === 'off';
  if (registration === 'off') authModus = 'login';
  else if (einladungsKey) {
    authModus = 'register';
    $('#regKey').value = einladungsKey;
  }
  $('#regHint').textContent = registration === 'off'
    ? 'Neue Konten legt zurzeit nur ein Admin an.'
    : registration === 'key' ? 'Für ein neues Konto brauchst du den Registrierungs-Key.' : '';
  paintAuth();
}

function paintAuth() {
  const neu = authModus === 'register';
  $$('#authReiter button').forEach(b => b.classList.toggle('active', b.dataset.auth === authModus));
  $('#regKey').hidden = !neu || state.registration !== 'key';
  $('#authBtn').textContent = neu ? 'Konto anlegen' : 'Anmelden';
  $('#loginForm').password.autocomplete = neu ? 'new-password' : 'current-password';
}

// Passwort sichtbar machen: auf dem Handy vertippt man sich sonst und weiss nicht, wo.
$('#pwAuge').onclick = () => {
  const feld = $('#loginForm').password;
  const zeigen = feld.type === 'password';
  feld.type = zeigen ? 'text' : 'password';
  const knopf = $('#pwAuge');
  knopf.setAttribute('aria-pressed', String(zeigen));
  knopf.title = knopf.ariaLabel = zeigen ? 'Passwort verbergen' : 'Passwort anzeigen';
  knopf.textContent = zeigen ? '🙈' : '👁';
  feld.focus();
};

$$('#authReiter button').forEach(b => (b.onclick = () => {
  authModus = b.dataset.auth;
  paintAuth();
}));

// Anmelden und Registrieren teilen sich ein Formular. Der Zielpfad wird deshalb pro Klick
// uebergeben statt gemerkt, und das required am Key-Feld gilt nur fuer die Dauer der Pruefung -
// sonst bleibt es nach einer fehlgeschlagenen Validierung haengen und blockiert das Anmelden.
async function submitAuth(path) {
  const form = $('#loginForm');
  const key = $('#regKey');
  key.required = path === '/api/register' && state.registration === 'key';
  const valid = form.reportValidity();
  key.required = false;
  if (!valid) return;
  try {
    state.me = await api('POST', path, Object.fromEntries(new FormData(form)));
    // Der einzige Moment, in dem der Browser das Passwort in der Hand hat - und der einzige, in
    // dem sich der private Chat-Schluessel oeffnen laesst.
    // Der einzige Moment, in dem der Browser das Passwort in der Hand hat.
    await schluesselEinrichten(form.password.value).catch(() => {});
    form.reset();
    await enter();
    if (state.me.standard_passwort)
      toast('Du meldest dich noch mit dem Standard-Passwort „admin“ an – bitte gleich unter Profil → Konto ändern.', false, { sekunden: 30 });
  } catch (err) { oops(err); }
}

$('#loginForm').onsubmit = e => {
  e.preventDefault();
  submitAuth(authModus === 'register' ? '/api/register' : '/api/login');
};

$('#logout').onclick = async () => {
  // Was der Browser sich fuer DIESEN Nutzer gemerkt hat, geht mit: sonst landete der naechste
  // auf der zuletzt offenen Seite des vorigen (etwa im Profil) und saehe dessen Filter und Tags.
  try {
    for (const k of [PLAN_CACHE, 'view', 'notizFilter', 'kalFilter', 'kalAnsicht', 'aboAuswahl', 'abwVergangene'])
      localStorage.removeItem(k);
  } catch { /* Privatmodus */ }
  // Auf einem fremden Geraet darf der Chat-Schluessel nicht liegen bleiben.
  await vergissKeys().catch(() => {});
  await api('POST', '/api/logout').catch(() => {});
  location.reload();
};

// --- PWA --------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Android/Chrome liefert das Install-Angebot als Event; iOS kennt es nicht, dort geht es nur
// ueber "Zum Home-Bildschirm" im Teilen-Menue. Deshalb erscheint der Knopf nur, wenn es ihn gibt.
let installEvent = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('#install').hidden = false;
});
addEventListener('appinstalled', () => { installEvent = null; $('#install').hidden = true; });
$('#install').onclick = async () => {
  if (!installEvent) return;
  $('#install').hidden = true;
  installEvent.prompt();
  installEvent = null;
};
$('#meChip').onclick = () => show('profile');
// Der Name oben fuehrt nach Hause: zum eigenen Plan, auch aus dem Plan eines Freundes heraus.
$('#brandKnopf').onclick = () => { state.target = state.me.id; show('plan'); };

export function paintMe() {
  setzeDesign(state.me.design);
  $('#meChip').replaceChildren(
    avatarEl(state.me),
    h('span', { textContent: nameOf(state.me) + (state.me.is_admin ? ' · Admin' : '') }));
  paintNav();
}

export async function enter() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  scrollHinweis($('header nav'));
  paintMe();
  state.target = state.me.id;
  state.week = null;
  state.friends = null; // [] ist truthy - ohne Reset behaelt ein Userwechsel die alte Freundesliste
  [state.courses, state.rooms] = await Promise.all([
    api('GET', '/api/courses').catch(() => []),
    api('GET', '/api/rooms').catch(() => []),
  ]);
  starteBadge();
  show(startAnsicht());
  // Nebenher: der Aushang und neue Schul-Nachrichten duerfen den Start nicht aufhalten, und ohne
  // Netz gibt es eben keine. Zwei Fenster uebereinander sind in Ordnung - eins nach dem anderen.
  hinweisZeigen().catch(() => {});
  nachrichtenZeigen().catch(() => {});
}
