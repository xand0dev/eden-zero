/**
 * Contribution-trace probe.
 *
 * "Why did it do that?" is a headline feature, and the acceptance run reported
 * paths of a single node, which means the backward recovery is not descending.
 * This dumps the raw numbers behind the panel so the cause can be measured
 * rather than guessed at.
 *
 *   npm run trace
 */
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { MOTOR_COUNT, MOTOR_NAMES, MOTOR_START } from '../src/simulation/brain/channels';

const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed: 'trace', initialPredators: 0 });

// Let the world settle so the networks are doing something.
for (let i = 0; i < 4000; i++) world.step();

const brain = world.humans[0].brain;
console.log('brain arrays');
console.log(`  neurons        ${brain.rate.length}`);
console.log(`  synapses       ${brain.synCount}`);

let activeRates = 0;
let maxRate = 0;
for (let i = 0; i < brain.rate.length; i++) {
  const value = Math.abs(brain.rate[i]);
  if (value > 1e-4) activeRates++;
  if (value > maxRate) maxRate = value;
}
console.log(`  active neurons ${activeRates} (${((activeRates / brain.rate.length) * 100).toFixed(0)}%)`);
console.log(`  max |rate|     ${maxRate.toFixed(4)}`);

let maxWeight = 0;
let sumWeight = 0;
for (let i = 0; i < brain.synCount; i++) {
  const value = Math.abs(brain.w[i]);
  sumWeight += value;
  if (value > maxWeight) maxWeight = value;
}
console.log(`  max |weight|   ${maxWeight.toFixed(4)}`);
console.log(`  mean |weight|  ${(sumWeight / brain.synCount).toFixed(4)}`);

// How many incoming synapses does each motor neuron have, and what do they carry?
console.log('\nmotor neurons — incoming contribution profile');
for (let m = 0; m < MOTOR_COUNT; m++) {
  const target = MOTOR_START + m;
  const start = brain.inStart[target];
  const end = brain.inStart[target + 1];
  let nonZero = 0;
  let best = 0;
  for (let s = start; s < end; s++) {
    const idx = brain.inSyn[s];
    const contribution = Math.abs(brain.w[idx] * brain.rate[brain.pre[idx]]);
    if (contribution > 1e-4) nonZero++;
    if (contribution > best) best = contribution;
  }
  console.log(
    `  ${MOTOR_NAMES[m].padEnd(15)} fan-in ${String(end - start).padStart(4)}  ` +
      `carrying ${String(nonZero).padStart(4)}  best ${best.toFixed(4)}`,
  );
}

// Walk the actual explanation for every human.
console.log('\nexplanations');
for (const human of world.humans.slice(0, 6)) {
  const explanation = world.explain(human.id);
  if (!explanation) {
    console.log(`  ${human.name}: none`);
    continue;
  }
  console.log(
    `  ${human.name.padEnd(9)} action ${explanation.action.padEnd(14)} ` +
      `strength ${explanation.strength.toFixed(2)}  ` +
      `summary lines ${explanation.summary.length}  path ${explanation.path.length}`,
  );
  for (const line of explanation.summary.slice(0, 3)) console.log(`      contributor: ${line}`);
  for (const node of explanation.path) {
    console.log(
      `      path ${node.short.padEnd(22)} activation ${node.activation.toFixed(4)}  ` +
        `contribution ${node.contribution.toFixed(4)}`,
    );
  }
}

// How deep does the backward walk actually get, across the whole population?
console.log('\npath-length distribution across all humans');
const histogram = new Map<number, number>();
for (const human of world.humans) {
  const explanation = world.explain(human.id);
  const length = explanation ? explanation.path.length : 0;
  histogram.set(length, (histogram.get(length) ?? 0) + 1);
}
for (const [length, count] of [...histogram.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${length} nodes: ${count}`);
}
