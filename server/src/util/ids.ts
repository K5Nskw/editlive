import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, URL-safe, sortable-ish id: base36 timestamp + random suffix. */
export function newId(prefix = ''): string {
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (const b of bytes) suffix += ALPHABET[b % ALPHABET.length];
  return `${prefix}${Date.now().toString(36)}${suffix}`;
}

/** Opaque token for unauthenticated share links. */
export function newToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Stream keys are typed into OBS by hand, so keep them unambiguous. */
export function newStreamKey(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const raw = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    out += chars[raw[i]! % chars.length];
    if (i % 5 === 4 && i !== 19) out += '-';
  }
  return out;
}
