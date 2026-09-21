import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  unwrapSave,
  wrapSave,
} from '../src/simulation/persistence/save';

function makeWorld(seed: string, overrides: Record<string, unknown> = {}): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, ...overrides } as never);
}

function summarise(world: World): string {
  return JSON.stringify({
    tick: world.tick,
    simTime: world.simTime,
    humans: world.humans.map((h) => ({
      id: h.id,
      name: h.name,
      x: Number(h.x.toFixed(4)),
      y: Number(h.y.toFixed(4)),
      health: Number(h.health.toFixed(3)),
      hunger: Number(h.hunger.toFixed(3)),
      age: Number(h.ageBio.toFixed(4)),
      gen: h.generation,
      mother: h.motherId,
      father: h.fatherId,
      children: h.childrenIds,
      w0: Number((h.brain.w[0] ?? 0).toFixed(5)),
    })),
    predators: world.predators.map((p) => ({ id: p.id, x: Number(p.x.toFixed(4)) })),
    plantCount: world.plants.length,
    births: world.births,
    deaths: world.deaths,
    maxGeneration: world.maxGeneration,
  });
}

describe('save schema', () => {
  it('wraps and unwraps a versioned envelope', () => {
    const payload = JSON.stringify({ hello: 'world' });
    const text = wrapSave(payload, 'seed-x', 42, 2.1);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.format).toBe(SAVE_FORMAT);
    expect(parsed.version).toBe(SAVE_VERSION);
    expect(parsed.seed).toBe('seed-x');
    expect(parsed.tick).toBe(42);

    const result = unwrapSave(text);
    expect(result.ok).toBe(true);
    expect(result.payload).toBe(payload);
  });

  it('rejects files that are not EDEN//0 saves', () => {
    expect(unwrapSave('not json').ok).toBe(false);
    expect(unwrapSave('{"format":"other"}').ok).toBe(false);
  });

  it('rejects a save from a newer schema version', () => {
    const text = JSON.stringify({
      format: SAVE_FORMAT,
      version: SAVE_VERSION + 5,
      payload: {},
    });
    const result = unwrapSave(text);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('newer');
  });
});

describe('save / load equivalence', () => {
  it('continues identically after a round trip through JSON', () => {
    const original = makeWorld('save-load', { initialPredators: 2 });
    for (let i = 0; i < 800; i++) original.step();

    const envelope = wrapSave(
      JSON.stringify(original.serialize()),
      original.seed,
      original.tick,
      original.simTime,
    );
    const result = unwrapSave(envelope);
    expect(result.ok).toBe(true);

    const restored = World.deserialize(JSON.parse(result.payload!));
    expect(summarise(restored)).toBe(summarise(original));

    // Both worlds must now evolve in lockstep.
    for (let i = 0; i < 500; i++) {
      original.step();
      restored.step();
    }
    expect(summarise(restored)).toBe(summarise(original));
  });

  it('preserves learned weights', () => {
    const original = makeWorld('save-weights');
    for (let i = 0; i < 2000; i++) original.step();

    const human = original.humans[0];
    const drift = human.brain.weightDrift();
    expect(drift).toBeGreaterThan(0);

    const restored = World.deserialize(JSON.parse(JSON.stringify(original.serialize())));
    const restoredHuman = restored.getHuman(human.id)!;
    expect(restoredHuman.brain.synCount).toBe(human.brain.synCount);
    expect(Array.from(restoredHuman.brain.w)).toEqual(Array.from(human.brain.w));
    expect(restoredHuman.brain.weightDrift()).toBeCloseTo(drift, 6);
  });

  it('preserves pregnancy state', () => {
    const world = makeWorld('save-pregnancy');
    const mother = world.humans.find((h) => h.sex === 0)!;
    const father = world.humans.find((h) => h.sex === 1)!;
    mother.ageBio = 20;
    father.ageBio = 20;
    mother.health = 100;
    father.health = 100;
    mother.conceive(father, world, father.genome, {
      motherGenes: 0,
      fatherGenes: 0,
      blendedGenes: 0,
      mutatedGenes: [],
      structuralMutation: false,
      mutationMagnitude: 0,
      crossover: { origin: {}, blendedGenes: 0 },
    });
    for (let i = 0; i < 400; i++) world.step();

    const restored = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
    const restoredMother = restored.getHuman(mother.id)!;
    expect(restoredMother.pregnancy).not.toBeNull();
    expect(restoredMother.pregnancy?.fatherId).toBe(father.id);
    expect(restoredMother.pregnancy?.progress).toBeCloseTo(mother.pregnancy!.progress, 8);
  });

  it('preserves social memory and genealogy', () => {
    const world = makeWorld('save-social');
    for (let i = 0; i < 1500; i++) world.step();
    const human = world.humans[0];
    const memoryBefore = human.memory.entries().map((entry) => entry.id).sort();

    const restored = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
    const restoredHuman = restored.getHuman(human.id)!;
    const memoryAfter = restoredHuman.memory.entries().map((entry) => entry.id).sort();
    expect(memoryAfter).toEqual(memoryBefore);
    expect(restoredHuman.childrenIds).toEqual(human.childrenIds);
    expect(restoredHuman.motherId).toBe(human.motherId);
  });

  it('preserves the environment and the event log', () => {
    const world = makeWorld('save-environment');
    world.setTemperatureOffset(7.5);
    world.setTimeOfDay(0.7);
    for (let i = 0; i < 600; i++) world.step();

    const restored = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
    expect(restored.climate.globalOffset).toBeCloseTo(7.5, 6);
    expect(restored.climate.dayPhase).toBeCloseTo(world.climate.dayPhase, 6);
    expect(restored.plants.length).toBe(world.plants.length);
    expect(restored.events.length).toBe(world.events.length);
  });

  it('preserves the PRNG stream so future randomness matches', () => {
    const world = makeWorld('save-rng');
    for (let i = 0; i < 300; i++) world.step();
    const restored = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
    expect(restored.rng.getState()).toEqual(world.rng.getState());
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 25; i++) {
      a.push(world.random());
      b.push(restored.random());
    }
    expect(b).toEqual(a);
  });
});
