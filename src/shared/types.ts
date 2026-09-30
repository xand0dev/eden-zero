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
 * 0 = kind, 1 = sex, 2 = stage, 3 = flags, 4 = house, 5..11 = looks (v3).
 *
 * The house needed its own byte rather than a flag bit: `EntityFlags` is a
 * single `Uint8Array` element and all eight bits were already spoken for, so a
 * `1 << 10` house flag was silently discarded by the typed-array write. That
 * cost an hour and is why the house is now a field rather than a bit.
 */
export const SNAPSHOT_META_STRIDE = 12;
/**
 * Where the looks start in the metadata: seven bytes (v3), each a 0..1 gene
 * scaled to 0..255 — build, head shape, hairstyle, hair colour, body paint,
 * paint colour, adornment. Zero for anything that is not a person.
 */
export const SNAPSHOT_MORPH_OFFSET = 5;
export const MORPH_GENES = ['build', 'headShape', 'hairStyle', 'hairHue', 'markings', 'markingHue', 'ornament'] as const;

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
  | 'build'
  | 'mind';

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
  kind: 'lightning' | 'birth' | 'death' | 'mating' | 'attack' | 'spawn' | 'build' | 'rain';
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
  /** Seasons, era, fate, favour and the rest of the game layer. */
  game: GameView;
}

/** Someone worth pointing the camera at. */
export interface SpotlightView {
  id: number;
  score: number;
  reason: string;
}

export interface EraRequirementView {
  label: string;
  current: number;
  target: number;
  met: boolean;
}

export interface CrisisView {
  kind: string;
  name: string;
  phase: 'warning' | 'active';
  text: string;
  advice: string;
  /** Simulated seconds until it begins (warning) or ends (active). */
  seconds: number;
  severity: number;
}

export interface ChronicleView {
  id: number;
  tick: number;
  simTime: number;
  kind: string;
  importance: number;
  title: string;
  text: string;
  entityIds: number[];
  x?: number;
  y?: number;
}

/** The game layer, as the client sees it on every snapshot. Small on purpose. */
export interface GameView {
  mode: string;
  biome: string;
  charter: string[];
  challengeId?: string;
  year: number;
  season: number;
  seasonPhase: number;
  day: number;
  era: number;
  /** What the next era needs, and how close the world is. */
  nextEra: EraRequirementView[];
  /** 0..1 of the two-day hold, once every requirement is met. */
  eraHold: number;
  favour: {
    enabled: boolean;
    value: number;
    cap: number;
    prices: Record<string, number>;
    /** Seconds until each tool is ready again; absent when ready. */
    cooldowns: Record<string, number>;
    interventions: number;
    spent: number;
  };
  interventionsAllowed: boolean;
  spawnAllowed: boolean;
  crisis: CrisisView | null;
  crisesSurvived: number;
  crisisHistory: Array<{ kind: string; survived: boolean; year: number }>;
  storedFood: number;
  granaries: number;
  wells: number;
  trails: number;
  /** Mean fertility of the land around the village, 0..1. */
  landHealth: number;
  spotlight: SpotlightView[];
  /** Chronicle entries since the previous snapshot. */
  chronicle: ChronicleView[];
  chronicleCount: number;
  /** Atlas entries seen for the first time since the previous snapshot. */
  discoveries: Array<{ id: string; humanId: number; name: string }>;
  /** Atlas entries seen in this world so far. */
  discovered: string[];
  /** Living people with an epithet, id -> epithet. */
  epithets: Record<number, string>;
  /** Positions of burning plants, for the renderer: [x, y, x, y, ...]. */
  fires: number[];
  rains: Array<{ x: number; y: number; radius: number }>;
  fevered: number[];
  /** Population, per snapshot, for the campaign graph (sampled every half day). */
  populationHistory: number[];
  extinct: boolean;
  /** Age of the oldest living person, in biological years. */
  oldest: number;
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
  fertility?: number;
  blighted?: boolean;
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
  /** 0 hut, 1 granary, 2 well, 3 workshop, 4 stone house, 5 palisade, 6 shrine. */
  kind?: number;
  store?: number;
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
  /** Neurons grown in life or inherited as instincts, named. */
  skills: GrownView[];
  /** Room for grown neurons, from the neurogenesis gene. */
  growthCapacity: number;
  synapseCount: number;
  excitatorySynapses: number;
  inhibitorySynapses: number;
  weightDrift: number;
  meanAbsWeight: number;

  genome: GeneView[];
  lifespan: number;

  /** Title earned in the atlas, e.g. "the Irrigator". */
  epithet: string | null;
  /** Atlas entries this person has earned. */
  atlas: string[];
  fever: boolean;
  /** Where this person's food has come from, in food units. */
  diet: { wild: number; crop: number; granary: number; carcass: number; gift: number };
  work: { timber: number; woodLaid: number; completed: number; sown: number; crops: number; canals: number };
}

/** A neuron a brain grew, or inherited as an instinct, as the observer sees it. */
export interface GrownView {
  /** Slot index in the brain (GROWN_START + k). */
  index: number;
  name: string;
  sentence: string;
  /** Presynaptic sensory channels. */
  inputs: number[];
  motor: number;
  /** +1 drives the motor, -1 holds it back. */
  sign: number;
  /** Current weight onto the motor. */
  outWeight: number;
  activity: number;
  /** 0 = grown in this life; k = instinct inherited through k generations. */
  generations: number;
  /** Simulated days since it grew; null for an instinct. */
  grownDaysAgo: number | null;
  utility: number;
}

export interface BrainView {
  entityId: number;
  neuronCount: number;
  /** Neurons grown in life or inherited as instincts (activity for these is not in `activity`). */
  grown: GrownView[];
  /** How many grown neurons this brain has room for. */
  growthCapacity: number;
  /** Smoothed activity per neuron, 0..1. */
  activity: number[];
  /** Membrane potential per neuron. */
  potential: number[];
  /** Motor read-out, 0..1, ordered by MOTOR_NAMES. */
  motor: number[];
  /** Strongest synapses per region pair: [pre, post, weight, change since birth]. */
  synapses: Array<[number, number, number, number]>;
  /** The synapses lifetime learning has changed most, same shape. */
  learned: Array<[number, number, number, number]>;
  /** Spikes per neuron since the previous brain view (sensory neurons do not spike). */
  spikes: number[];
  /** The plasticity valence driving learning right now, -1..1 (reward positive). */
  valence: number;
  /** Raw sensory input, one value per sensory channel. */
  sensors: number[];
  /** Body heading in radians, to turn egocentric senses into directions. */
  heading: number;
  /** Mean |weight change| since birth across all synapses. */
  weightDrift: number;
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
