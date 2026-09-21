import type {
  BrainView,
  DevMetrics,
  ExplanationView,
  HumanDetail,
  TreeNode,
  WorldEvent,
  WorldEffect,
  WorldStats,
} from '../shared/types';
import { EntityKind, SNAPSHOT_FLOAT_STRIDE, SNAPSHOT_META_STRIDE } from '../shared/types';
import type { GodCommand, MainToWorker, WorkerToMain, WorldConfig } from '../shared/protocol';
import { SNAPSHOT_HZ_NORMAL } from '../shared/constants';

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
  metrics: DevMetrics;
  selectedId: number | null;
  detail: HumanDetail | null;
  brain: BrainView | null;
  explain: ExplanationView | null;
  genealogy: TreeNode[] | null;
  error: string | null;
  fps: number;
  workerLatencyMs: number;
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
    metrics: DEFAULT_METRICS,
    selectedId: null,
    detail: null,
    brain: null,
    explain: null,
    genealogy: null,
    error: null,
    fps: 0,
    workerLatencyMs: 0,
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
    this.set({ config, phase: 'world', error: null, paused: false, speed: 1 }, true);
    this.send({ type: 'genesis', config });
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
    this.set({ phase: 'world', selectedId: null, detail: null, brain: null, explain: null }, true);
    this.send({ type: 'restore', payload });
  }

  /** Called by the renderer once per animation frame. */
  reportFps(fps: number): void {
    this.state.fps = fps;
  }

  private send(message: MainToWorker): void {
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

        if (message.revision !== this.lastRevision) {
          this.lastRevision = message.revision;
          const entities = decodeEntities(message.ids, message.floats, message.meta, message.count);
          for (const listener of this.entityListeners) listener(entities);
          this.state.entities = entities;
        }

        this.set({
          tick: message.tick,
          simTime: message.simTime,
          dayPhase: message.dayPhase,
          light: message.light,
          ambientTemperature: message.ambientTemperature,
          revision: message.revision,
          stats: message.stats,
          events: message.events,
          effects: message.effects,
          paused: message.paused,
          speed: message.speed,
          metrics: {
            ...message.metrics,
            fps: this.state.fps,
            workerLatencyMs: this.workerLatencyMs,
          },
        });
        break;
      }

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
    };
  }
  return out;
}

export const KIND_HUMAN = EntityKind.Human;
export const KIND_PREDATOR = EntityKind.Predator;
export const KIND_PLANT = EntityKind.Plant;
export const SNAPSHOT_HZ = SNAPSHOT_HZ_NORMAL;
