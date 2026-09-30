import { Rng } from '../rng';
import type { WorldRules } from './laws';

/**
 * Ages: the world's time never runs out of chapters.
 *
 * Eras (eras.ts) are what the settlement achieves and they stop at the city.
 * Ages are what the world goes through, and they never stop: every year
 * (`AGE_LENGTH_YEARS`) a new age begins, generated from the world's seed and its
 * number, so the same world meets the same ages and a different world meets
 * different ones. Each age leans on the physics one way — longer winters, a
 * season of plenty, faster mutation, restless predators — within bounds a
 * settlement can live through, and carries an omen: something the world may or
 * may not do before the age ends. Nothing in an age tells anyone what to do; it
 * changes the world they have to live in.
 *
 * This is the fifth Rule of Creation (genesis/rules.ts).
 */

/** Years per age. A year is eight days (calendar.ts). */
export const AGE_LENGTH_YEARS = 1;

export interface AgeTrait {
  id: string;
  /** Completes "The Age of …". */
  title: string;
  /** What changes, in one line. */
  text: string;
  /** Lean the rules this way, by `k` (0.6..1.4 of the trait's full strength). */
  apply(rules: WorldRules, k: number): void;
}

export const AGE_TRAITS: readonly AgeTrait[] = [
  { id: 'plenty', title: 'Plenty', text: 'Plants regrow faster.', apply: (r, k) => (r.plantRegen *= 1 + 0.25 * k) },
  { id: 'long-winters', title: 'Long Winters', text: 'The seasons swing harder.', apply: (r, k) => (r.seasonAmplitude *= 1 + 0.3 * k) },
  // Thirst is already the first cause of death; this age leans on the land more than on the body.
  { id: 'thirst', title: 'Thirst', text: 'The land dries and people thirst a little sooner.', apply: (r, k) => ((r.thirstRate *= 1 + 0.03 * k), (r.dryness *= 1 + 0.3 * k)) },
  { id: 'change', title: 'Change', text: 'Children differ more from their parents: mutation doubles.', apply: (r, k) => (r.mutationRate *= 1 + 1.2 * k) },
  { id: 'minds', title: 'Minds', text: 'Brains learn faster.', apply: (r, k) => (r.plasticity *= 1 + 0.2 * k) },
  { id: 'hunters', title: 'Hunters', text: 'Predators come in greater numbers.', apply: (r, k) => (r.predatorMigration *= 1 + 0.7 * k) },
  { id: 'calm', title: 'Calm', text: 'Fate is quiet: fewer crises.', apply: (r, k) => (r.crisisFrequency *= 1 - 0.4 * k) },
  { id: 'omens', title: 'Omens', text: 'Crises come more often, and so does favour.', apply: (r, k) => ((r.crisisFrequency *= 1 + 0.35 * k), (r.favourRate *= 1 + 0.4 * k)) },
  { id: 'warmth', title: 'Warmth', text: 'The island is warmer.', apply: (r, k) => (r.temperatureOffset += 3 * k) },
  { id: 'frost', title: 'Frost', text: 'The island is colder.', apply: (r, k) => (r.temperatureOffset -= 3 * k) },
  { id: 'cradles', title: 'Cradles', text: 'Twins are born more often.', apply: (r, k) => (r.twinChance += 0.05 * k) },
  { id: 'elders', title: 'Elders', text: 'Lives run longer.', apply: (r, k) => (r.lifespan *= 1 + 0.1 * k) },
  { id: 'forests', title: 'Forests', text: 'Timber regrows fast.', apply: (r, k) => (r.timberRegen *= 1 + 0.6 * k) },
  { id: 'long-nights', title: 'Long Nights', text: 'Nights are longer.', apply: (r, k) => (r.nightBias += 0.12 * k) },
  { id: 'healing', title: 'Healing', text: 'Wounds close faster.', apply: (r, k) => (r.healthRegen *= 1 + 0.3 * k) },
  { id: 'rich-earth', title: 'Rich Earth', text: 'Worn soil recovers faster.', apply: (r, k) => (r.soilRecovery *= 1 + 0.5 * k) },
];

export type OmenKind = 'births' | 'skills' | 'people' | 'survive' | 'fields' | 'discoveries';

export interface Omen {
  kind: OmenKind;
  /** How many during the age (or, for `survive`, people alive at its end). */
  target: number;
  label: string;
}

export interface Age {
  /** 1 is the first age. */
  index: number;
  /** A generated proper name: "Vessa". */
  name: string;
  trait: AgeTrait;
  /** Strength of the trait, 0.6..1.4. */
  intensity: number;
  omen: Omen;
}

const SYLLABLES_A = ['ve', 'ka', 'lo', 'mi', 'tor', 'sa', 'ru', 'ne', 'dha', 'io', 'gre', 'ul', 'ar', 'bel', 'cy', 'fen'];
const SYLLABLES_B = ['ssa', 'rin', 'dor', 'th', 'mar', 'le', 'vek', 'na', 'ros', 'quil', 'sh', 'den', 'ya', 'mor'];

/** A pronounceable name from a stream: two or three syllables. */
export function makeName(rng: Rng): string {
  let name = SYLLABLES_A[Math.floor(rng.next() * SYLLABLES_A.length)];
  if (rng.next() < 0.4) name += SYLLABLES_A[Math.floor(rng.next() * SYLLABLES_A.length)];
  name += SYLLABLES_B[Math.floor(rng.next() * SYLLABLES_B.length)];
  return name[0].toUpperCase() + name.slice(1);
}

/**
 * Age `index` of a world. Pure: the same seed and index always give the same
 * age, from a stream of its own, so ages never disturb the world's randomness.
 */
export function ageOf(seed: string, index: number, population = 8): Age {
  const rng = new Rng(`${seed}:age:${index}`);
  // The first age is the plain world the charter made.
  const trait = index <= 1 ? NEUTRAL_TRAIT : AGE_TRAITS[Math.floor(rng.next() * AGE_TRAITS.length)];
  const intensity = index <= 1 ? 0 : 0.6 + rng.next() * 0.8;
  const name = makeName(rng);
  const kinds: OmenKind[] = ['births', 'skills', 'people', 'survive', 'fields', 'discoveries'];
  const kind = kinds[Math.floor(rng.next() * kinds.length)];
  const p = Math.max(6, population);
  const target =
    kind === 'births'
      ? Math.round(p * 0.6)
      : kind === 'skills'
        ? 40 + Math.round(p * 4)
        : kind === 'people'
          ? 1
          : kind === 'survive'
            ? Math.max(6, Math.round(p * 1.1))
            : kind === 'fields'
              ? 3 + Math.round(p / 10)
              : 3;
  const label =
    kind === 'births'
      ? `${target} children born this age`
      : kind === 'skills'
        ? `${target} new skills grown this age`
        : kind === 'people'
          ? 'a new people arises this age'
          : kind === 'survive'
            ? `${target} people alive when the age ends`
            : kind === 'fields'
              ? `${target} fields sown this age`
              : `${target} new atlas behaviours this age`;
  return { index, name, trait, intensity, omen: { kind, target, label } };
}

const NEUTRAL_TRAIT: AgeTrait = { id: 'dawn', title: 'Dawn', text: 'The world as its laws made it.', apply: () => undefined };

/** "The Age of Long Winters". */
export function ageTitle(age: Age): string {
  return `The Age of ${age.trait.title}`;
}

export interface AgeState {
  index: number;
  startTick: number;
  /** Counters at the start of the age, for the omen. */
  births0: number;
  skills0: number;
  peoples0: number;
  fields0: number;
  discoveries0: number;
  /** Omens fulfilled over the world's life. */
  omensMet: number;
  /** Whether this age's omen has been fulfilled. */
  omenMet: boolean;
  /** People alive when the age began: the omen's targets were set from it. */
  population0: number;
}

export function createAgeState(): AgeState {
  return { index: 1, startTick: 0, births0: 0, skills0: 0, peoples0: 1, fields0: 0, discoveries0: 0, omensMet: 0, omenMet: false, population0: 8 };
}
