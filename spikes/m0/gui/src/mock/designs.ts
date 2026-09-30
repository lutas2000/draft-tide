/**
 * Example design files for the prototype. Each design state is a full set of
 * project files (HTML / CSS / JS as real text, images as pseudo binaries), so
 * file diffs, text diffs, NO_CHANGES and previews are all derived from the
 * same content instead of being hand-written per screen.
 */
import { pseudoHash, utf8Bytes } from '../lib/hash';
import type { FileEntry, FileSet } from './types';

// ---------------------------------------------------------------------------
// Design options

export interface AuroraOpts {
  family: 'aurora';
  theme: 'light' | 'dark';
  compact: boolean;
  bigHero: boolean;
  annual: boolean;
  leadIdx: number;
}

export interface NimbusOpts {
  family: 'nimbus';
  social: boolean;
  headlineIdx: number;
}

export type DesignOpts = AuroraOpts | NimbusOpts;

export const AURORA_BASELINE: AuroraOpts = {
  family: 'aurora',
  theme: 'light',
  compact: false,
  bigHero: false,
  annual: false,
  leadIdx: 0,
};

export const NIMBUS_BASELINE: NimbusOpts = { family: 'nimbus', social: false, headlineIdx: 0 };

// ---------------------------------------------------------------------------
// Helpers

function text(path: string, content: string): FileEntry {
  return { path, kind: 'text', text: content, size: utf8Bytes(content), hash: pseudoHash(`blob:${content}`) };
}

function binary(path: string, seed: string, size: number, previewArt?: string): FileEntry {
  const entry: FileEntry = { path, kind: 'binary', size, hash: pseudoHash(`bin:${seed}`) };
  if (previewArt !== undefined) entry.previewArt = previewArt;
  return entry;
}

function sortFiles(files: FileEntry[]): FileSet {
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Shared art (stands in for PNG bytes in the preview simulation)

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <rect width="32" height="32" rx="9" fill="#5b5bd6"/>
  <path d="M7 21c3-6 6-9 9-9s6 3 9 9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
</svg>
`;

const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="100%" height="100%">
  <circle cx="10" cy="10" r="10" fill="#ecebfd"/>
  <path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="#5b5bd6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const HERO_LIGHT_ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 380" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
<defs><linearGradient id="hl" x1="0" x2="1"><stop offset="0" stop-color="#bfeee0"/><stop offset=".5" stop-color="#d8d5fb"/><stop offset="1" stop-color="#fbdbe9"/></linearGradient></defs>
<path d="M0 250 C 240 170 430 320 650 240 S 1060 140 1280 220 V 0 H 0 Z" fill="url(#hl)" opacity=".55"/>
<path d="M0 170 C 270 100 490 250 720 180 S 1110 90 1280 150 V 0 H 0 Z" fill="url(#hl)" opacity=".45"/>
</svg>`;

function heroDarkArt(wide: boolean): string {
  const h = wide ? 470 : 380;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 ${h}" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
<defs>
<linearGradient id="hd${wide ? 'w' : ''}" x1="0" x2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset=".55" stop-color="#818cf8"/><stop offset="1" stop-color="#f472b6"/></linearGradient>
<filter id="hb${wide ? 'w' : ''}"><feGaussianBlur stdDeviation="${wide ? 34 : 26}"/></filter>
</defs>
<g filter="url(#hb${wide ? 'w' : ''})" opacity="${wide ? 0.75 : 0.6}">
<path d="M80 ${h * 0.62} C 320 ${h * 0.2} 520 ${h * 0.75} 760 ${h * 0.35} S 1120 ${h * 0.15} 1220 ${h * 0.5}" stroke="url(#hd${wide ? 'w' : ''})" stroke-width="${wide ? 120 : 90}" fill="none"/>
</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// Aurora 定價頁

const AURORA_LEADS = [
  '從個人筆記到整個團隊的知識庫，隨時升級或降級，不綁約。',
  '從一個人的靈感，到整個團隊的知識庫。隨時升級，不綁約。',
  '先免費開始，團隊變大時再升級。每個方案都能隨時取消。',
  '把會議記錄、規格與靈感放在同一處，依團隊大小選方案。',
];

interface Plan {
  name: string;
  monthly: string;
  yearly: string;
  unit: string;
  desc: string;
  features: string[];
  cta: string;
  featured: boolean;
}

const PLANS: Plan[] = [
  {
    name: '基本',
    monthly: 'NT$0',
    yearly: 'NT$0',
    unit: '/ 月',
    desc: '適合個人整理靈感與筆記。',
    features: ['無限筆記', '3 個共享空間', '基本搜尋'],
    cta: '開始使用',
    featured: false,
  },
  {
    name: '專業',
    monthly: 'NT$240',
    yearly: 'NT$192',
    unit: '/ 月',
    desc: '給需要版本紀錄與離線使用的創作者。',
    features: ['無限共享空間', '版本紀錄 30 天', '進階搜尋與標籤', '離線使用'],
    cta: '免費試用 14 天',
    featured: true,
  },
  {
    name: '團隊',
    monthly: 'NT$420',
    yearly: 'NT$336',
    unit: '/ 人・月',
    desc: '讓整個團隊共用同一個知識庫。',
    features: ['專業版全部功能', '成員權限管理', '單一登入（SSO）', '優先客服'],
    cta: '聯絡我們',
    featured: false,
  },
];

function auroraHtml(o: AuroraOpts): string {
  const heroSrc = o.theme === 'dark' ? 'assets/hero-dark.png' : 'assets/hero.png';
  const headline = o.bigHero ? '剛好的方案，<br>陪團隊一起長大' : '為成長中的團隊，<br>選一個剛好的方案';
  const lead = AURORA_LEADS[o.leadIdx % AURORA_LEADS.length] ?? '';
  const billing = o.annual
    ? [
        `      <div class="billing" role="group" aria-label="付款週期">`,
        `        <button class="is-active" data-cycle="monthly">月繳</button>`,
        `        <button data-cycle="yearly">年繳 <span class="save">省 20%</span></button>`,
        `      </div>`,
      ]
    : [];
  const plans = PLANS.flatMap((p) => {
    const price = o.annual
      ? `<strong data-monthly="${p.monthly}" data-yearly="${p.yearly}">${p.monthly}</strong>`
      : `<strong>${p.monthly}</strong>`;
    return [
      `      <article class="plan${p.featured ? ' featured' : ''}">`,
      ...(p.featured ? [`        <span class="tag">最受歡迎</span>`] : []),
      `        <h3>${p.name}</h3>`,
      `        <p class="price">${price}<span>${p.unit}</span></p>`,
      `        <p class="desc">${p.desc}</p>`,
      `        <ul class="features">`,
      ...p.features.map((f) =>
        o.compact ? `          <li>${f}</li>` : `          <li><img src="assets/icons/check.svg" alt="" width="18" height="18">${f}</li>`,
      ),
      `        </ul>`,
      `        <a href="#" class="btn ${p.featured ? 'primary' : 'outline'}">${p.cta}</a>`,
      `      </article>`,
    ];
  });
  return [
    `<!doctype html>`,
    `<html lang="zh-Hant">`,
    `<head>`,
    `  <meta charset="utf-8">`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1">`,
    `  <title>Aurora — 方案與價格</title>`,
    `  <link rel="stylesheet" href="styles.css">`,
    `</head>`,
    `<body>`,
    `  <header class="nav">`,
    `    <a class="brand" href="index.html"><img src="assets/logo.svg" alt="" width="28" height="28">Aurora</a>`,
    `    <nav class="links">`,
    `      <a href="#">產品</a>`,
    `      <a href="#">範本</a>`,
    `      <a href="#" class="active">價格</a>`,
    `      <a href="#">客戶案例</a>`,
    `    </nav>`,
    `    <div class="actions">`,
    `      <a href="#" class="btn ghost">登入</a>`,
    `      <a href="#" class="btn primary">免費開始</a>`,
    `    </div>`,
    `  </header>`,
    ``,
    `  <main>`,
    `    <section class="hero">`,
    `      <img class="hero-art" src="${heroSrc}" alt="">`,
    `      <p class="eyebrow">方案與價格</p>`,
    `      <h1>${headline}</h1>`,
    `      <p class="lead">${lead}</p>`,
    ...billing,
    `    </section>`,
    ``,
    `    <section class="plans">`,
    ...plans,
    `    </section>`,
    ``,
    `    <p class="note">所有付費方案皆含 14 天免費試用，可隨時取消。</p>`,
    `  </main>`,
    `  <script src="app.js"></script>`,
    `</body>`,
    `</html>`,
    ``,
  ].join('\n');
}

function auroraCss(o: AuroraOpts): string {
  const dark = o.theme === 'dark';
  const c = o.compact;
  const lines = [
    `:root {`,
    `  --bg: ${dark ? '#0e1726' : '#fbfaf7'};`,
    `  --surface: ${dark ? '#16223a' : '#ffffff'};`,
    `  --ink: ${dark ? '#eef2f8' : '#1b2430'};`,
    `  --muted: ${dark ? '#9aa8bd' : '#5f6b7a'};`,
    `  --line: ${dark ? '#26344f' : '#e6e2da'};`,
    `  --accent: ${dark ? '#8b8cf7' : '#5b5bd6'};`,
    `  --accent-ink: ${dark ? '#0e1726' : '#ffffff'};`,
    `  --accent-soft: ${dark ? '#232f55' : '#ecebfd'};`,
    `  --radius: 18px;`,
    `}`,
    ``,
    `* { box-sizing: border-box; }`,
    ``,
    `body {`,
    `  margin: 0;`,
    `  background: var(--bg);`,
    `  color: var(--ink);`,
    `  font-family: "PingFang TC", "Noto Sans TC", system-ui, sans-serif;`,
    `  line-height: 1.6;`,
    `}`,
    ``,
    `a { color: inherit; text-decoration: none; }`,
    ``,
    `.nav {`,
    `  display: flex;`,
    `  align-items: center;`,
    `  justify-content: space-between;`,
    `  padding: 18px 56px;`,
    `  position: relative;`,
    `  z-index: 2;`,
    `}`,
    `.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; }`,
    `.links { display: flex; gap: 32px; color: var(--muted); font-size: 15px; }`,
    `.links .active { color: var(--ink); font-weight: 600; }`,
    `.actions { display: flex; gap: 12px; }`,
    ``,
    `.btn {`,
    `  display: inline-flex;`,
    `  align-items: center;`,
    `  justify-content: center;`,
    `  padding: 10px 18px;`,
    `  border-radius: 999px;`,
    `  font-size: 14px;`,
    `  font-weight: 600;`,
    `}`,
    `.btn.primary { background: var(--accent); color: var(--accent-ink); }`,
    `.btn.ghost { color: var(--ink); }`,
    `.btn.outline { border: 1px solid var(--line); }`,
    ``,
    `.hero {`,
    `  position: relative;`,
    `  isolation: isolate;`,
    `  text-align: center;`,
    `  padding: ${o.bigHero ? '76px 24px 52px' : c ? '40px 24px 28px' : '56px 24px 40px'};`,
    `}`,
    `.hero-art {`,
    `  position: absolute;`,
    `  inset: -80px 0 auto 0;`,
    `  height: ${o.bigHero ? '470px' : '380px'};`,
    `  z-index: -1;`,
    `}`,
    `.eyebrow { margin: 0 0 12px; color: var(--accent); font-size: 14px; font-weight: 600; letter-spacing: 0.08em; }`,
    `.hero h1 {`,
    `  margin: 0 auto;`,
    `  max-width: ${o.bigHero ? '980px' : '760px'};`,
    `  font-size: ${o.bigHero ? '68px' : '44px'};`,
    `  line-height: ${o.bigHero ? '1.12' : '1.25'};`,
    `  letter-spacing: ${o.bigHero ? '-0.02em' : '-0.01em'};`,
    `}`,
    `.lead { margin: 16px auto 0; max-width: 560px; color: var(--muted); font-size: 17px; }`,
  ];
  if (o.annual) {
    lines.push(
      ``,
      `.billing {`,
      `  display: inline-flex;`,
      `  gap: 4px;`,
      `  margin-top: 24px;`,
      `  padding: 4px;`,
      `  border: 1px solid var(--line);`,
      `  border-radius: 999px;`,
      `  background: var(--surface);`,
      `}`,
      `.billing button {`,
      `  border: 0;`,
      `  border-radius: 999px;`,
      `  padding: 8px 18px;`,
      `  background: transparent;`,
      `  color: var(--muted);`,
      `  font: inherit;`,
      `  font-size: 14px;`,
      `}`,
      `.billing .is-active { background: var(--accent); color: var(--accent-ink); font-weight: 600; }`,
      `.billing .save { margin-left: 4px; color: var(--accent); font-size: 12px; font-weight: 700; }`,
    );
  }
  lines.push(
    ``,
    `.plans {`,
    `  display: grid;`,
    `  grid-template-columns: repeat(3, 1fr);`,
    `  gap: ${c ? '16px' : '24px'};`,
    `  max-width: ${c ? '960px' : '1040px'};`,
    `  margin: 0 auto;`,
    `  padding: 0 24px;`,
    `}`,
    `.plan {`,
    `  position: relative;`,
    `  display: flex;`,
    `  flex-direction: column;`,
    `  gap: ${c ? '8px' : '12px'};`,
    `  padding: ${c ? '22px 20px' : '32px 28px'};`,
    `  background: var(--surface);`,
    `  border: 1px solid var(--line);`,
    `  border-radius: var(--radius);`,
    `}`,
    `.plan.featured {`,
    `  border: 2px solid var(--accent);`,
    `  box-shadow: 0 18px 40px -20px rgba(60, 60, 180, 0.35);`,
    `}`,
    `.plan .tag {`,
    `  position: absolute;`,
    `  top: -12px;`,
    `  left: 28px;`,
    `  padding: 3px 10px;`,
    `  border-radius: 999px;`,
    `  background: var(--accent);`,
    `  color: var(--accent-ink);`,
    `  font-size: 12px;`,
    `  font-weight: 700;`,
    `}`,
    `.plan h3 { margin: 0; font-size: 18px; }`,
    `.price { margin: 0; display: flex; align-items: baseline; gap: 6px; }`,
    `.price strong { font-size: ${c ? '30px' : '36px'}; letter-spacing: -0.02em; }`,
    `.price span { color: var(--muted); font-size: 14px; }`,
    `.desc { margin: 0; color: var(--muted); font-size: 14px; }`,
    `.features {`,
    `  display: grid;`,
    `  gap: ${c ? '6px' : '10px'};`,
    `  margin: 8px 0 12px;`,
    `  padding: 0;`,
    `  list-style: none;`,
    `  font-size: ${c ? '13px' : '14px'};`,
    `}`,
    `.features li { display: flex; align-items: center; gap: 10px; }`,
  );
  if (c) lines.push(`.features li::before { content: "✓"; color: var(--accent); font-weight: 700; }`);
  lines.push(
    `.plan .btn { margin-top: auto; }`,
    ``,
    `.note { margin: 32px 0 48px; text-align: center; color: var(--muted); font-size: 13px; }`,
    ``,
  );
  return lines.join('\n');
}

function auroraJs(o: AuroraOpts): string {
  const lines = [
    `// Aurora pricing — small progressive enhancements`,
    `document.querySelectorAll('.plan .btn').forEach((btn) => {`,
    `  btn.addEventListener('click', (event) => {`,
    `    event.preventDefault();`,
    `    btn.textContent = '已選擇';`,
    `  });`,
    `});`,
  ];
  if (o.annual) {
    lines.push(
      ``,
      `// Monthly / yearly billing toggle`,
      `const cycleButtons = document.querySelectorAll('.billing button');`,
      `cycleButtons.forEach((button) => {`,
      `  button.addEventListener('click', () => {`,
      `    const cycle = button.dataset.cycle;`,
      `    cycleButtons.forEach((b) => b.classList.toggle('is-active', b === button));`,
      `    document.querySelectorAll('[data-monthly]').forEach((el) => {`,
      `      el.textContent = cycle === 'yearly' ? el.dataset.yearly : el.dataset.monthly;`,
      `    });`,
      `  });`,
      `});`,
    );
  }
  lines.push(``);
  return lines.join('\n');
}

const CHECKOUT_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>Aurora — 結帳</title>
  <style>
    body { margin: 0; background: #fbfaf7; color: #1b2430; font-family: "PingFang TC", "Noto Sans TC", system-ui, sans-serif; }
    .wrap { max-width: 640px; margin: 96px auto; padding: 0 24px; }
    .step { color: #5b5bd6; font-weight: 600; font-size: 14px; margin: 0; }
    h1 { font-size: 34px; margin: 8px 0 24px; }
    .card { background: #fff; border: 1px solid #e6e2da; border-radius: 18px; padding: 28px; display: grid; gap: 14px; }
    .row { display: flex; justify-content: space-between; font-size: 15px; }
    .total { border-top: 1px solid #e6e2da; padding-top: 14px; font-weight: 700; font-size: 18px; }
    .pay { margin-top: 24px; display: block; text-align: center; padding: 14px; border-radius: 999px; background: #5b5bd6; color: #fff; font-weight: 600; }
  </style>
</head>
<body>
  <main class="wrap">
    <p class="step">步驟 2 / 3</p>
    <h1>確認你的專業方案</h1>
    <div class="card">
      <div class="row"><span>專業方案（月繳）</span><span>NT$240</span></div>
      <div class="row"><span>14 天免費試用</span><span>−NT$240</span></div>
      <div class="row total"><span>今天應付</span><span>NT$0</span></div>
    </div>
    <span class="pay">開始免費試用</span>
  </main>
</body>
</html>
`;

function auroraFiles(o: AuroraOpts): FileSet {
  const files: FileEntry[] = [
    text('index.html', auroraHtml(o)),
    text('checkout.html', CHECKOUT_HTML),
    text('styles.css', auroraCss(o)),
    text('app.js', auroraJs(o)),
    text('assets/logo.svg', LOGO_SVG),
    binary('assets/hero.png', 'aurora-hero-light', 186_412, HERO_LIGHT_ART),
    binary('assets/fonts/NotoSansTC-Subset.woff2', 'noto-subset', 1_418_204),
  ];
  if (!o.compact) files.push(text('assets/icons/check.svg', CHECK_SVG));
  if (o.theme === 'dark') {
    files.push(
      o.bigHero
        ? binary('assets/hero-dark.png', 'aurora-hero-dark-wide', 238_907, heroDarkArt(true))
        : binary('assets/hero-dark.png', 'aurora-hero-dark', 201_337, heroDarkArt(false)),
    );
  }
  return sortFiles(files);
}

// ---------------------------------------------------------------------------
// Nimbus 登入流程 (the "source folder missing" example project)

const NIMBUS_HEADLINES = ['歡迎回到 Nimbus', '繼續你的專案', '登入 Nimbus'];

const NIMBUS_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="100%" height="100%">
  <rect width="40" height="40" rx="12" fill="#0f766e"/>
  <path d="M12 25a6 6 0 0 1 1.5-11.8A8 8 0 0 1 28.6 16 4.5 4.5 0 0 1 28 25z" fill="#fff"/>
</svg>
`;

const NIMBUS_ART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 800" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
<defs><linearGradient id="ng" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#99f6e4"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>
<rect width="560" height="800" fill="url(#ng)"/>
<circle cx="380" cy="220" r="120" fill="#ffffff" opacity=".25"/>
<circle cx="160" cy="560" r="180" fill="#ffffff" opacity=".15"/>
</svg>`;

function nimbusHtml(o: NimbusOpts): string {
  const social = o.social
    ? [
        `      <div class="social">`,
        `        <span class="soc">以 Google 繼續</span>`,
        `        <span class="soc">以 Apple 繼續</span>`,
        `      </div>`,
        `      <p class="or">或使用電子郵件</p>`,
      ]
    : [];
  return [
    `<!doctype html>`,
    `<html lang="zh-Hant">`,
    `<head>`,
    `  <meta charset="utf-8">`,
    `  <title>Nimbus — 登入</title>`,
    `  <link rel="stylesheet" href="styles.css">`,
    `</head>`,
    `<body>`,
    `  <main class="shell">`,
    `    <section class="panel">`,
    `      <img src="assets/logo.svg" alt="" width="40" height="40">`,
    `      <h1>${NIMBUS_HEADLINES[o.headlineIdx % NIMBUS_HEADLINES.length] ?? ''}</h1>`,
    `      <p class="sub">登入以繼續你的專案。</p>`,
    ...social,
    `      <p class="field"><span>電子郵件</span><span class="input">you@example.com</span></p>`,
    `      <p class="field"><span>密碼</span><span class="input">••••••••</span></p>`,
    `      <span class="primary">登入</span>`,
    `      <p class="foot">還沒有帳號？<a href="#">建立帳號</a></p>`,
    `    </section>`,
    `    <aside class="art"><img class="illus" src="assets/illustration.png" alt=""></aside>`,
    `  </main>`,
    `</body>`,
    `</html>`,
    ``,
  ].join('\n');
}

const NIMBUS_CSS = `* { box-sizing: border-box; }
body { margin: 0; background: #f7faf9; color: #0f1f1c; font-family: "PingFang TC", "Noto Sans TC", system-ui, sans-serif; }
.shell { display: grid; grid-template-columns: 1fr 560px; height: 100vh; }
.panel { display: flex; flex-direction: column; justify-content: center; gap: 14px; padding: 0 120px; }
h1 { margin: 12px 0 0; font-size: 36px; }
.sub { margin: 0 0 12px; color: #52615d; }
.social { display: grid; gap: 10px; }
.soc { display: block; padding: 12px; border: 1px solid #d4dedb; border-radius: 12px; text-align: center; font-weight: 600; background: #fff; }
.or { margin: 4px 0; text-align: center; color: #7b8a86; font-size: 13px; }
.field { display: grid; gap: 6px; margin: 0; font-size: 14px; color: #52615d; }
.input { display: block; padding: 12px 14px; border: 1px solid #d4dedb; border-radius: 12px; background: #fff; color: #9aa7a3; }
.primary { display: block; margin-top: 8px; padding: 13px; border-radius: 12px; background: #0f766e; color: #fff; text-align: center; font-weight: 600; }
.foot { color: #52615d; font-size: 14px; }
.foot a { color: #0f766e; font-weight: 600; }
.art { position: relative; overflow: hidden; }
.illus { position: absolute; inset: 0; width: 100%; height: 100%; }
`;

function nimbusFiles(o: NimbusOpts): FileSet {
  return sortFiles([
    text('index.html', nimbusHtml(o)),
    text('styles.css', NIMBUS_CSS),
    text('assets/logo.svg', NIMBUS_LOGO),
    binary('assets/illustration.png', 'nimbus-illustration', 312_558, NIMBUS_ART),
  ]);
}

// ---------------------------------------------------------------------------
// Public API

export function buildFiles(o: DesignOpts): FileSet {
  return o.family === 'aurora' ? auroraFiles(o) : nimbusFiles(o);
}

/** The scripted "edit in your own editor" step. Returns the next design and a description. */
export function nextEdit(o: DesignOpts): { opts: DesignOpts; description: string } {
  if (o.family === 'nimbus') {
    if (!o.social) return { opts: { ...o, social: true }, description: '在登入畫面加上社群登入按鈕' };
    return { opts: { ...o, headlineIdx: o.headlineIdx + 1 }, description: '修改登入標題文案' };
  }
  if (!o.compact) return { opts: { ...o, compact: true }, description: '把價格卡片改得更緊湊，並改用 CSS 勾號' };
  if (o.theme === 'light') return { opts: { ...o, theme: 'dark' }, description: '嘗試深色主題，並加入深色主視覺圖' };
  if (!o.bigHero) return { opts: { ...o, bigHero: true }, description: '放大主標題，並換上更寬的主視覺圖' };
  if (!o.annual) return { opts: { ...o, annual: true }, description: '加入月繳 / 年繳切換' };
  return { opts: { ...o, leadIdx: o.leadIdx + 1 }, description: '調整標題下方的說明文案' };
}

// ---------------------------------------------------------------------------
// Preview composition (simulates the isolated Preview Host)

const PREVIEW_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'">`;

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}

/**
 * Builds a self-contained srcdoc for a snapshot: inlines the stylesheet,
 * replaces asset <img> tags with inline SVG stand-ins, drops scripts, and adds a
 * CSP that blocks all network. Relative URLs are never left in the output, so
 * the sandboxed iframe cannot request anything from the host origin.
 */
export function composePreview(files: FileSet, entry: string): string | null {
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const html = byPath.get(entry)?.text;
  if (html === undefined) return null;
  let out = html;
  out = out.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (_m, href: string) => {
    const css = byPath.get(href)?.text;
    return css === undefined ? '' : `<style>${css.replace(/<\/style/gi, '')}</style>`;
  });
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  out = out.replace(/<img\b[^>]*>/g, (tag) => {
    const src = attr(tag, 'src') ?? '';
    const cls = attr(tag, 'class');
    const w = attr(tag, 'width');
    const h = attr(tag, 'height');
    const style = [w ? `width:${w}px` : '', h ? `height:${h}px` : '', 'display:inline-block', 'flex:none']
      .filter(Boolean)
      .join(';');
    const file = byPath.get(src);
    const art = file?.kind === 'text' ? file.text : file?.previewArt;
    const classAttr = cls ? ` class="${cls}"` : '';
    return `<span${classAttr} style="${style}" data-asset="${src}">${art ?? ''}</span>`;
  });
  out = out.replace(/<head>/, `<head>\n  ${PREVIEW_CSP}`);
  // Any leftover relative href/src would resolve against the host page; neutralise them.
  out = out.replace(/\s(href|src)="(?!#)[^"]*"/g, ' $1="#"');
  return out;
}
