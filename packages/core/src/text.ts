// Small text helpers shared by the use cases. Pure: Web Crypto only.

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;

// Text that came from Git or the folder, made safe to show anywhere: control
// characters (terminal escapes, line breaks) and bidirectional overrides
// become U+FFFD, and it is cut to max code points without splitting one.
export function printable(value: string, max: number): string {
  const clean = value.replace(CONTROLS, '�');
  if (clean.length <= max) return clean;
  return Array.from(clean).slice(0, max).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// JSON.stringify's UTF-8 length: what an item adds to a control message.
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

// The id Git gives these bytes as a blob (SHA-1 repositories only).
export async function gitBlobId(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(head.byteLength + bytes.byteLength);
  all.set(head);
  all.set(bytes, head.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
