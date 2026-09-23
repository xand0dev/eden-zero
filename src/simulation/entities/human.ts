import { Rng } from '../rng';
import { Brain, clamp } from '../brain/network';
import { M, MOTOR_COUNT, MOTOR_NAMES, MOTOR_START, S, SENSORY_COUNT, SENSORY_NAMES, regionOf } from '../brain/channels';
import { SocialMemory } from '../memory/social';
import { cloneGenome, type Genome } from '../genetics/genome';
import type { InheritanceReport } from '../genetics/evolution';
import type { SimWorld } from './context';
import {
  BUILD_CHUNK,
  BUILD_INTERVAL_TICKS,
  CARRY_CAPACITY,
  HARVEST_INTERVAL_TICKS,
} from './structure';
import { EntityKind, LifeStage, Sex, type EventKind } from '../../shared/types';
import {
  AGE_ADULT_END,
  AGE_BABY_END,
  AGE_CHILD_END,
  AGE_MAX,
  BIO_YEAR_SECONDS,
  GESTATION_YEARS,
} from '../../shared/constants';
import { Tile, isWater, tileAt } from '../environment/terrain';

// --- physiology tuning (all rates are per simulated second) -----------------

/**
 * Metabolic rates, per simulated second.
 *
 * These set the *foraging* cycle, not the biological clock (see
 * BIO_YEAR_SECONDS for ageing). They are deliberately slow enough that a founder
 * has a couple of simulated minutes to locate water: at a faster rate the first
 * generation reliably died of thirst before it had time to learn anything, which
 * makes for a bad observatory. At x20 speed a meal cycle is still about ten
 * seconds of wall-clock time, so foraging remains the dominant visible activity.
 */
const HUNGER_RATE = 0.26;
const THIRST_RATE = 0.34;
const FATIGUE_RATE = 1.1;
const FATIGUE_REST_RATE = 5.2;
const ENERGY_DRAIN_BASE = 0.3;
const ENERGY_DRAIN_MOVE = 1.35;
const ENERGY_REGEN_REST = 1.55;
const HEALTH_REGEN = 0.55;
const STARVATION_DAMAGE = 3.2;
const DEHYDRATION_DAMAGE = 4.2;
const THERMAL_DAMAGE = 1.7;
const PAIN_DECAY = 2.4;

const BASE_SPEED = 3.05;
const TURN_RATE = 3.6;
/** Turn rate applied by the obstacle-avoidance reflex when the body is stuck. */
const STUCK_TURN_RATE = 2.4;

/** Bite of plant biomass consumed per feeding action. */
const BITE_SIZE = 0.45;
const BITE_INTERVAL_TICKS = 6;
const HUNGER_PER_FOOD = 128;
const ENERGY_PER_FOOD = 88;

/** Contact distance for touching / eating / mating interactions. */
const REACH = 1.35;
const TOUCH_RANGE = 0.95;
/**
 * How far from the village centre a new hut may be founded.
 *
 * Without this the inhabitants scatter single huts across the whole island,
 * which looks like litter rather than a settlement.
 */
const VILLAGE_RADIUS = 26;

/**
 * How much further out the village may build for each structure already standing.
 *
 * A fixed radius meant a village could never actually grow: once the ring was
 * full, every further hut landed on top of the last one. Letting the reach
 * expand with the settlement is what turns a camp into something that spreads.
 */
const VILLAGE_GROWTH_PER_STRUCTURE = 1.8;

/**
 * A human standing within this distance of real timber may found a hut even
 * beyond the village's reach.
 *
 * The forest is where the building material is, and S1 measured that in three of
 * four worlds the founders start nowhere near it. Without this the settlement can
 * only ever grow around its own centre, never toward the trees — which is the
 * difference between a village getting bigger and a village reaching the forest.
 */
const FRONTIER_BUILD_RANGE = 14;

/**
 * How far beyond the village's own reach a hut may be founded, provided it is
 * standing beside a structure that already exists.
 *
 * The first version of S2 let anyone build anywhere there was timber, and the
 * measurement showed why that is wrong: 63 of 72 huts ended up outside the old
 * radius with a maximum of 91 tiles, which is not a village growing, it is
 * litter. Requiring a new hut to adjoin an existing one keeps the settlement
 * connected while still letting it reach out toward the forest, one hut at a
 * time.
 */
const VILLAGE_EXTENSION_RANGE = 16;

/** The village's reach stops growing here, so a settlement has a size. */
const MAX_VILLAGE_GROWTH = 24;

/**
 * Absolute limit on how far from the centre any hut may be founded.
 *
 * Without it the extension rule chains: each hut legitimises the next one
 * sixteen tiles further out, and the settlement walks across the whole island
 * one hut at a time. Measured at 88 tiles before this limit existed, on an
 * island 176 wide — a settlement that has become a scattering.
 */
const ABSOLUTE_VILLAGE_LIMIT = 46;

/** Duration of a mating event, in simulated seconds. */
export const MATING_DURATION = 7;
/**
 * Ticks a human must wait after mating before it can mate again.
 *
 * Exported because the world owns the mating lifecycle (pairing, completion,
 * cooldowns) and duplicating the number there is how the two drifted apart
 * before.
 */
export const MATING_REFRACTORY = 26;

const ATTACK_REACH = 1.5;
const ATTACK_INTERVAL_TICKS = 4;
const ATTACK_DAMAGE_SCALE = 0.25;

/** Need levels at which the survival-critical homeostatic override engages. */
const CRITICAL_THIRST = 85;
const CRITICAL_HUNGER = 80;

/** Window over which homeostatic change is accumulated before it becomes valence. */
const VALENCE_WINDOW = 0.5;

/** Vision refresh cadence for the (relatively expensive) water scan. */
const WATER_SCAN_INTERVAL = 4;

export interface Pregnancy {
  fatherId: number;
  conceptionTick: number;
  progress: number;
  embryoGenome: Genome;
  report: InheritanceReport;
  motherGenome: Genome;
  fatherGenome: Genome;
}

export interface MatingState {
  partnerId: number;
  progress: number;
}

/**
 * A human.
 *
 * There is no behaviour tree anywhere in this class. `think()` runs the neural
 * network; `act()` translates the resulting continuous motor command vector
 * into movement and into *proximity-gated* low-level actions. The gates exist so
 * that "press the eat output" only does something when there is actually food
 * within reach — that is a reflex, not a decision.
 */
export class Human {
  readonly kind = EntityKind.Human;

  id: number;
  name: string;
  sex: number;
  genome: Genome;
  brain: Brain;
  memory = new SocialMemory();

  x = 0;
  y = 0;
  heading = 0;
  /** Instantaneous locomotion speed in tiles/s (for animation + energy cost). */
  speed = 0;

  ageBio = 0;
  birthTick = 0;
  alive = true;
  deathTick: number | null = null;
  deathReason: string | null = null;
  stage: number = LifeStage.Baby;

  // physiology ---------------------------------------------------------
  health = 100;
  hunger = 0;
  thirst = 0;
  energy = 85;
  fatigue = 5;
  pain = 0;
  stress = 0;
  bodyTemperature = 6;
  comfort = 1;

  // construction -------------------------------------------------------
  /** Timber currently carried, 0..CARRY_CAPACITY. */
  wood = 0;
  /** Tick of the last felled unit of timber. */
  private lastHarvestTick = -1000;
  /** Tick of the last load of timber laid on a site. */
  private lastBuildTick = -1000;
  /** Set by `act` so the renderer can show a chopping or building pose. */
  harvesting = false;
  /** True on a tick spent sowing, reaping or digging, for the animation. */
  farming = false;
  building = false;
  /** Where this human was born; used for the "am I home" sense. */
  homeX = 0;
  homeY = 0;

  fertility01 = 0;
  libido = 0;

  pregnancy: Pregnancy | null = null;
  mating: MatingState | null = null;
  matingCooldown = 0;
  /** Ticks remaining of post-birth recovery. */
  recovery = 0;

  // brain I/O ----------------------------------------------------------
  readonly sensors = new Float32Array(SENSORY_COUNT);
  readonly motor = new Float32Array(MOTOR_COUNT);
  /** Valence used by the last plasticity update, for the inspector. */
  lastValence = 0;
  /** Homeostasis snapshot from the previous tick, for valence derivation. */
  private prevEnergy = 85;
  private prevThirst = 0;
  private prevPain = 0;
  private prevHealth = 100;
  private prevHunger = 0;
  private socialPulse = 0;
  /** Accumulator + window timer for the valence read-out. */
  private valenceAccumulator = 0;
  private valenceTimer = 0;
  private lastValenceValue = 0;

  // behaviour bookkeeping ----------------------------------------------
  actionIndex = 0;
  actionStrength = 0;
  currentAction = 'Idle';
  currentFocus = 'none';
  focusValue = 0;
  attacking = false;
  feeding = false;
  resting = false;
  sleeping = false;
  lastEatTick = -10000;
  lastDrinkTick = -10000;
  lastMateTick = -10000;
  private lastBiteTick = -10000;
  private lastAttackTick = -10000;
  private lastWaterScanTick = -10000;
  /** Water direction, ordered [front, right, back, left]. */
  private readonly waterDir = new Float32Array(4);
  /** Scratch accumulators for food / conspecific / threat, each [front, right, back, left]. */
  private readonly directionScratch = [
    new Float32Array(4),
    new Float32Array(4),
    new Float32Array(4),
    new Float32Array(4),
    new Float32Array(4),
    // v2: field, canal, forest
    new Float32Array(4),
    new Float32Array(4),
    new Float32Array(4),
  ];
  private attackTargetId: number | null = null;

  // genealogy ----------------------------------------------------------
  motherId: number | null = null;
  fatherId: number | null = null;
  childrenIds: number[] = [];
  generation = 0;
  /**
   * Which house this individual belongs to.
   *
   * Only meaningful in competitive mode, where the founding population is split
   * between two observers and every descendant inherits its mother's house. In
   * the ordinary single-observer world every human is house 0 and nothing reads
   * this.
   */
  house = 0;
  mateCount = 0;
  offspringCount = 0;

  // scratch ------------------------------------------------------------
  private readonly scratch: number[] = [];
  private readonly visibleIds: number[] = [];
  /** Deterministic per-entity stream; used only for sensory noise. */
  private readonly rng: Rng;

  constructor(id: number, name: string, sex: number, genome: Genome, rng: Rng) {
    this.id = id;
    this.name = name;
    this.sex = sex;
    this.genome = genome;
    this.rng = rng;
    this.brain = new Brain(genome);
    this.stage = LifeStage.Baby;
  }

  // ---------------------------------------------------------------------
  // Derived quantities
  // ---------------------------------------------------------------------

  /** 0..1 growth curve. Babies are small, adults are full size. */
  growth(): number {
    const t = clamp(this.ageBio / AGE_CHILD_END, 0, 1);
    return 0.38 + 0.62 * Math.pow(t, 0.7);
  }

  /** Visual/physical scale including the genome's own body size gene. */
  bodyScale(): number {
    let scale = this.growth() * this.genome.bodySize;
    if (this.ageBio > AGE_ADULT_END) {
      const decline = Math.min(1, (this.ageBio - AGE_ADULT_END) / 45);
      scale *= 1 - 0.04 * decline;
    }
    return scale;
  }

  speedFactor(): number {
    const stage = this.growth();
    const elder = this.ageBio > AGE_ADULT_END ? 1 - 0.3 * Math.min(1, (this.ageBio - AGE_ADULT_END) / 45) : 1;
    const energyFactor = 0.42 + 0.58 * clamp(this.energy / 100, 0, 1);
    const healthFactor = 0.5 + 0.5 * clamp(this.health / 100, 0, 1);
    const painFactor = 1 - 0.35 * clamp(this.pain / 100, 0, 1);
    return 0.45 + 0.55 * stage;
    // `elder`, `energyFactor`, `healthFactor` and `painFactor` are applied in act().
    void elder;
    void energyFactor;
    void healthFactor;
    void painFactor;
  }

  private locomotionFactor(): number {
    const elder = this.ageBio > AGE_ADULT_END ? 1 - 0.3 * Math.min(1, (this.ageBio - AGE_ADULT_END) / 45) : 1;
    const energyFactor = 0.42 + 0.58 * clamp(this.energy / 100, 0, 1);
    const healthFactor = 0.5 + 0.5 * clamp(this.health / 100, 0, 1);
    const painFactor = 1 - 0.35 * clamp(this.pain / 100, 0, 1);
    const loadFactor = 1 - 0.22 * this.growth();
    void loadFactor;
    return elder * energyFactor * healthFactor * painFactor;
  }

  isFemale(): boolean {
    return this.sex === Sex.Female;
  }

  isAdult(): boolean {
    return this.ageBio >= AGE_CHILD_END;
  }

  isFertile(): boolean {
    return this.fertility01 > 0.05;
  }

  canMate(): boolean {
    return (
      this.alive &&
      this.ageBio >= AGE_CHILD_END &&
      this.fertility01 > 0.12 &&
      this.libido > 0.18 &&
      this.mating === null &&
      this.pregnancy === null &&
      this.matingCooldown <= 0 &&
      this.recovery <= 0 &&
      this.health > 35
    );
  }

  /** Update the derived fertility/libido/comfort values. */
  updateDerived(dt: number): void {
    const mature = smoothstep(AGE_CHILD_END, AGE_CHILD_END + 1.6, this.ageBio);
    const female = this.isFemale();
    const endAge = female
      ? Math.min(this.genome.lifespan * 0.62, AGE_ADULT_END + 8)
      : Math.min(this.genome.lifespan * 0.78, AGE_ADULT_END + 18);
    const decline = 1 - smoothstep(endAge - 9, endAge, this.ageBio);
    this.fertility01 = clamp01(mature * decline * this.genome.fertility * (this.health / 100));

    const hunger01 = this.hunger / 100;
    const thirst01 = this.thirst / 100;
    const fatigue01 = this.fatigue / 100;
    const stress01 = this.stress / 100;
    // The suppressions are multiplicative, so they compound: with the original
    // coefficients a merely peckish, slightly tired adult ended up with a libido
    // around 0.5, a mate command below its action gate, and a world that reached
    // only nine matings in eighty simulated years.
    this.libido = clamp01(
      this.fertility01 *
        (0.4 + 0.6 * (1 - stress01 * 0.4)) *
        (1 - hunger01 * 0.35) *
        (1 - thirst01 * 0.35) *
        (1 - fatigue01 * 0.35) *
        (this.pregnancy ? 0 : 1),
    );

    if (this.matingCooldown > 0) this.matingCooldown -= dt;
    if (this.recovery > 0) this.recovery -= dt;

    // Thermal comfort: how far outside the genome's comfort band we are.
    const deviation = Math.abs(this.bodyTemperature - this.genome.tempOptimum);
    this.comfort = clamp01(1 - Math.max(0, deviation - this.genome.tempTolerance) / 8);
  }

  // ---------------------------------------------------------------------
  // Sensing
  // ---------------------------------------------------------------------

  /**
   * Fill the 32-channel sensory vector.
   *
   * Salience is modulated by internal state *upstream* of the network — a hungry
   * animal literally sees food more strongly. That is a physiological bias, and
   * it is one of the reasons the founders can survive at all with random
   * initial weights.
   */
  sense(world: SimWorld): void {
    const s = this.sensors;
    for (let i = 0; i < 32; i++) s[i] = 0;

    const vision = this.genome.visionRange * (0.55 + 0.45 * this.growth());
    const hunger01 = this.hunger / 100;
    const thirst01 = this.thirst / 100;
    const stress01 = this.stress / 100;

    // Egocentric direction accumulators, each ordered [front, right, back, left].
    const food = this.directionScratch[0];
    const conspecific = this.directionScratch[1];
    const threat = this.directionScratch[2];
    const woodDir = this.directionScratch[3];
    const buildDir = this.directionScratch[4];
    const fieldDir = this.directionScratch[5];
    const canalDir = this.directionScratch[6];
    const forestDir = this.directionScratch[7];
    food.fill(0);
    conspecific.fill(0);
    threat.fill(0);
    woodDir.fill(0);
    buildDir.fill(0);
    fieldDir.fill(0);
    canalDir.fill(0);
    forestDir.fill(0);
    let touch = 0;

    // Two different ranges for two different senses.
    //
    // Food is dense — thousands of plants — so a short range is both sufficient
    // and much cheaper. Water is sparse and often tens of tiles away, so it needs
    // a long range. Using one shared "foraging" radius of 76 tiles made every
    // human scan essentially every plant on the map every few ticks: at a
    // population of eighty that alone dominated the tick cost, and the simulation
    // crawled. This is also the more biologically sensible arrangement — you see
    // the berry bush in front of you and smell the river from across the valley.
    const foodRange = vision * 1.5;
    /**
     * Build-site sensing range.
     *
     * A human has to be able to find the village from the tree line, otherwise it
     * fells timber and then wanders off with it forever.
     */
    const buildRange = vision * 2.4;
    /**
     * Water sensing range.
     *
     * Water is sparse and often tens of tiles away, and scent carries much
     * further than vision. Without a long range the founders only noticed a river
     * once they were almost standing in it, wandered away, and died of thirst in
     * the middle of a fertile valley.
     */
    const waterRange = vision * 3.2;

    this.visibleIds.length = 0;
    let familiarity = 0;
    let attachment = 0;

    // --- edible plants ----------------------------------------------------
    //
    // The animal tracks the single *nearest* worthwhile food source rather than
    // accumulating every plant in range. Summing all of them made the directional
    // channels light up in every quadrant at once (there are thousands of plants),
    // which produced an ambiguous signal that steered nothing.
    let bestFoodDx = 0;
    let bestFoodDy = 0;
    let bestFoodDist = Infinity;
    let bestFoodValue = 0;
    let bestWoodDx = 0;
    let bestWoodDy = 0;
    let bestWoodDist = Infinity;
    let bestWoodTimber = 0;
    let bestWoodScore = 0;
    // One pass over the nearby plants feeds both the food and the timber senses.
    //
    // These were separate queries at first, which doubled the most expensive loop
    // in the simulation — every human scanning every nearby plant, twice, every
    // tick. Merging them costs one extra branch per plant and saves half the work.
    const plantCount = world.queryPlants(this.x, this.y, foodRange, this.scratch);
    for (let i = 0; i < plantCount; i++) {
      const plant = world.plants[this.scratch[i]];
      if (!plant) continue;
      const dx = plant.x - this.x;
      const dy = plant.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > foodRange) continue;
      if (dist < TOUCH_RANGE) touch = 1;

      if (plant.food >= 0.14 && dist < bestFoodDist) {
        bestFoodDist = dist;
        bestFoodDx = dx;
        bestFoodDy = dy;
        bestFoodValue = plant.food;
      }
      if (plant.timber > 0.05) {
        // Choose the tree by *value*, not by proximity. Selecting the nearest
        // one meant that once the trees around the village were stripped, the
        // network kept walking to the nearest stump instead of the untouched
        // stand a few tiles further on — so a logged area stayed logged and the
        // settlement never moved outward. Dividing by distance keeps a rich tree
        // reachable without letting it win from across the map.
        const score = Math.min(1, plant.timber / 1.5) / (dist + 1);
        if (score > bestWoodScore) {
          bestWoodScore = score;
          bestWoodDist = dist;
          bestWoodDx = dx;
          bestWoodDy = dy;
          bestWoodTimber = plant.timber;
        }
      }
    }
    if (bestFoodDist < Infinity) {
      // A resource already within reach stops pulling the animal forward. The
      // directional channel still reports "food is here", but its contribution
      // to locomotion collapses, which is what lets the consumption drive
      // (eat/drink) win the read-out and bring the animal to a halt. Without
      // this the search drive never switches off and the animal walks straight
      // past the river it is dying of thirst beside.
      const reachFactor = bestFoodDist > REACH ? 1 : 0.15;
      const weight = (1 - bestFoodDist / foodRange) * bestFoodValue * reachFactor;
      encodeDirection(bestFoodDx, bestFoodDy, this.heading, weight, food);
    }
    if (bestWoodDist < Infinity) {
      const reach = bestWoodDist > REACH ? 1 : 0.15;
      const weight = (1 - bestWoodDist / foodRange) * reach * Math.min(1, bestWoodTimber / 1.5);
      encodeDirection(bestWoodDx, bestWoodDy, this.heading, weight, woodDir);
    }

    // --- conspecifics -----------------------------------------------------
    //
    // Range is plain visual range. An earlier version extended it by libido (up
    // to ~2.2x) on the theory that a ready animal advertises over a longer range.
    // It measured *worse*: with a strong `human -> approach` prior, a long-range
    // social signal pulls animals away from food and water, and the seed that had
    // been thriving collapsed to three survivors inside twenty-five simulated
    // minutes. Mate search is a salience effect, not a range effect.
    const humanCount = world.queryHumans(this.x, this.y, vision, this.scratch);
    let nearestHumanDx = 0;
    let nearestHumanDy = 0;
    let nearestHumanDist = Infinity;
    for (let i = 0; i < humanCount; i++) {
      const other = world.humans[this.scratch[i]];
      if (!other || other === this || !other.alive) continue;
      const dx = other.x - this.x;
      const dy = other.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > vision) continue;
      if (dist < TOUCH_RANGE) touch = 1;
      this.visibleIds.push(other.id);
      const record = this.memory.get(other.id);
      if (record) {
        if (record.familiarity > familiarity) familiarity = record.familiarity;
        if (record.attachment > attachment) attachment = record.attachment;
      }
      if (dist < nearestHumanDist) {
        nearestHumanDist = dist;
        nearestHumanDx = dx;
        nearestHumanDy = dy;
      }
    }
    if (nearestHumanDist < Infinity) {
      // Mate search: a reproductively ready animal pays more attention to other
      // animals. Without this the inhabitants foraged past each other forever —
      // the mating diagnostics showed two willing adults coming within range
      // only once per ten thousand ticks.
      const mateSearch = 0.6 + this.libido;
      const weight = (1 - nearestHumanDist / vision) * this.genome.socialGain * mateSearch;
      encodeDirection(nearestHumanDx, nearestHumanDy, this.heading, weight, conspecific);
    }

    // --- threats ----------------------------------------------------------
    const predatorCount = world.queryPredators(this.x, this.y, vision, this.scratch);
    let nearestThreatDx = 0;
    let nearestThreatDy = 0;
    let nearestThreatDist = Infinity;
    let nearestThreatScale = 1;
    for (let i = 0; i < predatorCount; i++) {
      const predator = world.predators[this.scratch[i]];
      if (!predator || !predator.alive) continue;
      const dx = predator.x - this.x;
      const dy = predator.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > vision) continue;
      if (dist < TOUCH_RANGE) touch = 1;
      if (dist < nearestThreatDist) {
        nearestThreatDist = dist;
        nearestThreatDx = dx;
        nearestThreatDy = dy;
        nearestThreatScale = 0.5 + 0.5 * clamp(predator.bodyScale() / 3, 0, 1);
      }
    }
    if (nearestThreatDist < Infinity) {
      const weight = (1 - nearestThreatDist / vision) * nearestThreatScale;
      encodeDirection(nearestThreatDx, nearestThreatDy, this.heading, weight, threat);
    }

    // --- building sites ---------------------------------------------------
    //
    // A human only cares about sites that still want timber.
    let nearestSiteDx = 0;
    let nearestSiteDy = 0;
    let nearestSiteDist = Infinity;
    let siteNeed = 0;
    const siteScan = world.queryStructures(this.x, this.y, buildRange, this.scratch);
    for (let i = 0; i < siteScan; i++) {
      const site = world.structures[this.scratch[i]];
      if (!site || site.complete) continue;
      const dx = site.x - this.x;
      const dy = site.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > buildRange) continue;
      if (dist < nearestSiteDist) {
        nearestSiteDist = dist;
        nearestSiteDx = dx;
        nearestSiteDy = dy;
        siteNeed = site.need;
      }
    }
    if (nearestSiteDist < Infinity) {
      const reach = nearestSiteDist > REACH ? 1 : 0.15;
      const weight = (1 - nearestSiteDist / buildRange) * reach;
      encodeDirection(nearestSiteDx, nearestSiteDy, this.heading, weight, buildDir);
    }

    // Directional timber and build-site sensing.
    //
    // These eight channels were declared, computed into `woodDir`/`buildDir`
    // and then never written into the sensory array — so the network saw only
    // the scalar `woodCarried` and `buildNeed` channels and had no idea *where*
    // the trees or the building site were. Huts still got built, but by
    // wandering into a site rather than by steering toward one, which is why
    // construction was slow and why a stripped stand never sent anyone looking
    // further afield. Writing them is what makes the directional sensing the
    // channel table already promises actually reach the brain.
    s[S.woodFront] = clamp01(woodDir[0]);
    s[S.woodRight] = clamp01(woodDir[1]);
    s[S.woodBack] = clamp01(woodDir[2]);
    s[S.woodLeft] = clamp01(woodDir[3]);
    s[S.buildFront] = clamp01(buildDir[0]);
    s[S.buildRight] = clamp01(buildDir[1]);
    s[S.buildBack] = clamp01(buildDir[2]);
    s[S.buildLeft] = clamp01(buildDir[3]);
    // --- v2: fields, canals, forest ---------------------------------------
    let fieldNeed = 0;
    let fieldGrowth = 0;
    let irrigationNeed = 0;
    let nearestFieldDist = Infinity;
    let nearestFieldDx = 0;
    let nearestFieldDy = 0;
    const fieldScan = world.queryFields(this.x, this.y, buildRange, this.scratch);
    for (let i = 0; i < fieldScan; i++) {
      const field = world.fields[this.scratch[i]];
      if (!field) continue;
      const dx = field.x - this.x;
      const dy = field.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > buildRange) continue;
      if (dist < nearestFieldDist) {
        nearestFieldDist = dist;
        nearestFieldDx = dx;
        nearestFieldDy = dy;
        fieldNeed = field.needsSowing ? 1 : 0;
        fieldGrowth = field.growthFraction;
        // Ground that is drying out with no water reaching it wants a canal.
        irrigationNeed = field.moisture < 0.35 ? 1 - field.moisture : 0;
      }
    }
    if (nearestFieldDist < Infinity) {
      const reach = nearestFieldDist > REACH ? 1 : 0.15;
      const weight = (1 - nearestFieldDist / buildRange) * reach;
      encodeDirection(nearestFieldDx, nearestFieldDy, this.heading, weight, fieldDir);
    } else {
      // No field anywhere in range: a mild signal that breaking ground is worth
      // doing. Kept well below the value for a field that actually wants sowing,
      // so tending something that exists always beats starting something new.
      fieldNeed = 0.45;
    }

    let nearestCanalDist = Infinity;
    let nearestCanalDx = 0;
    let nearestCanalDy = 0;
    const canalScan = world.queryCanals(this.x, this.y, buildRange, this.scratch);
    for (let i = 0; i < canalScan; i++) {
      const canal = world.canals[this.scratch[i]];
      if (!canal || canal.complete) continue;
      const dx = canal.x - this.x;
      const dy = canal.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > buildRange) continue;
      if (dist < nearestCanalDist) {
        nearestCanalDist = dist;
        nearestCanalDx = dx;
        nearestCanalDy = dy;
      }
    }
    if (nearestCanalDist < Infinity) {
      const reach = nearestCanalDist > REACH ? 1 : 0.15;
      const weight = (1 - nearestCanalDist / buildRange) * reach;
      encodeDirection(nearestCanalDx, nearestCanalDy, this.heading, weight, canalDir);
    }

    const forest = world.nearestForest(this.x, this.y, buildRange);
    if (forest) {
      const reach = forest.distance > REACH ? 1 : 0.15;
      const weight = (1 - forest.distance / buildRange) * reach;
      encodeDirection(forest.dx, forest.dy, this.heading, weight, forestDir);
    }

    s[S.forestFront] = clamp01(forestDir[0]);
    s[S.forestRight] = clamp01(forestDir[1]);
    s[S.forestBack] = clamp01(forestDir[2]);
    s[S.forestLeft] = clamp01(forestDir[3]);
    s[S.fieldFront] = clamp01(fieldDir[0]);
    s[S.fieldRight] = clamp01(fieldDir[1]);
    s[S.fieldBack] = clamp01(fieldDir[2]);
    s[S.fieldLeft] = clamp01(fieldDir[3]);
    s[S.canalFront] = clamp01(canalDir[0]);
    s[S.canalRight] = clamp01(canalDir[1]);
    s[S.canalBack] = clamp01(canalDir[2]);
    s[S.canalLeft] = clamp01(canalDir[3]);
    // Soil moisture underfoot, so a human standing on dry ground can tell.
    s[S.soilMoisture] = clamp01(1 - world.waterDistanceAt(this.x, this.y) / 12);
    s[S.fieldNeed] = clamp01(fieldNeed);
    s[S.fieldGrowth] = clamp01(fieldGrowth);
    s[S.irrigationNeed] = clamp01(irrigationNeed);
    // Seed is not a separate inventory: a settlement that has timber and fields
    // has seed. Kept as its own channel so the brain can gate sowing on it.
    s[S.seeds] = clamp01(0.7);
    s[S.cropReady] = clamp01(fieldGrowth >= 1 ? 1 : 0);
    s[S.storedFood] = 0;
    s[S.settlementStage] = 0;

    s[S.woodCarried] = clamp01(this.wood / CARRY_CAPACITY);
    s[S.buildNeed] = clamp01(siteNeed);
    s[S.shelter] = clamp01(this.shelterFactor(world));
    s[S.dayPhase] = clamp01(world.climate.dayPhase);

    // --- water ------------------------------------------------------------
    this.scanWater(world, waterRange);
    // Same "search terminates on contact" rule as for food: standing at the
    // water's edge must stop driving locomotion, or the animal walks the
    // shoreline forever without ever lowering its head to drink.
    const waterReach = this.nearWater(world, 3) ? 0.15 : 1;

    // --- write channels ---------------------------------------------------
    const foodSalience = 0.22 + 0.78 * hunger01;
    const waterSalience = (0.22 + 0.78 * thirst01) * waterReach;
    const threatSalience = 0.4 + 0.6 * stress01;

    // Directional salience. The multiplier is generous because the motor
    // command is read as "drive above an adapting baseline": a sensory channel
    // that only reaches 0.15 produces a walk of a few centimetres per second.
    //
    // Urgency rises steeply once a need is more than 60% satisfied, so an
    // animal in trouble homes in on the resource far more aggressively than a
    // comfortable one. This is homeostatic gain control on the sensory pathway.
    const urgency = 1 + 1.6 * Math.max(0, (Math.max(hunger01, thirst01) - 0.6) / 0.4);
    const directionalGain = 2.6 * urgency;
    s[S.foodFront] = clamp01(food[0] * foodSalience * directionalGain);
    s[S.foodRight] = clamp01(food[1] * foodSalience * directionalGain);
    s[S.foodBack] = clamp01(food[2] * foodSalience * directionalGain);
    s[S.foodLeft] = clamp01(food[3] * foodSalience * directionalGain);
    s[S.waterFront] = clamp01(this.waterDir[0] * waterSalience * directionalGain);
    s[S.waterRight] = clamp01(this.waterDir[1] * waterSalience * directionalGain);
    s[S.waterBack] = clamp01(this.waterDir[2] * waterSalience * directionalGain);
    s[S.waterLeft] = clamp01(this.waterDir[3] * waterSalience * directionalGain);
    s[S.humanFront] = clamp01(conspecific[0]);
    s[S.humanRight] = clamp01(conspecific[1]);
    s[S.humanBack] = clamp01(conspecific[2]);
    s[S.humanLeft] = clamp01(conspecific[3]);
    s[S.threatFront] = clamp01(threat[0] * threatSalience);
    s[S.threatRight] = clamp01(threat[1] * threatSalience);
    s[S.threatBack] = clamp01(threat[2] * threatSalience);
    s[S.threatLeft] = clamp01(threat[3] * threatSalience);

    s[S.touch] = touch;
    s[S.pain] = clamp01(this.pain / 100);
    const tempDeviation = this.bodyTemperature - this.genome.tempOptimum;
    const tolerance = this.genome.tempTolerance;
    s[S.cold] = clamp01((-tempDeviation - tolerance) / tolerance);
    s[S.heat] = clamp01((tempDeviation - tolerance) / tolerance);
    s[S.light] = world.climate.light;
    s[S.hunger] = clamp01(hunger01);
    s[S.thirst] = clamp01(thirst01);
    s[S.fatigue] = clamp01(this.fatigue / 100);
    s[S.energy] = clamp01(1 - this.energy / 100);
    s[S.health] = clamp01(1 - this.health / 100);
    s[S.stress] = clamp01(stress01);
    s[S.libido] = this.libido;
    s[S.fertility] = this.fertility01 * 0.7;
    s[S.familiarity] = familiarity;
    s[S.attachment] = attachment;
    s[S.noise] = hash01(this.id * 2654435761 + world.tick * 40503);

    // Current sensory focus, purely for the inspector.
    let focusIndex = -1;
    let focusValue = 0;
    for (let i = 0; i < 32; i++) {
      if (i === S.noise) continue;
      if (s[i] > focusValue) {
        focusValue = s[i];
        focusIndex = i;
      }
    }
    this.currentFocus = focusIndex >= 0 ? SENSORY_NAMES[focusIndex] : 'none';
    this.focusValue = focusValue;

    // Remember who we saw. Encounters nudge valence toward the current
    // physiological situation rather than toward a scripted like/dislike.
    const wellbeing = this.wellbeing();
    for (let i = 0; i < this.visibleIds.length; i++) {
      const otherId = this.visibleIds[i];
      const related = world.relatedness(this.id, otherId);
      const valenceDelta = (wellbeing - 0.5) * 0.05;
      const attachmentDelta = 0.5 + wellbeing;
      this.memory.observe(otherId, world.tick, world.dt, related, valenceDelta, attachmentDelta);
    }
    this.socialPulse = clamp01(this.visibleIds.length / 4);
  }

  /**
   * Coarse water scan. Refreshed every few ticks to stay cheap.
   *
   * Casts rays outward and records the *first* water tile hit on each ray; the
   * ray with the shortest range wins. Taking the maximum over every water tile
   * in range instead lit up front, left and right simultaneously whenever the
   * animal stood near a large body of water, which is useless as a steering
   * signal. A nearest-hit ray cast gives one unambiguous bearing.
   */
  private scanWater(world: SimWorld, range: number): void {
    if (world.tick - this.lastWaterScanTick < WATER_SCAN_INTERVAL) return;
    this.lastWaterScanTick = world.tick;

    const out = this.waterDir;
    out.fill(0);

    const spokes = 16;
    const step = 1.5;
    let bestDistance = Infinity;
    let bestAngle = 0;

    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke / spokes) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let distance = 1.5; distance <= range; distance += step) {
        if (isWater(tileAt(world.terrain, this.x + cos * distance, this.y + sin * distance))) {
          if (distance < bestDistance) {
            bestDistance = distance;
            bestAngle = angle;
          }
          break;
        }
      }
    }

    if (bestDistance < Infinity) {
      // Scent grows fainter with distance.
      const intensity = clamp01(1 - bestDistance / range);
      encodeDirection(Math.cos(bestAngle), Math.sin(bestAngle), this.heading, intensity, out);
    }
  }

  /** 0..1 summary of how well the body is doing right now. */
  wellbeing(): number {
    return clamp01(
      0.34 * (this.energy / 100) +
        0.2 * (1 - this.hunger / 100) +
        0.18 * (1 - this.thirst / 100) +
        0.16 * (this.health / 100) +
        0.06 * (1 - this.fatigue / 100) +
        0.06 * (1 - this.pain / 100),
    );
  }

  // ---------------------------------------------------------------------
  // Thinking
  // ---------------------------------------------------------------------

  /** Run the neural network for one tick. */
  think(world: SimWorld): void {
    const valence = this.computeValence(world.dt);
    this.brain.step(this.sensors, valence);
    this.brain.readMotor(this.motor);
    this.brain.applyPlasticity(this.genome.plasticity, valence * this.genome.neuromodGain);
    this.lastValence = valence;

    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < this.motor.length; i++) {
      const scaled = i === M.attack ? this.motor[i] * this.genome.aggressionGain : this.motor[i];
      if (scaled > bestValue) {
        bestValue = scaled;
        best = i;
      }
    }
    this.actionIndex = best;
    this.actionStrength = clamp01(bestValue);

    // Capture the homeostasis baseline for the next tick's valence.
    this.prevEnergy = this.energy;
    this.prevThirst = this.thirst;
    this.prevPain = this.pain;
    this.prevHealth = this.health;
    this.prevHunger = this.hunger;
    void world;
  }

  /**
   * Homeostasis-derived valence — the "third factor" of the plasticity rule.
   *
   * This is NOT a hand-authored reward table. It is the sign and magnitude of
   * physiological change, accumulated over a short window and then read out.
   *
   * The window matters. Homeostatic changes per tick are tiny (~5e-4), so a
   * per-tick valence is dominated by whatever constant term happens to be in the
   * expression. An earlier version included an unconditioned "social contact"
   * bonus, which made valence permanently positive: every synapse in the brain
   * then grew to its clamp, motor drives reached ~17 instead of ~1, and every
   * motor saturated at full command. Accumulating the real deltas over half a
   * second gives a signal that is quiet while nothing is happening and spikes
   * sharply when the animal actually eats, drinks or is hurt.
   */
  computeValence(dt: number): number {
    const dEnergy = (this.energy - this.prevEnergy) / 100;
    const dThirst = (this.prevThirst - this.thirst) / 100;
    const dPain = (this.prevPain - this.pain) / 100;
    const dHealth = (this.health - this.prevHealth) / 100;
    const dHunger = (this.prevHunger - this.hunger) / 100;

    this.valenceAccumulator += dEnergy * 1.6 + dThirst * 1.2 + dPain * 2.4 + dHealth * 1.4 + dHunger * 0.8;
    this.valenceTimer += dt;

    if (this.valenceTimer < VALENCE_WINDOW) return this.lastValenceValue;

    const value = clamp(this.valenceAccumulator * 6, -1, 1);
    this.valenceAccumulator = 0;
    this.valenceTimer = 0;
    this.lastValenceValue = value;
    return value;
  }

  // ---------------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------------

  /** Translate the motor command vector into world interactions. */
  act(world: SimWorld, dt: number): void {
    if (!this.alive) return;
    const m = this.motor;

    // --- mating locks locomotion -----------------------------------------
    if (this.mating) {
      this.speed = 0;
      this.resting = false;
      this.sleeping = false;
      this.currentAction = 'Mating';
      this.actionStrength = this.mating.progress;
      return;
    }

    const forward = clamp(m[M.moveFwd] - m[M.moveBack], -1, 1);
    const turn = clamp(m[M.turnRight] - m[M.turnLeft], -1, 1);
    const sprint = 1 + 0.8 * m[M.sprint];

    this.resting = m[M.rest] > 0.45;
    this.sleeping = this.resting && world.climate.light < 0.28 && this.fatigue > 25;

    this.heading = normalizeAngle(this.heading + turn * TURN_RATE * dt);

    const stageScale = this.speedFactor();
    let desired = forward * BASE_SPEED * this.genome.speed * stageScale * sprint;
    desired *= this.locomotionFactor();
    if (this.resting) desired *= 0.25;
    if (this.pain > 45) desired *= 0.7;

    this.speed = desired;
    const moved = this.move(world, desired * dt);

    // Obstacle-avoidance reflex: if the body is driving forward but not
    // actually moving, something solid is in the way. Turning away is a spinal
    // reflex in every animal that has ever walked into a wall, and without it
    // the founders pinned themselves against rocks and starved facing a cliff.
    if (!moved && Math.abs(desired) > 0.35) {
      this.heading = normalizeAngle(this.heading + STUCK_TURN_RATE * dt);
    }

    // --- proximity-gated low-level actions --------------------------------
    //
    // Consumption deliberately does NOT compete with locomotion. An animal can
    // graze or drink while walking; making `eat` fight `move-forward` for
    // control of the legs meant that a hungry founder either walked past its
    // food or froze next to nothing. The gates below are driven by need, and the
    // `try*` methods additionally require the resource to actually be present.
    this.attacking = false;
    this.feeding = false;

    if (m[M.eat] > 0.25) this.tryEat(world);
    if (m[M.drink] > 0.25) this.tryDrink(world, dt);
    // Violence is possible but rare: only an individual whose aggression gene is
    // high *and* whose network is driving the attack output hard can actually
    // strike. Emergent violence between humans is a legitimate outcome of a
    // heritable trait, but it should not be the leading cause of death.
    if (m[M.attack] * this.genome.aggressionGain > 1.0) this.tryAttack(world);

    // Construction. Proximity-gated like eating rather than competing with
    // locomotion: carrying a log does not stop you walking.
    this.harvesting = false;
    this.building = false;
    if (m[M.harvest] > 0.3) this.tryHarvest(world);
    if (m[M.build] > 0.3) this.tryBuild(world);
    if (m[M.plant] > 0.3) this.trySow(world);
    if (m[M.tend] > 0.3) this.tryTend(world);
    if (m[M.dig] > 0.3) this.tryDig(world);

    // Survival-critical homeostatic override.
    //
    // When a need becomes life-threatening, the consummatory reflex fires
    // regardless of what the cortex is doing. This is brainstem-level
    // homeostatic modulation — the same class of reflex as the nociceptive
    // withdrawal pathway — and it is what stops an animal that has wandered
    // away from water from dying of thirst while its network is busy doing
    // something else. It only engages in the last ~12% of the need range; below
    // that, behaviour is entirely whatever the network produces.
    if (this.thirst > CRITICAL_THIRST && this.nearWater(world, 3)) {
      this.thirst = clamp(this.thirst - 45 * dt, 0, 100);
      this.lastDrinkTick = world.tick;
      this.feeding = true;
    }
    if (this.hunger > CRITICAL_HUNGER) this.tryEat(world, true);

    this.currentAction = this.describeAction();
  }

  private move(world: SimWorld, distance: number): boolean {
    if (distance === 0) return false;
    const dx = Math.cos(this.heading) * distance;
    const dy = Math.sin(this.heading) * distance;
    const nx = this.x + dx;
    const ny = this.y + dy;

    // Axis-separated collision so entities slide along obstacles.
    let moved = false;
    if (canStand(world, nx, ny)) {
      this.x = nx;
      this.y = ny;
      moved = true;
    } else if (canStand(world, nx, this.y)) {
      this.x = nx;
      moved = true;
    } else if (canStand(world, this.x, ny)) {
      this.y = ny;
      moved = true;
    } else {
      this.speed = 0;
    }
    this.x = clamp(this.x, 0.5, world.terrain.width - 0.5);
    this.y = clamp(this.y, 0.5, world.terrain.height - 0.5);
    return moved;
  }

  /**
   * Fell timber from the nearest tree.
   *
   * Costs energy and builds fatigue, so chopping is work rather than a free
   * action. The human stops when it is carrying a full load, which is what sends
   * it back to the village.
   */
  private tryHarvest(world: SimWorld): void {
    if (this.wood >= CARRY_CAPACITY) return;
    if (world.tick - this.lastHarvestTick < HARVEST_INTERVAL_TICKS) return;
    if (this.stage === LifeStage.Baby) return;

    const count = world.queryPlants(this.x, this.y, REACH + 0.6, this.scratch);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const index = this.scratch[i];
      const plant = world.plants[index];
      if (!plant || plant.timber <= 0.05) continue;
      const distance = Math.hypot(plant.x - this.x, plant.y - this.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) return;

    const wanted = Math.min(1.4, CARRY_CAPACITY - this.wood);
    const taken = world.harvestWood(bestIndex, wanted);
    if (taken <= 0) return;

    this.wood = Math.min(CARRY_CAPACITY, this.wood + taken);
    this.lastHarvestTick = world.tick;
    this.harvesting = true;
    this.energy = clamp(this.energy - taken * 1.6, 0, 100);
    this.fatigue = clamp(this.fatigue + taken * 2.2, 0, 100);
    this.stress = clamp(this.stress + taken * 0.6, 0, 100);
  }

  /**
   * Lay carried timber on the nearest incomplete building site.
   *
   * A human with a full load and no site in range will found one where it
   * stands, provided it is standing in the village. That is the only "rule"
   * about construction in the whole simulation — who builds, when, and how much
   * is entirely up to each individual's network.
   */
  /**
   * Whether there is real standing timber within founding distance.
   *
   * Lets a human start a hut out at the tree line instead of only around the
   * village centre, so the settlement grows toward its building material.
   */
  private standingInTimber(world: SimWorld): boolean {
    const count = world.queryPlants(this.x, this.y, FRONTIER_BUILD_RANGE, this.scratch);
    for (let i = 0; i < count; i++) {
      const plant = world.plants[this.scratch[i]];
      if (plant && plant.timber > 0.5) return true;
    }
    return false;
  }

  private tryBuild(world: SimWorld): void {
    if (this.wood <= 0) return;
    if (world.tick - this.lastBuildTick < BUILD_INTERVAL_TICKS) return;

    const count = world.queryStructures(this.x, this.y, REACH + 1.2, this.scratch);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const index = this.scratch[i];
      const site = world.structures[index];
      if (!site || site.complete) continue;
      const distance = Math.hypot(site.x - this.x, site.y - this.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) {
      // No site within reach — found one, but only within the village's current
      // reach. That reach grows with the settlement, and a human standing in
      // timber may found a hut out at the tree line regardless.
      const centre = world.settlementCentre;
      if (!centre) return;
      const distanceHome = Math.hypot(this.x - centre.x, this.y - centre.y);
      const reach =
        VILLAGE_RADIUS + Math.min(MAX_VILLAGE_GROWTH, world.structures.length * VILLAGE_GROWTH_PER_STRUCTURE);
      const withinReach = distanceHome <= reach;

      // Beyond the village's own reach, a hut may still be founded as a
      // continuation of it: beside a structure that already stands, and standing
      // in timber. Each new hut has to adjoin the last, so the settlement reaches
      // out toward the forest as a connected edge rather than scattering single
      // huts across the island.
      const extension =
        !withinReach &&
        distanceHome <= ABSOLUTE_VILLAGE_LIMIT &&
        world.queryStructures(this.x, this.y, VILLAGE_EXTENSION_RANGE, this.scratch) > 0 &&
        this.standingInTimber(world);

      if (!withinReach && !extension) return;
      const founded = world.foundStructure(this.x, this.y, this);
      if (!founded) return;
      return;
    }

    const laid = world.contributeWood(bestIndex, Math.min(BUILD_CHUNK, this.wood), this);
    if (laid <= 0) return;
    this.wood -= laid;
    this.lastBuildTick = world.tick;
    this.building = true;
    this.energy = clamp(this.energy - laid * 1.1, 0, 100);
    this.fatigue = clamp(this.fatigue + laid * 1.4, 0, 100);
  }

  /**
   * Sow a field, or break new ground for one.
   *
   * Farming is only ever an *addition* to foraging, never a replacement: a
   * settlement that cannot find wild food still eats. Fields are what turn a
   * surplus into something worth staying for.
   */
  private trySow(world: SimWorld): void {
    if (this.stage === LifeStage.Baby) return;

    // Sow an existing field that is waiting.
    const fieldCount = world.queryFields(this.x, this.y, REACH + 1.2, this.scratch);
    for (let i = 0; i < fieldCount; i++) {
      const index = this.scratch[i];
      const field = world.fields[index];
      if (!field || !field.needsSowing) continue;
      if (world.sowField(index, this)) {
        this.farming = true;
        this.energy = clamp(this.energy - 1.4, 0, 100);
        this.fatigue = clamp(this.fatigue + 2, 0, 100);
        return;
      }
    }

    // Otherwise break new ground, but only within the settlement's reach.
    const centre = world.settlementCentre;
    if (!centre) return;
    if (Math.hypot(this.x - centre.x, this.y - centre.y) > ABSOLUTE_VILLAGE_LIMIT) return;
    const founded = world.foundField(this.x, this.y, this);
    if (founded) {
      this.farming = true;
      this.fatigue = clamp(this.fatigue + 2.5, 0, 100);
    }
  }

  /** Bring in a ripe crop. */
  private tryTend(world: SimWorld): void {
    if (this.stage === LifeStage.Baby) return;
    const count = world.queryFields(this.x, this.y, REACH + 1.2, this.scratch);
    for (let i = 0; i < count; i++) {
      const index = this.scratch[i];
      const field = world.fields[index];
      if (!field || !field.ripe) continue;
      if (world.harvestField(index, this)) {
        this.farming = true;
        this.energy = clamp(this.energy - 1.8, 0, 100);
        this.fatigue = clamp(this.fatigue + 2.4, 0, 100);
        return;
      }
    }
  }

  /**
   * Dig, or start digging.
   *
   * A length under construction is finished first; otherwise a new one is staked
   * out. The world refuses a length that does not adjoin water or an existing
   * canal, so a line has to be dug outward from the river rather than appearing
   * wherever someone happens to stand.
   */
  private tryDig(world: SimWorld): void {
    if (this.stage === LifeStage.Baby) return;

    const count = world.queryCanals(this.x, this.y, REACH + 1.2, this.scratch);
    for (let i = 0; i < count; i++) {
      const index = this.scratch[i];
      const canal = world.canals[index];
      if (!canal || canal.complete) continue;
      if (world.digCanal(index, this)) {
        this.farming = true;
        this.energy = clamp(this.energy - 2.2, 0, 100);
        this.fatigue = clamp(this.fatigue + 3, 0, 100);
        return;
      }
    }

    const centre = world.settlementCentre;
    if (!centre) return;
    if (Math.hypot(this.x - centre.x, this.y - centre.y) > ABSOLUTE_VILLAGE_LIMIT * 1.4) return;
    const founded = world.foundCanal(this.x, this.y, this);
    if (founded) this.farming = true;
  }

  /** How sheltered this human currently is: 1 beside a finished hut, else less. */
  private shelterFactor(world: SimWorld): number {
    const count = world.queryStructures(this.x, this.y, 5, this.scratch);
    let best = 0;
    for (let i = 0; i < count; i++) {
      const site = world.structures[this.scratch[i]];
      if (!site || !site.complete) continue;
      const distance = Math.hypot(site.x - this.x, site.y - this.y);
      const factor = clamp01(1 - distance / 5);
      if (factor > best) best = factor;
    }
    return best;
  }

  private tryEat(world: SimWorld, forced = false): void {
    if (world.tick - this.lastBiteTick < BITE_INTERVAL_TICKS) return;
    if (!forced && this.hunger < 8 && this.energy > 92) return;

    const count = world.queryPlants(this.x, this.y, REACH, this.scratch);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const index = this.scratch[i];
      const plant = world.plants[index];
      if (!plant || plant.food < 0.1) continue;
      const distance = Math.hypot(plant.x - this.x, plant.y - this.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) return;

    const taken = world.consumePlant(bestIndex, BITE_SIZE);
    if (taken <= 0) return;

    this.hunger = clamp(this.hunger - taken * HUNGER_PER_FOOD, 0, 100);
    this.energy = clamp(this.energy + taken * ENERGY_PER_FOOD, 0, 100);
    this.lastBiteTick = world.tick;
    this.lastEatTick = world.tick;
    this.feeding = true;
    this.pain = Math.max(0, this.pain - taken * 10);
  }

  private tryDrink(world: SimWorld, dt: number): void {
    if (this.thirst < 4) return;
    // Generous reach: an animal that is moving at speed only spends a couple of
    // seconds within range of a shoreline, and it has to be able to drink in
    // that window.
    if (!this.nearWater(world, 2.2)) return;
    this.thirst = clamp(this.thirst - 45 * dt, 0, 100);
    this.lastDrinkTick = world.tick;
    this.feeding = true;
  }

  /**
   * Is there fresh water within `radius` tiles?
   *
   * Implemented as a tile neighbourhood scan rather than a ring of sample points.
   * With only eight samples on a circle of radius 1.6 the samples are ~1.3 tiles
   * apart, so a shoreline could sit *between* two samples and the animal would
   * conclude there was no water while standing on the beach. That is precisely
   * how several founders died of thirst with a river at their feet.
   */
  private nearWater(world: SimWorld, radius: number): boolean {
    const span = Math.max(1, Math.round(radius));
    const cx = Math.floor(this.x);
    const cy = Math.floor(this.y);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        if (isWater(tileAt(world.terrain, cx + dx + 0.5, cy + dy + 0.5))) return true;
      }
    }
    return false;
  }

  private tryAttack(world: SimWorld): void {
    if (world.tick - this.lastAttackTick < ATTACK_INTERVAL_TICKS) return;
    const count = world.queryHumans(this.x, this.y, ATTACK_REACH, this.scratch);
    let target: Human | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const other = world.humans[this.scratch[i]];
      if (!other || other === this || !other.alive) continue;
      const distance = Math.hypot(other.x - this.x, other.y - this.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        target = other;
      }
    }
    if (!target) return;

    const damage = this.genome.attackPower * ATTACK_DAMAGE_SCALE;
    world.damageHuman(target, damage, 'injuries', this.id);
    this.lastAttackTick = world.tick;
    this.attacking = true;
    this.attackTargetId = target.id;
    // Attacking someone is remembered by both parties, as a discrete event.
    this.memory.shock(target.id, world.tick, world.relatedness(this.id, target.id), -0.25, -0.02);
    target.memory.shock(this.id, world.tick, world.relatedness(this.id, target.id), -0.45, -0.06);
  }

  private describeAction(): string {
    const m = this.motor;
    if (this.mating) return 'Mating';
    if (this.pregnancy && this.pregnancy.progress > 0.6) return 'Carrying young';
    if (this.sleeping) return 'Sleeping';
    if (this.attacking) return 'Attacking';
    if (this.feeding && m[M.eat] > m[M.drink]) return 'Eating';
    if (this.feeding) return 'Drinking';
    if (this.resting) return 'Resting';
    if (m[M.mate] > 0.4 && this.isFertile()) return 'Seeking mate';
    if (m[M.interact] > 0.45) return 'Interacting';
    if (m[M.signal] > 0.5) return 'Vocalising';
    if (this.speed > 0.4) return 'Walking';
    if (this.speed < -0.4) return 'Backing away';
    if (Math.abs(this.speed) > 1.8) return 'Running';
    return 'Idle';
  }

  // ---------------------------------------------------------------------
  // Physiology
  // ---------------------------------------------------------------------

  updatePhysiology(world: SimWorld, dt: number): void {
    const metabolism = this.genome.metabolism;
    const growth = this.growth();
    const activity = Math.abs(this.speed) / (BASE_SPEED * 1.8);

    this.bodyTemperature = world.ambientTemperatureAt(this.x, this.y);
    this.updateDerived(dt);

    // Hunger / thirst / fatigue
    this.hunger = clamp(this.hunger + HUNGER_RATE * metabolism * dt, 0, 100);
    this.thirst = clamp(this.thirst + THIRST_RATE * metabolism * dt, 0, 100);

    if (this.resting) {
      const quality = this.sleeping ? 1.35 : 1;
      this.fatigue = clamp(this.fatigue - FATIGUE_REST_RATE * quality * dt, 0, 100);
    } else {
      this.fatigue = clamp(this.fatigue + FATIGUE_RATE * (0.6 + activity) * dt, 0, 100);
    }

    // Energy
    const drain = (ENERGY_DRAIN_BASE + ENERGY_DRAIN_MOVE * activity) * metabolism * (0.55 + 0.65 * growth);
    this.energy = clamp(this.energy - drain * dt, 0, 100);
    if (this.resting) {
      const quality = this.sleeping ? 1.3 : 1;
      this.energy = clamp(this.energy + ENERGY_REGEN_REST * quality * dt, 0, 100);
    }
    if (this.pregnancy) {
      this.energy = clamp(this.energy - 0.45 * this.pregnancy.progress * dt, 0, 100);
    }

    // Stress
    const thermalStress = 1 - this.comfort;
    const targetStress =
      100 *
      clamp01(
        0.34 * (this.hunger / 100) +
          0.3 * (this.thirst / 100) +
          0.22 * (this.pain / 100) +
          0.2 * thermalStress +
          0.14 * (this.fatigue / 100) +
          0.12 * (1 - this.health / 100),
      );
    this.stress += (targetStress - this.stress) * Math.min(1, dt * 1.5);
    this.stress = clamp(this.stress, 0, 100);

    this.pain = clamp(this.pain - PAIN_DECAY * dt, 0, 100);

    // Health
    let healthDelta = 0;
    if (this.hunger > 88) healthDelta -= STARVATION_DAMAGE * ((this.hunger - 88) / 12);
    if (this.thirst > 86) healthDelta -= DEHYDRATION_DAMAGE * ((this.thirst - 86) / 14);
    if (this.comfort < 0.35) healthDelta -= THERMAL_DAMAGE * (1 - this.comfort / 0.35);
    if (this.pain > 60) healthDelta -= 0.35 * ((this.pain - 60) / 40);

    const needsMet = this.hunger < 55 && this.thirst < 55 && this.comfort > 0.6;
    if (needsMet && healthDelta >= 0) {
      const senescense = this.ageBio > AGE_ADULT_END ? 0.55 : 1;
      healthDelta += HEALTH_REGEN * senescense * (0.5 + 0.5 * this.growth());
    }
    if (this.pregnancy) healthDelta -= 0.12;

    this.health = clamp(this.health + healthDelta * dt, 0, 100);

    // Ageing
    this.ageBio += dt / BIO_YEAR_SECONDS;
    this.updateStage();

    // Senescence hazard — a smooth mortality curve rather than a hard cut-off.
    const t = this.ageBio / this.genome.lifespan;
    if (t > 0.7) {
      const hazard = 2e-4 * Math.exp((t - 0.7) * 26);
      if (world.random() < hazard * dt) {
        this.health = 0;
        this.deathReason = 'old age';
      }
    }

    if (this.health <= 0) {
      if (!this.deathReason) {
        if (this.hunger > 88) this.deathReason = 'starvation';
        else if (this.thirst > 86) this.deathReason = 'dehydration';
        else if (this.comfort < 0.35) this.deathReason = 'exposure';
        else if (this.pain > 50) this.deathReason = 'injuries';
        else this.deathReason = 'unknown causes';
      }
    }
    if (this.ageBio >= AGE_MAX) {
      this.health = 0;
      this.deathReason = 'old age';
    }
  }

  private updateStage(): void {
    if (this.ageBio < AGE_BABY_END) this.stage = LifeStage.Baby;
    else if (this.ageBio < AGE_CHILD_END) this.stage = LifeStage.Child;
    else if (this.ageBio < AGE_ADULT_END) this.stage = LifeStage.Adult;
    else this.stage = LifeStage.Elder;
  }

  // ---------------------------------------------------------------------
  // Mating / pregnancy
  // ---------------------------------------------------------------------

  /** Advance a mating event. Returns true when it completes this tick. */
  advanceMating(dt: number): boolean {
    if (!this.mating) return false;
    this.mating.progress += dt / MATING_DURATION;
    if (this.mating.progress >= 1) {
      this.mating = null;
      this.matingCooldown = MATING_REFRACTORY;
      return true;
    }
    return false;
  }

  /** Terminate a mating event from the outside (partner died, god intervened). */
  cancelMating(): void {
    if (!this.mating) return;
    this.mating = null;
    this.matingCooldown = MATING_REFRACTORY * 0.4;
  }

  conceive(father: Human, world: SimWorld, embryoGenome: Genome, report: InheritanceReport): void {
    this.pregnancy = {
      fatherId: father.id,
      conceptionTick: world.tick,
      progress: 0,
      embryoGenome,
      report,
      motherGenome: cloneGenome(this.genome),
      fatherGenome: cloneGenome(father.genome),
    };
    this.mateCount += 1;
    father.mateCount += 1;
    this.memory.recordMating(father.id);
    father.memory.recordMating(this.id);
  }

  /** Returns true when gestation completes on this tick. */
  advancePregnancy(dt: number): boolean {
    if (!this.pregnancy) return false;
    const gestationSeconds = GESTATION_YEARS * BIO_YEAR_SECONDS;
    this.pregnancy.progress += dt / gestationSeconds;
    return this.pregnancy.progress >= 1;
  }

  /** Pregnancy progress in 0..1, or 0 when not pregnant. */
  pregnancyProgress(): number {
    return this.pregnancy ? clamp01(this.pregnancy.progress) : 0;
  }

  // ---------------------------------------------------------------------
  // Serialisation
  // ---------------------------------------------------------------------

  serialize(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      sex: this.sex,
      genome: this.genome,
      x: this.x,
      y: this.y,
      heading: this.heading,
      // `speed` feeds back into energy expenditure on the next tick, so it is
      // part of the dynamic state, not a render-only value.
      speed: this.speed,
      ageBio: this.ageBio,
      birthTick: this.birthTick,
      alive: this.alive,
      deathTick: this.deathTick,
      deathReason: this.deathReason,
      stage: this.stage,
      health: this.health,
      hunger: this.hunger,
      thirst: this.thirst,
      energy: this.energy,
      fatigue: this.fatigue,
      pain: this.pain,
      stress: this.stress,
      bodyTemperature: this.bodyTemperature,
      comfort: this.comfort,
      fertility01: this.fertility01,
      libido: this.libido,
      pregnancy: this.pregnancy,
      mating: this.mating,
      matingCooldown: this.matingCooldown,
      recovery: this.recovery,
      house: this.house,
      wood: this.wood,
      homeX: this.homeX,
      homeY: this.homeY,
      prevEnergy: this.prevEnergy,
      prevThirst: this.prevThirst,
      prevPain: this.prevPain,
      prevHealth: this.prevHealth,
      prevHunger: this.prevHunger,
      socialPulse: this.socialPulse,
      lastEatTick: this.lastEatTick,
      lastDrinkTick: this.lastDrinkTick,
      lastMateTick: this.lastMateTick,
      motherId: this.motherId,
      fatherId: this.fatherId,
      childrenIds: this.childrenIds,
      generation: this.generation,
      mateCount: this.mateCount,
      offspringCount: this.offspringCount,
      currentAction: this.currentAction,
      currentFocus: this.currentFocus,
      focusValue: this.focusValue,
      actionIndex: this.actionIndex,
      actionStrength: this.actionStrength,
      // Cached sensor + reflex state. Omitting any of this makes a restored
      // individual diverge on the very next tick: the water direction is cached
      // for several ticks, and the bite/attack timers are cooldowns.
      lastWaterScanTick: this.lastWaterScanTick,
      waterDir: Array.from(this.waterDir),
      lastBiteTick: this.lastBiteTick,
      lastAttackTick: this.lastAttackTick,
      valenceAccumulator: this.valenceAccumulator,
      valenceTimer: this.valenceTimer,
      lastValenceValue: this.lastValenceValue,
      memory: this.memory.serialize(),
      brain: this.brain.serialize(),
      rngState: this.rng.getState(),
    };
  }

  static deserialize(data: Record<string, unknown>, rng: Rng): Human {
    const genome = data.genome as Genome;
    const human = new Human(data.id as number, data.name as string, data.sex as number, genome, rng);
    human.x = data.x as number;
    human.y = data.y as number;
    human.heading = data.heading as number;
    human.speed = (data.speed as number) ?? 0;
    human.ageBio = data.ageBio as number;
    human.birthTick = data.birthTick as number;
    human.alive = data.alive as boolean;
    human.deathTick = (data.deathTick as number | null) ?? null;
    human.deathReason = (data.deathReason as string | null) ?? null;
    human.stage = data.stage as number;
    human.health = data.health as number;
    human.hunger = data.hunger as number;
    human.thirst = data.thirst as number;
    human.energy = data.energy as number;
    human.fatigue = data.fatigue as number;
    human.pain = data.pain as number;
    human.stress = data.stress as number;
    human.bodyTemperature = data.bodyTemperature as number;
    human.comfort = data.comfort as number;
    human.fertility01 = data.fertility01 as number;
    human.libido = data.libido as number;
    human.pregnancy = (data.pregnancy as Pregnancy | null) ?? null;
    human.mating = (data.mating as MatingState | null) ?? null;
    human.matingCooldown = data.matingCooldown as number;
    human.recovery = data.recovery as number;
    human.house = (data.house as number) ?? 0;
    human.wood = (data.wood as number) ?? 0;
    human.homeX = (data.homeX as number) ?? human.x;
    human.homeY = (data.homeY as number) ?? human.y;
    human.prevEnergy = data.prevEnergy as number;
    human.prevThirst = data.prevThirst as number;
    human.prevPain = data.prevPain as number;
    human.prevHealth = data.prevHealth as number;
    human.prevHunger = data.prevHunger as number;
    human.socialPulse = data.socialPulse as number;
    human.lastEatTick = data.lastEatTick as number;
    human.lastDrinkTick = data.lastDrinkTick as number;
    human.lastMateTick = data.lastMateTick as number;
    human.motherId = (data.motherId as number | null) ?? null;
    human.fatherId = (data.fatherId as number | null) ?? null;
    human.childrenIds = (data.childrenIds as number[]) ?? [];
    human.generation = data.generation as number;
    human.mateCount = data.mateCount as number;
    human.offspringCount = data.offspringCount as number;
    human.currentAction = (data.currentAction as string) ?? 'Idle';
    human.currentFocus = (data.currentFocus as string) ?? 'none';
    human.focusValue = (data.focusValue as number) ?? 0;
    human.actionIndex = (data.actionIndex as number) ?? 0;
    human.actionStrength = (data.actionStrength as number) ?? 0;
    human.lastWaterScanTick = (data.lastWaterScanTick as number) ?? -10000;
    const waterDir = data.waterDir as number[] | undefined;
    if (waterDir) for (let i = 0; i < 4; i++) human.waterDir[i] = waterDir[i] ?? 0;
    human.lastBiteTick = (data.lastBiteTick as number) ?? -10000;
    human.lastAttackTick = (data.lastAttackTick as number) ?? -10000;
    human.valenceAccumulator = (data.valenceAccumulator as number) ?? 0;
    human.valenceTimer = (data.valenceTimer as number) ?? 0;
    human.lastValenceValue = (data.lastValenceValue as number) ?? 0;
    human.memory.restore((data.memory as number[][]) ?? []);
    human.brain.restore(data.brain as number[], human.brain.synCount);
    if (Array.isArray(data.rngState)) human.rng.setState(data.rngState as number[]);
    return human;
  }
}

// ---------------------------------------------------------------------------

/**
 * Graded egocentric encoding of a direction vector.
 *
 * Instead of bucketing a target into one of four hard quadrants, the forward
 * component is `cos(relative angle)` and the lateral component is
 * `sin(relative angle)`. A target at 45 degrees therefore drives the front and
 * side channels equally, and the steering signal varies smoothly as the animal
 * turns. Hard quadrant bucketing produced a dead zone directly to the side and
 * an abrupt all-or-nothing switch at every boundary, which made the founders
 * twitch instead of steer.
 *
 * @param out ordered [front, right, back, left]
 */
function encodeDirection(dx: number, dy: number, heading: number, weight: number, out: Float32Array): void {
  if (weight <= 0) return;
  const relative = normalizeAngle(Math.atan2(dy, dx) - heading);
  const forward = Math.cos(relative);
  const lateral = Math.sin(relative);
  if (forward >= 0) {
    if (weight * forward > out[0]) out[0] = weight * forward;
  } else if (weight * -forward > out[2]) {
    out[2] = weight * -forward;
  }
  if (lateral >= 0) {
    if (weight * lateral > out[1]) out[1] = weight * lateral;
  } else if (weight * -lateral > out[3]) {
    out[3] = weight * -lateral;
  }
}

export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function canStand(world: SimWorld, x: number, y: number): boolean {
  const tile = tileAt(world.terrain, x, y);
  return tile !== Tile.Water && tile !== Tile.Rock;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Stateless deterministic hash in [0, 1). */
function hash01(n: number): number {
  let h = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export { MOTOR_NAMES, MOTOR_START, regionOf, EntityKind, type EventKind };
