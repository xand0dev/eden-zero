/**
 * Cultivation — fields and the canals that keep them alive.
 *
 * This is the second thing in the simulation that changes the world permanently
 * (the first is the hut). A field is a place a settlement returns to: it has to
 * be sown, it ripens on its own schedule, and it dries out if nobody brings it
 * water. That is the loop the twenty-minute session is built around — the
 * settlement stops following the berries and starts tending something.
 *
 * As with construction, nothing here decides who farms. The sites are staked out
 * where the network chooses, and the three motors (`plant`, `tend`, `dig`) are
 * driven by the same sensory channels every other behaviour uses.
 */

export const FieldStage = {
  /** Bare ground. Wants sowing. */
  Fallow: 0,
  /** Sown and growing. */
  Growing: 1,
  /** Ripe. Wants harvesting. */
  Ripe: 2,
} as const;
export type FieldStage = (typeof FieldStage)[keyof typeof FieldStage];

/** Fraction of a full crop added per simulated second, when watered. */
export const FIELD_GROWTH_PER_SECOND = 0.014;
/** Moisture lost per simulated second. */
export const FIELD_DRY_PER_SECOND = 0.0075;
/** Moisture gained per simulated second from an adjacent canal. */
export const FIELD_WATER_PER_SECOND = 0.05;
/** Below this moisture a field stops growing entirely. */
export const FIELD_MOISTURE_FLOOR = 0.22;
/** Moisture a newly broken field starts with. */
export const FIELD_START_MOISTURE = 0.55;
/** Food spawned as a pile when a crop is brought in. Far more than wild forage. */
export const FIELD_YIELD = 3.4;
/** How close a canal must be to water for its flow to be live, in tiles. */
export const CANAL_SOURCE_RANGE = 4;
/** How far a flowing canal waters a field, in tiles. */
export const CANAL_REACH = 3.5;
/** Work ticks to break one length of canal. */
export const CANAL_DIG_TICKS = 50;

export interface FieldData {
  id: number;
  x: number;
  y: number;
  stage: number;
  growth: number;
  moisture: number;
  lastWorkTick: number;
  workerName: string;
}

export class Field {
  readonly kind = 'field';
  id: number;
  x: number;
  y: number;
  stage: number = FieldStage.Fallow;
  /** 0..1 crop maturity. Meaningless while fallow. */
  growth = 0;
  /** 0..1 soil moisture. Drops on its own, restored by a canal. */
  moisture = FIELD_START_MOISTURE;
  lastWorkTick = -1000;
  workerName = '';

  constructor(id: number, x: number, y: number) {
    this.id = id;
    this.x = x;
    this.y = y;
  }

  /** Ripe crops want bringing in. Drives `S.cropReady`. */
  get ripe(): boolean {
    return this.stage === FieldStage.Ripe;
  }

  /** Bare ground wants sowing. Drives `S.fieldNeed`. */
  get needsSowing(): boolean {
    return this.stage === FieldStage.Fallow;
  }

  /** Crop maturity, for the `S.fieldGrowth` channel. */
  get growthFraction(): number {
    return this.stage === FieldStage.Fallow ? 0 : this.growth;
  }

  /**
   * Advance one tick.
   *
   * Growth needs moisture; moisture needs a canal or the rain. A field that runs
   * dry stalls where it is rather than dying, so neglect costs time rather than
   * the whole investment — a first farming system that can wipe out the village
   * is worse than no farming system.
   */
  update(dt: number, watered: boolean): void {
    if (watered) {
      this.moisture = Math.min(1, this.moisture + FIELD_WATER_PER_SECOND * dt);
    } else {
      this.moisture = Math.max(0, this.moisture - FIELD_DRY_PER_SECOND * dt);
    }

    if (this.stage !== FieldStage.Growing) return;
    if (this.moisture < FIELD_MOISTURE_FLOOR) return;

    // Dry soil grows slowly even above the floor; wet soil grows at full rate.
    const rate = 0.4 + 0.6 * this.moisture;
    this.growth = Math.min(1, this.growth + FIELD_GROWTH_PER_SECOND * rate * dt);
    if (this.growth >= 1) this.stage = FieldStage.Ripe;
  }

  sow(tick: number, workerName: string): boolean {
    if (this.stage !== FieldStage.Fallow) return false;
    this.stage = FieldStage.Growing;
    this.growth = 0;
    this.lastWorkTick = tick;
    this.workerName = workerName;
    return true;
  }

  /** Bring in the crop and return to bare ground. */
  harvest(tick: number, workerName: string): boolean {
    if (this.stage !== FieldStage.Ripe) return false;
    this.stage = FieldStage.Fallow;
    this.growth = 0;
    this.lastWorkTick = tick;
    this.workerName = workerName;
    return true;
  }

  toData(): FieldData {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      stage: this.stage,
      growth: this.growth,
      moisture: this.moisture,
      lastWorkTick: this.lastWorkTick,
      workerName: this.workerName,
    };
  }

  static fromData(data: FieldData): Field {
    const field = new Field(data.id, data.x, data.y);
    field.stage = data.stage;
    field.growth = data.growth;
    field.moisture = data.moisture;
    field.lastWorkTick = data.lastWorkTick;
    field.workerName = data.workerName;
    return field;
  }
}

export interface CanalData {
  id: number;
  x: number;
  y: number;
  progress: number;
  complete: boolean;
  flowing: boolean;
  lastWorkTick: number;
}

export class Canal {
  readonly kind = 'canal';
  id: number;
  x: number;
  y: number;
  /** 0..1 dug. A partially dug length carries no water. */
  progress = 0;
  complete = false;
  /**
   * Whether water actually reaches here.
   *
   * Recomputed each tick from the terrain: a canal is live if it is close enough
   * to a water tile, or adjacent to another live canal. That makes a chain from
   * the river to the fields behave like a chain, without anyone having to model
   * flow direction.
   */
  flowing = false;
  lastWorkTick = -1000;

  constructor(id: number, x: number, y: number) {
    this.id = id;
    this.x = x;
    this.y = y;
  }

  /** Dig one shift. Returns true when this length is finished. */
  dig(tick: number): boolean {
    if (this.complete) return false;
    this.progress = Math.min(1, this.progress + 1 / CANAL_DIG_TICKS);
    this.lastWorkTick = tick;
    if (this.progress >= 1) {
      this.progress = 1;
      this.complete = true;
      return true;
    }
    return false;
  }

  toData(): CanalData {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      progress: this.progress,
      complete: this.complete,
      flowing: this.flowing,
      lastWorkTick: this.lastWorkTick,
    };
  }

  static fromData(data: CanalData): Canal {
    const canal = new Canal(data.id, data.x, data.y);
    canal.progress = data.progress;
    canal.complete = data.complete;
    canal.flowing = data.flowing;
    canal.lastWorkTick = data.lastWorkTick;
    return canal;
  }
}
