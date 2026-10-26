// --- buero ---
// Das Buero: Notizen, Ideenbaum, Abstimmungen und Umfragen. Die Module kommen aus VNW, sind aber
// auf das Prinzip dieser App zugeschnitten: kein Rechtesystem mit Rollen, sondern Besitzer,
// ausgewaehlte Freunde und "alle mit einem meiner Kurse". Live (SSE) sind nur die Notizen - der
// Rest wird beim Oeffnen neu geladen. Eine Push-Art ("buero") fuer alles.
//
// Eigene Datei, weil index.js ohnehin fuenftausend Zeilen hat. Was von dort gebraucht wird
// (Anmeldung, Bremse, Freunde, Kurse, Meldungen, Verschluesselung), kommt als Parameter herein -
// diese Datei importiert index.js nicht, sonst entstuende ein Ring.

import { createHmac, randomBytes } from 'node:crypto';
import { db, getSetting, setSetting, sql, transaktion } from './db.js';
import { frageSaeubern, aenderungErlaubt, pruefeAntworten, csv } from './public/umfrage-logik.js';

// Ortszeit wie im Rest der App (ToDos, Termine): was jemand als "bis 18 Uhr" eintraegt, gilt bis
// 18 Uhr hier - und wird genauso angezeigt, wie es gespeichert ist.
const lokal = (d = new Date()) => {
  const z = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};
const jetzt = () => lokal();
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const HEX = /^#[0-9a-f]{6}$/i;
const ZEIT = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

// Ein Geheimnis nur fuer die Schluessel der Umfrage-Antworten. Einmal erzeugt, dann fest - sonst
// faende niemand seine eigene Antwort wieder.
let geheimWert = null;
function geheim() {
  if (geheimWert) return geheimWert;
  let g = getSetting('buero_geheim');
  if (!g) { g = randomBytes(32).toString('hex'); setSetting('buero_geheim', g); }
  return (geheimWert = g);
}
const hmac = text => createHmac('sha256', geheim()).update(text).digest('hex').slice(0, 40);

export function buero(app, h) {
  const { auth, bremse, gastBremse, benachrichtige, istFreund, meineKursIds, hatKurs, kanonischerKurs,
    kursGemeinsam, person, verschluesseln, entschluesseln, nameVon } = h;
  // Nur die Spalten, die fuer Namen und Avatar-Punkt gebraucht werden - SELECT * zoege jedes Mal
  // Avatar und Banner (bis 500 KB) mit.
  const PERSON = `SELECT id, username, display_name, color, emoji, bild_v, (avatar IS NOT NULL) AS has_avatar,
    (banner IS NOT NULL) AS has_banner FROM users WHERE id = ?`;
  const nutzer = id => sql(PERSON).get(id);
  const personVon = id => { const u = id && nutzer(id); return u ? person(u) : null; };
  const nr = v => Number(v) || 0;

  // --- Freigabe: Freunde und Kurse ------------------------------------------------------------

  const freigaben = (art, id) => sql('SELECT * FROM buero_freigabe WHERE art = ? AND ding_id = ?').all(art, id);

  /**
   * Rolle eines Nutzers bei einem Ding: 'besitzer', die Rolle der Freigabe, 'member' ueber den Kurs - oder null.
   * Kurs heisst: derselbe Kurs in derselben Stunde wie beim Besitzer. Nur die Kurs-ID reichte nicht -
   * zwei Jahrgaenge teilen sich manchmal eine, und dann laese der andere Jahrgang mit.
   */
  function rolleBei(art, id, besitzer, userId) {
    if (userId === besitzer) return 'besitzer';
    const zeilen = freigaben(art, id);
    const direkt = zeilen.find(z => z.user_id === userId);
    if (direkt) return direkt.rolle;
    if (zeilen.some(z => z.course_id && kursGemeinsam(besitzer, userId, z.course_id))) return art.startsWith('notiz') ? 'lesen' : 'member';
    return null;
  }

  /** Die IDs aller Dinge einer Art, die mit mir geteilt sind (direkt oder ueber einen Kurs). */
  function geteiltMit(art, userId) {
    const kurse = meineKursIds(userId);
    const platz = kurse.map(() => '?').join(',') || "''";
    return db.prepare(`SELECT DISTINCT ding_id FROM buero_freigabe WHERE art = ?
      AND (user_id = ? OR course_id COLLATE NOCASE IN (${platz}))`).all(art, userId, ...kurse).map(r => r.ding_id);
  }

  /** Alle Menschen, die ein Ding sehen - fuer Meldungen. Kurse: wer ihn in derselben Stunde hat wie der Besitzer. */
  function publikum(art, id, besitzer) {
    const ids = new Set();
    for (const z of freigaben(art, id)) {
      if (z.user_id) ids.add(z.user_id);
      if (z.course_id) for (const r of db.prepare(`SELECT user_id FROM entries WHERE course_id = ? COLLATE NOCASE
          UNION SELECT user_id FROM untis_lessons WHERE course_id = ? COLLATE NOCASE`).all(z.course_id, z.course_id))
        if (r.user_id !== besitzer && kursGemeinsam(besitzer, r.user_id, z.course_id)) ids.add(r.user_id);
    }
    return [...ids];
  }

  const ROLLEN = { notiz: ['lesen', 'aendern'], notiz_ordner: ['lesen', 'aendern'], idee: ['member', 'team'],
    abstimmung: ['member'], umfrage: ['member'] };
  const TABELLE = { notiz: 'notizen', notiz_ordner: 'notiz_ordner', idee: 'ideen_boards', abstimmung: 'abstimmungen', umfrage: 'umfragen' };
  const TITEL = { notiz: 'titel', notiz_ordner: 'name', idee: 'name', abstimmung: 'titel', umfrage: 'titel' };
  const WORT = { notiz: 'die Notiz', notiz_ordner: 'den Ordner', idee: 'den Ideenbaum', abstimmung: 'die Abstimmung', umfrage: 'die Umfrage' };

  // Object.hasOwn: "constructor" & Co. sind keine Art, sondern Prototyp-Schluessel - ohne die Pruefung ein 500.
  const dingVon = (art, id) => Object.hasOwn(TABELLE, art) && db.prepare(`SELECT * FROM ${TABELLE[art]} WHERE id = ?`).get(nr(id));

  app.get('/api/buero/:art/:id/freigabe', auth, (req, res) => {
    const d = dingVon(req.params.art, req.params.id);
    if (!d || d.owner_id !== req.user.id) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(freigaben(req.params.art, d.id).map(z => ({
      wer: z.wer, rolle: z.rolle, person: z.user_id ? personVon(z.user_id) : null, course_id: z.course_id })));
  });

  // Die ganze Freigabe auf einmal: { freunde: [{ id, rolle }], kurse: ['KURS'] }. Freunde nur, mit
  // denen man befreundet ist; Kurse nur, die man selbst hat - sonst koennte man Fremde "einladen".
  app.put('/api/buero/:art/:id/freigabe', auth, bremse('freigabe', 60), (req, res) => {
    const art = req.params.art;
    const d = dingVon(art, req.params.id);
    if (!d || d.owner_id !== req.user.id) return res.status(404).json({ error: 'Nicht gefunden' });
    const rollen = ROLLEN[art];
    const freunde = (Array.isArray(req.body?.freunde) ? req.body.freunde : []).slice(0, 200);
    const kurse = (Array.isArray(req.body?.kurse) ? req.body.kurse : []).slice(0, 50);
    for (const f of freunde) if (!istFreund(req.user.id, nr(f.id))) return res.status(403).json({ error: 'Teilen geht nur mit Freunden' });
    const kanon = [];
    for (const k of kurse) {
      const c = kanonischerKurs(k);
      if (!c || !hatKurs(req.user.id, c)) return res.status(403).json({ error: 'Nur Kurse aus deinem Stundenplan' });
      kanon.push(c);
    }
    const vorher = new Set(publikum(art, d.id, d.owner_id));
    // Notizen live: wer den Zugriff bekommt ODER verliert, sieht es sofort in seiner Liste.
    const liveSieht = art === 'notiz' ? uid => notizRolle(d, uid)
      : art === 'notiz_ordner' ? uid => ordnerRolle(d.id, uid) : null;
    const liveVorher = liveSieht ? liveBei(liveSieht) : [];
    transaktion(() => {
      db.prepare('DELETE FROM buero_freigabe WHERE art = ? AND ding_id = ?').run(art, d.id);
      const ein = db.prepare('INSERT OR IGNORE INTO buero_freigabe(art, ding_id, wer, user_id, course_id, rolle) VALUES(?, ?, ?, ?, ?, ?)');
      for (const f of freunde) ein.run(art, d.id, `u:${nr(f.id)}`, nr(f.id), null, rollen.includes(f.rolle) ? f.rolle : rollen[0]);
      for (const c of kanon) ein.run(art, d.id, `k:${c}`, null, c, rollen[0]);
    });
    // Wer neu dazukommt, erfaehrt davon - ausser bei Entwuerfen von Umfragen, die sieht noch keiner.
    if (!(art === 'umfrage' && d.status === 'draft'))
      for (const uid of publikum(art, d.id, d.owner_id)) if (!vorher.has(uid) && uid !== req.user.id)
        benachrichtige(uid, 'buero', `${nameVon(req.user)} teilt ${WORT[art]} mit dir`, d[TITEL[art]] ?? '', '/#buero');
    if (liveSieht) liveSenden([...liveVorher, ...liveBei(liveSieht)], req.user.id, art === 'notiz' ? d.id : null);
    res.json({ ok: true, anzahl: freunde.length + kanon.length });
  });

  const freigabeWeg = (art, id) => db.prepare('DELETE FROM buero_freigabe WHERE art = ? AND ding_id = ?').run(art, id);

  // =============================================================================================
  // Notizen
  // =============================================================================================

  // Die Rolle bei einem Ordner: seine eigene Freigabe oder die eines Elternordners. Geteilt wird
  // also immer der ganze Ast - samt allem, was spaeter hineinkommt.
  function ordnerRolle(oid, userId) {
    for (let i = 0; oid && i < 20; i++) {
      const o = sql('SELECT id, owner_id, parent_id FROM notiz_ordner WHERE id = ?').get(oid);
      if (!o) break;
      const r = rolleBei('notiz_ordner', o.id, o.owner_id, userId);
      if (r) return r;
      oid = o.parent_id;
    }
    return null;
  }
  // Die Rolle bei einer Notiz: direkt geteilt, oder ueber ihren Ordner (und dessen Eltern).
  function notizRolle(n, userId) {
    return rolleBei('notiz', n.id, n.owner_id, userId) ?? ordnerRolle(n.ordner_id, userId);
  }

  // --- Live (SSE) -----------------------------------------------------------------------------
  // Wer die Notizen offen hat, haelt eine Verbindung. Gemeldet wird nur, DASS sich etwas geaendert
  // hat - die ID der Notiz, bei Ordnern null. Den Inhalt holt der Client ueber die normalen Routen,
  // mit deren Rechtepruefung; ueber diese Leitung geht nie ein Text. Wer die Aenderung selbst
  // gemacht hat, bekommt nichts - er hat sie ja schon.
  // ponytail: eine Map in einem Prozess. Laeuft die App je auf mehreren, braucht es einen Bus dazwischen.
  const live = new Map();   // userId -> Set(res)
  const LIVE_JE_NUTZER = 5, LIVE_MAX = 1000;
  let liveZahl = 0;

  // Vor '/api/notizen/:id' - sonst hielte die Route "live" fuer eine ID.
  app.get('/api/notizen/live', auth, (req, res) => {
    // Schon weg, bevor die Route dran war (Abbruch waehrend der Middleware davor): dann kam 'close'
    // bereits und kaeme nie wieder - die Leiche zaehlte ewig mit und sperrte nach fuenf den Nutzer.
    if (req.socket.destroyed) return;
    const me = req.user.id;
    const meine = live.get(me) ?? new Set();
    // Offene Verbindungen kosten Speicher und einen Socket - horten laesst sich das nicht.
    if (meine.size >= LIVE_JE_NUTZER || liveZahl >= LIVE_MAX)
      return res.status(429).json({ error: 'Zu viele offene Live-Verbindungen' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      // Sonst sammelt ein vorgeschalteter nginx die Meldungen, statt sie durchzureichen.
      'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    meine.add(res); live.set(me, meine); liveZahl++;
    // Ohne Lebenszeichen schliessen Proxys eine stille Verbindung nach ein, zwei Minuten.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    ping.unref();
    res.on('close', () => {
      clearInterval(ping);
      meine.delete(res); liveZahl--;
      if (!meine.size) live.delete(me);
    });
  });

  /** Die gerade Verbundenen, die etwas sehen duerfen - dieselbe Pruefung wie beim Abrufen. */
  // ponytail: prueft jeden Verbundenen einzeln (~55 µs; 300 offene Leitungen = 18 ms je Speichern).
  // Werden es viele Hundert gleichzeitig, die Freigaben je Meldung nur einmal laden.
  const liveBei = sieht => [...live.keys()].filter(uid => sieht(uid));
  function liveSenden(uids, ausser, id = null) {
    const text = `event: notizen\ndata: ${JSON.stringify({ id })}\n\n`;
    for (const uid of new Set(uids)) if (uid !== ausser) for (const r of live.get(uid) ?? []) r.write(text);
  }
  // `vorher`: wer es VOR der Aenderung sah - wer eben den Zugriff verlor, soll es auch verlieren.
  const notizLive = (n, ausser, vorher = []) =>
    liveSenden([...vorher, ...liveBei(uid => notizRolle(n, uid))], ausser, n.id);
  const ordnerLive = (oid, ausser, vorher = []) =>
    liveSenden([...vorher, ...(oid ? liveBei(uid => ordnerRolle(oid, uid)) : [])], ausser);
  const darfAendern = r => r === 'besitzer' || r === 'aendern';

  function notizZeile(n, userId, rolle = notizRolle(n, userId), gezaehlt = null) {
    let tags = [];
    try { tags = JSON.parse(n.tags); } catch { /* leer */ }
    const todos = gezaehlt ?? sql('SELECT count(*) n, sum(done) d FROM notiz_todos WHERE notiz_id = ?').get(n.id);
    return { id: n.id, titel: n.titel, inhalt: n.inhalt, farbe: n.farbe, tags, ordner_id: n.ordner_id,
      angeheftet: !!n.angeheftet, archiviert: !!n.archiviert, created_at: n.created_at, updated_at: n.updated_at,
      besitzer: personVon(n.owner_id), geteilt: rolle !== 'besitzer', rolle,
      darf_aendern: darfAendern(rolle), todos: todos.n, todos_offen: todos.n - (todos.d ?? 0) };
  }

  // Ordner, in denen etwas mit mir geteilt ist - samt Unterordnern, denn geteilt wird ein Ast.
  // ponytail: liest alle Ordner aller Nutzer (fuer eine Schule ein paar Hundert Zeilen); wird das
  // viel, als rekursive CTE ab den eigenen und geteilten Ordnern.
  function sichtbareOrdner(userId) {
    const alle = db.prepare('SELECT * FROM notiz_ordner').all();
    const kinder = new Map();
    for (const o of alle) (kinder.get(o.parent_id) ?? kinder.set(o.parent_id, []).get(o.parent_id)).push(o);
    const sichtbar = new Map();
    const hinein = (o, rolle) => {
      if (sichtbar.has(o.id)) return;
      sichtbar.set(o.id, { ...o, rolle });
      for (const k of kinder.get(o.id) ?? []) hinein(k, k.owner_id === userId ? 'besitzer' : rolle);
    };
    for (const o of alle) if (o.owner_id === userId) hinein(o, 'besitzer');
    for (const id of geteiltMit('notiz_ordner', userId)) {
      const o = alle.find(x => x.id === id);
      if (o) hinein(o, rolleBei('notiz_ordner', o.id, o.owner_id, userId));
    }
    return [...sichtbar.values()];
  }

  app.get('/api/notizen', auth, (req, res) => {
    const me = req.user.id;
    const ordner = sichtbareOrdner(me);
    const ordnerIds = ordner.map(o => o.id);
    const direkt = geteiltMit('notiz', me);
    const platzO = ordnerIds.map(() => '?').join(',') || '0';
    const platzD = direkt.map(() => '?').join(',') || '0';
    const notizen = db.prepare(`SELECT * FROM notizen WHERE owner_id = ? OR id IN (${platzD}) OR ordner_id IN (${platzO})
      ORDER BY angeheftet DESC, updated_at DESC`).all(me, ...direkt, ...ordnerIds);
    // Die Todo-Zaehler in einer Abfrage statt einer je Notiz.
    const zaehler = new Map(notizen.length ? db.prepare(`SELECT notiz_id, count(*) n, sum(done) d FROM notiz_todos
      WHERE notiz_id IN (${notizen.map(() => '?').join(',')}) GROUP BY notiz_id`).all(...notizen.map(n => n.id))
      .map(z => [z.notiz_id, z]) : []);
    res.json({
      notizen: notizen.map(n => notizZeile(n, me, undefined, zaehler.get(n.id) ?? { n: 0, d: 0 })).filter(n => n.rolle),
      ordner: ordner.map(o => ({ id: o.id, name: o.name, farbe: o.farbe, parent_id: o.parent_id,
        rolle: o.rolle, besitzer: personVon(o.owner_id), geteilt: o.rolle !== 'besitzer' })),
    });
  });

  const notizEingabe = (b, alt = {}) => {
    const titel = 'titel' in b ? txt(b.titel, 200) : alt.titel ?? '';
    const inhalt = 'inhalt' in b ? String(b.inhalt ?? '').slice(0, 50_000) : alt.inhalt ?? '';
    if (!titel && !inhalt) return { error: 'Titel oder Text nötig' };
    let tags = alt.tags ?? '[]';
    if ('tags' in b) tags = JSON.stringify([...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags ?? '').split(','))
      .map(t => txt(t, 30).replace(/^#/, '')).filter(Boolean))].slice(0, 20));
    const farbe = 'farbe' in b ? (HEX.test(b.farbe ?? '') ? b.farbe : null) : alt.farbe ?? null;
    return { data: { titel, inhalt, tags, farbe } };
  };
  const eigenerOrdner = (id, me) => id == null || id === '' ? null
    : db.prepare('SELECT id FROM notiz_ordner WHERE id = ? AND owner_id = ?').get(nr(id), me)?.id ?? false;

  app.post('/api/notizen', auth, bremse('notiz', 120), (req, res) => {
    const { data, error } = notizEingabe(req.body ?? {});
    if (error) return res.status(400).json({ error });
    const ordner = eigenerOrdner(req.body?.ordner_id, req.user.id);
    if (ordner === false) return res.status(404).json({ error: 'Ordner nicht gefunden' });
    const { lastInsertRowid } = db.prepare(`INSERT INTO notizen(owner_id, ordner_id, titel, inhalt, farbe, tags, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, ordner, data.titel, data.inhalt, data.farbe, data.tags, jetzt(), jetzt());
    const n = db.prepare('SELECT * FROM notizen WHERE id = ?').get(lastInsertRowid);
    notizLive(n, req.user.id);
    res.status(201).json(notizZeile(n, req.user.id));
  });

  const notizFuer = (req, res) => {
    const n = db.prepare('SELECT * FROM notizen WHERE id = ?').get(nr(req.params.id));
    const rolle = n && notizRolle(n, req.user.id);
    if (!rolle) { res.status(404).json({ error: 'Notiz nicht gefunden' }); return null; }
    return { n, rolle };
  };

  app.get('/api/notizen/:id', auth, (req, res) => {
    const x = notizFuer(req, res); if (!x) return;
    res.json({ ...notizZeile(x.n, req.user.id, x.rolle),
      todo_liste: db.prepare('SELECT id, text, done FROM notiz_todos WHERE notiz_id = ? ORDER BY sort, id').all(x.n.id)
        .map(t => ({ ...t, done: !!t.done })),
      kommentare: db.prepare('SELECT * FROM notiz_kommentare WHERE notiz_id = ? ORDER BY id').all(x.n.id)
        .map(k => ({ id: k.id, text: k.text, at: k.created_at, von: personVon(k.user_id),
          darf_loeschen: k.user_id === req.user.id || x.rolle === 'besitzer' })) });
  });

  app.patch('/api/notizen/:id', auth, (req, res) => {
    const x = notizFuer(req, res); if (!x) return;
    if (!darfAendern(x.rolle)) return res.status(403).json({ error: 'Nur lesen' });
    const b = req.body ?? {};
    const { data, error } = notizEingabe(b, x.n);
    if (error) return res.status(400).json({ error });
    // Ordner, Anheften und Archiv gehoeren dem Besitzer - ein Mitschreiber raeumt nicht fremde Ablagen um.
    let ordner = x.n.ordner_id;
    if ('ordner_id' in b) {
      if (x.rolle !== 'besitzer') return res.status(403).json({ error: 'Nur der Besitzer verschiebt' });
      ordner = eigenerOrdner(b.ordner_id, req.user.id);
      if (ordner === false) return res.status(404).json({ error: 'Ordner nicht gefunden' });
    }
    const vorher = ordner !== x.n.ordner_id ? liveBei(uid => notizRolle(x.n, uid)) : [];
    db.prepare('UPDATE notizen SET titel = ?, inhalt = ?, farbe = ?, tags = ?, ordner_id = ?, updated_at = ? WHERE id = ?')
      .run(data.titel, data.inhalt, data.farbe, data.tags, ordner, jetzt(), x.n.id);
    const n = db.prepare('SELECT * FROM notizen WHERE id = ?').get(x.n.id);
    notizLive(n, req.user.id, vorher);
    res.json(notizZeile(n, req.user.id));
  });

  for (const [weg, spalte] of [['anheften', 'angeheftet'], ['archiv', 'archiviert']]) {
    app.post(`/api/notizen/:id/${weg}`, auth, (req, res) => {
      const x = notizFuer(req, res); if (!x) return;
      if (x.rolle !== 'besitzer') return res.status(403).json({ error: 'Nur der Besitzer' });
      const an = 'an' in (req.body ?? {}) ? !!req.body.an : !x.n[spalte];
      db.prepare(`UPDATE notizen SET ${spalte} = ? WHERE id = ?`).run(an ? 1 : 0, x.n.id);
      notizLive(x.n, req.user.id);
      res.json({ [spalte]: an });
    });
  }

  app.delete('/api/notizen/:id', auth, (req, res) => {
    const x = notizFuer(req, res); if (!x) return;
    if (x.rolle !== 'besitzer') return res.status(403).json({ error: 'Nur der Besitzer löscht' });
    const an = liveBei(uid => notizRolle(x.n, uid));   // danach sieht sie keiner mehr
    db.prepare('DELETE FROM notizen WHERE id = ?').run(x.n.id);
    freigabeWeg('notiz', x.n.id);
    liveSenden(an, req.user.id, x.n.id);
    res.json({ ok: true });
  });

  // Todos und Kommentare einer Notiz
  app.post('/api/notizen/:id/todos', auth, (req, res) => {
    const x = notizFuer(req, res); if (!x) return;
    if (!darfAendern(x.rolle)) return res.status(403).json({ error: 'Nur lesen' });
    const text = txt(req.body?.text, 500);
    if (!text) return res.status(400).json({ error: 'Text nötig' });
    const sort = db.prepare('SELECT coalesce(max(sort), 0) + 1 s FROM notiz_todos WHERE notiz_id = ?').get(x.n.id).s;
    const { lastInsertRowid } = db.prepare('INSERT INTO notiz_todos(notiz_id, text, sort) VALUES(?, ?, ?)').run(x.n.id, text, sort);
    notizLive(x.n, req.user.id);
    res.status(201).json({ id: Number(lastInsertRowid), text, done: false });
  });
  const todoFuer = (req, res) => {
    const t = db.prepare('SELECT * FROM notiz_todos WHERE id = ?').get(nr(req.params.tid));
    const n = t && db.prepare('SELECT * FROM notizen WHERE id = ?').get(t.notiz_id);
    const rolle = n && notizRolle(n, req.user.id);
    if (!rolle) { res.status(404).json({ error: 'Nicht gefunden' }); return null; }
    if (!darfAendern(rolle)) { res.status(403).json({ error: 'Nur lesen' }); return null; }
    return { ...t, notiz: n };
  };
  app.patch('/api/notizen/todos/:tid', auth, (req, res) => {
    const t = todoFuer(req, res); if (!t) return;
    const text = 'text' in (req.body ?? {}) ? txt(req.body.text, 500) : t.text;
    if (!text) return res.status(400).json({ error: 'Text nötig' });
    const done = 'done' in (req.body ?? {}) ? (req.body.done ? 1 : 0) : t.done;
    db.prepare('UPDATE notiz_todos SET text = ?, done = ? WHERE id = ?').run(text, done, t.id);
    notizLive(t.notiz, req.user.id);
    res.json({ id: t.id, text, done: !!done });
  });
  app.delete('/api/notizen/todos/:tid', auth, (req, res) => {
    const t = todoFuer(req, res); if (!t) return;
    db.prepare('DELETE FROM notiz_todos WHERE id = ?').run(t.id);
    notizLive(t.notiz, req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/notizen/:id/kommentare', auth, bremse('notiz-kommentar', 60), (req, res) => {
    const x = notizFuer(req, res); if (!x) return;
    const text = txt(req.body?.text, 2000);
    if (!text) return res.status(400).json({ error: 'Text nötig' });
    const { lastInsertRowid } = db.prepare('INSERT INTO notiz_kommentare(notiz_id, user_id, text, created_at) VALUES(?, ?, ?, ?)')
      .run(x.n.id, req.user.id, text, jetzt());
    if (x.n.owner_id !== req.user.id)
      benachrichtige(x.n.owner_id, 'buero', `${nameVon(req.user)} kommentiert deine Notiz`, text.slice(0, 120), '/#buero');
    notizLive(x.n, req.user.id);
    res.status(201).json({ id: Number(lastInsertRowid), text });
  });
  app.delete('/api/notizen/kommentare/:kid', auth, (req, res) => {
    const k = db.prepare('SELECT * FROM notiz_kommentare WHERE id = ?').get(nr(req.params.kid));
    const n = k && db.prepare('SELECT * FROM notizen WHERE id = ?').get(k.notiz_id);
    if (!n || !notizRolle(n, req.user.id)) return res.status(404).json({ error: 'Nicht gefunden' });
    if (k.user_id !== req.user.id && n.owner_id !== req.user.id) return res.status(403).json({ error: 'Nur eigene' });
    db.prepare('DELETE FROM notiz_kommentare WHERE id = ?').run(k.id);
    notizLive(n, req.user.id);
    res.json({ ok: true });
  });

  // Ordner
  app.post('/api/notizen-ordner', auth, (req, res) => {
    const name = txt(req.body?.name, 100);
    if (!name) return res.status(400).json({ error: 'Name nötig' });
    const parent = eigenerOrdner(req.body?.parent_id, req.user.id);
    if (parent === false) return res.status(404).json({ error: 'Ordner nicht gefunden' });
    const { lastInsertRowid } = db.prepare('INSERT INTO notiz_ordner(owner_id, parent_id, name, farbe, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(req.user.id, parent, name, HEX.test(req.body?.farbe ?? '') ? req.body.farbe : null, jetzt());
    ordnerLive(parent, req.user.id);   // ein Unterordner in einem geteilten Ast ist sofort mit drin
    res.status(201).json({ id: Number(lastInsertRowid), name, parent_id: parent });
  });
  const eigenerOrdnerOder404 = (req, res) => {
    const o = db.prepare('SELECT * FROM notiz_ordner WHERE id = ? AND owner_id = ?').get(nr(req.params.id), req.user.id);
    if (!o) res.status(404).json({ error: 'Ordner nicht gefunden' });
    return o;
  };
  app.patch('/api/notizen-ordner/:id', auth, (req, res) => {
    const o = eigenerOrdnerOder404(req, res); if (!o) return;
    const name = 'name' in (req.body ?? {}) ? txt(req.body.name, 100) : o.name;
    if (!name) return res.status(400).json({ error: 'Name nötig' });
    let parent = o.parent_id;
    if ('parent_id' in (req.body ?? {})) {
      parent = eigenerOrdner(req.body.parent_id, req.user.id);
      if (parent === false) return res.status(404).json({ error: 'Ordner nicht gefunden' });
      // Nicht in sich selbst oder einen eigenen Unterordner - sonst haengt der Ast in der Luft.
      for (let p = parent, i = 0; p && i < 50; i++) {
        if (p === o.id) return res.status(400).json({ error: 'Ein Ordner kann nicht in sich selbst liegen' });
        p = db.prepare('SELECT parent_id FROM notiz_ordner WHERE id = ?').get(p)?.parent_id;
      }
    }
    const farbe = 'farbe' in (req.body ?? {}) ? (HEX.test(req.body.farbe ?? '') ? req.body.farbe : null) : o.farbe;
    const vorher = liveBei(uid => ordnerRolle(o.id, uid));
    db.prepare('UPDATE notiz_ordner SET name = ?, parent_id = ?, farbe = ? WHERE id = ?').run(name, parent, farbe, o.id);
    ordnerLive(o.id, req.user.id, vorher);
    res.json({ id: o.id, name, parent_id: parent, farbe });
  });
  // Loeschen verliert nichts: die Notizen liegen danach ohne Ordner, Unterordner ruecken hoch.
  app.delete('/api/notizen-ordner/:id', auth, (req, res) => {
    const o = eigenerOrdnerOder404(req, res); if (!o) return;
    const an = liveBei(uid => ordnerRolle(o.id, uid));   // danach sieht ihn keiner mehr
    db.prepare('UPDATE notiz_ordner SET parent_id = ? WHERE parent_id = ?').run(o.parent_id, o.id);
    db.prepare('UPDATE notizen SET ordner_id = NULL WHERE ordner_id = ?').run(o.id);
    db.prepare('DELETE FROM notiz_ordner WHERE id = ?').run(o.id);
    freigabeWeg('notiz_ordner', o.id);
    liveSenden(an, req.user.id);
    res.json({ ok: true });
  });

  // =============================================================================================
  // Ideenbaum
  // =============================================================================================

  const boardFuer = (id, userId) => {
    const b = db.prepare('SELECT * FROM ideen_boards WHERE id = ?').get(nr(id));
    const rolle = b && rolleBei('idee', b.id, b.owner_id, userId);
    return rolle ? { b, rolle, team: rolle === 'besitzer' || rolle === 'team' } : null;
  };
  const knotenFuer = (id, userId) => {
    const k = db.prepare('SELECT * FROM ideen_knoten WHERE id = ?').get(nr(id));
    const z = k && boardFuer(k.board_id, userId);
    return z ? { ...z, k } : null;
  };

  /**
   * Braucht ein neuer Knoten unter `parentId` eine Freigabe? Erst die Ast-Regel: der naechste
   * Vorfahr mit gesetzter Regel entscheidet - fuer alle, auch das Team. Ohne Regel der Modus des
   * Boards: open nie, strict immer, moderated nur fuer die, die nicht im Team sind.
   */
  function brauchtFreigabe(b, parentId, team) {
    for (let p = parentId, i = 0; p && i < 200; i++) {
      const k = db.prepare('SELECT parent_id, braucht_freigabe FROM ideen_knoten WHERE id = ?').get(p);
      if (!k) break;
      if (k.braucht_freigabe != null) return !!k.braucht_freigabe;
      p = k.parent_id;
    }
    return b.modus === 'strict' || (b.modus === 'moderated' && !team);
  }

  const version = (k, von) => db.prepare('INSERT INTO ideen_versionen(knoten_id, titel, text, von_name, at) VALUES(?, ?, ?, ?, ?)')
    .run(k.id, k.titel, k.text, von, jetzt());

  const boardZeile = (b, me, rolle) => ({ id: b.id, name: b.name, beschreibung: b.beschreibung, modus: b.modus,
    gesperrt: !!b.gesperrt, archiviert: !!b.archiviert, besitzer: personVon(b.owner_id), rolle,
    team: rolle === 'besitzer' || rolle === 'team',
    knoten: db.prepare("SELECT count(*) n FROM ideen_knoten WHERE board_id = ? AND status = 'approved'").get(b.id).n,
    wartend: db.prepare("SELECT count(*) n FROM ideen_knoten WHERE board_id = ? AND status = 'pending'").get(b.id).n });

  app.get('/api/ideen', auth, (req, res) => {
    const me = req.user.id;
    const geteilt = geteiltMit('idee', me);
    const platz = geteilt.map(() => '?').join(',') || '0';
    res.json(db.prepare(`SELECT * FROM ideen_boards WHERE owner_id = ? OR id IN (${platz}) ORDER BY archiviert, id DESC`)
      .all(me, ...geteilt).map(b => boardZeile(b, me, rolleBei('idee', b.id, b.owner_id, me))).filter(b => b.rolle));
  });

  const MODI = ['open', 'moderated', 'strict'];
  app.post('/api/ideen', auth, bremse('ideen', 30), (req, res) => {
    const name = txt(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: 'Name nötig' });
    const modus = MODI.includes(req.body?.modus) ? req.body.modus : 'moderated';
    const { lastInsertRowid } = db.prepare('INSERT INTO ideen_boards(owner_id, name, beschreibung, modus, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(req.user.id, name, txt(req.body?.beschreibung, 2000) || null, modus, jetzt());
    res.status(201).json(boardZeile(db.prepare('SELECT * FROM ideen_boards WHERE id = ?').get(lastInsertRowid), req.user.id, 'besitzer'));
  });

  app.get('/api/ideen/:id', auth, (req, res) => {
    const z = boardFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    const me = req.user.id;
    // Wartendes sieht das Team und wer es vorgeschlagen hat - sonst niemand.
    const knoten = db.prepare('SELECT * FROM ideen_knoten WHERE board_id = ? ORDER BY sort, id').all(z.b.id)
      .filter(k => k.status === 'approved' || z.team || k.von_id === me);
    const stimmen = db.prepare('SELECT knoten_id, wahl, user_id FROM ideen_stimmen WHERE knoten_id IN (SELECT id FROM ideen_knoten WHERE board_id = ?)').all(z.b.id);
    const kommentare = db.prepare('SELECT knoten_id, count(*) n FROM ideen_kommentare WHERE knoten_id IN (SELECT id FROM ideen_knoten WHERE board_id = ?) GROUP BY knoten_id').all(z.b.id);
    res.json({ ...boardZeile(z.b, me, z.rolle),
      knoten: knoten.map(k => {
        const s = stimmen.filter(x => x.knoten_id === k.id);
        return { id: k.id, parent_id: k.parent_id, art: k.art, titel: k.titel, text: k.text, status: k.status,
          braucht_freigabe: k.braucht_freigabe, gesperrt: !!k.gesperrt, abstimmung: k.abstimmung, ausgenommen: !!k.ausgenommen,
          done: !!k.done, von: personVon(k.von_id), eigen: k.von_id === me,
          stimmen: { yes: s.filter(x => x.wahl === 'yes').length, no: s.filter(x => x.wahl === 'no').length,
            abstain: s.filter(x => x.wahl === 'abstain').length },
          meine_stimme: s.find(x => x.user_id === me)?.wahl ?? null,
          kommentare: kommentare.find(x => x.knoten_id === k.id)?.n ?? 0 };
      }),
      kanten: db.prepare('SELECT id, von, nach, label FROM ideen_kanten WHERE board_id = ?').all(z.b.id) });
  });

  app.patch('/api/ideen/:id', auth, (req, res) => {
    const z = boardFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    const b = req.body ?? {};
    const name = 'name' in b ? txt(b.name, 120) : z.b.name;
    if (!name) return res.status(400).json({ error: 'Name nötig' });
    const modus = MODI.includes(b.modus) ? b.modus : z.b.modus;
    const archiviert = 'archiviert' in b ? (b.archiviert ? 1 : 0) : z.b.archiviert;
    db.prepare('UPDATE ideen_boards SET name = ?, beschreibung = ?, modus = ?, archiviert = ? WHERE id = ?')
      .run(name, 'beschreibung' in b ? txt(b.beschreibung, 2000) || null : z.b.beschreibung, modus, archiviert, z.b.id);
    // Archivieren schliesst alle offenen Abstimmungen.
    if (archiviert) db.prepare("UPDATE ideen_knoten SET abstimmung = 'closed' WHERE board_id = ? AND abstimmung = 'open'").run(z.b.id);
    res.json(boardZeile(db.prepare('SELECT * FROM ideen_boards WHERE id = ?').get(z.b.id), req.user.id, 'besitzer'));
  });

  app.delete('/api/ideen/:id', auth, (req, res) => {
    const z = boardFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    db.prepare('DELETE FROM ideen_boards WHERE id = ?').run(z.b.id);
    freigabeWeg('idee', z.b.id);
    res.json({ ok: true });
  });

  // Board sperren oeffnet die Abstimmung fuer alle freigegebenen, nicht ausgenommenen Knoten;
  // entsperren schliesst sie wieder.
  app.post('/api/ideen/:id/sperren', auth, (req, res) => {
    const z = boardFuer(req.params.id, req.user.id);
    if (!z?.team) return res.status(404).json({ error: 'Nicht gefunden' });
    const an = !!req.body?.an;
    db.prepare('UPDATE ideen_boards SET gesperrt = ? WHERE id = ?').run(an ? 1 : 0, z.b.id);
    if (an) db.prepare("UPDATE ideen_knoten SET abstimmung = 'open' WHERE board_id = ? AND status = 'approved' AND ausgenommen = 0 AND art <> 'heading'").run(z.b.id);
    else db.prepare("UPDATE ideen_knoten SET abstimmung = 'closed' WHERE board_id = ? AND abstimmung = 'open'").run(z.b.id);
    res.json({ gesperrt: an });
  });

  const ARTEN = ['heading', 'idea', 'todo'];
  app.post('/api/ideen/:id/knoten', auth, bremse('ideen-knoten', 120), (req, res) => {
    const z = boardFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (z.b.archiviert) return res.status(409).json({ error: 'Der Ideenbaum ist archiviert' });
    if (z.b.gesperrt && !z.team) return res.status(409).json({ error: 'Der Ideenbaum ist gesperrt' });
    const titel = txt(req.body?.titel, 200);
    if (!titel) return res.status(400).json({ error: 'Titel nötig' });
    const parent = req.body?.parent_id ? db.prepare('SELECT * FROM ideen_knoten WHERE id = ? AND board_id = ?').get(nr(req.body.parent_id), z.b.id) : null;
    if (req.body?.parent_id && !parent) return res.status(404).json({ error: 'Übergeordnete Idee nicht gefunden' });
    if (parent?.status === 'pending') return res.status(409).json({ error: 'Unter einem wartenden Vorschlag geht noch nichts' });
    if (parent?.gesperrt && !z.team) return res.status(409).json({ error: 'Dieser Ast ist gesperrt' });
    const wartet = brauchtFreigabe(z.b, parent?.id ?? null, z.team);
    const art = ARTEN.includes(req.body?.art) ? req.body.art : 'idea';
    const sort = db.prepare('SELECT coalesce(max(sort), 0) + 1 s FROM ideen_knoten WHERE board_id = ? AND parent_id IS ?').get(z.b.id, parent?.id ?? null).s;
    const { lastInsertRowid } = db.prepare(`INSERT INTO ideen_knoten(board_id, parent_id, art, titel, text, von_id, status, sort, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(z.b.id, parent?.id ?? null, art, titel, txt(req.body?.text, 5000) || null,
      req.user.id, wartet ? 'pending' : 'approved', sort, jetzt(), jetzt());
    if (wartet && z.b.owner_id !== req.user.id)
      benachrichtige(z.b.owner_id, 'buero', `Neuer Vorschlag in „${z.b.name}"`, titel, '/#buero');
    res.status(201).json({ id: Number(lastInsertRowid), status: wartet ? 'pending' : 'approved' });
  });

  app.patch('/api/ideen/knoten/:kid', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    const { k, team } = z;
    const eigen = k.von_id === req.user.id;
    if (!team && !eigen) return res.status(403).json({ error: 'Nur wer es vorgeschlagen hat, oder das Team' });
    if (k.gesperrt && !team) return res.status(409).json({ error: 'Gesperrt' });
    const b = req.body ?? {};
    const titel = 'titel' in b ? txt(b.titel, 200) : k.titel;
    if (!titel) return res.status(400).json({ error: 'Titel nötig' });
    const text = 'text' in b ? txt(b.text, 5000) || null : k.text;
    if (titel !== k.titel || text !== k.text) version(k, nameVon(req.user));
    // Was nur das Team stellt: Ast-Regel, Sperre, von der Abstimmung ausgenommen.
    const nurTeam = ['braucht_freigabe', 'gesperrt', 'ausgenommen'];
    if (!team && nurTeam.some(f => f in b)) return res.status(403).json({ error: 'Nur das Team' });
    const bf = 'braucht_freigabe' in b ? (b.braucht_freigabe == null ? null : b.braucht_freigabe ? 1 : 0) : k.braucht_freigabe;
    db.prepare(`UPDATE ideen_knoten SET titel = ?, text = ?, art = ?, done = ?, braucht_freigabe = ?, gesperrt = ?, ausgenommen = ?, updated_at = ? WHERE id = ?`)
      .run(titel, text, ARTEN.includes(b.art) ? b.art : k.art, 'done' in b ? (b.done ? 1 : 0) : k.done, bf,
        'gesperrt' in b ? (b.gesperrt ? 1 : 0) : k.gesperrt, 'ausgenommen' in b ? (b.ausgenommen ? 1 : 0) : k.ausgenommen, jetzt(), k.id);
    res.json({ ok: true });
  });

  app.delete('/api/ideen/knoten/:kid', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!z.team && z.k.von_id !== req.user.id) return res.status(403).json({ error: 'Nur wer es vorgeschlagen hat, oder das Team' });
    // Ohne Team-Rolle nicht die Ideen anderer mitloeschen - der Unterbaum geht mit.
    if (!z.team && db.prepare(`WITH RECURSIVE ast(id) AS (SELECT id FROM ideen_knoten WHERE parent_id = ?
        UNION ALL SELECT k.id FROM ideen_knoten k JOIN ast ON k.parent_id = ast.id)
        SELECT 1 FROM ideen_knoten WHERE id IN (SELECT id FROM ast) AND von_id IS NOT ? LIMIT 1`).get(z.k.id, req.user.id))
      return res.status(409).json({ error: 'Darunter stehen Ideen von anderen – löschen kann das nur das Team' });
    db.prepare('DELETE FROM ideen_knoten WHERE id = ?').run(z.k.id);
    res.json({ ok: true });
  });

  app.post('/api/ideen/knoten/:kid/freigeben', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z?.team) return res.status(404).json({ error: 'Nicht gefunden' });
    db.prepare("UPDATE ideen_knoten SET status = 'approved' WHERE id = ?").run(z.k.id);
    if (z.k.von_id && z.k.von_id !== req.user.id)
      benachrichtige(z.k.von_id, 'buero', `Dein Vorschlag ist drin: ${z.k.titel}`, `in „${z.b.name}"`, '/#buero');
    res.json({ ok: true });
  });

  // Ablehnen braucht eine Begruendung - der Vorschlag verschwindet samt Unterbaum, die Begruendung
  // bleibt fuer den, der ihn gemacht hat.
  app.post('/api/ideen/knoten/:kid/ablehnen', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z?.team) return res.status(404).json({ error: 'Nicht gefunden' });
    const grund = txt(req.body?.grund, 1000);
    if (!grund) return res.status(400).json({ error: 'Begründung nötig' });
    db.prepare('INSERT INTO ideen_ablehnungen(board_id, titel, grund, von_name, vorschlag_von, at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(z.b.id, z.k.titel, grund, nameVon(req.user), z.k.von_id, jetzt());
    db.prepare('DELETE FROM ideen_knoten WHERE id = ?').run(z.k.id);
    if (z.k.von_id && z.k.von_id !== req.user.id)
      benachrichtige(z.k.von_id, 'buero', `Vorschlag abgelehnt: ${z.k.titel}`, grund.slice(0, 120), '/#buero');
    res.json({ ok: true });
  });

  app.get('/api/ideen-ablehnungen', auth, (req, res) => {
    res.json(db.prepare(`SELECT a.*, b.name AS board FROM ideen_ablehnungen a JOIN ideen_boards b ON b.id = a.board_id
      WHERE a.vorschlag_von = ? ORDER BY a.id DESC LIMIT 50`).all(req.user.id)
      .map(a => ({ id: a.id, board: a.board, titel: a.titel, grund: a.grund, von: a.von_name, at: a.at })));
  });

  // Abstimmung je Knoten: oeffnen/schliessen (Team), abstimmen (alle mit Zugang).
  app.post('/api/ideen/knoten/:kid/abstimmung', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z?.team) return res.status(404).json({ error: 'Nicht gefunden' });
    if (z.k.status !== 'approved') return res.status(409).json({ error: 'Erst freigeben' });
    db.prepare('UPDATE ideen_knoten SET abstimmung = ? WHERE id = ?').run(req.body?.offen ? 'open' : 'closed', z.k.id);
    res.json({ abstimmung: req.body?.offen ? 'open' : 'closed' });
  });
  const WAHL = ['yes', 'no', 'abstain'];
  app.post('/api/ideen/knoten/:kid/stimme', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (z.k.abstimmung !== 'open') return res.status(409).json({ error: 'Hier wird gerade nicht abgestimmt' });
    if (req.body?.wahl == null) {
      db.prepare('DELETE FROM ideen_stimmen WHERE knoten_id = ? AND user_id = ?').run(z.k.id, req.user.id);
      return res.json({ wahl: null });
    }
    if (!WAHL.includes(req.body.wahl)) return res.status(400).json({ error: 'Ja, Nein oder Enthaltung' });
    db.prepare(`INSERT INTO ideen_stimmen(knoten_id, user_id, wahl) VALUES(?, ?, ?)
      ON CONFLICT(knoten_id, user_id) DO UPDATE SET wahl = excluded.wahl`).run(z.k.id, req.user.id, req.body.wahl);
    res.json({ wahl: req.body.wahl });
  });

  // Kommentare: eine Antwortebene - eine Antwort auf eine Antwort haengt an der Wurzel.
  app.get('/api/ideen/knoten/:kid/kommentare', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(db.prepare('SELECT * FROM ideen_kommentare WHERE knoten_id = ? ORDER BY id').all(z.k.id).map(c => ({
      id: c.id, text: c.text, parent_id: c.parent_id, at: c.created_at, von: personVon(c.user_id),
      darf_loeschen: c.user_id === req.user.id || z.team })));
  });
  app.post('/api/ideen/knoten/:kid/kommentare', auth, bremse('ideen-kommentar', 60), (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (z.k.gesperrt && !z.team) return res.status(409).json({ error: 'Gesperrt' });
    const text = txt(req.body?.text, 2000);
    if (!text) return res.status(400).json({ error: 'Text nötig' });
    let parent = req.body?.parent_id ? db.prepare('SELECT * FROM ideen_kommentare WHERE id = ? AND knoten_id = ?').get(nr(req.body.parent_id), z.k.id) : null;
    if (parent?.parent_id) parent = db.prepare('SELECT * FROM ideen_kommentare WHERE id = ?').get(parent.parent_id);
    const { lastInsertRowid } = db.prepare('INSERT INTO ideen_kommentare(knoten_id, user_id, text, parent_id, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(z.k.id, req.user.id, text, parent?.id ?? null, jetzt());
    const an = parent?.user_id ?? z.k.von_id;
    if (an && an !== req.user.id)
      benachrichtige(an, 'buero', `${nameVon(req.user)} antwortet: ${z.k.titel}`, text.slice(0, 120), '/#buero');
    res.status(201).json({ id: Number(lastInsertRowid) });
  });
  app.delete('/api/ideen/kommentare/:cid', auth, (req, res) => {
    const c = db.prepare('SELECT * FROM ideen_kommentare WHERE id = ?').get(nr(req.params.cid));
    const z = c && knotenFuer(c.knoten_id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (c.user_id !== req.user.id && !z.team) return res.status(403).json({ error: 'Nur eigene' });
    db.prepare('DELETE FROM ideen_kommentare WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  app.get('/api/ideen/knoten/:kid/versionen', auth, (req, res) => {
    const z = knotenFuer(req.params.kid, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(db.prepare('SELECT id, titel, text, von_name, at FROM ideen_versionen WHERE knoten_id = ? ORDER BY id DESC').all(z.k.id));
  });
  app.post('/api/ideen/versionen/:vid/zurueck', auth, (req, res) => {
    const v = db.prepare('SELECT * FROM ideen_versionen WHERE id = ?').get(nr(req.params.vid));
    const z = v && knotenFuer(v.knoten_id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!z.team && z.k.von_id !== req.user.id) return res.status(403).json({ error: 'Nur wer es vorgeschlagen hat, oder das Team' });
    version(z.k, nameVon(req.user));
    db.prepare('UPDATE ideen_knoten SET titel = ?, text = ?, updated_at = ? WHERE id = ?').run(v.titel, v.text, jetzt(), z.k.id);
    res.json({ ok: true });
  });

  // Querverbindungen - nicht auf sich selbst, nicht doppelt, nicht im gesperrten Baum.
  app.post('/api/ideen/:id/kanten', auth, (req, res) => {
    const z = boardFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (z.b.gesperrt) return res.status(409).json({ error: 'Der Ideenbaum ist gesperrt' });
    const von = db.prepare('SELECT * FROM ideen_knoten WHERE id = ? AND board_id = ?').get(nr(req.body?.von), z.b.id);
    const nach = db.prepare('SELECT * FROM ideen_knoten WHERE id = ? AND board_id = ?').get(nr(req.body?.nach), z.b.id);
    if (!von || !nach || von.id === nach.id) return res.status(400).json({ error: 'Zwei verschiedene Ideen wählen' });
    if (!z.team && von.von_id !== req.user.id) return res.status(403).json({ error: 'Nur von eigenen Ideen aus, oder das Team' });
    const r = db.prepare('INSERT OR IGNORE INTO ideen_kanten(board_id, von, nach, label) VALUES(?, ?, ?, ?)')
      .run(z.b.id, von.id, nach.id, txt(req.body?.label, 60) || null);
    if (!r.changes) return res.status(409).json({ error: 'Diese Verbindung gibt es schon' });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  app.delete('/api/ideen/kanten/:eid', auth, (req, res) => {
    const e = db.prepare('SELECT * FROM ideen_kanten WHERE id = ?').get(nr(req.params.eid));
    const z = e && boardFuer(e.board_id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    const von = db.prepare('SELECT von_id FROM ideen_knoten WHERE id = ?').get(e.von);
    if (!z.team && von?.von_id !== req.user.id) return res.status(403).json({ error: 'Nur das Team' });
    db.prepare('DELETE FROM ideen_kanten WHERE id = ?').run(e.id);
    res.json({ ok: true });
  });

  // =============================================================================================
  // Abstimmungen
  // =============================================================================================

  const laeuft = a => !a.endet_at || a.endet_at > jetzt();
  const abstimmungFuer = (id, userId) => {
    const a = db.prepare('SELECT * FROM abstimmungen WHERE id = ?').get(nr(id));
    const rolle = a && rolleBei('abstimmung', a.id, a.owner_id, userId);
    return rolle ? { a, rolle } : null;
  };

  function abstimmungZeile(a, me, rolle) {
    const optionen = db.prepare('SELECT id, text FROM abstimmung_optionen WHERE abstimmung_id = ? ORDER BY sort, id').all(a.id);
    const stimmen = db.prepare('SELECT * FROM abstimmung_stimmen WHERE abstimmung_id = ?').all(a.id);
    const meine = stimmen.filter(s => s.user_id === me);
    const lauf = laeuft(a);
    const darfErgebnis = rolle === 'besitzer' || (a.ergebnis_fuer === 'alle' && (a.ergebnis_live || !lauf));
    let ergebnis = null;
    if (darfErgebnis) {
      const namenErlaubt = s => a.anonym === 'oeffentlich' || (a.anonym === 'selbst' && s.name_zeigen);
      ergebnis = {
        stimmen: new Set(stimmen.map(s => s.user_id)).size,
        optionen: optionen.map(o => {
          const hier = stimmen.filter(s => s.option_id === o.id);
          const namen = a.anonym === 'anonym' ? [] : hier.filter(namenErlaubt).map(s => nameVon(nutzer(s.user_id) ?? { username: '?' }));
          return { id: o.id, text: o.text, anzahl: hier.length, namen, ohne_namen: hier.length - namen.length };
        }),
      };
    }
    return { id: a.id, titel: a.titel, beschreibung: a.beschreibung, mehrfach: !!a.mehrfach, max_wahl: a.max_wahl,
      anonym: a.anonym, endet_at: a.endet_at, schliessen_angefragt: !!a.schliessen_angefragt, laeuft: lauf,
      ergebnis_live: !!a.ergebnis_live, ergebnis_fuer: a.ergebnis_fuer, created_at: a.created_at,
      besitzer: personVon(a.owner_id), rolle, optionen, meine_wahl: meine.map(s => s.option_id),
      mein_name_zeigen: !!meine[0]?.name_zeigen, ergebnis, hat_stimmen: stimmen.length > 0 };
  }

  app.get('/api/abstimmungen', auth, (req, res) => {
    const me = req.user.id;
    const geteilt = geteiltMit('abstimmung', me);
    const platz = geteilt.map(() => '?').join(',') || '0';
    res.json(db.prepare(`SELECT * FROM abstimmungen WHERE owner_id = ? OR id IN (${platz}) ORDER BY id DESC`)
      .all(me, ...geteilt).map(a => abstimmungZeile(a, me, rolleBei('abstimmung', a.id, a.owner_id, me))).filter(a => a.rolle));
  });

  const ANONYM = ['anonym', 'oeffentlich', 'selbst'];
  function abstimmungEingabe(b, alt = {}) {
    const titel = 'titel' in b ? txt(b.titel, 200) : alt.titel;
    if (!titel) return { error: 'Titel nötig' };
    const optionen = 'optionen' in b ? (Array.isArray(b.optionen) ? b.optionen : []).map(o => txt(o, 200)).filter(Boolean) : null;
    if (optionen && (optionen.length < 2 || optionen.length > 20)) return { error: '2 bis 20 Antwortmöglichkeiten' };
    let endet = 'endet_at' in b ? (b.endet_at ? String(b.endet_at).replace('T', ' ').slice(0, 16) : null) : alt.endet_at ?? null;
    if ('dauer_stunden' in b && Number(b.dauer_stunden) > 0)
      endet = lokal(new Date(Date.now() + Math.min(Number(b.dauer_stunden), 8784) * 3_600_000)).slice(0, 16);
    if (endet && !ZEIT.test(endet)) return { error: 'Ende als JJJJ-MM-TT HH:MM' };
    return { data: { titel, beschreibung: 'beschreibung' in b ? txt(b.beschreibung, 2000) || null : alt.beschreibung ?? null,
      mehrfach: 'mehrfach' in b ? (b.mehrfach ? 1 : 0) : alt.mehrfach ?? 0,
      max_wahl: 'max_wahl' in b ? Math.min(Math.max(nr(b.max_wahl), 0), 20) : alt.max_wahl ?? 0,
      anonym: ANONYM.includes(b.anonym) ? b.anonym : alt.anonym ?? 'oeffentlich', endet_at: endet,
      ergebnis_live: 'ergebnis_live' in b ? (b.ergebnis_live ? 1 : 0) : alt.ergebnis_live ?? 1,
      ergebnis_fuer: ['alle', 'ich'].includes(b.ergebnis_fuer) ? b.ergebnis_fuer : alt.ergebnis_fuer ?? 'alle' }, optionen };
  }

  app.post('/api/abstimmungen', auth, bremse('abstimmung', 30), (req, res) => {
    const { data, optionen, error } = abstimmungEingabe(req.body ?? {});
    if (error) return res.status(400).json({ error });
    if (!optionen) return res.status(400).json({ error: '2 bis 20 Antwortmöglichkeiten' });
    const { lastInsertRowid } = db.prepare(`INSERT INTO abstimmungen(owner_id, titel, beschreibung, mehrfach, max_wahl, anonym, endet_at,
      ergebnis_live, ergebnis_fuer, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, data.titel, data.beschreibung,
      data.mehrfach, data.max_wahl, data.anonym, data.endet_at, data.ergebnis_live, data.ergebnis_fuer, jetzt());
    const ein = db.prepare('INSERT INTO abstimmung_optionen(abstimmung_id, text, sort) VALUES(?, ?, ?)');
    optionen.forEach((t, i) => ein.run(lastInsertRowid, t, i));
    res.status(201).json(abstimmungZeile(db.prepare('SELECT * FROM abstimmungen WHERE id = ?').get(lastInsertRowid), req.user.id, 'besitzer'));
  });

  app.get('/api/abstimmungen/:id', auth, (req, res) => {
    const z = abstimmungFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(abstimmungZeile(z.a, req.user.id, z.rolle));
  });

  app.patch('/api/abstimmungen/:id', auth, (req, res) => {
    const z = abstimmungFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    const { data, optionen, error } = abstimmungEingabe(req.body ?? {}, z.a);
    if (error) return res.status(400).json({ error });
    const hatStimmen = db.prepare('SELECT 1 FROM abstimmung_stimmen WHERE abstimmung_id = ? LIMIT 1').get(z.a.id);
    // Nach der ersten Stimme nur noch strenger, nie lockerer: wer anonym abgestimmt hat, darf nicht
    // nachtraeglich mit Namen dastehen - und ein "nur ich"-Ergebnis nicht auf einmal fuer alle.
    const STRENGE = { oeffentlich: 0, selbst: 1, anonym: 2 };
    if (hatStimmen && (STRENGE[data.anonym] < STRENGE[z.a.anonym] || (z.a.ergebnis_fuer === 'ich' && data.ergebnis_fuer !== 'ich')))
      return res.status(409).json({ error: 'Es wurde schon abgestimmt – Namen und Ergebnis lassen sich nur noch strenger stellen' });
    if (optionen) {
      const alt = db.prepare('SELECT * FROM abstimmung_optionen WHERE abstimmung_id = ? ORDER BY sort, id').all(z.a.id);
      const gleich = alt.length === optionen.length && alt.every((o, i) => o.text === optionen[i]);
      // Nach der ersten Stimme bleiben die Optionen stehen - sonst stimmte jemand fuer etwas, das es nicht mehr gibt.
      if (!gleich && hatStimmen) return res.status(409).json({ error: 'Es wurde schon abgestimmt – die Antworten bleiben, wie sie sind' });
      if (!gleich) {
        db.prepare('DELETE FROM abstimmung_optionen WHERE abstimmung_id = ?').run(z.a.id);
        const ein = db.prepare('INSERT INTO abstimmung_optionen(abstimmung_id, text, sort) VALUES(?, ?, ?)');
        optionen.forEach((t, i) => ein.run(z.a.id, t, i));
      }
    }
    db.prepare(`UPDATE abstimmungen SET titel = ?, beschreibung = ?, mehrfach = ?, max_wahl = ?, anonym = ?, endet_at = ?,
      ergebnis_live = ?, ergebnis_fuer = ? WHERE id = ?`).run(data.titel, data.beschreibung, data.mehrfach, data.max_wahl,
      data.anonym, data.endet_at, data.ergebnis_live, data.ergebnis_fuer, z.a.id);
    res.json(abstimmungZeile(db.prepare('SELECT * FROM abstimmungen WHERE id = ?').get(z.a.id), req.user.id, 'besitzer'));
  });

  app.delete('/api/abstimmungen/:id', auth, (req, res) => {
    const z = abstimmungFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    db.prepare('DELETE FROM abstimmungen WHERE id = ?').run(z.a.id);
    freigabeWeg('abstimmung', z.a.id);
    res.json({ ok: true });
  });

  // Schliessen ohne festes Ende: noch 24 Stunden - wer es gerade mitbekommt, kann noch abstimmen.
  // Mit festem Ende: sofort vorbei.
  app.post('/api/abstimmungen/:id/schliessen', auth, (req, res) => {
    const z = abstimmungFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    if (!z.a.endet_at) {
      const bis = lokal(new Date(Date.now() + 24 * 3_600_000));
      db.prepare('UPDATE abstimmungen SET endet_at = ?, schliessen_angefragt = 1 WHERE id = ?').run(bis, z.a.id);
    } else db.prepare('UPDATE abstimmungen SET endet_at = ?, schliessen_angefragt = 0 WHERE id = ?').run(jetzt(), z.a.id);
    res.json(abstimmungZeile(db.prepare('SELECT * FROM abstimmungen WHERE id = ?').get(z.a.id), req.user.id, 'besitzer'));
  });
  app.post('/api/abstimmungen/:id/oeffnen', auth, (req, res) => {
    const z = abstimmungFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    db.prepare('UPDATE abstimmungen SET endet_at = NULL, schliessen_angefragt = 0 WHERE id = ?').run(z.a.id);
    res.json(abstimmungZeile(db.prepare('SELECT * FROM abstimmungen WHERE id = ?').get(z.a.id), req.user.id, 'besitzer'));
  });

  // Abstimmen ersetzt die alte Stimme; ohne Optionen = Stimme zurueckziehen.
  app.post('/api/abstimmungen/:id/stimme', auth, bremse('stimme', 120), (req, res) => {
    const z = abstimmungFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!laeuft(z.a)) return res.status(403).json({ error: 'Die Abstimmung ist vorbei' });
    const gueltig = new Set(db.prepare('SELECT id FROM abstimmung_optionen WHERE abstimmung_id = ?').all(z.a.id).map(o => o.id));
    const wahl = [...new Set((Array.isArray(req.body?.optionen) ? req.body.optionen : []).map(nr))];
    if (wahl.some(o => !gueltig.has(o))) return res.status(400).json({ error: 'Unbekannte Antwort' });
    if (!z.a.mehrfach && wahl.length > 1) return res.status(400).json({ error: 'Nur eine Antwort' });
    if (z.a.mehrfach && z.a.max_wahl && wahl.length > z.a.max_wahl) return res.status(400).json({ error: `Höchstens ${z.a.max_wahl}` });
    db.prepare('DELETE FROM abstimmung_stimmen WHERE abstimmung_id = ? AND user_id = ?').run(z.a.id, req.user.id);
    const ein = db.prepare('INSERT INTO abstimmung_stimmen(abstimmung_id, user_id, option_id, name_zeigen) VALUES(?, ?, ?, ?)');
    for (const o of wahl) ein.run(z.a.id, req.user.id, o, req.body?.name_zeigen ? 1 : 0);
    res.json(abstimmungZeile(z.a, req.user.id, z.rolle));
  });

  // =============================================================================================
  // Umfragen
  // =============================================================================================

  const umfrageLaeuft = u => u.status === 'open' && (!u.endet_at || u.endet_at > jetzt());
  const umfrageStatus = u => (u.status === 'open' && !umfrageLaeuft(u) ? 'closed' : u.status);
  const umfrageFuer = (id, userId) => {
    const u = db.prepare('SELECT * FROM umfragen WHERE id = ?').get(nr(id));
    const rolle = u && rolleBei('umfrage', u.id, u.owner_id, userId);
    // Einen Entwurf sieht nur, wer ihn baut.
    if (!rolle || (u.status === 'draft' && rolle !== 'besitzer')) return null;
    return { u, rolle };
  };
  const fragenVon = id => db.prepare('SELECT * FROM umfrage_fragen WHERE umfrage_id = ? ORDER BY sort, id').all(id)
    .map(f => ({ id: f.id, abschnitt_id: f.abschnitt_id, typ: f.typ, text: f.text, pflicht: !!f.pflicht,
      config: (() => { try { return JSON.parse(f.config); } catch { return {}; } })() }));
  const abschnitteVon = id => db.prepare('SELECT id, titel FROM umfrage_abschnitte WHERE umfrage_id = ? ORDER BY sort, id').all(id);
  const anzahlAntworten = id => db.prepare('SELECT count(*) n FROM umfrage_antworten WHERE umfrage_id = ?').get(id).n;
  const lies = t => { try { return JSON.parse(entschluesseln(t)); } catch { return null; } };

  // Der Schluessel der eigenen Antwort haengt an einem Geheimnis JE NUTZER, nicht an der Nutzer-ID:
  // mit der ID koennte, wer die Datenbank (ein Backup) hat, alle IDs durchrechnen und jede anonyme
  // Antwort einer Person zuordnen. Das Geheimnis liegt verschluesselt - der Schluessel dazu steckt
  // nicht im Backup.
  function nutzerGeheim(me) {
    const r = db.prepare('SELECT umfrage_geheim FROM users WHERE id = ?').get(me);
    if (r?.umfrage_geheim) { try { return entschluesseln(r.umfrage_geheim); } catch { /* neu anlegen */ } }
    const g = randomBytes(24).toString('hex');
    db.prepare('UPDATE users SET umfrage_geheim = ? WHERE id = ?').run(verschluesseln(g), me);
    return g;
  }
  const schluesselFuer = (u, me) => `u:${hmac(`umfrage:${u.id}:${nutzerGeheim(me)}`)}`;
  const hatGeantwortet = (u, me) => !u.mehrfach
    && !!db.prepare('SELECT 1 FROM umfrage_antworten WHERE umfrage_id = ? AND schluessel = ?').get(u.id, schluesselFuer(u, me));
  function meineAntwort(u, schluessel) {
    if (u.mehrfach) return null;
    const a = db.prepare('SELECT * FROM umfrage_antworten WHERE umfrage_id = ? AND schluessel = ?').get(u.id, schluessel);
    return a ? { public_id: a.public_id, antworten: lies(a.antworten_enc) ?? {}, at: a.updated_at } : null;
  }

  function umfrageZeile(u, me, rolle, mitFragen = false) {
    const darfErgebnis = rolle === 'besitzer'
      || (u.ergebnis_fuer === 'teilnehmer' && (u.ergebnis_live || umfrageStatus(u) === 'closed'));
    return { id: u.id, titel: u.titel, beschreibung: u.beschreibung, status: umfrageStatus(u), laeuft: umfrageLaeuft(u),
      endet_at: u.endet_at, identitaet: u.identitaet, mehrfach: !!u.mehrfach, ergebnis_live: !!u.ergebnis_live,
      ergebnis_fuer: u.ergebnis_fuer, besitzer: personVon(u.owner_id), rolle, darf_ergebnis: darfErgebnis,
      gast_key: rolle === 'besitzer' ? u.gast_key : undefined, antworten: rolle === 'besitzer' ? anzahlAntworten(u.id) : undefined,
      ...(mitFragen && { abschnitte: abschnitteVon(u.id), fragen: fragenVon(u.id), meine: meineAntwort(u, schluesselFuer(u, me)) }) };
  }

  app.get('/api/umfragen', auth, (req, res) => {
    const me = req.user.id;
    const geteilt = geteiltMit('umfrage', me);
    const platz = geteilt.map(() => '?').join(',') || '0';
    res.json(db.prepare(`SELECT * FROM umfragen WHERE owner_id = ? OR (id IN (${platz}) AND status <> 'draft') ORDER BY id DESC`)
      .all(me, ...geteilt).map(u => {
        const rolle = rolleBei('umfrage', u.id, u.owner_id, me);
        return rolle && { ...umfrageZeile(u, me, rolle), beantwortet: hatGeantwortet(u, me) };
      }).filter(Boolean));
  });

  app.post('/api/umfragen', auth, bremse('umfrage', 30), (req, res) => {
    const titel = txt(req.body?.titel, 200);
    if (!titel) return res.status(400).json({ error: 'Titel nötig' });
    const { lastInsertRowid } = db.prepare('INSERT INTO umfragen(owner_id, titel, beschreibung, created_at, updated_at) VALUES(?, ?, ?, ?, ?)')
      .run(req.user.id, titel, txt(req.body?.beschreibung, 2000) || null, jetzt(), jetzt());
    res.status(201).json(umfrageZeile(db.prepare('SELECT * FROM umfragen WHERE id = ?').get(lastInsertRowid), req.user.id, 'besitzer', true));
  });

  app.get('/api/umfragen/:id', auth, (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(umfrageZeile(z.u, req.user.id, z.rolle, true));
  });

  const eigeneUmfrage = (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') { res.status(404).json({ error: 'Nicht gefunden' }); return null; }
    return z.u;
  };
  const neuLaden = (res, id, me, status = 200) =>
    res.status(status).json(umfrageZeile(db.prepare('SELECT * FROM umfragen WHERE id = ?').get(id), me, 'besitzer', true));

  app.patch('/api/umfragen/:id', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    const b = req.body ?? {};
    const titel = 'titel' in b ? txt(b.titel, 200) : u.titel;
    if (!titel) return res.status(400).json({ error: 'Titel nötig' });
    let endet = 'endet_at' in b ? (b.endet_at ? String(b.endet_at).replace('T', ' ').slice(0, 16) : null) : u.endet_at;
    if (endet && !ZEIT.test(endet)) return res.status(400).json({ error: 'Ende als JJJJ-MM-TT HH:MM' });
    let identitaet = u.identitaet;
    if (b.identitaet === 'anonym' || b.identitaet === 'mit_namen') identitaet = b.identitaet;
    // Anonym -> mit Namen nur ohne Antworten: wer anonym geantwortet hat, soll nicht nachtraeglich benannt werden.
    if (u.identitaet === 'anonym' && identitaet === 'mit_namen' && anzahlAntworten(u.id))
      return res.status(409).json({ error: 'Es gibt schon anonyme Antworten – die bleiben anonym' });
    // Mit Namen -> anonym: die Namen fliegen wirklich raus, nicht nur aus der Anzeige.
    if (u.identitaet === 'mit_namen' && identitaet === 'anonym')
      db.prepare('UPDATE umfrage_antworten SET user_id = NULL, gast_name_enc = NULL WHERE umfrage_id = ?').run(u.id);
    db.prepare(`UPDATE umfragen SET titel = ?, beschreibung = ?, endet_at = ?, identitaet = ?, mehrfach = ?, ergebnis_live = ?,
      ergebnis_fuer = ?, updated_at = ? WHERE id = ?`).run(titel, 'beschreibung' in b ? txt(b.beschreibung, 2000) || null : u.beschreibung,
      endet, identitaet, 'mehrfach' in b ? (b.mehrfach ? 1 : 0) : u.mehrfach, 'ergebnis_live' in b ? (b.ergebnis_live ? 1 : 0) : u.ergebnis_live,
      ['ich', 'teilnehmer'].includes(b.ergebnis_fuer) ? b.ergebnis_fuer : u.ergebnis_fuer, jetzt(), u.id);
    neuLaden(res, u.id, req.user.id);
  });

  app.delete('/api/umfragen/:id', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    db.prepare('DELETE FROM umfragen WHERE id = ?').run(u.id);
    freigabeWeg('umfrage', u.id);
    res.json({ ok: true });
  });

  app.post('/api/umfragen/:id/oeffnen', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    if (!db.prepare('SELECT 1 FROM umfrage_fragen WHERE umfrage_id = ? LIMIT 1').get(u.id))
      return res.status(400).json({ error: 'Erst mindestens eine Frage anlegen' });
    const warEntwurf = u.status === 'draft';
    // Wieder oeffnen einer abgelaufenen: das Ende faellt weg, sonst waere sie sofort wieder zu.
    const endet = u.endet_at && u.endet_at <= jetzt() ? null : u.endet_at;
    db.prepare("UPDATE umfragen SET status = 'open', endet_at = ?, updated_at = ? WHERE id = ?").run(endet, jetzt(), u.id);
    if (warEntwurf) for (const uid of publikum('umfrage', u.id, u.owner_id)) if (uid !== req.user.id)
      benachrichtige(uid, 'buero', `Neue Umfrage: ${u.titel}`, `von ${nameVon(req.user)}`, '/#buero');
    neuLaden(res, u.id, req.user.id);
  });
  app.post('/api/umfragen/:id/schliessen', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    db.prepare("UPDATE umfragen SET status = 'closed', updated_at = ? WHERE id = ?").run(jetzt(), u.id);
    neuLaden(res, u.id, req.user.id);
  });
  app.post('/api/umfragen/:id/zuruecksetzen', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    db.prepare('DELETE FROM umfrage_antworten WHERE umfrage_id = ?').run(u.id);
    neuLaden(res, u.id, req.user.id);
  });
  // Duplizieren: ein Entwurf mit denselben Abschnitten und Fragen, ohne Antworten und ohne Gast-Link.
  app.post('/api/umfragen/:id/duplizieren', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    const { lastInsertRowid: neu } = db.prepare(`INSERT INTO umfragen(owner_id, titel, beschreibung, identitaet, mehrfach, ergebnis_live,
      ergebnis_fuer, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, `${u.titel} (Kopie)`.slice(0, 200),
      u.beschreibung, u.identitaet, u.mehrfach, u.ergebnis_live, u.ergebnis_fuer, jetzt(), jetzt());
    const abschnitt = new Map();
    for (const a of db.prepare('SELECT * FROM umfrage_abschnitte WHERE umfrage_id = ?').all(u.id))
      abschnitt.set(a.id, db.prepare('INSERT INTO umfrage_abschnitte(umfrage_id, titel, sort) VALUES(?, ?, ?)').run(neu, a.titel, a.sort).lastInsertRowid);
    for (const f of db.prepare('SELECT * FROM umfrage_fragen WHERE umfrage_id = ?').all(u.id))
      db.prepare('INSERT INTO umfrage_fragen(umfrage_id, abschnitt_id, typ, text, pflicht, config, sort) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(neu, abschnitt.get(f.abschnitt_id) ?? null, f.typ, f.text, f.pflicht, f.config, f.sort);
    neuLaden(res, Number(neu), req.user.id, 201);
  });

  // Abschnitte
  app.post('/api/umfragen/:id/abschnitte', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    const titel = txt(req.body?.titel, 200);
    if (!titel) return res.status(400).json({ error: 'Titel nötig' });
    const sort = db.prepare('SELECT coalesce(max(sort), 0) + 1 s FROM umfrage_abschnitte WHERE umfrage_id = ?').get(u.id).s;
    db.prepare('INSERT INTO umfrage_abschnitte(umfrage_id, titel, sort) VALUES(?, ?, ?)').run(u.id, titel, sort);
    neuLaden(res, u.id, req.user.id, 201);
  });
  const eigenerAbschnitt = (req, res) => {
    const a = db.prepare('SELECT * FROM umfrage_abschnitte WHERE id = ?').get(nr(req.params.aid));
    const u = a && db.prepare('SELECT * FROM umfragen WHERE id = ? AND owner_id = ?').get(a.umfrage_id, req.user.id);
    if (!u) { res.status(404).json({ error: 'Nicht gefunden' }); return null; }
    return { a, u };
  };
  app.patch('/api/umfragen/abschnitte/:aid', auth, (req, res) => {
    const x = eigenerAbschnitt(req, res); if (!x) return;
    const titel = txt(req.body?.titel, 200);
    if (!titel) return res.status(400).json({ error: 'Titel nötig' });
    db.prepare('UPDATE umfrage_abschnitte SET titel = ? WHERE id = ?').run(titel, x.a.id);
    neuLaden(res, x.u.id, req.user.id);
  });
  // Einen Abschnitt loeschen behaelt seine Fragen - sie stehen danach ohne Abschnitt.
  app.delete('/api/umfragen/abschnitte/:aid', auth, (req, res) => {
    const x = eigenerAbschnitt(req, res); if (!x) return;
    db.prepare('DELETE FROM umfrage_abschnitte WHERE id = ?').run(x.a.id);
    neuLaden(res, x.u.id, req.user.id);
  });

  // Rauf/runter tauscht die Sortierung mit dem Nachbarn in derselben Liste.
  // Bei Fragen zaehlt der Abschnitt mit: ↑↓ tauscht mit dem Nachbarn im SELBEN Abschnitt - sonst
  // tauschte es mit einer Frage aus einem anderen, und sichtbar geschah nichts.
  function verschiebe(tabelle, zeile, filter, filterWert, richtung, abschnitt) {
    const mitAbschnitt = abschnitt !== undefined;
    const alle = db.prepare(`SELECT id, sort FROM ${tabelle} WHERE ${filter} IS ?${mitAbschnitt ? ' AND abschnitt_id IS ?' : ''} ORDER BY sort, id`)
      .all(...(mitAbschnitt ? [filterWert, abschnitt] : [filterWert]));
    const setze = db.prepare(`UPDATE ${tabelle} SET sort = ? WHERE id = ?`);
    transaktion(() => {
      alle.forEach((z, i) => setze.run(i, z.id));
      const i = alle.findIndex(z => z.id === zeile.id), j = i + (richtung < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= alle.length) return;
      setze.run(j, alle[i].id);
      setze.run(i, alle[j].id);
    });
  }
  app.post('/api/umfragen/abschnitte/:aid/verschieben', auth, (req, res) => {
    const x = eigenerAbschnitt(req, res); if (!x) return;
    verschiebe('umfrage_abschnitte', x.a, 'umfrage_id', x.u.id, nr(req.body?.richtung));
    neuLaden(res, x.u.id, req.user.id);
  });

  // Fragen
  const abschnittOk = (u, id) => id == null || id === '' ? null
    : db.prepare('SELECT id FROM umfrage_abschnitte WHERE id = ? AND umfrage_id = ?').get(nr(id), u.id)?.id ?? false;
  app.post('/api/umfragen/:id/fragen', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    const f = frageSaeubern(req.body);
    if (f.fehler) return res.status(400).json({ error: f.fehler });
    const abschnitt = abschnittOk(u, req.body?.abschnitt_id);
    if (abschnitt === false) return res.status(404).json({ error: 'Abschnitt nicht gefunden' });
    if (db.prepare('SELECT count(*) n FROM umfrage_fragen WHERE umfrage_id = ?').get(u.id).n >= 200)
      return res.status(400).json({ error: 'Höchstens 200 Fragen' });
    const sort = db.prepare('SELECT coalesce(max(sort), 0) + 1 s FROM umfrage_fragen WHERE umfrage_id = ?').get(u.id).s;
    db.prepare('INSERT INTO umfrage_fragen(umfrage_id, abschnitt_id, typ, text, pflicht, config, sort) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(u.id, abschnitt, f.typ, f.text, f.pflicht ? 1 : 0, JSON.stringify(f.config), sort);
    neuLaden(res, u.id, req.user.id, 201);
  });
  const eigeneFrage = (req, res) => {
    const f = db.prepare('SELECT * FROM umfrage_fragen WHERE id = ?').get(nr(req.params.fid));
    const u = f && db.prepare('SELECT * FROM umfragen WHERE id = ? AND owner_id = ?').get(f.umfrage_id, req.user.id);
    if (!u) { res.status(404).json({ error: 'Nicht gefunden' }); return null; }
    return { f: { ...f, config: JSON.parse(f.config || '{}') }, u };
  };
  app.patch('/api/umfragen/fragen/:fid', auth, (req, res) => {
    const x = eigeneFrage(req, res); if (!x) return;
    const neu = frageSaeubern({ typ: x.f.typ, text: x.f.text, pflicht: !!x.f.pflicht, config: x.f.config, ...req.body });
    if (neu.fehler) return res.status(400).json({ error: neu.fehler });
    if (anzahlAntworten(x.u.id) && !aenderungErlaubt(x.f, neu))
      return res.status(409).json({ error: 'Es gibt schon Antworten: Typ, entfernte Optionen und Grenzen bleiben, wie sie sind. Erst zurücksetzen.' });
    const abschnitt = 'abschnitt_id' in (req.body ?? {}) ? abschnittOk(x.u, req.body.abschnitt_id) : x.f.abschnitt_id;
    if (abschnitt === false) return res.status(404).json({ error: 'Abschnitt nicht gefunden' });
    db.prepare('UPDATE umfrage_fragen SET typ = ?, text = ?, pflicht = ?, config = ?, abschnitt_id = ? WHERE id = ?')
      .run(neu.typ, neu.text, neu.pflicht ? 1 : 0, JSON.stringify(neu.config), abschnitt, x.f.id);
    neuLaden(res, x.u.id, req.user.id);
  });
  app.delete('/api/umfragen/fragen/:fid', auth, (req, res) => {
    const x = eigeneFrage(req, res); if (!x) return;
    if (anzahlAntworten(x.u.id)) return res.status(409).json({ error: 'Es gibt schon Antworten – erst zurücksetzen' });
    db.prepare('DELETE FROM umfrage_fragen WHERE id = ?').run(x.f.id);
    neuLaden(res, x.u.id, req.user.id);
  });
  app.post('/api/umfragen/fragen/:fid/verschieben', auth, (req, res) => {
    const x = eigeneFrage(req, res); if (!x) return;
    verschiebe('umfrage_fragen', x.f, 'umfrage_id', x.u.id, nr(req.body?.richtung), x.f.abschnitt_id ?? null);
    neuLaden(res, x.u.id, req.user.id);
  });
  app.post('/api/umfragen/fragen/:fid/duplizieren', auth, (req, res) => {
    const x = eigeneFrage(req, res); if (!x) return;
    db.prepare('INSERT INTO umfrage_fragen(umfrage_id, abschnitt_id, typ, text, pflicht, config, sort) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(x.u.id, x.f.abschnitt_id, x.f.typ, `${x.f.text} (Kopie)`.slice(0, 500), x.f.pflicht, JSON.stringify(x.f.config), x.f.sort);
    neuLaden(res, x.u.id, req.user.id, 201);
  });

  // Gast-Link: einmal erzeugt bleibt er, bis man ihn ausdruecklich erneuert - sonst waeren
  // verteilte Links auf einmal tot.
  app.post('/api/umfragen/:id/gastlink', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    const key = !u.gast_key || req.body?.erneuern ? randomBytes(12).toString('base64url') : u.gast_key;
    db.prepare('UPDATE umfragen SET gast_key = ? WHERE id = ?').run(key, u.id);
    res.json({ gast_key: key });
  });
  app.delete('/api/umfragen/:id/gastlink', auth, (req, res) => {
    const u = eigeneUmfrage(req, res); if (!u) return;
    db.prepare('UPDATE umfragen SET gast_key = NULL WHERE id = ?').run(u.id);
    res.json({ gast_key: null });
  });

  // --- Antworten (angemeldet und Gast) ---
  const publicId = () => 'TN-' + randomBytes(4).toString('base64url').replace(/[-_]/g, 'X').slice(0, 5).toUpperCase();

  /** Eine Antwort speichern. `schluessel` = wer (gehasht), `userId` nur bei "mit Namen". */
  function antwortSpeichern(u, roh, schluessel, { userId = null, gastName = null } = {}) {
    if (!umfrageLaeuft(u)) return { status: 403, error: 'Die Umfrage ist nicht offen' };
    const { antworten, fehler } = pruefeAntworten(fragenVon(u.id), roh);
    if (fehler) return { status: 400, error: fehler };
    const enc = verschluesseln(JSON.stringify(antworten));
    const name = u.identitaet === 'mit_namen' && gastName ? verschluesseln(txt(gastName, 80)) : null;
    const uid = u.identitaet === 'mit_namen' ? userId : null;
    if (u.mehrfach) {
      // Jede Teilnahme fuer sich - eigener Zufallsschluessel, nicht bearbeitbar.
      db.prepare(`INSERT INTO umfrage_antworten(umfrage_id, schluessel, public_id, user_id, gast_name_enc, antworten_enc, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(u.id, `m:${randomBytes(12).toString('hex')}`, publicId(), uid, name, enc, jetzt(), jetzt());
      return { ok: true };
    }
    db.prepare(`INSERT INTO umfrage_antworten(umfrage_id, schluessel, public_id, user_id, gast_name_enc, antworten_enc, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(umfrage_id, schluessel) DO UPDATE SET antworten_enc = excluded.antworten_enc,
      gast_name_enc = coalesce(excluded.gast_name_enc, gast_name_enc), updated_at = excluded.updated_at`)
      .run(u.id, schluessel, publicId(), uid, name, enc, jetzt(), jetzt());
    return { ok: true };
  }

  app.post('/api/umfragen/:id/antwort', auth, bremse('umfrage-antwort', 60), (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    const r = antwortSpeichern(z.u, req.body?.antworten, schluesselFuer(z.u, req.user.id), { userId: req.user.id });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(umfrageZeile(z.u, req.user.id, z.rolle, true));
  });
  app.delete('/api/umfragen/:id/antwort', auth, (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!umfrageLaeuft(z.u)) return res.status(403).json({ error: 'Die Umfrage ist nicht offen' });
    db.prepare('DELETE FROM umfrage_antworten WHERE umfrage_id = ? AND schluessel = ?').run(z.u.id, schluesselFuer(z.u, req.user.id));
    res.json(umfrageZeile(z.u, req.user.id, z.rolle, true));
  });

  // Das Ergebnis: Antworten ohne Identitaet - gerechnet wird im Browser. Namen nur fuer den
  // Besitzer und nur bei Umfragen "mit Namen".
  app.get('/api/umfragen/:id/ergebnis', auth, (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    const zeile = umfrageZeile(z.u, req.user.id, z.rolle, true);
    if (!zeile.darf_ergebnis) return res.status(403).json({ error: 'Das Ergebnis ist noch nicht sichtbar' });
    res.json({ umfrage: zeile, ...ergebnisDaten(z) });
  });

  /**
   * Die Antworten fuer die Auswertung. Anonym heisst auch: keine Zeilen-ID, keine Uhrzeit, keine
   * Reihenfolge - sonst liesse sich ueber "wer hat um 10:03 geantwortet" doch zuordnen, wer was sagte.
   */
  function ergebnisDaten(z) {
    const mitNamen = z.rolle === 'besitzer' && z.u.identitaet === 'mit_namen';
    const gastName = a => { try { return `${entschluesseln(a.gast_name_enc)} (Gast)`; } catch { return 'Gast'; } };
    const zeilen = db.prepare(`SELECT * FROM umfrage_antworten WHERE umfrage_id = ? ORDER BY ${mitNamen ? 'id' : 'random()'}`).all(z.u.id);
    const antworten = zeilen.map(a => ({
      public_id: a.public_id, antworten: lies(a.antworten_enc) ?? {},
      ...(mitNamen && { zeit: a.updated_at, name: a.user_id ? nameVon(nutzer(a.user_id) ?? { username: '?' }) : a.gast_name_enc ? gastName(a) : 'Gast' }) }));
    return { antworten, mit_namen: mitNamen };
  }

  // Die CSV als Datei vom Server - ein blob:-Download geht in der Android-App nicht.
  app.get('/api/umfragen/:id/csv', auth, (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!umfrageZeile(z.u, req.user.id, z.rolle).darf_ergebnis) return res.status(403).json({ error: 'Das Ergebnis ist noch nicht sichtbar' });
    const { antworten, mit_namen } = ergebnisDaten(z);
    res.set('Cache-Control', 'no-store').type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="umfrage-${z.u.id}.csv"`)
      .send('\ufeff' + csv(fragenVon(z.u.id), antworten, mit_namen));
  });

  // Eine einzelne Antwort loeschen (Besitzer) - ueber die oeffentliche Kennung, nicht die Zeilen-ID.
  app.delete('/api/umfragen/:id/antworten/:pid', auth, (req, res) => {
    const z = umfrageFuer(req.params.id, req.user.id);
    if (!z || z.rolle !== 'besitzer') return res.status(404).json({ error: 'Nicht gefunden' });
    const r = db.prepare('DELETE FROM umfrage_antworten WHERE umfrage_id = ? AND public_id = ?').run(z.u.id, String(req.params.pid));
    if (!r.changes) return res.status(404).json({ error: 'Antwort nicht gefunden' });
    res.json({ ok: true });
  });

  // --- Gaeste: ohne Konto, nur mit Link. Die Kennung des Gastes (Zufall im localStorage) kommt im
  // Kopf x-gast und wird nur gehasht gespeichert - wer sie kennt, koennte sonst die Antwort aendern.
  const gastUmfrage = (req, res) => {
    const u = db.prepare('SELECT * FROM umfragen WHERE gast_key = ?').get(String(req.params.key ?? ''));
    if (!u || u.status === 'draft') { res.status(404).json({ error: 'Diese Umfrage gibt es nicht (mehr)' }); return null; }
    return u;
  };
  const gastSchluessel = (u, req) => {
    const g = String(req.get('x-gast') ?? '');
    return /^[A-Za-z0-9_-]{16,64}$/.test(g) ? `g:${hmac(`gast:${u.id}:${g}`)}` : null;
  };
  app.get('/api/gast/umfragen/:key', gastBremse('gast-umfrage', 60), (req, res) => {
    const u = gastUmfrage(req, res); if (!u) return;
    const schl = gastSchluessel(u, req);
    res.json({ titel: u.titel, beschreibung: u.beschreibung, status: umfrageStatus(u), laeuft: umfrageLaeuft(u),
      endet_at: u.endet_at, identitaet: u.identitaet, mehrfach: !!u.mehrfach,
      abschnitte: abschnitteVon(u.id), fragen: fragenVon(u.id), meine: schl ? meineAntwort(u, schl) : null });
  });
  app.post('/api/gast/umfragen/:key', gastBremse('gast-antwort', 20), (req, res) => {
    const u = gastUmfrage(req, res); if (!u) return;
    const schl = gastSchluessel(u, req);
    if (!schl) return res.status(400).json({ error: 'Gast-Kennung fehlt' });
    const r = antwortSpeichern(u, req.body?.antworten, schl, { gastName: req.body?.name });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, meine: meineAntwort(u, schl) });
  });
  app.delete('/api/gast/umfragen/:key', gastBremse('gast-antwort', 20), (req, res) => {
    const u = gastUmfrage(req, res); if (!u) return;
    const schl = gastSchluessel(u, req);
    if (!schl) return res.status(400).json({ error: 'Gast-Kennung fehlt' });
    if (!umfrageLaeuft(u)) return res.status(403).json({ error: 'Die Umfrage ist nicht offen' });
    db.prepare('DELETE FROM umfrage_antworten WHERE umfrage_id = ? AND schluessel = ?').run(u.id, schl);
    res.json({ ok: true });
  });
}
