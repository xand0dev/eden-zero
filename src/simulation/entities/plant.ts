import { Rng } from '../rng';
import { EntityKind } from '../../shared/types';
import { BIO_YEAR_SECONDS } from '../../shared/constants';
import { Tile, tileAt, type TerrainData } from '../environment/terrain';
import { clamp } from '../brain/network';

/**
 * Plants are deliberately brainless. They grow, mature, produce edible
 * biomass, spread seeds onto nearby fertile ground and die. Plant population is
 * therefore dynamic — food does not appear out of nowhere, which is what makes
 * the ecology a closed loop. (The god tool can still spawn food separately.)
 */

export const PlantSpecies = {
  Grass: 0,
  Bush: 1,
  Tree: 2,
  /** Carcass or god-spawned food pile. Does not grow, only decays. */
  FoodPile: 3,
} as const;
export type PlantSpecies = (typeof PlantSpecies)[keyof typeof PlantSpecies];

export const PLANT_SPECIES_NAMES = ['grass', 'bush', 'tree', 'food'] as const;

export interface SpeciesProfile {
  name: string;
  maxFood: number;
  /** Biomass regeneration per simulated second at full maturity. */
  regen: number;
  /** Biological years until the plant reaches full size. */
  maturityYears: number;
  lifespanYears: number;
  /** Maximum seed dispersal distance in tiles. */
  seedRange: number;
  /** Probability per simulated second of attempting to spread, when mature. */
  seedChance: number;
  /** Visual radius in tiles. */
  visualRadius: number;
  hue: number;
  saturation: number;
  lightness: number;
  /** Can humans eat it? */
  edible: boolean;
  /**
   * Standing timber available to be felled. Zero for anything that is not a
   * tree, which is what makes `wood.*` sensing tree-specific.
   */
  maxTimber: number;
  /** Timber regenerated per simulated second. Trees regrow slowly. */
  timberRegen: number;
}

export const SPECIES_PROFILES: Record<number, SpeciesProfile> = {
  [PlantSpecies.Grass]: {
    name: 'grass',
    maxFood: 0.62,
    regen: 0.03,
    maturityYears: 0.25,
    lifespanYears: 6,
    seedRange: 7,
    seedChance: 0.05,
    visualRadius: 0.42,
    hue: 0.28,
    saturation: 0.45,
    lightness: 0.34,
    edible: true,
    maxTimber: 0,
    timberRegen: 0,
  },
  [PlantSpecies.Bush]: {
    name: 'bush',
    maxFood: 1.05,
    regen: 0.013,
    maturityYears: 1.1,
    lifespanYears: 16,
    seedRange: 10,
    seedChance: 0.016,
    visualRadius: 0.62,
    hue: 0.31,
    saturation: 0.4,
    lightness: 0.3,
    edible: true,
    maxTimber: 0,
    timberRegen: 0,
  },
  [PlantSpecies.Tree]: {
    name: 'tree',
    maxFood: 1.5,
    regen: 0.007,
    maturityYears: 6,
    lifespanYears: 55,
    seedRange: 15,
    seedChance: 0.005,
    visualRadius: 1.05,
    hue: 0.3,
    saturation: 0.35,
    lightness: 0.24,
    edible: true,
    maxTimber: 3.2,
    timberRegen: 0.0025,
  },
  [PlantSpecies.FoodPile]: {
    name: 'food',
    maxFood: 1.6,
    regen: 0,
    maturityYears: 0,
    lifespanYears: 0.85,
    seedRange: 0,
    seedChance: 0,
    visualRadius: 0.55,
    hue: 0.07,
    saturation: 0.5,
    lightness: 0.42,
    edible: true,
    maxTimber: 0,
    timberRegen: 0,
  },
};

export class Plant {
  readonly kind = EntityKind.Plant;
  id: number;
  species: number;
  x: number;
  y: number;
  /** 0..1 physical maturity. */
  growth = 0;
  ageBio = 0;
  /** Edible biomass, 0..1 of the species maximum. */
  food: number;
  /** Standing timber, 0..maxTimber. Only trees carry any. */
  timber = 0;
  alive = true;
  /** Cached so rendering does not have to re-read the profile table. */
  radius: number;

  constructor(id: number, species: number, x: number, y: number, rng: Rng, initialGrowth = 0) {
    this.id = id;
    this.species = species;
    this.x = x;
    this.y = y;
    const profile = SPECIES_PROFILES[species];
    this.radius = profile.visualRadius * rng.range(0.85, 1.15);
    if (profile.maturityYears > 0) {
      this.ageBio = initialGrowth * profile.maturityYears;
    } else {
      this.ageBio = 0;
    }
    this.growth = profile.maturityYears > 0 ? clamp(initialGrowth, 0, 1) : 1;
    this.food = profile.maxFood * this.growth * (species === PlantSpecies.FoodPile ? 1 : rng.range(0.4, 1));
    this.timber = profile.maxTimber * this.growth;
  }

  get profile(): SpeciesProfile {
    return SPECIES_PROFILES[this.species];
  }

  /** Fraction of maximum edible biomass currently available. */
  foodFraction(): number {
    const max = this.profile.maxFood;
    return max > 0 ? clamp(this.food / max, 0, 1) : 0;
  }

  /** Fraction of maximum standing timber currently available. */
  timberFraction(): number {
    const max = this.profile.maxTimber;
    return max > 0 ? clamp(this.timber / max, 0, 1) : 0;
  }

  /**
   * Fell timber. Returns how much was actually taken, so a human cannot credit
   * itself wood that the tree did not have.
   */
  takeTimber(amount: number): number {
    const taken = Math.min(amount, this.timber);
    this.timber -= taken;
    return taken;
  }

  update(terrain: TerrainData, dt: number, rng: Rng, canSpread: boolean): Plant | null {
    const profile = this.profile;
    this.ageBio += dt / BIO_YEAR_SECONDS;

    if (profile.maturityYears > 0) {
      this.growth = clamp(this.ageBio / profile.maturityYears, 0, 1);
    }

    // Biomass regenerates toward the mature carrying capacity.
    const capacity = profile.maxFood * this.growth;
    if (profile.regen > 0 && this.food < capacity) {
      this.food = Math.min(capacity, this.food + profile.regen * this.growth * dt);
    } else if (profile.regen === 0) {
      // Food piles only decay.
      this.food = Math.max(0, this.food - 0.02 * dt);
    }

    // Timber regrows far more slowly than foliage — a felled tree is a lasting
    // change to the landscape, which is the point.
    const timberCapacity = profile.maxTimber * this.growth;
    if (profile.timberRegen > 0 && this.timber < timberCapacity) {
      this.timber = Math.min(timberCapacity, this.timber + profile.timberRegen * this.growth * dt);
    }

    if (this.ageBio >= profile.lifespanYears || (profile.regen === 0 && this.food <= 0)) {
      this.alive = false;
      return null;
    }

    // Seed dispersal.
    if (
      canSpread &&
      profile.seedRange > 0 &&
      this.growth > 0.65 &&
      this.food > profile.maxFood * 0.3 &&
      rng.next() < profile.seedChance * dt
    ) {
      const angle = rng.next() * Math.PI * 2;
      const distance = rng.range(1.2, profile.seedRange);
      const sx = this.x + Math.cos(angle) * distance;
      const sy = this.y + Math.sin(angle) * distance;
      if (isFertileSpot(terrain, sx, sy)) {
        const childSpecies = pickOffspringSpecies(this.species, rng);
        return new Plant(0, childSpecies, sx, sy, rng, 0);
      }
    }
    return null;
  }

  serialize(): Record<string, unknown> {
    return {
      id: this.id,
      species: this.species,
      x: this.x,
      y: this.y,
      growth: this.growth,
      ageBio: this.ageBio,
      food: this.food,
      timber: this.timber,
      radius: this.radius,
      alive: this.alive,
    };
  }

  static deserialize(data: Record<string, unknown>): Plant {
    const plant = new Plant(
      data.id as number,
      data.species as number,
      data.x as number,
      data.y as number,
      new Rng((data.id as number) >>> 0),
      0,
    );
    plant.growth = data.growth as number;
    plant.ageBio = data.ageBio as number;
    plant.food = data.food as number;
    plant.timber = (data.timber as number) ?? plant.profile.maxTimber * plant.growth;
    plant.radius = data.radius as number;
    plant.alive = data.alive as boolean;
    return plant;
  }
}

function isFertileSpot(terrain: TerrainData, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 1 || ty < 1 || tx >= terrain.width - 1 || ty >= terrain.height - 1) return false;
  const tile = tileAt(terrain, x, y);
  return tile === Tile.Grass || tile === Tile.Forest;
}

/**
 * Offspring species selection.
 *
 * Mostly inherits the parent species, but occasionally a seed lands in a niche
 * that favours a different life form. This keeps the flora from collapsing into
 * a single species without any explicit "ecology manager".
 */
function pickOffspringSpecies(parentSpecies: number, rng: Rng): number {
  if (parentSpecies === PlantSpecies.FoodPile) return PlantSpecies.Grass;
  const roll = rng.next();
  if (roll < 0.06) return PlantSpecies.Tree;
  if (roll < 0.24) return PlantSpecies.Bush;
  if (roll < 0.9) return PlantSpecies.Grass;
  return parentSpecies;
}
