import { describe, expect, it } from 'vitest';
import { Rng } from '../src/simulation/rng';
import {
  GENE_DEFS,
  cloneGenome,
  geneDef,
  genomeDistance,
  isGenomeValid,
  randomGenome,
  type Genome,
} from '../src/simulation/genetics/genome';
import { crossover, mutate, reproduce } from '../src/simulation/genetics/evolution';

describe('genome', () => {
  it('generates valid founder genomes', () => {
    const rng = new Rng('founders');
    for (let i = 0; i < 200; i++) {
      expect(isGenomeValid(randomGenome(rng, 0))).toBe(true);
      expect(isGenomeValid(randomGenome(rng, 1))).toBe(true);
    }
  });

  it('declares a valid range for every gene', () => {
    for (const def of GENE_DEFS) {
      expect(def.max).toBeGreaterThan(def.min);
      expect(def.step).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(10);
    }
  });
});

describe('crossover', () => {
  it('takes traits from both parents', () => {
    const rng = new Rng('crossover');
    const a = randomGenome(rng, 0);
    const b = randomGenome(rng, 0);
    // Make the parents maximally distinguishable.
    for (const def of GENE_DEFS) {
      if (def.key === 'brainSeed') continue;
      a[def.key] = def.min;
      b[def.key] = def.max;
    }

    let fromMother = 0;
    let fromFather = 0;
    const trials = 40;
    for (let t = 0; t < trials; t++) {
      const child = crossover(a, b, rng);
      let motherGenes = 0;
      let fatherGenes = 0;
      for (const def of GENE_DEFS) {
        if (def.key === 'brainSeed') continue;
        const span = def.max - def.min;
        const value = child[def.key];
        const nearMother = Math.abs(value - def.min) < span * 0.3;
        const nearFather = Math.abs(value - def.max) < span * 0.3;
        if (nearMother && !nearFather) motherGenes++;
        if (nearFather && !nearMother) fatherGenes++;
      }
      expect(motherGenes).toBeGreaterThan(0);
      expect(fatherGenes).toBeGreaterThan(0);
      fromMother += motherGenes;
      fromFather += fatherGenes;
    }
    // Over many trials the two parents should contribute comparably.
    const ratio = fromMother / (fromMother + fromFather);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.7);
  });

  it('inherits a brain seed from one of the parents', () => {
    const rng = new Rng('seed-inherit');
    const a = randomGenome(rng, 0);
    const b = randomGenome(rng, 0);
    for (let i = 0; i < 30; i++) {
      const child = crossover(a, b, rng);
      expect([a.brainSeed, b.brainSeed]).toContain(child.brainSeed);
    }
  });
});

describe('mutation', () => {
  it('keeps every gene inside its declared bounds across many generations', () => {
    const rng = new Rng('mutation-bounds');
    let genome: Genome = randomGenome(rng, 0);
    for (let generation = 0; generation < 400; generation++) {
      mutate(genome, rng, { rate: 0.25, strength: 0.09, structuralChance: 0.05 });
      expect(isGenomeValid(genome)).toBe(true);
      for (const def of GENE_DEFS) {
        const value = genome[def.key];
        expect(value).toBeGreaterThanOrEqual(def.min);
        expect(value).toBeLessThanOrEqual(def.max);
        if (def.integer) expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it('changes genes in both directions over time (not always beneficial)', () => {
    const rng = new Rng('mutation-direction');
    const start = randomGenome(rng, 0);
    let increases = 0;
    let decreases = 0;
    let current = cloneGenome(start);
    for (let i = 0; i < 300; i++) {
      const before = current.bodySize;
      mutate(current, rng, { rate: 1, strength: 0.05 });
      if (current.bodySize > before) increases++;
      if (current.bodySize < before) decreases++;
    }
    expect(increases).toBeGreaterThan(50);
    expect(decreases).toBeGreaterThan(50);
  });

  it('can perform structural mutation that re-wires the brain seed', () => {
    const rng = new Rng('structural');
    let structural = 0;
    let genome = randomGenome(rng, 0);
    const originalSeed = genome.brainSeed;
    for (let i = 0; i < 200; i++) {
      const report = mutate(genome, rng, { rate: 0, strength: 0, structuralChance: 0.2 });
      if (report.structural) structural++;
    }
    expect(structural).toBeGreaterThan(10);
    expect(genome.brainSeed).not.toBe(originalSeed);
  });

  it('produces an inheritance report naming which genes mutated', () => {
    const rng = new Rng('inherit-report');
    const mother = randomGenome(rng, 0);
    const father = randomGenome(rng, 0);
    const { genome, report } = reproduce(mother, father, rng);
    expect(isGenomeValid(genome)).toBe(true);
    expect(report.motherGenes + report.fatherGenes + report.blendedGenes).toBeGreaterThan(0);
    for (const key of report.mutatedGenes) {
      expect(geneDef(key)).toBeDefined();
    }
  });

  it('increases genetic distance from the parents over generations', () => {
    const rng = new Rng('drift');
    let a = randomGenome(rng, 0);
    let b = randomGenome(rng, 0);
    const ancestorA = cloneGenome(a);
    for (let generation = 0; generation < 60; generation++) {
      const { genome } = reproduce(a, b, rng, { rate: 0.25, strength: 0.06, structuralChance: 0.03 });
      b = a;
      a = genome;
    }
    expect(genomeDistance(a, ancestorA)).toBeGreaterThan(0.02);
  });
});
