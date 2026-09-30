import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import {
  CANAL_REACH,
  CANAL_SOURCE_RANGE,
  Field,
  FieldStage,
  FIELD_MOISTURE_FLOOR,
  FIELD_START_MOISTURE,
} from '../src/simulation/entities/cultivation';
import { Tile } from '../src/simulation/environment/terrain';
import { PlantSpecies } from '../src/simulation/entities/plant';
import { DT } from '../src/shared/constants';
import { wrapSave, unwrapSave } from '../src/simulation/persistence/save';

function makeWorld(seed: string): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialHumans: 8, initialPredators: 0 });
}

/** Canal lengths are staked this far apart: over the 2.2-tile spacing rule, inside the 2.5-tile flow link. */
const CANAL_SPACING = 2.35;

interface Site {
  field: { x: number; y: number };
  /** Canal positions from the water's edge to within reach of the field. */
  chain: Array<{ x: number; y: number }>;
}

/**
 * A grass tile out of the river's direct reach, and a canal route to it.
 *
 * The route follows the water-distance gradient from the field down to the
 * shore, then is resampled at canal spacing and reversed so it can be dug
 * outward from the water, the only order the world accepts.
 */
function findIrrigationSite(world: World): Site | null {
  const { tiles, width, height } = world.terrain;
  const distanceAt = (x: number, y: number): number => world.waterDistance[y * width + x];
  const passable = (x: number, y: number): boolean =>
    x > 0 && y > 0 && x < width - 1 && y < height - 1 && tiles[y * width + x] !== Tile.Rock;

  for (let y = 4; y < height - 4; y++) {
    for (let x = 4; x < width - 4; x++) {
      if (tiles[y * width + x] !== Tile.Grass) continue;
      const d = distanceAt(x, y);
      if (d < CANAL_SOURCE_RANGE + 4 || d > CANAL_SOURCE_RANGE + 6) continue;

      // Walk downhill in water distance to the shore.
      const path: Array<{ x: number; y: number }> = [{ x: x + 0.5, y: y + 0.5 }];
      let cx = x;
      let cy = y;
      let ok = true;
      while (distanceAt(cx, cy) > 1) {
        let next: [number, number] | null = null;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!passable(nx, ny)) continue;
          if (distanceAt(nx, ny) < distanceAt(cx, cy)) {
            next = [nx, ny];
            break;
          }
        }
        if (!next) {
          ok = false;
          break;
        }
        [cx, cy] = next;
        path.push({ x: cx + 0.5, y: cy + 0.5 });
      }
      if (!ok) continue;

      // Resample from the shore end at canal spacing, stopping within reach of the field.
      path.reverse();
      const field = path[path.length - 1];
      const chain: Array<{ x: number; y: number }> = [path[0]];
      let carried = 0;
      for (let i = 1; i < path.length; i++) {
        carried += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
        if (carried < CANAL_SPACING) continue;
        carried = 0;
        chain.push(path[i]);
        if (Math.hypot(path[i].x - field.x, path[i].y - field.y) <= CANAL_REACH - 1) break;
      }
      const last = chain[chain.length - 1];
      if (Math.hypot(last.x - field.x, last.y - field.y) > CANAL_REACH - 1) continue;
      if (Math.hypot(last.x - field.x, last.y - field.y) < 1) continue;
      // One cell, one object: the field owns a 3x3 square, so no canal may sit
      // in it and no tree may stand in it.
      if (chain.some((c) => Math.max(Math.abs(c.x - field.x), Math.abs(c.y - field.y)) < 2)) continue;
      const tree = world.plants.some(
        (p) => p.alive && p.species === PlantSpecies.Tree && Math.abs(p.x - field.x) <= 1 && Math.abs(p.y - field.y) <= 1,
      );
      if (tree) continue;
      return { field, chain };
    }
  }
  return null;
}

/** Stake and fully dig every length of a chain, in order. */
function digChain(world: World, chain: Site['chain']): boolean {
  const worker = world.humans[0];
  for (const point of chain) {
    const canal = world.foundCanal(point.x, point.y, worker);
    if (!canal) return false;
    const index = world.canals.indexOf(canal);
    for (let i = 0; i < 60; i++) world.digCanal(index, worker);
  }
  return true;
}

describe('field growth', () => {
  it('grows when watered and stalls below the moisture floor', () => {
    const wet = new Field(1, 0, 0);
    const dry = new Field(2, 0, 0);
    wet.sow(0, 'a');
    dry.sow(0, 'b');
    dry.moisture = FIELD_MOISTURE_FLOOR - 0.01;

    for (let i = 0; i < 200; i++) {
      wet.update(DT, true);
      dry.update(DT, false);
    }
    expect(wet.growth).toBeGreaterThan(0);
    expect(dry.growth).toBe(0);
    expect(wet.moisture).toBeGreaterThan(FIELD_START_MOISTURE);
  });

  it('ripens only from the growing stage, and harvest returns it to fallow', () => {
    const field = new Field(1, 0, 0);
    field.moisture = 1;
    for (let i = 0; i < 5000; i++) field.update(DT, true);
    // Unsown ground never ripens, however wet.
    expect(field.stage).toBe(FieldStage.Fallow);

    field.sow(0, 'a');
    let ticks = 0;
    while (!field.ripe && ticks < 100000) {
      field.update(DT, true);
      ticks++;
    }
    expect(field.ripe).toBe(true);
    expect(field.harvest(ticks, 'a')).toBe(true);
    expect(field.stage).toBe(FieldStage.Fallow);
    expect(field.harvest(ticks, 'a')).toBe(false);
  });
});

describe('irrigation', () => {
  const site = findIrrigationSite(makeWorld('irrigation'));

  it('finds an irrigation site on the test seed', () => {
    expect(site).not.toBeNull();
    expect(site!.chain.length).toBeGreaterThanOrEqual(3);
  });

  it('carries water along a finished chain, and not along a broken one', () => {
    const world = makeWorld('irrigation');
    expect(digChain(world, site!.chain)).toBe(true);
    world.updateCultivation();
    expect(world.canals.every((canal) => canal.flowing)).toBe(true);

    // Break the second length: everything beyond it runs dry. (The world will
    // not let anyone stake past an unfinished length, so the gap is made by
    // un-finishing one in an otherwise complete chain.)
    const broken = makeWorld('irrigation');
    expect(digChain(broken, site!.chain)).toBe(true);
    broken.canals[1].complete = false;
    broken.canals[1].progress = 0.5;
    broken.updateCultivation();
    expect(broken.canals[0].flowing).toBe(true);
    expect(broken.canals[1].flowing).toBe(false);
    for (let i = 2; i < broken.canals.length; i++) expect(broken.canals[i].flowing).toBe(false);
  });

  it('a canal causes a distant field to stay moist and ripen; the same field without one does not', () => {
    const grow = (withCanal: boolean): { moisture: number; growth: number; stage: number } => {
      const world = makeWorld('irrigation');
      const worker = world.humans[0];
      if (withCanal) expect(digChain(world, site!.chain)).toBe(true);
      const field = world.foundField(site!.field.x, site!.field.y, worker);
      expect(field).not.toBeNull();
      field!.sow(0, worker.name);
      // Twenty simulated minutes of weather, with no people in the way.
      for (let i = 0; i < 24000; i++) world.updateCultivation();
      return { moisture: field!.moisture, growth: field!.growth, stage: field!.stage };
    };

    const irrigated = grow(true);
    const control = grow(false);
    expect(irrigated.stage).toBe(FieldStage.Ripe);
    expect(irrigated.moisture).toBeGreaterThan(0.9);
    expect(control.moisture).toBeLessThan(FIELD_MOISTURE_FLOOR);
    expect(control.stage).toBe(FieldStage.Growing);
    expect(control.growth).toBeLessThan(0.5);
  });

  it('a flowing canal does not water a field beyond its reach', () => {
    const world = makeWorld('irrigation');
    expect(digChain(world, site!.chain)).toBe(true);
    world.updateCultivation();
    const last = site!.chain[site!.chain.length - 1];
    // Walk away from the last canal until we are out of reach and out of the river's reach.
    const { width } = world.terrain;
    let far: { x: number; y: number } | null = null;
    for (let r = CANAL_REACH + 2; r < CANAL_REACH + 12 && !far; r += 0.5) {
      for (let a = 0; a < 16; a++) {
        const x = last.x + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = last.y + Math.sin((a / 16) * Math.PI * 2) * r;
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (world.terrain.tiles[ty * width + tx] !== Tile.Grass) continue;
        if (world.waterDistance[ty * width + tx] <= CANAL_SOURCE_RANGE) continue;
        let nearest = Infinity;
        for (const canal of world.canals) nearest = Math.min(nearest, Math.hypot(canal.x - x, canal.y - y));
        if (nearest <= CANAL_REACH + 1) continue;
        far = { x, y };
        break;
      }
    }
    expect(far).not.toBeNull();
    const field = world.foundField(far!.x, far!.y, world.humans[0]);
    expect(field).not.toBeNull();
    for (let i = 0; i < 2000; i++) world.updateCultivation();
    expect(field!.moisture).toBeLessThan(FIELD_START_MOISTURE);
  });
});

describe('cultivation persistence', () => {
  it('round-trips fields and canals and continues identically', () => {
    const world = makeWorld('cultivation-save');
    const site = findIrrigationSite(world);
    expect(site).not.toBeNull();
    const worker = world.humans[0];
    digChain(world, site!.chain.slice(0, 2));
    // Leave one length half-dug.
    const partial = world.foundCanal(site!.chain[2].x, site!.chain[2].y, worker)!;
    for (let i = 0; i < 20; i++) world.digCanal(world.canals.indexOf(partial), worker);
    const field = world.foundField(site!.field.x, site!.field.y, worker)!;
    field.sow(world.tick, worker.name);
    for (let i = 0; i < 300; i++) world.step();

    const text = wrapSave(JSON.stringify(world.serialize()), world.seed, world.tick, world.simTime);
    const unwrapped = unwrapSave(text);
    expect(unwrapped.ok).toBe(true);
    const restored = World.deserialize(JSON.parse(unwrapped.payload!));

    expect(restored.fields.map((f) => f.toData())).toEqual(world.fields.map((f) => f.toData()));
    expect(restored.canals.map((c) => c.toData())).toEqual(world.canals.map((c) => c.toData()));

    for (let i = 0; i < 600; i++) {
      world.step();
      restored.step();
    }
    expect(restored.fields.map((f) => f.toData())).toEqual(world.fields.map((f) => f.toData()));
    expect(restored.canals.map((c) => c.toData())).toEqual(world.canals.map((c) => c.toData()));
    expect(restored.humans.map((h) => [h.id, h.x, h.y])).toEqual(world.humans.map((h) => [h.id, h.x, h.y]));
  });
});

describe('construction spacing', () => {
  it('refuses a new canal length while an unfinished one is close, and allows it once finished', () => {
    const world = makeWorld('irrigation');
    const site = findIrrigationSite(world)!;
    const worker = world.humans[0];
    const first = world.foundCanal(site.chain[0].x, site.chain[0].y, worker)!;
    expect(first).not.toBeNull();
    expect(world.foundCanal(site.chain[1].x, site.chain[1].y, worker)).toBeNull();
    for (let i = 0; i < 60; i++) world.digCanal(world.canals.indexOf(first), worker);
    expect(world.foundCanal(site.chain[1].x, site.chain[1].y, worker)).not.toBeNull();
  });
});
