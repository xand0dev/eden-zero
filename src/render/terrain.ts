import { Texture } from 'pixi.js';
import type { TerrainData } from '../simulation/environment/terrain';

/**
 * The ground, baked once per world.
 *
 * The simulation thinks in tiles; the observer should not have to. Every value
 * here is sampled from the *continuous* elevation and moisture fields the
 * terrain was generated from, with the same thresholds, so a coastline drawn
 * between two tile centres is exactly where the simulation would put it — only
 * smooth instead of stepped. Relief is lit from the north-west, the one light
 * every object in the scene agrees on.
 */

/** Pixels per tile in the baked ground texture. */
export const TERRAIN_SCALE = 12;

// Thresholds, matching `generateTerrain`.
const WATER = 0.315;
const SHALLOW = 0.355;
const SAND = 0.395;
const ROCK = 0.78;
const FOREST_MOISTURE = 0.545;
const FOREST_ELEVATION = 0.44;

type RGB = [number, number, number];

/** Open sea. Exported so the canvas behind the map is the same ocean. */
export const DEEP_SEA = 0x0b2238;
const DEEP: RGB = [11, 34, 56];
const MID_WATER: RGB = [20, 66, 92];
const SHALLOW_WATER: RGB = [44, 118, 128];
const LAGOON: RGB = [86, 156, 150];
const WET_SAND: RGB = [150, 132, 94];
const SAND_C: RGB = [206, 186, 138];
const MEADOW_DRY: RGB = [132, 146, 78];
const MEADOW: RGB = [92, 132, 62];
const MEADOW_LUSH: RGB = [66, 116, 58];
const FOREST_FLOOR: RGB = [46, 78, 44];
const FOREST_DEEP: RGB = [34, 62, 38];
const ROCK_C: RGB = [118, 114, 106];
const ROCK_HIGH: RGB = [156, 150, 140];

export interface BakedTerrain {
  ground: Texture;
  /** Additive sparkle layers over the water, crossfaded by the renderer. */
  shimmer: [Texture, Texture];
}

export function bakeTerrain(terrain: TerrainData): BakedTerrain {
  return {
    ground: linearTexture(paintTerrain(terrain, TERRAIN_SCALE)),
    shimmer: [bakeShimmer(terrain, 1), bakeShimmer(terrain, 2)],
  };
}

/**
 * Paint the ground into a canvas at `S` pixels per tile.
 *
 * Shared by the world renderer and the Genesis screen's island preview, so the
 * island you are shown before you press Genesis is the island you get.
 */
export function paintTerrain(terrain: TerrainData, S: number): HTMLCanvasElement {
  const W = terrain.width * S;
  const H = terrain.height * S;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  const image = context.createImageData(W, H);
  const data = image.data;

  const elev = (tx: number, ty: number): number => sampleField(terrain, terrain.elevation, tx, ty);
  // Light from the north-west, fairly low, so gentle relief still reads.
  const lx = -0.55;
  const ly = -0.62;
  const lz = 0.56;
  const flat = lz;

  const color: RGB = [0, 0, 0];
  for (let py = 0; py < H; py++) {
    const ty = (py + 0.5) / S - 0.5;
    for (let px = 0; px < W; px++) {
      const tx = (px + 0.5) / S - 0.5;
      // A little sub-tile wobble so coastlines and forest edges are organic
      // rather than bilinear diamonds. Small enough never to move an edge by
      // more than a fraction of a tile.
      const wobble = (fbm2(tx * 0.9, ty * 0.9) - 0.5) * 0.016 + (vnoise(tx * 2.2, ty * 2.2) - 0.5) * 0.003;
      const e = elev(tx, ty) + wobble;
      const m = sampleField(terrain, terrain.moisture, tx, ty) + (vnoise(tx * 0.7 + 40, ty * 0.7) - 0.5) * 0.03;
      const grain = vnoise(tx * 11, ty * 11) - 0.5;
      const patch = fbm2(tx * 0.35 + 17, ty * 0.35 + 5);

      if (e < SHALLOW) {
        // Water: depth-graded, lighter over the shelf.
        const depth = clamp01((SHALLOW - e) / 0.16);
        if (depth > 0.55) mix(MID_WATER, DEEP, (depth - 0.55) / 0.45, color);
        else if (depth > 0.18) mix(SHALLOW_WATER, MID_WATER, (depth - 0.18) / 0.37, color);
        else mix(LAGOON, SHALLOW_WATER, depth / 0.18, color);
        // Soft caustic mottling in the shallows.
        const caustic = (fbm2(tx * 1.6 + 3, ty * 1.6 + 9) - 0.5) * (1 - depth) * 22;
        add(color, caustic + grain * 3);
        // Foam where the water meets the beach.
        const foam = smoothstep(SHALLOW - 0.012, SHALLOW - 0.001, e);
        mix(color, [214, 232, 226], foam * 0.55, color);
      } else {
        // Land.
        if (e < SAND) {
          const t = smoothstep(SHALLOW, SAND, e);
          mix(WET_SAND, SAND_C, Math.min(1, t * 1.6), color);
          add(color, grain * 14);
        } else if (e > ROCK - 0.03) {
          const t = smoothstep(ROCK - 0.03, ROCK + 0.05, e);
          const meadow = landColor(m, e, patch);
          mix(meadow, e > ROCK ? ROCK_HIGH : ROCK_C, t, color);
          add(color, grain * 18 + (vnoise(tx * 2.4, ty * 2.4) - 0.5) * 20 * t);
        } else {
          const lc = landColor(m, e, patch);
          color[0] = lc[0];
          color[1] = lc[1];
          color[2] = lc[2];
          add(color, grain * 12);
        }
        // Beach blends into the meadow instead of stopping at a line.
        if (e >= SAND && e < SAND + 0.03) mix(color, SAND_C, (1 - smoothstep(SAND, SAND + 0.03, e)) * 0.6, color);

        // Hillshade.
        const dx = (elev(tx + 0.5, ty) - elev(tx - 0.5, ty)) * 34;
        const dy = (elev(tx, ty + 0.5) - elev(tx, ty - 0.5)) * 34;
        const nlen = Math.hypot(dx, dy, 1);
        const shade = (-dx * lx - dy * ly + lz) / nlen / flat;
        const k = 1 + (shade - 1) * 0.55;
        color[0] *= k;
        color[1] *= k;
        color[2] *= k * 0.97 + 0.03;
      }

      const i = (py * W + px) * 4;
      data[i] = clampByte(color[0]);
      data[i + 1] = clampByte(color[1]);
      data[i + 2] = clampByte(color[2]);
      data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  // Shelter zones: warm rocky clearings.
  context.globalCompositeOperation = 'soft-light';
  for (const shelter of terrain.shelters) {
    const cx = shelter.x * S;
    const cy = shelter.y * S;
    const radius = shelter.radius * S;
    const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(255, 196, 120, 0.55)');
    gradient.addColorStop(1, 'rgba(255, 196, 120, 0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = 'source-over';
  return canvas;
}

/** Grass, meadow and forest floor for a point, from moisture and elevation. */
function landColor(m: number, e: number, patch: number): RGB {
  const out: RGB = [0, 0, 0];
  const forest = smoothstep(FOREST_MOISTURE - 0.02, FOREST_MOISTURE + 0.015, m) * smoothstep(FOREST_ELEVATION - 0.015, FOREST_ELEVATION + 0.01, e);
  // Meadow: drier and yellower on high, dry ground; lusher where it is wet.
  const wet = clamp01((m - 0.35) / 0.25);
  mix(MEADOW_DRY, MEADOW, clamp01(wet * 1.3), out);
  mix(out, MEADOW_LUSH, clamp01(wet - 0.5) * 0.8, out);
  // Large soft patches, so a meadow is never one flat colour.
  mix(out, patch > 0.5 ? MEADOW_DRY : MEADOW_LUSH, Math.abs(patch - 0.5) * 0.7, out);
  if (forest > 0) {
    const floor: RGB = [0, 0, 0];
    mix(FOREST_FLOOR, FOREST_DEEP, clamp01((m - FOREST_MOISTURE) / 0.12), floor);
    mix(out, floor, forest, out);
  }
  return out;
}

/**
 * Sparkle over the water only: short bright glints, thinning out in deep water.
 * Two variants with different glints are crossfaded so the sea glitters.
 */
function bakeShimmer(terrain: TerrainData, variant: number): Texture {
  const S = 8;
  const W = terrain.width * S;
  const H = terrain.height * S;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(W, H);
  const data = image.data;
  for (let py = 0; py < H; py++) {
    const ty = (py + 0.5) / S - 0.5;
    for (let px = 0; px < W; px++) {
      const tx = (px + 0.5) / S - 0.5;
      const e = sampleField(terrain, terrain.elevation, tx, ty);
      if (e >= SHALLOW - 0.004) continue;
      const depth = clamp01((SHALLOW - e) / 0.16);
      // Horizontal glints: stretched noise, thresholded.
      const n = vnoise(tx * 1.6 + variant * 31, ty * 9 + variant * 17) * vnoise(tx * 0.5 + variant * 7, ty * 0.5 + 3);
      const glint = smoothstep(0.55, 0.8, n) * (0.4 + 0.6 * (1 - depth));
      if (glint <= 0) continue;
      const i = (py * W + px) * 4;
      data[i] = 200;
      data[i + 1] = 232;
      data[i + 2] = 255;
      data[i + 3] = clampByte(glint * 95);
    }
  }
  context.putImageData(image, 0, 0);
  return linearTexture(canvas);
}

function linearTexture(canvas: HTMLCanvasElement): Texture {
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'linear';
  texture.source.autoGenerateMipmaps = true;
  texture.source.updateMipmaps();
  return texture;
}

// --- sampling --------------------------------------------------------------

/** Bilinear sample of a per-tile field at a continuous tile coordinate (tile centres at integers). */
function sampleField(terrain: TerrainData, field: Float32Array, tx: number, ty: number): number {
  const w = terrain.width;
  const h = terrain.height;
  const x = Math.max(0, Math.min(w - 1.001, tx));
  const y = Math.max(0, Math.min(h - 1.001, ty));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const a = field[i];
  const b = field[i + 1];
  const c = field[i + w];
  const d = field[i + w + 1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function vnoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function fbm2(x: number, y: number): number {
  return vnoise(x, y) * 0.6 + vnoise(x * 2.03 + 11, y * 2.03 + 7) * 0.28 + vnoise(x * 4.1 + 3, y * 4.1 + 19) * 0.12;
}

function mix(a: RGB, b: RGB, t: number, out: RGB): RGB {
  const k = clamp01(t);
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
  return out;
}

function add(c: RGB, v: number): void {
  c[0] += v;
  c[1] += v;
  c[2] += v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
