/**
 * Example data for the prototype: two recent projects, the scope review the
 * folder / example paths produce, folder-picker choices and one pending agent
 * request. All paths are display strings; nothing touches the real disk.
 */
import { minutesAgo } from '../lib/format';
import { pseudoHash, uuid } from '../lib/hash';
import { AURORA_BASELINE, NIMBUS_BASELINE, buildFiles, type AuroraOpts, type DesignOpts } from './designs';
import { createVersion } from './engine';
import type {
  EntryOrigin,
  ExcludedEntry,
  FileEntry,
  FolderChoice,
  PendingApproval,
  Project,
  ProjectId,
  ScopeDraft,
  SnapshotId,
  SnapshotKind,
  UnsupportedEntry,
  Version,
} from './types';

export const DEMO_PROJECT_ID = '7c1f3a52-2d8e-4f7b-9a41-0e6f5b8c2d19' as ProjectId;
export const MISSING_PROJECT_ID = 'e4a09b6d-51c3-4c88-b0f2-93d7a1c6e845' as ProjectId;

export const HISTORY_LOCATION = '~/Library/Application Support/Draft Tide';

export const EXCLUDED: readonly ExcludedEntry[] = [
  {
    path: '.git',
    kind: 'dir',
    reason: '原專案 Git 資料不會被修改',
    detail: '這個資料夾自己的 Git 紀錄不會被讀取或改動；Draft Tide 的版本歷史另外保存。',
  },
  {
    path: 'node_modules',
    kind: 'dir',
    reason: '套件與快取，可重新安裝',
    detail: '約 412 MB、18,204 個檔案。這些是開發工具下載的套件，不是設計內容。',
  },
  {
    path: '.env.local',
    kind: 'file',
    reason: '可能含密鑰',
    detail: '環境設定檔常含 API key 等機密，預設不保存進歷史。預設排除不代表能找出所有敏感內容。',
  },
  {
    path: '.DS_Store',
    kind: 'file',
    reason: '系統產生的檔案',
    detail: 'macOS Finder 的顯示設定，與設計內容無關。',
  },
];

export const UNSUPPORTED: readonly UnsupportedEntry[] = [
  {
    path: 'shared',
    kind: 'symlink',
    target: '../brand',
    detail:
      '這是指向資料夾外的捷徑（symbolic link）。Draft Tide 不會跟著捷徑讀取資料夾以外的檔案。若設計需要 ../brand 的內容，請先把檔案複製進這個資料夾。',
  },
];

function scopeHashFor(entry: string): string {
  return pseudoHash(`scope:v1:${entry}:${EXCLUDED.map((e) => e.path).join(',')}`);
}

export function makeScopeDraft(source: 'example' | 'folder', choice?: FolderChoice): ScopeDraft {
  const isExample = source === 'example';
  return {
    source,
    folderName: isExample ? 'aurora-pricing' : (choice?.folderName ?? 'aurora-landing'),
    displayPath: isExample ? '~/Documents/Draft Tide 範例/aurora-pricing' : (choice?.displayPath ?? '~/Design/aurora-landing'),
    suggestedName: isExample ? 'Aurora 定價頁（範例）' : (choice?.folderName ?? 'aurora-landing'),
    entryCandidates: ['index.html', 'checkout.html'],
    files: buildFiles(AURORA_BASELINE),
    excluded: EXCLUDED,
    unsupported: UNSUPPORTED,
    historyLocation: HISTORY_LOCATION,
    freeSpace: 182_400_000_000,
  };
}

export const OPEN_FOLDER_CHOICES: readonly FolderChoice[] = [
  { displayPath: '~/Design/aurora-landing', folderName: 'aurora-landing', note: 'Agent 產出的定價頁草稿 · 含 index.html' },
  {
    displayPath: '~/Design/aurora-pricing',
    folderName: 'aurora-pricing',
    note: '已經是專案「Aurora 定價頁」',
    boundProjectId: DEMO_PROJECT_ID,
  },
];

export const IMPORT_DESTINATIONS: readonly FolderChoice[] = [
  { displayPath: '~/Design/aurora-restored', folderName: 'aurora-restored', note: '空白資料夾', empty: true },
  { displayPath: '~/Design/aurora-pricing', folderName: 'aurora-pricing', note: '已有 9 個檔案', empty: false },
];

export const RELINK_CHOICES: readonly FolderChoice[] = [
  { displayPath: '~/Design/nimbus-login', folderName: 'nimbus-login', note: '內容與最後保存的 V2 相同' },
];

// ---------------------------------------------------------------------------
// Seed projects

interface SeedVersion {
  kind: SnapshotKind;
  origin: EntryOrigin;
  name: string;
  minutesAgo: number;
  design: DesignOpts;
  id: string;
}

function seedVersions(base: Pick<Project, 'scopeHash' | 'entry'>, seeds: SeedVersion[]): Version[] {
  const versions: Version[] = [];
  for (const s of seeds) {
    const v = createVersion(
      { versions, scopeHash: base.scopeHash, entry: base.entry },
      {
        kind: s.kind,
        origin: s.origin,
        name: s.name,
        files: buildFiles(s.design),
        design: s.design,
        createdAt: minutesAgo(s.minutesAgo),
        snapshotId: s.id,
      },
    );
    versions.push({ ...v, previewStatus: 'ready' });
  }
  return versions;
}

const A = AURORA_BASELINE;
const compact: AuroraOpts = { ...A, compact: true };
const dark: AuroraOpts = { ...compact, theme: 'dark' };
const bigHero: AuroraOpts = { ...dark, bigHero: true };
const annual: AuroraOpts = { ...bigHero, annual: true };

function demoProject(): Project {
  const scopeHash = scopeHashFor('index.html');
  const base = { scopeHash, entry: 'index.html' };
  const versions = seedVersions(base, [
    { id: '0b8e6c1e-8a57-4f0e-9d3b-5a0c7c2e4f11', kind: 'baseline', origin: 'gui', name: '第一版', minutesAgo: 3 * 1440 + 95, design: A },
    { id: '5d2f9a40-6c1b-4b7e-8f2a-1e9d3c7b6a22', kind: 'manual', origin: 'gui', name: '緊湊的價格卡片', minutesAgo: 2 * 1440 + 40, design: compact },
    { id: '9a7c3e15-2b4d-4e6f-a1c8-7d5b0f3e9c33', kind: 'agent-requested', origin: 'mcp', name: '深色主題嘗試', minutesAgo: 1440 + 210, design: dark },
    { id: 'c3e1b7d9-4f2a-4a8c-9e6b-2f8d1a5c7e44', kind: 'manual', origin: 'gui', name: '放大主標題', minutesAgo: 128, design: bigHero },
  ]);
  return {
    id: DEMO_PROJECT_ID,
    name: 'Aurora 定價頁',
    folderName: 'aurora-pricing',
    displayPath: '~/Design/aurora-pricing',
    entry: 'index.html',
    scopeHash,
    family: 'aurora',
    sourceAvailable: true,
    versions,
    working: buildFiles(annual),
    workingDesign: annual,
    createdAt: minutesAgo(3 * 1440 + 95),
    lastOpenedAt: minutesAgo(120),
  };
}

function missingProject(): Project {
  const scopeHash = scopeHashFor('index.html');
  const base = { scopeHash, entry: 'index.html' };
  const social = { ...NIMBUS_BASELINE, social: true };
  const versions = seedVersions(base, [
    { id: '1f4b8d2a-7c3e-4a9b-b5d1-6e2f0a8c3d55', kind: 'baseline', origin: 'gui', name: '第一版', minutesAgo: 12 * 1440, design: NIMBUS_BASELINE },
    { id: '6a9e2c7f-3d1b-4f5a-8c4e-9b7d2e1f0a66', kind: 'manual', origin: 'gui', name: '加上社群登入', minutesAgo: 11 * 1440 - 300, design: social },
  ]);
  return {
    id: MISSING_PROJECT_ID,
    name: 'Nimbus 登入流程',
    folderName: 'nimbus-login',
    displayPath: '~/Desktop/nimbus-login',
    entry: 'index.html',
    scopeHash,
    family: 'nimbus',
    sourceAvailable: false,
    versions,
    working: buildFiles(social),
    workingDesign: social,
    createdAt: minutesAgo(12 * 1440),
    lastOpenedAt: minutesAgo(10 * 1440),
  };
}

export function seedProjects(): Project[] {
  return [demoProject(), missingProject()];
}

export function seedPending(): PendingApproval[] {
  return [
    {
      id: uuid(),
      projectId: DEMO_PROJECT_ID,
      kind: 'restore',
      origin: 'mcp',
      targetId: '5d2f9a40-6c1b-4b7e-8f2a-1e9d3c7b6a22' as SnapshotId,
      requestedAt: minutesAgo(6),
      callerLabel: '外部 Agent',
    },
  ];
}

/** Creates a freshly bound project whose first version is the baseline. */
export function bindProject(draft: ScopeDraft, name: string, entry: string): Project {
  const scopeHash = scopeHashFor(entry);
  const now = new Date().toISOString();
  const id = uuid() as ProjectId;
  const baseline = createVersion(
    { versions: [], scopeHash, entry },
    { kind: 'baseline', origin: 'gui', name: '第一版', files: draft.files, design: AURORA_BASELINE },
  );
  return {
    id,
    name: name.trim() || draft.suggestedName,
    folderName: draft.folderName,
    displayPath: draft.displayPath,
    entry,
    scopeHash,
    family: 'aurora',
    sourceAvailable: true,
    versions: [baseline],
    working: draft.files,
    workingDesign: AURORA_BASELINE,
    createdAt: now,
    lastOpenedAt: now,
  };
}

/** A new, never-saved file an external tool dropped into the folder (UNTRACKED_FILES demo). */
export const UNTRACKED_FILE: FileEntry = (() => {
  const content = '# 定價頁文案草稿\n\n- 年繳方案要強調「省 20%」\n- 團隊方案補上 SSO 說明\n';
  return {
    path: 'notes/pricing-copy.md',
    kind: 'text',
    text: content,
    size: new TextEncoder().encode(content).length,
    hash: pseudoHash(`blob:${content}`),
  };
})();
