/**
 * Brain diagnostic: how alive is a single freshly-generated network?
 *
 *   ./node_modules/.bin/tsx scripts/brain-probe.ts
 */
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { Rng } from '../src/simulation/rng';
import { Brain } from '../src/simulation/brain/network';
import { randomGenome } from '../src/simulation/genetics/genome';
import { MOTOR_NAMES, MOTOR_START, MOD_START, RECURRENT_START, LOCAL_START } from '../src/simulation/brain/channels';

const rng = new Rng('probe');

console.log('=== static topology ===');
for (let i = 0; i < 3; i++) {
  const genome = randomGenome(rng, 0);
  const brain = new Brain(genome, rng);
  const stats = brain.stats();
  let sumAbs = 0;
  let sumExc = 0;
  for (let s = 0; s < brain.synCount; s++) {
    sumAbs += Math.abs(brain.w[s]);
    if (brain.w[s] > 0) sumExc += brain.w[s];
  }
  let inRec = 0;
  for (let n = RECURRENT_START; n < MOD_START; n++) inRec += brain.inStart[n + 1] - brain.inStart[n];
  let inMot = 0;
  for (let n = MOTOR_START; n < 256; n++) inMot += brain.inStart[n + 1] - brain.inStart[n];
  console.log(
    `brain ${i}: syn=${stats.synapses} exc=${stats.excitatory} inh=${stats.inhibitory} ` +
      `mean|w|=${(sumAbs / brain.synCount).toFixed(4)} sumExc=${sumExc.toFixed(1)} ` +
      `inPerRec=${(inRec / 132).toFixed(1)} inPerMotor=${(inMot / 12).toFixed(1)}`,
  );
}

console.log('\n=== dynamics with a synthetic sensory drive ===');
const genome = randomGenome(rng, 0);
const brain = new Brain(genome, rng);
const sensory = new Float32Array(32);
const motor = new Float32Array(12);
// A plausible mid-strength sensory pattern.
sensory[21] = 0.6; // hunger
sensory[22] = 0.4; // thirst
sensory[0] = 0.45; // food.front
sensory[4] = 0.3; // water.front
sensory[20] = 0.7; // light
sensory[31] = 0.5; // noise

for (let t = 0; t < 400; t++) {
  brain.step(sensory, 0);
  brain.applyPlasticity(genome.plasticity, 0);
  if (t % 50 === 0 || t === 399) {
    brain.readMotor(motor);
    let sensoryRate = 0;
    for (let i = 0; i < 32; i++) sensoryRate += brain.rate[i];
    let localRate = 0;
    for (let i = LOCAL_START; i < RECURRENT_START; i++) localRate += brain.rate[i];
    let recRate = 0;
    for (let i = RECURRENT_START; i < MOD_START; i++) recRate += brain.rate[i];
    let modRate = 0;
    for (let i = MOD_START; i < MOTOR_START; i++) modRate += brain.rate[i];
    let motorRate = 0;
    for (let i = MOTOR_START; i < 256; i++) motorRate += brain.rate[i];
    console.log(
      `t=${String(t).padStart(3)} ` +
        `rates: sens=${(sensoryRate / 32).toFixed(3)} local=${(localRate / 64).toFixed(3)} ` +
        `rec=${(recRate / 132).toFixed(3)} mod=${(modRate / 16).toFixed(3)} mot=${(motorRate / 12).toFixed(3)} ` +
        `| motorOut=${Array.from(motor)
          .map((v) => v.toFixed(2))
          .join(',')}`,
    );
  }
}

console.log('\n=== motor argmax over 400 ticks ===');
const counts = new Map<string, number>();
for (let t = 0; t < 400; t++) {
  brain.step(sensory, 0);
  brain.readMotor(motor);
  const idx = MOTOR_NAMES.length > 0 ? argmax(motor) : 0;
  counts.set(MOTOR_NAMES[idx], (counts.get(MOTOR_NAMES[idx]) ?? 0) + 1);
}
for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(16)} ${count}`);
}

console.log('\n=== world: single tick trace of founder 0 ===');
const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed: 'eden', initialPredators: 0 });
const human = world.humans[0];
console.log(`spawn at (${human.x.toFixed(1)}, ${human.y.toFixed(1)}) tile=${world.terrain.tiles[Math.floor(human.y) * world.terrain.width + Math.floor(human.x)]}`);
for (let t = 0; t < 600; t++) {
  world.step();
  if (t % 100 === 0 || t === 599) {
    const h = world.humans[0];
    if (!h) {
      console.log(`t=${t}: human gone`);
      break;
    }
    console.log(
      `t=${String(t).padStart(3)} pos=(${h.x.toFixed(1)},${h.y.toFixed(1)}) head=${h.heading.toFixed(2)} speed=${h.speed.toFixed(2)} ` +
        `hunger=${h.hunger.toFixed(0)} thirst=${h.thirst.toFixed(0)} energy=${h.energy.toFixed(0)} ` +
        `health=${h.health.toFixed(0)} action=${h.currentAction} focus=${h.currentFocus}(${h.focusValue.toFixed(2)}) ` +
        `motor=[${Array.from(h.motor).map((v) => v.toFixed(2)).join(',')}]`,
    );
  }
}

function argmax(values: Float32Array): number {
  let best = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > bestValue) {
      bestValue = values[i];
      best = i;
    }
  }
  return best;
}
