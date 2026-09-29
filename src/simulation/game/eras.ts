import { DAY_SECONDS, SIM_HZ } from '../../shared/constants';

/**
 * Settlement eras: hearth, camp, village, town, city.
 *
 * An era is a *fact about the world*, read from its state — never a button. The
 * next era arrives when every condition has held for two days running, so a
 * village that briefly touches thirty people does not flicker into an era it
 * cannot keep.
 *
 * Eras matter to the inhabitants in exactly one way: the brain senses the era on
 * the `settlementStage` channel, and each era lets the same `build` motor raise a
 * new kind of structure where the context calls for it (see `structureKindFor`).
 * Nobody is told to build a granary; a hut site staked beside a field in a camp
 * that has fields simply becomes one.
 */

export const Era = {
  Hearth: 0,
  Camp: 1,
  Village: 2,
  Town: 3,
  City: 4,
} as const;
export type Era = (typeof Era)[keyof typeof Era];

export const ERA_NAMES = ['Hearth', 'Camp', 'Village', 'Town', 'City'] as const;
export const ERA_NUMERALS = ['I', 'II', 'III', 'IV', 'V'] as const;

/** What the brain sees on `settlementStage` in each era. */
export const ERA_SENSOR = [0, 0.25, 0.5, 0.75, 1] as const;

/** Conditions must hold this long before an era is reached. */
export const ERA_HOLD_TICKS = 2 * DAY_SECONDS * SIM_HZ;

/** How often era conditions are checked. */
export const ERA_CHECK_INTERVAL = 200;

export interface EraInputs {
  population: number;
  generation: number;
  huts: number;
  fieldsSown: number;
  fields: number;
  flowingCanals: number;
  granaries: number;
  storedFood: number;
  elderFraction: number;
  crisesSurvived: number;
  palisades: number;
  wells: number;
}

export interface EraRequirement {
  label: string;
  current: number;
  target: number;
  met: boolean;
}

/** What reaching `era` (from the one before it) requires. */
export function requirementsFor(era: number, inputs: EraInputs): EraRequirement[] {
  const req = (label: string, current: number, target: number): EraRequirement => ({
    label,
    current,
    target,
    met: current >= target,
  });
  switch (era) {
    case Era.Camp:
      return [
        req('people', inputs.population, 12),
        req('huts', inputs.huts, 3),
        req('fields ever sown', inputs.fieldsSown, 1),
      ];
    case Era.Village:
      return [
        req('people', inputs.population, 30),
        req('generations', inputs.generation, 3),
        req('canals carrying water', inputs.flowingCanals, 1),
        req('food stored', Math.floor(inputs.storedFood), 40),
      ];
    case Era.Town:
      return [
        req('people', inputs.population, 60),
        req('generations', inputs.generation, 5),
        req('fields', inputs.fields, 6),
        req('granaries', inputs.granaries, 2),
        req('elders (%)', Math.round(inputs.elderFraction * 100), 15),
      ];
    case Era.City:
      return [
        req('people', inputs.population, 100),
        req('generations', inputs.generation, 8),
        req('crises survived', inputs.crisesSurvived, 3),
        req('palisade segments', inputs.palisades, 6),
      ];
    default:
      return [];
  }
}

export interface EraState {
  era: number;
  /** Tick from which the next era's conditions have held, or -1. */
  qualifyingSince: number;
  /** Tick each era was reached, indexed by era. */
  reachedAt: number[];
}

export function createEraState(): EraState {
  return { era: Era.Hearth, qualifyingSince: -1, reachedAt: [0] };
}

/**
 * Advance the era state. Returns the new era if one was reached this call.
 *
 * Eras never go backwards: a city that shrinks is a city in decline, which the
 * chronicle records, but the achievement of having built it stands.
 */
export function updateEra(state: EraState, inputs: EraInputs, tick: number): number | null {
  if (state.era >= Era.City) return null;
  const next = state.era + 1;
  const met = requirementsFor(next, inputs).every((r) => r.met);
  if (!met) {
    state.qualifyingSince = -1;
    return null;
  }
  if (state.qualifyingSince < 0) state.qualifyingSince = tick;
  if (tick - state.qualifyingSince < ERA_HOLD_TICKS) return null;
  state.era = next;
  state.qualifyingSince = -1;
  state.reachedAt[next] = tick;
  return next;
}
