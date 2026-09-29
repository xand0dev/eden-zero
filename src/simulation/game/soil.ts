import { base64ToFloat32, float32ToBase64 } from '../persistence/binary';
import { TUNING } from './tuning';

export { base64ToFloat32, bytesToBase64, base64ToBytes, float32ToBase64 } from '../persistence/binary';

/**
 * Soil fertility — the world's carrying capacity.
 *
 * Before this existed, food was effectively unlimited: a grass tuft regrew its
 * whole crop in about twenty seconds, so the land around a village could feed
 * tens of thousands. The measured result was a bimodal world — villages either
 * died out for reasons unrelated to food, or grew until they hit the hard
 * population cap and the tick rate collapsed.
 *
 * Grazing now exhausts the ground a plant stands on, and exhausted ground
 * regrows slowly and does not take new seed. Land that is left alone recovers
 * over a day or two. A village therefore has a real limit set by how much land
 * it can reach — and fields, which yield far more per tile, raise that limit.
 * That is the whole economic reason to farm, and nothing tells anyone to do it.
 */

// The two rates live in `TUNING` (fertilityPerFood, soilRecovery) so balance
// sweeps can vary them without copying the code.
/** Below this fertility a seed that lands will not take root. */
export const SOIL_SEED_FLOOR = 0.35;
/** How often recovery runs, in ticks. Recovery is slow; running it every tick is waste. */
export const SOIL_UPDATE_INTERVAL = 20;

export class Soil {
  readonly width: number;
  readonly height: number;
  readonly fertility: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.fertility = new Float32Array(width * height).fill(1);
  }

  private index(x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return -1;
    return ty * this.width + tx;
  }

  at(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? 0 : this.fertility[i];
  }

  /**
   * How fast a plant on this tile regrows, 0..1.
   *
   * Quadratic so that lightly grazed land still feeds well and heavily grazed
   * land nearly stops: the difference between a meadow and a trampled camp.
   */
  regenFactor(x: number, y: number): number {
    const f = this.at(x, y);
    return f * f;
  }

  /** Record that `food` units were eaten from the plant at (x, y). */
  graze(x: number, y: number, food: number, scale = 1): void {
    const i = this.index(x, y);
    if (i < 0) return;
    this.fertility[i] = Math.max(0, this.fertility[i] - food * TUNING.fertilityPerFood * scale);
  }

  /** Add fertility around a point (rain, ash). */
  enrich(x: number, y: number, radius: number, amount: number): void {
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const i = this.index(x + dx, y + dy);
        if (i < 0) continue;
        this.fertility[i] = Math.min(1, this.fertility[i] + amount);
      }
    }
  }

  /** Advance recovery by `dt` simulated seconds at `rate` times the base rate. */
  recover(dt: number, rate: number): void {
    const k = Math.min(1, TUNING.soilRecovery * rate * dt);
    const f = this.fertility;
    for (let i = 0; i < f.length; i++) {
      const value = f[i];
      if (value < 1) f[i] = value + (1 - value) * k;
    }
  }

  /** Mean fertility of a disc, for the observatory. */
  meanAround(x: number, y: number, radius: number): number {
    let sum = 0;
    let count = 0;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const i = this.index(x + dx, y + dy);
        if (i < 0) continue;
        sum += this.fertility[i];
        count++;
      }
    }
    return count > 0 ? sum / count : 1;
  }

  /**
   * Exact, not quantised: fertility feeds plant growth, and a restored world
   * that rounds it diverges within a few hundred ticks.
   */
  serialize(): string {
    return float32ToBase64(this.fertility);
  }

  restore(data: string | undefined): void {
    if (!data) return;
    base64ToFloat32(data, this.fertility);
  }
}
