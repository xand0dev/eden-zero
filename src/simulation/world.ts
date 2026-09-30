import { Rng } from './rng';
import { DAY_SECONDS, DT, MAX_CANALS, MAX_EVENTS, MAX_FIELDS, MAX_PLANTS, MAX_POPULATION, MAX_PREDATORS, MAX_STRUCTURES, SIM_HZ, SPATIAL_CELL, WORLD_H, WORLD_W, AGE_ADULT_END, AGE_CHILD_END } from '../shared/constants';
import { SpatialGrid } from './spatial/grid';
import { FOOTPRINT, Occupancy, Occupant, snap } from './spatial/occupancy';
import { generateTerrain, nearestWalkable, computeWaterDistance, tileAt, waterDistanceAt, Tile, isFreshAt, type TerrainData } from './environment/terrain';
import { ambientTemperature, createClimate, DAY_PHASE_AT_GENESIS, updateClimate, type Climate } from './environment/climate';
import { Human, MATING_DURATION, MATING_REFRACTORY } from './entities/human';
import { Predator } from './entities/predator';
import { FoodOrigin, Plant, PlantSpecies, SPECIES_PROFILES, type GrowthConditions } from './entities/plant';
import { Structure, StructureKind, STRUCTURE_NAMES, WOOD_PER_HUT, isDwelling, type StructureData } from './entities/structure';
import {
  CANAL_REACH,
  CANAL_SOURCE_RANGE,
  Canal,
  Field,
  FIELD_YIELD,
  FieldStage,
  type CanalData,
  type FieldData,
  type FieldFactors,
} from './entities/cultivation';
import { calendarAt, seasonFactors, SEASON_NAMES, YEAR_SECONDS, type SeasonFactors } from './game/calendar';
import { DEFAULT_RULES, rulesFor, type WorldRules } from './game/laws';
import { biomeById, terrainParamsFor } from './game/biomes';
import { Soil, SOIL_SEED_FLOOR, SOIL_UPDATE_INTERVAL } from './game/soil';
import { Paths, PATH_SPEED } from './game/paths';
import { createEraState, ERA_CHECK_INTERVAL, ERA_NAMES, ERA_NUMERALS, ERA_SENSOR, Era, requirementsFor, updateEra, type EraInputs, type EraState } from './game/eras';
import { CRISES, createFate, crisisFactors, NEUTRAL_FACTORS, updateFate, type CrisisFactors, type FateState } from './game/crises';
import { createFavour, FAVOUR_BASE_RATE, FAVOUR_REWARDS, favourCap, grant, priceOf, type FavourState } from './game/favour';
import { Chronicle, obituary, ordinal, type ChronicleEntry } from './game/chronicle';
import { ATLAS, atlasEntry, createLog, epithetFor, evaluate, regionIndex, SAMPLE_INTERVAL, type AtlasSubject, type BehaviourLog } from './game/atlas';
import {
  GRANARY_RANGE,
  GRANARY_SPOILAGE_PER_DAY,
  GRANARY_STALL,
  PALISADE_BLOCK,
  SHRINE_RANGE,
  WELL_REACH,
  WORKSHOP_BONUS,
  WORKSHOP_RANGE,
  structureKindFor,
} from './game/buildings';
import type { GameView, HouseStats, SpotlightView } from '../shared/types';
import type { GodCommand } from '../shared/protocol';
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

/** Closest two canal lengths may be staked. */
const CANAL_SPACING = 2.2;
/**
 * No new hut site or canal length is staked while an unfinished one lies within
 * this many tiles: work already started has to be finished first.
 *
 * The spacing rules used to be answered by 8-tile grid cells rather than by
 * distance, which accidentally kept sites ~8–16 tiles apart. Measured once the
 * distances were real: 21 hut sites and no finished hut after 20 000 ticks,
 * because timber was spread across every site anyone had started. Anyone can
 * still start work; it just has to be where no started work is waiting.
 */
const UNFINISHED_WORK_RANGE = 10;
/**
 * Two lengths this close are one channel: water in one flows into the other.
 *
 * Also the distance within which a new length may be staked beside an old one,
 * so every length the world accepts as a continuation actually is one. These
 * used to differ (staked within 3.2, linked within 2.5), and a length staked in
 * between was accepted, dug, and never carried water.
 */
const CANAL_LINK = 3.2;

const TICKS_PER_DAY = DAY_SECONDS * SIM_HZ;
/** First of the four threat channels (front, right, back, left). */
const S_THREAT_FRONT = 12;
const TICKS_PER_YEAR = YEAR_SECONDS * SIM_HZ;

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

/** How the world is played. */
export type WorldMode = 'campaign' | 'sandbox' | 'challenge' | 'daily';

export interface WorldOptions {
  seed: string;
  initialHumans: number;
  initialPredators: number;
  /** Initial plant density multiplier. */
  plantDensity: number;
  /** Absent in older saves and in tests: a sandbox, where favour is off. */
  mode?: WorldMode;
  /** Law ids. See `game/laws.ts`. */
  charter?: string[];
  /** Biome id. See `game/biomes.ts`. */
  biome?: string;
  /** Genomes from the vault that replace the first founders' random ones. */
  founderGenomes?: Genome[];
  /** Challenge this world was started for, if any. */
  challengeId?: string;
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
  settlementCentre: { x: number; y: number } | null = null;
  /**
   * Huts, finished and under construction.
   *
   * Capped so a long-running world cannot accumulate unbounded geometry; the cap
   * is generous (see MAX_STRUCTURES) because a thriving village genuinely does
   * keep building.
   */
  readonly structures: Structure[] = [];

  /**
   * Fields under cultivation.
   *
   * The second thing in the world that persists. A field is a place the
   * settlement returns to: sown, ripened, harvested, and watered by a canal if
   * anyone dug one.
   */
  readonly fields: Field[] = [];

  /** Dug channels carrying water from the river to the fields. */
  readonly canals: Canal[] = [];

  /** Completed huts. Maintained incrementally so stats stay cheap. */
  private huts = 0;

  /** Standing timber left on the map. Felling is a lasting change. */
  private get totalTimber(): number {
    let sum = 0;
    for (let i = 0; i < this.plants.length; i++) {
      const plant = this.plants[i];
      if (plant.alive && plant.timber > 0) sum += plant.timber;
    }
    return sum;
  }
  private nextEventId = 1;
  private nextEffectId = 1;

  private humanById = new Map<number, Human>();
  private predatorById = new Map<number, Predator>();

  private humanGrid: SpatialGrid;
  private predatorGrid: SpatialGrid;
  private plantGrid: SpatialGrid;
  private structureGrid: SpatialGrid;
  private fieldGrid: SpatialGrid;
  private canalGrid: SpatialGrid;
  /**
   * The land grid: which object owns each one-tile cell. One cell, one object —
   * the first Rule of Creation. See spatial/occupancy.ts.
   */
  readonly land: Occupancy;

  // --- the game layer ----------------------------------------------------
  /** The charter and biome, resolved into numbers the physics reads. */
  readonly rules: WorldRules;
  /** Seasonal physics this tick. */
  season: SeasonFactors;
  /** Crisis physics this tick. */
  crisis: CrisisFactors = NEUTRAL_FACTORS;
  /** Ground fertility: the carrying capacity. */
  readonly soil: Soil;
  /** Worn trails. */
  readonly paths: Paths;
  eraState: EraState = createEraState();
  fate: FateState;
  favour: FavourState;
  readonly chronicle = new Chronicle();
  /** Behaviour records for the atlas, by person id. Kept for the dead too, until compacted. */
  readonly logs = new Map<number, BehaviourLog>();
  /** First time each atlas entry was seen in this world. */
  readonly discovered = new Map<string, { tick: number; humanId: number; name: string }>();
  /** Atlas entries seen this session that the observer has not been told about yet. */
  pendingDiscoveries: string[] = [];
  /** Every accepted observer command, with the tick it was applied at: a replay. */
  commandLog: Array<{ tick: number; command: GodCommand }> = [];
  /** Plants on fire, by plant id, with ticks left to burn. */
  readonly burning = new Map<number, number>();
  /** Structures on fire, by structure id, with ticks left to burn. */
  readonly burningStructures = new Map<number, number>();
  /** Rain showers the observer has called, still falling. */
  rains: Array<{ x: number; y: number; radius: number; ticks: number }> = [];
  /** Who is in the spotlight, for the director camera. */
  spotlight: SpotlightView[] = [];
  /** People who have died, kept briefly for obituaries and the atlas. */
  private lastCrisisSurvivedCount = 0;

  /** Lifetime counters that must survive entity death. */
  births = 0;
  deaths = 0;
  maxGeneration = 0;
  totalMatings = 0;
  /**
   * Food eaten over the world's life, by where it came from, in food units.
   *
   * Counting a harvest says a crop was brought in; this says whether anyone ate
   * it. Pure bookkeeping — nothing reads it back into the simulation.
   */
  readonly foodEaten = { wild: 0, crop: 0, pile: 0 };

  private readonly scratchA: number[] = [];
  private readonly scratchB: number[] = [];
  private readonly structureScratch: number[] = [];
  private readonly fieldScratch: number[] = [];
  private readonly canalScratch: number[] = [];

  constructor(options: WorldOptions) {
    this.options = options;
    this.seed = options.seed;
    this.rng = new Rng(`${options.seed}:world`);
    const rules = rulesFor(options.charter ?? []);
    biomeById(options.biome).apply(rules);
    this.rules = rules;
    this.terrain = generateTerrain(options.seed, WORLD_W, WORLD_H, terrainParamsFor(options.biome));
    this.waterDistance = computeWaterDistance(this.terrain);
    this.climate = createClimate();
    this.soil = new Soil(this.terrain.width, this.terrain.height);
    this.paths = new Paths(this.terrain.width, this.terrain.height);
    this.season = seasonFactors(0, this.seasonOptions());
    this.fate = createFate(options.seed, rules.crisisFrequency);
    this.favour = createFavour(options.mode !== undefined && options.mode !== 'sandbox');

    this.humanGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.predatorGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.plantGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.structureGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.fieldGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.canalGrid = new SpatialGrid(this.terrain.width, this.terrain.height, SPATIAL_CELL);
    this.land = new Occupancy(this.terrain.width, this.terrain.height);

    this.seedPlants(options.plantDensity);
    this.seedFounders(rules.foundersOverride > 0 ? rules.foundersOverride : options.initialHumans);
    this.seedPredators(Math.round(options.initialPredators * rules.predatorsAtGenesis));

    // Populate the spatial grids immediately.
    //
    // `step()` rebuilds them at the top of every tick, so before this line a
    // freshly constructed world had empty grids: any query — "what plants are
    // near me" — returned nothing until the first tick had run. That is a
    // surprising contract for callers and it silently broke the first harvest
    // test, which is exactly the kind of thing a test should catch.
    this.rebuildGrids();

    const founders = this.humans.length;
    this.emitEvent('milestone', `Genesis — ${founders} humans awaken in world "${options.seed}".`, []);
    this.chronicle.add({
      tick: 0,
      simTime: 0,
      kind: 'genesis',
      importance: 3,
      title: 'Genesis',
      text: `${founders} people wake beside fresh water on the island of ${options.seed}, in the ${biomeById(options.biome).name.toLowerCase()}.`,
      entityIds: this.humans.map((h) => h.id),
      x: this.settlementCentre?.x,
      y: this.settlementCentre?.y,
    });
    for (const human of this.humans) this.logs.set(human.id, createLog(human.id));
  }

  private seasonOptions(): { amplitude: number; eternalSpring: boolean } {
    return { amplitude: this.rules.seasonAmplitude, eternalSpring: this.rules.eternalSpring };
  }

  /** Options for building a human brain under this world's laws. */
  get brainOptions(): { innateScale: number } {
    return { innateScale: this.rules.innatePriors };
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
        this.land.claim(plant.x, plant.y, Occupant.Plant, plant.id);
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
        if (!this.land.claim(x, y, Occupant.Plant, this.nextEntityId)) continue;
        this.plants.push(new Plant(this.nextEntityId++, PlantSpecies.Grass, snap(x), snap(y), this.rng, 0.8));
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
      let genome = randomGenome(this.rng, 0);
      // A genome from the vault replaces the random one. The random draw above
      // still happens, so the rest of genesis consumes the stream identically.
      const vaulted = this.options.founderGenomes?.[i];
      if (vaulted) genome = sanitizeGenome(cloneGenome(vaulted));
      const name = this.nameRegistry.claim(FOUNDER_NAMES[i % FOUNDER_NAMES.length]);
      const human = new Human(this.nextEntityId++, name, sex, genome, this.rng.fork(), this.brainOptions);
      human.x = x;
      human.y = y;
      human.homeX = x;
      human.homeY = y;
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
      // Founders alternate between the two houses so a competitive match starts
      // from a fair split. In a single-observer world this is harmless: nothing
      // reads `house` unless a match is running.
      human.house = i % 2;
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

  // ---------------------------------------------------------------------
  // The game layer, as the inhabitants feel it
  // ---------------------------------------------------------------------

  /** Finished structures by kind, rebuilt with the grids every tick. */
  private readonly finished: Structure[][] = [[], [], [], [], [], [], []];
  /** Total food held in granaries. */
  storedFood = 0;

  get era(): number {
    return this.eraState.era;
  }

  get eraSensor(): number {
    return ERA_SENSOR[this.eraState.era] ?? 0;
  }

  get storedFoodSensor(): number {
    const population = Math.max(1, this.humans.length);
    return Math.min(1, this.storedFood / (4 * population));
  }

  private finishedNear(kind: number, x: number, y: number, radius: number): Structure | null {
    const list = this.finished[kind];
    let best: Structure | null = null;
    let bestDistance = radius;
    for (let i = 0; i < list.length; i++) {
      const site = list[i];
      const distance = Math.hypot(site.x - x, site.y - y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = site;
      }
    }
    return best;
  }

  wellNear(x: number, y: number, radius: number): { x: number; y: number } | null {
    if (this.finished[StructureKind.Well].length === 0) return null;
    return this.finishedNear(StructureKind.Well, x, y, radius + WELL_REACH - 1);
  }

  workshopBonus(x: number, y: number): number {
    return this.finishedNear(StructureKind.Workshop, x, y, WORKSHOP_RANGE) ? WORKSHOP_BONUS : 1;
  }

  trailSpeed(x: number, y: number): number {
    return this.eraState.era >= Era.Village && this.paths.isTrail(x, y) ? PATH_SPEED : 1;
  }

  shrineNear(x: number, y: number): boolean {
    return this.finishedNear(StructureKind.Shrine, x, y, SHRINE_RANGE) !== null;
  }

  blockedForPredators(x: number, y: number): boolean {
    if (this.finished[StructureKind.Palisade].length === 0) return false;
    return this.finishedNear(StructureKind.Palisade, x, y, PALISADE_BLOCK) !== null;
  }

  private logOf(human: { id: number }): BehaviourLog | undefined {
    return this.logs.get(human.id);
  }

  noteWellDrink(human: Human): void {
    const log = this.logOf(human);
    if (log) log.wellDrinks += 1;
  }

  noteStrike(attacker: Human): void {
    const log = this.logOf(attacker);
    if (log) log.struck += 1;
  }

  noteFeverRecovered(human: Human): void {
    const log = this.logOf(human);
    if (log) log.feverRecovered += 1;
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
    let temperature =
      ambientTemperature(this.terrain, this.climate, x, y) +
      this.season.temperature +
      this.crisis.temperature +
      this.rules.temperatureOffset;
    // A finished dwelling holds warmth the way a rock shelter does, a stone
    // house more so. This is what makes a hut worth having in winter.
    const count = this.structureGrid.queryCircle(x, y, 5, this.structureScratch);
    let warmth = 0;
    for (let i = 0; i < count; i++) {
      const site = this.structures[this.structureScratch[i]];
      if (!site || !site.complete || !isDwelling(site.kind)) continue;
      const reach = site.kind === StructureKind.StoneHouse ? 5 : 4;
      const distance = Math.hypot(site.x - x, site.y - y);
      if (distance >= reach) continue;
      const strength = (1 - distance / reach) * (site.kind === StructureKind.StoneHouse ? 0.9 : 0.7);
      if (strength > warmth) warmth = strength;
    }
    if (warmth > 0) temperature += (6.5 - temperature) * warmth;
    return temperature;
  }

  queryStructures(x: number, y: number, radius: number, out: number[]): number {
    return this.structureGrid.queryCircle(x, y, radius, out);
  }

  harvestWood(plantIndex: number, amount: number, worker?: Human): number {
    const plant = this.plants[plantIndex];
    if (!plant || !plant.alive) return 0;
    const taken = plant.takeTimber(amount);
    if (worker && taken > 0) {
      const log = this.logOf(worker);
      if (log) log.timber += taken;
    }
    return taken;
  }

  // ---------------------------------------------------------------------
  // Cultivation
  // ---------------------------------------------------------------------

  /**
   * Whether water reaches a point.
   *
   * True beside open water, or beside a canal that is itself carrying water. A
   * field uses this to decide whether to grow or to dry out.
   */
  private waterAt(x: number, y: number): boolean {
    if (waterDistanceAt(this.terrain, this.waterDistance, x, y) <= CANAL_SOURCE_RANGE) return true;
    for (const rain of this.rains) {
      if (Math.hypot(rain.x - x, rain.y - y) <= rain.radius) return true;
    }
    const count = this.queryCanals(x, y, CANAL_REACH, this.canalScratch);
    for (let i = 0; i < count; i++) {
      const canal = this.canals[this.canalScratch[i]];
      if (canal?.flowing && Math.hypot(canal.x - x, canal.y - y) <= CANAL_REACH) return true;
    }
    return false;
  }

  /** Whether a site or length that is started but not complete lies within `UNFINISHED_WORK_RANGE`. */
  private unfinishedWithin(
    grid: SpatialGrid,
    items: ReadonlyArray<{ x: number; y: number; complete: boolean }>,
    x: number,
    y: number,
  ): boolean {
    const count = this.within(grid, items, x, y, UNFINISHED_WORK_RANGE, this.scratchA);
    for (let i = 0; i < count; i++) if (!items[this.scratchA[i]].complete) return true;
    return false;
  }

  /**
   * Indices of the entities in `grid` within `radius` of a point, into `out`.
   *
   * The spatial grid answers with every entity in the cells a circle overlaps —
   * up to sixteen tiles away for a small radius — and leaves the distance test
   * to the caller. Every spacing and reach rule in this file used the raw count,
   * so a canal could not be dug beside the last length (the chain the flow model
   * relies on was impossible) while one ten tiles away still counted as
   * "touching" it. This is the one place that turns a cell query into a radius.
   */
  private within(
    grid: SpatialGrid,
    items: ReadonlyArray<{ x: number; y: number }>,
    x: number,
    y: number,
    radius: number,
    out: number[],
  ): number {
    const count = grid.queryCircle(x, y, radius, out);
    let kept = 0;
    for (let i = 0; i < count; i++) {
      const item = items[out[i]];
      if (item && Math.hypot(item.x - x, item.y - y) <= radius) out[kept++] = out[i];
    }
    out.length = kept;
    return kept;
  }

  /**
   * Advance every field and work out which canals are actually carrying water.
   *
   * A canal is live if it sits close enough to the river, or if it touches
   * another canal that is already live. Running the check twice lets a chain
   * propagate along its own length within one tick instead of taking one tick
   * per length, which matters when a canal is twenty tiles long.
   */
  updateCultivation(): void {
    const factors: FieldFactors = {
      growth: this.season.fieldGrowth * this.crisis.fieldGrowth,
      dry: this.rules.dryness * this.crisis.fieldDry,
    };
    for (const field of this.fields) field.update(DT, this.waterAt(field.x, field.y), factors);

    for (const canal of this.canals) canal.flowing = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const canal of this.canals) {
        if (!canal.complete || canal.flowing) continue;
        if (waterDistanceAt(this.terrain, this.waterDistance, canal.x, canal.y) <= CANAL_SOURCE_RANGE) {
          canal.flowing = true;
          continue;
        }
        const count = this.within(this.canalGrid, this.canals, canal.x, canal.y, CANAL_LINK, this.canalScratch);
        for (let i = 0; i < count; i++) {
          const other = this.canals[this.canalScratch[i]];
          if (other && other !== canal && other.flowing) {
            canal.flowing = true;
            break;
          }
        }
      }
    }
  }

  queryFields(x: number, y: number, radius: number, out: number[]): number {
    return this.fieldGrid.queryCircle(x, y, radius, out);
  }

  queryCanals(x: number, y: number, radius: number, out: number[]): number {
    return this.canalGrid.queryCircle(x, y, radius, out);
  }

  waterDistanceAt(x: number, y: number): number {
    return waterDistanceAt(this.terrain, this.waterDistance, x, y);
  }

  /**
   * Nearest forest tile, found by sampling rings outward rather than by scanning
   * every tile — a full scan per human per tick would be thousands of tiles each.
   */
  nearestForest(x: number, y: number, radius: number): { dx: number; dy: number; distance: number } | null {
    const step = 2;
    for (let r = step; r <= radius; r += step) {
      const samples = Math.max(8, Math.round(r * 2));
      for (let a = 0; a < samples; a++) {
        const angle = (a / samples) * Math.PI * 2;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (tileAt(this.terrain, px, py) !== Tile.Forest) continue;
        const dx = px - x;
        const dy = py - y;
        return { dx, dy, distance: Math.hypot(dx, dy) };
      }
    }
    return null;
  }

  /**
   * Break new ground for a field.
   *
   * Only on grass, never in the forest and never on bare sand — a field is
   * something a settlement does to ground it already cleared, and it should read
   * as a clearing rather than as a patch in the middle of the woods.
   */
  foundField(x: number, y: number, worker: Human): Field | null {
    if (this.fields.length >= MAX_FIELDS) return null;
    if (tileAt(this.terrain, x, y) !== Tile.Grass) return null;
    if (this.within(this.fieldGrid, this.fields, x, y, 4.5, this.fieldScratch) > 0) return null;
    x = snap(x);
    y = snap(y);
    if (!this.claimGround(x, y, FOOTPRINT.field, Occupant.Field, this.nextEntityId)) return null;
    const field = new Field(this.nextEntityId++, x, y);
    field.fallowSince = this.tick;
    this.fields.push(field);
    this.fieldGrid.insert(this.fields.length - 1, x, y);
    this.emitEvent('build', `${worker.name} broke ground on a new field.`, [worker.id]);
    this.chronicle.first('field', {
      tick: this.tick,
      simTime: this.simTime,
      importance: 3,
      title: 'The first field',
      text: `${worker.name} broke ground for the first field. Nobody told anyone to farm.`,
      entityIds: [worker.id],
      x,
      y,
    });
    this.addEffect('build', x, y, 2.6, 1.8);
    return field;
  }

  sowField(index: number, worker: Human): boolean {
    const field = this.fields[index];
    if (!field) return false;
    if (!field.sow(this.tick, worker.name, TICKS_PER_DAY)) return false;
    field.sowerId = worker.id;
    const log = this.logOf(worker);
    if (log) log.fieldsSown += 1;
    this.emitEvent('build', `${worker.name} sowed a field.`, [worker.id]);
    this.addEffect('build', field.x, field.y, 1.8, 1.2);
    return true;
  }

  /**
   * Bring in a crop.
   *
   * The yield lands as a food pile beside the field rather than going straight
   * into the harvester's belly: a harvest is a thing the whole settlement eats,
   * and a pile is visible where a number is not.
   */
  harvestField(index: number, worker: Human): boolean {
    const field = this.fields[index];
    if (!field) return false;
    const rotated = field.rotation;
    const sowerId = field.sowerId;
    const amount = field.yieldNow() * this.season.harvestYield;
    if (!field.harvest(this.tick, worker.name)) return false;
    void FIELD_YIELD;

    // Into the granary if there is one close enough; otherwise onto the ground.
    const granary = this.finishedNear(StructureKind.Granary, field.x, field.y, GRANARY_RANGE);
    if (granary) {
      granary.store += amount;
      this.storedFood += amount;
    } else {
      // Always, even at the plant cap. The cap exists to stop wild growth
      // filling the map; with it applied here, a long-running world — which sits
      // at the cap permanently — turned every harvest into nothing but an event.
      // Carcasses were already exempt for the same reason.
      const px = field.x + this.rng.range(-1.2, 1.2);
      const py = field.y + this.rng.range(-1.2, 1.2);
      // Beside the field, on the first free cell outside it.
      const spot = this.pileSpot(px, py, 5);
      if (spot) {
        const pile = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, spot[0], spot[1], this.rng, 1);
        pile.food = amount;
        pile.crop = true;
        pile.origin = FoodOrigin.Crop;
        pile.harvesterId = worker.id;
        this.plants.push(pile);
        this.plantGrid.insert(this.plants.length - 1, pile.x, pile.y);
        this.land.claim(pile.x, pile.y, Occupant.Plant, pile.id);
      }
    }

    // Atlas bookkeeping: who reaped, whose canals watered it, whose rotation paid.
    const log = this.logOf(worker);
    if (log) log.crops += 1;
    const credited = new Set<number>();
    const canalCount = this.within(this.canalGrid, this.canals, field.x, field.y, CANAL_REACH + 0.5, this.canalScratch);
    for (let i = 0; i < canalCount; i++) {
      const canal = this.canals[this.canalScratch[i]];
      if (!canal?.flowing || !canal.finisherId || credited.has(canal.finisherId)) continue;
      credited.add(canal.finisherId);
      const digger = this.logs.get(canal.finisherId);
      if (digger) digger.irrigated += 1;
    }
    if (rotated && sowerId) {
      const sower = this.logs.get(sowerId);
      if (sower) sower.rotations += 1;
    }

    this.emitEvent('build', `${worker.name} brought in a crop${granary ? ' and stored it' : ''}.`, [worker.id]);
    this.addEffect('build', field.x, field.y, 3.2, 2.2);
    return true;
  }

  /**
   * Stake out one length of canal.
   *
   * Lengths are dug one at a time and chained from the river outward, so the
   * water arrives at the far end only once the whole line is finished. That is
   * what makes the canal read as a piece of infrastructure rather than as a
   * one-click upgrade.
   */
  foundCanal(x: number, y: number, worker: Human): Canal | null {
    if (this.canals.length >= MAX_CANALS) return null;
    const tile = tileAt(this.terrain, x, y);
    if (tile === Tile.Water || tile === Tile.Rock) return null;
    if (this.within(this.canalGrid, this.canals, x, y, CANAL_SPACING, this.canalScratch) > 0) return null;

    // A length may only be started next to water or next to an existing canal,
    // so the line has to be dug outward from the source rather than appearing
    // wherever someone happens to stand.
    // Both rules match the flow model exactly, so a length that is accepted is a
    // length that can carry water once dug.
    if (this.unfinishedWithin(this.canalGrid, this.canals, x, y)) return null;
    const nearWater = waterDistanceAt(this.terrain, this.waterDistance, x, y) <= CANAL_SOURCE_RANGE;
    const nearCanal = this.within(this.canalGrid, this.canals, x, y, CANAL_LINK, this.canalScratch) > 0;
    if (!nearWater && !nearCanal) return null;

    x = snap(x);
    y = snap(y);
    if (!this.claimGround(x, y, FOOTPRINT.canal, Occupant.Canal, this.nextEntityId)) return null;
    const canal = new Canal(this.nextEntityId++, x, y);
    this.canals.push(canal);
    this.canalGrid.insert(this.canals.length - 1, x, y);
    this.emitEvent('build', `${worker.name} began digging a canal.`, [worker.id]);
    return canal;
  }

  digCanal(index: number, worker: Human): boolean {
    const canal = this.canals[index];
    if (!canal) return false;
    const finished = canal.dig(this.tick, this.workshopBonus(canal.x, canal.y));
    if (finished) {
      canal.finisherId = worker.id;
      const log = this.logOf(worker);
      if (log) log.canalsFinished += 1;
      this.chronicle.first('canal', {
        tick: this.tick,
        simTime: this.simTime,
        importance: 3,
        title: 'The first canal',
        text: `${worker.name} finished the first length of canal.`,
        entityIds: [worker.id],
        x: canal.x,
        y: canal.y,
      });
      this.emitEvent('build', `${worker.name} finished a length of canal.`, [worker.id]);
      this.addEffect('build', canal.x, canal.y, 2.4, 1.6);
    }
    return true;
  }

  contributeWood(structureIndex: number, amount: number, builder: Human): number {
    const site = this.structures[structureIndex];
    if (!site || site.complete) return 0;
    const accepted = site.contribute(amount, this.tick, builder.id, builder.name);
    if (accepted <= 0) return 0;
    const log = this.logOf(builder);
    if (log) {
      log.woodLaid += accepted;
      log.lastBuildTick = this.tick;
      if (!log.sites.includes(site.id)) log.sites.push(site.id);
    }

    if (site.complete) {
      if (isDwelling(site.kind)) this.huts += 1;
      if (log) {
        log.completed += 1;
        log.completedKinds.push(site.kind);
      }
      const name = STRUCTURE_NAMES[site.kind] ?? 'hut';
      this.chronicle.first(`structure-${site.kind}`, {
        tick: this.tick,
        simTime: this.simTime,
        importance: 3,
        title: `The first ${name}`,
        text: `${builder.name} laid the last timber on the first ${name}.`,
        entityIds: [builder.id],
        x: site.x,
        y: site.y,
      });
      this.emitEvent(
        'build',
        `${builder.name} completed a ${name} at ${site.x.toFixed(0)}, ${site.y.toFixed(0)}.`,
        [builder.id],
      );
      this.addEffect('build', site.x, site.y, 3.4, 2.4);
    } else {
      this.emitEvent(
        'build',
        `${builder.name} added timber to a ${STRUCTURE_NAMES[site.kind] ?? 'hut'} (${Math.round(site.progress * 100)}%).`,
        [builder.id],
      );
      this.addEffect('build', site.x, site.y, 2.2, 1.2);
    }
    return accepted;
  }

  foundStructure(x: number, y: number, builder: Human, frontier = false): Structure | null {
    if (this.structures.length >= MAX_STRUCTURES) return null;
    // Keep sites a sensible distance apart so the village reads as a village and
    // not as one pile of huts. A palisade is a wall, so its segments may close
    // up — but that is decided after the kind is, below.
    const nearby = this.within(this.structureGrid, this.structures, x, y, 3.2, this.structureScratch);
    if (nearby > 0) return null;
    if (this.unfinishedWithin(this.structureGrid, this.structures, x, y)) return null;

    const [wx, wy] = nearestWalkable(this.terrain, x, y);
    const sx = snap(wx);
    const sy = snap(wy);
    const kind = this.siteKind(sx, sy);
    if (kind !== StructureKind.Palisade) {
      if (this.within(this.structureGrid, this.structures, sx, sy, 5.5, this.structureScratch) > 0) return null;
    }
    if (!this.claimGround(sx, sy, FOOTPRINT.structure, Occupant.Structure, this.nextEntityId)) return null;
    const site = new Structure(this.nextEntityId++, sx, sy, kind);
    this.structures.push(site);
    this.structureGrid.insert(this.structures.length - 1, sx, sy);
    if (frontier) {
      const log = this.logOf(builder);
      if (log) log.frontierFoundings += 1;
    }
    this.emitEvent('build', `${builder.name} staked out a new ${STRUCTURE_NAMES[kind]} site.`, [builder.id]);
    this.addEffect('build', sx, sy, 2.6, 1.6);
    return site;
  }

  /** What a site staked here becomes. See game/buildings.ts. */
  private siteKind(x: number, y: number): number {
    const centre = this.settlementCentre ?? { x, y };
    const reach = 26 + Math.min(24, this.structures.length * 1.8);
    const anyKindNear = (kind: number, radius: number): boolean => {
      for (const site of this.structures) {
        if (site.kind === kind && Math.hypot(site.x - x, site.y - y) <= radius) return true;
      }
      return false;
    };
    let rockNear = false;
    for (let dy = -4; dy <= 4 && !rockNear; dy += 2) {
      for (let dx = -4; dx <= 4; dx += 2) {
        if (tileAt(this.terrain, x + dx, y + dy) === Tile.Rock) {
          rockNear = true;
          break;
        }
      }
    }
    let shrines = 0;
    let workshops = 0;
    for (const site of this.structures) {
      if (site.kind === StructureKind.Shrine) shrines++;
      if (site.kind === StructureKind.Workshop) workshops++;
    }
    return structureKindFor({
      era: this.eraState.era,
      fieldNear: this.within(this.fieldGrid, this.fields, x, y, 6, this.fieldScratch) > 0,
      granaryNear: anyKindNear(StructureKind.Granary, 14),
      waterDistance: this.waterDistanceAt(x, y),
      wellNear: anyKindNear(StructureKind.Well, 16),
      workshops,
      huts: this.huts,
      population: this.humans.length,
      rockNear,
      edge: Math.hypot(x - centre.x, y - centre.y) / reach,
      shrines,
      deaths: this.deaths,
    });
  }

  /** Atlas bookkeeping for one bite. */
  private recordMeal(eater: Human, plant: Plant, taken: number): void {
    const log = this.logOf(eater);
    if (!log) return;
    log.meals += 1;
    if (this.climate.light < 0.28) log.nightMeals += 1;
    if (plant.species !== PlantSpecies.FoodPile) {
      log.foodWild += taken;
      return;
    }
    switch (plant.origin) {
      case FoodOrigin.Crop:
        log.foodCrop += taken;
        break;
      case FoodOrigin.Granary:
        log.foodGranary += taken;
        break;
      case FoodOrigin.Gift:
        log.foodGift += taken;
        break;
      default:
        log.foodCarcass += taken;
        break;
    }
    if ((plant.origin === FoodOrigin.Crop || plant.origin === FoodOrigin.Granary) && eater.wildInSight >= 5) {
      log.cropByChoice += taken;
    }
    if (
      plant.origin === FoodOrigin.Crop &&
      plant.harvesterId &&
      eater.ageBio < AGE_CHILD_END &&
      (eater.motherId === plant.harvesterId || eater.fatherId === plant.harvesterId)
    ) {
      const provider = this.logs.get(plant.harvesterId);
      if (provider) provider.fedChildren += 1;
    }
  }

  consumePlant(plantIndex: number, amount: number, eater?: Human): number {
    const plant = this.plants[plantIndex];
    if (!plant || !plant.alive) return 0;
    const taken = Math.min(plant.food, amount);
    plant.food -= taken;
    const wild = plant.species !== PlantSpecies.FoodPile;
    if (wild) {
      this.foodEaten.wild += taken;
      // Grazing exhausts the ground: the carrying capacity. See game/soil.ts.
      this.soil.graze(plant.x, plant.y, taken);
    } else if (plant.crop || plant.origin === FoodOrigin.Granary) this.foodEaten.crop += taken;
    else this.foodEaten.pile += taken;
    if (eater && taken > 0) this.recordMeal(eater, plant, taken);
    if (plant.food <= 0.0001 && plant.species === PlantSpecies.FoodPile) {
      plant.food = 0;
      plant.alive = false;
    }
    return taken;
  }

  damageHuman(target: Human, amount: number, reason: string, attackerId: number | null): void {
    if (!target.alive) return;
    amount *= this.rules.damageTaken;
    target.health -= amount;
    target.pain = Math.min(100, target.pain + amount * 3.2);
    if (reason.startsWith('predation')) {
      const log = this.logOf(target);
      if (log) log.predatorHitTick = this.tick;
    }
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
    this.structureGrid.clear();
    for (const list of this.finished) list.length = 0;
    for (let i = 0; i < this.structures.length; i++) {
      const site = this.structures[i];
      this.structureGrid.insert(i, site.x, site.y);
      if (site.complete) this.finished[site.kind]?.push(site);
    }

    this.fieldGrid.clear();
    for (let i = 0; i < this.fields.length; i++) {
      this.fieldGrid.insert(i, this.fields[i].x, this.fields[i].y);
    }

    this.canalGrid.clear();
    for (let i = 0; i < this.canals.length; i++) {
      this.canalGrid.insert(i, this.canals[i].x, this.canals[i].y);
    }
    this.rebuildLand();
  }

  /**
   * Re-claim the land grid from the objects standing on it. Buildings first,
   * then fields, canals and plants, so if two things ever share a cell (a save
   * from before the grid) the larger, more deliberate one keeps it.
   */
  private rebuildLand(): void {
    const land = this.land;
    land.clear();
    for (const site of this.structures) land.claimSquare(site.x, site.y, FOOTPRINT.structure, Occupant.Structure, site.id);
    for (const field of this.fields) land.claimSquare(field.x, field.y, FOOTPRINT.field, Occupant.Field, field.id);
    for (const canal of this.canals) land.claim(canal.x, canal.y, Occupant.Canal, canal.id);
    for (let i = 0; i < this.plants.length; i++) {
      const plant = this.plants[i];
      if (plant.alive) land.claim(plant.x, plant.y, Occupant.Plant, plant.id);
    }
  }

  /** Plants that give way to a field, a canal or a building: grass and bushes. Trees and food do not. */
  private readonly plantById = new Map<number, Plant>();
  private readonly clearable = (kind: Occupant, id: number): boolean => {
    if (kind !== Occupant.Plant) return false;
    const plant = this.plantById.get(id);
    return !!plant && (plant.species === PlantSpecies.Grass || plant.species === PlantSpecies.Bush);
  };
  private readonly clearScratch: number[] = [];

  /** Whether a square can be built on, clearing grass and bushes if it can. */
  private claimGround(x: number, y: number, half: number, kind: Occupant, id: number): boolean {
    this.plantById.clear();
    this.land.ownersInSquare(x, y, half, Occupant.Plant, this.clearScratch);
    if (this.clearScratch.length > 0) {
      for (const plant of this.plants) if (plant.alive && this.clearScratch.includes(plant.id)) this.plantById.set(plant.id, plant);
    }
    if (!this.land.squareFree(x, y, half, this.clearable)) return false;
    for (const plant of this.plantById.values()) {
      plant.alive = false;
      this.land.releaseSquare(plant.x, plant.y, 0, plant.id);
    }
    this.land.claimSquare(x, y, half, kind, id);
    return true;
  }

  /**
   * Where a pile of food can go: the nearest free walkable cell to (x, y), or
   * null if the ground around is full. A pile never lands on a field, a canal,
   * a building or another plant.
   */
  private pileSpot(x: number, y: number, maxRing = 4): [number, number] | null {
    return this.land.nearestFree(x, y, maxRing, (px, py) => {
      const tile = tileAt(this.terrain, px, py);
      return tile !== Tile.Water && tile !== Tile.Rock;
    });
  }

  step(): void {
    this.tick += 1;
    this.simTime += DT;
    updateClimate(this.climate, this.simTime);
    this.updateSky();
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
      this.paths.tread(human.x, human.y);
      if ((this.tick + human.id) % SAMPLE_INTERVAL === 0) this.sampleBehaviour(human);
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

    // --- cultivation ------------------------------------------------------
    this.updateCultivation();

    // --- the game layer: land, stores, fate, eras, favour, atlas ----------
    this.updateGame();

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

  private readonly growth: GrowthConditions = {
    regen: 1,
    spread: 1,
    timber: 1,
    spoilage: 1,
    seedFloor: SOIL_SEED_FLOOR,
    soilAt: (x, y) => this.soil.regenFactor(x, y),
    fertilityAt: (x, y) => this.soil.at(x, y),
  };

  private updatePlants(): void {
    const spreadAllowed = this.plants.length < MAX_PLANTS;
    const spawned: Plant[] = [];
    const growth = this.growth;
    growth.regen = this.season.plantRegen * this.rules.plantRegen * this.crisis.plantRegen;
    growth.spread = this.season.plantSpread;
    growth.timber = this.rules.timberRegen;
    growth.spoilage = this.season.spoilage;
    for (let i = 0; i < this.plants.length; i++) {
      const plant = this.plants[i];
      if (!plant.alive) continue;
      const child = plant.update(this.terrain, DT, this.rng, spreadAllowed, growth);
      if (child) {
        // A seed takes only in an empty cell, and grows at its centre.
        child.x = snap(child.x);
        child.y = snap(child.y);
        if (!this.land.claim(child.x, child.y, Occupant.Plant, this.nextEntityId)) continue;
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
    this.logOf(mother)?.partners.push(father.id);
    this.logOf(father)?.partners.push(mother.id);
    if (mother.pregnancy) return;
    // The one-child-a-year law: a mother too recently delivered does not conceive.
    const spacing = this.rules.birthSpacingYears * TICKS_PER_YEAR;
    if (spacing > 0 && this.tick - mother.lastBirthTick < spacing) return;

    // Conception is probabilistic and depends on both parents' fertility.
    const chance = 0.9 * Math.min(1, mother.fertility01) * Math.min(1, father.fertility01) * mother.genome.fertility;
    if (this.rng.next() > chance) return;

    const mutation = this.rules.mutationRate;
    const { genome, report } = reproduce(mother.genome, father.genome, this.rng, {
      rate: Math.min(1, 0.16 * mutation),
      strength: 0.05,
      structuralChance: Math.min(1, 0.02 * mutation),
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
    const twins = this.rules.twinChance > 0 && this.rng.next() < this.rules.twinChance;
    this.deliver(mother, pregnancy);
    if (twins && this.humans.length < MAX_POPULATION) {
      this.deliver(mother, pregnancy);
      this.emitEvent('birth', `${mother.name} had twins.`, [mother.id]);
    }
    this.afterBirth(mother);
  }

  private deliver(mother: Human, pregnancy: NonNullable<Human['pregnancy']>): void {
    const father = this.humanById.get(pregnancy.fatherId) ?? null;
    const genome = sanitizeGenome(cloneGenome(pregnancy.embryoGenome));

    const sex = this.rng.next() < 0.5 ? Sex.Female : Sex.Male;
    const name = this.nameRegistry.next(this.rng);
    const baby = new Human(this.nextEntityId++, name, sex, genome, this.rng.fork(), this.brainOptions);

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
    // Matrilineal: a child belongs to its mother's house. This is what makes a
    // house a lineage rather than a label, and it means a house can only grow
    // through its own women.
    baby.house = mother.house;
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

    // Lamarck (a law, off by default): a share of what the parents' reflexes
    // learned is written into the child's. Only the innate synapses line up
    // between two brains, so only they can be inherited this way.
    if (this.rules.lamarck > 0) {
      const count = baby.brain.synCount - baby.brain.innateStart;
      for (let k = 0; k < count; k++) {
        const fromMother = mother.brain.innateDrift(k);
        const fromFather = father ? father.brain.innateDrift(k) : fromMother;
        const s = baby.brain.innateStart + k;
        baby.brain.w[s] += this.rules.lamarck * 0.5 * (fromMother + fromFather);
      }
    }

    this.humans.push(baby);
    this.humanById.set(baby.id, baby);
    this.logs.set(baby.id, createLog(baby.id));
    baby.homeX = baby.x;
    baby.homeY = baby.y;

    mother.childrenIds.push(baby.id);
    mother.offspringCount += 1;
    if (father) {
      father.childrenIds.push(baby.id);
      father.offspringCount += 1;
    }

    this.births += 1;
    grant(this.favour, FAVOUR_REWARDS.birth, this.eraState.era);
    if (baby.generation > this.maxGeneration) {
      this.maxGeneration = baby.generation;
      grant(this.favour, FAVOUR_REWARDS.generation, this.eraState.era);
      this.emitEvent('generation', `Generation ${baby.generation} appeared with ${baby.name}.`, [baby.id]);
      this.chronicle.add({
        tick: this.tick,
        simTime: this.simTime,
        kind: 'milestone',
        importance: baby.generation <= 3 || baby.generation % 5 === 0 ? 3 : 2,
        title: `The ${ordinal(baby.generation)} generation`,
        text: `${baby.name} was born to ${mother.name}${father ? ` and ${father.name}` : ''}: the first of the ${ordinal(baby.generation)} generation.`,
        entityIds: [baby.id, mother.id],
        x: baby.x,
        y: baby.y,
      });
    }
    this.chronicle.first('birth', {
      tick: this.tick,
      simTime: this.simTime,
      importance: 3,
      title: 'The first child',
      text: `${baby.name} was born to ${mother.name}${father ? ` and ${father.name}` : ''} — the first child born in this world.`,
      entityIds: [baby.id, mother.id],
      x: baby.x,
      y: baby.y,
    });
    this.emitEvent('birth', `${baby.name} was born to ${mother.name}.`, [baby.id, mother.id]);
    this.addEffect('birth', baby.x, baby.y, 2.4, 1.2);

    // Newborn memory: both parents recognise their child immediately.
    mother.memory.shock(baby.id, this.tick, 0.5, 0.35, 0.3);
    if (father) father.memory.shock(baby.id, this.tick, 0.5, 0.3, 0.25);
  }

  private afterBirth(mother: Human): void {
    mother.lastBirthTick = this.tick;
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
    const spot = this.pileSpot(target.x, target.y);
    if (spot) {
      const carcass = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, spot[0], spot[1], this.rng, 1);
      carcass.food = SPECIES_PROFILES[PlantSpecies.FoodPile].maxFood * (0.5 + 0.5 * target.bodyScale());
      this.plants.push(carcass);
      this.land.claim(carcass.x, carcass.y, Occupant.Plant, carcass.id);
    }

    // Anyone who knew them remembers the loss.
    for (const other of this.humans) {
      if (!other.alive || other === target) continue;
      const record = other.memory.get(target.id);
      if (record) {
        record.valence = Math.max(-1, record.valence - 0.35);
        // A partner starts a vigil the atlas watches for.
        if (record.matings > 0) {
          const log = this.logOf(other);
          if (log && !log.mourning) {
            log.mourning = [target.x, target.y, this.tick];
            log.mourningSamples = 0;
          }
        }
      }
    }
    this.recordDeath(target);
  }

  /** The atlas's last look, the chronicle's obituary, and the observer's due. */
  private recordDeath(target: Human): void {
    const log = this.logs.get(target.id);
    if (log) {
      const earned = evaluate(log, this.subjectFor(target), true);
      this.award(target, log, earned);
    }
    const epithet = log ? epithetFor(log.earned) : null;
    if (target.deathReason === 'old age') grant(this.favour, FAVOUR_REWARDS.elderDeath, this.eraState.era);

    // A life is notable when it was long, fruitful, named, or the first of its kind.
    const notable =
      epithet !== null ||
      target.ageBio >= AGE_ADULT_END ||
      target.childrenIds.length >= 3 ||
      target.generation === 0;
    if (notable) {
      let circumstance: string | null = null;
      if (log && log.rescues > 0 && target.deathReason?.startsWith('predation')) circumstance = 'having once saved a child from a predator';
      else if (log && log.mourned > 0) circumstance = 'having mourned a partner';
      const text = obituary({
        name: target.name,
        epithet,
        generation: target.generation,
        ageYears: target.ageBio,
        children: target.childrenIds.length,
        reason: target.deathReason?.startsWith('predation') ? 'predation' : (target.deathReason ?? 'unknown causes'),
        circumstance,
      });
      this.chronicle.add({
        tick: this.tick,
        simTime: this.simTime,
        kind: 'death',
        importance: epithet || target.generation === 0 ? 2 : 1,
        title: `${target.name}${epithet ? ` ${epithet}` : ''} (${Math.round(target.ageBio)})`,
        text,
        entityIds: [target.id],
        x: target.x,
        y: target.y,
      });
    }
    this.logs.delete(target.id);
  }

  killPredator(target: Predator, reason: string): void {
    if (!target.alive) return;
    target.alive = false;
    target.health = 0;
    target.deathTick = this.tick;
    target.deathReason = reason;
    this.emitEvent('death', `${target.name} died from ${reason}.`, [target.id]);
    this.addEffect('death', target.x, target.y, 1.8, 1.1);
    const spot = this.pileSpot(target.x, target.y);
    if (spot) {
      const carcass = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, spot[0], spot[1], this.rng, 1);
      carcass.food = SPECIES_PROFILES[PlantSpecies.FoodPile].maxFood * 1.1;
      this.plants.push(carcass);
      this.land.claim(carcass.x, carcass.y, Occupant.Plant, carcass.id);
    }
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
        this.chronicle.add({
          tick: this.tick,
          simTime: this.simTime,
          kind: 'milestone',
          importance: milestone >= 30 ? 2 : 1,
          title: `${milestone} people`,
          text: `The population reached ${milestone}.`,
          entityIds: [],
        });
      }
    }
  }

  private readonly reachedMilestones = new Set<number>();

  // ---------------------------------------------------------------------
  // The game layer
  // ---------------------------------------------------------------------

  /** Light after the charter's long night and an eclipse have had their say. */
  private updateSky(): void {
    const bias = this.rules.nightBias;
    if (bias > 0) {
      const sun = Math.sin((this.climate.dayPhase - 0.25) * Math.PI * 2);
      this.climate.light = Math.max(0, Math.min(1, (sun + 0.35 - bias) / (1.35 - bias)));
    }
    if (this.crisis.light >= 0) this.climate.light = Math.min(this.climate.light, this.crisis.light);
  }

  private lastSeason = -1;

  private updateGame(): void {
    const tick = this.tick;

    if (tick % 20 === 0) {
      this.season = seasonFactors(this.simTime, this.seasonOptions());
      const calendar = calendarAt(this.simTime);
      if (calendar.season !== this.lastSeason) {
        if (this.lastSeason >= 0) {
          const name = SEASON_NAMES[calendar.season];
          this.emitEvent('ecology', `${name[0].toUpperCase()}${name.slice(1)} has come (year ${calendar.year}).`, []);
        }
        this.lastSeason = calendar.season;
      }
      this.paths.regrow(DT * 20);
      this.serveGranaries();
    }
    this.crisis = crisisFactors(this.fate, tick);

    if (tick % SOIL_UPDATE_INTERVAL === 0) {
      this.soil.recover(DT * SOIL_UPDATE_INTERVAL, this.rules.soilRecovery * this.season.soilRecovery);
    }

    for (let i = this.rains.length - 1; i >= 0; i--) {
      if (--this.rains[i].ticks <= 0) this.rains.splice(i, 1);
    }

    this.updateFateAndCrises();

    // Favour trickles in on its own, and mostly comes from the world doing well.
    grant(this.favour, FAVOUR_BASE_RATE * this.rules.favourRate * DT, this.eraState.era);

    if (tick % ERA_CHECK_INTERVAL === 0) this.checkEra();
    if (tick % 200 === 0) this.evaluateAtlas();
    if (tick % 40 === 0) this.updateSpotlight();
    if (tick % (TICKS_PER_DAY / 2) === 0) {
      this.populationHistory.push(this.humans.length);
      if (this.populationHistory.length > 400) {
        // Halve the resolution rather than forget the beginning.
        this.populationHistory = this.populationHistory.filter((_, i) => i % 2 === 0);
      }
    }
  }

  /** Population sampled every half day, for the campaign graph. */
  populationHistory: number[] = [];

  /** The game layer, as the client sees it. */
  buildGameView(chronicleSince: number): GameView {
    const calendar = calendarAt(this.simTime);
    const inputs = this.eraInputs();
    const nextEra = requirementsFor(this.eraState.era + 1, inputs);
    const hold =
      this.eraState.qualifyingSince >= 0
        ? Math.min(1, (this.tick - this.eraState.qualifyingSince) / (2 * TICKS_PER_DAY))
        : 0;
    const crisis = this.fate.current;
    const prices: Record<string, number> = {};
    const cooldowns: Record<string, number> = {};
    const inCrisis = crisis?.phase === 'active';
    for (const kind of ['rain', 'spawnFood', 'moveHuman', 'rewardPulse', 'painPulse', 'bless', 'editGenome', 'lightning', 'spawnPredator', 'spawnHuman', 'temperature', 'timeOfDay', 'kill']) {
      prices[kind] = priceOf(this.favour, kind, inCrisis);
      const ready = this.favour.readyAt[kind] ?? 0;
      if (ready > this.tick) cooldowns[kind] = (ready - this.tick) / SIM_HZ;
    }
    const epithets: Record<number, string> = {};
    const fevered: number[] = [];
    for (const human of this.humans) {
      if (!human.alive) continue;
      const epithet = this.epithetOf(human.id);
      if (epithet) epithets[human.id] = epithet;
      if (human.fever > 0) fevered.push(human.id);
    }
    const fires: number[] = [];
    if (this.burning.size > 0) {
      for (const plant of this.plants) {
        if (this.burning.has(plant.id)) fires.push(plant.x, plant.y);
      }
    }
    for (const site of this.structures) {
      if (this.burningStructures.has(site.id)) fires.push(site.x, site.y);
    }
    const discoveries = this.pendingDiscoveries.map((id) => {
      const found = this.discovered.get(id);
      return { id, humanId: found?.humanId ?? 0, name: found?.name ?? '' };
    });
    this.pendingDiscoveries = [];
    const centre = this.settlementCentre;
    return {
      mode: this.options.mode ?? 'sandbox',
      biome: this.options.biome ?? 'valley',
      charter: this.options.charter ?? [],
      challengeId: this.options.challengeId,
      year: calendar.year,
      season: calendar.season,
      seasonPhase: calendar.seasonPhase,
      day: calendar.day,
      era: this.eraState.era,
      nextEra,
      eraHold: hold,
      favour: {
        enabled: this.favour.enabled,
        value: this.favour.value,
        cap: favourCap(this.eraState.era),
        prices,
        cooldowns,
        interventions: this.favour.interventions,
        spent: this.favour.spent,
      },
      interventionsAllowed: this.rules.interventions,
      spawnAllowed: this.rules.spawnAllowed,
      crisis: crisis
        ? {
            kind: crisis.kind,
            name: CRISES[crisis.kind].name,
            phase: crisis.phase,
            text: crisis.phase === 'warning' ? CRISES[crisis.kind].warning : CRISES[crisis.kind].onset,
            advice: CRISES[crisis.kind].advice,
            seconds: ((crisis.phase === 'warning' ? crisis.startsAt : crisis.endsAt) - this.tick) / SIM_HZ,
            severity: crisis.severity,
          }
        : null,
      crisesSurvived: inputs.crisesSurvived,
      crisisHistory: this.fate.history.map((r) => ({
        kind: r.kind,
        survived: r.survived,
        year: Math.floor(r.startedAt / TICKS_PER_YEAR) + 1,
      })),
      storedFood: this.storedFood,
      granaries: inputs.granaries,
      wells: inputs.wells,
      trails: this.tick % 200 === 0 || this.cachedTrails < 0 ? (this.cachedTrails = this.paths.trailTiles()) : this.cachedTrails,
      landHealth: this.cachedLand < 0 || this.tick % 200 === 0 ? (this.cachedLand = this.landHealth()) : this.cachedLand,
      spotlight: this.spotlight,
      chronicle: this.chronicle.since(chronicleSince),
      chronicleCount: this.chronicle.entries.length,
      discoveries,
      discovered: [...this.discovered.keys()],
      epithets,
      fires,
      rains: this.rains.map((r) => ({ x: r.x, y: r.y, radius: r.radius })),
      fevered,
      populationHistory: this.populationHistory,
      extinct: this.humans.length === 0,
      oldest: this.humans.reduce((max, h) => (h.alive && h.ageBio > max ? h.ageBio : max), 0),
    };
  }

  private cachedTrails = -1;
  private cachedLand = -1;

  /**
   * How much the land the village lives on has left to give: mean fertility
   * under the wild plants within reach of the settlement. Bare ground nobody
   * grazes does not count, or the number would never move.
   */
  landHealth(): number {
    const centre = this.settlementCentre;
    if (!centre) return 1;
    const count = this.within(this.plantGrid, this.plants, centre.x, centre.y, 26, this.scratchB);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const plant = this.plants[this.scratchB[i]];
      if (!plant || plant.species === PlantSpecies.FoodPile) continue;
      sum += this.soil.at(plant.x, plant.y);
      n++;
    }
    return n > 0 ? sum / n : 1;
  }

  /** A granary puts some of its store out as a pile beside it, and loses some to rot. */
  private serveGranaries(): void {
    let total = 0;
    const spoil = GRANARY_SPOILAGE_PER_DAY * this.season.spoilage * ((DT * 20) / DAY_SECONDS);
    for (const granary of this.finished[StructureKind.Granary]) {
      granary.store *= 1 - spoil;
      if (granary.store > 0.05) {
        // Find this granary's stall: a granary pile within reach.
        let stall: Plant | null = null;
        const count = this.within(this.plantGrid, this.plants, granary.x, granary.y, 3.2, this.scratchB);
        for (let i = 0; i < count; i++) {
          const plant = this.plants[this.scratchB[i]];
          if (plant && plant.alive && plant.origin === FoodOrigin.Granary) {
            stall = plant;
            break;
          }
        }
        if (!stall) {
          // On the first free cell just outside the granary's own ground.
          const spot = this.pileSpot(granary.x + 2, granary.y, 1);
          if (!spot) {
            total += granary.store;
            continue;
          }
          stall = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, spot[0], spot[1], this.rng, 1);
          stall.food = 0;
          stall.origin = FoodOrigin.Granary;
          this.plants.push(stall);
          this.plantGrid.insert(this.plants.length - 1, stall.x, stall.y);
          this.land.claim(stall.x, stall.y, Occupant.Plant, stall.id);
        }
        const want = Math.max(0, GRANARY_STALL - stall.food);
        const given = Math.min(want, granary.store);
        stall.food += given;
        stall.ageBio = 0;
        granary.store -= given;
      }
      total += granary.store;
    }
    this.storedFood = total;
  }

  // --- fate ------------------------------------------------------------

  private updateFateAndCrises(): void {
    const event = updateFate(
      this.fate,
      this.tick,
      this.simTime,
      this.eraState.era,
      this.humans.length,
      this.rules.crisisFrequency,
      this.rules.crisisWeights,
    );
    if (event) {
      const def = CRISES[event.crisis.kind];
      if (event.type === 'warning') {
        this.emitEvent('ecology', `Omen: ${def.warning}`, []);
        this.chronicle.add({
          tick: this.tick,
          simTime: this.simTime,
          kind: 'crisis',
          importance: 2,
          title: `Omen of ${def.name.toLowerCase()}`,
          text: def.warning,
          entityIds: [],
        });
      } else if (event.type === 'start') {
        this.emitEvent('ecology', def.onset, []);
        this.startCrisis(event.crisis.kind, event.crisis.severity);
        this.chronicle.add({
          tick: this.tick,
          simTime: this.simTime,
          kind: 'crisis',
          importance: 3,
          title: def.name,
          text: def.onset,
          entityIds: [],
          x: this.settlementCentre?.x,
          y: this.settlementCentre?.y,
        });
      } else if (event.record) {
        this.endCrisis(event.record.kind);
        const record = event.record;
        const change = record.populationAfter - record.populationBefore;
        const verdict = record.survived
          ? `The settlement came through: ${record.populationAfter} alive (${change >= 0 ? '+' : ''}${change}).`
          : 'Nobody was left to see it end.';
        this.emitEvent('ecology', `${def.name} is over. ${verdict}`, []);
        this.chronicle.add({
          tick: this.tick,
          simTime: this.simTime,
          kind: 'crisis',
          importance: 3,
          title: `${def.name} ends`,
          text: verdict,
          entityIds: [],
        });
        if (record.survived) {
          grant(
            this.favour,
            FAVOUR_REWARDS.crisisBase + FAVOUR_REWARDS.crisisPerSeverity * record.severity,
            this.eraState.era,
          );
          for (const human of this.humans) {
            if (!human.alive || human.ageBio < AGE_CHILD_END) continue;
            const log = this.logOf(human);
            if (log && !log.crises.includes(record.kind)) log.crises.push(record.kind);
          }
        }
      }
    }

    const current = this.fate.current;
    if (current?.phase === 'active') {
      if (current.kind === 'fire' && this.tick % 10 === 0) this.spreadFire();
      if (current.kind === 'blight' && this.tick % 600 === 0) this.spreadBlight();
    }
    if (this.tick % 10 === 0) this.spreadFever();
    if (this.burning.size > 0 || this.burningStructures.size > 0) this.burn();
  }

  private startCrisis(kind: string, severity: number): void {
    const centre = this.settlementCentre ?? { x: this.terrain.width / 2, y: this.terrain.height / 2 };
    switch (kind) {
      case 'predatorMigration': {
        const count = Math.round((3 + 3 * Math.min(1, severity - 1 + 0.34)) * this.rules.predatorMigration);
        // They come ashore at the coast nearest the village.
        const angle = Math.atan2(centre.y - this.terrain.height / 2, centre.x - this.terrain.width / 2);
        for (let i = 0; i < count; i++) {
          const a = angle + (this.rng.next() - 0.5) * 0.9;
          const r = 30 + this.rng.next() * 10;
          this.releasePredator(centre.x + Math.cos(a) * r, centre.y + Math.sin(a) * r);
        }
        break;
      }
      case 'blight': {
        let driest: Field | null = null;
        for (const field of this.fields) {
          if (field.stage === FieldStage.Fallow) continue;
          if (!driest || field.moisture < driest.moisture) driest = field;
        }
        if (driest) driest.blighted = true;
        break;
      }
      case 'flood': {
        for (const field of this.fields) {
          if (this.waterDistanceAt(field.x, field.y) > 2) continue;
          field.stage = FieldStage.Fallow;
          field.growth = 0;
          field.moisture = 1;
        }
        for (const canal of this.canals) {
          if (!canal.complete && this.waterDistanceAt(canal.x, canal.y) <= 2) canal.progress = 0;
        }
        break;
      }
      case 'fever': {
        const adults = this.humans.filter((h) => h.alive && h.ageBio >= AGE_CHILD_END && !h.immune);
        const count = Math.min(adults.length, 1 + Math.round(severity));
        for (let i = 0; i < count; i++) {
          const index = Math.floor(this.rng.next() * adults.length);
          const patient = adults.splice(index, 1)[0];
          if (patient) patient.fever = TICKS_PER_DAY;
        }
        break;
      }
      case 'fire': {
        let best = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < this.plants.length; i++) {
          const plant = this.plants[i];
          if (!plant.alive || plant.species !== PlantSpecies.Tree) continue;
          const distance = Math.hypot(plant.x - centre.x, plant.y - centre.y);
          if (distance > 30 || this.fireproof(plant.x, plant.y)) continue;
          const score = this.rng.next() - distance / 30;
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        if (best >= 0) this.burning.set(this.plants[best].id, 120);
        break;
      }
      default:
        break;
    }
  }

  private endCrisis(kind: string): void {
    if (kind === 'fire') {
      this.burning.clear();
      this.burningStructures.clear();
    }
    if (kind === 'blight') for (const field of this.fields) field.blighted = false;
  }

  /** Ground fire cannot cross: open water, a flowing canal, or rain. */
  private fireproof(x: number, y: number): boolean {
    if (this.waterDistanceAt(x, y) <= 2) return true;
    for (const rain of this.rains) if (Math.hypot(rain.x - x, rain.y - y) <= rain.radius) return true;
    const count = this.within(this.canalGrid, this.canals, x, y, 2.5, this.canalScratch);
    for (let i = 0; i < count; i++) if (this.canals[this.canalScratch[i]]?.flowing) return true;
    return false;
  }

  private spreadFire(): void {
    const plantIndex = new Map<number, number>();
    for (let i = 0; i < this.plants.length; i++) plantIndex.set(this.plants[i].id, i);
    const ignite: number[] = [];
    for (const [id] of this.burning) {
      const index = plantIndex.get(id);
      if (index === undefined) continue;
      const plant = this.plants[index];
      const count = this.within(this.plantGrid, this.plants, plant.x, plant.y, 2.6, this.scratchB);
      for (let i = 0; i < count; i++) {
        const other = this.plants[this.scratchB[i]];
        if (!other?.alive || other.species === PlantSpecies.FoodPile || this.burning.has(other.id)) continue;
        if (this.fireproof(other.x, other.y)) continue;
        if (this.rng.next() < (other.species === PlantSpecies.Tree ? 0.18 : 0.08)) ignite.push(other.id);
      }
      const sites = this.within(this.structureGrid, this.structures, plant.x, plant.y, 2.8, this.structureScratch);
      for (let i = 0; i < sites; i++) {
        const site = this.structures[this.structureScratch[i]];
        if (site && site.wood > 0 && !this.burningStructures.has(site.id) && site.kind !== StructureKind.Well) {
          this.burningStructures.set(site.id, 200);
        }
      }
    }
    for (const id of ignite) this.burning.set(id, 120);
    // Rain puts it out.
    for (const [id] of this.burning) {
      const index = plantIndex.get(id);
      if (index === undefined) {
        this.burning.delete(id);
        continue;
      }
      const plant = this.plants[index];
      for (const rain of this.rains) {
        if (Math.hypot(rain.x - plant.x, rain.y - plant.y) <= rain.radius) this.burning.delete(id);
      }
    }
  }

  private burn(): void {
    if (this.burning.size > 0) {
      const byId = new Map<number, Plant>();
      for (const plant of this.plants) if (this.burning.has(plant.id)) byId.set(plant.id, plant);
      for (const [id, ticks] of this.burning) {
        const plant = byId.get(id);
        if (!plant || !plant.alive) {
          this.burning.delete(id);
          continue;
        }
        plant.food = Math.max(0, plant.food - 0.02);
        plant.timber = Math.max(0, plant.timber - 0.03);
        if (ticks <= 1) {
          plant.alive = false;
          this.burning.delete(id);
          // Ash feeds the ground.
          this.soil.enrich(plant.x, plant.y, 1.5, 0.3);
        } else this.burning.set(id, ticks - 1);
        if (this.tick % 10 === 0) {
          const count = this.within(this.humanGrid, this.humans, plant.x, plant.y, 1.2, this.scratchA);
          for (let i = 0; i < count; i++) {
            const human = this.humans[this.scratchA[i]];
            if (human?.alive) this.damageHuman(human, 2.5, 'fire', null);
          }
        }
      }
    }
    for (const [id, ticks] of this.burningStructures) {
      const site = this.structures.find((s) => s.id === id);
      if (!site) {
        this.burningStructures.delete(id);
        continue;
      }
      const rained = this.rains.some((r) => Math.hypot(r.x - site.x, r.y - site.y) <= r.radius);
      if (rained || ticks <= 1) {
        this.burningStructures.delete(id);
        continue;
      }
      site.wood = Math.max(0, site.wood - 0.08);
      if (site.complete && site.wood < site.required * 0.5) {
        site.complete = false;
        if (isDwelling(site.kind)) this.huts = Math.max(0, this.huts - 1);
        if (site.kind === StructureKind.Granary) site.store = 0;
        this.emitEvent('ecology', `A ${STRUCTURE_NAMES[site.kind]} burned down.`, []);
      }
      this.burningStructures.set(id, ticks - 1);
    }
  }

  private spreadBlight(): void {
    const infected = this.fields.filter((f) => f.blighted);
    for (const source of infected) {
      for (const field of this.fields) {
        if (field.blighted || field === source) continue;
        if (Math.hypot(field.x - source.x, field.y - source.y) > 8) continue;
        if (this.rng.next() < 0.6) field.blighted = true;
      }
    }
  }

  private spreadFever(): void {
    let any = false;
    for (const human of this.humans) if (human.alive && human.fever > 0) any = true;
    if (!any) return;
    for (const human of this.humans) {
      if (!human.alive || human.fever <= 0) continue;
      const count = this.within(this.humanGrid, this.humans, human.x, human.y, 1.6, this.scratchA);
      for (let i = 0; i < count; i++) {
        const other = this.humans[this.scratchA[i]];
        if (!other || other === human || !other.alive || other.fever > 0 || other.immune) continue;
        if (this.rng.next() < 0.05) other.fever = TICKS_PER_DAY;
      }
    }
  }

  /** A predator released by fate rather than by the observer. */
  private releasePredator(x: number, y: number): void {
    if (this.predators.length >= MAX_PREDATORS) return;
    const [px, py] = nearestWalkable(this.terrain, x, y, 16);
    const genome = randomGenome(this.rng, 1);
    const predator = new Predator(this.nextEntityId++, '', genome, this.rng.fork());
    predator.name = `Hunter ${predator.id}`;
    predator.x = px;
    predator.y = py;
    predator.ageBio = 10;
    predator.hunger = 50;
    this.predators.push(predator);
    this.predatorById.set(predator.id, predator);
  }

  // --- eras --------------------------------------------------------------

  eraInputs(): EraInputs {
    let elders = 0;
    for (const human of this.humans) if (human.alive && human.ageBio >= AGE_ADULT_END) elders++;
    let flowing = 0;
    for (const canal of this.canals) if (canal.flowing) flowing++;
    let sown = 0;
    for (const field of this.fields) if (field.lastWorkTick > 0 || field.stage !== FieldStage.Fallow) sown++;
    const population = this.humans.length;
    return {
      population,
      generation: this.maxGeneration,
      huts: this.huts,
      fieldsSown: sown,
      fields: this.fields.length,
      flowingCanals: flowing,
      granaries: this.finished[StructureKind.Granary].length,
      storedFood: this.storedFood,
      elderFraction: population > 0 ? elders / population : 0,
      crisesSurvived: this.fate.history.filter((r) => r.survived).length,
      palisades: this.finished[StructureKind.Palisade].length,
      wells: this.finished[StructureKind.Well].length,
    };
  }

  private checkEra(): void {
    const reached = updateEra(this.eraState, this.eraInputs(), this.tick);
    if (reached === null) return;
    const name = ERA_NAMES[reached];
    grant(this.favour, FAVOUR_REWARDS.era, reached);
    this.emitEvent('milestone', `Era ${ERA_NUMERALS[reached]}: the settlement is now a ${name.toLowerCase()}.`, []);
    this.chronicle.add({
      tick: this.tick,
      simTime: this.simTime,
      kind: 'era',
      importance: 3,
      title: `Era ${ERA_NUMERALS[reached]} — ${name}`,
      text: `With ${this.humans.length} people over ${this.maxGeneration} generations, the settlement has become a ${name.toLowerCase()}.`,
      entityIds: [],
      x: this.settlementCentre?.x,
      y: this.settlementCentre?.y,
    });
  }

  // --- the atlas ---------------------------------------------------------

  private sampleBehaviour(human: Human): void {
    let log = this.logs.get(human.id);
    if (!log) {
      log = createLog(human.id);
      this.logs.set(human.id, log);
    }
    log.samples += 1;
    if (this.waterDistanceAt(human.x, human.y) <= 6) log.nearWater += 1;
    if (Math.hypot(human.x - human.homeX, human.y - human.homeY) <= 10) log.nearHome += 1;
    if (!(human.nearestHumanDistance <= 12)) log.alone += 1;
    if (this.paths.isTrail(human.x, human.y)) log.onTrail += 1;
    log.motor[human.actionIndex] = (log.motor[human.actionIndex] ?? 0) + 1;
    log.valenceSum += human.lastValence;
    const region = regionIndex(human.x, human.y, this.terrain.width);
    log.regions[region] = this.tick;
    for (let i = 0; i < log.regions.length; i++) if (log.regions[i] === undefined) log.regions[i] = -1;

    if (this.climate.light < 0.28 && human.ageBio >= AGE_CHILD_END) {
      log.nightSamples += 1;
      const home = this.finishedDwellingNear(human.x, human.y, 6);
      if (human.sleeping) {
        log.nightAsleep += 1;
        if (home && Math.hypot(home.x - human.x, home.y - human.y) <= 4) log.nightAsleepNearHome += 1;
      } else if (home) {
        let sleepers = 0;
        const count = this.within(this.humanGrid, this.humans, human.x, human.y, 8, this.scratchA);
        for (let i = 0; i < count; i++) if (this.humans[this.scratchA[i]]?.sleeping) sleepers++;
        if (sleepers >= 3) log.nightWatch += 1;
      }
    }

    // A predator bite survived for a full day.
    if (log.predatorHitTick >= 0 && this.tick - log.predatorHitTick >= TICKS_PER_DAY) {
      log.survivedPredator += 1;
      log.predatorHitTick = -1;
    }

    // Fleeing from a predator with a child close by.
    const threat = Math.max(
      human.sensors[S_THREAT_FRONT],
      human.sensors[S_THREAT_FRONT + 1],
      human.sensors[S_THREAT_FRONT + 2],
      human.sensors[S_THREAT_FRONT + 3],
    );
    if (threat > 0.3 && human.ageBio >= AGE_CHILD_END && human.speed < -0.5 && log.rescuePending.length < 4) {
      const count = this.within(this.humanGrid, this.humans, human.x, human.y, 4, this.scratchA);
      for (let i = 0; i < count; i++) {
        const child = this.humans[this.scratchA[i]];
        if (child && child !== human && child.alive && child.ageBio < AGE_CHILD_END) {
          if (!log.rescuePending.some(([id]) => id === child.id)) log.rescuePending.push([child.id, this.tick]);
          break;
        }
      }
    }
    for (let i = log.rescuePending.length - 1; i >= 0; i--) {
      const [childId, since] = log.rescuePending[i];
      if (this.tick - since < TICKS_PER_DAY) continue;
      const child = this.humanById.get(childId);
      if (child?.alive) log.rescues += 1;
      log.rescuePending.splice(i, 1);
    }

    // Keeping vigil where a partner died.
    if (log.mourning) {
      const [mx, my, since] = log.mourning;
      if (Math.hypot(human.x - mx, human.y - my) <= 8) log.mourningSamples += 1;
      if (this.tick - since >= TICKS_PER_DAY) {
        if (log.mourningSamples >= (TICKS_PER_DAY / SAMPLE_INTERVAL) * 0.5) log.mourned += 1;
        log.mourning = null;
        log.mourningSamples = 0;
      }
    }
  }

  private finishedDwellingNear(x: number, y: number, radius: number): Structure | null {
    return (
      this.finishedNear(StructureKind.Hut, x, y, radius) ?? this.finishedNear(StructureKind.StoneHouse, x, y, radius)
    );
  }

  private subjectFor(human: Human): AtlasSubject {
    let grandchildren = 0;
    let descendants = 0;
    const seen = new Set<number>();
    const walk = (id: number, depth: number): void => {
      const person = this.humanById.get(id);
      if (!person) return;
      for (const childId of person.childrenIds) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        descendants++;
        const child = this.humanById.get(childId);
        if (depth === 1 && child?.alive) grandchildren++;
        if (depth < 6) walk(childId, depth + 1);
      }
    };
    walk(human.id, 0);
    let firstChildAge: number | null = null;
    if (human.childrenIds.length > 0) {
      const first = this.humanById.get(human.childrenIds[0]);
      if (first) firstChildAge = human.ageBio - first.ageBio;
    }
    const brain = human.brain;
    return {
      ageYears: human.ageBio,
      alive: human.alive,
      deathReason: human.deathReason,
      children: human.childrenIds.length,
      descendants,
      livingGrandchildren: grandchildren,
      firstChildAge,
      innateDrift: (k) => brain.innateDrift(k),
      maxInnateDrift: brain.maxInnateDrift().drift,
      strongReflexReversed: brain.strongReflexReversed(1.2, 0.2),
      innateWeight: (k) => brain.innateWeight(k),
      weightDrift: brain.weightDrift(),
      tick: this.tick,
    };
  }

  private evaluateAtlas(): void {
    for (const human of this.humans) {
      if (!human.alive) continue;
      const log = this.logs.get(human.id);
      if (!log) continue;
      this.award(human, log, evaluate(log, this.subjectFor(human), false));
    }
  }

  /** Record newly earned atlas entries: discoveries, epithets, favour. */
  private award(human: Human, log: BehaviourLog, earned: string[]): void {
    for (const id of earned) {
      const entry = atlasEntry(id);
      if (!entry) continue;
      if (!this.discovered.has(id)) {
        this.discovered.set(id, { tick: this.tick, humanId: human.id, name: human.name });
        this.pendingDiscoveries.push(id);
        grant(this.favour, FAVOUR_REWARDS.discovery, this.eraState.era);
        this.emitEvent('milestone', `Atlas: ${entry.name} — first seen in ${human.name}.`, [human.id]);
        this.chronicle.add({
          tick: this.tick,
          simTime: this.simTime,
          kind: 'discovery',
          importance: entry.rarity === 'common' ? 1 : entry.rarity === 'uncommon' ? 2 : 3,
          title: `Atlas: ${entry.name}`,
          text: `${entry.description} First seen in ${human.name}.`,
          entityIds: [human.id],
          x: human.x,
          y: human.y,
        });
      }
      if (entry.epithet && epithetFor(log.earned) === entry.epithet && human.alive) {
        this.chronicle.add({
          tick: this.tick,
          simTime: this.simTime,
          kind: 'epithet',
          importance: entry.rarity === 'legendary' || entry.rarity === 'rare' ? 2 : 1,
          title: `${human.name} ${entry.epithet}`,
          text: `${human.name} is now called ${human.name} ${entry.epithet}: ${entry.criterion.toLowerCase()}`,
          entityIds: [human.id],
          x: human.x,
          y: human.y,
        });
      }
    }
  }

  /** The epithet a person carries, or null. */
  epithetOf(id: number): string | null {
    const log = this.logs.get(id);
    return log ? epithetFor(log.earned) : null;
  }

  // --- the director --------------------------------------------------------

  /**
   * Who is most worth watching right now.
   *
   * The score is observational: an unusual action (few others doing it), a
   * rare epithet, a pregnancy near term, a person in danger. It points the
   * camera; it never touches anyone.
   */
  private updateSpotlight(): void {
    const counts = new Array(20).fill(0);
    let living = 0;
    for (const human of this.humans) {
      if (!human.alive) continue;
      counts[human.actionIndex]++;
      living++;
    }
    const scored: SpotlightView[] = [];
    for (const human of this.humans) {
      if (!human.alive) continue;
      let score = 0;
      let reason = '';
      const rarity = living > 0 ? 1 - counts[human.actionIndex] / living : 0;
      score += rarity;
      if (rarity > 0.8) reason = human.currentAction.toLowerCase();
      const epithet = this.epithetOf(human.id);
      if (epithet) {
        score += 0.4;
        if (!reason) reason = `${human.name} ${epithet}`;
      }
      if (human.mating) {
        score += 0.8;
        reason = 'mating';
      }
      if (human.pregnancy && human.pregnancy.progress > 0.85) {
        score += 0.9;
        reason = 'about to give birth';
      }
      if (human.pain > 40) {
        score += 0.7;
        reason = 'in pain';
      }
      if (human.fever > 0) {
        score += 0.4;
        reason = 'fevered';
      }
      if (human.building || human.farming) score += 0.3;
      scored.push({ id: human.id, score, reason: reason || human.currentAction.toLowerCase() });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    this.spotlight = scored.slice(0, 3);
  }

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

  spawnHuman(x: number, y: number, genome?: Genome, ageBio = 18, house = 0): Human {
    if (this.humans.length >= MAX_POPULATION) {
      this.emitEvent('god', 'Population cap reached — no new human was created.', []);
      return this.humans[0];
    }
    const [px, py] = nearestWalkable(this.terrain, x, y, 12);
    const sex = this.rng.next() < 0.5 ? Sex.Female : Sex.Male;
    const resolved = genome ? sanitizeGenome(cloneGenome(genome)) : randomGenome(this.rng, 0);
    const name = this.nameRegistry.next(this.rng);
    const human = new Human(this.nextEntityId++, name, sex, resolved, this.rng.fork(), this.brainOptions);
    human.x = px;
    human.y = py;
    human.homeX = px;
    human.homeY = py;
    human.ageBio = ageBio;
    human.birthTick = this.tick;
    human.stage = ageBio < 1.5 ? LifeStage.Baby : ageBio < 12 ? LifeStage.Child : LifeStage.Adult;
    human.energy = 92;
    human.generation = this.maxGeneration;
    // A god-spawned human has no mother, so its house is assigned rather than
    // inherited — in competitive mode it belongs to the observer who paid.
    human.house = house;
    this.humans.push(human);
    this.humanById.set(human.id, human);
    this.logs.set(human.id, createLog(human.id));
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
    const [wx, wy] = nearestWalkable(this.terrain, x, y, 8);
    const spot = this.pileSpot(wx, wy, 6);
    if (!spot) return;
    const [px, py] = spot;
    const pile = new Plant(this.nextEntityId++, PlantSpecies.FoodPile, px, py, this.rng, 1);
    pile.food = amount;
    pile.origin = FoodOrigin.Gift;
    this.plants.push(pile);
    this.land.claim(px, py, Occupant.Plant, pile.id);
    this.emitEvent('god', `Food was placed by the observer.`, []);
    this.addEffect('spawn', px, py, 1.2, 1);
  }

  strikeLightning(x: number, y: number, radius = 6, damage = 62): void {
    this.addEffect('lightning', x, y, 0.85, radius);
    this.emitEvent('lightning', `Lightning struck (${x.toFixed(0)}, ${y.toFixed(0)}).`, []);
    // Burning a blighted field stops the blight spreading from it — at the cost
    // of the crop. That is the one thing the observer can do about blight.
    for (const field of this.fields) {
      if (!field.blighted || Math.hypot(field.x - x, field.y - y) > radius) continue;
      field.blighted = false;
      field.stage = FieldStage.Fallow;
      field.growth = 0;
      this.emitEvent('god', 'A blighted field was burned clean.', []);
    }
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

  /** Call rain over a spot: fields drink, the ground recovers a little, fires go out. */
  rain(x: number, y: number, radius = 12): void {
    this.rains.push({ x, y, radius, ticks: 20 * SIM_HZ });
    this.soil.enrich(x, y, radius, 0.12);
    for (const field of this.fields) {
      if (Math.hypot(field.x - x, field.y - y) <= radius) field.moisture = Math.min(1, field.moisture + 0.6);
    }
    this.addEffect('rain', x, y, 20, radius);
    this.emitEvent('god', 'Rain fell at the observer’s call.', []);
  }

  /** Heal a person, and cure fever. */
  bless(id: number): boolean {
    const human = this.humanById.get(id);
    if (!human || !human.alive) return false;
    human.health = Math.min(100, human.health + 40);
    human.pain = 0;
    if (human.fever > 0) {
      human.fever = 0;
      human.immune = true;
    }
    this.addEffect('spawn', human.x, human.y, 1.4, 1.4);
    this.emitEvent('god', `${human.name} was blessed.`, [human.id]);
    return true;
  }

  /**
   * The neuro-lab's lever: add to the next valence read-out of one brain.
   *
   * The learning rule then strengthens (or weakens) whatever that brain was
   * doing in the last half second. The observer picks the moment; the brain
   * decides what gets learned.
   */
  pulse(id: number, sign: 1 | -1): boolean {
    const human = this.humanById.get(id);
    if (!human || !human.alive) return false;
    human.pendingPulse = 0.45 * sign;
    if (sign > 0) {
      const log = this.logOf(human);
      if (log) log.pulses += 1;
    }
    this.addEffect(sign > 0 ? 'birth' : 'attack', human.x, human.y, 0.8, 0.9);
    return true;
  }

  setTemperatureOffset(offset: number): void {
    this.climate.globalOffset = Math.max(-18, Math.min(22, offset));
  }

  setTimeOfDay(phase: number): void {
    const wrapped = ((phase % 1) + 1) % 1;
    // Move the simulation clock so that the climate's day phase equals `phase`.
    // Move the clock forward to the next time the day reaches `phase`, so the
    // calendar never runs backwards.
    const current = (((this.simTime / DAY_SECONDS + DAY_PHASE_AT_GENESIS) % 1) + 1) % 1;
    const ahead = (((wrapped - current) % 1) + 1) % 1;
    this.simTime += ahead * DAY_SECONDS;
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
      human.brain = new Brain(human.genome, this.brainOptions);
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
      huts: this.huts,
      sites: this.structures.length - this.huts,
      timber: this.totalTimber,
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

  /**
   * Per-house scoreboard.
   *
   * The competitive mode's whole score function. A house is worth its living
   * members, with a small bonus per generation reached — so a house that survives
   * deep is worth more than one that merely breeds wide, and going extinct is
   * unrecoverable because a house can only grow through its own women.
   */
  houseStats(): HouseStats[] {
    const houses: HouseStats[] = [0, 1].map((house) => ({
      house,
      population: 0,
      females: 0,
      males: 0,
      children: 0,
      deepestGeneration: 0,
      score: 0,
    }));

    for (const human of this.humans) {
      if (!human.alive) continue;
      const entry = houses[human.house === 1 ? 1 : 0];
      entry.population += 1;
      if (human.sex === Sex.Female) entry.females += 1;
      else entry.males += 1;
      if (human.stage === LifeStage.Baby || human.stage === LifeStage.Child) entry.children += 1;
      if (human.generation > entry.deepestGeneration) entry.deepestGeneration = human.generation;
    }

    for (const entry of houses) {
      // Population is the score; generation depth is the tiebreaker and the
      // reason to keep a lineage alive rather than merely numerous.
      entry.score = entry.population * 100 + entry.deepestGeneration * 25;
    }
    return houses;
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
      lifespan: human.genome.lifespan * this.rules.lifespan,
      epithet: this.epithetOf(human.id),
      atlas: this.logs.get(human.id)?.earned ?? [],
      fever: human.fever > 0,
      diet: (() => {
        const log = this.logs.get(human.id);
        return {
          wild: log?.foodWild ?? 0,
          crop: log?.foodCrop ?? 0,
          granary: log?.foodGranary ?? 0,
          carcass: log?.foodCarcass ?? 0,
          gift: log?.foodGift ?? 0,
        };
      })(),
      work: (() => {
        const log = this.logs.get(human.id);
        return {
          timber: log?.timber ?? 0,
          woodLaid: log?.woodLaid ?? 0,
          completed: log?.completed ?? 0,
          sown: log?.fieldsSown ?? 0,
          crops: log?.crops ?? 0,
          canals: log?.canalsFinished ?? 0,
        };
      })(),
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

    // The strongest synapses *between each pair of regions*, not overall.
    //
    // Rendering every connection is unreadable, but the plain top-N by weight
    // was almost entirely the innate sensory -> motor reflexes — the largest
    // weights in the brain by design — so the recurrent core, where learning
    // happens, looked disconnected. A per-pathway quota shows every stage of the
    // flow: senses to local circuits, into the core, around it, and out to the
    // motors. Read-only: nothing here touches the simulation.
    const buckets = new Map<number, number[]>();
    for (let s = 0; s < brain.synCount; s++) {
      const key = regionOf(brain.pre[s]) * 8 + regionOf(brain.post[s]);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push(s);
    }
    const synapses: Array<[number, number, number, number]> = [];
    const shown = new Set<number>();
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => Math.abs(brain.w[b]) - Math.abs(brain.w[a]));
      for (let i = 0; i < Math.min(26, bucket.length); i++) {
        const s = bucket[i];
        shown.add(s);
        synapses.push([brain.pre[s], brain.post[s], brain.w[s], brain.w[s] - brain.initialWeights[s]]);
      }
    }
    // What a lifetime has rewritten: the synapses that moved furthest from the
    // weight this individual was born with, whether or not they are strong.
    const byDrift: number[] = [];
    for (let s = 0; s < brain.synCount; s++) if (!shown.has(s)) byDrift.push(s);
    byDrift.sort(
      (a, b) => Math.abs(brain.w[b] - brain.initialWeights[b]) - Math.abs(brain.w[a] - brain.initialWeights[a]),
    );
    const learned: Array<[number, number, number, number]> = byDrift
      .slice(0, 40)
      .map((s) => [brain.pre[s], brain.post[s], brain.w[s], brain.w[s] - brain.initialWeights[s]]);

    // Spikes since the last read. Draining here is safe: nothing else reads it.
    const spikes = Array.from(brain.spikeCount);
    brain.spikeCount.fill(0);

    const stats = brain.stats();
    return {
      entityId: id,
      neuronCount: brain.n,
      activity,
      potential,
      motor: Array.from(human.motor),
      synapses,
      learned,
      spikes,
      valence: human.lastValence,
      sensors: Array.from(human.sensors),
      heading: human.heading,
      weightDrift: brain.weightDrift(),
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
      learnedPath: explanation.learnedPath.map((node) => ({
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
  buildSnapshot(revision: number, metrics: DevMetrics, chronicleSince = this.chronicle.lastId): WorldSnapshot {
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
      house: number,
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
      meta[m + 4] = house;
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
      if (human.harvesting) flags |= EntityFlags.Harvesting;
      if (human.building) flags |= EntityFlags.Building;
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
        human.house,
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
        0,
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
        // For plants `size` carries the fraction of standing timber, not a
        // radius: a felled tree draws small and brown and regrows visibly, so
        // logging is legible in the world instead of only in the stats panel.
        // Non-trees report zero, which the renderer ignores — they draw from
        // their species profile.
        plant.timberFraction(),
        profile.hue,
        profile.saturation,
        profile.lightness,
        plant.foodFraction(),
        0,
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
      // Structures change only when one is founded or receives timber, so the
      // list is small (bounded by MAX_STRUCTURES) and cheap to send whole.
      structures: this.structures.map((s) => s.toData()),
      // Fields and canals ride in the JSON header for the same reason: they
      // change rarely, their count is bounded, and the binary payload is fully
      // allocated already.
      fields: this.fields.map((f) => f.toData()),
      canals: this.canals.map((c) => c.toData()),
      game: this.buildGameView(chronicleSince),
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
      structures: this.structures.map((st) => st.toData()),
      fields: this.fields.map((f) => f.toData()),
      canals: this.canals.map((c) => c.toData()),
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
      foodEaten: { ...this.foodEaten },
      reachedMilestones: [...this.reachedMilestones],
      matingPairs: this.matingPairs,
      inheritanceReports: [...this.inheritanceReports.entries()].map(([id, report]) => [id, report]),
      game: {
        soil: this.soil.serialize(),
        paths: this.paths.serialize(),
        era: this.eraState,
        fate: this.fate,
        favour: this.favour,
        chronicle: this.chronicle.serialize(),
        logs: [...this.logs.values()],
        discovered: [...this.discovered.entries()],
        commandLog: this.commandLog,
        burning: [...this.burning.entries()],
        burningStructures: [...this.burningStructures.entries()],
        rains: this.rains,
        storedFood: this.storedFood,
        populationHistory: this.populationHistory,
        lastSeason: this.lastSeason,
      },
    };
  }

  static deserialize(data: Record<string, unknown>): World {
    const world = new World(data.options as WorldOptions);
    // Wipe the freshly generated world and replace it with the saved state.
    world.humans = [];
    world.predators = [];
    world.plants = [];
    world.structures.length = 0;
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
    Object.assign(world.foodEaten, (data.foodEaten as World['foodEaten'] | undefined) ?? {});
    for (const m of (data.reachedMilestones as number[]) ?? []) world.reachedMilestones.add(m);

    for (const raw of (data.humans as Record<string, unknown>[]) ?? []) {
      const human = Human.deserialize(raw, world.rng.fork(), world.brainOptions);
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
    for (const raw of (data.structures as StructureData[]) ?? []) {
      world.structures.push(Structure.fromData(raw));
    }
    for (const raw of (data.fields as FieldData[]) ?? []) {
      world.fields.push(Field.fromData(raw));
    }
    for (const raw of (data.canals as CanalData[]) ?? []) {
      world.canals.push(Canal.fromData(raw));
    }
    world.huts = world.structures.reduce((sum, site) => sum + (site.complete ? 1 : 0), 0);
    for (const event of (data.events as WorldEvent[]) ?? []) world.events.push(event);
    for (const effect of (data.effects as WorldEffect[]) ?? []) world.effects.push(effect);
    world.matingPairs = ((data.matingPairs as MatingPair[]) ?? []).map((p) => ({ ...p }));
    for (const [id, stored] of (data.inheritanceReports as Array<[number, StoredInheritance]>) ?? []) {
      world.inheritanceReports.set(id, stored);
    }

    const game = data.game as Record<string, unknown> | undefined;
    world.logs.clear();
    world.chronicle.restore(undefined);
    if (game) {
      world.soil.restore(game.soil as string);
      world.paths.restore(game.paths as string);
      if (game.era) world.eraState = structuredCloneSafe(game.era as EraState);
      if (game.fate) world.fate = structuredCloneSafe(game.fate as FateState);
      if (game.favour) world.favour = structuredCloneSafe(game.favour as FavourState);
      world.chronicle.restore(game.chronicle as Record<string, unknown>);
      for (const log of (game.logs as BehaviourLog[]) ?? []) world.logs.set(log.id, log);
      for (const [id, found] of (game.discovered as Array<[string, { tick: number; humanId: number; name: string }]>) ?? []) {
        world.discovered.set(id, found);
      }
      world.commandLog = (game.commandLog as World['commandLog']) ?? [];
      for (const [id, ticks] of (game.burning as Array<[number, number]>) ?? []) world.burning.set(id, ticks);
      for (const [id, ticks] of (game.burningStructures as Array<[number, number]>) ?? []) {
        world.burningStructures.set(id, ticks);
      }
      world.rains = ((game.rains as World['rains']) ?? []).map((r) => ({ ...r }));
      world.storedFood = (game.storedFood as number) ?? 0;
      world.populationHistory = (game.populationHistory as number[]) ?? [];
      world.lastSeason = (game.lastSeason as number) ?? -1;
    } else {
      // A save from before the game layer: start everyone's record fresh.
      for (const human of world.humans) world.logs.set(human.id, createLog(human.id));
    }
    world.season = seasonFactors(world.simTime, world.seasonOptions());
    world.crisis = crisisFactors(world.fate, world.tick);

    // The world PRNG state is restored LAST.
    //
    // Building entities consumes the world stream (each entity gets a forked
    // child stream), so restoring the state before them would leave the world's
    // own stream advanced past the saved position and the restored world would
    // diverge on the very next random draw. Entity streams are restored from
    // their own saved state, so the order in which they are forked here is
    // irrelevant.
    world.rng.setState(data.rng as number[]);

    // A save from before the land grid: set everything on cell centres. A save
    // made since is already on them, so this changes nothing for it.
    for (const plant of world.plants) {
      plant.x = snap(plant.x);
      plant.y = snap(plant.y);
    }
    for (const list of [world.structures, world.fields, world.canals] as Array<Array<{ x: number; y: number }>>) {
      for (const item of list) {
        item.x = snap(item.x);
        item.y = snap(item.y);
      }
    }
    world.rebuildGrids();
    return world;
  }
}

const MILESTONES = [10, 15, 20, 30, 50, 80, 120, 200];

/** Deep copy of plain JSON data, so a restored world owns its state. */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export { MOTOR_NAMES, MOTOR_START, labelNeuron, regionOf, STAGE_NAMES, WORLD_W, WORLD_H, Sex, LifeStage };
