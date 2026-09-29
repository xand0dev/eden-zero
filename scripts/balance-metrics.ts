import { STRUCTURE_NAMES } from '../src/simulation/entities/structure';
/**
 * Per-seed balance counters.
 *
 * Two rules shape this file.
 *
 * 1. Read state the simulation actually keeps. A number nobody can point at in
 *    the model is a guess, and a guess in a baseline is worse than no number.
 * 2. Run-scoped counts are accumulated *while the run happens*, never read off
 *    the end state. `world.events` retains only the last `MAX_EVENTS` entries,
 *    so a count taken after the fact is a sample of the tail whose bias depends
 *    on how busy the world happened to be — fine for an event log, useless as a
 *    before/after metric. A cursor over event ids counts every event as long as
 *    it is advanced at least once per `MAX_EVENTS` events, and `eventsMissed`
 *    says so out loud when it was not.
 *
 * There is a second reason not to read the end-state log: `killPredator` emits
 * the same `kind: 'death'` shape as `killHuman`, and predator ids come from the
 * same counter as human ids. Only tracking who is a *human* keeps a predator
 * from quietly inflating a column that sits next to `World.deaths`, which
 * counts humans only.
 */
import type { World } from '../src/simulation/world';
import { FieldStage } from '../src/simulation/entities/cultivation';
import { PlantSpecies } from '../src/simulation/entities/plant';
import { DT } from '../src/shared/constants';

/** Reason recorded for a human death `World.deaths` saw but the log did not explain. */
export const UNATTRIBUTED = 'unattributed';

/**
 * Counts of things the world only tells you once, while it happens.
 *
 * Construct it before the first `step()` and call `observe()` immediately after
 * every one of them. Missing a call risks missing events, which `eventsMissed`
 * reports rather than hides.
 */
export class BalanceTally {
  /** Highest event id already counted. */
  private lastEventId: number;
  /** `World.deaths` at the last observation; the ground truth deaths are reconciled against. */
  private lastDeaths: number;
  /** Ids of every human seen: the founders plus everyone born or spawned since. */
  private humanIds = new Set<number>();
  /** Last seen stage of each field, by field id, to catch ripening — which emits no event. */
  private fieldStages = new Map<number, number>();

  /** Crops brought in over the whole run. One field may yield many times. */
  harvests = 0;
  /** Fields sown over the whole run. */
  sowings = 0;
  /** Growing -> ripe transitions over the whole run. */
  ripenings = 0;
  /** Canal lengths finished over the whole run. */
  canalsDug = 0;
  /**
   * Events that were trimmed from the log before this tally saw them.
   *
   * Zero means every count above is complete. Anything else means the tally was
   * observed too rarely and the counts are lower bounds.
   */
  eventsMissed = 0;
  /**
   * Human deaths by reason, over the whole run.
   *
   * Always sums to the change in `World.deaths`: a death the log could not
   * explain (a missed event) lands in `UNATTRIBUTED` instead of vanishing.
   */
  readonly deathReasons: Record<string, number> = {};

  constructor(world: World) {
    const last = world.events[world.events.length - 1];
    // Genesis events belong to the world, not to the run; start after them.
    this.lastEventId = last ? last.id : 0;
    this.lastDeaths = world.deaths;
    this.trackHumans(world);
    this.trackFields(world);
  }

  /** Count everything emitted since the last call. */
  observe(world: World): void {
    const events = world.events;
    // Events are pushed in id order and trimmed from the front, so the new ones
    // are a suffix. Find where it starts.
    let first = events.length;
    while (first > 0 && events[first - 1].id > this.lastEventId) first--;
    if (first < events.length && events[first].id > this.lastEventId + 1) {
      this.eventsMissed += events[first].id - this.lastEventId - 1;
    }

    // Anyone alive now is known before any death is judged: a newborn or a
    // spawned human cannot be mistaken for a predator.
    this.trackHumans(world);

    let explained = 0;
    for (let i = first; i < events.length; i++) {
      const event = events[i];
      this.lastEventId = event.id;
      if (event.kind === 'build') {
        if (event.text.endsWith('brought in a crop.')) this.harvests += 1;
        else if (event.text.endsWith('sowed a field.')) this.sowings += 1;
        else if (event.text.endsWith('finished a length of canal.')) this.canalsDug += 1;
        continue;
      }
      if (event.kind !== 'death' && event.kind !== 'predation') continue;

      // `killHuman` and `killPredator` emit the same shape, and both put the
      // deceased first. Only humans are ours to count.
      const deceased = event.entityIds[0];
      if (deceased === undefined || !this.humanIds.has(deceased)) continue;
      const reason =
        event.kind === 'predation' ? 'predation' : (/died from (.+?)\.$/.exec(event.text)?.[1] ?? UNATTRIBUTED);
      this.deathReasons[reason] = (this.deathReasons[reason] ?? 0) + 1;
      explained += 1;
    }

    const deaths = world.deaths - this.lastDeaths;
    this.lastDeaths = world.deaths;
    if (deaths > explained) {
      this.deathReasons[UNATTRIBUTED] = (this.deathReasons[UNATTRIBUTED] ?? 0) + deaths - explained;
    }

    this.trackFields(world);
  }

  private trackHumans(world: World): void {
    for (const human of world.humans) this.humanIds.add(human.id);
  }

  private trackFields(world: World): void {
    for (const field of world.fields) {
      const previous = this.fieldStages.get(field.id);
      if (previous === FieldStage.Growing && field.stage === FieldStage.Ripe) this.ripenings += 1;
      this.fieldStages.set(field.id, field.stage);
    }
  }
}

/**
 * Gauges read at the end of a run: what the settlement has built and what is
 * standing on the map right now.
 */
export interface CultivationMetrics {
  /**
   * Fields ever broken.
   *
   * The world has no way to remove a field, so this is a lifetime count rather
   * than a gauge of how much ground is currently under cultivation.
   */
  fields: number;
  /** Fields sown and growing right now. */
  sown: number;
  /** Fields ripe right now. */
  ripe: number;
  /** Fields whose moisture is at or above the growth floor right now. */
  moist: number;
  /** Canal lengths ever staked out, dug or not. */
  canals: number;
  /** Canal lengths fully dug. A half-dug length carries no water. */
  canalsComplete: number;
  /** Canal lengths carrying water right now. */
  canalsFlowing: number;
  /**
   * Food piles standing on the map.
   *
   * Harvests and carrion both leave one behind, so this is *not* a harvest
   * count — `BalanceTally.harvests` is.
   */
  foodPiles: number;
  /** Food in piles (harvests, carrion, god-placed), in food units. */
  foodOnGround: number;
  /** Food carried by living wild plants (grass, bushes, trees), in food units. */
  wildFood: number;
}

export function collectCultivation(world: World, moistureFloor = 0.22): CultivationMetrics {
  let sown = 0;
  let ripe = 0;
  let moist = 0;
  for (const field of world.fields) {
    if (field.stage === FieldStage.Growing) sown++;
    else if (field.stage === FieldStage.Ripe) ripe++;
    if (field.moisture >= moistureFloor) moist++;
  }

  let canalsComplete = 0;
  let canalsFlowing = 0;
  for (const canal of world.canals) {
    if (canal.complete) canalsComplete++;
    if (canal.flowing) canalsFlowing++;
  }

  let foodPiles = 0;
  let foodOnGround = 0;
  let wildFood = 0;
  for (const plant of world.plants) {
    if (!plant.alive) continue;
    if (plant.species === PlantSpecies.FoodPile) {
      foodPiles++;
      foodOnGround += plant.food;
    } else {
      wildFood += plant.food;
    }
  }

  return {
    fields: world.fields.length,
    sown,
    ripe,
    moist,
    canals: world.canals.length,
    canalsComplete,
    canalsFlowing,
    foodPiles,
    foodOnGround,
    wildFood,
  };
}

export type BalanceOutcome = 'runaway' | 'thriving' | 'stable' | 'declining' | 'extinct';

export function classifyOutcome(
  final: number,
  _peak: number,
  birthsPerHour: number,
  deathsPerHour: number,
): BalanceOutcome {
  if (final === 0) return 'extinct';
  if (final > 12) return 'thriving';
  if (birthsPerHour >= deathsPerHour && final >= 6) return 'stable';
  return 'declining';
}

export interface RunConfig {
  ticks: number;
  humans: number;
  predators: number;
}

/** A population reading taken during the run. */
export interface PopulationSample {
  tick: number;
  population: number;
  generation: number;
  fields: number;
  canalsFlowing: number;
}

/** What only the run loop knows: how high the population got, how long it took, what happened. */
export interface SeedRun {
  peak: number;
  /** Lowest population seen after the peak — how deep the post-peak decline went. */
  troughAfterPeak?: number;
  /** Tick at which the population hit zero, or null if it never did. */
  extinctAtTick?: number | null;
  /** Tick at which the run was cut short for exceeding the population limit, or null. */
  stoppedAtTick?: number | null;
  elapsedSeconds: number;
  tally: BalanceTally;
  samples?: PopulationSample[];
}

/** One seed's result. The shape the JSON output publishes. */
export interface BalanceRow {
  seed: string;
  /** Ticks this row covers, so a rate is never read without its denominator. */
  ticks: number;
  population: number;
  peak: number;
  troughAfterPeak: number;
  extinctAtTick: number | null;
  stoppedAtTick: number | null;
  births: number;
  deaths: number;
  generation: number;
  birthsPerHour: number;
  deathsPerHour: number;
  plants: number;
  huts: number;
  sites: number;
  timber: number;
  outcome: BalanceOutcome;
  fields: number;
  sownFields: number;
  ripeFields: number;
  moistFields: number;
  /** Lifetime crops brought in. A field can yield repeatedly, so this is not a field count. */
  harvests: number;
  /** Lifetime sowings. */
  sowings: number;
  /** Lifetime growing -> ripe transitions. */
  ripenings: number;
  /** Canal lengths staked out, dug or not. */
  canals: number;
  /** Lifetime canal lengths finished. */
  canalsDug: number;
  canalsComplete: number;
  canalsFlowing: number;
  foodPiles: number;
  foodOnGround: number;
  wildFood: number;
  /**
   * Food eaten over the run, by source, in food units: wild plants, harvest
   * piles, other piles (carrion, observer). Zero where the world does not keep
   * the counter.
   */
  foodEaten: { wild: number; crop: number; pile: number };
  /** Human deaths by reason, over the run. Sums to `deaths` when the run started from genesis. */
  deathReasons: Record<string, number>;
  /** Events trimmed before the tally saw them; nonzero means event-derived counts are lower bounds. */
  eventsMissed: number;
  matingOpportunities: number;
  matingPairings: number;
  matings: number;
  /** Mean number of mating-willing adults per tick. */
  willingPerTick: number;
  wallTimeSeconds: number;
  ticksPerSecond: number;
  samples: PopulationSample[];
  /** The game layer: era reached, crises faced, stores and land. Absent in old runs. */
  game?: {
    era: number;
    crises: Array<{ kind: string; survived: boolean; before: number; after: number }>;
    storedFood: number;
    granaries: number;
    wells: number;
    landHealth: number;
    atlas: number;
    structures: Record<string, number>;
  };
}

export function buildRow(seed: string, world: World, config: RunConfig, run: SeedRun): BalanceRow {
  const stats = world.computeStats();
  const cultivation = collectCultivation(world);
  const hours = (config.ticks * DT) / 3600;
  const birthsPerHour = stats.births / hours;
  const deathsPerHour = stats.deaths / hours;
  // A very short run can finish inside the clock's resolution; keep ticks/s finite
  // so the JSON stays well-formed instead of serialising Infinity as null.
  const elapsedSeconds = Math.max(run.elapsedSeconds, 1e-9);
  const mating = world.matingDiagnostics;

  return {
    seed,
    ticks: config.ticks,
    population: stats.population,
    peak: run.peak,
    troughAfterPeak: run.troughAfterPeak ?? stats.population,
    extinctAtTick: run.extinctAtTick ?? null,
    stoppedAtTick: run.stoppedAtTick ?? null,
    births: stats.births,
    deaths: stats.deaths,
    generation: stats.oldestGeneration,
    birthsPerHour,
    deathsPerHour,
    plants: stats.plants,
    huts: stats.huts,
    sites: stats.sites,
    timber: stats.timber,
    outcome: run.stoppedAtTick != null ? 'runaway' : classifyOutcome(stats.population, run.peak, birthsPerHour, deathsPerHour),
    fields: cultivation.fields,
    sownFields: cultivation.sown,
    ripeFields: cultivation.ripe,
    moistFields: cultivation.moist,
    harvests: run.tally.harvests,
    sowings: run.tally.sowings,
    ripenings: run.tally.ripenings,
    canals: cultivation.canals,
    canalsDug: run.tally.canalsDug,
    canalsComplete: cultivation.canalsComplete,
    canalsFlowing: cultivation.canalsFlowing,
    foodPiles: cultivation.foodPiles,
    foodOnGround: cultivation.foodOnGround,
    wildFood: cultivation.wildFood,
    foodEaten: { wild: 0, crop: 0, pile: 0, ...(world as { foodEaten?: BalanceRow['foodEaten'] }).foodEaten },
    deathReasons: { ...run.tally.deathReasons },
    eventsMissed: run.tally.eventsMissed,
    matingOpportunities: mating.opportunities,
    matingPairings: mating.pairings,
    matings: world.totalMatings,
    willingPerTick: mating.ticks > 0 ? mating.willingTicks / mating.ticks : 0,
    wallTimeSeconds: elapsedSeconds,
    ticksPerSecond: config.ticks / elapsedSeconds,
    samples: run.samples ?? [],
    game: gameOf(world),
  };
}

function gameOf(world: World): BalanceRow['game'] {
  const structures: Record<string, number> = {};
  for (const site of world.structures) {
    if (!site.complete) continue;
    const name = STRUCTURE_NAMES[site.kind] ?? String(site.kind);
    structures[name] = (structures[name] ?? 0) + 1;
  }
  const centre = world.settlementCentre;
  return {
    era: world.eraState.era,
    crises: world.fate.history.map((r) => ({
      kind: r.kind,
      survived: r.survived,
      before: r.populationBefore,
      after: r.populationAfter,
    })),
    storedFood: world.storedFood,
    granaries: structures.granary ?? 0,
    wells: structures.well ?? 0,
    landHealth: centre ? world.landHealth() : 1,
    atlas: world.discovered.size,
    structures,
  };
}

export interface BalanceSummary {
  seeds: number;
  /** Ticks covered by every row added up — the denominator of `ticksPerSecond`. */
  ticks: number;
  survived: number;
  birthsAtLeastDeaths: number;
  meanFinalPopulation: number;
  deepestGeneration: number;
  /** Seeds whose deepest generation reached at least 2. */
  seedsReachingGen2: number;
  outcomes: Record<string, number>;
  hutsBuilt: number;
  seedsWithHuts: number;
  fieldsFounded: number;
  sownFields: number;
  ripeFields: number;
  sowings: number;
  ripenings: number;
  harvests: number;
  canals: number;
  canalsDug: number;
  canalsComplete: number;
  canalsFlowing: number;
  foodOnGround: number;
  deathReasons: Record<string, number>;
  eventsMissed: number;
  wallTimeSeconds: number;
  /**
   * Total ticks over total wall seconds.
   *
   * Not the mean of the per-seed rates: a seed that took 2s would otherwise
   * count as much as one that took 20s, which is exactly the weighting error a
   * benchmark should not have.
   */
  ticksPerSecond: number;
}

export function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function summarize(rows: BalanceRow[]): BalanceSummary {
  const sum = (pick: (row: BalanceRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  const deathReasons: Record<string, number> = {};
  for (const row of rows) {
    for (const [reason, count] of Object.entries(row.deathReasons)) {
      deathReasons[reason] = (deathReasons[reason] ?? 0) + count;
    }
  }
  const ticks = sum((row) => row.ticks);
  const wallTimeSeconds = sum((row) => row.wallTimeSeconds);
  return {
    seeds: rows.length,
    ticks,
    survived: rows.filter((row) => row.outcome !== 'extinct').length,
    birthsAtLeastDeaths: rows.filter((row) => row.birthsPerHour >= row.deathsPerHour).length,
    meanFinalPopulation: rows.length > 0 ? sum((row) => row.population) / rows.length : 0,
    deepestGeneration: rows.reduce((deepest, row) => Math.max(deepest, row.generation), 0),
    seedsReachingGen2: rows.filter((row) => row.generation >= 2).length,
    outcomes: countBy(rows.map((row) => row.outcome)),
    hutsBuilt: sum((row) => row.huts),
    seedsWithHuts: rows.filter((row) => row.huts > 0).length,
    fieldsFounded: sum((row) => row.fields),
    sownFields: sum((row) => row.sownFields),
    ripeFields: sum((row) => row.ripeFields),
    sowings: sum((row) => row.sowings),
    ripenings: sum((row) => row.ripenings),
    harvests: sum((row) => row.harvests),
    canals: sum((row) => row.canals),
    canalsDug: sum((row) => row.canalsDug),
    canalsComplete: sum((row) => row.canalsComplete),
    canalsFlowing: sum((row) => row.canalsFlowing),
    foodOnGround: sum((row) => row.foodOnGround),
    deathReasons,
    eventsMissed: sum((row) => row.eventsMissed),
    wallTimeSeconds,
    ticksPerSecond: wallTimeSeconds > 0 ? ticks / wallTimeSeconds : 0,
  };
}
