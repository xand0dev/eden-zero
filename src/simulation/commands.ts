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

/** Apply one command. Returns a short human-readable outcome for the ack. */
export function applyGodCommand(world: World, command: GodCommand): string {
  switch (command.kind) {
    case 'spawnHuman':
      world.spawnHuman(command.x, command.y);
      return 'spawned a human';
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
    default:
      return 'unknown command';
  }
}
