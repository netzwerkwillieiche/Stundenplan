import { deflateSync, crc32 } from 'node:zlib';

// Minimaler PNG-Writer. Ein PNG ist Signatur + IHDR + zlib-komprimierte Scanlines + IEND - mit
// zlib.crc32 aus der Stdlib sind das ein paar Zeilen, und das Paket bleibt frei von Binaerdateien.
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // Filter "none"
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 Bit pro Kanal
  ihdr[9] = 2; // Truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const OBEN = [0x3b, 0x6f, 0xd4];
const UNTEN = [0x6b, 0x5c, 0xe0];

// Vollflaechiger Verlauf mit einem Stundenplan-Raster in der Mitte. Randlos und mittig, damit es
// auch als maskable Icon funktioniert, wenn Android rund oder als Squircle beschneidet.
export const iconPng = size => png(size, (x, y) => {
  const rand = size * 0.26;
  const feld = size - 2 * rand;
  const spalten = 3, zeilen = 4, luecke = feld * 0.09;
  const bw = (feld - luecke * (spalten - 1)) / spalten;
  const bh = (feld - luecke * (zeilen - 1)) / zeilen;
  const gx = x - rand, gy = y - rand;

  if (gx >= 0 && gy >= 0 && gx < feld && gy < feld) {
    const sx = Math.floor(gx / (bw + luecke)), sy = Math.floor(gy / (bh + luecke));
    if (sx < spalten && sy < zeilen
      && gx - sx * (bw + luecke) < bw && gy - sy * (bh + luecke) < bh) return [255, 255, 255];
  }
  const t = y / size;
  return OBEN.map((v, i) => Math.round(v + (UNTEN[i] - v) * t));
});
