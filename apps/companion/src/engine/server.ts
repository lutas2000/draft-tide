import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import {
  ClientMessage,
  DtError,
  PROTOCOL_VERSION,
  isToolChannel,
  toErrorInfo,
  type Channel,
  type EngineEvent,
  type EngineInstanceId,
  type RequestMessage,
} from '@draft-tide/contracts';
import type { EngineCore, EventSink } from '@draft-tide/core';
import { FrameDecoder, encodeFrame } from '@draft-tide/engine-client';
import type { PeerInstance, PeerVerifier } from './peer-identity.ts';

const CHALLENGE_TIMEOUT_MS = 2_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_IN_FLIGHT_PER_SESSION = 32;

export interface ServerOptions {
  core: Pick<EngineCore, 'handle' | 'operationsFor'>;
  verifier: PeerVerifier;
  instanceId: EngineInstanceId;
  toolToken: string;
  log: (msg: string) => void;
  onActivity: () => void;
}

export interface EngineServer extends EventSink {
  readonly server: Server;
  sessionCount(): number;
  // Desktop sessions past the handshake: the app is open on this data store.
  desktopSessionCount(): number;
  inFlight(): number;
}

type SessionState =
  | { kind: 'hello' }
  | { kind: 'challenge'; nonce: string; t0: PeerInstance | null; timer: NodeJS.Timeout }
  | { kind: 'ready'; channel: Channel; t0: PeerInstance | null }
  | { kind: 'closed' };

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createEngineServer(options: ServerOptions): EngineServer {
  const { core, verifier, instanceId, toolToken, log, onActivity } = options;
  const desktopSessions = new Set<(frame: Buffer) => void>();
  let sessions = 0;
  let inFlight = 0;
  let seq = 0;

  const server = createServer((socket) => {
    sessions++;
    onActivity();
    const decoder = new FrameDecoder();
    let state: SessionState = { kind: 'hello' };
    let sessionInFlight = 0;
    const send = (message: unknown) => {
      if (state.kind !== 'closed' && !socket.destroyed) socket.write(encodeFrame(message));
    };
    const pushEvent = (frame: Buffer) => {
      if (!socket.destroyed) socket.write(frame);
    };
    const reject = (err: DtError) => {
      send({ type: 'rejected', error: err.toInfo() });
      close();
    };
    const close = () => {
      if (state.kind === 'challenge') clearTimeout(state.timer);
      state = { kind: 'closed' };
      desktopSessions.delete(pushEvent);
      socket.end();
      socket.destroySoon();
    };
    const helloTimer = setTimeout(() => {
      if (state.kind === 'hello') reject(new DtError('UNAUTHENTICATED', 'no hello received'));
    }, HELLO_TIMEOUT_MS);

    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (state.kind === 'challenge') clearTimeout(state.timer);
      state = { kind: 'closed' };
      desktopSessions.delete(pushEvent);
      sessions--;
      onActivity();
    });

    const welcome = (channel: Channel, t0: PeerInstance | null) => {
      state = { kind: 'ready', channel, t0 };
      if (channel === 'desktop') desktopSessions.add(pushEvent);
      send({
        type: 'welcome',
        instanceId,
        protocolVersion: PROTOCOL_VERSION,
        channel,
        operations: core.operationsFor(channel),
      });
    };

    const onMessage = (raw: unknown) => {
      if (state.kind === 'closed') return;
      onActivity();
      const parsed = ClientMessage.safeParse(raw);
      if (!parsed.success) return reject(new DtError('PROTOCOL_MISMATCH', 'malformed message'));
      const msg = parsed.data;

      if (state.kind === 'hello') {
        if (msg.type !== 'hello') return reject(new DtError('UNAUTHENTICATED', 'hello required'));
        clearTimeout(helloTimer);
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          return reject(
            new DtError('PROTOCOL_MISMATCH', 'this Draft Tide component needs a different version; update the app', {
              engineProtocolVersion: PROTOCOL_VERSION,
              clientProtocolVersion: msg.protocolVersion,
            }),
          );
        }
        if (isToolChannel(msg.channel)) {
          if (msg.toolToken === undefined || !sameSecret(msg.toolToken, toolToken)) {
            return reject(new DtError('UNAUTHENTICATED', 'engine handshake failed'));
          }
          return welcome(msg.channel, null);
        }
        const pinned = verifier.pin(socket);
        if (!pinned.ok) {
          log(`desktop handshake refused: ${pinned.reason}`);
          return reject(new DtError('UNAUTHENTICATED', 'the desktop app could not be verified'));
        }
        const nonce = randomBytes(32).toString('hex');
        const timer = setTimeout(
          () => reject(new DtError('UNAUTHENTICATED', 'no answer to the challenge')),
          CHALLENGE_TIMEOUT_MS,
        );
        state = { kind: 'challenge', nonce, t0: pinned.instance, timer };
        return send({ type: 'challenge', nonce });
      }

      if (state.kind === 'challenge') {
        clearTimeout(state.timer);
        // The echo must come from the instance pinned at hello: a request
        // followed by an exec into the real app, or a forked helper answering,
        // fails here (desktop-auth spike A7–A10).
        if (
          msg.type !== 'challenge-response' ||
          !sameSecret(msg.nonce, state.nonce) ||
          !verifier.sameInstance(socket, state.t0)
        ) {
          log('desktop handshake refused: challenge answered wrongly or by another process');
          return reject(new DtError('UNAUTHENTICATED', 'the desktop app could not be verified'));
        }
        return welcome('desktop', state.t0);
      }

      if (msg.type !== 'request')
        return reject(new DtError('PROTOCOL_MISMATCH', 'only requests are accepted after the handshake'));
      // Every desktop message is re-checked against the pinned instance.
      if (state.channel === 'desktop' && !verifier.sameInstance(socket, state.t0)) {
        log('desktop session closed: the peer is no longer the pinned process');
        return reject(new DtError('UNAUTHENTICATED', 'the desktop session changed hands'));
      }
      handleRequest(state.channel, msg);
    };

    const handleRequest = (channel: Channel, msg: RequestMessage) => {
      if (sessionInFlight >= MAX_IN_FLIGHT_PER_SESSION) {
        const err = new DtError('RESOURCE_BUDGET_EXCEEDED', 'too many requests in flight on this connection', {
          budget: 'in-flight-requests',
        });
        return send({ type: 'response', requestId: msg.requestId, ok: false, error: err.toInfo() });
      }
      sessionInFlight++;
      inFlight++;
      const fail = (e: unknown) => {
        const info = toErrorInfo(e);
        if (info.code === 'INTERNAL_ERROR') log(`internal error in ${msg.op.slice(0, 64)}: ${info.message}`);
        send({ type: 'response', requestId: msg.requestId, ok: false, error: info });
      };
      core
        .handle(channel, msg.op, msg.payload)
        .then((data) => {
          // A result too large for one control message is reported as such,
          // never dropped (or allowed to take the Engine down).
          try {
            send({ type: 'response', requestId: msg.requestId, ok: true, data });
          } catch (e) {
            fail(e);
          }
        }, fail)
        .finally(() => {
          sessionInFlight--;
          inFlight--;
          onActivity();
        });
    };

    socket.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        return reject(new DtError('PROTOCOL_MISMATCH', 'malformed frame'));
      }
      for (const m of messages) onMessage(m);
    });
  });

  return {
    server,
    publish(event: EngineEvent) {
      seq++;
      const frame = encodeFrame({ type: 'event', seq, event });
      for (const push of desktopSessions) push(frame);
    },
    sessionCount: () => sessions,
    desktopSessionCount: () => desktopSessions.size,
    inFlight: () => inFlight,
  };
}
