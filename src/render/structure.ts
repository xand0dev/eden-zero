import { Container, Graphics } from 'pixi.js';

/**
 * Procedural hut sprite.
 *
 * Drawn entirely from primitives created inside this repository — no external or
 * copyrighted assets. A structure passes through three visual states:
 *
 *   1. staked out  — four corner posts and a faint footprint
 *   2. framed      — posts, a partial wall ring, and a floor, with a progress arc
 *   3. finished    — walls, a thatched roof, a door, and a warm hearth glow
 *
 * The intermediate states matter: the whole point of construction is that the
 * observer can watch the village being built rather than find it already there.
 */

const POST = 0x6b4f2a;
const WALL = 0x8a6a3d;
const WALL_DARK = 0x6d5230;
const ROOF = 0xb08148;
const ROOF_DARK = 0x8a6335;
const FLOOR = 0x5a452a;
const GLOW = 0xffb45e;

export class StructureSprite extends Container {
  private readonly ground = new Graphics();
  private readonly frame = new Graphics();
  private readonly walls = new Graphics();
  private readonly roof = new Graphics();
  private readonly hearth = new Graphics();
  private readonly progress = new Graphics();

  /** Footprint half-width in world tiles. */
  private readonly half: number;

  private lastProgress = -1;
  private lastComplete = false;

  constructor(seedPhase: number) {
    super();
    // Deliberately larger than life. A human occupies well under one tile, and at
    // the default zoom a true-scale hut is a smudge — the whole point of
    // construction is that the observer can see the village grow.
    this.half = 1.5;
    this.ground.ellipse(0, 0.5, 1.95, 1.05).fill({ color: FLOOR, alpha: 0.55 });
    this.addChild(this.ground, this.frame, this.walls, this.roof, this.hearth, this.progress);
    // A little variation between huts so a village does not look stamped out.
    this.rotation = (seedPhase % 1) * Math.PI * 2;
  }

  /**
   * @param progress  0..1 of the timber delivered
   * @param complete  true once the hut is finished
   * @param pulse     0..1 animation phase while timber is actively being laid
   */
  update(progress: number, complete: boolean, pulse: number): void {
    if (progress === this.lastProgress && complete === this.lastComplete && pulse <= 0) return;
    this.lastProgress = progress;
    this.lastComplete = complete;

    const half = this.half;

    // --- frame: corner posts, always present once staked out -----------------
    this.frame.clear();
    const corners: Array<[number, number]> = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ];
    for (const [cx, cy] of corners) {
      this.frame.rect(cx - 0.15, cy - 0.15, 0.3, 0.3).fill({ color: POST });
    }

    // --- walls: grow with progress ------------------------------------------
    this.walls.clear();
    if (progress > 0.12) {
      // The wall ring fills in as timber arrives, so the hut visibly rises.
      const rise = Math.min(1, progress / 0.85);
      const height = 0.36 + rise * 0.66;
      this.walls
        .rect(-half, half - height, half * 2, height)
        .fill({ color: WALL_DARK })
        .rect(-half, -half, half * 2, height * 0.75)
        .fill({ color: WALL });
    }

    // --- roof: only on completion -------------------------------------------
    this.roof.clear();
    if (complete) {
      this.roof
        .poly([-half - 0.28, -half + 0.1, half + 0.28, -half + 0.1, 0, -half - 0.85])
        .fill({ color: ROOF_DARK })
        .poly([-half - 0.18, -half + 0.12, half + 0.18, -half + 0.12, 0, -half - 0.7])
        .fill({ color: ROOF });
      // Door.
      this.roof.rect(-0.3, half - 0.8, 0.6, 0.8).fill({ color: 0x2f2318 });
    }

    // --- hearth glow: finished huts look lived in ---------------------------
    this.hearth.clear();
    if (complete) {
      this.hearth.circle(0, half - 0.25, 0.75).fill({ color: GLOW, alpha: 0.12 });
      this.hearth.circle(0, half - 0.25, 0.38).fill({ color: GLOW, alpha: 0.2 });
    }

    // --- progress arc: only while under construction ------------------------
    this.progress.clear();
    if (!complete && progress > 0) {
      const radius = half + 0.7;
      const steps = 18;
      const sweep = progress * Math.PI * 2;
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * sweep;
        const x = Math.cos(t - Math.PI / 2) * radius;
        const y = Math.sin(t - Math.PI / 2) * radius;
        this.progress.circle(x, y, 0.1).fill({ color: ROOF, alpha: 0.75 });
      }
    }

    // A finished hut is drawn a touch larger so the village reads at a glance.
    this.scale.set(complete ? 1 : 0.92 + progress * 0.08);
    if (pulse > 0) {
      this.hearth.circle(0, 0, 1.1 + pulse * 0.5).stroke({ color: ROOF, width: 0.1, alpha: (1 - pulse) * 0.6 });
    }
  }
}
