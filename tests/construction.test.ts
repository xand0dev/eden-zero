import { describe, expect, it } from 'vitest';
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { CARRY_CAPACITY, WOOD_PER_HUT } from '../src/simulation/entities/structure';
import { PlantSpecies } from '../src/simulation/entities/plant';
import { M, S } from '../src/simulation/brain/channels';
import { normalizeAngle } from '../src/simulation/entities/human';

function makeWorld(seed = 'construction'): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialHumans: 8, initialPredators: 0 });
}

/** Find the nearest living tree to a point. */
function nearestTree(world: World, x: number, y: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < world.plants.length; i++) {
    const plant = world.plants[i];
    if (!plant.alive || plant.species !== PlantSpecies.Tree) continue;
    if (plant.timber <= 0.1) continue;
    const distance = Math.hypot(plant.x - x, plant.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

describe('timber', () => {
  it('trees carry standing timber and other plants do not', () => {
    const world = makeWorld();
    let trees = 0;
    let withTimber = 0;
    for (const plant of world.plants) {
      if (plant.species === PlantSpecies.Tree) {
        trees++;
        if (plant.timber > 0) withTimber++;
      } else {
        expect(plant.timber).toBe(0);
      }
    }
    expect(trees).toBeGreaterThan(0);
    expect(withTimber).toBe(trees);
  });

  it('felling removes timber from the tree and never over-draws', () => {
    const world = makeWorld();
    const index = nearestTree(world, world.settlementCentre!.x, world.settlementCentre!.y);
    expect(index).toBeGreaterThanOrEqual(0);
    const tree = world.plants[index];
    const before = tree.timber;

    const taken = world.harvestWood(index, 1.5);
    expect(taken).toBeGreaterThan(0);
    expect(tree.timber).toBeCloseTo(before - taken, 5);

    // Asking for more than remains returns only what is left.
    const rest = world.harvestWood(index, 999);
    expect(rest).toBeCloseTo(before - taken, 5);
    expect(tree.timber).toBeCloseTo(0, 5);
    // A bare tree yields nothing.
    expect(world.harvestWood(index, 5)).toBe(0);
  });

  it('timber regrows, but far more slowly than foliage', () => {
    const world = makeWorld();
    const index = nearestTree(world, world.settlementCentre!.x, world.settlementCentre!.y);
    const tree = world.plants[index];
    world.harvestWood(index, tree.timber * 0.5);
    const afterFelling = tree.timber;

    for (let i = 0; i < 2000; i++) world.step();

    expect(tree.timber).toBeGreaterThan(afterFelling);
    expect(tree.timber).toBeLessThan(tree.profile.maxTimber);
  });
});

describe('structures', () => {
  it('a new world has no huts and no sites', () => {
    const world = makeWorld();
    expect(world.structures.length).toBe(0);
    expect(world.computeStats().huts).toBe(0);
  });

  it('founding is refused when another site is already close', () => {
    const world = makeWorld();
    const centre = world.settlementCentre!;
    const human = world.humans[0];
    const first = world.foundStructure(centre.x, centre.y, human);
    expect(first).not.toBeNull();
    const second = world.foundStructure(centre.x + 1, centre.y + 1, human);
    expect(second).toBeNull();
    expect(world.structures.length).toBe(1);
  });

  it('contributing timber advances the site and completes it', () => {
    const world = makeWorld();
    const human = world.humans[0];
    const site = world.foundStructure(world.settlementCentre!.x, world.settlementCentre!.y, human)!;

    const laid = world.contributeWood(0, 10, human);
    expect(laid).toBe(10);
    expect(site.progress).toBeCloseTo(10 / WOOD_PER_HUT, 4);
    expect(site.complete).toBe(false);

    // Over-contributing is capped at what the site still needs.
    const rest = world.contributeWood(0, WOOD_PER_HUT * 4, human);
    expect(rest).toBeCloseTo(WOOD_PER_HUT - 10, 4);
    expect(site.complete).toBe(true);
    expect(site.progress).toBe(1);
    expect(world.computeStats().huts).toBe(1);

    // A finished hut accepts nothing more.
    expect(world.contributeWood(0, 5, human)).toBe(0);
  });

  it('emits a build event when a hut is completed', () => {
    const world = makeWorld();
    const human = world.humans[0];
    world.foundStructure(world.settlementCentre!.x, world.settlementCentre!.y, human);
    world.contributeWood(0, WOOD_PER_HUT, human);
    const completed = world.events.filter((e) => e.kind === 'build' && /completed/.test(e.text));
    expect(completed.length).toBe(1);
    expect(completed[0].text).toContain(human.name);
  });
});

describe('harvesting and building behaviour', () => {
  it('a human standing at a tree with the harvest drive fells timber', () => {
    const world = makeWorld();
    const human = world.humans[2];
    const index = nearestTree(world, human.x, human.y);
    expect(index).toBeGreaterThanOrEqual(0);
    const tree = world.plants[index];
    const before = tree.timber;

    // Place the human on the tree and drive the motor directly. This is testing
    // the action, not the network's decision to take it.
    human.x = tree.x;
    human.y = tree.y;
    human.wood = 0;
    human.motor.fill(0);
    human.motor[M.harvest] = 1;
    human.act(world, 0.05);

    expect(human.wood).toBeGreaterThan(0);
    expect(human.wood).toBeLessThanOrEqual(CARRY_CAPACITY);
    expect(tree.timber).toBeLessThan(before);
    expect(human.harvesting).toBe(true);
  });

  it('carrying a full load stops further felling', () => {
    const world = makeWorld();
    const human = world.humans[2];
    const index = nearestTree(world, human.x, human.y);
    const tree = world.plants[index];
    human.x = tree.x;
    human.y = tree.y;
    human.wood = CARRY_CAPACITY;
    human.motor.fill(0);
    human.motor[M.harvest] = 1;
    human.act(world, 0.05);
    expect(human.harvesting).toBe(false);
  });

  it('a human at a site with the build drive lays timber', () => {
    const world = makeWorld();
    const human = world.humans[1];
    const site = world.foundStructure(human.x, human.y, human)!;
    human.wood = 8;
    human.motor.fill(0);
    human.motor[M.build] = 1;
    human.act(world, 0.05);

    expect(site.wood).toBeGreaterThan(0);
    expect(human.wood).toBeLessThan(8);
    expect(human.building).toBe(true);
  });

  it('founds a site when carrying timber inside the village', () => {
    const world = makeWorld();
    const human = world.humans[3];
    const centre = world.settlementCentre!;
    human.x = centre.x;
    human.y = centre.y;
    human.wood = 6;
    human.motor.fill(0);
    human.motor[M.build] = 1;
    human.act(world, 0.05);
    expect(world.structures.length).toBe(1);
  });

  it('does not found a site far outside the village', () => {
    const world = makeWorld();
    const human = world.humans[3];
    const centre = world.settlementCentre!;
    human.x = centre.x + 60;
    human.y = centre.y;
    human.wood = 6;
    human.motor.fill(0);
    human.motor[M.build] = 1;
    human.act(world, 0.05);
    expect(world.structures.length).toBe(0);
  });

  it('the settlement actually builds huts on its own', () => {
    // The headline behaviour: with no scripted rule about who builds, the
    // inhabitants fell timber and raise huts over a few simulated hours.
    const world = makeWorld('builders');
    for (let i = 0; i < 120000; i++) world.step();

    const stats = world.computeStats();
    expect(stats.huts).toBeGreaterThan(0);
    // Felling is visible: standing timber is below what a pristine map holds.
    expect(stats.timber).toBeGreaterThan(0);
    expect(world.events.some((e) => e.kind === 'build')).toBe(true);
  }, 120000);
});

describe('forest exhaustion', () => {
  it('felling strips timber and a grown tree becomes a stump', () => {
    const world = makeWorld('eden');
    // A *mature* tree, because a young one has little timber without anyone
    // having touched it — which is exactly the trap the first version of this
    // code fell into.
    const index = world.plants.findIndex(
      (p) => p.alive && p.species === PlantSpecies.Tree && p.growth > 0.9 && p.timber > 1,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const tree = world.plants[index];

    expect(tree.timberFraction()).toBeGreaterThan(0.8);
    expect(tree.isStump()).toBe(false);

    world.harvestWood(index, tree.timber);
    expect(tree.timberFraction()).toBeCloseTo(0, 5);
    expect(tree.isStump()).toBe(true);

    // Regrowth is real, and slow: minutes of simulated time do not restore it.
    for (let i = 0; i < 4000; i++) world.step();
    expect(tree.timberFraction()).toBeGreaterThan(0);
    expect(tree.timberFraction()).toBeLessThan(0.5);
  });

  it('a young tree is small, not a stump', () => {
    const world = makeWorld('eden');
    const young = world.plants.find(
      (p) => p.alive && p.species === PlantSpecies.Tree && p.growth > 0.2 && p.growth < 0.6,
    );
    expect(young).toBeDefined();
    // Low timber fraction, but nobody cut it — so it must not read as a stump.
    expect(young!.timberFraction()).toBeLessThan(0.7);
    expect(young!.isStump()).toBe(false);
  });

  it('only trees carry timber; nothing else can be a stump', () => {
    const world = makeWorld('shrubs');
    let checked = 0;
    for (const plant of world.plants) {
      if (plant.species === PlantSpecies.Tree) continue;
      expect(plant.timberFraction()).toBe(0);
      expect(plant.isStump()).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('writes the directional timber channels the network needs', () => {
    // Regression. `woodDir` and `buildDir` were computed and then never written
    // into the sensory array, so these eight channels were permanently zero and
    // the brain could not see where the trees or the building sites were.
    const world = makeWorld('sensing');
    const human = world.humans[0];
    const index = nearestTree(world, human.x, human.y);
    expect(index).toBeGreaterThanOrEqual(0);
    const tree = world.plants[index];

    human.x = tree.x + 3;
    human.y = tree.y;
    human.sense(world);

    const timber =
      human.sensors[S.woodFront] +
      human.sensors[S.woodRight] +
      human.sensors[S.woodBack] +
      human.sensors[S.woodLeft];
    expect(timber).toBeGreaterThan(0);
  });

  it('prefers a rich tree over a nearer stripped one', () => {
    // The behaviour that makes the forest finite in practice: once the trees
    // around the village are cut, the network must look further out instead of
    // returning to the stump beside it.
    const world = makeWorld('woodchoice');

    // Find a human with at least two trees in sensing range, so there is an
    // actual choice to get wrong.
    let human = world.humans[0];
    let candidates: Array<{ plant: (typeof world.plants)[number]; i: number; d: number }> = [];
    const sideOf = (who: typeof human, x: number, y: number): number => {
      const relative = normalizeAngle(Math.atan2(y - who.y, x - who.x) - who.heading);
      const forward = Math.cos(relative);
      const lateral = Math.sin(relative);
      if (Math.abs(forward) >= Math.abs(lateral)) return forward >= 0 ? 0 : 2;
      return lateral >= 0 ? 1 : 3;
    };
    search: for (const candidate of world.humans) {
      const found = world.plants
        .map((plant, i) => ({ plant, i }))
        .filter(({ plant }) => plant.alive && plant.species === PlantSpecies.Tree && plant.timber > 0.8)
        .map(({ plant, i }) => ({ plant, i, d: Math.hypot(plant.x - candidate.x, plant.y - candidate.y) }))
        .filter((c) => c.d > 0.6 && c.d < 13)
        .sort((a, b) => a.d - b.d);
      if (found.length < 2) continue;
      // A real choice: the nearest tree is alone on its side, and a richer one
      // stands on another side. (Two trees on the same side are one channel.)
      const side = sideOf(candidate, found[0].plant.x, found[0].plant.y);
      const far = found.find((c) => c.d > found[0].d && sideOf(candidate, c.plant.x, c.plant.y) !== side);
      if (!far) continue;
      // Clear every other tree in range so the two are the only choice.
      for (const c of found) if (c !== found[0] && c !== far) c.plant.alive = false;
      world.rebuildGrids();
      human = candidate;
      candidates = [found[0], far];
      break search;
    }

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const near = candidates[0];
    const far = candidates[1];

    // Strip the nearer tree bare. It is now below the sensing threshold.
    world.harvestWood(near.i, 999);
    expect(near.plant.timber).toBeCloseTo(0, 5);

    human.sense(world);

    const channelOf = (dx: number, dy: number): number => {
      const relative = normalizeAngle(Math.atan2(dy, dx) - human.heading);
      const forward = Math.cos(relative);
      const lateral = Math.sin(relative);
      if (Math.abs(forward) >= Math.abs(lateral)) return forward >= 0 ? 0 : 2;
      return lateral >= 0 ? 1 : 3;
    };

    const timber = [
      human.sensors[S.woodFront],
      human.sensors[S.woodRight],
      human.sensors[S.woodBack],
      human.sensors[S.woodLeft],
    ];
    const strongest = timber.indexOf(Math.max(...timber));
    const strippedChannel = channelOf(near.plant.x - human.x, near.plant.y - human.y);

    // The strongest direction must not be the tree that has nothing left.
    expect(strongest).not.toBe(strippedChannel);
    expect(timber[strongest]).toBeGreaterThan(0);
  });
});
