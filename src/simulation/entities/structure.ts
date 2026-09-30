/**
 * Structures — huts the inhabitants build out of harvested timber.
 *
 * This is the one place in the simulation where humans change the world
 * permanently. Everything else they do is transient: they eat a berry and it is
 * gone, they mate and the act ends. A hut persists, and later generations are
 * born beside it.
 *
 * Design note: the *sites* are chosen deterministically at world creation (a ring
 * of plots around the settlement), but nothing about the labour is scripted. No
 * rule says "human 3 builds hut 2". The network decides, tick by tick, whether to
 * fell a tree, carry the timber, or lay it on a site — driven by the same
 * `wood.*` and `build.*` sensory channels every other behaviour uses.
 */

export const WOOD_PER_HUT = 42;

/**
 * What a structure is.
 *
 * Every kind is raised the same way — timber laid on a site by the `build` motor
 * — and the kind is decided by where the site was staked and what the settlement
 * already has (see `game/buildings.ts`). The brain has no "build a granary"
 * output; a granary is what a hut site beside a field becomes in a camp.
 */
export const StructureKind = {
  Hut: 0,
  Granary: 1,
  Well: 2,
  Workshop: 3,
  StoneHouse: 4,
  Palisade: 5,
  Shrine: 6,
} as const;
export type StructureKind = (typeof StructureKind)[keyof typeof StructureKind];

export const STRUCTURE_NAMES = ['hut', 'granary', 'well', 'workshop', 'stone house', 'palisade', 'shrine'] as const;

/** Timber each kind needs. */
export const WOOD_BY_KIND: Record<number, number> = {
  [StructureKind.Hut]: WOOD_PER_HUT,
  [StructureKind.Granary]: 60,
  [StructureKind.Well]: 30,
  [StructureKind.Workshop]: 70,
  [StructureKind.StoneHouse]: 54,
  [StructureKind.Palisade]: 18,
  [StructureKind.Shrine]: 48,
};

/** Kinds people can sleep in, for warmth and the shelter sense. */
export function isDwelling(kind: number): boolean {
  return kind === StructureKind.Hut || kind === StructureKind.StoneHouse;
}
/** Timber a human can carry at once. */
export const CARRY_CAPACITY = 12;
/** Ticks of work to fell one unit of timber from a tree. */
export const HARVEST_INTERVAL_TICKS = 24;
/** Timber laid per build action. */
export const BUILD_CHUNK = 3;
export const BUILD_INTERVAL_TICKS = 20;

export interface StructureData {
  id: number;
  x: number;
  y: number;
  wood: number;
  required: number;
  complete: boolean;
  /** Tick at which the last timber was laid, for the build animation. */
  lastBuildTick: number;
  builderId: number;
  builderName: string;
  /** Absent in saves written before structure kinds existed: those are all huts. */
  kind?: number;
  /** Food held, for a granary. */
  store?: number;
  /** The people whose builder staked it (v3): its style is theirs. */
  people?: number;
  /** That people's building colour (hue) and roof shape, for the renderer. */
  styleHue?: number;
  styleRoof?: number;
}

export class Structure {
  id: number;
  x: number;
  y: number;
  wood = 0;
  required = WOOD_PER_HUT;
  complete = false;
  lastBuildTick = -1000;
  builderId = 0;
  builderName = '';
  kind: number = StructureKind.Hut;
  /** Food held in a granary. Zero for everything else. */
  store = 0;
  /** The people whose builder staked it; 0 before peoples existed. */
  people = 0;

  constructor(id: number, x: number, y: number, kind: number = StructureKind.Hut) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.kind = kind;
    this.required = WOOD_BY_KIND[kind] ?? WOOD_PER_HUT;
  }

  get progress(): number {
    return Math.max(0, Math.min(1, this.wood / this.required));
  }

  /** How much timber the site still wants, normalised. Drives `S.buildNeed`. */
  get need(): number {
    if (this.complete) return 0;
    return Math.max(0, 1 - this.progress);
  }

  /**
   * Add timber. Returns how much was actually accepted, so the caller only
   * removes that much from the carrier.
   */
  contribute(amount: number, tick: number, builderId: number, builderName: string): number {
    if (this.complete) return 0;
    const accepted = Math.min(amount, this.required - this.wood);
    if (accepted <= 0) return 0;
    this.wood += accepted;
    this.lastBuildTick = tick;
    this.builderId = builderId;
    this.builderName = builderName;
    if (this.wood >= this.required) {
      this.wood = this.required;
      this.complete = true;
    }
    return accepted;
  }

  toData(): StructureData {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      wood: this.wood,
      required: this.required,
      complete: this.complete,
      lastBuildTick: this.lastBuildTick,
      builderId: this.builderId,
      builderName: this.builderName,
      ...(this.kind !== StructureKind.Hut ? { kind: this.kind } : {}),
      ...(this.store > 0 ? { store: this.store } : {}),
      ...(this.people > 0 ? { people: this.people } : {}),
    };
  }

  static fromData(data: StructureData): Structure {
    const structure = new Structure(data.id, data.x, data.y, data.kind ?? StructureKind.Hut);
    structure.store = data.store ?? 0;
    structure.people = data.people ?? 0;
    structure.wood = data.wood;
    structure.required = data.required;
    structure.complete = data.complete;
    structure.lastBuildTick = data.lastBuildTick;
    structure.builderId = data.builderId;
    structure.builderName = data.builderName;
    return structure;
  }
}
