import { M, MOTOR_NAMES, SENSORY_NAMES, S } from './channels';

/**
 * Names for grown neurons.
 *
 * A neuron a brain grows during life ties a handful of senses to one muscle:
 * "when these are on, do (or stop doing) that". Nobody wrote that rule — the
 * brain grew it at a moment that mattered — so the only honest name for it is
 * one built from what it is wired to. That is what this file does, and all it
 * does: it reads a neuron's wiring and says it in words. Nothing here feeds
 * back into the simulation.
 */

/** One word for the context a sense gives, used in a skill's name. */
const CONTEXT_WORD: Record<number, string> = {
  [S.foodFront]: 'Forage', [S.foodRight]: 'Forage', [S.foodBack]: 'Forage', [S.foodLeft]: 'Forage',
  [S.waterFront]: 'Water', [S.waterRight]: 'Water', [S.waterBack]: 'Water', [S.waterLeft]: 'Water',
  [S.humanFront]: 'Kin', [S.humanRight]: 'Kin', [S.humanBack]: 'Kin', [S.humanLeft]: 'Kin',
  [S.threatFront]: 'Threat', [S.threatRight]: 'Threat', [S.threatBack]: 'Threat', [S.threatLeft]: 'Threat',
  [S.touch]: 'Touch', [S.pain]: 'Pain', [S.cold]: 'Frost', [S.heat]: 'Heat', [S.light]: 'Daylight',
  [S.hunger]: 'Hunger', [S.thirst]: 'Thirst', [S.fatigue]: 'Weary', [S.energy]: 'Vigour', [S.health]: 'Hale',
  [S.stress]: 'Dread', [S.libido]: 'Longing', [S.fertility]: 'Bloom', [S.familiarity]: 'Hearth-kin',
  [S.attachment]: 'Bond', [S.noise]: 'Whim',
  [S.woodFront]: 'Timber', [S.woodRight]: 'Timber', [S.woodBack]: 'Timber', [S.woodLeft]: 'Timber',
  [S.buildFront]: 'Site', [S.buildRight]: 'Site', [S.buildBack]: 'Site', [S.buildLeft]: 'Site',
  [S.woodCarried]: 'Burden', [S.buildNeed]: 'Roofless', [S.shelter]: 'Home', [S.dayPhase]: 'Dusk',
  [S.forestFront]: 'Forest', [S.forestRight]: 'Forest', [S.forestBack]: 'Forest', [S.forestLeft]: 'Forest',
  [S.fieldFront]: 'Field', [S.fieldRight]: 'Field', [S.fieldBack]: 'Field', [S.fieldLeft]: 'Field',
  [S.canalFront]: 'Canal', [S.canalRight]: 'Canal', [S.canalBack]: 'Canal', [S.canalLeft]: 'Canal',
  [S.soilMoisture]: 'Wet-earth', [S.fieldNeed]: 'Fallow', [S.fieldGrowth]: 'Green', [S.irrigationNeed]: 'Dry-earth',
  [S.seeds]: 'Seed', [S.cropReady]: 'Ripe', [S.storedFood]: 'Granary', [S.settlementStage]: 'Age',
};

/** What each muscle does, as a noun, for a skill's name. */
const MOTOR_NOUN: Record<number, string> = {
  [M.moveFwd]: 'Stride', [M.moveBack]: 'Retreat', [M.turnLeft]: 'Veer-left', [M.turnRight]: 'Veer-right',
  [M.sprint]: 'Dash', [M.eat]: 'Feast', [M.drink]: 'Drink', [M.rest]: 'Rest', [M.attack]: 'Strike',
  [M.signal]: 'Call', [M.mate]: 'Courtship', [M.interact]: 'Greeting', [M.harvest]: 'Felling',
  [M.build]: 'Building', [M.plant]: 'Sowing', [M.tend]: 'Reaping', [M.dig]: 'Digging',
};

/** What each muscle does, as a verb phrase, for a skill's sentence. */
const MOTOR_VERB: Record<number, string> = {
  [M.moveFwd]: 'walk on', [M.moveBack]: 'back away', [M.turnLeft]: 'turn left', [M.turnRight]: 'turn right',
  [M.sprint]: 'run', [M.eat]: 'eat', [M.drink]: 'drink', [M.rest]: 'rest', [M.attack]: 'strike',
  [M.signal]: 'call out', [M.mate]: 'court', [M.interact]: 'greet', [M.harvest]: 'fell timber',
  [M.build]: 'build', [M.plant]: 'sow', [M.tend]: 'reap', [M.dig]: 'dig',
};

/** A sense as a phrase: "food ahead", "water to the left", "thirsty". */
export function sensePhrase(index: number): string {
  const name = SENSORY_NAMES[index];
  if (!name) return `input ${index}`;
  const [what, where] = name.split('.');
  const noun: Record<string, string> = {
    food: 'food', water: 'water', conspecific: 'someone', threat: 'a threat', wood: 'timber',
    build: 'a building site', forest: 'forest', field: 'a field', canal: 'a canal',
  };
  if (where) {
    const side = where === 'front' ? 'ahead' : where === 'back' ? 'behind' : `to the ${where}`;
    return `${noun[what] ?? what} ${side}`;
  }
  const scalar: Record<string, string> = {
    touch: 'touched', pain: 'in pain', cold: 'cold', heat: 'hot', light: 'daylight', hunger: 'hungry',
    thirst: 'thirsty', fatigue: 'tired', energy: 'rested', health: 'healthy', stress: 'afraid',
    libido: 'longing', fertility: 'fertile', familiarity: 'among kin', attachment: 'near a partner',
    noise: 'restless', woodCarried: 'carrying timber', buildNeed: 'the village short of roofs',
    shelter: 'under a roof', dayPhase: 'evening', soilMoisture: 'wet soil', fieldNeed: 'a field wanting seed',
    fieldGrowth: 'crops growing', irrigationNeed: 'dry soil', seeds: 'seed in hand', cropReady: 'a ripe crop',
    storedFood: 'a full granary', settlementStage: 'a grown village',
  };
  return scalar[name] ?? name;
}

export interface SkillWiring {
  /** Presynaptic neuron indices, strongest first. */
  inputs: readonly number[];
  /** Motor index, 0..16. */
  motor: number;
  /** Sign of the output synapse: +1 drives the motor, -1 holds it back. */
  sign: number;
}

/** A stable key for a skill's wiring, so the same skill found twice is known as the same. */
export function skillSignature(wiring: SkillWiring): string {
  const senses = wiring.inputs.filter((i) => i < SENSORY_NAMES.length).map((i) => CONTEXT_WORD[i] ?? `s${i}`);
  const unique = [...new Set(senses)].sort();
  return `${unique.join('+')}>${wiring.sign > 0 ? '' : '!'}${MOTOR_NAMES[wiring.motor] ?? wiring.motor}`;
}

/** "Thirst Stride", "Dusk Rest", "Pain-curbed Felling". */
export function skillName(wiring: SkillWiring): string {
  const first = wiring.inputs.find((i) => i < SENSORY_NAMES.length);
  const context = first !== undefined ? (CONTEXT_WORD[first] ?? 'Odd') : 'Inner';
  const noun = MOTOR_NOUN[wiring.motor] ?? 'Act';
  return wiring.sign > 0 ? `${context} ${noun}` : `${context}-curbed ${noun}`;
}

/** "When thirsty and water ahead: walk on." */
export function skillSentence(wiring: SkillWiring): string {
  const phrases = [...new Set(wiring.inputs.filter((i) => i < SENSORY_NAMES.length).map(sensePhrase))];
  const when = phrases.length === 0 ? 'On an inner urge' : `When ${joinAnd(phrases)}`;
  const verb = MOTOR_VERB[wiring.motor] ?? 'act';
  return wiring.sign > 0 ? `${when}: ${verb}.` : `${when}: do not ${verb}.`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
