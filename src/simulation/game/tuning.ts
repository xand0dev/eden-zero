/**
 * Balance knobs for the game layer, in one place.
 *
 * The values here are the shipped defaults and were chosen by multi-seed
 * headless runs (see docs/IMPLEMENTATION_LOG.md). The balance scripts can
 * override them for an experiment (`--tune '{"fertilityPerFood": 2}'`) so a
 * sweep does not need a copy of the code per variant. Nothing in the running
 * game changes them.
 */
export const TUNING = {
  /** Fertility a tile loses per unit of wild food eaten from it. */
  fertilityPerFood: 6,
  /** Fraction of the gap to full fertility a tile recovers per second. */
  soilRecovery: 1 / 400,
  /** Scales how far the seasons pull the world away from its baseline (0 = no seasons). */
  seasonDepth: 1,
  /**
   * How far the direction to other people is sensed, as a multiple of vision.
   * Social memory still only forms within vision; this only lets a person tell
   * which way the others went (the dispersal fix, E5).
   */
  socialRange: 1,
  /** Scales how fast everyone gets thirsty. */
  thirstScale: 1,
  /** Scales how fast everyone gets hungry. */
  hungerScale: 1,
  /**
   * Plasticity of the innate reflex synapses relative to the rest of the brain.
   * See `Brain.applyPlasticity`: at 1 a life of costly work erased the drink and
   * eat reflexes within ten minutes.
   */
  innatePlasticity: 1,
  /**
   * Motor command above which eating and drinking happen (when food or water is
   * actually within reach and there is a need).
   */
  consumeGate: 0.25,
};

export type Tuning = typeof TUNING;

export function applyTuning(overrides: Partial<Tuning>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (key in TUNING && typeof value === 'number' && Number.isFinite(value)) {
      (TUNING as Record<string, number>)[key] = value;
    }
  }
}
