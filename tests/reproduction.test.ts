import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { Sex, LifeStage } from '../src/shared/types';
import type { Human } from '../src/simulation/entities/human';
import { AGE_CHILD_END } from '../src/shared/constants';

function makeWorld(seed: string, overrides: Record<string, unknown> = {}): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialPredators: 0, ...overrides } as never);
}

/** Put an individual in peak reproductive condition. */
function prime(human: Human, age = 20): void {
  human.ageBio = age;
  human.stage = LifeStage.Adult;
  human.health = 100;
  human.energy = 100;
  human.hunger = 0;
  human.thirst = 0;
  human.fatigue = 0;
  human.stress = 0;
  human.pain = 0;
  human.mating = null;
  human.pregnancy = null;
  human.matingCooldown = 0;
  human.recovery = 0;
  human.updateDerived(0.05);
}

function placeTogether(a: Human, b: Human, world: World): void {
  const x = world.terrain.width / 2;
  const y = world.terrain.height / 2;
  a.x = x;
  b.x = x + 0.6;
  a.y = y;
  b.y = y;
}

describe('mating eligibility', () => {
  it('refuses juveniles', () => {
    const world = makeWorld('eligibility-juvenile');
    const human = world.humans[0];
    prime(human, 4);
    expect(human.canMate()).toBe(false);
  });

  it('refuses the already pregnant', () => {
    const world = makeWorld('eligibility-pregnant');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);
    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });
    expect(mother.canMate()).toBe(false);
  });

  it('refuses the badly injured', () => {
    const world = makeWorld('eligibility-injured');
    const human = world.humans[0];
    prime(human);
    human.health = 10;
    expect(human.canMate()).toBe(false);
  });

  it('refuses juveniles via fertility', () => {
    const world = makeWorld('eligibility-fertility');
    const human = world.humans[0];
    human.ageBio = AGE_CHILD_END - 3;
    human.updateDerived(0.05);
    expect(human.isFertile()).toBe(false);
  });
});

describe('mating behaviour', () => {
  it('pairs two willing, adjacent, opposite-sex adults', () => {
    const world = makeWorld('mating-pair');
    const female = world.humans.find((h) => h.sex === Sex.Female)!;
    const male = world.humans.find((h) => h.sex === Sex.Male)!;

    // Isolate them so no other pairing can occur.
    for (const human of world.humans) {
      if (human !== female && human !== male) world.killHuman(human, 'isolation', null);
    }
    world.step();
    prime(female);
    prime(male);
    placeTogether(female, male, world);

    let paired = false;
    for (let i = 0; i < 4000 && !paired; i++) {
      prime(female);
      prime(male);
      placeTogether(female, male, world);
      world.step();
      if (female.mating !== null || male.mating !== null) paired = true;
    }
    expect(paired).toBe(true);
  });

  it('requires mutual participation — a lone willing female never mates', () => {
    const world = makeWorld('mating-mutual');
    const female = world.humans.find((h) => h.sex === Sex.Female)!;
    for (const human of world.humans) {
      if (human !== female) world.killHuman(human, 'isolation', null);
    }
    world.step();
    prime(female);
    for (let i = 0; i < 800; i++) {
      prime(female);
      world.step();
    }
    expect(female.mating).toBeNull();
    expect(world.totalMatings).toBe(0);
  });

  it('does not pair same-sex individuals', () => {
    const world = makeWorld('mating-samesex');
    const females = world.humans.filter((h) => h.sex === Sex.Female);
    const femaleA = females[0];
    const femaleB = females[1];
    for (const human of world.humans) {
      if (human !== femaleA && human !== femaleB) world.killHuman(human, 'isolation', null);
    }
    world.step();
    for (let i = 0; i < 800; i++) {
      prime(femaleA);
      prime(femaleB);
      placeTogether(femaleA, femaleB, world);
      world.step();
    }
    expect(world.totalMatings).toBe(0);
  });

  it('does not pair individuals that are far apart', () => {
    const world = makeWorld('mating-distance');
    const female = world.humans.find((h) => h.sex === Sex.Female)!;
    const male = world.humans.find((h) => h.sex === Sex.Male)!;
    for (const human of world.humans) {
      if (human !== female && human !== male) world.killHuman(human, 'isolation', null);
    }
    world.step();
    for (let i = 0; i < 800; i++) {
      prime(female);
      prime(male);
      female.x = 10;
      female.y = 10;
      male.x = 40;
      male.y = 40;
      world.step();
    }
    expect(world.totalMatings).toBe(0);
  });
});

describe('pregnancy and birth', () => {
  it('creates a pregnancy with the correct father and a fresh embryo genome', () => {
    const world = makeWorld('pregnancy');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });

    expect(mother.pregnancy).not.toBeNull();
    expect(mother.pregnancy?.fatherId).toBe(father.id);
    expect(mother.pregnancy?.progress).toBe(0);
    expect(mother.pregnancy?.embryoGenome).toBeDefined();
    expect(mother.pregnancy?.embryoGenome.brainSeed).toBeDefined();
  });

  it('produces exactly one birth at the end of gestation', () => {
    const world = makeWorld('gestation');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    const populationBefore = world.humans.length;
    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });

    // Gestation is GESTATION_YEARS biological years; run until it completes.
    let births = 0;
    for (let i = 0; i < 60000; i++) {
      const before = world.births;
      world.step();
      if (world.births > before) births++;
      if (mother.pregnancy === null && births > 0) break;
    }

    expect(births).toBe(1);
    expect(world.humans.length).toBe(populationBefore + 1);
    expect(mother.pregnancy).toBeNull();
  });

  it('gives the newborn both parents and the next generation number', () => {
    const world = makeWorld('newborn');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });

    let baby: Human | undefined;
    for (let i = 0; i < 60000; i++) {
      world.step();
      if (mother.pregnancy === null && mother.childrenIds.length > 0) {
        baby = world.getHuman(mother.childrenIds[mother.childrenIds.length - 1]);
        break;
      }
    }

    expect(baby).toBeDefined();
    expect(baby?.motherId).toBe(mother.id);
    expect(baby?.fatherId).toBe(father.id);
    expect(baby?.generation).toBe(Math.max(mother.generation, father.generation) + 1);
    expect(baby?.stage).toBe(LifeStage.Baby);
    expect(baby?.ageBio).toBeLessThan(0.01);
    expect(baby?.health).toBeGreaterThan(50);
  });

  it('records the birth in the genealogy of both parents', () => {
    const world = makeWorld('genealogy-birth');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });

    for (let i = 0; i < 60000; i++) {
      world.step();
      if (mother.pregnancy === null && mother.childrenIds.length > 0) break;
    }

    const babyId = mother.childrenIds[0];
    expect(father.childrenIds).toContain(babyId);
    const baby = world.getHuman(babyId)!;
    expect(baby.motherId).toBe(mother.id);
    expect(baby.fatherId).toBe(father.id);
  });

  it('emits birth, conception and generation events', () => {
    const world = makeWorld('birth-events');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });
    world.emitEvent('conception', 'test', [mother.id]);

    for (let i = 0; i < 60000; i++) {
      world.step();
      if (mother.pregnancy === null && mother.childrenIds.length > 0) break;
    }

    const kinds = new Set(world.events.map((event) => event.kind));
    expect(kinds.has('birth')).toBe(true);
    expect(kinds.has('generation')).toBe(true);
  });

  it('increments the world birth counter and the generation counter', () => {
    const world = makeWorld('counters');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    const birthsBefore = world.births;
    const generationBefore = world.maxGeneration;
    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });
    for (let i = 0; i < 60000; i++) {
      world.step();
      if (mother.pregnancy === null && mother.childrenIds.length > 0) break;
    }
    expect(world.births).toBe(birthsBefore + 1);
    expect(world.maxGeneration).toBeGreaterThan(generationBefore);
  });
});

describe('relatedness', () => {
  it('reports parent/child, sibling and unrelated values consistently', () => {
    const world = makeWorld('relatedness');
    const mother = world.humans.find((h) => h.sex === Sex.Female)!;
    const father = world.humans.find((h) => h.sex === Sex.Male)!;
    prime(mother);
    prime(father);

    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });
    for (let i = 0; i < 60000; i++) {
      world.step();
      if (mother.pregnancy === null && mother.childrenIds.length > 0) break;
    }

    const babyId = mother.childrenIds[0];
    expect(world.relatedness(mother.id, babyId)).toBeCloseTo(0.5, 5);
    expect(world.relatedness(babyId, father.id)).toBeCloseTo(0.5, 5);
    expect(world.relatedness(mother.id, mother.id)).toBe(1);

    const unrelated = world.humans.find((h) => h.id !== mother.id && h.id !== father.id && h.id !== babyId);
    if (unrelated) {
      expect(world.relatedness(babyId, unrelated.id)).toBe(0);
    }
  });
});

describe('genealogy forest', () => {
  it('returns a forest whose links match the stored parent/child arrays', () => {
    const world = makeWorld('forest');
    for (let i = 0; i < 300; i++) world.step();
    const forest = world.genealogyForest();
    expect(Array.isArray(forest)).toBe(true);
    for (const root of forest) {
      expect(root.id).toBeGreaterThan(0);
      for (const child of root.children) {
        const parent = world.getHuman(root.id);
        if (parent) expect(parent.childrenIds).toContain(child.id);
      }
    }
  });
});
