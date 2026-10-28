import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoConfigError extends Error {
  override name = 'CryptoConfigError';
}

function loadKey(): Buffer {
  const hex = process.env.DEMO_AES_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CryptoConfigError(
      'DEMO_AES_KEY must be 32 bytes of hex (64 characters). ' +
        'Run `pnpm dev` once to generate .env, or set it with `openssl rand -hex 32`.',
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Called at boot so a missing key fails fast instead of on the first encrypt. */
export function assertKeyConfigured(): void {
  loadKey();
}

/** AES-256-GCM. Output is base64(iv || authTag || ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Throws if the blob was tampered with; never returns partial plaintext. */
export function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), raw.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

export const encryptJson = (value: unknown): string => encrypt(JSON.stringify(value));
export const decryptJson = <T>(blob: string): T => JSON.parse(decrypt(blob)) as T;
