/** Cross-cutting domain types shared by the simulation, the worker and the UI. */

export const EntityKind = {
  Human: 0,
  Predator: 1,
  Plant: 2,
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export const LifeStage = {
  Baby: 0,
  Child: 1,
  Adult: 2,
  Elder: 3,
} as const;
export type LifeStage = (typeof LifeStage)[keyof typeof LifeStage];

export const STAGE_NAMES = ['Baby', 'Child', 'Adult', 'Older adult'] as const;

export const Sex = {
  Female: 0,
  Male: 1,
} as const;
export type Sex = (typeof Sex)[keyof typeof Sex];

/** Bit flags packed into the snapshot's metadata byte. */
export const EntityFlags = {
  Injured: 1 << 0,
  Sleeping: 1 << 1,
  Mating: 1 << 2,
  Pregnant: 1 << 3,
  Dead: 1 << 4,
  Attacking: 1 << 5,
  Feeding: 1 << 6,
  Selected: 1 << 7,
  Harvesting: 1 << 8,
  Building: 1 << 9,
} as const;

/** Per-entity stride of the snapshot float buffer. */
export const SNAPSHOT_FLOAT_STRIDE = 12;
/** Per-entity stride of the snapshot metadata buffer. */
/**
 * Bytes of per-entity metadata in a snapshot.
 *
 * 0 = kind, 1 = sex, 2 = stage, 3 = flags, 4 = house.
 *
 * The house needed its own byte rather than a flag bit: `EntityFlags` is a
 * single `Uint8Array` element and all eight bits were already spoken for, so a
 * `1 << 10` house flag was silently discarded by the typed-array write. That
 * cost an hour and is why the house is now a field rather than a bit.
 */
export const SNAPSHOT_META_STRIDE = 5;

export type EventKind =
  | 'birth'
  | 'death'
  | 'adulthood'
  | 'conception'
  | 'mating'
  | 'predation'
  | 'injury'
  | 'lightning'
  | 'generation'
  | 'milestone'
  | 'god'
  | 'ecology'
  | 'build';

export interface WorldEvent {
  id: number;
  tick: number;
  simTime: number;
  kind: EventKind;
  text: string;
  /** Entity ids referenced by this event, so the feed can be clickable. */
  entityIds: number[];
}

export interface WorldStats {
  population: number;
  males: number;
  females: number;
  babies: number;
  children: number;
  adults: number;
  elders: number;
  pregnancies: number;
  births: number;
  deaths: number;
  oldestGeneration: number;
  predators: number;
  plants: number;
  /** Huts finished. */
  huts: number;
  /** Building sites that still want timber. */
  sites: number;
  /** Standing timber remaining across the map, in units. */
  timber: number;
  averageNeurons: number;
  averageSynapses: number;
  averageWeightDrift: number;
  seed: string;
  tick: number;
  simTime: number;
  dayPhase: number;
  light: number;
  ambientTemperature: number;
  climateOffset: number;
}

export interface DevMetrics {
  tps: number;
  fps: number;
  tickTimeMs: number;
  brainTimeMs: number;
  snapshotBytes: number;
  workerLatencyMs: number;
  entityCount: number;
  humanCount: number;
  predatorCount: number;
  plantCount: number;
  synapseCount: number;
}

/** Short-lived visual effect produced by the simulation (lightning, birth, ...). */
export interface WorldEffect {
  id: number;
  kind: 'lightning' | 'birth' | 'death' | 'mating' | 'attack' | 'spawn' | 'build';
  x: number;
  y: number;
  /** Remaining lifetime in simulated seconds. */
  ttl: number;
  /** Original lifetime, so the renderer can normalise the fade. */
  maxTtl: number;
  radius: number;
}

/** Compact snapshot pushed from the simulation worker to the renderer. */
export interface WorldSnapshot {
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
  stats: WorldStats;
  events: WorldEvent[];
  effects: WorldEffect[];
  metrics: DevMetrics;
  /** Huts, finished and under construction. Small enough to send whole. */
  structures: StructureView[];
  /** Fields under cultivation, sent whole for the same reason. */
  fields: FieldView[];
  /** Dug canal lengths. */
  canals: CanalView[];
}

/**
 * One house's standing in a competitive match.
 *
 * A house is a matrilineal lineage: every human belongs to the house of its
 * mother, and a house with no living women is extinct for good.
 */
export interface HouseStats {
  house: number;
  population: number;
  females: number;
  males: number;
  children: number;
  deepestGeneration: number;
  /** population x 100 + deepestGeneration x 25. */
  score: number;
}

/** A field under cultivation, as the client sees it. */
export interface FieldView {
  id: number;
  x: number;
  y: number;
  /** 0 fallow, 1 growing, 2 ripe. */
  stage: number;
  growth: number;
  moisture: number;
}

/** One dug length of canal. */
export interface CanalView {
  id: number;
  x: number;
  y: number;
  progress: number;
  complete: boolean;
  flowing: boolean;
}

export interface StructureView {
  id: number;
  x: number;
  y: number;
  wood: number;
  required: number;
  complete: boolean;
  lastBuildTick: number;
  builderId: number;
  builderName: string;
}

export interface SocialRecordView {
  id: number;
  name: string;
  familiarity: number;
  attachment: number;
  valence: number;
  lastSeenTick: number;
  encounters: number;
  matings: number;
  related: number;
  alive: boolean;
}

export interface GeneView {
  key: string;
  label: string;
  group: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  description: string;
  /** Value inherited from the mother / father, when known. */
  motherValue: number | null;
  fatherValue: number | null;
}

export interface RelativeView {
  id: number;
  name: string;
  sex: number;
  generation: number;
  alive: boolean;
  stage: number;
}

export interface PregnancyView {
  fatherId: number;
  fatherName: string;
  progress: number;
  conceptionTick: number;
  embryoGeneration: number;
}

export interface HumanDetail {
  id: number;
  name: string;
  sex: number;
  ageBio: number;
  stage: number;
  generation: number;
  alive: boolean;
  deathTick: number | null;
  deathReason: string | null;
  birthTick: number;

  health: number;
  hunger: number;
  thirst: number;
  energy: number;
  fatigue: number;
  pain: number;
  stress: number;
  bodyTemperature: number;
  ambientTemperature: number;
  comfort: number;
  fertility: number;
  libido: number;

  currentAction: string;
  actionStrength: number;
  currentFocus: string;
  motor: number[];

  pregnancy: PregnancyView | null;
  matingWith: number | null;
  matingWithName: string | null;

  mother: RelativeView | null;
  father: RelativeView | null;
  children: RelativeView[];
  siblings: RelativeView[];

  social: SocialRecordView[];

  neuronCount: number;
  synapseCount: number;
  excitatorySynapses: number;
  inhibitorySynapses: number;
  weightDrift: number;
  meanAbsWeight: number;

  genome: GeneView[];
  lifespan: number;
}

export interface BrainView {
  entityId: number;
  neuronCount: number;
  /** Smoothed activity per neuron, 0..1. */
  activity: number[];
  /** Membrane potential per neuron. */
  potential: number[];
  /** Motor read-out, 0..1, ordered by MOTOR_NAMES. */
  motor: number[];
  /** Strongest synapses for the visualiser: [pre, post, weight]. */
  synapses: Array<[number, number, number]>;
  stats: {
    meanActivity: number;
    activeNeurons: number;
    excitatory: number;
    inhibitory: number;
  };
}

export interface ExplanationView {
  tick: number;
  action: string;
  strength: number;
  summary: string[];
  path: Array<{ label: string; short: string; region: number; contribution: number; activation: number }>;
  /** Strongest chain through the recurrent core, i.e. the learned component. */
  learnedPath: Array<{ label: string; short: string; region: number; contribution: number; activation: number }>;
  note: string;
}

export interface TreeNode {
  id: number;
  name: string;
  generation: number;
  sex: number;
  alive: boolean;
  children: TreeNode[];
}
