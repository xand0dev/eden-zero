/**
 * Deterministic pseudo-random number generator.
 *
 * The whole simulation draws from instances of this class. `Math.random()` is
 * never used inside simulation code — determinism is a hard requirement of the
 * project (same seed + same interventions => identical history).
 *
 * Algorithm: sfc32 seeded through splitmix32. Fast, tiny state, good enough
 * statistical quality for an artificial-life toy, and trivially serialisable.
 */

const U32 = 4294967296;

function splitmix32(a: number): () => number {
  return function next(): number {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / U32;
  };
}

export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number | string) {
    this.seed(seed);
  }

  seed(seed: number | string): void {
    const numeric = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    const mixer = splitmix32(numeric || 0x1a2b3c4d);
    this.a = (mixer() * U32) >>> 0;
    this.b = (mixer() * U32) >>> 0;
    this.c = (mixer() * U32) >>> 0;
    this.d = (mixer() * U32) >>> 0;
    // Warm up so that nearby seeds diverge immediately.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Raw 32-bit unsigned integer. */
  nextUint32(): number {
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const r = (t + this.d) | 0;
    this.c = (this.c + r) | 0;
    return r >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / U32;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Standard normal via Box-Muller (deterministic given the stream). */
  normal(mean = 0, stdDev = 1): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform element of an array. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length];
  }

  /** In-place Fisher-Yates shuffle. Deterministic. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  /** Fork a child stream. Used to give each entity its own private stream. */
  fork(): Rng {
    return new Rng(this.nextUint32());
  }

  /** Serializable internal state — required for deterministic save/load. */
  getState(): [number, number, number, number] {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  setState(state: readonly number[]): void {
    this.a = state[0] >>> 0;
    this.b = state[1] >>> 0;
    this.c = state[2] >>> 0;
    this.d = state[3] >>> 0;
  }
}

/** Stable 32-bit string hash (FNV-1a). */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
