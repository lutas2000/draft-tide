import { DtError } from './errors.ts';

// The project configuration file at the repository root. It is part of the
// design tree (engineers can read it, anyone can hand-edit it), so everything
// in it is untrusted input: strict schema, no commands, no absolute paths.
export const CONFIG_FILE = '.drafttide.json';
export const MAX_CONFIG_BYTES = 64 * 1024;

export interface ProjectConfig {
  schemaVersion: 1;
  projectId: string;
  name: string;
  entryFiles: string[];
  excludeDirNames: string[];
  excludeFilePatterns: string[];
}

// Applied to new (untracked) files only. Tracked files are always in scope, so
// a default exclusion can never silently delete something already saved.
export const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.cache', '.parcel-cache', '.next', '.turbo', '.claude', '.cursor', '.idea', '.vscode'];
export const DEFAULT_EXCLUDE_FILES = ['.DS_Store', 'Thumbs.db', '.env', '.env.*', '*.log', '*.tmp', '*.swp', '~$*', '*.pem', '*.key', '*.p12', 'id_rsa*', '.npmrc', '.*.dt-tmp-*'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIR_NAME_RE = /^[A-Za-z0-9._~$@+=-][A-Za-z0-9._~$@+= -]{0,127}$/;
const FILE_PATTERN_RE = /^[A-Za-z0-9._~$@+=*?-][A-Za-z0-9._~$@+=*? -]{0,127}$/;

export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (!p.isWellFormed() || /[\u0000-\u001f\u007f\\]/.test(p)) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git');
}

function bad(msg: string): never {
  throw new DtError('CONFIG_INVALID', `${CONFIG_FILE}: ${msg}`);
}

export function parseConfig(bytes: Buffer): ProjectConfig {
  if (bytes.length > MAX_CONFIG_BYTES) bad('file is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    bad('not valid UTF-8 JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('must be a JSON object');
  const o = raw as Record<string, unknown>;
  const known = new Set(['schemaVersion', 'projectId', 'name', 'entryFiles', 'excludeDirNames', 'excludeFilePatterns']);
  for (const k of Object.keys(o)) if (!known.has(k)) bad(`unknown field "${k}"`);
  if (o['schemaVersion'] !== 1) bad('unsupported schemaVersion');
  if (typeof o['projectId'] !== 'string' || !UUID_RE.test(o['projectId'])) bad('projectId must be a UUID');
  if (typeof o['name'] !== 'string' || o['name'].length > 200 || /[\u0000-\u001f\u007f]/.test(o['name'])) bad('name must be a short single-line string');
  const list = (key: string, max: number, ok: (v: unknown) => boolean): string[] => {
    const v = o[key];
    if (!Array.isArray(v) || v.length > max || !v.every(ok)) bad(`${key} is invalid`);
    return v as string[];
  };
  return {
    schemaVersion: 1,
    projectId: o['projectId'],
    name: o['name'],
    entryFiles: list('entryFiles', 16, isSafeRelPath),
    excludeDirNames: list('excludeDirNames', 64, (v) => typeof v === 'string' && DIR_NAME_RE.test(v) && v !== '.' && v !== '..' && v.toLowerCase() !== '.git'),
    excludeFilePatterns: list('excludeFilePatterns', 128, (v) => typeof v === 'string' && FILE_PATTERN_RE.test(v)),
  };
}

export function newConfig(projectId: string, name: string, entryFiles: string[]): ProjectConfig {
  return { schemaVersion: 1, projectId, name, entryFiles, excludeDirNames: [...DEFAULT_EXCLUDE_DIRS], excludeFilePatterns: [...DEFAULT_EXCLUDE_FILES] };
}

// Stable, human-editable formatting (2-space indent, fixed key order).
export function serializeConfig(cfg: ProjectConfig): string {
  return `${JSON.stringify(cfg, null, 2)}\n`;
}
