/**
 * God commands, applied to a world.
 *
 * Extracted from the worker so that the local (Web Worker) and remote
 * (WebSocket server) paths run *identical* code. Two copies of this switch would
 * drift, and the drift would only show up as "the lightning works locally but not
 * on the server" — the worst kind of bug to find.
 */
import type { World } from './world';
import type { GodCommand } from '../shared/protocol';
import { spend } from './game/favour';

/**
 * Apply one command. Returns a short human-readable outcome for the ack.
 *
 * `house` is only meaningful in competitive mode: a god-spawned human has no
 * mother, so it is assigned to the observer who paid for it rather than
 * inheriting a lineage.
 */
export function applyGodCommand(world: World, command: GodCommand, house = 0): string {
  return applyGodCommandChecked(world, command, house).message;
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

/** Tools that change the world. Time-of-day and temperature count too. */
const COSTED = new Set([
  'spawnHuman',
  'kill',
  'lightning',
  'spawnFood',
  'spawnPredator',
  'moveHuman',
  'temperature',
  'timeOfDay',
  'editGenome',
  'rain',
  'bless',
  'rewardPulse',
  'painPulse',
]);

/**
 * Check the charter and the favour budget, then apply the command.
 *
 * The world's own laws come first — "only an observer" refuses everything, "no
 * new souls" refuses creating people — then favour. In a sandbox favour is off
 * and only the laws apply. Every accepted command is logged with its tick, which
 * is all a replay needs.
 */
export function applyGodCommandChecked(world: World, command: GodCommand, house = 0): CommandResult {
  if (COSTED.has(command.kind)) {
    if (!world.rules.interventions) return { ok: false, message: 'This world’s charter forbids interventions.' };
    if (command.kind === 'spawnHuman' && !world.rules.spawnAllowed) {
      return { ok: false, message: 'This world’s charter forbids creating people.' };
    }
    if (command.kind === 'editGenome' && world.favour.enabled) {
      const target = world.getHuman(command.id);
      if (target && target.ageBio >= 1.5) {
        return { ok: false, message: 'Only a newborn’s genome can be edited: a grown brain was built from the old one.' };
      }
    }
    const inCrisis = world.fate.current?.phase === 'active';
    const paid = spend(world.favour, command.kind, world.tick, inCrisis);
    if (!paid.ok) return { ok: false, message: paid.reason };
  }
  world.commandLog.push({ tick: world.tick, command });
  return { ok: true, message: applyUnchecked(world, command, house) };
}

function applyUnchecked(world: World, command: GodCommand, house: number): string {
  switch (command.kind) {
    case 'spawnHuman':
      world.spawnHuman(command.x, command.y, undefined, 18, house);
      return house === 0 ? 'spawned a human' : `spawned a human for house ${house}`;
    case 'kill': {
      const human = world.getHuman(command.id);
      if (!human) return 'no such human';
      world.killHuman(human, 'the observer', null);
      return `killed ${human.name}`;
    }
    case 'lightning':
      world.strikeLightning(command.x, command.y);
      return 'called down lightning';
    case 'spawnFood':
      world.spawnFood(command.x, command.y);
      return 'placed food';
    case 'spawnPredator':
      world.spawnPredator(command.x, command.y);
      return 'released a predator';
    case 'moveHuman':
      world.repositionHuman(command.id, command.x, command.y);
      return 'moved a human';
    case 'temperature':
      world.setTemperatureOffset(command.offset);
      return `set the temperature offset to ${command.offset}`;
    case 'timeOfDay':
      world.setTimeOfDay(command.phase);
      return 'moved the sun';
    case 'editGenome':
      world.editGenome(command.id, command.key as never, command.value);
      return 'edited a genome';
    case 'rain':
      world.rain(command.x, command.y);
      return 'called rain';
    case 'bless':
      return world.bless(command.id) ? 'blessed a human' : 'no such human';
    case 'rewardPulse':
      return world.pulse(command.id, 1) ? 'sent a reward pulse' : 'no such human';
    case 'painPulse':
      return world.pulse(command.id, -1) ? 'sent a pain pulse' : 'no such human';
    default:
      return 'unknown command';
  }
}
