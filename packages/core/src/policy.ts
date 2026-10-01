import {
  DtError,
  isOperationName,
  isToolChannel,
  operationSpec,
  type Channel,
  type OperationName,
} from '@draft-tide/contracts';

// Who may call what (M1 plan §9.1). Checked before the input is even parsed.
//
// - An operation not offered on the caller's channel is UNKNOWN_OPERATION, so
//   the tool channel cannot reach desktop-only operations whatever it sends.
// - With agent access off, the tool channel gets engine.info and nothing else
//   (AGENT_ACCESS_DISABLED). With it on, everything the catalog offers it.
// - Nothing in the payload (confirmed: true, --force, a plan id) is consulted.
export function authorize(op: string, channel: Channel, agentAccessEnabled: boolean): OperationName {
  if (!isOperationName(op)) {
    throw new DtError('UNKNOWN_OPERATION', `unknown operation: ${op.slice(0, 64)}`);
  }
  const spec = operationSpec(op);
  if (!isToolChannel(channel)) {
    if (!spec.desktop) throw new DtError('UNKNOWN_OPERATION', `${op} is not available in the app`);
    return op;
  }
  if (spec.tool === 'none') {
    throw new DtError('UNKNOWN_OPERATION', `${op} is not available to the CLI or MCP`);
  }
  if (spec.tool === 'agent-access' && !agentAccessEnabled) {
    throw new DtError(
      'AGENT_ACCESS_DISABLED',
      'Agent access is off. Ask the user to turn it on in the Draft Tide app (Settings).',
    );
  }
  return op;
}
