import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

// DB gehoert bei einem Deploy-Ziel ausserhalb von install_dir (ein Overwrite-Deploy leert das
// Verzeichnis) - deshalb ueber DB= setzbar und das Zielverzeichnis notfalls selbst anlegen.
export const dbFile = process.env.DB ?? 'stundenplan.db';
if (dbFile !== ':memory:' && dirname(dbFile) !== '.') mkdirSync(dirname(dbFile), { recursive: true });

// Eine laufende SQLite-Datei laesst sich nicht gefahrlos unter dem Prozess austauschen. Eine
// hochgeladene Sicherung wird deshalb nur als .incoming abgelegt und hier beim Start eingesetzt -
// die bisherige Datei bleibt als .vorher liegen, falls die Sicherung doch nicht taugt.
if (dbFile !== ':memory:' && existsSync(`${dbFile}.incoming`)) {
  if (existsSync(dbFile)) {
    rmSync(`${dbFile}.vorher`, { force: true });
    renameSync(dbFile, `${dbFile}.vorher`);
  }
  // Das WAL der alten Datei zieht mit um - bliebe es liegen, spielte SQLite es in die neue ein.
  for (const t of ['-wal', '-shm']) {
    rmSync(`${dbFile}.vorher${t}`, { force: true });
    if (existsSync(`${dbFile}${t}`)) renameSync(`${dbFile}${t}`, `${dbFile}.vorher${t}`);
  }
  renameSync(`${dbFile}.incoming`, dbFile);
  console.warn(`! Sicherung eingespielt. Die vorherige Datenbank liegt als ${dbFile}.vorher daneben.`);
}

export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys = ON');
// WAL: Lesen wartet nicht mehr auf Schreiben, und ein Schreibzugriff kostet kein fsync je Zeile.
// NORMAL reicht mit WAL - nach einem Absturz fehlt hoechstens die letzte Transaktion, kaputt geht nichts.
if (dbFile !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');

/** fn in einer Transaktion - ein COMMIT statt einem je Zeile. Verschachtelt laeuft fn einfach mit. */
export function transaktion(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// node:sqlite merkt sich keine vorbereiteten Anfragen - in heissen Pfaden (jede Anfrage) einmal
// vorbereiten und wiederverwenden. Nur fuer feste SQL-Texte, sonst waechst die Map.
const vorbereitet = new Map();
export const sql = text => vorbereitet.get(text) ?? vorbereitet.set(text, db.prepare(text)).get(text);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  username     TEXT COLLATE NOCASE UNIQUE NOT NULL,
  pw           TEXT NOT NULL,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  color        TEXT,
  emoji        TEXT,
  avatar       TEXT,
  banner       TEXT,
  created_at   TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Die eingestellte Schule ist die Vorgabe (users.school_id IS NULL); wer woanders zur Schule geht,
-- meldet sich ueber sein Profil mit seiner eigenen an. Gefuellt wird die Zeile weiter unten.
CREATE TABLE IF NOT EXISTS schools (
  id         INTEGER PRIMARY KEY,
  -- Woher der Plan dieser Schule kommt: 'untis' oder 'iserv'. Eine IServ-Schule ist eine EIGENE
  -- Schule, auch wenn nebenan dieselbe ueber WebUntis haengt: Raster, Kurse und Ferien passen
  -- nicht zusammen, und eine Kurs-ID aus IServ kann eine Untis-Kursnummer nie treffen.
  quelle     TEXT NOT NULL DEFAULT 'untis',
  server     TEXT NOT NULL,          -- hektor.webuntis.com, bei IServ die Schuladresse
  school     TEXT NOT NULL,          -- der Anmeldename der Schule bei WebUntis (bei IServ leer)
  name       TEXT NOT NULL,          -- Anzeigename aus der Schulsuche
  standard   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- Der Schluessel kommt ohne 'quelle' aus: ein WebUntis-Server heisst immer *.webuntis.com, eine
  -- IServ-Adresse nie. Zwei Zeilen mit derselben Adresse kann es also gar nicht geben.
  UNIQUE(server, school)
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS days (
  id   INTEGER PRIMARY KEY,
  iso  INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS periods (
  id         INTEGER PRIMARY KEY,
  -- Das Raster gehoert zur Schule: eine zweite Schule klingelt zu anderen Zeiten, und die
  -- 1. Stunde gibt es dann zweimal. Bestehende Datenbanken werden weiter unten umgebaut.
  school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  nr         INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  UNIQUE(school_id, nr)
);
CREATE TABLE IF NOT EXISTS subjects (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE UNIQUE NOT NULL, short TEXT);
CREATE TABLE IF NOT EXISTS rooms    (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE UNIQUE NOT NULL);
-- Kein Raum am Kurs: derselbe Kurs kann an verschiedenen Tagen in verschiedenen Raeumen sein,
-- deshalb haengt der Raum am einzelnen Stundenplan-Eintrag.
CREATE TABLE IF NOT EXISTS courses (
  id         TEXT COLLATE NOCASE PRIMARY KEY,
  title      TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status  TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS entries (
  user_id   INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  day_id    INTEGER NOT NULL REFERENCES days(id)     ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES periods(id)  ON DELETE CASCADE,
  course_id TEXT    NOT NULL REFERENCES courses(id)  ON UPDATE CASCADE ON DELETE CASCADE,
  room_id   INTEGER          REFERENCES rooms(id)    ON DELETE SET NULL,
  PRIMARY KEY (user_id, day_id, period_id)
);
CREATE TABLE IF NOT EXISTS absences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);
-- Hausaufgaben haengen am Kurs, nicht am einzelnen Stundenplan-Eintrag: sie gelten fuer alle im
-- Kurs, egal an welchem Tag der Einzelne die Stunde hat.
CREATE TABLE IF NOT EXISTS homework (
  id         INTEGER PRIMARY KEY,
  course_id  TEXT    NOT NULL REFERENCES courses(id) ON UPDATE CASCADE ON DELETE CASCADE,
  due_date   TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  user_id    INTEGER          REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS homework_done (
  homework_id INTEGER NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (homework_id, user_id)
);
CREATE INDEX IF NOT EXISTS hw_faellig ON homework(course_id, due_date);
-- to_id ist leer, wenn die Nachricht an eine Gruppe geht (dann steht group_id).
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      INTEGER          REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS msg_paar ON messages(from_id, to_id, id);
-- WebUntis: Zugangsdaten je Nutzer und die abgeglichenen Stunden. Anders als entries sind die
-- datumsbezogen - nur so lassen sich Vertretung und Ausfall an einem einzelnen Tag abbilden.
CREATE TABLE IF NOT EXISTS untis_accounts (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username    TEXT NOT NULL,
  secret      TEXT NOT NULL,
  person_id   INTEGER,
  person_type INTEGER,
  last_sync   TEXT,
  last_error  TEXT
);
CREATE TABLE IF NOT EXISTS untis_lessons (
  user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  date      TEXT    NOT NULL,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  course_id TEXT             REFERENCES courses(id) ON UPDATE CASCADE ON DELETE SET NULL,
  room      TEXT,
  status    TEXT    NOT NULL DEFAULT 'regular',
  info      TEXT,
  PRIMARY KEY (user_id, date, period_id)
);
CREATE INDEX IF NOT EXISTS untis_datum ON untis_lessons(user_id, date);
-- Notizen haengen am Wochentags-Slot, nicht am Eintrag: kommt der Plan aus WebUntis, gibt es
-- keinen entries-Satz, an dem eine Notiz haengen koennte.
-- Eigener Name und eigene Farbe je Kurs. Rein persoenlich: "G2_DE" heisst bei der Schule so, und
-- wer es lieber "Deutsch GK" nennt, soll das tun koennen, ohne es allen anderen umzustellen.
-- Ein Abo je Geraet. endpoint ist der Schluessel: derselbe Browser meldet sich nach einem
-- Neustart mit demselben an, und abgelaufene raeumen wir beim Zustellen weg.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
-- Der Text steht hier, nicht im Push: geschickt wird nur ein Anstupsen, den Inhalt holt der
-- Service Worker angemeldet ab. Beim Ende-zu-Ende-Chat kennt der Server ihn ohnehin nicht.
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  url          TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS notif_offen ON notifications(user_id, delivered_at);
-- Ferien und Feiertage aus WebUntis. Schulweit, deshalb ohne user_id: wer abgleicht, holt sie
-- fuer alle. Ohne sie sieht eine Ferienwoche aus wie eine, deren Plan noch fehlt.
-- Von Lehrern in WebUntis eingetragene Hausaufgaben. Schreibgeschuetzt: sie gehoeren der Schule,
-- nicht uns. Bei jedem Abgleich fuer den geholten Zeitraum ersetzt.
-- Persoenliche ToDos mit Erinnerung. Rein privat - niemand sonst sieht sie, auch kein Admin.
CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  due_at      TEXT,                       -- 'JJJJ-MM-TT HH:MM', leer = ohne Frist
  remind_min  INTEGER NOT NULL DEFAULT 0,-- Vorlauf in Minuten, 0 = zur Faelligkeit
  done        INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,                      -- gesetzt, sobald erinnert wurde: genau einmal
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_faellig ON todos(user_id, due_at);
CREATE TABLE IF NOT EXISTS untis_homework (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  untis_id  INTEGER NOT NULL,
  course_id TEXT             REFERENCES courses(id) ON UPDATE CASCADE ON DELETE SET NULL,
  date      TEXT NOT NULL,
  due_date  TEXT NOT NULL,
  text      TEXT NOT NULL,
  remark    TEXT,
  PRIMARY KEY (user_id, untis_id)
);
CREATE INDEX IF NOT EXISTS untis_hw_faellig ON untis_homework(user_id, due_date);
-- Eigene Tabelle statt negativer IDs in homework_done: dort haengt ein Fremdschluessel auf
-- homework(id), und eine Zeile ohne Gegenstueck kaeme gar nicht erst hinein.
CREATE TABLE IF NOT EXISTS untis_homework_done (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  untis_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, untis_id)
);
CREATE TABLE IF NOT EXISTS holidays (
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  von  TEXT NOT NULL,
  bis  TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (school_id, von, bis)
);
CREATE TABLE IF NOT EXISTS course_prefs (
  user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  course_id TEXT    NOT NULL REFERENCES courses(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name      TEXT,
  color     TEXT,
  PRIMARY KEY (user_id, course_id)
);
CREATE TABLE IF NOT EXISTS notes (
  user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  day_id    INTEGER NOT NULL REFERENCES days(id)    ON DELETE CASCADE,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  text      TEXT    NOT NULL,
  PRIMARY KEY (user_id, day_id, period_id)
);
`);

// CREATE TABLE IF NOT EXISTS ruehrt bestehende Tabellen nicht an - neue Spalten muessen an schon
// existierenden DBs nachgezogen werden. created_at bekommt bewusst kein DEFAULT (datetime('now')):
// SQLite lehnt nicht-konstante Defaults bei ADD COLUMN ab.
const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const addColumn = (table, name, def) => {
  if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
};

for (const [name, def] of [
  ['display_name', 'TEXT'], ['color', 'TEXT'], ['emoji', 'TEXT'], ['avatar', 'TEXT'], ['banner', 'TEXT'], ['created_at', 'TEXT'],
]) addColumn('users', name, def);

addColumn('entries', 'room_id', 'INTEGER REFERENCES rooms(id) ON DELETE SET NULL');
addColumn('subjects', 'short', 'TEXT'); // Kuerzel fuers Fach, fuer die kompakte Ansicht
addColumn('entries', 'note', 'TEXT');  // persoenliche Notiz zur einzelnen Stunde
// Ende-zu-Ende-Chat: der oeffentliche Schluessel steht offen, der private liegt nur mit dem
// eigenen Passwort verschlossen hier. Der Server kann damit nichts anfangen - genau das ist der
// Zweck. Alte Nachrichten bleiben im Klartext (messages.enc = 0) und weiter lesbar.
// Sitzungstokens liegen jetzt gehasht (64 Hex-Zeichen). Was noch im Klartext dasteht, passt zu
// keinem Cookie mehr - alle muessen sich einmal neu anmelden, und die toten Zeilen fliegen raus.
db.exec("DELETE FROM sessions WHERE length(token) <> 64 OR token GLOB '*[^0-9a-f]*'");

// Eigenes Kuerzel je Kurs - das steht in der kompakten Ansicht, und "G2" ist dort nicht
// hilfreicher als "DE".
// Eine Hausaufgabe haengt nicht nur am Kurs, sondern am Slot. Grund: zwei Jahrgaenge koennen
// sich eine Kurs-ID teilen (WebUntis liefert nicht immer eine Kursnummer), und dann sah der
// 13er die Hausaufgaben des 12ers. Tag und Stunde trennen sie.
// NULL heisst "alte Zeile ohne Slot" - die bleibt fuer alle Kursteilnehmer sichtbar.
addColumn('homework', 'day_id', 'INTEGER REFERENCES days(id) ON DELETE SET NULL');
addColumn('homework', 'period_id', 'INTEGER REFERENCES periods(id) ON DELETE SET NULL');

addColumn('course_prefs', 'short', 'TEXT');

// Hausaufgaben von vor der Slot-Pruefung haben weder Tag noch Stunde. "Kein Slot" hiess bisher
// "fuer alle im Kurs sichtbar" - und genau darueber liefen die Hausaufgaben zweier Jahrgaenge
// weiter ineinander, die sich eine Kurs-ID teilen. Deshalb einmalig nachtragen.
//
// Zwei Stufen, absichtlich in dieser Reihenfolge:
//   1. der Plan des Verfassers - er weiss am besten, welche Stunde er gemeint hat;
//   2. die Plaene aller anderen, aber nur wenn es dort GENAU EINE Stelle gibt. Zwei Jahrgaenge
//      liefern zwei, und dann ist Raten schlimmer als Offenlassen.
// Was danach offen bleibt, sieht nur noch der Verfasser (siehe homeworkFuer in index.js).
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'hw_slots'").get()) {
  const slots = `
    SELECT course_id, day_id, period_id, user_id FROM entries
    UNION
    SELECT u.course_id, d.id AS day_id, u.period_id, u.user_id
    FROM untis_lessons u
    JOIN days d ON d.iso = CAST(strftime('%u', u.date) AS INTEGER)
    WHERE u.course_id IS NOT NULL`;

  // Stufe 1: beim Verfasser selbst, frueheste Stelle der Woche.
  db.exec(`
    UPDATE homework SET
      day_id = (SELECT s.day_id FROM (${slots}) s
                JOIN days d ON d.id = s.day_id JOIN periods p ON p.id = s.period_id
                WHERE s.user_id = homework.user_id AND s.course_id = homework.course_id
                ORDER BY d.iso, p.nr LIMIT 1),
      period_id = (SELECT s.period_id FROM (${slots}) s
                   JOIN days d ON d.id = s.day_id JOIN periods p ON p.id = s.period_id
                   WHERE s.user_id = homework.user_id AND s.course_id = homework.course_id
                   ORDER BY d.iso, p.nr LIMIT 1)
    WHERE day_id IS NULL OR period_id IS NULL`);

  // Stufe 2: bei allen anderen - aber nur, wenn die Stelle eindeutig ist.
  db.exec(`
    UPDATE homework SET
      day_id = (SELECT min(s.day_id) FROM (${slots}) s WHERE s.course_id = homework.course_id),
      period_id = (SELECT min(s.period_id) FROM (${slots}) s WHERE s.course_id = homework.course_id)
    WHERE (day_id IS NULL OR period_id IS NULL)
      AND (SELECT count(*) FROM (SELECT DISTINCT day_id, period_id FROM (${slots}) s2
             WHERE s2.course_id = homework.course_id)) = 1`);

  db.prepare("INSERT INTO settings(key, value) VALUES('hw_slots', '1')").run();
  const offen = db.prepare('SELECT count(*) AS n FROM homework WHERE day_id IS NULL').get().n;
  if (offen) console.warn(`! ${offen} Hausaufgabe(n) liessen sich keiner Stunde zuordnen - `
    + 'sie sind jetzt nur noch fuer ihre Verfasser sichtbar.');
}

addColumn('users', 'pub_key', 'TEXT');
addColumn('users', 'priv_key_enc', 'TEXT');
addColumn('messages', 'enc', 'INTEGER NOT NULL DEFAULT 0');

addColumn('users', 'push_chat', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'push_ausfall', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'push_vertretung', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'push_freunde', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'push_todo', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'push_aenderung', 'INTEGER NOT NULL DEFAULT 1');
// Der Hinweis auf Lehrstoff und Notizen ist standardmaessig AUS: an manchen Schulen steht an
// nahezu jeder Stunde etwas, und dann markiert das Symbol nichts mehr, sondern rauscht nur.
addColumn('users', 'zeige_info', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'nav_order', 'TEXT'); // eigene Reihenfolge der Menuepunkte, kommagetrennt
addColumn('users', 'jetzt_stil', 'TEXT'); // 'zeit' | 'linie' | 'tag' - Aussehen des Live-Cursors
addColumn('users', 'nav_style', 'TEXT'); // 'icons' fuer eine Navigation aus Symbolen, sonst Text

// 'secret' = Schluessel aus der Untis-App (TOTP), sonst das Schulpasswort.
// Datenschutz: was der WebUntis-Abgleich anlegt, gehoert nicht in die Admin-Listen und nicht in
// die Kursauswahl anderer. Wer einen solchen Kurs im Plan haben will, holt ihn ueber seinen
// eigenen Abgleich - er verraet sonst, wer welchen Kurs belegt.
// rooms ist mit dabei, obwohl der Abgleich dort nichts anlegt (Untis-Raeume stehen als Freitext
// in untis_lessons.room) - die Stammdaten-Routen laufen in einer Schleife ueber alle drei
// Tabellen, und eine Ausnahme waere genau die Sorte Sonderfall, die spaeter jemand uebersieht.
for (const t of ['subjects', 'teachers', 'rooms', 'courses'])
  addColumn(t, 'from_untis', 'INTEGER NOT NULL DEFAULT 0');

// Nachtraeglich fuer alles, was vor dieser Spalte importiert wurde. Kurse sind an der ID
// erkennbar; Faecher und Lehrer gelten als importiert, wenn sie an keinem eigenen Kurs haengen.
// (getSetting steht weiter unten - hier direkt abfragen, sonst Zugriff vor der Definition.)
const nachgetragen = db.prepare("SELECT 1 FROM settings WHERE key = 'untis_herkunft'").get();
if (!nachgetragen) {
  db.exec("UPDATE courses SET from_untis = 1 WHERE id LIKE 'UNTIS-%'");
  for (const [tab, spalte] of [['subjects', 'subject_id'], ['teachers', 'teacher_id']])
    db.exec(`UPDATE ${tab} SET from_untis = 1 WHERE id IN (
               SELECT ${spalte} FROM courses WHERE from_untis = 1 AND ${spalte} IS NOT NULL)
             AND id NOT IN (
               SELECT ${spalte} FROM courses WHERE from_untis = 0 AND ${spalte} IS NOT NULL)`);
  db.prepare("INSERT INTO settings(key, value) VALUES('untis_herkunft', '1')").run();
}

// Ein eigener Eintrag mit Vorrang schlaegt WebUntis. Weil entries am Wochentag haengt und nicht
// am Datum, gilt die Korrektur damit fuer jede Woche - genau das ist der Zweck.
addColumn('entries', 'vorrang', 'INTEGER NOT NULL DEFAULT 0');

addColumn('untis_accounts', 'auth_typ', 'TEXT');
// Welcher Zeitraum bereits abgeglichen ist - danach entscheidet die Plan-Route, ob sie fuer eine
// weit entfernte Woche nachladen muss.
addColumn('untis_accounts', 'von', 'TEXT');
addColumn('untis_accounts', 'bis', 'TEXT');
// Wann zuletzt der ganze Zeitraum geholt wurde - der laeuft seltener als der kurze Abgleich.
addColumn('untis_accounts', 'last_voll', 'TEXT');
// Wann der letzte Versuch schiefging. Ohne das wuerde ein Konto mit falschem Passwort alle zehn
// Minuten einen Fehlversuch bei der Schule ausloesen - und WebUntis sperrt Konten nach zu vielen.
addColumn('untis_accounts', 'last_error_at', 'TEXT');
// Wie viele Stunden beim letzten Abgleich welchen Text mitgebracht haben. Reine Diagnose, aber
// eine, die eine ganze Rueckfragerunde spart: steht dort dauerhaft "Lehrstoff 0", weiss man ohne
// Raten, dass die Schule das Feld nicht herausgibt.
addColumn('untis_accounts', 'text_stat', 'TEXT');


// Kurs-IDs auf eine Schreibweise ziehen.
//
// `courses.id` ist COLLATE NOCASE, die Kindspalten sind BINARY. Wo beide auseinandergelaufen sind,
// stand der Kurs zwar in der Auswahlliste (NOCASE-Vergleich), wurde aber beim Eintragen einer
// Hausaufgabe abgelehnt (BINARY-Vergleich): "Du hast diesen Kurs nicht im Stundenplan", obwohl er
// im Plan steht. Der Fremdschluessel schlaegt dabei nie an, weil er mit der Collation des Elterns
// prueft - deshalb faellt es nirgends auf.
export function kursIdsGeradeziehen() {
  let geaendert = 0;
  for (const tabelle of ['entries', 'untis_lessons', 'homework', 'untis_homework', 'course_prefs']) {
    // `COLLATE BINARY` ist hier der Kern: ohne es nimmt der Vergleich die Collation des LINKEN
    // Operanden - und `c.id` ist NOCASE. "UNTIS-EK" und "untis-ek" gaelten dann als gleich, und
    // die Migration haette nie etwas gefunden.
    const abweichend = `course_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM courses c
      WHERE c.id = ${tabelle}.course_id AND c.id COLLATE BINARY <> ${tabelle}.course_id)`;
    // course_prefs hat (user_id, course_id) als Primaerschluessel: liegen Einstellungen unter
    // beiden Schreibweisen vor, kollidiert das Update. Dann gewinnt die kanonische Zeile, die
    // andere faellt in der zweiten Anweisung weg.
    geaendert += db.prepare(`UPDATE OR IGNORE ${tabelle}
      SET course_id = (SELECT c.id FROM courses c WHERE c.id = ${tabelle}.course_id)
      WHERE ${abweichend}`).run().changes;
    db.prepare(`DELETE FROM ${tabelle} WHERE ${abweichend}`).run();
  }
  return geaendert;
}
kursIdsGeradeziehen();
// Was der Lehrer in die Stunde geschrieben hat (Lehrstoff, Notizen) - mehrzeilig und getrennt vom
// kurzen Vertretungstext, damit die Struktur beim Anzeigen erhalten bleibt.
addColumn('untis_lessons', 'lesson_text', 'TEXT');
// Der Lehrer DIESER Stunde, nicht der des Kurses. Bei einer Vertretung sind das zwei verschiedene:
// am Kurs steht bewusst der, der ihn regulaer haelt - und im Plan soll trotzdem stehen, wer
// tatsaechlich davorsteht. Ohne diese Spalte zeigte eine Vertretung den falschen Namen.
addColumn('untis_lessons', 'teacher', 'TEXT');
// Der urspruengliche Raum bei einer Raumaenderung. NULL = kein Wechsel, '' = gewechselt ohne
// bekannte Herkunft. Ohne diese Spalte stand der neue Raum zwar da, aber nichts sagte, dass er
// neu ist - man merkte es erst vor der falschen Tuer.
addColumn('untis_lessons', 'room_regulaer', 'TEXT');
// Der Lehrstoff getrennt vom uebrigen Text: er kommt je Stunde und nur stuendlich, der Rest
// alle zehn Minuten. Laege er im selben Feld, wuerde jeder Zwischenlauf ihn wieder loeschen.
addColumn('untis_lessons', 'lehrstoff', 'TEXT');
// Der Vergleichsstand ALLER Stunden des Slots (JSON je Kurs) - die Spalten oben halten nur die
// angezeigte. Ohne ihn wurde Kurs A mit Kurs B verglichen, oder ein paralleler Kurs gar nicht.
addColumn('untis_lessons', 'stand', 'TEXT');
addColumn('untis_accounts', 'lehrstoff_geholt', 'TEXT');
// Welche einmalige Nachricht dieser Nutzer schon weggeklickt hat - gespeichert wird der
// Zeitstempel des Textes. Aendert der Admin sie, ist es eine neue Nachricht und sie erscheint
// wieder; sonst nie mehr.
addColumn('users', 'hinweis_gesehen', 'TEXT');

// Tickets. Der Inhalt liegt bei VNW - hier steht nur, WEM welches Ticket gehoert und wie viele
// Antworten er davon schon gelesen hat.
//
// `view_token` ist der Schluessel zum Ticket bei VNW: wer ihn hat, darf lesen UND hineinschreiben.
// Er verlaesst den Server deshalb nie; der Browser kennt nur die Nummer dieser Zeile.
db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Beide leer heisst: ein Ticket, das in der App bleibt (seit 3.1.0, ohne VNW).
  vnw_id     INTEGER,
  view_token TEXT,
  title      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open',
  antworten  INTEGER NOT NULL DEFAULT 0,
  gesehen    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);
-- Anhaenge im Chat: Bild oder Datei, verschluesselt wie die Nachricht selbst.
--
-- Getrennt von messages, weil eine Datei tausendmal so gross ist wie eine Nachricht: laege sie
-- in messages.text, laedt jede Verlaufsabfrage sie mit. So holt der Browser nur, was er wirklich
-- anzeigt. Name und Typ stehen NICHT hier, sondern verschluesselt im Nachrichtentext - der Server
-- soll nicht wissen, dass jemand "Abi-Zulassung.pdf" verschickt hat.
CREATE TABLE IF NOT EXISTS chat_files (
  id         INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  bytes      INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_files_msg ON chat_files(message_id);

-- Gruppenchats. Die Nachrichten liegen in derselben Tabelle wie die Einzelchats (messages mit
-- group_id) - ein zweiter Nachrichtenspeicher waere doppelte Logik fuer Anhaenge, Umfragen und
-- das Aufraeumen.
CREATE TABLE IF NOT EXISTS chat_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL
);
-- key_enc ist der Gruppenschluessel, mit dem Paar-Geheimnis dieses Mitglieds verpackt. Der Server
-- kann damit nichts anfangen - er verwahrt ihn nur, wie den privaten Schluessel im Einzelchat.
CREATE TABLE IF NOT EXISTS group_members (
  group_id       INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  rolle          TEXT    NOT NULL DEFAULT 'mitglied',
  status         TEXT    NOT NULL DEFAULT 'eingeladen',
  key_enc        TEXT,
  eingeladen_von INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id, status);

-- Stimmen zu einer Umfrage. Der Server kennt nur die NUMMER der Antwort - was sie bedeutet, steht
-- verschluesselt im Nachrichtentext. Ein Schluessel je Person und Nachricht: umentscheiden ersetzt
-- die Stimme, statt eine zweite zu zaehlen.
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  wahl       INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- ToDo-Ordner. Geteilt heisst gemeinsam: wer den Ordner hat, sieht und aendert die ToDos darin,
-- und das Abhaken gilt fuer alle. Bei Hausaufgaben ist es umgekehrt (dort hakt jeder fuer sich
-- ab) - eine Hausaufgabe macht jeder selbst, eine Einkaufsliste nicht.
CREATE TABLE IF NOT EXISTS todo_ordner (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS todo_ordner_geteilt (
  ordner_id INTEGER NOT NULL REFERENCES todo_ordner(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  PRIMARY KEY (ordner_id, user_id)
);`);

// Gruppennachricht: to_id bleibt dann leer.
/**
 * `messages.to_id` war NOT NULL - eine Gruppennachricht hat aber kein Gegenueber.
 *
 * SQLite kann eine Spalte nicht nachtraeglich nullable machen; die Tabelle wird deshalb einmal
 * umgebaut. Passiert genau einmal und nur dort, wo die alte Form noch steht.
 */
if (db.prepare("SELECT count(*) AS n FROM pragma_table_info('messages') WHERE name = 'to_id' AND \"notnull\" = 1").get().n) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE messages_neu (
      id         INTEGER PRIMARY KEY,
      from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id      INTEGER          REFERENCES users(id) ON DELETE CASCADE,
      text       TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      read_at    TEXT,
      enc        INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO messages_neu(id, from_id, to_id, text, created_at, read_at, enc)
      SELECT id, from_id, to_id, text, created_at, read_at, enc FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_neu RENAME TO messages;
    CREATE INDEX IF NOT EXISTS msg_paar ON messages(from_id, to_id, id);`);
  db.exec('PRAGMA foreign_keys = ON');
  console.warn('! messages.to_id ist jetzt optional (Gruppennachrichten).');
}

addColumn('messages', 'group_id', 'INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE');
// Anzahl der Antwortmoeglichkeiten einer Umfrage (0 = keine). Mehr braucht der Server nicht, um
// eine Stimme zu pruefen - der Text der Antworten geht ihn nichts an.
addColumn('messages', 'umfrage_n', 'INTEGER NOT NULL DEFAULT 0');
addColumn('todos', 'ordner_id', 'INTEGER REFERENCES todo_ordner(id) ON DELETE CASCADE');

// Wann diese Meldung hinausgehen soll. NULL = sofort (so war es immer). Alles andere wartet in
// der Tabelle, bis der Zehn-Minuten-Takt sie faellig findet - damit werden aus Benachrichtigungen
// planbare Erinnerungen: "30 Minuten vor Stundenbeginn" oder "alles gesammelt um 19 Uhr".
addColumn('notifications', 'faellig_at', 'TEXT');
addColumn('notifications', 'gesammelt', 'INTEGER NOT NULL DEFAULT 0');
// Worauf sich eine wartende Meldung bezieht, z.B. 'hw:42'. Damit laesst sie sich wiederfinden,
// wenn jemand seine Erinnerung zu genau dieser Hausaufgabe aendert oder abschaltet.
addColumn('notifications', 'ref', 'TEXT');
// Je Art ein eigener Plan, als JSON. Die alten Ein/Aus-Schalter (push_chat ...) bleiben stehen und
// dienen als Rueckfall, solange hier nichts steht - so verliert niemand seine Einstellung.
addColumn('users', 'push_plan', 'TEXT');
addColumn('users', 'digest_zeit', "TEXT NOT NULL DEFAULT '19:00'");
// Voreinstellung fuer die persoenliche Erinnerung an eine neue Hausaufgabe, in Minuten vor der
// Faelligkeit (0 = keine). Das Formular fuellt sein Feld damit vor - eingestellt wird es je
// Hausaufgabe, denn "einen Tag vorher" passt fuer ein Referat, nicht fuer drei Vokabeln.
addColumn('users', 'hw_erinnerung_min', 'INTEGER NOT NULL DEFAULT 0');
// Die Art der Meldung (Bug-Report, Vorschlag, ...). Der Name statt der ID: er soll in der Liste
// stehen, ohne dass dafuer jemand bei VNW nachfragen muss. Aufgefrischt wird er beim Abgleich.
addColumn('tickets', 'type_name', 'TEXT');

// Der Admin-Schalter fuer WebUntis ist weggefallen: eingerichtet ist, sobald eine Schule
// hinterlegt ist - die setzt der erste Nutzer mit einer erfolgreichen Anmeldung selbst.
db.exec("DELETE FROM settings WHERE key = 'untis_enabled'");

// Notizen sind von entries in eine eigene Tabelle gewandert. Bestand einmalig uebernehmen; die
// Bedingung "Spalte existiert noch" macht den Block von selbst einmalig.
if (columns('entries').includes('note')) {
  db.exec(`INSERT OR IGNORE INTO notes(user_id, day_id, period_id, text)
           SELECT user_id, day_id, period_id, note FROM entries WHERE note IS NOT NULL AND note <> ''`);
  db.exec('ALTER TABLE entries DROP COLUMN note');
}

// Der Raum ist vom Kurs an den Eintrag gewandert. Bestehende Zuordnungen einmalig uebernehmen,
// damit niemandem sein Raum verloren geht - danach faellt die alte Spalte weg (und damit auch
// die Bedingung, die diesen Block ein zweites Mal ausloesen wuerde).
if (columns('courses').includes('room_id')) {
  db.exec(`UPDATE entries SET room_id = (SELECT c.room_id FROM courses c WHERE c.id = entries.course_id)
           WHERE room_id IS NULL`);
  db.exec('ALTER TABLE courses DROP COLUMN room_id');
}

// scrypt laeuft absichtlich asynchron: synchron blockiert es den einzigen Thread, und eine
// Handvoll gleichzeitiger Anmeldeversuche legte damit die ganze App lahm. Im Threadpool tut es
// das nicht. Die Laenge des Passworts ist in index.js gedeckelt.
export const scryptAsync = (pw, salt) => new Promise((ok, weg) =>
  scrypt(pw, salt, 32, (err, key) => (err ? weg(err) : ok(key))));

export async function hash(pw) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await scryptAsync(pw, salt)).toString('hex');
}

export async function verify(pw, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const a = Buffer.from(key, 'hex');
  const b = await scryptAsync(pw, salt);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const getSetting = (k, d = null) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;

export const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  .run(k, String(v));

// Break-Glass fuer ausgesperrte Instanzen: ADMIN_RESET_PW setzt beim Start das Passwort des
// admin-Users (oder des in ADMIN_RESET_USER genannten) neu und stellt dessen Adminrechte her.
// ADMIN_PW greift nur beim allerersten Start - ohne diesen Weg gaebe es ohne Shell auf dem Server
// kein Zurueck. Wer Env-Vars setzen kann, kontrolliert die Instanz ohnehin.
const resetPw = process.env.ADMIN_RESET_PW?.trim();
if (resetPw) {
  const name = process.env.ADMIN_RESET_USER?.trim() || 'admin';
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (row) {
    db.prepare('UPDATE users SET pw = ?, is_admin = 1 WHERE id = ?').run(await hash(resetPw), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    // Mit dem eigenen Passwort verschluesselte Zugangsdaten sind mit dem alten Passwort verloren.
    db.prepare("DELETE FROM untis_accounts WHERE user_id = ? AND secret LIKE 'u1:%'").run(row.id);
    console.warn(`! ADMIN_RESET_PW: Passwort von "${name}" neu gesetzt, Adminrechte wiederhergestellt.`);
  } else {
    db.prepare("INSERT INTO users(username, pw, is_admin, created_at) VALUES(?, ?, 1, datetime('now'))")
      .run(name, await hash(resetPw));
    console.warn(`! ADMIN_RESET_PW: Admin "${name}" neu angelegt.`);
  }
  console.warn('! Jetzt einloggen, die Variable wieder entfernen und die App neu starten.');
}

// Die Freistunde ist als Kurs abgebildet. Dadurch greifen die Erkennung gemeinsamer Stunden, die
// Zelle und die Detailansicht ohne Sonderfall - zwei Leute mit Freistunde im selben Slot sind
// automatisch "gemeinsam". Die ID ist reserviert und taucht in der Oberflaeche nie auf.
export const FREI = '__frei__';
db.prepare("INSERT OR IGNORE INTO courses(id, title) VALUES(?, 'Freistunde')").run(FREI);

// Eine von Hand entfernte WebUntis-Stunde. Technisch ein Eintrag wie jeder andere - nur wird die
// Zelle leer gezeichnet. Ohne so einen Platzhalter gaebe es keine Moeglichkeit, "hier soll nichts
// stehen" auszudruecken: ein geloeschter Eintrag hiesse nur, dass WebUntis wieder gewinnt.
export const WEG = '__weg__';
db.prepare("INSERT OR IGNORE INTO courses(id, title) VALUES(?, 'Entfernt')").run(WEG);

// --- Mehrere Schulen ---------------------------------------------------------
// Bisher stand die Schule global in zwei Einstellungen (untis_server / untis_school). Jetzt ist
// sie eine Zeile, und jeder Nutzer zeigt darauf - die eingestellte bleibt die Vorgabe, denn
// users.school_id IS NULL heisst "die Standardschule". Deshalb muss kein Bestandskonto angefasst
// werden.
// Es gibt immer genau eine Standardschule - auch auf einer Instanz ganz ohne WebUntis. Sonst
// haetten Stundenraster und Ferien nichts, woran sie haengen koennen.
if (!db.prepare('SELECT 1 FROM schools WHERE standard = 1').get()) {
  const server = getSetting('untis_server', ''), kuerzel = getSetting('untis_school', '');
  db.prepare(`INSERT INTO schools(server, school, name, standard, created_at)
              VALUES(?, ?, ?, 1, datetime('now'))`)
    .run(server, kuerzel, kuerzel || 'Meine Schule');
}
export const standardSchule = () => db.prepare('SELECT * FROM schools WHERE standard = 1').get();
const standardId = standardSchule().id;

// periods.nr war instanzweit eindeutig - mit einer zweiten Schule gibt es die 1. Stunde zweimal.
// SQLite kann eine UNIQUE-Bedingung nicht aendern, also einmal umbauen. Die IDs bleiben, damit
// alles, was auf periods(id) zeigt (entries, notes, homework, untis_lessons), stehen bleibt.
if (!columns('periods').includes('school_id')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE periods_neu (
      id         INTEGER PRIMARY KEY,
      school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      nr         INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time   TEXT NOT NULL,
      UNIQUE(school_id, nr)
    );
    INSERT INTO periods_neu(id, school_id, nr, start_time, end_time)
      SELECT id, ${standardId}, nr, start_time, end_time FROM periods;
    DROP TABLE periods;
    ALTER TABLE periods_neu RENAME TO periods;`);
  db.exec('PRAGMA foreign_keys = ON');
  console.warn('! Stundenraster gehoert jetzt zu einer Schule.');
}

// Ferien sind schulweit, nicht instanzweit: sonst leert die zweite Schule den Plan der ersten.
if (!columns('holidays').includes('school_id')) {
  db.exec(`
    CREATE TABLE holidays_neu (
      school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      von  TEXT NOT NULL,
      bis  TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (school_id, von, bis)
    );
    INSERT INTO holidays_neu(school_id, von, bis, name)
      SELECT ${standardId}, von, bis, name FROM holidays;
    DROP TABLE holidays;
    ALTER TABLE holidays_neu RENAME TO holidays;`);
}

addColumn('schools', 'quelle', "TEXT NOT NULL DEFAULT 'untis'");
// Wo bei dieser IServ-Schule der Stundenplan steht. Was einmal geklappt hat, wird gemerkt - sonst
// probierte jeder Abgleich alle Pfade der Reihe nach durch.
addColumn('schools', 'iserv_pfad', 'TEXT');
// Der Nachrichten-Feed der Schule: von der Heute-Seite gemeldet oder vom Admin eingetragen, und
// wann zuletzt geholt wurde (hoechstens stuendlich).
addColumn('schools', 'rss_url', 'TEXT');
addColumn('schools', 'nachrichten_geholt', 'TEXT');
// Der Gebaeudeplan (JSON, siehe public/raumplan.js) - erst nur fuer Admins, bis er freigegeben ist.
addColumn('schools', 'raumplan', 'TEXT');
addColumn('schools', 'raumplan_frei', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'school_id', 'INTEGER REFERENCES schools(id) ON DELETE SET NULL');
// Nur damit die Kursauswahl nicht mit den Kursen fremder Schulen zuwaechst. NULL heisst hier
// "gehoert ueberall hin" - genau das sind die beiden Platzhalter Freistunde und Entfernt.
addColumn('courses', 'school_id', 'INTEGER REFERENCES schools(id) ON DELETE SET NULL');
db.prepare('UPDATE courses SET school_id = ? WHERE school_id IS NULL AND id NOT IN (?, ?)')
  .run(standardId, FREI, WEG);

// "Wer hat auch frei" in der Ausfall-Meldung mitschicken. Standardmaessig aus: es nennt Namen.
addColumn('users', 'frei_hinweis', 'INTEGER NOT NULL DEFAULT 0');

// --- Kalender ------------------------------------------------------------------
// Termine, Pruefungen und abonnierte Kalender liegen in denselben zwei Tabellen: eine Pruefung ist
// ein Termin mit anderer Art, ein Abo ein Kalender mit einer URL. Ein Sonderweg je Sorte waere
// dreimal dieselbe Abfrage.
db.exec(`
CREATE TABLE IF NOT EXISTS kalender (
  id           INTEGER PRIMARY KEY,
  -- NULL heisst: schulweit. Den legt der Admin an, sehen alle, aendern darf ihn nur er.
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  farbe        TEXT,                                  -- #rrggbb
  quelle       TEXT    NOT NULL DEFAULT 'eigen',      -- 'eigen'|'abo'|'schule'|'untis'
  ical_url     TEXT,                                  -- nur bei 'abo'
  letzter_sync TEXT,
  sync_fehler  TEXT,
  sichtbar     INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS kalender_eintraege (
  id          INTEGER PRIMARY KEY,
  kalender_id INTEGER NOT NULL REFERENCES kalender(id) ON DELETE CASCADE,
  -- Aus dem Abo uebernommen; von Hand angelegte Termine haben keine. Genau daran erkennt der
  -- Abgleich, was er ersetzen darf und was ihm nicht gehoert.
  uid         TEXT,
  titel       TEXT    NOT NULL,
  ort         TEXT,
  text        TEXT,
  von         TEXT    NOT NULL,   -- 'JJJJ-MM-TT HH:MM', bei ganztags 'JJJJ-MM-TT'
  bis         TEXT,
  ganztags    INTEGER NOT NULL DEFAULT 0,
  art         TEXT    NOT NULL DEFAULT 'termin',   -- 'termin' | 'pruefung'
  -- Nur bei Pruefungen: woran sie haengt und welche Schulstunden sie belegt. Damit markiert der
  -- Plan alle betroffenen Zellen, nicht nur eine.
  course_id   TEXT    REFERENCES courses(id) ON UPDATE CASCADE ON DELETE SET NULL,
  von_stunde  INTEGER,
  bis_stunde  INTEGER,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS kal_zeit ON kalender_eintraege(kalender_id, von);
-- Teilen wie ueberall in der App: mit Freunden, wahlweise nur lesen.
CREATE TABLE IF NOT EXISTS kalender_geteilt (
  kalender_id  INTEGER NOT NULL REFERENCES kalender(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  darf_aendern INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kalender_id, user_id)
);

-- Nachrichten der Schule: "Nachrichten zum Tag" aus WebUntis und der RSS-Feed. Schulweit - einer
-- holt sie, alle der Schule sehen sie. Was der Feed vergisst, bleibt hier stehen.
CREATE TABLE IF NOT EXISTS nachrichten (
  id         INTEGER PRIMARY KEY,
  school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  quelle     TEXT    NOT NULL,          -- 'untis' | 'rss'
  ext_id     TEXT    NOT NULL,          -- messagesOfDay.id bzw. guid/link
  datum      TEXT    NOT NULL,
  titel      TEXT    NOT NULL,
  text       TEXT,
  link       TEXT,
  created_at TEXT    NOT NULL,
  UNIQUE(school_id, quelle, ext_id)
);
CREATE INDEX IF NOT EXISTS nachrichten_schule ON nachrichten(school_id, datum);

-- --- Buero: aus der ToDo-Liste wird ein Board --------------------------------
-- Projekt (todo_ordner) -> Bereich -> Spalte -> Aufgabe. Der Bereich ist eine Etage ueber den
-- Spalten; ohne ihn stehen die Spalten einfach nebeneinander.
CREATE TABLE IF NOT EXISTS todo_bereiche (
  id        INTEGER PRIMARY KEY,
  ordner_id INTEGER NOT NULL REFERENCES todo_ordner(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS todo_spalten (
  id         INTEGER PRIMARY KEY,
  ordner_id  INTEGER NOT NULL REFERENCES todo_ordner(id)   ON DELETE CASCADE,
  bereich_id INTEGER          REFERENCES todo_bereiche(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0
);
`);

/**
 * ToDos ohne Frist.
 *
 * Eine Kanban-Aufgabe hat oft keinen Termin - `due_at` war aber NOT NULL. SQLite kann das nicht
 * nachtraeglich lockern, also einmal umbauen; die IDs bleiben, damit nichts verwaist.
 */
if (db.prepare("SELECT count(*) AS n FROM pragma_table_info('todos') WHERE name = 'due_at' AND \"notnull\" = 1").get().n) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE todos_neu (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text        TEXT    NOT NULL,
      due_at      TEXT,
      remind_min  INTEGER NOT NULL DEFAULT 0,
      done        INTEGER NOT NULL DEFAULT 0,
      notified_at TEXT,
      created_at  TEXT    NOT NULL,
      ordner_id   INTEGER REFERENCES todo_ordner(id) ON DELETE CASCADE
    );
    INSERT INTO todos_neu(id, user_id, text, due_at, remind_min, done, notified_at, created_at, ordner_id)
      SELECT id, user_id, text, due_at, remind_min, done, notified_at, created_at, ordner_id FROM todos;
    DROP TABLE todos;
    ALTER TABLE todos_neu RENAME TO todos;
    CREATE INDEX IF NOT EXISTS todo_faellig ON todos(user_id, due_at);`);
  db.exec('PRAGMA foreign_keys = ON');
  console.warn('! ToDos duerfen jetzt ohne Frist stehen.');
}

// Das Projekt: verschachtelbar, mit Regel fuer erledigte Aufgaben.
addColumn('todo_ordner', 'parent_id', 'INTEGER REFERENCES todo_ordner(id) ON DELETE SET NULL');
addColumn('todo_ordner', 'ist_ordner', 'INTEGER NOT NULL DEFAULT 0');
addColumn('todo_ordner', 'fertig_regel', "TEXT NOT NULL DEFAULT 'nichts'"); // nichts|verschieben|loeschen
addColumn('todo_ordner', 'fertig_spalte_id', 'INTEGER');
// Freigabe: nur lesen oder mitschreiben, wahlweise auch fuer die Unterprojekte.
addColumn('todo_ordner_geteilt', 'darf_aendern', 'INTEGER NOT NULL DEFAULT 1');
addColumn('todo_ordner_geteilt', 'rekursiv', 'INTEGER NOT NULL DEFAULT 1');
// Die Aufgabe im Board.
addColumn('todos', 'spalte_id', 'INTEGER REFERENCES todo_spalten(id) ON DELETE SET NULL');
addColumn('todos', 'zustaendig_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('todos', 'wiederholung', 'INTEGER NOT NULL DEFAULT 0');
addColumn('todos', 'wiederholung_einheit', 'TEXT');   // tag|woche|monat
// Geparkt: die Aufgabe gibt es, sie taucht aber erst ab diesem Zeitpunkt im Board auf.
addColumn('todos', 'sichtbar_ab', 'TEXT');
addColumn('todos', 'prioritaet', 'INTEGER NOT NULL DEFAULT 0');
addColumn('todos', 'sort', 'INTEGER NOT NULL DEFAULT 0');

// Stundenweise Abmeldung: NULL heisst weiterhin "ganzer Tag".
addColumn('absences', 'von_stunde', 'INTEGER');
addColumn('absences', 'bis_stunde', 'INTEGER');
// Der Grund - Vorgabe nur fuer einen selbst; mit Haken sehen ihn die Freunde.
addColumn('absences', 'grund', 'TEXT');
addColumn('absences', 'grund_sichtbar', 'INTEGER NOT NULL DEFAULT 0');

// Der geheime Link, mit dem ein Handy den Kalender abonniert.
addColumn('users', 'ics_token', 'TEXT');
// Zaehlt der Reiter die offenen Hausaufgaben?
addColumn('users', 'hw_badge', 'INTEGER NOT NULL DEFAULT 1');
// Nach wie vielen Tagen Ueberfaelliges von selbst verschwindet; 0 = nie.
addColumn('users', 'hw_loeschen_tage', 'INTEGER NOT NULL DEFAULT 7');
// Die Farben der Ebenen im Kalender, als JSON - wie push_plan.
addColumn('users', 'kalender_farben', 'TEXT');
// Die Farben fuer Ausfall, Vertretung, Vertretung ohne Lehrer und Raumaenderung - jeder fuer sich,
// wie die Kursfarben. Und die Darstellung des Plans: Standard oder wie WebUntis.
addColumn('users', 'status_farben', 'TEXT');
addColumn('users', 'plan_stil', 'TEXT');
// Vor Pruefungen erinnern: so viele Tage vorher, 0 = nie. Je Pruefung ueberschreibbar.
addColumn('users', 'pruefung_vorlauf_tage', 'INTEGER NOT NULL DEFAULT 7');
// Erledigte Hausaufgaben im Plan weiter zeigen (ausgegraut)? Vorgabe: nein.
addColumn('users', 'hw_erledigt_zeigen', 'INTEGER NOT NULL DEFAULT 0');
// Fenster und Meldungen: Klick auf den Hintergrund schliesst (Vorgabe ja), Meldungen bleiben so
// viele Sekunden stehen, Fehler bleiben, bis man sie wegklickt (Vorgabe ja).
addColumn('users', 'dialog_hintergrund', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'toast_sekunden', 'INTEGER NOT NULL DEFAULT 3');
addColumn('users', 'toast_fehler_bleibt', 'INTEGER NOT NULL DEFAULT 1');
// Das eigene Menue (JSON: Seiten und Gruppen, siehe index.js) - NULL = die Vorgabe.
addColumn('users', 'menue', 'TEXT');
// Die hoechste Schul-Nachricht (nachrichten.id), die der Nutzer schon gesehen hat: neuere kommen
// beim Oeffnen einmal als Fenster. NULL = noch nie geoeffnet, dann wird still aufgeholt.
addColumn('users', 'nachrichten_gesehen', 'INTEGER');
// Erledigte ToDos nach so vielen Tagen von selbst loeschen (0 = nie); dafuer merkt sich jedes ToDo,
// wann es abgehakt wurde.
addColumn('users', 'todo_loeschen_tage', 'INTEGER NOT NULL DEFAULT 30');
addColumn('todos', 'done_at', 'TEXT');
// 'modern' (Vorgabe, NULL) oder 'klassisch'.
addColumn('users', 'design', 'TEXT');
// Zeitstempel des letzten Bildwechsels (Avatar/Banner): steht als ?v= in der Bild-Adresse, damit
// der Browser das Bild ewig cachen darf und ein neues trotzdem sofort sieht.
addColumn('users', 'bild_v', 'INTEGER');
// Die Stunden im Plan: 'eckig' (Vorgabe, NULL) oder 'rund' - unabhaengig vom Design.
addColumn('users', 'stunden_form', 'TEXT');
// Zufallsgeheimnis je Nutzer fuer den Schluessel anonymer Umfrage-Antworten (verschluesselt,
// buero.js) - nie ausgeliefert.
addColumn('users', 'umfrage_geheim', 'TEXT');
// Kurschat: die Nachricht haengt am Kurs und an den Stunden, in denen der Absender ihn beim Senden
// hatte ("tag|stunde,..."). Sichtbar ist sie fuer alle, die den Kurs in einer dieser Stunden haben
// - so trennt der Chat zwei Jahrgaenge mit derselben Kurs-ID. Der Text liegt serverseitig
// verschluesselt (untis.js verschluesseln), nicht Ende-zu-Ende.
addColumn('messages', 'kurs_id', 'TEXT');
addColumn('messages', 'kurs_slots', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS kurschat_gelesen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kurs_id TEXT    NOT NULL,
  bis_id  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kurs_id)
);
CREATE TABLE IF NOT EXISTS kurschat_stumm (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kurs_id TEXT    NOT NULL,
  PRIMARY KEY (user_id, kurs_id)
);`);
// Eine Pruefung fuer den ganzen Kurs (sehen alle, die den Kurs in dieser Stunde haben) und ihre
// eigene Erinnerung (NULL = wie im Profil, 0 = keine).
addColumn('kalender_eintraege', 'fuer_kurs', 'INTEGER NOT NULL DEFAULT 0');
addColumn('kalender_eintraege', 'erinnerung_tage', 'INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS pruefung_erinnert (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eintrag_id INTEGER NOT NULL REFERENCES kalender_eintraege(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, eintrag_id)
)`);

db.exec(`
-- --- Buero: Notizen, Ideenbaum, Abstimmungen, Umfragen ---
-- Wer darf mit? Eine Zeile je Freund (wer = 'u:<id>') oder Kurs (wer = 'k:<kurs>'). Besitzer
-- stehen nicht hier, die stehen am Ding selbst. \`wer\` statt zweier NULL-Spalten im UNIQUE:
-- SQLite haelt zwei NULLs fuer verschieden, und dann gaebe es jede Freigabe doppelt.
CREATE TABLE IF NOT EXISTS buero_freigabe (
  id        INTEGER PRIMARY KEY,
  art       TEXT    NOT NULL,          -- notiz | notiz_ordner | idee | abstimmung | umfrage
  ding_id   INTEGER NOT NULL,
  wer       TEXT    NOT NULL,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  course_id TEXT,
  rolle     TEXT    NOT NULL DEFAULT 'member',  -- notiz: lesen|aendern, idee: member|team
  UNIQUE(art, ding_id, wer)
);
CREATE INDEX IF NOT EXISTS buero_freigabe_user ON buero_freigabe(user_id);

CREATE TABLE IF NOT EXISTS notiz_ordner (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES notiz_ordner(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL,
  farbe      TEXT,
  created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS notizen (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordner_id  INTEGER REFERENCES notiz_ordner(id) ON DELETE SET NULL,
  titel      TEXT    NOT NULL DEFAULT '',
  inhalt     TEXT    NOT NULL DEFAULT '',
  farbe      TEXT,
  tags       TEXT    NOT NULL DEFAULT '[]',
  angeheftet INTEGER NOT NULL DEFAULT 0,
  archiviert INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS notiz_todos (
  id       INTEGER PRIMARY KEY,
  notiz_id INTEGER NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
  text     TEXT    NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notiz_kommentare (
  id         INTEGER PRIMARY KEY,
  notiz_id   INTEGER NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ideen_boards (
  id           INTEGER PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  beschreibung TEXT,
  modus        TEXT    NOT NULL DEFAULT 'moderated',   -- open | moderated | strict
  gesperrt     INTEGER NOT NULL DEFAULT 0,
  archiviert   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ideen_knoten (
  id               INTEGER PRIMARY KEY,
  board_id         INTEGER NOT NULL REFERENCES ideen_boards(id) ON DELETE CASCADE,
  parent_id        INTEGER REFERENCES ideen_knoten(id) ON DELETE CASCADE,
  art              TEXT    NOT NULL DEFAULT 'idea',     -- heading | idea | todo
  titel            TEXT    NOT NULL,
  text             TEXT,
  von_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'approved', -- approved | pending
  braucht_freigabe INTEGER,                              -- NULL erbt, 1 immer, 0 nie
  gesperrt         INTEGER NOT NULL DEFAULT 0,
  abstimmung       TEXT,                                 -- NULL | open | closed
  ausgenommen      INTEGER NOT NULL DEFAULT 0,
  done             INTEGER NOT NULL DEFAULT 0,
  sort             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ideen_kanten (
  id       INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES ideen_boards(id) ON DELETE CASCADE,
  von      INTEGER NOT NULL REFERENCES ideen_knoten(id) ON DELETE CASCADE,
  nach     INTEGER NOT NULL REFERENCES ideen_knoten(id) ON DELETE CASCADE,
  label    TEXT,
  UNIQUE(von, nach)
);
CREATE TABLE IF NOT EXISTS ideen_stimmen (
  knoten_id INTEGER NOT NULL REFERENCES ideen_knoten(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wahl      TEXT    NOT NULL,        -- yes | no | abstain
  PRIMARY KEY (knoten_id, user_id)
);
CREATE TABLE IF NOT EXISTS ideen_kommentare (
  id         INTEGER PRIMARY KEY,
  knoten_id  INTEGER NOT NULL REFERENCES ideen_knoten(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES ideen_kommentare(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ideen_versionen (
  id        INTEGER PRIMARY KEY,
  knoten_id INTEGER NOT NULL REFERENCES ideen_knoten(id) ON DELETE CASCADE,
  titel     TEXT    NOT NULL,
  text      TEXT,
  von_name  TEXT,
  at        TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ideen_ablehnungen (
  id            INTEGER PRIMARY KEY,
  board_id      INTEGER NOT NULL REFERENCES ideen_boards(id) ON DELETE CASCADE,
  titel         TEXT    NOT NULL,
  grund         TEXT    NOT NULL,
  von_name      TEXT,
  vorschlag_von INTEGER REFERENCES users(id) ON DELETE CASCADE,
  at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS abstimmungen (
  id                   INTEGER PRIMARY KEY,
  owner_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  titel                TEXT    NOT NULL,
  beschreibung         TEXT,
  mehrfach             INTEGER NOT NULL DEFAULT 0,
  max_wahl             INTEGER NOT NULL DEFAULT 0,
  anonym               TEXT    NOT NULL DEFAULT 'oeffentlich',   -- anonym | oeffentlich | selbst
  endet_at             TEXT,
  schliessen_angefragt INTEGER NOT NULL DEFAULT 0,
  ergebnis_live        INTEGER NOT NULL DEFAULT 1,
  ergebnis_fuer        TEXT    NOT NULL DEFAULT 'alle',          -- alle | ich
  created_at           TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS abstimmung_optionen (
  id            INTEGER PRIMARY KEY,
  abstimmung_id INTEGER NOT NULL REFERENCES abstimmungen(id) ON DELETE CASCADE,
  text          TEXT    NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS abstimmung_stimmen (
  abstimmung_id INTEGER NOT NULL REFERENCES abstimmungen(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id     INTEGER NOT NULL REFERENCES abstimmung_optionen(id) ON DELETE CASCADE,
  name_zeigen   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (abstimmung_id, user_id, option_id)
);

CREATE TABLE IF NOT EXISTS umfragen (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  titel         TEXT    NOT NULL,
  beschreibung  TEXT,
  status        TEXT    NOT NULL DEFAULT 'draft',   -- draft | open | closed
  endet_at      TEXT,
  identitaet    TEXT    NOT NULL DEFAULT 'anonym',  -- anonym | mit_namen
  mehrfach      INTEGER NOT NULL DEFAULT 0,
  ergebnis_live INTEGER NOT NULL DEFAULT 1,
  ergebnis_fuer TEXT    NOT NULL DEFAULT 'ich',     -- ich | teilnehmer
  gast_key      TEXT UNIQUE,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS umfrage_abschnitte (
  id         INTEGER PRIMARY KEY,
  umfrage_id INTEGER NOT NULL REFERENCES umfragen(id) ON DELETE CASCADE,
  titel      TEXT    NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS umfrage_fragen (
  id           INTEGER PRIMARY KEY,
  umfrage_id   INTEGER NOT NULL REFERENCES umfragen(id) ON DELETE CASCADE,
  abschnitt_id INTEGER REFERENCES umfrage_abschnitte(id) ON DELETE SET NULL,
  typ          TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  pflicht      INTEGER NOT NULL DEFAULT 0,
  config       TEXT    NOT NULL DEFAULT '{}',
  sort         INTEGER NOT NULL DEFAULT 0
);
-- Antworten liegen verschluesselt. \`schluessel\` erkennt die eigene Antwort wieder, ohne den
-- Menschen zu nennen (HMAC ueber Umfrage und Nutzer bzw. Gast-Kennung); \`user_id\` nur bei
-- Umfragen "mit Namen".
CREATE TABLE IF NOT EXISTS umfrage_antworten (
  id            INTEGER PRIMARY KEY,
  umfrage_id    INTEGER NOT NULL REFERENCES umfragen(id) ON DELETE CASCADE,
  schluessel    TEXT    NOT NULL,
  public_id     TEXT    NOT NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  gast_name_enc TEXT,
  antworten_enc TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE(umfrage_id, schluessel)
);
`);

// Einmalig mit 3.0: wer sich schon ein eigenes Menue gebaut hat, bekaeme den neuen Reiter "Buero"
// sonst nie zu sehen - er wird hinten angehaengt. Nur einmal (Merker in settings): wer ihn danach
// aus dem Menue nimmt, bekommt ihn nicht bei jedem Neustart zurueck.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration_menue_buero'").get()) {
  for (const u of db.prepare("SELECT id, menue FROM users WHERE menue IS NOT NULL AND menue NOT LIKE '%\"buero%'").all()) {
    try {
      const m = JSON.parse(u.menue);
      if (Array.isArray(m)) db.prepare('UPDATE users SET menue = ? WHERE id = ?').run(JSON.stringify([...m, 'buero']), u.id);
    } catch { /* kaputtes Menue: bleibt bei der Vorgabe */ }
  }
  db.prepare("INSERT INTO settings(key, value) VALUES('migration_menue_buero', '1')").run();
}

// Einmalig mit 3.0.1: Bis dahin kam dieselbe Plan-Meldung ("Raum: B104 -> A213") bei jedem
// Abgleich neu in die Warteschlange - wer "gesammelt" oder "Vorlauf" eingestellt hat, haette die
// angestauten Kopien nach dem Update noch einmal bekommen. Von jeder gleichen wartenden Meldung
// bleibt eine.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration_meldungen_doppelt'").get()) {
  db.prepare(`DELETE FROM notifications WHERE delivered_at IS NULL AND kind IN ('aenderung', 'ausfall', 'vertretung')
    AND id NOT IN (SELECT min(id) FROM notifications WHERE delivered_at IS NULL
      AND kind IN ('aenderung', 'ausfall', 'vertretung') GROUP BY user_id, kind, title, coalesce(body, ''))`).run();
  db.prepare("INSERT INTO settings(key, value) VALUES('migration_meldungen_doppelt', '1')").run();
}

// --- 3.1.0 -------------------------------------------------------------------
// Tickets auch ohne VNW: ein App-Ticket hat weder vnw_id noch view_token. Beide waren NOT NULL -
// einmal umbauen, wie bei messages.to_id. Bestehende VNW-Tickets bleiben Zeile fuer Zeile gleich.
if (db.prepare("SELECT count(*) AS n FROM pragma_table_info('tickets') WHERE name = 'vnw_id' AND \"notnull\" = 1").get().n) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE tickets_neu (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vnw_id     INTEGER,
      view_token TEXT,
      title      TEXT    NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'open',
      antworten  INTEGER NOT NULL DEFAULT 0,
      gesehen    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL,
      type_name  TEXT
    );
    INSERT INTO tickets_neu(id, user_id, vnw_id, view_token, title, status, antworten, gesehen, created_at, type_name)
      SELECT id, user_id, vnw_id, view_token, title, status, antworten, gesehen, created_at, type_name FROM tickets;
    DROP TABLE tickets;
    ALTER TABLE tickets_neu RENAME TO tickets;
    CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);`);
  db.exec('PRAGMA foreign_keys = ON');
}
// Der Text eines App-Tickets und die Antworten darauf - bei VNW liegt beides dort.
addColumn('tickets', 'text', 'TEXT');
// Geschlossen und vom Melder aus seiner Liste genommen - im Postfach der Admins bleibt es.
addColumn('tickets', 'versteckt', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS ticket_antworten (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text       TEXT    NOT NULL,
  vom_team   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_antw ON ticket_antworten(ticket_id, id);
-- Aus WebUntis uebernommene Pruefungen, die jemand geloescht hat: der naechste Import holt sie nicht zurueck.
CREATE TABLE IF NOT EXISTS untis_pruefung_weg (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid     TEXT    NOT NULL,
  PRIMARY KEY (user_id, uid)
);`);
// Gibt es eine Pruefung schon selbst eingetragen: 'meine' behalten oder die von 'untis' nehmen.
addColumn('users', 'pruefung_doppelt', "TEXT NOT NULL DEFAULT 'meine'");
// Ausfall im Plan: 'deutlich' (rot hinterlegt, gestrichelt, durchgestrichen) oder 'klassisch'.
addColumn('users', 'ausfall_stil', "TEXT NOT NULL DEFAULT 'deutlich'");
// Zugangsdaten mit dem eigenen Passwort verschluesselt: der Schluessel K entsteht beim Anmelden
// aus Passwort + Salz und liegt NUR verpackt in der Sitzung - verpackt mit dem Cookie-Token, von
// dem der Server bloss den Hash kennt. Ohne den Nutzer kommt niemand an die Zugangsdaten.
addColumn('users', 'zugang_eigen', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'zugang_salt', 'TEXT');
addColumn('sessions', 'zugang_k', 'TEXT');

// Mehrere Zustaendige je Aufgabe - Mitglieder des Projekts ODER freie Namen ohne Konto (nur zur
// Uebersicht). Ersetzt todos.zustaendig_id, die nur eine Person kannte; die Spalte bleibt stehen.
db.exec(`
CREATE TABLE IF NOT EXISTS todo_zustaendige (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT,
  CHECK ((user_id IS NULL) <> (name IS NULL))
);
CREATE INDEX IF NOT EXISTS todo_zust ON todo_zustaendige(todo_id);
CREATE INDEX IF NOT EXISTS todo_zust_user ON todo_zustaendige(user_id);`);

/** Die alte Einzel-Zuweisung in die neue Tabelle - ohne Doppelte, beliebig oft aufrufbar. */
export function zustaendigeUebernehmen() {
  db.prepare(`INSERT INTO todo_zustaendige(todo_id, user_id)
    SELECT t.id, t.zustaendig_id FROM todos t
    WHERE t.zustaendig_id IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = t.zustaendig_id)
      AND NOT EXISTS (SELECT 1 FROM todo_zustaendige z WHERE z.todo_id = t.id AND z.user_id = t.zustaendig_id)`).run();
}
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration_todo_zustaendige'").get()) {
  zustaendigeUebernehmen();
  db.prepare("INSERT INTO settings(key, value) VALUES('migration_todo_zustaendige', '1')").run();
}

// Seed: ohne Admin, Tage und Stunden ist die App beim ersten Start unbedienbar.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PW ?? 'admin';
  db.prepare("INSERT INTO users(username, pw, is_admin, created_at) VALUES(?, ?, 1, datetime('now'))")
    .run('admin', await hash(pw));
  if (!process.env.ADMIN_PW) console.warn('! Admin angelegt: admin / admin  -- bitte Passwort aendern (ADMIN_PW setzen)');
}
if (!db.prepare('SELECT 1 FROM days LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO days(iso, name) VALUES(?, ?)');
  ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'].forEach((n, i) => ins.run(i + 1, n));
}
if (!db.prepare('SELECT 1 FROM periods LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO periods(school_id, nr, start_time, end_time) VALUES(?, ?, ?, ?)');
  [['08:00', '08:45'], ['08:45', '09:30'], ['09:50', '10:35'],
   ['10:35', '11:20'], ['11:40', '12:25'], ['12:25', '13:10']]
    .forEach((t, i) => ins.run(standardId, i + 1, ...t));
}
// Frische Installationen starten geschlossen: Registrierung nur mit Key. Ohne REG_KEY wird einer
// erzeugt und ins Log geschrieben - er steht danach unter Admin -> Registrierung.
if (getSetting('registration_mode') === null) {
  const key = process.env.REG_KEY?.trim() || randomBytes(6).toString('base64url');
  setSetting('registration_mode', 'key');
  setSetting('registration_key', key);
  // Der Key selbst gehoert nicht ins Log: bei VNW steht das Log-Ende in der Oberflaeche, und
  // damit saehe ihn jeder, der die Plattform bedienen darf.
  if (!process.env.REG_KEY?.trim())
    console.warn('! Registrierungs-Key erzeugt - er steht unter Admin -> Registrierung.');
}

// Indizes fuer die haeufigen Abfragen (Chatliste und Gruppen alle 30 s, Freunde, Hausaufgaben,
// Kurs-Mitglieder, Buero). Ohne sie liest SQLite dort jedes Mal die ganze Tabelle.
db.exec(`
CREATE INDEX IF NOT EXISTS msg_an ON messages(to_id, from_id, id);
CREATE INDEX IF NOT EXISTS msg_gruppe ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS msg_kurs ON messages(kurs_id, id);
CREATE INDEX IF NOT EXISTS freunde_an ON friendships(to_id, status);
CREATE INDEX IF NOT EXISTS hw_user ON homework(user_id);
CREATE INDEX IF NOT EXISTS hw_done_user ON homework_done(user_id);
-- Kurs-Spalten werden ueberall NOCASE verglichen (siehe kanonischerKurs) - ein gewoehnlicher
-- Index hilft dann nicht, SQLite laese die ganze Tabelle. untis_lessons ist die groesste.
DROP INDEX IF EXISTS entries_kurs;
DROP INDEX IF EXISTS untis_kurs;
CREATE INDEX IF NOT EXISTS entries_kurs_nc ON entries(course_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS untis_kurs_nc ON untis_lessons(course_id COLLATE NOCASE, user_id);
CREATE INDEX IF NOT EXISTS kalender_user ON kalender(user_id);
CREATE INDEX IF NOT EXISTS kalender_geteilt_user ON kalender_geteilt(user_id);
CREATE INDEX IF NOT EXISTS users_ics ON users(ics_token);
CREATE INDEX IF NOT EXISTS notif_zeit ON notifications(created_at);
CREATE INDEX IF NOT EXISTS notif_ref ON notifications(user_id, ref);
CREATE INDEX IF NOT EXISTS buero_freigabe_kurs ON buero_freigabe(course_id);
CREATE INDEX IF NOT EXISTS notizen_owner ON notizen(owner_id);
CREATE INDEX IF NOT EXISTS notiz_ordner_owner ON notiz_ordner(owner_id);
CREATE INDEX IF NOT EXISTS notiz_todos_notiz ON notiz_todos(notiz_id);
CREATE INDEX IF NOT EXISTS notiz_kommentare_notiz ON notiz_kommentare(notiz_id);
CREATE INDEX IF NOT EXISTS ideen_boards_owner ON ideen_boards(owner_id);
CREATE INDEX IF NOT EXISTS ideen_knoten_board ON ideen_knoten(board_id);
CREATE INDEX IF NOT EXISTS ideen_knoten_parent ON ideen_knoten(parent_id);
CREATE INDEX IF NOT EXISTS ideen_kommentare_knoten ON ideen_kommentare(knoten_id);
CREATE INDEX IF NOT EXISTS abstimmungen_owner ON abstimmungen(owner_id);
CREATE INDEX IF NOT EXISTS abstimmung_optionen_a ON abstimmung_optionen(abstimmung_id);
CREATE INDEX IF NOT EXISTS umfragen_owner ON umfragen(owner_id);
CREATE INDEX IF NOT EXISTS umfrage_fragen_u ON umfrage_fragen(umfrage_id);
`);
