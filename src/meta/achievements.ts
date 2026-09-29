import type { GameView, StructureView, WorldEvent, WorldStats } from '../shared/types';
import type { Profile } from './profile';
import { LAWS } from '../simulation/game/laws';
import { BIOMES } from '../simulation/game/biomes';
import { ATLAS, RARITY_ORDER, SECTION_NAMES, type AtlasSection } from '../simulation/game/atlas';
import { CRISES, CRISIS_ORDER } from '../simulation/game/crises';
import { ERA_NAMES, ERA_NUMERALS } from '../simulation/game/eras';

/**
 * The codex — about a hundred and fifty achievements.
 *
 * Most are generated from the game's own tables: reach each era on each island,
 * come through each crisis, live under each law, fill each chapter of the atlas.
 * A handful are hidden. Every one is checked against the running world's state
 * or the profile; none is granted for merely clicking.
 */

export type AchievementCategory = 'eras' | 'fate' | 'atlas' | 'laws' | 'world' | 'observer' | 'lab' | 'play' | 'hidden';

export const CATEGORY_NAMES: Record<AchievementCategory, string> = {
  eras: 'Eras and islands',
  fate: 'Fate',
  atlas: 'Atlas',
  laws: 'Laws',
  world: 'Worlds',
  observer: 'The observer',
  lab: 'Neuro-lab',
  play: 'Challenges and dailies',
  hidden: 'Hidden',
};

export interface AchievementContext {
  game: GameView;
  stats: WorldStats;
  structures: StructureView[];
  events: WorldEvent[];
  profile: Profile;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  hidden?: boolean;
  /** Evaluated against a running world; absent for profile-only achievements. */
  check(ctx: AchievementContext): boolean;
}

const finished = (ctx: AchievementContext, kind: number): number =>
  ctx.structures.filter((s) => s.complete && (s.kind ?? 0) === kind).length;
const survivedKind = (ctx: AchievementContext, kind: string): number =>
  ctx.game.crisisHistory.filter((c) => c.kind === kind && c.survived).length;
const atlasSeen = (ctx: AchievementContext): Set<string> => new Set(Object.keys(ctx.profile.atlas));

const list: Achievement[] = [];
const add = (a: Achievement): void => {
  list.push(a);
};

// --- eras on every island (24) ----------------------------------------------
for (const biome of BIOMES) {
  for (let era = 1; era <= 4; era++) {
    add({
      id: `era-${era + 1}-${biome.id}`,
      name: `${ERA_NAMES[era]} in the ${biome.name.toLowerCase()}`,
      description: `Reach era ${ERA_NUMERALS[era]} (${ERA_NAMES[era].toLowerCase()}) on the ${biome.name.toLowerCase()}.`,
      category: 'eras',
      check: (c) => c.game.biome === biome.id && c.game.era >= era,
    });
  }
}
// --- eras anywhere, used as unlock keys (4) ----------------------------------
for (let era = 2; era <= 4; era++) {
  add({
    id: `reach-era-${era + 1}`,
    name: `Era ${ERA_NUMERALS[era]}`,
    description: `Reach era ${ERA_NUMERALS[era]} — a ${ERA_NAMES[era].toLowerCase()} — in any world.`,
    category: 'eras',
    check: (c) => c.game.era >= era,
  });
}
add({
  id: 'era-5-hard-charter',
  name: 'Against the odds',
  description: 'Reach era V under a charter of three or more laws.',
  category: 'eras',
  check: (c) => c.game.era >= 4 && c.game.charter.length >= 3,
});
add({
  id: 'era-3-no-help',
  name: 'Left alone',
  description: 'Reach era III having intervened fewer than five times.',
  category: 'eras',
  check: (c) => c.game.era >= 2 && c.game.favour.interventions < 5,
});
add({
  id: 'era-2-year-1',
  name: 'Quick start',
  description: 'Reach era II within the first year.',
  category: 'eras',
  check: (c) => c.game.era >= 1 && c.game.year <= 1,
});

// --- fate (8 kinds + counts) ---------------------------------------------------
const UNLOCK_KEYS: Record<string, string> = {
  harshWinter: 'survive-harsh-winter',
  drought: 'survive-drought',
  predatorMigration: 'survive-predator-migration',
};
for (const kind of CRISIS_ORDER) {
  add({
    id: UNLOCK_KEYS[kind] ?? `survive-${kind}`,
    name: `Through the ${CRISES[kind].name.toLowerCase()}`,
    description: `Come through a ${CRISES[kind].name.toLowerCase()} with the settlement alive.`,
    category: 'fate',
    check: (c) => survivedKind(c, kind) >= 1,
  });
}
for (const [count, name] of [
  [3, 'Weathered'],
  [5, 'Hardened'],
  [10, 'Unbroken'],
] as const) {
  add({
    id: `survive-${count}-crises`,
    name,
    description: `Come through ${count} crises in one world.`,
    category: 'fate',
    check: (c) => c.game.crisesSurvived >= count,
  });
}
add({
  id: 'survive-two-droughts',
  name: 'Dust twice',
  description: 'Come through two droughts in one world.',
  category: 'fate',
  check: (c) => survivedKind(c, 'drought') >= 2,
});
add({
  id: 'first-winter',
  name: 'First winter',
  description: 'See a world through its first winter.',
  category: 'fate',
  check: (c) => c.game.year >= 2 && c.stats.population > 0,
});

// --- atlas (19) ------------------------------------------------------------------
for (const count of [5, 10, 15, 20, 25, 30, 35, 40, 50, 60]) {
  add({
    id: `atlas-${count}`,
    name: `Atlas: ${count}`,
    description: `Discover ${count} entries of the atlas of behaviours.`,
    category: 'atlas',
    check: (c) => atlasSeen(c).size >= count,
  });
}
add({
  id: 'atlas-all',
  name: 'The whole atlas',
  description: 'Discover every entry of the atlas.',
  category: 'atlas',
  check: (c) => ATLAS.every((e) => atlasSeen(c).has(e.id)),
});
for (const rarity of RARITY_ORDER) {
  add({
    id: `atlas-${rarity}`,
    name: `Every ${rarity}`,
    description: `Discover every ${rarity} entry of the atlas.`,
    category: 'atlas',
    check: (c) => ATLAS.filter((e) => e.rarity === rarity).every((e) => atlasSeen(c).has(e.id)),
  });
}
for (const section of Object.keys(SECTION_NAMES) as AtlasSection[]) {
  add({
    id: `atlas-section-${section}`,
    name: SECTION_NAMES[section],
    description: `Complete the atlas chapter "${SECTION_NAMES[section]}".`,
    category: 'atlas',
    check: (c) => ATLAS.filter((e) => e.section === section).every((e) => atlasSeen(c).has(e.id)),
  });
}

// --- laws (one per law) -------------------------------------------------------------
for (const law of LAWS) {
  add({
    id: `law-${law.id}`,
    name: `Under ${law.name.toLowerCase()}`,
    description: `Reach era III in a world whose charter includes “${law.name}”.`,
    category: 'laws',
    check: (c) => c.game.charter.includes(law.id) && c.game.era >= 2,
  });
}

// --- worlds -------------------------------------------------------------------------
for (const [count, name] of [
  [20, 'A village'],
  [50, 'A crowd'],
  [100, 'A people'],
  [150, 'A nation'],
] as const) {
  add({
    id: `population-${count}`,
    name,
    description: `Have ${count} people alive at once.`,
    category: 'world',
    check: (c) => c.stats.population >= count,
  });
}
for (const generation of [5, 10, 15, 20]) {
  add({
    id: `generation-${generation}`,
    name: `Generation ${generation}`,
    description: `See the ${generation}th generation born.`,
    category: 'world',
    check: (c) => c.stats.oldestGeneration >= generation,
  });
}
const STRUCTURE_ACHIEVEMENTS: Array<[string, string, number, number]> = [
  ['granary', 'Something put by', 1, 1],
  ['well', 'Deep water', 2, 1],
  ['workshop', 'Tools', 3, 1],
  ['stone-house', 'Stone walls', 4, 1],
  ['palisade-10', 'The wall', 5, 10],
  ['shrine', 'A place for the dead', 6, 1],
];
for (const [id, name, kind, count] of STRUCTURE_ACHIEVEMENTS) {
  add({
    id: `built-${id}`,
    name,
    description: count > 1 ? `Have ${count} finished structures of this kind.` : 'See one built, by nobody’s order.',
    category: 'world',
    check: (c) => finished(c, kind) >= count,
  });
}
add({
  id: 'granary-100',
  name: 'Plenty',
  description: 'Hold a hundred units of food in store at once.',
  category: 'world',
  check: (c) => c.game.storedFood >= 100,
});
add({
  id: 'trails-300',
  name: 'Desire lines',
  description: 'See three hundred tiles worn into trails.',
  category: 'world',
  check: (c) => c.game.trails >= 300,
});
add({
  id: 'huts-20',
  name: 'Twenty roofs',
  description: 'Twenty finished dwellings.',
  category: 'world',
  check: (c) => c.stats.huts >= 20,
});

// --- the observer -----------------------------------------------------------------
add({
  id: 'spend-1000',
  name: 'Patron',
  description: 'Spend a thousand favour over all your worlds.',
  category: 'observer',
  check: (c) => c.profile.stats.favourSpent >= 1000,
});
add({
  id: 'every-tool',
  name: 'Every tool',
  description: 'Use every observer tool at least once.',
  category: 'observer',
  check: (c) =>
    ['spawnHuman', 'spawnPredator', 'spawnFood', 'lightning', 'moveHuman', 'kill', 'rain', 'bless', 'rewardPulse', 'painPulse'].every(
      (tool) => c.profile.toolsUsed.includes(tool),
    ),
});
add({
  id: 'rain-on-fire',
  name: 'Rainmaker',
  description: 'Call rain while a wildfire burns.',
  category: 'observer',
  check: (c) => c.game.crisis?.kind === 'fire' && c.game.crisis.phase === 'active' && c.game.rains.length > 0,
});
add({
  id: 'rain-in-drought',
  name: 'Breaking the drought',
  description: 'Call rain during a drought.',
  category: 'observer',
  check: (c) => c.game.crisis?.kind === 'drought' && c.game.crisis.phase === 'active' && c.game.rains.length > 0,
});
add({
  id: 'full-favour',
  name: 'Held in reserve',
  description: 'Hold the most favour this era allows.',
  category: 'observer',
  check: (c) => c.game.favour.enabled && c.game.favour.value >= c.game.favour.cap - 0.5,
});
add({
  id: 'worlds-10',
  name: 'Many worlds',
  description: 'Begin ten worlds.',
  category: 'observer',
  check: (c) => c.profile.stats.worlds >= 10,
});
add({
  id: 'years-100',
  name: 'A century watched',
  description: 'Observe a hundred years across all your worlds.',
  category: 'observer',
  check: (c) => c.profile.stats.yearsObserved >= 100,
});
add({
  id: 'named-behaviour',
  name: 'Naturalist',
  description: 'Name a behaviour the atlas could not classify.',
  category: 'observer',
  check: (c) => c.profile.namedBehaviours.length >= 1,
});

// --- lab ---------------------------------------------------------------------------
add({
  id: 'lab-first-pulse',
  name: 'Stimulus',
  description: 'Send a reward pulse into a living brain.',
  category: 'lab',
  check: (c) => c.profile.stats.pulses >= 1,
});
add({
  id: 'lab-100-pulses',
  name: 'Trainer',
  description: 'Send a hundred pulses.',
  category: 'lab',
  check: (c) => c.profile.stats.pulses >= 100,
});
add({
  id: 'lab-conditioned',
  name: 'Conditioned',
  description: 'See the atlas record a person shaped by your pulses.',
  category: 'lab',
  check: (c) => atlasSeen(c).has('conditioned'),
});
add({
  id: 'lab-relearned',
  name: 'Against instinct',
  description: 'See an innate reflex rewritten by a life.',
  category: 'lab',
  check: (c) => atlasSeen(c).has('relearned'),
});
add({
  id: 'lab-fearless',
  name: 'Unafraid',
  description: 'See someone learn not to flee.',
  category: 'lab',
  check: (c) => atlasSeen(c).has('fearless'),
});

// --- challenges and dailies (profile) -------------------------------------------------
for (const [count, name] of [
  [1, 'First challenge'],
  [5, 'Five challenges'],
  [10, 'Ten challenges'],
  [20, 'Twenty challenges'],
  [30, 'Every challenge'],
] as const) {
  add({
    id: `challenges-${count}`,
    name,
    description: `Earn a medal in ${count} challenge${count > 1 ? 's' : ''}.`,
    category: 'play',
    check: (c) => Object.keys(c.profile.medals).length >= count,
  });
}
add({
  id: 'challenges-gold-10',
  name: 'Ten golds',
  description: 'Earn gold in ten challenges.',
  category: 'play',
  check: (c) => Object.values(c.profile.medals).filter((m) => m === 'gold').length >= 10,
});
for (const [count, name] of [
  [1, 'Daily'],
  [7, 'A week of dailies'],
  [30, 'A month of dailies'],
] as const) {
  add({
    id: `dailies-${count}`,
    name,
    description: `Finish ${count} daily world${count > 1 ? 's' : ''}.`,
    category: 'play',
    check: (c) => Object.keys(c.profile.daily).length >= count,
  });
}
add({
  id: 'vault-first',
  name: 'Keeper',
  description: 'Keep a genome in the vault.',
  category: 'play',
  check: (c) => c.profile.vault.length >= 1,
});
add({
  id: 'vault-full',
  name: 'A full vault',
  description: 'Fill the genome vault.',
  category: 'play',
  check: (c) => c.profile.vault.length >= 12,
});
add({
  id: 'campaign-finished',
  name: 'A history written',
  description: 'Finish a campaign.',
  category: 'play',
  check: (c) => c.profile.stats.campaignsFinished >= 1,
});
add({
  id: 'tutorial',
  name: 'First dawn',
  description: 'Complete the first dawn.',
  category: 'play',
  check: (c) => c.profile.tutorialDone,
});

// --- hidden ----------------------------------------------------------------------------
add({
  id: 'dont-panic',
  name: 'Don’t Panic',
  description: 'Exactly forty-two people alive.',
  category: 'hidden',
  hidden: true,
  check: (c) => c.stats.population === 42,
});
add({
  id: 'centenarian',
  name: 'Centenarian',
  description: 'Someone lives to a hundred.',
  category: 'hidden',
  hidden: true,
  check: (c) => (c.game.oldest ?? 0) >= 100,
});
add({
  id: 'twins',
  name: 'Two at once',
  description: 'Twins are born.',
  category: 'hidden',
  hidden: true,
  check: (c) => c.events.some((e) => e.kind === 'birth' && e.text.includes('twins')),
});
add({
  id: 'twenty-years',
  name: 'Twenty years',
  description: 'A world lives through twenty years.',
  category: 'hidden',
  hidden: true,
  check: (c) => c.game.year >= 21 && c.stats.population > 0,
});
add({
  id: 'last-two',
  name: 'The last two',
  description: 'A world down to two people recovers to twenty.',
  category: 'hidden',
  hidden: true,
  check: (c) => {
    const history = c.game.populationHistory;
    const low = history.findIndex((p) => p > 0 && p <= 2);
    return low >= 0 && history.slice(low).some((p) => p >= 20);
  },
});

export const ACHIEVEMENTS: readonly Achievement[] = list;

const BY_ID = new Map(list.map((a) => [a.id, a]));
export function achievementById(id: string): Achievement | undefined {
  return BY_ID.get(id);
}

/** Achievements newly earned against this context. */
export function newlyEarned(ctx: AchievementContext): Achievement[] {
  const out: Achievement[] = [];
  for (const achievement of list) {
    if (ctx.profile.achievements[achievement.id]) continue;
    try {
      if (achievement.check(ctx)) out.push(achievement);
    } catch {
      // A check that cannot read its data simply is not earned yet.
    }
  }
  return out;
}

/** Whether an unlock key (an achievement id) is satisfied. */
export function unlocked(profile: Profile, key: string | undefined): boolean {
  return !key || Boolean(profile.achievements[key]);
}
