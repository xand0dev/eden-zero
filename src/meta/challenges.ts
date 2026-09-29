import type { GameView, WorldStats } from '../shared/types';
import { LAWS } from '../simulation/game/laws';
import { BIOMES } from '../simulation/game/biomes';

/**
 * Challenges and the daily world.
 *
 * A challenge is a fixed seed, island and charter with one goal and a deadline
 * in years. Because the simulation is deterministic, everyone who plays a
 * challenge starts from the same world; what differs is what they notice and
 * when they choose to act. Medals are for how quickly and how lightly the goal
 * was reached.
 */

export type GoalKind = 'population' | 'era' | 'generation' | 'survive' | 'atlas' | 'store' | 'huts' | 'crises';

export interface Goal {
  kind: GoalKind;
  target: number;
}

export interface Challenge {
  id: string;
  name: string;
  brief: string;
  seed: string;
  biome: string;
  charter: string[];
  founders?: number;
  predators?: number;
  goal: Goal;
  /** Deadline in years. Gold if met by `gold`, silver by `silver`, bronze by the deadline. */
  deadline: number;
  gold: number;
  silver: number;
  /** Gold also requires no more than this many interventions, if set. */
  maxInterventionsForGold?: number;
}

export const GOAL_TEXT: Record<GoalKind, (n: number) => string> = {
  population: (n) => `${n} people alive`,
  era: (n) => `reach era ${['I', 'II', 'III', 'IV', 'V'][n] ?? n}`,
  generation: (n) => `the ${n}th generation`,
  survive: (n) => `still alive in year ${n + 1}`,
  atlas: (n) => `${n} atlas entries seen in this world`,
  store: (n) => `${n} food in store`,
  huts: (n) => `${n} dwellings`,
  crises: (n) => `come through ${n} crises`,
};

export const CHALLENGES: Challenge[] = [
  { id: 'c01', name: 'The last two', brief: 'Two founders and hungry predators. Can two become twenty?', seed: 'last-two', biome: 'valley', charter: [], founders: 2, predators: 4, goal: { kind: 'population', target: 20 }, deadline: 8, gold: 4, silver: 6 },
  { id: 'c02', name: 'Thirst', brief: 'A dry steppe under a dry law. Find a way to a village.', seed: 'thirst', biome: 'steppe', charter: ['dry-world'], goal: { kind: 'era', target: 2 }, deadline: 10, gold: 5, silver: 7 },
  { id: 'c03', name: 'Blank slate', brief: 'Born without reflexes. Will anyone learn to build a hut?', seed: 'blank', biome: 'valley', charter: ['tabula-rasa'], founders: 16, goal: { kind: 'huts', target: 1 }, deadline: 6, gold: 2, silver: 4 },
  { id: 'c04', name: 'Silence', brief: 'You may not intervene. Watch six generations happen.', seed: 'silence', biome: 'valley', charter: ['only-observer'], goal: { kind: 'generation', target: 6 }, deadline: 14, gold: 8, silver: 11 },
  { id: 'c05', name: 'Pavlov', brief: 'Shape a brain with reward pulses until the atlas notices.', seed: 'pavlov', biome: 'valley', charter: ['fast-learning'], goal: { kind: 'atlas', target: 18 }, deadline: 6, gold: 3, silver: 4 },
  { id: 'c06', name: 'Long winter', brief: 'A cold island with harsh seasons. Put food by.', seed: 'long-winter', biome: 'taiga', charter: ['harsh-seasons'], goal: { kind: 'store', target: 60 }, deadline: 10, gold: 5, silver: 7 },
  { id: 'c07', name: 'Islands', brief: 'An archipelago with little timber. Build ten roofs.', seed: 'islands', biome: 'archipelago', charter: [], goal: { kind: 'huts', target: 10 }, deadline: 8, gold: 4, silver: 6 },
  { id: 'c08', name: 'Salt', brief: 'The sea is salt. Survive five years.', seed: 'salt', biome: 'salt-coast', charter: [], goal: { kind: 'survive', target: 5 }, deadline: 6, gold: 6, silver: 6, maxInterventionsForGold: 10 },
  { id: 'c09', name: 'Storm season', brief: 'Fate strikes often. Come through three crises.', seed: 'storms', biome: 'valley', charter: ['stormy'], goal: { kind: 'crises', target: 3 }, deadline: 12, gold: 7, silver: 9 },
  { id: 'c10', name: 'Short lives', brief: 'Every life is short. Reach the tenth generation.', seed: 'mayfly', biome: 'valley', charter: ['short-lives'], goal: { kind: 'generation', target: 10 }, deadline: 14, gold: 8, silver: 11 },
  { id: 'c11', name: 'The pack', brief: 'Predator island. Fifty people.', seed: 'pack', biome: 'valley', charter: ['predator-island'], goal: { kind: 'population', target: 50 }, deadline: 12, gold: 6, silver: 9 },
  { id: 'c12', name: 'Four founders', brief: 'Four people, one valley. A village.', seed: 'four', biome: 'valley', charter: ['few-founders'], goal: { kind: 'era', target: 2 }, deadline: 12, gold: 6, silver: 9 },
  { id: 'c13', name: 'No pain', brief: 'Pain teaches nothing here. Reach a camp.', seed: 'numb', biome: 'valley', charter: ['no-pain'], goal: { kind: 'era', target: 1 }, deadline: 6, gold: 3, silver: 4 },
  { id: 'c14', name: 'Anxious', brief: 'Every bad outcome teaches twice. Thirty people.', seed: 'anxious', biome: 'valley', charter: ['anxious'], goal: { kind: 'population', target: 30 }, deadline: 8, gold: 4, silver: 6 },
  { id: 'c15', name: 'Optimists', brief: 'Bad outcomes barely teach. Survive six years.', seed: 'glad', biome: 'valley', charter: ['optimists'], goal: { kind: 'survive', target: 6 }, deadline: 7, gold: 7, silver: 7, maxInterventionsForGold: 5 },
  { id: 'c16', name: 'Meagre', brief: 'Poor soil and slow forests. A granary with food in it.', seed: 'meagre', biome: 'valley', charter: ['meagre-earth', 'sparse-timber'], goal: { kind: 'store', target: 30 }, deadline: 10, gold: 5, silver: 7 },
  { id: 'c17', name: 'Long night', brief: 'Night takes most of the day. A village.', seed: 'night', biome: 'valley', charter: ['long-night'], goal: { kind: 'era', target: 2 }, deadline: 12, gold: 6, silver: 9 },
  { id: 'c18', name: 'Noisy', brief: 'Every sense is noisy. Forty people.', seed: 'static', biome: 'valley', charter: ['noisy-senses'], goal: { kind: 'population', target: 40 }, deadline: 10, gold: 5, silver: 7 },
  { id: 'c19', name: 'Faint water', brief: 'Water is hard to sense on a dry plain. Survive four years.', seed: 'faint', biome: 'steppe', charter: ['short-sight'], goal: { kind: 'survive', target: 4 }, deadline: 5, gold: 5, silver: 5, maxInterventionsForGold: 8 },
  { id: 'c20', name: 'Volcano', brief: 'Rich soil, fire season. A town.', seed: 'cone', biome: 'volcanic', charter: ['fire-season'], goal: { kind: 'era', target: 3 }, deadline: 16, gold: 9, silver: 12 },
  { id: 'c21', name: 'Blight', brief: 'Blight-prone crops. A hundred food in store.', seed: 'rot', biome: 'valley', charter: ['blight-prone'], goal: { kind: 'store', target: 100 }, deadline: 12, gold: 7, silver: 9 },
  { id: 'c22', name: 'Mutants', brief: 'Blind mutation. Reach the eighth generation.', seed: 'drift', biome: 'valley', charter: ['blind-mutation'], goal: { kind: 'generation', target: 8 }, deadline: 12, gold: 7, silver: 9 },
  { id: 'c23', name: 'Lamarck', brief: 'Children inherit what their parents learned. Twenty-five atlas entries.', seed: 'lamarck', biome: 'valley', charter: ['lamarck', 'fast-learning'], goal: { kind: 'atlas', target: 25 }, deadline: 12, gold: 7, silver: 9 },
  { id: 'c24', name: 'Frail', brief: 'Fragile bodies, many predators. Survive five years.', seed: 'frail', biome: 'taiga', charter: ['fragile'], goal: { kind: 'survive', target: 5 }, deadline: 6, gold: 6, silver: 6, maxInterventionsForGold: 12 },
  { id: 'c25', name: 'One child', brief: 'One child a year. Sixty people.', seed: 'onechild', biome: 'valley', charter: ['one-child'], goal: { kind: 'population', target: 60 }, deadline: 16, gold: 10, silver: 13 },
  { id: 'c26', name: 'Twins', brief: 'Twins are common. A hundred people.', seed: 'twins', biome: 'valley', charter: ['twins'], goal: { kind: 'population', target: 100 }, deadline: 16, gold: 9, silver: 12 },
  { id: 'c27', name: 'Silent god', brief: 'Favour comes slowly. A town.', seed: 'quiet', biome: 'valley', charter: ['silent-god'], goal: { kind: 'era', target: 3 }, deadline: 18, gold: 10, silver: 14 },
  { id: 'c28', name: 'Cold', brief: 'A cold world. Survive three harsh winters’ worth of years.', seed: 'frost', biome: 'taiga', charter: ['cold-world'], goal: { kind: 'survive', target: 8 }, deadline: 9, gold: 9, silver: 9, maxInterventionsForGold: 15 },
  { id: 'c29', name: 'Sixteen', brief: 'Sixteen founders, rich earth. A city, quickly.', seed: 'sixteen', biome: 'valley', charter: ['big-tribe', 'rich-earth'], goal: { kind: 'era', target: 4 }, deadline: 20, gold: 12, silver: 16 },
  { id: 'c30', name: 'Everything', brief: 'Stormy fate, short lives, weak instincts. Come through five crises.', seed: 'everything', biome: 'valley', charter: ['stormy', 'short-lives', 'weak-instincts'], goal: { kind: 'crises', target: 5 }, deadline: 20, gold: 12, silver: 16 },
];

export function goalProgress(goal: Goal, game: GameView, stats: WorldStats): number {
  switch (goal.kind) {
    case 'population':
      return stats.population;
    case 'era':
      return game.era;
    case 'generation':
      return stats.oldestGeneration;
    case 'survive':
      return stats.population > 0 ? game.year - 1 : 0;
    case 'atlas':
      return game.discovered.length;
    case 'store':
      return Math.floor(game.storedFood);
    case 'huts':
      return stats.huts;
    case 'crises':
      return game.crisesSurvived;
    default:
      return 0;
  }
}

export type Medal = 'gold' | 'silver' | 'bronze';

/** The medal earned right now, or null if the goal is not met (or the deadline passed). */
export function medalFor(challenge: Challenge, game: GameView, stats: WorldStats): Medal | null {
  if (goalProgress(challenge.goal, game, stats) < challenge.goal.target) return null;
  const years = game.year - 1 + (game.day % 8) / 8;
  if (years > challenge.deadline) return null;
  const lightTouch =
    challenge.maxInterventionsForGold === undefined || game.favour.interventions <= challenge.maxInterventionsForGold;
  if (years <= challenge.gold && lightTouch) return 'gold';
  if (years <= challenge.silver) return 'silver';
  return 'bronze';
}

export function challengeFailed(challenge: Challenge, game: GameView, stats: WorldStats): boolean {
  return stats.population === 0 || game.year - 1 >= challenge.deadline;
}

export const MEDAL_RANK: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3 };

// --- the daily world -----------------------------------------------------------------

export interface Daily {
  date: string;
  seed: string;
  biome: string;
  charter: string[];
  /** The score is the population alive when this year begins. */
  endYear: number;
}

function hash(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Today's world: the same for everyone, from the date alone. */
export function dailyFor(date: Date): Daily {
  const day = date.toISOString().slice(0, 10);
  const h = hash(`eden-daily-${day}`);
  const biome = BIOMES[h % BIOMES.length].id;
  const pool = LAWS.filter((law) => law.category !== 'observer');
  const first = pool[(h >>> 8) % pool.length];
  let second = pool[(h >>> 16) % pool.length];
  if (second.id === first.id || first.excludes?.includes(second.id)) second = pool[((h >>> 16) + 7) % pool.length];
  const charter = [first.id, second.id].filter((id, i, all) => all.indexOf(id) === i);
  return { date: day, seed: `daily-${day}`, biome, charter, endYear: 5 };
}

export function dailyScore(game: GameView, stats: WorldStats): number {
  // People alive, weighted by what they have built of a civilisation.
  return stats.population * 10 + game.era * 50 + game.discovered.length * 5 + game.crisesSurvived * 25;
}
