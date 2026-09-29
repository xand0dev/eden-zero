import { StructureKind } from '../entities/structure';
import { Era } from './eras';

/**
 * What a newly staked building site becomes.
 *
 * The brain has one `build` output and no idea what a granary is. The kind of a
 * structure is decided here, once, when its site is staked — from the era and
 * from what surrounds the spot. A site beside a field in a camp becomes a
 * granary; one far from water in a village becomes a well; one at the edge of a
 * town becomes a length of palisade. The rules are about places, not people: the
 * same person standing somewhere else would have started a hut.
 */

export interface SiteContext {
  era: number;
  /** A field within 6 tiles. */
  fieldNear: boolean;
  /** A granary (any state) within 14 tiles. */
  granaryNear: boolean;
  /** Tiles to the nearest fresh water. */
  waterDistance: number;
  /** A well (any state) within 16 tiles. */
  wellNear: boolean;
  workshops: number;
  huts: number;
  population: number;
  /** Bare rock within 4 tiles. */
  rockNear: boolean;
  /** Distance from the settlement centre, as a fraction of its reach. */
  edge: number;
  shrines: number;
  deaths: number;
}

export function structureKindFor(ctx: SiteContext): number {
  if (ctx.era >= Era.Camp && ctx.fieldNear && !ctx.granaryNear) return StructureKind.Granary;
  if (ctx.era >= Era.Village && ctx.waterDistance >= 8 && !ctx.wellNear) return StructureKind.Well;
  if (ctx.era >= Era.Town) {
    if (ctx.huts >= 8 && ctx.workshops < Math.max(1, Math.floor(ctx.population / 40))) return StructureKind.Workshop;
    if (ctx.shrines === 0 && ctx.deaths >= 10) return StructureKind.Shrine;
    if (ctx.edge >= 0.75) return StructureKind.Palisade;
    if (ctx.rockNear) return StructureKind.StoneHouse;
  }
  return StructureKind.Hut;
}

/** How far a granary reaches: harvests brought in within this range are stored. */
export const GRANARY_RANGE = 10;
/** Food a granary puts out at once, as a pile beside it. */
export const GRANARY_STALL = 1.6;
/** Fraction of stored food lost per day, before the season's multiplier. */
export const GRANARY_SPOILAGE_PER_DAY = 0.01;
/** A workshop makes felling and digging this much faster within its range. */
export const WORKSHOP_BONUS = 1.3;
export const WORKSHOP_RANGE = 12;
/** Predators cannot come closer than this to a finished palisade. */
export const PALISADE_BLOCK = 1.4;
/** A shrine softens stress within this range. */
export const SHRINE_RANGE = 7;
/** A well counts as fresh water within this reach. */
export const WELL_REACH = 1.8;
