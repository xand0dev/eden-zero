import { Rng } from '../rng';
import { Brain, clamp } from '../brain/network';
import { M, MOTOR_NAMES, MOTOR_START, S, SENSORY_NAMES, regionOf } from '../brain/channels';
import { SocialMemory } from '../memory/social';
import { cloneGenome, type Genome } from '../genetics/genome';
import type { InheritanceReport } from '../genetics/evolution';
import type { SimWorld } from './context';
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

/** Duration of a mating event, in simulated seconds. */
export const MATING_DURATION = 7;
/**
 * Ticks a human must wait after mating before it can mate again.
 *
 * Exported because the world owns the mating lifecycle (pairing, completion,
 * cooldowns) and duplicating the number there is how the two drifted apart
 * before.
 */
export const MATING_REFRACTORY = 38;

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

  fertility01 = 0;
  libido = 0;

  pregnancy: Pregnancy | null = null;
  mating: MatingState | null = null;
  matingCooldown = 0;
  /** Ticks remaining of post-birth recovery. */
  recovery = 0;

  // brain I/O ----------------------------------------------------------
  readonly sensors = new Float32Array(32);
  readonly motor = new Float32Array(12);
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
  private readonly directionScratch = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  private attackTargetId: number | null = null;

  // genealogy ----------------------------------------------------------
  motherId: number | null = null;
  fatherId: number | null = null;
  childrenIds: number[] = [];
  generation = 0;
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
    food.fill(0);
    conspecific.fill(0);
    threat.fill(0);
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
    const plantCount = world.queryPlants(this.x, this.y, foodRange, this.scratch);
    for (let i = 0; i < plantCount; i++) {
      const plant = world.plants[this.scratch[i]];
      if (!plant || plant.food < 0.14) continue;
      const dx = plant.x - this.x;
      const dy = plant.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > foodRange) continue;
      if (dist < TOUCH_RANGE) touch = 1;
      if (dist < bestFoodDist) {
        bestFoodDist = dist;
        bestFoodDx = dx;
        bestFoodDy = dy;
        bestFoodValue = plant.food;
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

    // --- conspecifics -----------------------------------------------------
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
