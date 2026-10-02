import type {
  Activity,
  CollisionReason,
  ConfigInvalidReason,
  ErrorCode,
  FolderState,
  Origin,
  PreviewBlockedKind,
  PreviewFailedReason,
  PreviewMissingReason,
  PreviewUnsupportedReason,
  RecoveryReason,
  RepoBlocker,
  RepoBusyReason,
  RepoUnsupportedReason,
  RepoWarningReason,
  SnapshotKind,
  UnsupportedEntryKind,
} from '@draft-tide/contracts';

// Designer-facing words for every stable code and reason (M1 plan §4.1): a
// reason and a next step, never only a code. Codes stay visible in details.

export interface Copy {
  title: string;
  next: string;
}

export const ERROR_COPY: Partial<Record<ErrorCode, Copy>> = {
  ENGINE_UNAVAILABLE: {
    title: '無法連線到 Draft Tide 引擎',
    next: '設計檔案與歷史不受影響。稍後重試，或重新開啟 Draft Tide。',
  },
  PROTOCOL_MISMATCH: { title: 'Draft Tide 的元件版本不一致', next: '請更新或重新開啟 Draft Tide。' },
  STORAGE_IO_FAILED: { title: '無法讀寫本機狀態', next: '沒有任何資料被刪除。請到「設定與診斷」查看詳情。' },
  NO_CHANGES: { title: '這次沒有建立新版本', next: '資料夾內容與最新版本相同，不會建立重複的版本。' },
  SOURCE_BUSY: {
    title: '檔案還在變動，這次沒有保存',
    next: '有程式正在寫入資料夾。先停止會寫檔的工具（例如 agent 或自動儲存），再保存一次。',
  },
  LOCKED: { title: '另一個 Git 程式正在使用這個資料夾', next: '什麼都沒有改動。稍等一下再試一次。' },
  HISTORY_CHANGED: {
    title: '保存期間有其他程式在歷史中加入了新的內容',
    next: '什麼都沒有被覆蓋。再保存一次，新版本會接在它之後。',
  },
  REPO_BUSY: { title: '另一個 Git 操作正在進行', next: '等它完成（例如合併或 rebase）後再試。' },
  REPO_UNSUPPORTED: { title: '這個資料夾的 Git 狀態目前無法使用', next: '請看說明的原因與下一步。' },
  UNSUPPORTED_ENTRY: { title: '有些項目無法保存', next: '移除、改名或替換列出的項目後，再檢查一次。' },
  CONFIG_INVALID: {
    title: '專案設定檔（.drafttide.json）無法使用',
    next: '修正或移除這個檔案後再試；Draft Tide 不會猜測或改寫它。',
  },
  INSUFFICIENT_DISK_SPACE: { title: '磁碟空間不足', next: '這次沒有保存任何東西。清出空間後再試一次。' },
  LOCAL_ROOT_UNAVAILABLE: {
    title: '找不到專案資料夾',
    next: '資料夾可能被移動、重新命名，或在未連接的磁碟上。版本歷史就在資料夾內的 .git 裡。',
  },
  RECOVERY_REQUIRED: {
    title: '上一次的操作沒有完成',
    next: '內容沒有遺失。請在專案頁的「需要恢復」區塊完成或還原它，再繼續保存或回復。請勿手動刪除 .git/index.lock。',
  },
  PLAN_STALE: {
    title: '檔案已改變，請重新檢查回復內容',
    next: '檢查之後資料夾或歷史有變動，沒有改動任何檔案。按「重新檢查」看最新的內容，再確認一次。',
  },
  UNTRACKED_FILES: {
    title: '有沒有保存在任何版本裡的檔案擋住了回復',
    next: '沒有改動任何檔案。把它們移到資料夾以外，或加入保存範圍並保存版本，再重新檢查。',
  },
  CANCELLED: { title: '已取消', next: '操作在安全的步驟停下，沒有寫入任何設計檔案。' },
  CONFIRMATION_REQUIRED: {
    title: '這個操作需要你在 Draft Tide 視窗中完成',
    next: '請在 Draft Tide 視窗中完成或拒絕這個請求。',
  },
  APPROVAL_DENIED: { title: '這個請求已被拒絕', next: '沒有做任何改動。' },
  AGENT_ACCESS_DISABLED: {
    title: 'agent 存取已關閉',
    next: '到「設定與診斷」開啟 agent 存取之後，agent 才能操作專案。',
  },
  SCOPE_CHANGED: { title: '資料夾在檢查之後有變動', next: '請重新檢查保存範圍，再確認一次。' },
  PROJECT_ALREADY_BOUND: {
    title: '這個資料夾的專案已經連接在另一個位置',
    next: '它可能是複製出來的資料夾。可以把它連接成新的專案。',
  },
  PROJECT_NOT_BOUND: { title: '找不到這個專案', next: '它可能已經不在這台電腦的專案列表中。' },
  SNAPSHOT_NOT_FOUND: { title: '找不到這個版本', next: '它不在目前的版本歷史中。' },
  GIT_FAILED: { title: 'Git 操作失敗', next: '歷史沒有被改寫。請重試；若仍發生請匯出診斷資訊。' },
  INVALID_ARGUMENT: { title: '無法處理這個要求', next: '請重新操作一次。' },
  RESOURCE_BUDGET_EXCEEDED: { title: '內容太多，無法在這裡顯示', next: '原始檔案與版本不受影響。' },
  PREVIEW_UNSUPPORTED: { title: '這個版本沒有可以預覽的畫面', next: '版本本身不受影響。' },
  PREVIEW_FAILED: { title: '無法產生預覽', next: '版本本身不受影響，可以再試一次。' },
};

// Reason-specific copy where the code alone isn't enough.
export function errorCopy(code: ErrorCode, details: Record<string, unknown>): Copy {
  const reason = typeof details['reason'] === 'string' ? details['reason'] : null;
  if (code === 'CONFIG_INVALID' && reason === 'newer-schema') {
    return { title: '這個專案由較新版本的 Draft Tide 建立', next: '請更新 Draft Tide 後再開啟。' };
  }
  if (code === 'CONFIG_INVALID' && reason === 'missing') {
    return {
      title: '專案設定檔（.drafttide.json）不見了',
      next: '它定義了保存範圍，找回之前無法保存或回復。可以在專案頁從最新版本放回它。',
    };
  }
  if (code === 'INVALID_ARGUMENT' && reason === 'settings-present') {
    return {
      title: '資料夾裡已經有專案設定檔',
      next: 'Draft Tide 不會覆寫它。按「重新檢查」看它現在的狀態。',
    };
  }
  if (code === 'PLAN_STALE' && reason === 'used') {
    return { title: '這個回復計畫已經用過了', next: '每個計畫只能套用一次。按「重新檢查」產生新的計畫。' };
  }
  if (code === 'PLAN_STALE' && reason === 'expired') {
    return { title: '回復計畫已經過期', next: '計畫只保留 30 分鐘。按「重新檢查」看最新的內容，再確認一次。' };
  }
  if (code === 'PLAN_STALE' && reason === 'history-changed') {
    return {
      title: '檢查之後，版本歷史有了新的內容',
      next: '有其他程式加入了新的版本，沒有改動任何檔案。按「重新檢查」後再確認一次。',
    };
  }
  if (code === 'PLAN_STALE' && reason === 'external-change') {
    return {
      title: '回復寫入之前，有其他程式改了檔案',
      next: '那個檔案保持原樣，沒有改動任何檔案。先停止會寫入資料夾的工具，再重新檢查。',
    };
  }
  if (code === 'RECOVERY_REQUIRED' && reason === 'branch-changed') {
    return {
      title: '資料夾已經切換到其他 branch',
      next: '在其他 Git 工具切換回原本的 branch 之後，再完成恢復。',
    };
  }
  if (code === 'UNSUPPORTED_ENTRY' && reason === 'version-not-restorable') {
    return {
      title: '這個版本含有無法寫回資料夾的項目',
      next: '例如捷徑或名稱衝突的檔案。這個版本仍在歷史中，可以比較，但無法回復。',
    };
  }
  if (code === 'INVALID_ARGUMENT' && reason === 'nothing-to-recover') {
    return { title: '這個操作已經不需要恢復', next: 'Draft Tide 已經處理好了。' };
  }
  if (code === 'INVALID_ARGUMENT' && reason === 'unknown-plan') {
    return { title: '找不到這個計畫', next: '請重新檢查一次。' };
  }
  if (code === 'LOCAL_ROOT_UNAVAILABLE' && reason === 'repo-missing') {
    return {
      title: '資料夾裡的版本歷史（.git）不見了',
      next: '歷史保存在資料夾內的 .git 中；沒有它就無法保存或查看版本。',
    };
  }
  if (code === 'LOCAL_ROOT_UNAVAILABLE' && reason === 'project-mismatch') {
    return {
      title: '這個資料夾現在屬於另一個專案',
      next: '它的 .drafttide.json 指向不同的專案，Draft Tide 不會保存到這裡。',
    };
  }
  if (code === 'GIT_FAILED' && reason === 'git-missing') {
    return { title: '找不到 Git', next: '這個 Draft Tide 沒有可用的 Git，請重新安裝 Draft Tide。' };
  }
  if (code === 'INVALID_ARGUMENT' && reason === 'folder-not-chosen') {
    return { title: '請先選擇資料夾', next: '從「開啟設計資料夾」選擇要連接的資料夾。' };
  }
  return ERROR_COPY[code] ?? { title: '發生未預期的錯誤', next: '設計檔案不受影響。請重試，若仍發生請匯出診斷資訊。' };
}

export const UNSUPPORTED_REASON_COPY: Record<RepoUnsupportedReason, Copy> = {
  'inside-another-repo': {
    title: '這個資料夾位於另一個 Git repo 之內',
    next: '選擇那個 repo 的根目錄，或把資料夾移到 repo 之外。',
  },
  'overlaps-app-data': { title: '這個資料夾與 Draft Tide 自己的資料重疊', next: '請選擇其他資料夾。' },
  'dot-git-symlink': { title: '資料夾裡的 .git 是一個捷徑', next: '請使用 .git 為一般資料夾的 repo。' },
  'linked-worktree-or-submodule': { title: '這是 Git worktree 或 submodule', next: '請改選主要的 repo 資料夾。' },
  'dot-git-special': { title: '資料夾裡的 .git 不是一般資料夾', next: '請檢查這個資料夾的 Git 設定。' },
  'foreign-owner': { title: '.git 屬於這台電腦的另一個使用者', next: '請使用你自己的資料夾。' },
  'bare-repo': { title: '這是沒有工作檔案的 bare repo', next: '請改選有設計檔案的資料夾。' },
  'unknown-repo-format': {
    title: '這個 repo 使用 Draft Tide 不認得的格式',
    next: '請用一般的 Git repo，或更新 Draft Tide。',
  },
  'sha256-object-format': { title: '這個 repo 使用 SHA-256 格式', next: '目前只支援一般（SHA-1）格式的 repo。' },
  reftable: { title: '這個 repo 使用 reftable 格式', next: '目前只支援一般格式的 repo。' },
  'partial-clone': { title: '這是 partial clone，部分內容不在這台電腦上', next: '請改用完整的 clone。' },
  'shallow-clone': { title: '這是 shallow clone，歷史不完整', next: '請改用完整的 clone。' },
  'sparse-checkout': { title: '啟用了 sparse checkout，部分檔案不在資料夾中', next: '關閉 sparse checkout 後再試。' },
  'index-flags': { title: '有檔案被 Git 標記為略過（skip-worktree / assume-unchanged）', next: '取消這些標記後再試。' },
  'gitlink-in-index': { title: '這個 repo 含有 submodule', next: '目前不支援含 submodule 的 repo。' },
  'nested-repo': { title: '資料夾裡還有另一個 Git repo', next: '把它移出資料夾，或在保存範圍外處理。' },
  'detached-head': {
    title: '目前不在任何 branch 上（detached HEAD）',
    next: '在其他 Git 工具切換回一個 branch 後再試。',
  },
  'git-lfs': { title: '這個 repo 使用 Git LFS', next: '目前不支援 LFS：保存原始內容會繞過它。' },
  'attribute-filter': {
    title: '.gitattributes 設定了會改寫檔案內容的規則',
    next: '移除這些規則（filter、ident、working-tree-encoding）後再試。',
  },
  'line-ending-normalization': {
    title: '有含 Windows 換行的檔案被設定為自動轉換換行',
    next: '調整 .gitattributes 的 text / eol 設定後再試。',
  },
};

export const BUSY_REASON_COPY: Record<RepoBusyReason, string> = {
  'merge-in-progress': '合併（merge）正在進行',
  'rebase-in-progress': 'rebase 正在進行',
  'cherry-pick-in-progress': 'cherry-pick 正在進行',
  'revert-in-progress': 'revert 正在進行',
  'sequencer-in-progress': '一連串的 Git 操作正在進行',
  'bisect-in-progress': 'bisect 正在進行',
  'unmerged-entries': '有尚未解決的合併衝突',
};

export function blockerCopy(b: RepoBlocker): Copy {
  if (b.code === 'REPO_BUSY')
    return { title: BUSY_REASON_COPY[b.reason], next: '在原本的 Git 工具完成或取消它，再試一次。' };
  return UNSUPPORTED_REASON_COPY[b.reason];
}

export const WARNING_COPY: Record<RepoWarningReason, string> = {
  'hooks-present': '這個 repo 有 Git hooks。Draft Tide 不會執行它們。',
  'dangerous-config': '這個 repo 的設定含有會執行程式或改變連線的項目。Draft Tide 不會採用它們。',
  alternates: '這個 repo 會從其他位置借用 Git 物件。',
};

export const ENTRY_KIND_COPY: Record<UnsupportedEntryKind, string> = {
  symlink: '捷徑（symbolic link）',
  special: '特殊檔案',
  'parent-not-directory': '上層資料夾是捷徑',
  'invalid-name': '名稱無法保存',
  'non-utf8-name': '名稱的編碼無法辨識',
  'path-collision': '名稱只差在大小寫或字元組合',
  unreadable: '無法讀取',
};

export const CONFIG_REASON_COPY: Record<ConfigInvalidReason, string> = {
  missing: '設定檔不見了',
  'not-regular-file': '設定檔不是一般檔案（例如捷徑或資料夾）',
  'too-large': '設定檔太大',
  'not-json': '設定檔不是有效的 JSON 或 UTF-8',
  'not-object': '設定檔的內容格式不對',
  'newer-schema': '設定檔由較新版本的 Draft Tide 建立',
  schema: '設定檔的內容不符合格式',
};

export const FOLDER_STATE_COPY: Record<Exclude<FolderState, 'available'>, Copy> = {
  missing: {
    title: '找不到專案資料夾',
    next: '資料夾可能被移動、重新命名，或在未連接的磁碟上。版本歷史在資料夾內，找到資料夾後就能繼續。',
  },
  'repo-missing': {
    title: '資料夾裡的版本歷史（.git）不見了',
    next: '歷史保存在資料夾內的 .git 中。沒有同步到遠端的專案，刪掉 .git 就失去本機歷史。',
  },
  'config-missing': {
    title: '專案設定檔（.drafttide.json）不見了',
    next: '它定義了保存範圍，找回之前無法保存或回復。可以從最新版本放回它。',
  },
  'config-invalid': { title: '專案設定檔（.drafttide.json）無法使用', next: '修正這個檔案後就能繼續保存。' },
  'project-mismatch': {
    title: '這個資料夾現在屬於另一個專案',
    next: '它的 .drafttide.json 指向不同的專案，Draft Tide 不會保存到這裡。',
  },
};

export const KIND_LABEL: Record<SnapshotKind, string> = {
  baseline: '第一版',
  manual: '手動保存',
  'agent-requested': '由 agent 請求',
  'pre-restore': '回復前保護',
  restore: '回復版本',
};

export const ORIGIN_LABEL: Record<Origin, string> = { gui: 'Draft Tide 視窗', cli: 'CLI', mcp: 'MCP' };

export const SAVE_STAGE_LABEL: Record<string, string> = {
  scan: '列出檔案…',
  hash: '讀取檔案…',
  stage: '準備新內容…',
  verify: '確認檔案在讀取期間沒有變動…',
  write: '寫入版本歷史…',
  publish: '完成保存…',
};

export const RESTORE_STAGE_LABEL: Record<string, string> = {
  check: '檢查資料夾…',
  protect: '保存回復前的內容…',
  apply: '寫入檔案…',
  verify: '確認寫入的內容…',
  publish: '記錄回復版本…',
};

// Recovery reports the restore's last three stages.
export const RECOVERY_STAGE_LABEL: Record<string, string> = {
  apply: '寫入檔案…',
  verify: '確認寫入的內容…',
  publish: '記錄回復版本…',
};

// ---- Previews (M1 plan §8). A preview that can't be made never says
// anything about the version itself.

export const PREVIEW_UNSUPPORTED_COPY: Record<PreviewUnsupportedReason, string> = {
  'no-settings': '這個版本沒有專案設定檔（.drafttide.json），不知道要預覽哪一頁。',
  'settings-invalid': '這個版本的專案設定檔無法讀取，不知道要預覽哪一頁。',
  'no-entry': '這個版本沒有設定預覽頁面（entry）。',
  'entry-missing': '設定的預覽頁面不在這個版本裡。',
  'entry-type': '預覽頁面不是 HTML 網頁，也不是 PNG / JPEG 圖片。',
  'file-missing': '這個檔案不在這個版本裡。',
  'file-type': '只有 PNG 與 JPEG 圖片能預覽。',
  'not-a-file': '這是捷徑或子模組，無法預覽。',
  'image-invalid': '這不是 Draft Tide 能讀取的 PNG 或 JPEG 圖片。',
  'image-too-large': '圖片太大，不在這裡預覽。原始檔案不受影響。',
};

export const PREVIEW_FAILED_COPY: Record<PreviewFailedReason, string> = {
  'no-renderer': '這個 Draft Tide 沒有可用的預覽程式。',
  'queue-full': '等待預覽的工作太多。',
  timeout: '頁面在時間內沒有完成載入（例如腳本一直在執行）。',
  crashed: '預覽程式意外停止了。',
  'load-failed': '頁面無法載入。',
  'capture-failed': '頁面載入了，但沒有取得畫面。',
  'invalid-output': '預覽程式產生的圖片不正確。',
  'renderer-mismatch': '預覽程式的版本和預期不同。重新開啟 Draft Tide 後再試。',
};

export const PREVIEW_MISSING_COPY: Record<PreviewMissingReason, string> = {
  'not-in-version': '版本裡沒有這個檔案',
  'not-a-file': '不是一般檔案',
  type: '預覽不提供這種檔案',
  'too-large': '檔案太大',
  budget: '超過這次預覽的讀取上限',
  'invalid-path': '不是專案內的路徑',
};

export const PREVIEW_BLOCKED_COPY: Record<PreviewBlockedKind, string> = {
  network: '網路連線',
  navigation: '跳到其他頁面',
  popup: '開新視窗',
  permission: '要求權限',
  download: '下載',
};

// ---- Restore and recovery (M1 plan §9.2–9.4)

// Why an item is in the way of a restore: it isn't in any version, so
// writing over it would lose it.
export const COLLISION_COPY: Record<CollisionReason, string> = {
  'unsaved-file': '不在保存範圍內的檔案（被 .gitignore 或排除規則略過）',
  folder: '資料夾，裡面有沒保存的檔案；這個版本在這裡是一個檔案',
  link: '捷徑或特殊檔案，Draft Tide 不會寫入它',
  parent: '上層資料夾是上面其中一種項目',
};

export const KEPT_SETTINGS_COPY: Record<'missing' | 'invalid' | 'other-project', string> = {
  missing: '這個版本沒有專案設定檔（.drafttide.json）',
  invalid: '這個版本的專案設定檔（.drafttide.json）無法使用',
  'other-project': '這個版本的專案設定檔（.drafttide.json）屬於另一個專案',
};

export const RECOVERY_REASON_COPY: Record<RecoveryReason, Copy> = {
  interrupted: {
    title: 'Draft Tide 在操作途中停止了',
    next: '例如電腦關機或程式被結束。內容沒有遺失。',
  },
  'external-change': {
    title: '回復寫入期間，有其他程式改了檔案',
    next: '被改過的檔案會保持原樣。先停止會寫入資料夾的工具，再選擇要完成或還原。',
  },
  'history-changed': {
    title: '記錄回復版本之前，有其他程式在歷史中加入了新的內容',
    next: '什麼都沒有被覆蓋。完成回復會把回復版本接在新的內容之後。',
  },
  'not-recorded': {
    title: '檔案已經寫入，但回復版本沒有記錄下來',
    next: '完成回復會把回復版本記錄到歷史中。',
  },
  'verify-failed': {
    title: '寫入之後讀回的內容和預期不同',
    next: '可能有程式同時在寫入。先停止它，再選擇要完成或還原。',
  },
  'write-failed': {
    title: '有檔案無法寫入',
    next: '例如磁碟已滿或沒有權限。處理之後，再選擇要完成或還原。',
  },
  'index-switch': {
    title: '版本已經在歷史中，但最後一步沒有完成',
    next: '版本沒有遺失；只差把 Git 的索引切換到這個版本。',
  },
  'unknown-lock': {
    title: '.git 裡有 Draft Tide 留下的鎖，但找不到對應的操作紀錄',
    next: '它可能來自較早的 Draft Tide 或另一台電腦。確認沒有其他 Draft Tide 正在使用這個資料夾後，可以移除它。',
  },
};

export const ACTIVITY_LABEL: Record<Activity, { self: string; agent: string }> = {
  saving: { self: '保存中…', agent: '正在保存…' },
  restoring: { self: '回復中…', agent: '正在回復…' },
  recovering: { self: '恢復中…', agent: '正在恢復…' },
};

// "回復中…" from this window, "CLI 正在回復…" from an agent.
export function activityText(activity: Activity, origin: Origin): string {
  const label = ACTIVITY_LABEL[activity];
  return origin === 'gui' ? label.self : `${ORIGIN_LABEL[origin]} ${label.agent}`;
}
