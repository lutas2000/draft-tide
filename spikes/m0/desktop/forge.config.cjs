// Electron Forge (no Vite plugin): packages dist/ and ships the companion
// payload from ../core/build as extra resources outside the asar.
const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const payload = path.resolve(__dirname, '..', 'core', 'build');

module.exports = {
  packagerConfig: {
    name: 'Draft Tide M0',
    executableName: 'Draft Tide M0',
    appBundleId: 'dev.drafttide.m0-spike',
    asar: true,
    extraResource: ['companion', 'node', 'git', 'bin', 'gui'].map((d) => path.join(payload, d)),
    ignore: (p) => p !== '' && !/^\/(dist|package\.json)/.test(p),
  },
  hooks: {
    // Unsigned spike: re-seal the bundle ad-hoc after packaging so
    // `codesign --verify --deep --strict` passes. Releases use Developer ID +
    // hardened runtime + notarization instead.
    postPackage: async (_config, result) => {
      if (result.platform !== 'darwin') return;
      for (const dir of result.outputPaths) {
        for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.app'))) {
          execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.join(dir, name)], { stdio: 'inherit' });
        }
      }
    },
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true, // unsigned spike: keep a valid ad-hoc signature on arm64
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false, // GUI uses app://, never file://
    }),
  ],
};
