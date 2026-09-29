import type { Climate } from '../environment/climate';
import type { TerrainData } from '../environment/terrain';
import type { Human } from './human';
import type { Predator } from './predator';
import type { Plant } from './plant';
import type { Structure } from './structure';
import type { Canal, Field } from './cultivation';
import type { EventKind } from '../../shared/types';
import type { WorldRules } from '../game/laws';
import type { SeasonFactors } from '../game/calendar';
import type { CrisisFactors } from '../game/crises';

/**
 * The slice of the world that entities are allowed to see.
 *
 * Declaring it as an interface (rather than importing the concrete `World`
 * class) keeps the dependency graph acyclic and, more importantly, keeps the
 * door open for the future Rust migration: a Rust-backed world only has to
 * satisfy this contract.
 */
export interface SimWorld {
  tick: number;
  simTime: number;
  dt: number;
  terrain: TerrainData;
  climate: Climate;

  /**
   * Entity tables. Indices returned by the `query*` methods index directly into
   * these arrays; the tables are only compacted at the end of a tick, so
   * indices stay valid for the whole duration of one tick.
   */
  humans: Human[];
  predators: Predator[];
  plants: Plant[];
  structures: Structure[];
  fields: Field[];
  canals: Canal[];

  /** The charter and biome as numbers the physics reads. */
  readonly rules: WorldRules;
  /** Seasonal physics this tick. */
  readonly season: SeasonFactors;
  /** Crisis physics this tick. */
  readonly crisis: CrisisFactors;
  /** What the brain senses on `settlementStage`, 0..1. */
  readonly eraSensor: number;
  /** What the brain senses on `storedFood`, 0..1. */
  readonly storedFoodSensor: number;
  /** Current era, 0 = hearth. */
  readonly era: number;

  /** A finished well within `radius`, or null. */
  wellNear(x: number, y: number, radius: number): { x: number; y: number } | null;
  /** Speed-up a workshop gives felling and digging here, 1 if none. */
  workshopBonus(x: number, y: number): number;
  /** Walking speed multiplier from a worn trail here. */
  trailSpeed(x: number, y: number): number;
  /** Whether a finished shrine stands within range. */
  shrineNear(x: number, y: number): boolean;
  /** Whether a finished palisade stands in a predator's way here. */
  blockedForPredators(x: number, y: number): boolean;
  /** A person drank at a well (bookkeeping only). */
  noteWellDrink(human: Human): void;
  /** A person recovered from fever (bookkeeping only). */
  noteFeverRecovered(human: Human): void;
  /** A person struck another (bookkeeping only). */
  noteStrike(attacker: Human): void;

  /** World-level deterministic PRNG. */
  random(): number;

  getHuman(id: number): Human | undefined;
  getPredator(id: number): Predator | undefined;

  /** Fill `out` with indices of nearby entities. Returns the count. */
  queryHumans(x: number, y: number, radius: number, out: number[]): number;
  queryPredators(x: number, y: number, radius: number, out: number[]): number;
  queryPlants(x: number, y: number, radius: number, out: number[]): number;
  queryStructures(x: number, y: number, radius: number, out: number[]): number;
  queryFields(x: number, y: number, radius: number, out: number[]): number;
  queryCanals(x: number, y: number, radius: number, out: number[]): number;

  /** Distance in tiles to the nearest fresh water, saturated at 255. */
  waterDistanceAt(x: number, y: number): number;

  /**
   * Nearest standing forest within `radius`, as an offset from (x, y).
   *
   * Returns null when there is no woodland in range. This is what lets a
   * settlement grow toward the trees instead of only around its own centre.
   */
  nearestForest(x: number, y: number, radius: number): { dx: number; dy: number; distance: number } | null;

  /** Break ground for a new field. Returns null if the ground will not take one. */
  foundField(x: number, y: number, worker: Human): Field | null;
  sowField(fieldIndex: number, worker: Human): boolean;
  harvestField(fieldIndex: number, worker: Human): boolean;

  /** Stake out a length of canal. Returns null unless it adjoins water or canal. */
  foundCanal(x: number, y: number, worker: Human): Canal | null;
  digCanal(canalIndex: number, worker: Human): boolean;

  ambientTemperatureAt(x: number, y: number): number;

  /** Centre of the founding village, or null before it has been chosen. */
  readonly settlementCentre: { x: number; y: number } | null;

  /** Consume plant biomass; returns the amount actually taken. */
  consumePlant(plantIndex: number, amount: number, eater?: Human): number;

  /**
   * Fell timber from a tree. Returns the amount actually taken, so the caller
   * does not credit wood that the tree did not have.
   */
  harvestWood(plantIndex: number, amount: number, worker?: Human): number;

  /** Lay timber on a structure site. Returns the amount actually accepted. */
  contributeWood(structureIndex: number, amount: number, builder: Human): number;

  /** Start a new building site. Returns null if the village is full. */
  foundStructure(x: number, y: number, builder: Human, frontier?: boolean): Structure | null;

  /** Apply damage to a human, attributing a death reason. */
  damageHuman(target: Human, amount: number, reason: string, attackerId: number | null): void;

  /** Genetic relatedness in 0..1 between two individuals. */
  relatedness(a: number, b: number): number;

  emitEvent(kind: EventKind, text: string, entityIds: number[]): void;
}
