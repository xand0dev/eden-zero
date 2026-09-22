/**
 * Conceptual layout of the Drosophila-inspired brain.
 *
 * The brain is a small sparse recurrent network with biologically motivated
 * regions. It is NOT the FlyWire connectome and does NOT attempt to reproduce
 * ~139k neurons — see README for the honesty statement.
 *
 *   sensory (44)
 *        |
 *   local processing (64)
 *        |
 *   recurrent interneurons (132)
 *        |
 *   internal-state / neuromodulatory (16)
 *        |
 *   motor (14)
 */

export const SENSORY_COUNT = 44;
export const LOCAL_START = 44;
export const LOCAL_COUNT = 64;
export const RECURRENT_START = 108;
export const RECURRENT_COUNT = 132;
export const MOD_START = 240;
export const MOD_COUNT = 16;
export const MOTOR_START = 256;
export const MOTOR_COUNT = 14;
export const NEURON_COUNT = 270;

/**
 * Neuron regions. Declared as a frozen object rather than a `const enum`
 * because the build pipeline (esbuild + isolatedModules) does not support
 * const enums across module boundaries.
 */
export const Region = {
  Sensory: 0,
  Local: 1,
  Recurrent: 2,
  Modulatory: 3,
  Motor: 4,
} as const;
export type Region = (typeof Region)[keyof typeof Region];

export function regionOf(index: number): Region {
  if (index < LOCAL_START) return Region.Sensory;
  if (index < RECURRENT_START) return Region.Local;
  if (index < MOD_START) return Region.Recurrent;
  if (index < MOTOR_START) return Region.Modulatory;
  return Region.Motor;
}

export const REGION_NAMES = ['sensory', 'local', 'recurrent', 'modulatory', 'motor'] as const;

/**
 * Sensory channels. Four of the most behaviourally important modalities are
 * encoded with explicit egocentric direction (front / right / back / left)
 * rather than a single scalar, so the network can express turning decisions.
 */
export const SENSORY_NAMES = [
  'food.front',
  'food.right',
  'food.back',
  'food.left',
  'water.front',
  'water.right',
  'water.back',
  'water.left',
  'conspecific.front',
  'conspecific.right',
  'conspecific.back',
  'conspecific.left',
  'threat.front',
  'threat.right',
  'threat.back',
  'threat.left',
  'touch',
  'pain',
  'cold',
  'heat',
  'light',
  'hunger',
  'thirst',
  'fatigue',
  'energy',
  'health',
  'stress',
  'libido',
  'fertility',
  'familiarity',
  'attachment',
  'noise',
  // --- construction -------------------------------------------------------
  'wood.front',
  'wood.right',
  'wood.back',
  'wood.left',
  'build.front',
  'build.right',
  'build.back',
  'build.left',
  'woodCarried',
  'buildNeed',
  'shelter',
  'dayPhase',
] as const;

/** Index of each named sensory channel. */
export const S = {
  foodFront: 0,
  foodRight: 1,
  foodBack: 2,
  foodLeft: 3,
  waterFront: 4,
  waterRight: 5,
  waterBack: 6,
  waterLeft: 7,
  humanFront: 8,
  humanRight: 9,
  humanBack: 10,
  humanLeft: 11,
  threatFront: 12,
  threatRight: 13,
  threatBack: 14,
  threatLeft: 15,
  touch: 16,
  pain: 17,
  cold: 18,
  heat: 19,
  light: 20,
  hunger: 21,
  thirst: 22,
  fatigue: 23,
  energy: 24,
  health: 25,
  stress: 26,
  libido: 27,
  fertility: 28,
  familiarity: 29,
  attachment: 30,
  noise: 31,
  woodFront: 32,
  woodRight: 33,
  woodBack: 34,
  woodLeft: 35,
  buildFront: 36,
  buildRight: 37,
  buildBack: 38,
  buildLeft: 39,
  woodCarried: 40,
  buildNeed: 41,
  shelter: 42,
  dayPhase: 43,
} as const;

/** Motor outputs. Everything a human can *do* is one of these. */
export const MOTOR_NAMES = [
  'move-forward',
  'move-backward',
  'turn-left',
  'turn-right',
  'sprint',
  'eat',
  'drink',
  'rest',
  'attack',
  'signal',
  'mate',
  'interact',
  'harvest',
  'build',
] as const;

export const M = {
  moveFwd: 0,
  moveBack: 1,
  turnLeft: 2,
  turnRight: 3,
  sprint: 4,
  eat: 5,
  drink: 6,
  rest: 7,
  attack: 8,
  signal: 9,
  mate: 10,
  interact: 11,
  harvest: 12,
  build: 13,
} as const;

export type MotorName = (typeof MOTOR_NAMES)[number];

/** Human readable label for any neuron, used by the brain inspector + traces. */
export function labelNeuron(index: number): string {
  if (index < LOCAL_START) return `sensory:${SENSORY_NAMES[index]}`;
  if (index < RECURRENT_START) return `local:${index - LOCAL_START}`;
  if (index < MOD_START) return `recurrent:${index - RECURRENT_START}`;
  if (index < MOTOR_START) return `modulatory:${index - MOD_START}`;
  return `motor:${MOTOR_NAMES[index - MOTOR_START]}`;
}

export function shortLabel(index: number): string {
  if (index < LOCAL_START) return SENSORY_NAMES[index];
  if (index < RECURRENT_START) return `L${index - LOCAL_START}`;
  if (index < MOD_START) return `R${index - RECURRENT_START}`;
  if (index < MOTOR_START) return `N${index - MOD_START}`;
  return MOTOR_NAMES[index - MOTOR_START];
}
