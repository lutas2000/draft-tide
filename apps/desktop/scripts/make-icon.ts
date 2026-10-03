// Renders the app icon (assets/icon.svg) into the macOS icon the packaging
// script gives the app (assets/icon.icns): one PNG per size macOS asks for,
// each rasterized from the vector at that size (never scaled from another),
// by this repository's own Electron. The .icns is committed; run this after
// changing the SVG.
//
//   corepack pnpm --filter @draft-tide/desktop run icon
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = join(root, 'assets', 'icon.svg');
const ICNS = join(root, 'assets', 'icon.icns');

// The icon types of a modern .icns: PNG data at these pixel sizes (the @2x
// types are the Retina variants of the size below them).
export const ICNS_TYPES: readonly { type: string; size: number }[] = [
  { type: 'icp4', size: 16 },
  { type: 'ic11', size: 32 },
  { type: 'icp5', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic13', size: 256 },
  { type: 'ic08', size: 256 },
  { type: 'ic14', size: 512 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
];

// Width and height from a PNG's IHDR; throws for anything else.
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(png);
  const signature = '89504e470d0a1a0a';
  if (b.length < 24 || b.subarray(0, 8).toString('hex') !== signature || b.subarray(12, 16).toString() !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// 'icns', the total length, then each entry: its type, its length (with
// this 8-byte header) and its data.
export function buildIcns(entries: readonly { type: string; png: Uint8Array }[]): Buffer {
  const parts = entries.map(({ type, png }) => {
    if (!/^[a-z0-9]{4}$/.test(type)) throw new Error(`bad icon type ${type}`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, Buffer.from(png)]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// The entries of an .icns, for checks.
export function readIcns(icns: Uint8Array): { type: string; data: Buffer }[] {
  const b = Buffer.from(icns);
  if (b.subarray(0, 4).toString('latin1') !== 'icns' || b.readUInt32BE(4) !== b.length) throw new Error('not an icns');
  const out: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < b.length;) {
    const length = b.readUInt32BE(at + 4);
    if (length < 8 || at + length > b.length) throw new Error('truncated icns');
    out.push({ type: b.subarray(at, at + 4).toString('latin1'), data: b.subarray(at + 8, at + length) });
    at += length;
  }
  return out;
}

// A throwaway Electron main: one transparent window at device scale 1.
const MAIN = `import { app, BrowserWindow } from 'electron';
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 1100, transparent: true, frame: false, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  void win.loadURL('about:blank');
});
`;

async function render(): Promise<Map<number, Buffer>> {
  const work = mkdtempSync(join(tmpdir(), 'dt-icon-'));
  writeFileSync(join(work, 'main.mjs'), MAIN);
  const electronPath = createRequire(join(root, 'package.json'))('electron') as unknown as string;
  const app = await electron.launch({ executablePath: electronPath, args: [join(work, 'main.mjs')] });
  try {
    const page = await app.firstWindow();
    const svg = readFileSync(SVG).toString('base64');
    const pngs = new Map<number, Buffer>();
    for (const size of [...new Set(ICNS_TYPES.map((t) => t.size))]) {
      await page.setContent(
        `<html><body style="margin:0;background:transparent">` +
          `<img id="icon" src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}" style="display:block"></body></html>`,
      );
      // Decoded and laid out before the picture is taken.
      await page.waitForFunction(
        "document.getElementById('icon').complete && document.getElementById('icon').naturalWidth > 0",
      );
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
      const got = pngSize(png);
      if (got.width !== size || got.height !== size) throw new Error(`rendered ${got.width}×${got.height} for ${size}`);
      pngs.set(size, png);
    }
    return pngs;
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pngs = await render();
  const icns = buildIcns(ICNS_TYPES.map(({ type, size }) => ({ type, png: pngs.get(size) ?? Buffer.alloc(0) })));
  writeFileSync(ICNS, icns);
  process.stderr.write(`${ICNS}: ${ICNS_TYPES.length} images, ${(icns.length / 1024).toFixed(0)} KiB\n`);
}
