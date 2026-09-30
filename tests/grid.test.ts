import { describe, expect, it } from 'vitest';
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { FOOTPRINT, Occupancy, Occupant } from '../src/simulation/spatial/occupancy';

function makeWorld(seed = 'grid'): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialHumans: 8, initialPredators: 0 });
}

const onCentre = (v: number): boolean => Math.abs(v - Math.floor(v) - 0.5) < 1e-9;

/** Every standing object, with the square it owns. */
function objects(world: World): Array<{ id: number; x: number; y: number; half: number }> {
  const out: Array<{ id: number; x: number; y: number; half: number }> = [];
  for (const p of world.plants) if (p.alive) out.push({ id: p.id, x: p.x, y: p.y, half: 0 });
  for (const c of world.canals) out.push({ id: c.id, x: c.x, y: c.y, half: FOOTPRINT.canal });
  for (const f of world.fields) out.push({ id: f.id, x: f.x, y: f.y, half: FOOTPRINT.field });
  for (const s of world.structures) out.push({ id: s.id, x: s.x, y: s.y, half: FOOTPRINT.structure });
  return out;
}

function assertOneObjectPerCell(world: World): void {
  const owner = new Map<number, number>();
  for (const o of objects(world)) {
    expect(onCentre(o.x) && onCentre(o.y)).toBe(true);
    for (let dy = -o.half; dy <= o.half; dy++) {
      for (let dx = -o.half; dx <= o.half; dx++) {
        const cell = (Math.floor(o.y) + dy) * world.terrain.width + Math.floor(o.x) + dx;
        const previous = owner.get(cell);
        if (previous !== undefined) throw new Error(`cell ${cell} holds both ${previous} and ${o.id}`);
        owner.set(cell, o.id);
      }
    }
  }
}

describe('the land grid', () => {
  it('claims, refuses a second claim, and releases', () => {
    const land = new Occupancy(10, 10);
    expect(land.claim(3.2, 4.9, Occupant.Plant, 7)).toBe(true);
    expect(land.claim(3.7, 4.1, Occupant.Canal, 8)).toBe(false);
    expect(land.ownerAt(3.5, 4.5)).toBe(7);
    expect(land.squareFree(4.5, 4.5, 1)).toBe(false);
    expect(land.squareFree(4.5, 4.5, 1, (kind) => kind === Occupant.Plant)).toBe(true);
    land.releaseSquare(3.5, 4.5, 0, 7);
    expect(land.isFree(3.5, 4.5)).toBe(true);
  });

  it('finds the nearest free cell deterministically', () => {
    const land = new Occupancy(10, 10);
    land.claimSquare(5.5, 5.5, 1, Occupant.Structure, 1);
    const spot = land.nearestFree(5.5, 5.5, 3, () => true);
    expect(spot).toEqual([5.5, 3.5]);
    expect(land.nearestFree(5.5, 5.5, 3, () => true)).toEqual(spot);
  });

  it('a new world puts every plant on its own cell centre', () => {
    const world = makeWorld();
    assertOneObjectPerCell(world);
    expect(world.land.countOwned()).toBe(world.plants.filter((p) => p.alive).length);
  });

  it('after a long run, no two objects share a cell', () => {
    const world = makeWorld('grid-run');
    for (let i = 0; i < 6000; i++) world.step();
    world.rebuildGrids();
    assertOneObjectPerCell(world);
  });

  it('a field clears the grass under it and refuses a tree', () => {
    const world = makeWorld('grid-field');
    const worker = world.humans[0];
    // Find open grass with a free 3x3 square.
    let placed = null;
    for (let y = 4; y < world.terrain.height - 4 && !placed; y++) {
      for (let x = 4; x < world.terrain.width - 4 && !placed; x++) {
        placed = world.foundField(x + 0.3, y + 0.8, worker);
      }
    }
    expect(placed).not.toBeNull();
    expect(onCentre(placed!.x) && onCentre(placed!.y)).toBe(true);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        expect(world.land.kindAt(placed!.x + dx, placed!.y + dy)).toBe(Occupant.Field);
      }
    }
    for (const p of world.plants) {
      if (!p.alive) continue;
      expect(Math.abs(p.x - placed!.x) <= 1 && Math.abs(p.y - placed!.y) <= 1).toBe(false);
    }
  });
});
