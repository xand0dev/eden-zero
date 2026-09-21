import { Rng } from '../rng';
import { GENE_DEFS, type GeneKey, type Genome, isGenomeValid, sanitizeGenome } from './genome';

/**
 * Reproduction genetics: crossover + mutation.
 *
 * Design rule from the brief: mutations must be *visible* over many
 * generations but must never be universally beneficial, and every gene must
 * stay inside its declared bounds.
 */

export interface CrossoverReport {
  /** Which parent contributed the majority of each gene. 0 = A, 1 = B, 2 = blended. */
  origin: Partial<Record<GeneKey, 0 | 1 | 2>>;
  blendedGenes: number;
}

export interface MutationReport {
  mutated: GeneKey[];
  structural: boolean;
  magnitude: number;
}

/**
 * Uniform crossover with occasional blending.
 *
 * Each gene is taken from one parent; a fraction of genes are instead blended
 * (arithmetic mean plus a small jitter). `brainSeed` is inherited wholesale
 * unless mutation later re-wires it, which is what makes structural mutation a
 * discrete, observable event rather than continuous drift.
 */
export function crossover(a: Genome, b: Genome, rng: Rng, report?: CrossoverReport): Genome {
  const child: Genome = { ...a };
  child.species = a.species;
  let blended = 0;

  for (const def of GENE_DEFS) {
    const key = def.key;
    if (key === 'brainSeed') {
      const takeA = rng.chance(0.5);
      child.brainSeed = takeA ? a.brainSeed : b.brainSeed;
      if (report) report.origin[key] = takeA ? 0 : 1;
      continue;
    }
    const roll = rng.next();
    if (roll < 0.2) {
      // Blended inheritance.
      const mid = (a[key] + b[key]) * 0.5;
      const jitter = (b[key] - a[key]) * rng.range(-0.1, 0.1);
      child[key] = mid + jitter;
      blended++;
      if (report) report.origin[key] = 2;
    } else if (roll < 0.6) {
      child[key] = a[key];
      if (report) report.origin[key] = 0;
    } else {
      child[key] = b[key];
      if (report) report.origin[key] = 1;
    }
  }

  if (report) report.blendedGenes = blended;
  return sanitizeGenome(child);
}

export interface MutationOptions {
  /** Per-gene probability of a mutation. */
  rate?: number;
  /** Standard deviation of the perturbation, in normalised gene units. */
  strength?: number;
  /** Probability that a structural (brain re-wiring) mutation occurs. */
  structuralChance?: number;
}

/**
 * Mutate a genome in place and return a report.
 *
 * Perturbations are drawn in *normalised* gene space so that a 0.05 sigma means
 * the same thing for `bodySize` (span 0.62) and `lifespan` (span 64). Mutations
 * are symmetric — they can increase or decrease a trait — and are explicitly
 * not biased toward fitness.
 */
export function mutate(genome: Genome, rng: Rng, options: MutationOptions = {}): MutationReport {
  const rate = options.rate ?? 0.16;
  const strength = options.strength ?? 0.05;
  const structuralChance = options.structuralChance ?? 0.02;

  const mutated: GeneKey[] = [];
  let magnitude = 0;

  for (const def of GENE_DEFS) {
    const key = def.key;
    if (key === 'brainSeed') continue;
    if (!rng.chance(rate)) continue;
    const span = def.max - def.min;
    const delta = rng.normal(0, strength) * span;
    genome[key] = genome[key] + delta;
    mutated.push(key);
    magnitude += Math.abs(delta) / span;
  }

  // Structural mutation: re-wire the brain. Conservative for V0 — we perturb
  // the seed and slightly nudge connectivity genes.
  let structural = false;
  if (rng.chance(structuralChance)) {
    genome.brainSeed = (genome.brainSeed ^ rng.nextUint32()) >>> 0;
    genome.connDensity = genome.connDensity + rng.normal(0, 0.03);
    genome.excRatio = genome.excRatio + rng.normal(0, 0.012);
    structural = true;
    mutated.push('brainSeed', 'connDensity', 'excRatio');
  }

  sanitizeGenome(genome);

  if (mutated.length > 0) magnitude /= mutated.length;

  return { mutated, structural, magnitude };
}

/**
 * Produce a child genome from two parents.
 *
 * The returned report is stored on the newborn so the UI can show exactly what
 * was inherited from whom and what mutated — this is a core observability
 * feature, not a debug leftover.
 */
export interface InheritanceReport {
  motherGenes: number;
  fatherGenes: number;
  blendedGenes: number;
  mutatedGenes: GeneKey[];
  structuralMutation: boolean;
  mutationMagnitude: number;
  crossover: CrossoverReport;
}

export function reproduce(
  motherGenome: Genome,
  fatherGenome: Genome,
  rng: Rng,
  options: MutationOptions = {},
): { genome: Genome; report: InheritanceReport } {
  const crossoverReport: CrossoverReport = { origin: {}, blendedGenes: 0 };
  const child = crossover(motherGenome, fatherGenome, rng, crossoverReport);
  const mutationReport = mutate(child, rng, options);

  let motherGenes = 0;
  let fatherGenes = 0;
  for (const key of Object.keys(crossoverReport.origin) as GeneKey[]) {
    const origin = crossoverReport.origin[key];
    if (origin === 0) motherGenes++;
    else if (origin === 1) fatherGenes++;
  }

  return {
    genome: child,
    report: {
      motherGenes,
      fatherGenes,
      blendedGenes: crossoverReport.blendedGenes,
      mutatedGenes: mutationReport.mutated,
      structuralMutation: mutationReport.structural,
      mutationMagnitude: mutationReport.magnitude,
      crossover: crossoverReport,
    },
  };
}

export { isGenomeValid, sanitizeGenome };
