// --- profil ---
// Eigenes Profil, Kursnamen, WebUntis-Anbindung und Benachrichtigungen.
import {
  $, $$, api, avatarEl, bestaetigen, colorOf, courseHue, courseLabel, dmy, eingabe, h, md, oops,
  paintBanner, rueckgaengig, scrollHinweis, setzeKinder, state, toast,
} from './kern.js';
import { paintMe } from './login.js';
import { beschriftung, paintNav, SEITEN } from './menue.js';
import { chatNeuAnfangen, malHwBadge, schluesselEinrichten, schluesselUmpacken } from './chat.js';

// --- Profil -----------------------------------------------------------------

// --- WebUntis im Profil ------------------------------------------------------

// Die Schule wird gesucht, nicht vom Admin eingetragen: an der Schule hat niemand einen
// WebUntis-Admin-Zugang, jeder meldet sich mit seinem eigenen Schuelerkonto an.
let untisWahl = null; // im Profil ausgewaehlte Schule, solange noch keine hinterlegt ist
// Wer woanders zur Schule geht, klappt die Suche selbst wieder auf. Ohne diesen Schalter waere
// sie fuer jeden, der schon verbunden ist, fuer immer zu.
let andereSchule = false;

// Was an Texten wirklich ankam. Welche Felder eine WebUntis-Instanz an Schuelerkonten herausgibt,
// ist von Schule zu Schule verschieden - und ohne diese Zeile bleibt "der Lehrstoff fehlt" eine
// Vermutung, die nur eine weitere Runde klaeren kann.
/** Heute - am Wochenende der kommende Montag, sonst steht im Bericht "0 Stunden". */
function naechsterSchultag() {
  const d = new Date();
  const tag = d.getDay();
  if (tag === 6) d.setDate(d.getDate() + 2);
  if (tag === 0) d.setDate(d.getDate() + 1);
  // Ortszeit, nicht UTC: abends waere aus dem Montag sonst wieder der Sonntag geworden.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const textZaehler = t => {
  if (!t?.stunden) return '';
  const gefunden = t.lehrstoff_gefunden != null && t.lehrstoff_gefunden !== t.lehrstoff
    ? ` (${t.lehrstoff_gefunden} gefunden)` : '';
  const teile = [`Lehrstoff ${t.lehrstoff}${gefunden}`, `Notizen ${t.notizen}`, `Info ${t.info}`];
  return ` Texte vom letzten Abgleich (von ${t.stunden} Stunden): ${teile.join(' · ')}.`;
};

async function loadUntis() {
  const s = await api('GET', '/api/untis/status').catch(() => null);
  // Die Karte bleibt sichtbar, auch wenn nichts geht. Sie stillschweigend auszublenden hiess:
  // Wer WebUntis sucht, findet gar nichts und erfaehrt auch nicht, woran es liegt.
  $('#untisKarte').hidden = false;
  state.untisAktiv = !!s?.konto;
  if (!s?.moeglich) {
    for (const id of ['#untisSchulwahl', '#untisForm', '#untisAktionen', '#untisTexteZeile']) $(id).hidden = true;
    $('#untisWarnung').textContent = '';
    $('#untisHinweis').textContent = 'WebUntis läuft auf diesem Server gerade nicht.'
      + (state.me?.is_admin
        ? ' Der Schlüssel, mit dem die Zugänge verschlüsselt werden, ließ sich nicht anlegen — '
          + 'die App braucht dafür Schreibrechte im Ordner der Datenbank. Näheres steht im Serverlog.'
        : ' Frag einen Admin, woran es liegt.');
    $('#untisHinweis').classList.add('fehler');
    return;
  }

  maleIserv(s);
  // Ein Konto gibt es nur einmal - es gehoert zu der Quelle, aus der die eigene Schule kommt.
  // Sonst behauptete die WebUntis-Karte "verbunden", waehrend der Plan von IServ kommt.
  const k = s.quelle === 'iserv' ? null : s.konto;
  $('#pruefImportKarte').hidden = !k;   // Pruefungen gibt es nur aus WebUntis
  // Die eigene Schule - oder die gerade in der Suche gewaehlte, wenn jemand wechselt.
  const eigene = s.aktiv ? { name: s.schule?.name || s.school, server: s.server } : null;
  const schule = untisWahl ? { name: untisWahl.name, server: untisWahl.server } : eigene;
  // Die Suche steht offen, solange keine Schule feststeht - oder solange jemand wechseln will.
  $('#untisSchulwahl').hidden = !(andereSchule || (!k && !schule));
  // Das Anmeldeformular gehoert zur gewaehlten Schule: mit Konto nur beim Wechsel.
  $('#untisForm').hidden = !schule || (!!k && !untisWahl);
  $('#untisAktionen').hidden = !k;
  // DEBUG ist Adminsache: der Bericht ist fuer die naechste Runde Entwicklung, nicht fuer Schueler.
  $('#untisTexteZeile').hidden = !k || !state.me?.is_admin;
  $('#untisTexteTag').value ||= naechsterSchultag();
  $('#untisWechselnZeile').hidden = andereSchule || !!untisWahl || !schule;
  $('#untisHinweis').textContent = untisWahl
    ? `Andere Schule: ${untisWahl.name} (${untisWahl.server}). Melde dich mit deinem WebUntis-Zugang `
      + 'dieser Schule an — dein bisheriger Plan wird dabei ersetzt.'
    : k
      ? `Verbunden als ${k.username} (${k.auth_typ === 'secret' ? 'Schlüssel aus der Untis-App' : 'Passwort'})`
        + (eigene ? ` bei ${eigene.name}.` : '.')
        + (k.last_sync ? ` Zuletzt abgeglichen: ${k.last_sync.replace(' ', ', ')} Uhr.` : ' Noch kein Abgleich.')
        + (k.last_error ? ` Letzter Fehler: ${k.last_error}` : '')
        + textZaehler(k.texte)
      : schule
        ? `Schule: ${schule.name} (${schule.server}). Melde dich mit deinem eigenen WebUntis-Zugang an `
          + '— demselben, mit dem du dich auch bei WebUntis anmeldest. Dann kommt dein Plan samt '
          + 'Vertretungen automatisch.'
        : 'Such deine Schule und melde dich danach mit deinem eigenen WebUntis-Zugang an.';
  $('#untisHinweis').classList.toggle('fehler', !!k?.last_error);
  $('#untisTakt').textContent = k
    ? 'Abgeglichen wird automatisch etwa alle 10 Minuten für die nächsten Wochen und alle paar '
      + 'Stunden für den ganzen Zeitraum. Der Knopf holt sofort alles — etwa wenn du in WebUntis '
      + 'gerade etwas geändert hast.'
      // Ohne diesen Satz muss man raten, ob der März schon geladen ist. Er ist es nicht - er wird
      // erst geholt, wenn man hinblättert.
      + (k.bis ? ` Fest abgeglichen ist bis ${dmy(k.bis)}; weiter entfernte Wochen holt die App, `
        + 'sobald du dorthin blätterst.' : '')
    : '';
  untisArt();
}

/**
 * Die IServ-Karte.
 *
 * IServ hat fuer den Stundenplan keine Schnittstelle - gelesen wird die Seite, die auch ein Mensch
 * sieht. Deshalb steht hier ein Knopf, der zeigt, was wirklich ankommt: ohne den waere ein leerer
 * Plan von einer falschen Adresse nicht zu unterscheiden.
 */
function maleIserv(s) {
  const drin = s.quelle === 'iserv' && s.konto;
  $('#iservKarte').hidden = !s.moeglich;
  $('#iservForm').hidden = !!drin;
  $('#iservAktionen').hidden = !drin;
  $('#iservBericht').hidden = true;
  $('#iservHinweis').textContent = drin
    ? `Verbunden als ${s.konto.username} bei ${s.schule?.name || s.server}.`
      + (s.konto.last_sync ? ` Zuletzt abgeglichen: ${s.konto.last_sync.replace(' ', ', ')} Uhr.`
        : ' Noch kein Abgleich.')
      + (s.konto.last_error ? ` Letzter Fehler: ${s.konto.last_error}` : '')
      + ' Von IServ kommt die laufende Woche; für alle anderen bleibt dein eigener Plan stehen.'
    : 'Nutzt eure Schule IServ statt WebUntis? Dann melde dich hier mit deinem IServ-Zugang an. '
      + 'Deine Schule wird dabei zu einer eigenen Schule in der App — IServ und WebUntis lassen '
      + 'sich nicht mischen.';
  $('#iservWarnung').textContent = 'Dein IServ-Passwort wird verschlüsselt gespeichert, damit der '
    + 'Abgleich automatisch laufen kann. In der Datenbank steht es nirgends lesbar, und der '
    + 'Schlüssel dafür liegt nicht in ihr — wer die Datenbank oder eine Sicherung davon erbeutet, '
    + 'kann damit nichts anfangen.';
}

$('#iservForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('PUT', '/api/iserv/account', {
      server: f.server.value, name: f.name.value,
      username: f.username.value, password: f.password.value,
    });
    f.password.value = '';
    toast(untisMeldung(r), true);
    state.courses = await api('GET', '/api/courses').catch(() => state.courses);
    await loadUntis();
    state.plan = null;
  } catch (err) { oops(err); }
};

$('#iservWeg').onclick = async () => {
  if (!await bestaetigen('IServ-Verbindung trennen?\n\nDeine abgeglichenen Stunden werden entfernt.')) return;
  try {
    await api('DELETE', '/api/untis/account');
    toast('Getrennt.', true);
    await loadUntis();
    state.plan = null;
  } catch (err) { oops(err); }
};

$('#iservSync').onclick = async () => {
  const knopf = $('#iservSync');
  knopf.disabled = true;
  try {
    toast(untisMeldung(await api('POST', '/api/untis/sync')), true);
    state.plan = null;
    await loadUntis();
  } catch (err) { oops(err); }
  finally { knopf.disabled = false; }
};

/** Den Bericht lesbar hinschreiben - er geht am Ende an mich, nicht an einen Rechner. */
const iservBericht = d => {
  const zeilen = [`Server: ${d.bericht?.server ?? '?'}`];
  if (d.fehler) zeilen.push(`Fehler: ${d.fehler}`);
  zeilen.push(`Angemeldet: ${d.bericht?.angemeldet ? 'ja' : 'nein'}`);
  for (const sch of d.bericht?.schritte ?? [])
    zeilen.push(`  ${sch.url} → ${sch.status}`
      + (sch.weiter ? ` → ${sch.weiter}` : '')
      + (sch.fehler ? ` (${sch.fehler})` : '')
      + (sch.keks ? ` [${sch.keks}]` : ''));
  if (d.bericht?.formular) {
    const f = d.bericht.formular;
    zeilen.push(`Formular: ${f.action} · Benutzer=${f.user} · Passwort=${f.pass}`
      + (f.versteckt?.length ? ` · versteckt: ${f.versteckt.join(', ')}` : ''));
  } else if (d.bericht) {
    zeilen.push('Formular: keins gefunden');
  }
  if (d.ok) {
    zeilen.push(`Plan-Seite: ${d.pfad ?? 'nicht gefunden'} · ${d.gefunden} Stunden`);
    for (const v of d.versucht ?? [])
      zeilen.push(`  ${v.pfad} → ${v.status}, ${v.groesse} Zeichen, ${v.tabellen} Tabellen`
        + (v.probe?.length ? '\n    ' + v.probe.map(z => z.join(' | ')).join('\n    ') : ''));
  }
  return zeilen.join('\n');
};

$('#iservTest').onclick = async () => {
  const f = $('#iservForm');
  const kasten = $('#iservBericht');
  kasten.hidden = false;
  kasten.textContent = 'Teste …';
  try {
    kasten.textContent = iservBericht(await api('POST', '/api/iserv/test', {
      server: f.server.value, username: f.username.value, password: f.password.value,
    }));
  } catch (err) {
    kasten.textContent = 'Test nicht möglich: ' + err.message;
  }
};

$('#iservDiagnose').onclick = async () => {
  const kasten = $('#iservBericht');
  kasten.hidden = false;
  kasten.textContent = 'Frage IServ …';
  try {
    const d = await api('GET', '/api/iserv/diagnose');
    kasten.textContent = iservBericht({ ...d, ok: true, bericht: { server: d.server, angemeldet: d.angemeldet } });
  } catch (err) {
    kasten.textContent = 'Fehlgeschlagen: ' + err.message;
  }
};

// Schluessel oder Passwort - nur das jeweils noetige Feld ist sichtbar und pflicht.
function untisArt() {
  const art = $('#untisForm').art.value;
  const schluessel = art === 'secret';
  $('#untisSchluesselFeld').hidden = !schluessel;
  $('#untisSchluesselHilfe').hidden = !schluessel;
  $('#untisPasswortFeld').hidden = schluessel;
  $('#untisForm').secret.required = schluessel;
  $('#untisForm').password.required = !schluessel;
  $('#untisWarnung').textContent = schluessel
    ? 'Der Schlüssel wird verschlüsselt gespeichert, damit der Abgleich automatisch laufen kann — '
      + 'in der Datenbank steht er nirgends lesbar. Er gibt nur Lesezugriff auf deinen Plan und '
      + 'lässt sich in WebUntis jederzeit widerrufen; dein Schulpasswort bleibt außen vor.'
    : 'Dein WebUntis-Passwort wird verschlüsselt gespeichert, damit der Abgleich automatisch laufen '
      + 'kann. In der Datenbank steht es nirgends lesbar, und der Schlüssel dafür liegt nicht in '
      + 'ihr — wer die Datenbank oder eine Sicherung davon erbeutet, kann damit nichts anfangen. '
      + 'Noch besser ist der Zugriffsschlüssel aus der Untis-App: er gibt nur Lesezugriff und lässt '
      + 'sich einzeln widerrufen.';
}

$('#untisForm').art.onchange = untisArt;

// Die Schule ist die des Nutzers, nicht die der Instanz: hier klappt die Suche wieder auf.
$('#untisWechseln').onclick = () => { andereSchule = true; untisWahl = null; loadUntis(); };

$('#untisSuche').onsubmit = async e => {
  e.preventDefault();
  const liste = $('#untisTreffer');
  liste.replaceChildren(h('li', { className: 'muted', textContent: 'Suche läuft …' }));
  try {
    const treffer = await api('GET', '/api/untis/schools?q=' + encodeURIComponent(e.target.q.value));
    liste.replaceChildren(...(treffer.length ? treffer.map(t => {
      const nimm = h('button', { className: 'primary', textContent: 'Das ist meine' });
      nimm.onclick = () => { untisWahl = t; liste.replaceChildren(); loadUntis(); };
      return h('li', {},
        h('span', { className: 'grow' }, h('strong', { textContent: t.name }),
          h('small', { className: 'muted', textContent: t.ort ? ` ${t.ort}` : ` ${t.server}` })),
        nimm);
    }) : [h('li', { className: 'muted', textContent: 'Keine Schule gefunden.' })]));
  } catch (err) {
    liste.replaceChildren(h('li', { className: 'muted fehler', textContent: err.message }));
  }
};

const untisMeldung = r => {
  const teile = [`${r.uebernommen} Stunden übernommen`];
  if (r.ohneRaster) teile.push(`${r.ohneRaster} passten in kein Stundenraster`);
  return teile.join(', ') + '.';
};

$('#untisForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('PUT', '/api/untis/account', {
      username: f.username.value,
      ...(f.art.value === 'secret' ? { secret: f.secret.value } : { password: f.password.value }),
      ...untisWahl && { server: untisWahl.server, school: untisWahl.schule, name: untisWahl.name },
    });
    f.password.value = ''; f.secret.value = '';
    untisWahl = null;
    andereSchule = false;
    // Raster und Kurse gehoeren zur Schule - nach einem Wechsel stimmt beides nicht mehr.
    state.courses = await api('GET', '/api/courses').catch(() => state.courses);
    toast(untisMeldung(r), true);
    await loadUntis();
    state.plan = null;
  } catch (err) { oops(err); await loadUntis(); }
};

// Holt den ganzen Zeitraum, nicht nur die nahen Wochen: der Knopf ist genau fuer den Fall da,
// dass in WebUntis etwas geaendert wurde und man nicht auf den naechsten Takt warten will.
$('#untisSync').onclick = async () => {
  const knopf = $('#untisSync');
  knopf.disabled = true;
  const vorher = knopf.textContent;
  knopf.textContent = 'Abgleich läuft …';
  try {
    const r = await api('POST', '/api/untis/sync');
    toast(untisMeldung(r), true);
    state.plan = null; // der Plan zeigt sonst den Stand von vorhin
  } catch (err) { oops(err); }
  knopf.disabled = false;
  knopf.textContent = vorher;
  await loadUntis();
};

$('#untisTexte').onclick = async () => {
  const kasten = $('#untisTexteBericht');
  kasten.hidden = false;
  kasten.value = 'Frage WebUntis … das dauert ein paar Sekunden.';
  try {
    const tag = $('#untisTexteTag').value;
    const d = await api('GET', '/api/untis/texte' + (tag ? `?date=${tag}` : ''));
    kasten.value = d.bericht;
    $('#untisTexteKopie').hidden = false;
  } catch (err) {
    kasten.value = 'Fehlgeschlagen: ' + err.message;
  }
};
$('#untisTexteKopie').onclick = async () => {
  try { await navigator.clipboard.writeText($('#untisTexteBericht').value); toast('Kopiert.', true); }
  catch { $('#untisTexteBericht').select(); }
};

$('#untisWeg').onclick = async () => {
  if (!await bestaetigen('Verbindung trennen?\n\nZugang und alle abgeglichenen Stunden werden gelöscht. '
    + 'Dein selbst gebauter Plan bleibt.')) return;
  try { await api('DELETE', '/api/untis/account'); toast('Verbindung getrennt.', true); }
  catch (err) { oops(err); }
  await loadUntis();
};

// --- Das eigene Menue --------------------------------------------------------
// Knoepfe statt Ziehen: das funktioniert auf dem Handy und mit Tastatur, und es ist ein Bruchteil
// des Codes. Jede Aenderung geht sofort zum Server (der sie durch denselben Filter wie beim Lesen
// schickt), und die Leiste oben zieht mit. Seiten und Gruppen, eine Ebene tief.
function paintMenueBauer() {
  const m = structuredClone(state.me?.menue ?? []);
  const drin = new Set(m.flatMap(e => (typeof e === 'string' ? [e] : e.kinder)));
  const frei = Object.keys(SEITEN).filter(s => !drin.has(s) && (state.me?.is_admin || !s.startsWith('admin')));
  const gruppen = m.map((e, i) => [e, i]).filter(([e]) => typeof e !== 'string');

  const speichern = async neu => {
    try { state.me = await api('PATCH', '/api/me', { menue: neu }); paintNav(); paintMenueBauer(); }
    catch (err) { oops(err); }
  };
  const tausche = (liste, i, j) => { [liste[i], liste[j]] = [liste[j], liste[i]]; return speichern(m); };
  const knopf = (text, titel, tun, aus = false) => h('button', {
    type: 'button', className: 'tiny', textContent: text, title: titel, disabled: aus, onclick: tun });
  const neueGruppe = async () => {
    const name = await eingabe('Name der Gruppe');
    if (!name?.trim()) return null;
    const g = { name: name.trim().slice(0, 30), icon: '📁', kinder: [] };
    m.push(g);
    return g;
  };

  // Eine Seite oben: "in Gruppe" - die vorhandenen Gruppen oder eine neue.
  const inGruppe = (seite, i) => {
    const w = h('select', {}, h('option', { value: '', textContent: '↳ in Gruppe …' }),
      ...gruppen.map(([g, gi]) => h('option', { value: String(gi), textContent: g.name })),
      h('option', { value: 'neu', textContent: '+ Neue Gruppe' }));
    w.onchange = async () => {
      const ziel = w.value === 'neu' ? await neueGruppe() : m[Number(w.value)];
      if (!ziel) { w.value = ''; return; }
      m.splice(i, 1);
      ziel.kinder.push(seite);
      speichern(m);
    };
    return w;
  };

  const seitenZeile = (seite, liste, i, extra) => h('li', {},
    h('span', { className: 'grow', textContent: `${SEITEN[seite]?.[1] ?? ''} ${beschriftung(seite)}` }),
    knopf('↑', 'nach vorn', () => tausche(liste, i, i - 1), i === 0),
    knopf('↓', 'nach hinten', () => tausche(liste, i, i + 1), i === liste.length - 1),
    extra,
    knopf('×', 'aus dem Menü nehmen', () => { liste.splice(i, 1); speichern(m); }));

  const zeilen = m.map((e, i) => {
    if (typeof e === 'string') return seitenZeile(e, m, i, inGruppe(e, i));
    const name = h('input', { value: e.name, maxLength: 30, className: 'kurz', title: 'Name der Gruppe' });
    name.onchange = () => { e.name = name.value.trim() || e.name; speichern(m); };
    const icon = h('input', { value: e.icon, maxLength: 4, className: 'symbol', title: 'Symbol (Emoji)' });
    icon.onchange = () => { e.icon = icon.value.trim() || '📁'; speichern(m); };
    return h('li', { className: 'gruppe' },
      h('div', { className: 'row' }, icon, name, h('span', { className: 'grow' }),
        knopf('↑', 'nach vorn', () => tausche(m, i, i - 1), i === 0),
        knopf('↓', 'nach hinten', () => tausche(m, i, i + 1), i === m.length - 1),
        knopf('×', 'Gruppe auflösen – die Seiten kommen nach oben', () => { m.splice(i, 1, ...e.kinder); speichern(m); })),
      h('ul', { className: 'list' },
        ...e.kinder.map((k, j) => seitenZeile(k, e.kinder, j,
          knopf('↰', 'nach oben ins Hauptmenü', () => { e.kinder.splice(j, 1); m.splice(i + 1, 0, k); speichern(m); }))),
        e.kinder.length ? null : h('li', {}, h('span', { className: 'muted small',
          textContent: 'Noch leer – unten eine Seite hinzufügen und mit „in Gruppe" hierher.' }))));
  });

  const neu = h('select', {}, h('option', { value: '', textContent: '+ Seite hinzufügen …' }),
    ...frei.map(s => h('option', { value: s, textContent: beschriftung(s) })));
  neu.onchange = () => { if (neu.value) { m.push(neu.value); speichern(m); } };

  setzeKinder($('#menueBauer'),
    h('ul', { className: 'list menue-liste' }, ...zeilen),
    h('div', { className: 'row' }, neu,
      h('button', { type: 'button', className: 'tiny', textContent: '+ Gruppe', onclick: async () => { if (await neueGruppe()) speichern(m); } }),
      h('span', { className: 'grow' }),
      h('button', { type: 'button', className: 'tiny ghost', textContent: 'Zurücksetzen', title: 'Wieder das Menü, wie es am Anfang war',
        onclick: async () => { if (await bestaetigen('Dein eigenes Menü verwerfen und auf die Vorgabe zurücksetzen?')) speichern(null); } })));
}

// Kursnamen und -farben: gespeichert wird beim Verlassen des Feldes bzw. beim Farbwechsel -
// ein Speichern-Knopf je Zeile waere bei zwanzig Kursen nur Klickarbeit.
async function loadKurse() {
  const liste = $('#kursListe');
  const kurse = await api('GET', '/api/my-courses').catch(() => []);
  if (!kurse.length) {
    liste.replaceChildren(h('li', { className: 'muted',
      textContent: 'Sobald Kurse in deinem Plan stehen, kannst du sie hier umbenennen.' }));
    return;
  }

  // Rueckgaengig schreibt die Werte von vor dem Aendern zurueck - standen keine, loescht es die
  // Einstellung wieder. `c` wird dabei mitgezogen, damit ein zweites Aendern das erste kennt.
  const sichern = async (c, werte) => {
    const alt = { name: c.pref_name, short: c.pref_short, color: c.pref_color };
    try { await api('PUT', `/api/my-courses/${encodeURIComponent(c.id)}`, werte); }
    catch (err) { return oops(err); }
    state.plan = null;
    Object.assign(c, { pref_name: werte.name, pref_short: werte.short, pref_color: werte.color });
    rueckgaengig('Kurs gespeichert.', async () => {
      const weg = `/api/my-courses/${encodeURIComponent(c.id)}`;
      await (alt.name || alt.short || alt.color ? api('PUT', weg, alt) : api('DELETE', weg));
      state.plan = null;
      await loadKurse();
    });
  };

  liste.replaceChildren(...kurse.map(c => {
    const original = c.subject || c.title || c.id;
    const urKuerzel = c.subject_short || (original || '').slice(0, 2).toUpperCase();
    const name = h('input', { type: 'text', value: c.pref_name ?? '', placeholder: original, maxLength: 40 });
    const kurz = h('input', {
      type: 'text', className: 'kuerzelfeld', value: c.pref_short ?? '',
      placeholder: urKuerzel, maxLength: 6, title: 'Kürzel für die kompakte Ansicht',
      'aria-label': 'Kürzel',
    });
    const farbe = h('input', { type: 'color', value: c.pref_color || farbeAusHue(courseHue(c.id)) });
    const alles = () => ({ name: name.value, short: kurz.value, color: farbe.value });
    name.onchange = () => sichern(c, alles());
    kurz.onchange = () => sichern(c, alles());
    farbe.onchange = () => sichern(c, alles());

    const zurueck = h('button', {
      className: 'tiny ghost', textContent: 'Zurücksetzen', title: `Original: ${original}`,
      onclick: async () => {
        try { await api('DELETE', `/api/my-courses/${encodeURIComponent(c.id)}`); }
        catch (err) { return oops(err); }
        state.plan = null;
        await loadKurse();
      },
    });

    // Zusammenfuehren gehoert hierher, nicht nur in die Vorschlagskarte: die Duplikate stehen in
    // DIESER Liste, und ob die App sie selbst erkennt, ist Glueckssache.
    const verbinden = h('button', {
      className: 'tiny ghost', textContent: 'Zusammenführen …',
      title: 'Diesen Kurs in einen anderen überführen',
      onclick: () => zusammenfuehren(c, kurse.filter(x => x.id !== c.id)),
    });

    return h('li', {},
      h('span', { className: 'titel' },
        h('strong', { textContent: original }),
        h('small', { className: 'muted', textContent: c.id })),
      name, kurz, farbe, verbinden, zurueck);
  }));
}

/**
 * Einen Kurs in einen anderen ueberfuehren. Alles, was dem Nutzer an dem Kurs haengt, wandert mit:
 * Name, Kuerzel, Farbe, Hausaufgaben, eigene Eintraege, abgeglichene Stunden. Fuer andere, die
 * denselben Kurs haben, aendert sich nichts.
 */
async function zusammenfuehren(kurs, andere) {
  if (!andere.length) return toast('Es gibt keinen zweiten Kurs, in den er passen könnte.');
  const dlg = $('#kursMerge'), f = $('#kursMergeForm');
  $('#kursMergeVon').textContent = courseLabel(kurs);
  f.ziel.replaceChildren(...andere.map(c =>
    h('option', { value: c.id, textContent: courseLabel(c) })));
  if (kurs.nachfolger?.length) f.ziel.value = kurs.nachfolger[0];

  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('POST', `/api/my-courses/${encodeURIComponent(kurs.id)}/zusammenfuehren`,
        { ziel: f.ziel.value });
      dlg.close();
      state.plan = null;
      await loadKurse(); await loadAltKurse();
      toast(`Zusammengeführt${r.verschoben ? `, ${r.verschoben} Hausaufgaben mitgenommen` : ''}.`, true);
    } catch (err) { oops(err); }
  };
  $('#kursMergeAbbruch').onclick = () => dlg.close();
  dlg.showModal();
}

/**
 * Kurse, die es nur noch in der Vergangenheit gibt. Sie entstehen, wenn WebUntis eine Kursnummer
 * aendert - dann steht das Fach doppelt da, und Farbe wie Hausaufgaben haengen an der alten ID.
 * Was eindeutig ist, hat der Abgleich schon selbst zusammengefuehrt; hier liegt nur der Rest.
 */
async function loadAltKurse() {
  const alte = await api('GET', '/api/my-courses/aufraeumen').catch(() => []);
  $('#altKurseKarte').hidden = !alte.length;
  if (!alte.length) return;

  const aktiv = (await api('GET', '/api/my-courses').catch(() => []))
    .filter(c => !alte.some(a => a.id === c.id))
    .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b), 'de'));

  $('#altKurse').replaceChildren(...alte.map(k => {
    const ziel = h('select', {},
      ...aktiv.map(c => h('option', { value: c.id, textContent: courseLabel(c) })));
    if (k.nachfolger.length) ziel.value = k.nachfolger[0];
    ziel.disabled = !aktiv.length;

    const zusammen = h('button', {
      className: 'tiny primary', textContent: 'Zusammenführen', disabled: !aktiv.length,
      onclick: async () => {
        const zielName = ziel.options[ziel.selectedIndex]?.textContent ?? ziel.value;
        if (!await bestaetigen([
          `"${courseLabel(k)}" geht auf in "${zielName}".`,
          `Danach gibt es bei dir nur noch "${zielName}" — Hausaufgaben, Stunden und Einträge `
            + 'wandern dorthin. Für andere ändert sich nichts. Rückgängig geht es nicht.',
        ].join('\n\n'))) return;
        try {
          const r = await api('POST', `/api/my-courses/${encodeURIComponent(k.id)}/zusammenfuehren`,
            { ziel: ziel.value });
          toast(`Zusammengeführt${r.verschoben ? `, ${r.verschoben} Hausaufgaben mitgenommen` : ''}.`, true);
          state.plan = null;
          await loadKurse(); await loadAltKurse();
        } catch (err) { oops(err); }
      },
    });

    const weg = h('button', {
      className: 'tiny ghost', textContent: 'Entfernen',
      onclick: async () => {
        if (!await bestaetigen(`"${courseLabel(k)}" entfernen?\n\n`
          + (k.hausaufgaben
            ? `${k.hausaufgaben} Hausaufgabe${k.hausaufgaben > 1 ? 'n' : ''} und deine Einstellungen `
              + 'dazu werden gelöscht. '
            : 'Deine Einstellungen dazu werden gelöscht. ')
          + 'Für andere ändert sich nichts.')) return;
        try {
          await api('DELETE', `/api/my-courses/${encodeURIComponent(k.id)}/reste`);
          toast('Entfernt.', true);
          state.plan = null;
          await loadKurse(); await loadAltKurse();
        } catch (err) { oops(err); }
      },
    });

    return h('li', {},
      h('span', { className: 'grow' },
        h('strong', { textContent: courseLabel(k) }),
        // Die Kursnummer steht schon im Label - hier nur, was sonst noch daran haengt.
        h('small', { className: 'muted', textContent:
          [k.grund === 'veraltet' ? 'nur noch in der Vergangenheit' : 'steht doppelt im Plan',
            k.hausaufgaben ? `${k.hausaufgaben} Hausaufgabe${k.hausaufgaben > 1 ? 'n' : ''}` : null,
            k.nachfolger.length ? null : 'kein passender Nachfolger gefunden']
            .filter(Boolean).join(' · ') })),
      // Ohne diese zwei Woerter sieht man dem Auswahlfeld nicht an, welcher der beiden Kurse
      // bleibt und welcher verschwindet - danach wurde gefragt.
      h('small', { className: 'muted', textContent: 'geht auf in' }),
      ziel, zusammen, weg);
  }));
}

// Der Farbwaehler braucht einen Startwert - die Farbe, die der Plan ohnehin schon zeigt.
const farbeAusHue = hue => {
  const f = (n, k = (n + hue / 30) % 12) =>
    Math.round(255 * (0.55 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
};

// Notausgang: wenn der hinterlegte Schluessel nicht mehr zum Passwort passt (Admin-Reset), kommt
// man sonst nirgends mehr hinein. Bewusst hier und nicht im Chat - es ist ein Eingriff, kein
// Bedienschritt, und der bisherige Verlauf ist danach endgueltig verloren.
$('#chatReset').onclick = async () => {
  const frage = [
    'Chat-Schlüssel zurücksetzen?',
    'Alle bisherigen Nachrichten bleiben danach für immer unlesbar — auch für dein Gegenüber, '
      + 'soweit sie an dich gingen.',
    'Neue Nachrichten funktionieren wieder.',
  ].join('\n\n');
  if (!await bestaetigen(frage)) return;
  const passwort = await eingabe('Dein aktuelles Passwort:', '', { passwort: true }) || '';
  if (!passwort) return;
  try {
    await chatNeuAnfangen(passwort);
    toast('Neuer Chat-Schlüssel angelegt.', true);
  } catch (err) { oops(err); }
};

// Sechs Karten untereinander waren nicht mehr zu ueberblicken - dieselbe Reiterleiste wie im
// Admin-Bereich, und die zuletzt gewaehlte Gruppe wird gemerkt.
const PROFIL_GRUPPEN = [
  { key: 'profil', titel: 'Profil' },
  { key: 'ansicht', titel: 'Ansicht' },
  { key: 'kurse', titel: 'Kurse' },
  { key: 'nachrichten', titel: 'Nachrichten' },
  { key: 'menue', titel: 'Menü' },
  { key: 'konto', titel: 'Konto' },
];
const PROFIL_KEY = 'profilGruppe';
let profilGruppe = 'profil';
try { profilGruppe = localStorage.getItem(PROFIL_KEY) || profilGruppe; } catch { /* Privatmodus */ }
// Von aussen (eigenes Menue): den Unterreiter setzen, bevor loadProfile laeuft.
export function profilReiterSetzen(k) {
  if (!PROFIL_GRUPPEN.some(g => g.key === k)) return;
  profilGruppe = k;
  try { localStorage.setItem(PROFIL_KEY, k); } catch { /* Privatmodus */ }
}

function maleProfilReiter() {
  $('#profilReiter').replaceChildren(...PROFIL_GRUPPEN.map(g => h('button', {
    type: 'button',
    textContent: g.titel,
    className: g.key === profilGruppe ? 'active' : '',
    onclick: () => {
      profilGruppe = g.key;
      try { localStorage.setItem(PROFIL_KEY, g.key); } catch { /* Privatmodus */ }
      maleProfilReiter();
    },
  })));
  scrollHinweis($('#profilReiter'));
  // Karten, die sich selbst verstecken (WebUntis ohne Schluessel, "Sieht doppelt aus" ohne
  // Vorschlaege), bleiben davon unberuehrt: sie tragen zusaetzlich `hidden`.
  for (const karte of $$('section[data-panel="profile"] .card[data-gruppe]'))
    karte.classList.toggle('weg', karte.dataset.gruppe !== profilGruppe);
}

export async function loadProfile() {
  maleProfilReiter();
  const me = state.me;
  loadUntis().catch(() => {});
  loadKurse().catch(() => {});
  loadAltKurse().catch(() => {});
  paintPush().catch(() => {});
  paintMenueBauer();
  paintStatusFarben();
  $('#avatarPreview').replaceChildren(avatarEl(me, 'big'));
  paintBanner($('#bannerPreview'), me, me.has_banner ? '' : 'Noch kein Banner — Verlauf aus deiner Farbe');
  const f = $('#profileForm');
  f.display_name.value = me.display_name ?? '';
  f.color.value = colorOf(me);
  f.emoji.value = me.emoji ?? '';
  $('#zeigeInfo').checked = me.zeige_info === true;
  $('#navStyle').value = me.nav_style ?? 'text';
  $('#jetztStil').value = me.jetzt_stil ?? 'zeit';
  $('#planStil').value = me.plan_stil ?? 'standard';
  $('#stundenForm').value = me.stunden_form ?? 'eckig';
  $('#ausfallStil').value = me.ausfall_stil ?? 'deutlich';
  $('#pruefungDoppelt').value = me.pruefung_doppelt ?? 'meine';
  paintZugang();
  $('#designWahl').value = me.design ?? 'modern';
  $('#dropAvatar').hidden = !me.has_avatar;
  $('#dropBanner').hidden = !me.has_banner;
}

$('#profileForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    state.me = await api('PATCH', '/api/me', {
      display_name: f.display_name.value,
      color: f.color.value,
      emoji: f.emoji.value,
    });
    paintMe();
    state.plan = null;   // der Marker im Plan haengt daran
    await loadProfile();
    toast('Profil gespeichert.', true);
  } catch (err) { oops(err); }
};

$('#passwordForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    // Der private Chat-Schluessel haengt am Passwort und muss mitwandern, sonst waere der
    // Verlauf nach dem Wechsel auf jedem anderen Geraet verloren.
    const r = await schluesselUmpacken(f.current.value, f.new.value);

    // Ein Netzfehler ist kein Grund, den Verlauf wegzuwerfen - dann lieber gar nichts tun.
    if (r.netzfehler) return toast('Keine Verbindung — bitte gleich noch einmal versuchen.');

    // Der Schluessel laesst sich nicht oeffnen (Admin-Reset, oder ein frueherer Wechsel ging
    // schief). Frueher lief die Aenderung hier einfach durch und der Verlauf war still weg.
    if (r.passtNicht && !await bestaetigen([
      'Dein Chat-Schlüssel lässt sich mit dem alten Passwort nicht mehr öffnen.',
      'Wenn du das Passwort jetzt änderst, bleiben alle bisherigen Nachrichten mit allen Freunden '
        + 'für immer unlesbar — auch für die anderen.',
      'Neue Nachrichten funktionieren danach wieder. Trotzdem ändern?',
    ].join('\n\n'))) return;

    await api('POST', '/api/me/password', {
      current: f.current.value, new: f.new.value,
      ...r.key && { priv_key_enc: r.key },
      ...r.passtNicht && { chat_key_verwerfen: true },
    });
    // Verworfen heisst: der Server hat beide Teile geleert. Gleich ein frisches Paar anlegen, sonst
    // steht der Chat bis zum naechsten Anmelden ohne Schluessel da.
    if (r.passtNicht) await schluesselEinrichten(f.new.value).catch(() => {});
    f.reset();
    toast(r.passtNicht ? 'Passwort geändert. Der Chat fängt neu an.' : 'Passwort geändert.', true);
  } catch (err) { oops(err); }
};

// Avatar (quadratisch) und Banner (breit) laufen durch dieselbe Mechanik.
const BILDER = {
  avatar: { datei: '#avatarFile', knopf: '#pickAvatar', weg: '#dropAvatar', w: 128, h: 128 },
  banner: { datei: '#bannerFile', knopf: '#pickBanner', weg: '#dropBanner', w: 1024, h: 256 },
};

for (const [feld, cfg] of Object.entries(BILDER)) {
  $(cfg.knopf).onclick = () => $(cfg.datei).click();

  $(cfg.datei).onchange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.me = await api('PATCH', '/api/me', { [feld]: await shrink(file, cfg.w, cfg.h) });
      paintMe();
      await loadProfile();
      toast('Bild gespeichert.', true);
    } catch (err) { oops(err); }
  };

  $(cfg.weg).onclick = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { [feld]: null });
      paintMe();
      await loadProfile();
    } catch (err) { oops(err); }
  };
}

// Verkleinern passiert im Browser - so geht nie ein 5-MB-Handyfoto durch die API. Zugeschnitten
// wird mittig auf das Zielformat (cover), damit nichts verzerrt.
async function shrink(file, w, h) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.max(w / bitmap.width, h / bitmap.height);
  const sw = w / scale, sh = h / scale;
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d').drawImage(bitmap,
    (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, w, h);
  bitmap.close();
  const webp = canvas.toDataURL('image/webp', 0.82);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
}

// --- Benachrichtigungen im Profil -------------------------------------------

const pushMoeglich = () => 'serviceWorker' in navigator && 'PushManager' in window;

// Pruefungen aus WebUntis - nur auf Knopfdruck. Das Ergebnis in einem Satz.
$('#pruefImport').onclick = async e => {
  const knopf = e.currentTarget;
  knopf.disabled = true;
  try {
    const r = await api('POST', '/api/untis/pruefungen/import', { auch_geloeschte: $('#pruefAuchGeloeschte').checked });
    $('#pruefAuchGeloeschte').checked = false;
    state.plan = null;   // die gelben Kaesten im Plan
    const teile = [r.neu && `${r.neu} neu`, r.aktualisiert && `${r.aktualisiert} aktualisiert`,
      r.doppelt && `${r.doppelt} schon von dir eingetragen`, r.geloescht && `${r.geloescht} von dir gelöscht`].filter(Boolean);
    toast(r.gefunden ? `${r.gefunden} Prüfungen gefunden: ${teile.join(', ') || 'alle schon da'}.`
      : 'WebUntis meldet keine Prüfungen in den nächsten Monaten.', true);
  } catch (err) { oops(err); }
  finally { knopf.disabled = false; }
};

// Zugangsdaten nur fuer mich verschluesseln: Stand zeigen, ein- und ausschalten.
function paintZugang() {
  const an = !!state.me?.zugang_eigen;
  $('#zugangStand').textContent = !an ? 'Aus – der Server verschlüsselt deine Zugangsdaten (Standard).'
    : state.me?.zugang_bereit === false
      ? 'An – auf diesem Gerät fehlt dein Schlüssel: einmal ab- und wieder anmelden, dann gleicht es wieder ab.'
      : 'An – nur du kannst deine Zugangsdaten lesen.';
  $('#zugangSchalter').textContent = an ? 'Ausschalten …' : 'Einschalten …';
}
$('#zugangSchalter').onclick = async () => {
  const an = !state.me?.zugang_eigen;
  if (an && !(await bestaetigen('Zugangsdaten nur mit deinem Passwort verschlüsseln? Lies vorher die Hinweise im Kasten – '
    + 'vor allem: abgeglichen wird dann nur, während du die App benutzt.', { ja: 'Einschalten' }))) return;
  const pw = await eingabe('Dein Passwort für den Stundenplan', '', { passwort: true, ok: an ? 'Einschalten' : 'Ausschalten' });
  if (!pw) return;
  try {
    state.me = await api('POST', '/api/me/zugang', { an, password: pw });
    paintZugang();
    toast(an ? 'Deine Zugangsdaten sind jetzt mit deinem Passwort verschlüsselt.' : 'Wieder wie vorher: der Server verschlüsselt.', true);
  } catch (err) { oops(err); }
};

// Die Ansicht speichert beim Aendern, ohne Knopf - wie die Push-Schalter. Ein eigener
// Speichern-Knopf fuer drei Auswahlfelder waere ein Klick, den niemand braucht.
for (const [id, feld] of [['#navStyle', 'nav_style'], ['#jetztStil', 'jetzt_stil'], ['#planStil', 'plan_stil'],
  ['#designWahl', 'design'], ['#stundenForm', 'stunden_form'], ['#ausfallStil', 'ausfall_stil'],
  ['#pruefungDoppelt', 'pruefung_doppelt']]) {
  $(id).onchange = async e => {
    try {
      state.me = await api('PATCH', '/api/me', { [feld]: e.target.value });
      paintMe();
      state.plan = null;   // der Zeitstrich haengt daran
      toast('Gespeichert.', true);
    } catch (err) { oops(err); e.target.value = state.me?.[feld] ?? e.target.value; }
  };
}
// Die Farben der Stundenzustaende - wie die Kalenderfarben: aendern speichert, ohne Knopf.
const STATUS_TEXT = [['entfaellt', 'Ausfall'], ['vertretung', 'Vertretung'],
  ['ohne_lehrer', 'Vertretung ohne Lehrer'], ['raum', 'Raumänderung'], ['pruefung', 'Prüfung (Umrandung)']];
const STATUS_VORGABE = { entfaellt: '#c0392b', vertretung: '#d98b2b', ohne_lehrer: '#d98b2b', raum: '#d98b2b',
  pruefung: '#f5c400' };

function paintStatusFarben() {
  const farben = state.me?.status_farben ?? STATUS_VORGABE;
  const sichern = async neu => {
    try {
      state.me = await api('PATCH', '/api/me', { status_farben: neu });
      state.plan = null;   // der Plan traegt die Farben
      paintStatusFarben();
      toast('Gespeichert.', true);
    } catch (err) { oops(err); }
  };
  $('#statusFarben').replaceChildren(
    ...STATUS_TEXT.map(([k, text]) => {
      const f = h('input', { type: 'color', value: farben[k] ?? STATUS_VORGABE[k] });
      f.onchange = () => sichern({ [k]: f.value });
      return h('label', { className: 'check' }, f, ' ' + text);
    }),
    h('div', {}, h('button', { type: 'button', className: 'tiny ghost', textContent: 'Zurücksetzen',
      onclick: () => sichern(STATUS_VORGABE) })));
}

$('#zeigeInfo').onchange = async e => {
  try {
    state.me = await api('PATCH', '/api/me', { zeige_info: e.target.checked });
    state.plan = null;   // das Info-Zeichen im Plan haengt daran
    toast('Gespeichert.', true);
  } catch (err) { oops(err); e.target.checked = !e.target.checked; }
};

// --- Benachrichtigungen: je Art ein eigener Plan -----------------------------
// sofort | gesammelt (zu einer Uhrzeit) | vorlauf (eine Zeit VOR dem Ereignis) | aus.
// Die Zeilen entstehen hier, damit die Oberflaeche nur zeigt, was fuer die jeweilige Art
// ueberhaupt Sinn ergibt: einen Chat kann man nicht "30 Minuten vorher" bekommen.
const PUSH_ARTEN = [
  ['ausfall', 'Stunden, die ausfallen', true],
  ['vertretung', 'Vertretungen', true],
  ['aenderung', 'Änderungen an einer Stunde (Raum, Kurs, Hinweis)', true],
  ['hausaufgaben', 'Neue Hausaufgaben', true],
  ['todo', 'ToDo-Erinnerungen', false],
  ['chat', 'Neue Chat-Nachrichten', false],
  ['freunde', 'Freundschaftsanfragen', false],
  ['ticket', 'Antworten auf Bugs/Vorschläge', false],
  ['pruefung', 'Prüfungen (Tage vorher: siehe unten)', false],
  ['buero', 'Büro: Abstimmungen, Umfragen, Ideen, Notizen', false],
  ['kurschat', 'Kurschat (Nachrichten in deinen Kursen – einzelne Kurse im Chat stummschalten)', false],
];

// Mehr als das baut sich niemand mit Absicht - der Server deckelt genauso.
const MAX_REGELN = 4;

function pushZeile(art, mitVorlauf, regeln, i, neuMalen, speichern) {
  const p = regeln[i];

  const modus = h('select', {}, ...[
    ['sofort', 'Sofort'], ['gesammelt', 'Gesammelt'],
    ['vorlauf', 'Zum Zeitpunkt'], ['aus', 'Aus'],
  ].map(([v, t]) => h('option', { value: v, textContent: t, selected: p.modus === v })));

  // Eigene Uhrzeit - leer heisst: die gemeinsame unten.
  const zeit = h('input', { type: 'time', value: p.zeit ?? '' });

  // Der Vorlauf ist frei eintragbar, keine Auswahl aus einer Liste: wer eine Stunde und
  // siebenundvierzig Minuten vorher erinnert werden will, soll genau das eintragen koennen.
  const min = Number(p.vorlauf_min) || 0;
  const std = h('input', { type: 'number', min: 0, max: 168, step: 1,
    className: 'kurz', value: String(Math.floor(min / 60)), title: 'Stunden vorher' });
  const rest = h('input', { type: 'number', min: 0, max: 59, step: 1,
    className: 'kurz', value: String(min % 60), title: 'Minuten vorher' });
  // Drei Bezugspunkte. Die ersten beiden gibt es nur, wo im Stundenplan ein Zeitpunkt steht;
  // "nach der Meldung" braucht keinen und geht deshalb ueberall.
  const bezug = h('select', {}, ...[
    ...(mitVorlauf ? [['stunde', 'vor der Stunde'], ['schultag', 'vor Schulbeginn']] : []),
    ['meldung', 'nach der Meldung'],
  ].map(([v, t]) => h('option', {
    value: v, textContent: t,
    selected: p.bezug === v || (!mitVorlauf && v === 'meldung'),
  })));

  // "vorher" oder "später" - beim Bezug auf die Meldung zaehlt die Zeit nach vorn.
  const wort = h('small', { textContent: 'Min' });
  const vorlaufFeld = h('span', { className: 'vorlauf' },
    std, h('small', { textContent: 'Std' }), rest, wort);

  // Eine Regel laesst sich wieder wegnehmen - solange eine uebrig bleibt. "Keine Regel" waere
  // sonst ein zweiter Weg, dieselbe Art abzuschalten, und der heisst schon "Aus".
  const weg = h('button', {
    type: 'button', className: 'tiny ghost', textContent: '−', title: 'Diese Regel entfernen',
    hidden: regeln.length < 2,
    onclick: () => { regeln.splice(i, 1); neuMalen(); speichern(); },
  });
  // Der Titel steht ueber dem Block, nicht in der Zeile - sonst rutschen die Felder bei mehreren
  // Regeln an den rechten Rand und stehen unter nichts.
  const zeile = h('div', { className: 'push-zeile' }, modus, zeit, vorlaufFeld, bezug, weg);

  const sync = () => {
    zeit.hidden = modus.value !== 'gesammelt';
    vorlaufFeld.hidden = bezug.hidden = modus.value !== 'vorlauf';
    wort.textContent = bezug.value === 'meldung' ? 'Min später' : 'Min vorher';
  };
  const merken = () => {
    regeln[i] = {
      modus: modus.value,
      zeit: zeit.value || '',
      // Null und null heisst: genau zum Zeitpunkt.
      vorlauf_min: Math.min((Number(std.value) || 0) * 60 + (Number(rest.value) || 0), 168 * 60),
      bezug: bezug.value,
    };
    sync();
    speichern();
  };
  for (const el of [modus, zeit, std, rest, bezug]) el.onchange = merken;
  sync();
  return zeile;
}

/**
 * Eine Art mit allen ihren Regeln.
 *
 * Mehrere nebeneinander, weil "sofort" und "nochmal vor der Stunde" beides Sinn ergibt - und
 * zusammen etwas anderes sagen als jedes fuer sich.
 */
function pushBlock(art, titel, mitVorlauf, plan, speichern) {
  // Aus alten Plaenen kommt hier noch ein einzelnes Objekt.
  const regeln = Array.isArray(plan[art]) ? plan[art] : [plan[art] ?? { modus: 'sofort' }];
  plan[art] = regeln;

  const zeilen = h('div', { className: 'stack' });
  const plus = h('button', {
    type: 'button', className: 'tiny ghost', textContent: '+ Regel',
    onclick: () => {
      regeln.push({ modus: 'vorlauf', vorlauf_min: 30, bezug: mitVorlauf ? 'stunde' : 'meldung' });
      malen();
      speichern();
    },
  });
  const malen = () => {
    zeilen.replaceChildren(...regeln.map((r, i) =>
      pushZeile(art, mitVorlauf, regeln, i, () => malen(), speichern)));
    plus.hidden = regeln.length >= MAX_REGELN;
  };
  malen();

  return h('div', { className: 'push-block' },
    h('div', { className: 'row' },
      h('span', { className: 'grow', textContent: titel }), plus),
    zeilen);
}

function malePushPlan(me) {
  const plan = structuredClone(me.push_plan ?? {});
  let warte;
  const speichern = () => {
    // Sammeln statt bei jedem Klick senden: wer drei Felder umstellt, loest sonst drei Anfragen aus.
    clearTimeout(warte);
    warte = setTimeout(async () => {
      try {
        state.me = await api('PATCH', '/api/me', { push_plan: plan });
        toast('Gespeichert.', true);
      } catch (err) { oops(err); }
    }, 400);
  };
  $('#pushPlan').replaceChildren(
    ...PUSH_ARTEN.map(([art, titel, mitVorlauf]) =>
      pushBlock(art, titel, mitVorlauf, plan, speichern)));

  // Voreinstellung fuer neue Hausaufgaben - in denselben zwei freien Feldern wie ueberall.
  const hwMin = Number(me.hw_erinnerung_min) || 0;
  const hStd = $('#hwErinnernStd'), hMin = $('#hwErinnernMin');
  hStd.value = String(Math.floor(hwMin / 60));
  hMin.value = String(hwMin % 60);
  const hwMerken = async () => {
    try {
      state.me = await api('PATCH', '/api/me', {
        hw_erinnerung_min: (Number(hStd.value) || 0) * 60 + (Number(hMin.value) || 0) });
      toast('Gespeichert.', true);
    } catch (err) { oops(err); }
  };
  hStd.onchange = hMin.onchange = hwMerken;

  // Vor Pruefungen erinnern - so viele Tage vorher; je Pruefung im Termin ueberschreibbar.
  const vorlauf = $('#pruefungVorlauf');
  vorlauf.value = me.pruefung_vorlauf_tage ?? 7;
  vorlauf.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { pruefung_vorlauf_tage: Number(vorlauf.value) });
      vorlauf.value = state.me.pruefung_vorlauf_tage;
      toast('Gespeichert.', true);
    } catch (err) { oops(err); vorlauf.value = state.me?.pruefung_vorlauf_tage ?? 7; }
  };

  // Fenster & Meldungen - drei Schalter, dasselbe Muster wie die uebrigen.
  const schalter = (id, feld) => {
    const el = $(id);
    el.checked = me[feld] !== false;
    el.onchange = async () => {
      try { state.me = await api('PATCH', '/api/me', { [feld]: el.checked }); toast('Gespeichert.', true); }
      catch (err) { oops(err); el.checked = !el.checked; }
    };
  };
  schalter('#dialogHintergrund', 'dialog_hintergrund');
  schalter('#toastFehlerBleibt', 'toast_fehler_bleibt');
  const sek = $('#toastSekunden');
  sek.value = me.toast_sekunden ?? 3;
  sek.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { toast_sekunden: Number(sek.value) });
      sek.value = state.me.toast_sekunden;
      toast(`Gespeichert — ${state.me.toast_sekunden} Sekunden.`, true);
    } catch (err) { oops(err); sek.value = state.me?.toast_sekunden ?? 3; }
  };

  // Erledigte Hausaufgaben: auf Wunsch bleibt das Zeichen im Plan, nur grau.
  const erledigt = $('#hwErledigtZeigen');
  erledigt.checked = !!me.hw_erledigt_zeigen;
  erledigt.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { hw_erledigt_zeigen: erledigt.checked });
      state.plan = null;
      toast('Gespeichert.', true);
    } catch (err) { oops(err); erledigt.checked = !erledigt.checked; }
  };

  // Der Zaehler am Reiter - manche wollen keine roten Zahlen sehen.
  const zaehler = $('#hwBadge2');
  if (zaehler) {
    zaehler.checked = me.hw_badge !== false;
    zaehler.onchange = async () => {
      try {
        state.me = await api('PATCH', '/api/me', { hw_badge: zaehler.checked });
        toast('Gespeichert.', true);
        await malHwBadge();
      } catch (err) { oops(err); zaehler.checked = !!state.me?.hw_badge; }
    };
  }

  // Ueberfaelliges nach ein paar Tagen wegwerfen - die Frist stellt jeder selbst ein.
  const loeschen = $('#hwLoeschen');
  loeschen.value = me.hw_loeschen_tage ?? 7;
  loeschen.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { hw_loeschen_tage: Number(loeschen.value) });
      loeschen.value = state.me.hw_loeschen_tage;
      toast('Gespeichert.', true);
    } catch (err) { oops(err); loeschen.value = state.me?.hw_loeschen_tage ?? 7; }
  };
  const todoLoeschen = $('#todoLoeschen');
  todoLoeschen.value = me.todo_loeschen_tage ?? 30;
  todoLoeschen.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { todo_loeschen_tage: Number(todoLoeschen.value) });
      todoLoeschen.value = state.me.todo_loeschen_tage;
      toast('Gespeichert.', true);
    } catch (err) { oops(err); todoLoeschen.value = state.me?.todo_loeschen_tage ?? 30; }
  };

  // Standardmaessig aus: die Meldung nennt Namen.
  const freiAn = $('#freiHinweis');
  freiAn.checked = !!me.frei_hinweis;
  freiAn.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { frei_hinweis: freiAn.checked });
      toast('Gespeichert.', true);
    } catch (err) { oops(err); freiAn.checked = !!state.me?.frei_hinweis; }
  };

  const zeit = $('#digestZeit');
  zeit.value = me.digest_zeit ?? '19:00';
  zeit.onchange = async () => {
    try {
      state.me = await api('PATCH', '/api/me', { digest_zeit: zeit.value });
      toast('Gespeichert.', true);
    } catch (err) { oops(err); zeit.value = state.me?.digest_zeit ?? '19:00'; }
  };
}

async function pushAbo() {
  if (!pushMoeglich()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function paintPush() {
  const karte = $('#pushKarte');
  const hinweis = $('#pushHinweis');
  malePushPlan(state.me ?? {});

  // Im WebView der Android-App gibt es keinen PushManager - der iPhone-Hinweis waere dort falsch.
  // Die App holt die Meldungen selbst ab; der Regelplan darueber gilt weiter.
  if (navigator.userAgent.includes('StundenplanApp/')) {
    hinweis.textContent = 'Benachrichtigungen kommen über die Android-App — ein- und ausschalten '
      + 'in den Android-Einstellungen der App.';
    $('#pushAn').hidden = true;
    $('#pushAus').hidden = true;
    return;
  }
  if (!pushMoeglich()) {
    hinweis.textContent = 'Dieser Browser kann keine Benachrichtigungen anzeigen. '
      + 'Auf dem iPhone geht es erst, wenn die App über „Zum Home-Bildschirm" installiert ist.';
    $('#pushAn').hidden = true;
    $('#pushAus').hidden = true;
    return;
  }

  const abo = await pushAbo().catch(() => null);
  const erlaubt = Notification.permission === 'granted';
  $('#pushAn').hidden = !!abo;
  $('#pushAus').hidden = !abo;
  hinweis.textContent = abo
    ? 'Dieses Gerät bekommt Benachrichtigungen.'
    : Notification.permission === 'denied'
      ? 'Der Browser blockiert Benachrichtigungen für diese Seite — das lässt sich nur in seinen '
        + 'Einstellungen wieder freigeben.'
      : erlaubt
        ? 'Erlaubt, aber dieses Gerät ist noch nicht angemeldet.'
        : 'Bekomm Bescheid, wenn eine Stunde ausfällt oder dir jemand schreibt — auch wenn die App '
          + 'geschlossen ist. Auf dem iPhone braucht es dafür die installierte App.';
}

// Der Browser will den Schluessel als Bytes, der Server liefert ihn als base64url.
const vonB64Url = s => Uint8Array.from(
  atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')),
  c => c.charCodeAt(0));

$('#pushAn').onclick = async () => {
  try {
    if (await Notification.requestPermission() !== 'granted') return paintPush();
    const { key } = await api('GET', '/api/push/key');
    if (!key) return toast('Auf diesem Server sind Benachrichtigungen nicht eingerichtet.');
    const reg = await navigator.serviceWorker.ready;
    const abo = await reg.pushManager.subscribe({
      userVisibleOnly: true,          // ohne das lehnen Chrome und Firefox ab
      applicationServerKey: vonB64Url(key),
    });
    await api('POST', '/api/push/subscribe', { endpoint: abo.endpoint });
    toast('Benachrichtigungen sind an.', true);
  } catch (err) { oops(err); }
  await paintPush();
};

$('#pushAus').onclick = async () => {
  try {
    const abo = await pushAbo();
    if (abo) {
      await api('DELETE', '/api/push/subscribe', { endpoint: abo.endpoint });
      await abo.unsubscribe();
    }
    toast('Auf diesem Gerät abgeschaltet.', true);
  } catch (err) { oops(err); }
  await paintPush();
};


// --- Version, Neuigkeiten, Datenschutz --------------------------------------
// Bewusst kein Menuepunkt: eine Fussnote, die man anklicken kann, wenn man will. Sie steht auch
// auf dem Anmeldebildschirm, denn die Datenschutzerklaerung muss ohne Konto lesbar sein.

export let infoDaten = null;

async function ladeInfo() {
  infoDaten ??= await api('GET', '/api/info').catch(() => null);
  if (infoDaten) $$('.version').forEach(el => (el.textContent = infoDaten.version));
  return infoDaten;
}

/** Nach dem Speichern im Admin: beim naechsten Oeffnen frisch holen. */
export const vergissInfo = () => (infoDaten = null);

async function zeigeInfo(reiter = 'news') {
  const d = $('#info');
  const i = await ladeInfo();
  if (!i) return toast('Keine Verbindung.');

  // Zwei Reiter statt einer langen Rolle: die Datenschutzerklaerung ist lang, und wer die
  // Neuigkeiten lesen will, soll nicht daran vorbeiscrollen muessen.
  const inhalt = h('div');
  const male = welcher => {
    reiterLeiste.replaceChildren(...[['news', 'Neuigkeiten'], ['privacy', 'Datenschutzerklärung']]
      .map(([k, t]) => h('button', {
        type: 'button', textContent: t, className: k === welcher ? 'active' : '',
        onclick: () => male(k),
      })));
    const text = welcher === 'news' ? i.news : i.privacy;
    const stand = welcher === 'news' ? i.news_at : i.privacy_at;
    inhalt.replaceChildren(...[
      text ? md(text) : h('p', { className: 'meta', textContent: welcher === 'news'
        ? 'Noch nichts eingetragen.' : 'Es ist noch keine hinterlegt.' }),
      stand ? h('p', { className: 'meta', textContent: `Stand: ${stand} Uhr` }) : null,
    ].filter(Boolean));
  };
  const reiterLeiste = h('div', { className: 'reiter' });

  d.replaceChildren(
    h('h2', { textContent: 'Stundenplan ' + i.version }),
    reiterLeiste,
    inhalt,
    h('div', { className: 'row end' },
      h('button', { className: 'ghost', textContent: 'Schließen', onclick: () => d.close() })));
  male(reiter);
  d.showModal();
}

$$('.info-knopf').forEach(b => (b.onclick = () => zeigeInfo()));
$$('.datenschutz-knopf').forEach(b => (b.onclick = () => zeigeInfo('privacy')));
// Unter /datenschutz direkt die Datenschutzerklaerung - eine Adresse, die man verlinken kann
// (Play Store, Aushang), auch ohne Konto: der Knopf steht schon auf dem Anmeldebildschirm.
if (location.pathname.replace(/\/+$/, '') === '/datenschutz') zeigeInfo('privacy').catch(() => {});
ladeInfo().catch(() => {});

// --- Die einmalige Nachricht ------------------------------------------------
// Ein Aushang: der Admin schreibt sie, jeder sieht sie einmal beim Oeffnen, wer sie wegklickt,
// sieht sie nie wieder. Die Fassung ist der Text selbst - schreibt der Admin etwas Neues, ist es
// eine neue Nachricht und alle sehen sie wieder.
//
// Weggeklickt ist weggeklickt, egal wie: auch Esc und der Klick daneben zaehlen. Ein Fenster,
// das nach dem Wegdruecken wiederkommt, waere genau das, was hier nicht sein soll.
export async function hinweisZeigen() {
  const i = await ladeInfo();
  if (!i?.hinweis || !i.hinweis_ver || i.hinweis_ver === state.me?.hinweis_gesehen) return;

  const d = $('#hinweis');
  // Auf das 'close'-Ereignis ist kein Verlass - in manchen Browsern (und im Vorschaufenster hier)
  // bleibt es nach dialog.close() schlicht aus. Deshalb haengt das Merken am Knopf selbst, und
  // 'cancel' (Esc) und 'close' sind nur Netz und doppelter Boden. Einmal genuegt.
  let erledigt = false;
  const fertig = () => {
    if (erledigt) return;
    erledigt = true;
    if (state.me) state.me.hinweis_gesehen = i.hinweis_ver;
    api('POST', '/api/me/hinweis-gelesen').catch(() => {});
  };
  d.replaceChildren(
    md(i.hinweis),
    h('div', { className: 'row end' },
      h('button', { className: 'primary', textContent: 'Verstanden',
        onclick: () => { fertig(); d.close(); } })));
  d.oncancel = fertig;
  d.onclose = fertig;
  d.showModal();
}
