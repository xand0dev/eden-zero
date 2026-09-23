/**
 * WebSocket transport for shared-observation mode.
 *
 * The counterpart to the local Web Worker transport. The world is authoritative
 * on the server; this class connects, decodes frames, and hands snapshots back to
 * `SimClient`, which applies them through exactly the same path it uses for local
 * snapshots. Everything above this file is unaware of which mode is running.
 *
 * RECONNECTION
 * ------------
 * A dropped connection is normal — laptops sleep, Wi-Fi flaps. The transport
 * retries with exponential backoff and reports its state so the UI can show
 * "reconnecting" instead of silently freezing on a stale world.
 */
import { WireType, decodeFrame, viewOf } from '../shared/wire';
import type { GodCommand } from '../shared/protocol';
import type {
  CanalView,
  DevMetrics,
  FieldView,
  HouseStats,
  StructureView,
  WorldEffect,
  WorldEvent,
  WorldStats,
} from '../shared/types';

export interface RemoteSnapshot {
  tick: number;
  simTime: number;
  dayPhase: number;
  light: number;
  ambientTemperature: number;
  count: number;
  ids: Int32Array;
  floats: Float32Array;
  meta: Uint8Array;
  stats: WorldStats;
  events: WorldEvent[];
  effects: WorldEffect[];
  structures: StructureView[];
  fields: FieldView[];
  canals: CanalView[];
  metrics: DevMetrics;
  /** Present only when the server is running a competitive match. */
  match: MatchView | null;
}

export interface MatchView {
  houses: HouseStats[];
  elapsedSeconds: number;
  durationSeconds: number;
  active: boolean;
  ended: boolean;
  winner: number | null;
}

export interface RemoteHandlers {
  onOpen(): void;
  onSnapshot(snapshot: RemoteSnapshot): void;
  onWelcome(header: Record<string, unknown>): void;
  onAck(header: Record<string, unknown>): void;
  onError(message: string): void;
  onStatusChange(status: RemoteStatus): void;
}

export type RemoteStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 8000;

export class RemoteTransport {
  private socket: WebSocket | null = null;
  private status: RemoteStatus = 'idle';
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the caller asked for a deliberate close, so we stop retrying. */
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: RemoteHandlers,
  ) {}

  getStatus(): RemoteStatus {
    return this.status;
  }

  connect(): void {
    this.disposed = false;
    this.open();
  }

  close(): void {
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setStatus('closed');
    this.socket?.close();
    this.socket = null;
  }

  send(command: GodCommand): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    // Commands are small and infrequent; JSON keeps them readable in the network
    // panel. The high-volume direction is the binary snapshot stream.
    this.socket.send(JSON.stringify({ type: 'command', command }));
  }

  private open(): void {
    this.setStatus(this.retries === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.retries = 0;
      this.setStatus('open');
      this.handlers.onOpen();
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') return;
      this.receive(new Uint8Array(event.data));
    };

    socket.onerror = () => {
      this.handlers.onError(`could not reach ${this.url}`);
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.disposed) return;
      this.setStatus('reconnecting');
      const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** this.retries);
      this.retries += 1;
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  private receive(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    if (!frame) {
      this.handlers.onError('malformed frame from server');
      return;
    }

    switch (frame.type) {
      case WireType.Welcome:
        this.handlers.onWelcome(frame.header);
        return;

      case WireType.Ack:
        this.handlers.onAck(frame.header);
        return;

      case WireType.Error:
        this.handlers.onError(String(frame.header.message ?? 'server error'));
        return;

      case WireType.Snapshot:
        this.handlers.onSnapshot(decodeSnapshot(frame.header, frame.payload));
        return;

      default:
        return;
    }
  }

  private setStatus(status: RemoteStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatusChange(status);
  }
}

/**
 * Rebuild a snapshot from its header and payload.
 *
 * The payload is one flat byte range holding the three typed arrays back to back,
 * in the order the server wrote them. Their lengths come from the header, so the
 * client never has to guess a stride.
 */
function decodeSnapshot(header: Record<string, unknown>, payload: Uint8Array): RemoteSnapshot {
  const count = Number(header.count ?? 0);
  const idBytes = count * 4;
  const floatBytes = count * Number(header.floatStride ?? 12) * 4;
  const metaBytes = count * Number(header.metaStride ?? 4);

  return {
    tick: Number(header.tick ?? 0),
    simTime: Number(header.simTime ?? 0),
    dayPhase: Number(header.dayPhase ?? 0),
    light: Number(header.light ?? 0),
    ambientTemperature: Number(header.ambientTemperature ?? 0),
    count,
    ids: viewOf(payload, 0, idBytes, 'i32') as Int32Array,
    floats: viewOf(payload, idBytes, floatBytes, 'f32') as Float32Array,
    meta: viewOf(payload, idBytes + floatBytes, metaBytes, 'u8') as Uint8Array,
    stats: header.stats as WorldStats,
    events: (header.events as WorldEvent[]) ?? [],
    effects: (header.effects as WorldEffect[]) ?? [],
    structures: (header.structures as StructureView[]) ?? [],
    fields: (header.fields as FieldView[]) ?? [],
    canals: (header.canals as CanalView[]) ?? [],
    metrics: (header.metrics as DevMetrics) ?? ({} as DevMetrics),
    match: (header.match as MatchView | undefined) ?? null,
  };
}
