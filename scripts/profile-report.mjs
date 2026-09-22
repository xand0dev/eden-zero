/**
 * Parse a V8 .cpuprofile and report where the time actually went.
 *
 * Node's `--cpu-prof` writes a JSON profile; Chrome DevTools can open it, but a
 * terminal summary is what you want when tuning a simulation, and it can be
 * committed alongside the numbers it produced.
 *
 *   node --cpu-prof --cpu-prof-dir=/tmp/prof --import tsx scripts/bench.ts --ticks 8000
 *   node scripts/profile-report.mjs /tmp/prof/CPU.*.cpuprofile
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
const path = target ?? join('/tmp/prof', readdirSync('/tmp/prof').find((f) => f.endsWith('.cpuprofile')) ?? '');
if (!path) {
  console.error('no profile found; run the bench with --cpu-prof first');
  process.exit(1);
}

const profile = JSON.parse(readFileSync(path, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));

// A sample's leaf node is where the CPU actually was. Self time is therefore a
// count of samples per node; total time requires walking the parent chain, which
// the stack walk below does.
const selfSamples = new Map();
for (const id of profile.samples) selfSamples.set(id, (selfSamples.get(id) ?? 0) + 1);

const totalSamples = profile.samples.length;
const interval = profile.timeDeltas.reduce((sum, d) => sum + d, 0) / 1e6;

function label(node) {
  const fn = node.callFrame.functionName || '(anonymous)';
  const url = node.callFrame.url || '';
  const short = url.replace(/^.*\/(src|scripts|node_modules)\//, '$1/').replace(/:\d+:\d+$/, '');
  return short ? `${fn}  ${short}` : fn;
}

console.log(`profile: ${path}`);
console.log(`samples: ${totalSamples}  over ${interval.toFixed(2)} s of CPU\n`);

// --- self time --------------------------------------------------------------
const selfByLabel = new Map();
for (const [id, count] of selfSamples) {
  const node = byId.get(id);
  if (!node) continue;
  const key = label(node);
  selfByLabel.set(key, (selfByLabel.get(key) ?? 0) + count);
}

const ranked = [...selfByLabel.entries()].sort((a, b) => b[1] - a[1]);
console.log('self time — where the CPU actually was');
console.log('  share   samples  function');
for (const [key, count] of ranked.slice(0, 18)) {
  const share = (count / totalSamples) * 100;
  if (share < 0.4) break;
  const bar = '#'.repeat(Math.max(1, Math.round(share / 2)));
  console.log(`  ${share.toFixed(1).padStart(5)}%  ${String(count).padStart(7)}  ${key}  ${bar}`);
}

// --- total time by file -----------------------------------------------------
const fileTotals = new Map();
for (const [key, count] of selfByLabel) {
  const file = key.includes('  ') ? key.split('  ')[1] : '(native)';
  fileTotals.set(file, (fileTotals.get(file) ?? 0) + count);
}
console.log('\ntotal time by file');
for (const [file, count] of [...fileTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const share = (count / totalSamples) * 100;
  console.log(`  ${share.toFixed(1).padStart(5)}%  ${file}`);
}
