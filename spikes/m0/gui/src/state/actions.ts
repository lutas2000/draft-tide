import { useCallback } from 'react';
import { UNTRACKED_FILE } from '../mock/data';
import { buildFiles, nextEdit } from '../mock/designs';
import { captureSnapshot, diffFiles, sameScopeFiles, type CaptureResult, type CaptureStage } from '../mock/engine';
import type { FileEntry, Project, ProjectId, SnapshotId, Version } from '../mock/types';
import { pseudoHash, utf8Bytes } from '../lib/hash';
import { summarizeChanges } from '../components/FileChangeList';
import { useStore } from './store';

export function useProjectActions() {
  const { dispatch, getProject, toast, markStep } = useStore();

  const update = useCallback(
    (id: ProjectId, fn: (p: Project) => Project) => dispatch({ type: 'updateProject', id, update: fn }),
    [dispatch],
  );

  /** Facilitator tool: pretend the designer edited files in their own editor. */
  const simulateEdit = useCallback(
    (id: ProjectId) => {
      const p = getProject(id);
      const { opts, description } = nextEdit(p.workingDesign);
      const files = buildFiles(opts);
      const changes = diffFiles(p.working, files);
      update(id, (x) => ({ ...x, working: files, workingDesign: opts }));
      toast({ tone: 'info', title: '（原型）已模擬在編輯器修改檔案', body: `${description}｜${summarizeChanges(changes)}` });
    },
    [getProject, update, toast],
  );

  /** Facilitator tool: an external tool touches styles.css after a plan was made (PLAN_STALE). */
  const externalTouch = useCallback(
    (id: ProjectId) => {
      const touch = (f: FileEntry): FileEntry => {
        if (f.path !== 'styles.css' || f.text === undefined) return f;
        let text = f.text.includes('--radius: 18px;')
          ? f.text.replace('--radius: 18px;', '--radius: 22px;')
          : f.text.replace('--radius: 22px;', '--radius: 18px;');
        if (text === f.text) text = `${f.text}/* 外部工具修改 */\n`;
        return { ...f, text, size: utf8Bytes(text), hash: pseudoHash(`blob:${text}`) };
      };
      update(id, (x) => ({ ...x, working: x.working.map(touch) }));
    },
    [update],
  );

  const addUntracked = useCallback(
    (id: ProjectId) => update(id, (x) => ({ ...x, working: sameScopeFiles(x.working, UNTRACKED_FILE) })),
    [update],
  );

  const removeUntracked = useCallback(
    (id: ProjectId, paths: string[]) => update(id, (x) => ({ ...x, working: x.working.filter((f) => !paths.includes(f.path)) })),
    [update],
  );

  const markPreviewReady = useCallback(
    (id: ProjectId, snapshotIds: SnapshotId[]) => {
      // Previews are produced after the save and never block it.
      window.setTimeout(() => {
        update(id, (x) => ({
          ...x,
          versions: x.versions.map((v) => (snapshotIds.includes(v.meta.snapshotId) ? { ...v, previewStatus: 'ready' } : v)),
        }));
      }, 1100);
    },
    [update],
  );

  const appendVersions = useCallback(
    (id: ProjectId, versions: Version[], working?: Pick<Project, 'working' | 'workingDesign'>) => {
      update(id, (x) => ({ ...x, versions: [...x.versions, ...versions], ...(working ?? {}) }));
      markPreviewReady(
        id,
        versions.map((v) => v.meta.snapshotId),
      );
    },
    [update, markPreviewReady],
  );

  const saveVersion = useCallback(
    async (id: ProjectId, name: string, onStage?: (s: CaptureStage) => void): Promise<CaptureResult> => {
      const input: { name?: string; kind: 'manual'; origin: 'gui' } = { kind: 'manual', origin: 'gui' };
      if (name.trim()) input.name = name.trim();
      const result = await captureSnapshot(() => getProject(id), input, onStage);
      if (result.ok) {
        appendVersions(id, [result.version]);
        markStep(4);
      }
      return result;
    },
    [getProject, appendVersions, markStep],
  );

  return { update, simulateEdit, externalTouch, addUntracked, removeUntracked, appendVersions, saveVersion, markPreviewReady };
}
