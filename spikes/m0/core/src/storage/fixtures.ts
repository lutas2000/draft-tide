// Deterministic "agent-produced web design" fixture: HTML / CSS / JS / SVG /
// JSON text plus PNG / JPEG / font assets and a few edge cases. Generated at
// run time so no binaries are committed.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';

export function prng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

// Photo-like RGB PNG: smooth gradient plus seeded noise, so it compresses
// about as badly as real imagery does.
export function makePng(width: number, height: number, seed: number, noise = 0.6): Buffer {
  const rnd = prng(seed);
  const hueA = rnd() * 255;
  const hueB = rnd() * 255;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const gx = x / width;
      const gy = y / height;
      const n = (rnd() - 0.5) * 255 * noise;
      raw[o++] = clamp(hueA * gx + 60 * gy + n);
      raw[o++] = clamp(hueB * gy + 40 * gx + n);
      raw[o++] = clamp(200 - 100 * gx * gy + n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function write(root: string, rel: string, data: string | Buffer, mode?: number): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  if (mode !== undefined) chmodSync(abs, mode);
}

const SYSTEM_FONTS = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Georgia.ttf',
  '/System/Library/Fonts/Supplemental/Verdana.ttf',
];

export interface FixtureInfo {
  root: string;
  fileCount: number;
  totalBytes: number;
  assetBytes: number;
  jpegSource: 'sips' | 'none';
  fontSource: 'system-ttf' | 'synthetic';
  heroAssets: string[];
}

export function component(i: number, heading: string): string {
  return `<section class="c-${i}" data-component="${i}">\n  <h3>${heading}</h3>\n  <p>Block ${i}: layout copy produced by the agent for the Aurora pricing prototype. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n  <a class="btn" href="#plan-${i % 3}">Choose plan</a>\n</section>\n`;
}

export function tokensCss(hue: number, radius: number): string {
  return `:root {\n  --brand-hue: ${hue};\n  --brand: hsl(var(--brand-hue) 70% 45%);\n  --radius: ${radius}px;\n  --space: 8px;\n}\n`;
}

export function pricingHtml(prices: [number, number, number], headline: string): string {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Aurora pricing</title>\n<link rel="stylesheet" href="../css/tokens.css"><link rel="stylesheet" href="../css/styles.css"></head>\n<body>\n<h1>${headline}</h1>\n<ul class="plans">\n  <li>Starter $${prices[0]}</li>\n  <li>Team $${prices[1]}</li>\n  <li>Scale $${prices[2]}</li>\n</ul>\n<img src="../assets/img/hero-0.png" alt="">\n<script src="../js/app.js"></script>\n</body>\n</html>\n`;
}

export function generateFixture(root: string, seed = 20260930): FixtureInfo {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const rnd = prng(seed);
  let assetBytes = 0;

  write(root, 'index.html', `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Aurora</title>\n<link rel="stylesheet" href="css/tokens.css"><link rel="stylesheet" href="css/styles.css"></head>\n<body>\n<h1>Aurora keeps your team in flow</h1>\n<img src="assets/img/hero-0.png" alt="">\n<script src="js/app.js"></script>\n</body>\n</html>\n`);
  write(root, 'pages/pricing.html', pricingHtml([9, 29, 99], 'Simple pricing'));
  for (let i = 0; i < 4; i++) write(root, `pages/page-${i}.html`, `<!doctype html>\n<title>Page ${i}</title>\n<h1>Page ${i}</h1>\n`);
  write(root, 'css/tokens.css', tokensCss(210, 12));
  for (let i = 0; i < 9; i++) write(root, `css/part-${i}.css`, `.c-${i} { padding: calc(var(--space) * ${i + 1}); border-radius: var(--radius); }\n`.repeat(20));
  write(root, 'css/styles.css', `@import "part-0.css";\nbody { font-family: "Brand Sans", system-ui; color: #111; }\n.btn { background: var(--brand); }\n`);
  for (let i = 0; i < 10; i++) write(root, `js/module-${i}.js`, `export function feature${i}(el) {\n  el.dataset.ready = "${i}";\n  return el;\n}\n`.repeat(10));
  write(root, 'js/app.js', `document.querySelectorAll('[data-component]').forEach((el) => el.classList.add('ready'));\n`);

  // ~600 component partials across 20 folders.
  for (let d = 0; d < 20; d++) {
    for (let i = 0; i < 30; i++) {
      const n = d * 30 + i;
      write(root, `components/group-${String(d).padStart(2, '0')}/block-${n}.html`, component(n, `Feature ${n}`));
    }
  }
  // ~300 SVG icons.
  for (let i = 0; i < 300; i++) {
    const r = 4 + Math.floor(rnd() * 8);
    write(root, `assets/icons/icon-${i}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="${r}" fill="currentColor"/><path d="M${i % 24} 0L24 ${i % 24}" stroke="currentColor"/></svg>\n`);
  }
  // ~40 JSON data files.
  for (let i = 0; i < 40; i++) {
    write(root, `data/content-${i}.json`, JSON.stringify({ id: i, title: `Section ${i}`, items: Array.from({ length: 20 }, (_, k) => ({ k, label: `Item ${k}` })) }, null, 2) + '\n');
  }
  // Image assets: 4 hero images, 8 product shots, 40 small icons.
  const heroAssets: string[] = [];
  for (let i = 0; i < 4; i++) {
    const png = makePng(1600, 900, seed + 100 + i);
    write(root, `assets/img/hero-${i}.png`, png);
    heroAssets.push(`assets/img/hero-${i}.png`);
    assetBytes += png.length;
  }
  for (let i = 0; i < 8; i++) {
    const png = makePng(800, 600, seed + 200 + i);
    write(root, `assets/img/product-${i}.png`, png);
    assetBytes += png.length;
  }
  for (let i = 0; i < 40; i++) {
    const png = makePng(64, 64, seed + 300 + i, 0.2);
    write(root, `assets/img/icons/badge-${i}.png`, png);
    assetBytes += png.length;
  }
  // JPEG via macOS sips (no extra dependency); skipped elsewhere.
  let jpegSource: FixtureInfo['jpegSource'] = 'none';
  if (existsSync('/usr/bin/sips')) {
    for (let i = 0; i < 4; i++) {
      const src = join(root, `assets/img/product-${i}.png`);
      const dst = join(root, `assets/photos/photo-${i}.jpg`);
      mkdirSync(dirname(dst), { recursive: true });
      execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', src, '--out', dst], { stdio: 'ignore' });
      assetBytes += statSync(dst).size;
    }
    jpegSource = 'sips';
  }
  // Fonts: copy system TTFs if present (not redistributed; temp fixture only).
  let fontSource: FixtureInfo['fontSource'] = 'synthetic';
  const fonts = SYSTEM_FONTS.filter((f) => existsSync(f));
  if (fonts.length) {
    fonts.forEach((f, i) => {
      const dst = join(root, `assets/fonts/brand-${i}.ttf`);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(f, dst);
      assetBytes += statSync(dst).size;
    });
    fontSource = 'system-ttf';
  } else {
    for (let i = 0; i < 3; i++) {
      const b = Buffer.alloc(400_000);
      const r = prng(seed + 400 + i);
      for (let k = 0; k < b.length; k++) b[k] = Math.floor(r() * 256);
      write(root, `assets/fonts/brand-${i}.woff2`, b);
      assetBytes += b.length;
    }
  }

  // Edge cases the storage contract must keep byte-exact.
  write(root, 'notes/crlf-notes.txt', 'line one\r\nline two\r\n');
  write(root, 'notes/bom.css', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('body { margin: 0; }\n')]));
  write(root, 'scripts/build.sh', '#!/bin/sh\necho "no build needed"\n', 0o755);
  write(root, 'notes/empty.txt', '');
  write(root, '設計稿/首頁 草稿.html', '<!doctype html><title>首頁草稿</title><h1>讓想法流動</h1>\n');
  write(root, 'assets/very/deep/nested/path/to/file.json', '{"deep":true}\n');
  write(root, 'notes/trailing-no-newline.txt', 'no newline at end');

  // Things the default scope must exclude.
  write(root, 'node_modules/some-lib/index.js', 'module.exports = 1;\n');
  write(root, '.env.local', 'API_KEY=not-a-real-key\n');
  write(root, '.DS_Store', Buffer.from([0, 0, 0, 1, 66, 117, 100, 49]));
  write(root, 'debug.log', 'log line\n');

  const { fileCount, totalBytes } = countScope(root);
  return { root, fileCount, totalBytes, assetBytes, jpegSource, fontSource, heroAssets };
}

function countScope(root: string): { fileCount: number; totalBytes: number } {
  // Rough count for the report; the store's own scan is authoritative.
  const out = execFileSync('/usr/bin/find', [root, '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-name', '.env.local', '-not', '-name', '.DS_Store', '-not', '-name', '*.log'], { encoding: 'utf8' });
  const files = out.split('\n').filter(Boolean);
  let totalBytes = 0;
  for (const f of files) totalBytes += statSync(f).size;
  return { fileCount: files.length, totalBytes };
}
