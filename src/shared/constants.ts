/**
 * Global tuning constants for EDEN//0.
 *
 * IMPORTANT: everything here is in *simulated* units. The simulation runs on a
 * fixed timestep; wall-clock time only decides how many fixed ticks we execute.
 */

/** Fixed simulation rate: ticks per simulated second of engine time. */
export const SIM_HZ = 20;
/** Fixed timestep in simulated seconds. */
export const DT = 1 / SIM_HZ;

/** Neural solver sub-steps per simulation tick (keeps the LIF integration stable). */
export const BRAIN_SUBSTEPS = 5;
export const BRAIN_DT = DT / BRAIN_SUBSTEPS;

/** World dimensions in tiles. */
export const WORLD_W = 176;
export const WORLD_H = 128;
/** Pixels per tile at zoom 1. */
export const TILE = 14;

/** Default number of founding humans. */
export const GENESIS_HUMANS = 8;

/**
 * Accelerated biological clock.
 * One "biological year" of ageing equals this many simulated seconds.
 * This is deliberately decoupled from the day/night cycle so that we can have a
 * 4-minute day AND a 10-minute lifetime without either feeling absurd.
 */
export const BIO_YEAR_SECONDS = 150;

/** Length of a full day/night cycle in simulated seconds. */
export const DAY_SECONDS = 240;

/** Biological age thresholds, in biological years. */
export const AGE_BABY_END = 1.5;
export const AGE_CHILD_END = 12;
export const AGE_ADULT_END = 45;
/** Hard cap — nobody lives beyond this even with good genes. */
export const AGE_MAX = 110;

/** Gestation length in biological years. */
export const GESTATION_YEARS = 0.55;

/** Time-speed presets offered in the top bar. */
export const SPEED_PRESETS = [1, 5, 20, 100] as const;

/** How many fixed ticks we allow per rendered frame for each preset. */
export const SPEED_TICK_BUDGET: Record<number, number> = {
  1: 20, // 1 simulated second per real second
  5: 100,
  20: 400,
  100: 2000,
};

/** MAX mode: run continuously with a wall-clock budget per macrotask slice. */
export const MAX_SLICE_MS = 12;
export const MAX_TICKS_PER_SLICE = 4000;

/** Snapshot cadence (snapshots per second) for normal vs MAX mode. */
export const SNAPSHOT_HZ_NORMAL = 18;
export const SNAPSHOT_HZ_MAX = 3;

/** Hard safety limits. */
export const MAX_POPULATION = 900;
export const MAX_PLANTS = 6000;
export const MAX_PREDATORS = 400;
/** Cap on built structures. A thriving village keeps building, but not forever. */
export const MAX_STRUCTURES = 160;

/** Event feed retention. */
export const MAX_EVENTS = 400;

/** Spatial hash cell size in world units (1 world unit == 1 tile). */
export const SPATIAL_CELL = 8;
