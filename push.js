import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dbFile } from './db.js';

// --- Web Push ----------------------------------------------------------------
// Benachrichtigungen ohne Nutzdaten: wir schicken dem Push-Dienst nur ein "da ist was", der
// Service Worker holt sich den Text dann selbst von /api/notifications/pending.
//
// Das spart die Payload-Verschlüsselung nach RFC 8291 vollständig - und beim Ende-zu-Ende-Chat
// könnte der Server den Text ohnehin nicht mitschicken, er kennt ihn nicht.
//
// Nötig bleibt VAPID: ein Schlüsselpaar, mit dem wir uns beim Push-Dienst ausweisen. Es entsteht
// beim ersten Bedarf und liegt neben der Datenbank - wie der WebUntis-Schlüssel und aus demselben
// Grund: die Sicherung lädt die Datenbank herunter, und ein Schlüssel darin würde mitwandern.

const b64url = buf => Buffer.from(buf).toString('base64url');

let paar; // undefined = noch nicht versucht, null = nicht möglich

function vapidPaar() {
  if (paar !== undefined) return paar;
  if (dbFile === ':memory:') return (paar = eigenesPaar());
  const pfad = `${dbFile}.vapid`;
  try {
    if (existsSync(pfad)) return (paar = JSON.parse(readFileSync(pfad, 'utf8')));
    const neu = eigenesPaar();
    writeFileSync(pfad, JSON.stringify(neu), { mode: 0o600 });
    console.warn(`! Push-Schluessel erzeugt: ${pfad}`);
    console.warn('  Nicht loeschen - sonst muessen alle Benachrichtigungen neu erlaubt werden.');
    return (paar = neu);
  } catch (err) {
    console.warn(`! Push-Schluessel ${pfad} nicht nutzbar (${err.message}).`);
    return (paar = null);
  }
}

function eigenesPaar() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  // Der Browser will den unkomprimierten Punkt: 0x04 || x || y.
  const roh = Buffer.concat([Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pub: roh.toString('base64url'),
  };
}

export const pushKey = () => vapidPaar()?.pub ?? null;

/** VAPID-JWT nach RFC 8292: ES256, Empfänger ist der Ursprung des Push-Dienstes. */
export function vapidToken(endpoint, stunden = 12) {
  const p = vapidPaar();
  if (!p) return null;
  const kopf = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const inhalt = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + stunden * 3600,
    sub: process.env.PUSH_KONTAKT || 'mailto:admin@localhost',
  }));
  // ieee-p1363 liefert r||s - genau das erwartet JWS. Die DER-Form waere hier falsch.
  const unterschrift = sign('sha256', Buffer.from(`${kopf}.${inhalt}`),
    { key: createPrivateKey(p.pem), dsaEncoding: 'ieee-p1363' });
  return `${kopf}.${inhalt}.${b64url(unterschrift)}`;
}

/** Öffentlicher Schlüssel als KeyObject - nur zum Prüfen im Test. */
export const vapidPublicKey = () => {
  const p = vapidPaar();
  return p ? createPublicKey(createPrivateKey(p.pem)) : null;
};

/**
 * Anstupsen, ohne Inhalt. Rückgabe: true, wenn der Dienst es angenommen hat; false bei einem
 * abgelaufenen Abo (dann gehört es gelöscht); null, wenn wir es gar nicht erst versuchen konnten.
 */
export async function anstupsen(endpoint) {
  const token = vapidToken(endpoint);
  if (!token) return null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${token}, k=${pushKey()}`,
        TTL: '86400',
        'Content-Length': '0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    // 404/410 heisst: das Abo gibt es nicht mehr.
    if (res.status === 404 || res.status === 410) return false;
    return res.ok;
  } catch {
    return null;
  }
}
