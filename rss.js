// --- rss ---
// Der Nachrichten-Feed der Schule, ohne Fremdpaket - wie ical.js. Gelesen wird nur, was ein
// RSS-2.0-Kanal an Einträgen hat: Titel, Text, Link, Datum, Kennung. Was nicht passt, wird
// weggelassen statt geraten; kaputtes XML liefert eine leere Liste, keinen Fehler.
import { entitaeten } from './iserv.js';

const tag = (block, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!m) return '';
  // CDATA ist woertlich zu nehmen - Entities darin bleiben, wie sie sind.
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return cdata ? cdata[1].trim() : entitaeten(m[1]).trim();
};

/**
 * HTML zu Text: Links bleiben als [Text](Adresse) erhalten, damit md() sie klickbar macht;
 * Umbrueche aus <br>, </p> und </li>; alle anderen Tags fliegen raus.
 */
export function htmlZuText(html) {
  return entitaeten(String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, text) => /^https?:/i.test(href) ? `[${text.replace(/<[^>]*>/g, '').trim() || href}](${href})` : text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, ''))
    .split('\n').map(z => z.replace(/[ \t]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** "Mon, 07 Sep 2026 10:00:00 +0200" (oder ISO) zu "2026-09-07"; sonst null. */
const alsDatum = text => {
  const d = new Date(String(text ?? '').trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Die Einträge eines Feeds: { id, titel, text, link, datum } - neueste zuerst, wie im Feed. */
export function lese(xml) {
  const raus = [];
  for (const [, item] of String(xml ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const titel = htmlZuText(tag(item, 'title')) || 'Ohne Titel';
    const link = tag(item, 'link');
    const text = htmlZuText(tag(item, 'description') || tag(item, 'content:encoded'));
    const id = tag(item, 'guid') || link || `${titel}|${text.slice(0, 40)}`;
    raus.push({ id: id.slice(0, 300), titel: titel.slice(0, 200), text: text.slice(0, 4000),
      link: /^https?:/i.test(link) ? link.slice(0, 500) : null,
      datum: alsDatum(tag(item, 'pubDate') || tag(item, 'dc:date')) });
  }
  return raus;
}
