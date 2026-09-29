import { Texture } from 'pixi.js';
import { isWater, type TerrainData } from '../simulation/environment/terrain';

/**
 * The look of the year: a seasonal colour mood, a snow cover and worn trails.
 *
 * Everything here is paint over the same baked island. The season changes the
 * grade the whole diorama is seen through — fresh greens in spring, a warm haze
 * in summer, rust in autumn, a cold pale light in winter — and winter lays a
 * snow texture over the land that fades in and out with the cold.
 */

export interface Mood {
  /** Per-channel multiply. */
  tint: [number, number, number];
  saturation: number;
  brightness: number;
}

export const NEUTRAL_MOOD: Mood = { tint: [1, 1, 1], saturation: 1, brightness: 1 };

/** Spring, summer, autumn, winter, at the middle of each season. */
const SEASON_MOODS: Mood[] = [
  { tint: [0.98, 1.04, 0.98], saturation: 1.08, brightness: 1.02 },
  { tint: [1.05, 1.01, 0.9], saturation: 1.05, brightness: 1.03 },
  { tint: [1.1, 0.95, 0.8], saturation: 0.96, brightness: 0.98 },
  { tint: [0.92, 0.98, 1.1], saturation: 0.7, brightness: 1.04 },
];

function mix(a: Mood, b: Mood, t: number): Mood {
  return {
    tint: [a.tint[0] + (b.tint[0] - a.tint[0]) * t, a.tint[1] + (b.tint[1] - a.tint[1]) * t, a.tint[2] + (b.tint[2] - a.tint[2]) * t],
    saturation: a.saturation + (b.saturation - a.saturation) * t,
    brightness: a.brightness + (b.brightness - a.brightness) * t,
  };
}

/**
 * The mood for a point in the year, blended between season centres, with a
 * crisis laid on top: drought bleaches toward yellow, a harsh winter toward
 * white-blue, a wildfire toward orange.
 */
export function moodFor(season: number, seasonPhase: number, crisis: string | null): Mood {
  const position = season + seasonPhase - 0.5;
  const index = Math.floor(position);
  const t = position - index;
  const blend = 0.5 - 0.5 * Math.cos(Math.PI * t);
  let mood = mix(SEASON_MOODS[((index % 4) + 4) % 4], SEASON_MOODS[(index + 1 + 4) % 4], blend);
  if (crisis === 'drought') mood = mix(mood, { tint: [1.12, 1.02, 0.72], saturation: 0.72, brightness: 1.06 }, 0.7);
  if (crisis === 'harshWinter') mood = mix(mood, { tint: [0.9, 0.97, 1.16], saturation: 0.55, brightness: 1.06 }, 0.6);
  if (crisis === 'fire') mood = mix(mood, { tint: [1.14, 0.92, 0.78], saturation: 1.0, brightness: 0.96 }, 0.5);
  if (crisis === 'blight') mood = mix(mood, { tint: [1.0, 0.96, 0.9], saturation: 0.85, brightness: 0.98 }, 0.4);
  return mood;
}

/** How much snow lies on the ground, 0..1, from the season and a harsh winter. */
export function snowCover(season: number, seasonPhase: number, harshWinter: boolean): number {
  let cover = 0;
  if (season === 3) cover = Math.min(1, seasonPhase * 3) * (seasonPhase > 0.85 ? (1 - seasonPhase) / 0.15 : 1);
  if (season === 2 && seasonPhase > 0.85) cover = (seasonPhase - 0.85) / 0.15 * 0.3;
  if (harshWinter) cover = Math.max(cover, 0.9);
  return Math.max(0, Math.min(1, cover));
}

function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * Snow over the land: thicker on high ground and in the open, thinner under
 * the forest, none on water. Drifts are soft-edged noise so it reads as snow
 * lying, not as a white rectangle.
 */
export function makeSnowTexture(terrain: TerrainData): Texture {
  const S = 4;
  const W = terrain.width * S;
  const H = terrain.height * S;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(W, H);
  const data = image.data;
  for (let py = 0; py < H; py++) {
    const ty = Math.floor(py / S);
    for (let px = 0; px < W; px++) {
      const tx = Math.floor(px / S);
      const index = ty * terrain.width + tx;
      const tile = terrain.tiles[index];
      if (isWater(tile)) continue;
      const forest = tile === 4;
      const height = terrain.elevation[index];
      const n = 0.6 * hash(px >> 2, py >> 2) + 0.4 * hash(px, py);
      let alpha = 0.55 + 0.35 * Math.min(1, height * 1.4) - (forest ? 0.3 : 0) + (n - 0.5) * 0.35;
      alpha = Math.max(0, Math.min(0.92, alpha));
      const o = (py * W + px) * 4;
      data[o] = 236 + n * 16;
      data[o + 1] = 242 + n * 10;
      data[o + 2] = 250;
      data[o + 3] = alpha * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'linear';
  return texture;
}

/** Worn ground as a texture: one pixel per tile, alpha by wear. */
export function paintTrails(canvas: HTMLCanvasElement, wear: Uint8Array, width: number, height: number): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let i = 0; i < wear.length && i < width * height; i++) {
    const w = wear[i] / 255;
    // Faint where people pass now and then, clear where they walk every day.
    const alpha = w < 0.12 ? 0 : Math.min(0.62, (w - 0.12) * 1.1);
    const o = i * 4;
    data[o] = 150;
    data[o + 1] = 122;
    data[o + 2] = 84;
    data[o + 3] = alpha * 255;
  }
  ctx.putImageData(image, 0, 0);
}
