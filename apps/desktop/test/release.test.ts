import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { packagedLayout } from '@draft-tide/engine-client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_ID, identifiers, readReleaseConfig } from '../scripts/release/config.ts';
import { payloadSigning } from '../scripts/release/sign.ts';
import { EXPECTED_FUSES, iconCheck } from '../scripts/release/verify.ts';
import { ICNS_TYPES, buildIcns, pngSize, readIcns } from '../scripts/make-icon.ts';

const ENV = {
  DT_APP_VERSION: '0.1.0',
  DT_TEAM_ID: 'ABCDE12345',
  DT_SIGN_IDENTITY: 'Developer ID Application: Someone (ABCDE12345)',
};

describe('the release configuration', () => {
  it('needs a version, a team and a Developer ID identity', () => {
    expect(() => readReleaseConfig({})).toThrow(/DT_APP_VERSION, DT_TEAM_ID, DT_SIGN_IDENTITY/);
    const config = readReleaseConfig(ENV);
    expect(config).toMatchObject({
      appVersion: '0.1.0',
      teamId: 'ABCDE12345',
      notaryProfile: null,
      github: { clientId: 'Iv23li5bVjuyY8pVqtz5', appSlug: 'draft-tide' },
    });
    expect(config.ids.app).toBe(DEFAULT_APP_ID);
  });

  it('refuses a certificate that is not a Developer ID Application of the team', () => {
    for (const identity of [
      'Apple Development: Someone (ABCDE12345)',
      'Apple Distribution: Someone (ABCDE12345)',
      'Developer ID Application: Someone Else (ZZZZZ99999)',
    ])
      expect(() => readReleaseConfig({ ...ENV, DT_SIGN_IDENTITY: identity })).toThrow(/DT_SIGN_IDENTITY/);
    expect(readReleaseConfig({ ...ENV, DT_SIGN_IDENTITY: 'A'.repeat(40) }).identity).toBe('A'.repeat(40));
  });

  it('takes another GitHub App only as a pair', () => {
    expect(() => readReleaseConfig({ ...ENV, DT_GITHUB_CLIENT_ID: 'Iv23abcdefgh' })).toThrow(/both/);
    expect(
      readReleaseConfig({ ...ENV, DT_GITHUB_CLIENT_ID: 'Iv23abcdefgh', DT_GITHUB_APP_SLUG: 'draft-tide' }).github,
    ).toEqual({ clientId: 'Iv23abcdefgh', appSlug: 'draft-tide' });
  });

  it('gives the Preview Host, the Engine, the companion Node and Git identifiers other than the app', () => {
    const ids = identifiers('app.example.desktop');
    const others = [ids.previewHost, ids.engine, ids.node, ids.git, ids.gitRemoteHttps];
    expect(new Set(others).size).toBe(others.length);
    for (const id of others) expect(id).not.toBe(ids.app);
  });
});

describe('signing the payload', () => {
  it('covers the executables of the packaged layout, with JIT only for the Preview Host, the Node and the Engine', () => {
    // POSIX paths on every OS: the layout is the macOS one.
    const contents = '/A.app/Contents';
    const layout = packagedLayout(`${contents}/Resources`, 'darwin');
    const ids = identifiers('app.example.desktop');
    const signing = payloadSigning(ids);
    const rel = (p: string) => relative(contents, p);
    expect(signing.get(rel(layout.previewHost))).toEqual({ identifier: ids.previewHost, jit: true });
    expect(signing.get(rel(layout.node))).toMatchObject({ jit: true });
    expect(signing.get(rel(layout.engine))).toMatchObject({ jit: true });
    expect(signing.get(rel(layout.git))).toMatchObject({ jit: false });
    expect(signing.get(rel(join(layout.gitExecPath, 'git-remote-https')))).toMatchObject({ jit: false });
    for (const addon of ['better_sqlite3', 'peer-identity', 'keychain'])
      expect(signing.get(rel(join(layout.engineDir, `${addon}.node`)))).toMatchObject({ jit: false });
  });
});

describe('the fuses', () => {
  it('turn off running as Node, NODE_OPTIONS and inspect, and turn on ASAR integrity', () => {
    expect(Object.values(EXPECTED_FUSES)).toHaveLength(9);
    expect(EXPECTED_FUSES).toMatchObject({ 0: false, 2: false, 3: false, 4: true, 5: true, 7: false });
  });
});

describe('the app icon', () => {
  const icon = join(import.meta.dirname, '..', 'assets', 'icon.icns');

  it('holds a PNG of every size macOS asks for, each its own size', () => {
    const entries = readIcns(readFileSync(icon));
    expect(entries.map((e) => e.type)).toEqual(ICNS_TYPES.map((t) => t.type));
    for (const [i, e] of entries.entries()) {
      const size = ICNS_TYPES[i]?.size ?? 0;
      expect(pngSize(e.data), e.type).toEqual({ width: size, height: size });
    }
  });

  it('builds and reads back an .icns', () => {
    const png = readIcns(readFileSync(icon))[0]?.data ?? Buffer.alloc(0);
    const built = buildIcns([{ type: 'icp4', png }]);
    expect(readIcns(built)).toEqual([{ type: 'icp4', data: png }]);
    expect(() => readIcns(Buffer.from('icns\0\0\0\x09x'))).toThrow();
  });

  it("is what the packaged app's Info.plist names (S8)", () => {
    const app = mkdtempSync(join(tmpdir(), 'dt-icon-app-'));
    try {
      mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
      writeFileSync(
        join(app, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleIconFile</key>\n\t<string>electron.icns</string></dict></plist>',
      );
      writeFileSync(join(app, 'Contents', 'Resources', 'electron.icns'), 'electron');
      expect(iconCheck(app, icon).ok).toBe(false);
      writeFileSync(join(app, 'Contents', 'Resources', 'electron.icns'), readFileSync(icon));
      expect(iconCheck(app, icon)).toMatchObject({ id: 'S8', ok: true, details: { named: 'electron.icns' } });
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});
