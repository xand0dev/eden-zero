/**
 * Lightweight per-individual social memory.
 *
 * This is deliberately NOT a relationship system. There are no hard-coded
 * "friend", "partner" or "parent" categories — only continuous values that the
 * observer can read and interpret. Nothing in the simulation branches on
 * "is this my friend"; the values feed the sensory channels and the
 * neuromodulatory valence, and behaviour is whatever the network makes of that.
 */
export interface SocialRecord {
  id: number;
  /** How often / how long this individual has been encountered. 0..1 */
  familiarity: number;
  /** Slow-moving affiliative bond. 0..1 */
  attachment: number;
  /** Running affective value of interactions with this individual. -1..1 */
  valence: number;
  lastSeenTick: number;
  encounters: number;
  matings: number;
  /** Genetic relatedness estimate (0 = unrelated, 1 = identical). */
  relatedness: number;
}

const MAX_RECORDS = 64;

/**
 * Accumulation rates, per simulated second of co-presence.
 *
 * These are deliberately slow. An earlier version added a fixed increment per
 * *tick*, which meant that at 20 ticks/second two founders standing next to
 * each other for three seconds ended up with maximum familiarity and maximum
 * attachment. Bonds in this simulation are meant to build up over a lifetime,
 * so the observer can watch them form.
 */
const FAMILIARITY_RATE = 0.045;
const ATTACHMENT_RATE = 0.012;
const KIN_ATTACHMENT_BONUS = 1.8;

export class SocialMemory {
  private readonly records = new Map<number, SocialRecord>();

  get size(): number {
    return this.records.size;
  }

  get(id: number): SocialRecord | undefined {
    return this.records.get(id);
  }

  /** Record an encounter. Creates the record on first contact. */
  observe(
    id: number,
    tick: number,
    dt: number,
    relatedness: number,
    valenceDelta: number,
    attachmentDelta: number,
  ): SocialRecord {
    let record = this.records.get(id);
    if (!record) {
      record = {
        id,
        familiarity: 0,
        attachment: 0,
        valence: 0,
        lastSeenTick: tick,
        encounters: 0,
        matings: 0,
        relatedness,
      };
      this.records.set(id, record);
      this.evictIfNeeded();
    }
    record.encounters += 1;
    record.lastSeenTick = tick;
    record.relatedness = Math.max(record.relatedness, relatedness);
    record.familiarity = clamp01(
      record.familiarity + FAMILIARITY_RATE * (1 - record.familiarity) * dt,
    );
    const kinBonus = relatedness > 0.35 ? KIN_ATTACHMENT_BONUS : 1;
    record.attachment = clamp01(
      record.attachment + attachmentDelta * ATTACHMENT_RATE * kinBonus * dt,
    );
    record.valence = clamp(record.valence + valenceDelta * dt, -1, 1);
    return record;
  }

  recordMating(id: number): void {
    const record = this.records.get(id);
    if (!record) return;
    record.matings += 1;
    record.attachment = clamp01(record.attachment + 0.18);
    record.valence = clamp(record.valence + 0.2, -1, 1);
    record.familiarity = clamp01(record.familiarity + 0.1);
  }

  /**
   * An instantaneous event (being attacked, witnessing a death) rather than
   * continuous co-presence. Deltas are applied directly, not scaled by dt.
   */
  shock(id: number, tick: number, relatedness: number, valenceDelta: number, attachmentDelta: number): void {
    let record = this.records.get(id);
    if (!record) {
      record = {
        id,
        familiarity: 0,
        attachment: 0,
        valence: 0,
        lastSeenTick: tick,
        encounters: 1,
        matings: 0,
        relatedness,
      };
      this.records.set(id, record);
      this.evictIfNeeded();
    }
    record.lastSeenTick = tick;
    record.valence = clamp(record.valence + valenceDelta, -1, 1);
    record.attachment = clamp01(record.attachment + attachmentDelta);
  }

  /** Forgetting: familiarity and attachment fade, valence relaxes to neutral. */
  decay(dt: number, tick: number): void {
    const familiarityDecay = Math.exp(-dt / 900);
    const attachmentDecay = Math.exp(-dt / 4000);
    const valenceDecay = Math.exp(-dt / 700);
    for (const record of this.records.values()) {
      record.familiarity *= familiarityDecay;
      record.attachment *= attachmentDecay;
      record.valence *= valenceDecay;
      if (record.familiarity < 0.002 && tick - record.lastSeenTick > 4000) {
        this.records.delete(record.id);
      }
    }
  }

  /** Highest familiarity among a set of currently visible individuals. */
  maxFamiliarityAmong(ids: readonly number[]): number {
    let best = 0;
    for (let i = 0; i < ids.length; i++) {
      const record = this.records.get(ids[i]);
      if (record && record.familiarity > best) best = record.familiarity;
    }
    return best;
  }

  /** Highest attachment among a set of currently visible individuals. */
  maxAttachmentAmong(ids: readonly number[]): number {
    let best = 0;
    for (let i = 0; i < ids.length; i++) {
      const record = this.records.get(ids[i]);
      if (record && record.attachment > best) best = record.attachment;
    }
    return best;
  }

  /** Mean valence of recent social contact, used as a valence contribution. */
  recentSocialValence(): number {
    let sum = 0;
    let count = 0;
    for (const record of this.records.values()) {
      sum += record.valence;
      count++;
    }
    return count === 0 ? 0 : sum / count;
  }

  entries(): SocialRecord[] {
    return [...this.records.values()].sort((a, b) => b.familiarity - a.familiarity);
  }

  /** Keep the memory bounded: drop the least familiar, least attached, oldest. */
  private evictIfNeeded(): void {
    if (this.records.size <= MAX_RECORDS) return;
    let worstId = -1;
    let worstScore = Infinity;
    for (const record of this.records.values()) {
      const score = record.familiarity * 0.6 + record.attachment * 0.4;
      if (score < worstScore) {
        worstScore = score;
        worstId = record.id;
      }
    }
    if (worstId >= 0) this.records.delete(worstId);
  }

  serialize(): Array<[number, number, number, number, number, number, number, number]> {
    return [...this.records.values()].map((r) => [
      r.id,
      r.familiarity,
      r.attachment,
      r.valence,
      r.lastSeenTick,
      r.encounters,
      r.matings,
      r.relatedness,
    ]);
  }

  restore(data: ReadonlyArray<readonly number[]>): void {
    this.records.clear();
    for (const row of data) {
      this.records.set(row[0], {
        id: row[0],
        familiarity: row[1],
        attachment: row[2],
        valence: row[3],
        lastSeenTick: row[4],
        encounters: row[5],
        matings: row[6],
        relatedness: row[7],
      });
    }
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
