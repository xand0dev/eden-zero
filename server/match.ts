/**
 * Competitive match state.
 *
 * TWO HOUSES, TWO OBSERVERS, ONE ISLAND
 * -------------------------------------
 * A match splits the founding population between two matrilineal houses. Each
 * observer is assigned one house and may command only its own people; the world
 * is otherwise shared. A house grows only through its own women, so a house that
 * loses all its females is extinct for good — which turns the whole simulation
 * into the actual game: keep your daughters alive long enough to out-breed the
 * other house.
 *
 * WHAT MAKES IT A GAME RATHER THAN A SANDBOX
 * ------------------------------------------
 *  - a score (population x 100 + generation depth x 25)
 *  - a clock and a win condition
 *  - **scarcity**: commands cost influence, and influence regenerates slowly, so
 *    an observer cannot simply spam lightning
 *  - **interaction**: hostile tools are unrestricted, so you can bomb the other
 *    house or drop a predator into its village
 *
 * Friendly tools are house-scoped: you may spawn, move, kill or edit only your
 * own people. That rule is enforced here, on the server, because a rule enforced
 * in the client is not a rule.
 */

import type { World } from '../src/simulation/world';
import type { GodCommand } from '../src/shared/protocol';
import type { HouseStats } from '../src/shared/types';

export interface MatchConfig {
  enabled: boolean;
  /** Match length in simulated seconds. */
  durationSeconds: number;
  /** Influence an observer starts with. */
  startingInfluence: number;
  /** Influence regenerated per simulated second. */
  influencePerSecond: number;
  /** Influence cost per command kind. */
  costs: Record<string, number>;
}

export const DEFAULT_MATCH: MatchConfig = {
  enabled: false,
  // Twenty simulated minutes. Long enough for two or three generations, short
  // enough that a match ends in a sitting.
  durationSeconds: 1200,
  startingInfluence: 120,
  influencePerSecond: 1.2,
  costs: {
    // Cheap and frequent: shaping your own people.
    spawnHuman: 40,
    moveHuman: 3,
    editGenome: 25,
    kill: 30,
    // Expensive: acting on the whole world, including on your rival.
    spawnFood: 12,
    spawnPredator: 45,
    lightning: 35,
    temperature: 20,
    timeOfDay: 15,
  },
};

/** Commands that may only ever be aimed at the observer's own house. */
const HOUSE_SCOPED = new Set(['spawnHuman', 'moveHuman', 'kill', 'editGenome']);
/** Commands that affect the world and may be aimed anywhere. */
const WORLD_SCOPED = new Set(['lightning', 'spawnPredator', 'spawnFood', 'temperature', 'timeOfDay']);

export interface ObserverSlot {
  house: number;
  influence: number;
  commandsIssued: number;
  commandsRefused: number;
  name: string;
}

export interface MatchView {
  enabled: boolean;
  running: boolean;
  finished: boolean;
  /** Simulated seconds elapsed in the match. */
  elapsed: number;
  duration: number;
  houses: HouseStats[];
  winner: number | null;
  reason: string;
  /** Influence left per house, for the scoreboard. */
  influence: number[];
  observers: number;
}

export class Match {
  private readonly config: MatchConfig;
  private startedAt = -1;
  private finished = false;
  private winner: number | null = null;
  private reason = '';
  private readonly slots = new Map<number, ObserverSlot>();
  private nextHouse = 0;

  constructor(config: MatchConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Claim a house for a newly connected observer. */
  join(name: string): ObserverSlot {
    const house = this.nextHouse % 2;
    this.nextHouse += 1;
    const slot: ObserverSlot = {
      house,
      influence: this.config.startingInfluence,
      commandsIssued: 0,
      commandsRefused: 0,
      name,
    };
    this.slots.set(house, slot);
    return slot;
  }

  leave(house: number): void {
    this.slots.delete(house);
  }

  getSlot(house: number): ObserverSlot | undefined {
    return this.slots.get(house);
  }

  /** Start the clock on the first tick the world actually advances. */
  tick(world: World): void {
    if (!this.config.enabled || this.finished) return;
    if (this.startedAt < 0) this.startedAt = world.simTime;

    const elapsed = world.simTime - this.startedAt;
    for (const slot of this.slots.values()) {
      slot.influence = Math.min(
        this.config.startingInfluence * 2,
        slot.influence + this.config.influencePerSecond * (1 / 20),
      );
    }

    const houses = world.houseStats();
    for (const entry of houses) {
      if (entry.population === 0) {
        const other = entry.house === 0 ? 1 : 0;
        this.finished = true;
        this.winner = other;
        this.reason = `house ${entry.house} died out`;
        return;
      }
    }

    if (elapsed >= this.config.durationSeconds) {
      this.finished = true;
      const [a, b] = houses;
      if (a.score === b.score) {
        this.winner = null;
        this.reason = 'the houses finished level';
      } else {
        this.winner = a.score > b.score ? a.house : b.house;
        this.reason = 'the longer-lived house prevailed';
      }
    }
  }

  /**
   * Validate and charge for a command.
   *
   * Returns null when the command may proceed, or a refusal reason. Both outcomes
   * are reported back to the observer — a silent refusal is worse than no rule.
   */
  authorise(world: World, slot: ObserverSlot, command: GodCommand): string | null {
    if (!this.config.enabled) return null;
    if (this.finished) return 'the match is over';

    const cost = this.config.costs[command.kind] ?? 0;
    if (slot.influence < cost) {
      slot.commandsRefused += 1;
      return `not enough influence (need ${cost}, have ${Math.floor(slot.influence)})`;
    }

    if (WORLD_SCOPED.has(command.kind)) {
      slot.influence -= cost;
      slot.commandsIssued += 1;
      return null;
    }

    if (HOUSE_SCOPED.has(command.kind)) {
      // A spawned human has no mother, so the house cannot be inherited: it
      // belongs to whoever paid for it. Every other house-scoped command names a
      // target, and that target must be yours.
      if (command.kind === 'spawnHuman') {
        slot.influence -= cost;
        slot.commandsIssued += 1;
        return null;
      }
      if (!('id' in command) || typeof command.id !== 'number') {
        slot.commandsRefused += 1;
        return 'that command needs a target';
      }
      const human = world.getHuman(command.id);
      if (!human) {
        slot.commandsRefused += 1;
        return 'no such human';
      }
      if (human.house !== slot.house) {
        slot.commandsRefused += 1;
        return `that human belongs to house ${human.house}, not yours`;
      }
      slot.influence -= cost;
      slot.commandsIssued += 1;
      return null;
    }

    slot.commandsRefused += 1;
    return 'unknown command';
  }

  view(world: World): MatchView {
    const houses = world.houseStats();
    const influence = [0, 1].map((house) => Math.floor(this.slots.get(house)?.influence ?? 0));
    return {
      enabled: this.config.enabled,
      running: this.startedAt >= 0 && !this.finished,
      finished: this.finished,
      elapsed: this.startedAt >= 0 ? Math.max(0, world.simTime - this.startedAt) : 0,
      duration: this.config.durationSeconds,
      houses,
      winner: this.winner,
      reason: this.reason,
      influence,
      observers: this.slots.size,
    };
  }
}

