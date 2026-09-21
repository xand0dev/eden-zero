import { Rng } from '../rng';
import { Brain, clamp } from '../brain/network';
import { M, S } from '../brain/channels';
import type { Genome } from '../genetics/genome';
import { mutate } from '../genetics/evolution';
import type { SimWorld } from './context';
import { EntityKind, LifeStage, Sex } from '../../shared/types';
import { AGE_ADULT_END, AGE_CHILD_END, BIO_YEAR_SECONDS, AGE_MAX } from '../../shared/constants';
import { isWater, tileAt, Tile } from '../environment/terrain';
import { normalizeAngle } from './human';

/**
 * Predators.
 *
 * Per the brief they use *the same generic neural controller* as humans, with
 * different genome ranges, a different sensor mapping and a different
 * metabolism. There is no `if (humanNearby) chase()` anywhere: the predator's
 * `food.*` channels are simply wired to meat rather than to plants, and its
 * innate priors are the same hunger/approach/withdrawal reflexes.
 *
 * V0 simplification: predators reproduce parthenogenetically (budding) when
 * well fed rather than through a two-party mating event. This is documented in
 * docs/SIMULATION.md and does not change the neural architecture.
 */

const HUNGER_RATE = 0.55;
const FATIGUE_RATE = 0.9;
const FATIGUE_REST_RATE = 4.4;
const ENERGY_DRAIN_BASE = 0.44;
const ENERGY_DRAIN_MOVE = 1.75;
const ENERGY_REGEN_REST = 1.15;
const STARVATION_DAMAGE = 3.4;
const PAIN_DECAY = 2.2;
const HEALTH_REGEN = 0.35;

const BASE_SPEED = 3.75;
const TURN_RATE = 2.75;
const ATTACK_REACH = 1.75;
const ATTACK_INTERVAL_TICKS = 4;
const ATTACK_DAMAGE_SCALE = 0.25;
const REACH = 1.5;
const BITE_SIZE = 0.4;
const BITE_INTERVAL_TICKS = 6;
const HUNGER_PER_FOOD = 150;
const ENERGY_PER_FOOD = 105;

const REPRODUCTION_COOLDOWN = 900;
const REPRODUCTION_MIN_AGE = 4;
const WATER_SCAN_INTERVAL = 5;

export class Predator {
  readonly kind = EntityKind.Predator;

  id: number;
  name: string;
  genome: Genome;
  brain: Brain;

  x = 0;
  y = 0;
  heading = 0;
  speed = 0;

  ageBio = 0;
  birthTick = 0;
  alive = true;
  deathTick: number | null = null;
  deathReason: string | null = null;
  stage: number = LifeStage.Adult;
  generation = 0;

  health = 130;
  maxHealth = 130;
  hunger = 20;
  energy = 90;
  fatigue = 5;
  pain = 0;
  stress = 0;
  bodyTemperature = 6;

  readonly sensors = new Float32Array(32);
  readonly motor = new Float32Array(12);
  lastValence = 0;
  private prevEnergy = 90;
  private prevPain = 0;

  actionIndex = 0;
  currentAction = 'Roaming';
  feeding = false;
  resting = false;
  attacking = false;
  kills = 0;
  private lastBiteTick = -10000;
  private lastAttackTick = -10000;
  private lastReproductionTick = -10000;
  private lastWaterScanTick = -10000;
  private waterDir = { front: 0, right: 0, back: 0, left: 0 };
  private readonly scratch: number[] = [];
  private readonly rng: Rng;

  constructor(id: number, name: string, genome: Genome, rng: Rng) {
    this.id = id;
    this.name = name;
    this.genome = genome;
    this.rng = rng;
    this.brain = new Brain(genome);
    this.maxHealth = 130 * clamp(genome.bodySize, 0.8, 1.4);
    this.health = this.maxHealth;
  }

  bodyScale(): number {
    const juvenile = this.ageBio < AGE_CHILD_END ? 0.55 + 0.45 * (this.ageBio / AGE_CHILD_END) : 1;
    return this.genome.bodyScale * juvenile;
  }

  isAdult(): boolean {
    return this.ageBio >= AGE_CHILD_END;
  }

  // ---------------------------------------------------------------------

  sense(world: SimWorld): void {
    const s = this.sensors;
    for (let i = 0; i < 32; i++) s[i] = 0;

    const vision = this.genome.visionRange;
    const hunger01 = this.hunger / 100;
    const foodSalience = 0.25 + 0.75 * hunger01;

    let foodFront = 0;
    let foodRight = 0;
    let foodBack = 0;
    let foodLeft = 0;
    let packFront = 0;
    let packRight = 0;
    let packBack = 0;
    let packLeft = 0;
    let touch = 0;

    // Meat: living humans.
    const humanCount = world.queryHumans(this.x, this.y, vision, this.scratch);
    for (let i = 0; i < humanCount; i++) {
      const human = world.humans[this.scratch[i]];
      if (!human || !human.alive) continue;
      const dx = human.x - this.x;
      const dy = human.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > vision) continue;
      if (dist < 1.1) touch = 1;
      const proximity = (1 - dist / vision) * foodSalience * (1 + 0.4 * human.bodyScale());
      switch (quadrant(dx, dy, this.heading)) {
        case 0:
          if (proximity > foodFront) foodFront = proximity;
          break;
        case 1:
          if (proximity > foodRight) foodRight = proximity;
          break;
        case 2:
          if (proximity > foodBack) foodBack = proximity;
          break;
        default:
          if (proximity > foodLeft) foodLeft = proximity;
          break;
      }
    }

    // Carrion and god-spawned meat.
    const plantCount = world.queryPlants(this.x, this.y, vision, this.scratch);
    for (let i = 0; i < plantCount; i++) {
      const plant = world.plants[this.scratch[i]];
      if (!plant || plant.food < 0.14) continue;
      const dx = plant.x - this.x;
      const dy = plant.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > vision) continue;
      if (dist < 1.1) touch = 1;
      const proximity = (1 - dist / vision) * foodSalience * plant.foodFraction();
      switch (quadrant(dx, dy, this.heading)) {
        case 0:
          if (proximity > foodFront) foodFront = proximity;
          break;
        case 1:
          if (proximity > foodRight) foodRight = proximity;
          break;
        case 2:
          if (proximity > foodBack) foodBack = proximity;
          break;
        default:
          if (proximity > foodLeft) foodLeft = proximity;
          break;
      }
    }

    // Conspecifics (the pack).
    const predatorCount = world.queryPredators(this.x, this.y, vision, this.scratch);
    for (let i = 0; i < predatorCount; i++) {
      const other = world.predators[this.scratch[i]];
      if (!other || other === this || !other.alive) continue;
      const dx = other.x - this.x;
      const dy = other.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > vision) continue;
      const proximity = (1 - dist / vision) * this.genome.socialGain;
      switch (quadrant(dx, dy, this.heading)) {
        case 0:
          if (proximity > packFront) packFront = proximity;
          break;
        case 1:
          if (proximity > packRight) packRight = proximity;
          break;
        case 2:
          if (proximity > packBack) packBack = proximity;
          break;
        default:
          if (proximity > packLeft) packLeft = proximity;
          break;
      }
    }

    this.scanWater(world, vision);

    s[S.foodFront] = clamp01(foodFront);
    s[S.foodRight] = clamp01(foodRight);
    s[S.foodBack] = clamp01(foodBack);
    s[S.foodLeft] = clamp01(foodLeft);
    s[S.waterFront] = clamp01(this.waterDir.front * (0.3 + 0.7 * (this.hunger / 100)));
    s[S.waterRight] = clamp01(this.waterDir.right);
    s[S.waterBack] = clamp01(this.waterDir.back);
    s[S.waterLeft] = clamp01(this.waterDir.left);
    s[S.humanFront] = clamp01(packFront);
    s[S.humanRight] = clamp01(packRight);
    s[S.humanBack] = clamp01(packBack);
    s[S.humanLeft] = clamp01(packLeft);
    s[S.touch] = touch;
    s[S.pain] = clamp01(this.pain / 100);
    const deviation = this.bodyTemperature - this.genome.tempOptimum;
    s[S.cold] = clamp01((-deviation - this.genome.tempTolerance) / this.genome.tempTolerance);
    s[S.heat] = clamp01((deviation - this.genome.tempTolerance) / this.genome.tempTolerance);
    s[S.light] = world.climate.light;
    s[S.hunger] = clamp01(hunger01);
    s[S.thirst] = clamp01(this.hunger / 100) * 0.2;
    s[S.fatigue] = clamp01(this.fatigue / 100);
    s[S.energy] = clamp01(1 - this.energy / 100);
    s[S.health] = clamp01(1 - this.health / this.maxHealth);
    s[S.stress] = clamp01(this.stress / 100);
    s[S.libido] = this.isAdult() && this.hunger < 35 ? 0.55 : 0.1;
    s[S.fertility] = this.isAdult() ? 0.6 : 0;
    s[S.noise] = hash01(this.id * 40503 + world.tick * 2654435761);
  }

  private scanWater(world: SimWorld, vision: number): void {
    if (world.tick - this.lastWaterScanTick < WATER_SCAN_INTERVAL) return;
    this.lastWaterScanTick = world.tick;
    let front = 0;
    let right = 0;
    let back = 0;
    let left = 0;
    const rings = 2;
    const spokes = 12;
    for (let ring = 1; ring <= rings; ring++) {
      const radius = (vision * ring) / rings;
      for (let spoke = 0; spoke < spokes; spoke++) {
        const angle = this.heading + (spoke / spokes) * Math.PI * 2;
        const px = this.x + Math.cos(angle) * radius;
        const py = this.y + Math.sin(angle) * radius;
        if (!isWater(tileAt(world.terrain, px, py))) continue;
        const proximity = 1 - ring / (rings + 1);
        const relative = normalizeAngle(angle - this.heading);
        const abs = Math.abs(relative);
        if (abs < Math.PI / 4) {
          if (proximity > front) front = proximity;
        } else if (abs > (3 * Math.PI) / 4) {
          if (proximity > back) back = proximity;
        } else if (relative > 0) {
          if (proximity > right) right = proximity;
        } else if (proximity > left) {
          left = proximity;
        }
      }
    }
    this.waterDir = { front, right, back, left };
  }

  think(): void {
    const dEnergy = (this.energy - this.prevEnergy) / 100;
    const dPain = (this.prevPain - this.pain) / 100;
    const valence = clamp((dEnergy * 1.8 + dPain * 2.2) * 6, -1, 1);

    this.brain.step(this.sensors, valence);
    this.brain.readMotor(this.motor);
    this.brain.applyPlasticity(this.genome.plasticity, valence * this.genome.neuromodGain);
    this.lastValence = valence;

    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < this.motor.length; i++) {
      if (this.motor[i] > bestValue) {
        bestValue = this.motor[i];
        best = i;
      }
    }
    this.actionIndex = best;

    this.prevEnergy = this.energy;
    this.prevPain = this.pain;
  }

  act(world: SimWorld, dt: number): void {
    if (!this.alive) return;
    const m = this.motor;

    const forward = clamp(m[M.moveFwd] - m[M.moveBack], -1, 1);
    const turn = clamp(m[M.turnRight] - m[M.turnLeft], -1, 1);
    const sprint = 1 + 0.7 * m[M.sprint];

    this.resting = m[M.rest] > 0.5;
    this.heading = normalizeAngle(this.heading + turn * TURN_RATE * dt);

    const speedFactor = 0.55 + 0.45 * (this.ageBio < AGE_CHILD_END ? this.ageBio / AGE_CHILD_END : 1);
    let desired = forward * BASE_SPEED * this.genome.speed * speedFactor * sprint;
    desired *= 0.5 + 0.5 * clamp(this.energy / 100, 0, 1);
    if (this.resting) desired *= 0.2;
    this.speed = desired;

    this.move(world, desired * dt);

    this.attacking = false;
    this.feeding = false;

    if (m[M.attack] * this.genome.aggressionGain > 0.35) this.tryAttack(world);
    if (m[M.eat] > 0.3) this.tryEat(world);

    this.currentAction = this.attacking
      ? 'Hunting'
      : this.feeding
        ? 'Feeding'
        : this.resting
          ? 'Resting'
          : Math.abs(this.speed) > 0.5
            ? 'Prowling'
            : 'Roaming';
  }

  private move(world: SimWorld, distance: number): void {
    if (distance === 0) return;
    const dx = Math.cos(this.heading) * distance;
    const dy = Math.sin(this.heading) * distance;
    const nx = this.x + dx;
    const ny = this.y + dy;
    const passable = (x: number, y: number): boolean => {
      const tile = tileAt(world.terrain, x, y);
      return tile !== Tile.Water && tile !== Tile.Rock;
    };
    if (passable(nx, ny)) {
      this.x = nx;
      this.y = ny;
    } else if (passable(nx, this.y)) {
      this.x = nx;
    } else if (passable(this.x, ny)) {
      this.y = ny;
    } else {
      this.speed = 0;
    }
    this.x = clamp(this.x, 0.5, world.terrain.width - 0.5);
    this.y = clamp(this.y, 0.5, world.terrain.height - 0.5);
  }

  private tryAttack(world: SimWorld): void {
    if (world.tick - this.lastAttackTick < ATTACK_INTERVAL_TICKS) return;
    const count = world.queryHumans(this.x, this.y, ATTACK_REACH, this.scratch);
    let target = null;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i++) {
      const human = world.humans[this.scratch[i]];
      if (!human || !human.alive) continue;
      const distance = Math.hypot(human.x - this.x, human.y - this.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        target = human;
      }
    }
    if (!target) return;
    world.damageHuman(target, this.genome.attackPower * ATTACK_DAMAGE_SCALE, `predation by ${this.name}`, this.id);
    this.lastAttackTick = world.tick;
    this.attacking = true;
    if (!target.alive) this.kills += 1;
  }

  private tryEat(world: SimWorld): void {
    if (world.tick - this.lastBiteTick < BITE_INTERVAL_TICKS) return;
    if (this.hunger < 8 && this.energy > 90) return;
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
    this.feeding = true;
  }

  updatePhysiology(world: SimWorld, dt: number): void {
    const activity = Math.abs(this.speed) / (BASE_SPEED * 1.7);
    this.bodyTemperature = world.ambientTemperatureAt(this.x, this.y);

    this.hunger = clamp(this.hunger + HUNGER_RATE * this.genome.metabolism * dt, 0, 100);
    if (this.resting) {
      this.fatigue = clamp(this.fatigue - FATIGUE_REST_RATE * dt, 0, 100);
      this.energy = clamp(this.energy + ENERGY_REGEN_REST * dt, 0, 100);
    } else {
      this.fatigue = clamp(this.fatigue + FATIGUE_RATE * (0.6 + activity) * dt, 0, 100);
    }
    const drain = (ENERGY_DRAIN_BASE + ENERGY_DRAIN_MOVE * activity) * this.genome.metabolism;
    this.energy = clamp(this.energy - drain * dt, 0, 100);

    const thermal = Math.max(0, Math.abs(this.bodyTemperature - this.genome.tempOptimum) - this.genome.tempTolerance);
    const targetStress = clamp(
      0.6 * (this.hunger / 100) + 0.3 * (this.pain / 100) + 0.25 * (thermal / 10),
      0,
      1,
    );
    this.stress += (targetStress * 100 - this.stress) * Math.min(1, dt * 1.2);

    this.pain = clamp(this.pain - PAIN_DECAY * dt, 0, 100);

    let healthDelta = 0;
    if (this.hunger > 82) healthDelta -= STARVATION_DAMAGE * ((this.hunger - 82) / 18);
    if (thermal > 0) healthDelta -= 1.4 * (thermal / 10);
    if (this.hunger < 55 && this.pain < 20 && healthDelta >= 0) healthDelta += HEALTH_REGEN;
    this.health = clamp(this.health + healthDelta * dt, 0, this.maxHealth);

    this.ageBio += dt / BIO_YEAR_SECONDS;
    this.stage = this.ageBio < AGE_CHILD_END ? LifeStage.Child : this.ageBio < AGE_ADULT_END ? LifeStage.Adult : LifeStage.Elder;

    const t = this.ageBio / this.genome.lifespan;
    if (t > 0.72) {
      const hazard = 3e-4 * Math.exp((t - 0.72) * 24);
      if (world.random() < hazard * dt) {
        this.health = 0;
        this.deathReason = 'old age';
      }
    }

    if (this.health <= 0 && !this.deathReason) {
      this.deathReason = this.hunger > 82 ? 'starvation' : this.pain > 40 ? 'injuries' : 'exhaustion';
    }
    if (this.ageBio >= AGE_MAX) {
      this.health = 0;
      this.deathReason = 'old age';
    }
  }

  /**
   * V0 parthenogenetic reproduction: a well-fed adult buds an offspring with a
   * mutated genome. Triggered by the same `mate` motor output that humans use,
   * so the neural architecture is unchanged.
   */
  tryReproduce(world: SimWorld): Predator | null {
    if (!this.alive) return null;
    if (!this.isAdult()) return null;
    if (this.ageBio < REPRODUCTION_MIN_AGE) return null;
    if (world.tick - this.lastReproductionTick < REPRODUCTION_COOLDOWN) return null;
    if (this.energy < 68 || this.hunger > 32) return null;
    if (this.motor[M.mate] < 0.4) return null;

    this.lastReproductionTick = world.tick;
    this.energy -= 30;
    this.hunger = clamp(this.hunger + 18, 0, 100);

    const childGenome = { ...this.genome };
    mutate(childGenome, this.rng, { rate: 0.14, strength: 0.05, structuralChance: 0.03 });
    const angle = this.rng.next() * Math.PI * 2;
    const distance = this.rng.range(1.2, 2.6);
    const child = new Predator(0, '', childGenome, this.rng.fork());
    child.x = this.x + Math.cos(angle) * distance;
    child.y = this.y + Math.sin(angle) * distance;
    child.birthTick = world.tick;
    child.generation = this.generation + 1;
    child.ageBio = 0.2;
    child.stage = LifeStage.Child;
    return child;
  }

  serialize(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      genome: this.genome,
      x: this.x,
      y: this.y,
      heading: this.heading,
      speed: this.speed,
      ageBio: this.ageBio,
      birthTick: this.birthTick,
      alive: this.alive,
      deathTick: this.deathTick,
      deathReason: this.deathReason,
      stage: this.stage,
      generation: this.generation,
      health: this.health,
      maxHealth: this.maxHealth,
      hunger: this.hunger,
      energy: this.energy,
      fatigue: this.fatigue,
      pain: this.pain,
      stress: this.stress,
      bodyTemperature: this.bodyTemperature,
      prevEnergy: this.prevEnergy,
      prevPain: this.prevPain,
      kills: this.kills,
      lastBiteTick: this.lastBiteTick,
      lastAttackTick: this.lastAttackTick,
      lastReproductionTick: this.lastReproductionTick,
      currentAction: this.currentAction,
      lastWaterScanTick: this.lastWaterScanTick,
      waterDir: { ...this.waterDir },
      brain: this.brain.serialize(),
      rngState: this.rng.getState(),
    };
  }

  static deserialize(data: Record<string, unknown>, rng: Rng): Predator {
    const predator = new Predator(
      data.id as number,
      (data.name as string) ?? '',
      data.genome as Genome,
      rng,
    );
    predator.x = data.x as number;
    predator.y = data.y as number;
    predator.heading = data.heading as number;
    predator.speed = (data.speed as number) ?? 0;
    predator.ageBio = data.ageBio as number;
    predator.birthTick = data.birthTick as number;
    predator.alive = data.alive as boolean;
    predator.deathTick = (data.deathTick as number | null) ?? null;
    predator.deathReason = (data.deathReason as string | null) ?? null;
    predator.stage = data.stage as number;
    predator.generation = data.generation as number;
    predator.maxHealth = data.maxHealth as number;
    predator.health = data.health as number;
    predator.hunger = data.hunger as number;
    predator.energy = data.energy as number;
    predator.fatigue = data.fatigue as number;
    predator.pain = data.pain as number;
    predator.stress = data.stress as number;
    predator.bodyTemperature = data.bodyTemperature as number;
    predator.prevEnergy = data.prevEnergy as number;
    predator.prevPain = data.prevPain as number;
    predator.kills = (data.kills as number) ?? 0;
    predator.lastBiteTick = (data.lastBiteTick as number) ?? -10000;
    predator.lastAttackTick = (data.lastAttackTick as number) ?? -10000;
    predator.lastReproductionTick = (data.lastReproductionTick as number) ?? -10000;
    predator.currentAction = (data.currentAction as string) ?? 'Roaming';
    predator.lastWaterScanTick = (data.lastWaterScanTick as number) ?? -10000;
    const waterDir = data.waterDir as { front: number; right: number; back: number; left: number } | undefined;
    if (waterDir) predator.waterDir = { ...waterDir };
    predator.brain.restore(data.brain as number[], predator.brain.synCount);
    if (Array.isArray(data.rngState)) predator.rng.setState(data.rngState as number[]);
    return predator;
  }
}

// ---------------------------------------------------------------------------

function quadrant(dx: number, dy: number, heading: number): 0 | 1 | 2 | 3 {
  const relative = normalizeAngle(Math.atan2(dy, dx) - heading);
  const abs = Math.abs(relative);
  if (abs < Math.PI / 4) return 0;
  if (abs > (3 * Math.PI) / 4) return 2;
  return relative > 0 ? 1 : 3;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function hash01(n: number): number {
  let h = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export { Sex };
