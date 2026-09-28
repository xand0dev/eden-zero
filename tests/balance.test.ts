import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { CANAL_SOURCE_RANGE, FieldStage, FIELD_YIELD } from '../src/simulation/entities/cultivation';
import { Tile } from '../src/simulation/environment/terrain';
import { DT, MAX_EVENTS } from '../src/shared/constants';
import {
  BalanceTally,
  buildRow,
  classifyOutcome,
  collectCultivation,
  summarize,
  UNATTRIBUTED,
  type BalanceRow,
  type RunConfig,
} from '../scripts/balance-metrics';

function makeWorld(seed: string, predators = 0): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialHumans: 8, initialPredators: predators });
}

/** Nearest grass tile to a point — the only ground a field can be broken on. */
function findGrass(world: World, nearX: number, nearY: number): { x: number; y: number } | null {
  const { tiles, width, height } = world.terrain;
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (tiles[y * width + x] !== Tile.Grass) continue;
      const distance = Math.hypot(x - nearX, y - nearY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  return best;
}

/** A diggable tile close enough to water that a finished canal will carry it. */
function findCanalSpot(world: World): { x: number; y: number } | null {
  const { tiles, width, height } = world.terrain;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tile = tiles[y * width + x];
      if (tile === Tile.Water || tile === Tile.Rock) continue;
      if (world.waterDistance[y * width + x] > CANAL_SOURCE_RANGE) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
  }
  return null;
}

/** Push a crop from sown to ripe without waiting on the weather. */
function ripen(world: World, index: number): void {
  const field = world.fields[index];
  field.growth = 0.99999;
  field.moisture = 1;
  field.update(DT, true);
}

describe('cultivation metrics', () => {
  it('a fresh world has no fields, no canals and no harvest food', () => {
    const world = makeWorld('balance-fresh');
    const metrics = collectCultivation(world);
    expect(metrics).toMatchObject({
      fields: 0,
      sown: 0,
      ripe: 0,
      moist: 0,
      canals: 0,
      canalsComplete: 0,
      canalsFlowing: 0,
      foodPiles: 0,
      foodOnGround: 0,
    });
    // Wild forage is counted apart from piles, so a harvest is never confused with a bush.
    expect(metrics.wildFood).toBeGreaterThan(0);
  });

  it('follows one field through two full crop cycles, counting each harvest', () => {
    const world = makeWorld('balance-field');
    const tally = new BalanceTally(world);
    const human = world.humans[0];
    const grass = findGrass(world, world.settlementCentre!.x, world.settlementCentre!.y);
    expect(grass).not.toBeNull();

    const field = world.foundField(grass!.x, grass!.y, human);
    expect(field).not.toBeNull();
    let metrics = collectCultivation(world);
    expect(metrics.fields).toBe(1);
    // Broken ground is fallow, not sown. A field existing says nothing about a crop.
    expect(metrics.sown).toBe(0);
    tally.observe(world);
    expect(tally.sowings).toBe(0);

    for (let cycle = 1; cycle <= 2; cycle++) {
      expect(world.sowField(0, human)).toBe(true);
      tally.observe(world);
      expect(collectCultivation(world).sown).toBe(1);

      ripen(world, 0);
      tally.observe(world);
      metrics = collectCultivation(world);
      expect(metrics.sown).toBe(0);
      expect(metrics.ripe).toBe(1);

      expect(world.harvestField(0, human)).toBe(true);
      tally.observe(world);
      // Harvested ground goes back to fallow: the field persists, the crop does not.
      expect(field!.stage).toBe(FieldStage.Fallow);
      expect(tally.sowings).toBe(cycle);
      expect(tally.ripenings).toBe(cycle);
      expect(tally.harvests).toBe(cycle);
    }

    metrics = collectCultivation(world);
    // Repeated harvests of one field are two harvests, not two fields.
    expect(metrics.fields).toBe(1);
    expect(metrics.foodPiles).toBe(2);
    expect(metrics.foodOnGround).toBeCloseTo(2 * FIELD_YIELD, 5);
    expect(tally.eventsMissed).toBe(0);
  });

  it('reports a canal as staked, then complete, then flowing — separately', () => {
    const world = makeWorld('balance-canal');
    const tally = new BalanceTally(world);
    const human = world.humans[0];
    const spot = findCanalSpot(world);
    expect(spot).not.toBeNull();

    const canal = world.foundCanal(spot!.x, spot!.y, human);
    expect(canal).not.toBeNull();
    const index = world.canals.indexOf(canal!);
    let metrics = collectCultivation(world);
    expect(metrics.canals).toBe(1);
    // Half a canal is not a canal that waters anything.
    expect(metrics.canalsComplete).toBe(0);
    expect(metrics.canalsFlowing).toBe(0);

    for (let i = 0; i < 50; i++) world.digCanal(index, human);
    tally.observe(world);
    expect(canal!.complete).toBe(true);
    expect(tally.canalsDug).toBe(1);
    metrics = collectCultivation(world);
    expect(metrics.canalsComplete).toBe(1);
    // Flow is recomputed once per tick, not by the dig itself.
    expect(metrics.canalsFlowing).toBe(0);

    world.updateCultivation();
    expect(collectCultivation(world).canalsFlowing).toBe(1);
  });
});

describe('BalanceTally deaths', () => {
  it('counts human deaths by reason, predation included', () => {
    const world = makeWorld('balance-deaths');
    const tally = new BalanceTally(world);
    const [starved, aged, hunted, unknown] = world.humans;

    world.killHuman(starved, 'starvation', null);
    world.killHuman(aged, 'old age', null);
    world.damageHuman(hunted, 500, 'predation', null);
    world.killHuman(unknown, 'a mystery', null);
    tally.observe(world);

    expect(tally.deathReasons).toEqual({
      starvation: 1,
      'old age': 1,
      predation: 1,
      'a mystery': 1,
    });
  });

  it('never counts a predator death as a human death', () => {
    const world = makeWorld('balance-predator-death', 2);
    const tally = new BalanceTally(world);
    const deathsBefore = world.deaths;
    world.killPredator(world.predators[0], 'starvation');
    world.killHuman(world.humans[0], 'starvation', null);
    tally.observe(world);

    // One human death: World.deaths agrees, and so does the tally.
    expect(world.deaths - deathsBefore).toBe(1);
    expect(tally.deathReasons).toEqual({ starvation: 1 });
  });

  it('counts a human spawned and killed between observations as a human', () => {
    const world = makeWorld('balance-spawned');
    const tally = new BalanceTally(world);
    const spawned = world.spawnHuman(world.humans[0].x, world.humans[0].y);
    world.killHuman(spawned, 'exposure', null);
    tally.observe(world);
    expect(tally.deathReasons).toEqual({ exposure: 1 });
  });

  it('reports nothing for a world where nobody has died', () => {
    const world = makeWorld('balance-no-deaths');
    const tally = new BalanceTally(world);
    for (let i = 0; i < 50; i++) {
      world.step();
      tally.observe(world);
    }
    expect(world.deaths).toBe(0);
    expect(tally.deathReasons).toEqual({});
  });
});

describe('BalanceTally across event-log rollover', () => {
  it('keeps every harvest even after the log has trimmed them away', () => {
    const world = makeWorld('balance-rollover');
    const tally = new BalanceTally(world);
    const human = world.humans[0];
    const grass = findGrass(world, world.settlementCentre!.x, world.settlementCentre!.y);
    world.foundField(grass!.x, grass!.y, human);

    for (let cycle = 0; cycle < 3; cycle++) {
      world.sowField(0, human);
      ripen(world, 0);
      world.harvestField(0, human);
      tally.observe(world);
    }
    // Flood the log well past its capacity, observing as a run loop would.
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < MAX_EVENTS / 2; i++) world.emitEvent('ecology', `filler ${batch}.${i}`, []);
      tally.observe(world);
    }

    const inLog = world.events.filter((event) => event.text.endsWith('brought in a crop.')).length;
    expect(inLog).toBe(0);
    expect(tally.harvests).toBe(3);
    expect(tally.eventsMissed).toBe(0);
  });

  it('says so when it was observed too rarely, and keeps deaths reconciled', () => {
    const world = makeWorld('balance-missed');
    const tally = new BalanceTally(world);
    world.killHuman(world.humans[0], 'starvation', null);
    for (let i = 0; i < MAX_EVENTS + 50; i++) world.emitEvent('ecology', `filler ${i}`, []);
    tally.observe(world);

    expect(tally.eventsMissed).toBeGreaterThan(0);
    // The death's event was trimmed, but World.deaths still saw it.
    expect(tally.deathReasons).toEqual({ [UNATTRIBUTED]: 1 });
  });
});

describe('buildRow', () => {
  it('agrees with the world it read, and keeps derived rates consistent', () => {
    const world = makeWorld('balance-row');
    const tally = new BalanceTally(world);
    const config: RunConfig = { ticks: 500, humans: 8, predators: 0 };
    for (let i = 0; i < config.ticks; i++) {
      world.step();
      tally.observe(world);
    }

    const row = buildRow('balance-row', world, config, { peak: 9, elapsedSeconds: 2, tally });

    expect(row.seed).toBe('balance-row');
    expect(row.peak).toBe(9);
    expect(row.population).toBe(world.humans.length);
    expect(row.births).toBe(world.births);
    expect(row.deaths).toBe(world.deaths);
    expect(row.huts).toBe(world.computeStats().huts);

    const cultivation = collectCultivation(world);
    expect(row.fields).toBe(cultivation.fields);
    expect(row.sownFields).toBe(cultivation.sown);
    expect(row.ripeFields).toBe(cultivation.ripe);
    expect(row.canals).toBe(cultivation.canals);
    expect(row.canalsComplete).toBe(cultivation.canalsComplete);
    expect(row.canalsFlowing).toBe(cultivation.canalsFlowing);
    expect(row.foodOnGround).toBe(cultivation.foodOnGround);
    expect(row.harvests).toBe(tally.harvests);

    // Nothing may be counted twice or out of thin air.
    expect(row.sownFields + row.ripeFields).toBeLessThanOrEqual(row.fields);
    expect(row.canalsFlowing).toBeLessThanOrEqual(row.canalsComplete);
    expect(row.canalsComplete).toBeLessThanOrEqual(row.canals);
    const tallied = Object.values(row.deathReasons).reduce((total, count) => total + count, 0);
    expect(tallied).toBe(row.deaths);

    const hours = (config.ticks * DT) / 3600;
    expect(row.birthsPerHour).toBeCloseTo(row.births / hours, 8);
    expect(row.deathsPerHour).toBeCloseTo(row.deaths / hours, 8);
    expect(row.wallTimeSeconds).toBe(2);
    expect(row.ticksPerSecond).toBeCloseTo(config.ticks / 2, 8);
    expect(row.outcome).toBe(classifyOutcome(row.population, 9, row.birthsPerHour, row.deathsPerHour));
  });

  it('reports a finite tick rate even when the run takes no measurable time', () => {
    const world = makeWorld('balance-instant');
    const row = buildRow('balance-instant', world, { ticks: 1, humans: 8, predators: 0 }, {
      peak: 8,
      elapsedSeconds: 0,
      tally: new BalanceTally(world),
    });
    expect(Number.isFinite(row.ticksPerSecond)).toBe(true);
    expect(JSON.parse(JSON.stringify(row)).ticksPerSecond).toBe(row.ticksPerSecond);
  });
});

describe('summarize', () => {
  it('computes batch ticks per second as total ticks over total wall time', () => {
    const world = makeWorld('balance-summary');
    const tally = new BalanceTally(world);
    const fast = buildRow('fast', world, { ticks: 1000, humans: 8, predators: 0 }, { peak: 8, elapsedSeconds: 1, tally });
    const slow = buildRow('slow', world, { ticks: 1000, humans: 8, predators: 0 }, { peak: 8, elapsedSeconds: 9, tally });
    const summary = summarize([fast, slow]);
    expect(summary.ticks).toBe(2000);
    expect(summary.wallTimeSeconds).toBe(10);
    // Not (1000 + 111.1) / 2 — the mean of rates overweights the fast seed.
    expect(summary.ticksPerSecond).toBeCloseTo(200, 8);
  });

  it('adds up death reasons and reports an empty batch without -Infinity', () => {
    const base = { deathReasons: {} } as unknown as BalanceRow;
    const a = { ...base, deathReasons: { starvation: 2, predation: 1 } } as BalanceRow;
    const b = { ...base, deathReasons: { starvation: 3 } } as BalanceRow;
    expect(summarize([a, b]).deathReasons).toEqual({ starvation: 5, predation: 1 });
    expect(summarize([]).deepestGeneration).toBe(0);
  });
});

describe('classifyOutcome', () => {
  it('is extinct only at zero', () => {
    expect(classifyOutcome(0, 20, 9, 0)).toBe('extinct');
  });

  it('is thriving above twelve', () => {
    expect(classifyOutcome(13, 20, 0, 9)).toBe('thriving');
    expect(classifyOutcome(12, 20, 9, 0)).not.toBe('thriving');
  });

  it('is stable when births keep up and the village is not tiny', () => {
    expect(classifyOutcome(8, 20, 2, 2)).toBe('stable');
    // Births ahead of deaths cannot rescue a pair.
    expect(classifyOutcome(3, 20, 5, 1)).not.toBe('stable');
  });

  it('is declining otherwise', () => {
    expect(classifyOutcome(5, 20, 1, 3)).toBe('declining');
    expect(classifyOutcome(2, 20, 1, 1)).toBe('declining');
  });
});
