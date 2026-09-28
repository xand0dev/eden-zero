/**
 * Run the balance harness with one process per seed and merge the results.
 *
 * Long multi-seed runs are the only honest evidence of population viability,
 * and they are embarrassingly parallel: every seed is an independent world.
 *
 *   npm run balance:parallel -- --seeds eden,orion,vela --ticks 200000 --predators 0 --out run.json
 *
 * Every simulation number is identical to a sequential `npm run balance` run.
 * Wall time and ticks/s are not: seeds share CPUs, so per-seed rates are lower
 * than a quiet machine would give. Use `npm run balance` for tick-rate evidence.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { summarize, type BalanceRow } from './balance-metrics';

const argv = process.argv.slice(2);
const get = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const seeds = get('seeds', 'eden,orion,vela,lumen,tessera,auriga,kepler,solace').split(',');
const ticks = get('ticks', '150000');
const predators = get('predators', '2');
const humans = get('humans', '8');
const sampleEvery = get('sample-every', '6000');
const stopAbove = get('stop-above', '0');
const jobs = Number(get('jobs', String(Math.max(1, cpus().length - 2))));
const out = get('out', '');

function runOne(seed: string): Promise<BalanceRow> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/balance.ts',
        '--json',
        '--seeds',
        seed,
        '--ticks',
        ticks,
        '--predators',
        predators,
        '--humans',
        humans,
        '--sample-every',
        sampleEvery,
        '--stop-above',
        stopAbove,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`seed ${seed} exited with ${code}`));
      try {
        resolve((JSON.parse(stdout) as { rows: BalanceRow[] }).rows[0]);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main(): Promise<void> {
  const rows: BalanceRow[] = new Array(seeds.length);
  let next = 0;
  const start = performance.now();
  const worker = async (): Promise<void> => {
    while (next < seeds.length) {
      const index = next++;
      rows[index] = await runOne(seeds[index]);
      const row = rows[index];
      // Save what has finished so far, so a stopped batch keeps its completed seeds.
      if (out) writeFileSync(`${out}.partial`, JSON.stringify(rows.filter(Boolean), null, 2));
      process.stderr.write(
        `  ${row.seed.padEnd(10)} pop ${row.population} peak ${row.peak} gen ${row.generation} ` +
          `births ${row.births} deaths ${row.deaths} harvests ${row.harvests} ${row.outcome}\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, seeds.length) }, worker));
  const batchWallSeconds = (performance.now() - start) / 1000;

  const payload = {
    tool: 'eden-zero-balance-parallel',
    version: 3,
    args: {
      seeds,
      ticks: Number(ticks),
      predators: Number(predators),
      humans: Number(humans),
      stopAbove: Number(stopAbove),
      jobs,
    },
    notes: [
      'Simulation numbers match a sequential run. Wall time and ticks/s are measured under CPU contention.',
    ],
    batchWallSeconds,
    rows,
    summary: summarize(rows),
  };
  const text = JSON.stringify(payload, null, 2);
  if (out) writeFileSync(out, text);
  else console.log(text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
