// Third-party notices for the JavaScript the app ships: every production
// dependency of the desktop app and the companion (the GUI, Main, the CLI,
// the MCP server and the Engine are bundles of them). Over-inclusive on
// purpose: a dependency the bundler left out still gets listed. Electron,
// Chromium, Node and Git ship their own license files (licenses/, node/,
// git/).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface LicensedPackage {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

function licenseTexts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8').trim());
}

export function writeThirdPartyNotices(repo: string, file: string, filters: string[]): number {
  const r = spawnSync(
    'corepack',
    ['pnpm', 'licenses', 'list', '--prod', '--json', ...filters.flatMap((f) => ['--filter', f])],
    { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`pnpm licenses failed: ${r.stderr.trim().slice(0, 400)}`);
  const byLicense = JSON.parse(r.stdout) as Record<string, LicensedPackage[]>;
  const packages = Object.values(byLicense)
    .flat()
    .filter((p) => !p.name.startsWith('@draft-tide/'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sections = packages.map((p) => {
    const texts = [...new Set(p.paths.flatMap(licenseTexts))];
    const body =
      texts.length > 0 ? texts.join('\n\n') : `(no license file in the package; declared license: ${p.license})`;
    return `${p.name} ${p.versions.join(', ')} (${p.license})\n${'-'.repeat(72)}\n${body}\n`;
  });
  writeFileSync(
    file,
    `Draft Tide includes the following third-party software.\n\n${'='.repeat(72)}\n\n${sections.join(`\n${'='.repeat(72)}\n\n`)}`,
  );
  return packages.length;
}
