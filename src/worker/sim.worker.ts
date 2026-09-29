/**
 * Simulation worker.
 *
 * The world lives here, on its own thread. React never runs a simulation tick.
 *
 * Timing model:
 *  - The simulation advances in *fixed* steps (see SIM_HZ / DT). Speed settings
 *    change how many fixed steps we execute per unit of wall-clock time; they
 *    never scale `dt`, which is what keeps the physics and the neural solver
 *    numerically identical at every speed.
 *  - MAX mode runs ticks in a wall-clock-budgeted burst and then yields, so the
 *    worker stays responsive to incoming messages (including "pause").
 *  - Snapshots are throttled independently of the tick rate.
 */
import { DEFAULT_WORLD_OPTIONS, World, type WorldOptions } from '../simulation/world';
import { applyGodCommandChecked } from '../simulation/commands';
import { DT, MAX_SLICE_MS, MAX_TICKS_PER_SLICE, SIM_HZ, SNAPSHOT_HZ_MAX, SNAPSHOT_HZ_NORMAL, SPEED_TICK_BUDGET } from '../shared/constants';
import type { DevMetrics } from '../shared/types';
import type { MainToWorker, WorkerToMain, WorldConfig } from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let world: World | null = null;
let speed = 1;
let paused = true;
let accumulator = 0;
let lastFrameTime = 0;
let revision = 0;
let selectedId: number | null = null;
let lastSnapshotTime = 0;
let lastDetailTime = 0;
/** Last chronicle entry the main thread has been sent. */
let chronicleSent = 0;

// --- metrics ---------------------------------------------------------------
let tickTimeMs = 0;
let brainTimeMs = 0;
let measuredTps = 0;
let snapshotBytes = 0;
let lastTpsSampleTime = 0;
let ticksSinceSample = 0;

const TPS_SMOOTHING = 0.15;

function post(message: WorkerToMain, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer ?? []);
}

function configToOptions(config: WorldConfig): WorldOptions {
  return {
    ...DEFAULT_WORLD_OPTIONS,
    seed: config.seed,
    initialHumans: config.initialHumans,
    initialPredators: config.initialPredators,
    plantDensity: config.plantDensity,
    mode: config.mode,
    charter: config.charter,
    biome: config.biome,
    founderGenomes: config.founderGenomes,
    challengeId: config.challengeId,
  };
}

function genesis(config: WorldConfig): void {
  world = new World(configToOptions(config));
  chronicleSent = 0;
  accumulator = 0;
  lastFrameTime = performance.now();
  lastTpsSampleTime = lastFrameTime;
  ticksSinceSample = 0;
  measuredTps = 0;
  selectedId = null;
  // A freshly created world starts running at x1 — the observer should see life
  // immediately rather than an apparently frozen world.
  paused = false;
  speed = 1;
  post({ type: 'ready' });
  sendSnapshot(true);
  scheduleFrame();
}

// --- the loop --------------------------------------------------------------

let scheduled = false;

function scheduleFrame(): void {
  if (scheduled) return;
  scheduled = true;
  // setTimeout(0) yields to the message queue between slices, which is what
  // keeps "pause" responsive while MAX mode is running.
  setTimeout(frame, 0);
}

function frame(): void {
  scheduled = false;
  if (!world) return;

  const now = performance.now();
  const elapsed = Math.min(0.25, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (!paused && speed !== 0) {
    const start = performance.now();
    const ticks = runTicks(elapsed);
    const elapsedMs = performance.now() - start;
    tickTimeMs = tickTimeMs * (1 - TPS_SMOOTHING) + (elapsedMs / Math.max(1, ticks)) * TPS_SMOOTHING;
    ticksSinceSample += ticks;

    const sampleElapsed = (now - lastTpsSampleTime) / 1000;
    if (sampleElapsed >= 0.5) {
      measuredTps = measuredTps * 0.5 + (ticksSinceSample / sampleElapsed) * 0.5;
      ticksSinceSample = 0;
      lastTpsSampleTime = now;
    }
  }

  const snapshotHz = speed === -1 ? SNAPSHOT_HZ_MAX : SNAPSHOT_HZ_NORMAL;
  if (now - lastSnapshotTime >= 1000 / snapshotHz) {
    lastSnapshotTime = now;
    sendSnapshot(false);
  }

  if (selectedId !== null && now - lastDetailTime >= 120) {
    lastDetailTime = now;
    sendSelectionDetail();
  }

  scheduleFrame();
}

function runTicks(elapsedSeconds: number): number {
  if (!world) return 0;

  if (speed === -1) {
    const deadline = performance.now() + MAX_SLICE_MS;
    let ticks = 0;
    while (ticks < MAX_TICKS_PER_SLICE) {
      world.step();
      ticks++;
      if ((ticks & 15) === 0 && performance.now() >= deadline) break;
    }
    return ticks;
  }

  accumulator += elapsedSeconds * SIM_HZ * speed;
  const budget = SPEED_TICK_BUDGET[speed] ?? 20;
  let ticks = Math.floor(accumulator);
  if (ticks > budget) ticks = budget;
  if (ticks <= 0) return 0;
  accumulator -= ticks;

  const brainStart = performance.now();
  for (let i = 0; i < ticks; i++) world.step();
  brainTimeMs = brainTimeMs * (1 - TPS_SMOOTHING) + ((performance.now() - brainStart) / ticks) * TPS_SMOOTHING;
  return ticks;
}

/** Advance exactly one tick, regardless of pause state. */
function stepOnce(): void {
  if (!world) return;
  world.step();
  sendSnapshot(true);
}

function metrics(): DevMetrics {
  return {
    tps: measuredTps,
    fps: 0, // filled in by the renderer
    tickTimeMs,
    brainTimeMs,
    snapshotBytes,
    workerLatencyMs: 0, // filled in by the client
    entityCount: 0,
    humanCount: 0,
    predatorCount: 0,
    plantCount: 0,
    synapseCount: 0,
  };
}

function sendSnapshot(force: boolean): void {
  if (!world) return;
  revision += 1;
  const snapshot = world.buildSnapshot(revision, metrics(), chronicleSent);
  chronicleSent = world.chronicle.lastId;
  snapshotBytes =
    snapshot.ids.byteLength + snapshot.floats.byteLength + snapshot.meta.byteLength;

  post(
    {
      type: 'snapshot',
      revision: snapshot.revision,
      tick: snapshot.tick,
      simTime: snapshot.simTime,
      dayPhase: snapshot.dayPhase,
      light: snapshot.light,
      ambientTemperature: snapshot.ambientTemperature,
      count: snapshot.count,
      ids: snapshot.ids,
      floats: snapshot.floats,
      meta: snapshot.meta,
      stats: snapshot.stats,
      events: snapshot.events,
      effects: snapshot.effects,
      structures: snapshot.structures,
      fields: snapshot.fields,
      canals: snapshot.canals,
      game: snapshot.game,
      trails: sendTrails(),
      metrics: snapshot.metrics,
      paused,
      speed,
    },
    [snapshot.ids.buffer, snapshot.floats.buffer, snapshot.meta.buffer],
  );
  void force;
}

/** Worn-trail bytes for the renderer, every few seconds rather than every snapshot. */
let lastTrailsTime = 0;
function sendTrails(): Uint8Array | null {
  if (!world) return null;
  const now = performance.now();
  if (now - lastTrailsTime < 3000) return null;
  lastTrailsTime = now;
  return world.paths.toBytes();
}

function sendSelectionDetail(): void {
  if (!world || selectedId === null) return;
  const detail = world.humanDetail(selectedId);
  const brain = world.brainView(selectedId);
  const explain = world.explain(selectedId);
  post({ type: 'detail', id: selectedId, detail });
  post({ type: 'brain', id: selectedId, brain });
  post({ type: 'explain', id: selectedId, explain });
}

// --- message handling ------------------------------------------------------

ctx.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'genesis':
        genesis(message.config);
        break;

      case 'setSpeed':
        speed = message.speed;
        paused = message.speed === 0;
        accumulator = 0;
        lastFrameTime = performance.now();
        sendSnapshot(true);
        break;

      case 'stepOnce':
        stepOnce();
        break;

      case 'select':
        selectedId = message.id;
        if (selectedId !== null) sendSelectionDetail();
        break;

      case 'god': {
        if (!world) return;
        // Shared with the WebSocket server — see simulation/commands.ts.
        const result = applyGodCommandChecked(world, message.command);
        post({ type: 'godResult', ok: result.ok, message: result.message, kind: message.command.kind });
        sendSnapshot(true);
        break;
      }

      case 'requestDetail': {
        if (!world) return;
        post({ type: 'detail', id: message.id, detail: world.humanDetail(message.id) });
        break;
      }

      case 'requestBrain': {
        if (!world) return;
        post({ type: 'brain', id: message.id, brain: world.brainView(message.id) });
        break;
      }

      case 'requestExplain': {
        if (!world) return;
        post({ type: 'explain', id: message.id, explain: world.explain(message.id) });
        break;
      }

      case 'requestChronicle': {
        if (!world) return;
        post({ type: 'chronicle', entries: world.chronicle.entries });
        break;
      }

      case 'requestBrainPair': {
        if (!world) return;
        post({ type: 'brainPair', a: world.brainView(message.a), b: world.brainView(message.b) });
        break;
      }

      case 'requestGenealogy': {
        if (!world) return;
        post({ type: 'genealogy', forest: world.genealogyForest() });
        break;
      }

      case 'serialize': {
        if (!world) return;
        post({ type: 'serialized', payload: JSON.stringify(world.serialize()) });
        break;
      }

      case 'restore': {
        const parsed = JSON.parse(message.payload) as Record<string, unknown>;
        world = World.deserialize(parsed);
        chronicleSent = 0;
        lastTrailsTime = 0;
        accumulator = 0;
        lastFrameTime = performance.now();
        selectedId = null;
        paused = true;
        speed = 1;
        post({ type: 'restored', ok: true });
        sendSnapshot(true);
        scheduleFrame();
        break;
      }

      default:
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

post({ type: 'ready' });

export { DT };
