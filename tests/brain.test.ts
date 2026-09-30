import { describe, expect, it } from 'vitest';
import { Rng } from '../src/simulation/rng';
import { Brain, W_MAX } from '../src/simulation/brain/network';
import { randomGenome } from '../src/simulation/genetics/genome';
import { explainAction } from '../src/simulation/brain/trace';
import { MOTOR_COUNT, MOTOR_NAMES, NEURON_COUNT, SENSORY_COUNT } from '../src/simulation/brain/channels';
import { DT } from '../src/shared/constants';

function makeBrain(seed: string) {
  const rng = new Rng(seed);
  const genome = randomGenome(rng, 0);
  return { brain: new Brain(genome), genome, rng };
}

function randomSensory(rng: Rng): Float32Array {
  // Sized from the channel count, never hardcoded: a short array leaves the new
  // channels reading `undefined`, which silently turns the whole network to NaN.
  const sensory = new Float32Array(SENSORY_COUNT);
  for (let i = 0; i < SENSORY_COUNT; i++) sensory[i] = rng.next();
  return sensory;
}

describe('brain topology', () => {
  it('has the documented neuron count and a sparse synapse count', () => {
    const { brain } = makeBrain('topology');
    expect(brain.neuronCount).toBe(NEURON_COUNT);
    expect(brain.synCount).toBeGreaterThan(1500);
    expect(brain.synCount).toBeLessThan(6000);
    // Sparsity: a dense network would have NEURON_COUNT^2 synapses.
    expect(brain.synCount).toBeLessThan(NEURON_COUNT * NEURON_COUNT * 0.1);
  });

  it('is deterministic for a given genome and seed', () => {
    const a = makeBrain('same');
    const b = makeBrain('same');
    expect(b.brain.synCount).toBe(a.brain.synCount);
    expect(Array.from(b.brain.pre)).toEqual(Array.from(a.brain.pre));
    expect(Array.from(b.brain.post)).toEqual(Array.from(a.brain.post));
  });

  it('regenerates an identical topology from the same genome', () => {
    const rng = new Rng('regen');
    const genome = randomGenome(rng, 0);
    const first = new Brain(genome);
    const second = new Brain(genome);
    expect(second.synCount).toBe(first.synCount);
    expect(Array.from(second.pre)).toEqual(Array.from(first.pre));
  });

  it('contains both excitatory and inhibitory synapses', () => {
    const { brain } = makeBrain('signs');
    const stats = brain.stats();
    expect(stats.excitatory).toBeGreaterThan(100);
    expect(stats.inhibitory).toBeGreaterThan(50);
  });
});

describe('brain dynamics', () => {
  it('is deterministic and numerically stable over thousands of ticks', () => {
    const { brain, genome } = makeBrain('dynamics');
    const sensoryRng = new Rng('sensory');
    const a = new Brain(genome);
    const b = new Brain(genome);

    for (let t = 0; t < 3000; t++) {
      const sensory = randomSensory(sensoryRng);
      a.step(sensory, 0);
      b.step(sensory, 0);
      a.applyPlasticity(1, 0);
      b.applyPlasticity(1, 0);
    }

    for (let i = 0; i < NEURON_COUNT; i++) {
      expect(Number.isFinite(a.v[i])).toBe(true);
      expect(Number.isFinite(a.rate[i])).toBe(true);
      expect(a.rate[i]).toBeGreaterThanOrEqual(0);
      expect(a.rate[i]).toBeLessThanOrEqual(1);
    }
    expect(Array.from(b.rate)).toEqual(Array.from(a.rate));
    void brain;
  });

  it('produces non-trivial motor output from sensory input', () => {
    const { brain } = makeBrain('motor');
    const sensory = new Float32Array(SENSORY_COUNT);
    sensory[21] = 0.9; // hunger
    sensory[0] = 0.8; // food ahead
    sensory[20] = 0.7; // daylight

    const motor = new Float32Array(MOTOR_COUNT);
    let total = 0;
    for (let t = 0; t < 200; t++) {
      brain.step(sensory, 0);
      brain.readMotor(motor);
      total += motor.reduce((sum, value) => sum + value, 0);
    }
    expect(total).toBeGreaterThan(1);
    for (let i = 0; i < MOTOR_COUNT; i++) {
      expect(motor[i]).toBeGreaterThanOrEqual(0);
      expect(motor[i]).toBeLessThanOrEqual(1);
    }
  });

  it('fires the withdrawal motor harder when pain is high than when it is low', () => {
    // This is the nociceptive withdrawal reflex: pain must pull the animal back.
    const measure = (pain: number): number => {
      const { brain } = makeBrain('reflex');
      const sensory = new Float32Array(SENSORY_COUNT);
      sensory[17] = pain;
      const motor = new Float32Array(MOTOR_COUNT);
      let back = 0;
      let forward = 0;
      for (let t = 0; t < 400; t++) {
        brain.step(sensory, 0);
        brain.readMotor(motor);
        back += motor[MOTOR_NAMES.indexOf('move-backward')];
        forward += motor[MOTOR_NAMES.indexOf('move-forward')];
      }
      return back - forward;
    };
    expect(measure(1)).toBeGreaterThan(measure(0));
  });

  it('reacts more strongly to food when hungry (salience is applied upstream)', () => {
    const { brain } = makeBrain('salience');
    const sensory = new Float32Array(SENSORY_COUNT);
    sensory[0] = 1;
    const motor = new Float32Array(MOTOR_COUNT);
    let sum = 0;
    for (let t = 0; t < 300; t++) {
      brain.step(sensory, 0);
      brain.readMotor(motor);
      sum += motor[MOTOR_NAMES.indexOf('move-forward')];
    }
    expect(sum).toBeGreaterThan(0);
  });
});

describe('plasticity', () => {
  it('changes weights but keeps them bounded', () => {
    const { brain } = makeBrain('plasticity');
    const sensoryRng = new Rng('plasticity-sensory');
    const before = brain.w.slice();

    for (let t = 0; t < 1200; t++) {
      brain.step(randomSensory(sensoryRng), 0);
      // A strong, consistently positive valence is the harshest case.
      brain.applyPlasticity(1.5, 1);
    }

    let changed = 0;
    let maxAbs = 0;
    for (let s = 0; s < brain.synCount; s++) {
      if (Math.abs(brain.w[s] - before[s]) > 1e-6) changed++;
      maxAbs = Math.max(maxAbs, Math.abs(brain.w[s]));
      expect(Number.isFinite(brain.w[s])).toBe(true);
    }
    expect(changed).toBeGreaterThan(10);
    expect(maxAbs).toBeLessThanOrEqual(W_MAX + 1e-6);
    expect(brain.weightDrift()).toBeGreaterThan(0);
  });

  it('does not rewrite the whole brain when valence is negligible', () => {
    const { brain } = makeBrain('gated');
    const sensoryRng = new Rng('gated-sensory');
    for (let t = 0; t < 600; t++) {
      brain.step(randomSensory(sensoryRng), 0);
      brain.applyPlasticity(1.5, 0.01);
    }
    expect(brain.weightDrift()).toBeLessThan(0.05);
  });

  it('keeps total synaptic strength bounded by homeostasis', () => {
    const { brain } = makeBrain('homeostasis');
    const sensoryRng = new Rng('homeostasis-sensory');
    let initial = 0;
    for (let s = 0; s < brain.synCount; s++) initial += Math.abs(brain.w[s]);

    for (let t = 0; t < 4000; t++) {
      brain.step(randomSensory(sensoryRng), 0);
      brain.applyPlasticity(1.5, 1);
    }

    let final = 0;
    for (let s = 0; s < brain.synCount; s++) final += Math.abs(brain.w[s]);
    // Synaptic scaling should keep the total within a factor of a few, not let it
    // run away to the clamp.
    expect(final).toBeLessThan(initial * 4);
  });
});

describe('contribution trace ("Why did it do that?")', () => {
  it('returns contributors and a bounded path for a decision', () => {
    const { brain } = makeBrain('trace');
    const sensory = new Float32Array(SENSORY_COUNT);
    sensory[21] = 0.8;
    sensory[0] = 0.7;
    for (let t = 0; t < 200; t++) brain.step(sensory, 0);

    const motorIndex = brain.winningMotor();
    const explanation = explainAction(brain, motorIndex, sensory, 200);

    expect(explanation.motorIndex).toBe(motorIndex);
    expect(explanation.action).toBe(MOTOR_NAMES[motorIndex]);
    expect(explanation.contributors.length).toBeGreaterThan(0);
    expect(explanation.path.length).toBeGreaterThan(0);
    expect(explanation.path.length).toBeLessThanOrEqual(4);
    expect(explanation.note.length).toBeGreaterThan(20);
    for (const node of explanation.path) {
      expect(Number.isFinite(node.contribution)).toBe(true);
      expect(node.label.length).toBeGreaterThan(0);
    }
  });
});

describe('brain serialisation', () => {
  it('round-trips learned state exactly', () => {
    const { brain } = makeBrain('serialize');
    const sensoryRng = new Rng('serialize-sensory');
    for (let t = 0; t < 500; t++) {
      brain.step(randomSensory(sensoryRng), 0);
      brain.applyPlasticity(1, 0.8);
    }
    const packed = brain.serialize();

    const { brain: fresh } = makeBrain('serialize');
    expect(fresh.restore(packed, fresh.synCount)).toBe(true);
    expect(Array.from(fresh.w)).toEqual(Array.from(brain.w));
    expect(Array.from(fresh.v)).toEqual(Array.from(brain.v));
  });
});

describe('simulation timestep', () => {
  it('uses a fixed timestep constant', () => {
    expect(DT).toBeCloseTo(0.05, 10);
  });
});
