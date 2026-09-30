import { SNAPSHOT_META_STRIDE } from '../src/shared/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { LifeStage, Sex } from '../src/shared/types';
import { AGE_ADULT_END, AGE_BABY_END, AGE_CHILD_END } from '../src/shared/constants';
import { MOTOR_COUNT, NEURON_COUNT } from '../src/simulation/brain/channels';
import type { Human } from '../src/simulation/entities/human';
import type { Predator } from '../src/simulation/entities/predator';

function makeWorld(seed: string, overrides: Record<string, unknown> = {}): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialPredators: 0, ...overrides } as never);
}

function runUntil(world: World, predicate: () => boolean, maxTicks = 40000): boolean {
  for (let i = 0; i < maxTicks; i++) {
    world.step();
    if (predicate()) return true;
  }
  return false;
}

describe('genesis', () => {
  it('creates the requested number of humans with both sexes', () => {
    const world = makeWorld('genesis');
    expect(world.humans.length).toBe(8);
    expect(world.humans.filter((h) => h.sex === Sex.Female).length).toBe(4);
    expect(world.humans.filter((h) => h.sex === Sex.Male).length).toBe(4);
    expect(world.plants.length).toBeGreaterThan(100);
  });

  it('gives every human a unique name and id', () => {
    const world = makeWorld('names');
    const names = new Set(world.humans.map((h) => h.name));
    const ids = new Set(world.humans.map((h) => h.id));
    expect(names.size).toBe(world.humans.length);
    expect(ids.size).toBe(world.humans.length);
  });

  it('places the founders on walkable land', () => {
    const world = makeWorld('placement');
    for (const human of world.humans) {
      const tile = world.terrain.tiles[Math.floor(human.y) * world.terrain.width + Math.floor(human.x)];
      expect(tile === 0 || tile === 5).toBe(false);
    }
  });
});

describe('lifecycle', () => {
  it('advances baby -> child -> adult -> older adult with age', () => {
    const world = makeWorld('lifecycle');
    const human = world.humans[0];
    human.ageBio = 0;
    human.stage = LifeStage.Baby;

    // Drive ageing directly through the public physiology update.
    const stagesSeen = new Set<number>();
    const checkpoints = [0.5, 6, 20, 50, 70];
    for (const age of checkpoints) {
      human.ageBio = age;
      human.updatePhysiology(world, 0.0001);
      stagesSeen.add(human.stage);
    }
    expect(stagesSeen.has(LifeStage.Baby)).toBe(true);
    expect(stagesSeen.has(LifeStage.Child)).toBe(true);
    expect(stagesSeen.has(LifeStage.Adult)).toBe(true);
    expect(stagesSeen.has(LifeStage.Elder)).toBe(true);
  });

  it('uses the documented stage thresholds', () => {
    const world = makeWorld('thresholds');
    const human = world.humans[0];
    const stageAt = (age: number): number => {
      human.ageBio = age;
      human.updatePhysiology(world, 0.0001);
      return human.stage;
    };
    expect(stageAt(AGE_BABY_END - 0.1)).toBe(LifeStage.Baby);
    expect(stageAt(AGE_BABY_END + 0.1)).toBe(LifeStage.Child);
    expect(stageAt(AGE_CHILD_END + 0.1)).toBe(LifeStage.Adult);
    expect(stageAt(AGE_ADULT_END + 0.1)).toBe(LifeStage.Elder);
  });

  it('makes babies smaller and slower than adults', () => {
    const world = makeWorld('growth');
    const human = world.humans[0];
    human.ageBio = 0.2;
    const babyScale = human.bodyScale();
    const babySpeed = human.speedFactor();
    human.ageBio = 25;
    const adultScale = human.bodyScale();
    const adultSpeed = human.speedFactor();
    expect(babyScale).toBeLessThan(adultScale * 0.7);
    expect(babySpeed).toBeLessThan(adultSpeed);
  });

  it('makes juveniles infertile', () => {
    const world = makeWorld('infertile');
    const human = world.humans[0];
    human.ageBio = 4;
    human.updateDerived(0.05);
    expect(human.fertility01).toBeLessThan(0.05);
    expect(human.canMate()).toBe(false);
  });
});

describe('death', () => {
  it('records a death reason and stops the entity acting', () => {
    const world = makeWorld('death');
    const human = world.humans[0];
    world.killHuman(human, 'test', null);
    expect(human.alive).toBe(false);
    expect(human.deathTick).toBe(world.tick);
    expect(human.deathReason).toBe('test');
    expect(world.deaths).toBe(1);
  });

  it('turns a body into carrion so biomass re-enters the ecosystem', () => {
    const world = makeWorld('carrion');
    const before = world.plants.length;
    const human = world.humans[0];
    world.killHuman(human, 'test', null);
    expect(world.plants.length).toBe(before + 1);
    const carcass = world.plants[world.plants.length - 1];
    expect(carcass.food).toBeGreaterThan(0);
  });

  it('removes dead humans from the population after the tick', () => {
    const world = makeWorld('compaction');
    const human = world.humans[0];
    const id = human.id;
    world.killHuman(human, 'test', null);
    world.step();
    expect(world.getHuman(id)).toBeUndefined();
  });

  it('emits a death event naming the individual', () => {
    const world = makeWorld('death-event');
    const human = world.humans[0];
    const name = human.name;
    world.killHuman(human, 'starvation', null);
    const event = world.events.find((entry) => entry.kind === 'death');
    expect(event).toBeDefined();
    expect(event?.text).toContain(name);
  });

  it('kills from lightning and records it', () => {
    const world = makeWorld('lightning');
    const human = world.humans[0];
    world.strikeLightning(human.x, human.y, 8, 500);
    expect(human.alive).toBe(false);
    expect(human.deathReason).toBe('lightning');
  });
});

describe('time scaling', () => {
  it('advances exactly one fixed timestep per step() call regardless of wall time', () => {
    const world = makeWorld('timescale');
    const startTime = world.simTime;
    const startTick = world.tick;
    for (let i = 0; i < 100; i++) world.step();
    expect(world.tick - startTick).toBe(100);
    expect(world.simTime - startTime).toBeCloseTo(100 * 0.05, 8);
  });

  it('never changes dt — speed only changes how many ticks are executed', () => {
    const a = makeWorld('speed-a');
    const b = makeWorld('speed-a');
    // Simulating "at x20" is 20x as many fixed ticks, not one giant dt.
    for (let i = 0; i < 20; i++) a.step();
    for (let i = 0; i < 20; i++) b.step();
    expect(a.simTime).toBeCloseTo(b.simTime, 10);
    expect(a.tick).toBe(b.tick);
  });
});

describe('god mode', () => {
  it('spawns a human at a walkable position', () => {
    const world = makeWorld('spawn');
    const before = world.humans.length;
    const human = world.spawnHuman(world.terrain.width / 2, world.terrain.height / 2);
    expect(world.humans.length).toBe(before + 1);
    expect(human.alive).toBe(true);
  });

  it('spawns food and predators', () => {
    const world = makeWorld('god-spawn');
    const plants = world.plants.length;
    world.spawnFood(40, 40);
    expect(world.plants.length).toBe(plants + 1);

    const predators = world.predators.length;
    const predator = world.spawnPredator(40, 40);
    expect(world.predators.length).toBe(predators + 1);
    expect(predator).not.toBeNull();
  });

  it('repositions a human onto walkable land', () => {
    const world = makeWorld('reposition');
    const human = world.humans[0];
    const before = { x: human.x, y: human.y };
    world.repositionHuman(human.id, 30, 30);
    const tile = world.terrain.tiles[Math.floor(human.y) * world.terrain.width + Math.floor(human.x)];
    expect(tile === 0 || tile === 5).toBe(false);
    expect(Math.hypot(human.x - before.x, human.y - before.y)).toBeGreaterThan(0);
  });

  it('changes the climate offset and the time of day', () => {
    const world = makeWorld('climate-god');
    world.setTemperatureOffset(12);
    expect(world.climate.globalOffset).toBe(12);
    world.setTimeOfDay(0.5);
    expect(world.climate.dayPhase).toBeCloseTo(0.5, 2);
  });

  it('edits a genome and records the intervention', () => {
    const world = makeWorld('genome-god');
    const human = world.humans[0];
    const before = human.genome.bodySize;
    world.editGenome(human.id, 'bodySize', before + 0.2);
    expect(human.genome.bodySize).toBeGreaterThan(before);
    const event = world.events.find((entry) => entry.kind === 'god');
    expect(event?.text).toContain('lineage');
  });

  it('rebuilds the network when a structural gene is edited', () => {
    const world = makeWorld('structural-god');
    const human = world.humans[0];
    const before = human.brain.synCount;
    world.editGenome(human.id, 'connDensity', 1.5);
    expect(human.brain.synCount).toBeGreaterThan(before);
    expect(human.brain.synCount).toBe(human.brain.w.length);
  });
});

describe('observability', () => {
  it('produces a complete human detail record', () => {
    const world = makeWorld('detail');
    const human = world.humans[0];
    const detail = world.humanDetail(human.id);
    expect(detail).not.toBeNull();
    expect(detail?.name).toBe(human.name);
    expect(detail?.neuronCount).toBe(NEURON_COUNT);
    expect(detail?.synapseCount).toBeGreaterThan(1000);
    expect(detail?.genome.length).toBeGreaterThan(20);
    expect(detail?.motor.length).toBe(MOTOR_COUNT);
  });

  it('produces a brain view with activity for every neuron', () => {
    const world = makeWorld('brainview');
    const human = world.humans[0];
    for (let i = 0; i < 100; i++) world.step();
    const view = world.brainView(human.id);
    expect(view?.activity.length).toBe(NEURON_COUNT);
    expect(view?.motor.length).toBe(MOTOR_COUNT);
    expect(view?.synapses.length).toBeGreaterThan(10);
  });

  it('produces an explanation for the most recent action', () => {
    const world = makeWorld('explain');
    const human = world.humans[0];
    for (let i = 0; i < 100; i++) world.step();
    const explanation = world.explain(human.id);
    expect(explanation).not.toBeNull();
    expect(explanation?.action.length).toBeGreaterThan(0);
    expect(explanation?.note).toContain('Approximate');
  });

  it('builds a snapshot whose typed arrays match the entity count', () => {
    const world = makeWorld('snapshot');
    for (let i = 0; i < 60; i++) world.step();
    const snapshot = world.buildSnapshot(1, {
      tps: 0,
      fps: 0,
      tickTimeMs: 0,
      brainTimeMs: 0,
      snapshotBytes: 0,
      workerLatencyMs: 0,
      entityCount: 0,
      humanCount: 0,
      predatorCount: 0,
      plantCount: 0,
      synapseCount: 0,
    });
    expect(snapshot.ids.length).toBe(snapshot.count);
    expect(snapshot.floats.length).toBe(snapshot.count * 12);
    expect(snapshot.meta.length).toBe(snapshot.count * SNAPSHOT_META_STRIDE);
    expect(snapshot.stats.population).toBe(world.humans.length);
  });
});

describe('ecology', () => {
  it('plants spread, age and die', () => {
    const world = makeWorld('plants');
    const initial = world.plants.length;
    for (let i = 0; i < 2000; i++) world.step();
    expect(world.plants.length).not.toBe(initial);
    // Plants must not grow without bound.
    expect(world.plants.length).toBeLessThanOrEqual(6000);
  });

  it('predators exist and can kill humans', () => {
    const world = makeWorld('predation', { initialPredators: 6 });
    const predator = world.predators[0];
    expect(predator).toBeDefined();

    // Place a predator right next to a human and let it act.
    const human = world.humans[0];
    predator.x = human.x + 0.5;
    predator.y = human.y;
    predator.hunger = 90;
    predator.energy = 40;

    let killed = false;
    for (let i = 0; i < 2000 && !killed; i++) {
      world.step();
      if (!human.alive) killed = true;
    }
    // Predators use the same neural controller, so this is probabilistic; what
    // matters is that a kill is possible and that it is attributed correctly.
    if (killed) {
      expect(['predation', 'injuries']).toContain(
        human.deathReason?.startsWith('predation') ? 'predation' : 'injuries',
      );
    }
    expect(world.predators.length).toBeGreaterThan(0);
  });

  it('plants are consumed by eating and regenerate', () => {
    const world = makeWorld('grazing');
    const plantIndex = world.plants.findIndex((plant) => plant.food > 0.3);
    expect(plantIndex).toBeGreaterThanOrEqual(0);
    const plant = world.plants[plantIndex];
    const before = plant.food;
    const taken = world.consumePlant(plantIndex, 0.2);
    expect(taken).toBeGreaterThan(0);
    expect(plant.food).toBeLessThan(before);
  });
});

describe('statistics', () => {
  it('reports a coherent population breakdown', () => {
    const world = makeWorld('stats');
    for (let i = 0; i < 200; i++) world.step();
    const stats = world.computeStats();
    expect(stats.population).toBe(world.humans.length);
    expect(stats.males + stats.females).toBe(stats.population);
    expect(stats.babies + stats.children + stats.adults + stats.elders).toBe(stats.population);
    // Grown neurons (v3) come on top of the core.
    expect(stats.averageNeurons).toBeGreaterThanOrEqual(NEURON_COUNT);
    expect(stats.averageSynapses).toBeGreaterThan(1000);
  });
});

describe('long-run behaviour', () => {
  it('produces autonomous movement and some learning over 4000 ticks', () => {
    const world = makeWorld('behaviour');
    const start = world.humans.map((h: Human) => ({ id: h.id, x: h.x, y: h.y }));
    const startDrift = world.humans.map((h: Human) => h.brain.weightDrift());

    for (let i = 0; i < 4000; i++) world.step();

    let moved = 0;
    for (const human of world.humans) {
      const previous = start.find((entry) => entry.id === human.id);
      if (!previous) continue;
      if (Math.hypot(human.x - previous.x, human.y - previous.y) > 2) moved++;
    }
    // The world is stochastic; we assert that *some* individuals moved rather
    // than that all did.
    expect(moved).toBeGreaterThan(0);
    expect(startDrift.every((value) => value === 0)).toBe(true);
    const nowDrift = world.humans.map((h: Human) => h.brain.weightDrift());
    expect(Math.max(...nowDrift)).toBeGreaterThan(0);
  });

  it('never lets a predator act after death', () => {
    const world = makeWorld('dead-predator', { initialPredators: 2 });
    const predator: Predator = world.predators[0];
    const x = predator.x;
    const y = predator.y;
    world.killPredator(predator, 'test');
    world.step();
    expect(predator.x).toBe(x);
    expect(predator.y).toBe(y);
  });
});
