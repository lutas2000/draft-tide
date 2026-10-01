import {
  DtError,
  type DesktopOperationName,
  type ErrorInfo,
  type OperationInput,
  type OperationOutput,
} from '@draft-tide/contracts';
import type { DraftTideBridge } from '../../shared/bridge.ts';

declare global {
  interface Window {
    draftTide?: DraftTideBridge;
  }
}

// Present only inside the desktop app. A plain browser (for example the Vite
// dev server opened directly) has no Engine and says so.
export function bridge(): DraftTideBridge | null {
  return window.draftTide ?? null;
}

export class EngineCallError extends DtError {
  constructor(info: ErrorInfo) {
    super(info.code, info.message, info.details, info.retryable);
  }
}

export async function engineCall<N extends DesktopOperationName>(
  op: N,
  input: OperationInput<N>,
): Promise<OperationOutput<N>> {
  const b = bridge();
  if (!b) throw new DtError('ENGINE_UNAVAILABLE', 'not running inside the Draft Tide app');
  const envelope = await b.invoke(op, input);
  if (!envelope.ok || envelope.error) {
    throw new EngineCallError(
      envelope.error ?? { code: 'INTERNAL_ERROR', message: 'empty error envelope', details: {}, retryable: false },
    );
  }
  return envelope.data as OperationOutput<N>;
}

// The native folder picker; null when cancelled or outside the app.
export async function chooseFolder(): Promise<string | null> {
  return (await bridge()?.chooseFolder()) ?? null;
}
