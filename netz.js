// --- netz ---
// Darf der Server diese Adresse anfassen?
//
// Zwei Stellen fragen das: die IServ-Anmeldung und die abonnierten Kalender. Beide holen etwas von
// einer Adresse, die ein Nutzer eingetragen hat - und ohne Sperre waere so ein Eingabefeld ein
// Anfrage-Generator ins Innere des Servers (SSRF). Deshalb steht die Pruefung einmal hier, statt
// zweimal fast gleich.

import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';

// Der Namensdienst haengt an einer Stelle, damit die Tests ohne Netz auskommen: sie ersetzen
// 'netz.lookup'. Im Betrieb wird das nie angefasst.
export const netz = { lookup };

export const ohneSchema = s =>
  String(s ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

export const nurHost = server => ohneSchema(server).toLowerCase().split('/')[0];

/**
 * Sieht das nach einer gewoehnlichen Adresse im offenen Netz aus?
 *
 * Bei WebUntis liess sich das auf *.webuntis.com festnageln. Eine Schul- oder Kalenderadresse kann
 * aber alles sein - also faellt stattdessen alles heraus, was nach dem eigenen Netz aussieht.
 */
export function hostOk(server) {
  const host = nurHost(server);
  // Kein Nutzer:Passwort, kein Port, keine leere Angabe.
  if (!host || host.includes('@') || host.includes(':')) return false;
  // Ein Punkt und eine echte Endung: das schliesst 'localhost' aus und jede IPv4-Adresse, denn
  // die endet auf Ziffern.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host))
    return false;
  // Endungen, die per Konvention ins lokale Netz zeigen.
  return !/\.(local|localdomain|internal|intern|intranet|home|lan|corp|test|invalid|example)$/
    .test(host);
}

// Alles, was nicht ins offene Netz fuehrt. BlockList (Standardbibliothek) prueft auch
// IPv4-gemappte IPv6-Adressen (::ffff:10.0.0.1) gegen die IPv4-Regeln - die rutschten vorher durch.
const GESPERRT = new BlockList();
for (const [netzAdr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 3]]) GESPERRT.addSubnet(netzAdr, bits, 'ipv4');
// ::, ::1, ULA fc00::/7, link-local, Multicast, NAT64 (64:ff9b::/96 und /48) und 6to4 - die letzten
// drei tragen eine IPv4-Adresse in sich, die auch privat sein kann.
for (const [netzAdr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['2002::', 16]]) GESPERRT.addSubnet(netzAdr, bits, 'ipv6');

/** Ist diese IP gesperrt (privat, lokal, reserviert)? */
export const ipGesperrt = (address, family) => GESPERRT.check(address, family === 6 || String(address).includes(':') ? 'ipv6' : 'ipv4');

/**
 * Zeigt der Name wirklich nach draussen?
 *
 * Die Namenspruefung oben faellt auf eine Domain herein, die auf 10.0.0.5 zeigt. Deshalb wird
 * einmal nachgeschlagen, bevor der Server dorthin greift.
 *
 * ponytail: Zwischen dieser Pruefung und dem Abruf kann die Antwort des Namensdienstes wechseln
 * (DNS-Rebinding). Dicht waere das erst, wenn die Verbindung an eine geprueffte IP gebunden wird -
 * dafuer muesste der HTTP-Weg an fetch vorbei. Fuer Adressen, die jemand von seiner eigenen Schule
 * oder seinem eigenen Kalender eintraegt, ist das hier genug.
 */
export async function adresseErlaubt(server) {
  const host = nurHost(server);
  if (!hostOk(host)) return false;
  const treffer = await netz.lookup(host, { all: true }).catch(() => []);
  if (!treffer.length) return false;
  return treffer.every(({ address, family }) => !ipGesperrt(address, family));
}

/**
 * fetch mit Weiterleitungen - jedes Ziel neu geprueft. `redirect: 'follow'` fuehrte sonst von einer
 * erlaubten Adresse per 302 nach 127.0.0.1 oder 169.254.169.254 (SSRF).
 */
export async function holeGeprueft(url, opt = {}, spruenge = 5) {
  let ziel = String(url);
  for (let i = 0; i <= spruenge; i++) {
    const u = new URL(ziel);
    if (!/^https?:$/.test(u.protocol) || !hostOk(u.hostname) || !(await adresseErlaubt(u.hostname)))
      throw new Error('Die Adresse führt nicht ins offene Netz');
    const res = await fetch(ziel, { ...opt, redirect: 'manual' });
    const ort = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!ort) return res;
    ziel = new URL(ort, ziel).href;
  }
  throw new Error('Zu viele Weiterleitungen');
}

/** Wie ein Browser aussehen - ohne User-Agent antworten viele Server mit einer Fehlerseite. */
export const KOPF = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0.0.0 Safari/537.36 (Stundenplan-App)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'de-DE,de;q=0.9',
};
