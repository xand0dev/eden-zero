import type { Climate } from '../environment/climate';
import type { TerrainData } from '../environment/terrain';
import type { Human } from './human';
import type { Predator } from './predator';
import type { Plant } from './plant';
import type { Structure } from './structure';
import type { EventKind } from '../../shared/types';

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

  /** World-level deterministic PRNG. */
  random(): number;

  getHuman(id: number): Human | undefined;
  getPredator(id: number): Predator | undefined;

  /** Fill `out` with indices of nearby entities. Returns the count. */
  queryHumans(x: number, y: number, radius: number, out: number[]): number;
  queryPredators(x: number, y: number, radius: number, out: number[]): number;
  queryPlants(x: number, y: number, radius: number, out: number[]): number;
  queryStructures(x: number, y: number, radius: number, out: number[]): number;

  ambientTemperatureAt(x: number, y: number): number;

  /** Centre of the founding village, or null before it has been chosen. */
  readonly settlementCentre: { x: number; y: number } | null;

  /** Consume plant biomass; returns the amount actually taken. */
  consumePlant(plantIndex: number, amount: number): number;

  /**
   * Fell timber from a tree. Returns the amount actually taken, so the caller
   * does not credit wood that the tree did not have.
   */
  harvestWood(plantIndex: number, amount: number): number;

  /** Lay timber on a structure site. Returns the amount actually accepted. */
  contributeWood(structureIndex: number, amount: number, builder: Human): number;

  /** Start a new building site. Returns null if the village is full. */
  foundStructure(x: number, y: number, builder: Human): Structure | null;

  /** Apply damage to a human, attributing a death reason. */
  damageHuman(target: Human, amount: number, reason: string, attackerId: number | null): void;

  /** Genetic relatedness in 0..1 between two individuals. */
  relatedness(a: number, b: number): number;

  emitEvent(kind: EventKind, text: string, entityIds: number[]): void;
}
