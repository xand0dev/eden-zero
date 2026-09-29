import { Rng } from '../rng';
import { DAY_SECONDS, SIM_HZ } from '../../shared/constants';
import { Era } from './eras';
import { Season, YEAR_SECONDS, calendarAt } from './calendar';

/**
 * Crises — fate, on a schedule the observer cannot see but can prepare for.
 *
 * A crisis changes the *physics* of the world: the land dries, a winter bites
 * harder, a pack of predators walks in from the coast, a blight moves through the
 * fields. It never touches what anyone decides. Whether a village survives a
 * drought depends on whether its brains have learned to find water, whether it
 * dug canals, and on what the observer chose to do with the warning.
 *
 * Every crisis has a warning (a day), an active phase and an end. The first comes
 * no earlier than the second year, and later ones every two to three years —
 * never two at once, and harder as the settlement grows.
 *
 * Randomness comes from a dedicated stream (`seed:fate`), so the schedule is
 * deterministic per seed and does not perturb the world's own random stream.
 */

export const CrisisKind = {
  Drought: 'drought',
  HarshWinter: 'harshWinter',
  PredatorMigration: 'predatorMigration',
  Blight: 'blight',
  Flood: 'flood',
  Fever: 'fever',
  Fire: 'fire',
  Eclipse: 'eclipse',
} as const;
export type CrisisKind = (typeof CrisisKind)[keyof typeof CrisisKind];

export interface CrisisDefinition {
  kind: CrisisKind;
  name: string;
  /** Earliest era in which fate can choose this. */
  minEra: number;
  /** Active length in simulated days. */
  days: number;
  /** What the observer is told a day ahead. */
  warning: string;
  /** What the chronicle says when it begins. */
  onset: string;
  /** What the observer can do about it. */
  advice: string;
}

export const CRISES: Record<CrisisKind, CrisisDefinition> = {
  drought: {
    kind: 'drought',
    name: 'Drought',
    minEra: Era.Camp,
    days: 3,
    warning: 'The sky has turned yellow and the wind is dry. A drought is coming.',
    onset: 'Drought. The ground cracks; plants stop growing and fields dry fast.',
    advice: 'Rain on the fields. Canals and wells already dug soften the blow.',
  },
  harshWinter: {
    kind: 'harshWinter',
    name: 'Harsh winter',
    minEra: Era.Camp,
    days: 2,
    warning: 'The first frost came early. This winter will be a hard one.',
    onset: 'A harsh winter. Nights far below freezing; nothing grows.',
    advice: 'Warm the world, feed the hungry. Huts and full granaries are what save a village.',
  },
  predatorMigration: {
    kind: 'predatorMigration',
    name: 'Predator migration',
    minEra: Era.Village,
    days: 2,
    warning: 'Tracks on the shore. Something is moving inland.',
    onset: 'A pack of predators has come ashore.',
    advice: 'Lightning drives them off. A palisade keeps them out.',
  },
  blight: {
    kind: 'blight',
    name: 'Blight',
    minEra: Era.Village,
    days: 1.5,
    warning: 'Dark spots on the leaves of the driest field.',
    onset: 'Blight. Crops are rotting, and it spreads field to field.',
    advice: 'Burn an infected field with lightning to stop it spreading. Scattered fields lose less.',
  },
  flood: {
    kind: 'flood',
    name: 'Flood',
    minEra: Era.Village,
    days: 1,
    warning: 'Heavy rain in the hills. The river is rising.',
    onset: 'The river has flooded its banks. Low fields are lost.',
    advice: 'Nothing can stop it. Fields sown further from the river survive.',
  },
  fever: {
    kind: 'fever',
    name: 'Fever',
    minEra: Era.Town,
    days: 2,
    warning: 'Someone is coughing.',
    onset: 'Fever. It passes between people who stand close together.',
    advice: 'Move the sick apart. A blessing heals and cures.',
  },
  fire: {
    kind: 'fire',
    name: 'Wildfire',
    minEra: Era.Town,
    days: 1,
    warning: 'A dry season, and dry lightning on the horizon.',
    onset: 'Wildfire. It runs from tree to tree and into the huts.',
    advice: 'Rain puts it out. Canals and open water stop it spreading.',
  },
  eclipse: {
    kind: 'eclipse',
    name: 'Eclipse',
    minEra: Era.City,
    days: 1,
    warning: 'The moon will cross the sun tomorrow.',
    onset: 'Eclipse. A day without light: every eye is blind.',
    advice: 'Nothing to do but watch what the brains do in the dark.',
  },
};

export const CRISIS_ORDER: CrisisKind[] = [
  'drought',
  'harshWinter',
  'predatorMigration',
  'blight',
  'flood',
  'fever',
  'fire',
  'eclipse',
];

export type CrisisPhase = 'warning' | 'active';

/**
 * How hard fate strikes in each era.
 *
 * A camp of twenty is fragile: the first sweep with a flat severity of 1 saw a
 * camp drought take a village from 20 to 10 and 15 to 5, and a camp winter from
 * 9 to 4. The first crisis should be a test the camp can pass; the city's should
 * be a real threat.
 */
export const SEVERITY_BY_ERA = [0.6, 0.6, 0.8, 1, 1.25] as const;

export interface ActiveCrisis {
  kind: CrisisKind;
  phase: CrisisPhase;
  /** Tick the warning was issued. */
  warnedAt: number;
  /** Tick the crisis begins. */
  startsAt: number;
  /** Tick the crisis ends. */
  endsAt: number;
  /** 0.6 in a camp, rising to 1.25 in a city (see `SEVERITY_BY_ERA`). */
  severity: number;
  /** Population when it began, for the verdict. */
  populationAtStart: number;
}

export interface CrisisRecord {
  kind: CrisisKind;
  startedAt: number;
  endedAt: number;
  severity: number;
  survived: boolean;
  populationBefore: number;
  populationAfter: number;
}

export interface FateState {
  rngState: number[];
  nextAt: number;
  current: ActiveCrisis | null;
  history: CrisisRecord[];
}

const TICKS_PER_DAY = DAY_SECONDS * SIM_HZ;
const TICKS_PER_YEAR = YEAR_SECONDS * SIM_HZ;

export function createFate(seed: string, frequency: number): FateState {
  const rng = new Rng(`${seed}:fate`);
  // The first crisis comes in the second year at the earliest.
  const first = Math.round(TICKS_PER_YEAR * (1 + rng.next() * 0.5) / Math.max(0.2, Math.sqrt(frequency)));
  return { rngState: rng.getState(), nextAt: first, current: null, history: [] };
}

export interface FateEvent {
  type: 'warning' | 'start' | 'end';
  crisis: ActiveCrisis;
  record?: CrisisRecord;
}

/**
 * Advance fate by one tick. Returns what changed, if anything.
 *
 * `weights` comes from the charter and biome; a zero weight removes a kind.
 */
export function updateFate(
  fate: FateState,
  tick: number,
  simTime: number,
  era: number,
  population: number,
  frequency: number,
  weights: Partial<Record<string, number>>,
): FateEvent | null {
  const current = fate.current;
  if (current) {
    if (current.phase === 'warning' && tick >= current.startsAt) {
      current.phase = 'active';
      current.populationAtStart = population;
      return { type: 'start', crisis: current };
    }
    if (current.phase === 'active' && tick >= current.endsAt) {
      const record: CrisisRecord = {
        kind: current.kind,
        startedAt: current.startsAt,
        endedAt: tick,
        severity: current.severity,
        survived: population >= 2,
        populationBefore: current.populationAtStart,
        populationAfter: population,
      };
      fate.history.push(record);
      fate.current = null;
      const rng = new Rng(0);
      rng.setState(fate.rngState);
      const years = (2 + rng.next()) / Math.max(0.2, frequency);
      fate.nextAt = tick + Math.round(years * TICKS_PER_YEAR);
      fate.rngState = rng.getState();
      return { type: 'end', crisis: current, record };
    }
    return null;
  }

  if (tick < fate.nextAt || population < 2) return null;

  const rng = new Rng(0);
  rng.setState(fate.rngState);
  const season = calendarAt(simTime).season;
  const eligible: Array<[CrisisKind, number]> = [];
  for (const kind of CRISIS_ORDER) {
    const def = CRISES[kind];
    if (era < def.minEra) continue;
    let weight = weights[kind] ?? 1;
    // Fire needs a dry season; eclipses are rare even when possible.
    if (kind === 'fire' && season !== Season.Summer && season !== Season.Spring) weight = 0;
    if (kind === 'eclipse') weight *= 0.35;
    // Never repeat the last kind straight away: fate should vary.
    const last = fate.history[fate.history.length - 1];
    if (last && last.kind === kind) weight *= 0.25;
    if (weight > 0) eligible.push([kind, weight]);
  }
  if (eligible.length === 0) {
    // Nothing fate can do in this era yet: look again in half a year.
    fate.nextAt = tick + Math.round(TICKS_PER_YEAR / 2);
    fate.rngState = rng.getState();
    return null;
  }
  const total = eligible.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  let kind = eligible[0][0];
  for (const [candidate, weight] of eligible) {
    roll -= weight;
    if (roll <= 0) {
      kind = candidate;
      break;
    }
  }
  fate.rngState = rng.getState();

  let startsAt = tick + TICKS_PER_DAY;
  let length = Math.round(CRISES[kind].days * TICKS_PER_DAY);
  if (kind === 'harshWinter') {
    // A harsh winter is a winter: it starts when winter does.
    const yearStart = Math.floor(tick / TICKS_PER_YEAR) * TICKS_PER_YEAR;
    let winterStart = yearStart + Math.round(TICKS_PER_YEAR * 0.75);
    while (winterStart < tick + TICKS_PER_DAY) winterStart += TICKS_PER_YEAR;
    startsAt = winterStart;
    length = Math.round(TICKS_PER_YEAR * 0.25);
  }
  const crisis: ActiveCrisis = {
    kind,
    phase: 'warning',
    warnedAt: tick,
    startsAt,
    endsAt: startsAt + length,
    severity: SEVERITY_BY_ERA[Math.min(SEVERITY_BY_ERA.length - 1, era)],
    populationAtStart: population,
  };
  fate.current = crisis;
  return { type: 'warning', crisis };
}

/** Physics multipliers the current crisis applies. */
export interface CrisisFactors {
  temperature: number;
  plantRegen: number;
  fieldDry: number;
  fieldGrowth: number;
  thirst: number;
  /** Forced light level, or -1 for the normal day. */
  light: number;
}

export const NEUTRAL_FACTORS: CrisisFactors = {
  temperature: 0,
  plantRegen: 1,
  fieldDry: 1,
  fieldGrowth: 1,
  thirst: 1,
  light: -1,
};

export function crisisFactors(fate: FateState, tick: number): CrisisFactors {
  const crisis = fate.current;
  if (!crisis || crisis.phase !== 'active') return NEUTRAL_FACTORS;
  const s = crisis.severity;
  // Ease in and out over a quarter of a day so the world does not snap.
  const ramp = Math.min(1, (tick - crisis.startsAt) / (TICKS_PER_DAY / 4), (crisis.endsAt - tick) / (TICKS_PER_DAY / 4));
  const k = Math.max(0, ramp);
  switch (crisis.kind) {
    case 'drought':
      return {
        ...NEUTRAL_FACTORS,
        plantRegen: 1 - 0.75 * k * Math.min(1, s),
        fieldDry: 1 + 2.5 * k * s,
        fieldGrowth: 1 - 0.5 * k,
        thirst: 1 + 0.35 * k * s,
      };
    case 'harshWinter':
      return { ...NEUTRAL_FACTORS, temperature: -8 * k * s, plantRegen: 1 - 0.5 * k };
    case 'eclipse':
      return { ...NEUTRAL_FACTORS, light: 0.04 + 0.96 * (1 - k) * 0.5 };
    case 'fire':
      return { ...NEUTRAL_FACTORS, fieldDry: 1 + k };
    default:
      return NEUTRAL_FACTORS;
  }
}

export function ticksPerDay(): number {
  return TICKS_PER_DAY;
}
