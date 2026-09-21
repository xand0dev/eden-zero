import { Rng } from '../rng';
import { WORLD_H, WORLD_W } from '../../shared/constants';

/**
 * Terrain generation.
 *
 * A small deterministic value-noise fBm drives elevation and moisture. Water,
 * sand, grass, forest and rock fall out of those two fields. Everything is
 * derived from the world seed, so the same seed always yields the same island.
 */

export const Tile = {
  Water: 0,
  Shallow: 1,
  Sand: 2,
  Grass: 3,
  Forest: 4,
  Rock: 5,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export const TILE_NAMES = ['water', 'shallow', 'sand', 'grass', 'forest', 'rock'] as const;

/** True for tiles an entity cannot walk onto (but may drink from the edge). */
export function isImpassable(tile: number): boolean {
  return tile === Tile.Water || tile === Tile.Rock;
}

export function isWater(tile: number): boolean {
  return tile === Tile.Water || tile === Tile.Shallow;
}

export interface Shelter {
  x: number;
  y: number;
  radius: number;
}

export interface TerrainData {
  width: number;
  height: number;
  tiles: Uint8Array;
  elevation: Float32Array;
  moisture: Float32Array;
  /** Tiles where plants can take root. */
  fertile: Uint8Array;
  shelters: Shelter[];
}

// --- deterministic value noise ---------------------------------------------

function makeLattice(rng: Rng, size: number): Float32Array {
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
  return lattice;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function sampleLattice(lattice: Float32Array, size: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const xi0 = ((x0 % size) + size) % size;
  const yi0 = ((y0 % size) + size) % size;
  const xi1 = (xi0 + 1) % size;
  const yi1 = (yi0 + 1) % size;
  const v00 = lattice[yi0 * size + xi0];
  const v10 = lattice[yi0 * size + xi1];
  const v01 = lattice[yi1 * size + xi0];
  const v11 = lattice[yi1 * size + xi1];
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

function fbm(lattice: Float32Array, size: number, x: number, y: number, octaves: number): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * sampleLattice(lattice, size, x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

export function generateTerrain(seed: number | string, width = WORLD_W, height = WORLD_H): TerrainData {
  const rng = new Rng(`${seed}:terrain`);
  const LATTICE = 64;
  const elevationLattice = makeLattice(rng, LATTICE);
  const moistureLattice = makeLattice(rng, LATTICE);
  const detailLattice = makeLattice(rng, LATTICE);

  const tiles = new Uint8Array(width * height);
  const elevation = new Float32Array(width * height);
  const moisture = new Float32Array(width * height);
  const fertile = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x / width) * 4.2;
      const ny = (y / height) * 3.4;

      // Radial falloff pushes the coastline inward so we get an island rather
      // than an ocean with random land at the edges.
      const dx = (x / (width - 1)) * 2 - 1;
      const dy = (y / (height - 1)) * 2 - 1;
      const radial = Math.sqrt(dx * dx * 0.85 + dy * dy * 1.15);
      const falloff = Math.max(0, 1 - radial * radial * 1.02);

      const base = fbm(elevationLattice, LATTICE, nx, ny, 5);
      const detail = fbm(detailLattice, LATTICE, nx * 3.1, ny * 3.1, 3);
      const e = base * 0.78 + detail * 0.22;
      const height01 = e * falloff + 0.06;

      const m = fbm(moistureLattice, LATTICE, nx * 0.9 + 11, ny * 0.9 + 7, 4);

      const index = y * width + x;
      elevation[index] = height01;
      moisture[index] = m;

      let tile: number;
      if (height01 < 0.315) tile = Tile.Water;
      else if (height01 < 0.355) tile = Tile.Shallow;
      else if (height01 < 0.395) tile = Tile.Sand;
      else if (height01 > 0.78) tile = Tile.Rock;
      else if (m > 0.545 && height01 > 0.44) tile = Tile.Forest;
      else tile = Tile.Grass;

      tiles[index] = tile;
      fertile[index] = tile === Tile.Grass || tile === Tile.Forest ? 1 : 0;
    }
  }

  // Shelter zones: a handful of rocky outcrops that moderate temperature.
  const shelters: Shelter[] = [];
  const attempts = 140;
  for (let a = 0; a < attempts && shelters.length < 6; a++) {
    const x = rng.range(6, width - 6);
    const y = rng.range(6, height - 6);
    const tile = tiles[Math.floor(y) * width + Math.floor(x)];
    if (tile === Tile.Rock || tile === Tile.Forest) {
      let tooClose = false;
      for (const s of shelters) {
        if (Math.hypot(s.x - x, s.y - y) < 24) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) shelters.push({ x, y, radius: rng.range(4, 7) });
    }
  }
  // Guarantee at least one shelter so the "shelter zone" feature always exists.
  if (shelters.length === 0) {
    shelters.push({ x: width * 0.5, y: height * 0.5, radius: 6 });
  }

  return { width, height, tiles, elevation, moisture, fertile, shelters };
}

export function tileAt(terrain: TerrainData, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= terrain.width || ty >= terrain.height) return Tile.Rock;
  return terrain.tiles[ty * terrain.width + tx];
}

export function isWalkableAt(terrain: TerrainData, x: number, y: number): boolean {
  return !isImpassable(tileAt(terrain, x, y));
}

/** Find the nearest walkable position to (x, y), spiralling outwards. */
export function nearestWalkable(terrain: TerrainData, x: number, y: number, maxRadius = 24): [number, number] {
  if (isWalkableAt(terrain, x, y)) return [x, y];
  for (let r = 1; r <= maxRadius; r++) {
    for (let a = 0; a < 12; a++) {
      const angle = (a / 12) * Math.PI * 2;
      const px = x + Math.cos(angle) * r;
      const py = y + Math.sin(angle) * r;
      if (isWalkableAt(terrain, px, py)) return [px, py];
    }
  }
  return [x, y];
}

/**
 * Distance (in tiles, saturated at 255) from every tile to the nearest fresh
 * water. Computed once with a multi-source BFS from all water tiles.
 *
 * This exists because a founder dropped in the middle of a large island
 * dehydrates long before it can find a river, which makes the default world
 * unplayable for reasons that have nothing to do with the neural model. Real
 * populations settle near water; so do ours.
 */
export function computeWaterDistance(terrain: TerrainData): Uint8Array {
  const { width, height, tiles } = terrain;
  const distance = new Uint8Array(width * height).fill(255);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < tiles.length; i++) {
    if (isWater(tiles[i])) {
      distance[i] = 0;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = (index / width) | 0;
    const next = distance[index] + 1;
    if (next >= 255) continue;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIndex = ny * width + nx;
      if (distance[nIndex] <= next) continue;
      distance[nIndex] = next;
      queue[tail++] = nIndex;
    }
  }

  return distance;
}

export function waterDistanceAt(terrain: TerrainData, distance: Uint8Array, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= terrain.width || ty >= terrain.height) return 255;
  return distance[ty * terrain.width + tx];
}
