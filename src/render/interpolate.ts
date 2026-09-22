/**
 * Snapshot interpolation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Snapshots arrive at 20 Hz; the renderer draws at 60 fps. Snapping sprites to
 * whatever the last snapshot said therefore shows every entity moving in three
 * discrete jumps per frame budget — visibly steppy, and worse the slower the
 * snapshot rate gets.
 *
 * The fix is to render *between* the last two snapshots: keep the previous and
 * current entity positions and draw at a fraction `alpha` of the way from one to
 * the other, where `alpha` is how far through the snapshot interval we currently
 * are.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not extrapolate. `alpha` is clamped to 1, so if a snapshot is late the
 * world pauses at the last known state rather than guessing where things went.
 * Extrapolation is prediction, and prediction is a claim about the future that
 * this project has no business making in observer mode — an observer controls
 * nothing, so there is nothing to predict, and a wrong guess would be a lie the
 * UI tells.
 *
 * All of this is pure so it can be tested without a canvas.
 */

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

/**
 * Shortest signed rotation from `from` to `to`.
 *
 * Turning from 3.0 rad to -3.0 rad is 0.28 rad the short way, not 6.0 rad the
 * long way. Interpolating raw headings makes an entity spin most of the way round
 * whenever it crosses the wrap point, which is very visible.
 */
export function shortestAngleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * How far through the current snapshot interval we are, in 0..1.
 *
 * Returns 1 when no interval is known yet (first frame) or when a snapshot is
 * overdue, so callers never extrapolate.
 */
export function snapshotAlpha(elapsedMs: number, intervalMs: number): number {
  if (!(intervalMs > 0)) return 1;
  const alpha = elapsedMs / intervalMs;
  if (!Number.isFinite(alpha) || alpha <= 0) return 0;
  return alpha > 1 ? 1 : alpha;
}

/**
 * Smooth the measured snapshot interval.
 *
 * The real gap between snapshots jitters with scheduler noise and with the speed
 * setting, so a raw reading makes the animation speed wobble. A short exponential
 * average tracks genuine changes without amplifying noise.
 */
export function smoothInterval(previousMs: number, measuredMs: number, weight = 0.2): number {
  if (!(measuredMs > 0) || !Number.isFinite(measuredMs)) return previousMs;
  // Ignore absurd gaps (a tab that was backgrounded, a reconnection).
  if (measuredMs > 1000) return previousMs;
  return previousMs <= 0 ? measuredMs : previousMs * (1 - weight) + measuredMs * weight;
}

export interface InterpolatedPose {
  x: number;
  y: number;
  heading: number;
}

/**
 * Pose of an entity `alpha` of the way from its previous to its current state.
 *
 * When there is no previous sample — a newborn, or the first frame after a
 * connection — the current state is used unchanged. Inventing a start position
 * would make new arrivals fly in from nowhere.
 */
export function interpolatePose(
  previous: { x: number; y: number; heading: number } | undefined,
  current: { x: number; y: number; heading: number },
  alpha: number,
): InterpolatedPose {
  if (!previous) return { x: current.x, y: current.y, heading: current.heading };
  const t = alpha <= 0 ? 0 : alpha > 1 ? 1 : alpha;
  return {
    x: previous.x + (current.x - previous.x) * t,
    y: previous.y + (current.y - previous.y) * t,
    heading: previous.heading + shortestAngleDelta(previous.heading, current.heading) * t,
  };
}
