import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_OPTIONS, World } from '../src/simulation/world';
import { Rng } from '../src/simulation/rng';
import type { WorldOptions } from '../src/simulation/world';

function makeWorld(seed: string, overrides: Partial<WorldOptions> = {}): World {
  return new World({ ...DEFAULT_WORLD_OPTIONS, seed, ...overrides });
}

/**
 * A stable fingerprint of the entire simulation state.
 *
 * Includes the PRNG state, every entity's position and physiology, the learned
 * weights (sampled) and the environment clock. If two worlds produce the same
 * hash after the same number of ticks, they are genuinely identical — not just
 * superficially similar.
 */
export function fingerprint(world: World): string {
  const parts: string[] = [];
  parts.push(`tick:${world.tick}`);
  parts.push(`time:${world.simTime.toFixed(6)}`);
  parts.push(`rng:${world.rng.getState().join(',')}`);
  parts.push(`climate:${world.climate.dayPhase.toFixed(6)},${world.climate.globalOffset}`);

  for (const human of world.humans) {
    parts.push(
      [
        'H',
        human.id,
        human.name,
        human.x.toFixed(5),
        human.y.toFixed(5),
        human.heading.toFixed(5),
        human.ageBio.toFixed(6),
        human.health.toFixed(4),
        human.hunger.toFixed(4),
        human.thirst.toFixed(4),
        human.energy.toFixed(4),
        human.fatigue.toFixed(4),
        human.actionIndex,
        human.memory.size,
        human.pregnancy ? human.pregnancy.progress.toFixed(5) : '-',
        // A few learned weights, so plasticity is covered by the fingerprint.
        human.brain.w[0]?.toFixed(6) ?? '-',
        human.brain.w[100]?.toFixed(6) ?? '-',
        human.brain.w[human.brain.synCount - 1]?.toFixed(6) ?? '-',
      ].join('|'),
    );
  }

  for (const predator of world.predators) {
    parts.push(
      ['P', predator.id, predator.x.toFixed(5), predator.y.toFixed(5), predator.health.toFixed(4)].join('|'),
    );
  }

  for (const plant of world.plants.slice(0, 400)) {
    parts.push(['F', plant.id, plant.x.toFixed(3), plant.y.toFixed(3), plant.food.toFixed(4)].join('|'));
  }
  parts.push(`plantCount:${world.plants.length}`);
  parts.push(`events:${world.events.length}`);
  return parts.join('\n');
}

describe('determinism', () => {
  it('produces identical state for the same seed after N ticks', () => {
    const a = makeWorld('determinism-seed');
    const b = makeWorld('determinism-seed');
    for (let i = 0; i < 600; i++) {
      a.step();
      b.step();
    }
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('produces different state for different seeds', () => {
    const a = makeWorld('seed-alpha');
    const b = makeWorld('seed-beta');
    for (let i = 0; i < 200; i++) {
      a.step();
      b.step();
    }
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });

  it('does not depend on wall-clock time', () => {
    // If any wall-clock time leaked into the simulation, sleeping between ticks
    // would change the outcome. It must not.
    const a = makeWorld('wallclock');
    const b = makeWorld('wallclock');
    for (let i = 0; i < 120; i++) a.step();
    for (let i = 0; i < 120; i++) {
      b.step();
      // Busy-wait a fraction of a millisecond to advance wall-clock time.
      const until = performance.now() + 0.2;
      while (performance.now() < until) {
        /* spin */
      }
    }
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('keeps the PRNG deterministic across instances', () => {
    const a = new Rng('shared');
    const b = new Rng('shared');
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < 50; i++) {
      left.push(a.next());
      right.push(b.next());
    }
    expect(right).toEqual(left);
  });

  it('preserves determinism after a save/load round trip', () => {
    const original = makeWorld('roundtrip');
    for (let i = 0; i < 300; i++) original.step();

    const snapshot = JSON.parse(JSON.stringify(original.serialize()));
    const restored = World.deserialize(snapshot);

    for (let i = 0; i < 200; i++) {
      original.step();
      restored.step();
    }
    expect(fingerprint(restored)).toBe(fingerprint(original));
  });
});
