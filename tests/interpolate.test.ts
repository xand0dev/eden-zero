import { describe, expect, it } from 'vitest';
import {
  interpolatePose,
  shortestAngleDelta,
  smoothInterval,
  snapshotAlpha,
  wrapAngle,
} from '../src/render/interpolate';

/**
 * Snapshot interpolation is what makes a 20 Hz world look smooth at 60 fps. It is
 * pure arithmetic, so it is tested directly rather than by squinting at motion.
 */

describe('angle handling', () => {
  it('wraps into (-PI, PI]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0, 6);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(Math.PI * 2 + 0.5)).toBeCloseTo(0.5, 6);
  });

  it('takes the short way round the wrap point', () => {
    // From 3.0 to -3.0 is 0.28 rad forwards, not 6.0 rad backwards.
    const delta = shortestAngleDelta(3.0, -3.0);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeCloseTo(2 * Math.PI - 6.0, 6);
  });

  it('is negative when turning the other way', () => {
    expect(shortestAngleDelta(-3.0, 3.0)).toBeLessThan(0);
  });
});

describe('snapshot alpha', () => {
  it('is the fraction through the interval', () => {
    expect(snapshotAlpha(0, 50)).toBeCloseTo(0, 6);
    expect(snapshotAlpha(25, 50)).toBeCloseTo(0.5, 6);
    expect(snapshotAlpha(50, 50)).toBeCloseTo(1, 6);
  });

  it('never extrapolates past the last snapshot', () => {
    // This is the important property: a late snapshot must pause the world, not
    // make it guess where things went.
    expect(snapshotAlpha(500, 50)).toBe(1);
    expect(snapshotAlpha(9999, 50)).toBe(1);
  });

  it('falls back to 1 when no interval is known yet', () => {
    expect(snapshotAlpha(10, 0)).toBe(1);
    expect(snapshotAlpha(10, -5)).toBe(1);
  });

  it('clamps a negative or non-finite elapsed time to 0', () => {
    expect(snapshotAlpha(-10, 50)).toBe(0);
    expect(snapshotAlpha(Number.NaN, 50)).toBe(0);
  });
});

describe('interval smoothing', () => {
  it('adopts the first measurement', () => {
    expect(smoothInterval(0, 50)).toBe(50);
  });

  it('moves gradually toward a new measurement', () => {
    const next = smoothInterval(50, 100, 0.2);
    expect(next).toBeCloseTo(60, 6);
  });

  it('ignores absurd gaps from a backgrounded tab or a reconnect', () => {
    expect(smoothInterval(50, 30_000)).toBe(50);
    expect(smoothInterval(50, Number.NaN)).toBe(50);
    expect(smoothInterval(50, 0)).toBe(50);
  });
});

describe('pose interpolation', () => {
  const from = { x: 0, y: 0, heading: 0 };
  const to = { x: 10, y: 20, heading: 1 };

  it('returns the start at alpha 0 and the end at alpha 1', () => {
    expect(interpolatePose(from, to, 0)).toEqual({ x: 0, y: 0, heading: 0 });
    const end = interpolatePose(from, to, 1);
    expect(end.x).toBeCloseTo(10, 6);
    expect(end.y).toBeCloseTo(20, 6);
    expect(end.heading).toBeCloseTo(1, 6);
  });

  it('interpolates the midpoint', () => {
    const mid = interpolatePose(from, to, 0.5);
    expect(mid.x).toBeCloseTo(5, 6);
    expect(mid.y).toBeCloseTo(10, 6);
    expect(mid.heading).toBeCloseTo(0.5, 6);
  });

  it('uses the current pose unchanged when there is no previous sample', () => {
    // A newborn must not fly in from the origin.
    expect(interpolatePose(undefined, to, 0.3)).toEqual({ x: 10, y: 20, heading: 1 });
  });

  it('turns the short way when the heading crosses the wrap point', () => {
    const a = { x: 0, y: 0, heading: 3.0 };
    const b = { x: 0, y: 0, heading: -3.0 };
    const mid = interpolatePose(a, b, 0.5);
    // Halfway should be just past PI, not back at 0.
    expect(Math.abs(mid.heading)).toBeGreaterThan(3.0);
  });

  it('clamps an out-of-range alpha instead of extrapolating', () => {
    const over = interpolatePose(from, to, 4);
    expect(over.x).toBeCloseTo(10, 6);
    const under = interpolatePose(from, to, -3);
    expect(under.x).toBeCloseTo(0, 6);
  });
});
