import { SIM_HZ } from '../../shared/constants';

/**
 * Favour — what an observer can afford to do.
 *
 * Omnipotence is boring: when every tool is free, nothing is at stake and there
 * is nothing to do after the first few minutes. Favour makes interventions a
 * budget. It trickles in slowly on its own, but mostly it grows when the world
 * does — births, new generations, crises weathered, behaviours discovered — so
 * the way to more influence is a thriving world, not a waiting one.
 *
 * Sandbox worlds switch it off: everything is free and nothing is scored.
 */

export interface FavourCost {
  cost: number;
  /** Seconds before the same tool can be used again. */
  cooldown: number;
}

export const FAVOUR_COSTS: Record<string, FavourCost> = {
  rain: { cost: 20, cooldown: 60 },
  spawnFood: { cost: 12, cooldown: 0 },
  moveHuman: { cost: 3, cooldown: 0 },
  rewardPulse: { cost: 8, cooldown: 5 },
  painPulse: { cost: 8, cooldown: 5 },
  bless: { cost: 25, cooldown: 120 },
  editGenome: { cost: 25, cooldown: 0 },
  lightning: { cost: 35, cooldown: 0 },
  spawnPredator: { cost: 45, cooldown: 0 },
  spawnHuman: { cost: 40, cooldown: 0 },
  temperature: { cost: 20, cooldown: 30 },
  timeOfDay: { cost: 15, cooldown: 30 },
  kill: { cost: 30, cooldown: 0 },
};

/** Favour gained per simulated second, before the charter's multiplier. */
export const FAVOUR_BASE_RATE = 0.4;
export const FAVOUR_START = 120;
export const FAVOUR_CAP_BASE = 300;
export const FAVOUR_CAP_PER_ERA = 50;

/** Favour granted by the world for things that happen in it. */
export const FAVOUR_REWARDS = {
  birth: 6,
  generation: 40,
  discovery: 25,
  elderDeath: 10,
  crisisBase: 60,
  crisisPerSeverity: 60,
  era: 50,
};

export interface FavourState {
  enabled: boolean;
  value: number;
  /** Tick at which each tool is ready again. */
  readyAt: Record<string, number>;
  /** People created by the observer so far; each one costs half again as much. */
  spawned: number;
  /** Total favour spent, for the campaign summary. */
  spent: number;
  /** Total interventions, for challenges that count them. */
  interventions: number;
}

export function createFavour(enabled: boolean): FavourState {
  return { enabled, value: FAVOUR_START, readyAt: {}, spawned: 0, spent: 0, interventions: 0 };
}

export function favourCap(era: number): number {
  return FAVOUR_CAP_BASE + FAVOUR_CAP_PER_ERA * era;
}

/** What a tool costs right now, including escalation and crisis surcharges. */
export function priceOf(state: FavourState, kind: string, inCrisis: boolean): number {
  const base = FAVOUR_COSTS[kind]?.cost ?? 0;
  if (kind === 'spawnHuman') return Math.round(base * Math.pow(1.5, state.spawned));
  if (kind === 'spawnFood' && inCrisis) return base * 2;
  return base;
}

export type SpendResult = { ok: true; cost: number } | { ok: false; reason: string };

/** Try to pay for a tool. Mutates the state only on success. */
export function spend(state: FavourState, kind: string, tick: number, inCrisis: boolean): SpendResult {
  if (!state.enabled) {
    state.interventions += 1;
    return { ok: true, cost: 0 };
  }
  const ready = state.readyAt[kind] ?? 0;
  if (tick < ready) {
    const seconds = Math.ceil((ready - tick) / SIM_HZ);
    return { ok: false, reason: `Not ready — ${seconds}s until it can be used again.` };
  }
  const cost = priceOf(state, kind, inCrisis);
  if (state.value < cost) {
    return { ok: false, reason: `Needs ${cost} favour; you have ${Math.floor(state.value)}.` };
  }
  state.value -= cost;
  state.spent += cost;
  state.interventions += 1;
  const cooldown = FAVOUR_COSTS[kind]?.cooldown ?? 0;
  if (cooldown > 0) state.readyAt[kind] = tick + Math.round(cooldown * SIM_HZ);
  if (kind === 'spawnHuman') state.spawned += 1;
  return { ok: true, cost };
}

export function grant(state: FavourState, amount: number, era: number): void {
  if (!state.enabled) return;
  state.value = Math.min(favourCap(era), state.value + amount);
}
