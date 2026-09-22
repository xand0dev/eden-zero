/**
 * Headless simulation harness.
 *
 * This exists because "it compiles" is not evidence that an artificial-life
 * world works. Run it to watch population dynamics, foraging success and
 * neural activity over long stretches of simulated time without opening a
 * window.
 *
 *   npm run sim -- --ticks 40000 --seed eden --predators 0
 */
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { DT } from '../src/shared/constants';
import { MOTOR_NAMES } from '../src/simulation/brain/channels';

interface Args {
  ticks: number;
  seed: string;
  predators: number;
  humans: number;
  verbose: boolean;
  every: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    ticks: Number(get('ticks', '40000')),
    seed: get('seed', 'eden'),
    predators: Number(get('predators', '2')),
    humans: Number(get('humans', '8')),
    verbose: argv.includes('--verbose'),
    every: Number(get('every', '2000')),
  };
}

function main(): void {
  const args = parseArgs();
  const world = new World({
    ...DEFAULT_WORLD_OPTIONS,
    seed: args.seed,
    initialHumans: args.humans,
    initialPredators: args.predators,
  });

  console.log(`EDEN//0 headless — seed "${args.seed}", ${args.humans} humans, ${args.predators} predators`);
  console.log(`plants at genesis: ${world.plants.length}`);

  const start = Date.now();
  const actionCounts = new Map<string, number>();
  let travelled = 0;
  const previous = new Map<number, { x: number; y: number }>();
  let peakPopulation = world.humans.length;
  let minPopulation = world.humans.length;
  let firstBirthTick = -1;
  let firstDeathTick = -1;
  const deathReasons = new Map<string, number>();
  let lastEventId = 0;
  let maxThirst = 0;
  let maxHunger = 0;
  let speedSum = 0;
  let speedCount = 0;
  const motorSum = new Array(12).fill(0);

  for (let t = 0; t < args.ticks; t++) {
    for (const human of world.humans) {
      const prev = previous.get(human.id);
      if (prev) travelled += Math.hypot(human.x - prev.x, human.y - prev.y);
      previous.set(human.id, { x: human.x, y: human.y });
    }

    world.step();

    // Deaths must be read from the event log: dead entities are compacted out
    // of the population arrays at the end of the tick that killed them.
    for (const event of world.events) {
      if (event.id <= lastEventId) continue;
      lastEventId = event.id;
      if (event.kind === 'death' || event.kind === 'predation') {
        if (firstDeathTick < 0) firstDeathTick = event.tick;
        const match = /died from (.+?)\./.exec(event.text);
        const reason = event.kind === 'predation' ? 'predation' : (match?.[1] ?? 'unknown');
        deathReasons.set(reason, (deathReasons.get(reason) ?? 0) + 1);
      }
      if (event.kind === 'birth' && firstBirthTick < 0) firstBirthTick = event.tick;
    }

    for (const human of world.humans) {
      const name = MOTOR_NAMES[human.actionIndex] ?? 'unknown';
      actionCounts.set(name, (actionCounts.get(name) ?? 0) + 1);
      if (human.thirst > maxThirst) maxThirst = human.thirst;
      if (human.hunger > maxHunger) maxHunger = human.hunger;
      speedSum += Math.abs(human.speed);
      speedCount++;
      for (let i = 0; i < human.motor.length; i++) motorSum[i] += human.motor[i];
    }

    peakPopulation = Math.max(peakPopulation, world.humans.length);
    minPopulation = Math.min(minPopulation, world.humans.length);

    if (args.every > 0 && (t + 1) % args.every === 0) {
      const stats = world.computeStats();
      const avgHunger = mean(world.humans.map((h) => h.hunger));
      const avgEnergy = mean(world.humans.map((h) => h.energy));
      const avgThirst = mean(world.humans.map((h) => h.thirst));
      const avgFatigue = mean(world.humans.map((h) => h.fatigue));
      const avgDrift = mean(world.humans.map((h) => h.brain.weightDrift()));
      console.log(
        `t=${String(world.tick).padStart(6)} sim=${(world.simTime / 60).toFixed(1)}min ` +
          `pop=${String(stats.population).padStart(3)} (m${stats.males}/f${stats.females}) ` +
          `babies=${stats.babies} children=${stats.children} adults=${stats.adults} elders=${stats.elders} ` +
          `preg=${stats.pregnancies} births=${stats.births} deaths=${stats.deaths} gen=${stats.oldestGeneration} ` +
          `pred=${stats.predators} plants=${String(stats.plants).padStart(5)} ` +
          `| hunger=${avgHunger.toFixed(0)} thirst=${avgThirst.toFixed(0)} energy=${avgEnergy.toFixed(0)} ` +
          `fatigue=${avgFatigue.toFixed(0)} drift=${avgDrift.toFixed(4)}`,
      );
    }
  }

  const elapsed = (Date.now() - start) / 1000;
  const stats = world.computeStats();
  const ticksPerSecond = args.ticks / elapsed;

  console.log('\n=== RESULT ===');
  console.log(`ticks executed      : ${args.ticks} (${(args.ticks * DT / 60).toFixed(1)} simulated minutes)`);
  console.log(`wall time           : ${elapsed.toFixed(2)}s  (${ticksPerSecond.toFixed(0)} ticks/s)`);
  console.log(`population          : ${stats.population} (peak ${peakPopulation}, min ${minPopulation})`);
  console.log(`births / deaths     : ${stats.births} / ${stats.deaths}`);
  console.log(`generations         : ${stats.oldestGeneration}`);
  console.log(`plants              : ${stats.plants}`);
  console.log(`predators           : ${stats.predators}`);
  console.log(`matings             : ${world.totalMatings}`);
  console.log(`first birth tick    : ${firstBirthTick}`);
  console.log(`first death tick    : ${firstDeathTick}`);
  console.log(`total distance moved: ${travelled.toFixed(0)} tiles`);
  console.log(`avg synapses        : ${stats.averageSynapses.toFixed(0)}`);
  console.log(`avg weight drift    : ${stats.averageWeightDrift.toFixed(4)}`);
  console.log(`peak thirst/hunger  : ${maxThirst.toFixed(0)} / ${maxHunger.toFixed(0)}`);
  console.log(`mean |speed|        : ${(speedSum / Math.max(1, speedCount)).toFixed(3)} tiles/s`);
  console.log(
    'mean motor output   : ' +
      motorSum.map((sum, i) => `${MOTOR_NAMES[i]}=${(sum / Math.max(1, speedCount)).toFixed(3)}`).join(' '),
  );

  console.log('\ndeath reasons:');
  for (const [reason, count] of [...deathReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(28)} ${count}`);
  }

  // --- demographics -------------------------------------------------------
  //
  // The population question is "are births keeping up with deaths, and if not,
  // why". These numbers answer the "why" directly rather than by inference.
  const minutes = (args.ticks * DT) / 60;
  const hours = minutes / 60;
  console.log('\ndemographics:');
  console.log(
    `  births / deaths per hour : ${(stats.births / hours).toFixed(1)} / ${(stats.deaths / hours).toFixed(1)}`,
  );
  const d = world.matingDiagnostics;
  console.log(`  eligible-and-willing     : ${(d.willingTicks / Math.max(1, d.ticks)).toFixed(2)} humans/tick`);
  console.log(`  of which female          : ${(d.willingFemalesTicks / Math.max(1, d.ticks)).toFixed(2)} humans/tick`);
  console.log(`  willing pair in range    : ${(d.opportunities / Math.max(1, d.ticks)).toFixed(4)} per tick`);
  console.log(`  pairings                 : ${d.pairings}`);
  console.log(`  completed matings        : ${world.totalMatings}`);
  console.log(
    `  conception success       : ${((stats.births / Math.max(1, world.totalMatings)) * 100).toFixed(0)}%`,
  );
  console.log(`  mean offspring per female: ${(stats.births / Math.max(1, args.humans / 2)).toFixed(2)}`);

  console.log('\nconstruction:');
  console.log(`  huts finished        : ${stats.huts}`);
  console.log(`  sites under way      : ${stats.sites}`);
  console.log(`  standing timber      : ${stats.timber.toFixed(0)}`);
  console.log(
    `  timber carried       : ${world.humans.reduce((sum, h) => sum + h.wood, 0).toFixed(0)} units ` +
      `across ${world.humans.filter((h) => h.wood > 0).length} humans`,
  );
  const buildEvents = world.events.filter((e) => e.kind === 'build');
  console.log(`  build events (window): ${buildEvents.length}`);
  for (const event of buildEvents.slice(-4)) console.log(`      [t=${event.tick}] ${event.text}`);

  console.log('\nmotor output distribution (all humans, all ticks):');
  const sorted = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0) || 1;
  for (const [name, count] of sorted) {
    const bar = '#'.repeat(Math.round((count / total) * 50));
    console.log(`  ${name.padEnd(16)} ${((count / total) * 100).toFixed(1).padStart(5)}% ${bar}`);
  }

  if (args.verbose) {
    console.log('\nrecent events:');
    for (const event of world.events.slice(-30)) {
      console.log(`  [t=${event.tick}] ${event.text}`);
    }
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

main();
