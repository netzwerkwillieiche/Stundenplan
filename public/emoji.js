// --- emoji ---
// Die Emoji-Auswahl fuer den Chat. Ohne fremde Bibliothek und ohne lange Zeichenliste im
// Quelltext: die Zeichen werden aus den Unicode-Bloecken erzeugt und mit
// `\p{Extended_Pictographic}` gefiltert - damit ist wirklich jedes Emoji dabei, das der Browser
// kennt, und nicht nur eine Auswahl, die jemand von Hand getippt hat.
//
// Was das Geraet nicht darstellen kann, zeigt es als Kaestchen. Das ist der Preis dafuer, alles
// anzubieten; die Alternative waere eine gepflegte Liste, die auf jedem zweiten Geraet zu kurz ist.

const BLOECKE = [
  ['Gesichter', [[0x1F600, 0x1F64F], [0x1F910, 0x1F93A], [0x1F970, 0x1F97A]]],
  ['Menschen', [[0x1F440, 0x1F450], [0x1F464, 0x1F487], [0x1F933, 0x1F93E], [0x1FAC0, 0x1FAF8]]],
  ['Tiere & Natur', [[0x1F400, 0x1F43F], [0x1F980, 0x1F9AE], [0x1F330, 0x1F343], [0x1F980, 0x1F9A0]]],
  ['Essen', [[0x1F345, 0x1F37F], [0x1F950, 0x1F96F], [0x1FADA, 0x1FADF]]],
  ['Sport & Reisen', [[0x1F3A0, 0x1F3FA], [0x1F680, 0x1F6C5], [0x26BD, 0x26F9]]],
  ['Dinge', [[0x1F4A0, 0x1F4FF], [0x1F500, 0x1F53D], [0x1F550, 0x1F567], [0x1F9E0, 0x1F9FF]]],
  ['Zeichen', [[0x2190, 0x21FF], [0x2600, 0x26FF], [0x2700, 0x27BF], [0x1F300, 0x1F32F]]],
];

const PIKTOGRAMM = /\p{Extended_Pictographic}/u;

/** Alle darstellbaren Emoji eines Blocks - einmal berechnet, danach aus dem Zwischenspeicher. */
let gruppenCache = null;

export function emojiGruppen() {
  if (gruppenCache) return gruppenCache;
  gruppenCache = BLOECKE.map(([titel, bereiche]) => {
    const zeichen = new Set();
    for (const [von, bis] of bereiche) {
      for (let c = von; c <= bis; c++) {
        const z = String.fromCodePoint(c);
        if (PIKTOGRAMM.test(z)) zeichen.add(z);
      }
    }
    return { titel, zeichen: [...zeichen] };
  }).filter(g => g.zeichen.length);
  return gruppenCache;
}

// Die zuletzt benutzten stehen oben - danach greift man beim naechsten Mal zuerst.
const LETZTE_KEY = 'emojiLetzte';

export function letzteEmoji() {
  try { return JSON.parse(localStorage.getItem(LETZTE_KEY) ?? '[]').slice(0, 24); }
  catch { return []; }
}

export function merkeEmoji(zeichen) {
  try {
    const liste = [zeichen, ...letzteEmoji().filter(z => z !== zeichen)].slice(0, 24);
    localStorage.setItem(LETZTE_KEY, JSON.stringify(liste));
  } catch { /* Privatmodus - dann eben ohne Gedaechtnis */ }
}
