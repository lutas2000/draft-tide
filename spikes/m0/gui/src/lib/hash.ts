/**
 * Deterministic pseudo hashes for example data. They look like SHA-256 / Git
 * OIDs but are NOT cryptographic; the prototype only needs "same content →
 * same hash" so NO_CHANGES and blob reuse can be demonstrated.
 */
function fnv1a(input: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pseudoHash(input: string, hexLength = 64): string {
  let out = '';
  let seed = 0;
  while (out.length < hexLength) {
    out += fnv1a(input, seed).toString(16).padStart(8, '0');
    seed += 0x9e3779b9;
  }
  return out.slice(0, hexLength);
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** UUID v4. Uses crypto.randomUUID when available (secure contexts), else getRandomValues. */
export function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
