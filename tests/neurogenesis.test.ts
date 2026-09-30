import { describe, expect, it } from 'vitest';
import { Brain, decodeInstincts, inheritInstincts, INSTINCT_STRIDE, type GrownNeuron } from '../src/simulation/brain/network';
import { GROWN_START, M, MOTOR_START, NEURON_COUNT, S, SENSORY_COUNT } from '../src/simulation/brain/channels';
import { randomGenome } from '../src/simulation/genetics/genome';
import { Rng } from '../src/simulation/rng';
import { World, DEFAULT_WORLD_OPTIONS } from '../src/simulation/world';
import { skillName, skillSentence } from '../src/simulation/brain/skills';

function brain(seed = 'neuro'): Brain {
  const genome = randomGenome(new Rng(seed), 0);
  genome.neurogenesis = 1;
  return new Brain(genome);
}

const spec = (motor: number, sign = 1): GrownNeuron => ({
  inputs: [S.thirst, S.waterFront],
  inW: [0.8, 0.7],
  motor,
  outW: 0.55 * sign,
  born: 10,
  generations: 0,
  utility: 0,
});

function drive(b: Brain, sensory: Float32Array, ticks: number): void {
  for (let t = 0; t < ticks; t++) b.step(sensory, 0);
}

describe('neurogenesis', () => {
  it('grows a neuron after the core, leaving every core synapse where it was', () => {
    const b = brain();
    const core = b.synCount;
    const before = b.w.slice();
    expect(b.grow(spec(M.drink))).toBe(true);
    expect(b.neuronCount).toBe(NEURON_COUNT + 1);
    expect(b.synCount).toBe(core + 3);
    for (let s = 0; s < core; s++) expect(b.w[s]).toBe(before[s]);
    expect(b.pre[core]).toBe(S.thirst);
    expect(b.post[core]).toBe(GROWN_START);
    expect(b.post[core + 2]).toBe(MOTOR_START + M.drink);
  });

  it('a grown neuron fires when its moment recurs and drives its muscle', () => {
    const b = brain();
    const sensory = new Float32Array(SENSORY_COUNT);
    sensory[S.thirst] = 1;
    sensory[S.waterFront] = 1;
    drive(b, sensory, 50);
    const without = b.motorDrive[M.drink];
    const grownBrain = brain();
    grownBrain.grow({ ...spec(M.drink), inW: [1.2, 1.2], outW: 1.2 });
    drive(grownBrain, sensory, 50);
    expect(grownBrain.rate[GROWN_START]).toBeGreaterThan(0.1);
    // Drive is spiky; compare over a window rather than one sub-step.
    let sumWith = 0;
    let sumWithout = 0;
    for (let t = 0; t < 40; t++) {
      grownBrain.step(sensory, 0);
      b.step(sensory, 0);
      sumWith += grownBrain.motorDrive[M.drink];
      sumWithout += b.motorDrive[M.drink];
    }
    expect(sumWith).toBeGreaterThan(sumWithout);
    void without;
  });

  it('prunes a neuron and moves the later ones down a slot', () => {
    const b = brain();
    const core = b.synCount;
    b.grow(spec(M.drink));
    b.grow(spec(M.eat));
    b.grow(spec(M.rest, -1));
    b.prune(1);
    expect(b.grown.map((g) => g.motor)).toEqual([M.drink, M.rest]);
    expect(b.synCount).toBe(core + 6);
    // The rest neuron now lives in slot 1 and still projects onto rest.
    expect(b.pre[core + 5]).toBe(GROWN_START + 1);
    expect(b.post[core + 5]).toBe(MOTOR_START + M.rest);
    expect(b.grownOutWeight(1)).toBeCloseTo(-0.55, 5);
  });

  it('grows at a salient moment, crediting the given muscle, and not again during cooldown', () => {
    const b = brain();
    const sensory = new Float32Array(SENSORY_COUNT);
    drive(b, sensory, 200);
    for (let t = 0; t < 200; t++) b.considerGrowth(0, M.drink, t);
    sensory[S.thirst] = 1;
    sensory[S.waterFront] = 0.9;
    sensory[S.cold] = 0.6;
    drive(b, sensory, 5);
    const grown = b.considerGrowth(0.8, M.drink, 1000);
    expect(grown).not.toBeNull();
    expect(grown!.motor).toBe(M.drink);
    expect(grown!.outW).toBeGreaterThan(0);
    expect(grown!.inputs).toContain(S.thirst);
    expect(b.considerGrowth(0.8, M.eat, 1010)).toBeNull();
    expect(skillName({ inputs: grown!.inputs, motor: grown!.motor, sign: 1 })).toMatch(/Drink$/);
    expect(skillSentence({ inputs: [S.thirst], motor: M.drink, sign: -1 })).toBe('When thirsty: do not drink.');
  });

  it('writes useful grown neurons into a child genome as instincts, and the child is born with them', () => {
    const mother = brain('mother');
    const father = brain('father');
    mother.grow({ ...spec(M.drink), utility: 1 });
    mother.grow({ ...spec(M.eat), utility: -1 });
    father.grow({ ...spec(M.rest, -1), inputs: [S.pain, S.fatigue], utility: 0.9 });
    const genes = inheritInstincts(mother, father, new Rng('heir'));
    expect(genes.length % INSTINCT_STRIDE).toBe(0);
    const instincts = decodeInstincts(genes);
    expect(instincts.map((g) => g.motor).sort()).toEqual([M.drink, M.rest].sort());
    expect(instincts.every((g) => g.generations === 1 && g.born === -1)).toBe(true);
    const genome = randomGenome(new Rng('child'), 0);
    genome.instincts = genes;
    const child = new Brain(genome);
    expect(child.grown.length).toBe(instincts.length);
  });

  it('a world with grown neurons saves and continues identically', () => {
    const world = new World({ ...DEFAULT_WORLD_OPTIONS, seed: 'neuro-save', initialPredators: 0 });
    for (let t = 0; t < 4000; t++) world.step();
    const grown = world.humans.reduce((n, h) => n + h.brain.grown.length, 0);
    expect(grown).toBeGreaterThan(0);
    const copy = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
    for (let t = 0; t < 600; t++) {
      world.step();
      copy.step();
    }
    const sig = (w: World) => w.humans.map((h) => `${h.id}:${h.x.toFixed(4)}:${h.brain.grown.length}:${h.brain.synCount}`).join('|');
    expect(sig(copy)).toBe(sig(world));
    expect(copy.skills.size).toBe(world.skills.size);
  });
});
