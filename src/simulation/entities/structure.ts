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

  constructor(id: number, x: number, y: number) {
    this.id = id;
    this.x = x;
    this.y = y;
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
    };
  }

  static fromData(data: StructureData): Structure {
    const structure = new Structure(data.id, data.x, data.y);
    structure.wood = data.wood;
    structure.required = data.required;
    structure.complete = data.complete;
    structure.lastBuildTick = data.lastBuildTick;
    structure.builderId = data.builderId;
    structure.builderName = data.builderName;
    return structure;
  }
}
