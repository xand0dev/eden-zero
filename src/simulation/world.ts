import { Rng } from './rng';
import { DT, MAX_EVENTS, MAX_PLANTS, MAX_POPULATION, MAX_PREDATORS, SPATIAL_CELL, WORLD_H, WORLD_W } from '../shared/constants';
import { SpatialGrid } from './spatial/grid';
import { generateTerrain, nearestWalkable, computeWaterDistance, type TerrainData } from './environment/terrain';
import { ambientTemperature, createClimate, updateClimate, type Climate } from './environment/climate';
import { Human, MATING_DURATION, MATING_REFRACTORY } from './entities/human';
import { Predator } from './entities/predator';
import { Plant, PlantSpecies, SPECIES_PROFILES } from './entities/plant';
import type { SimWorld } from './entities/context';
import { cloneGenome, randomGenome, geneDef, sanitizeGenome, type GeneKey, type Genome } from './genetics/genome';
import { reproduce } from './genetics/evolution';
import { NameRegistry, FOUNDER_NAMES } from '../shared/names';
import {
  EntityKind,
  EntityFlags,
  LifeStage,
  SNAPSHOT_FLOAT_STRIDE,
  SNAPSHOT_META_STRIDE,
  Sex,
  STAGE_NAMES,
  type BrainView,
  type DevMetrics,
  type EventKind,
  type ExplanationView,
  type GeneView,
  type HumanDetail,
  type RelativeView,
  type SocialRecordView,
  type TreeNode,
  type WorldEffect,
  type WorldEvent,
  type WorldSnapshot,
  type WorldStats,
} from '../shared/types';
import { MOTOR_NAMES, MOTOR_START, M, labelNeuron, regionOf } from './brain/channels';
import { explainAction } from './brain/trace';
import { Brain } from './brain/network';
import type { InheritanceReport } from './genetics/evolution';

/**
 * How close two willing adults must be to pair.
 *
 * Raised from 2.4 after the mating diagnostics showed that willing pairs were
 * being formed only a handful of times per simulated hour: in a village of eight
 * to twelve people who spend most of their time foraging in different
 * directions, two mutually willing adults rarely pass within two tiles.
 */
const MATING_RADIUS = 5;

/**
 * Everything we keep about a birth, so the inspector can later answer
 * "which genes came from whom, and what mutated?" even after the parents die.
 */
export interface StoredInheritance {
  report: InheritanceReport;
  motherGenome: Genome;
  fatherGenome: Genome;
  motherId: number;
  fatherId: number | null;
}

export interface WorldOptions {
  seed: string;
  initialHumans: number;
  initialPredators: number;
  /** Initial plant density multiplier. */
  plantDensity: number;
}

export const DEFAULT_WORLD_OPTIONS: Omit<WorldOptions, 'seed'> = {
  initialHumans: 8,
  initialPredators: 2,
  plantDensity: 1,
};

interface MatingPair {
  aId: number;
  bId: number;
  progress: number;
}

/**
 * The world.
 *
 * Owns every entity, the terrain, the climate, the event log and the tick loop.
 * It implements `SimWorld`, which is the only surface entities are allowed to
 * touch — that boundary is what keeps a future Rust migration tractable.
 *
 * Determinism contract: given the same seed, options and intervention sequence,
 * `tick()` produces a byte-identical sequence of states. Everything iterates in
 * stable order (arrays in id order, grids rebuilt from those arrays) and all
 * randomness flows through `this.rng` or a per-entity forked stream.
 */
export class World implements SimWorld {
  tick = 0;
  simTime = 0;
  dt = DT;

  readonly seed: string;
  readonly options: WorldOptions;
  rng: Rng;
  terrain: TerrainData;
  /** Tiles from each position to the nearest fresh water (saturated at 255). */
  readonly waterDistance: Uint8Array;
  climate: Climate;

  humans: Human[] = [];
  predators: Predator[] = [];
  plants: Plant[] = [];

  events: WorldEvent[] = [];
  effects: WorldEffect[] = [];

  readonly nameRegistry = new NameRegistry();
  private nextEntityId = 1;
  /** Centre of the founding village, used to place predators in the surrounding wilderness. */
  private settlementCentre: { x: number; y: number } | null = null;
  private nextEventId = 1;
  private nextEffectId = 1;

  private humanById = new Map<number, Human>();
  private predatorById = new Map<number, Predator>();

  private humanGrid: SpatialGrid;
  private predatorGrid: SpatialGrid;
  private plantGrid: SpatialGrid;

  /** Lifetime counters that must survive entity death. */
  births = 0;
  deaths = 0;
  maxGeneration = 0;
  totalMatings = 0;

  private readonly scratchA: number[] = [];
  private readonly scratchB: number[] = [];

  constructor(options: WorldOptions) {
    this.options = options;
    this.seed = options.seed;
    this.rng = new Rng(`${options.seed}:world`);
    this.terrain = generateTerrain(options.seed);
    this.waterDistance = computeWaterDistance(this.terrain);
    this.climate = createClimate();

    this.humanGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.predatorGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.plantGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);

    this.seedPlants(options.plantDensity);
    this.seedFounders(options.initialHumans);
    this.seedPredators(options.initialPredators);

    this.emitEvent('milestone', `Genesis — ${options.initialHumans} humans awaken in world "${options.seed}".`, []);
  }

  // ---------------------------------------------------------------------
  // Genesis
  // ---------------------------------------------------------------------

  private seedPlants(density: number): void {
    const { tiles, width, height } = this.terrain;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const tile = tiles[y * width + x];
        if (tile !== 3 && tile !== 4) continue; // grass or forest
        const chance = (tile === 4 ? 0.22 : 0.1) * density;
        if (this.rng.next() > chance) continue;
        const species =
          tile === 4
            ? this.rng.next() < 0.28
              ? PlantSpecies.Tree
              : this.rng.next() < 0.6
                ? PlantSpecies.Bush
                : PlantSpecies.Grass
            : this.rng.next() < 0.12
              ? PlantSpecies.Bush
              : PlantSpecies.Grass;
        const plant = new Plant(this.nextEntityId++, species, x + 0.5, y + 0.5, this.rng, this.rng.range(0.4, 1));
        this.plants.push(plant);
        count++;
      }
    }
    if (count === 0) {
      // Degenerate seed with no fertile land — drop a few grass tufts anyway.
      for (let i = 0; i < 40; i++) {
        const [x, y] = nearestWalkable(
          this.terrain,
          this.rng.range(4, width - 4),
          this.rng.range(4, height - 4),
        );
        this.plants.push(new Plant(this.nextEntityId++, PlantSpecies.Grass, x, y, this.rng, 0.8));
      }
    }
  }

  private seedFounders(count: number): void {
    // Settle the founders as a single small village beside fresh water.
    //
    // Two earlier versions failed here: scattering them uniformly meant they
    // never met, never mated, and the world died of old age with generation 0
    // still on the books. A founding population needs to be a *population*.
    const sites = this.settlementSites();
    const home = sites.length > 0 ? sites[0] : [this.terrain.width / 2, this.terrain.height / 2];
    this.settlementCentre = { x: home[0], y: home[1] };

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.rng.range(-0.35, 0.35);
      const radius = this.rng.range(1.5, 7);
      const [x, y] = nearestWalkable(
        this.terrain,
        home[0] + Math.cos(angle) * radius,
        home[1] + Math.sin(angle) * radius,
      );
      // Guarantee a 4/4 split for the default of eight founders.
      const sex = i % 2 === 0 ? Sex.Female : Sex.Male;
      const genome = randomGenome(this.rng, 0);
      const name = this.nameRegistry.claim(FOUNDER_NAMES[i % FOUNDER_NAMES.length]);
      const human = new Human(this.nextEntityId++, name, sex, genome, this.rng.fork());
      human.x = x;
      human.y = y;
      human.heading = this.rng.range(-Math.PI, Math.PI);
      human.birthTick = 0;
      // Founders start as young adults: the world should begin with a chance.
      human.ageBio = this.rng.range(14, 24);
      human.stage = LifeStage.Adult;
      human.health = 100;
      human.energy = 92;
      human.hunger = this.rng.range(5, 14);
      human.thirst = this.rng.range(3, 10);
      human.fatigue = this.rng.range(2, 10);
      human.generation = 0;
      this.humans.push(human);
      this.humanById.set(human.id, human);
    }
    this.maxGeneration = 0;
  }

  /**
   * Deterministically pick well-separated walkable sites that are a short walk
   * from fresh water. Falls back to any walkable tile if the island has no
   * water at all.
   */
  private settlementSites(): Array<[number, number]> {
    const { width, height, tiles } = this.terrain;
    const candidates: Array<[number, number]> = [];
    for (let y = 3; y < height - 3; y += 2) {
      for (let x = 3; x < width - 3; x += 2) {
        const tile = tiles[y * width + x];
        if (tile !== 3 && tile !== 4) continue;
        const distance = this.waterDistance[y * width + x];
        if (distance < 2 || distance > 5) continue;
        candidates.push([x + 0.5, y + 0.5]);
      }
    }
    if (candidates.length === 0) {
      for (let y = 3; y < height - 3; y += 4) {
        for (let x = 3; x < width - 3; x += 4) {
          const tile = tiles[y * width + x];
          if (tile === 3 || tile === 4) candidates.push([x + 0.5, y + 0.5]);
        }
      }
    }
    this.rng.shuffle(candidates);

    // Greedy selection with a minimum separation so founders do not all pile up
    // in one spot.
    const selected: Array<[number, number]> = [];
    const minSeparation = Math.max(8, Math.sqrt((width * height) / 8) * 0.45);
    for (const candidate of candidates) {
      let ok = true;
      for (const site of selected) {
        if (Math.hypot(site[0] - candidate[0], site[1] - candidate[1]) < minSeparation) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      selected.push(candidate);
      if (selected.length >= 12) break;
    }
    if (selected.length === 0) selected.push(...candidates.slice(0, 12));
    return selected;
  }

  private seedPredators(count: number): void {
    // Release predators in the wilderness *around* the village, not uniformly
    // across the map.
    //
    // A random map position is almost always tens of tiles from the only people
    // in the world, and a predator that cannot find prey within a couple of
    // simulated minutes simply starves: in an early build two predators released
    // at random both died without ever meeting a human, which makes for a very
    // dull ecology.
    const home = this.settlementCentre ?? { x: this.terrain.width / 2, y: this.terrain.height / 2 };
    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + this.rng.range(-0.6, 0.6);
      const radius = this.rng.range(16, 34);
      const [x, y] = nearestWalkable(
        this.terrain,
        home.x + Math.cos(angle) * radius,
        home.y + Math.sin(angle) * radius,
      );
      const genome = randomGenome(this.rng, 1);
      const predator = new Predator(this.nextEntityId++, `Hunter ${i + 1}`, genome, this.rng.fork());
      predator.x = x;
      predator.y = y;
      predator.heading = this.rng.range(-Math.PI, Math.PI);
      predator.ageBio = this.rng.range(5, 14);
      predator.hunger = this.rng.range(20, 45);
      predator.generation = 0;
      this.predators.push(predator);
      this.predatorById.set(predator.id, predator);
    }
  }

  // ---------------------------------------------------------------------
  // SimWorld implementation
  // ---------------------------------------------------------------------

  random(): number {
    return this.rng.next();
  }

  getHuman(id: number): Human | undefined {
    return this.humanById.get(id);
  }

  getPredator(id: number): Predator | undefined {
    return this.predatorById.get(id);
  }

  queryHumans(x: number, y: number, radius: number, out: number[]): number {
    return this.humanGrid.queryCircle(x, y, radius, out);
  }

  queryPredators(x: number, y: number, radius: number, out: number[]): number {
    return this.predatorGrid.queryCircle(x, y, radius, out);
  }

  queryPlants(x: number, y: number, radius: number, out: number[]): number {
    return this.plantGrid.queryCircle(x, y, radius, out);
  }

  ambientTemperatureAt(x: number, y: number): number {
    return ambientTemperature(this.terrain, this.climate, x, y);
  }

  consumePlant(plantIndex: number, amount: number): number {
    const plant = this.plants[plantIndex];
    if (!plant || !plant.alive) return 0;
    const taken = Math.min(plant.food, amount);
    plant.food -= taken;
    if (plant.food <= 0.0001 && plant.species === PlantSpecies.FoodPile) {
      plant.food = 0;
      plant.alive = false;
    }
    return taken;
  }

  damageHuman(target: Human, amount: number, reason: string, attackerId: number | null): void {
    if (!target.alive) return;
    target.health -= amount;
    target.pain = Math.min(100, target.pain + amount * 3.2);
    if (target.health <= 0) {
      target.health = 0;
      this.killHuman(target, reason, attackerId);
    }
  }

  /** Genetic relatedness in 0..1. Depth-limited: V0 does not model lineages further. */
  relatedness(a: number, b: number): number {
    if (a === b) return 1;
    const first = this.humanById.get(a);
    const second = this.humanById.get(b);
    if (!first || !second) return 0;
    if (first.motherId === b || first.fatherId === b) return 0.5;
    if (second.motherId === a || second.fatherId === a) return 0.5;
    const shareMother = first.motherId !== null && first.motherId === second.motherId;
    const shareFather = first.fatherId !== null && first.fatherId === second.fatherId;
    if (shareMother || shareFather) return 0.25;
    const grandparent =
      (first.motherId !== null && (second.motherId === first.motherId || second.fatherId === first.motherId)) ||
      (first.fatherId !== null && (second.motherId === first.fatherId || second.fatherId === first.fatherId));
    if (grandparent) return 0.25;
    return 0;
  }

  emitEvent(kind: EventKind, text: string, entityIds: number[]): void {
    this.events.push({
      id: this.nextEventId++,
      tick: this.tick,
      simTime: this.simTime,
      kind,
      text,
      entityIds,
    });
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  // ---------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------

  rebuildGrids(): void {
    this.humanGrid.clear();
    this.predatorGrid.clear();
    this.plantGrid.clear();
    for (let i = 0; i < this.humans.length; i++) {
      const human = this.humans[i];
      if (human.alive) this.humanGrid.insert(i, human.x, human.y);
    }
    for (let i = 0; i < this.predators.length; i++) {
      const predator = this.predators[i];
      if (predator.alive) this.predatorGrid.insert(i, predator.x, predator.y);
    }
    for (let i = 0; i < this.plants.length; i++) {
      const plant = this.plants[i];
      if (plant.alive) this.plantGrid.insert(i, plant.x, plant.y);
    }
  }

  step(): void {
    this.tick += 1;
    this.simTime += DT;
    updateClimate(this.climate, this.simTime);
    this.rebuildGrids();

    // --- humans -----------------------------------------------------------
    const humanCount = this.humans.length;
    for (let i = 0; i < humanCount; i++) {
      const human = this.humans[i];
      if (!human.alive) continue;
      human.sense(this);
      human.think(this);
      human.act(this, DT);
      human.updatePhysiology(this, DT);
      if (human.health <= 0) {
        this.killHuman(human, human.deathReason ?? 'unknown causes', null);
      }
    }

    // --- predators --------------------------------------------------------
    const predatorCount = this.predators.length;
    for (let i = 0; i < predatorCount; i++) {
      const predator = this.predators[i];
      if (!predator.alive) continue;
      predator.sense(this);
      predator.think();
      predator.act(this, DT);
      predator.updatePhysiology(this, DT);
      if (predator.health <= 0) this.killPredator(predator, predator.deathReason ?? 'unknown causes');
      else if (this.predators.length < MAX_PREDATORS) {
        const child = predator.tryReproduce(this);
        if (child) {
          child.id = this.nextEntityId++;
          child.name = `Hunter ${child.id}`;
          this.predators.push(child);
          this.predatorById.set(child.id, child);
          this.emitEvent('birth', `A predator pup was born (generation ${child.generation}).`, [child.id]);
        }
      }
    }

    // --- plants -----------------------------------------------------------
    this.updatePlants();

    // --- reproduction -----------------------------------------------------
    this.resolveMating(DT);
    this.resolvePregnancies(DT);

    // --- effects ----------------------------------------------------------
    for (let i = this.effects.length - 1; i >= 0; i--) {
      this.effects[i].ttl -= DT;
      if (this.effects[i].ttl <= 0) this.effects.splice(i, 1);
    }

    // --- compaction -------------------------------------------------------
    this.compact();

    // --- milestones -------------------------------------------------------
    this.checkMilestones();
  }

  private updatePlants(): void {
    const spreadAllowed = this.plants.length < MAX_PLANTS;
    const spawned: Plant[] = [];
    for (let i = 0; i < this.plants.length; i++) {
      const plant = this.plants[i];
      if (!plant.alive) continue;
      const child = plant.update(this.terrain, DT, this.rng, spreadAllowed);
      if (child) {
        child.id = this.nextEntityId++;
        spawned.push(child);
      }
    }
    for (let i = 0; i < spawned.length; i++) {
      this.plants.push(spawned[i]);
    }
  }

  private resolveMating(dt: number): void {
    // 1. Advance existing pairs.
    for (let i = this.matingPairs.length - 1; i >= 0; i--) {
      const pair = this.matingPairs[i];
      const a = this.humanById.get(pair.aId);
      const b = this.humanById.get(pair.bId);
      if (!a || !b || !a.alive || !b.alive || !a.mating || !b.mating) {
        a?.cancelMating();
        b?.cancelMating();
        this.matingPairs.splice(i, 1);
        continue;
      }
      pair.progress += dt / MATING_DURATION;
      a.mating.progress = pair.progress;
      b.mating.progress = pair.progress;
      if (pair.progress >= 1) {
        a.cancelMating();
        b.cancelMating();
        a.matingCooldown = MATING_REFRACTORY;
        b.matingCooldown = MATING_REFRACTORY;
        a.lastMateTick = this.tick;
        b.lastMateTick = this.tick;
        this.matingPairs.splice(i, 1);
        this.completeMating(a, b);
      }
    }

    // 2. Form new pairs. Requires MUTUAL participation: both partners must be
    //    driving their mate motor above threshold and both must be eligible.
    const available: Human[] = [];
    let willingFemales = 0;
    for (let i = 0; i < this.humans.length; i++) {
      const human = this.humans[i];
      if (!human.alive) continue;
      if (!human.canMate()) continue;
      if (human.motor[M.mate] < 0.35) continue;
      if (human.sex === Sex.Female) willingFemales++;
      available.push(human);
    }

    // Diagnostics: distinguish "nobody is willing" from "willing people never
    // meet". Those two failures need completely different fixes.
    this.matingDiagnostics.willingTicks += available.length;
    this.matingDiagnostics.willingFemalesTicks += willingFemales;
    this.matingDiagnostics.ticks += 1;

    if (available.length < 2) return;

    for (let i = 0; i < available.length; i++) {
      const a = available[i];
      if (a.mating) continue;
      if (!a.canMate()) continue;
      let best: Human | null = null;
      let bestDistance = Infinity;
      for (let j = 0; j < available.length; j++) {
        if (i === j) continue;
        const b = available[j];
        if (b.mating) continue;
        if (b.sex === a.sex) continue;
        if (!b.canMate()) continue;
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        if (distance > MATING_RADIUS) continue;
        this.matingDiagnostics.opportunities += 1;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = b;
        }
      }
      if (!best) continue;
      this.matingDiagnostics.pairings += 1;
      a.mating = { partnerId: best.id, progress: 0 };
      best.mating = { partnerId: a.id, progress: 0 };
      this.matingPairs.push({ aId: a.id, bId: best.id, progress: 0 });
      this.emitEvent(
        'mating',
        `${a.name} and ${best.name} are mating.`,
        [a.id, best.id],
      );
      this.addEffect('mating', (a.x + best.x) / 2, (a.y + best.y) / 2, 2.2, 1.4);
    }
  }

  /**
   * Mating-pipeline counters.
   *
   * These exist because the first hypothesis for a declining population was
   * "they are not willing to mate", and the second was "willing adults never
   * find each other". The two need opposite fixes, and guessing wasted a lot of
   * time — so the pipeline reports which one is actually binding.
   */
  readonly matingDiagnostics = {
    ticks: 0,
    willingTicks: 0,
    willingFemalesTicks: 0,
    opportunities: 0,
    pairings: 0,
  };

  private matingPairs: MatingPair[] = [];

  private completeMating(a: Human, b: Human): void {
    this.totalMatings += 1;
    const mother = a.isFemale() ? a : b;
    const father = a.isFemale() ? b : a;
    if (mother.pregnancy) return;

    // Conception is probabilistic and depends on both parents' fertility.
    const chance = 0.9 * Math.min(1, mother.fertility01) * Math.min(1, father.fertility01) * mother.genome.fertility;
    if (this.rng.next() > chance) return;

    const { genome, report } = reproduce(mother.genome, father.genome, this.rng, {
      rate: 0.16,
      strength: 0.05,
      structuralChance: 0.02,
    });
    mother.conceive(father, this, genome, report);
    this.emitEvent('conception', `${mother.name} conceived a child with ${father.name}.`, [
      mother.id,
      father.id,
    ]);
  }

  private resolvePregnancies(dt: number): void {
    for (let i = 0; i < this.humans.length; i++) {
      const mother = this.humans[i];
      if (!mother.alive || !mother.pregnancy) continue;
      if (mother.advancePregnancy(dt)) {
        this.giveBirth(mother);
      }
    }
  }

  private giveBirth(mother: Human): void {
    const pregnancy = mother.pregnancy;
    if (!pregnancy) return;
    const father = this.humanById.get(pregnancy.fatherId) ?? null;
    const genome = sanitizeGenome(cloneGenome(pregnancy.embryoGenome));

    const sex = this.rng.next() < 0.5 ? Sex.Female : Sex.Male;
    const name = this.nameRegistry.next(this.rng);
    const baby = new Human(this.nextEntityId++, name, sex, genome, this.rng.fork());

    const angle = this.rng.next() * Math.PI * 2;
    const [bx, by] = nearestWalkable(
      this.terrain,
      mother.x + Math.cos(angle) * 0.9,
      mother.y + Math.sin(angle) * 0.9,
      6,
    );
    baby.x = bx;
    baby.y = by;
    baby.heading = mother.heading;
    baby.birthTick = this.tick;
    baby.ageBio = 0;
    baby.stage = LifeStage.Baby;
    baby.motherId = mother.id;
    baby.fatherId = father ? father.id : null;
    baby.generation = Math.max(mother.generation, father ? father.generation : 0) + 1;
    baby.health = 100;
    baby.energy = 80;
    baby.hunger = 20;
    baby.thirst = 20;
    baby.fatigue = 30;

    // Attach the inheritance report to the newborn so the inspector can show
    // exactly which genes came from which parent and what mutated.
    // Attach the inheritance report to the newborn so the inspector can show
    // exactly which genes came from which parent and what mutated — including
    // the parents' genomes, so the comparison survives the parents' deaths.
    this.inheritanceReports.set(baby.id, {
      report: pregnancy.report,
      motherGenome: pregnancy.motherGenome,
      fatherGenome: pregnancy.fatherGenome,
      motherId: mother.id,
      fatherId: father ? father.id : null,
    });

    this.humans.push(baby);
    this.humanById.set(baby.id, baby);

    mother.childrenIds.push(baby.id);
    mother.offspringCount += 1;
    if (father) {
      father.childrenIds.push(baby.id);
      father.offspringCount += 1;
    }

    mother.pregnancy = null;
    // Recovery after birth.
    //
    // The reproductive cycle is what caps population growth: a female is
    // unavailable while pregnant, while recovering, and during the mating
    // refractory, and the mating diagnostics showed only ~0.35 willing females
    // per tick against ~2.0 willing males. Shortening recovery directly raises
    // the birth rate without touching behaviour.
    mother.recovery = 85;
    mother.health = Math.max(35, mother.health - 6);
    mother.energy = Math.max(0, mother.energy - 22);
    mother.fatigue = Math.min(100, mother.fatigue + 35);

    this.births += 1;
    if (baby.generation > this.maxGeneration) {
      this.maxGeneration = baby.generation;
      this.emitEvent('generation', `Generation ${baby.generation} appeared with ${baby.name}.`, [baby.id]);
    }
    this.emitEvent('birth', `${baby.name} was born to ${mother.name}.`, [baby.id, mother.id]);
    this.addEffect('birth', baby.x, baby.y, 2.4, 1.2);

    // Newborn memory: both parents recognise their child immediately.
    mother.memory.shock(baby.id, this.tick, 0.5, 0.35, 0.3);
    if (father) father.memory.shock(baby.id, this.tick, 0.5, 0.3, 0.25);
  }

  /** Inheritance reports, kept out of the save payload's hot path but preserved. */
  readonly inheritanceReports = new Map<number, StoredInheritance>();

  // ---------------------------------------------------------------------
  // Death
  // ---------------------------------------------------------------------

  killHuman(target: Human, reason: string, killerId: number | null): void {
    if (!target.alive) return;
    target.alive = false;
    target.health = 0;
    target.deathTick = this.tick;
    target.deathReason = reason;
    target.mating = null;
    this.deaths += 1;

    const killer = killerId !== null ? this.humanById.get(killerId) : undefined;
    const predator = killerId !== null ? this.predatorById.get(killerId) : undefined;

    if (reason === 'predation' || reason.startsWith('predation')) {
      this.emitEvent(
        'predation',
        `${predator ? predator.name : 'A predator'} killed ${target.name}.`,
        [target.id, ...(predator ? [predator.id] : [])],
      );
    } else {
      this.emitEvent('death', `${target.name} died from ${reason}.`, [target.id, ...(killer ? [killer.id] : [])]);
    }
    this.addEffect('death', target.x, target.y, 2.2, 1.1);

    // The body becomes carrion: biomass re-enters the ecosystem.
    const carcass = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, target.x, target.y, this.rng, 1);
    carcass.food = SPECIES_PROFILES[PlantSpecies.FoodPile].maxFood * (0.5 + 0.5 * target.bodyScale());
    this.plants.push(carcass);

    // Anyone who knew them remembers the loss.
    for (const other of this.humans) {
      if (!other.alive || other === target) continue;
      const record = other.memory.get(target.id);
      if (record) {
        record.valence = Math.max(-1, record.valence - 0.35);
      }
    }
  }

  killPredator(target: Predator, reason: string): void {
    if (!target.alive) return;
    target.alive = false;
    target.health = 0;
    target.deathTick = this.tick;
    target.deathReason = reason;
    this.emitEvent('death', `${target.name} died from ${reason}.`, [target.id]);
    this.addEffect('death', target.x, target.y, 1.8, 1.1);
    const carcass = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, target.x, target.y, this.rng, 1);
    carcass.food = SPECIES_PROFILES[PlantSpecies.FoodPile].maxFood * 1.1;
    this.plants.push(carcass);
  }

  private compact(): void {
    if (this.humans.some((h) => !h.alive)) {
      this.humans = this.humans.filter((h) => h.alive);
      this.humanById = new Map(this.humans.map((h) => [h.id, h]));
    }
    if (this.predators.some((p) => !p.alive)) {
      this.predators = this.predators.filter((p) => p.alive);
      this.predatorById = new Map(this.predators.map((p) => [p.id, p]));
    }
    if (this.plants.some((p) => !p.alive)) {
      this.plants = this.plants.filter((p) => p.alive);
    }
  }

  private checkMilestones(): void {
    if (this.tick % 400 !== 0) return;
    const population = this.humans.length;
    for (const milestone of MILESTONES) {
      if (population >= milestone && !this.reachedMilestones.has(milestone)) {
        this.reachedMilestones.add(milestone);
        this.emitEvent('milestone', `Population reached ${milestone}.`, []);
      }
    }
  }

  private readonly reachedMilestones = new Set<number>();

  // ---------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------

  addEffect(kind: WorldEffect['kind'], x: number, y: number, ttl: number, radius: number): void {
    this.effects.push({ id: this.nextEffectId++, kind, x, y, ttl, maxTtl: ttl, radius });
    if (this.effects.length > 120) this.effects.splice(0, this.effects.length - 120);
  }

  // ---------------------------------------------------------------------
  // God mode
  // ---------------------------------------------------------------------

  spawnHuman(x: number, y: number, genome?: Genome, ageBio = 18): Human {
    if (this.humans.length >= MAX_POPULATION) {
      this.emitEvent('god', 'Population cap reached — no new human was created.', []);
      return this.humans[0];
    }
    const [px, py] = nearestWalkable(this.terrain, x, y, 12);
    const sex = this.rng.next() < 0.5 ? Sex.Female : Sex.Male;
    const resolved = genome ? sanitizeGenome(cloneGenome(genome)) : randomGenome(this.rng, 0);
    const name = this.nameRegistry.next(this.rng);
    const human = new Human(this.nextEntityId++, name, sex, resolved, this.rng.fork());
    human.x = px;
    human.y = py;
    human.ageBio = ageBio;
    human.birthTick = this.tick;
    human.stage = ageBio < 1.5 ? LifeStage.Baby : ageBio < 12 ? LifeStage.Child : LifeStage.Adult;
    human.energy = 92;
    human.generation = this.maxGeneration;
    this.humans.push(human);
    this.humanById.set(human.id, human);
    this.emitEvent('god', `${name} was created by the observer.`, [human.id]);
    this.addEffect('spawn', px, py, 1.6, 1.6);
    return human;
  }

  spawnPredator(x: number, y: number): Predator | null {
    if (this.predators.length >= MAX_PREDATORS) return null;
    const [px, py] = nearestWalkable(this.terrain, x, y, 12);
    const genome = randomGenome(this.rng, 1);
    const predator = new Predator(this.nextEntityId++, '', genome, this.rng.fork());
    predator.id = this.nextEntityId++;
    predator.name = `Hunter ${predator.id}`;
    predator.x = px;
    predator.y = py;
    predator.ageBio = 10;
    this.predators.push(predator);
    this.predatorById.set(predator.id, predator);
    this.emitEvent('god', `A predator was released by the observer.`, [predator.id]);
    this.addEffect('spawn', px, py, 1.6, 2);
    return predator;
  }

  spawnFood(x: number, y: number, amount = 1.4): void {
    const [px, py] = nearestWalkable(this.terrain, x, y, 8);
    const pile = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, px, py, this.rng, 1);
    pile.food = amount;
    this.plants.push(pile);
    this.emitEvent('god', `Food was placed by the observer.`, []);
    this.addEffect('spawn', px, py, 1.2, 1);
  }

  strikeLightning(x: number, y: number, radius = 6, damage = 62): void {
    this.addEffect('lightning', x, y, 0.85, radius);
    this.emitEvent('lightning', `Lightning struck (${x.toFixed(0)}, ${y.toFixed(0)}).`, []);
    for (const human of this.humans) {
      if (!human.alive) continue;
      const distance = Math.hypot(human.x - x, human.y - y);
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      this.damageHuman(human, damage * falloff, 'lightning', null);
    }
    for (const predator of this.predators) {
      if (!predator.alive) continue;
      const distance = Math.hypot(predator.x - x, predator.y - y);
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      predator.health -= damage * falloff;
      predator.pain = Math.min(100, predator.pain + damage * falloff * 3);
      if (predator.health <= 0) this.killPredator(predator, 'lightning');
    }
  }

  repositionHuman(id: number, x: number, y: number): boolean {
    const human = this.humanById.get(id);
    if (!human || !human.alive) return false;
    const [px, py] = nearestWalkable(this.terrain, x, y, 20);
    human.x = px;
    human.y = py;
    this.addEffect('spawn', px, py, 1.2, 1);
    return true;
  }

  setTemperatureOffset(offset: number): void {
    this.climate.globalOffset = Math.max(-18, Math.min(22, offset));
  }

  setTimeOfDay(phase: number): void {
    const wrapped = ((phase % 1) + 1) % 1;
    // Move the simulation clock so that the climate's day phase equals `phase`.
    const daySeconds = 240;
    const cycles = Math.floor(this.simTime / daySeconds);
    this.simTime = cycles * daySeconds + wrapped * daySeconds;
    updateClimate(this.climate, this.simTime);
    this.emitEvent('god', `Time of day set to ${(wrapped * 24).toFixed(1)}h.`, []);
  }

  editGenome(id: number, key: GeneKey, value: number): boolean {
    const human = this.humanById.get(id);
    if (!human) return false;
    const def = geneDef(key);
    const clamped = Math.max(def.min, Math.min(def.max, def.integer ? Math.round(value) : value));
    const previous = human.genome[key];
    human.genome[key] = clamped;
    sanitizeGenome(human.genome);

    // Structural genes require the network to be rebuilt.
    if (key === 'brainSeed' || key === 'connDensity' || key === 'weightScale' || key === 'excRatio' || key === 'tauScale') {
      const learnedWeights = human.brain.w.slice();
      human.brain = new Brain(human.genome);
      // Carry over what can be carried over: weights are position-indexed in a
      // regenerated topology, so we only reuse them when the shape still matches.
      if (human.brain.synCount === learnedWeights.length) {
        human.brain.w.set(learnedWeights);
        human.brain.initialWeights.set(learnedWeights);
      }
    }

    this.emitEvent(
      'god',
      `${human.name}: ${def.label} ${previous.toFixed(3)} → ${clamped.toFixed(3)} (lineage conditions broken).`,
      [human.id],
    );
    return true;
  }

  // ---------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------

  computeStats(): WorldStats {
    let males = 0;
    let females = 0;
    let babies = 0;
    let children = 0;
    let adults = 0;
    let elders = 0;
    let pregnancies = 0;
    let neurons = 0;
    let synapses = 0;
    let drift = 0;

    for (const human of this.humans) {
      if (!human.alive) continue;
      if (human.sex === Sex.Male) males++;
      else females++;
      switch (human.stage) {
        case LifeStage.Baby:
          babies++;
          break;
        case LifeStage.Child:
          children++;
          break;
        case LifeStage.Adult:
          adults++;
          break;
        default:
          elders++;
          break;
      }
      if (human.pregnancy) pregnancies++;
      neurons += human.brain.n;
      synapses += human.brain.synCount;
      drift += human.brain.weightDrift();
    }

    const population = this.humans.length;
    return {
      population,
      males,
      females,
      babies,
      children,
      adults,
      elders,
      pregnancies,
      births: this.births,
      deaths: this.deaths,
      oldestGeneration: this.maxGeneration,
      predators: this.predators.length,
      plants: this.plants.length,
      averageNeurons: population > 0 ? neurons / population : 0,
      averageSynapses: population > 0 ? synapses / population : 0,
      averageWeightDrift: population > 0 ? drift / population : 0,
      seed: this.seed,
      tick: this.tick,
      simTime: this.simTime,
      dayPhase: this.climate.dayPhase,
      light: this.climate.light,
      ambientTemperature: this.ambientTemperatureAt(this.terrain.width / 2, this.terrain.height / 2),
      climateOffset: this.climate.globalOffset,
    };
  }

  humanDetail(id: number): HumanDetail | null {
    const human = this.humanById.get(id);
    if (!human) return null;

    const mother = human.motherId !== null ? this.humanById.get(human.motherId) : undefined;
    const father = human.fatherId !== null ? this.humanById.get(human.fatherId) : undefined;
    const children: RelativeView[] = [];
    for (const childId of human.childrenIds) {
      const child = this.humanById.get(childId);
      if (child) children.push(this.relativeView(child));
    }
    const siblings: RelativeView[] = [];
    for (const other of this.humans) {
      if (other.id === human.id) continue;
      if (
        (human.motherId !== null && (other.motherId === human.motherId || other.fatherId === human.motherId)) ||
        (human.fatherId !== null && (other.motherId === human.fatherId || other.fatherId === human.fatherId))
      ) {
        siblings.push(this.relativeView(other));
      }
    }

    const social: SocialRecordView[] = [];
    for (const record of human.memory.entries()) {
      const other = this.humanById.get(record.id);
      social.push({
        id: record.id,
        name: other ? other.name : `#${record.id}`,
        familiarity: record.familiarity,
        attachment: record.attachment,
        valence: record.valence,
        lastSeenTick: record.lastSeenTick,
        encounters: record.encounters,
        matings: record.matings,
        related: record.relatedness,
        alive: other ? other.alive : false,
      });
    }

    const pregnancy = human.pregnancy
      ? {
          fatherId: human.pregnancy.fatherId,
          fatherName: this.humanById.get(human.pregnancy.fatherId)?.name ?? `#${human.pregnancy.fatherId}`,
          progress: human.pregnancy.progress,
          conceptionTick: human.pregnancy.conceptionTick,
          embryoGeneration: Math.max(
            human.generation,
            this.humanById.get(human.pregnancy.fatherId)?.generation ?? 0,
          ) + 1,
        }
      : null;

    const matePartner = human.mating ? this.humanById.get(human.mating.partnerId) : undefined;

    const genome: GeneView[] = [];
    for (const key of Object.keys(human.genome) as (keyof Genome)[]) {
      if (key === 'species') continue;
      const def = geneDef(key as GeneKey);
      const report = this.inheritanceReports.get(human.id);
      const motherGenome = report ? human.pregnancy?.motherGenome : undefined;
      const fatherGenome = report ? human.pregnancy?.fatherGenome : undefined;
      genome.push({
        key,
        label: def.label,
        group: def.group,
        value: human.genome[key] as number,
        min: def.min,
        max: def.max,
        step: def.step,
        integer: def.integer ?? false,
        description: def.description,
        motherValue: motherGenome ? (motherGenome[key] as number) : null,
        fatherValue: fatherGenome ? (fatherGenome[key] as number) : null,
      });
    }

    return {
      id: human.id,
      name: human.name,
      sex: human.sex,
      ageBio: human.ageBio,
      stage: human.stage,
      generation: human.generation,
      alive: human.alive,
      deathTick: human.deathTick,
      deathReason: human.deathReason,
      birthTick: human.birthTick,
      health: human.health,
      hunger: human.hunger,
      thirst: human.thirst,
      energy: human.energy,
      fatigue: human.fatigue,
      pain: human.pain,
      stress: human.stress,
      bodyTemperature: human.bodyTemperature,
      ambientTemperature: this.ambientTemperatureAt(human.x, human.y),
      comfort: human.comfort,
      fertility: human.fertility01,
      libido: human.libido,
      currentAction: human.currentAction,
      actionStrength: human.actionStrength,
      currentFocus: human.currentFocus,
      motor: Array.from(human.motor),
      pregnancy,
      matingWith: human.mating ? human.mating.partnerId : null,
      matingWithName: matePartner ? matePartner.name : null,
      mother: mother ? this.relativeView(mother) : null,
      father: father ? this.relativeView(father) : null,
      children,
      siblings,
      social: social.slice(0, 14),
      neuronCount: human.brain.n,
      synapseCount: human.brain.synCount,
      excitatorySynapses: human.brain.stats().excitatory,
      inhibitorySynapses: human.brain.stats().inhibitory,
      weightDrift: human.brain.weightDrift(),
      meanAbsWeight: human.brain.meanAbsWeight(),
      genome,
      lifespan: human.genome.lifespan,
    };
  }

  private relativeView(human: Human): RelativeView {
    return {
      id: human.id,
      name: human.name,
      sex: human.sex,
      generation: human.generation,
      alive: human.alive,
      stage: human.stage,
    };
  }

  brainView(id: number): BrainView | null {
    const human = this.humanById.get(id);
    if (!human) return null;
    const brain = human.brain;
    const activity: number[] = new Array(brain.n);
    const potential: number[] = new Array(brain.n);
    let meanActivity = 0;
    let activeNeurons = 0;
    for (let i = 0; i < brain.n; i++) {
      const value = Math.min(1, brain.rate[i] * 4);
      activity[i] = value;
      potential[i] = brain.v[i];
      meanActivity += value;
      if (value > 0.2) activeNeurons++;
    }
    meanActivity /= brain.n;

    // Strongest synapses only — rendering every connection is unreadable.
    const order: number[] = [];
    for (let s = 0; s < brain.synCount; s++) order.push(s);
    order.sort((a, b) => Math.abs(brain.w[b]) - Math.abs(brain.w[a]));
    const limit = Math.min(280, order.length);
    const synapses: Array<[number, number, number]> = [];
    for (let i = 0; i < limit; i++) {
      const s = order[i];
      synapses.push([brain.pre[s], brain.post[s], brain.w[s]]);
    }

    const stats = brain.stats();
    return {
      entityId: id,
      neuronCount: brain.n,
      activity,
      potential,
      motor: Array.from(human.motor),
      synapses,
      stats: {
        meanActivity,
        activeNeurons,
        excitatory: stats.excitatory,
        inhibitory: stats.inhibitory,
      },
    };
  }

  explain(id: number): ExplanationView | null {
    const human = this.humanById.get(id);
    if (!human) return null;
    const explanation = explainAction(human.brain, human.actionIndex, human.sensors, this.tick);
    return {
      tick: explanation.tick,
      action: explanation.action,
      strength: explanation.strength,
      summary: explanation.summary,
      path: explanation.path.map((node) => ({
        label: node.label,
        short: node.short,
        region: node.region,
        contribution: node.contribution,
        activation: node.activation,
      })),
      note: explanation.note,
    };
  }

  /** Family tree rooted at the founders, including dead ancestors. */
  genealogyForest(): TreeNode[] {
    const nodes = new Map<number, TreeNode>();
    const build = (id: number): TreeNode | null => {
      const existing = nodes.get(id);
      if (existing) return existing;
      const human = this.humanById.get(id);
      if (!human) return null;
      const node: TreeNode = {
        id: human.id,
        name: human.name,
        generation: human.generation,
        sex: human.sex,
        alive: human.alive,
        children: [],
      };
      nodes.set(id, node);
      for (const childId of human.childrenIds) {
        const child = this.humanById.get(childId);
        if (!child) continue;
        // Avoid infinite recursion in pathological cyclic data.
        if (nodes.has(childId)) continue;
        const childNode = build(childId);
        if (childNode) node.children.push(childNode);
      }
      return node;
    };

    const roots: TreeNode[] = [];
    for (const human of this.humans) {
      if (human.generation === 0) {
        const node = build(human.id);
        if (node) roots.push(node);
      }
    }
    // Orphans (founders removed from the population) are shown too.
    for (const human of this.humans) {
      if (human.generation > 0 && !nodes.has(human.id)) {
        const parentKnown =
          (human.motherId !== null && this.humanById.has(human.motherId)) ||
          (human.fatherId !== null && this.humanById.has(human.fatherId));
        if (!parentKnown) {
          const node = build(human.id);
          if (node) roots.push(node);
        }
      }
    }
    return roots;
  }

  /** Build the compact snapshot handed to the renderer. */
  buildSnapshot(revision: number, metrics: DevMetrics): WorldSnapshot {
    let count = 0;
    for (const human of this.humans) if (human.alive) count++;
    const predatorTotal = this.predators.length;
    const plantTotal = this.plants.length;
    const total = count + predatorTotal + plantTotal;

    const ids = new Int32Array(total);
    const floats = new Float32Array(total * SNAPSHOT_FLOAT_STRIDE);
    const meta = new Uint8Array(total * SNAPSHOT_META_STRIDE);
    let index = 0;

    const write = (
      id: number,
      kind: number,
      sex: number,
      stage: number,
      flags: number,
      x: number,
      y: number,
      heading: number,
      size: number,
      hue: number,
      saturation: number,
      lightness: number,
      health01: number,
      action: number,
      pregnancy01: number,
      mating01: number,
      age01: number,
    ): void => {
      ids[index] = id;
      const f = index * SNAPSHOT_FLOAT_STRIDE;
      floats[f] = x;
      floats[f + 1] = y;
      floats[f + 2] = heading;
      floats[f + 3] = size;
      floats[f + 4] = hue;
      floats[f + 5] = saturation;
      floats[f + 6] = lightness;
      floats[f + 7] = health01;
      floats[f + 8] = action;
      floats[f + 9] = pregnancy01;
      floats[f + 10] = mating01;
      floats[f + 11] = age01;
      const m = index * SNAPSHOT_META_STRIDE;
      meta[m] = kind;
      meta[m + 1] = sex;
      meta[m + 2] = stage;
      meta[m + 3] = flags;
      index++;
    };

    for (const human of this.humans) {
      if (!human.alive) continue;
      let flags = 0;
      if (human.pain > 35 || human.health < 55) flags |= EntityFlags.Injured;
      if (human.sleeping) flags |= EntityFlags.Sleeping;
      if (human.mating) flags |= EntityFlags.Mating;
      if (human.pregnancy) flags |= EntityFlags.Pregnant;
      if (human.attacking) flags |= EntityFlags.Attacking;
      if (human.feeding) flags |= EntityFlags.Feeding;
      write(
        human.id,
        EntityKind.Human,
        human.sex,
        human.stage,
        flags,
        human.x,
        human.y,
        human.heading,
        human.bodyScale(),
        human.genome.hue,
        human.genome.saturation,
        human.genome.lightness,
        human.health / 100,
        human.actionIndex,
        human.pregnancyProgress(),
        human.mating ? human.mating.progress : 0,
        Math.min(1, human.ageBio / human.genome.lifespan),
      );
    }

    for (const predator of this.predators) {
      let flags = 0;
      if (predator.health < predator.maxHealth * 0.55) flags |= EntityFlags.Injured;
      if (predator.attacking) flags |= EntityFlags.Attacking;
      write(
        predator.id,
        EntityKind.Predator,
        2,
        predator.stage,
        flags,
        predator.x,
        predator.y,
        predator.heading,
        predator.bodyScale(),
        predator.genome.hue,
        predator.genome.saturation,
        predator.genome.lightness,
        predator.health / predator.maxHealth,
        predator.actionIndex,
        0,
        0,
        Math.min(1, predator.ageBio / predator.genome.lifespan),
      );
    }

    for (const plant of this.plants) {
      const profile = SPECIES_PROFILES[plant.species];
      write(
        plant.id,
        EntityKind.Plant,
        plant.species,
        0,
        0,
        plant.x,
        plant.y,
        0,
        plant.radius,
        profile.hue,
        profile.saturation,
        profile.lightness,
        plant.foodFraction(),
        0,
        0,
        0,
        0,
      );
    }

    const stats = this.computeStats();
    return {
      revision,
      tick: this.tick,
      simTime: this.simTime,
      dayPhase: this.climate.dayPhase,
      light: this.climate.light,
      ambientTemperature: stats.ambientTemperature,
      count: index,
      ids,
      floats,
      meta,
      stats,
      events: this.events.slice(-120),
      effects: this.effects.map((e) => ({ ...e })),
      metrics: { ...metrics, entityCount: index, humanCount: count, predatorCount: predatorTotal, plantCount: plantTotal },
    };
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  serialize(): Record<string, unknown> {
    return {
      seed: this.seed,
      options: this.options,
      tick: this.tick,
      simTime: this.simTime,
      rng: this.rng.getState(),
      climate: { ...this.climate },
      humans: this.humans.map((h) => h.serialize()),
      predators: this.predators.map((p) => p.serialize()),
      plants: this.plants.map((p) => p.serialize()),
      events: this.events.slice(-200),
      effects: this.effects,
      names: this.nameRegistry.snapshot(),
      nextEntityId: this.nextEntityId,
      nextEventId: this.nextEventId,
      nextEffectId: this.nextEffectId,
      births: this.births,
      deaths: this.deaths,
      maxGeneration: this.maxGeneration,
      totalMatings: this.totalMatings,
      reachedMilestones: [...this.reachedMilestones],
      matingPairs: this.matingPairs,
      inheritanceReports: [...this.inheritanceReports.entries()].map(([id, report]) => [id, report]),
    };
  }

  static deserialize(data: Record<string, unknown>): World {
    const world = new World(data.options as WorldOptions);
    // Wipe the freshly generated world and replace it with the saved state.
    world.humans = [];
    world.predators = [];
    world.plants = [];
    world.events = [];
    world.effects = [];
    world.humanById.clear();
    world.predatorById.clear();
    world.matingPairs = [];

    world.tick = data.tick as number;
    world.simTime = data.simTime as number;
    world.climate = { ...(data.climate as Climate) };

    world.nameRegistry.restore((data.names as string[]) ?? []);
    world.nextEntityId = data.nextEntityId as number;
    world.nextEventId = data.nextEventId as number;
    world.nextEffectId = data.nextEffectId as number;
    world.births = (data.births as number) ?? 0;
    world.deaths = (data.deaths as number) ?? 0;
    world.maxGeneration = (data.maxGeneration as number) ?? 0;
    world.totalMatings = (data.totalMatings as number) ?? 0;
    for (const m of (data.reachedMilestones as number[]) ?? []) world.reachedMilestones.add(m);

    for (const raw of (data.humans as Record<string, unknown>[]) ?? []) {
      const human = Human.deserialize(raw, world.rng.fork());
      world.humans.push(human);
      world.humanById.set(human.id, human);
    }
    for (const raw of (data.predators as Record<string, unknown>[]) ?? []) {
      const predator = Predator.deserialize(raw, world.rng.fork());
      world.predators.push(predator);
      world.predatorById.set(predator.id, predator);
    }
    for (const raw of (data.plants as Record<string, unknown>[]) ?? []) {
      world.plants.push(Plant.deserialize(raw));
    }
    for (const event of (data.events as WorldEvent[]) ?? []) world.events.push(event);
    for (const effect of (data.effects as WorldEffect[]) ?? []) world.effects.push(effect);
    world.matingPairs = ((data.matingPairs as MatingPair[]) ?? []).map((p) => ({ ...p }));
    for (const [id, stored] of (data.inheritanceReports as Array<[number, StoredInheritance]>) ?? []) {
      world.inheritanceReports.set(id, stored);
    }

    // The world PRNG state is restored LAST.
    //
    // Building entities consumes the world stream (each entity gets a forked
    // child stream), so restoring the state before them would leave the world's
    // own stream advanced past the saved position and the restored world would
    // diverge on the very next random draw. Entity streams are restored from
    // their own saved state, so the order in which they are forked here is
    // irrelevant.
    world.rng.setState(data.rng as number[]);

    world.rebuildGrids();
    return world;
  }
}

const MILESTONES = [10, 15, 20, 30, 50, 80, 120, 200];

export { MOTOR_NAMES, MOTOR_START, labelNeuron, regionOf, STAGE_NAMES, WORLD_W, WORLD_H, Sex, LifeStage };
