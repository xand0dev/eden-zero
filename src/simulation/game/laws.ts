/**
 * Laws of the world — the charter an observer writes before genesis.
 *
 * A law changes physics, biology, the brain, the ecology or the observer's own
 * powers. It never changes what anyone decides: there is no law that says "build
 * more", only laws that make the world drier, lives shorter or learning faster,
 * and then the brains cope or do not.
 *
 * Every law resolves to multipliers on `WorldRules`. The simulation reads those
 * numbers where the constants are used, so a law is exactly as honest as the
 * physics it scales.
 */

export interface WorldRules {
  // physics -----------------------------------------------------------
  temperatureOffset: number;
  seasonAmplitude: number;
  eternalSpring: boolean;
  /** Pushes the light curve down: 0 is the normal day, 0.3 makes night ~60% of it. */
  nightBias: number;
  /** Field drying and plant water stress. */
  dryness: number;
  // ecology -----------------------------------------------------------
  plantRegen: number;
  soilRecovery: number;
  timberRegen: number;
  predatorsAtGenesis: number;
  predatorMigration: number;
  // biology -----------------------------------------------------------
  hungerRate: number;
  thirstRate: number;
  lifespan: number;
  mutationRate: number;
  healthRegen: number;
  damageTaken: number;
  twinChance: number;
  /** Minimum years between a mother's children; 0 disables the limit. */
  birthSpacingYears: number;
  // brain -------------------------------------------------------------
  /** Scale on the innate reflex synapses at birth. 1 is normal, ~0 is a blank slate. */
  innatePriors: number;
  plasticity: number;
  /** Fraction of a parent's learned weight change passed to a child. */
  lamarck: number;
  /** Weight of pain in the valence signal. */
  painValence: number;
  /** Scale on negative valence overall. */
  negativeValence: number;
  /** Standard deviation of noise added to every sensory channel. */
  sensorNoise: number;
  /** Range at which water is sensed. */
  waterSense: number;
  // fate --------------------------------------------------------------
  crisisFrequency: number;
  crisisWeights: Partial<Record<string, number>>;
  // observer ----------------------------------------------------------
  favourRate: number;
  interventions: boolean;
  spawnAllowed: boolean;
  foundersOverride: number;
}

export const DEFAULT_RULES: WorldRules = {
  temperatureOffset: 0,
  seasonAmplitude: 1,
  eternalSpring: false,
  nightBias: 0,
  dryness: 1,
  plantRegen: 1,
  soilRecovery: 1,
  timberRegen: 1,
  predatorsAtGenesis: 1,
  predatorMigration: 1,
  hungerRate: 1,
  thirstRate: 1,
  lifespan: 1,
  mutationRate: 1,
  healthRegen: 1,
  damageTaken: 1,
  twinChance: 0,
  birthSpacingYears: 0,
  innatePriors: 1,
  plasticity: 1,
  lamarck: 0,
  painValence: 1,
  negativeValence: 1,
  sensorNoise: 0,
  waterSense: 1,
  crisisFrequency: 1,
  crisisWeights: {},
  favourRate: 1,
  interventions: true,
  spawnAllowed: true,
  foundersOverride: 0,
};

export type LawCategory = 'physics' | 'biology' | 'brain' | 'ecology' | 'observer';

export interface LawDefinition {
  id: string;
  name: string;
  category: LawCategory;
  description: string;
  /** Legacy multiplier: harder charters are worth more at the end of a campaign. */
  multiplier: number;
  /** Laws that cannot share a charter with this one. */
  excludes?: string[];
  /** How the law is unlocked; absent means available from the start. */
  unlock?: string;
  apply(rules: WorldRules): void;
}

export const LAWS: LawDefinition[] = [
  // --- physics -----------------------------------------------------------
  {
    id: 'dry-world',
    name: 'Dry world',
    category: 'physics',
    description: 'Fields dry out half again as fast, wild plants regrow slower, and everyone gets thirsty sooner.',
    multiplier: 1.3,
    excludes: ['wet-world'],
    apply: (r) => {
      r.dryness *= 1.5;
      r.plantRegen *= 0.8;
      r.thirstRate *= 1.15;
    },
  },
  {
    id: 'wet-world',
    name: 'Wet world',
    category: 'physics',
    description: 'Rain is common: fields hold water, plants regrow faster. An easier start.',
    multiplier: 0.85,
    excludes: ['dry-world'],
    apply: (r) => {
      r.dryness *= 0.6;
      r.plantRegen *= 1.15;
    },
  },
  {
    id: 'long-night',
    name: 'Long night',
    category: 'physics',
    description: 'Night takes up about sixty percent of every day. Light-driven senses go dark for longer.',
    multiplier: 1.2,
    apply: (r) => {
      r.nightBias += 0.3;
    },
  },
  {
    id: 'eternal-spring',
    name: 'Eternal spring',
    category: 'physics',
    description: 'There is no winter. The year is spring, summer, autumn and spring again.',
    multiplier: 0.8,
    excludes: ['harsh-seasons'],
    apply: (r) => {
      r.eternalSpring = true;
    },
  },
  {
    id: 'harsh-seasons',
    name: 'Harsh seasons',
    category: 'physics',
    description: 'Summers hotter, winters colder, and the seasonal swing in food twice as deep.',
    multiplier: 1.35,
    excludes: ['eternal-spring'],
    unlock: 'survive-harsh-winter',
    apply: (r) => {
      r.seasonAmplitude *= 2;
    },
  },
  {
    id: 'cold-world',
    name: 'Cold world',
    category: 'physics',
    description: 'Four degrees colder everywhere, all year. Shelter matters from the first night.',
    multiplier: 1.25,
    excludes: ['warm-world'],
    apply: (r) => {
      r.temperatureOffset -= 4;
    },
  },
  {
    id: 'warm-world',
    name: 'Warm world',
    category: 'physics',
    description: 'Five degrees warmer. Winters are mild, summers are thirsty.',
    multiplier: 1.05,
    excludes: ['cold-world'],
    apply: (r) => {
      r.temperatureOffset += 5;
      r.thirstRate *= 1.08;
    },
  },
  {
    id: 'stormy',
    name: 'Stormy fate',
    category: 'physics',
    description: 'Crises come about sixty percent more often.',
    multiplier: 1.4,
    excludes: ['calm'],
    unlock: 'survive-3-crises',
    apply: (r) => {
      r.crisisFrequency *= 1.6;
    },
  },
  {
    id: 'calm',
    name: 'Calm fate',
    category: 'physics',
    description: 'Crises come half as often.',
    multiplier: 0.8,
    excludes: ['stormy'],
    apply: (r) => {
      r.crisisFrequency *= 0.5;
    },
  },
  // --- biology -----------------------------------------------------------
  {
    id: 'short-lives',
    name: 'Short lives',
    category: 'biology',
    description: 'Every lifespan is cut by forty percent. Fewer winters per life, less time to learn.',
    multiplier: 1.4,
    excludes: ['long-lives'],
    apply: (r) => {
      r.lifespan *= 0.6;
    },
  },
  {
    id: 'long-lives',
    name: 'Long lives',
    category: 'biology',
    description: 'Lifespans forty percent longer.',
    multiplier: 0.9,
    excludes: ['short-lives'],
    apply: (r) => {
      r.lifespan *= 1.4;
    },
  },
  {
    id: 'one-child',
    name: 'One child a year',
    category: 'biology',
    description: 'A mother cannot conceive again within a year of giving birth.',
    multiplier: 1.5,
    unlock: 'reach-era-3',
    apply: (r) => {
      r.birthSpacingYears = Math.max(r.birthSpacingYears, 1);
    },
  },
  {
    id: 'blind-mutation',
    name: 'Blind mutation',
    category: 'biology',
    description: 'Mutations three times as frequent. Lineages drift fast, for better and worse.',
    multiplier: 1.2,
    excludes: ['stable-genes'],
    apply: (r) => {
      r.mutationRate *= 3;
    },
  },
  {
    id: 'stable-genes',
    name: 'Stable genes',
    category: 'biology',
    description: 'Mutations a third as frequent. Children resemble their parents closely.',
    multiplier: 1.0,
    excludes: ['blind-mutation'],
    apply: (r) => {
      r.mutationRate *= 0.3;
    },
  },
  {
    id: 'fast-metabolism',
    name: 'Fast metabolism',
    category: 'biology',
    description: 'Hunger and thirst build a quarter faster.',
    multiplier: 1.3,
    apply: (r) => {
      r.hungerRate *= 1.25;
      r.thirstRate *= 1.25;
    },
  },
  {
    id: 'hardy',
    name: 'Hardy bodies',
    category: 'biology',
    description: 'Wounds heal half again as fast.',
    multiplier: 0.9,
    excludes: ['fragile'],
    apply: (r) => {
      r.healthRegen *= 1.5;
    },
  },
  {
    id: 'fragile',
    name: 'Fragile bodies',
    category: 'biology',
    description: 'Every blow, burn and bite does forty percent more damage.',
    multiplier: 1.3,
    excludes: ['hardy'],
    apply: (r) => {
      r.damageTaken *= 1.4;
    },
  },
  {
    id: 'twins',
    name: 'Twins',
    category: 'biology',
    description: 'One birth in four brings twins.',
    multiplier: 0.9,
    apply: (r) => {
      r.twinChance = Math.max(r.twinChance, 0.25);
    },
  },
  // --- brain -------------------------------------------------------------
  {
    id: 'tabula-rasa',
    name: 'Tabula rasa',
    category: 'brain',
    description:
      'Born without reflexes: the innate synapses start at a tenth of their strength. Everything must be learned — if it can be.',
    multiplier: 3.0,
    unlock: 'reach-era-4',
    apply: (r) => {
      r.innatePriors *= 0.1;
    },
  },
  {
    id: 'weak-instincts',
    name: 'Weak instincts',
    category: 'brain',
    description: 'Innate reflexes at half strength. Learning has more to do.',
    multiplier: 1.5,
    apply: (r) => {
      r.innatePriors *= 0.5;
    },
  },
  {
    id: 'fast-learning',
    name: 'Fast learning',
    category: 'brain',
    description: 'Synapses change twice as fast. Habits form quickly, and so do bad ones.',
    multiplier: 0.95,
    excludes: ['slow-learning'],
    apply: (r) => {
      r.plasticity *= 2;
    },
  },
  {
    id: 'slow-learning',
    name: 'Slow learning',
    category: 'brain',
    description: 'Synapses change at forty percent of the normal rate. A life is mostly instinct.',
    multiplier: 1.2,
    excludes: ['fast-learning'],
    apply: (r) => {
      r.plasticity *= 0.4;
    },
  },
  {
    id: 'lamarck',
    name: 'Lamarck',
    category: 'brain',
    description:
      'A child inherits a tenth of what its parents learned. Biologically wrong on purpose: an experiment in what inheritance of learning would do.',
    multiplier: 1.0,
    unlock: 'lab-conditioned',
    apply: (r) => {
      r.lamarck = Math.max(r.lamarck, 0.1);
    },
  },
  {
    id: 'no-pain',
    name: 'No pain',
    category: 'brain',
    description: 'Pain no longer teaches: it is removed from the learning signal. The body still gets hurt.',
    multiplier: 1.6,
    apply: (r) => {
      r.painValence = 0;
    },
  },
  {
    id: 'optimists',
    name: 'Optimists',
    category: 'brain',
    description: 'Bad outcomes teach at a fifth of their normal strength.',
    multiplier: 1.3,
    excludes: ['anxious'],
    apply: (r) => {
      r.negativeValence *= 0.2;
    },
  },
  {
    id: 'anxious',
    name: 'Anxious minds',
    category: 'brain',
    description: 'Bad outcomes teach twice as hard.',
    multiplier: 1.2,
    excludes: ['optimists'],
    apply: (r) => {
      r.negativeValence *= 2;
    },
  },
  {
    id: 'noisy-senses',
    name: 'Noisy senses',
    category: 'brain',
    description: 'Every sense carries random noise. Signals have to be strong to be trusted.',
    multiplier: 1.3,
    apply: (r) => {
      r.sensorNoise = Math.max(r.sensorNoise, 0.12);
    },
  },
  {
    id: 'short-sight',
    name: 'Faint water',
    category: 'brain',
    description: 'Water is sensed from only two thirds as far away.',
    multiplier: 1.35,
    apply: (r) => {
      r.waterSense *= 0.66;
    },
  },
  // --- ecology -----------------------------------------------------------
  {
    id: 'predator-island',
    name: 'Predator island',
    category: 'ecology',
    description: 'Three times the predators at genesis, and migrations bring three times as many.',
    multiplier: 1.5,
    excludes: ['no-predators'],
    unlock: 'survive-predator-migration',
    apply: (r) => {
      r.predatorsAtGenesis *= 3;
      r.predatorMigration *= 3;
    },
  },
  {
    id: 'no-predators',
    name: 'No predators',
    category: 'ecology',
    description: 'Nothing hunts the people of this world.',
    multiplier: 0.8,
    excludes: ['predator-island'],
    apply: (r) => {
      r.predatorsAtGenesis = 0;
      r.predatorMigration = 0;
      r.crisisWeights.predatorMigration = 0;
    },
  },
  {
    id: 'meagre-earth',
    name: 'Meagre earth',
    category: 'ecology',
    description: 'Ground exhausted by grazing recovers at sixty percent of the normal rate.',
    multiplier: 1.4,
    excludes: ['rich-earth'],
    apply: (r) => {
      r.soilRecovery *= 0.6;
      r.plantRegen *= 0.85;
    },
  },
  {
    id: 'rich-earth',
    name: 'Rich earth',
    category: 'ecology',
    description: 'Plants regrow a third faster and ground recovers quickly.',
    multiplier: 0.85,
    excludes: ['meagre-earth'],
    apply: (r) => {
      r.plantRegen *= 1.3;
      r.soilRecovery *= 1.4;
    },
  },
  {
    id: 'sparse-timber',
    name: 'Slow forests',
    category: 'ecology',
    description: 'Felled trees regrow at forty percent of the normal rate.',
    multiplier: 1.2,
    apply: (r) => {
      r.timberRegen *= 0.4;
    },
  },
  {
    id: 'blight-prone',
    name: 'Blight-prone crops',
    category: 'ecology',
    description: 'Crop blight is three times as likely when fate strikes.',
    multiplier: 1.15,
    apply: (r) => {
      r.crisisWeights.blight = (r.crisisWeights.blight ?? 1) * 3;
    },
  },
  {
    id: 'fire-season',
    name: 'Fire season',
    category: 'ecology',
    description: 'Wildfire is three times as likely when fate strikes.',
    multiplier: 1.2,
    unlock: 'reach-era-4',
    apply: (r) => {
      r.crisisWeights.fire = (r.crisisWeights.fire ?? 1) * 3;
    },
  },
  // --- observer ----------------------------------------------------------
  {
    id: 'silent-god',
    name: 'Silent god',
    category: 'observer',
    description: 'Favour accumulates at thirty percent of the normal rate.',
    multiplier: 2.0,
    excludes: ['only-observer', 'generous-god'],
    apply: (r) => {
      r.favourRate *= 0.3;
    },
  },
  {
    id: 'generous-god',
    name: 'Generous god',
    category: 'observer',
    description: 'Favour accumulates twice as fast.',
    multiplier: 0.7,
    excludes: ['silent-god', 'only-observer'],
    apply: (r) => {
      r.favourRate *= 2;
    },
  },
  {
    id: 'only-observer',
    name: 'Only an observer',
    category: 'observer',
    description: 'No interventions at all. Watch, understand, and let the world be.',
    multiplier: 2.5,
    excludes: ['silent-god', 'generous-god'],
    unlock: 'reach-era-3',
    apply: (r) => {
      r.interventions = false;
    },
  },
  {
    id: 'no-resurrection',
    name: 'No new souls',
    category: 'observer',
    description: 'The observer cannot create people. Every person in this world is born.',
    multiplier: 1.3,
    apply: (r) => {
      r.spawnAllowed = false;
    },
  },
  {
    id: 'few-founders',
    name: 'Four founders',
    category: 'observer',
    description: 'The world begins with four people instead of eight.',
    multiplier: 1.6,
    excludes: ['big-tribe'],
    apply: (r) => {
      r.foundersOverride = 4;
    },
  },
  {
    id: 'big-tribe',
    name: 'Sixteen founders',
    category: 'observer',
    description: 'The world begins with sixteen people.',
    multiplier: 0.8,
    excludes: ['few-founders'],
    apply: (r) => {
      r.foundersOverride = 16;
    },
  },
];

const LAW_BY_ID = new Map(LAWS.map((law) => [law.id, law]));

export function lawById(id: string): LawDefinition | undefined {
  return LAW_BY_ID.get(id);
}

/** Resolve a charter into rules. Unknown ids are ignored; order does not matter. */
export function rulesFor(charter: readonly string[]): WorldRules {
  const rules: WorldRules = { ...DEFAULT_RULES, crisisWeights: {} };
  const ids = [...new Set(charter)].sort();
  for (const id of ids) LAW_BY_ID.get(id)?.apply(rules);
  return rules;
}

/** The product of every law's multiplier: how much harder this charter is. */
export function charterMultiplier(charter: readonly string[]): number {
  let product = 1;
  for (const id of new Set(charter)) product *= LAW_BY_ID.get(id)?.multiplier ?? 1;
  return product;
}

/** Why a charter is invalid, or null if it is fine. */
export function charterProblem(charter: readonly string[], maxLaws: number): string | null {
  if (charter.length > maxLaws) return `A charter holds at most ${maxLaws} laws.`;
  for (const id of charter) {
    const law = LAW_BY_ID.get(id);
    if (!law) return `Unknown law "${id}".`;
    for (const other of law.excludes ?? []) {
      if (charter.includes(other)) return `${law.name} cannot share a charter with ${LAW_BY_ID.get(other)?.name ?? other}.`;
    }
  }
  return null;
}
