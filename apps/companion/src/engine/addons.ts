import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

// The Engine's native addons (desktop identity, keychain, SQLite) load only in
// the Engine and only from beside it: next to the release Engine executable (a
// Node SEA), or from the development build's dist/native. Never from a path
// the environment, arguments, settings or SQLite could name. In a release
// package every addon is team-signed, and the Engine's library validation
// admits nothing else.
export function engineAddonPath(file: string): string | null {
  if (isSea()) {
    const beside = join(dirname(process.execPath), file);
    return existsSync(beside) ? beside : null;
  }
  // Next to the bundled engine.mjs (dist/native), or the dev build when
  // running from source.
  const here = dirname(fileURLToPath(import.meta.url));
  return (
    [join(here, 'native', file), join(here, '..', '..', 'dist', 'native', file)].find((c) => existsSync(c)) ?? null
  );
}

export function loadEngineAddon<T>(file: string): T | null {
  const path = engineAddonPath(file);
  if (!path) return null;
  // A SEA's own require loads only built-in modules.
  return createRequire(isSea() ? process.execPath : import.meta.url)(path) as T;
}
