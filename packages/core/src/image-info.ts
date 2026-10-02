// Reading a PNG's or JPEG's size from its header, before anything decodes it
// (M1 plan §2.3 "經驗證的 PNG / JPEG 解碼"): an image is only handed to the
// Preview Host when its header says what it is and its pixels fit the decode
// budget. Pure: bytes in, numbers out; never trusts a length it hasn't
// bounds-checked.

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The largest width or height a PNG may declare (2^31 − 1).
const PNG_MAX_DIMENSION = 0x7fffffff;

function u32(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) * 0x1000000 + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0))) >>> 0;
}

function u16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

function pngInfo(b: Uint8Array): ImageInfo | null {
  // Signature, then the IHDR chunk: length 13, type, width, height.
  if (b.length < 8 + 8 + 13 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) return null;
  if (u32(b, 8) !== 13 || String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') return null;
  const width = u32(b, 16);
  const height = u32(b, 20);
  if (width === 0 || height === 0 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) return null;
  return { format: 'png', width, height };
}

// Start-of-frame markers carry the size: baseline, extended, progressive and
// lossless, Huffman or arithmetic (not DHT C4, JPG C8 or DAC CC).
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at < b.length) {
    if (b[at] !== 0xff) return null;
    // Fill bytes: any number of 0xFF before a marker.
    while (at < b.length && b[at] === 0xff) at++;
    const marker = b[at];
    at++;
    if (marker === undefined) return null;
    // Markers without a length: TEM, RST0–7, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image or start of scan before any frame header.
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
    if (at + 2 > b.length) return null;
    const length = u16(b, at);
    if (length < 2 || at + length > b.length) return null;
    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = u16(b, at + 3);
      const width = u16(b, at + 5);
      // A height of 0 is defined later by a DNL marker: not supported here.
      if (width === 0 || height === 0) return null;
      return { format: 'jpeg', width, height };
    }
    at += length;
  }
  return null;
}

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  return pngInfo(bytes) ?? jpegInfo(bytes);
}

// The size of a PNG's IHDR, for checking the Preview Host's output.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const info = pngInfo(bytes);
  return info ? { width: info.width, height: info.height } : null;
}

// Scales (never up) to fit a box, keeping the aspect ratio; at least 1 px.
export function fitWithin(
  size: { width: number; height: number },
  box: { width: number; height: number },
): { width: number; height: number } {
  const scale = Math.min(1, box.width / size.width, box.height / size.height);
  return {
    width: Math.max(1, Math.min(box.width, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(box.height, Math.round(size.height * scale))),
  };
}
