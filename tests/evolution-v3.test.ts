import { describe, expect, it } from 'vitest';
import { ageOf, AGE_TRAITS } from '../src/simulation/game/ages';
import { findDivergence, lookOf, describeLook, type Member } from '../src/simulation/game/peoples';
import { DEFAULT_RULES } from '../src/simulation/game/laws';
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { randomGenome } from '../src/simulation/genetics/genome';
import { Rng } from '../src/simulation/rng';
import { readLooks } from '../src/render/morph';
import { RULES_OF_CREATION } from '../src/simulation/genesis/rules';
import { YEAR_SECONDS } from '../src/simulation/game/calendar';

describe('ages', () => {
  it('are generated from the seed alone, and differ between worlds', () => {
    expect(ageOf('eden', 5, 20)).toEqual(ageOf('eden', 5, 20));
    const names = new Set([2, 3, 4, 5, 6, 7].map((i) => ageOf('eden', i).trait.id + ageOf('orion', i).trait.id));
    expect(names.size).toBeGreaterThan(1);
    expect(ageOf('eden', 1).trait.id).toBe('dawn');
  });

  it('every trait keeps the rules finite and sane at full strength', () => {
    for (const trait of AGE_TRAITS) {
      const rules = { ...DEFAULT_RULES, crisisWeights: {} };
      trait.apply(rules, 1.4);
      for (const [key, value] of Object.entries(rules)) {
        if (typeof value === 'number') expect(Number.isFinite(value), `${trait.id}.${key}`).toBe(true);
      }
      expect(rules.crisisFrequency).toBeGreaterThan(0);
      expect(rules.thirstRate).toBeLessThan(1.1);
    }
  });

  it('a world moves into its second age after a year, and the age leans on the base rules without compounding', () => {
    const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed: 'ages', initialPredators: 0 });
    const base = { ...world.rules };
    // Skip to the end of the first year rather than simulate all of it.
    world.simTime = YEAR_SECONDS - 1;
    for (let i = 0; i < 220 && world.age.index < 2; i++) world.step();
    expect(world.age.index).toBe(2);
    const expected = { ...base, crisisWeights: { ...base.crisisWeights } };
    world.age.trait.apply(expected, world.age.intensity);
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (typeof expected[key] === 'number') expect(world.rules[key]).toBeCloseTo(expected[key] as number, 9);
    }
    const copy = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
    expect(copy.age.index).toBe(2);
    expect(copy.rules.plantRegen).toBeCloseTo(world.rules.plantRegen, 9);
    expect(copy.age.omen).toEqual(world.age.omen);
  });
});

describe('peoples', () => {
  const member = (id: number, x: number, y: number): Member => ({ id, x, y, look: new Array(11).fill(0.5) });

  it('a people living in one place does not split', () => {
    const members = Array.from({ length: 16 }, (_, i) => member(i, 40 + (i % 4) * 2, 40 + Math.floor(i / 4) * 2));
    expect(findDivergence(members)).toBeNull();
  });

  it('a group that has settled far away becomes its own', () => {
    const home = Array.from({ length: 12 }, (_, i) => member(i, 40 + (i % 4), 40 + Math.floor(i / 4)));
    const away = Array.from({ length: 5 }, (_, i) => member(100 + i, 90 + i, 60));
    const split = findDivergence([...home, ...away]);
    expect(split).not.toBeNull();
    expect(split!.leaving.sort()).toEqual([100, 101, 102, 103, 104]);
  });

  it('founders are one people and share a look; looks are described in words', () => {
    const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed: 'peoples', initialPredators: 0 });
    expect(world.peoples.length).toBe(1);
    expect(world.humans.every((h) => h.people === 1)).toBe(true);
    const hairs = world.humans.map((h) => h.genome.hairStyle);
    expect(Math.max(...hairs) - Math.min(...hairs)).toBeLessThan(0.6);
    expect(describeLook(lookOf(world.humans[0].genome)).length).toBeGreaterThan(3);
  });
});

describe('looks', () => {
  it('seven genes read into a figure; missing looks fall back to neutral', () => {
    const genome = randomGenome(new Rng('looks'), 0);
    genome.hairStyle = 0.7;
    genome.markings = 0.9;
    genome.ornament = 0.85;
    const bytes = ['build', 'headShape', 'hairStyle', 'hairHue', 'markings', 'markingHue', 'ornament'].map((k) =>
      Math.round((genome as unknown as Record<string, number>)[k] * 255),
    );
    const looks = readLooks(bytes);
    expect(looks.hairStyle).toBe('crested');
    expect(looks.paint).toBe('chevrons');
    expect(looks.ornament).toBe('horns');
    expect(readLooks(null).hairStyle).toBe('cropped');
  });
});

describe('rules of creation', () => {
  it('lists seven rules, each pointing at its code', () => {
    expect(RULES_OF_CREATION.length).toBe(7);
    for (const rule of RULES_OF_CREATION) expect(rule.code).toMatch(/src\//);
  });
});
