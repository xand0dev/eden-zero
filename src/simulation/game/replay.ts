import { World, type WorldOptions } from '../world';
import { applyGodCommandChecked } from '../commands';
import type { GodCommand } from '../../shared/protocol';

/**
 * Replays.
 *
 * A world is deterministic: the same options and the same commands at the same
 * ticks give the same history, byte for byte. So a replay is not a recording —
 * it is the seed, the charter and the list of what the observer did. That is a
 * few hundred bytes for a whole campaign, and anyone can verify a result by
 * running it again. Daily-seed results are checked the same way.
 */

export interface ReplayFile {
  format: 'eden0-replay';
  version: 1;
  options: WorldOptions;
  commands: Array<{ tick: number; command: GodCommand }>;
  /** The tick the replay runs to, and the state hash it must reach there. */
  ticks: number;
  hash: string;
}

/** A short, stable fingerprint of the parts of the world that matter. */
export function stateHash(world: World): string {
  let h = 2166136261 >>> 0;
  const mix = (value: number): void => {
    // Quantise so the hash compares simulated state, not float formatting.
    const v = Math.round(value * 1000) | 0;
    h ^= v & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(world.tick);
  mix(world.humans.length);
  for (const human of world.humans) {
    mix(human.id);
    mix(human.x);
    mix(human.y);
    mix(human.health);
    mix(human.hunger);
    mix(human.brain.w[human.brain.innateStart] ?? 0);
  }
  mix(world.predators.length);
  for (const predator of world.predators) {
    mix(predator.x);
    mix(predator.y);
  }
  mix(world.plants.length);
  mix(world.structures.length);
  mix(world.fields.length);
  mix(world.births);
  mix(world.deaths);
  mix(world.eraState.era);
  mix(world.storedFood);
  return h.toString(16).padStart(8, '0');
}

export function makeReplay(world: World): ReplayFile {
  return {
    format: 'eden0-replay',
    version: 1,
    options: world.options,
    commands: world.commandLog.map((entry) => ({ tick: entry.tick, command: entry.command })),
    ticks: world.tick,
    hash: stateHash(world),
  };
}

/**
 * Rebuild a world from a replay. Commands are applied at the tick they were
 * logged at, before the next step — exactly where the worker applied them.
 */
export function runReplay(replay: ReplayFile, onProgress?: (tick: number) => void): World {
  const world = new World(replay.options);
  let next = 0;
  const commands = replay.commands;
  while (world.tick < replay.ticks) {
    while (next < commands.length && commands[next].tick === world.tick) {
      applyGodCommandChecked(world, commands[next].command);
      next++;
    }
    world.step();
    if (onProgress && world.tick % 5000 === 0) onProgress(world.tick);
  }
  while (next < commands.length && commands[next].tick === world.tick) {
    applyGodCommandChecked(world, commands[next].command);
    next++;
  }
  return world;
}

export function verifyReplay(replay: ReplayFile): { ok: boolean; hash: string } {
  const world = runReplay(replay);
  const hash = stateHash(world);
  return { ok: hash === replay.hash, hash };
}
