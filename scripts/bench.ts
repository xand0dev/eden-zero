/**
 * Simulation benchmark.
 *
 * Measures where a tick actually goes, and how the cost scales with population.
 * Written because the answer was not obvious and my first guess was wrong: I
 * assumed the neural solver would dominate, and it does not.
 *
 *   npm run bench
 *   npm run bench -- --ticks 40000
 *
 * For a real V8 CPU profile rather than these wall-clock numbers:
 *   node --cpu-prof --cpu-prof-dir=/tmp/prof node_modules/.bin/tsx scripts/bench.ts
 * and then inspect /tmp/prof/*.cpuprofile. docs/PROFILING.md records what that
 * profile showed.
 */
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const TICKS = Number(arg('ticks', '20000'));
const SEED = arg('seed', 'bench');

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

function main(): void {
  const world = new World({
    ...DEFAULT_WORLD_OPTIONS,
    seed: SEED,
    initialHumans: 8,
    initialPredators: 2,
  });

  console.log(`EDEN//0 benchmark — ${TICKS} ticks, seed "${SEED}"\n`);

  // Warm up so the JIT has compiled the hot paths before we measure anything.
  for (let i = 0; i < 2000; i++) world.step();

  const samples: number[] = [];
  const populationAt: number[] = [];
  const costAt: number[] = [];
  let windowStart = process.hrtime.bigint();
  let windowTicks = 0;
  let windowCost = 0;

  for (let i = 0; i < TICKS; i++) {
    const t0 = process.hrtime.bigint();
    world.step();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    samples.push(ms);
    windowCost += ms;
    windowTicks += 1;

    if (windowTicks === 500) {
      const wall = Number(process.hrtime.bigint() - windowStart) / 1e6;
      populationAt.push(world.humans.length);
      costAt.push(windowCost / windowTicks);
      void wall;
      windowStart = process.hrtime.bigint();
      windowTicks = 0;
      windowCost = 0;
    }
  }

  const sorted = samples.slice().sort((a, b) => a - b);
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  const total = samples.reduce((sum, v) => sum + v, 0);

  console.log('per-tick cost (milliseconds)');
  console.log(`  mean    ${mean.toFixed(4)}`);
  console.log(`  median  ${percentile(sorted, 0.5).toFixed(4)}`);
  console.log(`  p95     ${percentile(sorted, 0.95).toFixed(4)}`);
  console.log(`  p99     ${percentile(sorted, 0.99).toFixed(4)}`);
  console.log(`  max     ${sorted[sorted.length - 1].toFixed(4)}`);

  console.log('\nthroughput');
  console.log(`  ticks/second (single core) ${(1000 / mean).toFixed(0)}`);
  console.log(`  realtime headroom at x1    ${(1000 / mean / 20).toFixed(0)}x`);
  console.log(`  realtime headroom at x100  ${(1000 / mean / 2000).toFixed(1)}x`);

  console.log('\nscaling with population (500-tick windows)');
  console.log('  population   ms/tick');
  for (let i = 0; i < populationAt.length; i++) {
    const bar = '#'.repeat(Math.min(50, Math.round(costAt[i] * 400)));
    console.log(`  ${String(populationAt[i]).padStart(6)}       ${costAt[i].toFixed(4)} ${bar}`);
  }

  console.log('\nentity counts');
  console.log(`  humans    ${world.humans.length}`);
  console.log(`  predators ${world.predators.length}`);
  console.log(`  plants    ${world.plants.length}`);
  console.log(`  huts      ${world.computeStats().huts}`);

  const plantsPerTick = world.plants.length * (world.humans.length + world.predators.length);
  console.log('\nderived');
  console.log(`  total simulated time  ${(TICKS * 0.05 / 60).toFixed(1)} minutes`);
  console.log(`  total wall time       ${(total / 1000).toFixed(2)} s`);
  console.log(`  plant-scans per tick  ~${plantsPerTick} (worst case, before radius culling)`);
}

main();
