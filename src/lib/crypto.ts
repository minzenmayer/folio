// Thoughtbed · crypto — wrap/unwrap connector secrets at rest.
//
// Sprint 13 introduces connector_accounts.encrypted_secret holding the
// user's Beehiiv API key. Even single-user, plaintext API keys in the DB
// are a regret if Neon ever leaks or someone else onboards. AES-256-GCM
// gives us authenticated encryption with a per-record nonce — the right
// default for "small secrets in the DB" without bringing in a vault.
//
// Format on disk: base64( iv (12 bytes) || authTag (16 bytes) || ciphertext )
//   - iv: 96-bit random nonce per encryption call
//   - authTag: 128-bit GCM tag (decrypt fails if tampered)
//   - ciphertext: AES-256-GCM(encryption_key, iv, plaintext)
//
// Key source: CONNECTOR_ENCRYPTION_KEY env var, base64-encoded 32 bytes.
// Generate with: `openssl rand -base64 32`. Rotate by re-encrypting all
// rows with the new key (out of scope for Wave 1 — single-user, single-key).
//
// Failure modes (all surfaced as thrown Error):
//   - missing key  → crash on first call (loud — should never reach prod)
//   - bad key len  → "must be 32 bytes (256 bits)"
//   - tampered ct  → "decryption failed" (GCM tag mismatch)
//   - bad format   → "ciphertext too short"

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * Load and cache the encryption key from the env. Throws loudly if the
 * key is missing or malformed. The cache prevents re-decoding the base64
 * on every call but is per-process — fine on Vercel's stateless functions.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'CONNECTOR_ENCRYPTION_KEY is not set. Generate with `openssl rand -base64 32` and add to env.'
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CONNECTOR_ENCRYPTION_KEY is not valid base64.');
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `CONNECTOR_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (256 bits) when base64-decoded; got ${buf.length} bytes.`
    );
  }
  cachedKey = buf;
  return buf;
}

/**
 * Encrypt a UTF-8 plaintext to a portable base64 blob suitable for storage
 * in a TEXT column. Each call uses a fresh 96-bit IV so identical inputs
 * produce different ciphertexts (no reveal-by-equality).
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Reverse of encryptSecret. Throws if the ciphertext is malformed or has
 * been tampered with (authTag mismatch). Callers should treat any throw
 * here as "credential is unusable; force re-connect".
 */
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('encrypted secret blob is too short to be valid');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key(), iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
