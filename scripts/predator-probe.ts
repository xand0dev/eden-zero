import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { MOTOR_NAMES } from '../src/simulation/brain/channels';

const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed: 'probe', initialPredators: 1 });
const predator = world.predators[0];
const victim = world.humans[0];

console.log('predator genome:');
console.log(`  species        ${predator.genome.species}`);
console.log(`  aggressionGain ${predator.genome.aggressionGain.toFixed(3)}`);
console.log(`  attackPower    ${predator.genome.attackPower.toFixed(1)}`);
console.log(`  visionRange    ${predator.genome.visionRange.toFixed(1)}`);
console.log(`  synapses       ${predator.brain.synCount}`);

let gatePasses = 0;
let attacks = 0;
let maxAttackMotor = 0;
let maxFoodFront = 0;

for (let i = 0; i < 3000; i++) {
  predator.x = victim.x + 0.4;
  predator.y = victim.y;
  predator.hunger = 95;
  predator.energy = 30;
  predator.pain = 0;

  const beforeHealth = victim.health;
  world.step();

  const attackMotor = predator.motor[MOTOR_NAMES.indexOf('attack')];
  if (attackMotor > maxAttackMotor) maxAttackMotor = attackMotor;
  if (attackMotor * predator.genome.aggressionGain > 0.35) gatePasses++;
  if (victim.health < beforeHealth) attacks++;
  if (predator.sensors[0] > maxFoodFront) maxFoodFront = predator.sensors[0];

  if (!victim.alive) {
    console.log(`victim died at tick ${world.tick}`);
    break;
  }
}

console.log('\nafter 3000 ticks:');
console.log(`  victim alive       ${victim.alive}`);
console.log(`  victim health      ${victim.health.toFixed(1)}`);
console.log(`  attacks that landed ${attacks}`);
console.log(`  ticks gate passed   ${gatePasses}`);
console.log(`  max attack motor    ${maxAttackMotor.toFixed(3)}`);
console.log(`  max foodFront       ${maxFoodFront.toFixed(3)}`);
console.log(`  predator action     ${MOTOR_NAMES[predator.actionIndex]}`);
