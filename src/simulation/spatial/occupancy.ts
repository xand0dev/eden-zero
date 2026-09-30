/**
 * The land grid: one cell, one object.
 *
 * This is the first Rule of Creation (see `genesis/rules.ts`). The island is a
 * grid of one-tile cells; everything that stands still — a plant, a food pile, a
 * length of canal, a field, a building — sits on the grid and owns the cells
 * under it. Nothing else may stand in an owned cell. People and predators are
 * not on the grid: they walk freely between and across the cells.
 *
 * Before this existed a bush could sprout inside a hut, a harvest could land on
 * top of a canal and two fields could overlap, and the map read as noise. Now a
 * look at the island tells you what is where.
 *
 * The grid is rebuilt from the objects at the top of every tick (cheap: one pass
 * over ~22 000 cells and the object lists) and claimed incrementally as objects
 * appear during the tick, so nothing has to track removals — a dead plant simply
 * is not re-claimed next tick.
 */

export const Occupant = {
  None: 0,
  Plant: 1,
  Structure: 2,
  Field: 3,
  Canal: 4,
} as const;
export type Occupant = (typeof Occupant)[keyof typeof Occupant];

/** Half-width of the square an object owns: 0 is one cell, 1 is three by three. */
export const FOOTPRINT = {
  plant: 0,
  canal: 0,
  field: 1,
  structure: 1,
} as const;

/** The centre of the cell a coordinate falls in. */
export function snap(value: number): number {
  return Math.floor(value) + 0.5;
}

export class Occupancy {
  readonly width: number;
  readonly height: number;
  /** What owns each cell. */
  readonly kind: Uint8Array;
  /** The id of the entity that owns each cell (entity ids, not list indices). */
  readonly owner: Int32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.kind = new Uint8Array(width * height);
    this.owner = new Int32Array(width * height);
  }

  clear(): void {
    this.kind.fill(0);
    this.owner.fill(0);
  }

  /** Cell index of a coordinate, or -1 off the map. */
  cellOf(x: number, y: number): number {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return -1;
    return cy * this.width + cx;
  }

  kindAt(x: number, y: number): Occupant {
    const cell = this.cellOf(x, y);
    return cell < 0 ? Occupant.None : (this.kind[cell] as Occupant);
  }

  ownerAt(x: number, y: number): number {
    const cell = this.cellOf(x, y);
    return cell < 0 ? 0 : this.owner[cell];
  }

  isFree(x: number, y: number): boolean {
    const cell = this.cellOf(x, y);
    return cell >= 0 && this.kind[cell] === Occupant.None;
  }

  /** Claim one cell. False if it is off the map or already owned. */
  claim(x: number, y: number, kind: Occupant, id: number): boolean {
    const cell = this.cellOf(x, y);
    if (cell < 0 || this.kind[cell] !== Occupant.None) return false;
    this.kind[cell] = kind;
    this.owner[cell] = id;
    return true;
  }

  /**
   * Claim the square of half-width `half` around a cell, cell by cell, skipping
   * cells already owned. Used when the grid is rebuilt, where the objects are
   * already placed and the only question is who got there first.
   */
  claimSquare(x: number, y: number, half: number, kind: Occupant, id: number): void {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) this.claim(cx + dx + 0.5, cy + dy + 0.5, kind, id);
    }
  }

  /**
   * Whether every cell of the square is on the map and either free or owned by
   * something `yields` says may be displaced (grass, for instance, gives way to
   * a field).
   */
  squareFree(x: number, y: number, half: number, yields?: (kind: Occupant, id: number) => boolean): boolean {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const cell = this.cellOf(cx + dx + 0.5, cy + dy + 0.5);
        if (cell < 0) return false;
        const kind = this.kind[cell] as Occupant;
        if (kind === Occupant.None) continue;
        if (!yields || !yields(kind, this.owner[cell])) return false;
      }
    }
    return true;
  }

  /** Ids of whatever owns cells of the square, each once, in cell order. */
  ownersInSquare(x: number, y: number, half: number, kind: Occupant, out: number[]): number[] {
    out.length = 0;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const cell = this.cellOf(cx + dx + 0.5, cy + dy + 0.5);
        if (cell < 0 || this.kind[cell] !== kind) continue;
        const id = this.owner[cell];
        if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /** Release every cell owned by `id`. */
  releaseSquare(x: number, y: number, half: number, id: number): void {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const cell = this.cellOf(cx + dx + 0.5, cy + dy + 0.5);
        if (cell >= 0 && this.owner[cell] === id) {
          this.kind[cell] = Occupant.None;
          this.owner[cell] = 0;
        }
      }
    }
  }

  /**
   * The centre of the nearest free cell that `accept` allows, searching square
   * rings outward from the cell under (x, y). Rings are walked in a fixed order,
   * so the answer is deterministic. Null if nothing within `maxRing`.
   */
  nearestFree(
    x: number,
    y: number,
    maxRing: number,
    accept: (cx: number, cy: number) => boolean,
  ): [number, number] | null {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let ring = 0; ring <= maxRing; ring++) {
      // Within a ring, the closest cell wins (edges before corners); ties go to
      // the first in scan order.
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const d = dx * dx + dy * dy;
          if (d >= bestD) continue;
          const px = cx + dx + 0.5;
          const py = cy + dy + 0.5;
          if (this.isFree(px, py) && accept(px, py)) {
            best = [px, py];
            bestD = d;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Cells owned, for the tests and the stats panel. */
  countOwned(): number {
    let count = 0;
    for (let i = 0; i < this.kind.length; i++) if (this.kind[i] !== Occupant.None) count++;
    return count;
  }
}
