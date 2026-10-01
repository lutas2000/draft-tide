// Development loop: the GUI from the Vite dev server (hot reload), Main and
// preload rebuilt once, then Electron. Restart this script after editing Main.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildDesktop } from './build.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ configFile: join(root, 'vite.config.ts') });
await vite.listen();
const url = vite.resolvedUrls?.local[0];
if (!url) throw new Error('Vite dev server has no local URL');
await buildDesktop({ mode: 'development', guiDevUrl: url, skipGui: true });

const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
const child = spawn(electronPath, [root], { stdio: 'inherit' });
child.on('exit', (code) => {
  void vite.close().then(() => process.exit(code ?? 0));
});
