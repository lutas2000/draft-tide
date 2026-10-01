import type { z } from 'zod';
import { OPERATIONS, type OperationName } from './catalog.ts';
import { AgentAccess, EngineInfo, ProjectSummary } from './engine.ts';
import { envelopeSchema } from './envelope.ts';
import { ErrorInfo, JsonValue } from './errors.ts';
import { ProjectConfig } from './project-config.ts';
import { ClientMessage, Discovery, EngineMessage } from './protocol.ts';
import { SnapshotMetadata } from './snapshot.ts';

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
  };
  for (const name of Object.keys(OPERATIONS) as OperationName[]) {
    const spec = OPERATIONS[name];
    out[`op.${name}.input`] = spec.input;
    out[`op.${name}.result`] = envelopeSchema(spec.output);
  }
  return out;
}
