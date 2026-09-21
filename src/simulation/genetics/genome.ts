import { Rng } from '../rng';
import { AGE_MAX, GESTATION_YEARS } from '../../shared/constants';

/**
 * Genome: the complete heritable description of an individual.
 *
 * Everything that differs between individuals and can be passed to offspring
 * lives here. Neural topology is *not* stored directly — instead the genome
 * holds a `brainSeed` plus connectivity parameters, and the brain regenerates a
 * deterministic wiring pattern from them. Structural mutation therefore happens
 * by mutating `brainSeed` and the connectivity genes.
 */
export interface Genome {
  /** 0 = human, 1 = predator. Kept in the genome so the same machinery serves both. */
  species: number;

  // --- morphology & physiology -------------------------------------------
  bodySize: number; // 0.72 .. 1.34
  speed: number; // 0.65 .. 1.45
  metabolism: number; // 0.65 .. 1.45
  lifespan: number; // biological years at which senescence kills
  fertility: number; // 0.45 .. 1.55
  visionRange: number; // tiles
  tempOptimum: number; // preferred ambient temperature
  tempTolerance: number; // width of the comfort band
  growthRate: number; // 0.7 .. 1.35

  // --- appearance ---------------------------------------------------------
  hue: number; // 0 .. 1
  saturation: number; // 0.15 .. 0.85
  lightness: number; // 0.3 .. 0.78
  stature: number; // 0.85 .. 1.18 limb proportion

  // --- neural -------------------------------------------------------------
  brainSeed: number; // uint32, drives deterministic topology generation
  connDensity: number; // 0.55 .. 1.5
  weightScale: number; // 0.5 .. 1.7
  excRatio: number; // 0.6 .. 0.93
  tauScale: number; // 0.78 .. 1.3
  plasticity: number; // 0.15 .. 1.7  (learning rate multiplier)
  neuromodGain: number; // 0.35 .. 1.7 (sensitivity to valence)

  // --- behavioural disposition (biases, not scripts) ----------------------
  plantDiet: number; // 0 .. 1 preference weight for plant matter
  aggressionGain: number; // 0.3 .. 1.8 gain on the attack motor output
  socialGain: number; // 0.4 .. 1.7 gain on conspecific sensory salience

  // --- ecology (mainly predators) ----------------------------------------
  bodyScale: number; // overall visual/physical scale multiplier
  attackPower: number; // damage per attack tick
}

export type GeneKey = Exclude<keyof Genome, 'species'>;

export interface GeneDef {
  key: GeneKey;
  label: string;
  group: 'Morphology' | 'Physiology' | 'Appearance' | 'Neural' | 'Disposition' | 'Ecology';
  min: number;
  max: number;
  /** Suggested step for the genome editor slider. */
  step: number;
  integer?: boolean;
  description: string;
}

/**
 * The single source of truth for gene bounds. Mutation, the genome editor and
 * the validation tests all read from this table, which is what guarantees that
 * "mutations remain valid" is a testable invariant rather than a hope.
 */
export const GENE_DEFS: readonly GeneDef[] = [
  {
    key: 'bodySize',
    label: 'Body size',
    group: 'Morphology',
    min: 0.72,
    max: 1.34,
    step: 0.01,
    description: 'Physical scale. Larger bodies hit harder but burn more energy.',
  },
  {
    key: 'speed',
    label: 'Movement speed',
    group: 'Morphology',
    min: 0.65,
    max: 1.45,
    step: 0.01,
    description: 'Top locomotion speed multiplier.',
  },
  {
    key: 'stature',
    label: 'Stature',
    group: 'Morphology',
    min: 0.85,
    max: 1.18,
    step: 0.01,
    description: 'Limb-to-torso proportion. Purely cosmetic for V0.',
  },
  {
    key: 'growthRate',
    label: 'Growth rate',
    group: 'Morphology',
    min: 0.7,
    max: 1.35,
    step: 0.01,
    description: 'How quickly a juvenile reaches adult size.',
  },
  {
    key: 'metabolism',
    label: 'Metabolism',
    group: 'Physiology',
    min: 0.65,
    max: 1.45,
    step: 0.01,
    description: 'Rate at which energy is burned and hunger accrues.',
  },
  {
    key: 'lifespan',
    label: 'Lifespan',
    group: 'Physiology',
    min: 28,
    max: 92,
    step: 0.5,
    description: 'Biological years of maximum life.',
  },
  {
    key: 'fertility',
    label: 'Fertility',
    group: 'Physiology',
    min: 0.45,
    max: 1.55,
    step: 0.01,
    description: 'Conception probability multiplier and fertility window width.',
  },
  {
    key: 'visionRange',
    label: 'Vision range',
    group: 'Physiology',
    min: 3,
    max: 15,
    step: 0.1,
    description: 'Radius of the visual sensor field, in tiles.',
  },
  {
    key: 'tempOptimum',
    label: 'Temperature optimum',
    group: 'Physiology',
    min: -8,
    max: 16,
    step: 0.1,
    description: 'Ambient temperature this individual is adapted to.',
  },
  {
    key: 'tempTolerance',
    label: 'Temperature tolerance',
    group: 'Physiology',
    min: 3,
    max: 18,
    step: 0.1,
    description: 'Width of the thermal comfort band.',
  },
  {
    key: 'hue',
    label: 'Hue',
    group: 'Appearance',
    min: 0,
    max: 1,
    step: 0.005,
    description: 'Skin/clothing hue. Drifts visibly over generations.',
  },
  {
    key: 'saturation',
    label: 'Saturation',
    group: 'Appearance',
    min: 0.1,
    max: 0.9,
    step: 0.005,
    description: 'Colour intensity.',
  },
  {
    key: 'lightness',
    label: 'Lightness',
    group: 'Appearance',
    min: 0.25,
    max: 0.82,
    step: 0.005,
    description: 'Colour brightness.',
  },
  {
    key: 'brainSeed',
    label: 'Brain seed',
    group: 'Neural',
    min: 0,
    max: 4294967295,
    step: 1,
    integer: true,
    description: 'Deterministic wiring seed. Mutating it re-wires the brain structure.',
  },
  {
    key: 'connDensity',
    label: 'Connectivity density',
    group: 'Neural',
    min: 0.55,
    max: 1.5,
    step: 0.01,
    description: 'Synapse count multiplier (roughly 2k to 5k synapses).',
  },
  {
    key: 'weightScale',
    label: 'Synaptic weight scale',
    group: 'Neural',
    min: 0.5,
    max: 1.7,
    step: 0.01,
    description: 'Multiplier applied to generated initial weights.',
  },
  {
    key: 'excRatio',
    label: 'Excitatory ratio',
    group: 'Neural',
    min: 0.6,
    max: 0.93,
    step: 0.005,
    description: 'Fraction of synapses that are excitatory rather than inhibitory.',
  },
  {
    key: 'tauScale',
    label: 'Membrane time constant',
    group: 'Neural',
    min: 0.78,
    max: 1.3,
    step: 0.005,
    description: 'Neuronal leak rate. Slower neurons integrate over longer windows.',
  },
  {
    key: 'plasticity',
    label: 'Plasticity rate',
    group: 'Neural',
    min: 0.15,
    max: 1.7,
    step: 0.01,
    description: 'Lifetime learning rate multiplier.',
  },
  {
    key: 'neuromodGain',
    label: 'Neuromodulator gain',
    group: 'Neural',
    min: 0.35,
    max: 1.7,
    step: 0.01,
    description: 'How strongly homeostatic valence modulates plasticity.',
  },
  {
    key: 'plantDiet',
    label: 'Plant diet preference',
    group: 'Disposition',
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Nutritional weight given to plant matter vs. meat.',
  },
  {
    key: 'aggressionGain',
    label: 'Aggression gain',
    group: 'Disposition',
    min: 0.3,
    max: 1.8,
    step: 0.01,
    description: 'Gain applied to the attack motor output.',
  },
  {
    key: 'socialGain',
    label: 'Social sensitivity',
    group: 'Disposition',
    min: 0.4,
    max: 1.7,
    step: 0.01,
    description: 'Gain on conspecific sensory channels.',
  },
  {
    key: 'bodyScale',
    label: 'Body scale',
    group: 'Ecology',
    min: 0.5,
    max: 4,
    step: 0.01,
    description: 'Overall physical scale class (predators use larger values).',
  },
  {
    key: 'attackPower',
    label: 'Attack power',
    group: 'Ecology',
    min: 0.2,
    max: 30,
    step: 0.1,
    description: 'Damage dealt per attack tick.',
  },
];

const GENE_MAP: ReadonlyMap<GeneKey, GeneDef> = new Map(GENE_DEFS.map((d) => [d.key, d]));

export function geneDef(key: GeneKey): GeneDef {
  const def = GENE_MAP.get(key);
  if (!def) throw new Error(`Unknown gene: ${key}`);
  return def;
}

/** Clamp every gene into its declared valid range. */
export function sanitizeGenome(genome: Genome): Genome {
  for (const def of GENE_DEFS) {
    const raw = genome[def.key];
    let value = Number.isFinite(raw) ? raw : def.min;
    if (value < def.min) value = def.min;
    if (value > def.max) value = def.max;
    if (def.integer) value = Math.round(value);
    genome[def.key] = value;
  }
  genome.species = genome.species === 1 ? 1 : 0;
  return genome;
}

/** True if every gene sits inside its declared bounds. */
export function isGenomeValid(genome: Genome): boolean {
  for (const def of GENE_DEFS) {
    const value = genome[def.key];
    if (!Number.isFinite(value)) return false;
    if (value < def.min || value > def.max) return false;
    if (def.integer && !Number.isInteger(value)) return false;
  }
  return true;
}

function g(rng: Rng, def: GeneDef, mean: number, spread: number): number {
  const value = rng.normal(mean, spread);
  const clamped = Math.min(def.max, Math.max(def.min, value));
  return def.integer ? Math.round(clamped) : clamped;
}

/**
 * Sample a founder genome.
 *
 * Founders are drawn from a reasonably generous distribution: the brief
 * explicitly asks for a default world where life has a chance, without faking
 * survival. The priors in the brain plus these distributions are what give the
 * first generation a fighting chance.
 */
export function randomGenome(rng: Rng, species: 0 | 1 = 0): Genome {
  const def = (key: GeneKey): GeneDef => geneDef(key);

  if (species === 1) {
    // Predator: bigger, faster, more aggressive, shorter-lived, meat-only.
    const genome: Genome = {
      species: 1,
      bodySize: g(rng, def('bodySize'), 1.28, 0.06),
      speed: g(rng, def('speed'), 1.12, 0.12),
      metabolism: g(rng, def('metabolism'), 1.1, 0.12),
      lifespan: g(rng, def('lifespan'), 40, 8),
      fertility: g(rng, def('fertility'), 0.8, 0.2),
      visionRange: g(rng, def('visionRange'), 11, 2),
      tempOptimum: g(rng, def('tempOptimum'), 6, 3),
      tempTolerance: g(rng, def('tempTolerance'), 12, 3),
      growthRate: g(rng, def('growthRate'), 1.15, 0.1),
      hue: g(rng, def('hue'), 0.03, 0.03),
      saturation: g(rng, def('saturation'), 0.55, 0.12),
      lightness: g(rng, def('lightness'), 0.38, 0.07),
      stature: g(rng, def('stature'), 1.05, 0.05),
      brainSeed: rng.nextUint32(),
      connDensity: g(rng, def('connDensity'), 1.05, 0.14),
      weightScale: g(rng, def('weightScale'), 1.05, 0.14),
      excRatio: g(rng, def('excRatio'), 0.78, 0.04),
      tauScale: g(rng, def('tauScale'), 1.02, 0.08),
      plasticity: g(rng, def('plasticity'), 0.85, 0.2),
      neuromodGain: g(rng, def('neuromodGain'), 0.9, 0.2),
      plantDiet: 0,
      aggressionGain: g(rng, def('aggressionGain'), 1.35, 0.2),
      socialGain: g(rng, def('socialGain'), 1.15, 0.2),
      bodyScale: g(rng, def('bodyScale'), 2.35, 0.3),
      attackPower: g(rng, def('attackPower'), 9, 2),
    };
    return sanitizeGenome(genome);
  }

  const genome: Genome = {
    species: 0,
    bodySize: g(rng, def('bodySize'), 1.0, 0.11),
    speed: g(rng, def('speed'), 1.0, 0.13),
    metabolism: g(rng, def('metabolism'), 0.98, 0.13),
    // Founders get a slightly generous lifespan so the first generation can
    // actually reproduce before senescence arrives.
    lifespan: g(rng, def('lifespan'), 62, 10),
    fertility: g(rng, def('fertility'), 1.05, 0.2),
    visionRange: g(rng, def('visionRange'), 8.5, 2),
    tempOptimum: g(rng, def('tempOptimum'), 4, 3),
    tempTolerance: g(rng, def('tempTolerance'), 10.5, 3),
    growthRate: g(rng, def('growthRate'), 1.0, 0.1),
    hue: rng.next(),
    saturation: g(rng, def('saturation'), 0.42, 0.14),
    lightness: g(rng, def('lightness'), 0.58, 0.11),
    stature: g(rng, def('stature'), 1.0, 0.06),
    brainSeed: rng.nextUint32(),
    connDensity: g(rng, def('connDensity'), 0.95, 0.16),
    weightScale: g(rng, def('weightScale'), 0.95, 0.15),
    excRatio: g(rng, def('excRatio'), 0.79, 0.05),
    tauScale: g(rng, def('tauScale'), 1.0, 0.08),
    plasticity: g(rng, def('plasticity'), 0.95, 0.22),
    neuromodGain: g(rng, def('neuromodGain'), 0.95, 0.22),
    plantDiet: g(rng, def('plantDiet'), 0.82, 0.12),
    aggressionGain: g(rng, def('aggressionGain'), 0.72, 0.18),
    socialGain: g(rng, def('socialGain'), 1.0, 0.2),
    bodyScale: 1,
    attackPower: g(rng, def('attackPower'), 3.2, 0.8),
  };
  return sanitizeGenome(genome);
}

export function cloneGenome(genome: Genome): Genome {
  return { ...genome };
}

/** Euclidean distance in normalised gene space. Used by the inspector. */
export function genomeDistance(a: Genome, b: Genome): number {
  let sum = 0;
  for (const def of GENE_DEFS) {
    if (def.key === 'brainSeed') continue;
    const span = def.max - def.min || 1;
    const delta = (a[def.key] - b[def.key]) / span;
    sum += delta * delta;
  }
  return Math.sqrt(sum / GENE_DEFS.length);
}

export function gestationSeconds(): number {
  return GESTATION_YEARS;
}

export { AGE_MAX };
