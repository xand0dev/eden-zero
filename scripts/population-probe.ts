/**
 * Population probe — why does a world stop reproducing?
 *
 * The balance harness says *that* a population declines. This says *where* the
 * reproductive pipeline breaks, by sampling the same world at fixed intervals:
 *
 *   adults -> fertile -> eligible (canMate) -> willing (mate motor over the gate)
 *          -> meets a willing partner -> pairs -> conceives -> gives birth
 *
 * plus the motor distribution of adults (what they are doing instead) and the
 * age and reason of every death (who is dying, not just how many).
 *
 *   npm run probe:population -- --seed eden --ticks 200000 --predators 0 --window 10000 [--json]
 *
 * Read-only: it observes a world and never changes one.
 */
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { M, MOTOR_COUNT, MOTOR_NAMES, MOTOR_START, S } from '../src/simulation/brain/channels';
import { AGE_CHILD_END } from '../src/shared/constants';
import type { Human } from '../src/simulation/entities/human';

const argv = process.argv.slice(2);
const get = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const seed = get('seed', 'eden');
const ticks = Number(get('ticks', '200000'));
const predators = Number(get('predators', '0'));
const windowTicks = Number(get('window', '10000'));
const json = argv.includes('--json');
/**
 * Counterfactual: forbid founding fields and canals, so the agriculture channels
 * stay silent. Diagnostic only — it patches this probe's world instance and
 * changes nothing in the simulation source.
 */
const noFarming = argv.includes('--no-farming');

/** The gate `World.resolveMating` applies to the mate motor. */
const MATE_GATE = 0.35;
/** The gate `Human.act` applies to plant/tend/dig. */
const FARM_GATE = 0.3;

interface Window {
  endTick: number;
  population: number;
  adults: number;
  meanAdults: number;
  /** Mean per tick, over adults. */
  fertileFrac: number;
  eligibleFrac: number;
  willingFrac: number;
  meanLibido: number;
  meanMate: number;
  meanHunger: number;
  meanThirst: number;
  meanFatigue: number;
  meanEnergy: number;
  /** Adaptive motor read-out baseline (mean motor drive), averaged over adults. */
  meanBaseline: number;
  /** Raw integrated drive of the mate motor, before the baseline is subtracted. */
  meanMateDrive: number;
  /** The innate libido -> mate synapse weight, averaged over adults. */
  meanLibidoWeight: number;
  /** Fraction of adult-ticks where each motor is the strongest output. */
  winner: Record<string, number>;
  /** Mean adult command for each motor. */
  motorMean: Record<string, number>;
  /** Fraction of adult-ticks where plant/tend/dig clears its action gate. */
  farmGateFrac: number;
  meanFieldNeed: number;
  opportunities: number;
  pairings: number;
  matings: number;
  conceptions: number;
  births: number;
  deaths: number;
  deathsByStage: Record<string, number>;
  deathsByReason: Record<string, number>;
  /** Mean tiles to water at the moment of a dehydration death. */
  dehydrationWaterDistance: number;
  /** Mean distance of adults from the settlement centre. */
  meanHomeDistance: number;
  /** Mean distance from each adult to the nearest other human. */
  meanNearestHuman: number;
  /** Mean tiles to water, over all humans. */
  meanWaterDistance: number;
}

const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed, initialPredators: predators });
if (noFarming) {
  world.foundField = () => null;
  world.foundCanal = () => null;
}

/** Brain internals the probe reads but the simulation keeps private. */
interface BrainInternals {
  motorBaseline: number;
  motorDrive: Float32Array;
  pre: Int32Array;
  post: Int32Array;
  w: Float32Array;
  synCount: number;
}
/** Index of the innate libido -> mate synapse, per human, found once. */
const libidoSynapse = new Map<number, number>();
function libidoToMate(human: Human): number {
  const brain = human.brain as unknown as BrainInternals;
  let index = libidoSynapse.get(human.id);
  if (index === undefined) {
    index = -1;
    for (let s = 0; s < brain.synCount; s++) {
      if (brain.pre[s] === S.libido && brain.post[s] === MOTOR_START + M.mate) {
        index = s;
        break;
      }
    }
    libidoSynapse.set(human.id, index);
  }
  return index >= 0 ? brain.w[index] : 0;
}

let alive = new Map<number, Human>(world.humans.map((h) => [h.id, h]));
const windows: Window[] = [];

function freshAcc() {
  return {
    adultTicks: 0,
    popTicks: 0,
    fertile: 0,
    eligible: 0,
    willing: 0,
    libido: 0,
    mate: 0,
    hunger: 0,
    thirst: 0,
    fatigue: 0,
    energy: 0,
    baseline: 0,
    mateDrive: 0,
    libidoWeight: 0,
    farmGate: 0,
    fieldNeed: 0,
    winner: new Array<number>(MOTOR_COUNT).fill(0),
    motor: new Array<number>(MOTOR_COUNT).fill(0),
    deaths: 0,
    deathsByStage: {} as Record<string, number>,
    deathsByReason: {} as Record<string, number>,
    dehydrationWater: 0,
    dehydrations: 0,
    homeDistance: 0,
    nearestHuman: 0,
    nearestSamples: 0,
    waterDistance: 0,
    start: {
      opportunities: world.matingDiagnostics.opportunities,
      pairings: world.matingDiagnostics.pairings,
      matings: world.totalMatings,
      births: world.births,
    },
    conceptions: 0,
  };
}

let acc = freshAcc();
let lastEventId = world.events.length ? world.events[world.events.length - 1].id : 0;

for (let t = 0; t < ticks; t++) {
  world.step();

  for (let i = world.events.length - 1; i >= 0 && world.events[i].id > lastEventId; i--) {
    if (world.events[i].kind === 'conception') acc.conceptions++;
  }
  if (world.events.length) lastEventId = world.events[world.events.length - 1].id;

  // Deaths: anyone we knew last tick who is gone now.
  const next = new Map<number, Human>();
  for (const human of world.humans) next.set(human.id, human);
  for (const [id, human] of alive) {
    if (next.has(id)) continue;
    acc.deaths++;
    const stage = human.ageBio < 1.5 ? 'baby' : human.ageBio < AGE_CHILD_END ? 'child' : human.ageBio < 45 ? 'adult' : 'elder';
    acc.deathsByStage[stage] = (acc.deathsByStage[stage] ?? 0) + 1;
    const reason = (human.deathReason ?? 'unknown').replace(/ by Hunter \d+/, '');
    acc.deathsByReason[reason] = (acc.deathsByReason[reason] ?? 0) + 1;
    if (reason === 'dehydration') {
      acc.dehydrationWater += world.waterDistanceAt(human.x, human.y);
      acc.dehydrations++;
    }
  }
  alive = next;

  acc.popTicks += world.humans.length;
  const centre = world.settlementCentre ?? { x: 0, y: 0 };
  const sampleSpacing = world.tick % 20 === 0;
  for (const human of world.humans) {
    acc.waterDistance += world.waterDistanceAt(human.x, human.y);
    if (sampleSpacing && human.ageBio >= AGE_CHILD_END) {
      let nearest = Infinity;
      for (const other of world.humans) {
        if (other === human) continue;
        nearest = Math.min(nearest, Math.hypot(other.x - human.x, other.y - human.y));
      }
      if (nearest < Infinity) {
        acc.nearestHuman += nearest;
        acc.nearestSamples++;
      }
    }
    if (human.ageBio < AGE_CHILD_END) continue;
    acc.adultTicks++;
    acc.homeDistance += Math.hypot(human.x - centre.x, human.y - centre.y);
    if (human.fertility01 > 0.12) acc.fertile++;
    const eligible = human.canMate();
    if (eligible) acc.eligible++;
    if (eligible && human.motor[M.mate] >= MATE_GATE) acc.willing++;
    acc.libido += human.libido;
    acc.mate += human.motor[M.mate];
    acc.hunger += human.hunger;
    acc.thirst += human.thirst;
    acc.fatigue += human.fatigue;
    acc.energy += human.energy;
    const brain = human.brain as unknown as BrainInternals;
    acc.baseline += brain.motorBaseline;
    acc.mateDrive += brain.motorDrive[M.mate];
    acc.libidoWeight += libidoToMate(human);
    acc.fieldNeed += human.sensors[S.fieldNeed];
    if (human.motor[M.plant] > FARM_GATE || human.motor[M.tend] > FARM_GATE || human.motor[M.dig] > FARM_GATE) {
      acc.farmGate++;
    }
    acc.winner[human.actionIndex]++;
    for (let m = 0; m < MOTOR_COUNT; m++) acc.motor[m] += human.motor[m];
  }

  if (world.tick % windowTicks === 0 || t === ticks - 1) {
    const n = Math.max(1, acc.adultTicks);
    const span = windowTicks;
    const winner: Record<string, number> = {};
    const motorMean: Record<string, number> = {};
    for (let m = 0; m < MOTOR_COUNT; m++) {
      winner[MOTOR_NAMES[m]] = acc.winner[m] / n;
      motorMean[MOTOR_NAMES[m]] = acc.motor[m] / n;
    }
    windows.push({
      endTick: world.tick,
      population: world.humans.length,
      adults: world.humans.filter((h) => h.ageBio >= AGE_CHILD_END).length,
      meanAdults: acc.adultTicks / span,
      fertileFrac: acc.fertile / n,
      eligibleFrac: acc.eligible / n,
      willingFrac: acc.willing / n,
      meanLibido: acc.libido / n,
      meanMate: acc.mate / n,
      meanHunger: acc.hunger / n,
      meanThirst: acc.thirst / n,
      meanFatigue: acc.fatigue / n,
      meanEnergy: acc.energy / n,
      meanBaseline: acc.baseline / n,
      meanMateDrive: acc.mateDrive / n,
      meanLibidoWeight: acc.libidoWeight / n,
      winner,
      motorMean,
      farmGateFrac: acc.farmGate / n,
      meanFieldNeed: acc.fieldNeed / n,
      opportunities: world.matingDiagnostics.opportunities - acc.start.opportunities,
      pairings: world.matingDiagnostics.pairings - acc.start.pairings,
      matings: world.totalMatings - acc.start.matings,
      conceptions: acc.conceptions,
      births: world.births - acc.start.births,
      deaths: acc.deaths,
      deathsByStage: acc.deathsByStage,
      deathsByReason: acc.deathsByReason,
      dehydrationWaterDistance: acc.dehydrations > 0 ? acc.dehydrationWater / acc.dehydrations : 0,
      meanHomeDistance: acc.homeDistance / n,
      meanNearestHuman: acc.nearestSamples > 0 ? acc.nearestHuman / acc.nearestSamples : 0,
      meanWaterDistance: acc.waterDistance / Math.max(1, acc.popTicks),
    });
    acc = freshAcc();
    if (world.humans.length === 0) break;
  }
}

if (json) {
  console.log(JSON.stringify({ seed, ticks, predators, windowTicks, noFarming, generation: world.maxGeneration, windows }, null, 2));
} else {
  console.log(
    `population probe — seed ${seed}, ${ticks} ticks, ${predators} predators, window ${windowTicks}` +
      `${noFarming ? ', NO FARMING (counterfactual)' : ''}\n`,
  );
  console.log(
    '   tick  pop adlt  fert  elig  will libido  mate  hung thir fatg  farm  opp pair mate conc born died  top motors',
  );
  for (const w of windows) {
    const top = Object.entries(w.winner)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, frac]) => `${name} ${(frac * 100).toFixed(0)}%`)
      .join(', ');
    console.log(
      `${String(w.endTick).padStart(7)} ${String(w.population).padStart(4)} ${String(w.adults).padStart(4)}  ` +
        `${w.fertileFrac.toFixed(2)}  ${w.eligibleFrac.toFixed(2)}  ${w.willingFrac.toFixed(2)}  ${w.meanLibido.toFixed(2)}  ` +
        `${w.meanMate.toFixed(2)}  ${w.meanHunger.toFixed(0).padStart(4)} ${w.meanThirst.toFixed(0).padStart(4)} ${w.meanFatigue.toFixed(0).padStart(4)}  ` +
        `${w.farmGateFrac.toFixed(2)} ${String(w.opportunities).padStart(4)} ${String(w.pairings).padStart(4)} ${String(w.matings).padStart(4)} ` +
        `${String(w.conceptions).padStart(4)} ${String(w.births).padStart(4)} ${String(w.deaths).padStart(4)}  ${top}`,
    );
    console.log(
      `         brain: baseline ${w.meanBaseline.toFixed(3)} mateDrive ${w.meanMateDrive.toFixed(3)} ` +
        `libido->mate w ${w.meanLibidoWeight.toFixed(3)}`,
    );
    console.log(
      `         space: adults ${w.meanHomeDistance.toFixed(1)} from centre, nearest human ${w.meanNearestHuman.toFixed(1)}, ` +
        `water ${w.meanWaterDistance.toFixed(1)}` +
        (w.dehydrationWaterDistance > 0 ? `, dehydration deaths ${w.dehydrationWaterDistance.toFixed(1)} tiles from water` : ''),
    );
    if (w.deaths > 0) {
      console.log(`         deaths: ${JSON.stringify(w.deathsByStage)} ${JSON.stringify(w.deathsByReason)}`);
    }
  }
  console.log(`\nfinal: population ${world.humans.length}, generation ${world.maxGeneration}, births ${world.births}, deaths ${world.deaths}`);
}
