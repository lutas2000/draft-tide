import { z } from 'zod';

// Operation states (M1 plan §9.3, TECH_STACK §6.4):
//
//   planned → confirmed → preflight → protected → staged
//           → applying → verified → publishing → committed → completed
//                         └→ recovery-required
//
// Saves have no `applying` stage. `publishing` is the lock-first switch of ref
// and index (§9.3.1). The terminal failure states end operations that stopped
// before changing anything (failed, cancelled) or that recovery found someone
// else had built on (superseded). The transition rules arrive with the journal
// (M1-05).
export const OPERATION_STATES = [
  'planned',
  'confirmed',
  'preflight',
  'protected',
  'staged',
  'applying',
  'verified',
  'publishing',
  'committed',
  'completed',
  'recovery-required',
  'failed',
  'cancelled',
  'superseded',
] as const;
export const OperationState = z.enum(OPERATION_STATES);
export type OperationState = z.infer<typeof OperationState>;

export const TERMINAL_OPERATION_STATES: ReadonlySet<OperationState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'superseded',
]);
