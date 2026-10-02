// The Engine's keychain addon (macOS): a generic password created, read,
// updated and removed in-process, never with a dialog. The item is this test
// process's own, under a throwaway service name, and removed afterwards.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildNative } from '../scripts/build.ts';
import { createKeychainVault } from '../src/engine/github.ts';
import { COMPANION } from './helpers.ts';

const onMac = process.platform === 'darwin';
const service = `dev.drafttide.test.${randomUUID()}`;
const account = randomUUID();
let cleanup: (() => void) | null = null;

afterAll(() => cleanup?.());

describe.skipIf(!onMac)('keychain addon', () => {
  it('keeps one item: absent, written, updated in place, read back, removed', async () => {
    buildNative();
    const addon = createRequire(import.meta.url)(join(COMPANION, 'dist', 'native', 'keychain.node')) as Parameters<
      typeof createKeychainVault
    >[0];
    cleanup = () => void addon.remove(service, account);
    const vault = createKeychainVault(addon, { service, account, label: 'Draft Tide test item' });
    expect(vault.kind).toBe('keychain');
    expect(await vault.read()).toBeNull();
    await vault.write(new TextEncoder().encode('{"first":1}'));
    expect(new TextDecoder().decode((await vault.read()) as Uint8Array)).toBe('{"first":1}');
    await vault.write(new TextEncoder().encode('{"second":2}'));
    expect(new TextDecoder().decode((await vault.read()) as Uint8Array)).toBe('{"second":2}');
    await vault.clear();
    expect(await vault.read()).toBeNull();
    // Clearing what isn't there is not an error.
    await vault.clear();
  });
});
