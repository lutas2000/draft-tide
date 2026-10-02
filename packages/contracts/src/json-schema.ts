import type { z } from 'zod';
import { OPERATIONS, type OperationName } from './catalog.ts';
import { AgentAccess, EngineInfo, ProjectSummary } from './engine.ts';
import { envelopeSchema } from './envelope.ts';
import { ErrorInfo, JsonValue } from './errors.ts';
import { FileDiff, HistoryEntry, SavedSnapshot, SnapshotDiff } from './history.ts';
import { OperationList, OperationStatus } from './operation.ts';
import { PreviewArtifact, PreviewStatus } from './preview.ts';
import { FolderReview, ProjectStatus } from './project.ts';
import { ProjectConfig } from './project-config.ts';
import { ClientMessage, Discovery, EngineMessage } from './protocol.ts';
import { RecoveryPlan, RecoveryReport, RestorePlan, RestoreProgress, RestoreResult } from './restore.ts';
import { CaptureProgress, RepoBlocker, RepoWarning, UnsupportedEntry } from './scope.ts';
import { CommitIdentity, SaveProgress, SnapshotMetadata } from './snapshot.ts';

// Every schema published as JSON Schema, by file name. Each operation exports
// its input and its result envelope.
export function publicSchemas(): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {
    'project-config': ProjectConfig,
    'snapshot-metadata': SnapshotMetadata,
    'agent-access': AgentAccess,
    'project-summary': ProjectSummary,
    'engine-info': EngineInfo,
    'error-info': ErrorInfo,
    envelope: envelopeSchema(JsonValue),
    'protocol-client-message': ClientMessage,
    'protocol-engine-message': EngineMessage,
    'protocol-discovery': Discovery,
    'repo-blocker': RepoBlocker,
    'repo-warning': RepoWarning,
    'unsupported-entry': UnsupportedEntry,
    'capture-progress': CaptureProgress,
    'save-progress': SaveProgress,
    'commit-identity': CommitIdentity,
    'folder-review': FolderReview,
    'project-status': ProjectStatus,
    'history-entry': HistoryEntry,
    'saved-snapshot': SavedSnapshot,
    'snapshot-diff': SnapshotDiff,
    'file-diff': FileDiff,
    'restore-plan': RestorePlan,
    'restore-result': RestoreResult,
    'restore-progress': RestoreProgress,
    'recovery-report': RecoveryReport,
    'recovery-plan': RecoveryPlan,
    'operation-status': OperationStatus,
    'operation-list': OperationList,
    'preview-artifact': PreviewArtifact,
    'preview-status': PreviewStatus,
  };
  for (const name of Object.keys(OPERATIONS) as OperationName[]) {
    const spec = OPERATIONS[name];
    out[`op.${name}.input`] = spec.input;
    out[`op.${name}.result`] = envelopeSchema(spec.output);
  }
  return out;
}
