import type {
  BrainView,
  ChronicleView,
  GameView,
  CanalView,
  DevMetrics,
  ExplanationView,
  FieldView,
  HumanDetail,
  StructureView,
  TreeNode,
  WorldEvent,
  WorldEffect,
  WorldStats,
} from '../shared/types';
import { EntityKind, SNAPSHOT_FLOAT_STRIDE, SNAPSHOT_META_STRIDE } from '../shared/types';
import type { GodCommand, MainToWorker, WorkerToMain, WorldConfig } from '../shared/protocol';
import { SNAPSHOT_HZ_NORMAL } from '../shared/constants';
import { RemoteTransport, type MatchView, type RemoteSnapshot, type RemoteStatus } from './remote';

/** One entity, decoded from the worker's typed arrays for the renderer. */
export interface EntityView {
  id: number;
  kind: number;
  sex: number;
  stage: number;
  flags: number;
  x: number;
  y: number;
  heading: number;
  size: number;
  hue: number;
  saturation: number;
  lightness: number;
  health: number;
  action: number;
  pregnancy: number;
  mating: number;
  age: number;
  /** House affiliation in competitive mode; 0 for ordinary observatory. */
  house: number;
}

export interface SimState {
  ready: boolean;
  phase: 'genesis' | 'world';
  config: WorldConfig;
  paused: boolean;
  speed: number;
  tick: number;
  simTime: number;
  dayPhase: number;
  light: number;
  ambientTemperature: number;
  revision: number;
  entities: EntityView[];
  stats: WorldStats | null;
  events: WorldEvent[];
  effects: WorldEffect[];
  structures: StructureView[];
  fields: FieldView[];
  canals: CanalView[];
  metrics: DevMetrics;
  selectedId: number | null;
  detail: HumanDetail | null;
  brain: BrainView | null;
  explain: ExplanationView | null;
  genealogy: TreeNode[] | null;
  error: string | null;
  fps: number;
  workerLatencyMs: number;
  /** Present only when the server is running a competitive match. */
  match: MatchView | null;
  /** The game layer: calendar, era, fate, favour. Null for a remote world. */
  game: GameView | null;
  /** The chronicle as far as this client has seen it. */
  chronicle: ChronicleView[];
  /** Worn trails, one byte per tile, refreshed every few seconds. */
  trails: Uint8Array | null;
  /** The last observer command's outcome, for the tools panel. */
  lastCommand: { ok: boolean; message: string; kind: string; at: number } | null;
  /** A pair of brains for the lab's side-by-side view. */
  brainPair: { a: BrainView | null; b: BrainView | null } | null;
}

const DEFAULT_METRICS: DevMetrics = {
  tps: 0,
  fps: 0,
  tickTimeMs: 0,
  brainTimeMs: 0,
  snapshotBytes: 0,
  workerLatencyMs: 0,
  entityCount: 0,
  humanCount: 0,
  predatorCount: 0,
  plantCount: 0,
  synapseCount: 0,
};

const DEFAULT_CONFIG: WorldConfig = {
  seed: 'eden',
  initialHumans: 8,
  initialPredators: 2,
  plantDensity: 1,
};

/**
 * Thin main-thread wrapper around the simulation worker.
 *
 * Two notification channels:
 *  - `onEntities` fires on every snapshot and is consumed directly by the PixiJS
 *    renderer. It never goes through React.
 *  - `subscribe` fires at most ~10 times per second and drives the React UI.
 *
 * Keeping those separate is what stops the UI from re-rendering 18 times a
 * second while the world still animates smoothly.
 */
export class SimClient {
  private worker: Worker;
  private listeners = new Set<() => void>();
  private entityListeners = new Set<(entities: EntityView[]) => void>();

  private lastNotify = 0;
  private pendingNotify = false;
  private lastSnapshotSentAt = 0;
  private lastRevision = -1;
  private workerLatencyMs = 0;

  /**
   * Shared-observation transport.
   *
   * Null in the default local mode, where the world lives in the Web Worker on
   * this machine. When set, the world is authoritative on a server and snapshots
   * arrive over a WebSocket instead. Everything downstream is identical — the
   * remote path funnels into the same `applySnapshot` as the local one.
   */
  private remote: RemoteTransport | null = null;
  remoteStatus: RemoteStatus = 'idle';

  state: SimState = {
    ready: false,
    phase: 'genesis',
    config: DEFAULT_CONFIG,
    paused: true,
    speed: 1,
    tick: 0,
    simTime: 0,
    dayPhase: 0.2,
    light: 0.5,
    ambientTemperature: 5,
    revision: 0,
    entities: [],
    stats: null,
    events: [],
    effects: [],
    structures: [],
    fields: [],
    canals: [],
    metrics: DEFAULT_METRICS,
    selectedId: null,
    detail: null,
    brain: null,
    explain: null,
    genealogy: null,
    error: null,
    fps: 0,
    workerLatencyMs: 0,
    match: null,
    game: null,
    chronicle: [],
    trails: null,
    lastCommand: null,
    brainPair: null,
  };

  /** Listeners for game-layer moments: discoveries, chronicle entries, crises. */
  private gameListeners = new Set<(game: GameView) => void>();

  onGame = (listener: (game: GameView) => void): (() => void) => {
    this.gameListeners.add(listener);
    return () => this.gameListeners.delete(listener);
  };

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.handle(event.data);
    this.worker.onerror = (event) => {
      this.state = { ...this.state, error: event.message };
      this.notify(true);
    };
  }

  // --- subscriptions --------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SimState => this.state;

  onEntities = (listener: (entities: EntityView[]) => void): (() => void) => {
    this.entityListeners.add(listener);
    return () => this.entityListeners.delete(listener);
  };

  private notify(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastNotify < 90) {
      if (!this.pendingNotify) {
        this.pendingNotify = true;
        setTimeout(() => {
          this.pendingNotify = false;
          this.lastNotify = performance.now();
          for (const listener of this.listeners) listener();
        }, 90 - (now - this.lastNotify));
      }
      return;
    }
    this.lastNotify = now;
    for (const listener of this.listeners) listener();
  }

  private set(partial: Partial<SimState>, force = false): void {
    this.state = { ...this.state, ...partial };
    this.notify(force);
  }

  // --- commands -------------------------------------------------------------

  start(config: WorldConfig): void {
    this.set(
      { config, phase: 'world', error: null, paused: false, speed: 1, chronicle: [], game: null, lastCommand: null },
      true,
    );
    this.send({ type: 'genesis', config });
  }

  /** Leave the world and go back to the genesis screen. */
  leave(): void {
    this.send({ type: 'setSpeed', speed: 0 });
    this.set({ phase: 'genesis', selectedId: null, detail: null, brain: null, explain: null, game: null }, true);
  }

  requestChronicle(): void {
    this.send({ type: 'requestChronicle' });
  }

  requestBrainPair(a: number, b: number): void {
    this.send({ type: 'requestBrainPair', a, b });
  }

  setSpeed(speed: number): void {
    this.set({ speed, paused: speed === 0 }, true);
    this.send({ type: 'setSpeed', speed });
  }

  stepOnce(): void {
    this.send({ type: 'stepOnce' });
  }

  select(id: number | null): void {
    this.set({ selectedId: id, detail: id === null ? null : this.state.detail, brain: id === null ? null : this.state.brain, explain: id === null ? null : this.state.explain }, true);
    this.send({ type: 'select', id });
  }

  god(command: GodCommand): void {
    this.send({ type: 'god', command });
  }

  requestGenealogy(): void {
    this.send({ type: 'requestGenealogy' });
  }

  requestDetail(id: number): void {
    this.send({ type: 'requestDetail', id });
  }

  async serialize(): Promise<string> {
    return new Promise((resolve) => {
      const handler = (event: MessageEvent<WorkerToMain>): void => {
        if (event.data.type === 'serialized') {
          this.worker.removeEventListener('message', handler);
          resolve(event.data.payload);
        }
      };
      this.worker.addEventListener('message', handler);
      this.send({ type: 'serialize' });
    });
  }

  restore(payload: string): void {
    this.set({ phase: 'world', selectedId: null, detail: null, brain: null, explain: null, chronicle: [], game: null }, true);
    this.send({ type: 'restore', payload });
    // The restored world's chronicle arrives whole, not as a trickle.
    setTimeout(() => this.requestChronicle(), 200);
  }

  /** Called by the renderer once per animation frame. */
  reportFps(fps: number): void {
    this.state.fps = fps;
  }

  // --- shared observation ---------------------------------------------------

  /**
   * Attach to a server-hosted world.
   *
   * From here on the world is authoritative on the server and this client is an
   * observer: snapshots arrive over a WebSocket, and god commands are forwarded
   * rather than applied locally. The local worker stays alive but idle, so
   * `disconnectRemote` can hand control back without a page reload.
   */
  connectRemote(url: string): void {
    this.disconnectRemote();
    this.remoteStatus = 'connecting';
    this.remote = new RemoteTransport(url, {
      onOpen: () => {
        this.set({ phase: 'world', ready: true, paused: false, error: null }, true);
      },
      onWelcome: (header) => {
        this.remoteInfo = {
          seed: String(header.seed ?? ''),
          slot: Number(header.slot ?? 0),
          observers: Number(header.observers ?? 1),
        };
        this.set({ ready: true }, true);
      },
      onSnapshot: (snapshot) => {
        // The server does not send a revision; `tick` is monotonic and is all the
        // de-duplication needs. Remote worlds are never paused from the client's
        // point of view — the server owns time.
        this.applySnapshot({
          ...snapshot,
          revision: snapshot.tick,
          paused: false,
          speed: this.state.speed,
        });
      },
      onAck: (header) => {
        const outcome = String(header.outcome ?? '');
        if (outcome) this.lastCommandOutcome = outcome;
      },
      onError: (message) => {
        this.set({ error: message }, true);
      },
      onStatusChange: (status) => {
        this.remoteStatus = status;
        this.notify(true);
      },
    });
    this.remote.connect();
  }

  disconnectRemote(): void {
    this.remote?.close();
    this.remote = null;
    this.remoteStatus = 'idle';
    this.remoteInfo = null;
  }

  get isRemote(): boolean {
    return this.remote !== null;
  }

  /** Last outcome reported by the server for a god command. */
  lastCommandOutcome = '';

  remoteInfo: { seed: string; slot: number; observers: number } | null = null;

  /**
   * Apply one snapshot, from either transport.
   *
   * This is the single place entity decoding and state publication happen, which
   * is what guarantees that local and shared worlds look and behave identically
   * in the UI. Two copies of this would drift within a week.
   */
  private applySnapshot(snapshot: {
    tick: number;
    simTime: number;
    dayPhase: number;
    light: number;
    ambientTemperature: number;
    revision: number;
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
    game?: GameView | null;
    trails?: Uint8Array | null;
    paused: boolean;
    speed: number;
    metrics: DevMetrics;
  }): void {
    if (snapshot.game) {
      const fresh = snapshot.game.chronicle;
      if (fresh.length > 0) {
        const known = this.state.chronicle;
        const lastId = known.length > 0 ? known[known.length - 1].id : 0;
        const added = fresh.filter((entry) => entry.id > lastId);
        if (added.length > 0) this.state.chronicle = [...known, ...added].slice(-600);
      }
      for (const listener of this.gameListeners) listener(snapshot.game);
    }
    if (snapshot.trails) this.state.trails = snapshot.trails;
    if (snapshot.revision !== this.lastRevision) {
      this.lastRevision = snapshot.revision;
      const entities = decodeEntities(snapshot.ids, snapshot.floats, snapshot.meta, snapshot.count);
      for (const listener of this.entityListeners) listener(entities);
      this.state.entities = entities;
    }

    this.set({
      tick: snapshot.tick,
      simTime: snapshot.simTime,
      dayPhase: snapshot.dayPhase,
      light: snapshot.light,
      ambientTemperature: snapshot.ambientTemperature,
      revision: snapshot.revision,
      stats: snapshot.stats,
      events: snapshot.events,
      effects: snapshot.effects,
      structures: snapshot.structures,
      fields: snapshot.fields,
      canals: snapshot.canals,
      game: snapshot.game ?? this.state.game,
      paused: snapshot.paused,
      speed: snapshot.speed,
      metrics: {
        ...snapshot.metrics,
        fps: this.state.fps,
        workerLatencyMs: this.workerLatencyMs,
      },
    });
  }

  private send(message: MainToWorker): void {
    // In shared mode the world is not here, so commands go to the server. Only
    // god commands and the observer's selection matter remotely; playback
    // controls are meaningless when the server owns time.
    if (this.remote) {
      if (message.type === 'god') this.remote.send(message.command);
      return;
    }
    this.lastSnapshotSentAt = performance.now();
    this.worker.postMessage(message);
  }

  // --- inbound --------------------------------------------------------------

  private handle(message: WorkerToMain): void {
    switch (message.type) {
      case 'ready':
        this.set({ ready: true }, true);
        break;

      case 'snapshot': {
        const latency = performance.now() - this.lastSnapshotSentAt;
        this.workerLatencyMs = this.workerLatencyMs * 0.8 + latency * 0.2;
        this.applySnapshot({
          tick: message.tick,
          simTime: message.simTime,
          dayPhase: message.dayPhase,
          light: message.light,
          ambientTemperature: message.ambientTemperature,
          revision: message.revision,
          count: message.count,
          ids: message.ids,
          floats: message.floats,
          meta: message.meta,
          stats: message.stats,
          events: message.events,
          effects: message.effects,
          structures: message.structures,
          fields: message.fields,
          canals: message.canals,
          game: message.game,
          trails: message.trails,
          paused: message.paused,
          speed: message.speed,
          metrics: message.metrics,
        });
        break;
      }

      case 'godResult':
        this.set({ lastCommand: { ok: message.ok, message: message.message, kind: message.kind, at: performance.now() } }, true);
        break;

      case 'chronicle':
        this.set({ chronicle: message.entries }, true);
        break;

      case 'brainPair':
        this.set({ brainPair: { a: message.a, b: message.b } });
        break;

      case 'detail':
        if (message.id === this.state.selectedId) this.set({ detail: message.detail });
        break;

      case 'brain':
        if (message.id === this.state.selectedId) this.set({ brain: message.brain });
        break;

      case 'explain':
        if (message.id === this.state.selectedId) this.set({ explain: message.explain });
        break;

      case 'genealogy':
        this.set({ genealogy: message.forest }, true);
        break;

      case 'restored':
        this.set({ error: message.ok ? null : (message.message ?? 'Restore failed') }, true);
        break;

      case 'error':
        this.set({ error: message.message }, true);
        break;

      default:
        break;
    }
  }

  dispose(): void {
    this.worker.terminate();
  }
}

function decodeEntities(
  ids: Int32Array,
  floats: Float32Array,
  meta: Uint8Array,
  count: number,
): EntityView[] {
  const out: EntityView[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const f = i * SNAPSHOT_FLOAT_STRIDE;
    const m = i * SNAPSHOT_META_STRIDE;
    out[i] = {
      id: ids[i],
      kind: meta[m],
      sex: meta[m + 1],
      stage: meta[m + 2],
      flags: meta[m + 3],
      x: floats[f],
      y: floats[f + 1],
      heading: floats[f + 2],
      size: floats[f + 3],
      hue: floats[f + 4],
      saturation: floats[f + 5],
      lightness: floats[f + 6],
      health: floats[f + 7],
      action: floats[f + 8],
      pregnancy: floats[f + 9],
      mating: floats[f + 10],
      age: floats[f + 11],
      house: meta[m + 4],
    };
  }
  return out;
}

export const KIND_HUMAN = EntityKind.Human;
export const KIND_PREDATOR = EntityKind.Predator;
export const KIND_PLANT = EntityKind.Plant;
export const SNAPSHOT_HZ = SNAPSHOT_HZ_NORMAL;
