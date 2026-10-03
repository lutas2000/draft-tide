// Notarization with notarytool (a keychain profile made once with
// `xcrun notarytool store-credentials`; the credentials never pass through
// this script), stapling, and the disk image.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface NotaryResult {
  id: string | null;
  status: string;
}

// Submits a zip, disk image or package and waits for Apple's verdict.
export function notarize(file: string, profile: string): NotaryResult {
  process.stderr.write(`notarizing ${basename(file)} (this waits for Apple)…\n`);
  const r = spawnSync(
    '/usr/bin/xcrun',
    ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json'],
    { encoding: 'utf8' },
  );
  let parsed: { id?: string; status?: string; message?: string } = {};
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    throw new Error(`notarytool failed (${r.status ?? 'signal'}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  }
  const result = { id: parsed.id ?? null, status: parsed.status ?? 'unknown' };
  if (result.status !== 'Accepted') {
    const log = result.id
      ? spawnSync('/usr/bin/xcrun', ['notarytool', 'log', result.id, '--keychain-profile', profile], {
          encoding: 'utf8',
        }).stdout
      : '';
    throw new Error(
      `notarization ${result.status} (${result.id ?? 'no id'}): ${parsed.message ?? ''}\n${log.slice(0, 4000)}`,
    );
  }
  return result;
}

// Notarizes the app through a zip, then staples the ticket to the app itself,
// so Gatekeeper accepts it offline once copied out of the disk image.
export function notarizeApp(app: string, profile: string): NotaryResult {
  const dir = mkdtempSync(join(tmpdir(), 'dt-notarize-'));
  try {
    const zip = join(dir, `${basename(app, '.app')}.zip`);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
    const result = notarize(zip, profile);
    staple(app);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function staple(path: string): void {
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', path], { stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', path], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// A compressed (lzfse) disk image holding the app and a link to
// /Applications.
export function makeDmg(app: string, dmg: string, volumeName: string): void {
  const staging = mkdtempSync(join(tmpdir(), 'dt-dmg-'));
  try {
    execFileSync('/usr/bin/ditto', [app, join(staging, basename(app))]);
    symlinkSync('/Applications', join(staging, 'Applications'));
    rmSync(dmg, { force: true });
    execFileSync(
      '/usr/bin/hdiutil',
      ['create', '-volname', volumeName, '-srcfolder', staging, '-ov', '-format', 'ULFO', dmg],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
