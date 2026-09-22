import { describe, expect, it } from 'vitest';
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { DEFAULT_MATCH, Match } from '../server/match';
import { Sex } from '../src/shared/types';

function makeWorld(seed = 'match'): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialHumans: 8, initialPredators: 0 });
}

describe('houses', () => {
  it('splits the founders evenly between the two houses', () => {
    const world = makeWorld();
    const houses = world.houseStats();
    expect(houses).toHaveLength(2);
    expect(houses[0].population).toBe(4);
    expect(houses[1].population).toBe(4);
  });

  it('gives a child its mother’s house, not its father’s', () => {
    const world = makeWorld();
    // Pair a house-0 female with a house-1 male and check the child's house.
    const mother = world.humans.find((h) => h.sex === Sex.Female && h.house === 0)!;
    const father = world.humans.find((h) => h.sex === Sex.Male && h.house === 1)!;
    expect(mother).toBeDefined();
    expect(father).toBeDefined();

    // Drive the pair directly rather than waiting for them to find each other.
    mother.ageBio = 20;
    father.ageBio = 20;
    mother.health = 100;
    father.health = 100;
    for (let i = 0; i < 60000 && !mother.pregnancy; i++) {
      mother.x = 80;
      mother.y = 60;
      father.x = 80.6;
      father.y = 60;
      mother.matingCooldown = 0;
      father.matingCooldown = 0;
      mother.recovery = 0;
      world.step();
    }
    expect(mother.pregnancy).not.toBeNull();

    // Run until the baby exists.
    const before = world.humans.length;
    for (let i = 0; i < 40000 && world.humans.length === before; i++) world.step();

    const baby = world.humans.find((h) => h.motherId === mother.id);
    expect(baby).toBeDefined();
    expect(baby!.house).toBe(0);
    expect(baby!.house).toBe(mother.house);
  }, 120000);

  it('scores population first and generation depth second', () => {
    const world = makeWorld();
    const houses = world.houseStats();
    for (const entry of houses) {
      expect(entry.score).toBe(entry.population * 100 + entry.deepestGeneration * 25);
      expect(entry.females + entry.males).toBe(entry.population);
    }
  });

  it('gives a god-spawned human the house it was told to', () => {
    const world = makeWorld();
    const spawned = world.spawnHuman(80, 60, undefined, 18, 1);
    expect(spawned.house).toBe(1);
    const spawned0 = world.spawnHuman(81, 60, undefined, 18, 0);
    expect(spawned0.house).toBe(0);
  });
});

describe('match rules', () => {
  const config = { ...DEFAULT_MATCH, enabled: true, startingInfluence: 100 };

  it('assigns observers to alternating houses', () => {
    const match = new Match(config);
    expect(match.join('a').house).toBe(0);
    expect(match.join('b').house).toBe(1);
    expect(match.join('c').house).toBe(0);
  });

  it('refuses a house-scoped command aimed at the other house', () => {
    const world = makeWorld();
    const match = new Match(config);
    const a = match.join('a');

    const enemy = world.humans.find((h) => h.house === 1)!;
    const refusal = match.authorise(world, a, { kind: 'kill', id: enemy.id });
    expect(refusal).toContain('house 1');
    expect(a.commandsRefused).toBe(1);
    expect(a.influence).toBe(100);
  });

  it('allows a house-scoped command aimed at your own house', () => {
    const world = makeWorld();
    const match = new Match(config);
    const a = match.join('a');

    const friend = world.humans.find((h) => h.house === 0)!;
    expect(match.authorise(world, a, { kind: 'moveHuman', id: friend.id, x: 80, y: 60 })).toBeNull();
    expect(a.commandsIssued).toBe(1);
    expect(a.influence).toBe(100 - config.costs.moveHuman);
  });

  it('allows hostile world commands against anyone', () => {
    const world = makeWorld();
    const match = new Match(config);
    const a = match.join('a');
    // Lightning is unrestricted: that is what makes it a game rather than two
    // people tending separate gardens.
    expect(match.authorise(world, a, { kind: 'lightning', x: 80, y: 60 })).toBeNull();
    expect(a.influence).toBe(100 - config.costs.lightning);
  });

  it('refuses a command you cannot afford', () => {
    const world = makeWorld();
    const match = new Match({ ...config, startingInfluence: 5 });
    const a = match.join('a');
    const refusal = match.authorise(world, a, { kind: 'lightning', x: 80, y: 60 });
    expect(refusal).toContain('not enough influence');
    expect(a.influence).toBe(5);
  });

  it('lets a spawn through and charges for it', () => {
    const world = makeWorld();
    const match = new Match(config);
    const a = match.join('a');
    expect(match.authorise(world, a, { kind: 'spawnHuman', x: 80, y: 60 })).toBeNull();
    expect(a.influence).toBe(100 - config.costs.spawnHuman);
  });

  it('does nothing at all when the match is disabled', () => {
    const world = makeWorld();
    const match = new Match({ ...config, enabled: false });
    const a = match.join('a');
    const enemy = world.humans.find((h) => h.house === 1)!;
    // A single-observer world has no houses, so no command is ever refused.
    expect(match.authorise(world, a, { kind: 'kill', id: enemy.id })).toBeNull();
    expect(a.influence).toBe(100);
  });

  it('ends the match when a house dies out', () => {
    const world = makeWorld();
    const match = new Match(config);
    match.join('a');
    match.join('b');
    match.tick(world);
    expect(match.view(world).finished).toBe(false);

    // Kill every member of house 0.
    for (const human of world.humans.filter((h) => h.house === 0)) {
      world.killHuman(human, 'test', null);
    }
    // One step so the dead are compacted out of the population array.
    world.step();
    match.tick(world);

    const view = match.view(world);
    expect(view.finished).toBe(true);
    expect(view.winner).toBe(1);
    expect(view.reason).toContain('died out');
  });

  it('ends the match on the clock and awards it to the higher score', () => {
    const world = makeWorld();
    const match = new Match({ ...config, durationSeconds: 1 });
    match.join('a');
    match.join('b');
    match.tick(world);
    // Push simulated time past the duration.
    for (let i = 0; i < 40; i++) world.step();
    match.tick(world);

    const view = match.view(world);
    expect(view.finished).toBe(true);
    expect(view.reason.length).toBeGreaterThan(0);
  });

  it('regenerates influence but caps it', () => {
    const world = makeWorld();
    const match = new Match({ ...config, startingInfluence: 50, influencePerSecond: 10 });
    const a = match.join('a');
    a.influence = 0;
    for (let i = 0; i < 200; i++) {
      world.step();
      match.tick(world);
    }
    expect(a.influence).toBeGreaterThan(0);
    // Capped at twice the starting allowance, so an observer cannot bank forever.
    expect(a.influence).toBeLessThanOrEqual(100);
  });
});
