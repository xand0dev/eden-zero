import type { Rng } from '../simulation/rng';

/**
 * Name generation.
 *
 * Names are labels for the observer. The brief is explicit that they are NOT a
 * language the agents know — nothing in the simulation reads or reacts to a
 * name. Uniqueness is enforced by appending a numeric suffix when a generated
 * name is already taken.
 */

const SYLLABLES_A = [
  'a',
  'e',
  'i',
  'o',
  'u',
  'ae',
  'ei',
  'io',
  'ya',
  'au',
  'or',
  'il',
];
const SYLLABLES_B = [
  'r',
  'n',
  'l',
  'm',
  'v',
  's',
  'th',
  'k',
  'd',
  'z',
  'sh',
  'f',
  'b',
  'g',
];
const SYLLABLES_C = ['', 'a', 'e', 'i', 'o', 'u', 'en', 'ir', 'os', 'al', 'un', 'eth'];

/** Seed names for the eight founders — short, pronounceable, neutral. */
export const FOUNDER_NAMES = ['Ari', 'Mae', 'Nero', 'Lia', 'Ivo', 'Ena', 'Sora', 'Kael'] as const;

export function generateName(rng: Rng): string {
  const a = rng.pick(SYLLABLES_A);
  const b = rng.pick(SYLLABLES_B);
  const c = rng.pick(SYLLABLES_C);
  const raw = `${a}${b}${c}`;
  const capped = raw.charAt(0).toUpperCase() + raw.slice(1);
  return capped.length > 7 ? capped.slice(0, 7) : capped;
}

export class NameRegistry {
  private readonly used = new Set<string>();

  constructor() {
    this.used.clear();
  }

  claim(name: string): string {
    if (!this.used.has(name)) {
      this.used.add(name);
      return name;
    }
    let n = 2;
    while (this.used.has(`${name} ${n}`)) n++;
    const finalName = `${name} ${n}`;
    this.used.add(finalName);
    return finalName;
  }

  next(rng: Rng): string {
    return this.claim(generateName(rng));
  }

  markUsed(name: string): void {
    this.used.add(name);
  }

  snapshot(): string[] {
    return [...this.used];
  }

  restore(names: readonly string[]): void {
    this.used.clear();
    for (const name of names) this.used.add(name);
  }
}
