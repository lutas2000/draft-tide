// Packages, signs and (with a notary profile) notarizes the macOS release:
// out/release/Draft Tide-<version>-<arch>.dmg, the GPL sources asset
// (draft-tide-<version>-gpl-sources.tar, published in the same GitHub Release)
// and manifest.json beside them.
//
//   DT_APP_VERSION=0.1.0 DT_TEAM_ID=<team> \
//   DT_SIGN_IDENTITY="Developer ID Application: <name> (<team>)" \
//   [DT_NOTARY_PROFILE=<profile>] [DT_DESKTOP_APP_ID=<bundle id>] \
//   [DT_GITHUB_CLIENT_ID=<id> DT_GITHUB_APP_SLUG=<slug>]   (default: the release app) \
//   node scripts/package.ts
//
// Steps (scripts/release/ holds each part):
//  1. the companion in release mode: cli.mjs and the Engine SEA (the desktop
//     requirement and the Preview Host's renderer compiled in), from the Node
//     running this script, which also ships as the companion Node;
//  2. the desktop app in release mode (dist-release/), staged as a clean app
//     directory: no node_modules, nothing but Main, preload and the GUI;
//  3. @electron/packager: the app bundle with an asar (integrity recorded);
//  4. the Preview Host (a copy of the app's executable, Contents/MacOS) and
//     the payload into Contents/Resources (engine-client's packagedLayout):
//     node/, companion/, engine/, git/, skills/, licenses/;
//  5. the fuses;
//  6. Developer ID signing, inside out (release/sign.ts);
//  7. checks: static and runtime, the Preview Host's included
//     (release/verify.ts);
//  8. notarization and stapling of the app; the GPL sources asset; the disk
//     image (signed, notarized, stapled); Gatekeeper's verdict on both.
// Without DT_NOTARY_PROFILE, step 8 stops after a signed disk image, which
// is not a release artifact (Gatekeeper rejects it once downloaded).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseVersion, flipFuses } from '@electron/fuses';
import { packager } from '@electron/packager';
import { previewRendererId } from '@draft-tide/contracts';
import { packagedLayout } from '@draft-tide/engine-client';
import { releaseRequirement } from '../../companion/scripts/build.ts';
import { buildDesktop } from './build.ts';
import { readReleaseConfig, type ReleaseConfig } from './release/config.ts';
import { assembleGit, gplSourcesName, writeGplSources } from './release/git.ts';
import { makeDmg, notarize, notarizeApp, staple } from './release/notarize.ts';
import { writeThirdPartyNotices } from './release/notices.ts';
import { dmgSignArgs, signApp } from './release/sign.ts';
import {
  EXPECTED_FUSES,
  fuseCheck,
  gatekeeper,
  previewHostChecks,
  printChecks,
  runtimeChecks,
  staticChecks,
} from './release/verify.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const companion = join(repo, 'apps', 'companion');
const PRODUCT = 'Draft Tide';

function step(msg: string): void {
  process.stderr.write(`\n== ${msg}\n`);
}

function electronDir(): string {
  return dirname(createRequire(join(root, 'package.json')).resolve('electron'));
}

// The Node running this script becomes the companion Node and the base of the
// Engine SEA, so it must be relocatable: an official build that links only
// system libraries (a Homebrew Node links Homebrew's).
function preflight(config: ReleaseConfig): void {
  if (process.platform !== 'darwin') throw new Error('release packaging runs on macOS only');
  const linked = execFileSync('/usr/bin/otool', ['-L', process.execPath], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' ')[0] ?? '')
    .filter((l) => l !== '');
  const foreign = linked.filter((l) => !l.startsWith('/usr/lib/') && !l.startsWith('/System/Library/'));
  if (foreign.length > 0) throw new Error(`${process.execPath} links non-system libraries: ${foreign.join(', ')}`);
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  if (!identities.includes(config.identity))
    throw new Error(`signing identity not in the keychain: ${config.identity}`);
  if (config.notaryProfile === null)
    process.stderr.write('warning: DT_NOTARY_PROFILE is not set; the result is signed but not notarized\n');
}

// The renderer the packaged Preview Host reports (the Electron the packager
// uses), compiled into the Engine so previews are cached under it before the
// first render. R4 checks the packaged host reports exactly this.
function previewRenderer(electronVersion: string): string {
  const binary = createRequire(join(root, 'package.json'))('electron') as string;
  const r = spawnSync(binary, ['-p', 'process.versions.electron + " " + process.versions.chrome'], {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  const [electron, chromium] = r.stdout.trim().split(' ');
  if (r.status !== 0 || electron !== electronVersion || !chromium || !/^[0-9.]+$/.test(chromium))
    throw new Error(`could not read Electron ${electronVersion}'s Chromium version: ${r.stderr.trim().slice(0, 300)}`);
  return previewRendererId(electron, chromium);
}

function buildCompanion(config: ReleaseConfig, renderer: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DT_BUILD_MODE: 'release',
    DT_DESKTOP_APP_ID: config.ids.app,
    DT_TEAM_ID: config.teamId,
    DT_APP_VERSION: config.appVersion,
    DT_PREVIEW_RENDERER: renderer,
  };
  env['DT_GITHUB_CLIENT_ID'] = config.github.clientId;
  env['DT_GITHUB_APP_SLUG'] = config.github.appSlug;
  const r = spawnSync(process.execPath, [join(companion, 'scripts', 'build.ts')], { env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('the companion release build failed');
}

// A clean app directory for the packager: Main, preload, the GUI and a
// minimal package.json. Main is one bundle (only electron is external).
function stageApp(built: string, stage: string, config: ReleaseConfig): void {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const part of ['main', 'preload', 'gui']) cpSync(join(built, part), join(stage, part), { recursive: true });
  const desktop = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { description?: string };
  writeFileSync(
    join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name: 'draft-tide',
        productName: PRODUCT,
        version: config.appVersion,
        description: desktop.description ?? '',
        license: 'Apache-2.0',
        main: 'main/main.mjs',
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
}

// The Preview Host: the app's own executable (Electron's stub), copied beside
// it so Electron resolves the same framework, helpers and app.asar (with its
// integrity check) for it; signing gives it its own identifier (sign.ts), and
// Main runs only the Preview Host in it. A nested helper app doesn't work:
// Electron's helper executable won't run a browser process, and a stub in a
// nested bundle finds no helpers and would skip the asar integrity check
// (M1-09 record).
function addPreviewHost(app: string): string {
  const layout = packagedLayout(join(app, 'Contents', 'Resources'));
  copyFileSync(join(app, 'Contents', 'MacOS', PRODUCT), layout.previewHost);
  chmodSync(layout.previewHost, 0o755);
  return layout.previewHost;
}

// The payload, in the layout every component looks for (packagedLayout).
function addPayload(app: string, cacheDir: string, appVersion: string): { git: string; notices: number } {
  const resources = join(app, 'Contents', 'Resources');
  const layout = packagedLayout(resources);
  const dist = join(companion, 'dist');

  mkdirSync(dirname(layout.node), { recursive: true });
  copyFileSync(process.execPath, layout.node);
  const nodeLicense = join(dirname(dirname(process.execPath)), 'LICENSE');
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(dirname(dirname(layout.node)), 'LICENSE'));

  mkdirSync(dirname(layout.cli), { recursive: true });
  copyFileSync(join(dist, 'cli.mjs'), layout.cli);
  if (existsSync(join(dist, 'cli.mjs.LEGAL.txt')))
    copyFileSync(join(dist, 'cli.mjs.LEGAL.txt'), join(dirname(layout.cli), 'cli.mjs.LEGAL.txt'));

  // The Engine and its addons, nothing else beside it.
  cpSync(join(dist, 'sea'), layout.engineDir, { recursive: true });

  const git = assembleGit(cacheDir, dirname(dirname(layout.git)), appVersion);

  cpSync(join(repo, 'skills', 'draft-tide'), layout.skillDir, { recursive: true });

  const licenses = join(resources, 'licenses');
  mkdirSync(licenses, { recursive: true });
  copyFileSync(join(electronDir(), 'dist', 'LICENSE'), join(licenses, 'electron-LICENSE'));
  copyFileSync(join(electronDir(), 'dist', 'LICENSES.chromium.html'), join(licenses, 'LICENSES.chromium.html'));
  copyFileSync(join(repo, 'LICENSE'), join(licenses, 'draft-tide-LICENSE'));
  const notices = writeThirdPartyNotices(repo, join(licenses, 'THIRD-PARTY-NOTICES.txt'), [
    '@draft-tide/desktop',
    '@draft-tide/companion',
  ]);
  return { git: git.version, notices };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main(): Promise<void> {
  const config = readReleaseConfig();
  preflight(config);
  const out = join(root, 'out', 'release');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const electronVersion = (JSON.parse(readFileSync(join(electronDir(), 'package.json'), 'utf8')) as { version: string })
    .version;
  const desktopRequirement = releaseRequirement(config.ids.app, config.teamId);
  const renderer = previewRenderer(electronVersion);

  step(`companion (release): CLI and Engine SEA (Preview Host: ${renderer})`);
  buildCompanion(config, renderer);

  step('desktop (release)');
  const built = await buildDesktop({ mode: 'release', appVersion: config.appVersion });
  const stage = join(out, 'stage');
  stageApp(built, stage, config);

  step(`app bundle (Electron ${electronVersion})`);
  const [appDir] = await packager({
    dir: stage,
    out: join(out, 'package'),
    platform: 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    electronVersion,
    name: PRODUCT,
    executableName: PRODUCT,
    appBundleId: config.ids.app,
    appVersion: config.appVersion,
    buildVersion: config.appVersion,
    appCategoryType: 'public.app-category.productivity',
    darwinDarkModeSupport: true,
    asar: true,
    prune: false,
    overwrite: true,
    quiet: true,
  });
  if (!appDir) throw new Error('the packager produced no app');
  const app = join(appDir, `${PRODUCT}.app`);
  rmSync(stage, { recursive: true, force: true });

  step('Preview Host and payload: companion Node, CLI, Engine, Git, Skill, licenses');
  addPreviewHost(app);
  const payload = addPayload(app, join(root, '.cache'), config.appVersion);

  step('fuses');
  await flipFuses(app, {
    version: FuseVersion.V1,
    // Signed next with the Developer ID.
    resetAdHocDarwinSignature: false,
    strictlyRequireAllFuses: true,
    ...EXPECTED_FUSES,
  });

  step(`signing with ${config.identity}`);
  await signApp(app, config.identity, config.ids);

  step('checks');
  const checks = [
    ...staticChecks(app, { teamId: config.teamId, ids: config.ids, desktopRequirement }),
    await fuseCheck(app),
    ...(await runtimeChecks(app, { appVersion: config.appVersion, githubConfigured: true })),
    ...(await previewHostChecks(app, { renderer, desktopRequirement, previewHostId: config.ids.previewHost })),
  ];
  if (!printChecks(checks)) throw new Error('release checks failed; nothing was notarized');

  let notarized = false;
  if (config.notaryProfile) {
    step('notarizing the app');
    notarizeApp(app, config.notaryProfile);
    notarized = true;
  }
  const appGate = gatekeeper(app, 'exec');

  step('GPL sources (an asset of the same Release)');
  const gplSources = writeGplSources(
    join(root, '.cache'),
    join(out, gplSourcesName(config.appVersion)),
    config.appVersion,
  );

  step('disk image');
  const dmg = join(out, `${PRODUCT}-${config.appVersion}-${process.arch}.dmg`);
  makeDmg(app, dmg, PRODUCT);
  execFileSync('/usr/bin/codesign', dmgSignArgs(config.identity, config.ids.dmg, dmg), {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (config.notaryProfile) {
    notarize(dmg, config.notaryProfile);
    staple(dmg);
  }
  const dmgGate = gatekeeper(dmg, 'open');

  const manifest = {
    product: PRODUCT,
    version: config.appVersion,
    platform: `${process.platform}-${process.arch}`,
    identifiers: config.ids,
    teamId: config.teamId,
    desktopRequirement,
    githubApp: config.github,
    runtime: { electron: electronVersion, previewRenderer: renderer, node: process.version, git: payload.git },
    thirdPartyPackages: payload.notices,
    notarized,
    gatekeeper: { app: appGate, dmg: dmgGate },
    dmg: { file: dmg.slice(out.length + 1), bytes: statSync(dmg).size, sha256: sha256(dmg) },
    // Publish with the disk image, in the same Release, for as long as it is
    // downloadable (GPLv2 §3).
    gplSources: {
      file: gplSources.slice(out.length + 1),
      bytes: statSync(gplSources).size,
      sha256: sha256(gplSources),
    },
    checks: checks.map((c) => ({ id: c.id, ok: c.ok })),
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(
    `\n${dmg}\n  ${(manifest.dmg.bytes / 1024 / 1024).toFixed(1)} MiB, sha256 ${manifest.dmg.sha256}\n` +
      `  notarized: ${notarized ? 'yes' : 'no'}; Gatekeeper app: ${appGate.ok ? 'accepted' : 'rejected'}, dmg: ${dmgGate.ok ? 'accepted' : 'rejected'}\n`,
  );
  if (notarized && !(appGate.ok && dmgGate.ok)) throw new Error('Gatekeeper rejected the notarized build');
}

await main();
