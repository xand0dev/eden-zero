import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World, type WorldOptions } from '../src/simulation/world';
import { DAY_SECONDS, SIM_HZ, WORLD_H, WORLD_W } from '../src/shared/constants';
import { calendarAt, seasonFactors, Season, YEAR_SECONDS } from '../src/simulation/game/calendar';
import { charterMultiplier, charterProblem, LAWS, rulesFor } from '../src/simulation/game/laws';
import { Era, requirementsFor, updateEra, createEraState, ERA_HOLD_TICKS, type EraInputs } from '../src/simulation/game/eras';
import { createFate, updateFate, crisisFactors, CRISIS_ORDER } from '../src/simulation/game/crises';
import { createFavour, spend, grant, favourCap, FAVOUR_START } from '../src/simulation/game/favour';
import { Soil } from '../src/simulation/game/soil';
import { ATLAS, createLog, evaluate, epithetFor, type AtlasSubject } from '../src/simulation/game/atlas';
import { structureKindFor, type SiteContext } from '../src/simulation/game/buildings';
import { StructureKind } from '../src/simulation/entities/structure';
import { BIOMES, terrainParamsFor } from '../src/simulation/game/biomes';
import { generateTerrain, isWater } from '../src/simulation/environment/terrain';
import { applyGodCommandChecked } from '../src/simulation/commands';
import { makeReplay, stateHash, verifyReplay } from '../src/simulation/game/replay';
import { obituary } from '../src/simulation/game/chronicle';

const TICKS_PER_DAY = DAY_SECONDS * SIM_HZ;

function makeWorld(seed: string, overrides: Partial<WorldOptions> = {}): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, ...overrides });
}

describe('calendar', () => {
  it('has four two-day seasons in an eight-day year', () => {
    expect(YEAR_SECONDS).toBe(8 * DAY_SECONDS);
    expect(calendarAt(0).season).toBe(Season.Spring);
    expect(calendarAt(2 * DAY_SECONDS + 1).season).toBe(Season.Summer);
    expect(calendarAt(6 * DAY_SECONDS + 1).season).toBe(Season.Winter);
    expect(calendarAt(YEAR_SECONDS + 1).year).toBe(2);
  });

  it('makes winter cold and barren and blends smoothly across the year', () => {
    const winter = seasonFactors(7 * DAY_SECONDS);
    const summer = seasonFactors(3 * DAY_SECONDS);
    expect(winter.temperature).toBeLessThan(0);
    expect(summer.temperature).toBeGreaterThan(0);
    expect(winter.plantSpread).toBe(0);
    let previous = seasonFactors(0).temperature;
    for (let t = 10; t < YEAR_SECONDS; t += 10) {
      const now = seasonFactors(t).temperature;
      expect(Math.abs(now - previous)).toBeLessThan(0.2);
      previous = now;
    }
  });

  it('has no winter under eternal spring', () => {
    const factors = seasonFactors(7 * DAY_SECONDS, { amplitude: 1, eternalSpring: true });
    expect(factors.plantSpread).toBeGreaterThan(1);
  });
});

describe('laws', () => {
  it('defines forty or more laws with unique ids that all resolve', () => {
    expect(LAWS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(LAWS.map((l) => l.id)).size).toBe(LAWS.length);
    for (const law of LAWS) {
      const rules = rulesFor([law.id]);
      expect(rules).toBeDefined();
    }
  });

  it('turns a charter into rules and a legacy multiplier', () => {
    const rules = rulesFor(['tabula-rasa', 'short-lives']);
    expect(rules.innatePriors).toBeCloseTo(0.1);
    expect(rules.lifespan).toBeCloseTo(0.6);
    expect(charterMultiplier(['tabula-rasa', 'short-lives'])).toBeCloseTo(3 * 1.4);
  });

  it('refuses contradictory or oversized charters', () => {
    expect(charterProblem(['dry-world', 'wet-world'], 3)).toMatch(/cannot share/);
    expect(charterProblem(['calm', 'hardy', 'twins', 'lamarck'], 3)).toMatch(/at most 3/);
    expect(charterProblem(['calm', 'hardy'], 3)).toBeNull();
  });

  it('builds blank-slate brains under tabula rasa', () => {
    const normal = makeWorld('law-brain');
    const blank = makeWorld('law-brain', { charter: ['tabula-rasa'] });
    const a = normal.humans[0].brain;
    const b = blank.humans[0].brain;
    const k = a.innateStart;
    expect(Math.abs(b.w[k])).toBeCloseTo(Math.abs(a.w[k]) * 0.1, 5);
  });

  it('refuses every intervention for an observer who swore not to intervene', () => {
    const world = makeWorld('law-observer', { charter: ['only-observer'], mode: 'campaign' });
    const result = applyGodCommandChecked(world, { kind: 'spawnFood', x: 50, y: 50 });
    expect(result.ok).toBe(false);
  });
});

describe('eras', () => {
  const inputs = (overrides: Partial<EraInputs>): EraInputs => ({
    population: 0,
    generation: 0,
    huts: 0,
    fieldsSown: 0,
    fields: 0,
    flowingCanals: 0,
    granaries: 0,
    storedFood: 0,
    elderFraction: 0,
    crisesSurvived: 0,
    palisades: 0,
    wells: 0,
    ...overrides,
  });

  it('needs every condition held for two days before a new era', () => {
    const state = createEraState();
    const camp = inputs({ population: 12, huts: 3, fieldsSown: 1 });
    expect(requirementsFor(Era.Camp, camp).every((r) => r.met)).toBe(true);
    expect(updateEra(state, camp, 100)).toBeNull();
    expect(updateEra(state, camp, 100 + ERA_HOLD_TICKS - 1)).toBeNull();
    expect(updateEra(state, camp, 100 + ERA_HOLD_TICKS)).toBe(Era.Camp);
    expect(state.era).toBe(Era.Camp);
  });

  it('resets the hold when a condition lapses', () => {
    const state = createEraState();
    updateEra(state, inputs({ population: 12, huts: 3, fieldsSown: 1 }), 0);
    updateEra(state, inputs({ population: 11, huts: 3, fieldsSown: 1 }), 10);
    expect(state.qualifyingSince).toBe(-1);
  });
});

describe('fate', () => {
  it('schedules the same crises for the same seed, never before the second year', () => {
    const run = (): string[] => {
      const fate = createFate('fate-seed', 1);
      const kinds: string[] = [];
      for (let tick = 0; tick < 12 * YEAR_SECONDS * SIM_HZ; tick += 20) {
        const event = updateFate(fate, tick, tick / SIM_HZ, Era.Town, 50, 1, {});
        if (event?.type === 'warning') {
          expect(tick).toBeGreaterThanOrEqual(YEAR_SECONDS * SIM_HZ * 0.9);
          kinds.push(event.crisis.kind);
        }
      }
      return kinds;
    };
    const first = run();
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(run()).toEqual(first);
  });

  it('only chooses crises the era allows, and none in the hearth era', () => {
    const fate = createFate('fate-era', 1);
    for (let tick = 0; tick < 6 * YEAR_SECONDS * SIM_HZ; tick += 20) {
      const event = updateFate(fate, tick, tick / SIM_HZ, Era.Hearth, 20, 1, {});
      expect(event).toBeNull();
    }
    const camp = createFate('fate-era', 1);
    for (let tick = 0; tick < 12 * YEAR_SECONDS * SIM_HZ; tick += 20) {
      const event = updateFate(camp, tick, tick / SIM_HZ, Era.Camp, 20, 1, {});
      if (event?.type === 'warning') expect(['drought', 'harshWinter']).toContain(event.crisis.kind);
    }
  });

  it('dries the land in a drought and chills it in a harsh winter', () => {
    const fate = createFate('fate-factors', 1);
    fate.current = {
      kind: 'drought',
      phase: 'active',
      warnedAt: 0,
      startsAt: 0,
      endsAt: 10 * TICKS_PER_DAY,
      severity: 1,
      populationAtStart: 10,
    };
    const drought = crisisFactors(fate, TICKS_PER_DAY);
    expect(drought.plantRegen).toBeLessThan(0.5);
    expect(drought.fieldDry).toBeGreaterThan(2);
    fate.current.kind = 'harshWinter';
    expect(crisisFactors(fate, TICKS_PER_DAY).temperature).toBeLessThan(-6);
    expect(CRISIS_ORDER.length).toBe(8);
  });
});

describe('favour', () => {
  it('charges, refuses when poor, and enforces cooldowns', () => {
    const favour = createFavour(true);
    expect(favour.value).toBe(FAVOUR_START);
    expect(spend(favour, 'rain', 0, false).ok).toBe(true);
    expect(spend(favour, 'rain', 10, false).ok).toBe(false);
    favour.value = 5;
    const poor = spend(favour, 'lightning', 10_000, false);
    expect(poor.ok).toBe(false);
    grant(favour, 10_000, 0);
    expect(favour.value).toBe(favourCap(0));
  });

  it('makes each created person cost half again as much', () => {
    const favour = createFavour(true);
    favour.value = 1000;
    const a = spend(favour, 'spawnHuman', 0, false);
    const b = spend(favour, 'spawnHuman', 0, false);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.cost).toBe(Math.round(a.cost * 1.5));
  });

  it('is free and unscored in a sandbox', () => {
    const favour = createFavour(false);
    favour.value = 0;
    expect(spend(favour, 'spawnPredator', 0, false).ok).toBe(true);
  });
});

describe('soil', () => {
  it('is exhausted by grazing and recovers when left alone', () => {
    const soil = new Soil(10, 10);
    soil.graze(3.5, 3.5, 0.1);
    const grazed = soil.at(3.5, 3.5);
    expect(grazed).toBeLessThan(1);
    expect(soil.regenFactor(3.5, 3.5)).toBeCloseTo(grazed * grazed);
    for (let i = 0; i < 200; i++) soil.recover(5, 1);
    expect(soil.at(3.5, 3.5)).toBeGreaterThan(grazed);
  });

  it('round-trips exactly', () => {
    const soil = new Soil(20, 12);
    soil.graze(4, 4, 0.05);
    soil.graze(9, 2, 0.07);
    const copy = new Soil(20, 12);
    copy.restore(soil.serialize());
    expect(Array.from(copy.fertility)).toEqual(Array.from(soil.fertility));
  });

  it('lowers wild regrowth in the world where people graze', () => {
    const world = makeWorld('soil-world', { initialPredators: 0 });
    const plant = world.plants.find((p) => p.species === 0 && p.food > 0.3)!;
    const index = world.plants.indexOf(plant);
    world.consumePlant(index, 0.3, world.humans[0]);
    expect(world.soil.at(plant.x, plant.y)).toBeLessThan(1);
  });
});

describe('buildings', () => {
  const ctx = (overrides: Partial<SiteContext>): SiteContext => ({
    era: Era.Hearth,
    fieldNear: false,
    granaryNear: false,
    waterDistance: 3,
    wellNear: false,
    workshops: 0,
    huts: 0,
    population: 10,
    rockNear: false,
    edge: 0.2,
    shrines: 0,
    deaths: 0,
    ...overrides,
  });

  it('decides a site by place and era, never by person', () => {
    expect(structureKindFor(ctx({ fieldNear: true }))).toBe(StructureKind.Hut);
    expect(structureKindFor(ctx({ era: Era.Camp, fieldNear: true }))).toBe(StructureKind.Granary);
    expect(structureKindFor(ctx({ era: Era.Camp, fieldNear: true, granaryNear: true }))).toBe(StructureKind.Hut);
    expect(structureKindFor(ctx({ era: Era.Village, waterDistance: 12 }))).toBe(StructureKind.Well);
    expect(structureKindFor(ctx({ era: Era.Town, huts: 9 }))).toBe(StructureKind.Workshop);
    expect(structureKindFor(ctx({ era: Era.Town, huts: 9, workshops: 1, edge: 0.9 }))).toBe(StructureKind.Palisade);
  });
});

describe('atlas', () => {
  const subject = (overrides: Partial<AtlasSubject> = {}): AtlasSubject => ({
    ageYears: 30,
    alive: true,
    deathReason: null,
    children: 0,
    descendants: 0,
    livingGrandchildren: 0,
    firstChildAge: null,
    innateDrift: () => 0,
    maxInnateDrift: 0,
    strongReflexReversed: false,
    weightDrift: 0.01,
    tick: 0,
    ...overrides,
  });

  it('has forty or more entries with unique ids and stated criteria', () => {
    expect(ATLAS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ATLAS.map((e) => e.id)).size).toBe(ATLAS.length);
    for (const entry of ATLAS) expect(entry.criterion.length).toBeGreaterThan(10);
  });

  it('awards what the record shows, once, and the rarest epithet wins', () => {
    const log = createLog(1);
    log.meals = 3;
    log.timber = 50;
    log.canalsFinished = 3;
    log.irrigated = 1;
    const earned = evaluate(log, subject(), false);
    expect(earned).toContain('first-meal');
    expect(earned).toContain('woodcutter');
    expect(earned).toContain('irrigator');
    expect(evaluate(log, subject(), false)).toEqual([]);
    expect(epithetFor(log.earned)).toBe('the Irrigator');
  });

  it('keeps lifetime entries for the end of a life', () => {
    const log = createLog(2);
    log.samples = 1000;
    log.alone = 950;
    expect(evaluate(log, subject({ deathReason: 'old age' }), false)).not.toContain('hermit');
    expect(evaluate(log, subject({ deathReason: 'old age', alive: false }), true)).toContain('hermit');
  });

  it('reads learning from the brain itself', () => {
    const log = createLog(3);
    expect(evaluate(log, subject({ maxInnateDrift: 0.7 }), false)).not.toContain('relearned');
    expect(evaluate(log, subject({ strongReflexReversed: true }), false)).toContain('relearned');
  });
});

describe('biomes', () => {
  it('leaves the river valley exactly as the original island', () => {
    const plain = generateTerrain('biome-check');
    const valley = generateTerrain('biome-check', WORLD_W, WORLD_H, terrainParamsFor('valley'));
    expect(valley.tiles.join('')).toBe(plain.tiles.join(''));
  });

  it('makes every biome a different island', () => {
    const tiles = BIOMES.map((b) => generateTerrain('biome-check', WORLD_W, WORLD_H, terrainParamsFor(b.id)).tiles);
    const signatures = tiles.map((t) => t.join(''));
    expect(new Set(signatures).size).toBe(BIOMES.length);
  });

  it('salts the sea on a salt coast but keeps inland water fresh', () => {
    const terrain = generateTerrain('salt-check', WORLD_W, WORLD_H, terrainParamsFor('salt-coast'));
    expect(terrain.fresh[0]).toBe(0);
    let water = 0;
    let fresh = 0;
    for (let i = 0; i < terrain.tiles.length; i++) {
      if (isWater(terrain.tiles[i])) water++;
      if (terrain.fresh[i]) fresh++;
    }
    expect(fresh).toBeLessThan(water);
  });
});

describe('the game layer in a running world', () => {
  it('starts a campaign with favour, a chronicle and a record for every founder', () => {
    const world = makeWorld('campaign-start', { mode: 'campaign' });
    expect(world.favour.enabled).toBe(true);
    expect(world.chronicle.entries[0].kind).toBe('genesis');
    for (const human of world.humans) expect(world.logs.has(human.id)).toBe(true);
    const view = world.buildGameView(0);
    expect(view.era).toBe(Era.Hearth);
    expect(view.nextEra.length).toBeGreaterThan(0);
    expect(view.year).toBe(1);
  });

  it('senses the era and the stores on the two reserved channels', () => {
    const world = makeWorld('channels', { initialPredators: 0 });
    world.eraState.era = Era.Village;
    world.step();
    const human = world.humans[0];
    expect(human.sensors[63]).toBeCloseTo(0.5);
  });

  it('stores a harvest in a granary and serves it as a pile beside it', () => {
    const world = makeWorld('granary', { initialPredators: 0 });
    const worker = world.humans[0];
    world.eraState.era = Era.Camp;
    const field = world.foundField(worker.x, worker.y, worker) ?? world.fields[0];
    expect(field).toBeTruthy();
    const site = world.foundStructure(field.x + 3, field.y, worker);
    expect(site?.kind).toBe(StructureKind.Granary);
    site!.wood = site!.required;
    site!.complete = true;
    world.rebuildGrids();
    field.stage = 2;
    const index = world.fields.indexOf(field);
    expect(world.harvestField(index, worker)).toBe(true);
    expect(site!.store).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) world.step();
    const stall = world.plants.find((p) => p.origin === 4);
    expect(stall).toBeDefined();
    expect(world.storedFood).toBeGreaterThanOrEqual(0);
  });

  it('warns a day ahead and then starts the crisis fate chose', () => {
    const world = makeWorld('crisis-run', { initialPredators: 0 });
    world.eraState.era = Era.Camp;
    world.fate.nextAt = world.tick + 1;
    world.step();
    world.step();
    expect(world.fate.current?.phase).toBe('warning');
    const startsAt = world.fate.current!.startsAt;
    while (world.tick < startsAt + 1) world.step();
    expect(world.fate.current?.phase).toBe('active');
    expect(world.chronicle.entries.some((e) => e.kind === 'crisis')).toBe(true);
  });

  it('writes an obituary from recorded facts only', () => {
    const text = obituary({
      name: 'Orysia',
      epithet: 'the Night Watch',
      generation: 3,
      ageYears: 52,
      children: 5,
      reason: 'predation',
      circumstance: null,
    });
    expect(text).toBe('Orysia the Night Watch, of the 3rd generation, lived 52 years and left 5 children. Died to a predator.');
  });

  it('survives a save round trip with the game layer and continues identically', () => {
    const options: Partial<WorldOptions> = { mode: 'campaign', charter: ['fast-learning'], initialPredators: 1 };
    const original = makeWorld('game-roundtrip', options);
    original.eraState.era = Era.Camp;
    original.fate.nextAt = 50;
    for (let i = 0; i < 1500; i++) original.step();
    applyGodCommandChecked(original, { kind: 'rain', x: original.humans[0].x, y: original.humans[0].y });
    for (let i = 0; i < 300; i++) original.step();

    const restored = World.deserialize(JSON.parse(JSON.stringify(original.serialize())) as Record<string, unknown>);
    expect(restored.favour.value).toBeCloseTo(original.favour.value);
    expect(restored.chronicle.entries.length).toBe(original.chronicle.entries.length);
    for (let i = 0; i < 800; i++) {
      original.step();
      restored.step();
    }
    expect(stateHash(restored)).toBe(stateHash(original));
  });

  it('replays a campaign from its seed and command log to the same state', () => {
    const world = makeWorld('replay-check', { mode: 'campaign', initialPredators: 1 });
    for (let i = 0; i < 400; i++) world.step();
    applyGodCommandChecked(world, { kind: 'spawnFood', x: world.humans[0].x, y: world.humans[0].y });
    for (let i = 0; i < 400; i++) world.step();
    applyGodCommandChecked(world, { kind: 'rewardPulse', id: world.humans[1].id });
    for (let i = 0; i < 400; i++) world.step();
    const replay = makeReplay(world);
    expect(replay.commands.length).toBe(2);
    expect(verifyReplay(replay).ok).toBe(true);
  });
});
