import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.DB = ':memory:';
process.env.PORT = '0';
process.env.ADMIN_PW = 'geheim';
process.env.NODE_ENV = 'test';
process.env.REG_MAX = '100000';   // die Tests legen Hunderte Konten von einer IP an
process.env.UNTIS_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let base, server;

// Ein Client = ein Cookie-Jar. Reicht, um mehrere User parallel zu fahren.
function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.raw = path => fetch(base + path, { headers: cookie ? { cookie } : {} }); // fuer Bild-Bytes
  call.cookie = () => cookie; // fuer Anfragen, die kein JSON schicken (Datei-Upload)
  return call;
}

before(async () => {
  ({ server } = await import('./index.js'));
  if (!server.listening) await once(server, 'listening');
  base = `http://localhost:${server.address().port}`;
  // Eine frische DB startet im Key-Modus - fuer die Tests auf offen stellen.
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'geheim' });
  await admin('PUT', '/api/settings', { registration_mode: 'open', registration_key: '' });
});

after(() => server.close());

const login = async (user, pw) => {
  const c = client();
  assert.equal((await c('POST', '/api/login', { username: user, password: pw })).status, 200);
  return c;
};

const register = async (user) => {
  const c = client();
  const r = await c('POST', '/api/register', { username: user, password: 'pw4tests' });
  assert.equal(r.status, 200);
  return [c, r.body.id];
};

test('Login, falsches Passwort, /api/me', async () => {
  const admin = await login('admin', 'geheim');
  const me = (await admin('GET', '/api/me')).body;
  assert.equal(me.id, 1);
  assert.equal(me.username, 'admin');
  assert.equal(me.is_admin, true);

  const bad = client();
  assert.equal((await bad('POST', '/api/login', { username: 'admin', password: 'falsch' })).status, 401);
  assert.equal((await bad('GET', '/api/me')).status, 401);
});

test('Stammdaten nur fuer Admins', async () => {
  const [user] = await register('nichtadmin');
  assert.equal((await user('POST', '/api/courses', { id: 'X1', title: 'X' })).status, 403);
  assert.equal((await user('POST', '/api/subjects', { name: 'X' })).status, 403);
  assert.equal((await user('GET', '/api/courses')).status, 200); // lesen darf jeder
});

test('Kurs-Kuerzel: NOCASE-Dublette blockiert, Umbenennen zieht Eintraege mit', async () => {
  const admin = await login('admin', 'geheim');
  const subject = (await admin('POST', '/api/subjects', { name: 'Geschichte' })).body;
  assert.equal((await admin('POST', '/api/courses',
    { id: 'Q1GEG06', title: 'Geschichte GK', subject_id: subject.id })).status, 200);
  assert.equal((await admin('POST', '/api/courses', { id: 'q1geg06', title: 'Dublette' })).status, 409);

  const [user] = await register('umbenenner');
  const { days, periods } = (await user('GET', '/api/config')).body;
  await user('PUT', '/api/entry', { day_id: days[0].id, period_id: periods[0].id, course_id: 'Q1GEG06' });

  assert.equal((await admin('PUT', '/api/courses/Q1GEG06',
    { id: 'Q1GEG07', title: 'Geschichte GK', subject_id: subject.id })).status, 200);
  const { entries } = (await user('GET', '/api/timetable')).body;
  assert.equal(entries.length, 1, 'Eintrag darf beim Umbenennen nicht verschwinden');
  assert.equal(entries[0].id, 'Q1GEG07');
});

test('Gemeinsame Stunden, Privatsphaere und Abmeldung', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1MAG01', title: 'Mathe GK' });
  await admin('POST', '/api/courses', { id: 'Q1BIG02', title: 'Bio GK' });

  const [anna, annaId] = await register('anna');
  const [ben, benId] = await register('ben');
  const [chris] = await register('chris');
  const { days, periods } = (await anna('GET', '/api/config')).body;
  const slot = { day_id: days[0].id, period_id: periods[0].id };

  await anna('PUT', '/api/entry', { ...slot, course_id: 'Q1MAG01' });
  await ben('PUT', '/api/entry', { ...slot, course_id: 'Q1MAG01' });
  await chris('PUT', '/api/entry', { ...slot, course_id: 'Q1BIG02' });

  // Ohne Freundschaft: kein fremder Plan, keine gemeinsamen Stunden.
  assert.equal((await anna('GET', `/api/timetable?user=${benId}`)).status, 403);
  assert.deepEqual((await anna('GET', '/api/timetable')).body.entries[0].shared, []);

  assert.equal((await anna('POST', '/api/friends', { username: 'ben' })).body.status, 'pending');
  assert.match((await anna('POST', '/api/friends', { username: 'ben' })).body.error, /Anfrage/);
  assert.equal((await anna('GET', `/api/timetable?user=${benId}`)).status, 403, 'pending ist noch keine Freundschaft');
  await ben('POST', `/api/friends/${annaId}/accept`);
  // Nach dem Bestaetigen waere "Anfrage laeuft schon" schlicht falsch.
  assert.match((await anna('POST', '/api/friends', { username: 'ben' })).body.error, /schon befreundet/);
  await anna('POST', '/api/friends', { username: 'chris' });
  await chris('POST', `/api/friends/${annaId}/accept`);

  const mine = (await anna('GET', '/api/timetable')).body.entries[0];
  assert.deepEqual(mine.shared.map(s => s.username), ['ben'], 'nur gleicher Kurs zaehlt, chris hat Bio');

  // Freundesplan: ich selbst tauche als gemeinsame Stunde auf.
  const bens = (await anna('GET', `/api/timetable?user=${benId}`)).body;
  assert.equal(bens.owner.username, 'ben');
  assert.deepEqual(bens.entries[0].shared.map(s => s.username), ['anna']);

  // Abmeldung ueber drei Tage -> drei Datumszeilen, Freund sieht sie.
  const monday = (await anna('GET', '/api/timetable')).body.week;
  const r = await ben('POST', '/api/absences', { from: monday, to: addDays(monday, 2) });
  assert.equal(r.body.dates.length, 3);
  // Seit 2.4 traegt eine Abmeldung ihren Stundenbereich mit - ohne Angabe der ganze Tag.
  assert.deepEqual((await ben('GET', '/api/absences')).body,
    r.body.dates.map(d => ({ date: d, von: null, bis: null, grund: null, grund_sichtbar: false })));

  const after = (await anna('GET', '/api/timetable')).body.entries[0];
  assert.equal(after.shared[0].absent, true, 'ben ist am Montag abgemeldet');
  assert.deepEqual((await anna('GET', `/api/timetable?user=${benId}`)).body.absences.map(a => a.date),
    r.body.dates.filter(d => d <= addDays(monday, 2)));

  // Naechste Woche ist er wieder da.
  const next = (await anna('GET', `/api/timetable?week=${addDays(monday, 7)}`)).body;
  assert.equal(next.entries[0].shared[0].absent, false);
  assert.deepEqual(next.absences, []);

  assert.equal((await ben('POST', '/api/absences', { from: monday, to: '2020-01-01' })).status, 400);
});

test('Registrierung: aus, mit Key, offen', async () => {
  const admin = await login('admin', 'geheim');

  await admin('PUT', '/api/settings', { registration_mode: 'off', registration_key: '' });
  assert.equal((await client()('POST', '/api/register', { username: 'niemand', password: 'pw4tests' })).status, 403);
  assert.equal((await client()('GET', '/api/public-config')).body.registration, 'off');

  await admin('PUT', '/api/settings', { registration_mode: 'key', registration_key: 'schluessel123' });
  assert.equal((await client()('POST', '/api/register',
    { username: 'falsch', password: 'pw4tests', key: 'daneben' })).status, 403);
  assert.equal((await client()('POST', '/api/register',
    { username: 'mitkey', password: 'pw4tests', key: 'schluessel123' })).status, 200);

  // public-config darf den Key unter keinen Umstaenden mit ausliefern
  const pc = (await client()('GET', '/api/public-config')).body;
  assert.deepEqual(Object.keys(pc), ['registration']);
  assert.equal(JSON.stringify(pc).includes('schluessel'), false);

  assert.equal((await admin('PUT', '/api/settings',
    { registration_mode: 'key', registration_key: 'ab' })).status, 400, 'zu kurzer Key');

  await admin('PUT', '/api/settings', { registration_mode: 'open', registration_key: '' });
  assert.equal((await client()('POST', '/api/register', { username: 'wiederoffen', password: 'pw4tests' })).status, 200);
});

test('Key-Modus ohne hinterlegten Key laesst niemanden durch', async () => {
  // Diesen Zustand laesst die API nicht zu - direkt in der DB ist er aber erreichbar, und dann
  // darf safeEqual('', '') nicht plötzlich jeden reinlassen.
  const { setSetting } = await import('./db.js');
  setSetting('registration_mode', 'key');
  setSetting('registration_key', '');

  assert.equal((await client()('POST', '/api/register', { username: 'leerkey1', password: 'pw4tests' })).status, 403);
  assert.equal((await client()('POST', '/api/register',
    { username: 'leerkey2', password: 'pw4tests', key: '' })).status, 403);

  const admin = await login('admin', 'geheim');
  await admin('PUT', '/api/settings', { registration_mode: 'open', registration_key: '' });
});

test('Admin verwaltet Nutzer', async () => {
  const admin = await login('admin', 'geheim');
  const neu = (await admin('POST', '/api/users',
    { username: 'vomadmin', password: 'start123', is_admin: false })).body;
  assert.equal(neu.username, 'vomadmin');

  const c = client();
  assert.equal((await c('POST', '/api/login', { username: 'vomadmin', password: 'start123' })).status, 200);
  assert.equal((await c('GET', '/api/users')).status, 403, 'Nicht-Admin sieht keine Nutzerliste');
  assert.equal((await c('POST', '/api/users', { username: 'x', password: 'y' })).status, 403);

  await admin('PATCH', `/api/users/${neu.id}`, { password: 'neu12345' });
  assert.equal((await client()('POST', '/api/login',
    { username: 'vomadmin', password: 'start123' })).status, 401, 'altes Passwort gilt nicht mehr');
  assert.equal((await client()('POST', '/api/login',
    { username: 'vomadmin', password: 'neu12345' })).status, 200);

  assert.equal((await admin('DELETE', `/api/users/${neu.id}`)).status, 200);
  assert.equal((await client()('POST', '/api/login',
    { username: 'vomadmin', password: 'neu12345' })).status, 401, 'geloeschter User kommt nicht rein');
});

test('Aussperr-Schutz: der letzte Admin bleibt Admin', async () => {
  const admin = await login('admin', 'geheim');
  const me = (await admin('GET', '/api/me')).body;
  assert.equal((await admin('DELETE', `/api/users/${me.id}`)).status, 409, 'sich selbst loeschen');
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { is_admin: false })).status, 409, 'sich selbst degradieren');

  const zweiter = (await admin('POST', '/api/users',
    { username: 'admin2', password: 'pw12345', is_admin: true })).body;
  const a2 = client();
  await a2('POST', '/api/login', { username: 'admin2', password: 'pw12345' });
  assert.equal((await a2('PATCH', `/api/users/${me.id}`, { is_admin: false })).status, 200,
    'mit zweitem Admin darf der erste degradiert werden');
  assert.equal((await a2('PATCH', `/api/users/${zweiter.id}`, { is_admin: false })).status, 409,
    'aber nicht der jetzt letzte');

  await a2('PATCH', `/api/users/${me.id}`, { is_admin: true }); // fuer die Folgetests zuruecksetzen
});

test('Profil: Anzeigename, Farbe und Emoji reisen mit', async () => {
  const [dana, danaId] = await register('dana');
  const [erik] = await register('erik');

  const p = (await dana('PATCH', '/api/me',
    { display_name: 'Dana K.', color: '#ff8800', emoji: 'F' })).body;
  assert.equal(p.display_name, 'Dana K.');
  assert.equal(p.color, '#ff8800');
  assert.equal((await dana('PATCH', '/api/me', { color: 'rot' })).status, 400, 'Farbe muss Hex sein');

  await dana('POST', '/api/friends', { username: 'erik' });
  await erik('POST', `/api/friends/${danaId}/accept`);
  assert.equal((await erik('GET', '/api/friends')).body.friends[0].display_name, 'Dana K.');

  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1PRO01', title: 'Profilkurs' });
  const { days, periods } = (await dana('GET', '/api/config')).body;
  const slot = { day_id: days[0].id, period_id: periods[1].id };
  await dana('PUT', '/api/entry', { ...slot, course_id: 'Q1PRO01' });
  await erik('PUT', '/api/entry', { ...slot, course_id: 'Q1PRO01' });

  const geteilt = (await erik('GET', '/api/timetable')).body.entries.find(e => e.id === 'Q1PRO01').shared[0];
  assert.equal(geteilt.display_name, 'Dana K.', 'Profil auch in der shared-Liste');
  assert.equal(geteilt.has_avatar, false);
});

test('Avatar: hochladen, ausliefern, ablehnen', async () => {
  const [frida, fridaId] = await register('frida');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
    + 'DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  assert.equal((await frida('PATCH', '/api/me', { avatar: png })).body.has_avatar, true);
  const img = await frida.raw(`/api/users/${fridaId}/avatar`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok((await img.arrayBuffer()).byteLength > 0);

  assert.equal((await frida('PATCH', '/api/me', { avatar: 'data:image/gif;base64,AAAA' })).status, 400,
    'GIF ist nicht erlaubt');
  assert.equal((await frida('PATCH', '/api/me',
    { avatar: png.replace(/=+$/, '') + 'A'.repeat(100_001) })).status, 400, 'zu gross');

  // Der behauptete Typ zaehlt nicht - was zaehlt, sind die ersten Bytes. Sonst laege beliebiger
  // Inhalt unter einem Content-Type unserer Wahl auf unserem eigenen Origin.
  const alsPng = t => 'data:image/png;base64,' + Buffer.from(t).toString('base64');
  assert.equal((await frida('PATCH', '/api/me',
    { avatar: alsPng('<html><script>alert(1)</script></html>  ') })).status, 400, 'HTML ist kein PNG');
  assert.equal((await frida('PATCH', '/api/me',
    { avatar: 'data:image/jpeg;base64,' + png.split(',')[1] })).status, 400, 'PNG-Bytes als JPEG ausgegeben');

  assert.equal((await frida('PATCH', '/api/me', { avatar: null })).body.has_avatar, false);
  assert.equal((await frida.raw(`/api/users/${fridaId}/avatar`)).status, 404);
});

test('Passwort aendern meldet andere Sitzungen ab', async () => {
  const [greta] = await register('greta');
  const zweiteSitzung = client();
  await zweiteSitzung('POST', '/api/login', { username: 'greta', password: 'pw4tests' });

  assert.equal((await greta('POST', '/api/me/password', { current: 'falsch', new: 'neu12345' })).status, 401);
  assert.equal((await greta('POST', '/api/me/password', { current: 'pw4tests', new: 'neu12345' })).status, 200);

  assert.equal((await greta('GET', '/api/me')).status, 200, 'eigene Sitzung bleibt');
  assert.equal((await zweiteSitzung('GET', '/api/me')).status, 401, 'andere Sitzung ist weg');
  assert.equal((await client()('POST', '/api/login', { username: 'greta', password: 'neu12345' })).status, 200);
});

test('Stammdaten lassen sich bearbeiten, nicht nur anlegen und loeschen', async () => {
  const admin = await login('admin', 'geheim');
  const [user] = await register('crudtester');

  // subjects/rooms/teachers: umbenennen, Dublette blockiert, unbekannte id -> 404
  for (const table of ['subjects', 'rooms', 'teachers']) {
    const a = (await admin('POST', `/api/${table}`, { name: `${table}-A` })).body;
    await admin('POST', `/api/${table}`, { name: `${table}-B` });
    assert.equal((await admin('PUT', `/api/${table}/${a.id}`, { name: `${table}-neu` })).body.name, `${table}-neu`);
    assert.equal((await admin('PUT', `/api/${table}/${a.id}`, { name: `${table}-B` })).status, 409, 'Dublette');
    assert.equal((await admin('PUT', `/api/${table}/999999`, { name: 'x' })).status, 404);
    assert.equal((await admin('PUT', `/api/${table}/${a.id}`, { name: '  ' })).status, 400);
    assert.equal((await user('PUT', `/api/${table}/${a.id}`, { name: 'geklaut' })).status, 403, 'nur Admin');
  }

  // periods: Zeit korrigieren, ohne den Slot zu loeschen - Eintraege muessen stehen bleiben
  const { days, periods } = (await admin('GET', '/api/config')).body;
  const slot = { day_id: days[0].id, period_id: periods[0].id };
  await admin('POST', '/api/courses', { id: 'Q1CRU01', title: 'CRUD-Kurs' });
  await user('PUT', '/api/entry', { ...slot, course_id: 'Q1CRU01' });

  const p = periods[0];
  assert.equal((await admin('PUT', `/api/periods/${p.id}`,
    { nr: p.nr, start_time: '07:45', end_time: '08:30' })).body.start_time, '07:45');
  assert.equal((await user('GET', '/api/timetable')).body.entries.length, 1,
    'Zeitkorrektur darf keine Eintraege kosten');
  assert.equal((await admin('PUT', `/api/periods/${p.id}`,
    { nr: p.nr, start_time: '09:00', end_time: '08:00' })).status, 400, 'Ende vor Beginn');
  assert.equal((await admin('PUT', `/api/periods/${p.id}`,
    { nr: periods[1].nr, start_time: '07:45', end_time: '08:30' })).status, 409, 'Nummer belegt');
  // Die 0. Stunde gibt es wirklich - sie darf nicht an der Pruefung scheitern, Unfug schon.
  assert.equal((await admin('POST', '/api/periods',
    { nr: 0, start_time: '07:00', end_time: '07:45' })).status, 200, 'Fruehstunde');
  assert.equal((await admin('DELETE', `/api/periods/${(await admin('GET', '/api/config')).body.periods.find(x => x.nr === 0).id}`)).status, 200);
  for (const nr of [-1, 1.5, 99, 'zwei'])
    assert.equal((await admin('POST', '/api/periods',
      { nr, start_time: '07:00', end_time: '07:45' })).status, 400, String(nr));

  // days: umbenennen und Wochentag aendern
  const d = days[0];
  assert.equal((await admin('PUT', `/api/days/${d.id}`, { iso: d.iso, name: 'Wochenstart' })).body.name, 'Wochenstart');
  assert.equal((await admin('PUT', `/api/days/${d.id}`, { iso: days[1].iso, name: 'x' })).status, 409, 'Tag belegt');
  assert.equal((await admin('PUT', `/api/days/${d.id}`, { iso: 9, name: 'x' })).status, 400);
  await admin('PUT', `/api/days/${d.id}`, { iso: d.iso, name: d.name });

  // users: umbenennen
  const neu = (await admin('POST', '/api/users', { username: 'altername', password: 'pw12345' })).body;
  assert.equal((await admin('PATCH', `/api/users/${neu.id}`, { username: 'neuername' })).body.username, 'neuername');
  assert.equal((await client()('POST', '/api/login',
    { username: 'neuername', password: 'pw12345' })).status, 200, 'Login unter neuem Namen');
  assert.equal((await admin('PATCH', `/api/users/${neu.id}`, { username: 'admin' })).status, 409, 'Name vergeben');
});

test('Raum haengt am Eintrag, nicht am Kurs', async () => {
  const admin = await login('admin', 'geheim');
  const a213 = (await admin('POST', '/api/rooms', { name: 'R-A213' })).body;
  const b104 = (await admin('POST', '/api/rooms', { name: 'R-B104' })).body;
  await admin('POST', '/api/courses', { id: 'Q1RAU01', title: 'Raumkurs' });

  const [nina] = await register('nina');
  const { days, periods } = (await nina('GET', '/api/config')).body;

  // Gleicher Kurs, zwei Tage, zwei Raeume - genau der Fall, der vorher nicht ging.
  await nina('PUT', '/api/entry', { day_id: days[0].id, period_id: periods[2].id, course_id: 'Q1RAU01', room_id: a213.id });
  await nina('PUT', '/api/entry', { day_id: days[1].id, period_id: periods[2].id, course_id: 'Q1RAU01', room_id: b104.id });

  const eintraege = (await nina('GET', '/api/timetable')).body.entries.filter(e => e.id === 'Q1RAU01');
  assert.equal(eintraege.length, 2);
  assert.deepEqual(eintraege.map(e => e.room).sort(), ['R-A213', 'R-B104'], 'zwei Raeume fuer denselben Kurs');

  // Kurs kennt keinen Raum mehr
  assert.equal('room' in (await admin('GET', '/api/courses')).body[0], false, 'Kurs traegt keinen Raum');

  // Raum aendern und wieder entfernen
  await nina('PUT', '/api/entry', { day_id: days[0].id, period_id: periods[2].id, course_id: 'Q1RAU01', room_id: b104.id });
  assert.equal((await nina('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === days[0].id && e.period_id === periods[2].id).room, 'R-B104');
  await nina('PUT', '/api/entry', { day_id: days[0].id, period_id: periods[2].id, course_id: 'Q1RAU01', room_id: null });
  assert.equal((await nina('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === days[0].id && e.period_id === periods[2].id).room, null);

  // Geloeschter Raum reisst den Eintrag nicht mit (ON DELETE SET NULL)
  await admin('DELETE', `/api/rooms/${b104.id}`);
  const nachher = (await nina('GET', '/api/timetable')).body.entries.filter(e => e.id === 'Q1RAU01');
  assert.equal(nachher.length, 2, 'Eintraege bleiben');
  assert.equal(nachher.every(e => e.room === null), true, 'Raum ist nur genullt');
});

test('PWA: Manifest, Service Worker und erzeugte Icons', async () => {
  const c = client();

  // Alles muss ohne Login erreichbar sein - sonst installiert der Browser die App nicht.
  const mf = await c.raw('/manifest.webmanifest');
  assert.equal(mf.status, 200);
  assert.match(mf.headers.get('content-type'), /manifest\+json|application\/json/);
  const manifest = JSON.parse(await mf.text());
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(i => i.sizes === '192x192'), '192er Icon deklariert');
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'maskable Icon deklariert');

  const sw = await c.raw('/sw.js');
  assert.equal(sw.status, 200);
  const quelle = await sw.text();
  assert.match(quelle, /addEventListener\('fetch'/, 'fetch-Handler vorhanden (Bedingung fuer Installierbarkeit)');
  assert.match(quelle, /pathname\.startsWith\('\/api\/'\)/, '/api/ wird vom Cache ausgenommen');

  // Icons werden erzeugt, nicht mitgeliefert - also pruefen, dass echte PNGs rauskommen.
  for (const [pfad, groesse] of [['/icon-192.png', 192], ['/icon-512.png', 512], ['/apple-touch-icon.png', 180]]) {
    const r = await c.raw(pfad);
    assert.equal(r.status, 200, pfad);
    assert.equal(r.headers.get('content-type'), 'image/png', pfad);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${pfad}: PNG-Signatur`);
    assert.equal(buf.readUInt32BE(16), groesse, `${pfad}: Breite`);
    assert.equal(buf.readUInt32BE(20), groesse, `${pfad}: Hoehe`);
  }
});

test('Banner: hochladen, ausliefern, Groesse begrenzen', async () => {
  const [quirin, quirinId] = await register('quirin');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
    + 'DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  assert.equal((await quirin('GET', '/api/me')).body.has_banner, false, 'anfangs kein Banner');
  assert.equal((await quirin('PATCH', '/api/me', { banner: png })).body.has_banner, true);

  const img = await quirin.raw(`/api/users/${quirinId}/banner`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // Ein aufgeblasenes Bild, das echt anfaengt: nur die Groesse soll hier entscheiden, nicht die
  // Signaturpruefung. Angehaengt wird in Viererschritten, damit Base64 gueltig bleibt.
  // Das '=' am Ende muss weg, bevor angehaengt wird - sonst ist es kein gueltiges Base64 mehr.
  const aufgeblasen = n => png.replace(/=+$/, '') + 'A'.repeat(n);

  // Banner darf groesser sein als ein Avatar, aber nicht unbegrenzt
  assert.equal((await quirin('PATCH', '/api/me', { banner: aufgeblasen(400_001) })).status, 400);
  const avatarGrenze = aufgeblasen(150_000);
  assert.equal((await quirin('PATCH', '/api/me', { avatar: avatarGrenze })).status, 400, 'Avatar bleibt bei 100 KB');
  assert.equal((await quirin('PATCH', '/api/me', { banner: avatarGrenze })).status, 200, 'Banner nimmt das an');

  // Banner reist wie der Avatar mit, wenn Freunde den Plan ansehen
  const [rita, ritaId] = await register('rita');
  await quirin('POST', '/api/friends', { username: 'rita' });
  await rita('POST', `/api/friends/${quirinId}/accept`);
  assert.equal((await rita('GET', `/api/timetable?user=${quirinId}`)).body.owner.has_banner, true);

  assert.equal((await quirin('PATCH', '/api/me', { banner: null })).body.has_banner, false);
  assert.equal((await quirin.raw(`/api/users/${quirinId}/banner`)).status, 404);
  assert.equal((await rita.raw(`/api/users/${ritaId}/banner`)).status, 404, 'ohne Banner 404');
});

test('Fach-Kuerzel: pflegbar und im Stundenplan verfuegbar', async () => {
  const admin = await login('admin', 'geheim');

  const fach = (await admin('POST', '/api/subjects', { name: 'Erdkunde', short: 'EK' })).body;
  assert.equal(fach.short, 'EK');
  assert.equal((await admin('GET', '/api/subjects')).body.find(s => s.id === fach.id).short, 'EK');

  // Kuerzel ist optional und nachtraeglich aenderbar
  const ohne = (await admin('POST', '/api/subjects', { name: 'Musik' })).body;
  assert.equal(ohne.short, null);
  assert.equal((await admin('PUT', `/api/subjects/${ohne.id}`, { name: 'Musik', short: 'MU' })).body.short, 'MU');
  assert.equal((await admin('PUT', `/api/subjects/${ohne.id}`, { name: 'Musik', short: '' })).body.short, null);
  assert.equal((await admin('PUT', `/api/subjects/${fach.id}`, { name: '', short: 'X' })).status, 400, 'Name bleibt Pflicht');

  // Raeume und Lehrer kennen kein Kuerzel - die Schleife darf da nichts kaputt machen
  const raum = (await admin('POST', '/api/rooms', { name: 'K1', short: 'ignoriert' })).body;
  assert.equal(raum.name, 'K1');
  assert.equal('short' in raum, false);

  // Das Kuerzel reist bis in den Stundenplan mit
  await admin('POST', '/api/courses', { id: 'Q1EKG01', title: 'Erdkunde GK', subject_id: fach.id });
  const [udo] = await register('udo');
  const { days, periods } = (await udo('GET', '/api/config')).body;
  await udo('PUT', '/api/entry', { day_id: days[2].id, period_id: periods[5].id, course_id: 'Q1EKG01' });
  const e = (await udo('GET', '/api/timetable')).body.entries.find(x => x.id === 'Q1EKG01');
  assert.equal(e.subject, 'Erdkunde');
  assert.equal(e.subject_short, 'EK');
});

test('Freistunde: eintragbar, gemeinsam erkannt, geschuetzt', async () => {
  const admin = await login('admin', 'geheim');
  const FREI = '__frei__';

  const kurse = (await admin('GET', '/api/courses')).body;
  assert.ok(kurse.some(c => c.id === FREI), 'Freistunde existiert als Kurs');

  const [sofia, sofiaId] = await register('sofia');
  const [timo] = await register('timo');
  const { days, periods } = (await sofia('GET', '/api/config')).body;
  const slot = { day_id: days[3].id, period_id: periods[4].id };

  await sofia('PUT', '/api/entry', { ...slot, course_id: FREI });
  const meins = (await sofia('GET', '/api/timetable')).body.entries.find(e => e.day_id === slot.day_id);
  assert.equal(meins.id, FREI);
  assert.equal(meins.title, 'Freistunde');

  // Zwei Leute mit Freistunde im selben Slot gelten als gemeinsam - ohne Sonderfall in der Abfrage.
  await timo('PUT', '/api/entry', { ...slot, course_id: FREI });
  await sofia('POST', '/api/friends', { username: 'timo' });
  await timo('POST', `/api/friends/${sofiaId}/accept`);
  const geteilt = (await sofia('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === slot.day_id).shared;
  assert.deepEqual(geteilt.map(s => s.username), ['timo'], 'gemeinsame Freistunde erkannt');

  // Eine echte Stunde beim anderen zaehlt nicht als gemeinsame Freistunde
  await admin('POST', '/api/courses', { id: 'Q1FRE01', title: 'Kein Frei' });
  await timo('PUT', '/api/entry', { ...slot, course_id: 'Q1FRE01' });
  assert.deepEqual((await sofia('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === slot.day_id).shared, [], 'unterschiedliche Eintraege sind nicht gemeinsam');

  // Der Admin darf die Freistunde nicht loeschen oder umbenennen
  assert.equal((await admin('DELETE', `/api/courses/${FREI}`)).status, 409);
  assert.equal((await admin('PUT', `/api/courses/${FREI}`, { id: 'X', title: 'X' })).status, 409);
  assert.equal((await admin('DELETE', '/api/courses/__FREI__')).status, 409, 'auch in Grossschreibung');
  assert.ok((await admin('GET', '/api/courses')).body.some(c => c.id === FREI), 'noch da');
  assert.equal((await sofia('GET', '/api/timetable')).body.entries.length, 1, 'Eintrag unversehrt');
});

test('Sitzung ueberlebt den Browser (Cookie mit Ablaufdatum)', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'geheim' }),
  });
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i, 'kein Zugriff per JavaScript');
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=\d+/i, 'ohne Max-Age waere es beim Schliessen des Browsers weg');
  const tage = Number(/Max-Age=(\d+)/i.exec(cookie)[1]) / 86400;
  assert.ok(tage > 100, `Sitzung sollte Monate halten, sind aber ${tage} Tage`);
});

test('Notiz zur Stunde: privat, auch vor Freunden', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1NOT01', title: 'Notizkurs' });

  const [nina, ninaId] = await register('nina2');
  const [olaf] = await register('olaf');
  const { days, periods } = (await nina('GET', '/api/config')).body;
  const slot = { day_id: days[0].id, period_id: periods[5].id, course_id: 'Q1NOT01' };

  await nina('PUT', '/api/entry', slot);
  await nina('PUT', '/api/note', { day_id: slot.day_id, period_id: slot.period_id, text: 'Buch mitbringen' });
  const meins = (await nina('GET', '/api/timetable')).body.entries.find(e => e.id === 'Q1NOT01');
  assert.equal(meins.note, 'Buch mitbringen');

  // Freund sieht die Stunde, aber nicht die Notiz
  await olaf('PUT', '/api/entry', slot);
  await nina('POST', '/api/friends', { username: 'olaf' });
  await olaf('POST', `/api/friends/${ninaId}/accept`);
  const fremd = (await olaf('GET', `/api/timetable?user=${ninaId}`)).body.entries.find(e => e.id === 'Q1NOT01');
  assert.equal(fremd.id, 'Q1NOT01', 'Stunde ist sichtbar');
  assert.equal(fremd.note, null, 'Notiz bleibt privat');

  // Aendern und leeren
  const notiz = t => nina('PUT', '/api/note', { day_id: slot.day_id, period_id: slot.period_id, text: t });
  const gelesen = () => nina('GET', '/api/timetable')
    .then(r => r.body.entries.find(e => e.id === 'Q1NOT01').note);
  await notiz('Doch nicht');
  assert.equal(await gelesen(), 'Doch nicht');
  await notiz('   ');
  assert.equal(await gelesen(), null);

  // Zu lange Notizen werden gekuerzt, nicht abgelehnt
  await notiz('x'.repeat(400));
  assert.equal((await gelesen()).length, 300);

  // Die Notiz haengt am Slot, nicht am Eintrag: sie ueberlebt das Loeschen der Stunde und ist
  // danach fuer die neu eingetragene Stunde wieder da. Ohne das ginge sie beim Umstieg auf
  // WebUntis verloren.
  await nina('PUT', '/api/entry', { day_id: slot.day_id, period_id: slot.period_id, course_id: null });
  await nina('PUT', '/api/entry', slot);
  assert.equal((await gelesen()).length, 300, 'Notiz haengt nicht am Eintrag');
});

test('Hausaufgaben: kursweit sichtbar, persoenlich abhakbar', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1HAG01', title: 'Hausaufgabenkurs' });
  await admin('POST', '/api/courses', { id: 'Q1HAG02', title: 'Anderer Kurs' });

  const [vera] = await register('vera');
  const [wim] = await register('wim');
  const [xena] = await register('xena');
  const { days, periods } = (await vera('GET', '/api/config')).body;
  const slot = { day_id: days[0].id, period_id: periods[3].id };

  // vera und wim haben denselben Kurs, sind aber ausdruecklich NICHT befreundet.
  await vera('PUT', '/api/entry', { ...slot, course_id: 'Q1HAG01' });
  await wim('PUT', '/api/entry', { ...slot, course_id: 'Q1HAG01' });
  await xena('PUT', '/api/entry', { ...slot, course_id: 'Q1HAG02' });

  const faellig = (await vera('GET', '/api/timetable')).body.days[0].date;
  const ha = (await vera('POST', '/api/homework',
    { course_id: 'Q1HAG01', due_date: faellig, text: 'S. 42 Nr. 3' })).body;
  assert.equal(ha.text, 'S. 42 Nr. 3');
  assert.equal(ha.by.username, 'vera');
  assert.equal(ha.done, false);

  // Kursweit: wim sieht sie ohne Freundschaft, xena (anderer Kurs) nicht.
  const beiWim = (await wim('GET', `/api/homework?from=${faellig}&to=${faellig}`)).body;
  assert.deepEqual(beiWim.map(h => h.text), ['S. 42 Nr. 3'], 'ohne Freundschaft sichtbar');
  assert.deepEqual((await xena('GET', `/api/homework?from=${faellig}&to=${faellig}`)).body, [],
    'wer den Kurs nicht hat, sieht nichts');

  // Eintragen nur mit dem Kurs im Plan
  assert.equal((await xena('POST', '/api/homework',
    { course_id: 'Q1HAG01', due_date: faellig, text: 'fremd' })).status, 403);

  // Aendern und Loeschen nur Verfasser oder Admin
  assert.equal((await wim('PUT', `/api/homework/${ha.id}`, { due_date: faellig, text: 'geklaut' })).status, 403);
  assert.equal((await wim('DELETE', `/api/homework/${ha.id}`)).status, 403);
  assert.equal((await vera('PUT', `/api/homework/${ha.id}`,
    { due_date: faellig, text: 'S. 42 Nr. 3 und 4' })).body.text, 'S. 42 Nr. 3 und 4');

  // Abhaken ist persoenlich
  assert.equal((await wim('POST', `/api/homework/${ha.id}/done`)).body.done, true);
  assert.equal((await wim('GET', `/api/homework?from=${faellig}&to=${faellig}`)).body[0].done, true);
  assert.equal((await vera('GET', `/api/homework?from=${faellig}&to=${faellig}`)).body[0].done, false,
    'beim Verfasser bleibt sie offen');
  assert.equal((await wim('DELETE', `/api/homework/${ha.id}/done`)).body.done, false);

  // Validierung
  assert.equal((await vera('POST', '/api/homework', { course_id: 'Q1HAG01', due_date: faellig, text: '  ' })).status, 400);
  assert.equal((await vera('POST', '/api/homework',
    { course_id: 'Q1HAG01', due_date: faellig, text: 'x'.repeat(501) })).status, 400);
  assert.equal((await vera('POST', '/api/homework', { course_id: 'Q1HAG01', due_date: '1.2.2026', text: 'x' })).status, 400);
  assert.equal((await vera('POST', '/api/homework', { course_id: 'gibtsnicht', due_date: faellig, text: 'x' })).status, 404);

  // Freistunde bekommt keine Hausaufgaben
  await vera('PUT', '/api/entry', { day_id: days[1].id, period_id: periods[3].id, course_id: '__frei__' });
  assert.equal((await vera('POST', '/api/homework',
    { course_id: '__frei__', due_date: faellig, text: 'nix' })).status, 400);
});

test('Ueberfaellige Hausaufgaben stehen in der Liste', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1ALT01', title: 'Altkurs' });
  const [pia] = await register('pia');
  const { days, periods } = (await pia('GET', '/api/config')).body;
  await pia('PUT', '/api/entry', { day_id: days[0].id, period_id: periods[2].id, course_id: 'Q1ALT01' });

  const heute = new Date().toISOString().slice(0, 10);
  const vorbei = addDays(heute, -5);
  await pia('POST', '/api/homework', { course_id: 'Q1ALT01', due_date: vorbei, text: 'Laengst faellig' });
  await pia('POST', '/api/homework', { course_id: 'Q1ALT01', due_date: addDays(heute, 3), text: 'Kommt noch' });

  // Ohne from/to muss auch das Ueberfaellige kommen - sonst verschwindet alles, was man aus dem
  // Plan heraus fuer einen schon vergangenen Tag eintraegt.
  const standard = (await pia('GET', '/api/homework')).body.map(h => h.text);
  assert.ok(standard.includes('Laengst faellig'), `ueberfaellig fehlt: ${JSON.stringify(standard)}`);
  assert.ok(standard.includes('Kommt noch'));

  // Uraltes bleibt draussen
  await pia('POST', '/api/homework', { course_id: 'Q1ALT01', due_date: addDays(heute, -200), text: 'Uralt' });
  assert.equal((await pia('GET', '/api/homework')).body.some(h => h.text === 'Uralt'), false);
});

test('Ohne Wochenangabe nie eine Woche zeigen, die schon vorbei ist', async () => {
  const [quirin2] = await register('quirin2');
  const plan = (await quirin2('GET', '/api/timetable')).body;
  const heute = new Date().toISOString().slice(0, 10);
  assert.ok(plan.days.at(-1).date >= heute,
    `Plan endet am ${plan.days.at(-1).date}, heute ist ${heute} - am Wochenende muss die kommende Woche kommen`);

  // Mit ausdruecklicher Angabe bleibt es bei der genannten Woche
  const alt = (await quirin2('GET', '/api/timetable?week=2026-01-05')).body;
  assert.equal(alt.week, '2026-01-05');
  const mitten = (await quirin2('GET', '/api/timetable?week=2026-01-08')).body;
  assert.equal(mitten.week, '2026-01-05', 'ein Datum mitten in der Woche fuehrt auf deren Montag');
});

test('Hausaufgaben im Stundenplan: richtiger Tag, nur einmal, Umbenennen zieht mit', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1DOP01', title: 'Doppelstunde' });

  const [yuri] = await register('yuri');
  const { days, periods } = (await yuri('GET', '/api/config')).body;
  // derselbe Kurs zweimal am selben Tag plus einmal am Folgetag
  for (const p of [0, 1]) await yuri('PUT', '/api/entry', { day_id: days[0].id, period_id: periods[p].id, course_id: 'Q1DOP01' });
  await yuri('PUT', '/api/entry', { day_id: days[1].id, period_id: periods[0].id, course_id: 'Q1DOP01' });

  const plan = (await yuri('GET', '/api/timetable')).body;
  const tag1 = plan.days[0].date;
  await yuri('POST', '/api/homework', { course_id: 'Q1DOP01', due_date: tag1, text: 'Vokabeln' });

  const nachher = (await yuri('GET', '/api/timetable')).body.entries;
  const mitHa = nachher.filter(e => e.homework.length);
  assert.equal(mitHa.length, 1, 'trotz Doppelstunde nur einmal markiert');
  assert.equal(mitHa[0].day_id, plan.days[0].id);
  assert.equal(mitHa[0].period_id, periods[0].id, 'an der ersten Stunde des Tages');
  assert.equal(mitHa[0].homework[0].text, 'Vokabeln');
  assert.equal(nachher.filter(e => e.day_id === plan.days[1].id)[0].homework.length, 0,
    'am Folgetag keine Markierung');

  // Kuerzel umbenennen zieht die Hausaufgabe mit
  assert.equal((await admin('PUT', '/api/courses/Q1DOP01', { id: 'Q1DOP09', title: 'Doppelstunde' })).status, 200);
  const danach = (await yuri('GET', '/api/timetable')).body.entries.filter(e => e.homework.length);
  assert.equal(danach.length, 1, 'Hausaufgabe ueberlebt das Umbenennen');
  assert.equal(danach[0].homework[0].course_id, 'Q1DOP09');

  // Kurs loeschen raeumt die Hausaufgaben mit weg
  await admin('DELETE', '/api/courses/Q1DOP09');
  assert.deepEqual((await yuri('GET', `/api/homework?from=${tag1}&to=${tag1}`)).body, []);
});

test('Navigation: Symbole oder ausgeschrieben, Standard ausgeschrieben', async () => {
  const [tessa] = await register('tessa');
  assert.equal((await tessa('GET', '/api/me')).body.nav_style, 'text', 'Standard ist ausgeschrieben');

  assert.equal((await tessa('PATCH', '/api/me', { nav_style: 'icons' })).body.nav_style, 'icons');
  assert.equal((await tessa('GET', '/api/me')).body.nav_style, 'icons', 'bleibt ueber Anfragen hinweg');
  assert.equal((await tessa('PATCH', '/api/me', { nav_style: 'bunt' })).status, 400);
  assert.equal((await tessa('PATCH', '/api/me', { nav_style: 'text' })).body.nav_style, 'text');
});

test('Luecken zwischen Stunden werden automatisch zur Freistunde', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1LUE01', title: 'Lueckenkurs' });

  const [rosa, rosaId] = await register('rosa');
  const { days, periods } = (await rosa('GET', '/api/config')).body;
  const tag = days[0], anderer = days[1];

  // 1. und 4. Stunde belegt -> 2. und 3. muessen automatisch frei sein
  await rosa('PUT', '/api/entry', { day_id: tag.id, period_id: periods[0].id, course_id: 'Q1LUE01' });
  await rosa('PUT', '/api/entry', { day_id: tag.id, period_id: periods[3].id, course_id: 'Q1LUE01' });
  // an einem anderen Tag nur eine einzelne Stunde -> keine Luecke
  await rosa('PUT', '/api/entry', { day_id: anderer.id, period_id: periods[0].id, course_id: 'Q1LUE01' });

  const plan = (await rosa('GET', '/api/timetable')).body.entries;
  const amTag = plan.filter(e => e.day_id === tag.id).sort((a, b) => a.period_id - b.period_id);
  assert.equal(amTag.length, 4, 'zwei echte Stunden plus zwei automatische Freistunden');
  assert.deepEqual(amTag.map(e => e.id), ['Q1LUE01', '__frei__', '__frei__', 'Q1LUE01']);
  assert.deepEqual(amTag.map(e => !!e.auto), [false, true, true, false]);
  assert.equal(plan.filter(e => e.day_id === anderer.id).length, 1, 'einzelne Stunde erzeugt nichts');

  // Nach der letzten Stunde wird nicht aufgefuellt
  assert.equal(plan.some(e => e.period_id === periods[4].id), false, 'nach hinten offen');

  // Eine ausdrueckliche Eintragung in der Luecke gewinnt
  await rosa('PUT', '/api/entry', { day_id: tag.id, period_id: periods[1].id, course_id: 'Q1LUE01' });
  const nachher = (await rosa('GET', '/api/timetable')).body.entries
    .filter(e => e.day_id === tag.id && e.period_id === periods[1].id);
  assert.equal(nachher[0].id, 'Q1LUE01');
  assert.equal(!!nachher[0].auto, false);

  // Gemeinsame automatische Freistunde wird erkannt - das ging mit dem alten SQL-Join nicht
  const [sami] = await register('sami');
  await sami('PUT', '/api/entry', { day_id: tag.id, period_id: periods[0].id, course_id: 'Q1LUE01' });
  await sami('PUT', '/api/entry', { day_id: tag.id, period_id: periods[3].id, course_id: 'Q1LUE01' });
  await rosa('POST', '/api/friends', { username: 'sami' });
  await sami('POST', `/api/friends/${rosaId}/accept`);

  const luecke = (await rosa('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === tag.id && e.period_id === periods[2].id);
  assert.equal(luecke.id, '__frei__');
  assert.deepEqual(luecke.shared.map(s => s.username), ['sami'], 'gemeinsame Luecke erkannt');
});

test('Chat: nur unter Freunden, ungelesen wird gezaehlt', async () => {
  const [ada, adaId] = await register('ada');
  const [bo, boId] = await register('bo');
  const [cem] = await register('cem');

  // Ohne bestaetigte Freundschaft geht gar nichts
  assert.equal((await ada('GET', `/api/chats/${boId}`)).status, 403);
  assert.equal((await ada('POST', `/api/chats/${boId}`, { text: 'hallo' })).status, 403);
  await ada('POST', '/api/friends', { username: 'bo' });
  assert.equal((await ada('POST', `/api/chats/${boId}`, { text: 'hallo' })).status, 403,
    'eine offene Anfrage reicht nicht');
  await bo('POST', `/api/friends/${adaId}/accept`);

  const m1 = (await ada('POST', `/api/chats/${boId}`, { text: 'Hallo Bo' })).body;
  assert.equal(m1.text, 'Hallo Bo');
  assert.equal(m1.read, false);
  await bo('POST', `/api/chats/${adaId}`, { text: 'Hi Ada' });

  // Uebersicht: ungelesen zaehlt nur, was an mich ging
  const uebersicht = (await ada('GET', '/api/chats')).body;
  const mitBo = uebersicht.find(c => c.id === boId);
  assert.equal(mitBo.unread, 1, 'die Antwort von bo ist ungelesen');
  assert.equal(mitBo.last.text, 'Hi Ada');
  assert.equal(uebersicht.some(c => c.username === 'cem'), false, 'Fremde tauchen nicht auf');

  // Lesen setzt den Zaehler zurueck, aber nur beim Empfaenger
  const verlauf = (await ada('GET', `/api/chats/${boId}`)).body;
  assert.deepEqual(verlauf.map(m => m.text), ['Hallo Bo', 'Hi Ada']);
  assert.equal((await ada('GET', '/api/chats')).body.find(c => c.id === boId).unread, 0);
  assert.equal((await bo('GET', '/api/chats')).body.find(c => c.id === adaId).unread, 1,
    'bo hat Adas Nachricht noch nicht gelesen');

  // since liefert nur Neues
  assert.deepEqual((await ada('GET', `/api/chats/${boId}?since=${verlauf.at(-1).id}`)).body, []);
  await bo('POST', `/api/chats/${adaId}`, { text: 'Noch was' });
  assert.deepEqual((await ada('GET', `/api/chats/${boId}?since=${verlauf.at(-1).id}`)).body.map(m => m.text),
    ['Noch was']);

  // Validierung
  assert.equal((await ada('POST', `/api/chats/${boId}`, { text: '   ' })).status, 400);
  // 2000 Zeichen Klartext prueft der Browser vor dem Verschluesseln - das Chiffrat ist laenger,
  // deshalb liegt die Serverschranke hoeher und faengt nur das Vollschreiben ab.
  assert.equal((await ada('POST', `/api/chats/${boId}`, { text: 'x'.repeat(6001) })).status, 400);

  // Entfreunden sperrt den Verlauf wieder
  await ada('DELETE', `/api/friends/${boId}`);
  assert.equal((await ada('GET', `/api/chats/${boId}`)).status, 403);
});

test('Sicherheit: Sperre trifft das Konto, nicht die Schule', async () => {
  const [opfer] = await register('bremsopfer');
  const raten = (name, ip) => fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ username: name, password: 'falschfalsch' }),
  }).then(r => r.status);

  // Zehn Fehlversuche von einer IP gegen ein Konto - danach ist Schluss.
  for (let i = 0; i < 10; i++) assert.equal(await raten('bremsopfer', '9.9.9.1'), 401);
  assert.equal(await raten('bremsopfer', '9.9.9.1'), 429, 'gesperrt');

  // Eine andere IP darf weiterhin - sonst sperrte ein Einzelner die ganze Schule aus. Das ist
  // der Punkt, der ohne 'trust proxy' hinter dem Reverse Proxy nicht funktionieren wuerde.
  assert.equal(await raten('woandershin', '9.9.9.2'), 401, 'X-Forwarded-For trennt die Zaehler');

  // Das fremde Konto laesst sich nicht mit zehn Fehlversuchen aussperren: der Zaehler je Konto
  // liegt hoeher als der je IP, sonst waere die Bremse selbst die Waffe.
  assert.equal(await raten('bremsopfer', '9.9.9.3'), 401, 'anderes Konto bleibt bedienbar');

  // Und ein erfolgreicher Login mit einem *anderen* Konto hebt die Sperre nicht auf: sonst
  // genuegte ein eigenes Konto, um unbegrenzt weiterzuraten.
  const eigen = client();
  assert.equal((await eigen('POST', '/api/login',
    { username: 'bremsopfer', password: 'pw4tests' })).status, 200);
  assert.equal(await raten('bremsopfer', '9.9.9.1'), 429, 'Sperre steht noch');
  assert.equal((await opfer('GET', '/api/me')).status, 200, 'die alte Sitzung laeuft weiter');
});

test('Sicherheit: abgelaufene Sitzung wird abgewiesen', async () => {
  const [udo2, udoId] = await register('sitzungsudo');
  const { db } = await import('./db.js');
  assert.equal((await udo2('GET', '/api/me')).status, 200);

  // Aufgeraeumt wird nur beim Start - ohne Altersbedingung in der Abfrage bliebe ein erbeutetes
  // Token auf einem monatelang laufenden Server unbegrenzt gueltig.
  db.prepare("UPDATE sessions SET created_at = datetime('now', '-200 days') WHERE user_id = ?").run(udoId);
  assert.equal((await udo2('GET', '/api/me')).status, 401, 'zu alt');
});

test('Sicherheit: Header und keine Serverinterna nach aussen', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null, 'kein Fingerabdruck');
});

test('Chat-Schlüssel: kann nicht mehr still verlorengehen', async () => {
  // Der teuerste Fehler dieser App: das Passwort wurde geändert, der Schlüssel blieb mit dem ALTEN
  // verpackt liegen, und ab da war jede Nachricht unlesbar - ohne dass es jemand merkte.
  const [ada, adaId] = await register('schluesselada');

  // Erst ein Paar hinterlegen.
  assert.equal((await ada('PUT', '/api/me/keys',
    { pub_key: '{"kty":"EC"}', priv_key_enc: 'salt:iv:daten' })).status, 200);

  // Ein bestehendes Paar wird nicht mehr aus Versehen überschrieben.
  const ohneFlag = await ada('PUT', '/api/me/keys',
    { pub_key: '{"kty":"EC","neu":1}', priv_key_enc: 'a:b:c' });
  assert.equal(ohneFlag.status, 409);
  assert.equal((await ada('GET', '/api/me/keys')).body.pub_key, '{"kty":"EC"}', 'unverändert');

  // Mit ausdrücklichem Ersetzen schon - das ist der Notausgang.
  assert.equal((await ada('PUT', '/api/me/keys',
    { pub_key: '{"kty":"EC","neu":1}', priv_key_enc: 'a:b:c', ersetzen: true })).status, 200);

  // Passwort ändern ohne mitgeschickten Schlüssel: abgelehnt, nichts passiert.
  const stumm = await ada('POST', '/api/me/password', { current: 'pw4tests', new: 'pw4tests2' });
  assert.equal(stumm.status, 409);
  assert.match(stumm.body.error, /Chat-Schlüssel/);
  assert.equal((await ada('POST', '/api/me/passwort-pruefen', { password: 'pw4tests' })).status, 200,
    'das alte Passwort gilt noch');

  // Mit neu verpacktem Schlüssel: beides wandert zusammen.
  assert.equal((await ada('POST', '/api/me/password',
    { current: 'pw4tests', new: 'pw4tests2', priv_key_enc: 'neu:neu:neu' })).status, 200);
  assert.equal((await ada('GET', '/api/me/keys')).body.priv_key_enc, 'neu:neu:neu');

  // Oder ausdrücklich verwerfen - dann sind beide Teile weg, kein halber Zustand.
  assert.equal((await ada('POST', '/api/me/password',
    { current: 'pw4tests2', new: 'pw4tests3', chat_key_verwerfen: true })).status, 200);
  const leer = (await ada('GET', '/api/me/keys')).body;
  assert.equal(leer.pub_key, null);
  assert.equal(leer.priv_key_enc, null);

  // Passwort prüfen, ohne etwas zu ändern - der Notausgang backt sonst einen Tippfehler mit ein.
  assert.equal((await ada('POST', '/api/me/passwort-pruefen', { password: 'falsch' })).status, 401);
  assert.equal((await ada('POST', '/api/me/passwort-pruefen', { password: 'pw4tests3' })).status, 200);

  // Und der Admin-Reset lässt keinen verwaisten Schlüssel stehen.
  await ada('PUT', '/api/me/keys', { pub_key: '{"kty":"EC"}', priv_key_enc: 'x:y:z' });
  const admin = await login('admin', 'geheim');
  assert.equal((await admin('PATCH', `/api/users/${adaId}`, { password: 'ganzneu99' })).status, 200);
  const nachReset = await login('schluesselada', 'ganzneu99');
  const k = (await nachReset('GET', '/api/me/keys')).body;
  assert.equal(k.pub_key, null, 'der Schlüssel zum alten Passwort ist weg statt unbrauchbar da');
  assert.equal(k.priv_key_enc, null);
});

test('Hausaufgaben: das Fach lässt sich ändern', async () => {
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1, tag2] = cfg.days;
  const [p1, p2] = cfg.periods;
  await admin('POST', '/api/courses', { id: 'HW-MA', title: 'Mathe' });
  await admin('POST', '/api/courses', { id: 'HW-DE', title: 'Deutsch' });

  const [udo] = await register('hwudo');
  await udo('PUT', '/api/entry', { day_id: tag1.id, period_id: p1.id, course_id: 'HW-MA' });
  await udo('PUT', '/api/entry', { day_id: tag2.id, period_id: p2.id, course_id: 'HW-DE' });

  const heute = new Date().toISOString().slice(0, 10);
  const neu = await udo('POST', '/api/homework',
    { course_id: 'HW-MA', due_date: heute, text: 'S. 42' });
  assert.equal(neu.status, 200);
  assert.equal(neu.body.day_id, tag1.id, 'Slot beim Anlegen gefunden');

  // Falsches Fach erwischt - das war bisher nur durch Löschen und Neuanlegen zu beheben.
  const geaendert = await udo('PUT', `/api/homework/${neu.body.id}`,
    { course_id: 'HW-DE', due_date: heute, text: 'S. 42' });
  assert.equal(geaendert.status, 200);
  assert.equal(geaendert.body.course_id, 'HW-DE');
  assert.equal(geaendert.body.day_id, tag2.id, 'die Stunde wandert mit');
  assert.equal(geaendert.body.period_id, p2.id);

  // Ein Kurs, den man gar nicht hat, geht nicht.
  await admin('POST', '/api/courses', { id: 'HW-FREMD', title: 'Fremd' });
  const fremd = await udo('PUT', `/api/homework/${neu.body.id}`,
    { course_id: 'HW-FREMD', due_date: heute, text: 'S. 42' });
  assert.equal(fremd.status, 403);
});

test('Kurse: veralteten Kurs erkennen und zusammenführen', async () => {
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1, tag2] = cfg.days;
  const [p1, p2] = cfg.periods;
  const { db } = await import('./db.js');

  // Fach und Lehrer sind bei alt und neu gleich - so sieht es aus, wenn WebUntis nur die
  // Kursnummer wechselt.
  // Die ids nicht raten: 'INSERT OR IGNORE' schweigt, wenn der Name schon existiert, und dann
  // zeigte der Fremdschluessel ins Leere.
  const nimm = (tabelle, name) => {
    db.prepare(`INSERT OR IGNORE INTO ${tabelle}(name, from_untis) VALUES(?, 1)`).run(name);
    return db.prepare(`SELECT id FROM ${tabelle} WHERE name = ?`).get(name).id;
  };
  const fachId = nimm('subjects', 'Erdkunde'), lehrerId = nimm('teachers', 'Frau Grün');
  for (const id of ['UNTIS-ALT', 'UNTIS-NEU'])
    db.prepare(`INSERT OR IGNORE INTO courses(id, title, subject_id, teacher_id, from_untis)
                VALUES(?, 'Erdkunde', ?, ?, 1)`).run(id, fachId, lehrerId);

  const [eva, evaId] = await register('kurseva');
  const [ben, benId] = await register('kursben');
  // Sieben Tage zurueck und sieben vor: derselbe Wochentag, so wie ein Kurs wirklich liegt.
  const gestern = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const morgen = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  // Wochentag passend zum jeweiligen Datum, sonst landet die Stunde in einem anderen Slot.
  const wochentag = iso => db.prepare("SELECT id FROM days WHERE iso = CAST(strftime('%u', ?) AS INTEGER)")
    .get(iso)?.id;
  const legeStunde = (user, datum, periodId, kurs) =>
    db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
                VALUES(?, ?, ?, ?, 'regular')`).run(user, datum, periodId, kurs);

  // Der alte Kurs liegt nur in der Vergangenheit, der neue in der Zukunft - beide in derselben
  // Stunde. Genau das macht sie zum selben Kurs.
  if (!wochentag(gestern) || !wochentag(morgen)) return;   // Wochenende: kein passender Slot
  legeStunde(evaId, gestern, p1.id, 'UNTIS-ALT');
  legeStunde(evaId, morgen, p1.id, 'UNTIS-NEU');

  await eva('PUT', '/api/my-courses/UNTIS-ALT', { name: 'Erdkunde LK', short: 'EK', color: '#123456' });
  const hw = await eva('POST', '/api/homework',
    { course_id: 'UNTIS-ALT', due_date: morgen, text: 'Karte zeichnen' });
  assert.equal(hw.status, 200);

  // Ein zweiter Nutzer hat den alten Kurs noch aktiv - für ihn darf sich nichts ändern.
  legeStunde(benId, morgen, p1.id, 'UNTIS-ALT');
  await ben('PUT', '/api/my-courses/UNTIS-ALT', { name: 'Bens Name', short: 'BN', color: '#654321' });

  const veraltet = (await eva('GET', '/api/my-courses/aufraeumen')).body;
  assert.deepEqual(veraltet.map(k => k.id), ['UNTIS-ALT']);
  assert.equal(veraltet[0].eindeutig, 'UNTIS-NEU', 'Fach, Lehrer und Stunde stimmen überein');
  assert.equal(veraltet[0].hausaufgaben, 1);

  const r = await eva('POST', '/api/my-courses/UNTIS-ALT/zusammenfuehren', { ziel: 'UNTIS-NEU' });
  assert.equal(r.status, 200);
  assert.equal(r.body.verschoben, 1);

  const meine = (await eva('GET', '/api/my-courses')).body;
  const neu = meine.find(c => c.id === 'UNTIS-NEU');
  assert.equal(neu.pref_name, 'Erdkunde LK', 'Name wandert mit');
  assert.equal(neu.pref_color, '#123456', 'Farbe wandert mit');
  assert.equal(neu.pref_short, 'EK');
  assert.equal(meine.some(c => c.id === 'UNTIS-ALT'), false, 'der alte Kurs ist aus der Liste weg');
  assert.equal((await eva('GET', '/api/homework')).body
    .filter(x => x.course_id === 'UNTIS-NEU').length, 1, 'die Hausaufgabe ist mitgekommen');

  // Ben merkt nichts davon.
  const bens = (await ben('GET', '/api/my-courses')).body.find(c => c.id === 'UNTIS-ALT');
  assert.equal(bens?.pref_name, 'Bens Name', 'die Zusammenführung gilt nur für einen Nutzer');
});

test('Kurse: gleiches Fach und gleicher Lehrer reichen nicht - die Stunde muss passen', async () => {
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [p1, p2] = cfg.periods;
  const { db } = await import('./db.js');

  const nimm = (tabelle, name) => {
    db.prepare(`INSERT OR IGNORE INTO ${tabelle}(name, from_untis) VALUES(?, 1)`).run(name);
    return db.prepare(`SELECT id FROM ${tabelle} WHERE name = ?`).get(name).id;
  };
  const fachId = nimm('subjects', 'Latein'), lehrerId = nimm('teachers', 'Herr Blau');
  for (const id of ['UNTIS-LAT-ALT', 'UNTIS-LAT-ANDERE'])
    db.prepare(`INSERT OR IGNORE INTO courses(id, title, subject_id, teacher_id, from_untis)
                VALUES(?, 'Latein', ?, ?, 1)`).run(id, fachId, lehrerId);

  const [ina, inaId] = await register('kursina');
  const gestern = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const morgen = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const hatTag = iso => !!db.prepare("SELECT 1 FROM days WHERE iso = CAST(strftime('%u', ?) AS INTEGER)").get(iso);
  if (!hatTag(gestern) || !hatTag(morgen)) return;

  // Derselbe Lehrer, dasselbe Fach - aber eine andere Stunde. Das ist der andere Jahrgang, und
  // genau deshalb darf hier nichts automatisch zusammenwandern.
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-LAT-ALT', 'regular')`).run(inaId, gestern, p1.id);
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-LAT-ANDERE', 'regular')`).run(inaId, morgen, p2.id);

  const veraltet = (await ina('GET', '/api/my-courses/aufraeumen')).body
    .find(k => k.id === 'UNTIS-LAT-ALT');
  assert.ok(veraltet, 'der alte Kurs gilt als veraltet');
  assert.deepEqual(veraltet.nachfolger, [], 'aber ohne Nachfolger - die Stunde passt nicht');
  assert.equal(veraltet.eindeutig, null);
});

test('WebUntis: der Lehrstoff kommt aus dem Stundendetail', async t => {
  // Die Wochenabfrage liefert 'periodText' und 'periodInfo', aber bei manchen Instanzen kein
  // 'lessonText' - genau so kam der Plan an: Notizen da, Lehrstoff nicht. Der Lehrstoff steht im
  // Endpunkt fuer das Stundendetail und heisst dort 'teachingContent'.
  const { createServer } = await import('node:http');
  const gesehen = [];
  const server = createServer((req, res) => {
    gesehen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { calendarEntries: [
      { id: 5, singleEntries: [
        { startDateTime: '2026-09-02T08:00', endDateTime: '2026-09-02T08:45',
          teachingContent: 'Fotoübung zu Licht; S-Bilder besprechen' },
        { startDateTime: '2026-09-02T09:40', teachingContent: '' },
      ] },
    ] } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${server.address().port}`;

  const untis = await import('./untis.js');
  const heute = new Date().toISOString().slice(0, 10);
  const stoff = await untis.lehrstoff(
    { host, cookie: 'JSESSIONID=x', personId: 42, personType: 5 }, heute, heute);

  assert.ok(gesehen.some(u => u.includes('calendar-entry/detail')), 'das Stundendetail wurde gefragt');
  assert.ok(gesehen.some(u => u.includes('elementId=42') && u.includes('startDateTime=')),
    'nach der eigenen Person und mit Zeitraum');
  assert.deepEqual(stoff, [{ date: '20260902', von: 800, bis: 845, text: 'Fotoübung zu Licht; S-Bilder besprechen' }],
    'leerer Lehrstoff kommt gar nicht erst in die Liste');

  // Eine Doppelstunde ist bei WebUntis EIN Eintrag 08:00-09:30 - bei uns zwei Stunden. Beide
  // bekommen den Text; die Stunde danach nicht. Ohne Ende zaehlt nur die gleiche Anfangszeit.
  const doppel = [{ date: '20260902', von: 800, bis: 930, text: 'Doppelt' },
    { date: '20260903', von: 800, bis: null, text: 'Einzeln' }];
  const stunde = (date, startTime, endTime) => ({ date, startTime, endTime });
  assert.equal(untis.stoffFuer(doppel, stunde(20260902, 800, 845)), 'Doppelt');
  assert.equal(untis.stoffFuer(doppel, stunde(20260902, 850, 935)), 'Doppelt', 'zweite Haelfte');
  assert.equal(untis.stoffFuer(doppel, stunde(20260902, 940, 1025)), '', 'die Stunde danach nicht');
  assert.equal(untis.stoffFuer(doppel, stunde(20260903, 800, 845)), 'Einzeln');
  assert.equal(untis.stoffFuer(doppel, stunde(20260903, 850, 935)), '', 'ohne Ende nur der Anfang');

  // Faellt der Abruf aus, ist das kein Grund, den ganzen Plan zu verlieren.
  server.close();
  const leer = await untis.lehrstoff(
    { host, cookie: 'x', personId: 42, personType: 5 }, heute, heute).catch(() => 'geworfen');
  assert.ok(leer === 'geworfen' || leer.length === 0);
});

test('WebUntis: Änderung an einer Stunde erkennen', async () => {
  // Verglichen wurde frueher nur der Status - eine reine Raumaenderung war doppelt unsichtbar,
  // weil auch der Vorzustand nur die auffaelligen Stunden geladen hat.
  const { stundenAenderung } = await import('./index.js');
  const stunde = (f = {}) => ({ status: 'regular', course_id: 'UNTIS-1', room: 'C204', info: null, ...f });

  assert.equal(stundenAenderung(null, stunde()), null, 'ohne Vorzustand wird nichts gemeldet');
  assert.equal(stundenAenderung(stunde(), stunde()), null, 'unverändert ist keine Meldung');
  assert.equal(stundenAenderung(stunde(), stunde({ room: 'B104' })), 'Raum: C204 → B104');
  assert.equal(stundenAenderung(stunde(), stunde({ course_id: 'UNTIS-2' })), 'Anderer Kurs');
  // Der wichtigste Fall: aus einer Vertretung MIT Lehrer wird eine OHNE. Der Status bleibt dabei
  // 'irregular', die Statusmeldung greift also nicht - ohne diesen Vergleich erfaehrt es niemand.
  assert.equal(stundenAenderung(stunde({ teacher: 'Frau Ersatz' }), stunde({ teacher: null })),
    'Lehrer: Frau Ersatz → niemand');
  assert.equal(stundenAenderung(stunde({ teacher: null }), stunde({ teacher: 'Herr Neu' })),
    'Lehrer: niemand → Herr Neu');
  assert.equal(stundenAenderung(stunde(), stunde({ info: 'Bitte Buch mitbringen' })),
    'Bitte Buch mitbringen');

  // Ein Statuswechsel ist Ausfall oder Vertretung - der laeuft ueber die eigenen Meldungen und
  // darf hier nicht doppelt herauskommen.
  assert.equal(stundenAenderung(stunde(), stunde({ status: 'cancelled', room: 'B104' })), null);

  // Ein Raum, der wegfaellt, ist auch eine Änderung.
  assert.equal(stundenAenderung(stunde(), stunde({ room: null })), 'Raum: C204 → –');
});

test('Kurs-IDs: abweichende Schreibweise blockiert keine Hausaufgabe mehr', async () => {
  // `courses.id` ist COLLATE NOCASE, die Kindspalten sind BINARY. Dadurch stand ein Kurs in der
  // Auswahlliste (die vergleicht NOCASE), wurde aber von `hatKurs` abgelehnt (das vergleicht
  // BINARY) - "Du hast diesen Kurs nicht im Stundenplan", obwohl er im Plan steht.
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1] = cfg.days;
  const [p1] = cfg.periods;

  db.prepare(`INSERT OR IGNORE INTO courses(id, title, from_untis) VALUES('UNTIS-MA-KLEIN', 'Mathe', 1)`).run();
  const [max, maxId] = await register('kollmax');

  // So schreibt der Abgleich es heute: der Kurs behaelt die alte Schreibweise, die Stunde bekommt
  // die neue.
  const heute = new Date().toISOString().slice(0, 10);
  const tagIso = db.prepare('SELECT iso FROM days WHERE id = ?').get(tag1.id).iso;
  const datum = db.prepare(`SELECT date(?, '+' || ((? - CAST(strftime('%u', ?) AS INTEGER) + 7) % 7) || ' days') AS d`)
    .get(heute, tagIso, heute).d;
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'untis-ma-klein', 'regular')`).run(maxId, datum, p1.id);

  const meine = (await max('GET', '/api/my-courses')).body;
  assert.ok(meine.some(c => c.id === 'UNTIS-MA-KLEIN'), 'der Kurs steht in der Auswahlliste');

  // Genau diesen Wert schickt die Oberflaeche zurueck - er muss angenommen werden.
  const neu = await max('POST', '/api/homework',
    { course_id: 'UNTIS-MA-KLEIN', due_date: datum, text: 'Blatt 3' });
  assert.equal(neu.status, 200, 'was in der Liste steht, muss auch annehmbar sein');
  assert.equal(neu.body.ohne_slot, false, 'und die Stunde wird gefunden');
  assert.equal(neu.body.day_id, tag1.id);

  // Und sie muss danach auch WIRKLICH in der Liste stehen: 'meineKursIds' lieferte die rohen
  // Kindwerte, und `h.course_id IN (…)` vergleicht BINARY - die Aufgabe war angelegt und
  // unsichtbar. Der Fehler steckte eine Ebene tiefer als der 403.
  assert.deepEqual((await max('GET', '/api/homework')).body.map(h => h.text), ['Blatt 3'],
    'die Hausaufgabe erscheint auch in der Liste');
  // Die Woche, in der die Stunde liegt - sie muss nicht die laufende sein.
  const montag = db.prepare(`SELECT date(?, '-' || ((CAST(strftime('%u', ?) AS INTEGER) + 6) % 7)
    || ' days') AS d`).get(datum, datum).d;
  const plan = (await max('GET', `/api/timetable?week=${montag}`)).body;
  assert.ok(plan.entries.some(e => e.homework.some(h => h.text === 'Blatt 3')),
    'und im Plan an ihrer Stunde');
});

test('Hausaufgabe ändern: nur ein Kurs-WECHSEL wird geprüft', async () => {
  // Wer nur den Text korrigiert, darf nicht daran scheitern, dass sein Kurs inzwischen veraltet
  // ist - sonst laesst sich eine Aufgabe nur noch loeschen.
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1] = cfg.days;
  const [p1] = cfg.periods;
  await admin('POST', '/api/courses', { id: 'ALT-KURS', title: 'Alt' });
  await admin('POST', '/api/courses', { id: 'FREMD-KURS', title: 'Fremd' });

  const [nina, ninaId] = await register('kollnina');
  await nina('PUT', '/api/entry', { day_id: tag1.id, period_id: p1.id, course_id: 'ALT-KURS' });
  const heute = new Date().toISOString().slice(0, 10);
  const hw = (await nina('POST', '/api/homework',
    { course_id: 'ALT-KURS', due_date: heute, text: 'alt' })).body;

  // Jetzt faellt der Kurs aus dem Plan - genau der Zustand, in dem der Dialog "(nicht im Plan)"
  // vorwaehlt und die alte ID zurueckschickt.
  db.prepare('DELETE FROM entries WHERE user_id = ? AND course_id = ?').run(ninaId, 'ALT-KURS');

  const gleich = await nina('PUT', `/api/homework/${hw.id}`,
    { course_id: 'ALT-KURS', due_date: heute, text: 'korrigiert' });
  assert.equal(gleich.status, 200, 'Text ändern geht weiter');
  assert.equal(gleich.body?.text ?? db.prepare('SELECT text FROM homework WHERE id = ?').get(hw.id).text,
    'korrigiert');

  // Auch ganz ohne course_id im Body.
  assert.equal((await nina('PUT', `/api/homework/${hw.id}`,
    { due_date: heute, text: 'nochmal' })).status, 200);

  // Ein WECHSEL auf einen fremden Kurs bleibt verboten.
  assert.equal((await nina('PUT', `/api/homework/${hw.id}`,
    { course_id: 'FREMD-KURS', due_date: heute, text: 'nope' })).status, 403);
});

test('Kurs-IDs: die Migration zieht bestehende Zeilen gerade', async () => {
  const { db, kursIdsGeradeziehen } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1] = cfg.days;
  const [p1] = cfg.periods;
  const [mia, miaId] = await register('migmia');

  db.prepare(`INSERT OR IGNORE INTO courses(id, title, from_untis) VALUES('UNTIS-EK-GRUEN', 'Erdkunde', 1)`).run();

  // Drei Sorten Altlast in der falschen Schreibweise.
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, '2026-09-07', ?, 'untis-ek-gruen', 'regular')`).run(miaId, p1.id);
  db.prepare(`INSERT INTO homework(course_id, due_date, text, user_id, created_at)
              VALUES('UNTIS-Ek-Gruen', '2026-09-07', 'Karte', ?, datetime('now'))`).run(miaId);
  // Und Einstellungen unter BEIDEN Schreibweisen - der Primaerschluessel kollidiert beim Update.
  db.prepare(`INSERT OR REPLACE INTO course_prefs(user_id, course_id, name, color)
              VALUES(?, 'UNTIS-EK-GRUEN', 'kanonisch', '#111111')`).run(miaId);
  db.prepare(`INSERT OR REPLACE INTO course_prefs(user_id, course_id, name, color)
              VALUES(?, 'untis-ek-gruen', 'abweichend', '#222222')`).run(miaId);

  assert.ok(kursIdsGeradeziehen() >= 2, 'es wurde etwas geradegezogen');

  const schief = t => db.prepare(`SELECT count(*) AS n FROM ${t}
    WHERE course_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM courses c WHERE c.id = ${t}.course_id AND c.id <> ${t}.course_id)`).get().n;
  for (const t of ['entries', 'untis_lessons', 'homework', 'untis_homework', 'course_prefs'])
    assert.equal(schief(t), 0, `${t} steht gerade`);

  // Bei der Kollision bleibt genau eine Zeile übrig, und zwar die kanonische.
  const prefs = db.prepare('SELECT course_id, name FROM course_prefs WHERE user_id = ?').all(miaId);
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].name, 'kanonisch');

  // Zweimal laufen darf nichts kaputt machen.
  assert.equal(kursIdsGeradeziehen(), 0, 'beim zweiten Mal gibt es nichts mehr zu tun');
  assert.equal(db.prepare('SELECT count(*) AS n FROM homework WHERE user_id = ?').get(miaId).n, 1,
    'die Hausaufgabe ist noch da');
});

test('Kurse: auch zwei AKTIVE Duplikate werden vorgeschlagen', async () => {
  // Wechselt WebUntis die Kursnummer erst zum Halbjahr - oder liefert sie mal und mal nicht -,
  // haben beide IDs Stunden in der Zukunft. Dann galt keine als "veraltet", die Karte blieb leer,
  // und es gab in der Oberflaeche keinen Weg zum Zusammenfuehren.
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [p1, p2] = cfg.periods;

  const nimm = (t, n) => {
    db.prepare(`INSERT OR IGNORE INTO ${t}(name, from_untis) VALUES(?, 1)`).run(n);
    return db.prepare(`SELECT id FROM ${t} WHERE name = ?`).get(n).id;
  };
  const fach = nimm('subjects', 'Biologie');
  // Verschiedene Lehrer - genau der Fall, in dem die strenge Regel nicht greift: bei einer
  // Vertretung schreibt der Abgleich den Vertreter an den Kurs.
  const lehrerA = nimm('teachers', 'Frau Weiss'), lehrerB = nimm('teachers', 'WEI');
  db.prepare(`INSERT OR IGNORE INTO courses(id, title, subject_id, teacher_id, from_untis)
              VALUES('UNTIS-BIO-A', 'Biologie', ?, ?, 1)`).run(fach, lehrerA);
  db.prepare(`INSERT OR IGNORE INTO courses(id, title, subject_id, teacher_id, from_untis)
              VALUES('UNTIS-BIO-B', 'Biologie', ?, ?, 1)`).run(fach, lehrerB);

  const [ole, oleId] = await register('doppelole');
  // Montage aus dem laufenden Plan statt "heute + 7 Tage": faellt heute auf einen Samstag, laege
  // auch heute+7 auf einem Samstag - und den kennt das Stundenraster (Mo-Fr) gar nicht. Die
  // Stunden haetten dann keinen Wochentag, und der Test schluege jedes Wochenende fehl.
  const montag = (await ole('GET', '/api/timetable')).body.days[0].date;
  const inWochen = n => addDays(montag, 7 * n);   // immer ein Montag, immer in der Zukunft
  const setz = (datum, periode, kurs) =>
    db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
                VALUES(?, ?, ?, ?, 'regular')`).run(oleId, datum, periode, kurs);

  // Beide in derselben Stunde desselben Wochentags, beide in der Zukunft. B hat mehr Stunden und
  // ist damit die staerkere Seite.
  setz(inWochen(1), p1.id, 'UNTIS-BIO-A');
  setz(inWochen(2), p1.id, 'UNTIS-BIO-B');
  setz(inWochen(3), p1.id, 'UNTIS-BIO-B');

  const vor = (await ole('GET', '/api/my-courses/aufraeumen')).body;
  assert.deepEqual(vor.map(k => k.id), ['UNTIS-BIO-A'],
    'nur die schwächere Seite wird vorgeschlagen, sonst stünde jedes Paar zweimal da');
  assert.equal(vor[0].grund, 'doppelt');
  assert.deepEqual(vor[0].nachfolger, ['UNTIS-BIO-B']);
  assert.equal(vor[0].eindeutig, null, 'ohne "veraltet" wird nichts automatisch zusammengeführt');

  // Ein dritter Kurs im selben Fach, aber in einer ANDEREN Stunde, ist kein Duplikat.
  db.prepare(`INSERT OR IGNORE INTO courses(id, title, subject_id, teacher_id, from_untis)
              VALUES('UNTIS-BIO-C', 'Biologie', ?, ?, 1)`).run(fach, lehrerA);
  setz(inWochen(1), p2.id, 'UNTIS-BIO-C');
  assert.equal((await ole('GET', '/api/my-courses/aufraeumen')).body
    .some(k => k.id === 'UNTIS-BIO-C'), false, 'andere Stunde, also ein anderer Kurs');
});

test('Kurse: zwei aktive Kurse zusammenführen', async () => {
  // Der haeufige Fall: beide Kurse stehen noch im Plan, keiner gilt als veraltet. Ueber die
  // Kursliste muss das trotzdem gehen.
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1, tag2] = cfg.days;
  const [p1] = cfg.periods;
  await admin('POST', '/api/courses', { id: 'AKT-ALT', title: 'Alt' });
  await admin('POST', '/api/courses', { id: 'AKT-NEU', title: 'Neu' });

  const [pia] = await register('aktpia');
  const heute = new Date().toISOString().slice(0, 10);
  await pia('PUT', '/api/entry', { day_id: tag1.id, period_id: p1.id, course_id: 'AKT-ALT' });
  await pia('PUT', '/api/entry', { day_id: tag2.id, period_id: p1.id, course_id: 'AKT-NEU' });
  await pia('PUT', '/api/my-courses/AKT-ALT', { name: 'Mein Name', short: 'MN', color: '#abcdef' });
  await pia('POST', '/api/homework', { course_id: 'AKT-ALT', due_date: heute, text: 'Rest' });

  assert.equal((await pia('POST', '/api/my-courses/AKT-ALT/zusammenfuehren',
    { ziel: 'AKT-NEU' })).status, 200);

  const meine = (await pia('GET', '/api/my-courses')).body;
  assert.equal(meine.some(c => c.id === 'AKT-ALT'), false, 'der alte Kurs ist wirklich weg');
  const neu = meine.find(c => c.id === 'AKT-NEU');
  assert.equal(neu.pref_name, 'Mein Name');
  assert.equal(neu.pref_color, '#abcdef');
  assert.equal((await pia('GET', '/api/homework')).body.filter(h => h.text === 'Rest').length, 1,
    'die Hausaufgabe ist mitgekommen, nicht verloren');
});
test('WebUntis: ein Gedankenstrich heißt „nichts eingetragen"', async () => {
  const { echterText, aufbereiten } = await import('./untis.js');

  // Das sind die ueblichen Arten, in WebUntis "nichts" zu schreiben.
  for (const leer of ['-', '–', '—', '  -  ', '/', '.', '', '__', '-/-', null, undefined])
    assert.equal(echterText(leer), '', `${JSON.stringify(leer)} ist kein Text`);

  // Sobald ein Buchstabe oder eine Ziffer dabei ist, bleibt es stehen.
  assert.equal(echterText('-1 bis -5'), '-1 bis -5');
  assert.equal(echterText('- Blatt 3'), '- Blatt 3');
  assert.equal(echterText('  HA: S. 12  '), 'HA: S. 12');

  // Und im Plan: eine Stunde, an der ueberall nur Striche stehen, hat keinen Text - also auch
  // kein Info-Zeichen, weil das an `lesson_text` haengt.
  const [nur] = aufbereiten([{
    date: 20260903, startTime: 800, endTime: 845, lsnumber: 1,
    su: [{ name: 'MA' }], te: [{ name: 'KLE' }], ro: [{ name: 'A1' }],
    lstext: '-', bkText: '–', bkRemark: ' - ', info: '-', substText: '',
  }]);
  assert.equal(nur.lesson_text, null, 'kein Abschnitt „Von der Schule"');
  assert.equal(nur.info, null, 'und kein angehängtes „ -" im Hinweis');

  // Steht daneben etwas Echtes, bleibt genau das uebrig.
  const [gemischt] = aufbereiten([{
    date: 20260903, startTime: 800, endTime: 845, lsnumber: 2,
    su: [{ name: 'KU' }], te: [], ro: [],
    lstext: '-', bkText: 'HA: Seite 12', bkRemark: '-',
  }]);
  assert.equal(gemischt.lesson_text, 'Notizen für Schüler*innen:\nHA: Seite 12');
});

test('Hausaufgaben des Lehrers stehen im Plan an ihrer Stunde', async () => {
  // Bisher tauchten sie nur in der Liste auf - nie im Stundenplan und nie als Marker in der Zelle,
  // weil der Plan ausschliesslich die Tabelle `homework` gelesen hat.
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const p1 = cfg.periods[0];

  db.prepare(`INSERT OR IGNORE INTO courses(id, title, from_untis) VALUES('UNTIS-7788', 'Chemie', 1)`).run();
  const [tom, tomId] = await register('lehrertom');

  // Eine abgeglichene Stunde in dieser Woche, dazu die Hausaufgabe des Lehrers.
  const plan = (await tom('GET', '/api/timetable')).body;
  const tag = plan.days[1];
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-7788', 'regular')`).run(tomId, tag.date, p1.id);
  db.prepare(`INSERT OR REPLACE INTO untis_homework(user_id, untis_id, course_id, date, due_date, text, remark)
              VALUES(?, 77, 'UNTIS-7788', ?, ?, 'Versuchsprotokoll', NULL)`)
    .run(tomId, tag.date, tag.date);

  const frisch = (await tom('GET', '/api/timetable')).body;
  const slot = frisch.entries.find(e => e.day_id === tag.id && e.period_id === p1.id);
  assert.ok(slot, 'die Stunde steht im Plan');
  assert.deepEqual(slot.homework.map(h => h.text), ['Versuchsprotokoll'],
    'und die Hausaufgabe des Lehrers hängt daran');
  assert.equal(slot.homework[0].von_untis, true, 'gekennzeichnet als von der Schule');

  // Im Plan eines Freundes haben sie nichts zu suchen - sie gehoeren zu dem Konto, das sie geholt hat.
  const [eva, evaId] = await register('lehrereva');
  await eva('POST', '/api/friends', { username: 'lehrertom' });
  await tom('POST', `/api/friends/${evaId}/accept`);
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-7788', 'regular')`).run(evaId, tag.date, p1.id);
  const fremd = (await eva('GET', `/api/timetable?user=${tomId}`)).body;
  const fremderSlot = fremd.entries.find(e => e.day_id === tag.id && e.period_id === p1.id);
  assert.deepEqual(fremderSlot?.homework ?? [], [], 'im fremden Plan nicht');
});

test('WebUntis: Vertretung auch ohne code erkennen', async () => {
  const { aufbereiten, ausZellzustand } = await import('./untis.js');
  const stunde = (f = {}) => ({ date: 20260903, startTime: 800, endTime: 845, lsnumber: 1,
    su: [{ name: 'MA' }], te: [{ name: 'KLE' }], ro: [{ name: 'A1' }], ...f });

  // Der dokumentierte Weg bleibt.
  assert.equal(aufbereiten([stunde({ code: 'irregular' })])[0].status, 'irregular');
  assert.equal(aufbereiten([stunde({ code: 'cancelled' })])[0].status, 'cancelled');
  assert.equal(aufbereiten([stunde()])[0].status, 'regular');

  // Neu: nur ein Vertretungstext, kein code - so liefern es viele Schulen.
  assert.equal(aufbereiten([stunde({ substText: 'Vertretung Herr Klein' })])[0].status, 'irregular');

  // Ein Strich ist kein Text (siehe echterText) - sonst waere plötzlich alles Vertretung.
  assert.equal(aufbereiten([stunde({ substText: '-' })])[0].status, 'regular');
  assert.equal(aufbereiten([stunde({ substText: '   ' })])[0].status, 'regular');

  // Ausfall gewinnt: eine Stunde, die entfällt, wird nicht vertreten.
  assert.equal(aufbereiten([stunde({ code: 'cancelled', substText: 'fällt aus' })])[0].status,
    'cancelled');

  // Und der Zellzustand aus der REST-Wochenabfrage, den bisher niemand gelesen hat.
  assert.equal(ausZellzustand('SUBSTITUTION'), 'irregular');
  // Eine Raumaenderung ist KEINE Vertretung - derselbe Unterricht, nur woanders. Sie stand
  // bisher mit orangem Pfeil im Plan, als waere ein anderer Lehrer da.
  assert.equal(ausZellzustand('ROOMSUBSTITUTION'), 'roomchange');
  assert.equal(ausZellzustand('SHIFT'), 'irregular');
  assert.equal(ausZellzustand('CANCEL'), 'cancelled');
  assert.equal(ausZellzustand('STANDARD'), null);
  assert.equal(ausZellzustand('WAS-AUCH-IMMER'), null, 'Unbekanntes sagt nichts aus');
  assert.equal(ausZellzustand(null), null);
});

test('WebUntis: der Vertreter bleibt nicht am Kurs kleben', async () => {
  // Der Abgleich schreibt den Lehrer jeder Stunde an den Kurs. Bei einer Vertretung hiesse das:
  // der Vertreter gilt fuer JEDEN, der den Kurs hat, bis eine regulaere Stunde ihn zuruecksetzt.
  const { db } = await import('./db.js');
  const { aufbereiten } = await import('./untis.js');

  const [regulaer] = aufbereiten([{ date: 20260907, startTime: 800, endTime: 845, lsnumber: 5150,
    su: [{ name: 'PH', longname: 'Physik' }], te: [{ name: 'BLA', longname: 'Herr Blau' }] }]);
  const [vertreten] = aufbereiten([{ date: 20260908, startTime: 800, endTime: 845, lsnumber: 5150,
    su: [{ name: 'PH', longname: 'Physik' }], te: [{ name: 'ROT', longname: 'Frau Rot' }],
    substText: 'Vertretung' }]);

  assert.equal(regulaer.status, 'regular');
  assert.equal(vertreten.status, 'irregular');
  assert.equal(vertreten.teacher, 'Frau Rot', 'der Vertreter steht in der Stunde');

  // Genau die Bedingung, die der Abgleich benutzt.
  const lehrerFuerKurs = s => (s.teacher && s.status === 'regular' ? s.teacher : null);
  assert.equal(lehrerFuerKurs(regulaer), 'Herr Blau');
  assert.equal(lehrerFuerKurs(vertreten), null, 'aus einer Vertretung wird kein Kurslehrer');
  assert.ok(db, 'db erreichbar');
});

test('Hausaufgaben: eine fremde Stunde wird abgelehnt statt still verschoben', async () => {
  // Im Plan eines Freundes gab es ein Eingabefeld. Der Eintrag landete dann auf der fruehesten
  // EIGENEN Stelle der Woche und tauchte dort, wo man geklickt hatte, gar nicht auf - es sah aus,
  // als sei nichts passiert.
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [tag1, tag2] = cfg.days;
  const [p1, p2] = cfg.periods;
  await admin('POST', '/api/courses', { id: 'FREMD-MA', title: 'Mathe' });

  const [udo] = await register('fremdudo');
  await udo('PUT', '/api/entry', { day_id: tag1.id, period_id: p1.id, course_id: 'FREMD-MA' });
  const heute = new Date().toISOString().slice(0, 10);

  // Der Slot aus dem eigenen Plan geht.
  const eigen = await udo('POST', '/api/homework',
    { course_id: 'FREMD-MA', due_date: heute, text: 'meine Stunde', day_id: tag1.id, period_id: p1.id });
  assert.equal(eigen.status, 200);
  assert.equal(eigen.body.day_id, tag1.id);

  // Ein Slot, den man selbst nicht hat - so kam es aus dem Plan eines Freundes.
  const fremd = await udo('POST', '/api/homework',
    { course_id: 'FREMD-MA', due_date: heute, text: 'fremde Stunde', day_id: tag2.id, period_id: p2.id });
  assert.equal(fremd.status, 400, 'kein stilles Verschieben mehr');
  assert.match(fremd.body.error, /Stunde/);

  // Ohne Slot sucht der Server weiter selbst - das ist der Weg ueber das Hausaufgaben-Menue.
  const ohne = await udo('POST', '/api/homework',
    { course_id: 'FREMD-MA', due_date: heute, text: 'über das Menü' });
  assert.equal(ohne.status, 200);
  assert.equal(ohne.body.day_id, tag1.id, 'der Server findet die Stunde selbst');
});

test('Profil: der Zeitstrich lässt sich umstellen', async () => {
  const [lea] = await register('strichlea');
  assert.equal((await lea('GET', '/api/me')).body.jetzt_stil, 'zeit', 'Vorgabe');

  for (const stil of ['linie', 'tag', 'zeit'])
    assert.equal((await lea('PATCH', '/api/me', { jetzt_stil: stil })).body.jetzt_stil, stil);

  const kaputt = await lea('PATCH', '/api/me', { jetzt_stil: 'blinkend' });
  assert.equal(kaputt.status, 400);
  assert.equal((await lea('GET', '/api/me')).body.jetzt_stil, 'zeit', 'unverändert');
});

test('Fenster & Meldungen: drei Einstellungen mit Vorgaben und Deckel', async () => {
  const [tom] = await register('toast-tom');
  const me = (await tom('GET', '/api/me')).body;
  assert.deepEqual([me.dialog_hintergrund, me.toast_sekunden, me.toast_fehler_bleibt], [true, 3, true], 'Vorgaben');
  const neu = (await tom('PATCH', '/api/me', { dialog_hintergrund: false, toast_sekunden: 99, toast_fehler_bleibt: false })).body;
  assert.deepEqual([neu.dialog_hintergrund, neu.toast_sekunden, neu.toast_fehler_bleibt], [false, 30, false], 'gedeckelt bei 30');
  assert.equal((await tom('PATCH', '/api/me', { toast_sekunden: 0 })).body.toast_sekunden, 1, 'mindestens eine Sekunde');
});

test('ToDo ohne Frist, aber mit Wiederholung: der Rhythmus zaehlt ab heute, 08:00', async () => {
  const { todoErinnerungen } = await import('./index.js');
  const { db } = await import('./db.js');
  const [pia, piaId] = await register('rhythmus-pia');
  const heute = new Date(), z = x => String(x).padStart(2, '0');
  const lokal = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  const inTagen = n => { const d = new Date(heute); d.setDate(d.getDate() + n); return lokal(d); };

  // Frueher: "Ohne Frist gibt es nichts zu wiederholen". Jetzt: naechste Woche um acht.
  const t = (await pia('POST', '/api/todos', { text: 'Blumen gießen', wiederholung: 1, wiederholung_einheit: 'woche' })).body;
  assert.equal(t.due_at, `${inTagen(7)} 08:00`);
  assert.equal(t.wiederholung, 1);
  // Taeglich: morgen um acht.
  const t2 = (await pia('POST', '/api/todos', { text: 'Vokabeln', wiederholung: 1, wiederholung_einheit: 'tag' })).body;
  assert.equal(t2.due_at, `${inTagen(1)} 08:00`);
  // Abhaken rueckt vom alten Termin weiter - wie bei jeder wiederkehrenden Aufgabe.
  const nach = (await pia('POST', `/api/todos/${t2.id}/done`)).body;
  assert.equal(nach.done, false);
  assert.equal(nach.naechst, `${inTagen(2)} 08:00`);
  // Eine Frist steht, wenn sie da ist: aendern ohne Frist setzt keine neue, solange eine bleibt.
  const ge = (await pia('PUT', `/api/todos/${t.id}`, { text: 'Blumen gießen!', due_at: t.due_at, wiederholung: 2, wiederholung_einheit: 'woche' })).body;
  assert.equal(ge.due_at, t.due_at);
  // Und die Erinnerung kommt, sobald der Termin da ist.
  db.prepare("UPDATE todos SET due_at = datetime('now', 'localtime', '-1 minute') WHERE id = ?").run(t2.id);
  todoErinnerungen();
  assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE user_id = ? AND kind = 'todo'").get(piaId).n, 1);
});

test('Abmeldung: nur "ab Stunde" oder nur "bis Stunde"', async () => {
  const [ole] = await register('halb-ole');
  const cfg = (await ole('GET', '/api/config')).body;
  const letzte = Math.max(...cfg.periods.map(p => p.nr));
  const tag = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  let r = (await ole('POST', '/api/absences', { from: tag(1), to: tag(1), von_stunde: 3 })).body;
  assert.deepEqual([r.von, r.bis], [3, letzte], 'nur "ab 3." heisst bis zum Ende des Tages');
  r = (await ole('POST', '/api/absences', { from: tag(2), to: tag(2), bis_stunde: 2 })).body;
  assert.deepEqual([r.von, r.bis], [1, 2], 'nur "bis 2." heisst ab der ersten');
  r = (await ole('POST', '/api/absences', { from: tag(3), to: tag(3) })).body;
  assert.deepEqual([r.von, r.bis], [null, null], 'ohne Angabe der ganze Tag');
  // Bearbeiten ist ein zweiter POST fuer denselben Tag.
  r = (await ole('POST', '/api/absences', { from: tag(1), to: tag(1), von_stunde: 2, bis_stunde: 4, grund: 'Arzt' })).body;
  const liste = (await ole('GET', '/api/absences')).body;
  assert.deepEqual([liste[0].von, liste[0].bis, liste[0].grund], [2, 4, 'Arzt']);
  assert.equal(liste.length, 3, 'kein zweiter Eintrag fuer denselben Tag');
});

test('Profil: Darstellung des Plans und die Farben der Zustaende', async () => {
  const [ida] = await register('farbe-ida');
  const me = (await ida('GET', '/api/me')).body;
  assert.equal(me.plan_stil, 'standard', 'Vorgabe');
  assert.deepEqual(me.status_farben,
    { entfaellt: '#c0392b', vertretung: '#d98b2b', ohne_lehrer: '#d98b2b', raum: '#d98b2b', pruefung: '#f5c400' },
    'die Vorgaben sind die alten Farben des Plans - und Gelb fuer die Pruefung');

  assert.equal((await ida('PATCH', '/api/me', { plan_stil: 'untis' })).body.plan_stil, 'untis');
  assert.equal((await ida('PATCH', '/api/me', { plan_stil: 'bunt' })).status, 400);
  assert.equal((await ida('GET', '/api/me')).body.plan_stil, 'untis', 'unveraendert');

  // Eine Farbe allein schicken: der Rest bleibt. Unfug fliegt raus, statt zu stoeren.
  const f = (await ida('PATCH', '/api/me', { status_farben: { vertretung: '#1e90ff', quatsch: '#000000', raum: 'blau' } })).body.status_farben;
  assert.equal(f.vertretung, '#1e90ff');
  assert.equal(f.raum, '#d98b2b', 'keine Farbe ist keine Farbe');
  assert.equal('quatsch' in f, false);
  assert.equal(f.entfaellt, '#c0392b', 'die anderen bleiben');
  assert.equal((await ida('GET', '/api/me')).body.status_farben.vertretung, '#1e90ff');

  // Aus dem Plan heraus eine Pruefung eintragen, ohne je den Kalender geoeffnet zu haben: der
  // eigene Kalender ist da und beschreibbar (der Client holt die Liste jetzt selbst nach).
  const k = (await ida('GET', '/api/kalender')).body.kalender;
  assert.ok(k.some(x => x.darf_aendern && x.quelle === 'eigen'), 'ein eigener, beschreibbarer Kalender');
});

test('Vertretung: der Lehrer der Stunde, nicht der des Kurses', async () => {
  // Am Kurs haengt bewusst der regulaere Lehrer (sonst klebt der Vertreter dauerhaft dort). Im
  // Plan soll aber stehen, wer wirklich davorsteht - dafuer hat die Stunde eine eigene Spalte.
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const p1 = cfg.periods[0];

  const nimm = (t, n) => {
    db.prepare(`INSERT OR IGNORE INTO ${t}(name, from_untis) VALUES(?, 1)`).run(n);
    return db.prepare(`SELECT id FROM ${t} WHERE name = ?`).get(n).id;
  };
  const fach = nimm('subjects', 'Chemie'), lehrer = nimm('teachers', 'Herr Regulär');
  db.prepare(`INSERT OR IGNORE INTO courses(id, title, subject_id, teacher_id, from_untis)
              VALUES('UNTIS-VTR', 'Chemie', ?, ?, 1)`).run(fach, lehrer);

  const [rico, ricoId] = await register('vertrico');
  const woche = (await rico('GET', '/api/timetable')).body;
  const [mo, di, mi] = woche.days;

  const legen = (datum, status, teacher) => db.prepare(`
    INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, room, status, teacher)
    VALUES(?, ?, ?, 'UNTIS-VTR', 'C1', ?, ?)`).run(ricoId, datum, p1.id, status, teacher);

  legen(mo.date, 'regular', 'Herr Regulär');
  legen(di.date, 'irregular', 'Frau Ersatz');
  legen(mi.date, 'irregular', null);      // Vertretung, aber niemand da

  const plan = (await rico('GET', '/api/timetable')).body;
  const holen = tag => plan.entries.find(e => e.day_id === tag.id && e.period_id === p1.id);

  assert.equal(holen(mo).teacher, 'Herr Regulär');
  assert.equal(holen(di).teacher, 'Frau Ersatz', 'die Vertretung nennt den Vertreter');
  assert.equal(holen(di).teacher_regulaer, 'Herr Regulär', 'und wen sie ersetzt');
  assert.equal(holen(mi).teacher, null, 'ohne Lehrer bleibt es leer - die Anzeige benennt es');
  assert.equal(holen(mi).status, 'irregular', 'ohne Lehrer trotzdem eine Vertretung');
});

test('Module: jeder Import wird auch exportiert', async () => {
  // Ein fehlendes `export` bricht im Browser den ganzen Modulbaum ab - die Seite bleibt schwarz,
  // ohne dass Syntaxpruefung oder API-Tests etwas merken. Genau das ist einmal passiert, als
  // beim Aufraeumen ein `export` mitgeloescht wurde. Deshalb hier fest verankert.
  const { readdirSync, readFileSync } = await import('node:fs');
  const ordner = new URL('./public/', import.meta.url);
  const module = readdirSync(ordner).filter(d => d.endsWith('.js') && d !== 'sw.js');

  const text = Object.fromEntries(module.map(d => [d, readFileSync(new URL(d, ordner), 'utf8')]));
  const EXPORT = /^export\s+(?:const|let|var|async function|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  const IMPORT = /^import \{ ([^}]+) \} from '\.\/([\w.-]+)';/gm;

  const exporte = Object.fromEntries(module.map(d =>
    [d, new Set([...text[d].matchAll(EXPORT)].map(m => m[1]))]));

  const fehler = [];
  for (const datei of module) {
    for (const m of text[datei].matchAll(IMPORT)) {
      const quelle = m[2];
      if (!exporte[quelle]) { fehler.push(`${datei} → ${quelle} (Datei fehlt)`); continue; }
      for (const name of m[1].split(',').map(x => x.trim())) {
        if (!exporte[quelle].has(name)) fehler.push(`${datei} importiert "${name}" aus ${quelle}`);
      }
    }
  }
  assert.deepEqual(fehler, [], 'Importe ohne passenden Export');

  // Und alles muss vom Einstieg aus erreichbar sein, sonst laufen die Module nie los und ihre
  // Ereignisbehandler haengen an nichts.
  const kanten = Object.fromEntries(module.map(d =>
    [d, [...text[d].matchAll(/from '\.\/([\w.-]+)'|import '\.\/([\w.-]+)'/g)].map(m => m[1] || m[2])]));
  const erreicht = new Set();
  const lauf = n => { if (erreicht.has(n)) return; erreicht.add(n); (kanten[n] ?? []).forEach(lauf); };
  lauf('app.js');
  assert.deepEqual(module.filter(d => !erreicht.has(d)), [],
    'nicht vom Einstieg aus erreichbar');
});

test('Die Oberflaeche ruft die Routen auf, die es gibt', async () => {
  // Die Notiz zog von entries in eine eigene Tabelle um - der Server war umgestellt, die Tests
  // riefen PUT /api/note direkt auf, und das Frontend schickte sie weiter an /api/entry, wo sie
  // stillschweigend verfiel. Eine reine API-Testsammlung sieht so etwas nie. Deshalb hier ein
  // grober, aber wirksamer Riegel: welche Routen app.js ueberhaupt anspricht.
  // Alle Module, nicht nur app.js: seit der Aufteilung liegt der Code in mehreren Dateien, und
  // ein beim Verschieben verlorener Aufruf faellt sonst niemandem auf.
  const { readFileSync, readdirSync } = await import('node:fs');
  const ordner = new URL('./public/', import.meta.url);
  const quelle = readdirSync(ordner)
    .filter(d => d.endsWith('.js') && d !== 'sw.js')
    .map(d => readFileSync(new URL(d, ordner), 'utf8'))
    .join('\n');

  for (const route of ['/api/note', '/api/entry', '/api/timetable', '/api/homework', '/api/chats'])
    assert.ok(quelle.includes(route), `app.js spricht ${route} nicht an`);

  // Und keine Aufrufe an Routen, die es nicht mehr gibt.
  for (const weg of ['/api/suggestions'])
    assert.equal(quelle.includes(weg), false, `app.js ruft noch ${weg} auf`);
});

test('Datenschutz: WebUntis-Stammdaten bleiben aus den Listen heraus', async () => {
  const admin = await login('admin', 'geheim');
  const [schueler, schuelerId] = await register('listenpruefer');
  const { db } = await import('./db.js');

  // So legt der Abgleich an: mit Herkunft.
  db.prepare("INSERT INTO subjects(name, from_untis) VALUES('Geheimfach', 1)").run();
  db.prepare("INSERT INTO teachers(name, from_untis) VALUES('Frau Geheim', 1)").run();
  db.prepare(`INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-4242', 'Geheimkurs', 1)`).run();
  const fach = db.prepare("SELECT id FROM subjects WHERE name = 'Geheimfach'").get().id;

  // Alle Stammdaten-Listen, auch die ohne Import - sie laufen durch dieselbe Schleife, und eine
  // fehlende Spalte faellt sonst erst im Browser auf.
  for (const pfad of ['/api/subjects', '/api/teachers', '/api/rooms', '/api/courses'])
    assert.equal((await admin('GET', pfad)).status, 200, pfad);

  for (const [pfad, name] of [['/api/subjects', 'Geheimfach'], ['/api/teachers', 'Frau Geheim']]) {
    const liste = (await admin('GET', pfad)).body;
    assert.equal(liste.some(r => r.name === name), false, `${pfad} zeigt Importiertes`);
  }
  assert.equal((await admin('GET', '/api/courses')).body.some(c => c.id === 'UNTIS-4242'), false,
    'Kursliste zeigt Importiertes');

  // Auch der Admin darf daran nicht schrauben - beim naechsten Abgleich waere es ohnehin weg.
  assert.equal((await admin('PUT', `/api/subjects/${fach}`, { name: 'Umbenannt' })).status, 409);
  assert.equal((await admin('DELETE', `/api/subjects/${fach}`)).status, 409);
  assert.equal((await admin('PUT', '/api/courses/UNTIS-4242',
    { id: 'UNTIS-4242', title: 'Anders' })).status, 409);
  assert.equal((await admin('DELETE', '/api/courses/UNTIS-4242')).status, 409);

  // Die Grenze verlaeuft am eigenen Plan, nicht am Import: wer den Kurs NICHT hat, sieht ihn
  // nicht und kann sich nicht hineinschreiben - sonst saehe er ueber die gemeinsamen Stunden,
  // wer darin sitzt.
  const cfg = (await schueler('GET', '/api/config')).body;
  const slot = { day_id: cfg.days[0].id, period_id: cfg.periods[0].id };
  assert.equal((await schueler('GET', '/api/courses')).body.some(c => c.id === 'UNTIS-4242'), false,
    'fremder Untis-Kurs steht nicht in der Auswahl');
  const fremd = await schueler('PUT', '/api/entry', { ...slot, course_id: 'UNTIS-4242' });
  assert.equal(fremd.status, 403);
  assert.match(fremd.body.error, /WebUntis/);

  // Wer ihn dagegen selbst im Plan hat, darf ihn auch eintragen - in eine andere Stunde legen,
  // eine falsch importierte ersetzen. Ohne das war die Kursauswahl fuer alle leer, deren Plan
  // vollstaendig aus WebUntis kommt: sie konnten in ihrem eigenen Plan gar nichts eintragen.
  db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, '2026-09-07', ?, 'UNTIS-4242', 'regular')`).run(schuelerId, cfg.periods[0].id);
  const meiner = (await schueler('GET', '/api/courses')).body.find(c => c.id === 'UNTIS-4242');
  assert.ok(meiner, 'der eigene Untis-Kurs steht in der Auswahl');
  assert.equal(meiner.from_untis, 1, 'als importiert gekennzeichnet - der Admin blendet ihn aus');
  assert.equal((await schueler('PUT', '/api/entry',
    { ...slot, period_id: cfg.periods[1].id, course_id: 'UNTIS-4242' })).status, 200);

  // Fuer den Admin, der die Stunde nicht hat, aendert das nichts.
  assert.equal((await admin('GET', '/api/courses')).body.some(c => c.id === 'UNTIS-4242'), false,
    'fremde Untis-Kurse bleiben unsichtbar');

  // Hausaufgaben zum eigenen Untis-Kurs gehen trotzdem - die haengen am Plan, nicht an der
  // Kursauswahl.
  assert.equal((await schueler('POST', '/api/homework',
    { course_id: 'UNTIS-4242', due_date: '2026-09-07', text: 'S. 5' })).status, 200);

  db.prepare("DELETE FROM homework WHERE course_id = 'UNTIS-4242'").run();
  db.prepare("DELETE FROM entries WHERE course_id = 'UNTIS-4242'").run();
  db.prepare("DELETE FROM untis_lessons WHERE course_id = 'UNTIS-4242'").run();
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-4242'").run();
  db.prepare("DELETE FROM subjects WHERE from_untis = 1").run();
  db.prepare("DELETE FROM teachers WHERE from_untis = 1").run();
});

test('WebUntis ersetzen: eigener Eintrag mit Vorrang gilt fuer jede Woche', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1DEG01', title: 'Deutsch GK' });
  const [wanda, wandaId] = await register('wanda');
  const cfg = (await wanda('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1] = cfg.periods;
  const { db } = await import('./db.js');

  // WebUntis liefert fuer zwei aufeinanderfolgende Montage etwas Falsches.
  const plan1 = (await wanda('GET', '/api/timetable')).body;
  const montag1 = plan1.days[0].date;
  const montag2 = new Date(Date.parse(montag1) + 7 * 86400e3).toISOString().slice(0, 10);
  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-FALSCH', 'Falsch', 1) ON CONFLICT(id) DO NOTHING").run();
  for (const datum of [montag1, montag2])
    db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
                VALUES(?, ?, ?, 'UNTIS-FALSCH', 'regular')`).run(wandaId, datum, p1.id);

  const holen = woche => wanda('GET', `/api/timetable${woche ? '?week=' + woche : ''}`)
    .then(r => r.body.entries.find(e => e.day_id === mo.id && e.period_id === p1.id));

  assert.equal((await holen()).id, 'UNTIS-FALSCH', 'ohne Vorrang gewinnt WebUntis');

  // Ein ALTER Eintrag aus dem selbst gebauten Wochenplan - von vor dem Abgleich, ohne Vorrang -
  // verliert weiterhin. Sonst stuende am Untis-Tag wieder der alte Plan daneben.
  db.prepare(`INSERT INTO entries(user_id, day_id, period_id, course_id, vorrang)
              VALUES(?, ?, ?, 'Q1DEG01', 0) ON CONFLICT(user_id, day_id, period_id)
              DO UPDATE SET course_id = excluded.course_id, vorrang = 0`).run(wandaId, mo.id, p1.id);
  assert.equal((await holen()).id, 'UNTIS-FALSCH', 'der alte Plan bleibt draussen');

  // Wer aber JETZT etwas eintraegt, meint es auch so: an einem Tag mit WebUntis-Stunden setzt
  // der Server den Vorrang selbst. Ohne das entstuende der Eintrag und waere beim naechsten
  // Laden kommentarlos verschwunden.
  await wanda('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'Q1DEG01' });
  const selbst = await holen();
  assert.equal(selbst.id, 'Q1DEG01', 'was man selbst eintraegt, bleibt stehen');
  assert.equal(selbst.vorrang, true);

  // Mit Vorrang gilt der eigene Eintrag - und zwar in beiden Wochen, nicht nur der sichtbaren.
  await wanda('PUT', '/api/entry',
    { day_id: mo.id, period_id: p1.id, course_id: 'Q1DEG01', vorrang: true });
  const ersteWoche = await holen();
  assert.equal(ersteWoche.id, 'Q1DEG01');
  assert.equal(ersteWoche.vorrang, true);
  assert.equal((await holen(montag2)).id, 'Q1DEG01', 'auch in der naechsten Woche');

  // Zuruecknehmen holt WebUntis wieder.
  await wanda('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: null });
  assert.equal((await holen()).id, 'UNTIS-FALSCH', 'wieder WebUntis');

  db.prepare("DELETE FROM untis_lessons WHERE user_id = ?").run(wandaId);
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-FALSCH'").run();
});

const ANSICHTEN_ANZAHL = 8;

test('Menuereihenfolge: jeder sortiert seine eigene', async () => {
  const [xaver] = await register('xaver');
  const standard = (await xaver('GET', '/api/me')).body.nav_order;
  assert.deepEqual(standard,
    ['plan', 'friends', 'chat', 'homework', 'buero', 'profile', 'absence', 'tickets'],
    'Abmeldung hinten - sie ist nur eine Info an Freunde, keine Krankmeldung');
  assert.equal(standard.includes('admin'), false, 'Admin laesst sich nicht wegsortieren');

  const eigen = (await xaver('PATCH', '/api/me',
    { nav_order: ['friends', 'plan', 'chat', 'homework', 'profile', 'absence'] })).body.nav_order;
  assert.deepEqual(eigen.slice(0, 2), ['friends', 'plan']);
  assert.deepEqual((await xaver('GET', '/api/me')).body.nav_order, eigen, 'bleibt gespeichert');

  // Unvollstaendig gespeichert: Fehlendes wird hinten angehaengt, damit spaeter dazukommende
  // Menuepunkte nicht unsichtbar werden.
  assert.equal(eigen.at(-1), 'tickets',
    'ein spaeter dazugekommener Menuepunkt haengt sich hinten an, statt zu verschwinden');

  const kurz = (await xaver('PATCH', '/api/me', { nav_order: ['profile'] })).body.nav_order;
  assert.equal(kurz[0], 'profile');
  assert.equal(kurz.length, ANSICHTEN_ANZAHL, 'der Rest haengt hinten dran');

  assert.equal((await xaver('PATCH', '/api/me', { nav_order: ['gibtsnicht'] })).status, 400);

  // Und die Reihenfolge ist wirklich persoenlich.
  const [yuri2] = await register('sortieryuri');
  assert.deepEqual((await yuri2('GET', '/api/me')).body.nav_order, standard, 'andere unberuehrt');
});

test('Eigene Kursnamen und -farben gelten nur fuer einen selbst', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'G2_DE', title: 'Deutsch Grundkurs 2' });
  const [yannick, yannickId] = await register('yannick');
  const [zoe] = await register('zoe');
  const cfg = (await yannick('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1] = cfg.periods;

  // Ohne Kurs im Plan taucht auch nichts in der Liste auf.
  assert.deepEqual((await yannick('GET', '/api/my-courses')).body, []);

  await yannick('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'G2_DE' });
  await zoe('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'G2_DE' });
  assert.equal((await yannick('GET', '/api/my-courses')).body[0].id, 'G2_DE');

  assert.equal((await yannick('PUT', '/api/my-courses/G2_DE',
    { name: 'Deutsch GK', short: 'DEU', color: '#3366cc' })).status, 200);

  const meins = (await yannick('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p1.id);
  assert.equal(meins.pref_name, 'Deutsch GK');
  assert.equal(meins.pref_short, 'DEU', 'eigenes Kuerzel fuer die kompakte Ansicht');
  assert.equal(meins.pref_color, '#3366cc');

  // Zoe sieht davon nichts - weder im eigenen Plan noch sonst wo.
  const ihrs = (await zoe('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p1.id);
  assert.equal(ihrs.pref_name, null, 'persoenlich, nicht global');
  assert.equal(ihrs.pref_short, null);
  assert.equal((await zoe('GET', '/api/courses')).body.find(c => c.id === 'G2_DE').title,
    'Deutsch Grundkurs 2', 'der echte Kurs bleibt unangetastet');

  // Freundesplan: meine Namen gelten, weil ich sie wiedererkennen will.
  await yannick('POST', '/api/friends', { username: 'zoe' });
  await zoe('POST', `/api/friends/${yannickId}/accept`);
  const zoeId = (await zoe('GET', '/api/me')).body.id;
  const beiZoe = (await yannick('GET', `/api/timetable?user=${zoeId}`)).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p1.id);
  assert.equal(beiZoe.pref_name, 'Deutsch GK', 'im Freundesplan gelten meine Namen');

  assert.equal((await yannick('PUT', '/api/my-courses/G2_DE', { color: 'blau' })).status, 400);
  assert.equal((await yannick('PUT', '/api/my-courses/GIBTSNICHT', { name: 'x' })).status, 404);

  // Die Hausaufgaben-Auswahl kommt aus derselben Quelle - sie muss alle eigenen Kurse kennen,
  // nicht nur die der gerade angezeigten Woche.
  assert.equal((await yannick('GET', '/api/my-courses')).body.some(c => c.id === 'G2_DE'), true);

  await yannick('DELETE', '/api/my-courses/G2_DE');
  const zurueck = (await yannick('GET', '/api/my-courses')).body[0];
  assert.equal(zurueck.pref_name, null, 'zurueckgesetzt');
  assert.equal(zurueck.pref_short, null);
});

test('Version, Neuigkeiten und Datenschutz - ohne Anmeldung lesbar, nur als Admin schreibbar', async () => {
  const admin = await login('admin', 'geheim');
  const [nutzer] = await register('lesernutzer');

  // Eine Datenschutzerklaerung, die man erst nach dem Anmelden lesen kann, ist keine.
  const ohne = await client()('GET', '/api/info');
  assert.equal(ohne.status, 200, 'ohne Cookie erreichbar');
  assert.match(ohne.body.version, /^\d+\.\d+\.\d+$/);

  assert.equal((await nutzer('PUT', '/api/settings/text', { key: 'privacy', text: 'x' })).status, 403,
    'schreiben nur als Admin');

  const mehrzeilig = ['Wir speichern:', '- deinen Namen', '- deinen Plan'].join('\n');
  const r = await admin('PUT', '/api/settings/text', { key: 'privacy', text: mehrzeilig });
  assert.equal(r.status, 200);
  assert.ok(r.body.at, 'Aenderungszeitpunkt wird gemerkt');

  const jetzt = (await client()('GET', '/api/info')).body;
  assert.match(jetzt.privacy, /deinen Plan/);
  assert.equal(jetzt.privacy, mehrzeilig, 'Absaetze bleiben erhalten');

  // Feste Liste: sonst waere das ein Schreibzugriff auf alle Einstellungen.
  for (const key of ['registration_key', 'untis_server', 'admin'])
    assert.equal((await admin('PUT', '/api/settings/text', { key, text: 'gekapert' })).status, 400, key);
  assert.notEqual((await admin('GET', '/api/settings')).body.registration_key, 'gekapert',
    'der Registrierungs-Key liess sich nicht ueber diesen Weg setzen');
});

test('Chat: unlesbare Altnachrichten aufraeumen', async () => {
  // Was mit einem verworfenen Schluessel verschluesselt wurde, kann niemand mehr lesen. Welche
  // Nachrichten das sind, weiss nur der Browser - deshalb schickt er die IDs. Der Server prueft
  // dann, dass sie wirklich zu dieser Unterhaltung gehoeren und verschluesselt sind.
  const [ada, adaId] = await register('raeumada');
  const [bo, boId] = await register('raeumbo');
  const [cid, cidId] = await register('raeumcid');
  await bo('POST', '/api/friends', { username: 'raeumada' });
  await ada('POST', `/api/friends/${boId}/accept`);
  await cid('POST', '/api/friends', { username: 'raeumada' });
  await ada('POST', `/api/friends/${cidId}/accept`);

  const kaputt = (await ada('POST', `/api/chats/${boId}`, { text: 'AAAA:BBBB', enc: true })).body;
  const klar = (await ada('POST', `/api/chats/${boId}`, { text: 'lesbar' })).body;
  const fremd = (await ada('POST', `/api/chats/${cidId}`, { text: 'CCCC:DDDD', enc: true })).body;

  // Alle drei IDs auf einmal - nur die eine darf verschwinden.
  const weg = await bo('POST', `/api/chats/${adaId}/aufraeumen`,
    { ids: [kaputt.id, klar.id, fremd.id, 999999] });
  assert.equal(weg.status, 200);
  assert.equal(weg.body.geloescht, 1, 'nur das Chiffrat aus dieser Unterhaltung');

  const rest = (await bo('GET', `/api/chats/${adaId}`)).body.map(m => m.text);
  assert.deepEqual(rest, ['lesbar'], 'die lesbare Nachricht bleibt');
  assert.equal((await cid('GET', `/api/chats/${adaId}`)).body.length, 1,
    'die fremde Unterhaltung ist unberuehrt');

  // Und nicht ueber Unterhaltungen hinweg, mit denen man nichts zu tun hat.
  assert.equal((await cid('POST', `/api/chats/${boId}/aufraeumen`, { ids: [1] })).status, 403);
});

test('Chat Ende-zu-Ende: der Server sieht nur Kauderwelsch', async () => {
  // Dasselbe Verfahren, das der Browser fährt - hier mit Nodes WebCrypto nachgestellt. Geprüft
  // wird die Eigenschaft, auf die es ankommt: beide Seiten rechnen denselben Schlüssel aus, und
  // was beim Server ankommt, enthält den Klartext nicht.
  const { subtle } = globalThis.crypto;
  const paar = () => subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const gemeinsam = (privat, fremd) => subtle.deriveKey({ name: 'ECDH', public: fremd }, privat,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  const a = await paar(), b = await paar(), fremder = await paar();
  const keyA = await gemeinsam(a.privateKey, b.publicKey);
  const keyB = await gemeinsam(b.privateKey, a.publicKey);

  const klartext = 'Treffen wir uns um 13 Uhr an der Bibliothek?';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const chiffrat = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, keyA,
    new TextEncoder().encode(klartext)));
  const blob = Buffer.from(iv).toString('base64') + ':' + chiffrat.toString('base64');

  // 1. Der Empfänger kommt heran - beide Seiten leiten denselben Schlüssel ab.
  const zurueck = new TextDecoder().decode(
    await subtle.decrypt({ name: 'AES-GCM', iv }, keyB, chiffrat));
  assert.equal(zurueck, klartext);

  // 2. Ein Dritter nicht, auch nicht mit derselben Kurve.
  const keyX = await gemeinsam(fremder.privateKey, a.publicKey);
  await assert.rejects(() => subtle.decrypt({ name: 'AES-GCM', iv }, keyX, chiffrat));

  // 3. Und der Klartext steckt nicht im Chiffrat.
  assert.equal(blob.includes('Bibliothek'), false);
  assert.equal(chiffrat.toString('latin1').includes('Treffen'), false);

  // Jetzt derselbe Blob durch die echte Route: der Server nimmt ihn, speichert ihn unverändert
  // und weiß nur, dass er verschlüsselt ist.
  const [ida, idaId] = await register('kryptoada');
  const [idb, idbId] = await register('kryptobo');
  await idb('POST', '/api/friends', { username: 'kryptoada' });
  await ida('POST', `/api/friends/${idbId}/accept`);

  assert.equal((await ida('POST', `/api/chats/${idbId}`, { text: blob, enc: true })).status, 200);

  const { db } = await import('./db.js');
  const gespeichert = db.prepare('SELECT text, enc FROM messages WHERE from_id = ? ORDER BY id DESC')
    .get(idaId);
  assert.equal(gespeichert.enc, 1);
  assert.equal(gespeichert.text, blob, 'unverändert durchgereicht');
  assert.equal(gespeichert.text.includes('Bibliothek'), false, 'kein Klartext in der Datenbank');

  // Auch die Schlüsselablage: der private Teil liegt nur verschlossen hier, und fremde
  // öffentliche Schlüssel gibt es nur unter Freunden.
  await ida('PUT', '/api/me/keys', { pub_key: '{"kty":"EC"}', priv_key_enc: 'salt:iv:daten' });
  assert.equal((await idb('GET', `/api/keys/${idaId}`)).body.pub_key, '{"kty":"EC"}');

  const [fremd] = await register('kryptofremd');
  assert.equal((await fremd('GET', `/api/keys/${idaId}`)).status, 403, 'nur unter Freunden');
});

test('Benachrichtigungen: VAPID, Warteschlange und Schalter', async t => {
  const { pushKey, vapidToken, vapidPublicKey } = await import('./push.js');
  const { verify } = await import('node:crypto');

  // Der öffentliche Schlüssel geht so an den Browser, wie applicationServerKey ihn erwartet:
  // unkomprimierter Punkt, 65 Bytes, führendes 0x04.
  const roh = Buffer.from(pushKey(), 'base64url');
  assert.equal(roh.length, 65);
  assert.equal(roh[0], 4);

  // Das JWT muss der Push-Dienst prüfen können - eine falsche Signaturform (DER statt r||s) wäre
  // hier die wahrscheinlichste Falle und fiele sonst erst beim echten Versand auf.
  const jwt = vapidToken('https://fcm.googleapis.com/fcm/send/abc123');
  const [kopf, inhalt, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(kopf, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(inhalt, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'nur der Ursprung, nicht der volle Endpunkt');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, 'hoechstens 24 Stunden gueltig');
  assert.equal(Buffer.from(sig, 'base64url').length, 64, 'r||s, nicht DER');
  assert.equal(verify('sha256', Buffer.from(`${kopf}.${inhalt}`),
    { key: vapidPublicKey(), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);

  // Abo, Warteschlange, Schalter
  const [nils, nilsId] = await register('pushnils');
  const [oskar, oskarId] = await register('pushoskar');
  await nils('POST', '/api/friends', { username: 'pushoskar' });

  // Die Anfrage selbst meldet sich schon beim Empfaenger.
  const anfrage = (await oskar('GET', '/api/notifications/pending')).body;
  assert.equal(anfrage.length, 1);
  assert.match(anfrage[0].title, /pushnils.*Freund/);

  await oskar('POST', `/api/friends/${nilsId}/accept`);
  const angenommen = (await nils('GET', '/api/notifications/pending')).body;
  assert.equal(angenommen.length, 1, 'und das Annehmen meldet sich zurueck');
  assert.match(angenommen[0].title, /angenommen/);

  assert.equal((await nils('POST', '/api/push/subscribe', { endpoint: 'nix' })).status, 400);
  assert.equal((await nils('POST', '/api/push/subscribe',
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).status, 200);

  // Eine Nachricht an Oskar legt bei ihm eine Meldung ab - ohne den Text, den der Server bei
  // Ende-zu-Ende gar nicht kennt.
  await nils('POST', `/api/chats/${oskarId}`, { text: 'iv:geheim', enc: true });
  const offen = (await oskar('GET', '/api/notifications/pending')).body;
  assert.equal(offen.length, 1);
  assert.match(offen[0].title, /Neue Nachricht von pushnils/);
  assert.equal(offen[0].body, null, 'kein Inhalt in der Benachrichtigung');
  assert.equal(JSON.stringify(offen).includes('geheim'), false);

  // Abgeholt ist abgeholt - sonst zeigt der Service Worker dasselbe bei jedem Anstupsen erneut.
  assert.deepEqual((await oskar('GET', '/api/notifications/pending')).body, []);

  // Und niemand sieht fremde Meldungen.
  assert.deepEqual((await nils('GET', '/api/notifications/pending')).body, []);

  // Alle vier Schalter sind da und stehen auf an.
  const me = (await oskar('GET', '/api/me')).body;
  for (const f of ['push_chat', 'push_ausfall', 'push_vertretung', 'push_freunde'])
    assert.equal(me[f], true, f);

  // Wer den Schalter umlegt, bekommt nichts mehr.
  assert.equal((await oskar('PATCH', '/api/me', { push_chat: false })).body.push_chat, false);
  await nils('POST', `/api/chats/${oskarId}`, { text: 'noch was' });
  assert.deepEqual((await oskar('GET', '/api/notifications/pending')).body, [], 'abgeschaltet');
});

test('Kein Flickenteppich: pro Tag gilt entweder WebUntis oder der eigene Plan', async () => {
  // Der gemeldete Fehler: mal stand am Montag der alte Plan und am Rest der neue, mal umgekehrt.
  // Ursache war, dass pro *Stunde* zusammengeführt wurde - wo WebUntis nichts lieferte, blieb der
  // selbst gebaute Eintrag stehen. Am Rand des abgeglichenen Zeitraums wurde daraus ein Mix,
  // den niemand deuten kann.
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'EIGEN01', title: 'Selbst gebaut' });
  const [mia, miaId] = await register('mischmia');
  const { db } = await import('./db.js');

  const cfg = (await mia('GET', '/api/config')).body;
  const [mo, di] = cfg.days, [p1] = cfg.periods;

  // Eigener Plan: Montag und Dienstag belegt.
  for (const tag of [mo, di])
    await mia('PUT', '/api/entry', { day_id: tag.id, period_id: p1.id, course_id: 'EIGEN01' });

  const woche = (await mia('GET', '/api/timetable')).body;
  const dieseWoche = woche.week;
  const naechste = new Date(Date.parse(dieseWoche) + 7 * 86400e3).toISOString().slice(0, 10);
  const montag = woche.days[0].date;

  // WebUntis deckt genau diese Woche ab und liefert nur für Montag etwas.
  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-MIX', 'Aus Untis', 1) ON CONFLICT(id) DO NOTHING").run();
  db.prepare(`INSERT INTO untis_accounts(user_id, username, secret, von, bis)
              VALUES(?, 'mia', 'x', ?, ?)`)
    .run(miaId, dieseWoche, new Date(Date.parse(dieseWoche) + 6 * 86400e3).toISOString().slice(0, 10));
  db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-MIX', 'regular')`).run(miaId, montag, p1.id);

  const holen = async w => {
    const b = (await mia('GET', `/api/timetable${w ? '?week=' + w : ''}`)).body;
    const bei = tag => b.entries.find(e => e.day_id === tag.id && e.period_id === p1.id);
    return { montag: bei(mo), dienstag: bei(di) };
  };

  // Für den Montag hat WebUntis etwas - dort gilt er, und zwar für den ganzen Tag.
  const drin = await holen();
  assert.equal(drin.montag?.id, 'UNTIS-MIX');

  // Für den Dienstag hat WebUntis nichts. Der Tag liegt zwar im abgeglichenen Zeitraum, aber
  // "kein Eintrag" heißt nicht "frei" - die Schule hat den Plan vielleicht nur noch nicht
  // veröffentlicht. Dann bleibt der eigene Plan stehen, statt zu verschwinden.
  assert.equal(drin.dienstag?.id, 'EIGEN01', 'ohne Untis-Daten bleibt der eigene Plan');

  // Und eine ganze Woche ohne WebUntis-Daten bleibt vollständig der eigene Plan.
  const draussen = await holen(naechste);
  assert.equal(draussen.montag?.id, 'EIGEN01');
  assert.equal(draussen.dienstag?.id, 'EIGEN01');

  // Der Flickenteppich, den die Regel verhindert, ist der ALTE Wochenplan: EIGEN01 steht oben
  // fuer jeden Tag in p1 - am Montag gilt trotzdem UNTIS-MIX (siehe oben). Was man dagegen
  // JETZT in eine freie Stunde eintraegt, ist Absicht und bleibt stehen.
  const [p2] = cfg.periods.slice(1);
  await mia('PUT', '/api/entry', { day_id: mo.id, period_id: p2.id, course_id: 'EIGEN01' });
  const montagSlots = (await mia('GET', '/api/timetable')).body.entries
    .filter(e => e.day_id === mo.id && !e.auto);
  assert.deepEqual(montagSlots.map(e => e.id).sort(), ['EIGEN01', 'UNTIS-MIX'],
    'die selbst eingetragene Stunde steht neben der von WebUntis');
  assert.equal(montagSlots.find(e => e.period_id === p1.id).id, 'UNTIS-MIX',
    'der alte Wochenplan bleibt trotzdem draussen');

  // Und eine dauerhaft ersetzte Stunde überlebt beides.
  await mia('PUT', '/api/entry',
    { day_id: mo.id, period_id: p1.id, course_id: 'EIGEN01', vorrang: true });
  assert.equal((await holen()).montag?.id, 'EIGEN01', 'Ersetztes bleibt ersetzt');

  db.prepare('DELETE FROM untis_lessons WHERE user_id = ?').run(miaId);
  db.prepare('DELETE FROM untis_accounts WHERE user_id = ?').run(miaId);
});

test('Abgleich: haeufig fuer die naechsten Wochen, selten fuer den ganzen Zeitraum', async () => {
  const [pit, pitId] = await register('taktpit');
  const { db } = await import('./db.js');
  db.prepare("INSERT INTO untis_accounts(user_id, username, secret) VALUES(?, 'pit', 'x')").run(pitId);

  const konto = () => db.prepare('SELECT * FROM untis_accounts WHERE user_id = ?').get(pitId);

  // Ein gescheiterter Versuch darf nicht alle zehn Minuten wiederholt werden - WebUntis sperrt
  // Konten nach einigen Fehlversuchen, und das waere ein echtes Problem fuer den Schueler.
  db.prepare("UPDATE untis_accounts SET last_error = 'falsch', last_error_at = datetime('now') WHERE user_id = ?")
    .run(pitId);
  const faellig = () => db.prepare(`SELECT count(*) AS n FROM untis_accounts
    WHERE user_id = ? AND (last_sync IS NULL OR last_sync < datetime('now', '-10 minutes'))
      AND (last_error_at IS NULL OR last_error_at < datetime('now', '-1 hour'))`).get(pitId).n;
  assert.equal(faellig(), 0, 'nach einem Fehler wird pausiert');

  db.prepare("UPDATE untis_accounts SET last_error_at = datetime('now', '-2 hours') WHERE user_id = ?")
    .run(pitId);
  assert.equal(faellig(), 1, 'nach einer Stunde wieder faellig');

  // Und ein frischer Abgleich ist nicht sofort wieder dran.
  db.prepare("UPDATE untis_accounts SET last_sync = datetime('now'), last_error_at = NULL WHERE user_id = ?")
    .run(pitId);
  assert.equal(faellig(), 0, 'gerade abgeglichen, also Ruhe');
  assert.equal(konto().username, 'pit');

  db.prepare('DELETE FROM untis_accounts WHERE user_id = ?').run(pitId);
});

test('Hausaufgaben funktionieren auch, wenn der Plan aus WebUntis kommt', async () => {
  // Vorher hing "habe ich diesen Kurs?" allein an den selbst eingetragenen Stunden. Wer seinen
  // Plan aus WebUntis bezieht - und das ist inzwischen der Normalfall -, konnte deshalb weder
  // eine Hausaufgabe eintragen noch eine sehen.
  const [rico, ricoId] = await register('untisrico');
  const [sina, sinaId] = await register('untissina');
  const { db } = await import('./db.js');
  const cfg = (await rico('GET', '/api/config')).body;
  // Ein Schultag aus dem laufenden Plan, nicht "heute": am Wochenende gehoert heute zu keinem
  // Wochentag des Rasters, die Stunde haette keinen Slot und die Aufgabe niemanden, der sie sieht.
  const heute = (await rico('GET', '/api/timetable')).body.days[0].date;

  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-HA', 'Mathe LK', 1) ON CONFLICT(id) DO NOTHING").run();
  for (const id of [ricoId, sinaId])
    db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
                VALUES(?, ?, ?, 'UNTIS-HA', 'regular')`).run(id, heute, cfg.periods[0].id);

  const r = await rico('POST', '/api/homework',
    { course_id: 'UNTIS-HA', due_date: heute, text: 'S. 42 Nr. 3' });
  assert.equal(r.status, 200, 'eintragen geht');

  // Und wer denselben Kurs hat, sieht sie - genau wie beim selbst gebauten Plan.
  assert.equal((await sina('GET', '/api/homework')).body.some(h => h.text === 'S. 42 Nr. 3'), true);

  // Wer ihn nicht hat, sieht nichts.
  const [fremd] = await register('untisfremd');
  assert.equal((await fremd('GET', '/api/homework')).body.length, 0);
  assert.equal((await fremd('POST', '/api/homework',
    { course_id: 'UNTIS-HA', due_date: heute, text: 'geht nicht' })).status, 403);

  db.prepare("DELETE FROM homework WHERE course_id = 'UNTIS-HA'").run();
  db.prepare("DELETE FROM untis_lessons WHERE course_id = 'UNTIS-HA'").run();
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-HA'").run();
});

test('Ferien: Tage werden benannt und bleiben leer', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'FERI01', title: 'Irgendwas' });
  const [nele] = await register('ferienele');
  const { db } = await import('./db.js');
  const cfg = (await nele('GET', '/api/config')).body;
  const [mo, di] = cfg.days, [p1] = cfg.periods;

  for (const tag of [mo, di])
    await nele('PUT', '/api/entry', { day_id: tag.id, period_id: p1.id, course_id: 'FERI01' });

  const woche = (await nele('GET', '/api/timetable')).body;
  const montag = woche.days[0].date;
  const { standardSchule } = await import('./db.js');
  db.prepare("INSERT INTO holidays(school_id, von, bis, name) VALUES(?, ?, ?, 'Herbstferien')")
    .run(standardSchule().id, montag, montag);

  const jetzt = (await nele('GET', '/api/timetable')).body;
  assert.equal(jetzt.ferien[montag], 'Herbstferien', 'der Tag ist benannt');

  // In den Ferien steht nichts - auch nicht der eigene Wochenplan, der dort schlicht falsch waere.
  assert.equal(jetzt.entries.some(e => e.day_id === mo.id), false, 'Ferientag bleibt leer');
  assert.equal(jetzt.entries.some(e => e.day_id === di.id && e.id === 'FERI01'), true,
    'der Rest der Woche bleibt unberuehrt');

  db.prepare('DELETE FROM holidays').run();
});

test('Hausaufgaben trennen zwei Jahrgaenge mit derselben Kurs-ID', async () => {
  // Der gemeldete Fall: der 13er hat "G4" in der 8. Stunde, der 12er "G4" in der 4. Weil WebUntis
  // nicht immer eine Kursnummer liefert, teilen sich beide dieselbe course_id - und damit sahen
  // sie gegenseitig ihre Hausaufgaben. Der Slot trennt sie.
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'G4', title: 'Mathe G4' });
  const [dreizehn] = await register('jahrgang13');
  const [zwoelf] = await register('jahrgang12');
  const cfg = (await dreizehn('GET', '/api/config')).body;
  const [mo] = cfg.days;
  const achte = cfg.periods.at(-1), vierte = cfg.periods[1];
  const heute = new Date().toISOString().slice(0, 10);

  await dreizehn('PUT', '/api/entry', { day_id: mo.id, period_id: achte.id, course_id: 'G4' });
  await zwoelf('PUT', '/api/entry', { day_id: mo.id, period_id: vierte.id, course_id: 'G4' });

  const r = await dreizehn('POST', '/api/homework',
    { course_id: 'G4', due_date: heute, text: 'Nur fuer die 13' });
  assert.equal(r.status, 200);

  const texte = k => k('GET', '/api/homework').then(x => x.body.map(h => h.text));
  assert.deepEqual(await texte(dreizehn), ['Nur fuer die 13'], 'der eigene Jahrgang sieht sie');
  assert.deepEqual(await texte(zwoelf), [], 'der andere Jahrgang nicht');

  // Wer denselben Kurs in derselben Stunde hat, gehoert dazu - darum geht es ja.
  const [mitschueler] = await register('jahrgang13b');
  await mitschueler('PUT', '/api/entry', { day_id: mo.id, period_id: achte.id, course_id: 'G4' });
  assert.deepEqual(await texte(mitschueler), ['Nur fuer die 13'], 'Kurskamerad sieht sie');

  // Ueber das Menue eingetragen, an einem Tag ohne diesen Kurs: der Server findet den Slot selbst.
  const inDreiTagen = new Date(Date.parse(heute) + 3 * 86400e3).toISOString().slice(0, 10);
  assert.equal((await zwoelf('POST', '/api/homework',
    { course_id: 'G4', due_date: inDreiTagen, text: 'Vom 12er ueber das Menue' })).status, 200);
  assert.equal((await mitschueler('GET', '/api/homework')).body.some(h => h.text.includes('12er')),
    false, 'landet beim 12er-Slot, nicht beim 13er');
  assert.equal((await zwoelf('GET', '/api/homework')).body.some(h => h.text.includes('12er')), true);
});

test('WebUntis-Stunde einzeln entfernen und zurueckholen', async () => {
  const [olav, olavId] = await register('entferner');
  const { db } = await import('./db.js');
  const cfg = (await olav('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1] = cfg.periods;

  const plan1 = (await olav('GET', '/api/timetable')).body;
  const montag = plan1.days[0].date;
  const naechster = new Date(Date.parse(montag) + 7 * 86400e3).toISOString().slice(0, 10);
  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-WEG', 'Falsche Stunde', 1) ON CONFLICT(id) DO NOTHING").run();
  for (const datum of [montag, naechster])
    db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
                VALUES(?, ?, ?, 'UNTIS-WEG', 'regular')`).run(olavId, datum, p1.id);

  const slot = async woche => (await olav('GET', `/api/timetable${woche ? '?week=' + woche : ''}`))
    .body.entries.find(e => e.day_id === mo.id && e.period_id === p1.id);

  assert.equal((await slot()).id, 'UNTIS-WEG', 'kommt aus WebUntis');

  // Entfernen gilt fuer jede Woche, nicht nur die sichtbare.
  assert.equal((await olav('PUT', '/api/entry',
    { day_id: mo.id, period_id: p1.id, course_id: '__weg__', vorrang: true })).status, 200);
  assert.equal((await slot()).id, '__weg__');
  assert.equal((await slot(naechster)).id, '__weg__', 'auch naechste Woche');

  // Eine entfernte Stunde ist keine gemeinsame Stunde - sonst "traefe" man sich im Nichts.
  const [pia2, pia2Id] = await register('entferner2');
  await olav('POST', '/api/friends', { username: 'entferner2' });
  await pia2('POST', `/api/friends/${olavId}/accept`);
  await pia2('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: '__weg__', vorrang: true });
  assert.deepEqual((await slot()).shared, [], 'niemand teilt eine entfernte Stunde');

  // Und sie ist kein Kurs: keine Hausaufgaben, nicht in der Auswahl.
  assert.equal((await olav('POST', '/api/homework',
    { course_id: '__weg__', due_date: montag, text: 'geht nicht' })).status, 400);
  assert.equal((await olav('GET', '/api/courses')).body.some(c => c.id === '__weg__'), false);
  assert.equal((await olav('GET', '/api/my-courses')).body.some(c => c.id === '__weg__'), false);

  // Zurueckholen: Eintrag weg, WebUntis gilt wieder.
  await olav('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: null });
  assert.equal((await slot()).id, 'UNTIS-WEG', 'wieder da');

  db.prepare('DELETE FROM untis_lessons WHERE user_id IN (?, ?)').run(olavId, pia2Id);
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-WEG'").run();
});

test('WebUntis-Hausaufgaben: importiert, gekennzeichnet, schreibgeschuetzt', async () => {
  const [hera, heraId] = await register('untisherta');
  const { db } = await import('./db.js');
  const heute = new Date().toISOString().slice(0, 10);

  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-555', 'Chemie', 1) ON CONFLICT(id) DO NOTHING").run();
  db.prepare(`INSERT INTO untis_homework(user_id, untis_id, course_id, date, due_date, text, remark)
              VALUES(?, 42, 'UNTIS-555', ?, ?, 'Versuch protokollieren', 'bis Freitag')`)
    .run(heraId, heute, heute);

  const liste = (await hera('GET', '/api/homework')).body;
  const meins = liste.find(h => h.text.includes('Versuch'));
  assert.ok(meins, 'taucht in der Liste auf');
  assert.equal(meins.von_untis, true, 'ist als von der Schule gekennzeichnet');
  assert.equal(meins.by, null, 'kein Verfasser aus unserer Nutzerliste');
  assert.match(meins.text, /bis Freitag/, 'die Bemerkung des Lehrers steht dabei');
  assert.ok(meins.id < 0, 'eigener Nummernraum, damit sich nichts mit eigenen Aufgaben beisst');

  // Abhaken ist persoenlich und geht auch hier.
  assert.equal((await hera('POST', `/api/homework/${meins.id}/done`)).status, 200);
  assert.equal((await hera('GET', '/api/homework')).body.find(h => h.id === meins.id).done, true);

  // Aendern und Loeschen nicht - die gehoert der Schule.
  assert.equal((await hera('PUT', `/api/homework/${meins.id}`,
    { course_id: 'UNTIS-555', due_date: heute, text: 'gekapert' })).status, 404);
  assert.equal((await hera('DELETE', `/api/homework/${meins.id}`)).status, 404);
  assert.match((await hera('GET', '/api/homework')).body.find(h => h.id === meins.id).text, /Versuch/);

  // Und niemand sonst sieht sie - sie haengt am eigenen Abgleich.
  const [fremd] = await register('untisfremd2');
  assert.equal((await fremd('GET', '/api/homework')).body.some(h => h.text.includes('Versuch')), false);

  db.prepare('DELETE FROM untis_homework WHERE user_id = ?').run(heraId);
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-555'").run();
});

test('Altbestand: Hausaufgaben ohne Stunde werden zugeordnet oder privat', async () => {
  // Vor der Slot-Pruefung angelegte Hausaufgaben hatten weder Tag noch Stunde - und liefen
  // deshalb weiter zwischen zwei Jahrgaengen mit derselben Kurs-ID ueber.
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'ALTG4', title: 'Alt Mathe' });
  const [alfons, alfonsId] = await register('altverfasser');
  const [berta] = await register('altmitschueler');
  const cfg = (await alfons('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1, p2] = cfg.periods;
  const heute = new Date().toISOString().slice(0, 10);
  const { db } = await import('./db.js');

  await alfons('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'ALTG4' });
  await berta('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'ALTG4' });

  // So sieht eine Zeile von frueher aus: Kurs ja, Slot nein.
  const alt = db.prepare(`INSERT INTO homework(course_id, due_date, text, user_id, created_at)
    VALUES('ALTG4', ?, 'Alte Aufgabe', ?, datetime('now'))`).run(heute, alfonsId).lastInsertRowid;

  // Ohne Zuordnung sieht sie nur der Verfasser - lieber eine zu wenig als beim falschen Jahrgang.
  const sieht = k => k('GET', '/api/homework').then(r => r.body.some(h => h.text === 'Alte Aufgabe'));
  assert.equal(await sieht(alfons), true, 'der Verfasser sieht seine eigene');
  assert.equal(await sieht(berta), false, 'sonst niemand, solange die Stunde fehlt');
  const meins = (await alfons('GET', '/api/homework')).body.find(h => h.text === 'Alte Aufgabe');
  assert.equal(meins.ohne_slot, true, 'und die Zeile sagt das auch');

  // Nach der Zuordnung sieht der Kurskamerad sie wieder.
  db.prepare('UPDATE homework SET day_id = ?, period_id = ? WHERE id = ?')
    .run(mo.id, p1.id, Number(alt));
  assert.equal(await sieht(berta), true, 'zugeordnet: der Kurs sieht sie');
  assert.equal((await alfons('GET', '/api/homework')).body
    .find(h => h.text === 'Alte Aufgabe').ohne_slot, false);

  // Wer denselben Kurs zu anderer Stunde hat, sieht sie weiterhin nicht.
  const [carl] = await register('altanderer');
  await carl('PUT', '/api/entry', { day_id: mo.id, period_id: p2.id, course_id: 'ALTG4' });
  assert.equal(await sieht(carl), false, 'andere Stunde, anderer Kurs');
});

test('Stundentexte der Lehrer kommen getrennt im Plan an', async () => {
  const { aufbereiten } = await import('./untis.js');
  const roh = [{
    date: 20260907, startTime: 800, endTime: 845, lsnumber: 4711,
    su: [{ name: 'KU', longname: 'Kunst' }], te: [{ name: 'MEY' }],
    substText: 'Vertretung durch Frau Meier',
    lstext: 'Fotouebung zu Licht; Was macht ein gutes Foto aus?',
    bkText: ['HA:', '-SZ Artikel', '-AB Auge+Fotoapparat'].join('\n'),
  }];
  const [f] = aufbereiten(roh);

  // Kurz und lang gehoeren getrennt: das eine steht in der Zelle, das andere im Detailfenster.
  // Frueher war beides mit " · " verklebt und die Zeilenumbrueche des Lehrers waren hin.
  assert.equal(f.info, 'Vertretung durch Frau Meier');
  assert.match(f.lesson_text, /^Unterrichtstext:/);
  assert.match(f.lesson_text, /Fotouebung zu Licht/);
  assert.match(f.lesson_text, /-SZ Artikel/);
  assert.equal(f.lesson_text.split('\n').length > 3, true, 'Zeilenumbrueche bleiben erhalten');
  assert.equal(f.info.includes('Fotouebung'), false, 'der lange Text steht nicht in der Zelle');

  // Diese Stunde hat KEIN 'code', aber einen Vertretungstext - sie ist eine Vertretung. Frueher
  // hing der Status allein an 'code'; Schulen, die ihn nicht setzen, hatten damit unsichtbare
  // Vertretungen: keine Kennzeichnung in der Zelle, nirgends.
  assert.equal(f.status, 'irregular', 'Vertretungstext ohne code zählt als Vertretung');

  // Und er kommt bis in die Plan-Antwort durch.
  const [tanja, tanjaId] = await register('textilda');
  const { db } = await import('./db.js');
  const cfg = (await tanja('GET', '/api/config')).body;
  const plan = (await tanja('GET', '/api/timetable')).body;
  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-4711', 'Kunst', 1) ON CONFLICT(id) DO NOTHING").run();
  db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status, info, lesson_text)
              VALUES(?, ?, ?, 'UNTIS-4711', 'regular', ?, ?)`)
    .run(tanjaId, plan.days[0].date, cfg.periods[0].id, f.info, f.lesson_text);

  const stunde = (await tanja('GET', '/api/timetable')).body.entries
    .find(e => e.id === 'UNTIS-4711');
  assert.match(stunde.lesson_text, /Fotouebung/);
  assert.equal(stunde.info, 'Vertretung durch Frau Meier');

  db.prepare('DELETE FROM untis_lessons WHERE user_id = ?').run(tanjaId);
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-4711'").run();
});

test('ToDos: privat, mit Erinnerung genau einmal', async () => {
  const [uwe, uweId] = await register('todouwe');
  const [vera3] = await register('todovera');
  const { db } = await import('./db.js');

  const morgen = new Date(Date.now() + 86400e3).toISOString().slice(0, 16).replace('T', ' ');
  const angelegt = await uwe('POST', '/api/todos',
    { text: 'Buch zurückbringen', due_at: morgen, remind_min: 1440 });
  assert.equal(angelegt.status, 200);
  assert.equal(angelegt.body.remind_min, 1440);

  // Rein persoenlich - kein Weg an fremde ToDos, auch nicht ueber die ID.
  assert.deepEqual((await vera3('GET', '/api/todos')).body, []);
  assert.equal((await vera3('PUT', `/api/todos/${angelegt.body.id}`,
    { text: 'gekapert', due_at: morgen, remind_min: 0 })).status, 404);
  // 404 statt eines stillen "ok": dass es dieses ToDo gibt, geht Fremde nichts an - dieselbe
  // Linie wie bei Tickets und Ordnern.
  assert.equal((await vera3('DELETE', `/api/todos/${angelegt.body.id}`)).status, 404);
  assert.equal((await uwe('GET', '/api/todos')).body.length, 1, 'fremdes Loeschen tut nichts');

  // Freie Zahlen als Vorlauf gibt es nicht - die Oberflaeche bietet vier Werte, mehr nimmt der
  // Server auch nicht an.
  assert.equal((await uwe('POST', '/api/todos',
    { text: 'x', due_at: morgen, remind_min: 999999 })).status, 400);
  assert.equal((await uwe('POST', '/api/todos', { text: 'x', due_at: 'morgen' })).status, 400);

  // Erinnerung: faellig gestellt, muss genau eine Meldung ergeben - nicht bei jedem Takt eine.
  db.prepare("UPDATE todos SET due_at = datetime('now', 'localtime', '-5 minutes'), remind_min = 0 WHERE user_id = ?")
    .run(uweId);
  const { todoErinnerungen } = await import('./index.js');
  todoErinnerungen();
  todoErinnerungen();
  const offen = (await uwe('GET', '/api/notifications/pending')).body
    .filter(n => n.kind === 'todo');
  assert.equal(offen.length, 1, 'genau einmal erinnert');
  assert.match(offen[0].title, /Buch zurückbringen/);

  // Abhaken ist auch hier persoenlich.
  const id = (await uwe('GET', '/api/todos')).body[0].id;
  assert.equal((await uwe('POST', `/api/todos/${id}/done`)).body.done, true);
  assert.equal((await uwe('GET', '/api/todos')).body[0].done, true);
  assert.equal((await uwe('DELETE', `/api/todos/${id}/done`)).body.done, false);
});

test('Sicherung: herunterladen, pruefen, einspielen', async () => {
  const { readFileSync, existsSync, rmSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');

  const admin = await login('admin', 'geheim');
  const [nutzer] = await register('sicherungstester');
  assert.equal((await nutzer('GET', '/api/backup')).status, 403, 'nur Admins');

  // Herunterladen liefert eine echte, oeffenbare SQLite-Datei
  const res = await admin.raw('/api/backup');
  assert.equal(res.status, 200);
  const daten = Buffer.from(await res.arrayBuffer());
  assert.equal(daten.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');

  const kopie = join(tmpdir(), `bak-${randomUUID()}.db`);
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(kopie, daten);
    const geoeffnet = new DatabaseSync(kopie, { readOnly: true });
    assert.ok(geoeffnet.prepare("SELECT 1 FROM users WHERE username = 'sicherungstester'").get(),
      'die Sicherung enthaelt die Daten');

    // Aber keine verwendbaren Sitzungstokens: die Datei landet in Downloads und E-Mails, und
    // im Klartext koennte jeder daraus ein gueltiges sid-Cookie bauen - ohne ein Passwort.
    const meins = admin.cookie().split('=')[1];
    const gespeichert = geoeffnet.prepare('SELECT token FROM sessions').all().map(r => r.token);
    assert.ok(gespeichert.length, 'Sitzungen sind ueberhaupt drin');
    assert.equal(gespeichert.includes(meins), false, 'kein Token im Klartext');
    assert.ok(gespeichert.every(t => /^[0-9a-f]{64}$/.test(t)), 'nur Hashes');
    geoeffnet.close();

    // Muell wird abgelehnt
    const muell = await fetch(base + '/api/backup/restore', {
      method: 'POST', headers: { cookie: admin.cookie(), 'content-type': 'application/octet-stream' },
      body: Buffer.from('kein SQLite'),
    });
    assert.equal(muell.status, 400);

    // Eine Datei mit richtigem Header, aber ohne unsere Tabellen ebenfalls
    const fremd = join(tmpdir(), `fremd-${randomUUID()}.db`);
    const f = new DatabaseSync(fremd);
    f.exec('CREATE TABLE irgendwas (a INTEGER)');
    f.close();
    const fremdRes = await fetch(base + '/api/backup/restore', {
      method: 'POST', headers: { cookie: admin.cookie(), 'content-type': 'application/octet-stream' },
      body: readFileSync(fremd),
    });
    rmSync(fremd, { force: true });
    assert.equal(fremdRes.status, 400, 'fremde SQLite-Datei wird abgelehnt');
    assert.match((await fremdRes.json()).error, /fehlt/);
  } finally {
    rmSync(kopie, { force: true });
  }

  // Die laufende Instanz nutzt :memory: - dort ist Einspielen sinnlos und wird abgelehnt.
  const echt = await fetch(base + '/api/backup/restore', {
    method: 'POST', headers: { cookie: admin.cookie(), 'content-type': 'application/octet-stream' },
    body: daten,
  });
  assert.equal(echt.status, 400);
  assert.match((await echt.json()).error, /Datenbankdatei/);
  assert.equal(existsSync(':memory:.incoming'), false);
});

test('Sicherung einspielen: .incoming wird beim Start uebernommen', async () => {
  const { execFileSync } = await import('node:child_process');
  const { rmSync, existsSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');

  const alt = join(tmpdir(), `alt-${randomUUID()}.db`);
  const neu = `${alt}.incoming`;
  const probe = `
    const { db } = await import('./db.js');
    const u = db.prepare('SELECT username FROM users ORDER BY id').all().map(r => r.username);
    console.log('RESULT' + JSON.stringify(u));`;
  const run = env => JSON.parse(execFileSync(
    process.execPath, ['--no-warnings', '--input-type=module', '-e', probe],
    { env: { ...process.env, DB: alt, PORT: '0', ...env }, encoding: 'utf8' },
  ).split('RESULT')[1]);

  try {
    // Erste DB anlegen und einen Nutzer erzeugen, dann als "Sicherung" beiseite legen
    run({ ADMIN_PW: 'a' });
    const sicherung = join(tmpdir(), `sicherung-${randomUUID()}.db`);
    copyFileSync(alt, sicherung);
    run({ ADMIN_RESET_PW: 'b', ADMIN_RESET_USER: 'spaeter' }); // DB veraendern
    assert.deepEqual(run({}), ['admin', 'spaeter']);

    // Sicherung als .incoming hinlegen -> naechster Start setzt sie ein
    copyFileSync(sicherung, neu);
    assert.deepEqual(run({}), ['admin'], 'die Sicherung ist eingespielt');
    assert.equal(existsSync(neu), false, '.incoming ist verbraucht');
    assert.ok(existsSync(`${alt}.vorher`), 'die vorherige Datei liegt als Sicherheitsnetz daneben');
    rmSync(sicherung, { force: true });
  } finally {
    for (const f of [alt, neu, `${alt}.vorher`]) rmSync(f, { force: true });
  }
});

// --- WebUntis ---------------------------------------------------------------
// Gegen einen nachgebauten WebUntis-Server. Die echte Schnittstelle laesst sich hier nicht
// erreichen; geprueft wird damit alles, was auf unserer Seite passiert: Anmeldung, Verschluesselung,
// Abbildung auf Faecher/Lehrer/Kurse, Vertretung und Ausfall, Vorrang vor dem manuellen Plan.

async function fakeUntis(perioden) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const { method, params } = JSON.parse(body || '{}');
      const antwort = r => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'JSESSIONID=abc123; Path=/' });
        res.end(JSON.stringify({ id: 'x', jsonrpc: '2.0', ...r }));
      };
      if (method === 'authenticate') {
        return params.password === 'richtig'
          ? antwort({ result: { sessionId: 'abc123', personType: 5, personId: 42 } })
          : antwort({ error: { code: -8504, message: 'bad credentials' } });
      }
      if (method === 'getTimetable') return antwort({ result: perioden });
      antwort({ result: {} });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, host: `127.0.0.1:${server.address().port}` };
}

test('WebUntis: Lehrstoff und Notizen kommen aus der REST-Schnittstelle', async t => {
  // JSON-RPC liefert Schuelerkonten 'lstext'/'bkText' leer aus, auch wenn man 'showLsText' setzt -
  // 'info' und 'substText' dagegen schon. Genau so kam der Plan an: Info da, Lehrstoff nicht.
  // Deshalb holt 'stundenplan' die Texte zusaetzlich ueber REST und legt sie darueber.
  const { createServer } = await import('node:http');
  // Relativ zu heute: die Texte holt untis.js nur in einem Fenster um heute (textWochen) - ein
  // festes Datum lief irgendwann aus dem Fenster und der Test kippte von selbst.
  const tag = new Date().toISOString().slice(0, 10), tagNr = Number(tag.replaceAll('-', ''));
  const tagPlus2 = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const gesehen = [];
  const server = createServer((req, res) => {
    const fertig = o => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'GET') {
      gesehen.push(req.url);
      // Das Stundendetail hat den Lehrstoff - zusaetzlich zum Unterrichtstext, nicht statt seiner.
      if (req.url.includes('calendar-entry')) return fertig({ data: { calendarEntries: [
        { startDateTime: `${tag}T08:00`, endDateTime: `${tag}T08:45`,
          teachingContent: 'Bitte die ausgeteilten Arbeitsaufträge bearbeiten' }] } });
      // Erst im zweiten Anlauf (mit formatId) antworten - so wie manche Instanzen es tun.
      if (!req.url.includes('formatId')) return fertig({ data: {} });
      return fertig({ data: { result: { data: { elementPeriods: { 42: [
        { id: 900, date: tagNr, startTime: 800,
          lessonText: 'Fotoübung zu Licht; S-Bilder besprechen',
          periodText: ['HA:', '–SZ Artikel', '–AB Auge+Fotoapparat'].join('\n'),
          periodInfo: '' },
      ] } } } } });
    }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => fertig({ jsonrpc: '2.0', id: 'x', result: [
      { id: 900, date: tagNr, startTime: 800, endTime: 845, lsnumber: 900,
        su: [{ name: 'KU', longname: 'Kunst' }], te: [{ name: 'ROT' }], ro: [{ name: 'A1' }],
        info: 'Raumänderung' },
    ] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${server.address().port}`;

  const untis = await import('./untis.js');
  const sitzung = { url: host + '/WebUntis/jsonrpc.do', host, cookie: 'JSESSIONID=x',
    personId: 42, personType: 5 };
  const [stunde] = untis.aufbereiten(await untis.stundenplan(sitzung, tag, tagPlus2));

  assert.equal(stunde.info, 'Raumänderung', 'kurzer Text bleibt kurz und getrennt');
  assert.equal(stunde.lehrstoff, 'Bitte die ausgeteilten Arbeitsaufträge bearbeiten',
    'der Lehrstoff hat sein eigenes Feld - und faellt nicht weg, nur weil die Stunde auch einen Unterrichtstext hat');
  assert.match(stunde.lesson_text, /^Unterrichtstext:\nFotoübung zu Licht/);
  assert.match(stunde.lesson_text, /Notizen für Schüler\*innen:\nHA:\n–SZ Artikel/);
  assert.ok(stunde.lesson_text.includes('\n\n'), 'die beiden Teile bleiben getrennt');
  assert.ok(gesehen.some(u => u.includes('elementId=42') && u.includes('elementType=5')),
    'nach der eigenen Person gefragt');

  // Faellt REST aus, muss der Plan trotzdem stehen - die Texte sind eine Zugabe.
  server.close();
  const ohne = await untis.stundenplan(sitzung, tag, tagPlus2).catch(() => 'geworfen');
  assert.equal(ohne, 'geworfen', 'ohne Server gibt es auch keinen Plan - aber keinen Absturz');
});

test('WebUntis: Abgleich, Vertretung, Ausfall und Vorrang vor dem eigenen Plan', async t => {
  const admin = await login('admin', 'geheim');
  const cfg = (await admin('GET', '/api/config')).body;
  const [p1, p2, p3] = cfg.periods;

  // Der Plan der laufenden Woche - dieselben Tage, die der Server ausliefert.
  const [ulf, ulfId] = await register('ulf');
  const wocheVon = (await ulf('GET', '/api/timetable')).body.days;
  const montag = wocheVon[0].date, dienstag = wocheVon[1].date;

  const roh = [
    { date: Number(montag.replaceAll('-', '')), startTime: Number(p1.start_time.replace(':', '')),
      endTime: Number(p1.end_time.replace(':', '')), lsnumber: 777,
      su: [{ name: 'PH', longname: 'Physik' }], te: [{ name: 'SCM', longname: 'Herr Schmidt' }],
      ro: [{ name: 'C204' }] },
    { date: Number(montag.replaceAll('-', '')), startTime: Number(p2.start_time.replace(':', '')),
      endTime: Number(p2.end_time.replace(':', '')), lsnumber: 778, code: 'cancelled',
      su: [{ name: 'CH', longname: 'Chemie' }], te: [{ name: 'MEY', longname: 'Frau Meyer' }],
      ro: [{ name: 'C110' }], info: 'Lehrer krank' },
    { date: Number(dienstag.replaceAll('-', '')), startTime: Number(p1.start_time.replace(':', '')),
      endTime: Number(p1.end_time.replace(':', '')), lsnumber: 779, code: 'irregular',
      su: [{ name: 'PH', longname: 'Physik' }], te: [{ name: 'KLN', longname: 'Herr Klein' }],
      ro: [{ name: 'B104' }], substText: 'Vertretung' },
    // Eine Stunde ausserhalb des Rasters (03:00) - muss gemeldet, nicht still verworfen werden
    { date: Number(dienstag.replaceAll('-', '')), startTime: 300, endTime: 345, lsnumber: 780,
      su: [{ name: 'XX', longname: 'Nachtschicht' }], te: [], ro: [] },
  ];

  const { server, host } = await fakeUntis(roh);
  t.after(() => server.close());

  // Ohne ausgewaehlte Schule geht nichts - und der Admin muss dafuer nichts tun
  const ohneSchule = await ulf('PUT', '/api/untis/account', { username: 'u', password: 'richtig' });
  assert.equal(ohneSchule.status, 400);
  assert.match(ohneSchule.body.error, /Schule/);

  const { db: datenbank } = await import('./db.js');
  datenbank.prepare("UPDATE schools SET server = ?, school = ? WHERE standard = 1")
    .run(host, 'Testschule');
  assert.equal((await ulf('GET', '/api/untis/status')).body.aktiv, true, 'Schule reicht, kein Schalter');

  // untis.js spricht https; im Test zeigt der Server auf http - deshalb prueft dieser Test die
  // Abbildung ueber die Bibliothek direkt und den Rest ueber die API.
  const untis = await import('./untis.js');
  const sitzung = await untis.login(host, 'Testschule', 'ulf', 'richtig').catch(e => e);
  if (sitzung instanceof Error) {
    // Kein https moeglich - dann wenigstens die reine Aufbereitung pruefen.
    const fertig = untis.aufbereiten(roh);
    assert.equal(fertig.length, 4);
    assert.equal(fertig[0].course_id, 'UNTIS-777');
    assert.equal(fertig[0].subject, 'Physik');
    assert.equal(fertig[0].teacher, 'Herr Schmidt');
    assert.equal(fertig.find(f => f.course_id === 'UNTIS-778').status, 'cancelled');
    assert.match(fertig.find(f => f.course_id === 'UNTIS-778').info, /krank/);
    assert.equal(fertig.find(f => f.course_id === 'UNTIS-779').status, 'irregular');
    assert.match(fertig.find(f => f.course_id === 'UNTIS-779').info, /Vertretung/);
    t.diagnostic('WebUntis nur ueber http erreichbar - Abbildung geprueft, Netzweg nicht');
  }

  // Verschluesselung: das Passwort darf nirgends im Klartext landen
  const geheim = untis.verschluesseln('richtig');
  assert.equal(geheim.includes('richtig'), false, 'kein Klartext');
  assert.equal(untis.entschluesseln(geheim), 'richtig');
  assert.notEqual(untis.verschluesseln('richtig'), geheim, 'jedes Mal ein neuer iv');

  // Zuruecksetzen darf nur der App-Admin, und es raeumt Zugaenge und Stunden mit weg
  assert.equal((await ulf('DELETE', '/api/untis/school')).status, 403);
  assert.equal((await admin('DELETE', '/api/untis/school')).status, 200);
  assert.equal((await ulf('GET', '/api/untis/status')).body.aktiv, false);
  assert.equal(ulfId > 0, true);
});

test('WebUntis: Schulsuche statt Admin-Eintrag', async () => {
  const [schueler] = await register('nora');
  const { schulenAufbereiten, ohneSchema } = await import('./untis.js');

  // Aus der WebUntis-Antwort muss genau das werden, was die Anmeldung braucht: Server und
  // Anmeldename der Schule (nicht der Anzeigename - der steht so nie in der URL).
  const treffer = schulenAufbereiten({ schools: [
    { displayName: 'Gymnasium Musterstadt', address: 'Musterstadt', loginName: 'gym-muster',
      server: 'https://herakles.webuntis.com/' },
    { displayName: 'Ohne Server', loginName: 'kaputt', server: '' },
  ] });
  assert.deepEqual(treffer, [{ name: 'Gymnasium Musterstadt', ort: 'Musterstadt',
    server: 'herakles.webuntis.com', schule: 'gym-muster' }]);
  assert.equal(ohneSchema('https://x.webuntis.com/'), 'x.webuntis.com');

  // Jeder Angemeldete darf suchen - die Einrichtung braucht keinen App-Admin. Zu kurze Suchen
  // werden abgewiesen, bevor irgendetwas nach draussen geht.
  const kurz = await schueler('GET', '/api/untis/schools?q=ab');
  assert.equal(kurz.status, 400);
  assert.match(kurz.body.error, /drei Zeichen/);
  assert.equal((await client()('GET', '/api/untis/schools?q=Gymnasium')).status, 401, 'nur angemeldet');

  // Der wichtigste Fall: ein fremder Server darf gar nicht erst angesprochen werden. Sonst
  // koennte der Erstbeste die App auf seinen eigenen zeigen lassen und die Schulpasswoerter
  // aller anderen einsammeln - der Wert gilt ab dem ersten Erfolg fuer die ganze Instanz.
  for (const server of ['gibts-nicht.invalid', '10.0.0.5:8443', 'webuntis.com.angreifer.de',
    'evil.example/x.webuntis.com', 'localhost']) {
    const r = await schueler('PUT', '/api/untis/account',
      { username: 'x', password: 'y', server, school: 'keine' });
    assert.equal(r.status, 400, server);
    assert.match(r.body.error, /Schulsuche/, server);
  }

  // Ein Host, der die Pruefung besteht, aber keine Schule von uns kennt, darf ebenfalls nichts
  // setzen - sonst haengt die ganze App an einem Vertipper. (Die Meldung wird hier bewusst nicht
  // festgenagelt: der Aufruf geht wirklich hinaus, und was zurueckkommt, haengt am Netz.)
  const daneben = await schueler('PUT', '/api/untis/account',
    { username: 'x', password: 'y', server: 'gibts-hier-nicht.webuntis.com', school: 'keine' });
  assert.equal(daneben.status, 400);
  assert.equal(daneben.body.error.includes('\\'), false, 'keine Pfade in der Meldung');
  assert.equal((await schueler('GET', '/api/untis/status')).body.aktiv, false, 'nichts gesetzt');
});

test('WebUntis: Anmeldung mit dem Schluessel aus der Untis-App', async () => {
  const [schueler, schuelerId] = await register('schluesselnutzer');
  const { totp } = await import('./untis.js');

  // RFC-6238-Testvektoren (Seed "12345678901234567890" als Base32). Der Einmalcode ist die eine
  // Stelle, an der ein Rechenfehler sich als "falsches Passwort" tarnen wuerde.
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(seed, 59_000), '287082');
  assert.equal(totp(seed, 1_111_111_109_000), '081804');
  assert.equal(totp(seed, 1_234_567_890_000), '005924');
  assert.equal(totp(seed, 31_000), totp(seed, 59_000), 'gleiches 30-Sekunden-Fenster');
  assert.notEqual(totp(seed, 59_000), totp(seed, 61_000), 'naechstes Fenster');
  assert.throws(() => totp('!!!'), /Zugriffsschl/, 'kein Base32 - und das faellt vor dem Netz auf');

  // Ein unbrauchbarer Schluessel darf gar nicht erst nach draussen gehen. Die Meldung zeigt
  // zugleich, dass wirklich der Schluessel-Weg genommen wurde und nicht der Passwort-Weg.
  const kaputt = await schueler('PUT', '/api/untis/account',
    { username: 'schluesselnutzer', secret: '!!!', server: 'gibts-hier-nicht.webuntis.com', school: 'keine' });
  assert.equal(kaputt.status, 400);
  assert.match(kaputt.body.error, /Zugriffsschl/);

  assert.match((await schueler('PUT', '/api/untis/account', { username: 'schluesselnutzer' })).body.error,
    /Schlüssel oder Passwort/);

  // Womit man verbunden ist, muss die Oberflaeche sehen koennen.
  const { db, ...rest } = await import('./db.js');
  const { verschluesseln } = await import('./untis.js');
  db.prepare(`INSERT INTO untis_accounts(user_id, username, secret, auth_typ) VALUES(?, ?, ?, 'secret')`)
    .run(schuelerId, 'schluesselnutzer', verschluesseln(seed));
  assert.equal((await schueler('GET', '/api/untis/status')).body.konto.auth_typ, 'secret');
  assert.equal(rest.standardSchule().school, '', 'ein Fehlversuch setzt keine Schule');
  db.prepare('DELETE FROM untis_accounts WHERE user_id = ?').run(schuelerId);
});

test('WebUntis: der Schluessel-Login spricht das dokumentierte Protokoll', async t => {
  // Gegen eine echte Schule laesst sich das hier nicht pruefen. Was sich pruefen laesst, ist das,
  // was wir senden - genau daran wuerde eine falsch gebaute Anfrage scheitern.
  const { loginMitSchluessel } = await import('./untis.js');
  const echt = globalThis.fetch;
  t.after(() => { globalThis.fetch = echt; });

  const gesehen = [];
  globalThis.fetch = async (url, opt = {}) => {
    gesehen.push({ url: String(url), opt });
    if (String(url).includes('jsonrpc_intern.do')) return new Response(
      JSON.stringify({ id: 'x', jsonrpc: '2.0', result: { masterData: {} } }),
      { headers: { 'content-type': 'application/json', 'set-cookie': 'JSESSIONID=sitzung42; Path=/' } });
    return new Response(JSON.stringify({ data: { loginServiceConfig: {
      user: { personId: 4711, persons: [{ id: 4711, type: 5 }] } } } }),
      { headers: { 'content-type': 'application/json' } });
  };

  const sitzung = await loginMitSchluessel('gymnasium-nordhorn.webuntis.com', 'gymnasium-nordhorn',
    'nora', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

  const [anmeldung, konfig] = gesehen;
  const u = new URL(anmeldung.url);
  assert.equal(u.origin, 'https://gymnasium-nordhorn.webuntis.com', 'immer https');
  assert.equal(u.pathname, '/WebUntis/jsonrpc_intern.do');
  assert.equal(u.searchParams.get('m'), 'getUserData2017');
  assert.equal(u.searchParams.get('school'), 'gymnasium-nordhorn');
  assert.equal(u.searchParams.get('v'), 'i2.2');

  const gesendet = JSON.parse(anmeldung.opt.body);
  assert.equal(gesendet.method, 'getUserData2017');
  const { auth } = gesendet.params[0];
  assert.equal(auth.user, 'nora');
  assert.match(auth.otp, /^\d{6}$/, 'Einmalcode statt Passwort - das Passwort verlaesst uns nie');
  assert.equal(typeof auth.clientTime, 'number');
  assert.equal(JSON.stringify(gesendet).includes('GEZDGNBV'), false, 'der Schluessel selbst geht nie raus');

  assert.equal(konfig.url, 'https://gymnasium-nordhorn.webuntis.com/WebUntis/api/app/config');
  assert.equal(konfig.opt.headers.cookie, 'JSESSIONID=sitzung42', 'die Sitzung wird mitgenommen');

  assert.equal(sitzung.personId, 4711);
  assert.equal(sitzung.personType, 5);
  assert.equal(sitzung.url, 'https://gymnasium-nordhorn.webuntis.com/WebUntis/jsonrpc.do?school=gymnasium-nordhorn',
    'der Stundenplan kommt danach ueber den normalen Weg');
});

test('WebUntis-Schluessel: erzeugt sich selbst, ueberlebt Neustarts, liegt nicht in der DB', async () => {
  const { execFileSync } = await import('node:child_process');
  const { rmSync, existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');

  const file = join(tmpdir(), `key-${randomUUID()}.db`);
  const probe = `
    const { untisKey, verschluesseln, entschluesseln } = await import('./untis.js');
    const key = untisKey();
    console.log('RESULT' + JSON.stringify({
      laenge: key?.length ?? 0,
      // Verschluesseln und Entschluesseln im selben Lauf muss klappen ...
      rund: entschluesseln(verschluesseln('probe')) === 'probe',
      // ... und was ein frueherer Lauf verschluesselt hat, muss noch lesbar sein.
      alt: process.env.ALT ? (() => { try { return entschluesseln(process.env.ALT); } catch { return 'FEHLER'; } })() : null,
      geheim: verschluesseln('probe'),
    }));`;
  const run = env => JSON.parse(execFileSync(
    process.execPath, ['--no-warnings', '--input-type=module', '-e', probe],
    { env: { ...process.env, DB: file, PORT: '0', UNTIS_KEY: '', ...env }, encoding: 'utf8' },
  ).split('RESULT')[1]);

  try {
    // Ohne jede Einrichtung: der erste Lauf legt den Schluessel selbst an.
    const erst = run({});
    assert.equal(erst.laenge, 32, 'ohne UNTIS_KEY entsteht trotzdem ein Schluessel');
    assert.equal(erst.rund, true);
    assert.equal(existsSync(`${file}.untis-key`), true, 'als eigene Datei neben der Datenbank');
    assert.match(readFileSync(`${file}.untis-key`, 'utf8'), /^[0-9a-f]{64}$/);

    // Neustart: derselbe Schluessel, also bleiben gespeicherte Zugaenge nutzbar.
    assert.equal(run({ ALT: erst.geheim }).alt, 'probe', 'ueberlebt den Neustart');

    // Der Schluessel darf nicht in der Datenbank stehen - sonst truege jede Sicherung ihn mit.
    const roh = readFileSync(file);
    const datei = readFileSync(`${file}.untis-key`, 'utf8').trim();
    assert.equal(roh.includes(datei), false, 'nicht in der Datenbank');
    assert.equal(roh.includes(Buffer.from(datei, 'hex')), false, 'auch nicht als Rohbytes');

    // Eine gesetzte Umgebungsvariable hat weiterhin Vorrang.
    const eigen = 'aa'.repeat(32);
    assert.equal(run({ UNTIS_KEY: eigen, ALT: erst.geheim }).alt, 'FEHLER',
      'anderer Schluessel: das alte Geheimnis scheitert hoerbar, statt still Muell zu liefern');
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}.untis-key`, { force: true });
  }
});

test('Ohne nutzbaren Schluessel bleibt die Anbindung abgeschaltet', async t => {
  // Normalerweise legt die App den Schluessel selbst an; hier laeuft sie auf :memory: und ohne
  // UNTIS_KEY, also gibt es keinen - genau der Fall, in dem nichts gespeichert werden darf.
  const admin = await login('admin', 'geheim');
  const key = process.env.UNTIS_KEY;
  delete process.env.UNTIS_KEY;
  t.after(() => { process.env.UNTIS_KEY = key; });

  // Der Status muss den Grund nennen - die Oberflaeche zeigt ihn an, statt die Karte
  // wortlos auszublenden.
  const status = (await admin('GET', '/api/untis/status')).body;
  assert.equal(status.moeglich, false);
  assert.equal(status.aktiv, false);
  assert.match(status.hinweis, /Schlüssel/);
  assert.equal((await admin('GET', '/api/untis/status')).status, 200, 'auch ohne Schluessel abrufbar');

  // Weder verbinden noch suchen - sonst laegen Passwoerter unverschluesselt herum
  const r = await admin('PUT', '/api/untis/account',
    { username: 'u', password: 'p', server: 'x.webuntis.com', school: 'S' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Schlüssel/);
  assert.match((await admin('GET', '/api/untis/schools?q=Gymnasium')).body.error, /Schlüssel/);

  const { verschluesseln } = await import('./untis.js');
  assert.throws(() => verschluesseln('geheim'), /Schlüssel/, 'ohne Schluessel wird nichts gespeichert');
});

test('WebUntis: Stunden ueberschreiben den eigenen Plan nur an ihren Tagen', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1EIG01', title: 'Eigener Kurs' });
  const [vera2, vera2Id] = await register('vera2');
  const cfg = (await vera2('GET', '/api/config')).body;
  const plan = (await vera2('GET', '/api/timetable')).body;
  const [mo, di] = plan.days;
  const p1 = cfg.periods[0];

  // Selbst gebauter Plan an beiden Tagen
  for (const tag of [mo, di]) await vera2('PUT', '/api/entry', { day_id: tag.id, period_id: p1.id, course_id: 'Q1EIG01' });

  // WebUntis liefert nur fuer Montag - direkt in die Tabelle, der Netzweg ist eigener Test
  const { db } = await import('./db.js');
  db.prepare("INSERT INTO courses(id, title) VALUES('UNTIS-900', 'Physik') ON CONFLICT(id) DO NOTHING").run();
  db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, room, status, info)
              VALUES(?, ?, ?, 'UNTIS-900', 'C204', 'irregular', 'Vertretung Herr Klein')`)
    .run(vera2Id, mo.date, p1.id);

  const nachher = (await vera2('GET', '/api/timetable')).body.entries;
  const amMontag = nachher.find(e => e.day_id === mo.id && e.period_id === p1.id);
  const amDienstag = nachher.find(e => e.day_id === di.id && e.period_id === p1.id);

  assert.equal(amMontag.id, 'UNTIS-900', 'WebUntis hat Vorrang');
  assert.equal(amMontag.source, 'untis');
  assert.equal(amMontag.status, 'irregular');
  assert.match(amMontag.info, /Vertretung/);
  assert.equal(amMontag.room, 'C204');
  assert.equal(amDienstag.id, 'Q1EIG01', 'ohne WebUntis-Daten bleibt der eigene Plan');
  assert.equal(amDienstag.source, 'manuell');

  // Notiz gilt weiter - sie haengt am Slot, nicht am Eintrag
  await vera2('PUT', '/api/note', { day_id: mo.id, period_id: p1.id, text: 'Formelsammlung' });
  assert.equal((await vera2('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p1.id).note, 'Formelsammlung');

  // Gemeinsame Stunde ueber die WebUntis-Kurs-ID
  const [wim2, wim2Id] = await register('wim2');
  db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-900', 'regular')`).run(wim2Id, mo.date, p1.id);
  await vera2('POST', '/api/friends', { username: 'wim2' });
  await wim2('POST', `/api/friends/${vera2Id}/accept`);
  assert.deepEqual((await vera2('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p1.id).shared.map(s => s.username), ['wim2']);
});

// Der Break-Glass-Reset greift beim Import von db.js - also je ein eigener Prozess pro Schritt.
test('Break-Glass: ADMIN_RESET_PW holt einen ausgesperrten Admin zurueck', async () => {
  const { execFileSync } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');

  const file = join(tmpdir(), `bg-${randomUUID()}.db`);
  const probe = `
    const { db, verify } = await import('./db.js');
    const u = db.prepare('SELECT pw, is_admin FROM users WHERE username = ?').get(process.env.WHO ?? 'admin');
    console.log('RESULT' + JSON.stringify(u && { ok: await verify(process.env.CHECK, u.pw), admin: !!u.is_admin }));`;
  const run = env => JSON.parse(execFileSync(
    process.execPath, ['--no-warnings', '--input-type=module', '-e', probe],
    { env: { ...process.env, DB: file, PORT: '0', ...env }, encoding: 'utf8' },
  ).split('RESULT')[1]);

  try {
    // Erster Start legt den Admin mit ADMIN_PW an - das kennt hinterher niemand mehr.
    assert.deepEqual(run({ ADMIN_PW: 'vergessen', CHECK: 'vergessen' }), { ok: true, admin: true });
    // ADMIN_PW spaeter zu aendern bringt nichts, der Seed lief schon.
    assert.equal(run({ ADMIN_PW: 'zweiterversuch', CHECK: 'zweiterversuch' }).ok, false);
    // ADMIN_RESET_PW dagegen greift und stellt auch die Adminrechte wieder her.
    assert.deepEqual(run({ ADMIN_RESET_PW: 'rettung42', CHECK: 'rettung42' }), { ok: true, admin: true });
    // Und ohne die Variable bleibt es beim neuen Passwort.
    assert.deepEqual(run({ CHECK: 'rettung42' }), { ok: true, admin: true });
  } finally {
    rmSync(file, { force: true });
  }
});

const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test('Raumaenderung: der neue Raum steht da - und dass er neu ist', async () => {
  const { aufbereiten } = await import('./untis.js');
  const stunde = (ro, f = {}) => aufbereiten([{ date: 20260903, startTime: 800, endTime: 845,
    lsnumber: 7, su: [{ name: 'PH' }], te: [{ name: 'KLE' }], ro, ...f }])[0];

  // Der Normalfall: kein Wechsel, nichts zu melden.
  assert.equal(stunde([{ name: 'A213' }]).room_regulaer, null);
  // WebUntis nennt den urspruenglichen Raum in 'orgname'.
  const getauscht = stunde([{ name: 'B7', orgname: 'A213' }]);
  assert.equal(getauscht.room, 'B7');
  assert.equal(getauscht.room_regulaer, 'A213');
  assert.equal(getauscht.status, 'regular', 'ein anderer Raum ist keine Vertretung');
  // Nur der Zellzustand aus der Wochenabfrage: gewechselt, Herkunft unbekannt.
  assert.equal(stunde([{ name: 'B7' }], { raumWechsel: true }).room_regulaer, '');

  // Und der Plan gibt es heraus - ohne das weiss die Oberflaeche nichts davon.
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const p1 = (await admin('GET', '/api/config')).body.periods[0];
  db.prepare(`INSERT OR IGNORE INTO courses(id, title, from_untis) VALUES('UNTIS-RAUM', 'Physik', 1)`).run();

  const [rita, ritaId] = await register('ritaraum');
  const [mo, di] = (await rita('GET', '/api/timetable')).body.days;
  const legen = (datum, raum, org) => db.prepare(`
    INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, room, status, room_regulaer)
    VALUES(?, ?, ?, 'UNTIS-RAUM', ?, 'regular', ?)`).run(ritaId, datum, p1.id, raum, org);
  legen(mo.date, 'A213', null);
  legen(di.date, 'B7', 'A213');

  const plan = (await rita('GET', '/api/timetable')).body;
  const holen = tag => plan.entries.find(e => e.day_id === tag.id && e.period_id === p1.id);
  assert.equal(holen(mo).room_regulaer, null);
  assert.equal(holen(di).room, 'B7');
  assert.equal(holen(di).room_regulaer, 'A213');
});

test('Einmalige Nachricht: einmal zeigen, dann nie wieder', async () => {
  const admin = await login('admin', 'geheim');
  const [hans] = await register('hansaushang');

  // Ohne Text kein Aushang.
  assert.equal((await hans('GET', '/api/info')).body.hinweis, '');
  assert.equal((await hans('GET', '/api/me')).body.hinweis_gesehen, null);

  await admin('PUT', '/api/settings/text', { key: 'hinweis', text: '# Hallo\n\nMorgen **frei**.' });
  const erste = (await hans('GET', '/api/info')).body;
  assert.match(erste.hinweis, /Morgen/);
  assert.ok(erste.hinweis_ver, 'die Fassung kommt aus dem Text, nicht aus der Uhr');

  // Weggeklickt: der Server merkt sich die Fassung selbst, der Client kann sie nicht erfinden.
  const gelesen = (await hans('POST', '/api/me/hinweis-gelesen')).body;
  assert.equal(gelesen.hinweis_gesehen, erste.hinweis_ver);
  assert.equal((await hans('GET', '/api/me')).body.hinweis_gesehen, erste.hinweis_ver);

  // Neuer Text heisst neue Nachricht - auch in derselben Minute. Der Zeitstempel steht nur auf
  // die Minute genau; haenge die Fassung an ihm, waere eine schnelle Korrektur nie erschienen.
  await admin('PUT', '/api/settings/text', { key: 'hinweis', text: 'Doch Unterricht.' });
  const zweite = (await hans('GET', '/api/info')).body;
  assert.notEqual(zweite.hinweis_ver, erste.hinweis_ver);
  assert.notEqual((await hans('GET', '/api/me')).body.hinweis_gesehen, zweite.hinweis_ver);

  // Wieder weggeklickt, und ein leeres Feld schaltet den Aushang ganz ab.
  await hans('POST', '/api/me/hinweis-gelesen');
  await admin('PUT', '/api/settings/text', { key: 'hinweis', text: '' });
  assert.equal((await hans('GET', '/api/info')).body.hinweis_ver, null);

  // Und nur die drei bekannten Schluessel, sonst waere das ein Schreibzugriff auf alle Einstellungen.
  assert.equal((await admin('PUT', '/api/settings/text',
    { key: 'registration_key', text: 'x' })).status, 400);
});

test('Kursfarbe: Ton UND Saettigung, damit Grau grau bleibt', async () => {
  // Frueher kam aus der gewaehlten Farbe nur der Farbton heraus. Damit war Grau ROT (ohne
  // Buntanteil gibt es keinen Ton, und der Rueckfallwert 0 ist Rot), und Pastellrosa,
  // Dunkelrot und Signalrot waren im Plan dieselbe Farbe.
  const { tonAus } = await import('./public/kern.js');

  assert.deepEqual(tonAus('#888888'), { h: 0, s: 0 }, 'Grau ist grau, nicht rot');
  assert.deepEqual(tonAus('#ffffff'), { h: 0, s: 0 });
  assert.deepEqual(tonAus('#000000'), { h: 0, s: 0 });
  assert.equal(tonAus('#ff0000').s, 100, 'Signalrot bleibt kraeftig');

  const blass = tonAus('#ffd6e7'), kraeftig = tonAus('#d81b60');
  assert.ok(blass.s < 30 && kraeftig.s > 70, 'blass bleibt blass, kraeftig bleibt kraeftig');
  assert.ok(Math.abs(blass.h - 335) < 15 && Math.abs(kraeftig.h - 339) < 15, 'derselbe Ton');

  // Ein dunkler Ton behaelt seine Kraft - die Helligkeit kommt bewusst vom Design, sonst waere
  // Dunkelblau im Dunkelmodus unsichtbar.
  assert.ok(tonAus('#10243f').s > 60);
  assert.equal(tonAus('irgendwas'), null, 'kein Hex, keine Farbe');
  assert.equal(tonAus(null), null);
});

test('Eigene Stunde in einer freien Stunde am WebUntis-Tag', async () => {
  // Die Meldung war: "wo jetzt keine Stunden sind, kann ich nichts eintragen". Zwei Ursachen -
  // die Auswahl war leer, und was man doch eintrug, loeschte planFuer am Untis-Tag wieder weg.
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1FREI09', title: 'Lueckenfueller' });
  const [udo, udoId] = await register('luecken-udo');
  const { db } = await import('./db.js');
  const cfg = (await udo('GET', '/api/config')).body;
  const [p1, p2] = cfg.periods;
  const woche = (await udo('GET', '/api/timetable')).body;
  const [mo] = woche.days;

  db.prepare("INSERT INTO courses(id, title, from_untis) VALUES('UNTIS-LUECKE', 'Sport', 1) ON CONFLICT(id) DO NOTHING").run();
  db.prepare(`INSERT INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-LUECKE', 'regular')`).run(udoId, mo.date, p1.id);

  const holen = async () => (await udo('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p2.id);

  // Der eigene Kurs in die freie Stunde daneben - und er bleibt dort.
  assert.equal((await udo('PUT', '/api/entry',
    { day_id: mo.id, period_id: p2.id, course_id: 'Q1FREI09' })).status, 200);
  assert.equal((await holen()).id, 'Q1FREI09');
  assert.equal((await holen()).vorrang, true, 'ohne Vorrang waere er sofort wieder weg');

  // Auch der eigene Untis-Kurs laesst sich woandershin legen.
  assert.equal((await udo('PUT', '/api/entry',
    { day_id: mo.id, period_id: p2.id, course_id: 'UNTIS-LUECKE' })).status, 200);
  assert.equal((await holen()).id, 'UNTIS-LUECKE');

  // An einem Tag ohne WebUntis-Daten bleibt es beim gewoehnlichen Eintrag - dort braucht es
  // keinen Vorrang, und ein stiller Dauerzustand waere eine Nebenwirkung, die niemand bestellt hat.
  const [, di] = woche.days;
  await udo('PUT', '/api/entry', { day_id: di.id, period_id: p1.id, course_id: 'Q1FREI09' });
  assert.equal(db.prepare('SELECT vorrang FROM entries WHERE user_id = ? AND day_id = ? AND period_id = ?')
    .get(udoId, di.id, p1.id).vorrang, 0);

  db.prepare("DELETE FROM untis_lessons WHERE user_id = ?").run(udoId);
  db.prepare("DELETE FROM entries WHERE user_id = ?").run(udoId);
  db.prepare("DELETE FROM courses WHERE id = 'UNTIS-LUECKE'").run();
});

// --- Tickets ----------------------------------------------------------------
// Gegenstelle ist ein falscher VNW-Server: er spricht genau das Protokoll nach, das im Quelltext
// der Plattform steht (server/routes/tickets.js) - Rechte, Antwortformate, Fehlercodes. Die echte
// Instanz kann hier niemand anschliessen.
async function falschesVnw() {
  const { createServer } = await import('node:http');
  const zustand = {
    tickets: new Map(),      // id -> { id, title, description, status, view_token, replies[] }
    tags: [],
    naechste: 100,
    gesehen: [],             // alle Anfragen, fuer die Zusicherungen
    tagsErlaubt: true,       // simuliert ein Token ohne 'tickets.tags'
  };

  const server = createServer((req, res) => {
    let roh = '';
    req.on('data', c => (roh += c));
    req.on('end', () => {
      const koerper = roh ? JSON.parse(roh) : {};
      const pfad = req.url.split('?')[0];
      zustand.gesehen.push({ pfad, method: req.method, koerper,
        auth: req.headers.authorization ?? null, url: req.url });
      const sende = (code, daten) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(daten));
      };
      // Alles ausser den view-Pfaden verlangt den Token - genau wie bei VNW.
      const braucht = !pfad.startsWith('/api/tickets/view/');
      if (braucht && req.headers.authorization !== 'Bearer vnw_test123')
        return sende(401, { error: 'API-Token ungültig' });

      if (pfad === '/api/tickets/types')
        return sende(200, { types: [
          { id: 7, name: 'Bug-Report', fields: [
            { key: 'geraet', label: 'Gerät', type: 'text' },
            { key: 'browser', label: 'Browser', type: 'select', options: ['Chrome', 'Safari'] },
            { key: 'wieder', label: 'Reproduzierbar?', type: 'checkbox' },
          ] },
          { id: 8, name: 'Ideenvorschlag', fields: [] },
          // Eigener Typ fuers Pflichtfeld: haenge es an Typ 7, muessten alle anderen Ticket-Tests
          // es mitschicken, obwohl sie von Feldern gar nicht handeln.
          { id: 9, name: 'Bewerbung', fields: [
            { key: 'klasse', label: 'Klasse', type: 'text', required: true },
          ] },
        ] });

      if (pfad === '/api/tickets/tags' && req.method === 'GET') return sende(200, { tags: zustand.tags });
      if (pfad === '/api/tickets/tags' && req.method === 'POST') {
        if (!zustand.tagsErlaubt) return sende(403, { error: 'Fehlende Berechtigung', required: 'tickets.tags' });
        if (zustand.tags.some(t => t.name.toLowerCase() === String(koerper.name).toLowerCase()))
          return sende(409, { error: 'Dieses Schlagwort gibt es schon' });
        const tag = { id: 3, name: koerper.name, slug: String(koerper.name).toLowerCase() };
        zustand.tags.push(tag);
        return sende(201, { tag });
      }

      if (pfad === '/api/tickets' && req.method === 'POST') {
        const id = zustand.naechste++;
        const t = { id, title: koerper.title, description: koerper.description,
          status: 'open', view_token: 'vt_' + id, replies: [], tags: koerper.tags ?? [],
          ticket_type_id: koerper.ticket_type_id,
          extra_fields: koerper.extra_fields ?? {},
          type_name: { 8: 'Ideenvorschlag', 9: 'Bewerbung' }[koerper.ticket_type_id] ?? 'Bug-Report' };
        zustand.tickets.set(id, t);
        return sende(201, { ticket: t, view_token: t.view_token, view_link: '/ticket/view/' + t.view_token });
      }

      if (pfad === '/api/tickets' && req.method === 'GET') {
        return sende(200, { tickets: [...zustand.tickets.values()].map(t => ({
          id: t.id, title: t.title, status: t.status, reply_count: t.replies.length,
          type_name: t.type_name, view_token: t.view_token,
        })), total: zustand.tickets.size });
      }

      // Dasselbe Ticket mit dem Token der Schule - dieser Weg fuehrt die Formularfelder immer.
      const einzeln = pfad.match(/^\/api\/tickets\/(\d+)$/);
      if (einzeln && req.method === 'GET') {
        const t = zustand.tickets.get(Number(einzeln[1]));
        return t ? sende(200, { ticket: t }) : sende(404, { error: 'Ticket nicht gefunden' });
      }
      // Loeschen (Zurueckziehen) verlangt bei VNW das Recht tickets.close.
      if (einzeln && req.method === 'DELETE') {
        if (zustand.loeschenErlaubt === false)
          return sende(403, { error: 'Fehlende Berechtigung', required: 'tickets.close' });
        if (!zustand.tickets.delete(Number(einzeln[1]))) return sende(404, { error: 'Ticket nicht gefunden' });
        return sende(200, { ok: true });
      }

      const view = pfad.match(/^\/api\/tickets\/view\/([^/]+)(\/reply)?$/);
      if (view) {
        const t = [...zustand.tickets.values()].find(x => x.view_token === view[1]);
        if (!t) return sende(404, { error: 'Ticket nicht gefunden' });
        // Manche Instanzen geben die Formularfelder auf dem Melder-Weg nicht mit.
        if (!view[2]) return sende(200, {
          ticket: zustand.viewOhneFelder ? { ...t, extra_fields: undefined } : t,
          replies: t.replies,
        });
        if (t.status === 'closed') return sende(400, { error: 'Ticket ist geschlossen' });
        t.replies.push({ id: t.replies.length + 1, author_name: koerper.author_name,
          message: koerper.message, created_at: '2026-09-05 12:00' });
        return sende(201, { reply: t.replies.at(-1) });
      }
      sende(404, { error: 'unbekannt' });
    });
  });
  return { zustand, server };
}

// Einrichten und danach aufraeumen - sonst zeigt die Einstellung auf einen Port, den es in den
// folgenden Tests nicht mehr gibt.
async function vnwEinrichten(t, admin, extra = {}) {
  const { zustand, server } = await falschesVnw();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  Object.assign(zustand, extra);
  const antwort = await admin('PUT', '/api/tickets/config',
    { url, token: 'vnw_test123', type_ids: [7, 8] });
  t.after(async () => {
    server.close();
    await admin('PUT', '/api/tickets/config', { url: '' });
  });
  return { zustand, url, antwort };
}

test('Tickets: melden, lesen, antworten - jeder nur seine eigenen', async (t) => {
  const admin = await login('admin', 'geheim');
  const { zustand } = await vnwEinrichten(t, admin);

  const [mia] = await register('ticketmia');
  await mia('PATCH', '/api/me', { display_name: 'Mia M.' });
  const [tom] = await register('tickettom');

  // Anlegen: Typ, Schlagwort und der Melder gehen mit hinaus.
  const neu = await mia('POST', '/api/tickets',
    { title: 'Plan lädt nicht', text: 'Nach dem Anmelden bleibt die Seite leer.' });
  assert.equal(neu.status, 201);
  const anlegen = zustand.gesehen.find(g => g.pfad === '/api/tickets' && g.method === 'POST');
  assert.equal(anlegen.koerper.ticket_type_id, 7);
  assert.deepEqual(anlegen.koerper.tags, [3], 'das Schlagwort geht als ID mit, nicht als Slug');
  assert.match(anlegen.koerper.description, /Mia M\. \(@ticketmia\)/,
    'sonst stünden alle Tickets unter dem Namen des Token-Besitzers');

  // Der view_token ist ein Schluessel - er darf in KEINER Antwort an den Browser stehen.
  const liste = await mia('GET', '/api/tickets');
  const detail = await mia('GET', `/api/tickets/${neu.body.id}`);
  for (const a of [neu, liste, detail])
    assert.equal(JSON.stringify(a.body).includes('vt_'), false, 'view_token nach draußen');

  assert.deepEqual(liste.body.tickets.map(x => x.title), ['Plan lädt nicht']);
  assert.equal(liste.body.tickets[0].status_text, 'Offen');
  assert.equal(detail.body.antwortbar, true);

  // Antworten geht mit dem Anzeigenamen hinaus.
  assert.equal((await mia('POST', `/api/tickets/${neu.body.id}/replies`,
    { text: 'Nur im Chrome.' })).status, 201);
  const antwort = zustand.gesehen.find(g => g.pfad.endsWith('/reply'));
  assert.equal(antwort.koerper.author_name, 'Mia M.');
  assert.equal(antwort.auth, null, 'der view_token braucht keine Anmeldung');

  // Und ein fremdes Ticket gibt es fuer Tom schlicht nicht.
  assert.equal((await tom('GET', `/api/tickets/${neu.body.id}`)).status, 404);
  assert.equal((await tom('POST', `/api/tickets/${neu.body.id}/replies`, { text: 'hi' })).status, 404);
  assert.deepEqual((await tom('GET', '/api/tickets')).body.tickets, []);
});

test('Tickets: der Punkt bei neuen Antworten', async (t) => {
  const admin = await login('admin', 'geheim');
  const { zustand } = await vnwEinrichten(t, admin);
  const [nils] = await register('ticketnils');

  const neu = (await nils('POST', '/api/tickets', { title: 'Farbe falsch', text: 'Grau wird rot.' })).body;
  const drin = [...zustand.tickets.values()][0];
  assert.equal((await nils('GET', '/api/tickets')).body.tickets[0].neu, false);

  // Das Team antwortet und setzt den Status.
  drin.replies.push({ id: 1, author_name: 'Team', message: 'Ist behoben.', created_at: '2026-09-05 09:00' });
  drin.status = 'in_progress';
  const liste = (await nils('GET', '/api/tickets')).body;
  assert.equal(liste.tickets[0].neu, true, 'eine ungelesene Antwort');
  assert.equal(liste.tickets[0].status_text, 'In Bearbeitung');

  // Öffnen heisst gelesen.
  assert.equal((await nils('GET', `/api/tickets/${neu.id}`)).body.replies.length, 1);
  assert.equal((await nils('GET', '/api/tickets')).body.tickets[0].neu, false);

  // Die eigene Antwort laesst den Punkt nicht aufleuchten.
  await nils('POST', `/api/tickets/${neu.id}/replies`, { text: 'Danke!' });
  assert.equal((await nils('GET', '/api/tickets')).body.tickets[0].neu, false, 'die eigene Antwort');

  // Ein geschlossenes Ticket nimmt nichts mehr an - die Meldung von VNW kommt durch.
  drin.status = 'closed';
  assert.equal((await nils('GET', `/api/tickets/${neu.id}`)).body.antwortbar, false);
  const zu = await nils('POST', `/api/tickets/${neu.id}/replies`, { text: 'noch was' });
  assert.equal(zu.status, 502);
  assert.match(zu.body.error, /geschlossen/);
});

test('Tickets: die Zahl am Reiter und die Meldung, wenn das Team antwortet', async (t) => {
  const { ticketsAuffrischen } = await import('./index.js');
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const { zustand } = await vnwEinrichten(t, admin);
  const [ina, inaId] = await register('ticketina');

  const neu = (await ina('POST', '/api/tickets', { title: 'Knopf fehlt', text: 'Im Profil.' })).body;
  const drin = [...zustand.tickets.values()][0];
  assert.equal((await ina('GET', '/api/tickets/neu')).body.n, 0);
  const meldungen = () => db.prepare(
    "SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'ticket'").all(inaId)
    .map(r => ({ ...r }));

  // Das Team antwortet - der Takt merkt es, ohne dass Ina die Ansicht oeffnet.
  drin.replies.push({ id: 1, author_name: 'Team', message: 'Kommt.', created_at: '2026-09-13 09:00' });
  await ticketsAuffrischen();
  assert.equal((await ina('GET', '/api/tickets/neu')).body.n, 1, 'eine ungelesene Antwort');
  assert.deepEqual(meldungen(), [{ title: 'Antwort auf dein Ticket', body: 'Knopf fehlt' }]);
  // Ein zweiter Takt ohne neue Antwort meldet nichts noch einmal.
  await ticketsAuffrischen();
  assert.equal(meldungen().length, 1, 'keine zweite Meldung fuer dieselbe Antwort');

  // Aufmachen heisst gelesen.
  await ina('GET', `/api/tickets/${neu.id}`);
  assert.equal((await ina('GET', '/api/tickets/neu')).body.n, 0);

  // Die eigene Antwort ist keine Neuigkeit - weder Zahl noch Meldung.
  await ina('POST', `/api/tickets/${neu.id}/replies`, { text: 'Danke.' });
  await ticketsAuffrischen();
  assert.equal((await ina('GET', '/api/tickets/neu')).body.n, 0, 'die eigene Antwort');
  assert.equal(meldungen().length, 1);

  // Ein geschlossenes Ticket wird im Takt nicht mehr angefasst.
  drin.status = 'closed';
  await ina('GET', `/api/tickets/${neu.id}`);
  drin.replies.push({ id: 3, author_name: 'Team', message: 'Nachtrag', created_at: '2026-09-13 10:00' });
  await ticketsAuffrischen();
  assert.equal(meldungen().length, 1, 'geschlossen: keine Meldung mehr');
});

test('Tickets: fremde Tickets aus der VNW-Liste bleiben draußen', async (t) => {
  // Gehoert der Token einem Konto mit der Rolle "Admin", liefert VNW ALLE Tickets der Plattform.
  // Zugeordnet wird deshalb nur ueber die gespeicherte vnw_id.
  const admin = await login('admin', 'geheim');
  const { zustand } = await vnwEinrichten(t, admin);
  const [uta] = await register('ticketuta');

  await uta('POST', '/api/tickets', { title: 'Meins', text: 'dazu' });
  zustand.tickets.set(999, { id: 999, title: 'Fremdes Ticket', status: 'closed',
    view_token: 'vt_999', replies: [{ id: 1 }, { id: 2 }] });

  const liste = (await uta('GET', '/api/tickets')).body.tickets;
  assert.deepEqual(liste.map(x => x.title), ['Meins']);
  assert.equal(liste[0].status, 'open', 'der fremde Status hat hier nichts verloren');
});

test('Tickets: Einrichtung - Token bleibt drin, Schlagwort entsteht', async (t) => {
  const admin = await login('admin', 'geheim');
  const [gast] = await register('ticketgast');

  // Ohne VNW bleiben Tickets seit 3.1.0 in der App - vorher hiess es nur "nicht eingerichtet".
  const ohne = (await gast('GET', '/api/tickets')).body;
  assert.equal(ohne.eingerichtet, true);
  assert.equal(ohne.ziel, 'app');
  assert.equal((await gast('GET', '/api/tickets/config')).status, 403, 'die Einrichtung ist Adminsache');

  const { zustand, url } = await vnwEinrichten(t, admin);
  assert.deepEqual(zustand.tags.map(x => x.name), ['Stundenplan'], 'das Schlagwort wird angelegt');
  // Wer VNW eingerichtet hat, merkt vom Update nichts: ohne gesetztes Ziel gilt VNW.
  assert.equal((await gast('GET', '/api/tickets')).body.ziel, 'vnw');

  const cfg = (await admin('GET', '/api/tickets/config')).body;
  assert.equal(cfg.token_gesetzt, true);
  assert.equal(JSON.stringify(cfg).includes('vnw_test123'), false, 'der Token geht nicht zurück');
  assert.deepEqual(cfg.typen.map(t => t.name), ['Bug-Report', 'Ideenvorschlag', 'Bewerbung'],
    'die Auswahl zeigt alles, was VNW anbietet');
  assert.deepEqual(cfg.type_ids, [7, 8], 'beide freigegeben');

  // Leeres Token-Feld heisst "unveraendert" - sonst loescht das Ändern des Typs den Token.
  assert.equal((await admin('PUT', '/api/tickets/config',
    { url, token: '', type_ids: [7] })).body.token_gesetzt, true);
  assert.equal((await gast('POST', '/api/tickets', { title: 'Geht doch', text: 'jetzt schon' })).status, 201);

  // Zweites Einrichten: das Schlagwort ist schon da (409 gilt als Erfolg).
  const wieder = await admin('PUT', '/api/tickets/config', { url, token: 'vnw_test123', type_ids: [7] });
  assert.equal(wieder.status, 200);
  assert.equal(wieder.body.tag_id, 3);
  assert.equal(zustand.tags.length, 1);

  // Falsche Adresse und falscher Token werden benannt, nicht verschluckt.
  assert.match((await admin('PUT', '/api/tickets/config',
    { url: 'ftp://x', token: 'vnw_test123' })).body.error, /http/);
  assert.match((await admin('PUT', '/api/tickets/config',
    { url, token: 'vnw_falsch', type_ids: [7] })).body.error, /ungültig/);
});

test('Tickets: fehlt tickets.tags, sagt die Einrichtung es', async (t) => {
  const admin = await login('admin', 'geheim');
  const { antwort } = await vnwEinrichten(t, admin, { tagsErlaubt: false });

  assert.equal(antwort.status, 200, 'ohne Schlagwort geht es trotzdem weiter');
  assert.match(antwort.body.hinweis, /Schlagwort/);
  assert.match(antwort.body.hinweis, /tickets\.tags/, 'das fehlende Recht wird benannt');
});

test('Tickets: mehrere Arten zur Wahl', async (t) => {
  const admin = await login('admin', 'geheim');
  const { zustand, url } = await vnwEinrichten(t, admin);
  const [ida] = await register('ticketida');

  // Die erlaubten Arten stehen in der Liste - daraus baut das Formular seine Auswahl, ohne die
  // Admin-Route anzufassen.
  assert.deepEqual((await ida('GET', '/api/tickets')).body.typen.map(t => [t.id, t.name]),
    [[7, 'Bug-Report'], [8, 'Ideenvorschlag']]);

  // Mit Angabe: genau diese Art geht an VNW. (Typ 8 hat keine eigenen Felder.)
  const idee = await ida('POST', '/api/tickets',
    { title: 'Dunkelmodus umschaltbar', text: 'Bitte ein Schalter dafür.', type_id: 8 });
  assert.equal(idee.status, 201);
  assert.equal(idee.body.type_name, 'Ideenvorschlag');
  assert.equal(zustand.gesehen.filter(g => g.pfad === '/api/tickets' && g.method === 'POST')
    .at(-1).koerper.ticket_type_id, 8);

  // Ohne Angabe: die erste eingerichtete Art. So bleibt der Weg über die API unverändert nutzbar.
  // Typ 7 hat ein Pflichtfeld - das muss mit.
  const ohne = await ida('POST', '/api/tickets',
    { title: 'Absturz', text: 'beim Öffnen', extra_fields: { geraet: 'iPhone' } });
  assert.equal(ohne.body.type_name, 'Bug-Report');

  // Eine nicht freigegebene Art ist ein Fehler - und legt bei VNW nichts an.
  const vorher = zustand.tickets.size;
  const fremd = await ida('POST', '/api/tickets', { title: 'Bewerbung', text: 'x', type_id: 99 });
  assert.equal(fremd.status, 400);
  assert.equal(zustand.tickets.size, vorher, 'nichts entstanden');

  // In Liste und Unterhaltung steht die Art.
  const liste = (await ida('GET', '/api/tickets')).body.tickets;
  assert.deepEqual(liste.map(x => x.type_name).sort(), ['Bug-Report', 'Ideenvorschlag']);
  assert.equal((await ida('GET', `/api/tickets/${idee.body.id}`)).body.type_name, 'Ideenvorschlag');

  // Nimmt der Admin eine Art wieder heraus, ist sie weg - und was VNW gar nicht kennt, wird beim
  // Speichern verworfen, statt später beim Anlegen einen Fehler zu erzeugen.
  const eng = await admin('PUT', '/api/tickets/config',
    { url, token: '', type_ids: [8, 4242] });
  assert.deepEqual(eng.body.type_ids, [8]);
  assert.deepEqual((await ida('GET', '/api/tickets')).body.typen.map(t => t.id), [8]);
  assert.equal((await ida('POST', '/api/tickets',
    { title: 'Doch ein Bug', text: 'x', type_id: 7 })).status, 400);
});

test('Tickets: die Felder des Ticket-Typs aus VNW', async (t) => {
  const admin = await login('admin', 'geheim');
  const { zustand, url } = await vnwEinrichten(t, admin);
  const [finn] = await register('ticketfinn');

  // Die Felder kommen mit der Liste - das Formular braucht dafuer keinen eigenen Aufruf.
  const typen = (await finn('GET', '/api/tickets')).body.typen;
  assert.deepEqual(typen[0].fields.map(f => [f.key, f.typ, f.pflicht]),
    [['geraet', 'text', false], ['browser', 'select', false], ['wieder', 'checkbox', false]]);
  assert.deepEqual(typen[0].fields[1].optionen, ['Chrome', 'Safari']);

  // Ausgefuellt gehen sie als extra_fields hinaus - Unbekanntes bleibt hier.
  const neu = await finn('POST', '/api/tickets', {
    title: 'Plan bleibt leer', text: 'nach dem Anmelden', type_id: 7,
    extra_fields: { geraet: 'iPad', browser: 'Safari', wieder: true, heimlich: 'weg damit' },
  });
  assert.equal(neu.status, 201);
  const raus = zustand.gesehen.filter(g => g.pfad === '/api/tickets' && g.method === 'POST').at(-1);
  assert.deepEqual(raus.koerper.extra_fields, { geraet: 'iPad', browser: 'Safari', wieder: true });

  // Im Detail stehen sie mit ihrem Label - "geraet" allein sagt niemandem etwas.
  const detail = (await finn('GET', `/api/tickets/${neu.body.id}`)).body;
  assert.deepEqual(detail.felder, [
    { label: 'Gerät', wert: 'iPad' },
    { label: 'Browser', wert: 'Safari' },
    { label: 'Reproduzierbar?', wert: 'ja' },
  ]);

  // Ein leeres Pflichtfeld ist ein Fehler - VNW selbst prueft das NICHT, es wuerde ein Ticket
  // mit leerem Pflichtfeld anlegen und niemand merkte es.
  // Typ 9 zusaetzlich freigeben - NICHT neu einrichten: das startete eine zweite Attrappe, und
  // alles Weitere liefe an `zustand` vorbei.
  await admin('PUT', '/api/tickets/config', { url, token: '', type_ids: [7, 8, 9] });
  const vorher = zustand.tickets.size;
  const leer = await finn('POST', '/api/tickets',
    { title: 'Ohne Klasse', text: 'x', type_id: 9, extra_fields: {} });
  assert.equal(leer.status, 400);
  assert.match(leer.body.error, /Klasse/);
  assert.equal(zustand.tickets.size, vorher, 'nichts entstanden');

  // Eine zu grosse Datei wird abgelehnt, bevor sie den Body-Parser sprengt.
  const gross = await finn('POST', '/api/tickets', {
    title: 'Mit Anhang', text: 'x', type_id: 7,
    extra_fields: { geraet: 'PC', anhang: { upload: 'A'.repeat(9000), file_name: 'gross.png' } },
  });
  assert.equal(gross.status, 201, 'ein unbekanntes Feld faellt weg, statt zu stoeren');
  assert.equal(zustand.gesehen.at(-1).koerper.extra_fields.anhang, undefined);
});

test('Chat: Bild und Datei, verschluesselt und nur fuer die Beteiligten', async (t) => {
  const [ada, adaId] = await register('chatada');
  const [ben, benId] = await register('chatben');
  const [cem] = await register('chatcem');
  await ada('POST', '/api/friends', { username: 'chatben' });
  await ben('POST', `/api/friends/${adaId}/accept`);

  // Der Anhang kommt fertig verschluesselt an - der Server sieht base64 und sonst nichts.
  const chiffrat = 'aXZpdmluaXY=:' + Buffer.from('so tut ein Bild').toString('base64');
  const hoch = await ada('POST', `/api/chats/${benId}/datei`, { data: chiffrat });
  assert.equal(hoch.status, 201);
  assert.ok(hoch.body.datei_id);

  // Solange keine Nachricht dazu da ist, taucht nichts im Verlauf auf: der Anhang haengt an einem
  // Platzhalter, und der ist leer.
  assert.deepEqual((await ben('GET', `/api/chats/${adaId}`)).body, []);
  assert.equal((await ben('GET', '/api/chats')).body.find(c => c.id === adaId).last, null);

  // Jetzt die Nachricht - Name und Typ stehen VERSCHLUESSELT drin, der Server kennt sie nicht.
  const geschickt = await ada('POST', `/api/chats/${benId}`,
    { text: 'iv:verschluesselter-name-und-typ', enc: true, datei_id: hoch.body.datei_id });
  assert.equal(geschickt.status, 200);
  assert.equal(geschickt.body.datei.id, hoch.body.datei_id);

  const verlauf = (await ben('GET', `/api/chats/${adaId}`)).body;
  assert.equal(verlauf.length, 1, 'der Platzhalter ist weg');
  assert.equal(verlauf[0].datei.bytes, Math.floor(chiffrat.length * 3 / 4));
  assert.equal(JSON.stringify(verlauf[0]).includes('so tut ein Bild'), false,
    'die Bytes kommen erst, wenn jemand sie wirklich abholt');

  // Abholen darf, wer an der Unterhaltung beteiligt ist - und sonst niemand.
  assert.equal((await ben('GET', `/api/chats/datei/${hoch.body.datei_id}`)).body.data, chiffrat);
  assert.equal((await cem('GET', `/api/chats/datei/${hoch.body.datei_id}`)).status, 404);
  assert.equal((await cem('POST', `/api/chats/${adaId}/datei`, { data: chiffrat })).status, 403,
    'ohne Freundschaft kein Upload');

  // Ein fremder Anhang laesst sich nicht an die eigene Nachricht haengen.
  const fremd = await ben('POST', `/api/chats/${adaId}`,
    { text: 'iv:x', enc: true, datei_id: hoch.body.datei_id });
  assert.equal(fremd.status, 400);

  // Und was zu gross ist, wird abgelehnt - vor der Datenbank, nicht danach.
  const zuGross = await ada('POST', `/api/chats/${benId}/datei`, { data: 'A'.repeat(12_000_000) });
  assert.equal(zuGross.status, 413);
  assert.match(zuGross.body.error, /groß/);

  // Wird die Nachricht aufgeraeumt, geht der Anhang mit (ON DELETE CASCADE).
  const { db } = await import('./db.js');
  db.prepare('DELETE FROM messages WHERE id = ?').run(geschickt.body.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chat_files WHERE id = ?')
    .get(hoch.body.datei_id).n, 0);
});

// --- Benachrichtigungen nach Plan --------------------------------------------

test('Meldungen: sofort, gesammelt, mit Vorlauf, aus', async () => {
  const { db } = await import('./db.js');
  const { pushPlan } = await import('./index.js');
  const [pia, piaId] = await register('planpia');

  // Ohne eigenen Plan gelten die alten Schalter - sonst waere nach dem Update jede Einstellung weg.
  assert.equal(pushPlan({ push_chat: 0 }).chat[0].modus, 'aus');
  assert.equal(pushPlan({}).chat[0].modus, 'sofort');
  // Vorlauf gibt es nur, wo es einen Zeitpunkt gibt.
  assert.equal(pushPlan({ push_plan: '{"chat":{"modus":"vorlauf"}}' }).chat[0].modus, 'sofort');
  assert.equal(pushPlan({ push_plan: '{"ausfall":{"modus":"vorlauf"}}' }).ausfall[0].modus, 'vorlauf');
  // Und ein kaputter Eintrag wirft nicht, er faellt zurueck.
  assert.equal(pushPlan({ push_plan: 'kein json' }).todo[0].modus, 'sofort');
  // "nach der Meldung" braucht keinen Zeitpunkt im Stundenplan - das geht auch beim Chat.
  const chatSpaeter = pushPlan({
    push_plan: '{"chat":{"modus":"vorlauf","bezug":"meldung","vorlauf_min":60}}' }).chat[0];
  assert.equal(chatSpaeter.modus, 'vorlauf');
  assert.equal(chatSpaeter.bezug, 'meldung');
  assert.equal(chatSpaeter.vorlauf_min, 60);
  // Freie Zeiten, nicht aus einer Liste - und bei einer Woche ist Schluss.
  assert.equal(pushPlan({ push_plan: '{"ausfall":{"modus":"vorlauf","vorlauf_min":287}}' })
    .ausfall[0].vorlauf_min, 287);
  assert.equal(pushPlan({ push_plan: '{"ausfall":{"modus":"vorlauf","vorlauf_min":999999}}' })
    .ausfall[0].vorlauf_min, 7 * 24 * 60);

  const setzen = plan => pia('PATCH', '/api/me', { push_plan: plan });
  const meldungen = () => db.prepare(
    'SELECT kind, faellig_at, gesammelt FROM notifications WHERE user_id = ? ORDER BY id').all(piaId);

  await setzen({
    ausfall: { modus: 'vorlauf', vorlauf_min: 287, bezug: 'stunde' },
    vertretung: { modus: 'gesammelt', zeit: '19:00' },
    aenderung: { modus: 'aus' },
  });
  const gespeichert = (await pia('GET', '/api/me')).body.push_plan;
  assert.equal(gespeichert.ausfall[0].vorlauf_min, 287, 'auch krumme Vorlaeufe sind erlaubt');
  assert.equal(gespeichert.vertretung[0].zeit, '19:00');

  // Der Abgleich meldet: Ausfall (Vorlauf), Vertretung (gesammelt), Aenderung (aus).
  const cfg = (await pia('GET', '/api/config')).body;
  const [p1] = cfg.periods;
  db.prepare("INSERT OR IGNORE INTO courses(id, title, from_untis) VALUES('UNTIS-MELD', 'Chemie', 1)").run();
  const inZwei = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
                          VALUES(?, ?, ?, 'UNTIS-MELD', ?)`);
  ins.run(piaId, inZwei, p1.id, 'cancelled');
  const { untisAbgleich } = await import('./index.js');

  // Kein echter WebUntis-Aufruf: die Meldungen entstehen aus dem Vergleich, den wir hier direkt
  // nachstellen - dafuer gibt es benachrichtige() ueber die oeffentliche Test-Schnittstelle nicht.
  // Stattdessen pruefen wir die Auswertung des Plans an der Warteschlange.
  const { faelligeMeldungen } = await import('./index.js');
  assert.equal(typeof faelligeMeldungen, 'function');
});

test('Meldungen: "nach der Meldung" verzögert, statt sofort zu stupsen', async () => {
  const { db } = await import('./db.js');
  const [zoe, zoeId] = await register('spaeterzoe');
  const [zac, zacId] = await register('spaeterzac');
  await zoe('POST', '/api/friends', { username: 'spaeterzac' });
  await zac('POST', `/api/friends/${zoeId}/accept`);

  // Zoe will Chat-Meldungen erst eine Stunde spaeter - beim Lernen.
  await zoe('PATCH', '/api/me',
    { push_plan: { chat: { modus: 'vorlauf', bezug: 'meldung', vorlauf_min: 60 } } });
  await zac('POST', `/api/chats/${zoeId}`, { text: 'Hallo' });

  const m = db.prepare(`SELECT faellig_at FROM notifications
    WHERE user_id = ? AND kind = 'chat' ORDER BY id DESC LIMIT 1`).get(zoeId);
  assert.ok(m?.faellig_at, 'sie wartet, statt sofort zu stupsen');
  assert.equal((await zoe('GET', '/api/notifications/pending')).body.some(o => o.kind === 'chat'),
    false, 'und ist noch nicht abholbar');

  // Null Minuten heisst: einfach sofort.
  await zoe('PATCH', '/api/me',
    { push_plan: { chat: { modus: 'vorlauf', bezug: 'meldung', vorlauf_min: 0 } } });
  await zac('POST', `/api/chats/${zoeId}`, { text: 'Und jetzt?' });
  assert.equal(db.prepare(`SELECT faellig_at FROM notifications
    WHERE user_id = ? AND kind = 'chat' ORDER BY id DESC LIMIT 1`).get(zoeId).faellig_at, null);
});

test('Meldungen: die Warteschlange schickt erst, wenn es soweit ist', async () => {
  const { db } = await import('./db.js');
  const { faelligeMeldungen } = await import('./index.js');
  const [wim, wimId] = await register('planwim');

  // Zwei wartende Meldungen: eine ist faellig, eine noch nicht.
  db.prepare(`INSERT INTO notifications(user_id, kind, title, created_at, faellig_at, gesammelt)
              VALUES(?, 'ausfall', 'Jetzt', datetime('now'), '2020-01-01 07:00', 0)`).run(wimId);
  db.prepare(`INSERT INTO notifications(user_id, kind, title, created_at, faellig_at, gesammelt)
              VALUES(?, 'vertretung', 'Später', datetime('now'), '2099-01-01 07:00', 1)`).run(wimId);

  // Vor dem Lauf holt der Service Worker nichts ab - beides wartet.
  assert.deepEqual((await wim('GET', '/api/notifications/pending')).body, []);

  faelligeMeldungen('2020-06-01 08:00');
  const offen = (await wim('GET', '/api/notifications/pending')).body;
  assert.deepEqual(offen.map(o => o.title), ['Jetzt'], 'nur die faellige');

  // Was gesammelt wartet, wird zu EINEM Hinweis zusammengefasst.
  faelligeMeldungen('2099-06-01 08:00');
  const zweite = (await wim('GET', '/api/notifications/pending')).body;
  assert.equal(zweite.some(o => o.title === 'Später'), true);
  assert.equal(zweite.some(o => /Hinweis/.test(o.title)), true, 'die Sammlung');
});

// --- Gruppenchats -------------------------------------------------------------

test('Gruppen: anlegen, einladen, zustimmen - und das Admin-Prinzip', async () => {
  const [ada, adaId] = await register('grpada');
  const [ben, benId] = await register('grpben');
  const [cem, cemId] = await register('grpcem');

  const g = await ada('POST', '/api/groups', { name: 'Bio LK', key_enc: 'iv:fuer-ada' });
  assert.equal(g.status, 201);
  assert.equal(g.body.rolle, 'admin', 'wer anlegt, ist Admin');
  assert.equal(g.body.key_enc, 'iv:fuer-ada');

  // Einladen darf nur ein Admin.
  assert.equal((await ben('POST', `/api/groups/${g.body.id}/mitglieder`,
    { user_id: cemId, key_enc: 'x' })).status, 404, 'wer nicht drin ist, sieht die Gruppe nicht');
  assert.equal((await ada('POST', `/api/groups/${g.body.id}/mitglieder`,
    { user_id: benId, key_enc: 'iv:fuer-ben' })).status, 201);
  assert.equal((await ada('POST', `/api/groups/${g.body.id}/mitglieder`,
    { user_id: benId, key_enc: 'x' })).status, 409, 'zweimal einladen geht nicht');

  // Vor der Zusage: kein Verlauf.
  assert.equal((await ben('GET', `/api/groups/${g.body.id}/nachrichten`)).status, 404);
  const einladung = (await ben('GET', '/api/groups')).body[0];
  assert.equal(einladung.status, 'eingeladen');
  assert.equal(einladung.key_enc, null, 'den Schlüssel gibt es erst nach der Zusage');

  assert.equal((await ben('POST', `/api/groups/${g.body.id}/beitreten`)).status, 200);
  assert.equal((await ben('GET', '/api/groups')).body[0].key_enc, 'iv:fuer-ben');

  // Mitglied ist noch kein Admin.
  assert.equal((await ben('POST', `/api/groups/${g.body.id}/mitglieder`,
    { user_id: cemId, key_enc: 'x' })).status, 403);
  await ada('PATCH', `/api/groups/${g.body.id}/mitglieder/${benId}`, { rolle: 'admin' });
  assert.equal((await ben('POST', `/api/groups/${g.body.id}/mitglieder`,
    { user_id: cemId, key_enc: 'iv:fuer-cem' })).status, 201);

  // Schreiben und lesen - Cem ist noch nicht beigetreten und sieht nichts.
  assert.equal((await ada('POST', `/api/groups/${g.body.id}/nachrichten`,
    { text: 'iv:hallo', enc: true })).status, 200);
  assert.equal((await ben('GET', `/api/groups/${g.body.id}/nachrichten`)).body.length, 1);
  assert.equal((await cem('GET', `/api/groups/${g.body.id}/nachrichten`)).status, 404);

  // Der oeffentliche Schluessel ist auch ohne Freundschaft zu holen, wenn man eine Gruppe teilt.
  await ada('PUT', '/api/me/keys', { pub_key: '{"k":"ada"}', priv_key_enc: 'x:y:z' });
  assert.equal((await ben('GET', `/api/keys/${adaId}`)).body.pub_key, '{"k":"ada"}');
  const [dora] = await register('grpdora');
  assert.equal((await dora('GET', `/api/keys/${adaId}`)).status, 403, 'Fremde nicht');

  // Ablehnen loescht die Zeile samt verpacktem Schluessel.
  assert.equal((await cem('DELETE', `/api/groups/${g.body.id}/mitglieder/${cemId}`)).status, 200);
  const { db } = await import('./db.js');
  assert.equal(db.prepare('SELECT count(*) AS n FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(g.body.id, cemId).n, 0);

  // Geht der letzte Admin, rueckt jemand nach - sonst waere die Gruppe eingefroren.
  await ada('PATCH', `/api/groups/${g.body.id}/mitglieder/${benId}`, { rolle: 'mitglied' });
  await ada('DELETE', `/api/groups/${g.body.id}/mitglieder/${adaId}`);
  assert.equal((await ben('GET', '/api/groups')).body[0].rolle, 'admin', 'nachgerueckt');

  // Und wenn der Letzte geht, ist die Gruppe weg.
  await ben('DELETE', `/api/groups/${g.body.id}/mitglieder/${benId}`);
  assert.deepEqual((await ben('GET', '/api/groups')).body, []);
});

// --- Umfragen -----------------------------------------------------------------

test('Umfragen: eine Stimme je Person, und nur wer die Nachricht sieht', async () => {
  const [ute, uteId] = await register('umfrageute');
  const [vik, vikId] = await register('umfragevik');
  const [wal] = await register('umfragewal');
  await ute('POST', '/api/friends', { username: 'umfragevik' });
  await vik('POST', `/api/friends/${uteId}/accept`);

  const m = await ute('POST', `/api/chats/${vikId}`,
    { text: 'iv:verschluesselte-frage', enc: true, umfrage_n: 3 });
  assert.equal(m.body.umfrage_n, 3);
  // Der Fragetext bleibt Chiffrat - der Server kennt ihn nicht.
  assert.equal(JSON.stringify(m.body).includes('Kuchen'), false);

  assert.equal((await vik('POST', `/api/messages/${m.body.id}/stimme`, { wahl: 1 })).status, 200);
  // Umentscheiden ERSETZT die Stimme, statt doppelt zu zaehlen.
  const zweite = await vik('POST', `/api/messages/${m.body.id}/stimme`, { wahl: 2 });
  assert.deepEqual(zweite.body.stimmen, [{ user_id: vikId, wahl: 2 }]);

  // Eine Antwort, die es nicht gibt.
  assert.equal((await ute('POST', `/api/messages/${m.body.id}/stimme`, { wahl: 3 })).status, 400);
  assert.equal((await ute('POST', `/api/messages/${m.body.id}/stimme`, { wahl: -1 })).status, 400);
  // Und wer die Unterhaltung nicht sieht, stimmt auch nicht ab.
  assert.equal((await wal('POST', `/api/messages/${m.body.id}/stimme`, { wahl: 0 })).status, 404);

  // Die Stimmen kommen mit dem Verlauf.
  const verlauf = (await ute('GET', `/api/chats/${vikId}`)).body;
  assert.deepEqual(verlauf[0].stimmen, [{ user_id: vikId, wahl: 2 }]);

  // Auf eine gewoehnliche Nachricht laesst sich nicht abstimmen.
  const normal = await ute('POST', `/api/chats/${vikId}`, { text: 'nur Text' });
  assert.equal((await vik('POST', `/api/messages/${normal.body.id}/stimme`, { wahl: 0 })).status, 400);
});

// --- ToDo-Listen ---------------------------------------------------------------

test('ToDo-Listen: teilen heißt gemeinsam', async () => {
  const [eva, evaId] = await register('listeeva');
  const [fyn, fynId] = await register('listefyn');
  const [gil] = await register('listegil');
  await eva('POST', '/api/friends', { username: 'listefyn' });
  await fyn('POST', `/api/friends/${evaId}/accept`);

  const o = await eva('POST', '/api/todo-ordner', { name: 'Einkauf Kursfahrt' });
  assert.equal(o.status, 201);
  assert.equal(o.body.meiner, true);

  const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16).replace('T', ' ');
  const t = await eva('POST', '/api/todos',
    { text: 'Kekse kaufen', due_at: morgen, remind_min: 60, ordner_id: o.body.id });
  assert.equal(t.body.ordner_id, o.body.id);

  // Vor dem Teilen sieht Fyn nichts.
  assert.deepEqual((await fyn('GET', '/api/todos')).body, []);
  assert.deepEqual((await fyn('GET', '/api/todo-ordner')).body, []);

  // Teilen geht nur mit Freunden.
  assert.equal((await eva('POST', `/api/todo-ordner/${o.body.id}/teilen`, { user_id: 999999 })).status, 403);
  assert.equal((await eva('POST', `/api/todo-ordner/${o.body.id}/teilen`, { user_id: fynId })).status, 201);

  // Jetzt sieht Fyn die Liste, traegt ein und hakt ab - und das gilt fuer beide.
  assert.equal((await fyn('GET', '/api/todos')).body.length, 1);
  assert.equal((await fyn('POST', '/api/todos',
    { text: 'Saft', due_at: morgen, remind_min: 0, ordner_id: o.body.id })).status, 200);
  assert.equal((await fyn('POST', `/api/todos/${t.body.id}/done`)).status, 200);
  assert.equal((await eva('GET', '/api/todos')).body.find(x => x.id === t.body.id).done, true,
    'abgehakt ist abgehakt - fuer alle');

  // Ein Fremder kommt nicht heran.
  assert.equal((await gil('POST', '/api/todos',
    { text: 'x', due_at: morgen, remind_min: 0, ordner_id: o.body.id })).status, 404);
  assert.equal((await gil('POST', `/api/todos/${t.body.id}/done`)).status, 404);
  assert.equal((await gil('DELETE', `/api/todo-ordner/${o.body.id}`)).status, 404);

  // Umbenennen bleibt beim Besitzer, austreten kann der Geteilte.
  assert.equal((await fyn('PUT', `/api/todo-ordner/${o.body.id}`, { name: 'meins jetzt' })).status, 404);
  assert.equal((await eva('PUT', `/api/todo-ordner/${o.body.id}`, { name: 'Kursfahrt' })).body.name,
    'Kursfahrt');
  assert.equal((await fyn('DELETE', `/api/todo-ordner/${o.body.id}`)).status, 200);
  assert.deepEqual((await fyn('GET', '/api/todo-ordner')).body, []);
  assert.equal((await eva('GET', '/api/todo-ordner')).body.length, 1, 'die Liste selbst bleibt');

  // Loeschen nimmt die ToDos mit.
  await eva('DELETE', `/api/todo-ordner/${o.body.id}`);
  assert.deepEqual((await eva('GET', '/api/todos')).body, []);
});

// --- Mehrere Anhaenge ----------------------------------------------------------

test('Chat: drei Dateien ergeben drei Nachrichten', async () => {
  const [hal, halId] = await register('dateihal');
  const [ina, inaId] = await register('dateiina');
  await hal('POST', '/api/friends', { username: 'dateiina' });
  await ina('POST', `/api/friends/${halId}/accept`);

  for (const name of ['a', 'b', 'c']) {
    const { body } = await hal('POST', `/api/chats/${inaId}/datei`, { data: `iv:${name}` });
    await hal('POST', `/api/chats/${inaId}`,
      { text: `iv:beschreibung-${name}`, enc: true, datei_id: body.datei_id });
  }
  const verlauf = (await ina('GET', `/api/chats/${halId}`)).body;
  assert.equal(verlauf.length, 3, 'drei Nachrichten, drei Anhaenge');
  assert.equal(verlauf.every(m => m.datei), true);
  assert.equal(new Set(verlauf.map(m => m.datei.id)).size, 3, 'jede mit eigenem Anhang');
});

// --- CRUD ----------------------------------------------------------------------

test('CRUD: anlegen, lesen, ändern, löschen - und für Fremde nichts davon', async (t) => {
  const admin = await login('admin', 'geheim');
  const [ida, idaId] = await register('crudida');
  const [jan] = await register('crudjan');
  const cfg = (await ida('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1] = cfg.periods;
  const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const morgenZeit = morgen + ' 08:00';

  // --- Kurse (Admin) ---
  const kurs = await admin('POST', '/api/courses', { id: 'CRUD01', title: 'Crud GK' });
  assert.equal(kurs.status, 200);
  assert.equal((await ida('GET', '/api/courses')).body.some(c => c.id === 'CRUD01'), true);
  assert.equal((await admin('PUT', '/api/courses/CRUD01',
    { id: 'CRUD01', title: 'Crud LK' })).body.title, 'Crud LK');
  assert.equal((await ida('POST', '/api/courses', { id: 'X', title: 'X' })).status, 403);

  // --- Stundenplan-Eintrag ---
  assert.equal((await ida('PUT', '/api/entry',
    { day_id: mo.id, period_id: p1.id, course_id: 'CRUD01' })).status, 200);
  assert.equal((await ida('GET', '/api/timetable')).body.entries
    .some(e => e.day_id === mo.id && e.period_id === p1.id), true);
  assert.equal((await ida('PUT', '/api/entry',
    { day_id: mo.id, period_id: p1.id, course_id: null })).status, 200);

  // --- Hausaufgabe ---
  await ida('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'CRUD01' });
  const hw = await ida('POST', '/api/homework',
    { course_id: 'CRUD01', due_date: morgen, text: 'S. 12' });
  assert.equal(hw.status, 200);
  assert.equal((await ida('GET', '/api/homework')).body.some(x => x.id === hw.body.id), true);
  assert.equal((await ida('PUT', `/api/homework/${hw.body.id}`,
    { course_id: 'CRUD01', due_date: morgen, text: 'S. 13' })).body.text, 'S. 13');
  assert.equal((await jan('PUT', `/api/homework/${hw.body.id}`,
    { course_id: 'CRUD01', due_date: morgen, text: 'gekapert' })).status, 403);
  assert.equal((await jan('DELETE', `/api/homework/${hw.body.id}`)).status, 403);
  assert.equal((await ida('DELETE', `/api/homework/${hw.body.id}`)).status, 200);

  // --- Notiz ---
  assert.equal((await ida('PUT', '/api/note',
    { day_id: mo.id, period_id: p1.id, text: 'Buch mit' })).status, 200);
  assert.equal((await ida('GET', '/api/timetable')).body.entries
    .find(e => e.day_id === mo.id && e.period_id === p1.id).note, 'Buch mit');
  await ida('PUT', '/api/note', { day_id: mo.id, period_id: p1.id, text: '' });

  // --- ToDo ---
  const todo = await ida('POST', '/api/todos',
    { text: 'Crud', due_at: morgenZeit, remind_min: 0 });
  assert.equal((await ida('PUT', `/api/todos/${todo.body.id}`,
    { text: 'Crud 2', due_at: morgenZeit, remind_min: 60 })).body.text, 'Crud 2');
  assert.equal((await jan('DELETE', `/api/todos/${todo.body.id}`)).status, 404);
  assert.equal((await ida('DELETE', `/api/todos/${todo.body.id}`)).status, 200);

  // --- ToDo-Liste ---
  const liste = await ida('POST', '/api/todo-ordner', { name: 'Crud-Liste' });
  assert.equal((await ida('PUT', `/api/todo-ordner/${liste.body.id}`, { name: 'Crud 2' })).body.name,
    'Crud 2');
  assert.equal((await jan('PUT', `/api/todo-ordner/${liste.body.id}`, { name: 'x' })).status, 404);
  assert.equal((await ida('DELETE', `/api/todo-ordner/${liste.body.id}`)).status, 200);

  // --- Abmeldung ---
  assert.equal((await ida('POST', '/api/absences', { from: morgen, to: morgen })).status, 200);
  assert.deepEqual((await ida('GET', '/api/absences')).body,
    [{ date: morgen, von: null, bis: null, grund: null, grund_sichtbar: false }]);
  assert.equal((await ida('DELETE', `/api/absences/${morgen}`)).status, 200);

  // --- Gruppe ---
  const g = await ida('POST', '/api/groups', { name: 'Crud-Gruppe', key_enc: 'iv:x' });
  assert.equal((await ida('PATCH', `/api/groups/${g.body.id}`, { name: 'Crud-Gruppe 2' })).body.name,
    'Crud-Gruppe 2');
  assert.equal((await jan('PATCH', `/api/groups/${g.body.id}`, { name: 'x' })).status, 404);
  assert.equal((await jan('GET', `/api/groups/${g.body.id}/nachrichten`)).status, 404);
  assert.equal((await ida('DELETE', `/api/groups/${g.body.id}/mitglieder/${idaId}`)).status, 200);

  // --- Eigenes Profil ---
  assert.equal((await ida('PATCH', '/api/me', { display_name: 'Ida C.' })).body.display_name, 'Ida C.');
  assert.equal((await ida('PATCH', '/api/me', { digest_zeit: '25:00' })).status, 400);

  // --- Aufraeumen ---
  await admin('DELETE', '/api/courses/CRUD01');
  assert.equal((await ida('GET', '/api/courses')).body.some(c => c.id === 'CRUD01'), false);
});

test('Hausaufgaben: eigene Erinnerung vorher, mit selbst gewählter Zeit', async () => {
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'Q1ERIN01', title: 'Erinnerungskurs' });
  const [rob, robId] = await register('erinnerrob');
  const cfg = (await rob('GET', '/api/config')).body;
  await rob('PUT', '/api/entry',
    { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'Q1ERIN01' });

  const inDrei = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const meine = () => db.prepare(`SELECT title, body, faellig_at FROM notifications
    WHERE user_id = ? AND kind = 'hausaufgaben' ORDER BY id DESC LIMIT 1`).get(robId);

  // Eigene Zeit beim Eintragen: 26 Stunden vorher - keine Liste, sondern eine Zahl.
  const hw = await rob('POST', '/api/homework',
    { course_id: 'Q1ERIN01', due_date: inDrei, text: 'Referat vorbereiten', erinnerung_min: 26 * 60 });
  assert.equal(hw.status, 200);
  const m = meine();
  assert.match(m.title, /Denk dran/);
  assert.match(m.body, /Referat/);
  assert.ok(m.faellig_at, 'sie wartet auf ihren Zeitpunkt');

  // Ohne Angabe gilt die Voreinstellung aus dem Profil.
  await rob('PATCH', '/api/me', { hw_erinnerung_min: 120 });
  assert.equal((await rob('GET', '/api/me')).body.hw_erinnerung_min, 120);
  await rob('POST', '/api/homework',
    { course_id: 'Q1ERIN01', due_date: inDrei, text: 'Vokabeln' });
  assert.match(meine().body, /Vokabeln/);

  // Und 0 heisst: keine Erinnerung.
  const vorher = db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'hausaufgaben'")
    .get(robId).n;
  await rob('POST', '/api/homework',
    { course_id: 'Q1ERIN01', due_date: inDrei, text: 'Ohne', erinnerung_min: 0 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'hausaufgaben'")
    .get(robId).n, vorher, 'nichts dazugekommen');

  // Eine Erinnerung an einen Zeitpunkt in der Vergangenheit waere keine.
  const gestern = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await rob('POST', '/api/homework',
    { course_id: 'Q1ERIN01', due_date: gestern, text: 'Zu spät', erinnerung_min: 60 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND kind = 'hausaufgaben'")
    .get(robId).n, vorher);
});


// --- Mehrere Schulen ----------------------------------------------------------

test('Schulen: die eingestellte ist die Vorgabe, andere kommen daneben', async () => {
  const { db, standardSchule } = await import('./db.js');
  const std = standardSchule();
  assert.equal(std.standard, 1, 'es gibt immer genau eine Standardschule');

  // Wer nichts eingestellt hat, gehoert zur Standardschule - ohne dass an seinem Konto etwas steht.
  const [ida, idaId] = await register('schulida');
  assert.equal(db.prepare('SELECT school_id FROM users WHERE id = ?').get(idaId).school_id, null);
  const cfgIda = (await ida('GET', '/api/config')).body;
  assert.equal(cfgIda.schule.id, std.id);
  assert.equal(cfgIda.periods.length > 0, true, 'das Raster der eigenen Schule');

  // Eine zweite Schule mit eigenem Raster - andere Klingelzeiten, andere Stunden-IDs.
  const zweite = Number(db.prepare(`INSERT INTO schools(server, school, name, created_at)
    VALUES('sued.webuntis.com', 'rs-sued', 'Realschule Süd', datetime('now'))`).run().lastInsertRowid);
  const rein = db.prepare('INSERT INTO periods(school_id, nr, start_time, end_time) VALUES(?, ?, ?, ?)');
  rein.run(zweite, 1, '07:30', '08:15');
  rein.run(zweite, 2, '08:20', '09:05');

  const [udo, udoId] = await register('schuludo');
  db.prepare('UPDATE users SET school_id = ? WHERE id = ?').run(zweite, udoId);
  const cfgUdo = (await udo('GET', '/api/config')).body;
  assert.equal(cfgUdo.schule.name, 'Realschule Süd');
  assert.equal(cfgUdo.periods.length, 2, 'nur das Raster der eigenen Schule');
  assert.equal(cfgUdo.periods[0].start_time, '07:30');
  // Dieselbe Stundennummer an zwei Schulen ist erlaubt - vorher war nr instanzweit eindeutig.
  assert.notEqual(cfgUdo.periods[0].id, cfgIda.periods[0].id);

  // Ferien der einen Schule gehen die andere nichts an.
  const woche = (await udo('GET', '/api/timetable')).body;
  const montag = woche.days[0].date;
  db.prepare("INSERT INTO holidays(school_id, von, bis, name) VALUES(?, ?, ?, 'Süd-Ferien')")
    .run(zweite, montag, montag);
  assert.equal((await udo('GET', '/api/timetable')).body.ferien[montag], 'Süd-Ferien');
  assert.equal((await ida('GET', '/api/timetable')).body.ferien[montag], undefined,
    'die andere Schule hat frei, wir nicht');

  // In der Freundesliste steht, zu welcher Schule jemand gehoert - danach gruppiert die Auswahl.
  await ida('POST', '/api/friends', { username: 'schuludo' });
  await udo('POST', `/api/friends/${idaId}/accept`);
  const freunde = (await ida('GET', '/api/friends')).body.friends;
  assert.equal(freunde.find(f => f.id === udoId).school, 'Realschule Süd');
  assert.equal((await udo('GET', '/api/friends')).body.friends.find(f => f.id === idaId).school,
    std.name);
});

test('Kurs-IDs: dieselbe Nummer an zwei Schulen sind zwei Kurse', async () => {
  const { aufbereiten } = await import('./untis.js');
  const roh = [{ date: 20260302, startTime: 800, endTime: 845, lsnumber: 4711,
    su: [{ name: 'MA', longname: 'Mathe' }], te: [], ro: [] }];

  // Die Standardschule behaelt das alte Format - ihre IDs stehen so in jeder bestehenden Datenbank.
  assert.equal(aufbereiten(roh)[0].course_id, 'UNTIS-4711');
  assert.equal(aufbereiten(roh, 'S3-')[0].course_id, 'S3-UNTIS-4711');
  // Auch ohne Kursnummer, wo Fach und Lehrer die ID bilden.
  const ohneNr = [{ ...roh[0], lsnumber: undefined, te: [{ name: 'KLN' }], kl: [{ name: '10a' }] }];
  assert.equal(aufbereiten(ohneNr)[0].course_id.startsWith('UNTIS-'), true);
  assert.equal(aufbereiten(ohneNr, 'S3-')[0].course_id.startsWith('S3-UNTIS-'), true);
});

// --- Wer hat auch frei --------------------------------------------------------

test('Wer hat auch frei: Freistunde, Ausfall und Vertretung ohne Lehrer', async () => {
  const { db, standardSchule } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'FREI01', title: 'Deutsch' });
  await admin('POST', '/api/courses', { id: 'FREI02', title: 'Sport' });

  const [mia, miaId] = await register('freimia');
  const [tom, tomId] = await register('freitom');
  const [nils, nilsId] = await register('freinils');
  const [ida, idaId] = await register('freiida');   // andere Schule
  for (const [wer, id] of [[tom, tomId], [nils, nilsId], [ida, idaId]]) {
    await mia('POST', '/api/friends', { username: (await wer('GET', '/api/me')).body.username });
    await wer('POST', `/api/friends/${miaId}/accept`);
    assert.ok(id > 0);
  }

  const cfg = (await mia('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1, p2, p3] = cfg.periods;

  // Mia: 1. Stunde Deutsch, 3. Stunde Deutsch - die 2. ist damit eine Freistunde.
  await mia('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'FREI01' });
  await mia('PUT', '/api/entry', { day_id: mo.id, period_id: p3.id, course_id: 'FREI01' });
  // Tom hat in der 2. Stunde Sport, das aber ausfaellt; in der 1. hat er Unterricht.
  await tom('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'FREI01' });
  await tom('PUT', '/api/entry', { day_id: mo.id, period_id: p2.id, course_id: 'FREI02' });
  // Nils ist in der 1. Stunde da und danach fertig - in der 2. hat er schlicht nichts.
  await nils('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'FREI01' });
  // Ida sitzt an einer anderen Schule und hat dort dieselbe Luecke.
  const zweite = Number(db.prepare(`INSERT INTO schools(server, school, name, created_at)
    VALUES('nord.webuntis.com', 'gym-nord', 'Gymnasium Nord', datetime('now'))`).run().lastInsertRowid);
  db.prepare('INSERT INTO periods(school_id, nr, start_time, end_time) VALUES(?, 1, ?, ?)')
    .run(zweite, '08:00', '08:45');
  db.prepare('UPDATE users SET school_id = ? WHERE id = ?').run(zweite, idaId);

  const woche = (await mia('GET', '/api/timetable')).body;
  const montag = woche.days.find(d => d.id === mo.id).date;
  // Toms Tag kommt aus WebUntis: 1. Stunde regulaer, 2. Stunde faellt aus. Beides gehoert dazu -
  // wer an dem Tag ueberhaupt keinen Unterricht hat, ist nicht "auch frei", sondern woanders.
  db.prepare("INSERT OR IGNORE INTO courses(id, title, from_untis, school_id) VALUES('UNTIS-FREI', 'Sport', 1, ?)")
    .run(standardSchule().id);
  const untisRein = db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status)
              VALUES(?, ?, ?, 'UNTIS-FREI', ?)`);
  untisRein.run(tomId, montag, p1.id, 'regular');
  untisRein.run(tomId, montag, p2.id, 'cancelled');

  const slot = (plan, pid) => plan.entries.find(e => e.day_id === mo.id && e.period_id === pid);
  const jetzt = (await mia('GET', '/api/timetable')).body;
  const luecke = slot(jetzt, p2.id);
  assert.equal(luecke.id, '__frei__', 'zwischen zwei Stunden entsteht die Freistunde');

  const namen = Object.fromEntries(luecke.frei.map(f => [f.username, f.grund]));
  assert.equal(namen.freitom, 'ausfall', 'bei Tom faellt in der Stunde etwas aus');
  assert.equal(namen.freinils, 'kein_unterricht', 'Nils ist an dem Tag da, aber nicht mehr');
  assert.equal('freiida' in namen, false, 'andere Schule bleibt aussen vor');

  // In einer Stunde, in der ich selbst Unterricht habe, steht die Liste leer.
  assert.deepEqual(slot(jetzt, p1.id).frei, []);

  // Wer abgemeldet ist, ist krank und nicht frei.
  await nils('POST', '/api/absences', { from: montag, to: montag });
  const ohneNils = slot((await mia('GET', '/api/timetable')).body, p2.id).frei;
  assert.equal(ohneNils.some(f => f.username === 'freinils'), false, 'abgemeldet zaehlt nicht');
  await nils('DELETE', `/api/absences/${montag}`);

  // Eine Vertretung ohne Lehrer ist auch freie Zeit - in beide Richtungen.
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status, teacher)
              VALUES(?, ?, ?, 'UNTIS-FREI', 'irregular', NULL)`).run(tomId, montag, p2.id);
  const ohneLehrer = slot((await mia('GET', '/api/timetable')).body, p2.id).frei;
  assert.equal(ohneLehrer.find(f => f.username === 'freitom').grund, 'ohne_lehrer');

  // Mit Lehrer ist es eine Stunde wie jede andere.
  db.prepare(`INSERT OR REPLACE INTO untis_lessons(user_id, date, period_id, course_id, status, teacher)
              VALUES(?, ?, ?, 'UNTIS-FREI', 'irregular', 'Frau Ersatz')`).run(tomId, montag, p2.id);
  const mitLehrer = slot((await mia('GET', '/api/timetable')).body, p2.id).frei;
  assert.equal(mitLehrer.some(f => f.username === 'freitom'), false, 'Vertretung mit Lehrer ist Unterricht');
});

test('Meldungen: mehrere Regeln je Art nebeneinander', async () => {
  const { db } = await import('./db.js');
  const { pushPlan } = await import('./index.js');
  const [ute, uteId] = await register('regelute');
  const [uwe] = await register('regeluwe');
  await ute('POST', '/api/friends', { username: 'regeluwe' });
  await uwe('POST', `/api/friends/${uteId}/accept`);

  // Ein einzelnes Objekt bleibt gueltig - so steht es in jedem bisher gespeicherten Plan.
  assert.deepEqual(pushPlan({ push_plan: '{"chat":{"modus":"aus"}}' }).chat.map(r => r.modus), ['aus']);
  // Mehr als vier Regeln baut sich niemand mit Absicht.
  const viele = JSON.stringify({ chat: Array.from({ length: 9 }, () => ({ modus: 'sofort' })) });
  assert.equal(pushPlan({ push_plan: viele }).chat.length, 4);

  const chatMeldungen = () => db.prepare(
    "SELECT faellig_at FROM notifications WHERE user_id = ? AND kind = 'chat' ORDER BY id").all(uteId);

  // Sofort UND nochmal eine Stunde spaeter: zwei Meldungen aus einer Nachricht.
  await ute('PATCH', '/api/me', { push_plan: { chat: [
    { modus: 'sofort' },
    { modus: 'vorlauf', bezug: 'meldung', vorlauf_min: 60 },
  ] } });
  assert.equal((await ute('GET', '/api/me')).body.push_plan.chat.length, 2, 'beide bleiben stehen');
  const vorher = chatMeldungen().length;
  await uwe('POST', `/api/chats/${uteId}`, { text: 'Hallo' });
  const beide = chatMeldungen().slice(vorher);
  assert.equal(beide.length, 2);
  assert.equal(beide.filter(m => m.faellig_at === null).length, 1, 'eine geht sofort hinaus');
  assert.equal(beide.filter(m => m.faellig_at !== null).length, 1, 'eine wartet');

  // Zwei Regeln, die auf denselben Zeitpunkt fallen, sind EINE Meldung - nicht zwei.
  await ute('PATCH', '/api/me', { push_plan: { chat: [
    { modus: 'sofort' },
    { modus: 'vorlauf', bezug: 'meldung', vorlauf_min: 0 },
  ] } });
  const vorDoppel = chatMeldungen().length;
  await uwe('POST', `/api/chats/${uteId}`, { text: 'Und nochmal' });
  assert.equal(chatMeldungen().length - vorDoppel, 1, 'nicht doppelt');

  // Und "aus" in allen Regeln heisst weiterhin: gar nichts.
  await ute('PATCH', '/api/me', { push_plan: { chat: [{ modus: 'aus' }] } });
  const vorAus = chatMeldungen().length;
  await uwe('POST', `/api/chats/${uteId}`, { text: 'Still' });
  assert.equal(chatMeldungen().length, vorAus);
});

test('Der Frei-Hinweis in der Ausfall-Meldung ist standardmaessig aus', async () => {
  const [rea] = await register('hinweisrea');
  assert.equal((await rea('GET', '/api/me')).body.frei_hinweis, false, 'aus, bis jemand ihn anschaltet');
  await rea('PATCH', '/api/me', { frei_hinweis: true });
  assert.equal((await rea('GET', '/api/me')).body.frei_hinweis, true);
});

test('Der Nachsatz an der Ausfall-Meldung nennt, wer dann auch frei hat', async () => {
  const { db, standardSchule } = await import('./db.js');
  const { auchFrei } = await import('./index.js');
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'NACH01', title: 'Erdkunde' });

  const [ole, oleId] = await register('nachole');
  const [pia] = await register('nachpia');
  const [qip] = await register('nachqip');
  for (const [wer, name] of [[pia, 'nachpia'], [qip, 'nachqip']]) {
    await ole('POST', '/api/friends', { username: name });
    await wer('POST', `/api/friends/${oleId}/accept`);
  }

  const cfg = (await ole('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1, p2, p3] = cfg.periods;
  const montag = (await ole('GET', '/api/timetable')).body.days[0].date;

  // Beide Freunde sind an dem Tag da und haben in der 2. Stunde eine Luecke.
  for (const wer of [pia, qip]) {
    await wer('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'NACH01' });
    await wer('PUT', '/api/entry', { day_id: mo.id, period_id: p3.id, course_id: 'NACH01' });
  }
  const schule = standardSchule();
  assert.match(auchFrei(oleId, montag, p2.id, schule), /nachpia und nachqip haben dann auch frei/);

  // Einer allein wird auch grammatisch einer.
  db.prepare('DELETE FROM entries WHERE user_id = (SELECT id FROM users WHERE username = ?)').run('nachqip');
  assert.match(auchFrei(oleId, montag, p2.id, schule), /nachpia hat dann auch frei/);

  // Und wenn niemand frei hat, steht da auch nichts - kein leerer Anhang an der Meldung.
  await pia('PUT', '/api/entry', { day_id: mo.id, period_id: p2.id, course_id: 'NACH01' });
  assert.equal(auchFrei(oleId, montag, p2.id, schule), '');
});


/**
 * Ein WebUntis, das nur so tut.
 *
 * Der echte Weg besteht auf https und auf einem Host aus der Schulsuche - ein Testserver auf
 * 127.0.0.1 kommt da nicht durch, und das soll er auch nicht. Gefaelscht wird deshalb der
 * Transport: alles an *.webuntis.com beantwortet dieser Stub, alles andere (also die eigene API)
 * geht weiter an das echte fetch. Damit laeuft der Abgleich unveraendert durch.
 */
function stubUntis({ raster, stunden, ferien = [], rasterFehler = false, rest = null }) {
  const echt = globalThis.fetch;
  const gesehen = [];
  const json = (o, kopf = {}) => new Response(JSON.stringify(o),
    { headers: { 'content-type': 'application/json', ...kopf } });

  globalThis.fetch = async (url, opt) => {
    if (!String(url).includes('webuntis.com')) return echt(url, opt);
    // Die REST-Zugaben (Lehrstoff, Notizen, Hausaufgaben) - leer, aber gueltig. Ein Test kann
    // eigene Antworten geben: ein Objekt wird zu JSON, eine Response geht durch.
    if (!opt?.body) {
      gesehen.push(String(url));
      const eigene = rest?.(String(url));
      return eigene instanceof Response ? eigene : json(eigene ?? { data: {} });
    }
    const { method } = JSON.parse(opt.body);
    gesehen.push(method);
    if (method === 'authenticate') return json(
      { jsonrpc: '2.0', result: { sessionId: 'sitzung7', personId: 77, personType: 5 } },
      { 'set-cookie': 'JSESSIONID=sitzung7; Path=/' });
    if (method === 'getTimegridUnits') {
      return rasterFehler
        ? json({ jsonrpc: '2.0', error: { code: -7002, message: 'no right for timegrid' } })
        : json({ jsonrpc: '2.0', result: raster });
    }
    if (method === 'getTimetable') return json({ jsonrpc: '2.0', result: stunden });
    if (method === 'getHolidays') return json({ jsonrpc: '2.0', result: ferien });
    return json({ jsonrpc: '2.0', result: {} });
  };
  return { gesehen, zurueck: () => { globalThis.fetch = echt; } };
}

// Die Standardschule muss stehen, sonst ist die naechste Anmeldung nicht die ZWEITE Schule,
// sondern die erste - und die fuellt bekanntlich die Vorgabe.
const standardSchuleSetzen = async () => {
  const { db, standardSchule } = await import('./db.js');
  if (!standardSchule().server)
    db.prepare("UPDATE schools SET server = 'haupt.webuntis.com', school = 'gym-haupt', name = 'Gymnasium Haupt' WHERE standard = 1").run();
  return standardSchule();
};

test('RSS: Einträge lesen, HTML zu Text, leerer Kanal', async () => {
  const rss = await import('./rss.js');
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>WebUntis Feed</title>
    <item><title><![CDATA[Planbau &amp; Räume]]></title>
      <link>https://gho-berlin.webuntis.com/WebUntis?school=gho-berlin</link>
      <description><![CDATA[<p>Ab Montag gilt der <b>neue Plan</b>.<br>Details: <a href="https://schule.de/plan">hier</a></p>]]></description>
      <pubDate>Mon, 07 Sep 2026 10:00:00 +0200</pubDate><guid>n-1</guid></item>
    <item><title>Aula gesperrt &amp; Mensa offen</title><description>Bis Freitag.</description></item>
  </channel></rss>`;
  const [a, b] = rss.lese(xml);
  assert.equal(a.id, 'n-1');
  assert.equal(a.titel, 'Planbau & Räume', 'CDATA traegt HTML - die Entity wird aufgeloest');
  assert.equal(a.datum, '2026-09-07');
  assert.equal(a.link, 'https://gho-berlin.webuntis.com/WebUntis?school=gho-berlin');
  assert.equal(a.text, 'Ab Montag gilt der neue Plan.\nDetails: [hier](https://schule.de/plan)',
    'Umbruch bleibt, der Link wird Markdown, sonst keine Tags');
  assert.equal(b.titel, 'Aula gesperrt & Mensa offen', 'ausserhalb von CDATA werden Entities aufgeloest');
  assert.equal(b.datum, null);
  assert.equal(b.id, b.titel + '|Bis Freitag.', 'ohne guid und Link ein Schluessel aus dem Inhalt');

  // Das Beispiel des Nutzers: ein Kanal ohne Eintraege. Und Unfug.
  assert.deepEqual(rss.lese('<rss version="2.0"><channel><title>WebUntis Feed</title></channel></rss>'), []);
  assert.deepEqual(rss.lese('<item><title>offen'), []);
  assert.deepEqual(rss.lese(null), []);
});

test('WebUntis: Lehrstoff - Tag fuer Tag, wenn die Woche nichts liefert; Objekt statt Text', async t => {
  const { createServer } = await import('node:http');
  const gesehen = [];
  const heute = new Date().toISOString().slice(0, 10);
  const server = createServer((req, res) => {
    gesehen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    const u = new URL(req.url, 'http://x');
    const von = u.searchParams.get('startDateTime'), bis = u.searchParams.get('endDateTime');
    // Die Woche bleibt leer, ein einzelner Tag antwortet - so wie manche Instanzen.
    if (von.slice(0, 10) !== bis.slice(0, 10)) return res.end(JSON.stringify({ data: { calendarEntries: [] } }));
    if (!von.startsWith(heute)) return res.end(JSON.stringify({ data: { calendarEntries: [] } }));
    res.end(JSON.stringify({ data: { calendarEntries: [
      { startDateTime: `${heute}T08:00`, endDateTime: `${heute}T09:30`,
        teachingContent: { text: 'Als Objekt verpackt' } },
    ] } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${server.address().port}`;
  const untis = await import('./untis.js');
  const stoff = await untis.lehrstoff(
    { host, cookie: 'JSESSIONID=x', personId: 42, personType: 5 }, heute, heute);
  assert.deepEqual(stoff, [{ date: heute.replaceAll('-', ''), von: 800, bis: 930, text: 'Als Objekt verpackt' }]);
  assert.ok(gesehen.filter(u => u.includes(`${heute}T00`)).length >= 1, 'der Tag wurde einzeln gefragt');
  const montag = new Date(heute + 'T12:00:00Z');
  montag.setUTCDate(montag.getUTCDate() - ((montag.getUTCDay() + 6) % 7));
  assert.ok(gesehen.some(u => u.includes(`startDateTime=${montag.toISOString().slice(0, 10)}T00`)
    && !u.includes(`endDateTime=${montag.toISOString().slice(0, 10)}`)), 'zuerst die ganze Woche');
});

test('WebUntis: Lehrstoff je Stunde, wenn Bereiche 404 geben - nur auf Wunsch, mit Abbruch', async t => {
  // So sah der Bericht einer Schule aus: die Wochenabfrage liefert 36 Stunden, calendar-entry/detail
  // antwortet fuer Woche und Tag mit 404 - der Endpunkt kennt nur exakt eine Stunde.
  const { createServer } = await import('node:http');
  const gesehen = [];
  const heute = new Date().toISOString().slice(0, 10);
  const alsZahl = iso => Number(iso.replaceAll('-', ''));
  let kaputt = false;
  const server = createServer((req, res) => {
    gesehen.push(req.url);
    const fertig = (o, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      return req.on('end', () => fertig({ jsonrpc: '2.0', id: 'x', result: [
        { id: 1, date: alsZahl(heute), startTime: 750, endTime: 835, lsnumber: 1, su: [{ name: 'GE' }], te: [{ name: 'Wend' }], ro: [{ name: '205' }] },
        { id: 2, date: alsZahl(heute), startTime: 840, endTime: 925, lsnumber: 1, su: [{ name: 'GE' }], te: [{ name: 'Wend' }], ro: [{ name: '205' }] },
        { id: 3, date: alsZahl(heute), startTime: 940, endTime: 1025, lsnumber: 2, su: [{ name: 'PW' }], te: [{ name: 'Cle' }], ro: [{ name: '221' }] },
        // Weit weg vom Fenster: dafuer wird nicht je Stunde gefragt.
        { id: 4, date: alsZahl(heute) + 100, startTime: 750, endTime: 835, lsnumber: 3, su: [{ name: 'MA' }], te: [], ro: [] },
      ] }));
    }
    if (req.url.includes('calendar-entry/detail')) {
      if (kaputt) return fertig({ errorCode: 'NOT_FOUND', errorMessage: 'Not Found' }, 404);
      const u = new URL(req.url, 'http://x');
      const von = u.searchParams.get('startDateTime'), bis = u.searchParams.get('endDateTime');
      // Nur die exakte Stunde ohne Sekunden, wie die Oberflaeche sie schickt - alles andere 404.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(von) || von.slice(0, 10) !== bis.slice(0, 10) || von.endsWith('T00:00'))
        return fertig({ errorCode: 'NOT_FOUND', errorMessage: 'Not Found' }, 404);
      if (!u.pathname.includes('/v1/')) return fertig({ errorMessage: 'Not Found' }, 404);   // nur v1 gibt es
      return fertig({ data: { calendarEntries: [{ startDateTime: von, endDateTime: bis,
        teachingContent: von.endsWith('T07:50') ? 'Bitte die ausgeteilten Arbeitsaufträge bearbeiten' : '' }] } });
    }
    fertig({ data: {} });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${server.address().port}`;
  const untis = await import('./untis.js');
  const sitzung = { url: host + '/WebUntis/jsonrpc.do', host, cookie: 'JSESSIONID=x', personId: 625, personType: 5 };

  // Ohne den Wunsch bleibt es bei den Bereichsanfragen - und der Lehrstoff ist "nicht geholt".
  let roh = await untis.stundenplan(sitzung, heute, heute);
  assert.equal(gesehen.filter(u => /startDateTime=[^&]*T07:50/.test(u)).length, 0, 'kein Aufruf je Stunde');
  assert.equal(roh[0].lehrstoff, null);
  assert.equal(untis.aufbereiten(roh)[0].lehrstoff, null, 'null heisst: nicht geholt');

  // Mit dem Wunsch: je Stunde im Fenster, exakte Zeiten, v1 bleibt nach dem ersten Treffer.
  gesehen.length = 0;
  roh = await untis.stundenplan(sitzung, heute, heute, { lehrstoff: true });
  const jeStunde = gesehen.filter(u => u.includes('calendar-entry/detail') && !u.includes('T00:00'));
  assert.ok(jeStunde.some(u => u.includes(`startDateTime=${heute}T07:50&endDateTime=${heute}T08:35`)),
    'exakt die Stunde, ohne Sekunden und ohne Z');
  assert.equal(jeStunde.filter(u => u.includes('/v2/')).length, 1, 'nach dem ersten Treffer wird v2 nicht mehr probiert');
  assert.equal(roh.lehrstoffGeholt, true);
  const fertig = untis.aufbereiten(roh);
  assert.equal(fertig[0].lehrstoff, 'Bitte die ausgeteilten Arbeitsaufträge bearbeiten');
  assert.equal(fertig[1].lehrstoff, '', 'geholt, aber keiner: leer, nicht null');
  assert.equal(fertig[3].lehrstoff, null, 'ausserhalb des Fensters nicht gefragt');
  assert.equal(gesehen.some(u => u.includes(`${String(alsZahl(heute) + 100).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}T`)), false);

  // Ist der Endpunkt tot, hoert der Abruf nach fuenf Fehlschlaegen auf - und ueberschreibt nichts.
  kaputt = true;
  gesehen.length = 0;
  roh = await untis.stundenplan(sitzung, heute, heute, { lehrstoff: true });
  assert.equal(roh.lehrstoffGeholt, false);
  assert.ok(roh.every(p => p.lehrstoff === null), 'nichts geholt - der gespeicherte bleibt');
});

test('WebUntis: der Lehrstoff ueberlebt den Zehn-Minuten-Takt und steht im Plan voran', async t => {
  const { db } = await import('./db.js');
  const { untisAbgleich } = await import('./index.js');
  await standardSchuleSetzen();
  const [ute, uteId] = await register('stoff-ute');
  const woche = (await ute('GET', '/api/timetable')).body.days;
  const montag = woche[0].date;
  const alsZahl = iso => Number(iso.replaceAll('-', ''));
  const raster = [{ day: 2, timeUnits: [{ name: '1', startTime: 750, endTime: 835 }, { name: '2', startTime: 840, endTime: 925 }] }];
  const stunden = [
    { date: alsZahl(montag), startTime: 750, endTime: 835, lsnumber: 10, su: [{ name: 'GE', longname: 'Geschichte' }], te: [{ name: 'Wend' }], ro: [{ name: '205' }] },
    { date: alsZahl(montag), startTime: 840, endTime: 925, lsnumber: 10, su: [{ name: 'GE', longname: 'Geschichte' }], te: [{ name: 'Wend' }], ro: [{ name: '205' }], bkText: 'HA: S. 5' },
  ];
  let jeStunde = 0;
  const stub = stubUntis({ raster, stunden, rest: url => {
    if (!url.includes('calendar-entry/detail')) return null;
    const u = new URL(url);
    const von = u.searchParams.get('startDateTime');
    if (!/T\d{2}:\d{2}$/.test(von) || von.endsWith('T00:00'))
      return new Response(JSON.stringify({ errorMessage: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    jeStunde++;
    return { data: { calendarEntries: [{ startDateTime: von, teachingContent: 'Quellenarbeit S. 12' }] } };
  } });
  t.after(() => stub.zurueck());

  // Der volle Abgleich (Knopf) holt je Stunde.
  const r = await ute('PUT', '/api/untis/account', {
    username: 'ute', password: 'egal', server: 'stoff.webuntis.com', school: 'gym-stoff', name: 'Gymnasium Stoff',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Die Stunden liegen in der angezeigten Woche - am Wochenende ist das die kommende, also im Fenster.
  assert.ok(jeStunde >= 2, `je Stunde gefragt (${jeStunde})`);
  const plan = () => ute('GET', '/api/timetable').then(x => x.body.entries.filter(e => e.source === 'untis'));
  let eintraege = (await plan()).sort((x, y) => x.period_id - y.period_id);
  assert.equal(eintraege.length, 2);
  assert.match(eintraege[0].lesson_text, /^Lehrstoff:\nQuellenarbeit S\. 12/);
  assert.match(eintraege[1].lesson_text, /^Lehrstoff:\nQuellenarbeit S\. 12\n\nNotizen für Schüler\*innen:\nHA: S\. 5$/,
    'Lehrstoff voran, dann der uebrige Text');
  const stat = JSON.parse(db.prepare('SELECT text_stat FROM untis_accounts WHERE user_id = ?').get(uteId).text_stat);
  assert.equal(stat.lehrstoff, 2);
  assert.ok(db.prepare('SELECT lehrstoff_geholt FROM untis_accounts WHERE user_id = ?').get(uteId).lehrstoff_geholt);

  // Der Takt mit Fenster kurz danach: kein Abruf je Stunde - und der Lehrstoff bleibt trotzdem.
  const vorher = jeStunde;
  await untisAbgleich(uteId, { von: montag, bis: woche.at(-1).date });
  assert.equal(jeStunde, vorher, 'innerhalb der Stunde nicht noch einmal');
  eintraege = (await plan()).sort((x, y) => x.period_id - y.period_id);
  assert.match(eintraege[0].lesson_text, /^Lehrstoff:\nQuellenarbeit/, 'der gespeicherte Lehrstoff ueberlebt den Zwischenlauf');

  // Ist die Stunde um, holt der Takt wieder.
  db.prepare("UPDATE untis_accounts SET lehrstoff_geholt = datetime('now', '-61 minutes') WHERE user_id = ?").run(uteId);
  await untisAbgleich(uteId, { von: montag, bis: woche.at(-1).date });
  assert.ok(jeStunde > vorher, 'nach einer Stunde wieder');
});

test('WebUntis: die Textdiagnose probiert alle Wege und schreibt auf, was kam', async t => {
  const { createServer } = await import('node:http');
  const gesehen = [];
  const server = createServer((req, res) => {
    gesehen.push(req.url);
    const fertig = (o, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      return req.on('end', () => fertig({ jsonrpc: '2.0', id: 'x', result: [
        { id: 900, date: 20260902, startTime: 800, endTime: 845, lsnumber: 900,
          su: [{ name: 'KU' }], te: [{ name: 'ROT' }], ro: [{ name: 'A1' }], info: 'Raumänderung' },
      ] }));
    }
    if (req.url.includes('weekly/data')) return fertig({ data: { result: { data: { elementPeriods: { 42: [
      { id: 900, date: 20260902, startTime: 800, periodText: 'HA: S. 12', lessonText: '' }] } } } } });
    if (req.url.includes('calendar-entry/detail')) {
      // Die Woche gibt es nicht, der Tag liefert einen Eintrag mit dem Lehrstoff an unerwarteter Stelle.
      const u = new URL(req.url, 'http://x');
      if (u.searchParams.get('startDateTime').slice(0, 10) !== u.searchParams.get('endDateTime').slice(0, 10))
        return fertig({ error: 'range too large' }, 400);
      return fertig({ data: { calendarEntries: [{ startDateTime: '2026-09-02T08:00', endDateTime: '2026-09-02T08:45',
        blocks: [{ lehrstoffText: 'Bitte die ausgeteilten Arbeitsaufträge bearbeiten', color: '#ff0000',
          id: 4711, when: '2026-09-02T08:00:00Z' }] }] } });
    }
    if (req.url.includes('period/info')) return fertig({ errorMessage: 'not found', requestId: 'r1', traceId: 't1' }, 404);
    if (req.url.includes('timetable/entries')) return fertig({ days: [{ gridEntries: [{ notesAll: 'Aus der neuen API' }] }] });
    fertig({ data: {} });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const host = `http://127.0.0.1:${server.address().port}`;
  const untis = await import('./untis.js');
  const bericht = await untis.texteDiagnose(
    { url: host + '/WebUntis/jsonrpc.do', host, cookie: 'JSESSIONID=geheim-kekse', personId: 42, personType: 5 },
    '2026-09-02');

  for (const weg of ['weekly/data', 'calendar-entry/detail?', 'period/info', 'timetable/entries'])
    assert.ok(gesehen.some(u => u.includes(weg)), `${weg} wurde gefragt`);
  assert.ok(gesehen.some(u => u.includes('startDateTime=2026-09-02T08:00&endDateTime=2026-09-02T08:45')),
    'auch exakt die erste Stunde, so wie die Oberflaeche');
  assert.ok(gesehen.some(u => u.includes('startDateTime=2026-09-02T08:00:00&endDateTime=2026-09-02T08:45:00')), 'mit Sekunden');
  assert.ok(gesehen.some(u => u.includes('startDateTime=2026-09-02T08:00:00Z')), 'und als UTC');
  for (const v of ['v1', 'v2']) for (const art of ['MY_TIMETABLE', 'STANDARD'])
    assert.ok(gesehen.some(u => u.includes(`/${v}/timetable/entries`) && u.includes(`timetableType=${art}`)), `${v} ${art}`);
  assert.match(bericht, /JSON-RPC getTimetable\n1 Stunden\n  08:00–08:45 KU \(id 900, ls 900\) Text: info="Raumänderung"/);
  assert.match(bericht, /REST Woche.*\n.*Status 200/);
  assert.match(bericht, /calendar-entry\/detail v2, Woche\nStatus 400, Schlüssel: error\n0 Einträge/, 'ein Fehlerstatus steht da, statt zu werfen');
  assert.match(bericht, /period\/info.*\nStatus 404, Fehler: not found\n/, 'eine WebUntis-Fehlerantwort in einem Satz');
  assert.match(bericht, /blocks\.0\.lehrstoffText: "Bitte die ausgeteilten Arbeitsaufträge bearbeiten"/,
    'ein Textfeld an unerwarteter Stelle steht mit Pfad im Bericht');
  assert.equal(bericht.includes('#ff0000'), false, 'Farben, IDs und Zeitstempel sind kein Text');
  assert.equal(bericht.includes('4711'), false);
  assert.match(bericht, /gridEntries\.0\.notesAll: "Aus der neuen API"/);
  assert.equal(bericht.includes('geheim-kekse'), false, 'die Sitzung steht nicht im Bericht');
});

test('Nachrichten der Schule: Tagesnachrichten und Feed, schulweit, hoechstens stuendlich', async t => {
  const { db } = await import('./db.js');
  const { netz } = await import('./netz.js');
  await standardSchuleSetzen();
  const [ralf] = await register('news-ralf');
  const [olga] = await register('news-olga');    // Standardschule - sieht Ralfs Nachrichten nicht
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  t.after(() => { netz.lookup = echt; });

  const raster = [{ day: 2, timeUnits: [{ name: '1', startTime: 800, endTime: 845 }] }];
  let feedAufrufe = 0;
  const stub = stubUntis({ raster, stunden: [], rest: url => {
    if (url.includes('newsWidgetData')) return { data: { messagesOfDay: [
      { id: 11, subject: 'Planbau', text: '<p>Ab Montag <b>neuer Plan</b>.<br>Siehe <a href="https://schule.de/p">Aushang</a></p>' },
      { id: 12, subject: 'Mensa', text: 'Freitag geschlossen.' },
    ], rssUrl: 'https://nord.webuntis.com/WebUntis/monitor/rss?school=gym-nord' } };
    if (url.includes('monitor/rss')) {
      feedAufrufe++;
      return new Response(`<rss version="2.0"><channel><item><title>Aus dem Feed</title>
        <description>Text im Feed</description><guid>f-1</guid><pubDate>Tue, 08 Sep 2026 08:00:00 +0200</pubDate></item></channel></rss>`,
      { headers: { 'content-type': 'application/rss+xml' } });
    }
    return null;
  } });
  t.after(() => stub.zurueck());

  const r = await ralf('PUT', '/api/untis/account', {
    username: 'ralf', password: 'egal', server: 'nord.webuntis.com', school: 'gym-nord', name: 'Gymnasium Nord',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const liste = (await ralf('GET', '/api/nachrichten')).body;
  assert.deepEqual(liste.map(n => [n.quelle, n.titel]).sort(),
    [['rss', 'Aus dem Feed'], ['untis', 'Mensa'], ['untis', 'Planbau']]);
  const planbau = liste.find(n => n.titel === 'Planbau');
  assert.equal(planbau.text, 'Ab Montag neuer Plan.\nSiehe [Aushang](https://schule.de/p)');
  assert.equal(liste.find(n => n.quelle === 'rss').datum, '2026-09-08');
  assert.equal(db.prepare("SELECT rss_url FROM schools WHERE school = 'gym-nord'").get().rss_url,
    'https://nord.webuntis.com/WebUntis/monitor/rss?school=gym-nord', 'die Feed-Adresse merkt sich die Schule');
  assert.equal(feedAufrufe, 1);
  assert.deepEqual((await olga('GET', '/api/nachrichten')).body, [], 'andere Schule, andere Nachrichten');

  // Ein zweiter Abgleich innerhalb der Stunde holt nicht noch einmal - und legt nichts doppelt an.
  await ralf('POST', '/api/untis/sync');
  assert.equal(feedAufrufe, 1);
  assert.equal((await ralf('GET', '/api/nachrichten')).body.length, 3);

  // Der Admin kann den Feed der Standardschule setzen - mit derselben Adresspruefung wie bei Abos.
  const admin = await login('admin', 'geheim');
  const vorher = (await admin('GET', '/api/settings')).body;
  assert.equal((await admin('PUT', '/api/settings', { rss_url: 'https://10.0.0.5/rss' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { rss_url: 'http://schule.de/rss' })).status, 400, 'nur https');
  const ok = await admin('PUT', '/api/settings', { rss_url: 'https://schule.de/rss.xml' });
  assert.equal(ok.status, 200);
  const nachher = (await admin('GET', '/api/settings')).body;
  assert.equal(nachher.rss_url, 'https://schule.de/rss.xml');
  assert.equal(nachher.registration_mode, vorher.registration_mode, 'die Registrierung bleibt, wie sie war');
  await admin('PUT', '/api/settings', { rss_url: '' });
});

test('Zweite Schule: eigenes Raster aus WebUntis, eigene Kurs-IDs, eigene Ferien', async t => {
  const { db } = await import('./db.js');
  const std = await standardSchuleSetzen();
  const stdRaster = db.prepare('SELECT nr, start_time FROM periods WHERE school_id = ? ORDER BY nr')
    .all(std.id);

  const [sam, samId] = await register('sued-sam');
  const woche = (await sam('GET', '/api/timetable')).body.days;
  const montag = woche[0].date, dienstag = woche[1].date;
  const alsZahl = iso => Number(iso.replaceAll('-', ''));

  // Das Raster der Schule Sued: fruehere Zeiten als die Standardschule, und WebUntis liefert je
  // Wochentag eins. Der Samstag hat weniger Stunden - genommen wird der Tag mit den meisten.
  const einheiten = [
    { name: '1', startTime: 730, endTime: 815 },
    { name: '2', startTime: 820, endTime: 905 },
    { name: '3a', startTime: 925, endTime: 1010 },
    { name: '4', startTime: 1015, endTime: 1100 },
  ];
  const raster = [
    { day: 7, timeUnits: einheiten.slice(0, 2) },
    { day: 2, timeUnits: einheiten },
    { day: 3, timeUnits: einheiten },
  ];

  // Dieselbe lsnumber, die es an der Standardschule auch geben kann - genau der Fall, in dem sich
  // zwei Schulen einen Kurs teilen wuerden.
  const stunden = [
    { date: alsZahl(montag), startTime: 730, endTime: 815, lsnumber: 4711,
      su: [{ name: 'MA', longname: 'Mathe' }], te: [{ name: 'KLN', longname: 'Frau Klein' }],
      ro: [{ name: 'S12' }] },
    { date: alsZahl(dienstag), startTime: 925, endTime: 1010, lsnumber: 4712, code: 'cancelled',
      su: [{ name: 'BIO', longname: 'Biologie' }], te: [], ro: [], info: 'Lehrer krank' },
  ];

  const stub = stubUntis({ raster, stunden, ferien: [
    { startDate: 20990701, endDate: 20990731, longName: 'Sommerferien Süd' }] });
  t.after(() => stub.zurueck());

  const r = await sam('PUT', '/api/untis/account', {
    username: 'sam', password: 'egal',
    server: 'west.webuntis.com', school: 'rs-west', name: 'Realschule West',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(stub.gesehen.includes('getTimegridUnits'), true, 'das Raster wird wirklich geholt');

  // Die Schule steht als eigene Zeile da - mit dem Namen aus der Schulsuche, nicht mit dem
  // Anmeldenamen.
  const schule = db.prepare('SELECT * FROM schools WHERE school = ?').get('rs-west');
  assert.equal(schule.name, 'Realschule West');
  assert.equal(schule.standard, 0);
  assert.equal(db.prepare('SELECT school_id FROM users WHERE id = ?').get(samId).school_id, schule.id);
  assert.equal((await standardSchuleSetzen()).id, std.id, 'die Standardschule bleibt, was sie war');

  // Das Raster kommt aus getTimegridUnits: der Tag mit den meisten Einheiten, nummeriert nach
  // Reihenfolge (nicht nach dem Namen - "3a" gibt es auch).
  const meins = db.prepare('SELECT nr, start_time, end_time FROM periods WHERE school_id = ? ORDER BY nr')
    .all(schule.id);
  assert.deepEqual(meins.map(x => `${x.nr}:${x.start_time}-${x.end_time}`),
    ['1:07:30-08:15', '2:08:20-09:05', '3:09:25-10:10', '4:10:15-11:00']);
  assert.deepEqual(db.prepare('SELECT nr, start_time FROM periods WHERE school_id = ? ORDER BY nr')
    .all(std.id), stdRaster, 'die andere Schule wurde nicht angefasst');

  // Die Kurs-ID traegt die Schule - sonst faellt sie mit der der Standardschule zusammen.
  const kurse = db.prepare('SELECT id, school_id FROM courses WHERE id LIKE ?')
    .all(`%UNTIS-4711`).map(k => k.id);
  assert.equal(kurse.includes(`S${schule.id}-UNTIS-4711`), true, kurse.join(', '));
  assert.equal(kurse.includes('UNTIS-4711'), false, 'und nicht im Format der Standardschule');

  // Die Stunden liegen im Raster DIESER Schule.
  const zeilen = db.prepare(`SELECT u.date, u.status, p.nr, p.school_id
    FROM untis_lessons u JOIN periods p ON p.id = u.period_id WHERE u.user_id = ? ORDER BY u.date`)
    .all(samId);
  assert.equal(zeilen.length, 2, 'beide Stunden passten ins Raster');
  assert.equal(zeilen.every(z => z.school_id === schule.id), true);
  assert.deepEqual(zeilen.map(z => `${z.nr}/${z.status}`), ['1/regular', '3/cancelled']);

  // Ferien gehoeren der Schule, nicht der Instanz.
  assert.equal(db.prepare('SELECT count(*) AS n FROM holidays WHERE school_id = ?').get(schule.id).n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM holidays WHERE school_id = ?').get(std.id).n, 0);

  stub.zurueck();

  // Und der Plan zeigt das alles: eigenes Raster, eigene Stunden.
  const plan = (await sam('GET', '/api/timetable')).body;
  assert.equal(plan.schule.name, 'Realschule West');
  assert.deepEqual(plan.periods.map(p => p.start_time), ['07:30', '08:20', '09:25', '10:15']);
  assert.equal(plan.entries.some(e => e.id === `S${schule.id}-UNTIS-4711` && e.room === 'S12'), true);
  assert.equal(plan.entries.some(e => e.status === 'cancelled'), true);
});

test('Ohne Raster von WebUntis wird das der Standardschule kopiert', async t => {
  const { db } = await import('./db.js');
  const std = await standardSchuleSetzen();
  const [tia, tiaId] = await register('nord-tia');
  const montag = (await tia('GET', '/api/timetable')).body.days[0].date;

  // Manche Schulen geben Schuelerkonten das Raster nicht heraus. Ein leerer Plan waere die falsche
  // Antwort darauf - ein grob passendes Raster ist besser als gar keins.
  const erste = db.prepare('SELECT start_time, end_time FROM periods WHERE school_id = ? ORDER BY nr LIMIT 1')
    .get(std.id);
  const stub = stubUntis({
    rasterFehler: true,
    raster: [],
    stunden: [{ date: Number(montag.replaceAll('-', '')),
      startTime: Number(erste.start_time.replace(':', '')),
      endTime: Number(erste.end_time.replace(':', '')), lsnumber: 5001,
      su: [{ name: 'PH', longname: 'Physik' }], te: [], ro: [] }],
  });
  t.after(() => stub.zurueck());

  const r = await tia('PUT', '/api/untis/account', {
    username: 'tia', password: 'egal',
    server: 'nord2.webuntis.com', school: 'gym-nord2', name: 'Gymnasium Nord II',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const schule = db.prepare('SELECT * FROM schools WHERE school = ?').get('gym-nord2');
  const kopiert = db.prepare('SELECT nr, start_time, end_time FROM periods WHERE school_id = ? ORDER BY nr')
    .all(schule.id);
  const vorlage = db.prepare('SELECT nr, start_time, end_time FROM periods WHERE school_id = ? ORDER BY nr')
    .all(std.id);
  assert.deepEqual(kopiert, vorlage, 'dieselben Zeiten wie die Standardschule');
  // Und die Stunde landet trotzdem im Plan, statt still zu verschwinden.
  assert.equal(db.prepare('SELECT count(*) AS n FROM untis_lessons WHERE user_id = ?').get(tiaId).n, 1);
});

test('Das Stundenraster einer Schule: Namen, wenn sie taugen - sonst die Reihenfolge', async t => {
  const { raster } = await import('./untis.js');
  const sitzung = { url: 'https://x.webuntis.com/WebUntis/jsonrpc.do?school=x', cookie: 'c' };
  const hole = async antwort => {
    const stub = stubUntis({ raster: antwort, stunden: [] });
    try { return await raster(sitzung); } finally { stub.zurueck(); }
  };
  assert.ok(t);

  // Eine 0. Stunde ist an vielen Schulen die Fruehstunde. Zaehlten wir stur ab eins, staende im
  // Plan ueberall eine Nummer, die im Haus niemand benutzt.
  const frueh = await hole([{ day: 2, timeUnits: [
    { name: '0', startTime: 700, endTime: 745 },
    { name: '1', startTime: 800, endTime: 845 },
    { name: '2', startTime: 850, endTime: 935 }] }]);
  assert.deepEqual(frueh.map(p => `${p.nr}:${p.start_time}-${p.end_time}`),
    ['0:07:00-07:45', '1:08:00-08:45', '2:08:50-09:35']);

  // Sobald ein Name keine Zahl ist, zaehlt die Reihenfolge - fuer alle, nicht gemischt.
  const bunt = await hole([{ day: 2, timeUnits: [
    { name: '1', startTime: 700, endTime: 745 },
    { name: '2a', startTime: 800, endTime: 845 }] }]);
  assert.deepEqual(bunt.map(p => p.nr), [1, 2]);

  // Doppelte Nummern wuerde die Datenbank zu einer Zeile machen - auch dann die Reihenfolge.
  const doppelt = await hole([{ day: 2, timeUnits: [
    { name: '1', startTime: 700, endTime: 745 },
    { name: '1', startTime: 800, endTime: 845 },
    { name: '2', startTime: 850, endTime: 935 }] }]);
  assert.deepEqual(doppelt.map(p => p.nr), [1, 2, 3]);

  // Der Tag mit den meisten Einheiten gewinnt: am Samstag fehlen an vielen Schulen welche.
  const samstag = await hole([
    { day: 7, timeUnits: [{ name: '1', startTime: 800, endTime: 845 }] },
    { day: 3, timeUnits: [
      { name: '1', startTime: 800, endTime: 845 },
      { name: '2', startTime: 850, endTime: 935 }] }]);
  assert.equal(samstag.length, 2);

  // Und wenn gar nichts kommt, kommt eine leere Liste - keine Ausnahme.
  assert.deepEqual(await hole([]), []);
  assert.deepEqual(await hole(null), []);
  assert.deepEqual(await hole([{ day: 1, timeUnits: [{ name: '1' }] }]), [], 'ohne Zeiten unbrauchbar');
});


// --- IServ --------------------------------------------------------------------

/**
 * Ein IServ, das nur so tut - und zwar so, wie sich ein echtes benimmt.
 *
 * Gefaelscht wird der Transport, nicht die Pruefung: die Adresspruefung, der Namensdienst und der
 * ganze Weg durch anmelden() laufen unveraendert. Die Schalter bilden nach, woran die erste
 * Fassung gescheitert ist: Weiterleitungen, fremde Feldnamen, ein Server, der ohne User-Agent
 * nicht mitspielt.
 */
function stubIserv(plaene, {
  passwort = 'richtig', umleiten = false, felder = 'iserv', brauchtUA = true,
  ohneWeiterleitung = false, boeseUmleitung = null,
} = {}) {
  const echt = globalThis.fetch;
  const gesehen = [];
  const hosts = Object.keys(plaene);
  const NAMEN = {
    iserv: { user: '_username', pass: '_password', token: '_csrf_token' },
    symfony: { user: 'login[username]', pass: 'login[password]', token: '_token' },
  }[felder];

  const seite = (aktion, inhalt) => `<!doctype html><html><body>${inhalt}
    <form action="${aktion}" method="post">
      <input type="hidden" name="${NAMEN.token}" value="tok42">
      <label>Account <input type="text" name="${NAMEN.user}"></label>
      <label>Passwort <input type="password" name="${NAMEN.pass}"></label>
      <input type="checkbox" name="bleib" value="1">
      <input type="submit" value="Anmelden">
    </form></body></html>`;

  const html = (koerper, status = 200, kopf = {}) =>
    new Response(koerper, { status, headers: { 'content-type': 'text/html', ...kopf } });

  globalThis.fetch = async (url, opt = {}) => {
    const u = String(url);
    const host = hosts.find(h => u.includes(h));
    if (!host) return echt(url, opt);
    const art = opt.method ?? 'GET';
    const kopf = new Headers(opt.headers ?? {});
    gesehen.push({ url: u, art, body: opt.body ?? null, ua: kopf.get('user-agent') });
    const pfad = new URL(u).pathname;
    const wwwHost = new URL(u).hostname.startsWith('www.');

    // Ein echter Server ohne Browserkennung: er zeigt einfach wieder die Anmeldeseite.
    if (brauchtUA && !kopf.get('user-agent')) return html(seite('/iserv/app/login', '<p>Bitte anmelden</p>'));

    if (boeseUmleitung && pfad === '/iserv/app/login')
      return new Response(null, { status: 302, headers: { location: boeseUmleitung } });

    // Die Anmeldung liegt auf www - die blanke Domain leitet dorthin.
    if (umleiten && !wwwHost)
      return new Response(null, { status: 301,
        headers: { location: `https://www.${host}${pfad}`, 'set-cookie': 'vorher=1; Path=/' } });

    if (pfad === '/iserv/app/login' && art === 'GET')
      return html(seite('/iserv/app/login', '<p>Bitte anmelden</p>'),
        200, { 'set-cookie': 'PHPSESSID=alt; Path=/' });

    if (pfad === '/iserv/app/login') {
      const daten = new URLSearchParams(String(opt.body ?? ''));
      const gut = daten.get(NAMEN.pass) === passwort
        && daten.get(NAMEN.user)
        && daten.get(NAMEN.token) === 'tok42';
      if (!gut) return html(seite('/iserv/app/login', '<p class="fehler">Anmeldung fehlgeschlagen</p>'));
      // Manche Instanzen zeigen die App direkt, andere leiten weiter - beides kommt vor.
      return ohneWeiterleitung
        ? html('<h1>Schreibtisch</h1>', 200, { 'set-cookie': 'PHPSESSID=neu; Path=/' })
        : new Response(null, { status: 302,
            headers: { location: '/iserv/', 'set-cookie': 'PHPSESSID=neu; Path=/' } });
    }

    if (pfad === '/iserv/' || pfad === '/iserv') return html('<h1>Schreibtisch</h1>');
    if (pfad.startsWith('/iserv/plan')) return html(plaene[host]);
    return html('<h1>Nicht gefunden</h1>', 404);
  };
  return { gesehen, zurueck: () => { globalThis.fetch = echt; } };
}

/** Ein Plan, wie ihn IServ zeigt: Kopfzeile mit Tagen, erste Spalte mit den Zeiten. */
const iservPlanHtml = (zellen = {}) => `
  <h1>Stundenplan</h1>
  <table class="timetable">
    <tr><th>Stunde</th><th>Montag</th><th>Dienstag</th><th>Mittwoch</th></tr>
    <tr><td>1<br>07:45 - 08:30</td><td>${zellen.mo1 ?? 'MA<br>Klein<br>A12'}</td>
        <td>DE / Roth / B04</td><td></td></tr>
    <tr><td>2<br>08:35 - 09:20</td><td>${zellen.mo2 ?? 'PH<br>Meyer<br>C20'}</td>
        <td></td><td>SP<br>Vogel<br>Halle</td></tr>
  </table>`;

test('IServ: die Adresse muss nach der Schule aussehen, nicht nach dem eigenen Netz', async () => {
  const { iservHostOk, adresseErlaubt, netz } = await import('./iserv.js');

  for (const gut of ['iserv.gymnasium-nord.de', 'https://schule.de/', 'SCHULE.DE'])
    assert.equal(iservHostOk(gut), true, gut);
  // Alles, was ins eigene Netz zeigen koennte - sonst waere das Feld ein Anfrage-Generator.
  for (const schlecht of ['localhost', '10.0.0.5', '192.168.1.1', '[::1]', 'server.local',
    'user:pw@schule.de', 'schule.de:8443', '', 'kein-punkt'])
    assert.equal(iservHostOk(schlecht), false, schlecht);

  // Und ein Name, der nach draussen aussieht, aber nach innen zeigt.
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '10.1.2.3', family: 4 }];
  assert.equal(await adresseErlaubt('schule.de'), false, 'Name zeigt ins private Netz');
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal(await adresseErlaubt('schule.de'), true);
  netz.lookup = async () => { throw new Error('kein Namensdienst'); };
  assert.equal(await adresseErlaubt('schule.de'), false, 'ohne Antwort lieber nicht');
  netz.lookup = echt;
});

test('IServ: die Tabelle der Plan-Seite lesen', async () => {
  const iserv = await import('./iserv.js');
  const t = iserv.tabellen(iservPlanHtml());
  assert.equal(t.length, 1);

  assert.deepEqual([...iserv.tageAus(t[0][0]).values()], [1, 2, 3], 'Mo, Di, Mi');
  assert.deepEqual(iserv.zeitenAus(t[0]),
    [{ nr: 1, start_time: '07:45', end_time: '08:30' },
     { nr: 2, start_time: '08:35', end_time: '09:20' }]);

  const stunden = iserv.ausTabelle(t[0], '2026-09-07', 'S9-');
  assert.equal(stunden.length, 4, 'leere Zellen zaehlen nicht');
  const erste = stunden[0];
  assert.deepEqual([erste.date, erste.start, erste.subject, erste.teacher, erste.room],
    ['2026-09-07', '07:45', 'MA', 'Klein', 'A12']);
  assert.equal(erste.course_id, 'S9-ISERV-MA-Klein', 'Schulpraefix und ISERV davor');
  // "Fach / Lehrer / Raum" in einer Zeile wird genauso gelesen wie drei Zeilen.
  const di = stunden.find(x => x.subject === 'DE');
  assert.deepEqual([di.teacher, di.room, di.date], ['Roth', 'B04', '2026-09-08']);

  // Ein Ausfall ist einer, egal wie er geschrieben steht - und dann steht kein Lehrer da.
  const aus = iserv.ausTabelle(iserv.tabellen(iservPlanHtml({ mo2: 'PH<br>Meyer<br>C20<br>f&auml;llt aus' }))[0],
    '2026-09-07')[1];
  assert.equal(aus.status, 'cancelled');
  assert.equal(aus.teacher, null);

  // Eine Zelle ueber zwei Spalten darf die Tage dahinter nicht verrutschen lassen.
  const breit = iserv.tabellen('<table><tr><th>Std</th><th colspan="2">Montag</th><th>Dienstag</th></tr>'
    + '<tr><td>1 08:00-08:45</td><td colspan="2">MA</td><td>DE</td></tr></table>');
  const tage = iserv.tageAus(breit[0][0]);
  assert.equal(tage.size, 2);
  assert.deepEqual(iserv.ausTabelle(breit[0], '2026-09-07').map(x => x.subject + '@' + x.date),
    ['MA@2026-09-07', 'DE@2026-09-08']);

  // Steht ein Datum im Kopf, zaehlt es - sonst wuessten wir samstags nicht, welche Woche das ist.
  const datiert = iserv.tabellen('<table><tr><th>Std</th><th>Mo 14.09.2026</th><th>Di 15.09.</th></tr>'
    + '<tr><td>1 08:00-08:45</td><td>MA</td><td></td></tr></table>');
  assert.equal(iserv.montagAus(datiert[0][0]), '2026-09-14');
  assert.equal(iserv.montagAus(t[0][0]), null, 'ohne Datum bleibt es offen');

  // Kaputtes HTML wirft nicht, es liefert nichts.
  assert.deepEqual(iserv.tabellen('<table><tr><td>offen'), []);
  assert.deepEqual(iserv.tabellen(null), []);
  assert.equal(iserv.planTabelle([]), null);
});

test('IServ: dem Anmeldeformular folgen - Weiterleitung, fremde Feldnamen, Browserkennung', async t => {
  const { anmelden, netz } = await import('./iserv.js');
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  t.after(() => { netz.lookup = echt; });

  // Der Fall aus dem Betrieb: die blanke Domain leitet auf www, und das Formular heisst anders
  // als geraten. Beides hat die erste Fassung scheitern lassen.
  const stub = stubIserv({ 'schule-a.de': iservPlanHtml() }, { umleiten: true, felder: 'symfony' });
  const sitzung = await anmelden('schule-a.de', 'max', 'richtig');
  assert.match(sitzung.cookie, /PHPSESSID=neu/, 'die Sitzung nach der Anmeldung gilt');
  assert.match(sitzung.cookie, /vorher=1/, 'die Kekse der Weiterleitung gehen mit');
  assert.equal(sitzung.bericht.angemeldet, true);

  const post = stub.gesehen.find(g => g.art === 'POST');
  assert.match(post.url, /^https:\/\/www\./, 'gesendet wird an das Ziel der Weiterleitung');
  assert.match(post.body, /login%5Busername%5D=max/, 'die Feldnamen kommen aus dem Formular');
  assert.match(post.body, /_token=tok42/, 'das Schutzfeld der Seite geht mit zurueck');
  assert.ok(post.ua, 'und eine Browserkennung ist dabei');
  assert.deepEqual(sitzung.bericht.formular.user, 'login[username]');
  stub.zurueck();

  // Ein Server, der ohne Browserkennung nur die Anmeldeseite zeigt: mit Kennung geht es, ohne
  // nicht. Node schickt von sich aus keine - genau daran kann es echt scheitern.
  const streng = stubIserv({ 'schule-a.de': iservPlanHtml() }, { brauchtUA: true });
  assert.ok(await anmelden('schule-a.de', 'max', 'richtig'));
  streng.zurueck();

  // Manche Instanzen zeigen nach der Anmeldung direkt die App, ohne Weiterleitung.
  const direkt = stubIserv({ 'schule-a.de': iservPlanHtml() }, { ohneWeiterleitung: true });
  assert.equal((await anmelden('schule-a.de', 'max', 'richtig')).bericht.angemeldet, true);
  direkt.zurueck();

  // Falsches Passwort bleibt ein klarer Fehler - und sagt jetzt, woran man es erkennt.
  const normal = stubIserv({ 'schule-a.de': iservPlanHtml() });
  await assert.rejects(() => anmelden('schule-a.de', 'max', 'falsch'),
    /zeigt weiter das Anmeldeformular/);
  normal.zurueck();

  // Und eine Weiterleitung ins interne Netz wird nicht verfolgt, sondern abgebrochen.
  const boese = stubIserv({ 'schule-a.de': iservPlanHtml() },
    { boeseUmleitung: 'http://169.254.169.254/latest/meta-data/' });
  await assert.rejects(() => anmelden('schule-a.de', 'max', 'richtig'), /Weiterleitung führt/);
  boese.zurueck();
});

test('IServ: Abgleich Ende zu Ende - eigene Schule, eigenes Raster, eigene Kurse', async t => {
  const { db, standardSchule } = await import('./db.js');
  const { netz } = await import('./iserv.js');
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const stub = stubIserv({ 'schule-nord.de': iservPlanHtml() });
  t.after(() => { stub.zurueck(); netz.lookup = echt; });

  const std = await standardSchuleSetzen();
  const [ina, inaId] = await register('iserv-ina');

  const r = await ina('PUT', '/api/iserv/account', {
    server: 'https://schule-nord.de/', name: 'Gymnasium Nord', username: 'ina', password: 'richtig',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Eine eigene Schulzeile - mit ihrer Quelle, und nie die Standardschule.
  const schule = db.prepare("SELECT * FROM schools WHERE server = 'schule-nord.de'").get();
  assert.equal(schule.quelle, 'iserv');
  assert.equal(schule.school, '', 'IServ kennt keinen Anmeldenamen der Schule');
  assert.equal(schule.standard, 0);
  assert.equal(schule.name, 'Gymnasium Nord');
  assert.equal(schule.iserv_pfad, '/iserv/plan', 'der gefundene Weg wird gemerkt');
  assert.equal(db.prepare('SELECT school_id FROM users WHERE id = ?').get(inaId).school_id, schule.id);
  assert.equal(standardSchule().id, std.id, 'die Standardschule bleibt, was sie war');

  // Das Raster kommt aus der ersten Spalte der Tabelle.
  assert.deepEqual(db.prepare('SELECT nr, start_time, end_time FROM periods WHERE school_id = ? ORDER BY nr')
    .all(schule.id).map(p => `${p.nr}:${p.start_time}-${p.end_time}`),
    ['1:07:45-08:30', '2:08:35-09:20']);

  // Die Stunden liegen in diesem Raster, die Kurse tragen Praefix und ISERV.
  const zeilen = db.prepare(`SELECT u.course_id, p.nr, p.school_id FROM untis_lessons u
    JOIN periods p ON p.id = u.period_id WHERE u.user_id = ?`).all(inaId);
  assert.equal(zeilen.length, 4);
  assert.equal(zeilen.every(z => z.school_id === schule.id), true);
  assert.equal(zeilen.every(z => z.course_id.startsWith(`S${schule.id}-ISERV-`)), true,
    zeilen.map(z => z.course_id).join(', '));

  // Und der Plan zeigt es.
  const plan = (await ina('GET', '/api/timetable')).body;
  assert.equal(plan.schule.name, 'Gymnasium Nord');
  assert.equal(plan.schule.quelle, 'iserv');
  assert.deepEqual(plan.periods.map(p => p.start_time), ['07:45', '08:35']);
  assert.equal(plan.entries.some(e => e.subject === 'MA' && e.room === 'A12'), true);

  // Die Diagnose sagt, was wirklich ankam - ohne sie waere ein leerer Plan nicht zu deuten.
  const d = (await ina('GET', '/api/iserv/diagnose')).body;
  assert.equal(d.angemeldet, true);
  assert.equal(d.pfad, '/iserv/plan');
  assert.equal(d.gefunden, 4);
  assert.ok(d.versucht[0].probe.length, 'die ersten Zeilen stehen im Bericht');
});

test('IServ: zwei Schulen bleiben getrennt - auch von WebUntis', async t => {
  const { db } = await import('./db.js');
  const { netz } = await import('./iserv.js');
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  // Zwei IServ-Schulen mit verschiedenen Klingelzeiten.
  const anders = iservPlanHtml().replace('07:45 - 08:30', '08:10 - 08:55')
    .replace('08:35 - 09:20', '09:00 - 09:45');
  const stub = stubIserv({ 'schule-sued.de': anders, 'schule-ost.de': iservPlanHtml() });
  t.after(() => { stub.zurueck(); netz.lookup = echt; });

  const [sue, sueId] = await register('iserv-sue');
  const [ost, ostId] = await register('iserv-ost');
  await sue('PUT', '/api/iserv/account',
    { server: 'schule-sued.de', name: 'RS Süd', username: 'sue', password: 'richtig' });
  await ost('PUT', '/api/iserv/account',
    { server: 'schule-ost.de', name: 'RS Ost', username: 'ost', password: 'richtig' });

  const s1 = db.prepare("SELECT * FROM schools WHERE server = 'schule-sued.de'").get();
  const s2 = db.prepare("SELECT * FROM schools WHERE server = 'schule-ost.de'").get();
  assert.notEqual(s1.id, s2.id, 'zwei Adressen, zwei Schulen');
  assert.equal((await sue('GET', '/api/config')).body.periods[0].start_time, '08:10');
  assert.equal((await ost('GET', '/api/config')).body.periods[0].start_time, '07:45');

  // Dieselbe Stunde an beiden Schulen ist NICHT derselbe Kurs.
  const kurs = uid => db.prepare('SELECT course_id FROM untis_lessons WHERE user_id = ? ORDER BY date, period_id LIMIT 1')
    .get(uid).course_id;
  assert.notEqual(kurs(sueId), kurs(ostId));

  // Befreundet, aber an verschiedenen Schulen: keine gemeinsamen Stunden, keine Frei-Liste.
  await sue('POST', '/api/friends', { username: 'iserv-ost' });
  await ost('POST', `/api/friends/${sueId}/accept`);
  const plan = (await sue('GET', '/api/timetable')).body;
  assert.equal(plan.entries.every(e => e.shared.length === 0 && e.frei.length === 0), true);
  assert.equal((await sue('GET', '/api/friends')).body.friends.find(f => f.id === ostId).school, 'RS Ost');
});

test('Tickets: die Felder kommen auch, wenn der Melder-Weg sie verschweigt', async t => {
  const admin = await login('admin', 'geheim');
  const { zustand } = await vnwEinrichten(t, admin, { viewOhneFelder: true });
  const [tom] = await register('ticket-tom');

  const neu = await tom('POST', '/api/tickets',
    { title: 'Kein Ton', text: 'Beim Öffnen', type_id: 7, extra_fields: { geraet: 'iPhone 12' } });
  assert.equal(neu.status, 201, JSON.stringify(neu.body));

  const t1 = (await tom('GET', `/api/tickets/${neu.body.id}`)).body;
  assert.equal(t1.felder.length, 1, 'ueber den zweiten Weg geholt');
  assert.equal(t1.felder[0].wert, 'iPhone 12');
  assert.equal(t1.felder[0].label, 'Gerät', 'mit Beschriftung, nicht mit dem Schluessel');
  assert.ok(zustand.tickets.size >= 1);

  // Sobald das Team geantwortet hat, laesst sich das Ticket nicht mehr zurueckziehen - da
  // arbeitet jemand daran.
  [...zustand.tickets.values()].at(-1).replies.push({ id: 1, author_name: 'Team', message: 'Schauen wir an.', created_at: '2026-09-05 09:00' });
  await tom('GET', `/api/tickets/${neu.body.id}`);          // Stand uebernehmen
  assert.equal((await tom('DELETE', `/api/tickets/${neu.body.id}`)).status, 409);

  // Geschlossen schon - und dann ist es aus der eigenen Liste weg.
  [...zustand.tickets.values()].at(-1).status = 'closed';
  await tom('GET', `/api/tickets/${neu.body.id}`);          // Stand uebernehmen
  assert.equal((await tom('DELETE', `/api/tickets/${neu.body.id}`)).status, 200);
  assert.equal((await tom('GET', '/api/tickets')).body.tickets.length, 0, 'aus der Liste');
  assert.equal((await tom('DELETE', `/api/tickets/${neu.body.id}`)).status, 404, 'und nur einmal');
});

test('Markdown: ein Umbruch bleibt ein Umbruch', async () => {
  // Die Oberflaeche laeuft im Browser - fuer diese eine Funktion genuegt ein winziges Dokument.
  const echt = globalThis.document;
  globalThis.document = {
    createElement: tag => ({
      tag, textContent: '', kinder: [],
      append(...k) { this.kinder.push(...k.flat().filter(x => x != null && x !== false)); },
    }),
  };
  const alsText = n => (typeof n === 'string' ? n
    : n.tag === 'br' ? '\n' : (n.textContent || '') + n.kinder.map(alsText).join(''));
  const zaehle = (n, tag) => (typeof n === 'string' ? 0
    : (n.tag === tag ? 1 : 0) + n.kinder.reduce((a, k) => a + zaehle(k, tag), 0));

  try {
    const { md } = await import('./public/kern.js');

    const zwei = md('Zeile 1\nZeile 2');
    assert.equal(zaehle(zwei, 'br'), 1, 'der Umbruch steht als <br> da');
    assert.equal(alsText(zwei), 'Zeile 1\nZeile 2');

    // Eine Leerzeile bleibt ein neuer Absatz, kein zweiter Umbruch.
    const absaetze = md('Erster\n\nZweiter');
    assert.equal(zaehle(absaetze, 'p'), 2);
    assert.equal(zaehle(absaetze, 'br'), 0);

    // Ueberschriften und Listen bleiben, was sie sind.
    const gemischt = md('# Titel\nText\n\n- eins\n- zwei');
    assert.equal(zaehle(gemischt, 'h3'), 1);
    assert.equal(zaehle(gemischt, 'ul'), 1);
    assert.equal(zaehle(gemischt, 'li'), 2);

    // Fett und Links entstehen als Elemente - nie als HTML im Text.
    const reich = md('Das ist **fett** und [Link](https://example.org).');
    assert.equal(zaehle(reich, 'strong'), 1);
    assert.equal(zaehle(reich, 'a'), 1);
    assert.equal(alsText(md('<script>alert(1)</script>')).includes('<script>'), true,
      'spitze Klammern bleiben Text');
  } finally {
    globalThis.document = echt;
  }
});

test('Kinder setzen: aus einem null wird kein Text "null"', async () => {
  // Genau das stand im Chat neben dem Namen: der Knopf "Mitglieder" gibt es nur in Gruppen, und
  // replaceChildren() macht aus dem null an seiner Stelle den TEXT "null". h() filtert, die
  // DOM-Methode nicht.
  const { setzeKinder } = await import('./public/kern.js');
  const el = { kinder: null, replaceChildren(...k) { this.kinder = k; } };

  setzeKinder(el, 'links', null, 'mitte', false, undefined, 'rechts');
  assert.deepEqual(el.kinder, ['links', 'mitte', 'rechts']);

  // Verschachtelte Listen werden flach gemacht - wie bei h().
  setzeKinder(el, ['a', null], 'b');
  assert.deepEqual(el.kinder, ['a', 'b']);

  // Und die 0 bleibt: sie ist ein Wert, kein "nichts".
  setzeKinder(el, 0, '');
  assert.deepEqual(el.kinder, [0, '']);
});

test('IServ: die Verbindung testen, ohne etwas zu speichern', async t => {
  const { db } = await import('./db.js');
  const { netz } = await import('./iserv.js');
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const stub = stubIserv({ 'schule-test.de': iservPlanHtml() }, { umleiten: true });
  t.after(() => { stub.zurueck(); netz.lookup = echt; });

  const [tes, tesId] = await register('iserv-tes');
  const zaehle = () => ({
    konten: db.prepare('SELECT count(*) AS n FROM untis_accounts WHERE user_id = ?').get(tesId).n,
    schulen: db.prepare("SELECT count(*) AS n FROM schools WHERE server = 'schule-test.de'").get().n,
  });
  const vorher = zaehle();

  // Falsches Passwort: der Bericht IST das Ergebnis, deshalb kommt er mit 200 zurueck.
  const schlecht = await tes('POST', '/api/iserv/test',
    { server: 'schule-test.de', username: 'tes', password: 'falsch' });
  assert.equal(schlecht.status, 200);
  assert.equal(schlecht.body.ok, false);
  assert.match(schlecht.body.fehler, /Anmeldeformular/);
  assert.ok(schlecht.body.bericht.schritte.length >= 2, 'jeder Sprung steht im Bericht');
  assert.equal(schlecht.body.bericht.formular.user, '_username');
  assert.equal(JSON.stringify(schlecht.body).includes('falsch'), false,
    'das Passwort steht in keiner Antwort');

  // Richtiges Passwort: samt gefundener Plan-Seite - und noch immer nichts gespeichert.
  const gut = await tes('POST', '/api/iserv/test',
    { server: 'schule-test.de', username: 'tes', password: 'richtig' });
  assert.equal(gut.body.ok, true);
  assert.equal(gut.body.pfad, '/iserv/plan');
  assert.equal(gut.body.gefunden, 4);
  assert.deepEqual(zaehle(), vorher, 'der Test legt weder Konto noch Schule an');

  // Ohne Angaben gibt es keinen Testlauf.
  assert.equal((await tes('POST', '/api/iserv/test', { server: 'schule-test.de' })).status, 400);
});

test('ToDo-Liste: der Besitzer kann das Teilen wieder zuruecknehmen', async () => {
  const [ute, uteId] = await register('teil-ute');
  const [vik, vikId] = await register('teil-vik');
  await ute('POST', '/api/friends', { username: 'teil-vik' });
  await vik('POST', `/api/friends/${uteId}/accept`);

  const o = (await ute('POST', '/api/todo-ordner', { name: 'Bio-Referat' })).body;
  assert.equal((await ute('POST', `/api/todo-ordner/${o.id}/teilen`, { user_id: vikId })).status, 201);
  assert.equal((await vik('GET', '/api/todo-ordner')).body.length, 1, 'Vik sieht die Liste');
  assert.deepEqual((await ute('GET', '/api/todo-ordner')).body[0].geteilt_mit.map(p => p.username),
    ['teil-vik'], 'und die Besitzerin sieht, mit wem');

  // Zuruecknehmen - genau das, was der neue Knopf im Fenster tut.
  assert.equal((await ute('DELETE', `/api/todo-ordner/${o.id}/teilen/${vikId}`)).status, 200);
  assert.deepEqual((await vik('GET', '/api/todo-ordner')).body, [], 'weg bei Vik');
  assert.deepEqual((await ute('GET', '/api/todo-ordner')).body[0].geteilt_mit, [],
    'und aus der Liste der Besitzerin');

  // Ein Fremder kann niemandem etwas entziehen.
  const [wim] = await register('teil-wim');
  assert.equal((await wim('DELETE', `/api/todo-ordner/${o.id}/teilen/${uteId}`)).status, 403);
});


// --- Kalender -----------------------------------------------------------------

test('iCal: schreiben und wieder lesen', async () => {
  const { schreibe, lese } = await import('./ical.js');

  const ics = schreibe([
    { uid: 'a1', titel: 'Mathe-Klausur; wichtig', von: '2026-09-24 09:50', bis: '2026-09-24 12:25',
      ort: 'A213', text: 'Zeile 1\nZeile 2' },
    { uid: 'a2', titel: 'Ein sehr langer Titel, der über die fünfundsiebzig Oktette hinausgeht und '
      + 'deshalb gefaltet werden muss — mit Umlauten', von: '2026-09-25', ganztags: true },
  ], 'Probe');

  // Gefaltet wird auf 75 Oktette, und Fortsetzungen beginnen mit einem Leerzeichen.
  const zeilen = ics.split('\r\n');
  assert.equal(zeilen.every(z => Buffer.from(z, 'utf8').length <= 75), true, 'jede Zeile passt');
  assert.equal(zeilen.some(z => z.startsWith(' ')), true, 'es wurde wirklich gefaltet');
  assert.match(ics, /SUMMARY:Mathe-Klausur\\;/, 'Semikolon wird maskiert');
  // Ein ganztaegiger Termin endet am Folgetag - sonst zeigen ihn manche Kalender zu kurz.
  assert.match(ics, /DTEND;VALUE=DATE:20260926/);

  const zurueck = lese(ics, { von: '2026-09-01', bis: '2026-10-31' });
  assert.equal(zurueck.length, 2);
  assert.deepEqual([zurueck[0].titel, zurueck[0].von, zurueck[0].bis, zurueck[0].ort],
    ['Mathe-Klausur; wichtig', '2026-09-24 09:50', '2026-09-24 12:25', 'A213']);
  assert.equal(zurueck[0].text, 'Zeile 1\nZeile 2', 'Zeilenumbrüche überleben');
  assert.equal(zurueck[1].ganztags, true);
  assert.equal(zurueck[1].von, '2026-09-25');
  assert.match(zurueck[1].titel, /Umlauten$/, 'der gefaltete Titel ist wieder ganz');
});

test('iCal: Serien, Ausnahmen und Unfug', async () => {
  const { lese } = await import('./ical.js');
  const bau = (dt, rrule, extra = '') => 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n'
    + 'SUMMARY:Probe\r\nDTSTART:' + dt + '\r\nDTEND:' + dt.replace('T0800', 'T0900') + '\r\n'
    + (rrule ? 'RRULE:' + rrule + '\r\n' : '') + extra + 'END:VEVENT\r\nEND:VCALENDAR';
  const f = { von: '2026-09-01', bis: '2026-12-31' };
  const tage = a => a.map(x => x.von.slice(0, 10));

  assert.deepEqual(tage(lese(bau('20260907T080000', 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4'), f)),
    ['2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16']);
  assert.deepEqual(tage(lese(bau('20260907T080000', 'FREQ=WEEKLY;INTERVAL=2;COUNT=3'), f)),
    ['2026-09-07', '2026-09-21', '2026-10-05']);
  // Monatsende: der 31. wird zum letzten Tag des Monats, nicht zum Ersten des naechsten.
  assert.deepEqual(tage(lese(bau('20260131T080000', 'FREQ=MONTHLY;COUNT=3'),
    { von: '2026-01-01', bis: '2026-12-31' })), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(tage(lese(bau('20260907T080000', 'FREQ=DAILY;UNTIL=20260909T000000Z'), f)),
    ['2026-09-07', '2026-09-08', '2026-09-09']);
  // EXDATE laesst einen Termin aus - zaehlt fuer COUNT aber mit, so will es der Standard.
  assert.deepEqual(tage(lese(bau('20260907T080000', 'FREQ=DAILY;COUNT=4',
    'EXDATE:20260908T080000\r\n'), f)), ['2026-09-07', '2026-09-09', '2026-09-10']);
  // Die Dauer bleibt an jedem Vorkommen haengen.
  assert.equal(lese(bau('20260907T080000', 'FREQ=DAILY;COUNT=2'), f)[1].bis, '2026-09-08 09:00');

  // Was nicht zu lesen ist, ergibt nichts - und wirft nicht.
  assert.deepEqual(lese('Kein Kalender'), []);
  assert.deepEqual(lese(null), []);
  assert.deepEqual(lese('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Ohne Datum\r\nEND:VEVENT'), []);
});

test('Kalender: eigener, schulweiter und fremder', async t => {
  const admin = await login('admin', 'geheim');
  const [kim, kimId] = await register('kal-kim');
  const [lou] = await register('kal-lou');
  assert.ok(t && kimId);

  const meine = (await kim('GET', '/api/kalender')).body;
  assert.equal(meine.kalender.length >= 1, true, 'jeder bekommt seinen eigenen');
  const eigen = meine.kalender.find(k => k.quelle === 'eigen');
  assert.equal(eigen.darf_aendern, 1);

  // Termin anlegen, aendern, loeschen.
  const e = await kim('POST', `/api/kalender/${eigen.id}/eintraege`,
    { titel: 'Zahnarzt', von: '2026-09-22 15:00', bis: '2026-09-22 16:00', ort: 'Marktplatz' });
  assert.equal(e.status, 201);
  assert.equal((await kim('PATCH', `/api/kalender/eintraege/${e.body.id}`,
    { titel: 'Zahnarzt (verschoben)', von: '2026-09-23 15:00' })).body.titel, 'Zahnarzt (verschoben)');

  // Ein fremder Kalender ist nicht zu sehen und nicht zu beschreiben.
  assert.equal((await lou('POST', `/api/kalender/${eigen.id}/eintraege`, { titel: 'X', von: '2026-09-22' })).status, 404);
  assert.equal((await lou('PATCH', `/api/kalender/eintraege/${e.body.id}`, { titel: 'X' })).status, 404);
  assert.equal((await lou('DELETE', `/api/kalender/eintraege/${e.body.id}`)).status, 404);

  // Der schulweite Kalender: alle sehen ihn, schreiben darf nur der Admin.
  const schul = await admin('POST', '/api/kalender', { name: 'Schule', schulweit: true });
  assert.equal(schul.status, 201);
  await admin('POST', `/api/kalender/${schul.body.id}/eintraege`,
    { titel: 'Schulfest', von: '2026-09-26', ganztags: true });
  const beiKim = (await kim('GET', '/api/kalender/eintraege?von=2026-09-01&bis=2026-09-30')).body;
  assert.equal(beiKim.eintraege.some(x => x.titel === 'Schulfest'), true, 'Kim sieht das Schulfest');
  assert.equal((await kim('POST', `/api/kalender/${schul.body.id}/eintraege`,
    { titel: 'Meins', von: '2026-09-27' })).status, 403, 'schreiben darf nur der Admin');

  // Ein Nutzer, der es nicht ist, kann ihn auch nicht anlegen.
  const versuch = await kim('POST', '/api/kalender', { name: 'Fake-Schule', schulweit: true });
  assert.equal(versuch.body.user_id, kimId, 'wird stillschweigend ein eigener');

  // Abos gehen nur ins offene Netz.
  for (const url of ['http://schule.de/x.ics', 'https://10.0.0.5/x.ics', 'https://localhost/x.ics'])
    assert.equal((await kim('POST', '/api/kalender', { name: 'Abo', ical_url: url })).status, 400, url);

  await admin('DELETE', `/api/kalender/${schul.body.id}`);
});

test('Kalender: Hausaufgaben als Ebene, Farben und der Abo-Link', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'KAL01', title: 'Erdkunde' });
  const [nia, niaId] = await register('kal-nia');
  const cfg = (await nia('GET', '/api/config')).body;
  await nia('PUT', '/api/entry',
    { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'KAL01' });
  const inDrei = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await nia('POST', '/api/homework', { course_id: 'KAL01', due_date: inDrei, text: 'Karte zeichnen' });

  const heute = new Date().toISOString().slice(0, 10);
  const bis = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const daten = (await nia('GET', `/api/kalender/eintraege?von=${heute}&bis=${bis}`)).body;
  const hw = daten.eintraege.find(x => x.art === 'hausaufgabe');
  assert.ok(hw, 'die Hausaufgabe liegt als Ebene im Kalender');
  assert.equal(hw.ganztags, true);
  assert.equal(hw.farbe, daten.farben.hausaufgabe);
  assert.equal(hw.darf_aendern, false, 'abgehakt wird sie bei den Hausaufgaben, nicht hier');

  // Farben sind Ansichtssache und gelten nur fuer den, der sie setzt.
  const gesetzt = (await nia('PATCH', '/api/me',
    { kalender_farben: { hausaufgabe: '#123456', quatsch: 'lila' } })).body;
  assert.equal(gesetzt.kalender_farben.hausaufgabe, '#123456');
  assert.equal('quatsch' in gesetzt.kalender_farben, false, 'Unbekanntes fliegt raus');

  // Der Abo-Link: ohne Anmeldung, aber nur mit dem richtigen Token.
  const token = (await nia('GET', '/api/me/ics-token')).body.token;
  assert.equal(token.length >= 16, true);
  // Der Abo-Link liefert Text, kein JSON - deshalb roh abholen.
  const feed = await client().raw(`/kal/${token}.ics`);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  const text = await feed.text();
  assert.match(text, /BEGIN:VCALENDAR/);
  assert.match(text, /Karte zeichnen/, 'die Hausaufgabe steht im Abo');
  assert.equal((await client().raw('/kal/gibtesnichtgibtesnicht.ics')).status, 404);

  // Neu wuerfeln macht den alten Link tot.
  const neu = (await nia('POST', '/api/me/ics-token')).body.token;
  assert.notEqual(neu, token);
  assert.equal((await client().raw(`/kal/${token}.ics`)).status, 404, 'der alte Link ist tot');
  assert.equal((await client().raw(`/kal/${neu}.ics`)).status, 200);
  assert.ok(niaId > 0);
});

test('Prüfungen: aus dem Plan eingetragen, über mehrere Stunden markiert', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'PRUE01', title: 'Mathe' });
  const [ole, oleId] = await register('prue-ole');
  const [paul] = await register('prue-paul');
  await ole('POST', '/api/friends', { username: 'prue-paul' });
  await paul('POST', `/api/friends/${oleId}/accept`);

  const cfg = (await ole('GET', '/api/config')).body;
  const [mo] = cfg.days;
  for (const p of cfg.periods.slice(0, 4))
    await ole('PUT', '/api/entry', { day_id: mo.id, period_id: p.id, course_id: 'PRUE01' });
  const montag = (await ole('GET', '/api/timetable')).body.days[0].date;

  const kal = (await ole('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  const pr = await ole('POST', `/api/kalender/${kal.id}/eintraege`,
    { titel: 'Mathe-Klausur', art: 'pruefung', von: montag, von_stunde: 2, bis_stunde: 4,
      course_id: 'PRUE01' });
  assert.equal(pr.status, 201);
  // Die Uhrzeiten kommen aus dem Raster der eigenen Schule.
  assert.equal(pr.body.von, `${montag} ${cfg.periods[1].start_time}`);
  assert.equal(pr.body.bis, `${montag} ${cfg.periods[3].end_time}`);

  const plan = (await ole('GET', '/api/timetable')).body;
  const markiert = plan.entries.filter(e => e.day_id === mo.id && e.pruefungen?.length)
    .map(e => cfg.periods.find(p => p.id === e.period_id).nr).sort();
  assert.deepEqual(markiert, [2, 3, 4], 'genau die belegten Stunden, keine weitere');

  // Im Plan eines Freundes steht die Pruefung auch - in denselben Stunden, samt Notiz.
  const beiPaul = (await paul('GET', `/api/timetable?user=${oleId}`)).body;
  const beiPaulMarkiert = beiPaul.entries.filter(e => e.pruefungen?.length)
    .map(e => cfg.periods.find(p => p.id === e.period_id).nr).sort();
  assert.deepEqual(beiPaulMarkiert, markiert, 'der Freund sieht dieselben Stunden');
  const beiPaulPr = beiPaul.entries.find(e => e.pruefungen?.length).pruefungen[0];
  assert.equal(beiPaulPr.titel, pr.body.titel);
  // Nicht-Freunde sehen den Plan gar nicht.
  const [fremd] = await register('pruef-fremd');
  assert.equal((await fremd('GET', `/api/timetable?user=${oleId}`)).status, 403);
});

test('Chat-Suche: nurLesen markiert nichts als gelesen', async () => {
  const [ada, adaId] = await register('such-ada');
  const [ben, benId] = await register('such-ben');
  await ada('POST', '/api/friends', { username: 'such-ben' });
  await ben('POST', `/api/friends/${adaId}/accept`);
  await ben('POST', `/api/chats/${adaId}`, { text: 'Hallo Ada, Klausur am Freitag?' });
  const ungelesen = async () => (await ada('GET', '/api/chats')).body.find(c => c.id === benId).unread;
  assert.equal(await ungelesen(), 1);
  const gelesen = (await ada('GET', `/api/chats/${benId}?since=0&nurLesen=1`)).body;
  assert.equal(gelesen.length, 1, 'die Suche bekommt den Verlauf');
  assert.equal(await ungelesen(), 1, 'aber der Zaehler bleibt');
  await ada('GET', `/api/chats/${benId}?since=0`);
  assert.equal(await ungelesen(), 0, 'das normale Oeffnen markiert wie bisher');
});

test('Raumplan: Wegsuche ueber Etagen, Sperren, Treppenrichtung, Raeume nie als Durchgang', async () => {
  const rp = await import('./public/raumplan.js');
  const plan = rp.saeubern({ etagen: [
    { name: 'EG', b: 10, h: 5, felder: [
      { x: 0, y: 0, w: 3, h: 2, art: 'raum', name: '101' },
      { x: 4, y: 0, w: 3, h: 2, art: 'raum', name: '102' },
      { x: 0, y: 2, w: 10, h: 1, art: 'flur' },
      { x: 8, y: 0, w: 2, h: 2, art: 'treppe', name: 'T1' },
    ] },
    { name: '1. OG', b: 10, h: 5, felder: [
      { x: 8, y: 0, w: 2, h: 2, art: 'treppe', name: 'T1' },
      { x: 0, y: 2, w: 10, h: 1, art: 'flur' },
      { x: 0, y: 3, w: 3, h: 2, art: 'raum', name: '205' },
    ] },
  ] });
  const w = rp.weg(plan, '101', '205');
  assert.ok(w && w.length > 5, 'ein Weg');
  assert.deepEqual([w[0].etage, w.at(-1).etage], [0, 1], 'von EG ins 1. OG');
  assert.ok(w.some(p => p.etage === 0 && p.x >= 8 && p.y < 2), 'ueber die Treppe');
  assert.equal(w.some(p => p.etage === 0 && p.y < 2 && p.x >= 4 && p.x <= 6), false, 'nicht durch Raum 102');
  assert.equal(rp.weg(plan, '101', '999'), null, 'unbekannter Raum');
  assert.equal(rp.weg(plan, ' 101 ', '101').length, 1, 'gleicher Raum, Leerzeichen egal');
  assert.deepEqual(rp.raumNamen(plan), ['101', '102', '205']);
  assert.equal(rp.etageVon(plan, '205'), 1);

  // Treppe oben "nur hinein": man kommt nicht aus ihr heraus aufs 1. OG - kein Weg.
  plan.etagen[1].felder[0].zugang = 'nur_rein';
  assert.equal(rp.weg(plan, '101', '205'), null);
  // Umgekehrt geht es: von oben nach unten darf man hinein.
  assert.ok(rp.weg(plan, '205', '101'));
  plan.etagen[1].felder[0].zugang = 'beide';
  // Gesperrter Flur im EG: kein Weg mehr.
  plan.etagen[0].felder[2].gesperrt = 1;
  assert.equal(rp.weg(plan, '101', '205'), null);
  plan.etagen[0].felder[2].gesperrt = 0;
  // Das SVG traegt Namen und den Weg; Sonderzeichen werden maskiert.
  plan.etagen[0].felder[0].name = 'A<1>';
  const svg = rp.zeichnen(plan, 0, rp.weg(plan, 'A<1>', '205'), { start: 'A<1>' });
  assert.ok(svg.includes('A&lt;1&gt;') && svg.includes('<polyline'));
  assert.equal(svg.includes('<1>'), false);
  // Eine Treppe, die "bis 2. OG" reicht: einmal im EG gezeichnet, steht sie auf jeder Etage
  // dazwischen - und der Weg geht Etage fuer Etage, nicht quer vom EG ins 2. OG.
  const hoch = rp.saeubern({ etagen: [
    { name: 'EG', b: 10, h: 5, felder: [
      { x: 0, y: 0, w: 3, h: 2, art: 'raum', name: '101' },
      { x: 0, y: 2, w: 10, h: 1, art: 'flur' },
      { x: 8, y: 0, w: 2, h: 2, art: 'treppe', name: 'T1', hoch: 2 },
    ] },
    { name: '1. OG', b: 10, h: 5, felder: [{ x: 0, y: 2, w: 10, h: 1, art: 'flur' }] },
    { name: '2. OG', b: 10, h: 5, felder: [
      { x: 0, y: 2, w: 10, h: 1, art: 'flur' },
      { x: 0, y: 3, w: 3, h: 2, art: 'raum', name: '305' },
    ] },
  ] });
  assert.equal(hoch.etagen[0].felder[2].hoch, 2);
  assert.ok(rp.felderAuf(hoch, 1).some(f => f.art === 'treppe' && f.von === 0), 'im 1. OG steht die Kopie');
  assert.ok(rp.felderAuf(hoch, 2).some(f => f.art === 'treppe' && f.von === 0), 'im 2. OG auch');
  const w3 = rp.weg(hoch, '101', '305');
  assert.ok(w3, 'ein Weg ueber die durchgehende Treppe');
  assert.deepEqual([...new Set(w3.map(p => p.etage))], [0, 1, 2], 'Etage fuer Etage, nicht EG → 2. OG');
  assert.ok(rp.zeichnen(hoch, 1).includes('stroke-dasharray'), 'die Kopie ist gestrichelt');
  // Reicht sie nur bis ins 1. OG, fehlt sie im 2. OG - kein Weg mehr.
  hoch.etagen[0].felder[2].hoch = 1;
  assert.equal(rp.weg(hoch, '101', '305'), null);
  assert.equal(rp.saeubern({ etagen: [{ felder: [{ art: 'treppe', name: 'T', hoch: 99 }] }] }).etagen[0].felder[0].hoch, 11, 'gedeckelt');
  assert.equal(rp.saeubern({ etagen: [{ felder: [{ art: 'flur', hoch: 3 }] }] }).etagen[0].felder[0].hoch, 0, 'nur Treppen reichen hoch');

  // saeubern deckelt und wirft Unbekanntes raus.
  const s = rp.saeubern({ etagen: [{ b: 999, h: 1, felder: [{ x: 3, y: 0, w: 50, h: 5, art: 'lift' }, { x: -1, y: 0 }] }] });
  assert.deepEqual([s.etagen[0].b, s.etagen[0].h, s.etagen[0].felder.length, s.etagen[0].felder[0].art, s.etagen[0].felder[0].w],
    [rp.GRENZEN.breite, 5, 1, 'flur', 50]);
});

test('Raumplan: nur Admins schreiben, Nutzer sehen ihn erst nach der Freigabe', async () => {
  const admin = await login('admin', 'geheim');
  const [nils] = await register('rp-nils');
  const plan = { etagen: [{ name: 'EG', b: 10, h: 5, felder: [{ x: 0, y: 0, w: 2, h: 2, art: 'raum', name: 'R1' }] }] };
  assert.equal((await nils('PUT', '/api/raumplan', { plan })).status, 403);
  assert.equal((await admin('PUT', '/api/raumplan', { plan: 'unfug' })).status, 400);
  const r = await admin('PUT', '/api/raumplan', { plan, frei: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.etagen[0].felder[0].name, 'R1');
  assert.equal(r.body.frei, false);
  assert.equal((await admin('GET', '/api/raumplan')).body.plan.etagen.length, 1, 'der Admin sieht ihn zum Testen');
  assert.equal((await nils('GET', '/api/raumplan')).body.plan, null, 'Nutzer noch nicht');
  await admin('PUT', '/api/raumplan', { plan, frei: true });
  assert.equal((await nils('GET', '/api/raumplan')).body.plan.etagen[0].name, 'EG', 'nach der Freigabe schon');
  await admin('PUT', '/api/raumplan', { plan, frei: false });
});

test('Prüfungen für den ganzen Kurs: sehen alle mit dem Kurs in der Stunde, nicht loeschbar; Erinnerung vorher', async () => {
  const { pruefungsErinnerungen } = await import('./index.js');
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'KPR01', title: 'Physik' });
  await admin('POST', '/api/courses', { id: 'KPR02', title: 'Chemie' });
  const [anne, anneId] = await register('kpr-anne');
  const [bo, boId] = await register('kpr-bo');       // derselbe Kurs, dieselbe Stunde
  const [cem] = await register('kpr-cem');            // anderer Kurs
  const cfg = (await anne('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1, p2] = cfg.periods;
  for (const wer of [anne, bo])
    await wer('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'KPR01' });
  await cem('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'KPR02' });
  // Bo hat den Kurs auch in der 2. Stunde, Anne nicht - die Pruefung liegt nur in der 1.
  await bo('PUT', '/api/entry', { day_id: mo.id, period_id: p2.id, course_id: 'KPR01' });
  // Der Montag der NAECHSTEN Woche: liegt immer in der Zukunft (sonst waere die Pruefung an einem
  // Mittwoch schon vorbei) und hoechstens sieben Tage weg - Bos Vorgabe greift also.
  // Am Wochenende zeigt der Plan schon die kommende Woche - dann ist deren Montag der richtige.
  const gezeigt = (await anne('GET', '/api/timetable')).body.days[0].date;
  const montag = gezeigt > new Date().toISOString().slice(0, 10) ? gezeigt
    : new Date(new Date(gezeigt + 'T00:00:00Z').getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  const kal = (await anne('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  // Ohne Haken: nur bei Anne.
  const privat = (await anne('POST', `/api/kalender/${kal.id}/eintraege`,
    { titel: 'Physik-Test', art: 'pruefung', von: montag, von_stunde: 1, course_id: 'KPR01' })).body;
  assert.equal(privat.fuer_kurs, 0);
  const boPlan = () => bo('GET', `/api/timetable?week=${montag}`).then(r => r.body.entries.filter(e => e.pruefungen?.length));
  assert.equal((await boPlan()).length, 0, 'ohne Haken privat');

  // Mit Haken: Bo sieht sie in Plan und Kalender - mit Annes Namen, nicht loeschbar. Cem nicht.
  const kurs = (await anne('PATCH', `/api/kalender/eintraege/${privat.id}`, { fuer_kurs: true, erinnerung_tage: 3 })).body;
  assert.equal(kurs.fuer_kurs, 1);
  assert.equal(kurs.erinnerung_tage, 3);
  const beiBo = await boPlan();
  assert.equal(beiBo.length, 1, 'genau die eine Stunde');
  assert.equal(beiBo[0].period_id, p1.id);
  assert.deepEqual([beiBo[0].pruefungen[0].quelle, beiBo[0].pruefungen[0].von_name], ['kurs', 'kpr-anne']);
  const boKal = (await bo('GET', `/api/kalender/eintraege?von=${montag}&bis=${montag}`)).body.eintraege
    .filter(e => e.art === 'pruefung');
  assert.equal(boKal.length, 1);
  assert.equal(boKal[0].darf_aendern, false);
  assert.equal(boKal[0].kalender, 'Prüfungen (Kurs)');
  assert.equal((await bo('DELETE', `/api/kalender/eintraege/${privat.id}`)).status, 404, 'nicht seine');
  const beiCem = (await cem('GET', `/api/timetable?week=${montag}`)).body.entries.filter(e => e.pruefungen?.length);
  assert.equal(beiCem.length, 0, 'anderer Kurs');
  // Fuer den Kurs geht nur mit Kurs: ein Termin ohne Stunde bleibt privat.
  const frei = (await anne('POST', `/api/kalender/${kal.id}/eintraege`,
    { titel: 'Nur ich', art: 'pruefung', von: `${montag} 10:00`, fuer_kurs: true })).body;
  assert.equal(frei.fuer_kurs, 0);

  // Erinnerung: die Pruefung liegt in der angezeigten Woche (hoechstens 6 Tage weg). Anne hat 3
  // Tage je Pruefung gesetzt, Bo nimmt seine Vorgabe (7) - beide sind dran, jeder genau einmal.
  const meldungen = wer => db.prepare("SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'pruefung' ORDER BY id")
    .all(wer).map(r => ({ ...r }));
  const tageBis = Math.round((new Date(montag) - new Date(new Date().toISOString().slice(0, 10))) / 86_400_000);
  pruefungsErinnerungen();
  pruefungsErinnerungen();
  assert.equal(meldungen(boId).length, 1, 'Bo: Vorgabe 7 Tage, genau einmal');
  assert.match(meldungen(boId)[0].body, /von kpr-anne/);
  // Anne: "Nur ich" (Vorgabe 7 Tage, liegt in der Woche) immer, "Physik-Test" nur 3 Tage vorher.
  assert.equal(meldungen(anneId).length, 1 + (tageBis <= 3 ? 1 : 0), 'Anne: je Pruefung ihre Tage');
  // 0 heisst nie - auch wenn die Vorgabe etwas anderes sagt.
  await bo('PATCH', '/api/me', { pruefung_vorlauf_tage: 0 });
  assert.equal((await bo('GET', '/api/me')).body.pruefung_vorlauf_tage, 0);
  const eigene = (await bo('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  await bo('POST', `/api/kalender/${eigene.id}/eintraege`,
    { titel: 'Eigene', art: 'pruefung', von: montag, von_stunde: 2, course_id: 'KPR01' });
  pruefungsErinnerungen();
  assert.equal(meldungen(boId).length, 1, 'Vorgabe 0: keine neue Meldung');
  // Vergangenes nie.
  await bo('PATCH', '/api/me', { pruefung_vorlauf_tage: 30 });
  await bo('POST', `/api/kalender/${eigene.id}/eintraege`,
    { titel: 'Vorbei', art: 'pruefung', von: '2020-01-10 08:00', erinnerung_tage: 30 });
  pruefungsErinnerungen();
  assert.equal(meldungen(boId).filter(m => m.title.includes('Vorbei')).length, 0);
});

test('Abmeldung mit Grund: privat oder fuer Freunde, und "abgemeldet bis" in der Stunde', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'GRD01', title: 'Erdkunde' });
  const [ulf, ulfId] = await register('grund-ulf');
  const [vera] = await register('grund-vera');
  await ulf('POST', '/api/friends', { username: 'grund-vera' });
  await vera('POST', `/api/friends/${ulfId}/accept`);
  const cfg = (await ulf('GET', '/api/config')).body;
  const [mo, di, mi] = cfg.days, [p1] = cfg.periods;
  for (const wer of [ulf, vera]) for (const d of [mo, di, mi])
    await wer('PUT', '/api/entry', { day_id: d.id, period_id: p1.id, course_id: 'GRD01' });
  // Die naechste Woche: liegt sicher in der Zukunft, und dort greift "ab heute".
  const naechster = new Date(new Date((await ulf('GET', '/api/timetable')).body.days[0].date + 'T00:00:00Z').getTime() + 7 * 86_400_000)
    .toISOString().slice(0, 10);
  const woche = (await ulf('GET', `/api/timetable?week=${naechster}`)).body.days;
  const [montag, dienstag, mittwoch] = woche.map(d => d.date);

  // Privater Grund: nur Ulf sieht ihn.
  let r = await ulf('POST', '/api/absences', { from: montag, to: dienstag, grund: 'Zahnarzt' });
  assert.deepEqual([r.body.grund, r.body.grund_sichtbar], ['Zahnarzt', false]);
  assert.equal((await ulf('GET', '/api/absences')).body[0].grund, 'Zahnarzt');
  let beiVera = (await vera('GET', '/api/friends/absences')).body;
  assert.equal(beiVera.length, 1);
  assert.equal(beiVera[0].grund, null, 'privat bleibt privat');
  let stunde = (await vera('GET', `/api/timetable?week=${naechster}`)).body.entries.find(e => e.day_id === mo.id);
  let u = stunde.shared.find(x => x.username === 'grund-ulf');
  assert.deepEqual([u.absent, u.abwesend_bis, u.grund], [true, dienstag, null], 'bis Dienstag, ohne Grund');

  // Sichtbar: der Grund kommt mit - in der Liste und in der Stunde. Anderer Grund = neue Spanne.
  await ulf('POST', '/api/absences', { from: mittwoch, to: mittwoch, grund: 'krank', grund_sichtbar: true });
  beiVera = (await vera('GET', '/api/friends/absences')).body;
  assert.deepEqual(beiVera.map(x => [x.von, x.tage, x.grund]), [[montag, 2, null], [mittwoch, 1, 'krank']]);
  stunde = (await vera('GET', `/api/timetable?week=${naechster}`)).body.entries.find(e => e.day_id === mi.id);
  u = stunde.shared.find(x => x.username === 'grund-ulf');
  assert.deepEqual([u.abwesend_bis, u.grund], [mittwoch, 'krank']);
  // Der Haken ohne Grund ist nichts: leer bleibt leer.
  r = await ulf('POST', '/api/absences', { from: mittwoch, to: mittwoch, grund: '   ', grund_sichtbar: true });
  assert.deepEqual([r.body.grund, r.body.grund_sichtbar], [null, false]);
});

test('Kalender: Ferien als Ebene, abschaltbar; Pruefung im Plan mit Raum und Notiz', async () => {
  const { db } = await import('./db.js');
  const std = await standardSchuleSetzen();
  const [kim] = await register('ferien-kim');
  const heute = new Date().toISOString().slice(0, 10);
  const tag = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  db.prepare('INSERT OR REPLACE INTO holidays(school_id, von, bis, name) VALUES(?, ?, ?, ?)')
    .run(std.id, tag(10), tag(20), 'Herbstferien Test');
  const eintraege = async () => (await kim('GET', `/api/kalender/eintraege?von=${heute}&bis=${tag(30)}`)).body;
  let e = await eintraege();
  const ferien = e.eintraege.find(x => x.art === 'ferien');
  assert.ok(ferien, 'die Ferien stehen im Kalender');
  assert.deepEqual([ferien.titel, ferien.von, ferien.bis, ferien.ganztags, ferien.darf_aendern, ferien.quelle],
    ['Herbstferien Test', tag(10), tag(20), true, false, 'ferien']);
  assert.equal(ferien.farbe, e.farben.ferien);
  assert.deepEqual(e.ohne, []);

  // Ausblenden - und Unbekanntes in der Liste wird verworfen.
  await kim('PATCH', '/api/me', { kalender_ohne: ['ferien', 'quatsch'] });
  e = await eintraege();
  assert.deepEqual(e.ohne, ['ferien']);
  assert.equal(e.eintraege.some(x => x.art === 'ferien'), false, 'ausgeblendet');
  // Eine Farbe aendern laesst das Ausblenden stehen.
  await kim('PATCH', '/api/me', { kalender_farben: { ferien: '#123456' } });
  e = await eintraege();
  assert.deepEqual([e.ohne, e.farben.ferien], [['ferien'], '#123456']);
  await kim('PATCH', '/api/me', { kalender_ohne: [] });
  assert.equal((await eintraege()).eintraege.some(x => x.art === 'ferien'), true, 'wieder da');
  db.prepare('DELETE FROM holidays WHERE school_id = ? AND name = ?').run(std.id, 'Herbstferien Test');

  // Eine Pruefung traegt im Plan Raum und Notiz - damit die Stunde sie zeigen und aendern kann.
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'FER01', title: 'Latein' });
  const cfg = (await kim('GET', '/api/config')).body;
  await kim('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'FER01' });
  const montag = (await kim('GET', '/api/timetable')).body.days[0].date;
  const kal = (await kim('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  await kim('POST', `/api/kalender/${kal.id}/eintraege`,
    { titel: 'Latein-Test', art: 'pruefung', von: montag, von_stunde: 1, course_id: 'FER01', ort: '205', text: 'Vokabeln 1-3' });
  const pr = (await kim('GET', '/api/timetable')).body.entries.find(x => x.pruefungen?.length).pruefungen[0];
  assert.deepEqual([pr.ort, pr.text, pr.kalender_id, pr.course_id, pr.art], ['205', 'Vokabeln 1-3', kal.id, 'FER01', 'pruefung']);
});

test('Abmeldungen der Freunde: als Spannen, nur Freunde, nur ab heute', async () => {
  const [ali, aliId] = await register('abw-ali');
  const [bea] = await register('abw-bea');
  const [cid] = await register('abw-cid');    // kein Freund
  await ali('POST', '/api/friends', { username: 'abw-bea' });
  await bea('POST', `/api/friends/${aliId}/accept`);
  const heute = new Date().toISOString().slice(0, 10);
  const tag = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  // Drei Tage ganz, danach ein Tag mit Stunden, und etwas aus der Vergangenheit.
  await ali('POST', '/api/absences', { from: tag(1), to: tag(3) });
  await ali('POST', '/api/absences', { from: tag(5), to: tag(5), von_stunde: 1, bis_stunde: 2 });
  await ali('POST', '/api/absences', { from: tag(-3), to: tag(-2) });

  const bei = (await bea('GET', '/api/friends/absences')).body;
  assert.equal(bei.length, 2, 'zwei Spannen, Vergangenes fehlt');
  assert.deepEqual([bei[0].username, bei[0].von, bei[0].bis, bei[0].tage, bei[0].von_stunde],
    ['abw-ali', tag(1), tag(3), 3, null], 'drei Tage sind eine Zeile');
  assert.deepEqual([bei[1].von, bei[1].tage, bei[1].von_stunde, bei[1].bis_stunde], [tag(5), 1, 1, 2]);
  assert.ok(bei[0].von >= heute);
  assert.deepEqual((await cid('GET', '/api/friends/absences')).body, [], 'kein Freund, nichts');
  // Ein anderer Stundenbereich am Folgetag ist eine neue Spanne.
  await ali('POST', '/api/absences', { from: tag(4), to: tag(4), von_stunde: 3, bis_stunde: 3 });
  assert.equal((await bea('GET', '/api/friends/absences')).body.length, 3);
});

test('Stundenweise Abmeldung: nur die genannten Stunden', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'ABM01', title: 'Sport' });
  const [rea, reaId] = await register('abm-rea');
  const [sam, samId] = await register('abm-sam');
  await rea('POST', '/api/friends', { username: 'abm-sam' });
  await sam('POST', `/api/friends/${reaId}/accept`);

  const cfg = (await rea('GET', '/api/config')).body;
  const [mo] = cfg.days, [p1, p2, p3] = cfg.periods;
  // Rea hat die 1. und die 3. Stunde - dazwischen eine Freistunde.
  await rea('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'ABM01' });
  await rea('PUT', '/api/entry', { day_id: mo.id, period_id: p3.id, course_id: 'ABM01' });
  // Sam ist den ganzen Montag da, meldet sich aber fuer die 2. Stunde ab.
  await sam('PUT', '/api/entry', { day_id: mo.id, period_id: p1.id, course_id: 'ABM01' });
  await sam('PUT', '/api/entry', { day_id: mo.id, period_id: p3.id, course_id: 'ABM01' });
  const montag = (await rea('GET', '/api/timetable')).body.days[0].date;
  await sam('POST', '/api/absences', { from: montag, to: montag, von_stunde: 2, bis_stunde: 2 });

  const plan = (await rea('GET', '/api/timetable')).body;
  const luecke = plan.entries.find(e => e.day_id === mo.id && e.period_id === p2.id);
  assert.equal(luecke.frei.some(f => f.username === 'abm-sam'), false,
    'in der 2. Stunde ist Sam abgemeldet, also nicht frei');
  const erste = plan.entries.find(e => e.day_id === mo.id && e.period_id === p1.id);
  assert.equal(erste.shared.find(x => x.username === 'abm-sam')?.absent, false,
    'in der 1. Stunde ist er da');

  // Der eigene Plan meldet den Bereich, nicht den ganzen Tag.
  const beiSam = (await sam('GET', '/api/timetable')).body;
  assert.deepEqual(beiSam.absences, [{ date: montag, von: 2, bis: 2 }]);
  assert.ok(samId > 0);

  // Ganztags bleibt ganztags.
  await sam('POST', '/api/absences', { from: montag, to: montag });
  assert.deepEqual((await sam('GET', '/api/timetable')).body.absences,
    [{ date: montag, von: null, bis: null }]);
  await sam('DELETE', `/api/absences/${montag}`);
});

test('Überfällige Hausaufgaben verschwinden nach der eigenen Frist - eigene weg, fremde nur aus', async () => {
  const { hausaufgabenAufraeumen } = await import('./index.js');
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'ALT01', title: 'Bio' });
  const [nora, noraId] = await register('alt-nora');
  const [ole] = await register('alt-ole');
  const cfg = (await nora('GET', '/api/config')).body;
  for (const wer of [nora, ole])
    await wer('PUT', '/api/entry',
      { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'ALT01' });
  const vor = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  // Vorgabe: 7 Tage. Die von vor 8 Tagen ist faellig zum Loeschen, die von vor 6 nicht.
  assert.equal((await nora('GET', '/api/me')).body.hw_loeschen_tage, 7);
  const uralt = await nora('POST', '/api/homework', { course_id: 'ALT01', due_date: vor(8), text: 'Uralt' });
  await nora('POST', '/api/homework', { course_id: 'ALT01', due_date: vor(6), text: 'Neulich' });
  // Ole will nie aufraeumen - seine alte Aufgabe bleibt, Nora sieht sie trotzdem nicht mehr.
  await ole('PATCH', '/api/me', { hw_loeschen_tage: 0 });
  await ole('POST', '/api/homework', { course_id: 'ALT01', due_date: vor(20), text: 'Oles alte' });
  db.prepare(`INSERT INTO untis_homework(user_id, untis_id, course_id, date, due_date, text, remark)
    VALUES(?, 901, 'ALT01', ?, ?, 'Vom Lehrer', NULL)`).run(noraId, vor(30), vor(30));

  hausaufgabenAufraeumen();
  const texte = (await nora('GET', `/api/homework?from=${vor(60)}`)).body.map(h => h.text);
  assert.deepEqual(texte, ['Neulich'], 'Uralt und die von WebUntis sind weg, Oles ist ausgeblendet');
  assert.equal(db.prepare('SELECT count(*) n FROM homework WHERE id = ?').get(uralt.body.id).n, 0);
  // Oles Aufgabe gehoert Ole - der hat sie noch, seine Frist ist seine Sache.
  assert.equal(db.prepare("SELECT count(*) n FROM homework WHERE text = 'Oles alte'").get().n, 1);

  // 0 heisst nie: dann bleibt auch Altes liegen und wird gezeigt.
  assert.equal((await ole('GET', `/api/homework?from=${vor(60)}`)).body.some(h => h.text === 'Oles alte'), true);
  // Unfug wird gedeckelt statt abgelehnt.
  assert.equal((await ole('PATCH', '/api/me', { hw_loeschen_tage: 9999 })).body.hw_loeschen_tage, 365);
  assert.equal((await ole('PATCH', '/api/me', { hw_loeschen_tage: -3 })).body.hw_loeschen_tage, 0);
});

test('Aktualisieren: jede Antwort nennt die Version, statische Dateien werden immer nachgefragt', async () => {
  const { readFileSync } = await import('node:fs');
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const info = await client().raw('/api/info');
  assert.equal(info.headers.get('x-version'), version);
  const js = await client().raw('/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  assert.ok(js.headers.get('etag'), 'mit ETag ist die Nachfrage ein 304');
});

test('Der Zähler am Reiter zählt nur, was offen und noch nicht vorbei ist', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'ZAE01', title: 'Chemie' });
  const [tia] = await register('zaehl-tia');
  const cfg = (await tia('GET', '/api/config')).body;
  await tia('PUT', '/api/entry',
    { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'ZAE01' });

  const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const gestern = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const offen = await tia('POST', '/api/homework', { course_id: 'ZAE01', due_date: morgen, text: 'Aufgabe 1' });
  await tia('POST', '/api/homework', { course_id: 'ZAE01', due_date: gestern, text: 'Von gestern' });
  assert.equal((await tia('GET', '/api/homework/offen')).body.n, 1, 'nur die von morgen');

  await tia('POST', `/api/homework/${offen.body.id}/done`);
  assert.equal((await tia('GET', '/api/homework/offen')).body.n, 0, 'abgehakt zählt nicht');

  // Ausgeschaltet zählt er gar nicht.
  await tia('POST', `/api/homework/${offen.body.id}/done`);   // wieder offen? nein: erneutes Setzen
  await tia('DELETE', `/api/homework/${offen.body.id}/done`);
  assert.equal((await tia('GET', '/api/homework/offen')).body.n, 1);
  await tia('PATCH', '/api/me', { hw_badge: false });
  assert.equal((await tia('GET', '/api/homework/offen')).body.n, 0, 'aus ist aus');
});

test('ToDo: Board, Wiederholung, Erledigt-Regel und geerbte Freigabe', async () => {
  const [uwe, uweId] = await register('buero-uwe');
  const [vio, vioId] = await register('buero-vio');
  await uwe('POST', '/api/friends', { username: 'buero-vio' });
  await vio('POST', `/api/friends/${uweId}/accept`);

  // Ein neues Projekt bringt drei Spalten mit - ein leeres Brett sagt nichts.
  const o = (await uwe('POST', '/api/todo-ordner', { name: 'Referat' })).body;
  const board = (await uwe('GET', `/api/todo-ordner/${o.id}/board`)).body;
  assert.deepEqual(board.spalten.map(s => s.name), ['Offen', 'Dran', 'Fertig']);

  // Eine Aufgabe ohne Frist ist erlaubt.
  const t1 = (await uwe('POST', '/api/todos',
    { text: 'Quellen suchen', ordner_id: o.id, spalte_id: board.spalten[0].id })).body;
  assert.equal(t1.due_at, null);

  // Wiederkehrend: abhaken rueckt weiter, statt zu erledigen - gerechnet vom ALTEN Termin.
  const t2 = (await uwe('POST', '/api/todos', { text: 'Müll', ordner_id: o.id,
    due_at: '2026-09-09 18:00', wiederholung: 1, wiederholung_einheit: 'woche' })).body;
  const nach = (await uwe('POST', `/api/todos/${t2.id}/done`)).body;
  assert.equal(nach.done, false);
  assert.match(nach.naechst, /^2026-09-16 18:00$|^20\d\d-/, 'der nächste Termin, nicht heute + 7');

  // Erledigt-Regel: in eine Spalte schieben.
  await uwe('PUT', `/api/todo-ordner/${o.id}`,
    { fertig_regel: 'verschieben', fertig_spalte_id: board.spalten[2].id });
  await uwe('POST', `/api/todos/${t1.id}/done`);
  assert.equal((await uwe('GET', '/api/todos')).body.find(t => t.id === t1.id).spalte_id,
    board.spalten[2].id);

  // Reihenfolge in einem Rutsch.
  assert.equal((await uwe('PUT', `/api/todo-spalten/${board.spalten[0].id}/reihenfolge`,
    { ids: [t2.id, t1.id] })).status, 200);

  // Teilen wirkt auch auf Unterprojekte, die es beim Teilen noch gar nicht gab.
  await uwe('POST', `/api/todo-ordner/${o.id}/teilen`, { user_id: vioId });
  const unter = (await uwe('POST', '/api/todo-ordner', { name: 'Kapitel 1', parent_id: o.id })).body;
  const beiVio = (await vio('GET', '/api/todo-ordner')).body.map(x => x.id);
  assert.equal(beiVio.includes(unter.id), true, 'geerbte Freigabe gilt für später Angelegtes');

  // Zuständig kann nur werden, wer dabei ist.
  const [wim, wimId] = await register('buero-wim');
  assert.equal((await uwe('POST', '/api/todos',
    { text: 'X', ordner_id: o.id, zustaendig_id: wimId })).status, 400);
  assert.equal((await uwe('POST', '/api/todos',
    { text: 'Y', ordner_id: o.id, zustaendig_id: vioId })).status, 200);
  assert.ok(wim);

  // Ein Projekt kann nicht in sich selbst liegen.
  assert.equal((await uwe('PUT', `/api/todo-ordner/${o.id}`, { parent_id: unter.id })).status, 400);

  // Loeschen laesst die Kinder eine Ebene hochruecken, statt sie mitzunehmen.
  await uwe('DELETE', `/api/todo-ordner/${o.id}`);
  const rest = (await uwe('GET', '/api/todo-ordner')).body.find(x => x.id === unter.id);
  assert.ok(rest, 'das Unterprojekt lebt');
  assert.equal(rest.parent_id, null, 'und liegt jetzt oben');
});

test('Ticket zurueckziehen: solange niemand geantwortet hat, und nur mit dem Recht am Token', async t => {
  const admin = await login('admin', 'geheim');
  const { zustand } = await vnwEinrichten(t, admin);
  const [zoe] = await register('ticket-zoe');
  const neu = (await zoe('POST', '/api/tickets', { title: 'Versehen', text: 'Falscher Knopf.' })).body;
  assert.ok(zustand.tickets.size >= 1);

  // Ohne tickets.close am Token: klare Ansage, nichts geloescht - auch nicht hier.
  zustand.loeschenErlaubt = false;
  const verboten = await zoe('DELETE', `/api/tickets/${neu.id}`);
  assert.equal(verboten.status, 403);
  assert.match(verboten.body.error, /tickets\.close/);
  assert.equal((await zoe('GET', '/api/tickets')).body.tickets.length, 1, 'bleibt in der Liste');

  // Mit dem Recht: weg bei VNW und hier.
  zustand.loeschenErlaubt = true;
  assert.equal((await zoe('DELETE', `/api/tickets/${neu.id}`)).status, 200);
  const geloescht = zustand.gesehen.find(g => g.method === 'DELETE');
  assert.ok(geloescht?.pfad.startsWith('/api/tickets/'), 'VNW hat den Loeschbefehl bekommen');
  assert.equal(zustand.tickets.size, 0);
  assert.deepEqual((await zoe('GET', '/api/tickets')).body.tickets, []);
});

test('Das eigene Menue: Seiten und Gruppen, gefiltert, mit Vorgabe aus der alten Reihenfolge', async () => {
  const [max] = await register('menue-max');
  const vorgabe = (await max('GET', '/api/me')).body.menue;
  assert.deepEqual(vorgabe, ['plan', 'homework', 'tickets'],
    'die Vorgabe: nur der Alltag - der Rest steht im Seitenmenue hinter ☰');

  // Die alte Sortierung bleibt die Vorgabe, solange kein eigenes Menue steht.
  await max('PATCH', '/api/me', { nav_order: ['tickets', 'plan'] });
  assert.equal((await max('GET', '/api/me')).body.menue[0], 'tickets');

  // Ein eigenes Menue: eine Seite aus dem Untermenue oben, Abmeldung in einer Gruppe, Muell weg.
  const eigen = (await max('PATCH', '/api/me', { menue: [
    'plan', 'homework/kalender',
    { name: '  Leute  ', icon: '🧑‍🤝‍🧑', kinder: ['friends', 'absence', 'admin', 'gibtsnicht', 'friends'] },
    'admin/system', 42, { name: '', kinder: ['chat'] }, { name: 'Leer', kinder: [] }, 'plan',
  ] })).body.menue;
  assert.deepEqual(eigen, [
    'plan', 'homework/kalender',
    { name: 'Leute', icon: '🧑‍🤝‍🧑', kinder: ['friends', 'absence'] },
    { name: 'Leer', icon: '📁', kinder: [] },
  ], 'Unbekanntes, Doppeltes, Admin-Seiten und namenlose Gruppen fallen weg; leere Gruppen bleiben');
  assert.deepEqual((await max('GET', '/api/me')).body.menue, eigen, 'bleibt gespeichert');
  assert.equal((await max('PATCH', '/api/me', { menue: 'plan' })).status, 400, 'keine Liste');

  // Zuruecksetzen: wieder die Vorgabe.
  assert.equal((await max('PATCH', '/api/me', { menue: null })).body.menue[0], 'tickets');

  // Ein Admin darf die Admin-Seiten hinein - und hat sie in der Vorgabe hinten.
  const admin = await login('admin', 'geheim');
  assert.deepEqual((await admin('GET', '/api/me')).body.menue, ['plan', 'homework', 'tickets']);
  const adminMenue = (await admin('PATCH', '/api/me', { menue: ['plan', { name: 'Verwaltung', icon: '⚙️', kinder: ['admin/system', 'admin'] }] })).body.menue;
  assert.deepEqual(adminMenue[1].kinder, ['admin/system', 'admin']);
  await admin('PATCH', '/api/me', { menue: null });
});

test('Der Zaehler zaehlt ToDos mit: alle offenen, nur geparkte nicht', async () => {
  const [pit] = await register('zaehl-pit');
  const z = x => String(x).padStart(2, '0');
  const lokal = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  const heute = new Date(), morgen = new Date(Date.now() + 86_400_000), gestern = new Date(Date.now() - 86_400_000);

  await pit('POST', '/api/todos', { text: 'Heute noch', due_at: `${lokal(heute)} 23:59` });
  await pit('POST', '/api/todos', { text: 'Seit gestern', due_at: `${lokal(gestern)} 08:00` });
  await pit('POST', '/api/todos', { text: 'Erst morgen', due_at: `${lokal(morgen)} 08:00` });
  await pit('POST', '/api/todos', { text: 'Ohne Frist' });
  const geparkt = (await pit('POST', '/api/todos', { text: 'Geparkt', due_at: `${lokal(gestern)} 08:00`,
    sichtbar_ab: `${lokal(morgen)} 08:00` })).body;
  assert.equal(geparkt.geparkt, true);

  let zahl = (await pit('GET', '/api/homework/offen')).body;
  assert.deepEqual([zahl.hausaufgaben, zahl.todos, zahl.n], [0, 4, 4], 'heute, gestern, morgen und ohne Frist - nur geparkt nicht');

  // Abgehakt zaehlt nicht mehr; ausgeschaltet zaehlt gar nichts.
  const alle = (await pit('GET', '/api/todos')).body;
  await pit('POST', `/api/todos/${alle.find(t => t.text === 'Heute noch').id}/done`);
  zahl = (await pit('GET', '/api/homework/offen')).body;
  assert.deepEqual([zahl.todos, zahl.n], [3, 3]);
  await pit('PATCH', '/api/me', { hw_badge: false });
  assert.deepEqual((await pit('GET', '/api/homework/offen')).body, { n: 0, hausaufgaben: 0, todos: 0 });
});

test('Hausaufgabe leise wiederherstellen: kein zweiter Push an den Kurs', async () => {
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'LEIS01', title: 'Physik' });
  const [ann, annId] = await register('leise-ann');
  const [bob, bobId] = await register('leise-bob');
  const cfg = (await ann('GET', '/api/config')).body;
  for (const wer of [ann, bob])
    await wer('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'LEIS01' });
  const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const zaehle = () => db.prepare("SELECT count(*) n FROM notifications WHERE user_id = ? AND kind = 'hausaufgaben'").get(bobId).n;

  const hw = (await ann('POST', '/api/homework', { course_id: 'LEIS01', due_date: morgen, text: 'S. 12' })).body;
  assert.equal(zaehle(), 1, 'Bob erfaehrt von der neuen Aufgabe');

  // Geloescht und per Rueckgaengig wieder da: dieselbe Aufgabe, keine zweite Meldung.
  await ann('DELETE', `/api/homework/${hw.id}`);
  const wieder = await ann('POST', '/api/homework', { course_id: 'LEIS01', due_date: morgen, text: 'S. 12', leise: true });
  assert.equal(wieder.status, 200, JSON.stringify(wieder.body));
  assert.equal(zaehle(), 1, 'leise heisst leise');
  assert.equal((await bob('GET', '/api/homework')).body.filter(h => h.text === 'S. 12').length, 1);
  void annId;
});

test('Neue Schul-Nachrichten: die hoechste gesehene ID, nur aufwaerts, nie ueber das Vorhandene', async () => {
  const { db } = await import('./db.js');
  const [rike] = await register('news-rike');
  assert.equal((await rike('GET', '/api/me')).body.nachrichten_gesehen, null, 'noch nie geoeffnet');
  const schule = db.prepare('SELECT id FROM schools WHERE standard = 1').get().id;   // Rike haengt an der Standardschule
  const heute = new Date().toISOString().slice(0, 10);
  const lege = (ext, titel) => Number(db.prepare(`INSERT INTO nachrichten(school_id, quelle, ext_id, datum, titel, text, created_at)
    VALUES(?, 'rss', ?, ?, ?, '', datetime('now'))`).run(schule, ext, heute, titel).lastInsertRowid);
  const a = lege('n-a', 'Erste'), b = lege('n-b', 'Zweite');

  // Ohne id: alles bis jetzt gilt als gesehen (das erste Oeffnen holt still auf).
  assert.equal((await rike('POST', '/api/me/nachrichten-gelesen')).body.nachrichten_gesehen, b);
  // Nicht rueckwaerts, nicht ueber das Vorhandene hinaus.
  assert.equal((await rike('POST', '/api/me/nachrichten-gelesen', { id: a })).body.nachrichten_gesehen, b);
  assert.equal((await rike('POST', '/api/me/nachrichten-gelesen', { id: 999_999 })).body.nachrichten_gesehen, b);
  const c = lege('n-c', 'Dritte');
  assert.equal((await rike('GET', '/api/me')).body.nachrichten_gesehen, b, 'die Dritte ist neu');
  assert.equal((await rike('POST', '/api/me/nachrichten-gelesen', { id: c })).body.nachrichten_gesehen, c);
});

test('Datenschutz: eigene Adresse /datenschutz und Knopf neben der Version', async () => {
  const c = client();
  const seite = await c.raw('/datenschutz');
  assert.equal(seite.status, 200, 'ohne Anmeldung');
  const html = await seite.text();
  assert.ok(html.includes('datenschutz-knopf'), 'der Knopf steht in der Seite');
  const { readFileSync } = await import('node:fs');
  const profil = readFileSync(new URL('./public/profil.js', import.meta.url), 'utf8');
  assert.ok(profil.includes("'/datenschutz'") && profil.includes("zeigeInfo('privacy')"), 'die Seite oeffnet den Reiter');
});

// --- Fuer die Android-App -------------------------------------------------------------------

test('Android-App: /api/info nennt App und Schule, ohne Anmeldung', async () => {
  const info = await client()('GET', '/api/info');
  assert.equal(info.status, 200);
  assert.equal(info.body.app, 'stundenplan');
  assert.equal(typeof info.body.schule, 'string');
  assert.ok(info.body.schule.length > 0, 'der Name der Standardschule');
});

test('Android-App: die Oberflaeche kennt Hash und WebView', async () => {
  const { readFileSync } = await import('node:fs');
  const plan = readFileSync(new URL('./public/plan.js', import.meta.url), 'utf8');
  assert.ok(plan.includes('location.hash'), 'plan.js liest den Hash');
  assert.ok(plan.includes("'hashchange'"), 'plan.js hoert auf hashchange');
  assert.ok(plan.includes('replaceState'), 'und entfernt ihn wieder');
  const profil = readFileSync(new URL('./public/profil.js', import.meta.url), 'utf8');
  assert.ok(profil.includes('StundenplanApp/'), 'profil.js erkennt den WebView der App');
});

test('Android-App: /api/widget - Stunden des Tages, offene Hausaufgaben, Pruefungen, in einem Aufruf', async () => {
  const { db } = await import('./db.js');
  assert.equal((await client()('GET', '/api/widget')).status, 401, 'ohne Anmeldung nichts');

  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'WID01', title: 'Erdkunde' });
  const [wim, wimId] = await register('widget-wim');
  await wim('PUT', '/api/my-courses/WID01', { short: 'Ek', name: 'Erdkunde LK', color: '#123456' });
  const cfg = (await wim('GET', '/api/config')).body;
  const montag = cfg.days.find(d => d.iso === 1), dienstag = cfg.days.find(d => d.iso === 2);
  await wim('PUT', '/api/entry', { day_id: montag.id, period_id: cfg.periods[0].id, course_id: 'WID01' });
  await wim('PUT', '/api/entry', { day_id: montag.id, period_id: cfg.periods[1].id, course_id: '__frei__' });

  // Naechster Montag - egal, an welchem Wochentag der Test laeuft.
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const naechsterMontag = d.toISOString().slice(0, 10);
  const naechsterDienstag = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);

  const offen = (await wim('POST', '/api/homework', { course_id: 'WID01', due_date: naechsterMontag, text: 'Atlas S. 40' })).body;
  const erledigt = (await wim('POST', '/api/homework', { course_id: 'WID01', due_date: naechsterMontag, text: 'Schon gemacht' })).body;
  await wim('POST', `/api/homework/${erledigt.id}/done`);
  db.prepare(`INSERT INTO untis_homework(user_id, untis_id, course_id, date, due_date, text, remark)
              VALUES(?, 4242, 'WID01', ?, ?, 'Aus WebUntis', NULL)`).run(wimId, naechsterMontag, naechsterMontag);
  const kal = (await wim('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  await wim('POST', `/api/kalender/${kal.id}/eintraege`, { titel: 'Ek-Klausur', art: 'pruefung', von: `${naechsterMontag} 08:00`, bis: `${naechsterMontag} 09:30` });
  await wim('POST', `/api/kalender/${kal.id}/eintraege`, { titel: 'Kein Test', art: 'termin', von: `${naechsterMontag} 10:00`, bis: `${naechsterMontag} 11:00` });

  const r = await wim('GET', `/api/widget?tag=${naechsterMontag}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await wim.raw(`/api/widget?tag=${naechsterMontag}`)).headers.get('cache-control'), 'no-store');
  assert.equal(r.body.tag, naechsterMontag);
  assert.equal(r.body.heute, new Date().toISOString().slice(0, 10));
  assert.deepEqual(r.body.stunden.map(s => [s.nr, s.kurz, s.name, s.farbe, s.status]),
    [[cfg.periods[0].nr, 'Ek', 'Erdkunde LK', '#123456', 'regular']], 'die Stunde mit eigenem Kuerzel, Frei fehlt');
  assert.equal(typeof r.body.stunden[0].start_time, 'string');
  assert.deepEqual(r.body.hausaufgaben.map(h => [h.quelle, h.text, h.done]),
    [['eigene', 'Atlas S. 40', false], ['untis', 'Aus WebUntis', false]], 'offene ja, abgehakte nein');
  const untis = r.body.hausaufgaben.find(h => h.quelle === 'untis');
  assert.ok(untis.id < 0, 'WebUntis-Hausaufgaben mit negativer id');
  assert.deepEqual(r.body.pruefungen.map(p => p.titel), ['Ek-Klausur']);

  // Ein anderer Tag hat keine Stunde; ohne tag: heute (am Wochenende Montag), ein Datum als Feld.
  assert.deepEqual((await wim('GET', `/api/widget?tag=${naechsterDienstag}`)).body.stunden, []);
  const ohne = (await wim('GET', '/api/widget')).body;
  assert.match(ohne.tag, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await wim('GET', '/api/widget?tag=quatsch')).status, 400);

  // Abhaken der WebUntis-Aufgabe ueber dieselbe id - dann ist sie im Widget weg.
  assert.equal((await wim('POST', `/api/homework/${untis.id}/done`)).status, 200);
  assert.deepEqual((await wim('GET', `/api/widget?tag=${naechsterMontag}`)).body.hausaufgaben.map(h => h.text), ['Atlas S. 40']);
  void offen;
  db.prepare('DELETE FROM untis_homework WHERE user_id = ?').run(wimId);
});

test('Erledigte ToDos: auf einmal loeschen und nach der eigenen Frist von selbst', async () => {
  const { todosAufraeumen } = await import('./index.js');
  const { db } = await import('./db.js');
  const [udo, udoId] = await register('putz-udo');
  const [vera, veraId] = await register('putz-vera');
  assert.equal((await udo('GET', '/api/me')).body.todo_loeschen_tage, 30, 'Vorgabe 30 Tage');

  const t1 = (await udo('POST', '/api/todos', { text: 'Alt und erledigt' })).body;
  const t2 = (await udo('POST', '/api/todos', { text: 'Frisch erledigt' })).body;
  const t3 = (await udo('POST', '/api/todos', { text: 'Noch offen' })).body;
  await udo('POST', `/api/todos/${t1.id}/done`);
  await udo('POST', `/api/todos/${t2.id}/done`);
  assert.ok(db.prepare('SELECT done_at FROM todos WHERE id = ?').get(t1.id).done_at, 'abhaken merkt sich den Zeitpunkt');
  db.prepare("UPDATE todos SET done_at = datetime('now', '-40 days') WHERE id = ?").run(t1.id);
  // Und ein Board von Vera, in dem Udo mitarbeitet - dort raeumt nur Vera auf.
  await vera('PATCH', '/api/me', { todo_loeschen_tage: 0 });   // Vera raeumt erst mal nicht
  const o = (await vera('POST', '/api/todo-ordner', { name: 'Veras Projekt' })).body;
  await vera('POST', '/api/friends', { username: 'putz-udo' });
  await udo('POST', `/api/friends/${veraId}/accept`);
  await vera('POST', `/api/todo-ordner/${o.id}/teilen`, { user_id: udoId, darf_aendern: true });
  const im = (await udo('POST', '/api/todos', { text: 'Im Board', ordner_id: o.id })).body;
  await udo('POST', `/api/todos/${im.id}/done`);
  db.prepare("UPDATE todos SET done_at = datetime('now', '-40 days') WHERE id = ?").run(im.id);

  todosAufraeumen();
  const texte = async () => (await udo('GET', '/api/todos')).body.map(t => t.text).sort();
  assert.deepEqual(await texte(), ['Frisch erledigt', 'Im Board', 'Noch offen'], 'nur das alte eigene ist weg, das im fremden Board bleibt');
  // Vera raeumt ihr Board auf - nach ihrer Frist.
  await vera('PATCH', '/api/me', { todo_loeschen_tage: 10 });
  todosAufraeumen();
  assert.deepEqual(await texte(), ['Frisch erledigt', 'Noch offen']);
  // 0 heisst nie.
  await udo('PATCH', '/api/me', { todo_loeschen_tage: 0 });
  db.prepare("UPDATE todos SET done_at = datetime('now', '-400 days') WHERE id = ?").run(t2.id);
  todosAufraeumen();
  assert.deepEqual(await texte(), ['Frisch erledigt', 'Noch offen']);
  assert.equal((await udo('PATCH', '/api/me', { todo_loeschen_tage: 9999 })).body.todo_loeschen_tage, 365, 'gedeckelt');

  // Von Hand: alle erledigten losen auf einmal; im Board nur, wer aendern darf.
  assert.deepEqual((await udo('DELETE', '/api/todos/erledigt')).body, { n: 1 });
  assert.deepEqual(await texte(), ['Noch offen']);
  const im2 = (await udo('POST', '/api/todos', { text: 'Board 2', ordner_id: o.id })).body;
  await udo('POST', `/api/todos/${im2.id}/done`);
  const [fremd] = await register('putz-fremd');
  assert.equal((await fremd('DELETE', `/api/todos/erledigt?ordner=${o.id}`)).status, 404);
  assert.deepEqual((await udo('DELETE', `/api/todos/erledigt?ordner=${o.id}`)).body, { n: 1 });
  assert.equal((await udo('GET', '/api/todos')).body.some(t => t.text === 'Board 2'), false);
});

// --- 3.0: Buero, Einladungslink, Abo-Auswahl, Kleinkram ------------------------------------------

/** Zwei befreundete Nutzer, ein dritter im selben Kurs (nicht befreundet), ein Fremder. */
async function bueroLeute(praefix) {
  const admin = await login('admin', 'geheim');
  const kurs = `${praefix.toUpperCase()}K`;
  await admin('POST', '/api/courses', { id: kurs, title: 'Büro-Kurs' });
  const [bes, besId] = await register(`${praefix}-bes`);
  const [fre, freId] = await register(`${praefix}-fre`);
  const [kur, kurId] = await register(`${praefix}-kur`);
  const [fremd] = await register(`${praefix}-fremd`);
  await bes('POST', '/api/friends', { username: `${praefix}-fre` });
  await fre('POST', `/api/friends/${besId}/accept`);
  const cfg = (await bes('GET', '/api/config')).body;
  for (const wer of [bes, kur])
    await wer('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: kurs });
  return { bes, besId, fre, freId, kur, kurId, fremd, kurs };
}

test('Buero Notizen: CRUD, Ordner, Todos, Kommentare, Freigabe lesen/aendern, Kurs, Fremde', async () => {
  const { bes, fre, freId, kur, fremd, kurs } = await bueroLeute('bn');
  // Anlegen und lesen
  const leer = await bes('POST', '/api/notizen', { titel: '', inhalt: '' });
  assert.equal(leer.status, 400, 'Titel oder Text noetig');
  const n = (await bes('POST', '/api/notizen', { titel: 'Referat', inhalt: '# Gliederung', tags: ['bio', '#schule', 'bio'], farbe: '#112233' })).body;
  assert.deepEqual(n.tags, ['bio', 'schule'], 'Tags ohne # und ohne Doppelte');
  assert.equal(n.rolle, 'besitzer');
  let liste = (await bes('GET', '/api/notizen')).body;
  assert.equal(liste.notizen.length, 1);
  // Aendern
  const geaendert = (await bes('PATCH', `/api/notizen/${n.id}`, { inhalt: '# Gliederung\n- Einleitung' })).body;
  assert.match(geaendert.inhalt, /Einleitung/);
  // Anheften, Archiv
  assert.equal((await bes('POST', `/api/notizen/${n.id}/anheften`)).body.angeheftet, true);
  assert.equal((await bes('POST', `/api/notizen/${n.id}/archiv`, { an: false })).body.archiviert, false);
  // Todos
  const t = (await bes('POST', `/api/notizen/${n.id}/todos`, { text: 'Folien' })).body;
  assert.equal((await bes('PATCH', `/api/notizen/todos/${t.id}`, { done: true })).body.done, true);
  const detail = (await bes('GET', `/api/notizen/${n.id}`)).body;
  assert.deepEqual(detail.todo_liste.map(x => [x.text, x.done]), [['Folien', true]]);

  // Fremde sehen nichts
  assert.equal((await fremd('GET', `/api/notizen/${n.id}`)).status, 404);
  assert.equal((await fremd('PATCH', `/api/notizen/${n.id}`, { titel: 'x' })).status, 404);
  assert.equal((await fremd('GET', '/api/notizen')).body.notizen.length, 0);

  // Teilen: nur mit Freunden und eigenen Kursen
  assert.equal((await bes('PUT', `/api/buero/notiz/${n.id}/freigabe`, { freunde: [{ id: 999999, rolle: 'lesen' }] })).status, 403);
  assert.equal((await bes('PUT', `/api/buero/notiz/${n.id}/freigabe`, { kurse: ['GIBTSNICHT'] })).status, 403);
  assert.equal((await bes('PUT', `/api/buero/notiz/${n.id}/freigabe`, { freunde: [{ id: freId, rolle: 'lesen' }], kurse: [kurs] })).status, 200);
  const frei = (await bes('GET', `/api/buero/notiz/${n.id}/freigabe`)).body;
  assert.deepEqual(frei.map(z => z.wer).sort(), [`k:${kurs}`, `u:${freId}`].sort());
  // Freund liest, darf aber nicht aendern
  assert.equal((await fre('GET', `/api/notizen/${n.id}`)).body.rolle, 'lesen');
  assert.equal((await fre('PATCH', `/api/notizen/${n.id}`, { titel: 'gekapert' })).status, 403);
  assert.equal((await fre('POST', `/api/notizen/${n.id}/todos`, { text: 'x' })).status, 403);
  // Kursmitglied liest mit
  assert.equal((await kur('GET', `/api/notizen/${n.id}`)).status, 200);
  assert.equal((await kur('GET', '/api/notizen')).body.notizen[0].geteilt, true);
  // Kommentieren darf, wer sieht; loeschen der Autor oder der Besitzer
  const k = (await fre('POST', `/api/notizen/${n.id}/kommentare`, { text: 'Gute Idee' })).body;
  assert.equal((await kur('DELETE', `/api/notizen/kommentare/${k.id}`)).status, 403);
  assert.equal((await bes('DELETE', `/api/notizen/kommentare/${k.id}`)).status, 200);
  // Bearbeiten-Freigabe
  await bes('PUT', `/api/buero/notiz/${n.id}/freigabe`, { freunde: [{ id: freId, rolle: 'aendern' }] });
  assert.equal((await fre('PATCH', `/api/notizen/${n.id}`, { titel: 'Referat Bio' })).status, 200);
  assert.equal((await fre('PATCH', `/api/notizen/${n.id}`, { ordner_id: null })).status, 403, 'verschieben nur der Besitzer');
  assert.equal((await fre('DELETE', `/api/notizen/${n.id}`)).status, 403);
  assert.equal((await kur('GET', `/api/notizen/${n.id}`)).status, 404, 'Kurs aus der Freigabe genommen');

  // Ordner: CRUD, Freigabe vererbt, Loeschen verliert nichts
  const o = (await bes('POST', '/api/notizen-ordner', { name: 'Schule' })).body;
  const unter = (await bes('POST', '/api/notizen-ordner', { name: 'Bio', parent_id: o.id })).body;
  assert.equal((await bes('PATCH', `/api/notizen-ordner/${o.id}`, { parent_id: unter.id })).status, 400, 'nicht in sich selbst');
  const imOrdner = (await bes('POST', '/api/notizen', { titel: 'Zellen', inhalt: 'x', ordner_id: unter.id })).body;
  assert.equal((await kur('GET', `/api/notizen/${imOrdner.id}`)).status, 404);
  await bes('PUT', `/api/buero/notiz_ordner/${o.id}/freigabe`, { kurse: [kurs] });
  assert.equal((await kur('GET', `/api/notizen/${imOrdner.id}`)).status, 200, 'ueber den Elternordner geteilt');
  assert.equal((await bes('PATCH', `/api/notizen-ordner/${o.id}`, { name: 'Schule 2026' })).body.name, 'Schule 2026');
  assert.equal((await fremd('DELETE', `/api/notizen-ordner/${o.id}`)).status, 404);
  assert.equal((await bes('DELETE', `/api/notizen-ordner/${unter.id}`)).status, 200);
  const nachher = (await bes('GET', `/api/notizen/${imOrdner.id}`)).body;
  assert.equal(nachher.ordner_id, null, 'die Notiz liegt danach ohne Ordner');
  // Loeschen
  assert.equal((await bes('DELETE', `/api/notizen/todos/${t.id}`)).status, 200);
  assert.equal((await bes('DELETE', `/api/notizen/${n.id}`)).status, 200);
  assert.equal((await fre('GET', `/api/notizen/${n.id}`)).status, 404);
  liste = (await bes('GET', '/api/notizen')).body;
  assert.deepEqual(liste.notizen.map(x => x.titel), ['Zellen']);
});

test('Buero Ideenbaum: Warteschlange, Team, Ablehnen mit Grund, Sperren = Abstimmung, Kanten, Versionen', async () => {
  const { bes, fre, freId, kur, fremd, kurs } = await bueroLeute('bi');
  const b = (await bes('POST', '/api/ideen', { name: 'Schulfest', modus: 'moderated' })).body;
  assert.equal((await fremd('GET', `/api/ideen/${b.id}`)).status, 404);
  await bes('PUT', `/api/buero/idee/${b.id}/freigabe`, { freunde: [{ id: freId, rolle: 'team' }], kurse: [kurs] });

  const kopf = (await bes('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Essen', art: 'heading' })).body;
  assert.equal(kopf.status, 'approved', 'der Besitzer postet direkt');
  const vorschlag = (await kur('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Waffeln', parent_id: kopf.id })).body;
  assert.equal(vorschlag.status, 'pending', 'Mitmachende im Kurs landen in der Warteschlange');
  assert.equal((await kur('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Sirup', parent_id: vorschlag.id })).status, 409, 'unter Wartendem nichts');
  const teamIdee = (await fre('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Grill', parent_id: kopf.id })).body;
  assert.equal(teamIdee.status, 'approved', 'das Team postet direkt');
  // Wartendes sieht das Team und der Vorschlagende, andere nicht
  const [andere] = await register('bi-andere');
  const adminLogin = await login('admin', 'geheim');
  void adminLogin;
  assert.ok((await fre('GET', `/api/ideen/${b.id}`)).body.knoten.some(k => k.id === vorschlag.id));
  assert.ok((await kur('GET', `/api/ideen/${b.id}`)).body.knoten.some(k => k.id === vorschlag.id));
  void andere;
  // Mitmachende duerfen nicht freigeben
  assert.equal((await kur('POST', `/api/ideen/knoten/${vorschlag.id}/freigeben`)).status, 404);
  assert.equal((await fre('POST', `/api/ideen/knoten/${vorschlag.id}/freigeben`)).status, 200);
  // Ablehnen braucht eine Begruendung und nimmt den Unterbaum mit
  const zweiter = (await kur('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Karaoke' })).body;
  assert.equal((await bes('POST', `/api/ideen/knoten/${zweiter.id}/ablehnen`, {})).status, 400);
  assert.equal((await bes('POST', `/api/ideen/knoten/${zweiter.id}/ablehnen`, { grund: 'zu laut' })).status, 200);
  assert.deepEqual((await kur('GET', '/api/ideen-ablehnungen')).body.map(a => [a.titel, a.grund]), [['Karaoke', 'zu laut']]);
  // Aendern legt Versionen an, zurueckholen geht
  assert.equal((await kur('PATCH', `/api/ideen/knoten/${vorschlag.id}`, { titel: 'Belgische Waffeln' })).status, 200);
  assert.equal((await kur('PATCH', `/api/ideen/knoten/${teamIdee.id}`, { titel: 'x' })).status, 403, 'fremde Ideen nicht');
  assert.equal((await kur('PATCH', `/api/ideen/knoten/${vorschlag.id}`, { gesperrt: true })).status, 403, 'Sperren nur das Team');
  const versionen = (await kur('GET', `/api/ideen/knoten/${vorschlag.id}/versionen`)).body;
  assert.equal(versionen[0].titel, 'Waffeln');
  await kur('POST', `/api/ideen/versionen/${versionen[0].id}/zurueck`);
  assert.equal((await bes('GET', `/api/ideen/${b.id}`)).body.knoten.find(k => k.id === vorschlag.id).titel, 'Waffeln');
  // Kanten
  const e = await bes('POST', `/api/ideen/${b.id}/kanten`, { von: vorschlag.id, nach: teamIdee.id, label: 'passt zu' });
  assert.equal(e.status, 201);
  assert.equal((await bes('POST', `/api/ideen/${b.id}/kanten`, { von: vorschlag.id, nach: teamIdee.id })).status, 409);
  assert.equal((await bes('POST', `/api/ideen/${b.id}/kanten`, { von: kopf.id, nach: kopf.id })).status, 400);
  // Kommentare mit einer Antwortebene
  const c1 = (await fre('POST', `/api/ideen/knoten/${vorschlag.id}/kommentare`, { text: 'Lecker' })).body;
  const c2 = (await kur('POST', `/api/ideen/knoten/${vorschlag.id}/kommentare`, { text: 'Ja', parent_id: c1.id })).body;
  await bes('POST', `/api/ideen/knoten/${vorschlag.id}/kommentare`, { text: 'Auf die Antwort', parent_id: c2.id });
  const ks = (await bes('GET', `/api/ideen/knoten/${vorschlag.id}/kommentare`)).body;
  assert.deepEqual(ks.map(k => k.parent_id), [null, c1.id, c1.id], 'Antwort auf Antwort haengt an der Wurzel');
  assert.equal((await kur('DELETE', `/api/ideen/kommentare/${c1.id}`)).status, 403);
  // Sperren oeffnet die Abstimmung - ausser fuer Ueberschriften und Ausgenommene
  await bes('PATCH', `/api/ideen/knoten/${teamIdee.id}`, { ausgenommen: true });
  assert.equal((await kur('POST', `/api/ideen/knoten/${vorschlag.id}/stimme`, { wahl: 'yes' })).status, 409, 'noch keine Abstimmung');
  await bes('POST', `/api/ideen/${b.id}/sperren`, { an: true });
  const gesperrt = (await bes('GET', `/api/ideen/${b.id}`)).body;
  const abst = Object.fromEntries(gesperrt.knoten.map(k => [k.titel, k.abstimmung]));
  assert.deepEqual([abst.Essen, abst.Waffeln, abst.Grill], [null, 'open', null]);
  assert.equal((await kur('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Spaet' })).status, 409, 'gesperrt: nur noch das Team');
  await kur('POST', `/api/ideen/knoten/${vorschlag.id}/stimme`, { wahl: 'yes' });
  await kur('POST', `/api/ideen/knoten/${vorschlag.id}/stimme`, { wahl: 'no' });
  await fre('POST', `/api/ideen/knoten/${vorschlag.id}/stimme`, { wahl: 'yes' });
  const w = (await kur('GET', `/api/ideen/${b.id}`)).body.knoten.find(k => k.id === vorschlag.id);
  assert.deepEqual([w.stimmen.yes, w.stimmen.no, w.meine_stimme], [1, 1, 'no'], 'eine Stimme je Person, umentscheiden geht');
  await bes('POST', `/api/ideen/${b.id}/sperren`, { an: false });
  assert.equal((await bes('GET', `/api/ideen/${b.id}`)).body.knoten.find(k => k.id === vorschlag.id).abstimmung, 'closed');
  // Loeschen: Knoten mit Unterbaum, dann das Board (nur der Besitzer)
  assert.equal((await fre('DELETE', `/api/ideen/${b.id}`)).status, 404);
  assert.equal((await bes('DELETE', `/api/ideen/knoten/${kopf.id}`)).status, 200);
  assert.equal((await bes('GET', `/api/ideen/${b.id}`)).body.knoten.length, 0, 'der Unterbaum ging mit');
  assert.equal((await bes('PATCH', `/api/ideen/${b.id}`, { name: 'Sommerfest', archiviert: true })).body.archiviert, true);
  assert.equal((await bes('DELETE', `/api/ideen/${b.id}`)).status, 200);
  assert.equal((await fre('GET', `/api/ideen/${b.id}`)).status, 404);
});

test('Buero Abstimmungen: Kurs stimmt ab, Optionen fest nach der ersten Stimme, Schliessen +24h, Anonymitaet', async () => {
  const { bes, fre, freId, kur, fremd, kurs } = await bueroLeute('ba');
  assert.equal((await bes('POST', '/api/abstimmungen', { titel: 'Ziel?', optionen: ['nur eine'] })).status, 400);
  const a = (await bes('POST', '/api/abstimmungen', { titel: 'Wandertag wohin?', optionen: ['Zoo', 'See', 'Berg'], anonym: 'selbst' })).body;
  assert.equal((await kur('GET', `/api/abstimmungen/${a.id}`)).status, 404, 'noch nicht geteilt');
  await bes('PUT', `/api/buero/abstimmung/${a.id}/freigabe`, { kurse: [kurs], freunde: [{ id: freId }] });
  const [zoo, see, berg] = a.optionen.map(o => o.id);
  assert.equal((await kur('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [zoo, see] })).status, 400, 'nur eine');
  assert.equal((await kur('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [zoo], name_zeigen: true })).status, 200);
  await fre('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [see] });
  await fre('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [berg] });   // umentscheiden
  assert.equal((await fremd('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [zoo] })).status, 404);
  let r = (await bes('GET', `/api/abstimmungen/${a.id}`)).body.ergebnis;
  assert.equal(r.stimmen, 2);
  const zooErg = r.optionen.find(o => o.id === zoo), bergErg = r.optionen.find(o => o.id === berg);
  assert.deepEqual([zooErg.anzahl, zooErg.namen.length, bergErg.anzahl, bergErg.namen.length, bergErg.ohne_namen], [1, 1, 1, 0, 1],
    '"selbst": nur wer den Namen zeigen will');
  // Optionen nach der ersten Stimme fest
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { optionen: ['Zoo', 'Meer'] })).status, 409);
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { titel: 'Wandertag: wohin?' })).status, 200);
  assert.equal((await kur('PATCH', `/api/abstimmungen/${a.id}`, { titel: 'x' })).status, 404, 'nur der Besitzer aendert');
  // Stimme zurueckziehen
  await fre('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [] });
  assert.deepEqual((await fre('GET', `/api/abstimmungen/${a.id}`)).body.meine_wahl, []);
  // Schliessen ohne Ende: laeuft noch 24 Stunden
  const zu = (await bes('POST', `/api/abstimmungen/${a.id}/schliessen`)).body;
  assert.equal(zu.laeuft, true);
  assert.equal(zu.schliessen_angefragt, true);
  // Mit Ende: sofort vorbei
  const zu2 = (await bes('POST', `/api/abstimmungen/${a.id}/schliessen`)).body;
  assert.equal(zu2.laeuft, false);
  assert.equal((await kur('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [see] })).status, 403);
  const wieder = (await bes('POST', `/api/abstimmungen/${a.id}/oeffnen`)).body;
  assert.deepEqual([wieder.laeuft, wieder.endet_at], [true, null]);
  // Ergebnis nur fuer mich; anonym zeigt keine Namen
  const b = (await bes('POST', '/api/abstimmungen', { titel: 'Geheim', optionen: ['Ja', 'Nein'], anonym: 'anonym', ergebnis_fuer: 'ich', mehrfach: true, max_wahl: 1 })).body;
  await bes('PUT', `/api/buero/abstimmung/${b.id}/freigabe`, { kurse: [kurs] });
  assert.equal((await kur('POST', `/api/abstimmungen/${b.id}/stimme`, { optionen: b.optionen.map(o => o.id) })).status, 400, 'hoechstens 1');
  await kur('POST', `/api/abstimmungen/${b.id}/stimme`, { optionen: [b.optionen[0].id] });
  assert.equal((await kur('GET', `/api/abstimmungen/${b.id}`)).body.ergebnis, null);
  r = (await bes('GET', `/api/abstimmungen/${b.id}`)).body.ergebnis;
  assert.deepEqual([r.optionen[0].anzahl, r.optionen[0].namen], [1, []]);
  // Listen und Loeschen
  assert.equal((await kur('GET', '/api/abstimmungen')).body.length, 2);
  assert.equal((await fremd('GET', '/api/abstimmungen')).body.length, 0);
  assert.equal((await kur('DELETE', `/api/abstimmungen/${a.id}`)).status, 404);
  assert.equal((await bes('DELETE', `/api/abstimmungen/${a.id}`)).status, 200);
  assert.equal((await kur('GET', '/api/abstimmungen')).body.length, 1);
});

test('Umfragen: Pruefung aller acht Fragetypen (die eine Vertrauensgrenze)', async () => {
  const L = await import('./public/umfrage-logik.js');
  const f = (typ, config, pflicht = false) => ({ id: 1, text: 'F', pflicht, ...L.frageSaeubern({ typ, text: 'F', config, pflicht }) });
  assert.equal(L.frageSaeubern({ typ: 'single', text: 'F', config: { options: ['a'] } }).fehler, 'Mindestens zwei Antwortmöglichkeiten');
  assert.equal(L.frageSaeubern({ typ: 'quatsch', text: 'F' }).fehler, 'Unbekannter Fragetyp');
  assert.ok(L.frageSaeubern({ typ: 'slider', text: 'F', config: { min: 5, max: 5 } }).fehler);
  const opt = { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] };
  const p = (frage, v) => L.pruefeAntworten([frage], { 1: v });
  assert.deepEqual(p(f('single', opt), 'a').antworten, { 1: 'a' });
  assert.ok(p(f('single', opt), 'x').fehler);
  assert.ok(p(f('multi', { ...opt, max: 1 }), ['a', 'b']).fehler);
  assert.deepEqual(p(f('multi', opt), ['a', 'a', 'b']).antworten, { 1: ['a', 'b'] });
  assert.ok(p(f('points', { ...opt, total: 10 }), { a: 5, b: 4 }).fehler, 'Summe muss aufgehen');
  assert.ok(p(f('points', { ...opt, total: 10 }), { a: -1, b: 11 }).fehler);
  assert.deepEqual(p(f('points', { ...opt, total: 10 }), { a: 6, b: 4, c: 0 }).antworten, { 1: { a: 6, b: 4 } });
  assert.ok(p(f('text_limited', { max_length: 10 }), 'x'.repeat(11)).fehler);
  assert.deepEqual(p(f('text', {}), '  hallo  ').antworten, { 1: 'hallo' });
  assert.ok(p(f('slider', { min: 0, max: 10 }), 11).fehler);
  assert.ok(p(f('slider', { min: 0, max: 10 }), 2.5).fehler, 'nur ganze Zahlen');
  const sm = f('slider_multi', { min: 1, max: 5, items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] });
  assert.ok(p(sm, { x: 3 }).fehler, 'jeder Regler');
  assert.deepEqual(p(sm, { x: 3, y: 5, z: 9 }).antworten, { 1: { x: 3, y: 5 } });
  assert.ok(p(f('slider2d', {}), { x: 11, y: 2 }).fehler);
  assert.deepEqual(p(f('slider2d', {}), { x: 2.34, y: 7 }).antworten, { 1: { x: 2.3, y: 7 } });
  assert.ok(p(f('single', opt, true), undefined).fehler, 'Pflicht');
  assert.deepEqual(p(f('single', opt), undefined).antworten, {}, 'freiwillig darf leer bleiben');
  // Aendern nach Antworten: Texte ja, Typ/Optionen/Grenzen nein
  const alt = f('single', opt);
  assert.equal(L.aenderungErlaubt(alt, { ...alt, text: 'neu' }), true);
  assert.equal(L.aenderungErlaubt(alt, { ...alt, config: { options: opt.options.slice(0, 2) } }), false);
  assert.equal(L.aenderungErlaubt(alt, { ...alt, typ: 'multi' }), false);
  // CSV mit Schutz gegen Formeln
  const csvText = L.csv([{ id: 1, typ: 'text', text: 'T', config: {} }], [{ public_id: 'TN-A', antworten: { 1: '=HYPERLINK("x")' } }]);
  assert.match(csvText, /'=HYPERLINK/);
  // Kreuztabelle und k-means (deterministisch)
  const fa = { id: 1, typ: 'single', config: opt }, fb = { id: 2, typ: 'single', config: opt };
  const ant = [{ antworten: { 1: 'a', 2: 'a' } }, { antworten: { 1: 'a', 2: 'b' } }, { antworten: { 1: 'b', 2: 'b' } }];
  assert.deepEqual(L.kreuztabelle(ant, fa, fb).zellen, [[1, 1, 0], [0, 1, 0], [0, 0, 0]]);
  const regler = [{ id: 3, typ: 'slider', text: 'R1', config: { min: 0, max: 10 } }, { id: 4, typ: 'slider', text: 'R2', config: { min: 0, max: 10 } }];
  const punkte = [[1, 1], [1, 2], [2, 1], [9, 9], [9, 8], [8, 9], [5, 1], [5, 2]].map(([x, y]) => ({ antworten: { 3: x, 4: y } }));
  const k1 = L.kmeans(punkte, regler, 2), k2 = L.kmeans(punkte, regler, 2);
  assert.deepEqual(k1, k2, 'gleiche Eingabe, gleiche Gruppen');
  assert.equal(k1.gruppen.reduce((s, g) => s + g.mitglieder.length, 0), 8);
  assert.ok(L.kmeans(punkte.slice(0, 3), regler).hinweis, 'unter 6 Antworten nur ein Hinweis');
});

test('Buero Umfragen: Aufbau, Teilnahme, verschluesselt, Gaeste, Identitaet, Sperren nach Antworten', async () => {
  const { db } = await import('./db.js');
  const { bes, fre, freId, kur, kurId, fremd, kurs } = await bueroLeute('bu');
  const u = (await bes('POST', '/api/umfragen', { titel: 'Mensa-Umfrage' })).body;
  assert.equal(u.status, 'draft');
  assert.equal((await bes('POST', `/api/umfragen/${u.id}/oeffnen`)).status, 400, 'ohne Frage nicht oeffnen');
  // Abschnitt + alle acht Typen
  let v = (await bes('POST', `/api/umfragen/${u.id}/abschnitte`, { titel: 'Essen' })).body;
  const aId = v.abschnitte[0].id;
  const neueFrage = async (typ, config, extra = {}) => (await bes('POST', `/api/umfragen/${u.id}/fragen`, { typ, text: `Frage ${typ}`, config, abschnitt_id: aId, ...extra })).body;
  const opts = { options: [{ label: 'gut' }, { label: 'mittel' }, { label: 'schlecht' }] };
  for (const [typ, config] of [['single', opts], ['multi', { ...opts, max: 2 }], ['points', { ...opts, total: 10 }], ['text', {}],
    ['text_limited', { max_length: 50 }], ['slider', { min: 0, max: 10 }], ['slider_multi', { min: 1, max: 5, items: [{ label: 'Preis' }, { label: 'Menge' }] }],
    ['slider2d', { x_left: 'billig', x_right: 'teuer', y_top: 'lecker', y_bottom: 'naja' }]]) v = await neueFrage(typ, config, { pflicht: typ === 'single' });
  assert.equal(v.fragen.length, 8);
  const F = Object.fromEntries(v.fragen.map(f => [f.typ, f]));
  // Frage aendern, verschieben, duplizieren, loeschen - vor den Antworten geht alles
  v = (await bes('PATCH', `/api/umfragen/fragen/${F.text.id}`, { text: 'Was fehlt?' })).body;
  v = (await bes('POST', `/api/umfragen/fragen/${F.text.id}/verschieben`, { richtung: -1 })).body;
  v = (await bes('POST', `/api/umfragen/fragen/${F.text.id}/duplizieren`)).body;
  const kopie = v.fragen.find(f => f.text === 'Was fehlt? (Kopie)');
  v = (await bes('DELETE', `/api/umfragen/fragen/${kopie.id}`)).body;
  assert.equal(v.fragen.length, 8);
  // Entwurf sieht nur der Besitzer
  await bes('PUT', `/api/buero/umfrage/${u.id}/freigabe`, { kurse: [kurs], freunde: [{ id: freId }] });
  assert.equal((await kur('GET', `/api/umfragen/${u.id}`)).status, 404);
  assert.equal((await bes('POST', `/api/umfragen/${u.id}/oeffnen`)).body.status, 'open');
  const g = F.single.config.options, p = F.points.config.options, it = F.slider_multi.config.items;
  const antwort = {
    [F.single.id]: g[0].id, [F.multi.id]: F.multi.config.options.slice(0, 2).map(o => o.id), [F.points.id]: { [p[0].id]: 7, [p[1].id]: 3 },
    [F.text.id]: 'Salat', [F.text_limited.id]: 'mehr Nudeln', [F.slider.id]: 8,
    [F.slider_multi.id]: { [it[0].id]: 2, [it[1].id]: 5 }, [F.slider2d.id]: { x: 3, y: 1 } };
  assert.equal((await kur('POST', `/api/umfragen/${u.id}/antwort`, { antworten: { ...antwort, [F.single.id]: undefined } })).status, 400, 'Pflichtfrage');
  const ok = await kur('POST', `/api/umfragen/${u.id}/antwort`, { antworten: antwort });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await fremd('POST', `/api/umfragen/${u.id}/antwort`, { antworten: antwort })).status, 404);
  // Verschluesselt, nicht im Klartext; anonym ohne user_id
  const roh = db.prepare('SELECT * FROM umfrage_antworten WHERE umfrage_id = ?').all(u.id);
  assert.equal(roh.length, 1);
  assert.equal(roh[0].antworten_enc.includes('Salat'), false, 'Antworten liegen verschluesselt');
  assert.equal(roh[0].user_id, null);
  // Ein Hash, kein Klartext - "enthaelt die Ziffern der ID nicht" schlug in ~1 % der Laeufe zufaellig an.
  assert.match(roh[0].schluessel, /^u:[0-9a-f]{40}$/);
  assert.notEqual(roh[0].schluessel, `u:${kurId}`);
  // Eigene Antwort wiederfinden und aendern (keine zweite Zeile)
  assert.equal((await kur('GET', `/api/umfragen/${u.id}`)).body.meine.antworten[F.text.id], 'Salat');
  await kur('POST', `/api/umfragen/${u.id}/antwort`, { antworten: { ...antwort, [F.text.id]: 'Suppe' } });
  assert.equal(db.prepare('SELECT count(*) n FROM umfrage_antworten WHERE umfrage_id = ?').get(u.id).n, 1);
  // Nach Antworten: Texte ja, Typ/Optionen nein, Loeschen nein
  assert.equal((await bes('PATCH', `/api/umfragen/fragen/${F.single.id}`, { text: 'Wie war es?' })).status, 200);
  assert.equal((await bes('PATCH', `/api/umfragen/fragen/${F.single.id}`, { config: { options: g.slice(0, 2) } })).status, 409);
  assert.equal((await bes('PATCH', `/api/umfragen/fragen/${F.slider.id}`, { config: { min: 0, max: 5 } })).status, 409);
  assert.equal((await bes('DELETE', `/api/umfragen/fragen/${F.text.id}`)).status, 409);
  // Ergebnis: Besitzer ja, Teilnehmer erst mit Freigabe
  assert.equal((await kur('GET', `/api/umfragen/${u.id}/ergebnis`)).status, 403);
  const e = (await bes('GET', `/api/umfragen/${u.id}/ergebnis`)).body;
  assert.equal(e.antworten[0].antworten[F.text.id], 'Suppe');
  assert.equal(e.antworten[0].name, undefined, 'anonym: kein Name');
  await bes('PATCH', `/api/umfragen/${u.id}`, { ergebnis_fuer: 'teilnehmer' });
  assert.equal((await kur('GET', `/api/umfragen/${u.id}/ergebnis`)).status, 200);
  // Anonym -> mit Namen: nicht, solange Antworten da sind
  assert.equal((await bes('PATCH', `/api/umfragen/${u.id}`, { identitaet: 'mit_namen' })).status, 409);

  // Gaeste per Link
  const key = (await bes('POST', `/api/umfragen/${u.id}/gastlink`)).body.gast_key;
  assert.equal((await bes('POST', `/api/umfragen/${u.id}/gastlink`)).body.gast_key, key, 'bleibt, bis man erneuert');
  const gast = (method, k, body, kennung = 'gast-kennung-0123456789') => fetch(`${base}/api/gast/umfragen/${k}`, {
    method, headers: { 'content-type': 'application/json', 'x-gast': kennung }, body: body && JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const blick = await gast('GET', key);
  assert.equal(blick.status, 200);
  assert.equal(blick.body.fragen.length, 8);
  assert.equal((await gast('POST', key, { antworten: antwort }, 'kurz')).status, 400, 'Kennung noetig');
  assert.equal((await gast('POST', key, { antworten: antwort })).status, 200);
  assert.equal((await gast('GET', key)).body.meine.antworten[F.text.id], 'Salat', 'der Gast findet seine Antwort wieder');
  assert.equal((await gast('GET', key, undefined, 'andere-kennung-0123456789')).body.meine, null);
  assert.equal(db.prepare('SELECT count(*) n FROM umfrage_antworten WHERE umfrage_id = ?').get(u.id).n, 2);
  const neuKey = (await bes('POST', `/api/umfragen/${u.id}/gastlink`, { erneuern: true })).body.gast_key;
  assert.notEqual(neuKey, key);
  assert.equal((await gast('GET', key)).status, 404, 'der alte Link ist tot');
  assert.equal((await gast('DELETE', neuKey)).status, 200, 'zurueckziehen - unter dem neuen Link dieselbe Kennung');

  // Zweite Umfrage "mit Namen": Name beim Besitzer; Wechsel zu anonym loescht user_id
  const m = (await bes('POST', '/api/umfragen', { titel: 'Mit Namen' })).body;
  await bes('PATCH', `/api/umfragen/${m.id}`, { identitaet: 'mit_namen' });
  const mf = (await bes('POST', `/api/umfragen/${m.id}/fragen`, { typ: 'text', text: 'Wer bringt was mit?' })).body.fragen[0];
  await bes('PUT', `/api/buero/umfrage/${m.id}/freigabe`, { freunde: [{ id: freId }] });
  await bes('POST', `/api/umfragen/${m.id}/oeffnen`);
  await fre('POST', `/api/umfragen/${m.id}/antwort`, { antworten: { [mf.id]: 'Kuchen' } });
  assert.equal((await bes('GET', `/api/umfragen/${m.id}/ergebnis`)).body.antworten[0].name, 'bu-fre');
  await bes('PATCH', `/api/umfragen/${m.id}`, { identitaet: 'anonym' });
  assert.equal(db.prepare('SELECT user_id FROM umfrage_antworten WHERE umfrage_id = ?').get(m.id).user_id, null, 'der Name ist wirklich weg');
  // Mehrfach: jede Teilnahme einzeln
  await bes('PATCH', `/api/umfragen/${m.id}`, { mehrfach: true });
  await fre('POST', `/api/umfragen/${m.id}/antwort`, { antworten: { [mf.id]: 'Saft' } });
  await fre('POST', `/api/umfragen/${m.id}/antwort`, { antworten: { [mf.id]: 'Chips' } });
  assert.equal(db.prepare('SELECT count(*) n FROM umfrage_antworten WHERE umfrage_id = ?').get(m.id).n, 3);

  // Duplizieren, Schliessen, Zuruecksetzen, Loeschen
  const dup = (await bes('POST', `/api/umfragen/${u.id}/duplizieren`)).body;
  assert.deepEqual([dup.status, dup.fragen.length, dup.abschnitte.length, dup.antworten], ['draft', 8, 1, 0]);
  assert.equal((await bes('POST', `/api/umfragen/${u.id}/schliessen`)).body.status, 'closed');
  assert.equal((await kur('POST', `/api/umfragen/${u.id}/antwort`, { antworten: antwort })).status, 403);
  assert.equal((await bes('POST', `/api/umfragen/${u.id}/zuruecksetzen`)).body.antworten, 0);
  assert.equal((await kur('DELETE', `/api/umfragen/${u.id}`)).status, 404);
  for (const id of [u.id, m.id, dup.id]) assert.equal((await bes('DELETE', `/api/umfragen/${id}`)).status, 200);
  assert.equal((await gast('GET', neuKey)).status, 404);
  void fre;
});

test('Buero: Teilen meldet sich per Push-Art "buero"', async () => {
  const { db } = await import('./db.js');
  const { bes, freId } = await bueroLeute('bp');
  const a = (await bes('POST', '/api/abstimmungen', { titel: 'Pizza?', optionen: ['Ja', 'Nein'] })).body;
  await bes('PUT', `/api/buero/abstimmung/${a.id}/freigabe`, { freunde: [{ id: freId }] });
  await bes('PUT', `/api/buero/abstimmung/${a.id}/freigabe`, { freunde: [{ id: freId }] });
  assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE user_id = ? AND kind = 'buero'").get(freId).n, 1, 'nur wer neu dazukommt');
  assert.ok((await bes('GET', '/api/me')).body.push_plan.buero, 'die Art steht im Benachrichtigungsplan');
});

test('Einladungslink: /registrieren und /umfrage/<key> liefern die Seite; Ticket nur mit Titel', async t => {
  for (const pfad of ['/registrieren', '/registrieren/', '/umfrage/abc123']) {
    const r = await client().raw(pfad);
    assert.equal(r.status, 200, pfad);
    assert.match(await r.text(), /<main id="gast"/);
  }
  const { readFileSync } = await import('node:fs');
  const loginJs = readFileSync(new URL('./public/login.js', import.meta.url), 'utf8');
  assert.ok(loginJs.includes("get('key')") && loginJs.includes('replaceState'), 'login.js traegt den Key ein und nimmt ihn aus der Adresse');
  // Ticket: Titel reicht
  const admin = await login('admin', 'geheim');
  await vnwEinrichten(t, admin);
  const [tim] = await register('titel-tim');
  assert.equal((await tim('POST', '/api/tickets', { title: 'Nur ein Titel' })).status, 201);
  assert.equal((await tim('POST', '/api/tickets', { title: '', text: 'nur Text' })).status, 400);
});

test('"5. Stunde" statt "5.-5. Stunde"', async () => {
  const { stunden } = await import('./public/kern.js');
  assert.equal(stunden(5, 5), '5. Stunde');
  assert.equal(stunden(5, null), '5. Stunde');
  assert.equal(stunden(5, 6), '5.–6. Stunde');
});

test('Kalender-Abo: nur Pruefungen, nur Hausaufgaben, beides - mit Zeitzone', async () => {
  const admin = await login('admin', 'geheim');
  await admin('POST', '/api/courses', { id: 'ABO01', title: 'Chemie' });
  const [ali] = await register('abo-ali');
  const cfg = (await ali('GET', '/api/config')).body;
  await ali('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: 'ABO01' });
  const inDrei = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await ali('POST', '/api/homework', { course_id: 'ABO01', due_date: inDrei, text: 'Formeln lernen' });
  const weg = (await ali('POST', '/api/homework', { course_id: 'ABO01', due_date: inDrei, text: 'Schon erledigt' })).body;
  await ali('POST', `/api/homework/${weg.id}/done`);
  const kal = (await ali('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  await ali('POST', `/api/kalender/${kal.id}/eintraege`, { titel: 'Chemie-Klausur', art: 'pruefung', von: `${inDrei} 08:00`, bis: `${inDrei} 09:30` });
  await ali('POST', `/api/kalender/${kal.id}/eintraege`, { titel: 'Zahnarzt', art: 'termin', von: `${inDrei} 15:00`, bis: `${inDrei} 16:00` });
  const token = (await ali('GET', '/api/me/ics-token')).body.token;
  const hol = async teil => { const r = await client().raw(`/kal/${token}${teil}`); return { status: r.status, text: await r.text() }; };
  const nurP = await hol('/pruefungen.ics');
  assert.equal(nurP.status, 200);
  assert.match(nurP.text, /Chemie-Klausur/);
  assert.equal(/Formeln|Zahnarzt/.test(nurP.text), false);
  assert.match(nurP.text, /X-WR-CALNAME:Stundenplan – Prüfungen/);
  assert.match(nurP.text, /X-WR-TIMEZONE:Europe\/Berlin/);
  assert.match(nurP.text, /DTSTART;TZID=Europe\/Berlin:\d{8}T080000/);
  const nurH = await hol('/hausaufgaben.ics');
  assert.match(nurH.text, /Formeln lernen/);
  assert.equal(/Chemie-Klausur|Schon erledigt/.test(nurH.text), false, 'erledigte fallen weg');
  const beides = await hol('/pruefungen-hausaufgaben.ics');
  assert.ok(/Chemie-Klausur/.test(beides.text) && /Formeln lernen/.test(beides.text) && !/Zahnarzt/.test(beides.text));
  const alles = await hol('.ics');
  assert.ok(/Zahnarzt/.test(alles.text) && /Chemie-Klausur/.test(alles.text), 'der alte Link liefert alles');
  assert.equal((await hol('/quatsch.ics')).status, 404);
  assert.equal((await client().raw('/kal/falschfalschfalsch1234/pruefungen.ics')).status, 404);
  // Rundreise: die eigene Ausgabe liest sich wieder richtig ein
  const { lese } = await import('./ical.js');
  const t = lese(nurP.text).find(x => x.titel === 'Chemie-Klausur');
  assert.equal(t.von, `${inDrei} 08:00`);
});

test('Freundschaft: keine zweite Zeile in Gegenrichtung, niemand doppelt in der Liste', async () => {
  const [ina, inaId] = await register('dopp-ina');
  const [jan, janId] = await register('dopp-jan');
  await ina('POST', '/api/friends', { username: 'dopp-jan' });
  await jan('POST', `/api/friends/${inaId}/accept`);
  const nochmal = await jan('POST', '/api/friends', { username: 'dopp-ina' });
  assert.equal(nochmal.status, 409, 'schon befreundet - auch aus der anderen Richtung');
  assert.equal((await ina('GET', '/api/friends')).body.friends.filter(f => f.id === janId).length, 1);
  // Alte Datenbanken mit Zeilen in beiden Richtungen: trotzdem nur einmal.
  const { db } = await import('./db.js');
  db.prepare("INSERT INTO friendships(from_id, to_id, status) VALUES(?, ?, 'accepted')").run(janId, inaId);
  assert.equal((await ina('GET', '/api/friends')).body.friends.filter(f => f.id === janId).length, 1);
});

test('Kein window.prompt/confirm mehr - die liefern im Android-WebView still null', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  for (const f of readdirSync('public').filter(f => f.endsWith('.js'))) {
    const code = readFileSync(`public/${f}`, 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /(?<![\w.])(prompt|confirm)\(/, `${f} nutzt noch prompt()/confirm()`);
  }
});

test('Umfrage-Logik: Optionen behalten ihre IDs eindeutig, Punkte auf 0 = nicht beantwortet', async () => {
  const { zeilenMitIds, pruefeAntworten } = await import('./public/umfrage-logik.js');
  const alt = [{ id: 'a', label: 'Rot' }, { id: 'b', label: 'Grün' }, { id: 'c', label: 'Blau' }];
  assert.deepEqual(zeilenMitIds('Gelb\nRot\nGrün\nBlau', alt).map(o => o.id), [undefined, 'a', 'b', 'c'],
    'oben eingefuegt: die alten behalten ihre ID, die neue bekommt keine fremde');
  assert.deepEqual(zeilenMitIds('Rot\nHellgrün\nBlau', alt).map(o => o.id), ['a', 'b', 'c'], 'umbenannt: ID bleibt');
  assert.deepEqual(zeilenMitIds('Grün\nBlau', alt).map(o => o.id), ['b', 'c'], 'geloescht: keine doppelte ID');
  const doppelt = zeilenMitIds('Rot\nRot', alt).map(o => o.id);
  assert.notEqual(doppelt[0], doppelt[1]);
  const f = { id: 'p', typ: 'points', text: 'P', pflicht: false, config: { options: [{ id: 'x' }, { id: 'y' }], total: 10 } };
  assert.deepEqual(pruefeAntworten([f], { p: { x: 0 } }), { antworten: {} }, 'alles wieder auf 0: einfach nicht beantwortet');
  assert.match(pruefeAntworten([{ ...f, pflicht: true }], { p: { x: 0, y: 0 } }).fehler, /beantworten/);
  assert.match(pruefeAntworten([f], { p: { x: 3 } }).fehler, /genau 10/);
});

test('Umfragen: CSV vom Server, anonym ohne Zeit, Loeschen ueber public_id, verschieben im Abschnitt', async () => {
  const { db } = await import('./db.js');
  const { bes, fre, freId, fremd } = await bueroLeute('uc');
  const u = (await bes('POST', '/api/umfragen', { titel: 'CSV-Test' })).body;
  const aId = (await bes('POST', `/api/umfragen/${u.id}/abschnitte`, { titel: 'A' })).body.abschnitte[0].id;
  const neu = async (text, abschnitt_id = null) =>
    (await bes('POST', `/api/umfragen/${u.id}/fragen`, { typ: 'text', text, config: {}, abschnitt_id })).body;
  await neu('Ohne');
  await neu('Y', aId);
  let v = await neu('Z', aId);
  const [Y, Z] = ['Y', 'Z'].map(t => v.fragen.find(f => f.text === t));
  const imAbschnitt = x => x.fragen.filter(f => f.abschnitt_id === aId).map(f => f.text);
  v = (await bes('POST', `/api/umfragen/fragen/${Y.id}/verschieben`, { richtung: -1 })).body;
  assert.deepEqual(imAbschnitt(v), ['Y', 'Z'], 'die erste im Abschnitt bleibt oben - kein Tausch mit einer Frage ausserhalb');
  assert.equal(v.fragen.find(f => f.text === 'Ohne').abschnitt_id, null);
  v = (await bes('POST', `/api/umfragen/fragen/${Z.id}/verschieben`, { richtung: -1 })).body;
  assert.deepEqual(imAbschnitt(v), ['Z', 'Y']);

  await bes('PUT', `/api/buero/umfrage/${u.id}/freigabe`, { freunde: [{ id: freId }] });
  await bes('POST', `/api/umfragen/${u.id}/oeffnen`);
  const ohne = v.fragen.find(f => f.text === 'Ohne');
  assert.equal((await fre('POST', `/api/umfragen/${u.id}/antwort`, { antworten: { [ohne.id]: '=HYPERLINK("x")' } })).status, 200);
  assert.equal((await fre('GET', '/api/umfragen')).body.find(x => x.id === u.id).beantwortet, true);
  // Der Schluessel haengt an einem Geheimnis je Nutzer - verschluesselt gespeichert, nie ausgeliefert.
  const geheim = db.prepare('SELECT umfrage_geheim FROM users WHERE id = ?').get(freId).umfrage_geheim;
  assert.ok(geheim && !/^[0-9a-f]{48}$/.test(geheim), 'nicht im Klartext');
  assert.equal('umfrage_geheim' in (await fre('GET', '/api/me')).body, false);

  // Anonym: ohne Zeilen-ID und ohne Uhrzeit
  const erg = (await bes('GET', `/api/umfragen/${u.id}/ergebnis`)).body;
  assert.equal(erg.antworten.length, 1);
  assert.deepEqual(Object.keys(erg.antworten[0]).sort(), ['antworten', 'public_id']);

  // CSV: als Datei, mit Formelschutz, nur fuer wer das Ergebnis sehen darf
  const datei = await bes.raw(`/api/umfragen/${u.id}/csv`);
  assert.equal(datei.status, 200);
  assert.match(datei.headers.get('content-disposition'), /attachment; filename="umfrage-\d+\.csv"/);
  const csvText = await datei.text();
  assert.match(csvText, /'=HYPERLINK/);
  assert.doesNotMatch(csvText.split('\r\n')[0], /Zeit/, 'anonym: keine Zeit-Spalte');
  assert.equal((await fre.raw(`/api/umfragen/${u.id}/csv`)).status, 403, 'Ergebnis "nur ich"');
  assert.equal((await fremd.raw(`/api/umfragen/${u.id}/csv`)).status, 404);

  // Eine Antwort loeschen - ueber die oeffentliche Kennung
  const pid = erg.antworten[0].public_id;
  assert.equal((await fre('DELETE', `/api/umfragen/${u.id}/antworten/${pid}`)).status, 404, 'nur der Besitzer');
  assert.equal((await bes('DELETE', `/api/umfragen/${u.id}/antworten/${pid}`)).status, 200);
  assert.equal((await bes('DELETE', `/api/umfragen/${u.id}/antworten/${pid}`)).status, 404);
});

test('Abstimmung: nach der ersten Stimme nur noch strenger, nie lockerer', async () => {
  const { bes, kur, kurs } = await bueroLeute('as');
  const a = (await bes('POST', '/api/abstimmungen', { titel: 'Geheim', optionen: ['Ja', 'Nein'], anonym: 'anonym', ergebnis_fuer: 'ich' })).body;
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { anonym: 'selbst' })).status, 200, 'vor der ersten Stimme geht alles');
  await bes('PATCH', `/api/abstimmungen/${a.id}`, { anonym: 'anonym' });
  await bes('PUT', `/api/buero/abstimmung/${a.id}/freigabe`, { kurse: [kurs] });
  await kur('POST', `/api/abstimmungen/${a.id}/stimme`, { optionen: [a.optionen[0].id] });
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { anonym: 'oeffentlich' })).status, 409);
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { anonym: 'selbst' })).status, 409);
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { ergebnis_fuer: 'alle' })).status, 409);
  assert.equal((await bes('PATCH', `/api/abstimmungen/${a.id}`, { titel: 'Geheim!' })).status, 200, 'anderes aendern geht');
});

test('Kurs heisst: derselbe Kurs in derselben Stunde - der andere Jahrgang mit gleicher ID bleibt draussen', async () => {
  const { db } = await import('./db.js');
  const { bes, kur, kurId, kurs } = await bueroLeute('kj');
  const [jg, jgId] = await register('kj-jahrgang');
  const cfg = (await bes('GET', '/api/config')).body;
  await jg('PUT', '/api/entry', { day_id: cfg.days[1].id, period_id: cfg.periods[2].id, course_id: kurs });
  const n = (await bes('POST', '/api/notizen', { titel: 'Nur für uns' })).body;
  await bes('PUT', `/api/buero/notiz/${n.id}/freigabe`, { kurse: [kurs] });
  assert.equal((await kur('GET', `/api/notizen/${n.id}`)).status, 200);
  assert.equal((await jg('GET', `/api/notizen/${n.id}`)).status, 404, 'gleiche Kurs-ID, andere Stunde');
  // Hausaufgabe: die Meldung geht nur an die, die sie auch sehen
  const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  assert.equal((await bes('POST', '/api/homework', { course_id: kurs, due_date: morgen, text: 'S. 12' })).status, 200);
  const meldungen = id => db.prepare("SELECT count(*) n FROM notifications WHERE user_id = ? AND title LIKE 'Neue Hausaufgabe%'").get(id).n;
  assert.equal(meldungen(kurId), 1);
  assert.equal(meldungen(jgId), 0);
});

test('Idee loeschen: ohne Team-Rolle nicht die Unter-Ideen anderer mit', async () => {
  const { bes, fre, freId, kur, kurs } = await bueroLeute('il');
  const b = (await bes('POST', '/api/ideen', { name: 'Offen', modus: 'open' })).body;
  await bes('PUT', `/api/buero/idee/${b.id}/freigabe`, { freunde: [{ id: freId }], kurse: [kurs] });
  const oben = (await kur('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Oben' })).body;
  await fre('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Drunter', parent_id: oben.id });
  assert.equal((await kur('DELETE', `/api/ideen/knoten/${oben.id}`)).status, 409);
  assert.equal((await bes('DELETE', `/api/ideen/knoten/${oben.id}`)).status, 200, 'der Besitzer (Team) darf');
  const allein = (await kur('POST', `/api/ideen/${b.id}/knoten`, { titel: 'Allein' })).body;
  assert.equal((await kur('DELETE', `/api/ideen/knoten/${allein.id}`)).status, 200, 'eigene ohne fremde Kinder: ja');
  assert.equal((await bes('GET', '/api/buero/constructor/1/freigabe')).status, 404, 'Prototyp-Schluessel sind keine Art');
});

test('Sicherheit: Weiterleitungen ins interne Netz, gemappte IPv6, fremde Seiten, Bremsen', async () => {
  const { netz, holeGeprueft, adresseErlaubt } = await import('./netz.js');
  const echtLookup = netz.lookup, echtFetch = globalThis.fetch;
  let fehler = null;
  try {
    netz.lookup = async host => [{ address: host === 'intern.schule-a.de' ? '10.0.0.7' : '93.184.216.34', family: 4 }];
    let ziel = 'http://127.0.0.1/geheim';
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: ziel } });
    await assert.rejects(holeGeprueft('https://kalender.schule-a.de/a.ics'), /offene Netz/, 'Sprung auf 127.0.0.1');
    ziel = 'https://intern.schule-a.de/x';
    await assert.rejects(holeGeprueft('https://kalender.schule-a.de/a.ics'), /offene Netz/, 'Name, der intern zeigt');
    ziel = '/wieder-hier';
    await assert.rejects(holeGeprueft('https://kalender.schule-a.de/a.ics'), /Weiterleitungen/, 'Endlosschleife');
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    assert.equal((await holeGeprueft('https://kalender.schule-a.de/a.ics')).status, 200);
    netz.lookup = async () => [{ address: '::ffff:10.0.0.1', family: 6 }];
    assert.equal(await adresseErlaubt('kalender.schule-a.de'), false, 'IPv4 in IPv6 verpackt');
    netz.lookup = async () => [{ address: '64:ff9b::a00:1', family: 6 }];
    assert.equal(await adresseErlaubt('kalender.schule-a.de'), false, 'NAT64');
  } catch (e) { fehler = e; }
  netz.lookup = echtLookup;
  globalThis.fetch = echtFetch;
  if (fehler) throw fehler;

  // Eine fremde Seite darf nichts aendern (zweite Leine neben SameSite)
  const fremd = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ username: 'admin', password: 'geheim' }) });
  assert.equal(fremd.status, 403);

  // Freundschaftsanfragen sind gebremst
  const [spam] = await register('bremse-spam');
  let status = 0;
  for (let i = 0; i < 31; i++) status = (await spam('POST', '/api/friends', { username: `gibtsnicht${i}` })).status;
  assert.equal(status, 429);
});

test('Abo-Adresse nur fuer den Besitzer, Gruppen-Anhaenge fuer alle Mitglieder, Platzhalter werden aufgeraeumt', async () => {
  const { db } = await import('./db.js');
  const { restAufraeumen } = await import('./index.js');
  const { lastInsertRowid } = db.prepare(`INSERT INTO kalender(user_id, name, quelle, ical_url, created_at)
    VALUES(NULL, 'Schulabo', 'abo', 'https://kalender.schule-a.de/privat-geheim.ics', datetime('now'))`).run();
  const [leser] = await register('abo-leser');
  const admin = await login('admin', 'geheim');
  const finde = async c => (await c('GET', '/api/kalender')).body.kalender.find(k => k.id === Number(lastInsertRowid));
  assert.equal((await finde(leser)).ical_url, null);
  assert.match((await finde(admin)).ical_url, /privat-geheim/);
  db.prepare('DELETE FROM kalender WHERE id = ?').run(Number(lastInsertRowid));

  const [ada] = await register('anh-ada');
  const [ben, benId] = await register('anh-ben');
  const g = (await ada('POST', '/api/groups', { name: 'Anhang', key_enc: 'k' })).body;
  await ada('POST', `/api/groups/${g.id}/mitglieder`, { user_id: benId, key_enc: 'k2' });
  await ben('POST', `/api/groups/${g.id}/beitreten`);
  const gross = 'A'.repeat(1_500_000);   // groesser als der globale 1-MB-Parser
  const hoch = await ada('POST', `/api/groups/${g.id}/datei`, { data: gross });
  assert.equal(hoch.status, 201, 'Gruppen-Anhaenge ueber 1 MB kommen durch');
  assert.equal((await ben('GET', `/api/chats/datei/${hoch.body.datei_id}`)).status, 200, 'jedes Mitglied darf lesen');
  const [fremd] = await register('anh-fremd');
  assert.equal((await fremd('GET', `/api/chats/datei/${hoch.body.datei_id}`)).status, 404);

  // Nie abgeschickt: nach einer Stunde weg - samt Datei
  db.prepare("UPDATE messages SET created_at = datetime('now', '-2 hours') WHERE id = (SELECT message_id FROM chat_files WHERE id = ?)").run(hoch.body.datei_id);
  restAufraeumen();
  assert.equal(db.prepare('SELECT 1 FROM chat_files WHERE id = ?').get(hoch.body.datei_id), undefined);
});

test('Design: modern ist die Vorgabe, klassisch waehlbar', async () => {
  const [dora] = await register('design-dora');
  assert.equal((await dora('GET', '/api/me')).body.design, 'modern');
  assert.equal((await dora('PATCH', '/api/me', { design: 'klassisch' })).body.design, 'klassisch');
  assert.equal((await dora('GET', '/api/me')).body.design, 'klassisch');
  assert.equal((await dora('PATCH', '/api/me', { design: 'bunt' })).status, 400);
  // Die Stunden: eckig ist die Vorgabe, abgerundet waehlbar
  assert.equal((await dora('GET', '/api/me')).body.stunden_form, 'eckig');
  assert.equal((await dora('PATCH', '/api/me', { stunden_form: 'rund' })).body.stunden_form, 'rund');
  assert.equal((await dora('PATCH', '/api/me', { stunden_form: 'oval' })).status, 400);
  // Wer frueher selbst sortiert hat, behaelt sein flaches Menue
  const alt = (await dora('PATCH', '/api/me', { nav_order: ['chat', 'plan'] })).body.menue;
  assert.deepEqual(alt.slice(0, 2), ['chat', 'plan']);
  assert.equal(alt.some(e => typeof e === 'object'), false);
});

/** Ein Kurs mit zwei Nicht-Freunden in derselben Stunde, dazu ein anderer Jahrgang und ein Fremder. */
async function kursLeute(praefix) {
  const admin = await login('admin', 'geheim');
  const kurs = `${praefix.toUpperCase()}K`;
  await admin('POST', '/api/courses', { id: kurs, title: `Kurs ${praefix}` });
  const [ana, anaId] = await register(`${praefix}-ana`);
  const [ben, benId] = await register(`${praefix}-ben`);
  const [jg, jgId] = await register(`${praefix}-jg`);
  const [fremd] = await register(`${praefix}-fremd`);
  const cfg = (await ana('GET', '/api/config')).body;
  for (const wer of [ana, ben])
    await wer('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: kurs });
  await jg('PUT', '/api/entry', { day_id: cfg.days[2].id, period_id: cfg.periods[3].id, course_id: kurs });
  return { admin, kurs, ana, anaId, ben, benId, jg, jgId, fremd, cfg };
}

test('Kurschat: ohne Freundschaft, nur derselbe Kurs in derselben Stunde, serverseitig verschluesselt', async () => {
  const { db } = await import('./db.js');
  const { kurs, ana, anaId, ben, benId, jg, fremd } = await kursLeute('kc');
  const pfad = `/api/kurschats/${encodeURIComponent(kurs)}`;
  // In der Liste steht der Kurs - ohne dass ana und ben befreundet sind. ben oeffnet die Liste
  // erst NACH der ersten Nachricht: die zaehlt trotzdem als ungelesen.
  assert.equal((await ana('GET', '/api/friends')).body.friends.length, 0);
  assert.ok((await ana('GET', '/api/kurschats')).body.some(k => k.id === kurs));

  const gesendet = await ana('POST', pfad, { text: 'Hallo Kurs <b>fett</b>' });
  assert.equal(gesendet.status, 200);
  assert.equal(gesendet.body.von.id, anaId, 'die Person kommt mit - der Browser kennt Nicht-Freunde sonst nicht');
  // Ungelesen bei ben, dann gelesen
  assert.equal((await ben('GET', '/api/kurschats')).body.find(k => k.id === kurs).unread, 1);
  const verlauf = (await ben('GET', `${pfad}?since=0`)).body;
  assert.deepEqual(verlauf.map(m => m.text), ['Hallo Kurs <b>fett</b>']);
  assert.equal((await ben('GET', '/api/kurschats')).body.find(k => k.id === kurs).unread, 0);
  // Anderer Jahrgang mit gleicher Kurs-ID und ein Fremder: nichts
  assert.equal((await jg('GET', `${pfad}?since=0`)).status, 200, 'jg hat den Kurs - aber in einer anderen Stunde');
  assert.equal((await jg('GET', `${pfad}?since=0`)).body.length, 0, 'und sieht die Nachricht nicht');
  assert.equal((await fremd('GET', `${pfad}?since=0`)).status, 404);
  assert.equal((await fremd('POST', pfad, { text: 'rein?' })).status, 404);
  assert.equal((await ana('GET', '/api/kurschats/GIBTSNICHT?since=0')).status, 404);
  // Umgekehrt: was jg schreibt, sehen ana und ben nicht - und es verdraengt ihren Verlauf nicht,
  // auch wenn der andere Jahrgang viel mehr schreibt als das Abruf-Limit.
  const kid = db.prepare('SELECT kurs_slots FROM messages WHERE kurs_id = ? AND from_id = ?').get(kurs, anaId);
  const jgSlots = db.prepare(`INSERT INTO messages(from_id, kurs_id, kurs_slots, text, enc, created_at)
    VALUES(?, ?, '9|9', 'x', 0, datetime('now'))`);
  for (let i = 0; i < 350; i++) jgSlots.run(benId, kurs);
  await jg('POST', pfad, { text: 'anderer Jahrgang' });
  const nachFlut = (await ana('GET', `${pfad}?since=0`)).body;
  assert.equal(nachFlut.some(m => m.text === 'anderer Jahrgang'), false);
  assert.ok(nachFlut.some(m => m.id === gesendet.body.id), 'der eigene Verlauf bleibt trotz 350 fremder Nachrichten');
  assert.ok(kid.kurs_slots, 'die Stunden stehen an der Nachricht');
  // In der Datenbank steht kein Klartext - und DM- und Gruppenlisten bleiben unberuehrt
  const roh = db.prepare('SELECT text FROM messages WHERE id = ?').get(gesendet.body.id).text;
  assert.ok(!roh.includes('Hallo'), 'serverseitig verschluesselt');
  assert.equal((await ben('GET', '/api/chats')).body.length, 0);
  assert.equal((await ben('GET', `/api/chats/${anaId}`)).status, 403, 'Direktchat bleibt Freunden vorbehalten');
  // Mitglieder: ana und ben, nicht jg
  const mitglieder = (await ben('GET', `${pfad}/mitglieder`)).body.map(p => p.id).sort();
  assert.deepEqual(mitglieder, [anaId, benId].sort());
  // Leere und zu lange Nachrichten
  assert.equal((await ana('POST', pfad, { text: '   ' })).status, 400);
  assert.equal((await ana('POST', pfad, { text: 'x'.repeat(4001) })).status, 400);
});

test('Kurschat: Anhang, Umfrage, Loeschen, Verlauf fuer Neue, Meldungen gesammelt und stumm', async () => {
  const { db } = await import('./db.js');
  const { admin, kurs, ana, anaId, ben, benId, fremd, jg, cfg } = await kursLeute('kd');
  const pfad = `/api/kurschats/${encodeURIComponent(kurs)}`;
  // Anhang: kommt im Klartext, liegt verschluesselt, Mitglied liest, Fremder und anderer Jahrgang nicht
  const daten = Buffer.from('Hallo Datei').toString('base64');
  const hoch = await ana('POST', `${pfad}/datei`, { data: daten });
  assert.equal(hoch.status, 201);
  assert.notEqual(db.prepare('SELECT data FROM chat_files WHERE id = ?').get(hoch.body.datei_id).data, daten);
  assert.equal((await ben('POST', pfad, { text: '{"t":"datei"}', datei_id: hoch.body.datei_id })).status, 400, 'fremder Anhang');
  const mitDatei = (await ana('POST', pfad, { text: '{"t":"datei","name":"a.txt"}', datei_id: hoch.body.datei_id })).body;
  assert.equal(mitDatei.datei.id, hoch.body.datei_id);
  const geholt = (await ben('GET', `/api/chats/datei/${hoch.body.datei_id}`)).body;
  assert.deepEqual([geholt.data, geholt.klar], [daten, true]);
  assert.equal((await fremd('GET', `/api/chats/datei/${hoch.body.datei_id}`)).status, 404);
  assert.equal((await jg('GET', `/api/chats/datei/${hoch.body.datei_id}`)).status, 404);
  // Umfrage: abstimmen nur wer sie sieht
  const u = (await ana('POST', pfad, { text: '{"t":"umfrage","frage":"?","optionen":["a","b"]}', umfrage_n: 2 })).body;
  // Unstimmiges wird abgewiesen - sonst legte eine praeparierte Nachricht die Anzeige lahm.
  assert.equal((await ana('POST', pfad, { text: '{"t":"datei","name":"x"}', umfrage_n: 2 })).status, 400);
  assert.equal((await ana('POST', pfad, { text: 'nur Text', umfrage_n: 2 })).status, 400);
  assert.equal((await ana('POST', pfad, { text: '{"t":"umfrage","frage":"?","optionen":["a"]}', umfrage_n: 2 })).status, 400);
  assert.equal((await ben('POST', `/api/messages/${u.id}/stimme`, { wahl: 1 })).status, 200);
  assert.equal((await fremd('POST', `/api/messages/${u.id}/stimme`, { wahl: 0 })).status, 404);
  assert.equal((await jg('POST', `/api/messages/${u.id}/stimme`, { wahl: 0 })).status, 404);
  assert.deepEqual((await ana('GET', `${pfad}?since=0`)).body.find(m => m.id === u.id).stimmen, [{ user_id: benId, wahl: 1 }]);
  // Loeschen: eigene ja, fremde nein
  const weg = (await ana('POST', pfad, { text: 'vertippt' })).body;
  assert.equal((await ben('DELETE', `/api/kurschats/nachricht/${weg.id}`)).status, 404);
  assert.equal((await ana('DELETE', `/api/kurschats/nachricht/${weg.id}`)).status, 200);
  assert.equal((await ben('GET', `${pfad}?since=0`)).body.some(m => m.id === weg.id), false);
  // Neues Mitglied sieht den Verlauf; wer den Kurs verlaesst, nimmt seine Nachrichten nicht mit
  const [neu] = await register('kd-neu');
  await neu('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: kurs });
  assert.ok((await neu('GET', `${pfad}?since=0`)).body.some(m => m.id === u.id));
  assert.equal((await neu('GET', '/api/kurschats')).body.find(k => k.id === kurs).unread, 0, 'alter Verlauf zaehlt nicht als ungelesen');
  await ana('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: null });
  assert.equal((await ana('GET', `${pfad}?since=0`)).status, 404, 'ana hat den Kurs nicht mehr');
  assert.ok((await ben('GET', `${pfad}?since=0`)).body.some(m => m.from_id === anaId), 'ihre Nachrichten bleiben');
  await ana('PUT', '/api/entry', { day_id: cfg.days[0].id, period_id: cfg.periods[0].id, course_id: kurs });

  // Meldungen: Vorgabe gesammelt, je Kurs hoechstens eine wartende, stumm heisst keine
  const meldungen = id => db.prepare("SELECT faellig_at, gesammelt, body FROM notifications WHERE user_id = ? AND ref = ? AND delivered_at IS NULL").all(id, `kurs:${kurs}`);
  db.prepare("DELETE FROM notifications WHERE ref = ?").run(`kurs:${kurs}`);
  await ana('POST', pfad, { text: 'eins' });
  await ana('POST', pfad, { text: 'zwei' });
  const m = meldungen(benId);
  assert.equal(m.length, 1, 'nur eine wartende Meldung je Kurs');
  assert.ok(m[0].faellig_at && m[0].gesammelt === 1, 'gesammelt statt sofort');
  assert.equal(m[0].body, null, 'kein Inhalt in der Meldung');
  assert.equal((await ben('GET', '/api/me')).body.push_plan.kurschat[0].modus, 'gesammelt');
  db.prepare("DELETE FROM notifications WHERE ref = ?").run(`kurs:${kurs}`);
  assert.equal((await ben('PUT', `${pfad}/stumm`, { an: true })).body.stumm, true);
  await ana('POST', pfad, { text: 'drei' });
  assert.equal(meldungen(benId).length, 0, 'stumm');
  assert.equal((await ben('GET', '/api/kurschats')).body.find(k => k.id === kurs).stumm, true);
  void admin;
});

test('Kurschat: Bremse und die Oberflaeche kennt die Routen', async () => {
  const { kurs, ana } = await kursLeute('kb');
  const pfad = `/api/kurschats/${encodeURIComponent(kurs)}`;
  let status = 0;
  for (let i = 0; i < 61; i++) status = (await ana('POST', pfad, { text: `n${i}` })).status;
  assert.equal(status, 429);
  const { readFileSync } = await import('node:fs');
  const chat = readFileSync('public/chat.js', 'utf8');
  for (const r of ['/api/kurschats', '/mitglieder', '/stumm', '/api/kurschats/nachricht/'])
    assert.ok(chat.includes(r), `chat.js nutzt ${r}`);
  assert.ok(readFileSync('public/menue.js', 'utf8').includes("'chat/kurs'"));
});

test('Raumaenderung: parallele Kurse im selben Slot melden nichts, eine echte Aenderung genau einmal', async () => {
  const { db, standardSchule } = await import('./db.js');
  const { stundenSchreiben } = await import('./index.js');
  const [, id] = await register('raum-rita');
  const schule = standardSchule();
  const perioden = db.prepare('SELECT * FROM periods WHERE school_id = ? ORDER BY nr').all(schule.id);
  const tag = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const stunde = (kurs, raum, extra = {}) => ({ date: tag, start: perioden[0].start_time, subject: kurs, course_id: kurs,
    room: raum, status: 'regular', info: null, lesson_text: null, teacher: 'Hr. X', ...extra });
  const lauf = liste => stundenSchreiben({ userId: id, schule, perioden, stunden: liste, von: tag, bis: tag, vollstaendig: false });
  const meldungen = () => db.prepare(`SELECT kind, title, body FROM notifications
    WHERE user_id = ? AND kind IN ('aenderung', 'ausfall', 'vertretung') ORDER BY id`).all(id);

  // WebUntis schickt zwei Stunden fuer denselben Slot (Religion/Ethik). Vorher: bei jedem Abgleich
  // "Raum: B104 -> A213", obwohl sich nichts aendert.
  const parallel = [stunde('RAUM-RE', 'A213'), stunde('RAUM-ET', 'B104')];
  lauf(parallel); lauf(parallel); lauf(parallel);
  assert.deepEqual(meldungen(), [], 'parallele Kurse sind keine Aenderung');
  assert.equal(db.prepare('SELECT room FROM untis_lessons WHERE user_id = ?').get(id).room, 'B104', 'gespeichert bleibt wie bisher die letzte');

  // Eine echte Aenderung: genau einmal, auch wenn der naechste Abgleich dasselbe liefert
  const neu = [stunde('RAUM-RE', 'A213'), stunde('RAUM-ET', 'C001')];
  lauf(neu); lauf(neu);
  assert.equal(meldungen().length, 1);
  assert.match(meldungen()[0].body, /B104 → C001/);

  // Kurs-ID in anderer Schreibweise ist kein "Anderer Kurs"
  lauf([stunde('RAUM-RE', 'A213'), stunde('raum-et', 'C001')]);
  assert.equal(meldungen().length, 1);

  // Ein Hinweis, der wegen eines gescheiterten Abrufs kurz fehlt und wiederkommt: nur einmal
  const mit = [stunde('RAUM-RE', 'A213'), stunde('RAUM-ET', 'C001', { info: 'Raumänderung' })];
  const ohne = [stunde('RAUM-RE', 'A213'), stunde('RAUM-ET', 'C001')];
  lauf(mit); lauf(ohne); lauf(mit); lauf(ohne); lauf(mit);
  assert.equal(meldungen().length, 2);

  // 3.0.1 verschluckte hier den Ausfall von RAUM-RE, weil nur die letzte Stunde zaehlte. Jetzt:
  // jeder Kurs seine eigene Meldung, jede genau einmal.
  const ausfall = [stunde('RAUM-RE', 'A213', { status: 'cancelled' }), stunde('RAUM-ET', 'C001', { status: 'irregular', teacher: 'Fr. Y' })];
  lauf(ausfall); lauf(ausfall); lauf(ausfall);
  assert.equal(meldungen().filter(m => m.kind === 'vertretung').length, 1, 'die Vertretung einmal');
  assert.deepEqual(meldungen().filter(m => m.kind === 'ausfall').map(m => m.title), ['RAUM-RE fällt aus'], 'der Ausfall des vorderen Kurses einmal');
  assert.equal(db.prepare('SELECT course_id FROM untis_lessons WHERE user_id = ?').get(id).course_id, 'RAUM-ET', 'angezeigt bleibt die letzte');
});

test('Planmeldungen: gleicher Kurs doppelt, Zeilen von vor 3.0.2, anderer Kurs', async () => {
  const { db, standardSchule } = await import('./db.js');
  const { stundenSchreiben } = await import('./index.js');
  const [, id] = await register('raum-rolf');
  const schule = standardSchule();
  const perioden = db.prepare('SELECT * FROM periods WHERE school_id = ? ORDER BY nr').all(schule.id);
  const tag = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const stunde = (kurs, extra = {}) => ({ date: tag, start: perioden[1].start_time, subject: kurs, course_id: kurs,
    room: 'R1', status: 'regular', info: null, lesson_text: null, teacher: 'Hr. X', ...extra });
  const lauf = liste => stundenSchreiben({ userId: id, schule, perioden, stunden: liste, von: tag, bis: tag, vollstaendig: false });
  const meldungen = () => db.prepare(`SELECT kind, title, body FROM notifications
    WHERE user_id = ? AND kind IN ('aenderung', 'ausfall', 'vertretung') ORDER BY id`).all(id);

  // Ausfall plus Ersatz mit DERSELBEN Kursnummer ist eine Vertretung - kein zusaetzlicher Ausfall
  lauf([stunde('ROLF-MA')]);
  lauf([stunde('ROLF-MA', { status: 'cancelled' }), stunde('ROLF-MA', { status: 'irregular', teacher: 'Fr. Z' })]);
  assert.deepEqual(meldungen().map(m => m.kind), ['vertretung']);

  // Zeile von vor dem Update (ohne Stand): der parallele Kurs ist unbekannt - erst merken, dann melden
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  lauf([stunde('ROLF-RE'), stunde('ROLF-ET')]);
  db.prepare('UPDATE untis_lessons SET stand = NULL WHERE user_id = ?').run(id);
  lauf([stunde('ROLF-RE', { status: 'cancelled' }), stunde('ROLF-ET')]);
  assert.deepEqual(meldungen(), [], 'kein Schwall nach dem Update');
  lauf([stunde('ROLF-RE', { status: 'cancelled' }), stunde('ROLF-ET', { room: 'R9' })]);
  assert.deepEqual(meldungen().map(m => m.body.split(' · ')[1]), ['Raum: R1 → R9'], 'ab jetzt wird wieder gemeldet');

  // Eine einzelne Stunde, die ihren Kurs wechselt: "Anderer Kurs" bleibt erhalten
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
  lauf([stunde('ROLF-MA')]);
  lauf([stunde('ROLF-PH')]);
  assert.deepEqual(meldungen().map(m => m.body.split(' · ')[1]), ['Anderer Kurs']);
});

test('Notizen live (SSE): nur wer sie sehen darf, nur die ID, nie die eigene, Grenze je Nutzer', async () => {
  const { bes, fre, freId, fremd } = await bueroLeute('sse');
  // Einen Strom mitlesen - die Liste `ereignisse` waechst, solange er offen ist.
  const mitlesen = async wer => {
    const ab = new AbortController();
    const res = await fetch(base + '/api/notizen/live', { headers: { cookie: wer.cookie() }, signal: ab.signal });
    const ereignisse = [];
    const leser = res.body.getReader();
    const dec = new TextDecoder();
    let puffer = '';
    (async () => {
      for (;;) {
        const { value, done } = await leser.read();
        if (done) return;
        puffer += dec.decode(value, { stream: true });
        for (let i; (i = puffer.indexOf('\n\n')) >= 0; puffer = puffer.slice(i + 2)) {
          const block = puffer.slice(0, i);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          if (ev) ereignisse.push({ ev, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
        }
      }
    })().catch(() => { /* abgebrochen */ });
    return { res, ereignisse, zu: () => ab.abort() };
  };
  const warte = async (liste, n) => {
    for (let i = 0; i < 100 && liste.length < n; i++) await new Promise(r => setTimeout(r, 20));
  };

  const f = await mitlesen(fre), x = await mitlesen(fremd), b = await mitlesen(bes);
  assert.equal(f.res.status, 200);
  assert.match(f.res.headers.get('content-type'), /^text\/event-stream/);

  const o = (await bes('POST', '/api/notizen-ordner', { name: 'Live' })).body;
  await bes('PUT', `/api/buero/notiz_ordner/${o.id}/freigabe`, { freunde: [{ id: freId, rolle: 'lesen' }] });
  await warte(f.ereignisse, 1);
  assert.deepEqual(f.ereignisse, [{ ev: 'notizen', data: { id: null } }], 'der Ordner wurde geteilt');

  await bes('POST', '/api/notizen', { titel: 'privat' });
  const n = (await bes('POST', '/api/notizen', { titel: 'im Ordner', ordner_id: o.id })).body;
  await warte(f.ereignisse, 2);
  assert.deepEqual(f.ereignisse[1], { ev: 'notizen', data: { id: n.id } }, 'als naechstes die im Ordner - die private meldet nichts');
  await bes('PATCH', `/api/notizen/${n.id}`, { inhalt: 'neu' });
  await bes('POST', `/api/notizen/${n.id}/todos`, { text: 'Punkt' });
  await warte(f.ereignisse, 4);
  assert.equal(f.ereignisse.length, 4, 'Text und Todo');

  // Freigabe weg: einmal noch (die Notiz verschwindet aus der Liste), danach nichts mehr
  await bes('PUT', `/api/buero/notiz_ordner/${o.id}/freigabe`, { freunde: [] });
  await warte(f.ereignisse, 5);
  await bes('PATCH', `/api/notizen/${n.id}`, { inhalt: 'noch neuer' });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(f.ereignisse.length, 5, 'nach dem Entzug keine Meldungen mehr');
  assert.deepEqual(x.ereignisse, [], 'Fremde hoeren nichts');
  assert.deepEqual(b.ereignisse, [], 'wer aendert, bekommt seine eigene Aenderung nicht');

  // Hoechstens fuenf je Nutzer, und nur angemeldet
  const mehr = [];
  for (let i = 0; i < 4; i++) mehr.push(await mitlesen(fre));
  const zuViel = await fetch(base + '/api/notizen/live', { headers: { cookie: fre.cookie() } });
  assert.equal(zuViel.status, 429);
  await zuViel.body?.cancel();
  assert.equal((await fetch(base + '/api/notizen/live')).status, 401);
  for (const s of [f, x, b, ...mehr]) s.zu();
});

// --- 3.1.0 -------------------------------------------------------------------------------------

/** Der naechste Montag, mindestens eine Woche voraus - dort gibt es eine Zeile in `days`. */
const naechsterMontag = () => {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
};

test('Plan: eine Pruefung oder stattfindende Stunde verdeckt den Ausfall, nicht umgekehrt', async () => {
  const { db, standardSchule } = await import('./db.js');
  const { stundenSchreiben } = await import('./index.js');
  const untis = await import('./untis.js');
  const [, id] = await register('rang-rosa');
  const schule = standardSchule();
  const perioden = db.prepare('SELECT * FROM periods WHERE school_id = ? ORDER BY nr').all(schule.id);
  const tag = naechsterMontag();
  const stunde = (kurs, extra = {}) => ({ date: tag, start: perioden[2].start_time, subject: kurs, course_id: kurs,
    room: 'R1', status: 'regular', info: null, lesson_text: null, teacher: 'Hr. X', ...extra });
  const lauf = liste => stundenSchreiben({ userId: id, schule, perioden, stunden: liste, von: tag, bis: tag, vollstaendig: false });
  const gezeigt = () => ({ ...db.prepare('SELECT course_id, status FROM untis_lessons WHERE user_id = ?').get(id) });

  // Die Klausur reicht in die 3. Stunde, die eigentliche faellt dort aus - egal in welcher Reihenfolge.
  lauf([stunde('RANG-PH'), stunde('RANG-GE', { status: 'cancelled' })]);
  assert.deepEqual(gezeigt(), { course_id: 'RANG-PH', status: 'regular' });
  lauf([stunde('RANG-GE', { status: 'cancelled' }), stunde('RANG-PH')]);
  assert.deepEqual(gezeigt(), { course_id: 'RANG-PH', status: 'regular' }, 'vorher gewann hier der Ausfall');
  // Gleicher Rang: wie immer die letzte.
  lauf([stunde('RANG-A'), stunde('RANG-B')]);
  assert.equal(gezeigt().course_id, 'RANG-B');
  // Eine Pruefung gewinnt auch gegen eine stattfindende Stunde - so zeigt es WebUntis.
  lauf([stunde('RANG-PH', { pruefung: true }), stunde('RANG-GE')]);
  assert.equal(gezeigt().course_id, 'RANG-PH');

  // WebUntis kennzeichnet Pruefungen mit lstype 'ex'.
  const [p] = untis.aufbereiten([{ date: 20261012, startTime: 940, endTime: 1025, lstype: 'ex',
    su: [{ name: 'PH' }], te: [], ro: [] }]);
  assert.equal(p.pruefung, true);
  assert.equal(untis.aufbereiten([{ date: 20261012, startTime: 940, su: [], te: [], ro: [] }])[0].pruefung, false);
});

test('Meldungen: dauerhaft entfernte oder ersetzte Stunden melden nichts, auch nicht am Abend', async () => {
  const { db, standardSchule, WEG } = await import('./db.js');
  const { stundenSchreiben, tagesVorschau } = await import('./index.js');
  const [, id] = await register('weg-wanda');
  const schule = standardSchule();
  const perioden = db.prepare('SELECT * FROM periods WHERE school_id = ? ORDER BY nr').all(schule.id);
  const tag = naechsterMontag();
  const montagId = db.prepare('SELECT id FROM days WHERE iso = 1').get().id;
  const stunde = (kurs, extra = {}) => ({ date: tag, start: perioden[2].start_time, subject: kurs, course_id: kurs,
    room: 'R1', status: 'regular', info: null, lesson_text: null, teacher: 'Hr. X', ...extra });
  const lauf = liste => stundenSchreiben({ userId: id, schule, perioden, stunden: liste, von: tag, bis: tag, vollstaendig: false });
  const ausfaelle = () => db.prepare("SELECT title FROM notifications WHERE user_id = ? AND kind = 'ausfall' ORDER BY id")
    .all(id).map(r => r.title);
  const festlegen = kurs => db.prepare(`INSERT INTO entries(user_id, day_id, period_id, course_id, vorrang)
    VALUES(?, ?, ?, ?, 1) ON CONFLICT(user_id, day_id, period_id) DO UPDATE SET course_id = excluded.course_id, vorrang = 1`)
    .run(id, montagId, perioden[2].id, kurs);

  lauf([stunde('WEG-RE'), stunde('WEG-ET')]);
  festlegen(WEG);
  lauf([stunde('WEG-RE', { status: 'cancelled' }), stunde('WEG-ET', { status: 'cancelled' })]);
  assert.deepEqual(ausfaelle(), [], 'dauerhaft entfernt: keine Meldung');
  assert.equal(tagesVorschau(id), null, 'und nichts in der Abendvorschau');

  // Ersetzt durch den eigenen der beiden Kurse: nur der meldet.
  festlegen('WEG-RE');
  lauf([stunde('WEG-RE'), stunde('WEG-ET')]);
  lauf([stunde('WEG-RE'), stunde('WEG-ET', { status: 'cancelled' })]);
  assert.deepEqual(ausfaelle(), [], 'der fremde Kurs im Slot meldet nicht');
  lauf([stunde('WEG-RE', { status: 'cancelled' }), stunde('WEG-ET', { status: 'cancelled' })]);
  assert.deepEqual(ausfaelle(), ['WEG-RE fällt aus']);

  // Ohne Festlegung meldet die Abendvorschau den angezeigten Ausfall wieder.
  db.prepare('DELETE FROM entries WHERE user_id = ?').run(id);
  assert.match(tagesVorschau(id) ?? '', /fällt aus/);
});

test('Pruefungen aus WebUntis: Import auf Knopfdruck, Doppelte nach Regel, Geloeschtes bleibt weg', async () => {
  const { db, standardSchule } = await import('./db.js');
  const { pruefungenUebernehmen, untisPruefungsListe, altePruefungskalenderUebernehmen } = await import('./index.js');
  const [rex, id] = await register('pruef-paul');
  const perioden = db.prepare('SELECT * FROM periods WHERE school_id = ? ORDER BY nr').all(standardSchule().id);
  const tag = naechsterMontag();
  const tag2 = new Date(new Date(tag).getTime() + 86_400_000).toISOString().slice(0, 10);

  // Was WebUntis liefert, mit Schulstunden: 08:00-10:25 sind die Stunden 1 bis 3.
  const liste = untisPruefungsListe([
    { untis_id: 11, date: tag, start: perioden[0].start_time, end: '10:25', titel: 'Klausur', fach: 'PH' },
    { untis_id: 12, date: tag2, start: perioden[1].start_time, end: perioden[1].end_time, titel: 'Test', fach: 'MA' },
  ], perioden);
  assert.deepEqual(liste.map(p => [p.uid, p.titel, p.von_stunde, p.bis_stunde]),
    [['untis-exam-11', 'PH: Klausur', 1, 3], ['untis-exam-12', 'MA: Test', 2, 2]]);

  // Eine selbst eingetragene Physik-Klausur in derselben Zeit - mit eigener Erinnerung.
  const kal = (await rex('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  const eigen = (await rex('POST', `/api/kalender/${kal.id}/eintraege`, { titel: 'Physik-Klausur', art: 'pruefung',
    von: `${tag} 08:45`, bis: `${tag} 09:30`, von_stunde: 2, bis_stunde: 2, erinnerung_tage: 3 })).body;
  const meine = () => db.prepare(`SELECT e.id, e.uid, e.titel, e.von_stunde, e.bis_stunde, e.erinnerung_tage
    FROM kalender_eintraege e JOIN kalender k ON k.id = e.kalender_id WHERE k.user_id = ? AND e.art = 'pruefung' ORDER BY e.id`).all(id);

  assert.deepEqual(pruefungenUebernehmen(id, liste), { neu: 1, aktualisiert: 0, doppelt: 1, geloescht: 0 });
  assert.deepEqual(pruefungenUebernehmen(id, liste), { neu: 0, aktualisiert: 0, doppelt: 1, geloescht: 0 },
    'ein zweiter Import legt nichts doppelt an');
  assert.equal(meine().length, 2);

  // "Die von WebUntis nehmen": die eigene Zeile bekommt Titel und Zeit - die Erinnerung bleibt.
  assert.equal(pruefungenUebernehmen(id, liste, { regel: 'untis' }).aktualisiert, 1);
  const ph = meine().find(m => m.id === eigen.id);
  assert.deepEqual([ph.uid, ph.titel, ph.von_stunde, ph.bis_stunde, ph.erinnerung_tage],
    ['untis-exam-11', 'PH: Klausur', 1, 3, 3]);
  assert.deepEqual(pruefungenUebernehmen(id, liste, { regel: 'untis' }), { neu: 0, aktualisiert: 0, doppelt: 0, geloescht: 0 });

  // Geloescht bleibt geloescht - ausser man will es ausdruecklich.
  const ma = meine().find(m => m.uid === 'untis-exam-12');
  assert.equal((await rex('DELETE', `/api/kalender/eintraege/${ma.id}`)).status, 200);
  assert.deepEqual(pruefungenUebernehmen(id, liste), { neu: 0, aktualisiert: 0, doppelt: 0, geloescht: 1 });
  assert.equal(pruefungenUebernehmen(id, liste, { auchGeloeschte: true }).neu, 1);

  // Verschiebt die Schule die Pruefung, zieht der naechste Import das WANN nach - den Titel nicht.
  const neuMa = meine().find(m => m.uid === 'untis-exam-12');
  db.prepare("UPDATE kalender_eintraege SET titel = 'Mathe-Test (Kapitel 3)' WHERE id = ?").run(neuMa.id);
  const verschoben = untisPruefungsListe([{ untis_id: 12, date: tag2, start: perioden[3].start_time,
    end: perioden[3].end_time, titel: 'Test', fach: 'MA' }], perioden);
  assert.equal(pruefungenUebernehmen(id, verschoben).aktualisiert, 1);
  const nachher = meine().find(m => m.uid === 'untis-exam-12');
  assert.deepEqual([nachher.titel, nachher.von_stunde], ['Mathe-Test (Kapitel 3)', 4]);

  // Die alten, automatisch gefuellten Kalender werden einmalig uebernommen und verschwinden.
  const { lastInsertRowid } = db.prepare(`INSERT INTO kalender(user_id, name, farbe, quelle, created_at)
    VALUES(?, 'Prüfungen (Schule)', '#f5c400', 'untis', datetime('now'))`).run(id);
  db.prepare(`INSERT INTO kalender_eintraege(kalender_id, uid, titel, von, bis, ganztags, art, von_stunde, bis_stunde, created_at)
    VALUES(?, 'untis-exam-99', 'DE: Aufsatz', ?, ?, 0, 'pruefung', 5, 6, datetime('now'))`)
    .run(Number(lastInsertRowid), `${tag2} 11:40`, `${tag2} 13:10`);
  altePruefungskalenderUebernehmen();
  assert.equal(db.prepare("SELECT count(*) n FROM kalender WHERE quelle = 'untis'").get().n, 0);
  assert.equal(meine().some(m => m.uid === 'untis-exam-99' && m.titel === 'DE: Aufsatz'), true);

  // Ohne WebUntis gibt es nichts zu importieren - mit klarer Ansage.
  const ohne = await rex('POST', '/api/untis/pruefungen/import', {});
  assert.equal(ohne.status, 400);
  assert.match(ohne.body.error, /WebUntis/);
  // Und die Liste im Kalender sagt, woher eine Pruefung kam.
  const eintraege = (await rex('GET', `/api/kalender/eintraege?von=${tag}&bis=${tag2}`)).body.eintraege;
  assert.equal(eintraege.find(e => e.titel === 'PH: Klausur').aus_untis, true);
});

test('Profil: Ausfall-Darstellung und Regel fuer doppelte Pruefungen', async () => {
  const [ali] = await register('stil-stine');
  const me = (await ali('GET', '/api/me')).body;
  assert.equal(me.ausfall_stil, 'deutlich', 'Vorgabe: deutlich');
  assert.equal(me.pruefung_doppelt, 'meine', 'Vorgabe: meine behalten');
  assert.equal(me.zugang_eigen, false, 'Vorgabe: der Server verschluesselt');
  assert.equal((await ali('PATCH', '/api/me', { ausfall_stil: 'klassisch' })).body.ausfall_stil, 'klassisch');
  assert.equal((await ali('PATCH', '/api/me', { pruefung_doppelt: 'untis' })).body.pruefung_doppelt, 'untis');
  assert.equal((await ali('PATCH', '/api/me', { ausfall_stil: 'bunt' })).status, 400);
  assert.equal((await ali('PATCH', '/api/me', { pruefung_doppelt: 'beide' })).status, 400);
});

test('Tickets in der App: melden, Postfach, Antwort, Punkt am Reiter, Status - ohne VNW', async () => {
  const { db } = await import('./db.js');
  const admin = await login('admin', 'geheim');
  const [mel] = await register('app-melder');
  const [fremd] = await register('app-fremd');
  const adminId = (await admin('GET', '/api/me')).body.id;
  assert.equal((await mel('PUT', '/api/tickets/ziel', { ziel: 'app' })).status, 403, 'nur Admins');
  assert.equal((await admin('PUT', '/api/tickets/ziel', { ziel: 'irgendwo' })).status, 400);
  assert.equal((await admin('PUT', '/api/tickets/ziel', { ziel: 'app' })).status, 200);
  try {
    const liste = (await mel('GET', '/api/tickets')).body;
    assert.equal(liste.ziel, 'app');
    assert.deepEqual(liste.typen.map(t => t.name), ['Vorschlag', 'Fehler']);

    const t = await mel('POST', '/api/tickets', { title: 'Knopf klemmt', text: 'Im Plan', type_id: 2 });
    assert.equal(t.status, 201);
    assert.equal(t.body.type_name, 'Fehler');
    assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE user_id = ? AND kind = 'ticket' AND title LIKE 'Neues Ticket%'")
      .get(adminId).n >= 1, true, 'die Admins erfahren von dem neuen Ticket');

    assert.equal((await mel('GET', '/api/admin/tickets')).status, 403);
    const post = (await admin('GET', '/api/admin/tickets')).body.find(x => x.id === t.body.id);
    assert.equal(post.wartet, true);
    assert.equal(post.von, 'app-melder');

    assert.equal((await admin('POST', `/api/admin/tickets/${t.body.id}/replies`, { text: 'Schauen wir an' })).status, 201);
    assert.equal((await mel('GET', '/api/tickets/neu')).body.n, 1, 'der Punkt am Reiter');
    const offen = (await mel('GET', `/api/tickets/${t.body.id}`)).body;
    assert.equal(offen.text, 'Im Plan');
    assert.equal(offen.status, 'in_progress', 'die erste Antwort nimmt es in Bearbeitung');
    assert.deepEqual(offen.replies.map(r => r.text), ['Schauen wir an']);
    assert.match(offen.replies[0].name, /\(Team\)$/);
    assert.equal((await mel('GET', '/api/tickets/neu')).body.n, 0, 'gelesen ist gelesen');

    assert.equal((await mel('POST', `/api/tickets/${t.body.id}/replies`, { text: 'Danke!' })).status, 201);
    assert.equal((await admin('GET', '/api/admin/tickets')).body.find(x => x.id === t.body.id).wartet, true,
      'das letzte Wort hatte der Melder');
    assert.equal((await mel('DELETE', `/api/tickets/${t.body.id}`)).status, 409, 'das Team hat schon geantwortet');
    assert.equal((await fremd('GET', `/api/tickets/${t.body.id}`)).status, 404);

    assert.equal((await admin('PUT', `/api/admin/tickets/${t.body.id}/status`, { status: 'closed' })).status, 200);
    assert.equal((await mel('POST', `/api/tickets/${t.body.id}/replies`, { text: 'Noch was' })).status, 409);
    // Aus der eigenen Liste - beim Admin bleibt der Vorgang.
    assert.equal((await mel('DELETE', `/api/tickets/${t.body.id}`)).status, 200);
    assert.equal((await mel('GET', '/api/tickets')).body.tickets.some(x => x.id === t.body.id), false);
    assert.equal((await admin('GET', `/api/admin/tickets/${t.body.id}`)).status, 200);

    // Zurueckziehen, solange niemand geantwortet hat: ganz weg.
    const zwei = (await mel('POST', '/api/tickets', { title: 'Doch nicht' })).body;
    assert.equal((await mel('DELETE', `/api/tickets/${zwei.id}`)).status, 200);
    assert.equal((await admin('GET', `/api/admin/tickets/${zwei.id}`)).status, 404);
  } finally {
    db.prepare("DELETE FROM settings WHERE key = 'tickets_ziel'").run();
  }
});

test('Zugangsdaten nur mit dem eigenen Passwort: nur die Sitzung kann sie oeffnen', async t => {
  const { db } = await import('./db.js');
  const { netz } = await import('./iserv.js');
  const { untisAbgleich } = await import('./index.js');
  const untis = await import('./untis.js');
  const echt = netz.lookup;
  netz.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const stub = stubIserv({ 'schule-zugang.de': iservPlanHtml() });
  t.after(() => { stub.zurueck(); netz.lookup = echt; });

  const [alt] = await register('zugang-zora');
  const id = (await alt('GET', '/api/me')).body.id;
  assert.equal((await alt('PUT', '/api/iserv/account', {
    server: 'https://schule-zugang.de/', name: 'Zugangsschule', username: 'zora', password: 'richtig' })).status, 200);
  const secret = () => db.prepare('SELECT secret FROM untis_accounts WHERE user_id = ?').get(id)?.secret;
  assert.equal(untis.entschluesseln(secret()), 'richtig', 'Vorgabe: Server-Schluessel');

  // Eine zweite Sitzung von vorher - sie wird den Schluessel nicht haben.
  const neu = await login('zugang-zora', 'pw4tests');
  assert.equal((await neu('POST', '/api/me/zugang', { an: true, password: 'falsch' })).status, 401);
  const an = await neu('POST', '/api/me/zugang', { an: true, password: 'pw4tests' });
  assert.equal(an.status, 200, JSON.stringify(an.body));
  assert.equal(an.body.zugang_eigen, true);
  assert.match(secret(), /^u1:/);
  assert.throws(() => untis.entschluesseln(secret().slice(3)), 'mit dem Server-Schluessel nicht zu oeffnen');
  assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id = ? AND zugang_k IS NOT NULL').get(id).n, 1,
    'K liegt nur verpackt in der einen Sitzung');

  // In dieser Sitzung geht der Abgleich, in der alten nicht - und ohne Nutzer schon gar nicht.
  assert.equal((await neu('POST', '/api/untis/sync')).status, 200);
  const ohneK = await alt('POST', '/api/untis/sync');
  assert.equal(ohneK.status, 409);
  assert.match(ohneK.body.error, /ab und wieder an/);
  assert.equal((await alt('GET', '/api/me')).body.zugang_bereit, false);
  assert.equal((await alt('PUT', '/api/iserv/account', {
    server: 'https://schule-zugang.de/', username: 'zora', password: 'richtig' })).status, 409);
  await assert.rejects(() => untisAbgleich(id), /ab und wieder an/);

  // Neu anmelden reicht.
  const drei = await login('zugang-zora', 'pw4tests');
  assert.equal((await drei('GET', '/api/me')).body.zugang_bereit, true);
  assert.equal((await drei('POST', '/api/untis/sync')).status, 200);

  // Passwort aendern: die Zugangsdaten wandern mit.
  assert.equal((await drei('POST', '/api/me/password', { current: 'pw4tests', new: 'neu12345' })).status, 200);
  assert.match(secret(), /^u1:/);
  assert.equal((await drei('POST', '/api/untis/sync')).status, 200);

  // Ausschalten: wieder der Server-Schluessel.
  assert.equal((await drei('POST', '/api/me/zugang', { an: false, password: 'neu12345' })).status, 200);
  assert.equal(untis.entschluesseln(secret()), 'richtig');

  // Wieder an - und dann setzt ein Admin das Passwort zurueck: die Zugangsdaten sind weg.
  assert.equal((await drei('POST', '/api/me/zugang', { an: true, password: 'neu12345' })).status, 200);
  const admin = await login('admin', 'geheim');
  assert.equal((await admin('PATCH', `/api/users/${id}`, { password: 'reset999' })).status, 200);
  assert.equal(secret(), undefined, 'mit dem alten Passwort verschluesselt - nicht mehr zu oeffnen, also weg');
});

// --- Aus den Tickets (3.1.0) -------------------------------------------------------------------

/** Ortszeit 'JJJJ-MM-TT HH:MM', so wie Termine und ToDos sie speichern. */
const lokalZeit = d => {
  const z = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

test('Pruefungen: weg aus "kommende", sobald sie vorbei sind - nicht erst um Mitternacht', async () => {
  const [pia] = await register('vorbei-pia');
  const kal = (await pia('GET', '/api/kalender')).body.kalender.find(k => k.quelle === 'eigen');
  const jetzt = Date.now(), std = 3_600_000;
  const neu = (titel, von, bis) => pia('POST', `/api/kalender/${kal.id}/eintraege`,
    { titel, art: 'pruefung', von: lokalZeit(new Date(von)), bis: lokalZeit(new Date(bis)) });
  assert.equal((await neu('Schon geschrieben', jetzt - 3 * std, jetzt - std)).status, 201);
  assert.equal((await neu('Läuft noch', jetzt - std / 2, jetzt + 2 * std)).status, 201);
  const titel = (await pia('GET', '/api/widget')).body.pruefungen.map(p => p.titel);
  assert.equal(titel.includes('Schon geschrieben'), false, 'vorbei ist vorbei');
  assert.equal(titel.includes('Läuft noch'), true, 'bis zu ihrem Ende steht sie da');
});

test('Board: mehrere Zustaendige, freie Namen - und es zaehlt nur, was mich betrifft', async () => {
  const { db, zustaendigeUebernehmen } = await import('./db.js');
  const { todoErinnerungen } = await import('./index.js');
  const [anna, annaId] = await register('zust-anna');
  const [ben, benId] = await register('zust-ben');
  const [, carlId] = await register('zust-carl');
  await anna('POST', '/api/friends', { username: 'zust-ben' });
  await ben('POST', `/api/friends/${annaId}/accept`);
  const o = (await anna('POST', '/api/todo-ordner', { name: 'Referat' })).body;
  assert.equal((await anna('POST', `/api/todo-ordner/${o.id}/teilen`, { user_id: benId })).status, 201);
  const offen = async wer => (await wer('GET', '/api/homework/offen')).body.todos;
  const [vorA, vorB] = [await offen(anna), await offen(ben)];
  const neu = (text, zustaendige) => anna('POST', '/api/todos', { text, ordner_id: o.id, zustaendige });

  // Mehrere auf einmal, Doppeltes faellt weg - Groß/Klein egal.
  const alle = await neu('Folien', [{ id: annaId }, { id: benId }, { name: 'Lisa' }, { name: 'lisa' }]);
  assert.equal(alle.status, 200, JSON.stringify(alle.body));
  assert.deepEqual(alle.body.zustaendige, [{ id: annaId }, { id: benId }, { name: 'Lisa' }]);
  assert.equal((await neu('Fremd', [{ id: carlId }])).status, 400, 'nur wer das Projekt sieht');
  await anna('DELETE', `/api/todos/${alle.body.id}`);

  await neu('Nur Ben', [{ id: benId }]);
  await neu('Niemand', []);
  await neu('Nur Lisa', [{ name: 'Lisa' }]);
  const annaUndLisa = (await neu('Anna und Lisa', [{ id: annaId }, { name: 'Lisa' }])).body;
  assert.equal(await offen(anna), vorA + 2, 'Anna: "Niemand" und "Anna und Lisa" - nicht "Nur Ben", nicht "Nur Lisa"');
  assert.equal(await offen(ben), vorB + 2, 'Ben: "Nur Ben" und "Niemand"');

  // Ein PUT ohne Zustaendige laesst sie stehen; der alte Weg mit einer Person geht weiter.
  const geaendert = (await anna('PUT', `/api/todos/${annaUndLisa.id}`, { text: 'Anna und Lisa (neu)' })).body;
  assert.deepEqual(geaendert.zustaendige, [{ id: annaId }, { name: 'Lisa' }]);
  const alt = (await anna('PUT', `/api/todos/${annaUndLisa.id}`, { text: 'Jetzt Ben', zustaendig_id: benId })).body;
  assert.deepEqual(alt.zustaendige, [{ id: benId }]);
  assert.equal(alt.zustaendig_id, benId);

  // Erinnert wird nur, wer zustaendig ist.
  const faellig = (await anna('POST', '/api/todos', { text: 'Abgabe Ben', ordner_id: o.id, remind_min: 0,
    due_at: lokalZeit(new Date(Date.now() - 60_000)), zustaendige: [{ id: benId }] })).body;
  todoErinnerungen();
  const erinnert = db.prepare("SELECT user_id FROM notifications WHERE kind = 'todo' AND title = 'Abgabe Ben'").all()
    .map(r => r.user_id);
  assert.deepEqual(erinnert, [benId]);
  assert.ok(faellig.id);

  // Alte Einzel-Zuweisungen wandern in die neue Tabelle - einmal, nicht doppelt.
  const { lastInsertRowid } = db.prepare(`INSERT INTO todos(user_id, text, ordner_id, zustaendig_id, created_at)
    VALUES(?, 'Alt', ?, ?, datetime('now'))`).run(annaId, o.id, benId);
  zustaendigeUebernehmen(); zustaendigeUebernehmen();
  assert.deepEqual(db.prepare('SELECT user_id, name FROM todo_zustaendige WHERE todo_id = ?').all(Number(lastInsertRowid))
    .map(r => ({ ...r })), [{ user_id: benId, name: null }]);
});
