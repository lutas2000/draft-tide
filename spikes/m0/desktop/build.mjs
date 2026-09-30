// Bundles main (ESM) and the sandboxed preload (CJS) into dist/.
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], logLevel: 'warning' };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs', format: 'esm' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' });
