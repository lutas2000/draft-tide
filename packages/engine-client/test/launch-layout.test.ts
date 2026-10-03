import { describe, expect, it } from 'vitest';
import { DATA_DIR_ENV, engineEnvironment, packagedLayout, scriptEngineLaunch } from '../src/index.ts';

describe('the Engine environment', () => {
  const caller = {
    HOME: '/Users/a',
    TMPDIR: '/tmp/x',
    USER: 'a',
    LOGNAME: 'a',
    LANG: 'en_US.UTF-8',
    PATH: '/opt/homebrew/bin:/usr/bin',
    NODE_OPTIONS: '--require /tmp/evil.js',
    NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    GIT_DIR: '/tmp/repo',
    XDG_DATA_HOME: '/x',
  };

  it('carries only the OS basics and the data directory on macOS', () => {
    expect(engineEnvironment('/data', {}, 'darwin', caller)).toEqual({
      [DATA_DIR_ENV]: '/data',
      HOME: '/Users/a',
      TMPDIR: '/tmp/x',
      USER: 'a',
      LOGNAME: 'a',
      LANG: 'en_US.UTF-8',
    });
  });

  it('keeps the XDG directories only on Linux', () => {
    expect(engineEnvironment('/data', {}, 'linux', caller)).toHaveProperty('XDG_DATA_HOME', '/x');
    expect(engineEnvironment('/data', {}, 'darwin', caller)).not.toHaveProperty('XDG_DATA_HOME');
  });

  it("adds the launch's own variables", () => {
    expect(engineEnvironment('/data', { DRAFT_TIDE_ENGINE_IDLE_MS: '500' }, 'darwin', caller)).toHaveProperty(
      'DRAFT_TIDE_ENGINE_IDLE_MS',
      '500',
    );
  });
});

describe('launching the Engine', () => {
  it('runs the development Engine script with --disable-sigusr1 before it', () => {
    const launch = scriptEngineLaunch('/node', '/engine.mjs', { A: '1' });
    expect(launch.command).toBe('/node');
    expect(launch.args).toEqual(['--disable-sigusr1', '/engine.mjs']);
    expect(launch.env).toMatchObject({ A: '1' });
  });
});

describe('the packaged layout', () => {
  it('keeps every part in its own place under the resources', () => {
    expect(packagedLayout('/App.app/Contents/Resources', 'darwin')).toEqual({
      node: '/App.app/Contents/Resources/node/bin/node',
      cli: '/App.app/Contents/Resources/companion/cli.mjs',
      engine: '/App.app/Contents/Resources/engine/draft-tide-engine',
      engineDir: '/App.app/Contents/Resources/engine',
      git: '/App.app/Contents/Resources/git/bin/git',
      gitExecPath: '/App.app/Contents/Resources/git/libexec/git-core',
      skillDir: '/App.app/Contents/Resources/skills/draft-tide',
      previewHost: '/App.app/Contents/MacOS/Draft Tide Preview',
    });
  });

  it('names Windows executables with .exe', () => {
    const layout = packagedLayout('C:\\Draft Tide\\resources', 'win32');
    expect(layout.engine).toBe('C:\\Draft Tide\\resources\\engine\\draft-tide-engine.exe');
    expect(layout.node).toBe('C:\\Draft Tide\\resources\\node\\bin\\node.exe');
    expect(layout.previewHost).toBe('C:\\Draft Tide\\Draft Tide Preview.exe');
  });
});
