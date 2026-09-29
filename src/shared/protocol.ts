import type {
  BrainView,
  ExplanationView,
  HumanDetail,
  TreeNode,
  WorldSnapshot,
} from './types';

/**
 * Message protocol between the React UI and the simulation worker.
 *
 * The UI never touches simulation internals — it sends commands and receives
 * snapshots. That boundary is what makes a future Rust migration tractable:
 * the same protocol can be served by a Tauri command instead of a worker.
 */

export type GodCommand =
  | { kind: 'spawnHuman'; x: number; y: number }
  | { kind: 'kill'; id: number }
  | { kind: 'lightning'; x: number; y: number }
  | { kind: 'spawnFood'; x: number; y: number }
  | { kind: 'spawnPredator'; x: number; y: number }
  | { kind: 'moveHuman'; id: number; x: number; y: number }
  | { kind: 'temperature'; offset: number }
  | { kind: 'timeOfDay'; phase: number }
  | { kind: 'editGenome'; id: number; key: string; value: number }
  | { kind: 'rain'; x: number; y: number }
  | { kind: 'bless'; id: number }
  | { kind: 'rewardPulse'; id: number }
  | { kind: 'painPulse'; id: number };

export type GodCommandKind = GodCommand['kind'];

export interface WorldConfig {
  seed: string;
  initialHumans: number;
  initialPredators: number;
  plantDensity: number;
  /** campaign (default in the UI), sandbox, challenge or daily. */
  mode?: 'campaign' | 'sandbox' | 'challenge' | 'daily';
  charter?: string[];
  biome?: string;
  /** Genomes from the vault for the first founders. */
  founderGenomes?: import('../simulation/genetics/genome').Genome[];
  challengeId?: string;
}

/** -1 means MAX (run as fast as possible), 0 means paused. */
export type SpeedSetting = number;

export type MainToWorker =
  | { type: 'genesis'; config: WorldConfig }
  | { type: 'setSpeed'; speed: SpeedSetting }
  | { type: 'stepOnce' }
  | { type: 'select'; id: number | null }
  | { type: 'god'; command: GodCommand }
  | { type: 'requestDetail'; id: number }
  | { type: 'requestBrain'; id: number }
  | { type: 'requestExplain'; id: number }
  | { type: 'requestGenealogy' }
  | { type: 'serialize' }
  | { type: 'restore'; payload: string }
  | { type: 'requestChronicle' }
  | { type: 'requestAtlasWorld' }
  | { type: 'requestBrainPair'; a: number; b: number }
  | { type: 'setSpeedPreset'; preset: number };

export type WorkerToMain =
  | { type: 'ready' }
  | {
      type: 'snapshot';
      revision: number;
      tick: number;
      simTime: number;
      dayPhase: number;
      light: number;
      ambientTemperature: number;
      count: number;
      ids: Int32Array;
      floats: Float32Array;
      meta: Uint8Array;
      stats: WorldSnapshot['stats'];
      events: WorldSnapshot['events'];
      effects: WorldSnapshot['effects'];
      structures: WorldSnapshot['structures'];
      fields: WorldSnapshot['fields'];
      canals: WorldSnapshot['canals'];
      game: WorldSnapshot['game'];
      /** Worn-trail wear per tile, one byte each; sent every few seconds, else null. */
      trails: Uint8Array | null;
      metrics: WorldSnapshot['metrics'];
      paused: boolean;
      speed: number;
    }
  | { type: 'detail'; id: number; detail: HumanDetail | null }
  | { type: 'brain'; id: number; brain: BrainView | null }
  | { type: 'explain'; id: number; explain: ExplanationView | null }
  | { type: 'genealogy'; forest: TreeNode[] }
  | { type: 'serialized'; payload: string }
  | { type: 'godResult'; ok: boolean; message: string; kind: string }
  | { type: 'chronicle'; entries: import('./types').ChronicleView[] }
  | { type: 'brainPair'; a: BrainView | null; b: BrainView | null }
  | { type: 'restored'; ok: boolean; message?: string }
  | { type: 'error'; message: string };
