import { z } from 'zod';
import { DtError } from './errors.ts';
import { ProjectId } from './ids.ts';
import { isSingleLine } from './text.ts';

// `.drafttide.json` at the repo root (M1 plan §5.2). It is part of the design
// tree: anyone can hand-edit it and it changes with the remote. It is
// untrusted input: strict schema, nothing executable, no absolute paths, and
// anything unsafe is CONFIG_INVALID with nothing partially accepted. The
// "regular file, not a symlink" check belongs to the filesystem adapter.
export const PROJECT_CONFIG_FILE = '.drafttide.json';
export const PROJECT_CONFIG_SCHEMA_VERSION = 1;
export const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;

// A project-relative path with `/` separators: no absolute or drive paths, no
// backslashes, no empty, `.` or `..` segments, nothing under `.git`.
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 1024) return false;
  if (!p.isWellFormed() || !isSingleLine(p) || p.includes('\\')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git');
}

export const RelativePath = z.string().refine(isSafeRelativePath, 'must be a safe project-relative path');

// Excludes are handed to Git's own matcher (`ls-files --exclude`), so the
// character set and length are limited and negation (`!`) is not allowed.
const EXCLUDE_DIR_NAME = /^[A-Za-z0-9._~$@+=-][A-Za-z0-9._~$@+= -]{0,127}$/;
const EXCLUDE_FILE_PATTERN = /^[A-Za-z0-9._~$@+=*?-][A-Za-z0-9._~$@+=*? -]{0,127}$/;

export const ExcludeDirName = z
  .string()
  .regex(EXCLUDE_DIR_NAME)
  .refine((v) => v !== '.' && v !== '..' && v.toLowerCase() !== '.git', 'must not be ., .. or .git');
export const ExcludeFilePattern = z.string().regex(EXCLUDE_FILE_PATTERN);

// New fields need a new schemaVersion: unknown fields are always rejected.
export const ProjectConfig = z.strictObject({
  schemaVersion: z.literal(PROJECT_CONFIG_SCHEMA_VERSION),
  projectId: ProjectId,
  name: z.string().max(200).refine(isSingleLine, 'must be a single line'),
  entryFiles: z.array(RelativePath).max(16),
  excludeDirNames: z.array(ExcludeDirName).max(64),
  excludeFilePatterns: z.array(ExcludeFilePattern).max(128),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

function invalid(reason: string, message: string, details: Record<string, string | number | boolean> = {}): never {
  throw new DtError('CONFIG_INVALID', `${PROJECT_CONFIG_FILE}: ${message}`, { reason, ...details });
}

export function parseProjectConfig(bytes: Uint8Array): ProjectConfig {
  if (bytes.byteLength > MAX_PROJECT_CONFIG_BYTES) invalid('too-large', 'the file is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    invalid('not-json', 'the file is not valid UTF-8 JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid('not-object', 'must be a JSON object');
  const version = (raw as Record<string, unknown>)['schemaVersion'];
  // A newer schema is not "broken": the GUI asks the user to update the app.
  if (typeof version === 'number' && Number.isInteger(version) && version > PROJECT_CONFIG_SCHEMA_VERSION) {
    invalid('newer-schema', 'written by a newer Draft Tide', {
      schemaVersion: version,
      supportedSchemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
      requiresNewerApp: true,
    });
  }
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.map(String).join('.') ?? '';
    invalid('schema', `${field || 'file'} is invalid`, { field });
  }
  return parsed.data;
}

// Stable, hand-editable formatting: fixed key order, 2-space indent.
export function serializeProjectConfig(config: ProjectConfig): string {
  const ordered: ProjectConfig = {
    schemaVersion: config.schemaVersion,
    projectId: config.projectId,
    name: config.name,
    entryFiles: config.entryFiles,
    excludeDirNames: config.excludeDirNames,
    excludeFilePatterns: config.excludeFilePatterns,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
