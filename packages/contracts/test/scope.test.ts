import { describe, expect, it } from 'vitest';
import {
  CAPTURE_STAGES,
  CONFIG_INVALID_REASONS,
  CaptureProgress,
  DEFAULT_EXCLUDE_DIR_NAMES,
  DEFAULT_EXCLUDE_FILE_PATTERNS,
  ExcludeDirName,
  ExcludeFilePattern,
  REPO_BUSY_REASONS,
  REPO_UNSUPPORTED_REASONS,
  RepoBlocker,
  UNSUPPORTED_ENTRY_KINDS,
} from '../src/index.ts';

describe('scope contracts', () => {
  it('keeps the default excludes inside the character set of project excludes', () => {
    for (const d of DEFAULT_EXCLUDE_DIR_NAMES) expect(ExcludeDirName.safeParse(d).success, d).toBe(true);
    for (const p of DEFAULT_EXCLUDE_FILE_PATTERNS) expect(ExcludeFilePattern.safeParse(p).success, p).toBe(true);
  });

  it('keeps secrets, caches and editor folders out of new files by default', () => {
    expect(DEFAULT_EXCLUDE_DIR_NAMES).toEqual(expect.arrayContaining(['node_modules', '.cache', '.idea', '.vscode']));
    expect(DEFAULT_EXCLUDE_FILE_PATTERNS).toEqual(
      expect.arrayContaining(['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '.DS_Store', '*.log']),
    );
  });

  it('defines every reason once', () => {
    for (const list of [
      REPO_UNSUPPORTED_REASONS,
      REPO_BUSY_REASONS,
      UNSUPPORTED_ENTRY_KINDS,
      CONFIG_INVALID_REASONS,
      CAPTURE_STAGES,
    ]) {
      expect(new Set<string>(list).size).toBe(list.length);
      for (const r of list) expect(r).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('pairs each blocker code with its own reasons', () => {
    expect(RepoBlocker.safeParse({ code: 'REPO_BUSY', reason: 'merge-in-progress', details: {} }).success).toBe(true);
    expect(RepoBlocker.safeParse({ code: 'REPO_UNSUPPORTED', reason: 'merge-in-progress', details: {} }).success).toBe(
      false,
    );
    expect(RepoBlocker.safeParse({ code: 'REPO_UNSUPPORTED', reason: 'git-lfs', details: { count: 2 } }).success).toBe(
      true,
    );
  });

  it('has no ETA in capture progress', () => {
    const p = { stage: 'hash', attempt: 1, filesDone: 1, filesTotal: 2, bytesDone: 3, bytesTotal: 4 };
    expect(CaptureProgress.safeParse(p).success).toBe(true);
    expect(CaptureProgress.safeParse({ ...p, etaMs: 100 }).success).toBe(false);
  });
});
