import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  DtError,
  EngineMessage,
  type Channel,
  type EngineEvent,
  type EngineInstanceId,
  type Hello,
  type OperationInput,
  type OperationName,
  type OperationOutput,
  type RequestId,
} from '@draft-tide/contracts';
import { FrameDecoder, encodeFrame } from './framing.ts';

export interface EventInfo {
  seq: number;
  // A sequence number was skipped: the listener must re-read state, since an
  // event alone never says whether data is complete.
  gap: boolean;
}

type Pending = { resolve: (data: unknown) => void; reject: (err: DtError) => void };

const HANDSHAKE_TIMEOUT_MS = 5_000;

// One authenticated session with the Engine.
export class EngineConnection {
  readonly instanceId: EngineInstanceId;
  readonly channel: Channel;
  readonly operations: readonly string[];
  readonly #socket: Socket;
  readonly #pending = new Map<string, Pending>();
  readonly #eventListeners = new Set<(event: EngineEvent, info: EventInfo) => void>();
  readonly #closeListeners = new Set<() => void>();
  #lastSeq = 0;
  #closed = false;

  private constructor(
    socket: Socket,
    welcome: { instanceId: EngineInstanceId; channel: Channel; operations: string[] },
  ) {
    this.#socket = socket;
    this.instanceId = welcome.instanceId;
    this.channel = welcome.channel;
    this.operations = welcome.operations;
  }

  // Connects and completes the handshake. The desktop channel answers the
  // Engine's nonce from this same process; the tool channel sends its token.
  static open(socketPath: string, hello: Hello, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<EngineConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const decoder = new FrameDecoder();
      let conn: EngineConnection | null = null;
      let settled = false;
      const fail = (err: DtError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(unavailable('the Engine did not answer the handshake')), timeoutMs);

      socket.once('connect', () => socket.write(encodeFrame(hello)));
      socket.on('error', (e: NodeJS.ErrnoException) => {
        if (!conn) fail(unavailable(`cannot reach the Engine (${e.code ?? e.message})`));
      });
      socket.on('close', () => {
        if (conn) conn.#handleClose();
        else fail(unavailable('the Engine closed the connection during the handshake'));
      });
      socket.on('data', (chunk: Buffer) => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const raw of messages) {
          if (conn) {
            conn.#dispatch(raw);
            continue;
          }
          const parsed = EngineMessage.safeParse(raw);
          if (!parsed.success)
            return fail(new DtError('PROTOCOL_MISMATCH', 'unexpected handshake message from the Engine'));
          const msg = parsed.data;
          if (msg.type === 'challenge') {
            socket.write(encodeFrame({ type: 'challenge-response', nonce: msg.nonce }));
          } else if (msg.type === 'welcome') {
            settled = true;
            clearTimeout(timer);
            conn = new EngineConnection(socket, msg);
            resolve(conn);
          } else if (msg.type === 'rejected') {
            return fail(DtError.fromInfo(msg.error));
          } else {
            return fail(new DtError('PROTOCOL_MISMATCH', 'unexpected handshake message from the Engine'));
          }
        }
      });
    });
  }

  call<N extends OperationName>(op: N, payload: OperationInput<N>): Promise<OperationOutput<N>> {
    return this.callRaw(op, payload) as Promise<OperationOutput<N>>;
  }

  // Untyped form for clients that forward operations by name (MCP, CLI).
  callRaw(op: string, payload: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(unavailable('the Engine connection is closed'));
    const requestId = randomUUID() as RequestId;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#socket.write(encodeFrame({ type: 'request', requestId, op, payload: payload ?? {} }));
      } catch (e) {
        this.#pending.delete(requestId);
        reject(e instanceof DtError ? e : unavailable('cannot send to the Engine'));
      }
    });
  }

  onEvent(listener: (event: EngineEvent, info: EventInfo) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.#closed) queueMicrotask(listener);
    else this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#socket.end();
  }

  #dispatch(raw: unknown): void {
    const parsed = EngineMessage.safeParse(raw);
    if (!parsed.success) {
      this.#socket.destroy();
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'response') {
      const pending = this.#pending.get(msg.requestId);
      if (!pending) return;
      this.#pending.delete(msg.requestId);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(DtError.fromInfo(msg.error));
    } else if (msg.type === 'event') {
      const gap = this.#lastSeq !== 0 && msg.seq !== this.#lastSeq + 1;
      this.#lastSeq = msg.seq;
      for (const listener of this.#eventListeners) listener(msg.event, { seq: msg.seq, gap });
    } else if (msg.type === 'rejected') {
      // The Engine ended the session (for example, the peer check failed).
      this.#socket.destroy();
    }
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(unavailable('the Engine connection closed'));
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}

function unavailable(message: string): DtError {
  return new DtError('ENGINE_UNAVAILABLE', message);
}
