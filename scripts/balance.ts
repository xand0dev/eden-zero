/**
 * Multi-seed balance harness.
 *
 * A single run tells you almost nothing about an artificial-life world: with
 * eight founders, genetic drift and plain luck dominate, and one seed can thrive
 * while the next collapses. This runs a batch and reports the distribution.
 *
 *   npm run balance
 *   npm run balance -- --seeds eden,orion,vela --ticks 150000
 *   npm run balance -- --json                  # machine-readable, for before/after diffs
 *
 * Counting lives in scripts/balance-metrics.ts so it can be tested without
 * running a batch. Harvests and death reasons are tallied during the run by a
 * `BalanceTally`, not read off the log at the end: the log only keeps the last
 * 400 events, so an end-state count would be a tail sample whose bias depends
 * on how busy that particular world was.
 */
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { DT } from '../src/shared/constants';
import {
  BalanceTally,
  buildRow,
  summarize,
  type BalanceRow,
  type BalanceSummary,
  type PopulationSample,
  type RunConfig,
} from './balance-metrics';

interface Args extends RunConfig {
  seeds: string[];
  json: boolean;
  /** Ticks between population samples in the JSON output. */
  sampleEvery: number;
  /**
   * End a seed early once its population passes this (0 = never).
   *
   * A world that grows without bound is its own failure — tick cost is linear
   * in population, and at several hundred humans a session is unwatchable — and
   * it would otherwise dominate a batch's wall time.
   */
  stopAbove: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    seeds: get('seeds', 'eden,orion,vela,lumen,tessera,auriga,kepler,solace').split(','),
    ticks: Number(get('ticks', '150000')),
    predators: Number(get('predators', '2')),
    humans: Number(get('humans', '8')),
    json: argv.includes('--json'),
    sampleEvery: Number(get('sample-every', '6000')),
    stopAbove: Number(get('stop-above', '0')),
  };
}

function runSeed(args: Args, seed: string): BalanceRow {
  const world = new World({
    ...DEFAULT_WORLD_OPTIONS,
    seed,
    initialHumans: args.humans,
    initialPredators: args.predators,
  });

  // Counting has to run alongside the world, not after it: the event log rolls
  // over, and a count taken at the end is whatever survived the roll.
  const tally = new BalanceTally(world);

  const samples: PopulationSample[] = [];
  const sample = (): void => {
    let flowing = 0;
    for (const canal of world.canals) if (canal.flowing) flowing++;
    samples.push({
      tick: world.tick,
      population: world.humans.length,
      generation: world.maxGeneration,
      fields: world.fields.length,
      canalsFlowing: flowing,
    });
  };
  sample();

  const start = performance.now();
  let peak = world.humans.length;
  let troughAfterPeak = peak;
  let extinctAtTick: number | null = null;
  let stoppedAtTick: number | null = null;
  for (let t = 0; t < args.ticks; t++) {
    world.step();
    tally.observe(world);
    const population = world.humans.length;
    if (population > peak) {
      peak = population;
      troughAfterPeak = population;
    } else if (population < troughAfterPeak) {
      troughAfterPeak = population;
    }
    if (population === 0 && extinctAtTick === null) extinctAtTick = world.tick;
    if (args.sampleEvery > 0 && world.tick % args.sampleEvery === 0) sample();
    if (args.stopAbove > 0 && population > args.stopAbove) {
      stoppedAtTick = world.tick;
      break;
    }
  }
  const elapsedSeconds = (performance.now() - start) / 1000;

  // Rates are per tick actually run, so an early stop does not dilute them.
  const config = { ...args, ticks: world.tick };
  return buildRow(seed, world, config, { peak, troughAfterPeak, extinctAtTick, stoppedAtTick, elapsedSeconds, tally, samples });
}

function formatRow(row: BalanceRow): string {
  return (
    `  ${row.seed.padEnd(10)} pop ${String(row.population).padStart(4)} (peak ${String(row.peak).padStart(3)})  ` +
    `gen ${String(row.generation).padStart(2)}  ` +
    `births ${String(row.births).padStart(4)}  deaths ${String(row.deaths).padStart(4)}  ` +
    `huts ${String(row.huts).padStart(2)}+${String(row.sites).padStart(2)}  ` +
    `${row.birthsPerHour.toFixed(1)}/${row.deathsPerHour.toFixed(1)} per h  ` +
    `fields ${row.fields} (sown ${row.sowings} ripened ${row.ripenings} harvested ${row.harvests})  ` +
    `canals ${row.canals}/${row.canalsComplete}/${row.canalsFlowing} staked/dug/flowing  ` +
    `food ${row.foodOnGround.toFixed(1)} eaten wild/crop/pile ${row.foodEaten.wild.toFixed(0)}/${row.foodEaten.crop.toFixed(0)}/${row.foodEaten.pile.toFixed(0)}  ` +
    `${row.wallTimeSeconds.toFixed(1)}s ${row.ticksPerSecond.toFixed(0)}t/s  ${row.outcome}`
  );
}

function printSummary(summary: BalanceSummary): void {
  const seeds = summary.seeds;
  console.log('\nsummary');
  console.log(`  seeds                 : ${seeds} (${summary.ticks} ticks total)`);
  console.log(`  survived              : ${summary.survived}/${seeds}`);
  console.log(`  births >= deaths      : ${summary.birthsAtLeastDeaths}/${seeds}`);
  console.log(`  mean final population : ${summary.meanFinalPopulation.toFixed(1)}`);
  console.log(`  deepest generation    : ${summary.deepestGeneration} (${summary.seedsReachingGen2}/${seeds} seeds reached gen 2)`);
  console.log(`  outcomes              : ${JSON.stringify(summary.outcomes)}`);
  console.log(`  huts built            : ${summary.hutsBuilt} across ${summary.seedsWithHuts}/${seeds} seeds`);
  console.log(
    `  fields founded        : ${summary.fieldsFounded} (sown now ${summary.sownFields}, ripe now ${summary.ripeFields})`,
  );
  console.log(
    `  crop cycle (lifetime) : ${summary.sowings} sown, ${summary.ripenings} ripened, ${summary.harvests} harvested`,
  );
  console.log(
    `  canals                : ${summary.canals} staked, ${summary.canalsComplete} dug, ${summary.canalsFlowing} flowing now`,
  );
  if (summary.eventsMissed > 0) {
    console.log(`  WARNING               : ${summary.eventsMissed} events missed; event-derived counts are lower bounds`);
  }
  console.log(`  food on ground        : ${summary.foodOnGround.toFixed(1)}`);
  console.log(`  wall time             : ${summary.wallTimeSeconds.toFixed(1)}s (${summary.ticksPerSecond.toFixed(0)} ticks/s)`);

  const reasons = Object.entries(summary.deathReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) return;
  console.log('  human death reasons   :');
  for (const [reason, count] of reasons.slice(0, 6)) {
    console.log(`    ${reason.padEnd(18)} ${count}`);
  }
}

/**
 * One JSON document on stdout and nothing else, so it can be piped straight
 * into a diff or a chart without stripping the human summary first.
 */
function printJson(rows: BalanceRow[], args: Args): void {
  const payload = {
    tool: 'eden-zero-balance',
    version: 3,
    args: {
      seeds: args.seeds,
      ticks: args.ticks,
      predators: args.predators,
      humans: args.humans,
      sampleEvery: args.sampleEvery,
      stopAbove: args.stopAbove,
    },
    notes: [
      'fields is a lifetime count: the world never removes a field. sownFields, ripeFields and moistFields are current states.',
      'sowings, ripenings, harvests and canalsDug are lifetime counts tallied every tick; a field can cycle repeatedly.',
      'canals is staked lengths; canalsComplete and canalsFlowing are current states.',
      'deathReasons counts human deaths by reason and sums to the row deaths column. Predator deaths are excluded.',
      'eventsMissed > 0 means event-derived counts are lower bounds.',
      'wallTimeSeconds and ticksPerSecond are machine-dependent; every other number is not.',
    ],
    rows,
    summary: summarize(rows),
  };
  console.log(JSON.stringify(payload, null, 2));
}

function main(): void {
  const args = parseArgs();
  if (!args.json) {
    const hours = (args.ticks * DT) / 3600;
    console.log(
      `EDEN//0 balance — ${args.seeds.length} seeds, ${args.ticks} ticks (${hours.toFixed(1)} simulated hours), ` +
        `${args.humans} founders, ${args.predators} predators\n`,
    );
  }

  const rows: BalanceRow[] = [];
  for (const seed of args.seeds) {
    const row = runSeed(args, seed);
    rows.push(row);
    if (!args.json) console.log(formatRow(row));
  }

  if (args.json) printJson(rows, args);
  else printSummary(summarize(rows));
}

main();
