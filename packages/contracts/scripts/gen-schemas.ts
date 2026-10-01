// Exports the public contracts as JSON Schema into dist/schemas. A schema that
// can't be represented fails the build (TECH_STACK §8.1).
//
//   node scripts/gen-schemas.ts [outDir]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { publicSchemas } from '../src/json-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', 'dist', 'schemas'));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const failures: string[] = [];
let written = 0;
for (const [name, schema] of Object.entries(publicSchemas())) {
  try {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'throw', io: 'input' });
    writeFileSync(join(outDir, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
    written++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failures.length > 0) {
  process.stderr.write(`JSON Schema export failed:\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stderr.write(`wrote ${written} schemas to ${outDir}\n`);
