// The bundled Git (CLAUDE.md "Git hygiene", single-repo spike Finding 10): the
// subset of dugite-native 2.53.0 Draft Tide needs, and nothing else:
//
//   git/bin/git
//   git/libexec/git-core/git-remote-https
//   git/libexec/git-core/git              → ../../bin/git
//   git/libexec/git-core/git-remote-http  → git-remote-https
//
// No Git Credential Manager, git-lfs, scalar, templates or dugite's
// etc/gitconfig. Both binaries link only system libraries (TLS through the
// system's libcurl and trust). The Engine sets GIT_EXEC_PATH, since this build
// can't derive its own.
//
// GPL-2.0 (decided 2026-10-03): the complete corresponding source is offered
// from the same place as the app, as an asset of the same GitHub Release
// (GPLv2 §3, last paragraph): draft-tide-<version>-gpl-sources.tar, made by
// writeGplSources() from pinned inputs. Git's COPYING and SOURCE.txt, naming
// that asset, ship beside the binaries. An app that stays downloadable keeps
// its sources asset.
//
// Downloads are pinned by SHA-256 and cached in apps/desktop/.cache/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

interface Pinned {
  name: string;
  url: string;
  sha256: string;
}

const DUGITE_TAG = 'v2.53.0-4';
const DUGITE: Partial<Record<string, Pinned>> = {
  'darwin-arm64': {
    name: 'dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz',
    url: `https://github.com/desktop/dugite-native/releases/download/${DUGITE_TAG}/dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz`,
    sha256: 'f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe',
  },
  // Not measured yet (CLAUDE.md): macOS x64 and universal builds.
};

// The source of what ships: Git 2.53.0 (kernel.org's release tarball, the
// hash checked against kernel.org's sha256sums.asc) and dugite-native at the
// tag that built it, whose `git` submodule is v2.53.0's commit
// (67ad42147a7acc2af6074753ebd03d904476118f) and whose script/build-macos.sh
// applies no patches.
const GIT_SOURCE: Pinned = {
  name: 'git-2.53.0.tar.xz',
  url: 'https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.53.0.tar.xz',
  sha256: '5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653',
};
const DUGITE_SOURCE: Pinned = {
  name: 'dugite-native-v2.53.0-4-source.tar.gz',
  url: `https://github.com/desktop/dugite-native/archive/refs/tags/${DUGITE_TAG}.tar.gz`,
  sha256: '6600bdf3c7e2cbb127ac63d9d38da3a91267610c6034ecb8ff73e94f89508f33',
};

export function gplSourcesName(appVersion: string): string {
  return `draft-tide-${appVersion}-gpl-sources.tar`;
}

const GIT_COPYING: Pinned = {
  name: 'git-v2.53.0-COPYING',
  url: 'https://raw.githubusercontent.com/git/git/v2.53.0/COPYING',
  sha256: '5b2198d1645f767585e8a88ac0499b04472164c0d2da22e75ecf97ef443ab32e',
};

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Downloads once into the cache (resuming a partial download) and checks the
// hash on every use.
function fetchPinned(cacheDir: string, pin: Pinned): string {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, pin.name);
  if (!existsSync(file)) {
    const partial = `${file}.partial`;
    process.stderr.write(`downloading ${pin.url}\n`);
    execFileSync(
      '/usr/bin/curl',
      ['--fail', '--location', '--silent', '--show-error', '--continue-at', '-', '--output', partial, pin.url],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    renameSync(partial, file);
  }
  const actual = sha256(file);
  if (actual !== pin.sha256) {
    rmSync(file, { force: true });
    throw new Error(`${pin.name}: SHA-256 ${actual}, expected ${pin.sha256} (removed; run again to re-download)`);
  }
  return file;
}

export interface BundledGit {
  version: string;
  source: string;
}

// Assembles the subset into outDir (the payload's git/ directory).
export function assembleGit(cacheDir: string, outDir: string, appVersion: string): BundledGit {
  const key = `${process.platform}-${process.arch}`;
  const pin = DUGITE[key];
  if (!pin) throw new Error(`no pinned dugite-native build for ${key}`);
  const tarball = fetchPinned(cacheDir, pin);
  const copying = fetchPinned(cacheDir, GIT_COPYING);
  const scratch = mkdtempSync(join(tmpdir(), 'dt-git-'));
  try {
    // In the tarball git-remote-https is a symlink to git-remote-http.
    execFileSync(
      '/usr/bin/tar',
      [
        '-xzf',
        tarball,
        '-C',
        scratch,
        'bin/git',
        'libexec/git-core/git-remote-http',
        'libexec/git-core/git-remote-https',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(join(outDir, 'bin'), { recursive: true });
    mkdirSync(join(outDir, 'libexec', 'git-core'), { recursive: true });
    copyFileSync(join(scratch, 'bin', 'git'), join(outDir, 'bin', 'git'));
    copyFileSync(
      join(scratch, 'libexec', 'git-core', 'git-remote-http'),
      join(outDir, 'libexec', 'git-core', 'git-remote-https'),
    );
    symlinkSync('../../bin/git', join(outDir, 'libexec', 'git-core', 'git'));
    symlinkSync('git-remote-https', join(outDir, 'libexec', 'git-core', 'git-remote-http'));
    copyFileSync(copying, join(outDir, 'COPYING'));
    writeFileSync(join(outDir, 'SOURCE.txt'), sourceText(key, pin, appVersion));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { version: '2.53.0', source: pin.url };
}

function sourceText(key: string, binaries: Pinned, appVersion: string): string {
  return [
    `Git 2.53.0, as built by dugite-native ${DUGITE_TAG} (${key}), unmodified.`,
    'Only bin/git and libexec/git-core/git-remote-https are included.',
    '',
    'Git is licensed under the GNU General Public License version 2 (COPYING).',
    '',
    'Its complete corresponding source is offered from the same place as this',
    'app: the GitHub Release you downloaded Draft Tide from carries it as',
    '',
    `  ${gplSourcesName(appVersion)}`,
    '',
    'which holds:',
    `  ${GIT_SOURCE.name}`,
    `    SHA-256 ${GIT_SOURCE.sha256}`,
    `  ${DUGITE_SOURCE.name} (the build scripts)`,
    `    SHA-256 ${DUGITE_SOURCE.sha256}`,
    '',
    'The binaries come from:',
    `  ${binaries.url}`,
    `  SHA-256 ${binaries.sha256}`,
    '',
    'Upstream: https://github.com/git/git/tree/v2.53.0',
    `          https://github.com/desktop/dugite-native/tree/${DUGITE_TAG}`,
    '',
  ].join('\n');
}

// The Release asset with Git's complete corresponding source: the two
// pinned source archives, COPYING and a README on how they match what ships.
// Uncompressed tar: its members are compressed already.
export function writeGplSources(cacheDir: string, outFile: string, appVersion: string): string {
  const key = `${process.platform}-${process.arch}`;
  const binaries = DUGITE[key];
  if (!binaries) throw new Error(`no pinned dugite-native build for ${key}`);
  const scratch = mkdtempSync(join(tmpdir(), 'dt-gpl-'));
  const dir = join(scratch, `draft-tide-${appVersion}-gpl-sources`);
  try {
    mkdirSync(dir);
    for (const pin of [GIT_SOURCE, DUGITE_SOURCE, GIT_COPYING])
      copyFileSync(fetchPinned(cacheDir, pin), join(dir, pin === GIT_COPYING ? 'COPYING' : pin.name));
    writeFileSync(
      join(dir, 'README.txt'),
      [
        `Source code for the GPL-2.0 software in Draft Tide ${appVersion}`,
        '',
        `Draft Tide ships two programs from Git 2.53.0 (Contents/Resources/git/ in the app):`,
        '  bin/git and libexec/git-core/git-remote-https,',
        `taken unmodified from dugite-native ${DUGITE_TAG}'s ${key} build:`,
        `  ${binaries.url}`,
        `  SHA-256 ${binaries.sha256}`,
        '',
        `${GIT_SOURCE.name}`,
        "  Git's release source, from kernel.org:",
        `  ${GIT_SOURCE.url}`,
        `  SHA-256 ${GIT_SOURCE.sha256}`,
        '',
        `${DUGITE_SOURCE.name}`,
        `  dugite-native at ${DUGITE_TAG}: the scripts that build those binaries.`,
        '  Its git/ submodule is Git v2.53.0 (commit 67ad42147a7acc2af6074753ebd03d904476118f),',
        `  the source in ${GIT_SOURCE.name}; script/build-macos.sh applies no patches.`,
        `  ${DUGITE_SOURCE.url}`,
        `  SHA-256 ${DUGITE_SOURCE.sha256}`,
        '',
        'COPYING',
        "  Git's license, the GNU General Public License version 2.",
        '',
      ].join('\n'),
    );
    rmSync(outFile, { force: true });
    execFileSync('/usr/bin/tar', ['-cf', outFile, '-C', scratch, basename(dir)], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { COPYFILE_DISABLE: '1', PATH: '/usr/bin:/bin' },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return outFile;
}
