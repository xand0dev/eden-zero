import { Container, Graphics } from 'pixi.js';
import { OUTLINE_WIDTH, SHADOW_ALPHA, SHADOW_COLOR, STRUCTURE_COLORS, outlineOf } from './style';

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

// Colours come from the shared palette so a hut is made of the same materials
// as the fields, the canals and the trees around it.
const POST = STRUCTURE_COLORS.post;
const WALL = STRUCTURE_COLORS.wall;
const WALL_DARK = STRUCTURE_COLORS.wallDark;
const ROOF = STRUCTURE_COLORS.roof;
const ROOF_DARK = STRUCTURE_COLORS.roofDark;
const FLOOR = STRUCTURE_COLORS.floor;
const GLOW = STRUCTURE_COLORS.glow;

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
    this.ground.ellipse(0, 0.75, 1.75, 0.8).fill({ color: SHADOW_COLOR, alpha: SHADOW_ALPHA });
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
      this.frame
        .rect(cx - 0.15, cy - 0.15, 0.3, 0.3)
        .fill({ color: POST })
        .stroke({ color: outlineOf(POST), width: OUTLINE_WIDTH });
    }

    // --- walls: grow with progress ------------------------------------------
    this.walls.clear();
    if (progress > 0.12) {
      // The wall ring fills in as timber arrives, so the hut visibly rises —
      // all the way to the eaves. It used to stop at a fixed 1.02 tiles, which
      // on a 3-tile footprint left a gap between the walls and the roof and
      // made a finished hut read as two separate objects.
      const rise = Math.min(1, progress / 0.85);
      const height = 0.4 + rise * (half * 2 - 0.4);
      this.walls
        .rect(-half, half - height, half * 2, height)
        .fill({ color: WALL_DARK })
        .stroke({ color: outlineOf(WALL_DARK), width: OUTLINE_WIDTH })
        .rect(-half, -half, half * 2, height * 0.75)
        .fill({ color: WALL })
        .stroke({ color: outlineOf(WALL), width: OUTLINE_WIDTH });
    }

    // --- roof: only on completion -------------------------------------------
    this.roof.clear();
    if (complete) {
      this.roof
        .poly([-half - 0.28, -half + 0.1, half + 0.28, -half + 0.1, 0, -half - 0.85])
        .fill({ color: ROOF_DARK })
        .stroke({ color: outlineOf(ROOF_DARK), width: OUTLINE_WIDTH })
        .poly([-half - 0.18, -half + 0.12, half + 0.18, -half + 0.12, 0, -half - 0.7])
        .fill({ color: ROOF })
        .stroke({ color: outlineOf(ROOF), width: OUTLINE_WIDTH });
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
