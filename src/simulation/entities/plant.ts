import { Rng } from '../rng';
import { EntityKind } from '../../shared/types';
import { BIO_YEAR_SECONDS } from '../../shared/constants';
import type { TerrainData } from '../environment/terrain';
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

/**
 * Radius a felled tree shrinks to, as a fraction of its full radius.
 *
 * Not zero on purpose: a stump is still something you can see, and a logged
 * stand should read as a place that has been cut rather than as bare ground.
 * The difference between "nothing was ever here" and "something was taken" is
 * the whole reason for showing it.
 */
export const STUMP_RADIUS_FRACTION = 0.4;

/**
 * Timber fraction below which a *fully grown* tree counts as a stump.
 *
 * Low, because the fraction is relative to `maxTimber * growth`: a half-grown
 * tree sits at 0.5 without anyone having touched it, and calling that a stump
 * would make a young forest look like a logged one.
 */
export const STUMP_TIMBER_FRACTION = 0.2;

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

/** Where a food pile came from. Wild plants are always `Wild`. */
export const FoodOrigin = {
  Wild: 0,
  Crop: 1,
  Carcass: 2,
  Gift: 3,
  Granary: 4,
} as const;
export type FoodOrigin = (typeof FoodOrigin)[keyof typeof FoodOrigin];

/**
 * What the world does to plant growth this tick: the season, the charter, fate,
 * and the soil under each plant. Kept as one object so `Plant` stays ignorant of
 * where any of it comes from.
 */
export interface GrowthConditions {
  /** Multiplier on food regrowth. */
  regen: number;
  /** Multiplier on seed dispersal; 0 means nothing sprouts. */
  spread: number;
  /** Multiplier on timber regrowth. */
  timber: number;
  /** Multiplier on how fast loose food spoils. */
  spoilage: number;
  /** Regrowth factor of the ground at a point, 0..1. */
  soilAt?(x: number, y: number): number;
  /** Fertility of the ground at a point, 0..1, for seeds. */
  fertilityAt?(x: number, y: number): number;
  /** Below this fertility a seed does not take. */
  seedFloor: number;
}

const NEUTRAL_GROWTH: GrowthConditions = { regen: 1, spread: 1, timber: 1, spoilage: 1, seedFloor: 0 };

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
  /** A food pile left by a harvest rather than by a death or the observer. */
  crop = false;
  /** Where a food pile came from. */
  origin: number = FoodOrigin.Wild;
  /** Who brought in the harvest this pile came from, for the atlas. */
  harvesterId = 0;

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
   * Whether the tree has been felled to a stump.
   *
   * Note that `timberFraction()` alone cannot answer this: a tree's timber is
   * `maxTimber * growth`, so a young tree that nobody has touched also reports a
   * low fraction. Only a tree that is fully grown *and* has had its timber taken
   * is a stump.
   */
  isStump(): boolean {
    return this.profile.maxTimber > 0 && this.growth > 0.85 && this.timberFraction() < STUMP_TIMBER_FRACTION;
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

  update(
    terrain: TerrainData,
    dt: number,
    rng: Rng,
    canSpread: boolean,
    conditions: GrowthConditions = NEUTRAL_GROWTH,
  ): Plant | null {
    const profile = this.profile;
    this.ageBio += dt / BIO_YEAR_SECONDS;

    if (profile.maturityYears > 0) {
      this.growth = clamp(this.ageBio / profile.maturityYears, 0, 1);
    }

    // Biomass regenerates toward the mature carrying capacity, as fast as the
    // season and the ground allow. Grazed-out ground barely regrows at all.
    const capacity = profile.maxFood * this.growth;
    if (profile.regen > 0 && this.food < capacity) {
      const soil = conditions.soilAt ? conditions.soilAt(this.x, this.y) : 1;
      this.food = Math.min(capacity, this.food + profile.regen * this.growth * conditions.regen * soil * dt);
    } else if (profile.regen === 0) {
      // Food piles only decay, faster in summer heat.
      this.food = Math.max(0, this.food - 0.02 * conditions.spoilage * dt);
    }

    // Timber regrows far more slowly than foliage — a felled tree is a lasting
    // change to the landscape, which is the point.
    const timberCapacity = profile.maxTimber * this.growth;
    if (profile.timberRegen > 0 && this.timber < timberCapacity) {
      this.timber = Math.min(
        timberCapacity,
        this.timber + profile.timberRegen * this.growth * conditions.timber * dt,
      );
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
      // The season decides whether a seed that lands takes at all (nothing
      // sprouts in winter), and exhausted ground refuses it. Drawn after the
      // dispersal roll so a world with neutral conditions consumes the random
      // stream exactly as before.
      const takes =
        conditions.spread >= 1 || rng.next() < conditions.spread;
      const ground = conditions.fertilityAt ? conditions.fertilityAt(sx, sy) : 1;
      if (takes && ground >= conditions.seedFloor && isFertileSpot(terrain, sx, sy)) {
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
      ...(this.crop ? { crop: true } : {}),
      ...(this.origin !== FoodOrigin.Wild ? { origin: this.origin } : {}),
      ...(this.harvesterId ? { harvesterId: this.harvesterId } : {}),
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
    plant.crop = (data.crop as boolean | undefined) ?? false;
    plant.origin = (data.origin as number | undefined) ?? (plant.crop ? FoodOrigin.Crop : FoodOrigin.Wild);
    plant.harvesterId = (data.harvesterId as number | undefined) ?? 0;
    return plant;
  }
}

function isFertileSpot(terrain: TerrainData, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 1 || ty < 1 || tx >= terrain.width - 1 || ty >= terrain.height - 1) return false;
  // The terrain's fertile mask: grass and forest, and reed shallows on an archipelago.
  return terrain.fertile[ty * terrain.width + tx] === 1;
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
