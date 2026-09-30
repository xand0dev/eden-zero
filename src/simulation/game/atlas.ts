import { DAY_SECONDS, SIM_HZ, AGE_ADULT_END, AGE_CHILD_END } from '../../shared/constants';
import { M, MOTOR_START, S } from '../brain/channels';
import { innatePriorIndex } from '../brain/network';

/**
 * The atlas of behaviours — what the observer can discover.
 *
 * Nobody wrote any of these behaviours. The atlas is a classifier that only
 * *watches*: it reads motor choices, positions, bodies and brains, and when an
 * individual's record matches a formal pattern it names what it saw. It never
 * feeds anything back into the simulation. Each entry states its criterion in
 * plain words, so a discovery can always be checked against what happened.
 *
 * Collecting the atlas is the long game: the common entries turn up in the
 * first hour, the legendary ones need the right world, the right lineage and
 * patience.
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';
export type AtlasSection = 'food' | 'family' | 'work' | 'space' | 'danger' | 'mind';

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'legendary'];
export const SECTION_NAMES: Record<AtlasSection, string> = {
  food: 'Food and water',
  family: 'Family',
  work: 'Work',
  space: 'Space',
  danger: 'Danger',
  mind: 'Mind',
};

const TICKS_PER_DAY = DAY_SECONDS * SIM_HZ;
/** Behaviour samples are taken every this many ticks per person. */
export const SAMPLE_INTERVAL = 10;
const SAMPLES_PER_DAY = TICKS_PER_DAY / SAMPLE_INTERVAL;

/** 16x16-tile regions for the wandering statistics. */
export const REGION_SIZE = 16;

/**
 * Everything the atlas records about one person. Counters only: cheap to keep,
 * cheap to save, and impossible to misread as a decision.
 */
export interface BehaviourLog {
  id: number;
  /** Neurons this person's brain grew in life (neurogenesis, v3). */
  skillsGrown?: number;
  samples: number;
  nearWater: number;
  nearHome: number;
  alone: number;
  onTrail: number;
  nightSamples: number;
  nightAsleepNearHome: number;
  nightAsleep: number;
  nightWatch: number;
  motor: number[];
  /** Last tick each region was visited, -1 if never. */
  regions: number[];
  lastBuildTick: number;
  // food and water
  foodWild: number;
  foodCrop: number;
  foodCarcass: number;
  foodGranary: number;
  foodGift: number;
  meals: number;
  nightMeals: number;
  wellDrinks: number;
  /** Crop eaten while wild food was plentiful nearby. */
  cropByChoice: number;
  // work
  timber: number;
  woodLaid: number;
  sites: number[];
  completed: number;
  completedKinds: number[];
  fieldsSown: number;
  crops: number;
  canalsFinished: number;
  frontierFoundings: number;
  fedChildren: number;
  irrigated: number;
  rotations: number;
  // family
  partners: number[];
  // danger
  predatorHitTick: number;
  survivedPredator: number;
  rescuePending: Array<[number, number]>;
  rescues: number;
  struck: number;
  crises: string[];
  feverRecovered: number;
  // grief
  mourning: [number, number, number] | null;
  mourningSamples: number;
  mourned: number;
  // mind
  valenceSum: number;
  pulses: number;
  earned: string[];
}

export function createLog(id: number): BehaviourLog {
  return {
    id,
    samples: 0,
    nearWater: 0,
    nearHome: 0,
    alone: 0,
    onTrail: 0,
    nightSamples: 0,
    nightAsleepNearHome: 0,
    nightAsleep: 0,
    nightWatch: 0,
    motor: new Array(17).fill(0),
    regions: [],
    lastBuildTick: -1e9,
    foodWild: 0,
    foodCrop: 0,
    foodCarcass: 0,
    foodGranary: 0,
    foodGift: 0,
    meals: 0,
    nightMeals: 0,
    wellDrinks: 0,
    cropByChoice: 0,
    timber: 0,
    woodLaid: 0,
    sites: [],
    completed: 0,
    completedKinds: [],
    fieldsSown: 0,
    crops: 0,
    canalsFinished: 0,
    frontierFoundings: 0,
    fedChildren: 0,
    irrigated: 0,
    rotations: 0,
    partners: [],
    predatorHitTick: -1,
    survivedPredator: 0,
    rescuePending: [],
    rescues: 0,
    struck: 0,
    crises: [],
    feverRecovered: 0,
    mourning: null,
    mourningSamples: 0,
    mourned: 0,
    valenceSum: 0,
    pulses: 0,
    earned: [],
  };
}

/** What an entry's test can see about the person besides the log. */
export interface AtlasSubject {
  ageYears: number;
  alive: boolean;
  deathReason: string | null;
  children: number;
  descendants: number;
  livingGrandchildren: number;
  firstChildAge: number | null;
  /** Change since birth of innate reflex k. */
  innateDrift(k: number): number;
  maxInnateDrift: number;
  /** A driving reflex born at strength 1.2 or more now pulls the other way. */
  strongReflexReversed: boolean;
  /** Current weight of innate reflex k. */
  innateWeight(k: number): number;
  weightDrift: number;
  /** Tick of the current world. */
  tick: number;
  /** Grown neurons alive in the brain now, instincts included. */
  grownNeurons?: number;
  /** How many grown neurons the brain has room for. */
  growthCapacity?: number;
  /** Instincts this person was born with. */
  instincts?: number;
  /** Most generations any of their instincts has been inherited through. */
  instinctGenerations?: number;
}

export interface AtlasEntry {
  id: string;
  name: string;
  section: AtlasSection;
  rarity: Rarity;
  /** What it is, in the observer's words. */
  description: string;
  /** How it is detected, stated so it can be checked. */
  criterion: string;
  /** Title the person earns, shown after their name. */
  epithet?: string;
  /** Only evaluated when the person dies (lifetime entries). */
  atDeath?: boolean;
  test(log: BehaviourLog, subject: AtlasSubject): boolean;
}

const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
const motorShare = (log: BehaviourLog, motor: number): number =>
  share(log.motor[motor], log.motor.reduce((a, b) => a + b, 0));
const regionsVisited = (log: BehaviourLog): number => log.regions.filter((t) => t >= 0).length;
const recentRegions = (log: BehaviourLog, tick: number, days: number): number =>
  log.regions.filter((t) => t >= 0 && tick - t <= days * TICKS_PER_DAY).length;

const FLEE = innatePriorIndex(S.threatFront, MOTOR_START + M.moveBack);
const HUNGER_TEND = innatePriorIndex(S.hunger, MOTOR_START + M.tend);

export const ATLAS: AtlasEntry[] = [
  // --- food and water ------------------------------------------------------
  {
    id: 'first-meal',
    name: 'First meal',
    section: 'food',
    rarity: 'common',
    description: 'Someone found food and ate it. Every behaviour in this world starts here.',
    criterion: 'Ate any food.',
    test: (l) => l.meals >= 1,
  },
  {
    id: 'waterside',
    name: 'Waterside dweller',
    section: 'food',
    rarity: 'common',
    description: 'Lives by the water, rarely straying more than a few steps from it.',
    criterion: 'At least 70% of a day or more of samples within 6 tiles of fresh water.',
    epithet: 'of the Shore',
    test: (l) => l.samples >= SAMPLES_PER_DAY && share(l.nearWater, l.samples) >= 0.7,
  },
  {
    id: 'forager',
    name: 'Forager',
    section: 'food',
    rarity: 'common',
    description: 'Lives on what grows wild.',
    criterion: 'Ate 25 or more units of wild food.',
    test: (l) => l.foodWild >= 25,
  },
  {
    id: 'grain-eater',
    name: 'Grain eater',
    section: 'food',
    rarity: 'uncommon',
    description: 'Lives mostly on harvested crops rather than on the wild.',
    criterion: 'Half or more of at least 10 units of food eaten came from harvests.',
    test: (l) => {
      const total = l.foodWild + l.foodCrop + l.foodGranary + l.foodCarcass + l.foodGift;
      return total >= 10 && share(l.foodCrop + l.foodGranary, total) >= 0.5;
    },
  },
  {
    id: 'unusual-taste',
    name: 'Unusual taste',
    section: 'food',
    rarity: 'rare',
    description: 'Eats from the harvest even when wild food is all around — a preference, not a necessity.',
    criterion: '8 or more units of crop eaten while at least five wild plants with food stood within reach of sight.',
    epithet: 'the Particular',
    test: (l) => l.cropByChoice >= 8,
  },
  {
    id: 'scavenger',
    name: 'Scavenger',
    section: 'food',
    rarity: 'uncommon',
    description: 'Eats from the dead.',
    criterion: 'Ate 2 or more units from a carcass.',
    test: (l) => l.foodCarcass >= 2,
  },
  {
    id: 'granary-regular',
    name: 'Granary regular',
    section: 'food',
    rarity: 'uncommon',
    description: 'Comes back to the granary to eat.',
    criterion: 'Ate 6 or more units from a granary.',
    test: (l) => l.foodGranary >= 6,
  },
  {
    id: 'night-forager',
    name: 'Night forager',
    section: 'food',
    rarity: 'rare',
    description: 'Eats in the dark while others sleep.',
    criterion: 'At least 40% of 30 or more meals eaten at night.',
    epithet: 'the Owl',
    test: (l) => l.meals >= 30 && share(l.nightMeals, l.meals) >= 0.4,
  },
  {
    id: 'well-drinker',
    name: 'Well drinker',
    section: 'food',
    rarity: 'uncommon',
    description: 'Drinks from a well instead of the river.',
    criterion: 'Drank at a well 20 or more times.',
    test: (l) => l.wellDrinks >= 20,
  },
  // --- family --------------------------------------------------------------
  {
    id: 'provider',
    name: 'Provider',
    section: 'family',
    rarity: 'common',
    description: 'Brings in a harvest that their own children then eat.',
    criterion: 'A child of theirs ate from a crop pile they harvested.',
    epithet: 'the Provider',
    test: (l) => l.fedChildren >= 1,
  },
  {
    id: 'devoted-pair',
    name: 'Devoted pair',
    section: 'family',
    rarity: 'uncommon',
    description: 'Mates with one partner only, again and again.',
    criterion: 'Three or more matings, all with the same partner.',
    test: (l) => l.partners.length >= 3 && l.partners.every((p) => p === l.partners[0]),
  },
  {
    id: 'matriarch',
    name: 'Great parent',
    section: 'family',
    rarity: 'rare',
    description: 'Raises a large family.',
    criterion: 'Six or more children.',
    epithet: 'the Elder',
    test: (_l, s) => s.children >= 6,
  },
  {
    id: 'grandparent',
    name: 'Grandparent',
    section: 'family',
    rarity: 'common',
    description: 'Lives to see a grandchild.',
    criterion: 'Alive with at least one living grandchild.',
    test: (_l, s) => s.alive && s.livingGrandchildren >= 1,
  },
  {
    id: 'dynasty',
    name: 'Dynasty',
    section: 'family',
    rarity: 'legendary',
    description: 'The root of a great lineage.',
    criterion: 'Fifteen or more descendants.',
    epithet: 'the Root',
    test: (_l, s) => s.descendants >= 15,
  },
  {
    id: 'late-bloomer',
    name: 'Late bloomer',
    section: 'family',
    rarity: 'rare',
    description: 'Has a first child late in life.',
    criterion: 'First child born after the parent turned 35.',
    test: (_l, s) => s.firstChildAge !== null && s.firstChildAge >= 35,
  },
  {
    id: 'mourner',
    name: 'Mourner',
    section: 'family',
    rarity: 'legendary',
    description: 'After a partner dies, keeps returning to the place it happened.',
    criterion: 'Spent at least half of the following day within 8 tiles of where a partner died.',
    epithet: 'the Mourner',
    test: (l) => l.mourned >= 1,
  },
  // --- work ----------------------------------------------------------------
  {
    id: 'woodcutter',
    name: 'Woodcutter',
    section: 'work',
    rarity: 'common',
    description: 'Fells trees.',
    criterion: 'Felled 40 or more units of timber.',
    epithet: 'the Woodcutter',
    test: (l) => l.timber >= 40,
  },
  {
    id: 'hut-raiser',
    name: 'Hut raiser',
    section: 'work',
    rarity: 'common',
    description: 'Lays timber on many different buildings.',
    criterion: 'Laid timber on five or more different structures.',
    test: (l) => l.sites.length >= 5,
  },
  {
    id: 'master-builder',
    name: 'Master builder',
    section: 'work',
    rarity: 'uncommon',
    description: 'Finishes what the village starts.',
    criterion: 'Laid the final timber on three or more structures.',
    epithet: 'the Builder',
    test: (l) => l.completed >= 3,
  },
  {
    id: 'obsessive-builder',
    name: 'Obsessive builder',
    section: 'work',
    rarity: 'rare',
    description: 'Does little else but build.',
    criterion: 'Build was the strongest motor in 40% or more of at least a day of samples.',
    test: (l) => l.samples >= SAMPLES_PER_DAY && motorShare(l, M.build) >= 0.4,
  },
  {
    id: 'sower',
    name: 'Sower',
    section: 'work',
    rarity: 'common',
    description: 'Sows fields.',
    criterion: 'Sowed 10 or more fields.',
    epithet: 'the Sower',
    test: (l) => l.fieldsSown >= 10,
  },
  {
    id: 'harvester',
    name: 'Harvester',
    section: 'work',
    rarity: 'common',
    description: 'Brings in the crops.',
    criterion: 'Brought in 10 or more crops.',
    test: (l) => l.crops >= 10,
  },
  {
    id: 'irrigator',
    name: 'Irrigator',
    section: 'work',
    rarity: 'rare',
    description: 'Digs canals that carry water to fields that then yield.',
    criterion: 'Finished three or more canal lengths, and a field watered by one of them was harvested.',
    epithet: 'the Irrigator',
    test: (l) => l.canalsFinished >= 3 && l.irrigated >= 1,
  },
  {
    id: 'rotation',
    name: 'Crop rotation',
    section: 'work',
    rarity: 'rare',
    description: 'Lets a field rest before sowing it again — and the rested field yields.',
    criterion: 'Sowed a field that had lain fallow for two days or more, and it was harvested.',
    epithet: 'the Patient',
    test: (l) => l.rotations >= 1,
  },
  {
    id: 'granary-builder',
    name: 'Granary builder',
    section: 'work',
    rarity: 'uncommon',
    description: 'Completes a granary.',
    criterion: 'Laid the final timber on a granary.',
    test: (l) => l.completedKinds.includes(1),
  },
  {
    id: 'well-digger',
    name: 'Well digger',
    section: 'work',
    rarity: 'uncommon',
    description: 'Completes a well.',
    criterion: 'Laid the final timber on a well.',
    test: (l) => l.completedKinds.includes(2),
  },
  // --- space ---------------------------------------------------------------
  {
    id: 'homebody',
    name: 'Homebody',
    section: 'space',
    rarity: 'common',
    description: 'Stays close to where they were born.',
    criterion: '80% or more of two days of samples within 10 tiles of their birthplace.',
    test: (l) => l.samples >= 2 * SAMPLES_PER_DAY && share(l.nearHome, l.samples) >= 0.8,
  },
  {
    id: 'nomad',
    name: 'Nomad',
    section: 'space',
    rarity: 'uncommon',
    description: 'Keeps moving across the island and never builds.',
    criterion: 'Visited five or more 16x16 regions in the last three days without laying any timber.',
    epithet: 'the Wanderer',
    test: (l, s) => recentRegions(l, s.tick, 3) >= 5 && s.tick - l.lastBuildTick > 3 * TICKS_PER_DAY,
  },
  {
    id: 'explorer',
    name: 'Explorer',
    section: 'space',
    rarity: 'rare',
    description: 'Has walked a large part of the island.',
    criterion: 'Visited 25 or more of the island’s 16x16 regions in a lifetime.',
    epithet: 'the Far-walker',
    test: (l) => regionsVisited(l) >= 25,
  },
  {
    id: 'hermit',
    name: 'Hermit',
    section: 'space',
    rarity: 'legendary',
    description: 'Lives apart from everyone, and lives long.',
    criterion: 'Died of old age after spending 80% or more of their life with nobody in sight.',
    epithet: 'the Hermit',
    atDeath: true,
    test: (l, s) => s.deathReason === 'old age' && share(l.alone, l.samples) >= 0.8,
  },
  {
    id: 'pathfinder',
    name: 'Pathfinder',
    section: 'space',
    rarity: 'uncommon',
    description: 'Walks the worn trails.',
    criterion: '30% or more of a day or more of samples on a trail.',
    test: (l) => l.samples >= SAMPLES_PER_DAY && share(l.onTrail, l.samples) >= 0.3,
  },
  {
    id: 'frontier',
    name: 'Frontier founder',
    section: 'space',
    rarity: 'uncommon',
    description: 'Starts a building out at the forest edge, beyond the village.',
    criterion: 'Founded a structure beyond the village’s reach.',
    test: (l) => l.frontierFoundings >= 1,
  },
  {
    id: 'hearth-keeper',
    name: 'Hearth keeper',
    section: 'space',
    rarity: 'common',
    description: 'Sleeps by a hut every night.',
    criterion: '80% or more of at least a day’s worth of night-time sleep spent within 4 tiles of a dwelling.',
    test: (l) => l.nightAsleep >= SAMPLES_PER_DAY / 3 && share(l.nightAsleepNearHome, l.nightAsleep) >= 0.8,
  },
  // --- danger --------------------------------------------------------------
  {
    id: 'survivor',
    name: 'Survivor',
    section: 'danger',
    rarity: 'uncommon',
    description: 'Was bitten by a predator and lived.',
    criterion: 'Alive a full day after taking predator damage.',
    epithet: 'the Scarred',
    test: (l) => l.survivedPredator >= 1,
  },
  {
    id: 'rescuer',
    name: 'Rescuer',
    section: 'danger',
    rarity: 'rare',
    description: 'Fled from a predator with a child close by — and both lived.',
    criterion: 'Retreated from a predator with a child within 4 tiles; both alive a day later.',
    epithet: 'the Guardian',
    test: (l) => l.rescues >= 1,
  },
  {
    id: 'brawler',
    name: 'Brawler',
    section: 'danger',
    rarity: 'uncommon',
    description: 'Strikes another person.',
    criterion: 'Struck another human three or more times.',
    epithet: 'the Fist',
    test: (l) => l.struck >= 3,
  },
  {
    id: 'winter-survivor',
    name: 'Winter survivor',
    section: 'danger',
    rarity: 'uncommon',
    description: 'Lived through a harsh winter as an adult.',
    criterion: 'An adult alive at the end of a harsh winter.',
    test: (l) => l.crises.includes('harshWinter'),
  },
  {
    id: 'drought-survivor',
    name: 'Drought survivor',
    section: 'danger',
    rarity: 'uncommon',
    description: 'Lived through a drought as an adult.',
    criterion: 'An adult alive at the end of a drought.',
    test: (l) => l.crises.includes('drought'),
  },
  {
    id: 'fever-survivor',
    name: 'Fever survivor',
    section: 'danger',
    rarity: 'rare',
    description: 'Caught the fever and recovered.',
    criterion: 'Recovered from fever.',
    test: (l) => l.feverRecovered >= 1,
  },
  // --- mind ----------------------------------------------------------------
  {
    id: 'night-watch',
    name: 'Night watch',
    section: 'mind',
    rarity: 'uncommon',
    description: 'Stays awake near the huts at night while others sleep around them.',
    criterion: 'Awake near a dwelling, with three or more asleep within 8 tiles, in 70% or more of a day’s night samples.',
    epithet: 'the Night Watch',
    test: (l) => l.nightSamples >= SAMPLES_PER_DAY / 3 && share(l.nightWatch, l.nightSamples) >= 0.7,
  },
  {
    id: 'first-neuron',
    name: 'A new neuron',
    section: 'mind',
    rarity: 'common',
    description: 'At a moment that mattered, their brain grew a neuron nobody designed — a small rule tying what they sensed to what they did.',
    criterion: 'Grew at least one neuron in life.',
    test: (l) => (l.skillsGrown ?? 0) >= 1,
  },
  {
    id: 'many-neurons',
    name: 'Growing mind',
    section: 'mind',
    rarity: 'uncommon',
    description: 'Grew six new neurons in one life.',
    criterion: 'Grew six or more neurons in life.',
    epithet: 'the Growing',
    test: (l) => (l.skillsGrown ?? 0) >= 6,
  },
  {
    id: 'full-mind',
    name: 'A full mind',
    section: 'mind',
    rarity: 'rare',
    description: 'Every slot their genes allowed for new neurons is taken, and there is room for at least twelve.',
    criterion: 'Grown neurons equal capacity, capacity twelve or more.',
    epithet: 'the Deep',
    test: (_l, s) => (s.growthCapacity ?? 0) >= 12 && (s.grownNeurons ?? 0) >= (s.growthCapacity ?? 0),
  },
  {
    id: 'born-knowing',
    name: 'Born knowing',
    section: 'mind',
    rarity: 'uncommon',
    description: 'Born with an instinct: something a parent learned, written into the child as wiring.',
    criterion: 'At least one inherited instinct.',
    test: (_l, s) => (s.instincts ?? 0) >= 1,
  },
  {
    id: 'ancestral-instinct',
    name: 'Ancestral instinct',
    section: 'mind',
    rarity: 'rare',
    description: 'Carries an instinct that has passed down five generations — a reflex that evolved in this world.',
    criterion: 'An instinct inherited through five or more generations.',
    epithet: 'of the Old Blood',
    test: (_l, s) => (s.instinctGenerations ?? 0) >= 5,
  },
  {
    id: 'instinct-of-ages',
    name: 'Instinct of ages',
    section: 'mind',
    rarity: 'legendary',
    description: 'Carries an instinct twelve generations old. Nobody wrote it; the world did.',
    criterion: 'An instinct inherited through twelve or more generations.',
    epithet: 'the Inheritor',
    test: (_l, s) => (s.instinctGenerations ?? 0) >= 12,
  },
  {
    id: 'relearned',
    name: 'Relearned',
    section: 'mind',
    rarity: 'legendary',
    description: 'Lifetime learning has turned one of the strongest driving reflexes around — to drink, eat, flee, rest — so that it now pulls the other way.',
    criterion: 'An excitatory innate reflex born at 1.2 or more is now −0.2 or below.',
    epithet: 'the Changed',
    test: (_l, s) => s.strongReflexReversed,
  },
  {
    id: 'learned-reaping',
    name: 'Learned to reap',
    section: 'mind',
    rarity: 'uncommon',
    description:
      'Born with hunger holding back farm work, has learned the opposite: hunger now sends them to bring in the crop.',
    criterion: 'The innate "hunger suppresses reaping" synapse (−1.6 at birth) is now +0.2 or more.',
    epithet: 'the Reaper',
    test: (_l, s) => HUNGER_TEND >= 0 && s.innateWeight(HUNGER_TEND) >= 0.2,
  },
  {
    id: 'fearless',
    name: 'Fearless',
    section: 'mind',
    rarity: 'rare',
    description: 'Has learned not to flee: the innate threat-to-retreat reflex has weakened.',
    criterion: 'The threat-front to move-back synapse fell 0.4 or more below its birth weight.',
    epithet: 'the Fearless',
    test: (_l, s) => FLEE >= 0 && s.innateDrift(FLEE) <= -0.4,
  },
  {
    id: 'quick-study',
    name: 'Quick study',
    section: 'mind',
    rarity: 'uncommon',
    description: 'Learns fast: a young brain that has already moved far from its birth weights.',
    criterion: 'Mean synaptic drift of 0.02 or more before the age of 15.',
    test: (_l, s) => s.ageYears < 15 && s.weightDrift >= 0.02,
  },
  {
    id: 'stubborn',
    name: 'Stubborn',
    section: 'mind',
    rarity: 'rare',
    description: 'Hardly changed by a long life.',
    criterion: 'Mean synaptic drift below 0.004 at the age of 40 or more.',
    test: (_l, s) => s.ageYears >= 40 && s.weightDrift < 0.004,
  },
  {
    id: 'contented',
    name: 'Contented',
    section: 'mind',
    rarity: 'rare',
    description: 'Life, on the whole, has felt good: the learning signal has run positive.',
    criterion: 'Mean valence above +0.03 over at least two days of samples.',
    epithet: 'the Glad',
    test: (l) => l.samples >= 2 * SAMPLES_PER_DAY && l.valenceSum / l.samples > 0.03,
  },
  {
    id: 'conditioned',
    name: 'Conditioned',
    section: 'mind',
    rarity: 'rare',
    description: 'Shaped by the observer: received reward pulses and carries the change.',
    criterion: 'Received five or more reward pulses, with mean synaptic drift of 0.015 or more.',
    test: (l, s) => l.pulses >= 5 && s.weightDrift >= 0.015,
  },
  // --- the second wave: more to find ---------------------------------------
  {
    id: 'fed-by-gods',
    name: 'Fed by the gods',
    section: 'food',
    rarity: 'uncommon',
    description: 'Has eaten food the observer placed.',
    criterion: 'Ate 3 or more units of food placed by the observer.',
    test: (l) => l.foodGift >= 3,
  },
  {
    id: 'canal-digger',
    name: 'Canal digger',
    section: 'work',
    rarity: 'common',
    description: 'Has finished a length of canal.',
    criterion: 'Finished at least one canal length.',
    test: (l) => l.canalsFinished >= 1,
  },
  {
    id: 'lumberjack',
    name: 'Lumberjack',
    section: 'work',
    rarity: 'rare',
    description: 'Has felled a forest’s worth of timber.',
    criterion: 'Felled 200 or more units of timber.',
    epithet: 'the Axe',
    test: (l) => l.timber >= 200,
  },
  {
    id: 'master-farmer',
    name: 'Master farmer',
    section: 'work',
    rarity: 'rare',
    description: 'Sows and reaps, season after season.',
    criterion: 'Sowed 30 or more fields and brought in 30 or more crops.',
    epithet: 'the Farmer',
    test: (l) => l.fieldsSown >= 30 && l.crops >= 30,
  },
  {
    id: 'workshop-builder',
    name: 'Workshop builder',
    section: 'work',
    rarity: 'rare',
    description: 'Completes a workshop.',
    criterion: 'Laid the final timber on a workshop.',
    test: (l) => l.completedKinds.includes(3),
  },
  {
    id: 'stonemason',
    name: 'Stonemason',
    section: 'work',
    rarity: 'rare',
    description: 'Completes a house of stone.',
    criterion: 'Laid the final timber on a stone house.',
    test: (l) => l.completedKinds.includes(4),
  },
  {
    id: 'wall-builder',
    name: 'Wall builder',
    section: 'work',
    rarity: 'rare',
    description: 'Completes a length of palisade.',
    criterion: 'Laid the final timber on a palisade.',
    epithet: 'the Warden',
    test: (l) => l.completedKinds.includes(5),
  },
  {
    id: 'shrine-builder',
    name: 'Shrine builder',
    section: 'work',
    rarity: 'legendary',
    description: 'Completes the place where the village remembers its dead.',
    criterion: 'Laid the final timber on a shrine.',
    epithet: 'the Keeper',
    test: (l) => l.completedKinds.includes(6),
  },
  {
    id: 'long-walker',
    name: 'Long walker',
    section: 'space',
    rarity: 'legendary',
    description: 'Has walked most of the island’s land.',
    criterion: 'Visited 35 or more of the island’s 16x16 regions in a lifetime.',
    test: (l) => regionsVisited(l) >= 35,
  },
  {
    id: 'trail-walker',
    name: 'Trail walker',
    section: 'space',
    rarity: 'rare',
    description: 'Lives on the worn trails.',
    criterion: '60% or more of two days of samples on a trail.',
    test: (l) => l.samples >= 2 * SAMPLES_PER_DAY && share(l.onTrail, l.samples) >= 0.6,
  },
  {
    id: 'twice-bitten',
    name: 'Twice bitten',
    section: 'danger',
    rarity: 'rare',
    description: 'Survived predator bites on two separate days.',
    criterion: 'Alive a full day after predator damage, twice.',
    test: (l) => l.survivedPredator >= 2,
  },
  {
    id: 'crisis-veteran',
    name: 'Crisis veteran',
    section: 'danger',
    rarity: 'uncommon',
    description: 'Has lived through two different kinds of crisis as an adult.',
    criterion: 'An adult at the end of two different kinds of crisis.',
    test: (l) => l.crises.length >= 2,
  },
  {
    id: 'weathered',
    name: 'Weathered',
    section: 'danger',
    rarity: 'legendary',
    description: 'Has seen three kinds of disaster and is still here.',
    criterion: 'An adult at the end of three different kinds of crisis.',
    epithet: 'the Weathered',
    test: (l) => l.crises.length >= 3,
  },
  {
    id: 'elder',
    name: 'Elder',
    section: 'family',
    rarity: 'common',
    description: 'Has lived into old age.',
    criterion: 'Alive at 45 years or older.',
    test: (_l, s) => s.alive && s.ageYears >= 45,
  },
  {
    id: 'centenarian',
    name: 'Centenarian',
    section: 'family',
    rarity: 'legendary',
    description: 'Has lived a hundred years.',
    criterion: 'Alive at 100 years or older.',
    epithet: 'the Ancient',
    test: (_l, s) => s.alive && s.ageYears >= 100,
  },
  {
    id: 'restless',
    name: 'Restless',
    section: 'mind',
    rarity: 'uncommon',
    description: 'Hardly ever stops to rest.',
    criterion: 'Rest was the strongest motor in under 3% of two days of samples.',
    test: (l) => l.samples >= 2 * SAMPLES_PER_DAY && motorShare(l, M.rest) < 0.03,
  },
  {
    id: 'sleeper',
    name: 'Sound sleeper',
    section: 'mind',
    rarity: 'common',
    description: 'Sleeps through the night.',
    criterion: 'Asleep in 90% or more of at least a day’s night samples.',
    test: (l) => l.nightSamples >= SAMPLES_PER_DAY / 3 && share(l.nightAsleep, l.nightSamples) >= 0.9,
  },
  {
    id: 'gloomy',
    name: 'Gloomy',
    section: 'mind',
    rarity: 'rare',
    description: 'Life, on the whole, has felt bad: the learning signal has run negative.',
    criterion: 'Mean valence below −0.03 over at least two days of samples.',
    epithet: 'the Grim',
    test: (l) => l.samples >= 2 * SAMPLES_PER_DAY && l.valenceSum / l.samples < -0.03,
  },
];

const ENTRY_BY_ID = new Map(ATLAS.map((entry) => [entry.id, entry]));

export function atlasEntry(id: string): AtlasEntry | undefined {
  return ENTRY_BY_ID.get(id);
}

const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

/** The rarest epithet earned, or null. */
export function epithetFor(earned: readonly string[]): string | null {
  let best: AtlasEntry | null = null;
  for (const id of earned) {
    const entry = ENTRY_BY_ID.get(id);
    if (!entry?.epithet) continue;
    if (!best || RARITY_RANK[entry.rarity] > RARITY_RANK[best.rarity]) best = entry;
  }
  return best?.epithet ?? null;
}

/**
 * Check a person against every entry they have not earned yet.
 *
 * Returns the newly earned entry ids. Lifetime entries are skipped until death.
 */
export function evaluate(log: BehaviourLog, subject: AtlasSubject, atDeath: boolean): string[] {
  const out: string[] = [];
  for (const entry of ATLAS) {
    if (log.earned.includes(entry.id)) continue;
    if (entry.atDeath && !atDeath) continue;
    if (entry.test(log, subject)) {
      log.earned.push(entry.id);
      out.push(entry.id);
    }
  }
  return out;
}

export function regionIndex(x: number, y: number, width: number): number {
  const columns = Math.ceil(width / REGION_SIZE);
  return Math.floor(y / REGION_SIZE) * columns + Math.floor(x / REGION_SIZE);
}

export const ATLAS_CONSTANTS = { TICKS_PER_DAY, SAMPLES_PER_DAY, AGE_ADULT_END, AGE_CHILD_END };
