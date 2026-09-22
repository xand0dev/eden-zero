/**
 * Multi-seed balance harness.
 *
 * A single run tells you almost nothing about an artificial-life world: with
 * eight founders, genetic drift and plain luck dominate, and one seed can thrive
 * while the next collapses. This runs a batch and reports the distribution.
 *
 *   npm run balance
 *   npm run balance -- --seeds eden,orion,vela --ticks 150000
 */
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { DT } from '../src/shared/constants';

interface Args {
  seeds: string[];
  ticks: number;
  predators: number;
  humans: number;
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
  };
}

interface Row {
  seed: string;
  population: number;
  peak: number;
  births: number;
  deaths: number;
  generation: number;
  birthsPerHour: number;
  deathsPerHour: number;
  plants: number;
  outcome: 'thriving' | 'stable' | 'declining' | 'extinct';
}

function classify(final: number, peak: number, birthsPerHour: number, deathsPerHour: number): Row['outcome'] {
  if (final === 0) return 'extinct';
  if (final > 12) return 'thriving';
  if (birthsPerHour >= deathsPerHour && final >= 6) return 'stable';
  if (final >= 4 && final <= peak) return 'declining';
  return 'declining';
}

function runSeed(args: Args, seed: string): Row {
  const world = new World({
    ...DEFAULT_WORLD_OPTIONS,
    seed,
    initialHumans: args.humans,
    initialPredators: args.predators,
  });

  let peak = world.humans.length;
  for (let t = 0; t < args.ticks; t++) {
    world.step();
    if (world.humans.length > peak) peak = world.humans.length;
  }

  const stats = world.computeStats();
  const hours = (args.ticks * DT) / 3600;
  const birthsPerHour = stats.births / hours;
  const deathsPerHour = stats.deaths / hours;
  return {
    seed,
    population: stats.population,
    peak,
    births: stats.births,
    deaths: stats.deaths,
    generation: stats.oldestGeneration,
    birthsPerHour,
    deathsPerHour,
    plants: stats.plants,
    outcome: classify(stats.population, peak, birthsPerHour, deathsPerHour),
  };
}

function main(): void {
  const args = parseArgs();
  const hours = (args.ticks * DT) / 3600;
  console.log(
    `EDEN//0 balance — ${args.seeds.length} seeds, ${args.ticks} ticks (${hours.toFixed(1)} simulated hours), ` +
      `${args.humans} founders, ${args.predators} predators\n`,
  );

  const rows: Row[] = [];
  for (const seed of args.seeds) {
    const row = runSeed(args, seed);
    rows.push(row);
    console.log(
      `  ${seed.padEnd(10)} pop ${String(row.population).padStart(4)} (peak ${String(row.peak).padStart(3)})  ` +
        `gen ${String(row.generation).padStart(2)}  ` +
        `births ${String(row.births).padStart(4)}  deaths ${String(row.deaths).padStart(4)}  ` +
        `${row.birthsPerHour.toFixed(1)}/${row.deathsPerHour.toFixed(1)} per h  ${row.outcome}`,
    );
  }

  const surviving = rows.filter((row) => row.outcome !== 'extinct').length;
  const growing = rows.filter((row) => row.birthsPerHour >= row.deathsPerHour).length;
  const meanPop = rows.reduce((sum, row) => sum + row.population, 0) / rows.length;
  const maxGen = Math.max(...rows.map((row) => row.generation));

  console.log('\nsummary');
  console.log(`  survived              : ${surviving}/${rows.length}`);
  console.log(`  births >= deaths      : ${growing}/${rows.length}`);
  console.log(`  mean final population : ${meanPop.toFixed(1)}`);
  console.log(`  deepest generation    : ${maxGen}`);
  console.log(`  outcomes              : ${JSON.stringify(countBy(rows.map((row) => row.outcome)))}`);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

main();
