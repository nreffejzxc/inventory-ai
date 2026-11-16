/**
 * Encryption at rest for platform TOTP secrets and WebAuthn public keys.
 *
 * AES-256-GCM with a random 12-byte IV per record. The envelope is
 * `v1.<iv>.<tag>.<ciphertext>` using base64url. The key is derived from
 * `PLATFORM_MFA_ENCRYPTION_KEY`; nothing is encrypted with a tenant key and
 * there is no plaintext fallback.
 */

import crypto from 'node:crypto';

import ApiError from '../../utils/ApiError.ts';
import { platformMfaEncryptionKey } from '../../config/platformSecurity.ts';

const VERSION = 'v1';

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function encryptPlatformSecret(plaintext: string): string {
  const key = platformMfaEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
}

export function decryptPlatformSecret(envelope: string): string {
  const key = platformMfaEncryptionKey();
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ApiError(500, 'Stored platform secret is invalid', 'PLATFORM_SECRET_INVALID');
  }
  try {
    const iv = fromB64url(parts[1]!);
    const tag = fromB64url(parts[2]!);
    const ciphertext = fromB64url(parts[3]!);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new ApiError(500, 'Stored platform secret is invalid', 'PLATFORM_SECRET_INVALID');
  }
}

export function encryptPlatformCredential(publicKey: Uint8Array | Buffer): string {
  return encryptPlatformSecret(Buffer.from(publicKey).toString('base64url'));
}

export function decryptPlatformCredential(value: string): Uint8Array<ArrayBuffer> {
  const raw = Buffer.from(decryptPlatformSecret(value), 'base64url');
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  output.set(raw);
  return output;
}

export default {
  encryptPlatformSecret,
  decryptPlatformSecret,
  encryptPlatformCredential,
  decryptPlatformCredential,
};
