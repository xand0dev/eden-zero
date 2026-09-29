import { base64ToFloat32, float32ToBase64 } from '../persistence/binary';

/**
 * Worn paths.
 *
 * Every step wears the ground a little; unused ground grows back. The routes the
 * inhabitants actually take — hut to river, village to field — become visible
 * trails without anyone laying them out, and once the settlement is a village
 * (era III), walking on a worn trail is faster. The path network is a record of
 * behaviour, drawn on the land.
 */

/** Wear added per tick a person stands on a tile. */
const WEAR_PER_TICK = 0.006;
/** Fraction of wear lost per simulated second. */
const REGROW_PER_SECOND = 1 / 900;
/** Wear at which a tile counts as a trail. */
export const PATH_THRESHOLD = 0.4;
/** Walking speed on a trail, once the village knows how to keep one. */
export const PATH_SPEED = 1.25;

export class Paths {
  readonly width: number;
  readonly height: number;
  readonly wear: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.wear = new Float32Array(width * height);
  }

  private index(x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return -1;
    return ty * this.width + tx;
  }

  at(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? 0 : this.wear[i];
  }

  isTrail(x: number, y: number): boolean {
    return this.at(x, y) >= PATH_THRESHOLD;
  }

  tread(x: number, y: number): void {
    const i = this.index(x, y);
    if (i < 0) return;
    const value = this.wear[i] + WEAR_PER_TICK;
    this.wear[i] = value > 1 ? 1 : value;
  }

  regrow(dt: number): void {
    const k = REGROW_PER_SECOND * dt;
    const w = this.wear;
    for (let i = 0; i < w.length; i++) {
      const value = w[i];
      if (value > 0) w[i] = value > k ? value - k : 0;
    }
  }

  /** Number of trail tiles, for statistics. */
  trailTiles(): number {
    let count = 0;
    for (let i = 0; i < this.wear.length; i++) if (this.wear[i] >= PATH_THRESHOLD) count++;
    return count;
  }

  /** One byte per tile, for the renderer and the save. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.wear.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(this.wear[i] * 255);
    return bytes;
  }

  /** Exact: trails change walking speed from the village era on. */
  serialize(): string {
    return float32ToBase64(this.wear);
  }

  restore(data: string | undefined): void {
    if (!data) return;
    base64ToFloat32(data, this.wear);
  }
}
