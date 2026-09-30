/**
 * The Rules of Creation.
 *
 * EDEN//0 is built on a short list of base rules, and everything the observer
 * sees is generated from them while the world runs: behaviour, skills, instincts,
 * looks, peoples, the style of their buildings, the ages the world passes
 * through. No behaviour, skill, people or age is written anywhere as content;
 * these rules are what is written, and what comes out of them is the game.
 *
 * This file is the list. Each rule names the code that is its only
 * implementation, so the claim can be checked. The UI shows it (the Book of
 * Life) and docs/RULES_OF_CREATION.md explains it at length.
 */

export interface CreationRule {
  id: string;
  /** Roman numeral as shown. */
  numeral: string;
  name: string;
  /** The rule itself, one sentence. */
  rule: string;
  /** What it produces while the world runs. */
  yields: string;
  /** Where it lives. */
  code: string;
}

export const RULES_OF_CREATION: readonly CreationRule[] = [
  {
    id: 'land',
    numeral: 'I',
    name: 'Land',
    rule: 'The island is a grid; every standing thing owns the cells under it, and no cell holds two things. Living things walk freely across it.',
    yields: 'An ordered landscape: fields, canals, huts, plants and harvests that never overlap.',
    code: 'src/simulation/spatial/occupancy.ts',
  },
  {
    id: 'body',
    numeral: 'II',
    name: 'Body',
    rule: 'A person is senses, a spiking brain and muscles. The world answers only the muscles; the only reward is the body doing better or worse.',
    yields: 'All behaviour — foraging, fleeing, building, farming, courting — with no behaviour written.',
    code: 'src/simulation/entities/human.ts, src/simulation/brain/network.ts',
  },
  {
    id: 'growth',
    numeral: 'III',
    name: 'Growth',
    rule: 'At a moment that matters, a brain with room grows one neuron from what stood out in its senses to what it was doing — and prunes those that stop earning their keep.',
    yields: 'Skills: new context → action rules, named from their wiring, different in every life.',
    code: 'src/simulation/brain/network.ts (considerGrowth), src/simulation/brain/skills.ts',
  },
  {
    id: 'heredity',
    numeral: 'IV',
    name: 'Heredity',
    rule: 'Children take their genes from both parents with mutation, and the skills that served a parent best are born into the child as instincts.',
    yields: 'Evolution of bodies and brains, and instincts no one designed that spread down lineages.',
    code: 'src/simulation/genetics/evolution.ts, inheritInstincts in brain/network.ts',
  },
  {
    id: 'drift',
    numeral: 'V',
    name: 'Drift',
    rule: 'Looks are inherited and nothing selects on them, so they drift; a group that settles apart becomes a people of its own, and a people that drifts far enough becomes another.',
    yields: 'Peoples with generated names, faces, paint and adornment, and buildings in their style.',
    code: 'src/simulation/game/peoples.ts, src/render/morph.ts',
  },
  {
    id: 'time',
    numeral: 'VI',
    name: 'Time',
    rule: 'Every year a new age begins, drawn from the world’s seed, leaning the physics one way and carrying an omen.',
    yields: 'An endless run of different chapters: plenty, frost, hunters, change, calm.',
    code: 'src/simulation/game/ages.ts',
  },
  {
    id: 'fate',
    numeral: 'VII',
    name: 'Fate',
    rule: 'Crises arrive by chance, harder as the settlement grows; the observer may intervene, at a price.',
    yields: 'Droughts, fires, fevers and migrations that make each run a different story.',
    code: 'src/simulation/game/crises.ts, src/simulation/game/favour.ts',
  },
];
