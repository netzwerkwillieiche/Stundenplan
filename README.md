# Stundenplan

Web-App: eigener Wochenstundenplan aus zentral gepflegten Kursen, Freunde hinzufügen, deren Pläne
sehen, gemeinsame Stunden erkennen, sich für einzelne Tage abmelden.

Node.js 22+ (nutzt das eingebaute `node:sqlite`), eine einzige Dependency: Express.

Freie Software unter der **GNU Affero General Public License v3.0 oder später** (siehe
[LICENSE](LICENSE)). Wer die App verändert und für andere betreibt, muss ihnen den Quelltext seiner
Fassung zugänglich machen.

## Lokal

```bash
npm install && npm start
```

http://localhost:3120, erster Login `admin` / `admin`.

## Rollen und Registrierung

- **Admin** legt Tage, Stunden, Fächer, Lehrer, Räume und Kurse an, **bearbeitet** sie und löscht
  sie; verwaltet Nutzer (anlegen, umbenennen, Adminrechte, Passwort zurücksetzen, löschen),
  und steuert die Registrierung.
  Bearbeiten statt Löschen ist bei Stunden wichtig: das Löschen einer Stunde nimmt per Cascade die
  Stundenplan-Einträge aller Nutzer mit, eine Zeitkorrektur dagegen nicht.
- **Jeder** baut seinen eigenen Plan, verwaltet Freunde, meldet sich für Tage ab, gestaltet sein
  Profil (Anzeigename, Farbe, Emoji, Profilbild, **Banner**, Passwort), trägt Hausaufgaben ein,
  benennt seine Kurse für sich um, sortiert sein Menü und stellt Benachrichtigungen ein.

### Der Raum gehört zur Stunde, nicht zum Kurs

Ein Kurs trägt Kürzel, Titel, Fach und Lehrer — **keinen Raum**. Den setzt jeder selbst pro Stunde
in seinem Plan (Klick auf die Zelle → Raum wählen), denn derselbe Kurs kann montags in A213 und
mittwochs in B104 stattfinden. Wird ein Raum gelöscht, verlieren die betroffenen Einträge nur ihre
Raumangabe, nicht sich selbst.

### Stunde eintragen

Klick auf eine Zelle öffnet das Detailfenster. Der Kurs wird **in zwei Schritten** gewählt: erst
das Fach, dann erscheinen nur dessen Kurse (mit Lehrer und Kursnummer). Das hält die Liste
übersichtlich, auch wenn die Schule hundert Kurse hat. Ganz oben stehen „— nichts eintragen —"
und „Frei (Freistunde)".

Dazu kommen der **Raum** für genau diese Stunde und eine **Notiz** — etwa „Buch mitbringen".
Die Notiz ist **privat**: Freunde sehen deine Stunde, aber nicht deine Notiz. Im Plan zeigt ein ✎,
dass eine Notiz hinterlegt ist (kompakt: ein grauer Punkt unten links), der Text steht im Tooltip
und im Detailfenster.

### Woche und Ansicht

Ohne Wochenangabe zeigt der Plan die laufende Woche — **am Wochenende die kommende**. Samstags die
gerade beendete Woche zu zeigen hilft niemandem, und alles, was man dort einträgt, wäre sofort
überfällig.

Die zuletzt geöffnete Ansicht wird gemerkt: Nach dem Neuladen oder beim Start der installierten
App landet man wieder dort, wo man war, nicht immer auf dem Plan.

### Angemeldet bleiben

Das Sitzungscookie hat ein Ablaufdatum von 180 Tagen — man bleibt also über Browser- und
Handy-Neustarts hinweg angemeldet, was für eine installierte App die Erwartung ist. Abgelaufene
Sitzungen räumt die App beim Start auf. Wer sich auf einem fremden Gerät anmeldet, sollte
**Ausloggen** benutzen; das löscht die Sitzung serverseitig und den lokalen Zwischenspeicher.

### Anzeige im Stundenplan

In der Zelle steht groß das **Fach**, darunter **Lehrer · Raum** und ganz klein die Kursnummer.
Bei der Kursauswahl heißt ein Kurs **Fach — Lehrer — Kursnummer**, alphabetisch sortiert.

**Zweite Darstellung „Wie WebUntis"** (Profil → Ansicht → Darstellung): Karten mit einem
Farbbalken in der Kursfarbe, **Lehrer zuerst**, dann Fach, dann Raum — so, wie es Schüler aus
WebUntis kennen. Was heute anders ist, wird hinterlegt: der Vertretungslehrer, der neue Raum, und
die Karte ist leicht getönt; ein ⓘ unten rechts sagt, dass zur Stunde etwas geschrieben steht.
Die Kompaktansicht bleibt davon unberührt.

**Zustandsfarben** (Profil → Ansicht → Farben im Stundenplan): Ausfall, Vertretung, Vertretung
ohne Lehrer, Raumänderung und Prüfung — jede Farbe für sich, wie bei den Kursen, mit
„Zurücksetzen". Die Vorgaben sind die Farben, die der Plan immer hatte (Ausfall rot, alles „heute
anders" bernsteinfarben); eine **Prüfung** ist **fett gelb umrandet** — die Kursfarbe bleibt
darunter, der Rahmen sagt nur „hier wird geschrieben". Technisch: `users.status_farben` als
JSON, im Plan als CSS-Variablen `--st-entfaellt`, `--st-vertretung`, `--st-ohne-lehrer`,
`--st-raum`, `--st-pruefung`; Plan und Detailfenster lesen dieselben.

### Kompakte Ansicht (fürs Handy)

Der Knopf **Kompakt** über dem Plan schaltet auf eine gedrängte Darstellung: die ganze Woche passt
ohne seitliches Scrollen aufs Display (auf 375 px rund 350 × 306 px). In der Zelle steht dann nur
das **Fach-Kürzel** und der Raum, gemeinsame Stunden erscheinen als kleiner Punkt statt als
Gesichterreihe. Ein Klick auf die Stunde zeigt weiterhin alles.

Das Kürzel pflegt der Admin beim Fach (**Admin → Fächer**, zweites Feld, z. B. `MA` für
Mathematik). Ohne gepflegtes Kürzel nimmt die App die ersten beiden Buchstaben des Fachnamens.

Auf schmalen Displays (bis 700 px) ist die kompakte Ansicht voreingestellt, auf großen die volle.
Sobald du den Knopf einmal drückst, gilt deine Wahl und wird gemerkt — die automatische Vorgabe
wird bewusst *nicht* gespeichert, sonst würde ein einmalig schmales Fenster die Ansicht dauerhaft
festlegen.

### Hausaufgaben

Unter **Hausaufgaben** trägt jeder ein, was zu tun ist — Kurs, Fälligkeitsdatum, Text. Schneller
geht es direkt aus der Stunde heraus: Klick auf die Zelle → Abschnitt „Hausaufgaben", dort sind
Kurs und Datum schon vorbelegt.

**Sichtbar für alle, die den Kurs im Stundenplan haben — auch ohne Freundschaft.** Das ist die
einzige Stelle, an der die App von ihrer sonst strengen Regel abweicht (man sieht nur Daten
bestätigter Freunde). Anders funktioniert es nicht: Wer keine Freunde hat, sähe sonst nie eine
Hausaufgabe. Der Verfasser wird mit Namen genannt, für Kursteilnehmer ist damit erkennbar, wer den
Kurs belegt.

- **Eintragen** darf, wer den Kurs im Plan hat; **ändern und löschen** der Verfasser und Admins.
- **Abhaken ist persönlich**: jeder hakt für sich ab, bei den anderen bleibt die Aufgabe offen.
- Im Plan zeigt ein 📝 an der Stunde, dass etwas offen ist (kompakt: ein oranger Punkt). Kommt ein
  Kurs an einem Tag zweimal vor, steht der Marker nur an der ersten Stunde.
- Die Liste ist nach Fälligkeit gruppiert („Heute", „Morgen", „Überfällig …") und reicht 30 Tage
  zurück und 28 Tage nach vorn — **Überfälliges bleibt sichtbar**, sonst verschwände alles, was man
  aus dem Plan heraus für einen schon vergangenen Tag einträgt. Erledigte lassen sich einblenden.
- **Überfälliges räumt sich von selbst weg**: nach 7 Tagen (Vorgabe; im Profil unter *Ansicht*
  einstellbar, 0 = nie). Gelöscht wird nur, was einem gehört — die eigenen Einträge und die aus
  WebUntis; was Mitschüler in den Kurs eingetragen haben, wird nur ausgeblendet, denn deren Frist
  ist deren Sache. Läuft im Zehn-Minuten-Takt und nach jedem WebUntis-Import, weil der die alten
  Aufgaben sonst wieder mitbrächte.

Hausaufgaben hängen am **Kurs**, nicht am einzelnen Stundenplan-Eintrag. Ein umbenanntes Kurskürzel
nimmt sie mit (`ON UPDATE CASCADE`), ein gelöschter Kurs räumt sie weg.

### ToDos

Neben den Hausaufgaben gibt es einen zweiten Reiter: **ToDos**. Der Unterschied in einem Satz —
Hausaufgaben hängen an einem Kurs und sehen alle, die ihn haben; ToDos hängen an einer Uhrzeit und
sieht **nur man selbst**.

Jedes ToDo hat eine Fälligkeit mit Uhrzeit und eine Erinnerung: *zur Fälligkeit*, *1 Stunde*,
*8 Stunden* oder *1 Tag vorher*. Die Meldung kommt als Benachrichtigung — einmal, nicht bei jedem
Durchlauf. Wer den Termin verschiebt, wird neu erinnert.

> Verschickt wird im selben Zehn-Minuten-Takt wie der WebUntis-Abgleich — eine Stelle für alles
> Periodische statt zweier Timer. Eine Erinnerung kann dadurch bis zu zehn Minuten zu spät kommen.
> Bei „einen Tag vorher" merkt das niemand, bei „zur Fälligkeit" schon.

Voreingestellt ist der Reiter **Hausaufgaben**; die zuletzt gewählte Seite wird gemerkt.

### Was der Lehrer zur Stunde geschrieben hat

WebUntis führt zwei Sorten Text, und die App hält sie getrennt:

- **kurz** — Vertretungs- und Ausfalltext. Steht in der Zelle.
- **lang** — was der Lehrer eingetragen hat: Lehrstoff und Notizen für die Klasse, oft mehrzeilig
  und oft mit den eigentlichen Hausaufgaben darin. Steht im Detailfenster unter **„Von der
  Schule"**, mit den Zeilenumbrüchen des Lehrers.

Der lange Teil zerfällt in **Lehrstoff**, **Unterrichtstext** und **Notizen für Schüler\*innen** —
Abschnitte, so wie sie der Lehrer eingetragen hat, nicht zu einem Absatz verklebt. Lehrstoff ist
der Klassenbucheintrag zur einzelnen Stunde; der Unterrichtstext hängt am Unterricht selbst
(„Klausur", ein Hinweis für alle Stunden). Er erscheint nur, wenn er nicht bloß den Lehrstoff
wiederholt.

Im Plan selbst steht dafür **kein** Zeichen: an manchen Schulen hängt an fast jeder Stunde etwas,
und dann markiert ein Symbol nichts mehr. Wer es trotzdem will, schaltet im Profil *„Im Plan zeigen,
wenn der Lehrer etwas zur Stunde geschrieben hat"* ein — dann erscheint ein **ℹ** in der Zelle
(kompakt: ein blauer Punkt).

> **Lehrstoff und Notizen kommen aus zwei verschiedenen Schnittstellen.** Die Wochenabfrage
> liefert `periodText` (Notizen für Schüler\*innen) und `periodInfo`, aber bei manchen Instanzen
> bleibt `lessonText` leer — genau so kam der Plan an: Notizen da, Lehrstoff nicht. Der Lehrstoff
> steht im Endpunkt für das Stundendetail
> (`/WebUntis/api/rest/view/v2/calendar-entry/detail`, Feld `teachingContent`) und wird von dort
> zusätzlich geholt, über Datum und **Zeitspanne** zugeordnet: eine Doppelstunde ist dort *ein*
> Eintrag 08:00–09:30, bei uns sind es zwei Stunden — und die zweite bekam den Lehrstoff bisher
> nie. Genauso ging er verloren, wenn die Stunde daneben einen Unterrichtstext hatte: der stand im
> selben Feld und gewann. Jetzt sind es zwei Felder.
>
> Liefert die Wochenanfrage nichts, wird derselbe Endpunkt **Tag für Tag** gefragt — manche
> Instanzen beantworten nur kurze Zeiträume. `teachingContent` darf auch ein Objekt mit `text`
> sein; `notesAll` zählt als Ersatz, wenn es leer ist.
>
> **Und manche Instanzen beantworten überhaupt nur exakt eine Stunde.** Das hat der Bericht einer
> Schule gezeigt: 36 Perioden in der Wochenabfrage, aber `404` für jeden Bereich — Woche wie Tag,
> v1 wie v2. So ruft auch die WebUntis-Oberfläche den Endpunkt auf: mit Start und Ende der einen
> Stunde (`startDateTime=2026-09-14T07:50&endDateTime=2026-09-14T08:35`, ohne Sekunden, ohne `Z`).
> Bringt der Bereich nichts, holt der Abgleich den Lehrstoff deshalb **je Stunde** — nur für
> **−7 bis +7 Tage** und nur **stündlich** (`untis_accounts.lehrstoff_geholt`; „Jetzt abgleichen"
> immer), denn das sind ~70 Aufrufe je Lauf. Antwortet der Endpunkt fünfmal in Folge gar nicht,
> bricht der Lauf ab. Der Lehrstoff liegt darum in einer **eigenen Spalte** (`untis_lessons.lehrstoff`)
> mit eigenem Takt: der Zehn-Minuten-Abgleich lässt ihn stehen, statt ihn mit dem übrigen Text zu
> überschreiben. Für den Client ist es weiterhin ein Text, der Lehrstoff voran.
>
> Die übrigen Textabrufe laufen nur über **−28 bis +21 Tage**, nicht über den ganzen
> Abgleichsbereich: den Lehrstoff trägt der Lehrer *nach* der Stunde ein, für den Mai gibt es keinen.
>
> **Fehlt er trotzdem**, steht im Profil unter der WebUntis-Karte — **nur für Admins** — der Knopf
> **DEBUG**: er meldet sich mit dem eigenen Zugang an und probiert für einen Tag (am Wochenende den
> kommenden Montag) alles durch, was Lehrstoff tragen könnte — JSON-RPC, die Wochenabfrage, das
> Stundendetail (Woche, Tag, exakt eine Stunde in drei Zeitschreibweisen, v2 und v1), den klassischen
> `period/info`-Endpunkt und `timetable/entries` (v1/v2, `MY_TIMETABLE`/`STANDARD`) — und schreibt
> auf, was kam: Status, Schlüssel und **jedes Textfeld mit seinem Pfad**, egal wie es heißt. Das
> Passwort steht in keiner Zeile. Ohne diesen Bericht bleibt „der Lehrstoff fehlt" eine Vermutung;
> mit ihm war es eine Zeile Code.
>
> Die WebUntis-Karte im Profil zeigt nach jedem Abgleich, **wie viele** Stunden welchen Text
> mitgebracht haben („Lehrstoff 12 · Notizen 30 · Info 4"). Welche Felder eine Instanz an
> Schülerkonten herausgibt, ist von Schule zu Schule verschieden; ohne diese Zeile bleibt „der
> Lehrstoff fehlt" eine Vermutung. Steht dort „Lehrstoff 9 (12 gefunden)", kamen zwölf Einträge
> mit Text an, aber nur neun ließen sich einer Stunde zuordnen — dann liegt es an der Zuordnung,
> nicht an der Schule.

> Die beiden langen Texte kommen **nicht** aus JSON-RPC. Dort bleiben `lstext` und `bkText` für
> Schülerkonten leer, auch wenn man `showLsText` mitschickt — `info` und `substText` dagegen
> nicht. Genau so sah es aus: Info zur Stunde da, Lehrstoff nicht. Die Texte stehen in der
> REST-Schnittstelle, die auch die WebUntis-Weboberfläche des Schülers benutzt; dort heißen sie
> `lessonText` und `periodText`. Die Abfrage geht wochenweise und ist eine Zugabe — schlägt sie
> fehl, steht der Stundenplan trotzdem.

### Freistunden

Liegt zwischen zwei belegten Stunden eines Tages eine Lücke, füllt die App sie **automatisch**
mit einer Freistunde — zurückhaltender dargestellt als eine selbst eingetragene. Sie wird nur
berechnet, nicht gespeichert: ändert sich der Plan, stimmt sie von selbst. Auch eine automatische
Lücke zählt als gemeinsame Stunde, wenn ein Freund sie ebenfalls hat. Vor der ersten und nach der
letzten Stunde wird nichts aufgefüllt.

Neben den Kursen steht in der Auswahl **Frei (Freistunde)**. Eine eingetragene Freistunde erscheint
zurückhaltend grau mit „Frei" — ohne Lehrer, Raum und Kursnummer. Haben zwei Befreundete dieselbe
Freistunde, wird das genauso als gemeinsam angezeigt wie ein gemeinsamer Kurs: man sieht also auf
einen Blick, mit wem man eine Lücke teilt.

Technisch ist die Freistunde ein reservierter Kurs mit der ID `__frei__`. Dadurch greifen
Gemeinsamkeits-Erkennung, Zelle und Detailansicht ohne Sonderweg. Sie gehört der App: Löschen oder
Umbenennen lehnt der Server ab, und im Admin-Kurspanel taucht sie nicht auf.

Hast du eine Stunde gemeinsam mit Freunden, stehen deren **Profilbilder** klein und überlappend
rechts in der Zelle — ohne eigenes Bild Emoji bzw. Initialen, abgemeldete ausgegraut. Ab vier
Personen werden drei gezeigt und der Rest als „+N"; die vollständige Liste steht im Tooltip und
beim Klick auf die Stunde.

### WebUntis

Ist die Anbindung eingerichtet, kommt der Plan automatisch von der Schule — **samt Vertretung und
Ausfall**. Der selbst gebaute Plan bleibt als Rückfall: WebUntis hat Vorrang, aber nur an den Tagen,
für die es etwas liefert.

**Es braucht keinen API-Key und keine App-Registrierung bei Untis.** WebUntis kennt so etwas
nicht — die Schnittstelle steht jedem offen, der sich anmelden kann. Auch ein Admin-Zugang bei
WebUntis wird nicht gebraucht: jeder meldet sich mit seinem eigenen Schülerkonto an. Eingerichtet
wird die Anbindung deshalb komplett im Profil, ohne Zutun eines Admins:

- **Profil → WebUntis → Schule suchen**: WebUntis beantwortet die Schulsuche öffentlich. Das ist
  nötig, weil in der Anmelde-URL nicht der Anzeigename der Schule steht, sondern ihr *Anmeldename*
  (`gymnasium-nordhorn`, nicht „Gymnasium Nordhorn") — den kennt sonst niemand.
- Danach der eigene WebUntis-Benutzername und **entweder das Passwort oder der Zugriffsschlüssel**
  (siehe unten).
- Die **eingestellte Schule ist die Vorgabe** — gesetzt von dem, dessen Anmeldung dort als Erstes
  klappt. Ein Vertipper kann sie nicht festlegen: gespeichert wird sie erst nach einer
  erfolgreichen Anmeldung.
- Wer **woanders zur Schule geht**, klappt mit „Nicht meine Schule — andere Schule anmelden" die
  Suche wieder auf und meldet sich mit seiner eigenen an (siehe unten).
- **Admin → WebUntis** zeigt nur noch, welche Schule als Vorgabe hinterlegt ist, und kann sie
  zurücksetzen (löscht dabei die Zugänge und abgeglichenen Stunden **dieser** Schule — die zeigen
  sonst ins Leere; wer mit seiner eigenen Schule angemeldet ist, behält seinen Zugang).
- Im Plan wird ein **Ausfall** durchgestrichen und rot markiert („entfällt"), eine **Vertretung**
  bernsteinfarben; der Text von WebUntis steht im Detailfenster.

Fächer, Lehrer und Kurse legt der Abgleich in den vorhandenen Tabellen an. Die Kurs-ID ist
`UNTIS-<Kursnummer>` — dadurch bekommen zwei Leute im selben WebUntis-Kurs dieselbe ID, und
**gemeinsame Stunden, Notizen und kursweite Hausaufgaben funktionieren unverändert weiter**.
Liefert WebUntis keine Kursnummer, wird auf `UNTIS-<Fach>-<Lehrer>` ausgewichen; dann können zwei
verschiedene Kurse desselben Lehrers im selben Fach zusammenfallen.

#### Mehrere Schulen

Ein Konto gehört zu **genau einer** Schule. Die eingestellte ist die Vorgabe (`users.school_id IS
NULL` heißt „die Standardschule" — deshalb muss kein Bestandskonto angefasst werden); über den
Knopf im Profil meldet man sich stattdessen bei einer anderen an. Was von Schule zu Schule
verschieden ist, hängt daran:

| | warum |
|---|---|
| **Stundenraster** (`periods.school_id`) | andere Klingelzeiten. Ohne das fiele eine Schule, die um 7:30 anfängt, komplett durch die Rasterzuordnung — leerer Plan. Das Raster einer neuen Schule holt der erste Abgleich per `getTimegridUnits`; scheitert das, wird das der Standardschule kopiert |
| **Ferien** (`holidays.school_id`) | sonst leert Schule B den Plan von Schule A |
| **Kurs-IDs** | dieselbe `lsnumber` gibt es an jeder Schule. Jede Schule außer der Standardschule bekommt ein Präfix (`S3-UNTIS-4711`); die Standardschule behält `UNTIS-4711`, so wie es in jeder bestehenden Datenbank steht |
| **Kursliste** (`courses.school_id`) | damit die Auswahl im Eintrag-Fenster nicht mit fremden Kursen zuwächst |

**Gemeinsame Stunden und „wer hat auch frei" gibt es nur innerhalb derselben Schule** — über
Schulgrenzen hinweg passen weder Kurse noch Zeiten zusammen. Die **Planauswahl** gruppiert die
Freunde nach Schule, sobald mehr als eine vorkommt; wer nur Freunde an einer Schule hat, sieht von
der anderen nichts.

Ein **Schulwechsel** löscht die eigenen abgeglichenen Stunden (sie zeigen auf die alte Schule);
selbst gebaute Einträge bleiben stehen — im fremden Raster sind sie unsichtbar und beim
Zurückwechseln wieder da. Die Prüfung, dass der Server aus der Schulsuche stammt
(`*.webuntis.com`), gilt unverändert für jede Anmeldung.

### IServ als zweite Quelle

Wer kein WebUntis hat, meldet sich im Profil mit seinem **IServ**-Zugang an: Adresse der Schule,
Benutzername, Passwort. Danach läuft alles wie bei WebUntis — derselbe Zehn-Minuten-Takt, dieselbe
Tabelle, dieselben Meldungen, dasselbe „wer hat auch frei".

**Was IServ nicht hat: eine Schnittstelle für den Stundenplan.** Das Modul importiert Untis-,
DaVinci- oder svPlaner-Dateien und zeigt sie an — kein REST, kein iCal, kein Export. Gelesen wird
deshalb die Seite, die auch ein Mensch sieht, mit seinem Konto und seiner Sitzung
(`POST /iserv/app/login`, dann die Plan-Seite). Der Tabellenleser in `iserv.js` ist bewusst
tolerant: `<br>` und „Fach / Lehrer / Raum" werden gleich behandelt, `colspan` verschiebt keine
Tage, und wo nichts passt, entsteht **nichts** statt etwas Erfundenem.

**Angemeldet wird wie im Browser**, nicht nach Vermutung: Weiterleitungen werden verfolgt (die
blanke Schuladresse zeigt oft auf `www.`), das Anmeldeformular wird **gelesen** — Ziel, Feldnamen
und versteckte Schutzfelder — und genau das wird gesendet, mit den Kopfzeilen eines Browsers. Daran
ist die erste Fassung gescheitert: sie holte die Anmeldeseite, ohne der Weiterleitung zu folgen,
fand deshalb das Schutzfeld `_csrf_token` nie und schickte geratene Feldnamen ohne `User-Agent`
los. Das Ergebnis war jedes Mal „stimmen Benutzername und Passwort?".

> Jedes Weiterleitungsziel wird neu geprüft (https, Schuldomain, kein privates Netz). Ohne das wäre
> das Folgen genau das Loch, das die Adressprüfung schließen soll: eine Adresse, die auf
> `169.254.169.254` weiterleitet, führte den Server sonst dorthin.

Weil die Plan-Seite von Schule zu Schule anders aussieht, gibt es im Profil zwei Knöpfe:
**„Verbindung testen"** (vor dem Speichern, mit den Angaben aus dem Formular) und **„Was kommt von
IServ zurück?"** (danach). Beide schreiben denselben Bericht: welcher Pfad welchen Status hatte,
wohin weitergeleitet wurde, ob ein Formular gefunden wurde und wie seine Felder heißen, welche
Kekse kamen — und am Ende, ob die Plan-Seite gefunden wurde, samt ihren ersten Zeilen im Klartext.
Das Passwort steht in keiner Antwort und in keinem Log. Ohne diesen Bericht wäre „Anmeldung
fehlgeschlagen" eine Sackgasse.

| | |
|---|---|
| **Zeitraum** | nur **eine Woche** — IServ zeigt, was auf der Seite steht, und einen Datumsparameter gibt es nicht. Angenommen wird die Woche, die auch der Plan zeigt (am Wochenende also die kommende); steht in der Kopfzeile ein Datum („Mo 14.09."), zählt das. Für alle anderen Wochen bleibt der selbst gebaute Plan stehen |
| **Raster** | kommt aus der ersten Spalte der Tabelle („07:45 – 08:30") — die Zeiten regeln sich also auch hier von selbst |
| **Kurs-IDs** | `ISERV-<Fach>-<Lehrer>` mit dem Schulpräfix davor; eine Kursnummer gibt IServ nicht heraus |
| **Adresse** | nur https und nur, was nach einer Schuldomain aussieht: IP-Adressen, `localhost`, `*.local` und alles, was laut Namensdienst ins private Netz zeigt, wird abgewiesen — sonst wäre das Eingabefeld ein Anfrage-Generator ins Innere des Servers |

**Eine IServ-Schule ist eine eigene Schule** — auch wenn dasselbe Haus daneben über WebUntis hängt.
Sie teilen weder Raster noch Kurse, und „gemeinsame Stunden" oder „wer hat auch frei" gibt es
zwischen ihnen nicht. Das ist keine Einschränkung, sondern die ehrliche Lage: eine Kurs-ID aus
IServ kann eine Untis-Kursnummer nie treffen, und ein gemeinsames Raster wäre geraten. Mehrere
IServ-Schulen nebeneinander gehen dagegen wie gehabt — jede mit eigenem Raster, eigenen Ferien und
eigener Gruppe in der Planauswahl.

> `ponytail:` Der Leser ist gegen einen nachgebauten IServ geprüft, nicht gegen ein echtes. Passt
> die Plan-Seite eurer Schule nicht ins Schema, sagt der Diagnose-Knopf, was ankommt — und der
> Leser wird darauf nachgezogen.

#### Schlüssel statt Passwort

Automatischer Abgleich heißt, dass etwas entschlüsselbar gespeichert liegen muss. Es muss aber
nicht das Schulpasswort sein: WebUntis vergibt unter **Profil → Freigaben → Zugriff über andere
Apps** einen Zugriffsschlüssel (denselben, der im QR-Code der Untis-App steckt). Daraus rechnet
die App bei jeder Anmeldung einen Einmalcode — **das Passwort und der Schlüssel selbst gehen nie
über die Leitung**.

Voreingestellt ist **Benutzername + Passwort**, weil das jeder hat und die Freigabe für andere
Apps nicht an jeder Schule eingeschaltet ist. Wo es sie gibt, ist der Schlüssel aber in jeder
Hinsicht die bessere Wahl:

| | Zugriffsschlüssel | Passwort |
|---|---|---|
| Reichweite | nur Lesezugriff auf den Plan | das ganze WebUntis-Konto |
| Widerrufen | in WebUntis, einzeln | nur durch Passwortwechsel |
| Bei Serverzugriff erbeutet | ein widerrufbarer Schlüssel | das Schulpasswort |

Umschalten geht im selben Formular unter „Anmelden mit".

**Einzurichten ist dafür nichts.** Die App legt den nötigen Schlüssel beim ersten Bedarf selbst
an (siehe unten). Steht im Profil trotzdem nur ein Hinweis statt des Anmeldefelds, konnte sie die
Schlüsseldatei nicht schreiben — dann fehlen Schreibrechte im Ordner der Datenbank.

#### Wo der Schlüssel liegt, mit dem das verschlüsselt wird

Verschlüsselt wird mit AES-256-GCM. Den Schlüssel dazu erzeugt die App beim ersten Bedarf selbst
und legt ihn als **`<DB-Pfad>.untis-key`** neben die Datenbank — also **nicht hinein**. Das ist
kein Selbstzweck: die Sicherungsfunktion lädt die Datenbank als Datei herunter, und die landet in
Downloads und E-Mails. Stünde der Schlüssel darin, trüge jede Sicherung die Untis-Zugänge aller
Nutzer mit sich.

- Die Datei gehört gesichert und darf **nicht gelöscht** werden — sonst müssen sich alle neu
  verbinden. Sie liegt neben der Datenbank und damit automatisch außerhalb von `install_dir`.
- Wer den Schlüssel lieber selbst vorgibt, setzt `UNTIS_KEY` (32 Byte als Hex oder Base64) — die
  Variable hat Vorrang, und dann wird keine Datei angelegt.
- Eine Sicherung, die auf einem **anderen** Server eingespielt wird, bringt ihren Schlüssel nicht
  mit: Pläne, Hausaufgaben und Chats sind da, die WebUntis-Zugänge müssen neu hinterlegt werden.

> Wer den Server kontrolliert, kommt an beides und damit an das Hinterlegte: beim Schlüssel-Weg an
> widerrufbare Lese-Schlüssel, beim Passwort-Weg an die Schul-Passwörter aller Nutzer.

> **Anmeldung und Abgleich sind nicht gegen eine echte Schule getestet.** Die Schulsuche schon —
> sie liefert hier echte Treffer. Der Einmalcode ist gegen die Testvektoren aus RFC 6238 geprüft,
> die Form der Anmelde-Anfrage gegen die Dokumentation, der Plan-Abruf gegen einen nachgebauten
> Server. Ob eure Instanz sich genauso verhält (insbesondere `lsnumber` und die Freigabe für
> andere Apps), zeigt sich beim ersten Abgleich. Fehler stehen im Profil unter „Letzter Fehler",
> nicht nur im Log.

### Wie oft abgeglichen wird

Zwei Takte, weil sich Nahes und Fernes verschieden schnell ändert:

| | Zeitraum | Wie oft |
|---|---|---|
| kurz | laufende Woche −1 bis +2 | **alle 10 Minuten** |
| voll | 4 Wochen zurück bis 20 Wochen vorwärts | alle 6 Stunden |

Vertretungen und Ausfälle betreffen die nächsten Tage und sollen zeitnah da sein; der Plan in vier
Monaten ändert sich praktisch nie. Alle zehn Minuten den ganzen Halbjahresplan zu holen wäre nur
unhöflich gegenüber dem Schulserver.

Der Abgleich läuft **auch, wenn niemand die App offen hat** — sonst käme die Meldung über eine
ausgefallene Stunde erst, wenn man ohnehin schon nachsieht. Die Konten werden nacheinander
abgearbeitet, nicht alle gleichzeitig.

**Profil → „Jetzt mit WebUntis abgleichen"** holt sofort den ganzen Zeitraum — der Knopf ist für
den Fall da, dass in WebUntis gerade etwas geändert wurde.

> Schlägt eine Anmeldung fehl (etwa nach einem Passwortwechsel), wird dieses Konto **eine Stunde
> lang nicht erneut versucht**. Sonst liefe alle zehn Minuten ein Fehlversuch auf, und WebUntis
> sperrt Konten nach einigen davon. Der Fehler steht im Profil unter „Letzter Fehler".

### Entweder WebUntis oder der eigene Plan — pro Tag, nie gemischt

Entschieden wird **pro Tag**, und zwar danach, ob WebUntis für diesen Tag wirklich etwas geliefert
hat:

| Der Tag hat … | Angezeigt wird |
|---|---|
| Untis-Stunden | **nur WebUntis** — auch die Lücken dazwischen, die Schule kennt den ganzen Tag |
| keine Untis-Stunden | der selbst gebaute Plan |
| Ferien | nichts, die Spalte ist als Ferien beschriftet |

Der Unterschied zwischen „keine Stunden" und „frei" ist der Punkt: eine Woche, deren Plan die
Schule noch nicht veröffentlicht hat, liegt zwar im abgeglichenen Zeitraum, hat aber keine
Stunden. Würde sie als „WebUntis sagt: frei" gelten, wäre der selbst gebaute Plan dort schlagartig
verschwunden.

Innerhalb eines Tages wird nicht gemischt — sonst stünde neben vier Untis-Stunden noch eine fünfte
aus dem **alten** Plan, und niemand wüsste, was gilt. Der abgeglichene Zeitraum rastet zusätzlich
auf ganze Wochen ein, damit die Grenze nie mitten in eine Woche fällt.

Gemeint ist damit der Wochenplan von *früher* — nicht das, was man **jetzt** einträgt. Wer an einem
Tag mit WebUntis-Stunden selbst etwas in eine freie Stunde schreibt, meint es auch so: der Server
speichert solche Einträge mit **Vorrang** und sie bleiben stehen. Vorher entstand der Eintrag,
verschwand beim nächsten Laden und niemand erfuhr warum — auf dem Bildschirm sah es aus, als
hätte das Speichern gar nichts getan. Zurück geht es mit „WebUntis wieder übernehmen".

### Ferien

Der Abgleich holt Ferien und Feiertage gleich mit (`getHolidays`). Sie gelten schulweit — wer
abgleicht, holt sie für alle. Im Plan steht der Name in der Spaltenüberschrift („03.09. ·
Herbstferien"), die Spalte bleibt leer und lädt nicht zum Eintragen ein.

Ohne das sähe eine Ferienwoche genauso aus wie eine, deren Plan noch fehlt.

### Was aus WebUntis kommt, bleibt bei dem, der es geholt hat

Fächer, Lehrer und Kurse, die der Abgleich anlegt, tauchen **nicht** in den Admin-Listen und nicht
in der Kursauswahl **anderer** auf. Der Grund ist einfach: eine vollständige Kursliste der Schule
verrät, wer was belegt.

Die Grenze verläuft am **eigenen Plan**: Untis-Kurse, die der eigene Abgleich liefert, stehen in
der eigenen Kursauswahl und lassen sich auch eintragen — in eine andere Stunde legen, eine falsch
importierte ersetzen. Wer einen Kurs **nicht** hat, sieht ihn nicht und bekommt über die API einen
403: sonst könnte man sich in einen fremden Kurs eintragen und über die gemeinsamen Stunden sehen,
wer darin sitzt.

> Früher blieb alles Importierte aus der Auswahl heraus, auch das eigene. Wessen Plan vollständig
> aus WebUntis kommt — der Normalfall —, bekam damit eine Fachauswahl mit genau zwei Einträgen
> („nichts eintragen" und „Frei") und konnte in seinem eigenen Plan gar nichts eintragen und nichts
> überarbeiten. Auch „Dauerhaft ersetzen" führte nur zu einem leeren Formular.

In den **Admin-Listen** bleibt Importiertes weiterhin draußen: dort geht es um das, was sich
bearbeiten lässt, und daran ändert der Admin ohnehin nichts.

Manuell angelegte Stammdaten bleiben für alle sichtbar und vom Admin bearbeitbar — falls bei
WebUntis etwas fehlt oder die Anbindung gar nicht genutzt wird. Importiertes lässt sich dagegen
nicht ändern oder löschen; der nächste Abgleich würde es ohnehin überschreiben.

Was davon **unberührt** bleibt: Freundespläne, gemeinsame Stunden, Notizen und Hausaufgaben
funktionieren mit Untis-Kursen genau wie mit eigenen. Hausaufgaben sind eine Funktion dieser App,
nicht von WebUntis — wer den Kurs im Plan hat, trägt sie ein und sieht sie, egal woher der Kurs
stammt.

### Eine falsch importierte Stunde dauerhaft ersetzen

Stimmt eine Stunde aus WebUntis nicht, öffnet ein Klick darauf **„Dauerhaft ersetzen"**. Danach
wählt man Fach, Kurs und Raum wie sonst auch — und der eigene Eintrag gewinnt ab da gegen
WebUntis. **Für alle Wochen**, nicht nur die gerade sichtbare: der Plan hängt am Wochentag, nicht
am Datum. „WebUntis wieder übernehmen" macht es rückgängig.

Die Notiz zur Stunde lässt sich immer bearbeiten, auch ohne Ersetzen.

### Kursnamen und -farben, jeder für sich

**Profil → Deine Kurse** listet alles, was im eigenen Plan vorkommt — selbst eingetragen wie aus
WebUntis. Heißt ein Kurs bei der Schule `G2_DE`, kann man ihm hier

- einen eigenen **Namen** geben („Deutsch GK"),
- ein eigenes **Kürzel** für die kompakte Ansicht („DEU" statt „G2"),
- und eine eigene **Farbe**.

Von der Farbe zählen **Ton und Sättigung**: Grau bleibt grau, Blasses blass, Kräftiges kräftig.
Die **Helligkeit** kommt bewusst vom Design — sie hält den Plan im Hell- wie im Dunkelmodus
lesbar, und Dunkelblau würde im Dunkelmodus sonst unsichtbar. Bis 1.6.0 zählte nur der Ton: Grau
wurde dadurch **rot** (ohne Buntanteil gibt es keinen Farbton, und der Rückfallwert 0 ist Rot),
und Pastellrosa, Dunkelrot und Signalrot waren im Plan dieselbe Farbe.

Alles gilt **nur für einen selbst** — Freunde sehen weiter das Original, und niemand kann anderen
den Plan verstellen. Ohne eigenes Kürzel leitet die App eines aus dem eigenen Namen ab, sonst
nimmt sie das der Schule. „Zurücksetzen" holt das Original zurück.

Dieselbe Liste füllt auch die Kursauswahl beim Eintragen von Hausaufgaben: **alle** eigenen Kurse,
nicht nur die der gerade angezeigten Woche.

### Das Profil ist in Reiter geteilt

Sechs Karten untereinander waren nicht mehr zu überblicken. Dieselbe Reiterleiste wie im
Admin-Bereich, und die zuletzt gewählte Gruppe wird gemerkt:

**Profil** (Bild, Banner, Name, Farbe, Emoji) · **Ansicht** (Navigation, Zeitstrich, Info-Zeichen,
Menü-Reihenfolge) · **Kurse** · **Nachrichten** (Push) · **Konto** (Passwort, Chat-Schlüssel,
WebUntis).

Die Einstellungen unter **Ansicht** speichern **beim Ändern**, ohne Knopf — wie die Push-Schalter.
Die **WebUntis-Anmeldung** steht unter *Profil*, wo man sie sucht.

Auf dem Handy passen weder die Navigation noch die Reiterzeile in die Breite. Dass es dort
weitergeht, sieht man jetzt: der Inhalt **verblasst** an der Seite, an der noch etwas liegt
(`scrollHinweis` in `kern.js` setzt die Klasse, `mask-image` macht den Verlauf). CSS allein kann
das nicht — „ist dieses Element scrollbar" ist keine Frage, die eine Regel beantworten kann, und
ein Verlauf, der immer da ist, verspräche auch dann etwas, wenn nichts mehr kommt. Beobachtet wird
mit einem `ResizeObserver`: eine Leiste in einem noch versteckten Panel ist null Pixel breit, und
ein einmaliger Blick nach dem Zeichnen fände dort nie etwas zu scrollen.
Karten, die sich selbst verstecken (WebUntis ohne Schlüssel, „Sieht doppelt aus" ohne Vorschläge),
bleiben davon unberührt: sie tragen zusätzlich `hidden`, deshalb blendet der Reiter mit einer
eigenen Klasse aus statt mit `hidden`.

### Bilder, Dateien und Emoji im Chat

Neben dem Eingabefeld stehen zwei Knöpfe: **😊** öffnet die Emoji-Auswahl, **📎** hängt ein Bild
oder eine Datei an.

- **Jedes Emoji**, nicht eine gepflegte Auswahl: die Zeichen entstehen aus den Unicode-Blöcken und
  werden mit `\p{Extended_Pictographic}` gefiltert (`public/emoji.js`, rund 1000 Stück in sieben
  Gruppen). Was das Gerät nicht darstellen kann, zeigt es als Kästchen — der Preis dafür, alles
  anzubieten. Die zuletzt benutzten stehen oben.
- **Bilder werden im Browser verkleinert**, bevor sie irgendwohin gehen: längste Kante 1600 Pixel,
  JPEG-Qualität 0,82. Ein Handyfoto schrumpft dabei um den Faktor zehn — in der Leitung wie in der
  Datenbank. Kleine Bilder bleiben unangetastet; neu zu kodieren macht sie oft nur größer.
- **Verschlüsselt wie der Text**: die Bytes gehen durch denselben Paar-Schlüssel. Für einen Anhang
  gibt es **keinen Klartext-Rückfall** — ein Bild im Klartext auf dem Server wäre das Gegenteil
  dessen, was der Chat verspricht. Ohne Schlüssel auf beiden Seiten sagt die App das und schickt
  nichts.
- **Name und Typ stehen im verschlüsselten Text**, nicht an der Datei: der Server soll nicht
  wissen, dass jemand `Abi-Zulassung.pdf` verschickt hat. Er kennt nur die Größe.
- Ein **Bild** erscheint direkt (unter 400 KB), eine **Datei** bleibt ein Knopf — damit niemand
  ungefragt Megabytes durch sein Mobilfunknetz zieht. Grenze: 8 MB.

**Mehrere Dateien auf einmal** gehen: je Datei entsteht eine eigene Nachricht, der Begleittext
hängt an der ersten. Bewusst keine n:1-Beziehung — `messages ↔ chat_files` bleibt 1:1, und auf dem
Bildschirm sieht es aus wie überall sonst.

### Gruppenchats

Anlegen darf **jeder**. Wer dazugeholt wird, bekommt eine **Anfrage** und entscheidet selbst —
niemand findet sich ungefragt in einer Gruppe wieder. Verwaltet wird nach **Admin-Prinzip**: wer
anlegt, ist Admin; nur Admins laden ein, entfernen und ernennen weitere Admins. Jeder kann selbst
gehen. Geht der letzte Admin, **rückt das dienstälteste Mitglied nach** — sonst wäre die Gruppe
eingefroren; geht der Letzte, verschwindet sie samt Nachrichten.

**Verschlüsselt bleibt verschlüsselt**, ohne neues Verfahren: die Gruppe hat einen AES-Schlüssel,
und der liegt für **jedes Mitglied einzeln verpackt** (mit dem Paar-Geheimnis aus dem Einzelchat).
Wer einlädt, verpackt — dafür braucht er den *öffentlichen* Schlüssel des Eingeladenen, weshalb
`/api/keys/:id` jetzt auch „gemeinsame Gruppe" als Grund gelten lässt, nicht nur Freundschaft. Vor
der Zusage bekommt der Eingeladene **keinen** Schlüssel und **keine** Nachricht zu sehen; lehnt er
ab, wird die Zeile samt verpacktem Schlüssel gelöscht.

> Wer später dazukommt, kann auch Älteres lesen — es ist ein Schlüssel je Gruppe. Und wer
> entfernt wird, behält den Schlüssel, kommt aber nicht mehr an die Nachrichten: der Server gibt
> sie ihm nicht mehr heraus.

### Umfragen

Frage und Antwortmöglichkeiten sind **verschlüsselt** wie jede Nachricht. Der Server bekommt nur
die *Anzahl* der Antworten — genug, um eine Stimme zu prüfen, zu wenig, um die Umfrage zu kennen.
Er sieht: *Nutzer 7 hat bei Nachricht 42 die Nummer 2 gewählt*; was „2" bedeutet, steht im
Chiffrat.

Eine Stimme je Person, Umentscheiden **ersetzt** sie. Die **Namen sind sichtbar** — in einer Klasse
will man ohnehin wissen, wer mitkommt.

### Chat-Suche

Zwei Suchen: **über der Liste** (chatübergreifend) und **im Gespräch** (die Lupe 🔍 in der
Kopfzeile: Treffer werden im Verlauf markiert, ‹ › springen dazwischen, Enter = älterer Treffer,
Esc schließt — gesucht wird im Text der Blasen, der ohnehin entschlüsselt im Browser steht).

Über der Chatliste ein Suchfeld. **Tippen filtert die Liste** nach Person oder Gruppe — sofort,
ohne Server. **Enter durchsucht die Nachrichten.** Das geht nur im Browser: die Nachrichten sind
Ende-zu-Ende verschlüsselt, der Server sieht Chiffrat. Der Browser holt dafür je Chat die letzten
300 Nachrichten (`?since=0&nurLesen=1` — die Suche darf keinen ungelesenen Zähler löschen),
entschlüsselt sie und sucht darin; Dateien zählen mit ihrem Namen, Umfragen mit ihrer Frage. Die
Treffer stehen mit Schnipsel in der Liste, ein Klick öffnet den Chat und springt zur Nachricht
(kurz eingerahmt). Bei vielen Chats dauert das ein paar Sekunden — der Fortschritt steht dabei.

### Die Schreibzeile: drei Punkte

Emoji, Anhang und Umfrage stehen hinter **⋯** — auf 375 Pixeln bliebe für das Eingabefeld sonst
nichts. Einheitlich auf allen Breiten: ein Codepfad statt zweier, und wer die App auf dem Handy
kennt, findet dasselbe Menü am Rechner wieder.

Der Anhang wird in **zwei Schritten** geschickt: erst die Datei, dann die Nachricht, die sie nennt.
Anders geht es nicht, denn die Nummer des Anhangs muss im verschlüsselten Text stehen. Bis dahin
hängt er an einer leeren Platzhalter-Nachricht, die beim Absenden verschwindet und die in keiner
Liste auftaucht.

> **Drei Fallen, die nur der Browser zeigt:**
> `String.fromCharCode(...bytes)` reicht für ein Chiffrat von ein paar hundert Zeichen und sprengt
> bei einem Bild den Aufrufstapel — base64 läuft jetzt stückweise. Eine Blob-URL im `onload`
> freizugeben klingt sparsam, macht das Bild aber zum kaputten Platzhalter, sobald Chrome es neu
> zeichnet; freigegeben wird beim Wechsel der Unterhaltung. Und die **CSP** erlaubte `blob:`
> nicht — ein blockiertes `<img>` bleibt einfach leer und meldet sich nur in der Konsole.

### Hausaufgaben/ToDo: vier Reiter

Der Menüpunkt heißt **Hausaufgaben/ToDo** und hat vier Reiter — **Hausaufgaben** (wie gehabt),
**ToDo** (als Board), **Kalender** und **Nachrichten**. Kein neuer Menüpunkt, kein zweiter Ort
für dasselbe.

Am Reiter steht die Zahl der **offenen Hausaufgaben** — nur, was ab heute fällig und nicht abgehakt
ist; Vergangenes zählt nicht mit, sonst stünde dort auf ewig eine Zahl, die niemand mehr
kleinkriegt. Abschaltbar unter Profil → Ansicht.

### Nachrichten der Schule

Was die Schule veröffentlicht, steht im Reiter **Nachrichten** — Hinweise zum Planbau, gesperrte
Räume, was eben auf der Heute-Seite von WebUntis unter **„Nachrichten zum Tag"** erscheint, und
dazu der **RSS-Feed** der Schule (das RSS-Zeichen neben diesen Nachrichten).

Beides holt der Abgleich, **höchstens stündlich je Schule** — Nachrichten sind schulweit, einer
holt sie, alle sehen sie:

- **Nachrichten zum Tag**: `GET /WebUntis/api/public/news/newsWidgetData?date=JJJJMMTT`, dieselbe
  Anfrage, die die Heute-Seite stellt, für heute und die sechs Tage danach (eine Nachricht gilt
  oft für mehrere Tage). Die Antwort nennt auch die **Adresse des Feeds** (`rssUrl`) — die merkt
  sich die Schule beim ersten Fund, niemand muss sie suchen.
- **Der Feed** (`rss.js`, ohne Fremdpaket wie `ical.js`): `<item>` mit Titel, Text, Link, Datum
  und Kennung; CDATA und Entities werden aufgelöst, HTML wird zu Zeilen, Links bleiben als
  `[Text](Adresse)` erhalten und sind in der App klickbar. Ein leerer Kanal ist ein leerer Kanal,
  kaputtes XML eine leere Liste.
- Geholt wird mit derselben Sperre wie bei Kalender-Abos: nur https, keine Adresse ins interne
  Netz. Unter **Admin → System → Nachrichten der Schule** lässt sich die Feed-Adresse der
  Standardschule von Hand setzen, falls WebUntis sie nicht meldet.

Gespeichert wird mit Nachziehen: eine geänderte Nachricht wird übernommen, eine gelöschte bleibt
stehen — ein Feed vergisst alte Einträge, die App nicht. Gezeigt werden die letzten 60 Tage,
neueste zuerst, mit Plakette *WebUntis* oder *RSS*.

> Keine rote Zahl und kein Push für Nachrichten: ein Feed ohne Einträge (so sah das Beispiel aus)
> soll nicht erst einmal bei allen leuchten. Lässt sich anhängen, wenn es gebraucht wird.

### Kalender

Eine Ansicht, mehrere Ebenen: eigene Termine, **Prüfungen**, **Hausaufgaben** (als ganztägige
Einträge), abonnierte Kalender und der **schulweite** vom Admin. Jede Ebene hat ihre Farbe, jede
lässt sich für sich ausblenden — beides gilt nur für den, der es einstellt.

| | |
|---|---|
| **Eigene Kalender** | Jeder bekommt beim ersten Blick „Mein Kalender". Weitere lassen sich anlegen, umbenennen, einfärben |
| **Schulweit** | Legt der Admin an (`user_id IS NULL`): Schulfest, Zeugnisausgabe. Sehen alle, schreiben darf nur er |
| **Teilen** | Mit Freunden, wie überall in der App — wahlweise nur lesen. Dasselbe Fenster wie beim Projekt unter ToDo |
| **Abonnieren** | Ein fremder iCal-Link (Familie, Verein, Nextcloud) wird stündlich geholt. Ersetzt wird nur, was aus dem Abo stammt; von Hand angelegte Termine im selben Kalender bleiben unangetastet |
| **Aufs Handy** | Ein geheimer Abo-Link (`/kal/<token>.ics`) ohne Anmeldung — iPhone, Google und Outlook können ihn abonnieren. Nur lesend; wer ihn hat, sieht die Termine, deshalb steht ein „Neu würfeln" daneben |

`ical.js` schreibt und liest das Format selbst — kein Fremdpaket, wie überall hier. Gelesen werden
`VEVENT` samt `RRULE` (täglich, wöchentlich mit `BYDAY`, monatlich, jährlich, mit `INTERVAL`,
`COUNT`, `UNTIL`) und `EXDATE`; Zeilen werden entfaltet, `\n` und Semikolons entkommen. Was nicht
verstanden wird (VTODO, `RECURRENCE-ID`-Ausnahmen, exotische Zeitzonen), fällt weg statt geraten zu
werden — ein erfundener Termin wäre schlimmer als ein fehlender.

> Zeiten sind „schwebend": geschrieben wird ohne Zeitzone, gelesen wird alles als Ortszeit (ein
> angehängtes `Z` wird umgerechnet). Für eine Schule in **einer** Zeitzone ist das richtig; eine
> vollständige VTIMEZONE-Behandlung wäre ein Vielfaches an Code für einen Fall, den es hier nicht
> gibt.

**Abrufe an fremde Adressen** (Abos, IServ) laufen über dieselbe Sperre in `netz.js`: nur https,
keine IP-Adressen, kein `localhost`, und der Name wird aufgelöst, bevor der Server hingeht — sonst
wäre das Eingabefeld ein Anfrage-Generator ins eigene Netz.

### Prüfungen

Zwei Quellen, ein Ort:

- **Aus WebUntis** — der Prüfungskalender der Schule, geholt wie die Lehrer-Hausaufgaben (erst
  REST, sonst JSON-RPC). Gibt die Schule ihn Schülerkonten nicht heraus, bleibt die Ebene leer und
  der Abgleich läuft trotzdem.
- **Selbst eingetragen, aus dem Stundenplan heraus** — im Detailfenster einer Stunde steht
  „+ Prüfung eintragen": Titel, Tag und **von welcher bis zu welcher Stunde**. Eine Klausur geht
  selten nur eine Schulstunde, also markiert sie **alle** belegten Zellen im Plan. Die Uhrzeiten
  rechnet der Server aus dem Stundenraster der eigenen Schule — dadurch steht sie im Kalender und
  im Handy-Abo zur richtigen Zeit.

Eigene Prüfungen sind **privat**: im Plan eines Freundes stehen sie nicht, solange der Kalender
nicht geteilt ist — **es sei denn, der Haken „für den ganzen Kurs sichtbar" ist gesetzt**. Dann
sieht sie jeder, der den Kurs **in dieser Stunde** hat (dieselbe Regel wie bei Hausaufgaben:
Kurs + Wochentag + Stundenbereich, `kursPruefungen` in `index.js`), im Plan mit gelbem Rahmen
und im Kalender als Ebene „Prüfungen (Kurs)" mit dem Namen dessen, der sie eingetragen hat — nur
ansehen, nicht ändern. Der Haken lässt sich nachträglich setzen und nehmen; ohne Kurs (freier
Termin) gibt es ihn nicht, denn niemand wüsste, wer es sehen soll.

**Erinnerung vorher.** Im Profil unter *Nachrichten* steht „Vor Prüfungen: erinnere mich N Tage
vorher" (Vorgabe 7, 0 = nie); jede Prüfung kann das im Termin überschreiben („Erinnern: … Tage
vorher", leer = wie im Profil). Der Zehn-Minuten-Takt (`pruefungsErinnerungen`) geht durch alles,
was einer im Kalender sieht — eigene, geteilte, Kurs- und Schulprüfungen —, und meldet jede genau
einmal (`pruefung_erinnert`), sobald der Tag erreicht ist; Vergangenes nie. Die Meldungsart heißt
*Prüfungen* und ist wie die anderen im Profil regelbar.

**Kalenderfilter.** Über dem Monat eine Chipzeile: *Alle · Hausaufgaben · Prüfungen · Termine ·
Ferien* — rein in der Anzeige, gemerkt wie der Reiter. Der Abo-Link fürs Handy bleibt ungefiltert.

**Ändern aus der Stunde.** Eigene Prüfungen haben im Stundenfenster neben „×" ein „Ändern" —
dasselbe Fenster wie beim Eintragen; Raum und Notiz stehen dort und in der Stunde.

**Monat: Wischen, Heute, Text, Liste, Ferien.**
- Der Monat wechselt **per Wischen** wie die Woche im Plan, mit derselben kurzen Bewegung.
- Die blaue Markierung gehört zum Tag, nicht zum Monat: liegt heute im Monat, ist heute gewählt,
  sonst **kein** Tag — früher sprang sie auf den 1. und blieb dort. Ohne gewählten Tag steht unten
  **„Termine im Oktober"**, der ganze Monat nach Tagen; ein zweiter Tipp auf den gewählten Tag hebt
  die Wahl auf.
- Auf den Kacheln stehen die **Titel** (bis zu drei, mit Farbbalken, „+N" für den Rest) statt
  Punkten. Am Handy kleiner: alle sechs Wochen auf einen Blick, zwei Titel je Tag — und die
  globale Tabellen-Mindestbreite des Stundenplans (48 rem) gilt hier nicht mehr, sie hatte den
  Monat breiter als den Bildschirm gemacht.
- **Monat · Liste**: die Ereignis-Ansicht zeigt alle Einträge des Monats als Liste nach Tagen, mit
  Ändern/×, Filter gilt mit.
- **Ferien & Feiertage** der eigenen Schule (aus WebUntis) sind eine Ebene mit eigener Farbe —
  unter „Kalender & Farben" abschaltbar (`kalender_farben.ohne`), im Abo-Link mit dabei.

### ToDo: Projekte und Boards

```
Projekt (todo_ordner)          ← beliebig verschachtelt
  └─ Kategorie (todo_bereiche) ← eine Etage über den Spalten
      └─ Spalte (todo_spalten) ← die Kanban-Spalte
          └─ Aufgabe (todos)
```

Ein neues Projekt bringt drei Spalten mit (Offen · Dran · Fertig) — ein leeres Brett sagt niemandem,
was es sein will. Eine Aufgabe hat wahlweise Frist, Erinnerung, Zuständigkeit, Wichtigkeit, eine
**Wiederholung** und ein „erst zeigen ab".

- **Wiederkehrend**: Abhaken erledigt nicht, sondern rückt zum nächsten Termin — gerechnet vom
  **alten** Termin, sonst wandert der Rhythmus. Monatsenden korrekt (31.01. + 1 Monat → 28.02.),
  und nach langer Abwesenheit wird gleich der nächste *zukünftige* Termin genommen.
- **Geparkt** (`sichtbar_ab` in der Zukunft): die Aufgabe existiert, ist im Board ausgeblendet,
  „Geplante zeigen" holt sie hervor.
- **Erledigt-Regel** je Projekt: liegen lassen · in eine Spalte schieben · löschen. Die Rückfrage
  kommt beim **Einstellen**, nicht bei jedem Haken.
- **Geerbte Freigabe** wird bei jedem Lesen gerechnet, nicht beim Teilen kopiert: ein Unterprojekt,
  das später entsteht, ist automatisch mitgeteilt. Eine direkte Freigabe schlägt die geerbte.
- **Löschen ohne Datenverlust**: Unterprojekte rücken eine Ebene hoch, statt mitzugehen.
- **Zuständig** kann nur werden, wer das Projekt überhaupt sieht.

**Aufgeteilt wie ein VNW-Workspace**: links der Projektbaum („Eigene Aufgaben" zuerst, darunter die
Projekte mit der Zahl ihrer offenen Aufgaben), rechts das Board des gewählten Projekts. In der
Kopfzeile stehen nur **„+ Aufgabe"** und ein **⋯-Menü** — alles Seltene (Spalten, Kategorien,
Erledigt-Regel, Teilen, Unterprojekt, Umbenennen, Löschen, „Geplante/Erledigte zeigen") steckt
dort. Die Karten tragen die Wichtigkeit als Farbkante links; auf dem Handy wird aus dem Baum eine
Zeile mit Chips über dem Board.

Verschoben wird per Ziehen (am Rechner) **und** über die Aufgabe selbst — auf dem Handy ist das der
Weg, der funktioniert. Die Spalten stehen in einem **Raster**: am Rechner drei nebeneinander,
die vierte darunter; auf schmaleren Bildschirmen zwei, auf dem Handy alle untereinander — Spalten
nach rechts schieben war das, was störte.

> Aus der VNW-Vorlage nicht übernommen: Rollen und Berechtigungen, Webhooks, MCP-Werkzeuge und das
> Archivieren. Die App kennt Nutzer, Admin und Freundschaft — mehr braucht sie nicht.

### ToDo-Listen, auch geteilt

ToDos lassen sich in **Listen** legen, und eine Liste kann man mit Freunden **teilen**. Dann sehen
alle Beteiligten dieselben Punkte, tragen ein, ändern und haken ab — und das **Abhaken gilt für
alle**. Eine geteilte Liste, an der jeder für sich abhakt, wäre keine Liste, sondern fünf.

> Bei **Hausaufgaben** ist es genau umgekehrt: dort hakt jeder für sich ab. Eine Hausaufgabe macht
> jeder selbst; eine Einkaufsliste für die Kursfahrt nicht.

**Geteilt wird in einem Fenster** mit Suchfeld: oben, wer die Liste schon hat (mit „Entfernen"),
darunter die übrigen Freunde (mit „Hinzufügen"), Enter nimmt den ersten Treffer. Bis 2.2.0 war das
ein `prompt` mit durchnummerierten Namen — und das **Zurücknehmen** konnte der Server zwar
(`DELETE /api/todo-ordner/:id/teilen/:wen`), in der Oberfläche gab es dafür aber keinen Weg.

Umbenennen und Löschen bleiben beim Besitzer (Löschen nimmt die ToDos mit); wer geteilt bekommen
hat, kann sich selbst herausnehmen. **Erinnerungen gehen an alle**, die die Liste haben — sonst
wäre das Teilen halb: gemeinsam eintragen, aber nur einer wird erinnert.

### Freunde im Stundenfenster, Abmeldungen der Freunde

Wer im Stundenfenster unter „Freunde in dieser Stunde" oder „Haben auch frei" steht, ist
**anklickbar** — ein Klick öffnet seinen Stundenplan in derselben Woche; „Mein Stundenplan" führt
zurück.

Unter **Abmeldung** steht neben der eigenen Liste die Karte **„Abgemeldete Freunde"**: wer aus dem
Freundeskreis wann fehlt, als **Spannen** — „Do 17.09. – Sa 19.09. · 3 Tage · ganzer Tag",
„Mo 21.09. · 1.–2. Stunde", heute Laufendes mit Plakette „jetzt", Klick führt zum Plan.
`GET /api/friends/absences` fasst die Tageszeilen der Tabelle je Freund zusammen (aufeinander
folgende Tage mit gleichem Stundenbereich und Grund), ab heute bis +60 Tage, nur Freunde.

**Grund.** Eine Abmeldung kann einen Grund tragen („krank", „Arzttermin") — Vorgabe **nur für
mich**; mit dem Haken *„Grund für Freunde sichtbar"* sehen ihn Freunde in der Karte und in der
Stunde (`absences.grund`, `grund_sichtbar`; ohne Grund ist der Haken nichts). Die eigene Liste
blendet **Vergangenes aus**, bis man „Vergangene anzeigen" anhakt. Im Stundenfenster steht bei
einem abgemeldeten Freund **bis wann**: „abgemeldet bis Fr 19.09. · krank" — der letzte Tag der
zusammenhängenden Abmeldung, dafür schaut `/api/timetable` 60 Tage über die Woche hinaus.

### Nächste Prüfungen im Hausaufgaben-Reiter

Am Rechner war rechts neben der Liste Platz — dort steht jetzt die Karte **„Nächste Prüfungen"**
(eigene, Kurs und Schule, 60 Tage voraus, aus dem Kalender): Farbstrich, Titel, „in N Tagen ·
Mo 21.09.", Stundenbereich, Herkunft; Klick wechselt in den Kalender. Auf dem Handy steht die Karte
unter der Liste.

## Neu in 3.1.0

**Prüfung statt Ausfall.** Reicht eine Klausur in eine Stunde hinein, deren eigentlicher Unterricht
deshalb ausfällt, stand bisher der durchgestrichene Ausfall im Plan.
- **Ursache:** Je Slot zeigt die App eine WebUntis-Stunde, und es gewann stur die letzte.
- **Jetzt:** Es gewinnt nach Rang: Prüfung (JSON-RPC `lstype: 'ex'`, REST-Zellzustand `EXAM`) vor
  stattfindend vor ausgefallen. Bei gleichem Rang bleibt es die letzte.
- Die Meldungen sind davon unberührt, sie laufen seit 3.0.2 je Kurs.

**Ein Kasten um die ganze Prüfung.** Eine Prüfung über mehrere Stunden hat einen gelben Rahmen um
den ganzen Block statt einen je Stunde. Das gilt eckig und rund, in Standard, Kompakt und im
WebUntis-Stil.

**Ausfall deutlicher.** Ausfälle sehen aus wie „Vertretung ohne Lehrer“: rot hinterlegt, dicker
gestrichelter Balken, kompakt mit ⊘. Dazu sind sie durchgestrichen. Profil › Ansicht › „Ausfall im
Plan: Klassisch“ holt den alten dünnen Strich zurück.

**Keine Meldungen für entfernte Stunden.**
- Wer eine WebUntis-Stunde dauerhaft entfernt hat, bekommt dazu keine Meldung mehr. Auch die
  gesammelte Abendmeldung lässt sie weg.
- Hat jemand eine Stunde durch einen anderen Kurs ersetzt, meldet nur noch dieser Kurs. Wer bei
  Religion/Ethik den eigenen gewählt hat, hört nur noch von seinem.

**Prüfungen aus WebUntis nur auf Knopfdruck.**
- Profil › Kurse › „Prüfungen aus WebUntis“ › „Jetzt importieren“ übernimmt sie in den eigenen
  Kalender. Dort lassen sie sich ändern und löschen wie selbst eingetragene.
- Gelöschte kommen beim nächsten Import nicht wieder. Wer sie doch will, setzt den Haken „Auch
  gelöschte holen“.
- **Schon selbst eingetragen** heißt: gleicher Tag und überschneidende Stunden (sonst Uhrzeit, sonst
  das Fach im Titel bzw. Kurs). Dann entscheidet die Einstellung daneben:
  - „Meine behalten“ (Vorgabe);
  - „Die von WebUntis nehmen“: übernimmt Titel und Zeit. Notiz und Erinnerung bleiben.
- Ein erneuter Import zieht bei schon übernommenen Prüfungen nur das **Wann** nach. Eigene Titel und
  Notizen bleiben.
- Die alten, automatisch gefüllten Kalender „Prüfungen (Schule)“ werden beim ersten Start einmal
  übernommen (ohne Doppelte) und dann gelöscht.
- Nebenbei behoben: Der automatische Abgleich legte diese Prüfungen alle zehn Minuten neu an. Die
  Erinnerung „Prüfung in X Tagen“ hängt an der ID und konnte deshalb wiederholt kommen.

**Tickets ohne VNW (für das Open-Source-Release).**
- Neben VNW gibt es jetzt Tickets „in der App“: Gemeldet wird wie bisher unter „Vorschläge & Bugs“
  (Arten „Vorschlag“ und „Fehler“), beantwortet wird im Admin-Bereich unter **Tickets › Postfach**:
  - lesen, antworten, Status setzen (offen, in Bearbeitung, geschlossen);
  - ● zeigt, was auf eine Antwort wartet;
  - die Admins bekommen eine Meldung zu jedem neuen Ticket und jeder Rückfrage, der Melder zu jeder
    Antwort und jedem neuen Status.
- **Wohin neue Tickets gehen**, steht in derselben Gruppe:
  - Admin › Tickets › „Neue Tickets landen: hier in der App / in VNW“ (`PUT /api/tickets/ziel`).
  - Ohne Einstellung gilt: VNW, wenn es eingerichtet ist, sonst die App.
  - **Bestehende Installationen mit VNW ändern sich durch das Update also nicht.**
- Jedes Ticket weiß selbst, wohin es gehört (mit `vnw_id` VNW, ohne die App). Umschalten nimmt
  keinem alten Ticket etwas weg.
- Ein geschlossenes App-Ticket, das der Melder aus seiner Liste nimmt, bleibt im Postfach.
- Die VNW-Karte ist von „System“ in die neue Gruppe „Tickets“ gewandert.

**Zugangsdaten nur für mich verschlüsseln (Profil › Konto, Vorgabe aus).**
- **Wie es funktioniert:**
  - Aus dem Passwort entsteht beim Anmelden ein Schlüssel K: `scrypt` mit eigenem Salz.
  - K verschlüsselt das WebUntis- bzw. IServ-Passwort (`u1:` + AES-256-GCM).
  - K liegt nie in der Datenbank, nur verpackt in der eigenen Sitzung. Verpackt ist er mit einem
    Schlüssel aus dem Cookie-Token, von dem der Server nur den Hash kennt.
  - Ohne eine Anfrage des Nutzers kommt also niemand an die Zugangsdaten: kein Admin, keine
    Sicherung, kein Server-Schlüssel.
- **Der Preis**, im Profil vor dem Einschalten als Warnung zu lesen:
  - Abgeglichen wird nur, während man die App benutzt. Meldungen zu Ausfall & Co. kommen dann erst
    beim Öffnen.
  - Andere Geräte brauchen einmal ein neues Anmelden.
  - Setzt ein Admin das Passwort zurück, sind die Zugangsdaten weg. Beim normalen Passwort-Ändern
    werden sie mit dem neuen Passwort neu verschlüsselt und bleiben.
- Ausschalten packt sie wieder mit dem Server-Schlüssel ein.

**Aus den Tickets:**
- **Prüfungen verschwinden nach ihrem Ende.** In „Nächste Prüfungen“ und im Widget stand eine
  Prüfung von heute bis Mitternacht. Jetzt gilt: mit Uhrzeit bis zu ihrem Ende, ganztags bis zum
  Ende des Tages (`pruefungVorbei` im Server, dieselbe Regel im Client).
- **Mehrere Zuständige, auch ohne Konto.** Eine Aufgabe im Projektboard lässt sich mehreren
  Mitgliedern zuweisen (Haken mit Gesicht) und dazu Namen ohne Konto, z. B. „Lisa, Herr Maier“. Die
  Namen sind nur zur Übersicht und bekommen nichts mit.
  - Die Karte zeigt bis zu drei Gesichter (danach +n) und die freien Namen.
  - Gespeichert wird in `todo_zustaendige` (`user_id` oder `name`). Die alte Einzel-Zuweisung
    `todos.zustaendig_id` wird beim ersten Start einmal übernommen.
  - `zustaendig_id` geht als alter Weg weiter.
- **Es zählt nur, was mich betrifft.** Die rote Zahl am Reiter zählt eine Projektaufgabe nur noch,
  wenn sie niemandem zugewiesen ist oder mir. Was nur anderen oder nur Namen ohne Konto gehört,
  zählt nicht.
  - Aus demselben Grund erinnert eine fällige Aufgabe nur ihre Zuständigen mit Konto. Ohne
    Zuständige erinnert sie wie bisher alle im Projekt.

**Prüfung (Funktion, Performance, Sicherheit):**
- 189 Tests grün. Neu getestet: Rang im Slot, entfernte und ersetzte Stunden samt Abendvorschau,
  Import mit beiden Regeln, Löschen, Nachziehen, Übernahme der alten Kalender, App-Tickets von
  Melden bis Schließen, die Verschlüsselung mit Sitzung, neuem Gerät, Passwortwechsel, Reset und
  Ausschalten.
- Abgleich eines Halbjahres (1360 Stunden, davon 340 doppelt): etwa 16 ms.
- Im Browser geprüft auf 375 px und am Desktop: Plan, Profil und Postfach.
- Nebenbei einen älteren Test repariert, der an einem festen Datum hing und dadurch von selbst
  kippte.

## Neu in 3.0.2

**Meldungen zu Ausfall, Vertretung und Raumänderung kommen wieder.** Der Fix aus 3.0.1 hat zu viel
weggenommen.
- **Ursache**: 3.0.1 hat je Slot nur noch die *letzte* Stunde verglichen (die angezeigte). Wer
  parallele Kurse hat (Religion/Ethik, Wahlpflicht, Oberstufe), dessen eigene Stunde steht oft
  nicht hinten. Ihr Ausfall, ihre Vertretung und ihr Raumwechsel wurden deshalb verschluckt.
  Nebenbei wurden die Kurse der vorderen Stunden nicht mehr angelegt.
- **Fix**: `untis_lessons.stand` (neue Spalte) hält den Vergleichsstand **aller** Stunden des Slots,
  als JSON je kanonischer Kurs-ID. Jede Stunde wird mit ihrem eigenen Vorstand verglichen, also mit
  demselben Kurs im selben Slot. Kurs A gegen Kurs B gibt es nicht mehr, und keine Stunde bleibt
  unbeobachtet. Angezeigt wird weiter die letzte, der Plan ändert sich nicht.
- **Sonderfälle**:
  - Derselbe Kurs zweimal im Slot (Ausfall plus Ersatz mit derselben Kursnummer) ergibt eine
    Vertretung, keinen zusätzlichen Ausfall.
  - War vorher genau eine Stunde da und ist es jetzt auch, nur mit anderem Kurs, heißt die Meldung
    weiter „Anderer Kurs“.
  - Zeilen von vor dem Update kennen nur die angezeigte Stunde. Für die parallelen Kurse wird beim
    ersten Abgleich nur gemerkt und nichts gemeldet. So kommt nach dem Update kein Schwall längst
    bekannter Ausfälle.
- Die 14-Tage-Sperre gegen doppelte Meldungen (`ref`) enthält jetzt den Kurs. Sonst hätte sie den
  Ausfall des zweiten Kurses im selben Slot geschluckt.
- **Performance**: ein Halbjahr mit 1360 Stunden, davon 340 doppelt belegt. Jeder Abgleich dauert
  etwa 30 ms (3.0.1: 40 ms), weil die Abfragen je Stunde jetzt über `sql()` wiederverwendet werden.
  Ein Ausfall im vorderen Kurs ergibt genau eine Meldung, auch über drei Abgleiche.

**Notizen live (SSE).** Wer Büro › Notizen offen hat, sieht Änderungen anderer sofort, ohne
Neuladen.
- **Server**: `GET /api/notizen/live` liefert `text/event-stream`. Gemeldet wird nur, *dass* sich
  etwas geändert hat (`event: notizen`, `data: {"id": …}`, bei Ordnern `null`). Den Inhalt holt der
  Client über die normalen Routen, mit deren Rechteprüfung.
- **Empfänger**: Vor jeder Meldung werden die verbundenen Nutzer mit derselben Rolle geprüft wie
  beim Abrufen (`notizRolle`/`ordnerRolle`). Wer die Änderung selbst gemacht hat, bekommt keine
  Meldung.
  - Bei Verschieben, Freigabe und Löschen bekommen auch die eine Meldung, die den Zugriff eben
    verloren haben. So verschwindet die Notiz auch aus ihrer Liste.
- **Ausgelöst von**: Notiz anlegen, ändern, anheften, archivieren und löschen; Todo; Kommentar;
  Ordner; Freigabe von Notiz oder Ordner.
- **Client**:
  - Die Liste lädt nach, ein fokussiertes Suchfeld behält dabei den Cursor.
  - Eine offene Notiz wird still neu gezeichnet. Wer gerade tippt, wird nicht überfahren und
    bekommt stattdessen die Leiste „Diese Notiz wurde gerade woanders geändert. [Neu laden]“ (mit
    Rückfrage, wenn Ungespeichertes verloren ginge).
  - Meldungen innerhalb von 300 ms werden zu einem Neuladen gesammelt. Nach einem Abriss (Funkloch)
    wird einmal alles geholt.
  - Beim Verlassen des Reiters oder der Ansicht wird die Leitung geschlossen.
- **Grenzen und Sicherheit**:
  - Höchstens 5 Leitungen je Nutzer und 1000 insgesamt, darüber 429. Nur angemeldet.
  - Ping alle 25 s, `X-Accel-Buffering: no` für nginx.
  - Eine Anfrage, die schon während der Middleware abgebrochen wurde, wird nicht mehr gezählt.
    Vorher blieb sie als Leiche stehen und sperrte nach fünf den Nutzer.
- **Performance**: Ohne offene Leitungen kostet es nichts. Mit 300 offenen (davon 20 berechtigten)
  dauert ein Speichern 18 statt 2 ms. Es kamen genau die 1000 erwarteten Meldungen an (50 Änderungen
  an 20 Berechtigte).
- Gleichzeitiges Speichern: Es gewinnt weiter die letzte Änderung. Die Leiste warnt davor.

**Ordner teilen = alles darin teilen.** Die Freigabe eines Ordners gilt für alle Notizen darin,
auch für Unterordner und für alles, was später dazukommt.
- Wer eine Notiz aus dem Ordner herausverschiebt, teilt sie nicht mehr, außer sie ist direkt
  geteilt.
- Über einen Kurs geteilt heißt immer „nur lesen“.
- Das Teilen-Fenster eines Ordners sagt das jetzt auch.

## Neu in 3.0.1

**Falsche Meldungen „Raumänderung“ behoben.** Viele bekamen alle zehn Minuten eine Raumänderung,
obwohl sich im Plan nichts änderte.
- **Ursache**: WebUntis schickt oft mehrere Stunden für denselben Slot, zum Beispiel bei
  Religion/Ethik, Wahlpflicht ohne Kurszuordnung oder bei Ausfall plus Ersatz. Gespeichert wird
  eine davon (die letzte). Verglichen wurde aber jede einzeln mit dem gespeicherten Stand. Das
  ergab bei jedem Abgleich „Raum: B104 → A213“, während der Plan unverändert die gespeicherte
  Stunde zeigte. Ausfall und Vertretung konnten genauso kreisen.
- **Fix** in `stundenSchreiben` (index.js), gilt für WebUntis und IServ:
  - **Eine Stunde je Slot.** Vor dem Vergleich wird auf die Stunde reduziert, die auch
    gespeichert wird. Die Anzeige bleibt dieselbe.
  - **Jede Meldung nur einmal.** Jede Plan-Meldung trägt
    `ref = lage:<datum>|<stunde>|<art>|<text>`. Dieselbe geht höchstens einmal in 14 Tagen hinaus
    (Index `notifications(user_id, ref)`). Das fängt auch Hinweistexte ab, die bei einem
    gescheiterten Abruf kurz fehlten und dann als „neu“ wiederkamen.
  - **Kurs-Schreibweise.** Verglichen wird mit der gespeicherten Schreibweise der Kurs-ID, sonst
    hieß Groß/Klein jedes Mal „Anderer Kurs“.
  - **Aufgeräumt.** Beim ersten Start wird von angestauten gleichen wartenden Meldungen nur eine
    behalten (für „gesammelt“ und „Vorlauf“).
  - **Test und Messung.** Ein Test gleicht mehrfach mit doppelt belegten Slots, echten
    Änderungen, anderer Schreibweise und flackerndem Hinweis ab. Gemessen: ein Halbjahr mit
    1360 Stunden, davon 340 doppelt belegt, braucht etwa 40 ms je Abgleich und erzeugt keine
    Meldung.

**Oberfläche**, jeweils auch auf dem Handy geprüft:
- **Stunden-Fenster**:
  - Die Erklärung „Diese Stunde kommt aus WebUntis …“ steht hinter einem **ⓘ** neben
    „Dauerhaft ersetzen“ und klappt beim Antippen auf.
  - „Freunde in dieser Stunde“ und „Haben auch frei“ sind kompakter: eine Zeile je Person, der
    Grund („Englisch ohne Lehrer“) klein unter dem Namen, „Plan ›“ rechts daneben.
- **ToDo**: Der **⋯**-Knopf steht direkt neben der Suche. Auf dem Handy stehen Suche und ⋯ in der
  zweiten Zeile, „+ Aufgabe“ oben rechts.
- **Nächste Prüfungen**: Das **×** steht neben „Ändern“ oben rechts statt allein in einer eigenen
  Zeile. Die Spalte ist etwas breiter (22rem).

## Neu in 3.0: das Büro

Ein neuer Reiter **Büro** mit vier Unterreitern: **Notizen · Ideen · Abstimmungen · Umfragen**. Die
Module kommen aus der VNW-Plattform, aber zugeschnitten auf diese App: kein Rechtesystem mit Rollen,
sondern **Besitzer**, **ausgewählte Freunde** und **alle mit einem meiner Kurse** (wer den Kurs im
Stundenplan hat). Die ganze Schule gibt es als Publikum bewusst nicht. Keine Live-Verbindung, neu
geladen wird beim Öffnen. Meldungen laufen über eine eigene Push-Art **„büro“**, die im Profil
einstellbar ist. Der Server-Teil steht in `buero.js`, die Oberfläche in `public/buero.js` und
`public/umfragen.js`, das gemeinsame Teilen-Fenster in `public/freigabe.js`. Die Regeln für Umfragen
(Fragetypen, Prüfung, k-means, CSV) stehen in `public/umfrage-logik.js`, das der Server **genauso
lädt**, damit sie nicht zweimal verschieden dastehen.

**Freigabe** (`buero_freigabe`, eine Zeile je Freund `u:<id>` oder Kurs `k:<kurs>`): gespeichert
wird immer der ganze Stand (`PUT /api/buero/:art/:id/freigabe`). Freunde darf man nur freigeben,
wenn man mit ihnen befreundet ist, Kurse nur, wenn man sie selbst hat. Wer neu dazukommt, bekommt
eine Meldung.

- **Notizen**: Titel, Markdown-Text (mit Vorschau), Farbe, Tags, Ordner (verschachtelt),
  Anheften, Archiv, je Notiz eine Todo-Liste und Kommentare, Suche und Tag-Filter. Freunde
  bekommen die Rolle *lesen* oder *bearbeiten*, ein Kurs liest mit. Ein geteilter Ordner teilt
  alles darin, auch Unterordner. Einen Ordner zu löschen verliert nichts: die Notizen liegen danach
  ohne Ordner, Unterordner rücken hoch. Löschen lässt sich rückgängig machen, samt Todo-Liste.
- **Ideenbaum**: ein Baum aus Überschriften, Ideen und Aufgaben. Das **Team** (Besitzer plus
  Freunde mit Rolle *Team*) postet direkt, gibt frei und lehnt ab. Wer nur mitmacht, landet je
  nach Modus (*offen / moderiert / streng*) in der Warteschlange; eine Ast-Regel (*erbt / immer /
  nie*) geht vor. Ablehnen braucht eine Begründung: der Vorschlag verschwindet samt Unterbaum, und
  der Vorschlagende sieht die Begründung. **Sperren** öffnet die Abstimmung (ja / nein /
  Enthaltung, eine Stimme je Person) für alle freigegebenen Ideen, die nicht ausgenommen sind.
  Kommentare haben eine Antwortebene. Frühere Fassungen lassen sich zurückholen. Querverbindungen
  erscheinen als gestrichelte Linien über dem Baum.
- **Abstimmungen**: 2–20 Antworten, eine oder mehrere (mit Obergrenze). Die Namen sind *sichtbar*,
  *anonym* oder *jeder entscheidet selbst*. Ende offen, nach Dauer oder zu einem Datum. Das Ergebnis
  gibt es live oder erst am Ende, für alle oder nur für mich. Abstimmen ersetzt die alte Stimme, und
  man kann sie zurückziehen. Nach der ersten Stimme sind die Antworten fest (409). **Schließen**
  ohne festes Ende heißt: noch 24 Stunden. **Wieder öffnen** geht.
- **Umfragen**:
  - **Fragetypen**: alle **acht** aus VNW, also Einfachauswahl, Mehrfachauswahl, Punkte verteilen,
    Freitext, Kurztext, Schieberegler, mehrere Regler und 2D-Regler.
  - **Aufbau**: Abschnitte, Pflichtfragen, Entwurf / offen / beendet, Duplizieren, Zurücksetzen.
  - **Nach den ersten Antworten**: Texte lassen sich ändern und Neues kommt dazu. Typ wechseln,
    Antworten entfernen und Grenzen ändern ist gesperrt (409).
  - **Identität**: *anonym* (niemand sieht, wer was geantwortet hat) oder *mit Namen*. Der Wechsel
    von *mit Namen* zu *anonym* löscht die Zuordnung wirklich. Der umgekehrte Weg geht nur ohne
    Antworten.
  - **Verschlüsselt**: Die Antworten liegen AES-verschlüsselt in der Datenbank (derselbe Schlüssel
    wie die WebUntis-Passwörter). Erkannt wird die eigene Antwort über einen HMAC-Schlüssel, nicht
    über die Person.
  - **Gäste** ohne Konto füllen per Link `/umfrage/<key>` aus. Ihre Kennung ist ein Zufallswert
    im Browser, der Server kennt sie nur gehasht. Mit derselben Kennung können sie ihre Antwort
    ändern oder zurückziehen. Ein neuer Link macht den alten ungültig.
  - **Auswertung** (im Browser, aus Antworten ohne Identität):
    - Übersicht mit SVG-Diagrammen je Typ
    - Kreuztabelle und Untergruppe gegen alle
    - Personengruppen: k-means über die Regler-Werte, deterministisch, 3–5 Gruppen, mit
      Radar-Diagramm
    - CSV-Export mit Schutz gegen Formeln

**Was bewusst fehlt** (gegenüber VNW): Rollen und Rechte, Live-Updates, öffentliche Links für
Notizen und Ideen, Einmal-Codes für Abstimmungen, Mehrsprachigkeit und E-Mail-Bestätigung bei
Umfragen (der Stundenplan verschickt keine Mails), Kategorien und Tags bei Abstimmungen und Umfragen.

### Wer darf was (CRUD im Büro)

| Ding | Anlegen | Lesen | Ändern | Löschen |
|---|---|---|---|---|
| Notiz | jeder (eigene) | Besitzer, Freigabe, Kurs, Ordner-Freigabe | Besitzer, Freigabe *bearbeiten* | Besitzer |
| Notiz-Ordner | jeder (eigene) | Besitzer, Freigabe | Besitzer | Besitzer (Inhalt bleibt) |
| Notiz-Todo | wer bearbeiten darf | wer liest | wer bearbeiten darf | wer bearbeiten darf |
| Notiz-Kommentar | wer liest | wer liest | – | Autor, Besitzer |
| Ideenbaum | jeder | Besitzer, Freigabe, Kurs | Besitzer | Besitzer |
| Idee | wer mitmacht (ggf. Warteschlange) | alle Beteiligten (Wartendes: Team + Vorschlagender) | Vorschlagender, Team | Vorschlagender, Team |
| Verbindung | Vorschlagender der Quelle, Team | alle Beteiligten | – | Team, Vorschlagender der Quelle |
| Ideen-Kommentar | alle Beteiligten | alle Beteiligten | – | Autor, Team |
| Abstimmung | jeder | Besitzer, Freigabe, Kurs | Besitzer (Antworten nur vor der 1. Stimme) | Besitzer |
| Stimme | Teilnehmer (solange sie läuft) | nach Ergebnis-Regel | Teilnehmer (neu abstimmen) | Teilnehmer (zurückziehen) |
| Umfrage / Abschnitt / Frage | Besitzer | Besitzer; Teilnehmer ab „offen“ | Besitzer (nach Antworten eingeschränkt) | Besitzer (Frage nur ohne Antworten) |
| Antwort | Teilnehmer, Gast per Link | Besitzer, Teilnehmer nach Ergebnis-Regel (ohne Identität) | Absender (außer *mehrfach*) | Absender, Besitzer |

Jede Zeile ist in `test.js` als Test abgedeckt (Besitzer, Freund, Kursmitglied, Fremder).

### Einladungslink

Unter Admin → Nutzer → Registrierung steht im Modus „Nur mit Key“ ein **Einladungslink**
`/registrieren?key=<key>` zum Kopieren oder Teilen. Er nimmt den **gespeicherten** Key, es wird
nichts neu erzeugt. Er ist **beliebig oft verwendbar**, bis der Key geändert wird. Wer ihn öffnet,
landet direkt auf „Neues Konto“ mit eingetragenem Key; der Key verschwindet sofort aus der Adresse.

### Kalender-Abo: Auswahl und Samsung

Das Abo gibt es jetzt **getrennt**, gewählt über Häkchen im Fenster „Kalender & Farben“. Mehrere
Abos nebeneinander gehen, etwa eins nur für Prüfungen und eins nur für Hausaufgaben.

- Adresse: `/kal/<token>/<auswahl>.ics`, die Auswahl steht im Pfad. Sie ist `alles` oder eine
  Kombination aus `pruefungen`, `hausaufgaben`, `termine`, `ferien`, zum Beispiel
  `pruefungen-hausaufgaben.ics`.
- Der alte Link `/kal/<token>.ics` liefert weiter alles.
- Erledigte Hausaufgaben fallen im Abo weg.
- Die Datei nennt die Zeitzone (`X-WR-TIMEZONE`, `VTIMEZONE` Europe/Berlin, `TZID` an jeder
  Uhrzeit). Ohne sie hat Google die Termine um ein bis zwei Stunden verschoben.

**Samsung Kalender** kann Adressen nicht selbst abonnieren. Deshalb gibt es den Knopf „In Google
Kalender hinzufügen“: ist das Google-Konto im Samsung Kalender aktiv, erscheint das Abo dort von
allein. iPhone und Outlook bekommen einen `webcal://`-Link.

### Kleinkram in 3.0

- Prüfungen stehen jetzt auch im **Plan eines Freundes**, mit Stunde, Raum und Notiz. Ändern kann
  sie nur, wem sie gehören. Seine übrigen Termine bleiben privat.
- „5. Stunde“ statt „5.–5. Stunde“ überall (`stunden()` in `kern.js`).
- ToDo: Das Suchfeld steht links beim Titel, „+ Aufgabe“ ganz rechts, auf dem Handy in eigener
  Zeile. Vorher tippten manche die neue Aufgabe ins Suchfeld.
- Tickets: Pflicht ist nur der Titel, die Beschreibung ist optional.
- Freundschaften können nicht mehr doppelt entstehen (Anfrage in Gegenrichtung zu einer
  bestehenden Freundschaft: 409). Alte doppelte Zeilen stehen trotzdem nur einmal in der Liste.
- Der Hash zum Öffnen einer Ansicht (`#chat` …) bleibt stehen, solange noch niemand angemeldet
  ist. Er wirkt dann nach dem Login.

### Neues Design und neues Menü

- **Design „Modern“** ist die Vorgabe: runde Karten ohne Rand, weiche Schatten, eine Kopfzeile aus
  Glas und größere Tippflächen (mindestens 40 px). Fenster fahren sanft ein. Hell und dunkel
  folgen dem Gerät. Unter Profil → Ansicht → **Design der App** gibt es weiter **„Klassisch“**,
  das alte Aussehen. Gespeichert wird das in `users.design` und im Browser (`localStorage`), damit
  schon der Login-Bildschirm stimmt. Das CSS für „Modern“ steht als eigener Block
  `[data-design="modern"]` am Ende von `style.css` und überschreibt nur. Klassisch bleibt
  unverändert.
- **Form der Stunden** im Plan: **eckig** ist die Vorgabe, in beiden Designs. Unter Profil → Ansicht
  → „Form der Stunden“ lässt sich **abgerundet** wählen, dann sind die Stunden Kacheln mit etwas
  Abstand (`users.stunden_form`, `#grid.rund`). Das gilt auch für die Karten im WebUntis-Stil.
- **Handy** (unter 700 px, Modern): Das Menü wird zur **Leiste unten** mit Piktogramm und
  Beschriftung. Sie ist fest angedockt und blickdicht, der Inhalt endet darüber und läuft nicht
  sichtbar darunter durch. Sie beachtet den Rand von iPhones (Safe-Area). Meldungen erscheinen
  darüber.
- **„Stundenplan“ oben links** ist ein Knopf und führt zum eigenen Plan, auch aus dem Plan eines
  Freundes heraus.
- **Ausloggen** steht nicht mehr in der Kopfzeile, sondern unter **Profil → Konto**. Beim
  Ausloggen vergisst der Browser auch, was er sich für diesen Nutzer gemerkt hat: die zuletzt
  offene Seite, Filter und die Abo-Auswahl.
- **Piktogramme** an allen Menüpunkten (Leiste, Untermenü, Seitenmenü).
- **Vorgabe-Menü**: oben nur der Alltag, **Plan · ToDo & Prüfungen · Vorschläge & Bugs**. Dazu
  kommt immer **☰** (drei Striche). Es öffnet ein **Seitenmenü**, das von rechts hereinfährt, mit
  allen Hauptpunkten. Ein **Pfeil** klappt die Unterpunkte auf und zu. Der Punkt, auf dem man
  steht, ist schon aufgeklappt. Die rote Zahl am ☰ zählt alles, was nicht in der Leiste steht,
  eine Freundschaftsanfrage sieht man also trotzdem.
- „Profil“ steht nicht mehr in der Leiste, dafür reicht der eigene Name oben rechts. Im
  Seitenmenü ist es weiter da.
- Wer früher selbst sortiert hat (`nav_order`) oder ein eigenes Menü gebaut hat, behält es. Eigene
  Gruppen klappen jetzt als kleines Menü unter dem Knopf auf (Popover).

### Kurschat

Im Chat gibt es neben **Direkt** und **Gruppen** den Reiter **Kurs**. Jeder Kurs im eigenen Plan hat
einen Chat, befreundet muss man dafür nicht sein. Im Menü heißt er „Kurschats“ (`chat/kurs`).

- **Wer liest mit**: alle, die den Kurs **in derselben Stunde** haben, nach derselben Regel wie bei
  den Hausaufgaben. Jede Nachricht speichert die Stunden, in denen der Absender den Kurs beim Senden
  hatte (`messages.kurs_id`, `messages.kurs_slots`). Sichtbar ist sie für jeden, der den Kurs jetzt
  in einer dieser Stunden hat.
  - Zwei Jahrgänge mit gleicher Kurs-ID bleiben getrennt.
  - Wer neu dazukommt, sieht den Verlauf, zählt ihn aber nicht als ungelesen.
  - Wer den Kurs verlässt, nimmt seine Nachrichten nicht mit.
  - Die **Mitgliederliste** im Chat zeigt, wer dabei ist.
- **Verschlüsselung**: nicht Ende-zu-Ende. Die Mitglieder wechseln und kennen sich nicht, deshalb
  ließe sich kein gemeinsamer Schlüssel verteilen. Text und Anhänge liegen **serverseitig
  verschlüsselt** in der Datenbank (AES, derselbe Schlüssel wie bei den WebUntis-Passwörtern). Im
  Chat steht das als Hinweis.
- **Können**: Text, Bilder und Dateien, Umfragen, Suche (auch über die Chatliste), eigene
  Nachrichten löschen, Mitglieder, stummschalten.
- **Meldungen**: eigene Art **„Kurschat“** im Profil, Vorgabe **gesammelt** (einmal am Tag statt
  bei jeder Nachricht). Je Kurs wartet höchstens eine Meldung, ohne Inhalt. Stummgeschaltete Kurse
  melden nichts und zählen nicht in der roten Zahl am Menü.
- **Routen**:
  - `GET /api/kurschats` (Liste mit Vorschau und ungelesen)
  - `GET/POST /api/kurschats/:kurs`
  - `POST /api/kurschats/:kurs/datei`
  - `GET /api/kurschats/:kurs/mitglieder`
  - `PUT /api/kurschats/:kurs/stumm`
  - `DELETE /api/kurschats/nachricht/:id`
  - Anhänge und Umfrage-Stimmen laufen über die bestehenden Routen, mit Prüfung der Sichtbarkeit.
- **Bekannte Grenze**: Wer sich einen Kurs selbst in den Plan einträgt, liest mit, wie bei den
  Hausaufgaben. Die Mitgliederliste macht das sichtbar. Löschen kann man nur die eigenen
  Nachrichten, eine Moderation durch Admins gibt es nicht.

**Check nach dem Einbau**
- **Funktion**: im Browser durchgeklickt, mit einem Nicht-Freund als Gegenüber.
  - Senden, Empfangen, Bild, Umfrage mit Stimme des anderen, Löschen, Mitglieder, Stumm, Suche.
  - Rote Zahl am ☰, bei „Chat“ und „Kurschats“.
  - Handy-Breite ohne Überlauf, der Zurück-Knopf und der Wechsel zwischen den drei Reitern.
- **Sicherheit**:
  - Fremde und der andere Jahrgang bekommen 404 bzw. sehen nichts, auch bei Anhängen und Stimmen.
  - In der Datenbank steht kein Klartext.
  - Die Push-Meldung verrät keinen Inhalt.
  - Text kommt nur über `textContent` in die Seite.
  - Gebremst: 60 Nachrichten je Viertelstunde.
  - **Gefunden und behoben**: Eine präparierte Nachricht (Umfrage-Zahl mit Datei-Text) legte die
    Anzeige des ganzen Chats lahm. Der Server prüft jetzt den Aufbau von Umfragen und Anhängen,
    und der Browser zeichnet nur Stimmiges. Das gilt auch für Direkt und Gruppen.
- **Performance**: gemessen mit 10 Kursen × 2000 Nachrichten und 30 Mitgliedern.
  - Liste 4 ms, Verlauf (300 Nachrichten) 9 ms, 5-Sekunden-Abruf 2 ms, Senden samt Meldungen 3 ms.
  - **Gefunden und behoben**:
    - Viel Verkehr eines anderen Jahrgangs mit gleicher Kurs-ID hätte den eigenen Verlauf
      verdrängt, weil erst nach dem LIMIT gefiltert wurde. Jetzt filtert die SQL-Abfrage vorher.
    - Die Kurs-Spalten wurden ohne Index gelesen, weil sie NOCASE verglichen werden. Die Indizes
      `entries_kurs_nc` und `untis_kurs_nc` sind NOCASE.
  - Nebenbei behoben: „Aufräumen“ unlesbarer Nachrichten in einer Gruppe traf den Direktchat mit
    einem Freund gleicher Nummer. Es gibt es jetzt nur noch im Direktchat.

### Umfragen repariert

- **„+ Umfrage“ tat nichts**: Der Titel kam aus `window.prompt`, und das liefert im Android-WebView
  still `null`. Deshalb gibt es jetzt überall eigene Fenster statt `prompt`/`confirm`
  (`bestaetigen`, `eingabe` in `kern.js`, alle 51 Stellen). Ein Test sorgt dafür, dass keins
  zurückkommt.
- **Freitext kam nie an**: Das Feld wurde beim Bauen überschrieben, und eine Pflicht-Textfrage ließ
  sich nicht absenden.
- **Antworten ändern** vergab doppelte IDs, wenn man eine Antwort einfügte oder löschte. Dann
  wanderten Stimmen zu einer anderen Option. Zugeordnet wird jetzt erst über den Text, dann über
  die Position (`zeilenMitIds`).
- **↑/↓** tauscht nur innerhalb des Abschnitts.
- **CSV** kommt als Datei vom Server (`GET /api/umfragen/:id/csv`). Der `blob:`-Download ging in
  der App nicht.
- **Punkte** wieder auf 0 gestellt heißt „nicht beantwortet“. Vorher kam „falsche Summe“.
- **Mehrere Regler** zählen erst als beantwortet, wenn man sie bewegt. Nicht bewegte zeigen „–“,
  und der Fehler steht direkt an der Frage.
- **Diagramme** sind HTML statt SVG: Die Schrift ist am Handy lesbar, und im Dunkelmodus sind die
  Zahlen sichtbar.
- „Kopieren“ zeigt ohne Zwischenablage ein Fenster mit markiertem Link, statt stumm zu bleiben.
- Gäste sind je Minute gebremst (20 Antworten je IP). Eine Klasse im Schul-WLAN hat eine IP.
- Eine halb ausgefüllte Umfrage wird nach einem Update nicht neu geladen.

### Funktionsprüfung vor 3.0

Jede Funktion wurde einmal im Browser durchgeklickt, zum Teil mit einem zweiten Nutzer. Behoben
wurde, was nicht so funktionierte wie gedacht:

- **Rückfragen hintereinander** (erst „Zurücksetzen?“, dann „Neues Passwort“): Das zweite
  Fenster ging sofort wieder zu, weil das verspätete Schließen-Signal des ersten es traf. Das
  betraf zum Beispiel „Passwort zurücksetzen“ im Admin-Bereich.
- **Lösch-Rückfragen** zeigen jetzt einen roten Knopf mit dem Verb („Löschen“, „Entfernen“,
  „Zurücksetzen“) statt „OK“.
- **Freund entfernen** ging sofort und ohne Rückweg. Jetzt kommt vorher eine Rückfrage.
- **Notizen**: Ungespeicherte Änderungen am Text gingen verloren, sobald man anheftete, ein Todo
  oder einen Kommentar hinzufügte. Sie bleiben jetzt erhalten. „← Zurück“ fragt, bevor
  Ungespeichertes verworfen wird. Archivieren speichert vorher.
- **Umfrage-Einstellungen**: Ein geänderter Titel ging verloren, wenn man danach z. B. den
  Gast-Link erzeugte. Er wird jetzt vorher mitgespeichert. Die anonyme CSV hat keine leere
  Zeit-Spalte mehr.
- **Hausaufgabe in einer vergangenen Stunde**: Sie bekam das vergangene Datum als Fälligkeit und
  verschwand sofort wieder, obwohl „eingetragen“ gemeldet wurde. Für vergangene Tage gibt es das
  Feld nicht mehr, dafür einen Hinweis. Ein leeres „Eintragen“ setzt den Cursor ins Feld.
- **Plan**: Das Entfernen einer Stunde meldet jetzt „Stunde entfernt“ statt „Stunde
  gespeichert“. „+ Prüfung eintragen“ öffnet ein Fenster mit dem Titel „Neue Prüfung“. Ein
  leerer eigener Plan zeigt einen Hinweis, wie er sich füllt (+ oder WebUntis).
- **Chat**: Beim Wechsel zwischen „Direkt“ und „Gruppen“ blieb der andere Chat offen. Auf dem
  Handy war die Gruppenliste dadurch gar nicht zu sehen. Die Meldung beim Einladen eines Freundes
  ohne Chat-Schlüssel erklärt jetzt, was zu tun ist.
- **Abmeldung**: Beim Bearbeiten gibt es jetzt „Abbrechen“.
- **Ideenbaum**: Der Knopf heißt fürs Team „Hinzufügen“ statt „Vorschlagen“, denn das Team postet
  direkt.
- **Listen im Büro** (Notizen, Ideenbäume, Umfragen) zeigen Auszüge ohne Markdown-Zeichen, also
  nicht mehr „**fett**“.
- **Menü zurücksetzen** fragt vorher nach, statt ein selbst gebautes Menü sofort zu verwerfen.
- **Handy**: Der Avatar oben rechts war ein leerer Farbkreis, weil der Anfangsbuchstabe mit
  ausgeblendet wurde. Tags und Ordner bei Notizen sowie die Farbfelder unter Ansicht haben
  fingerbreite Tippflächen. Die Balken-Diagramme der Umfragen sind am Handy lesbar und im
  Dunkelmodus sichtbar.
- Ein neuer Nutzer landete nach dem Registrieren auf der zuletzt offenen Seite des vorigen
  Nutzers dieses Geräts (siehe Ausloggen oben).

Geprüft und in Ordnung: Woche blättern, Kompakt, Stunden eintragen, Raumplan, Plan eines Freundes;
Hausaufgaben anlegen, ändern, abhaken, Erinnerung, löschen, Rückgängig, Suche; ToDos und Projekte
mit Board, Spalten, Teilen und Löschen; Kalender mit Terminen, Filtern und dem getrennten Abo;
Nachrichten; Chat; Freunde mit Anfrage, Annehmen, Ablehnen und der roten Zahl; Abmeldung;
Notizen, Ideenbaum mit Warteschlange und Abstimmung, Abstimmungen und Umfragen samt Gast-Link und
CSV; Profil, Bilder, Kurse, Benachrichtigungen, Passwort, Menü-Baukasten; alle Admin-Reiter mit
Nutzern, Stammdaten, Texten und Sicherung; Login, falsches Passwort, Registrierung per
Einladungslink, `/datenschutz`. Tickets brauchen eine VNW-Anbindung. Sie sind über die
automatischen Tests mit einem nachgebauten VNW abgedeckt.

### Sicherheits- und Performance-Prüfung (3.0)

**Sicherheit** (jeweils mit Test):

- **Abstimmung**: Nach der ersten Stimme lassen sich Namen und Ergebnis nur noch strenger
  stellen (409). Vorher konnte man eine anonyme Abstimmung nachträglich öffentlich machen.
- **Weiterleitungen**: Kalender-Abo und RSS folgen Weiterleitungen nur noch nach erneuter Prüfung
  jedes Ziels (`holeGeprueft` in `netz.js`). Vorher kam man per 302 an `127.0.0.1`.
- **Adressprüfung** mit `net.BlockList`. Sie erkennt auch in IPv6 verpackte IPv4-Adressen
  (`::ffff:10.0.0.1`), NAT64, Multicast und 198.18/15.
- **Kurs** heißt jetzt: derselbe Kurs **in derselben Stunde**. Das gilt für Büro-Freigaben und für
  die Meldung „Neue Hausaufgabe“. Ein anderer Jahrgang mit gleicher Kurs-ID liest nicht mehr mit.
  „Für den ganzen Kurs“ bei Prüfungen geht nur mit einem eigenen Kurs.
- **Anonyme Umfragen**: Der Schlüssel der eigenen Antwort hängt an einem Zufallsgeheimnis je
  Nutzer (verschlüsselt in `users.umfrage_geheim`), nicht an der Nutzer-ID. Die Auswertung
  kommt ohne Zeilen-ID und Uhrzeit und in zufälliger Reihenfolge. Gelöscht wird über die
  öffentliche Kennung.
- **Bremsen** auch für Freundschaftsanfragen, Gruppen-Einladungen, neue Kalender, Passwort ändern,
  Freigaben und Hausaufgaben. Erfolgreiche Registrierungen zählen mit (60 je Viertelstunde und IP,
  über `REG_MAX` änderbar).
- Die **Abo-Adresse** eines geteilten oder schulweiten Kalenders sieht nur der Besitzer.
- Liegengebliebene **Chat-Anhänge**, die nie abgeschickt wurden, werden nach einer Stunde gelöscht.
- **Chat-Anhänge** öffnen sich nur als Bild, wenn sie PNG/JPEG/GIF/WebP/AVIF sind. Alles andere
  wird heruntergeladen.
- **Ideen**: Ohne Team-Rolle löscht man keine Unter-Ideen anderer mit (409).
- **HSTS** über https. Änderungen von einer fremden Seite (`Sec-Fetch-Site: cross-site`) werden
  abgewiesen.
- **Anmeldung**: gleiche Laufzeit mit und ohne Nutzer. Ein Admin mit dem Standard-Passwort `admin`
  bekommt nach dem Login einen Hinweis.
- Nebenbei behoben: Gruppen-Anhänge konnten andere Mitglieder nicht öffnen (404), und Anhänge über
  1 MB in Gruppen scheiterten (413).

**Bewusst nicht geändert**:

- `trust proxy` bleibt 1: VNW steht hinter einem Proxy, sonst hinge jede IP-Bremse an dessen IP.
- `admin/admin` bei der Erstinstallation ohne `ADMIN_PW` bleibt. Ein Startabbruch wäre auf VNW
  schlimmer. Dafür gibt es den Hinweis nach dem Login.
- Die scrypt-Stärke bleibt, weil eine Erhöhung alle Passwörter neu hashen müsste.

**Performance**:

- SQLite läuft im **WAL**-Modus mit `synchronous=NORMAL`. Schleifen, die viel schreiben, laufen in
  einer Transaktion (`transaktion()` in `db.js`).
- Jede Anfrage lud bisher Avatar und Banner (bis 500 KB) mit, weil `auth` `SELECT *` las. Jetzt
  steht dort nur, ob es sie gibt. Bilder haben eine Version in der Adresse (`?v=`) und bleiben im
  Browser-Cache.
- Die **Chatliste** (alle 30 s) holt nur noch die letzte Nachricht je Freund statt des ganzen
  Verlaufs. Rund 25 neue **Indizes** kamen dazu (Chat, Gruppen, Freunde, Hausaufgaben, Kurse,
  Kalender, Büro).
- Prüfungs-Erinnerungen fragen im 10-Minuten-Takt nur noch Prüfungen ab. Zugestellte Meldungen
  verschwinden nach 30 Tagen. Notizen zählen ihre Todos in einer Abfrage.
- Der Service Worker legt nur erfolgreiche Antworten in den Cache.
- Die Kompression (gzip) übernimmt am besten der VNW-Proxy, dafür gibt es keine neue Abhängigkeit.

### ToDo: Fenster, Zahl, Aufräumen

Das **Aufgaben-Fenster** zeigt nur das Nötige — Was, im Board Spalte und Zuständig, Fällig am.
Erinnerung, Wichtigkeit, Wiederholen und Parken stecken hinter einem `<details>` „Mehr", das beim
Ändern offen ist, sobald eins davon gesetzt ist. Wiederholen ohne Fälligkeit geht seit 2.12 (ab
heute 08:00).

Die **rote Zahl** zählt seit 2.14 **alle offenen ToDos** (nicht geparkte), nicht nur fällige — die
Leute lasen „nur fällige" als „kein Punkt".

**Erledigte** lassen sich ansehen („Erledigte zeigen", wird jetzt gemerkt) und im Punkte-Menü **auf
einmal löschen** (`DELETE /api/todos/erledigt?ordner=…`, endgültig, ohne Rückgängig — wer das
wählt, will Platz). Und sie verschwinden **von selbst**: `users.todo_loeschen_tage` (Vorgabe 30,
0 = nie), `todos.done_at` merkt sich den Haken; `todosAufraeumen()` läuft mit den anderen Sweeps
und nimmt nur eigene lose Aufgaben und eigene Projekte — in einem fremden Board räumt dessen
Besitzer nach seiner Frist auf. Vor 2.14 abgehakte ToDos haben kein `done_at`; dann zählt das
Anlegedatum.

### Raumplan: Treppen über Etagen, Etagen umsortieren

Eine Treppe musste auf jeder Etage einzeln gezeichnet werden — auf dem 2. OG fehlte sie dann.
Jetzt hat ein Treppenfeld **`hoch`**: über so viele Etagen reicht es nach oben (Editor: „bis
2. OG"). `felderAuf(plan, e)` liefert die Felder einer Etage samt der Kopien durchgehender Treppen
tieferer Etagen (gestrichelt, `T1 · von EG`, in beide Richtungen offen — die Richtung gilt nur, wo
die Treppe gezeichnet ist). Gezählt wird in Etagen, nicht Namen: Etagen lassen sich im Editor mit
◀ ▶ **umsortieren**, und die Treppen folgen der Reihenfolge — so ist es physisch.

Der **Weg** springt von einer Treppe nur zur **nächsten** Etage darüber oder darunter, die sie hat:
EG → 1. OG → 2. OG statt EG → 2. OG. Ein alter Plan mit Treppe nur im EG und 2. OG bleibt
verbunden (ein Sprung). Der Pfeil im Plan zeigt ↑ oder ↓.

### Rückgängig – kurz, nicht für immer

Fast jede Aktion lässt sich **30 Sekunden lang** zurücknehmen: über den Knopf „Rückgängig" in der
Meldung oder mit **Strg+Z** (⌘Z). Stunde gesetzt, entfernt oder WebUntis wieder übernommen; Notiz;
Prüfung und Termin angelegt, geändert, gelöscht; Hausaufgabe eingetragen, geändert, gelöscht,
abgehakt; ToDo angelegt, geändert, verschoben, gelöscht, abgehakt; Abmeldung eingetragen oder
zurückgenommen; Kursname und -farbe; ein gemeldetes Ticket. Die Rückfragen vor dem Löschen
(„wirklich?") sind dafür weg — Rückgängig ist die bessere Rückfrage.

Danach ist der Eintrag weg: wer eine Stunde später Strg+Z drückt, erwartet nicht, dass eine längst
vergessene Hausaufgabe wieder auftaucht. Im Textfeld macht der Browser sein eigenes Undo; da
mischt sich die App nicht ein. Kein Redo.

Technisch ist das ein Stapel in `kern.js` (`rueckgaengig(text, mach)`): jede Stelle gibt die
**Umkehrung** als Funktion mit — die alten Werte kennt nur sie. Gelöschtes wird **neu angelegt**
und bekommt eine neue ID; eine wiederhergestellte Hausaufgabe geht mit `leise: true` hinaus, damit
der Kurs nicht ein zweites Mal benachrichtigt wird (die Haken der anderen sind allerdings weg).
Nicht rückgängig: Freundschaften, Projekte und Spalten, ganze Kalender, Chat-Nachrichten,
Ticket-Antworten.

### Meldungen stapeln sich

Mehrere Meldungen kurz nacheinander überschrieben sich früher. Jetzt ist `#toasts` ein Behälter
(weiter als `popover="manual"` im Top-Layer, also über jedem Fenster) mit einer Meldung je
Element: neue erscheinen **oben**, verschwindet eine, klappt sie zusammen (`height` → 0 per
Transition) und die darüber rutschen nach. Höchstens fünf; jede hat ihr eigenes ×; die Meldung
mit „Rückgängig" bleibt mindestens sechs Sekunden, damit man den Knopf erwischt.

### Suche in Hausaufgaben, ToDos und Abmeldungen

Drei Suchfelder, die das zuletzt Geholte filtern — Text, Fach und Name bei Hausaufgaben, der
Text bei ToDos, Wochentag, Datum und Grund bei Abmeldungen. Kein Server-Aufruf je Tastendruck.

### Entwürfe merken auch die Auswahl

`entwurf()` versteht jetzt `<select>` und Kontrollkästchen (die sind nie „leer", also zählt der
Entwurf dort immer) und mit `immer` auch vorbelegte Felder. Damit bleibt beim Ticket die **Art**
(„Bug-Report" stand sonst wieder da) und die Felder des Typs erhalten, beim Termin Beginn, Ende,
Ort und Notiz, bei der Aufgabe die Fälligkeit. `entwurfWeg('termin')` räumt alles darunter mit
ab.

### Ticket zurückziehen

Solange **niemand geantwortet** hat, lässt sich ein Ticket zurückziehen — in der Liste und im
Ticket selbst, und als Rückgängig direkt nach dem Melden. Das löscht es **bei VNW** (über die
gespeicherte `vnw_id`) und dann hier. Dafür braucht das Token der App das Recht **`tickets.close`**;
fehlt es, sagt die Meldung genau das. Sobald das Team geantwortet hat, ist es dessen Vorgang:
dann bleibt es stehen, bis es abgeschlossen ist (409), und verschwindet danach nur aus der eigenen
Liste, wie bisher.

### Rote Zahlen: Freunde, Hausaufgaben und ToDos

Der Reiter **Freunde** zeigt offene Anfragen an dich. **Hausaufgaben/ToDo** zeigt die Summe aus
offenen Hausaufgaben (ab heute, wie bisher) und **fälligen oder überfälligen ToDos** (nicht
geparkte, mit Fälligkeit bis heute — „das muss jetzt weg", nicht „so viel steht irgendwann an");
die Unterreiter tragen die beiden Zahlen einzeln. `GET /api/homework/offen` liefert
`{ n, hausaufgaben, todos }`. Gemalt wird zentral (`malBadges()` in `menue.js`) an jede Stelle,
die eine Seite zeigt — auch eine Gruppe im eigenen Menü zeigt die Summe ihrer Kinder.

### Die Woche bleibt beim Planwechsel

Wer im Plan eines Freundes zwei Wochen vorgeblättert hat, sieht beim Zurückwechseln dieselbe
Woche — zum Vergleichen. Nur „Heute" und die Anmeldung setzen auf die aktuelle Woche zurück.

### Neue Schul-Nachrichten beim Öffnen

Gibt es seit dem letzten Öffnen neue Nachrichten der Schule (WebUntis „Nachrichten zum Tag", RSS),
erscheinen sie einmal als Fenster. Gemerkt wird die höchste gesehene `nachrichten.id` je Nutzer
(`users.nachrichten_gesehen`, `POST /api/me/nachrichten-gelesen`) — beim ersten Öffnen still, sonst
bekäme jeder 60 Tage alte Nachrichten nachgereicht. Gemerkt wird beim Zeigen, nicht beim
Schließen: ein Fenster, das wiederkommt, wäre genau das Falsche.

### Das eigene Menü

Profil → **Menü**: die obere Leiste baut sich jeder selbst — aus **Seiten** (die Ansichten und
ihre Unterreiter, etwa der Kalender) und **Gruppen** mit Seiten darin, eine Ebene tief. Eine
Gruppe ist ein Knopf oben; ihre Seiten stehen in einer zweiten Zeile darunter. Seiten lassen sich
sortieren, in Gruppen stecken und wieder herausholen; Unterreiter können als eigener Punkt nach
oben. Das Menü von vorher ist die Vorgabe (`nav_order` bleibt als Vorgabe erhalten),
„Zurücksetzen" holt es zurück. Knöpfe statt Ziehen — das geht auf dem Handy und mit Tastatur.

Gespeichert wird als JSON in `users.menue`; der Server (`SEITEN`, `menue(u)` in `index.js`) lässt
nur bekannte Seiten durch, wirft Doppeltes weg, hält Admin-Seiten von Nicht-Admins fern und
behält leere Gruppen (im Editor legt man erst die Gruppe an). Im Browser baut `menue.js` die
Leiste; `show(view, sub)` setzt den Unterreiter über kleine Setter (`hwReiterSetzen` …). Die
eingebauten Unterreiter-Leisten der Ansichten bleiben, wie sie sind. Das Profil ist immer über
den Namen oben rechts erreichbar — auch ohne Menüpunkt.

### Layout

Die eigenen Abmeldungen und die Hausaufgaben-Liste stehen in eigenen Karten („Meine Abmeldungen",
„Deine Hausaufgaben"), mit Abstand zu den Nachbarn — vorher hingen sie lose unter dem Formular.

### Fenster und Meldungen

**Meldungen** (die Zeile unten) sind ein `popover="manual"`: das liegt im Top-Layer des Browsers,
also **über** jedem modalen Fenster. Mit `z-index` allein lag die Meldung hinter dem geblurrten
Hintergrund — ausgerechnet die Fehlermeldung zum Fenster, das man gerade offen hatte. Jede Meldung
hat ein **×**; Fehler bleiben stehen, bis man sie wegklickt, Erfolge verschwinden nach N Sekunden
(Profil → Ansicht → Fenster & Meldungen: Sekunden 1–30, „Fehler bleiben stehen" an/aus).

**Fenster** bekommen beim Öffnen ein **×** oben rechts, und ein Klick auf den Hintergrund
schließt sie (abschaltbar, Vorgabe an). Beides sitzt einmal in `kern.js` an `showModal` statt in
vierzehn Dialogen einzeln — viele bauen ihren Inhalt bei jedem Öffnen neu, da wäre ein Knopf im
Markup nach dem ersten `replaceChildren` weg. Der Hintergrund-Klick prüft das Rechteck des
Fensters, nicht nur das Ziel-Element: das Padding gehört zum `<dialog>` und zählt sonst als
„außen".

**Entwürfe.** Ein halb getippter Text überlebt den Ansichtswechsel — Ticket-Meldung und -Antwort
(die werden bei jedem Laden neu gebaut), die Chat-Eingabe **je Chat**, Titel eines neuen Termins
und Text einer neuen Aufgabe nach dem Schließen des Fensters. `entwurf(schlüssel, feld)` in
`kern.js` hängt sich an `input` und schreibt in `sessionStorage` — für die Sitzung, nicht für
immer; Absenden löscht ihn.

**Profil → Ansicht** ist in vier Karten gegliedert: Stundenplan, Hausaufgaben, Fenster &
Meldungen, Menü.

### Hausaufgaben: zwei Haken

„Erledigte anzeigen" zeigt Abgehaktes **ab heute**; **„Abgelaufene anzeigen"** holt die Tage vor
heute dazu — vorher standen alte Aufgaben zwischen dem, was wirklich ansteht. Beide Haken werden
gemerkt. In der Karte „Nächste Prüfungen" lassen sich eigene Prüfungen **ändern und löschen**, wie
im Kalender.

### ToDo ohne Frist, aber mit Wiederholung

„Erinnere mich wöchentlich" braucht keine Frist: ohne Fälligkeit zählt der Rhythmus **ab heute,
08:00 Uhr** — „alle 1 Woche" heißt nächste Woche um acht, danach wie jede wiederkehrende Aufgabe
(Abhaken schiebt vom alten Termin weiter). Früher wurde das abgelehnt.

### Abmeldung: halbe Tage, Bis-Datum, Ändern

Nur **„ab Stunde 5"** heißt: 5. bis letzte Stunde; nur **„bis Stunde 2"** heißt: 1. bis 2. —
vorher wurde ein fehlendes Feld still zum ganzen Tag. „Von" setzt „Bis" gleich mit. Jede eigene
Abmeldung hat **„Ändern"**: das Formular wird mit dem Tag befüllt, Speichern überschreibt ihn
(`POST` ist ein Upsert je Tag, kein neuer Endpunkt).

### Die Zahl am Reiter zieht sofort nach

Eintragen, Abhaken, Löschen — die rote Zahl am Reiter *Hausaufgaben/ToDo* wird direkt danach
aufgefrischt (`malHwBadge()` nach jeder Änderung), nicht erst beim nächsten 30-Sekunden-Takt.

### Erledigte Hausaufgaben im Plan

Abgehakt heißt normalerweise: das 📝 an der Stunde verschwindet. Wer es lieber behält, schaltet
unter Profil → Ansicht *„Erledigte Hausaufgaben im Plan weiter zeigen"* ein — dann bleibt das
Zeichen, ausgegraut (`hw_erledigt_zeigen`, Vorgabe aus). Die Erinnerung zur Hausaufgabe kommt
ohnehin, ob erledigt oder nicht: sie wird beim Eintragen geplant und beim Abhaken nicht
gelöscht. Der Zähler am Reiter zählt weiterhin nur Offenes.

### Raumplan

Ein Gebäudeplan je Schule, gebaut vom Admin (**Admin → Raumplan**): Etagen aus **Rechtecken auf
einem Kachelraster** — Räume, Flure, Treppen, Freizeitbereiche, Hof, Sport, Wände. Art wählen,
Rechteck mit der Maus aufziehen, fertig; Klick wählt ein Feld aus (Name, gesperrt, Treppenrichtung,
nach vorn, löschen), zwanzig Schritte rückgängig. Räume heißen so, wie sie im Stundenplan stehen
(Vorschlagsliste aus Stammdaten, WebUntis und dem Plan selbst); Treppen gleichen Namens verbinden
die Etagen.

**Wege** sucht der Browser (`public/raumplan.js`, Breitensuche über Etage × Kachel): begehbar sind
Flur, Treppe, Freizeit, Hof und Sport; **Räume nur als Start oder Ziel** — durch einen Klassenraum
läuft niemand hindurch. **Gesperrte** Felder nie. Eine Treppe kann **„nur hinein"** sein (von
dieser Etage hinein, aber nicht heraus auf sie — der Notausgang) oder **„nur heraus"**. Gibt es
keinen Weg, sagt die App das, statt einen zu erfinden.

Für Nutzer: der Knopf **Raumplan** in der Plan-Leiste öffnet die Karte mit Etagen-Reitern, einer
**Raumsuche** (tippen → Raum hervorgehoben, Etage gewählt) und optional Start/Ziel; im
Detailfenster einer Stunde steht **„Weg zum Raum"** — Start ist der Raum der vorherigen Stunde des
Tages, Ziel der Raum der Stunde, beides änderbar, der Weg ist gleich gezeichnet.

**Erst nur für Admins.** Nach dem Anlegen sehen nur Admins Knopf und Karte — zum Testen. Setzt ein
Admin im Editor *„Für alle sichtbar"*, sehen es alle (`schools.raumplan_frei`). Gespeichert wird
der Plan als JSON in `schools.raumplan`, vom Server auf Form und Größe geprüft (≤ 12 Etagen,
≤ 120 × 80 Kacheln, ≤ 400 Felder je Etage); das SVG entsteht aus Text mit maskierten Namen und
kommt über den Parser in die Seite, nicht über `innerHTML`.

> Nicht dabei: Maßstab in Metern, Druckansicht, mehrere Gebäude als getrennte Pläne (Hof und Sport
> sind Bereiche im selben Raster), Touch-Zeichnen im Editor (der Admin sitzt am Rechner).

### Menü sortieren

**Profil → Menü**: seit 2.13 der ganze Editor (Seiten, Gruppen, Unterreiter nach oben — siehe
„Das eigene Menü"). Die alte Reihenfolge (`nav_order`) bleibt die Vorgabe, solange kein eigenes
Menü gespeichert ist. Kein Ziehen — Knöpfe funktionieren auf dem Handy und mit der Tastatur.

Die **Abmeldung** steht in der Voreinstellung hinten, und über ihr steht ein deutlicher Hinweis:
Sie ist eine Info an Freunde, **keine offizielle Krankmeldung**. Die läuft weiter über das
Sekretariat.

### Hausaufgaben hängen am Slot, nicht nur am Kurs

Eine Hausaufgabe merkt sich **Wochentag und Stunde**, an der der Verfasser den Kurs hat. Sehen kann
sie nur, wer denselben Kurs **zur selben Zeit** hat.

Der Grund ist handfest: WebUntis liefert nicht für jeden Kurs eine Kursnummer. Fehlt sie, wird die
Kurs-ID aus Fach, Lehrer und Klasse gebildet — und zwei Jahrgänge mit „Mathe G4" konnten sich dann
eine ID teilen. Der 13er mit G4 in der 8. Stunde sah die Hausaufgaben des 12ers mit G4 in der 4.

Wer eine Hausaufgabe über das Menü einträgt — auch zu einem Tag, an dem er den Kurs gar nicht hat —,
muss nichts weiter angeben: der Server sucht die passende Stelle im eigenen Plan selbst. Aus dem
Plan heraus ist es ohnehin die angeklickte Stunde.

Bestehende Einträge ohne Stunde werden beim ersten Start **nachträglich zugeordnet**: erst aus dem
Plan des Verfassers, dann aus den Plänen aller anderen, die den Kurs haben — aber nur, wenn es dort
genau eine Stelle gibt. Zwei Jahrgänge liefern zwei, und dann bleibt es offen, statt falsch
zuzuordnen. Was offen bleibt, sieht **nur der Verfasser**, und die Zeile sagt das auch: „keiner
Stunde zugeordnet — nur du siehst sie".

### Hausaufgaben und Stundentexte aus WebUntis

Was Lehrer in WebUntis eintragen, wird beim Abgleich mitgeholt und in der Hausaufgabenliste
angezeigt — gekennzeichnet als **„von der Schule (WebUntis)"**.

- **Abhaken** geht wie bei eigenen Aufgaben und ist persönlich.
- **Ändern und Löschen** nicht: sie gehören der Schule, und der nächste Abgleich würde es
  überschreiben.
- Die Bemerkung des Lehrers steht hinter dem Aufgabentext.
- Stundentexte (`lstext`, `info`, Buchungstexte) landen im Detailfenster der Stunde.

> **Nicht gegen eine echte Schule geprüft.** Der Abruf läuft über
> `/WebUntis/api/homeworks/lessons` und braucht dort — anders als der Stundenplan — die Schule im
> Cookie. Ob eure Instanz die Felder so liefert, zeigt der erste Abgleich. Scheitert der Abruf,
> läuft der restliche Abgleich unbeirrt weiter.

### Eine WebUntis-Stunde einzeln entfernen

Neben „Dauerhaft ersetzen" gibt es **„Stunde entfernen"**: die Zelle bleibt danach leer, auch wenn
WebUntis die Stunde weiter liefert — und zwar in **jeder** Woche, weil der Plan am Wochentag hängt.
Ein winziger Punkt unten links zeigt, dass hier etwas entfernt wurde; ein Klick darauf öffnet
**„WebUntis wieder übernehmen"**.

Eine entfernte Stunde ist kein Kurs: keine Hausaufgaben, keine gemeinsame Stunde mit Freunden, und
in keiner Auswahl.

### Wischen, Passwort anzeigen, Freunde finden

- Im Plan **nach links oder rechts wischen** blättert die Woche. Ausgelöst wird das erst ab 60 px
  waagerecht und nur, wenn die Bewegung deutlich waagerechter als senkrecht ist — sonst würde die
  Geste das normale Scrollen kapern.
- Beim Anmelden zeigt ein **Auge** im Passwortfeld das Passwort im Klartext.
- **Freunde suchen** geht über den Username *und* den Anzeigenamen. Wer schon befreundet ist oder
  eine offene Anfrage hat, wird gekennzeichnet statt versteckt — sonst sucht man jemanden und
  findet ihn scheinbar nicht.

### Ist der sichtbare Quelltext eine Sicherheitslücke?

**Nein.** Jede Web-App liefert ihr Frontend im Klartext aus; der Browser muss es ausführen können.
Das gilt für jede Seite im Netz, und „Untersuchen" zeigt nichts, was ein Angreifer nicht auch durch
einen Blick auf die Netzwerkanfragen sähe.

Sicherheit entsteht **auf dem Server**: dort wird bei jeder Anfrage geprüft, wer was darf. Wer die
Oberfläche umgeht und die API direkt anspricht, kommt keinen Schritt weiter — genau deshalb prüft
jede Route Anmeldung, Rechte und Zugehörigkeit selbst.

Im ausgelieferten `app.js` steht **nichts Vertrauliches**: keine Passwörter, keine WebUntis-Zugänge,
kein Registrierungs-Key. Der private Chat-Schlüssel liegt als *nicht exportierbarer* Schlüssel in
der IndexedDB des Geräts und lässt sich auch per Skript nicht auslesen.

Das Frontend liegt in acht Modulen (`kern`, `login`, `plan`, `freunde`, `chat`, `hausaufgaben`,
`profil`, `admin`), die der Browser über ES-Importe selbst lädt — kein Build-Schritt, keine
Werkzeugkette. `kern.js` importiert aus keinem der anderen; alle hängen an ihm. Damit kann dort
kein Ring entstehen.

Minifizieren würde die Dateien kleiner, aber nicht sicherer machen — das ist eine Frage der
Ladezeit, und komprimiert sind es etwa 25 KB.

### Bugs und Vorschläge — Tickets in VNW

Fehler melden, Vorschläge einreichen, den Stand sehen und mit dem Team schreiben. Die Tickets
entstehen in der **VNW-Plattform**, wo das Team ohnehin arbeitet; jedes trägt das Schlagwort
**Stundenplan**, damit die Herkunft sofort sichtbar ist.

Ein Schüler braucht dafür **kein VNW-Konto**. Die App legt das Ticket mit ihrem eigenen API-Token
an und bekommt einen `view_token` zurück — über den lässt sich das einzelne Ticket ohne Anmeldung
lesen und beantworten. Genau dafür ist er bei VNW gedacht.

> **Der `view_token` verlässt den Server nie.** Wer ihn hat, darf lesen *und* hineinschreiben — er
> ist ein Schlüssel, kein Bezeichner. Der Browser kennt nur die Nummer der lokalen Zeile, und jede
> Route holt sie mit `AND user_id = ?`. Ein fremdes Ticket ist ein **404**, kein 403: dass es die
> Nummer gibt, geht niemanden etwas an.

Was die App lokal speichert, ist wenig: wem welches Ticket gehört, sein Titel, der zuletzt bekannte
Status und wie viele Antworten der Melder schon gelesen hat. Der Inhalt liegt bei VNW.

- Beim Melden wählt man die **Art**: Bug-Report, Ideenvorschlag — was der Admin freigegeben hat.
  Bei nur einer freigegebenen Art erscheint das Feld gar nicht; eine Auswahl ohne Wahl ist nur ein
  Klick mehr. Die Art steht danach als Plakette an der Meldung.
- **Die eigenen Felder des Ticket-Typs** erscheinen mit: was in VNW am Typ hängt (Gerät, Browser,
  Klasse …), wird hier zur Eingabe — Textfeld, Auswahl, Kästchen, Datum, Datei. Wechselt man die
  Art, wechseln die Felder mit. Im Ticket stehen sie später mit ihrem Label, nicht mit ihrem
  Schlüssel.
- In der **Liste** steht der Status als Plakette (Offen · In Bearbeitung · Geschlossen), und ein
  Punkt zeigt neue Antworten — dieselbe Sprache wie ungelesene Chats. Die eigene Antwort lässt ihn
  nicht aufleuchten.
- **Antwortet das Team, merkt man es, ohne nachzusehen**: der Zehn-Minuten-Takt fragt die
  Ticketliste bei VNW ab (ein Aufruf für alle offenen Tickets), zählt neue Antworten und schickt
  eine Meldung (*Antworten auf Bugs/Vorschläge*, im Profil abschaltbar). Am Reiter steht die
  **rote Zahl** der Tickets mit ungelesenen Antworten — wie beim Chat; Öffnen löscht sie.
- Im **Ticket** stehen die Beschreibung und die öffentlichen Antworten mit Namen und Datum. Interne
  Notizen des Teams liefert VNW über diesen Weg gar nicht erst mit.
- Ein **geschlossenes** Ticket nimmt bei VNW nichts mehr an; dann gibt es hier auch kein
  Eingabefeld, das so tut, als ginge es noch.
- Ist VNW gerade nicht erreichbar, bleibt die Liste mit dem Stand von vorhin stehen und sagt es.
  Eine leere Seite wäre die schlechtere Antwort.

**An den Text kommt eine Fußzeile**: *— gemeldet von Mia M. (@ticketmia) · Stundenplan 1.7.1*.
Ohne sie stünden alle Tickets unter dem Namen des Token-Besitzers, und das Team wüsste nicht, wem
es antwortet. Antworten gehen mit dem Anzeigenamen des Schülers hinaus (`author_name` ist bei VNW
frei wählbar).

#### Einrichten (Admin → System → Tickets)

Adresse der VNW-Instanz, API-Token, **erlaubte Ticket-Typen** — mehr nicht. Die Typen kommen aus
VNW und werden angehakt; das Schlagwort legt die App beim Speichern selbst an.

Gespeichert wird die Auswahl **mit den Namen und den Feldern** (`vnw_typen`). Das ist kein Zufall: sonst bräuchte
das Meldeformular bei jedem Öffnen einen VNW-Aufruf, nur um „Bug-Report" beschriften zu können.
Aufgefrischt werden die Namen, sooft der Admin die Karte öffnet oder speichert — und beim Abgleich
der Liste, in der VNW `type_name` ohnehin mitliefert.

**Pflichtfelder prüft der Stundenplan-Server**, nicht VNW: `POST /api/tickets` schaut dort nur auf
`title` und `ticket_type_id`. Ohne diese Prüfung ginge eine Meldung mit leerem Pflichtfeld hinaus,
und niemand merkte es. Unbekannte Schlüssel wirft der Server weg — der Client soll nicht bestimmen,
was am Ticket hängt.

> ⚠ **Die API-Beschreibung ist an einer Stelle falsch.** Für ein `file`-Feld nennt sie
> `{ "__file": { name, type, data } }`; der Quelltext will `{ upload, file_name, mime_type }`
> (`server/utils/fieldFiles.js`) und gibt `__file` nur als *gespeicherte Referenz* zurück. Gebaut
> ist es nach dem Quelltext.
>
> `ponytail:` Dateien sind auf **600 KB** begrenzt — der Body-Parser der App nimmt 1 MB, und base64
> bläht um ein Drittel auf. VNW selbst erlaubt 10 MB; für mehr müsste das Bild im Browser
> verkleinert werden.

Angehakt wird nur, was VNW auch wirklich kennt: beim Speichern wird die Auswahl gegen die geladenen
Typen abgeglichen. Ein Typ, den es dort nicht mehr gibt, fällt heraus, statt später beim Anlegen
einen Fehler zu erzeugen. Und eine Art, die **nicht** freigegeben ist, lehnt der Server beim Melden
mit **400** ab — still auf eine andere auszuweichen schöbe die Meldung in eine fremde
Zuständigkeit, ohne dass es jemand merkt.

| Recht am Token | wofür |
|---|---|
| `tickets.create` | Tickets anlegen |
| `tickets.view` | Typen laden, Status und Antwortzahl auffrischen |
| `tickets.tags` | nur einmalig: das Schlagwort anlegen (fehlt es, sagt die App, dass du es in VNW von Hand anlegen musst) |
| `tickets.close` | Tickets zurückziehen (löscht sie bei VNW, solange niemand geantwortet hat) |

Der Token liegt **verschlüsselt** in den Einstellungen — mit demselben Schlüssel wie die
WebUntis-Passwörter und aus demselben Grund: die Sicherung lädt die Datenbank als Datei herunter,
und ein Token im Klartext wäre danach ein Token in Downloads und E-Mails. Zurückgegeben wird er
nie, nur ob einer hinterlegt ist. Ein **leeres** Token-Feld heißt beim Speichern *unverändert* —
sonst löschte das Ändern der Typ-Auswahl den Token.

Aufgefrischt wird mit **einem** Aufruf für die ganze Liste (`GET /api/tickets?tag=…` liefert je
Ticket `status` und `reply_count`), und zwar beim Öffnen der Ansicht. Kein Hintergrundabruf, keine
Push-Benachrichtigung — der Punkt in der Liste reicht.

> ⚠ **Ein Fallstrick aus dem VNW-Quelltext:** gehört der Token einem Konto mit der Rolle *Admin*,
> liefert `GET /api/tickets` **alle** Tickets der Plattform, nicht nur die der App. Zugeordnet wird
> deshalb ausschließlich über die gespeicherte `vnw_id` der eigenen Zeilen — fremde Tickets können
> gar nicht erst hereinrutschen.

### Die App aktualisiert sich selbst

Eine installierte App lädt sich nie von allein neu: wer sie vor drei Wochen geöffnet hat, sitzt
auf dem Code von damals, während der Server längst weiter ist — so standen Leute auf 2.2.0, als
2.5 draußen war. Zwei Dinge fangen das ab:

- **Jede Antwort trägt die Version im Kopf** (`X-Version`). Weicht sie von der ab, mit der die
  Sitzung begann, lädt die App neu — sofort, wenn nichts verloren gehen kann. Ist ein Fenster
  offen oder ein Text angefangen, erscheint stattdessen der Balken *„Neue Version … ist da —
  Aktualisieren"*. Das kostet keine einzige zusätzliche Anfrage: der 30-Sekunden-Takt der Zähler
  trägt den Kopf ohnehin, und beim Hervorholen der App wird einmal `/api/info` gefragt.
- **Statische Dateien werden immer nachgefragt** (`Cache-Control: no-cache`). Ohne diese Zeile
  darf der Browser eine Datei nach Heuristik tagelang für frisch halten — auch durch den Service
  Worker hindurch, der network-first arbeitet, aber den HTTP-Cache des Browsers benutzt. Mit ETag
  ist die Nachfrage ein 304, also fast umsonst.

> Einmal je Version: käme trotz allem der alte Code aus dem Cache, würde die App sonst endlos
> kreisen — `sessionStorage` merkt sich, für welche Version schon neu geladen wurde; danach
> bleibt nur der Balken.

### Versionsnummer, Neuigkeiten, Datenschutzerklärung

Ganz unten auf jeder Seite steht klein die Version — auch auf dem Anmeldebildschirm, denn die
Datenschutzerklärung muss ohne Konto lesbar sein. Ein Klick öffnet beides.

Beide Texte pflegt der Admin unter **Admin → Texte**, mit Vorschau und Änderungsdatum — dort steht
auch die **einmalige Nachricht** (siehe unten).

Geschrieben wird **Markdown**: `#` Überschrift, `**fett**`, `*kursiv*`, `` `Code` ``, `-`
Aufzählung, `[Text](https://…)`. Gerät wird es **ohne `innerHTML`** — der Renderer in `kern.js`
baut ausschließlich Elemente mit `textContent`, und ein Link kommt nur mit `http`, `https` oder
`mailto` durch. Ein Admin-Feld, das HTML rendert, wäre genau die Lücke, die die App sonst nirgends
hat; `javascript:` in einem `href` wäre dieselbe Lücke, nur anders buchstabiert.

Der Admin-Bereich ist in Reiter geteilt — Stundenraster, Stammdaten, Nutzer, System, Texte —, und
die zuletzt gewählte Gruppe wird gemerkt.

### Die einmalige Nachricht

Ein Aushang für alle: **Admin → Texte → Einmalige Nachricht**. Wer die App öffnet oder sich
anmeldet, bekommt sie als Fenster — **einmal**. Weggeklickt ist weggeklickt, auch mit Esc, und
zwar geräteübergreifend: gemerkt wird sie am Konto, nicht im Browser.

Die **Fassung ist der Text selbst** (ein kurzer Hash), nicht der Zeitstempel. Der steht nur auf die
Minute genau — eine Tippfehlerkorrektur eine halbe Minute später wäre für alle, die schon
weggeklickt hatten, nie erschienen. Ändert der Admin den Text, ist es eine neue Nachricht und alle
sehen sie wieder. Ein leeres Feld schaltet den Aushang ab.

Welche Fassung als gesehen gilt, bestimmt der **Server** (`POST /api/me/hinweis-gelesen`) — der
Client kann nicht behaupten, er habe eine Nachricht gesehen, die es noch gar nicht gibt.

### Vertretungen erkennen — nicht nur am `code`

Der Status hing bisher allein an `p.code` aus JSON-RPC. Viele Instanzen setzen den bei einer
Vertretung aber **gar nicht**: sie tauschen nur den Lehrer aus und schreiben einen Hinweis in
`substText`. So eine Stunde galt für die App als völlig regulär — keine Kennzeichnung, nirgends.

Jetzt gibt es drei Quellen, in dieser Reihenfolge:

1. `p.code` aus JSON-RPC, wie bisher;
2. **`cellState`** aus der REST-Wochenabfrage (`SUBSTITUTION`, `SHIFT`, `CANCEL`; zu
   `ROOMSUBSTITUTION` siehe *Raumänderungen*). Diese Antwort lag längst im Speicher — `stundentexte` legt die ganze Periode ab, nicht
   nur die Texte — und wurde bisher bis auf drei Textfelder weggeworfen;
3. ein echter **Vertretungstext** als letzter Rückfall.

Ein Ausfall gewinnt immer vor einer Vertretung, und ein bloßer Gedankenstrich zählt nicht als Text
(siehe `echterText`) — sonst wäre plötzlich jede Stunde eine Vertretung.

> **Nebenwirkung, die vorher niemandem auffiel:** der Abgleich schrieb den Lehrer *jeder* Stunde an
> den Kurs. Bei einer Vertretung klebte damit der **Vertreter dauerhaft am Kurs** — für jeden, der
> ihn hat, bis eine reguläre Stunde ihn zurücksetzte. Der Lehrer wird jetzt nur noch aus regulären
> Stunden übernommen. Das ist zugleich der Grund, warum die Nachfolger-Erkennung beim
> Zusammenführen so oft am Lehrer scheiterte.

### … und sie auch sehen

Auf dem Handy war eine Vertretung praktisch unsichtbar. Die Plakette „Vertretung" wird in der
kompakten Ansicht ausgeblendet, und im Zellinhalt gab es dort **keinen** Ersatz — übrig blieb ein
3 px schmaler oranger Streifen, der obendrein nur die ohnehin vorhandene Kursfarbe ersetzte. Bei
einem orangen Kurs war der Unterschied nicht zu sehen. Ein Ausfall dagegen behält seinen
Durchstrich, auch kompakt — genau daher die Schieflage: „Ausfälle sehe ich, Vertretungen nicht."

- **Kompakt** trägt jetzt das Kürzel selbst die Kennzeichnung: orange, mit vorangestelltem `↻`.
  Die vier Ecken sind mit Freunden, Hausaufgabe, Notiz und Schultext belegt — eine fünfte gibt es
  nicht, und das Kürzel ist ohnehin das, worauf man schaut.
- **Voll** ist der Streifen breiter und die Zelle bekommt einen leichten orangen Grund.
- Der **Vertretungstext** steht jetzt auch im Tooltip der Zelle. Vorher war er ausschließlich im
  Detailfenster zu finden.

### Wer vertritt — und wenn niemand da ist

Der Lehrer hing bisher am **Kurs**, nicht an der Stunde. Da am Kurs bewusst der reguläre Lehrer
steht (siehe oben), zeigte der Plan während einer Vertretung den **Falschen**. Jede abgeglichene
Stunde bringt ihren eigenen Lehrer mit — WebUntis liefert ihn längst, gespeichert wurde er nie.

- In der Zelle steht jetzt, **wer wirklich davorsteht**.
- Im Detailfenster dazu, wen er ersetzt: *„Frau Ersatz (statt Herr Regulär)"*.
- Bei einer Vertretung gilt **ausschließlich** der Lehrer dieser Stunde. Nennt WebUntis keinen, ist
  auch keiner da — dann steht **„ohne Lehrer"** da, in der Zelle wie im Detailfenster. Würde
  hier der Kurslehrer einspringen, behauptete der Plan das Gegenteil dessen, was los ist.

Seit 1.8.0 hat dieser Fall ein **eigenes Zeichen**. Er ist etwas Drittes: kein gewöhnlicher
Lehrertausch, aber auch kein Ausfall — die Schule sagt selbst, dass die Stunde stattfindet, man
sitzt sie nur ab.

| | Ausfall | Vertretung | Vertretung ohne Lehrer |
|---|---|---|---|
| kompakt | durchgestrichen, blass | `↻` bernstein | **`⊘` bernstein** |
| voll | Plakette „entfällt" | Plakette „Vertretung" | Plakette **„ohne Lehrer"** |
| Zelle | — | durchgezogener Balken | **gestrichelter Balken** |

Bewusst keine vierte Farbe: derselbe Bernsteinton, nur gestrichelt statt massiv. Zwei Zeichen und
ein Strichmuster reichen, um drei Zustände auseinanderzuhalten.

Solche Stunden bleiben als **Vertretung** gekennzeichnet und werden nicht zum Ausfall umgedeutet —
für die Schule sind sie etwas anderes, und du sollst sehen, was sie geschrieben hat.

> **Eine Grenze bleibt:** wer eine Stunde *dauerhaft ersetzt* hat, bekommt für diesen Platz gar
> keine WebUntis-Zeile mehr — dort bleibt auch eine Vertretung unsichtbar. Das ist die Bedeutung
> des Knopfes; es aufzuweichen würde ihn sinnlos machen.

### Raumänderungen

Der neue Raum stand immer schon in der Zelle — aber nichts sagte, dass er neu ist. Man merkte es
erst vor der falschen Tür.

Jetzt bringt jede abgeglichene Stunde ihren **ursprünglichen** Raum mit
(`untis_lessons.room_regulaer`, aus `orgname`, das WebUntis beim Tausch mitliefert). Der Raum steht
dann bernsteinfarben da — in beiden Ansichten —, im Detailfenster als *„B7 (statt A213)"*, und der
Tooltip sagt es in Worten.

Drei Fälle, alle drei unterscheidbar: `NULL` heißt *kein Wechsel*, ein Name heißt *statt diesem
Raum*, und der leere Text heißt *gewechselt, aber WebUntis nennt die Herkunft nicht* — das ist der
Fall, in dem nur der Zellzustand `ROOMSUBSTITUTION` vorliegt.

> **Und `ROOMSUBSTITUTION` ist keine Vertretung mehr.** Der Wert enthält `SUBSTITUT` und fiel damit
> in die Vertretungs-Erkennung: eine bloße Raumänderung stand mit orangem `↻` im Plan, als wäre
> ein anderer Lehrer da. Sie ist etwas Eigenes — derselbe Unterricht, nur woanders.

Eine Raumänderung löst außerdem eine **Benachrichtigung** aus (Schalter „Stunde geändert") — das
tat sie schon vorher, gemeldet wird nur der Wechsel gegenüber dem letzten Abgleich.

### Was gemeldet wird — und was lange stumm blieb

| Fall | Meldung | Art |
|---|---|---|
| Stunde fällt aus | „Physik fällt aus" | Ausfall |
| Vertretung | „Vertretung: Physik" | Vertretung |
| Vertretung **ohne Lehrer** | „Physik: Vertretung ohne Lehrer" | Vertretung |
| Raum, Kurs, Lehrer oder Hinweis geändert | „Physik geändert · Lehrer: Frau Ersatz → niemand" | Stunde geändert |
| Neue Hausaufgabe im Kurs | „Neue Hausaufgabe: Q1PHG02" | Hausaufgaben |

#### Wann es kommt, entscheidest du — je Art

Seit 2.0 ist jede Art nicht mehr nur an oder aus:

| Modus | Bedeutung |
|---|---|
| **Sofort** | im Moment des Entstehens, wie bisher |
| **Gesammelt** | alles zusammen zu einer Uhrzeit — je Art eine eigene, sonst die gemeinsame (Vorgabe 19:00) |
| **Zum Zeitpunkt** | eine **selbst eingetragene** Zeit, bezogen auf: die betroffene **Stunde**, den **Schulbeginn** oder den Moment, in dem die **Meldung entsteht** (dann zählt sie nach vorn: „eine Stunde später"). Stunden und Minuten frei eintippen — keine Auswahlliste, die die eine Zeit nicht kennt, die jemand braucht |
| **Aus** | gar nicht |

Der Bezug **nach der Meldung** braucht keinen Stundenplan und geht deshalb bei **jeder** Art —
auch beim Chat, wenn man beim Lernen Ruhe haben will.

#### Mehrere Regeln je Art

Je Art lassen sich bis zu **vier Regeln nebeneinander** stellen: „bei Ausfall **sofort** — und
nochmal **30 Minuten vor der Stunde**". Jede Regel legt ihre eigene Meldung an; zwei Regeln, die
auf **denselben Zeitpunkt** fallen (etwa „sofort" und „0 Minuten vorher"), ergeben **eine**
Meldung, nicht zwei. Im Profil steht je Art ein Block mit „+ Regel" und einem „−" je Zeile.

Gespeichert wird das als Liste (`{"ausfall": [{…}, {…}]}`). Ein einzelnes Objekt, wie es bis 2.0
dort stand, bleibt gültig und wird beim Lesen zur einelementigen Liste — niemand muss etwas
anfassen.

#### Erinnerung an eine Hausaufgabe — jeder für sich

Beim Eintragen einer Hausaufgabe steht dabei, wie lange vorher man erinnert werden will. **Jeder
im Kurs bekommt seine eigene** nach seiner Voreinstellung (Profil → Nachrichten), und über die
**Glocke** an jeder Aufgabe lässt sie sich für genau diese eine ändern oder abschalten. Eine
Hausaufgabe ist kursweit — eine Erinnerung ist es nicht.

Technisch ist auch das nur eine wartende Meldung: `notifications.ref` (`hw:42`) macht sie
wiederfindbar, mehr braucht es nicht. Eine Erinnerung an einen Zeitpunkt, der schon vorbei ist,
wird gar nicht erst angelegt.

Der **gesammelte Hinweis** bringt beides: was seit dem letzten Mal aufgelaufen ist, und die
**Vorschau auf den nächsten Schultag** (fällige Hausaufgaben, Ausfälle, Vertretungen). Genau das,
wofür man abends aufs Handy schaut.

Technisch wird aus `notifications` eine **Warteschlange**: was nicht sofort hinausgeht, bekommt ein
`faellig_at` und wartet dort. Der vorhandene Zehn-Minuten-Takt stellt zu — Vorlauf-Meldungen
einzeln, Gesammeltes als **einen** Anstupser (fünf Vibrationen hintereinander sind keine Sammlung).
Ein Vorlauf, der schon vorbei ist, wird nicht nachgeholt: eine Erinnerung an eine laufende Stunde
hilft niemandem mehr.

> `ponytail:` zehn Minuten Ungenauigkeit — dieselbe Einschränkung wie bei den ToDo-Erinnerungen.
> Wer „30 Minuten vorher" einstellt, bekommt es zwischen 30 und 40 Minuten vorher. Ein Timer je
> Meldung wäre die Alternative und den Aufwand nicht wert.

Die **alten Ein/Aus-Schalter** bleiben als Rückfall stehen: Wer nichts umstellt, behält seine
bisherige Einstellung (`1` → sofort, `0` → aus). Keine Migration, kein Datenverlust.

Der **Lehrer** war bis 1.9.0 nicht Teil des Vergleichs — und damit blieb der wichtigste Fall
stumm: Wird aus einer Vertretung *mit* Frau Ersatz eine *ohne* Lehrer, bleibt der Status
`irregular`. Die Statusmeldung greift also nicht, und ohne den Lehrervergleich erfuhr es niemand.
Jetzt kommt „Lehrer: Frau Ersatz → niemand".

### Wessen Plan? Mit Suchfeld

Neben der Auswahl steht **„Mein Stundenplan"**, sobald der Plan eines anderen zu sehen ist — der
Weg zurück ist der häufigste und soll ein Klick sein, nicht zwei.

Die Planauswahl ist ein Fenster mit **Suchfeld**: „Mein Plan", darunter die Freunde mit Bild und
`@username`, nach Schule gruppiert. Getippt wird auf Name und Username gefiltert, Enter nimmt den
ersten Treffer.

> Ein Suchfeld über einer Auswahlliste wäre weniger Code gewesen und auf dem Handy nutzlos: dort
> öffnet `<select>` die Liste des Betriebssystems, und die kennt das Feld daneben nicht.

### Abmeldung: ganztags oder stundenweise

Zur Abmeldung gehört seit 2.4 ein **Stundenbereich**: „ab der fünften" oder „die ersten beiden".
Ohne Angabe gilt weiter der ganze Tag. Im Plan färbt ein Bereich nur seine Zellen, nicht die
Tagesspalte — und **„wer hat auch frei"** rechnet stundengenau: wer in der 3. Stunde abgemeldet ist,
ist dort nicht frei, in der 5. aber schon.

> Ein Bereich je Tag reicht: „die ersten beiden" oder „ab der fünften" ist der Fall, „1.–2. und die
> 6." nicht. Dafür bräuchte es eine Zeile je Block — und ein Formular, das niemand ausfüllt.

### Wer hat auch frei

Fällt eine Stunde aus, ist die erste Frage nicht *warum*, sondern *wer noch*. In jeder Stunde, in
der man selbst frei hat, steht deshalb in der Zelle, wer aus der Freundesliste ebenfalls frei hat —
als Gesichterreihe, in der kompakten Ansicht als hohler Punkt. Im Detailfenster stehen die Namen
mit dem **Grund**:

| Grund | im Fenster |
|---|---|
| Freistunde | „Freistunde" |
| Ausfall | „Sport fällt aus" |
| Vertretung ohne Lehrer | „Sport ohne Lehrer" |
| an dem Tag schon fertig | „kein Unterricht" |

**Frei** ist mehr als die Freistunde: ein Ausfall zählt dazu, und eine **Vertretung, vor der
niemand steht**, auch — das ist Absitzen. Das gilt in beide Richtungen, also sowohl für die eigene
Zelle als auch für den, der in der Liste auftaucht.

Nicht angezeigt wird:

- **wer an dem Tag gar keinen Unterricht hat** — der ist nicht „auch frei", der ist woanders;
- **wer abgemeldet ist** — krank ist nicht frei;
- **wer an einer anderen Schule ist** — dort klingelt es zu anderen Zeiten, „gleichzeitig" wäre
  eine Behauptung.

Gerechnet wird das in `GET /api/timetable`, in derselben Schleife, die ohnehin schon jeden Freund
durchgeht, um **gemeinsame Stunden** zu finden — es kostet keine einzige zusätzliche Abfrage.

Dazu ein Schalter in **Profil → Nachrichten**, **standardmäßig aus**: „Bei Ausfall dazuschreiben,
wer dann auch frei hat". Dann steht es in derselben Meldung — „Physik fällt aus · Mia und Tom haben
dann auch frei." — und nicht in einer zweiten. Der eingestellte Vorlauf gilt damit automatisch mit,
und aus einem Ausfall wird nicht zweimal vibriert.

### Vergangene Stunden werden blass

Was vorbei ist, tritt zurück: frühere Tage vollständig, heute alles, dessen Gong durch ist. Der
Blick bleibt an dem hängen, was noch kommt.

Umgesetzt allein über die Deckkraft, nicht über eigene Farben — so bleiben Ausfall, Vertretung und
die Kursfarbe erkennbar, nur zurückgenommen. Abgemeldete Tage sind davon ausgenommen: die haben
schon ihre eigene Blässe, und zusammen wäre es unlesbar.

### Im Plan eines Freundes wird nichts eingetragen

Das Eingabefeld für eine neue Hausaufgabe erschien in **jedem** Plan. Was dann passierte, war
schlimmer als eine Fehlermeldung: die Aufgabe landete auf der frühesten **eigenen** Stelle der
Woche — mit dem Datum aus dem fremden Plan — und tauchte dort, wo man geklickt hatte, gar nicht
auf. Es sah aus, als sei nichts passiert, obwohl ein Eintrag entstanden war.

Jetzt erscheint das Feld nur im eigenen Plan. Die **Liste** bleibt überall sichtbar — zu sehen, was
zu einer Stunde aufgegeben ist, ist ja der Sinn davon, in einen fremden Plan zu schauen.

Der Server verlässt sich nicht auf die Oberfläche: ein **ausdrücklich mitgeschickter** Slot, den man
selbst nicht hat, ist jetzt ein Fehler statt einer stillen Korrektur. Wird gar keiner mitgeschickt —
der Weg über das Hausaufgaben-Menü — sucht er die Stunde wie bisher selbst.

### Drei Darstellungen für den roten Zeitstrich

Im Profil unter *„Roter Zeitstrich im Plan"*:

| Auswahl | Was man sieht |
|---|---|
| **Linie mit Uhrzeit** | wie bisher: Strich über den ganzen Plan, Uhrzeit als Blase am linken Rand |
| **Nur die Linie** | derselbe Strich, ohne die Blase |
| **Nur im heutigen Tag** | der Strich läuft nur durch die Spalte von heute |

Die laufende Stunde bleibt in allen drei Fällen rot markiert. Für die Tages-Variante kommen Position
und Breite aus der Kopfzelle des heutigen Tages — die Zellen selbst mussten dafür nicht angefasst
werden.

### Kurs-IDs: eine Schreibweise, überall

`courses.id` ist `TEXT COLLATE NOCASE`, die Kindspalten (`entries.course_id`,
`untis_lessons.course_id`, …) sind **BINARY**. Liefen die beiden auseinander, entstand ein
Widerspruch, den man von außen nicht auflösen konnte:

```
courses.id              = 'UNTIS-MA-KLEIN'   (NOCASE)
untis_lessons.course_id = 'untis-ma-klein'   (BINARY)

Kursliste  (vergleicht c.id, also NOCASE) → Kurs erscheint  ✓
hatKurs    (vergleicht die Kindspalte, BINARY) → kein Treffer ✗
```

Ergebnis: „Du hast diesen Kurs nicht im Stundenplan", obwohl er dort steht und in der Auswahlliste
angeboten wird. Der Fremdschlüssel schlägt dabei nie an, weil er mit der Collation des **Elterns**
prüft — deshalb fällt es nirgends auf. Entstanden ist die Abweichung beim Abgleich: der
Kurs-Upsert trifft wegen NOCASE die bestehende Zeile und lässt deren Schreibweise stehen, während
die Stunde die neu gelieferte bekam.

Dagegen jetzt drei Dinge:

- **`kanonischerKurs()`** bestimmt an einer Stelle die eine gültige Schreibweise. Jede Kurs-ID, die
  von außen kommt oder gespeichert wird, läuft hindurch — im Abgleich, beim Eintragen einer Stunde
  und bei jeder Hausaufgabe.
- Die Leseabfragen (`hatKurs`, `hatKursImSlot`, `slotFuerKurs`, die Slot-Prüfung der Hausaufgaben)
  vergleichen **`COLLATE NOCASE`**. Damit sind auch Zeilen harmlos, die vorher entstanden sind.
- Eine **Migration** zieht den Bestand gerade. Wichtig darin: `c.id COLLATE BINARY <> …` — ohne das
  nimmt der Vergleich die Collation des linken Operanden, und der ist NOCASE. Die Migration hätte
  sonst nie etwas gefunden.

> Beim Ändern einer Hausaufgabe wird der Kurs **nur bei einem Wechsel** geprüft. Wer nur den Text
> korrigiert, während sein Kurs veraltet ist, kam sonst nicht weiter — die Aufgabe ließ sich nur
> noch löschen.

### Doppelte Kurse zusammenführen

Jeder Kurs in „Deine Kurse" hat einen Knopf **„Zusammenführen …"**. Er überführt ihn in einen
anderen eigenen Kurs; Hausaufgaben, eigene Einträge und alle abgeglichenen Stunden wandern mit.
Das gilt **nur für dich** — wer denselben Kurs hat, merkt nichts davon.

**Welcher bleibt?** Der aus der Auswahlliste, also das **Ziel**. Der Kurs, bei dem du den Knopf
drückst — bzw. der in der Vorschlagskarte in der Zeile steht — verschwindet aus deiner Liste.

Bei **Name, Kürzel und Farbe** gibt es eine Feinheit: sie wandern nur mit, wenn beim Zielkurs noch
nichts hinterlegt ist. Hast du beide umbenannt oder eingefärbt, gewinnt das Ziel. Willst du es
andersherum, drück den Knopf beim anderen Kurs und wähl diesen hier als Ziel.

Daneben schlägt die Karte **„Sieht doppelt aus"** von sich aus Paare vor:

- *veraltet* — der Kurs steht nur noch in der Vergangenheit,
- *doppelt* — zwei Kurse mit **gleichem Fach** und mindestens **einer gemeinsamen Stunde** im
  Wochenraster, auch wenn beide noch aktiv sind.

Vorgeschlagen wird immer nur die schwächere Seite — der Kurs mit **weniger Stunden in der
Zukunft**, meistens also der alte. Er ist damit auch der, der beim Zusammenführen verschwindet.
Sonst stünde jedes Paar zweimal in der Liste.

> Der Lehrer ist dabei nur ein Zusatzhinweis, keine Bedingung: bei einer Vertretung schreibt der
> Abgleich den Vertreter an den Kurs, und „KLE" und „Klein" sind für die Datenbank zwei
> verschiedene Lehrer. Fürs **automatische** Zusammenführen ohne Rückfrage gilt weiter die strenge
> Regel — Fach **und** Lehrer **und** gemeinsame Stunde, und nur bei einem veralteten Kurs.

### Wie weit der Plan reicht

Automatisch abgeglichen wird **−28 bis +140 Tage**. Alles darüber hinaus holt die App erst, wenn
man in die Woche blättert. Die WebUntis-Karte im Profil nennt das Datum, damit man nicht raten muss.

Ein **voller** Abgleich räumt jetzt auch außerhalb seines Fensters auf. Vorher blieben Stunden, die
jemand beim Blättern in den Februar einmal geholt hatte, für immer stehen: der Hintergrundtakt
deckt nur die laufende Woche ±2, der volle nur ±140 Tage — dazwischen fasste sie nie wieder jemand
an. Die Kurs-ID von damals lag damit dauerhaft in der Zukunft und galt als „aktuell", weshalb die
Aufräum-Karte leer blieb, obwohl die Kursliste doppelt war. Blättert man wieder hin, wird die Woche
frisch geholt.

### Hausaufgaben, die der Lehrer einträgt

Sie stehen jetzt **im Stundenplan** an ihrer Stunde, nicht mehr nur in der Liste — mit dem
📝-Marker in der Zelle und im Detailfenster unter „Hausaufgaben". Zugeordnet werden sie über Kurs
und Datum, dieselbe Mechanik wie bei den selbst eingetragenen; einen eigenen Slot brauchen sie
dafür nicht.

Sie gehören weiterhin der Schule: **abhaken ja, ändern und löschen nein**, und sie erscheinen nur
im eigenen Plan — nicht im Plan eines Freundes, denn sie hängen an dem Konto, das sie abgeglichen
hat. Ohne auflösbare Kursnummer bleiben sie wie bisher in der Liste, ohne Fach.

### Ein Gedankenstrich heißt „nichts eingetragen"

Steht in Lehrstoff, Notizen oder Hinweis nur ein `-` (oder `–`, `/`, `.`), gilt das als leer: kein
**ℹ** in der Zelle, kein leerer Abschnitt „Von der Schule", kein angehängtes „ -" im Ausfallhinweis.
Sobald ein Buchstabe oder eine Ziffer dabei ist, bleibt der Text stehen — „-1 bis -5" überlebt.

Gefiltert wird in `untis.js`, wo die Texte zusammenlaufen, und **vor** dem Zusammenbau: sonst
gewänne ein bloßer Strich aus JSON-RPC gegen den echten Text aus der REST-Schnittstelle.

### Der rote Strich: wie spät ist es, welche Stunde läuft

Über dem Plan liegt ein waagerechter roter Strich auf der aktuellen Uhrzeit, mit der Zeit als
kleine Blase am linken Rand — dasselbe Bild wie in WebUntis. Die laufende Stunde bekommt ihre
Nummer rot; damit ist „welche Stunde ist gerade?" ohne Millimeterlesen beantwortet.

Gerechnet wird nicht über die Uhrzeit, sondern über die Zeilen: die Zeitachse der Tabelle ist
**nicht** linear, weil Pausen keine eigene Zeile haben. Innerhalb der laufenden Stunde sitzt der
Strich anteilig, in einer Pause auf der Kante zwischen zwei Zeilen. Er liegt im scrollenden
Container, wandert beim seitlichen Scrollen also mit der Tabelle mit.

Er erscheint nur, wenn die angezeigte Woche den heutigen Tag enthält und die Uhrzeit im Raster
liegt — nachts, am Wochenende und beim Blättern in eine andere Woche also nicht. Aktualisiert wird
alle 30 Sekunden, und nur solange der Plan offen ist.

### Wischen ohne das Scrollen zu kapern

In der vollen Ansicht ist die Tabelle breiter als ein Handy, und `#grid` ist selbst der
Scroll-Container. Ein waagerechter Wisch war damit doppeldeutig: er scrollte zum Mittwoch **und**
blätterte eine Woche weiter.

Jetzt wird beim Auflegen des Fingers die Scrollposition gemerkt. Hat sie sich bis zum Loslassen
geändert, war es Scrollen — dann passiert nichts weiter. Nur wenn der Plan stehen geblieben ist
(kompakte Ansicht, oder man ist schon am Rand), gilt es als Wochenwechsel. Ein Sonderfall für
kompakt/voll ist dafür nicht nötig; die Frage „konnte hier überhaupt gescrollt werden?" beantwortet
sich von selbst.

### Hausaufgabe bearbeiten — auch das Fach

Der Bearbeiten-Knopf öffnet ein Fenster mit **Kurs, Fälligkeit und Text**. Vorher war es ein
`prompt`, in dem nur der Text stand: wer eine Aufgabe beim falschen Fach eingetragen hatte, musste
sie löschen und neu anlegen.

Wird der Kurs gewechselt, **bestimmt der Server die Stunde neu** — an ihr hängt, wer die Aufgabe zu
sehen bekommt (siehe „Hausaufgaben hängen am Slot"). Anlegen und Ändern benutzen dafür dieselbe
Funktion, damit sie nicht auseinanderlaufen.

### Kurse zusammenführen, wenn WebUntis die Kursnummer ändert

Die Kurs-ID kommt aus der `lsnumber`. Ändert die Schule sie, entsteht eine **neue** Kurs-ID — und
der alte Kurs bleibt stehen, weil der Abgleich `untis_lessons` nur im Sync-Fenster löscht. Das Fach
steht dann doppelt in der Liste, Farbe und Umbenennung hängen an der alten ID und sind scheinbar
weg, und alte Hausaufgaben verschwinden aus der Ansicht.

**Ein Kurs gilt als veraltet**, wenn er im eigenen Plan nur noch in der Vergangenheit vorkommt.

**Nachfolger** ist ein aktueller Kurs mit
1. demselben **Fach**,
2. demselben **Lehrer** und
3. mindestens **einer gemeinsamen Stunde** im Wochenraster.

Die dritte Bedingung ist die entscheidende: erst sie macht das automatische Übernehmen ungefährlich.
Zwei Jahrgänge beim selben Lehrer im selben Fach sitzen nie in derselben Stunde.

Ist der Nachfolger eindeutig, wandert am Ende des Abgleichs alles von selbst hinüber — Name,
Kürzel, Farbe, Hausaufgaben (mit neu bestimmter Stunde), eigene Einträge und die abgeglichenen
Stunden. Alles Uneindeutige landet im Profil unter **„Sieht doppelt aus"**, mit einer Auswahlliste
zum Zusammenführen und einem Knopf zum Entfernen — und lässt sich außerdem direkt in der Kursliste
zusammenführen (siehe „Doppelte Kurse zusammenführen").

> Verschoben wird immer nur, was **einem Nutzer** gehört, nie der Kurs selbst: die Kurszeile teilen
> sich alle, die den Kurs haben. Für die anderen ändert sich nichts.

### Benachrichtigung bei Raum- und Stundenänderungen

Bis 1.3.1 wurde beim Abgleich **nur der Status** verglichen, und der Vorzustand lud ausschließlich
die auffälligen Stunden — eine reine Raumänderung war damit doppelt unsichtbar.

Jetzt wird der volle Vorzustand geladen und mitverglichen. Ändert sich bei gleichbleibendem Status
**Raum**, **Kurs** oder der **Hinweistext**, kommt eine Meldung: *„Physik geändert — Mi, 03.09.,
2. Stunde · Raum: C204 → B104."* Dafür gibt es einen eigenen Schalter, damit man ihn abstellen kann,
ohne Ausfall und Vertretung mit zu verlieren.

Ohne Vorzustand wird **nichts** gemeldet: beim ersten Abgleich ist jede Stunde neu, und eine Meldung
für jede wäre Lärm statt Nachricht.

### Chat — Ende zu Ende verschlüsselt

Unter **Chat** schreibt man **bestätigten Freunden** — nur dort, jede Route prüft die Freundschaft.
Links die Freundesliste (wer zuletzt geschrieben hat, steht oben), rechts der Verlauf; auf schmalen
Displays erst die Liste, nach der Auswahl die Unterhaltung mit Zurück-Pfeil.

**Der Server kann nicht mitlesen.** Jeder bekommt beim ersten Anmelden ein Schlüsselpaar
(ECDH P-256) im Browser. Der öffentliche Teil liegt offen beim Server, der private mit dem eigenen
Login-Passwort verschlossen (PBKDF2, 210 000 Runden). Nach dem Entpacken liegt er als *nicht
exportierbarer* Schlüssel in der IndexedDB des Geräts — dadurch bleibt der Chat nach dem Neuladen
lesbar, ohne dass das Passwort irgendwo gespeichert wird.

Für jede Nachricht rechnen beide Seiten aus ihrem privaten und dem fremden öffentlichen Schlüssel
denselben gemeinsamen Schlüssel aus; verschlüsselt wird mit AES-GCM. In der Datenbank steht nur
`iv:chiffrat`.

- **Passwort ändern**: der Schlüssel wird mit dem neuen Passwort neu verschlossen — dasselbe Paar
  bleibt, der Verlauf bleibt auf **allen** Geräten lesbar.

  > Genau hier sind Verläufe verlorengegangen, und zwar unbemerkt. Das Passwort wurde **immer**
  > gesetzt, der neu verpackte Schlüssel nur, wenn der Browser ihn mitschickte — und der Client
  > verschluckte falsches Passwort, kaputtes Chiffrat und Funkloch in demselben `null` und ließ das
  > Feld dann einfach weg. Danach lag der Schlüssel mit einem Passwort verschlossen da, das es nicht
  > mehr gab.
  >
  > Der Server nimmt eine Passwortänderung jetzt nur noch an, wenn der Browser **entweder** den neu
  > verpackten Schlüssel mitschickt **oder** ausdrücklich sagt, dass er verworfen werden soll — dann
  > werden beide Schlüsselteile in derselben Anweisung geleert. Kein halber Zustand mehr. Der
  > Browser unterscheidet die Fälle: bei einem Netzfehler bricht er ab, bei einem nicht mehr zu
  > öffnenden Schlüssel fragt er nach und sagt dabei klar, was verloren geht.

- **Passwort von einem Admin zurücksetzen lassen**: der alte Verlauf ist **weg**. Niemand kann ihn
  wiederherstellen — das ist der Preis dafür, dass auch der Serverbetreiber ihn nicht lesen kann.
  Der Reset löscht beide Schlüsselteile jetzt gleich mit, statt sie unbrauchbar liegen zu lassen;
  beim nächsten Anmelden entsteht sauber ein neues Paar. Die Admin-Oberfläche warnt vorher.
- **Ein bestehendes Schlüsselpaar wird nicht mehr aus Versehen ersetzt.** Der Server nimmt ein neues
  nur mit ausdrücklichem `ersetzen` an — und das schickt allein der Notausgang. Vorher hätte jeder
  doppelte Aufruf rückwirkend jede Nachricht entwertet, ohne dass der Server es hätte merken können.
- **Der Notausgang prüft das Passwort, bevor er etwas zerstört.** Sonst wurde ein Tippfehler in das
  neue Paar eingebacken — und das wäre genauso wenig zu öffnen gewesen wie das alte.
- **Ein veralteter Schlüssel fällt jetzt auf.** Neben dem privaten wird der zugehörige öffentliche
  Schlüssel auf dem Gerät abgelegt und mit dem Server verglichen. Passt er nicht mehr, gilt das
  Gerät als nicht entsperrt statt stillschweigend nichts zu entschlüsseln — davor konnte ein altes
  Schlüsselpaar dafür sorgen, dass **jede** Nachricht unlesbar war, in beide Richtungen und ohne
  jeden Hinweis.
- **Notausgang:** Profil → „Chat-Schlüssel zurücksetzen", falls sich der Chat gar nicht mehr
  entsperren lässt (etwa nach einem Admin-Reset). Der bisherige Verlauf bleibt dann unlesbar.
- **Unlesbare Altnachrichten bekommen keine eigene Blase mehr.** Eine Reihe gleichlautender
  „nicht lesbar"-Zeilen sieht aus, als sei der Chat kaputt — dabei betrifft es ausschließlich
  Nachrichten von *vor* einem Schlüsselwechsel. Sie werden gezählt und oben in **einer** Zeile
  erklärt, mit einem Knopf **„Aufräumen"**, der sie wegwirft (bei beiden Seiten, endgültig).
- **Verschlüsselt wird immer gegen einen frisch geholten öffentlichen Schlüssel.** Der
  Zwischenspeicher wurde nur geleert, wenn man den *eigenen* Schlüssel wechselte — nie, wenn das
  Gegenüber es tat. Wer den Chat offen hatte, während der andere neu anfing, schrieb Nachrichten,
  die nur er selbst lesen konnte: bei ihm sah alles normal aus, beim anderen stand „nicht lesbar".
  Ein GET pro Nachricht kostet bei dieser Menge nichts und beendet die ganze Fehlerklasse. Beim
  Entschlüsseln bleibt der Zwischenspeicher, dort wirkt er.
- **Keine doppelten Nachrichten mehr.** `chatLetzte` wurde erst *nach* dem Netz-Roundtrip
  hochgezählt — zwei überlappende Abrufe (der 5-Sekunden-Takt und das Absenden, beim gleichzeitigen
  Schreiben also zuverlässig) fragten mit demselben `since` und rendern beide dasselbe. Jetzt teilt
  sich ein zweiter Aufruf die laufende Abfrage, gezeigte IDs werden gemerkt, und der Takt des alten
  Chats wird beim Wechsel angehalten, **bevor** der neue lädt — sonst erschien der ganze Verlauf
  doppelt. Der Senden-Knopf ist während des Absendens gesperrt.
- Ein **Netzfehler** kostet den Schlüssel auf dem Gerät nicht mehr: lässt sich der Server nicht
  fragen, bleibt liegen, was da ist, statt vorsichtshalber gelöscht zu werden.
- **Jedes Gerät einmal entsperren:** der private Schlüssel liegt nur auf dem Gerät, auf dem du ihn
  ausgepackt hast. Auf einem neuen Gerät — oder wenn du dauerhaft angemeldet warst und ihn nie
  eingegeben hast — steht im Chat „Chat auf diesem Gerät entsperren". Einmal das Passwort
  eingeben, fertig.
- **Ausloggen** löscht den Schlüssel vom Gerät. Auf einem fremden Rechner also unbedingt benutzen.
- Schreibt man jemandem, der sich seit der Umstellung noch nie angemeldet hat, gibt es noch keinen
  öffentlichen Schlüssel — dann geht die Nachricht im Klartext hinaus. Alte Nachrichten von vorher
  bleiben ebenfalls lesbar; nachträglich verschlüsselt wird nichts.

> **Was der Server trotzdem sieht:** wer wann mit wem schreibt und wie lang die Nachricht ist.
> Verborgen ist der Inhalt, nicht die Tatsache der Unterhaltung.
>
> **Kein Forward Secrecy.** Ein Schlüsselpaar pro Nutzer, keine Schlüssel pro Nachricht: wer alte
> Chiffrate mitgeschnitten hat und später an einen privaten Schlüssel kommt, kann sie lesen. Für
> einen Klassenchat angemessen; das Upgrade wäre ein Doppelratchet.

Kein WebSocket: die offene Unterhaltung fragt alle 5 Sekunden nach Neuem, der Ungelesen-Zähler in
der Navigation alle 30 Sekunden. Beim Verlassen der Ansicht stoppt das Nachfragen. Wird eine
Freundschaft aufgelöst, ist der Verlauf nicht mehr abrufbar.

### Benachrichtigungen

**Profil → Benachrichtigungen** — einmal erlauben, dann meldet sich die App auch, wenn sie
geschlossen ist:

- wenn eine Stunde **ausfällt**,
- wenn es eine **Vertretung** gibt,
- wenn dir jemand **schreibt**,
- wenn dich jemand als **Freund** hinzufügen will (und wenn deine Anfrage angenommen wurde).

Jedes einzeln abschaltbar, und „Auf diesem Gerät abschalten" löst nur dieses eine Gerät.

Gemeldet wird bei Ausfall und Vertretung nur der **Wechsel** — was schon beim letzten Abgleich so
stand, meldet sich nicht erneut. Sonst käme bei einem Takt von zehn Minuten immer wieder dieselbe
Nachricht. Und nur, was in der Zukunft liegt, höchstens zehn auf einmal.

Der Push selbst trägt **keinen Inhalt**: verschickt wird nur ein Anstupsen, den Text holt der
Service Worker danach angemeldet von `/api/notifications/pending`. Das spart die
Payload-Verschlüsselung nach RFC 8291 vollständig — und beim Ende-zu-Ende-Chat könnte der Server
den Text ohnehin nicht mitschicken, er kennt ihn nicht. Deshalb steht in der Chat-Meldung nur
„Neue Nachricht von …".

Das nötige VAPID-Schlüsselpaar erzeugt die App beim ersten Bedarf selbst und legt es als
`<DB-Pfad>.vapid` neben die Datenbank — wie den WebUntis-Schlüssel und aus demselben Grund.
Löschen heißt: alle müssen die Benachrichtigungen neu erlauben.

> Auf dem **iPhone** funktioniert das erst, wenn die App über „Zum Home-Bildschirm" installiert
> ist — eine Einschränkung von iOS, nicht der App. Die Karte im Profil sagt das auch.

### Sicherung (Admin)

**Admin → Sicherung** lädt die komplette Datenbank herunter — Nutzer, Pläne, Hausaufgaben,
Nachrichten und Bilder. Der Schnappschuss entsteht per `VACUUM INTO` und ist auch im laufenden
Betrieb konsistent.

Beim **Einspielen** wird die Datei erst in einer Kopie geöffnet und geprüft (SQLite-Header **und**
die erwarteten Tabellen) — eine Datei mit richtigem Header, aber falschem Inhalt würde die App
sonst beim nächsten Start lahmlegen. Erst danach landet sie als `<DB>.incoming` neben der
Datenbank und wird **beim nächsten Start** eingesetzt; die bisherige Datei bleibt als
`<DB>.vorher` liegen. Eine laufende SQLite-Datei lässt sich nicht gefahrlos unter dem Prozess
austauschen, deshalb der Umweg über den Neustart.

### Banner

Jeder kann im Profil ein Banner hinterlegen; es steht über dem Stundenplan und wird auch bei
Freunden angezeigt. Ohne eigenes Bild erscheint dort ein Verlauf aus der Profilfarbe, die Fläche
bleibt also nie leer. Bilder werden im Browser zugeschnitten (Avatar 128×128, Banner 1024×256)
und als WebP in der Datenbank abgelegt — ein 328-KB-Foto landet als rund 8 KB.

### Als App aufs Handy (PWA)

Die Seite ist eine installierbare PWA. Manifest, Service Worker und Icons liefert der Server selbst,
es gibt keinen Build-Schritt — die Icons werden beim ersten Abruf aus `icon.js` gerechnet, deshalb
liegen keine Binärdateien im Paket.

- **Android/Chrome**: Oben rechts erscheint **App installieren**, alternativ Browsermenü →
  „App installieren".
- **iOS/Safari**: Teilen-Menü → „Zum Home-Bildschirm". Einen Install-Knopf kann es dort nicht
  geben, weil iOS das nötige Ereignis nicht kennt.

Der Service Worker cached nur die Oberfläche (HTML, JS, CSS, Icon) und arbeitet network-first —
nach einem Deploy ist sofort die neue Version da. **`/api/` wird nie gecacht**: sonst zeigte die
App alte Stundenpläne, und angemeldete Antworten hätten auf einem geteilten Handy nichts im Cache
verloren.

Ohne Netz startet die App trotzdem und zeigt den zuletzt geladenen **eigenen** Plan mit dem Hinweis
„Offline — Stand von …". Dieser Zwischenspeicher liegt im `localStorage` und wird beim Ausloggen
gelöscht. Profilbilder und Banner liegen unter `/api/` und fehlen offline; dort erscheinen dann
Emoji bzw. Initialen und der Farbverlauf.

> Installierbar ist eine PWA nur über **HTTPS** (Ausnahme: localhost). Hinter einem Reverse Proxy
> mit Zertifikat passt das; über eine nackte `http://`-Adresse bietet der Browser die Installation
> nicht an.

Die Registrierung kennt drei Modi, umschaltbar unter **Admin → Registrierung**:

| Modus | Bedeutung |
|---|---|
| `key` | Nur mit dem gemeinsamen Registrierungs-Key. **Voreinstellung bei einer neuen Installation.** |
| `open` | Jeder kann sich selbst ein Konto anlegen. |
| `off` | Keine Selbstregistrierung — Konten legt nur der Admin an. |

Eine frische Installation startet also geschlossen. Den Key setzt du beim ersten Start über
`REG_KEY`; ohne diese Variable erzeugt die App einen und schreibt ihn ins Log
(`! Registrierungs-Key: …`). Danach steht er unter **Admin → Registrierung** und ist dort änderbar.

Ist mit Modus `key` kein Key hinterlegt, wird jede Registrierung abgelehnt — der Modus fällt nie
versehentlich offen zurück.

> Der Modus liegt in der Datenbank, nicht im Code. Bei einer **bestehenden** Installation bleibt
> die dort gespeicherte Einstellung erhalten; umstellen geht nur über Admin → Registrierung.

Gegen Raten des Keys bzw. von Passwörtern bremst ein Zähler pro IP: ab 10 Fehlversuchen in
15 Minuten antwortet der Server mit 429. Der Zähler liegt im Prozessspeicher und beginnt bei einem
Neustart von vorn.

### Android-App

Die Android-App ist ein WebView um genau diese Web-App plus native Homescreen-Widgets. Vier
kleine Anker dafür, nichts davon ändert das Verhalten im Browser:

- **Ansicht per URL-Hash**: `#chat`, `#homework`, `#plan`, `#profile`, `#tickets` (die Keys von
  `LOADERS` in `plan.js`) gewinnen beim Start über die gemerkte Ansicht und werden danach aus der
  Adresse entfernt — ein Reload springt nicht wieder dorthin. Der Hash überlebt den Login; und ist
  die App schon offen, reicht `hashchange`: der WebView setzt beim Tipp aufs Widget nur den Hash.
- **`GET /api/info`** nennt `app: 'stundenplan'` und `schule` (Name der Standardschule), weiter
  ohne Anmeldung — so prüft die App eine eingegebene Serveradresse („Verbunden mit: Gymnasium X").
- **`GET /api/widget`** (angemeldet): alles für die Widgets in einem Aufruf — `stunden` des Tages
  (`?tag=JJJJ-MM-TT`, Vorgabe heute, am Wochenende Montag; aus `planFuer`, mit eigenem Kürzel,
  Namen und Farbe, Status und Vertretungstext, ohne Frei/Entfernt), `hausaufgaben` (offen ab
  heute, höchstens 20, WebUntis mit negativer id wie in `/api/homework`, damit
  `POST /api/homework/:id/done` für beide geht) und `pruefungen` (ab heute, höchstens 10). Jedes
  Handy fragt alle 15 Minuten: `bremse('widget', 30)`, `Cache-Control: no-store`, Texte auf 200
  Zeichen, kein WebUntis-Abgleich (den macht die App, wenn sie offen ist), `tag` streng geprüft.
- **Benachrichtigungs-Karte**: der WebView hängt ` StundenplanApp/1` an den User-Agent. Dort gibt
  es keinen PushManager, also stand fälschlich der iPhone-Hinweis. Jetzt: „Benachrichtigungen
  kommen über die Android-App …", ohne Erlauben/Abschalten-Knöpfe. Der Regelplan bleibt — der
  Server legt die Meldungen ohnehin in `notifications`, die App holt sie ab.

### Ausgesperrt? Admin-Passwort zurücksetzen

`ADMIN_PW` wirkt **nur beim allerersten Start**, solange noch kein Nutzer existiert. Ist das
Admin-Passwort später weg, hilft es nicht weiter — dafür gibt es `ADMIN_RESET_PW`:

1. `ADMIN_RESET_PW=<neues Passwort>` als Env-Var setzen und die App neu starten.
2. Im Log steht `! ADMIN_RESET_PW: Passwort von "admin" neu gesetzt`. Jetzt einloggen.
3. **Variable wieder entfernen** und erneut neu starten.

Das setzt zugleich die Adminrechte des Kontos zurück und meldet dessen offene Sitzungen ab. Mit
`ADMIN_RESET_USER=<name>` trifft es ein anderes Konto; existiert es nicht, wird es als Admin neu
angelegt. Wer Env-Vars setzen darf, kontrolliert die Instanz ohnehin — der Weg macht sie also
nicht angreifbarer, als sie es durch das Deployment schon ist.

## Deploy auf VNW (Node-Apps)

**ZIP bauen** — ohne `node_modules`, ohne `stundenplan.db`, ohne Wurzelordner:

```bash
npm run pack
```

Erzeugt `stundenplan-deploy.zip`. Beim Deploy in der VNW-UI:

| Option | Wert |
|---|---|
| `run_npm_install` | **an** (node_modules sind absichtlich nicht im ZIP) |
| `strip_root` | aus (das ZIP hat keinen Wurzelordner) |
| `main_file` | `index.js` — der VNW-Default, nichts umzustellen |
| `start_command` | leer lassen (`node index.js` ist genau richtig) |

### Env-Vars (in der App-Konfiguration setzen, nicht ins ZIP)

| Variable | Zweck |
|---|---|
| `DB` | **Wichtig.** Pfad der SQLite-Datei, z.B. `/opt/apps/stundenplan-data/stundenplan.db`. Ohne diese Variable landet die DB in `install_dir` — und ein Update mit `mode='overwrite'` leert `install_dir`, die Datenbank wäre weg. Das Verzeichnis wird beim Start automatisch angelegt. |
| `ADMIN_PW` | Passwort des beim allerersten Start angelegten `admin`-Users. **Vor dem ersten Start setzen** — sonst ist das Passwort `admin`. Wirkt später nicht mehr; danach hilft `ADMIN_RESET_PW`. |
| `ADMIN_RESET_PW` | Notfall: setzt beim Start das Admin-Passwort neu (siehe „Ausgesperrt?"). Nach dem Einloggen wieder entfernen. |
| `REG_KEY` | Registrierungs-Key für den allerersten Start. Ohne die Variable wird einer erzeugt und ins Log geschrieben. Wirkt nur beim Anlegen einer neuen Datenbank; später ändert man ihn unter Admin → Registrierung. |
| `PORT` | Listen-Port (Default **3120**). Gleichen Wert im Feld `port` der App eintragen. |
| `TRUST_PROXY` | Wie viele Proxys vor der App stehen (Standard 1). Ohne das ist `req.ip` hinter dem Reverse Proxy für alle gleich — zehn Fehlversuche von irgendwem würden die ganze Schule aussperren. Setzt der Proxy `X-Forwarded-For` nicht selbst, gehört hier `0` hin. |
| `NODE_ENV` | Auf `production` setzen. Sonst schickt Express bei Fehlern Stacktraces an den Client, und das Sitzungscookie bekommt kein `Secure`. |
| `PUSH_KONTAKT` | Optional, z. B. `mailto:admin@schule.de`. Steht im VAPID-Token; manche Push-Dienste wollen eine Kontaktadresse sehen. |
| `UNTIS_KEY` | **Optional.** 32 Byte als Hex oder Base64, verschlüsselt die WebUntis-Zugänge. Ohne die Variable erzeugt die App den Schlüssel selbst und legt ihn als `<DB-Pfad>.untis-key` ab. Setzen nur, wenn man ihn selbst verwalten will — **Ändern macht alle gespeicherten Zugänge unbrauchbar**, die Nutzer müssen sich dann neu verbinden. |
| `NODE_OPTIONS` | Optional `--no-warnings`. `node:sqlite` schreibt sonst beim Start eine ExperimentalWarning ins Log — harmlos, aber sie frisst Platz im 4 KB großen `last_log_tail`. |

Mit gesetztem `DB` außerhalb von `install_dir` sind `mode='merge'` und `mode='overwrite'`
beide gefahrlos. Profilbilder liegen als Data-URL in der Datenbank (im Browser auf 128 px
verkleinert, ~2 KB) — es gibt also kein Upload-Verzeichnis, das ein Deploy wegräumen könnte.

Bestehende Installationen brauchen nichts weiter: fehlende Spalten werden beim Start
per `ALTER TABLE` nachgezogen, vorhandene Daten bleiben unangetastet.

## Tests

```bash
npm test
```

Siebenundfünfzig Integrationstests gegen eine In-Memory-DB: Login und Rechte, Kurs-Kürzel (NOCASE-Dubletten,
Umbenennen mit Cascade), gemeinsame Stunden, Freundschafts-Privatsphäre, Abmeldungen,
Registrierungsmodi (inkl. Key-Modus ohne hinterlegten Key), Nutzerverwaltung, Aussperr-Schutz für den letzten Admin, Profilfelder,
PWA (Manifest, Service Worker, erzeugte Icons), Avatar- und Banner-Upload, das Bearbeiten aller Stammdaten, Raum je Eintrag, private Notizen, dauerhafte Anmeldung, Fach-Kürzel, Freistunden, Hausaufgaben (kursweite Sichtbarkeit, persönliches
Abhaken, Anzeige im Plan), Chat, Sicherung, automatische Freistunden, Navigation als Symbole und die WebUntis-Anbindung
(Verschlüsselung, Schulsuche, Einmalcode nach RFC 6238, Form der Schlüssel-Anmeldung,
der selbst erzeugte Schlüssel neben der Datenbank,
Aufbereitung, Vorrang vor dem eigenen Plan).

Dazu die Sicherheitsprüfungen — fremder WebUntis-Host wird abgelehnt, die Sicherung enthält keine
verwendbaren Sitzungstokens, abgelaufene Sitzungen werden abgewiesen, ein erfolgreicher Login hebt
die Sperre für ein anderes Konto nicht auf, `X-Forwarded-For` trennt die Zähler, ein Bild mit
falschen Magic Bytes fliegt raus — und die neuen Funktionen: dauerhaftes Ersetzen über mehrere
Wochen, WebUntis-Stammdaten bleiben aus den Listen heraus, persönliche Kursnamen und -farben,
Menüreihenfolge, Version und Texte, Ende-zu-Ende-Chat (beide Seiten rechnen denselben Schlüssel
aus, ein Dritter nicht, kein Klartext in der Datenbank), VAPID-Signatur und Meldungs-Warteschlange,
sowie der Break-Glass-Reset des Admin-Passworts.
