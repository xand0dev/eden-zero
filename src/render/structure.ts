import { Container, Graphics } from 'pixi.js';

/**
 * Procedural roundhouse.
 *
 * Drawn entirely from primitives created inside this repository — no external or
 * copyrighted assets. Seen like everything else: from above and slightly in
 * front, lit from the north-west. A structure passes through three states the
 * observer can watch:
 *
 *   1. staked out  — a ring of stakes on trampled ground
 *   2. rising      — a wattle wall that climbs with every load of timber, a
 *                    woodpile beside it
 *   3. finished    — a conical thatched roof, a door, a hearth glow and smoke
 */

const GROUND = 0x7a6448;
const STAKE = 0x5a3e22;
const WATTLE = 0x8a6a42;
const WATTLE_DARK = 0x5e4428;
const THATCH = 0xc79b58;
const THATCH_LIGHT = 0xe8c888;
const THATCH_DARK = 0x7e5a2e;
const DOOR = 0x22160c;
const GLOW = 0xffb45e;
const LINE = 0x1c130a;

export class StructureSprite extends Container {
  private readonly shadow = new Graphics();
  private readonly base = new Graphics();
  private readonly hut = new Graphics();
  private readonly glow = new Graphics();
  private readonly smoke = new Graphics();
  private readonly pulseRing = new Graphics();

  /** Footprint radius in world tiles: a hut is about three people across. */
  private readonly radius = 1.45;
  private readonly variant: number;
  private lastProgress = -1;
  private lastComplete = false;
  private clock = 0;

  constructor(seedPhase: number) {
    super();
    this.variant = seedPhase % 1;
    this.addChild(this.shadow, this.base, this.hut, this.glow, this.smoke, this.pulseRing);
  }

  /**
   * @param progress  0..1 of the timber delivered
   * @param complete  true once the hut is finished
   * @param pulse     0..1 animation phase while timber is actively being laid
   */
  update(progress: number, complete: boolean, pulse: number): void {
    this.pulseRing.clear();
    if (pulse > 0) {
      this.pulseRing
        .ellipse(0, 0.3, this.radius + 0.4 + pulse * 0.6, (this.radius + 0.4 + pulse * 0.6) * 0.45)
        .stroke({ color: THATCH_LIGHT, width: 0.08, alpha: (1 - pulse) * 0.7 });
    }
    if (progress === this.lastProgress && complete === this.lastComplete) return;
    this.lastProgress = progress;
    this.lastComplete = complete;
    const R = this.radius;

    // Trampled ground and the shadow a finished roof casts to the south-east.
    this.shadow.clear();
    this.base.clear();
    this.base.ellipse(0, 0.25, R + 0.55, (R + 0.55) * 0.62).fill({ color: GROUND, alpha: 0.55 });
    this.base.ellipse(0, 0.25, R + 0.2, (R + 0.2) * 0.6).fill({ color: GROUND, alpha: 0.5 });
    if (complete) this.shadow.ellipse(0.55, 0.65, R * 1.2, R * 0.62).fill({ color: 0x08100a, alpha: 0.32 });

    const g = this.hut.clear();
    if (complete) {
      this.drawRoundhouse(g, R);
    } else {
      this.drawConstruction(g, R, progress);
    }

    this.glow.clear();
    if (complete) {
      this.glow.ellipse(0, R * 0.62, 0.9, 0.42).fill({ color: GLOW, alpha: 0.14 });
      this.glow.ellipse(0, R * 0.55, 0.45, 0.22).fill({ color: GLOW, alpha: 0.22 });
    }
  }

  /** Smoke from the roof: a slow, looping wisp. Call every frame. */
  animate(dt: number): void {
    if (!this.lastComplete) {
      if (this.smoke.visible) this.smoke.clear();
      this.smoke.visible = false;
      return;
    }
    this.smoke.visible = true;
    this.clock += dt;
    const g = this.smoke.clear();
    for (let i = 0; i < 4; i++) {
      const t = ((this.clock * 0.35 + i / 4 + this.variant) % 1 + 1) % 1;
      const x = -0.15 + Math.sin(t * 5 + i) * 0.18 + t * 0.6;
      const y = -this.radius * 1.15 - t * 1.6;
      g.circle(x, y, 0.16 + t * 0.32).fill({ color: 0xd8dde0, alpha: 0.28 * (1 - t) });
    }
  }

  private drawRoundhouse(g: Graphics, R: number): void {
    // Wall band: the part of the drum visible below the eaves at the front.
    g.ellipse(0, 0.35, R * 0.92, R * 0.52).fill(WATTLE_DARK);
    g.rect(-R * 0.92, -0.05, R * 1.84, 0.4).fill(WATTLE);
    g.ellipse(0, 0.35, R * 0.92, R * 0.52).stroke({ color: LINE, width: 0.05, alpha: 0.6 });
    // Wattle weave on the wall band.
    for (let i = -4; i <= 4; i++) {
      const x = (i / 4.6) * R * 0.88;
      g.moveTo(x, 0.1).lineTo(x, 0.35 + Math.sqrt(Math.max(0, 1 - (x / (R * 0.92)) ** 2)) * R * 0.5).stroke({
        color: WATTLE_DARK,
        width: 0.05,
        alpha: 0.7,
      });
    }
    // Door, facing the observer.
    g.roundRect(-0.28, 0.25, 0.56, 0.62, 0.22).fill(DOOR);
    g.roundRect(-0.2, 0.33, 0.4, 0.5, 0.18).fill({ color: GLOW, alpha: 0.18 });

    // Conical thatched roof: the apex sits north of centre, as a cone does seen
    // from above and in front.
    const apexX = -0.05;
    const apexY = -R * 1.05;
    const eave = { cx: 0, cy: 0, rx: R * 1.12, ry: R * 0.62 };
    // Roof silhouette: eave ellipse plus the cone up to the apex.
    const pts: number[] = [];
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI; // front half of the eave
      pts.push(eave.cx + Math.cos(a) * eave.rx, eave.cy + Math.sin(a) * eave.ry);
    }
    pts.push(apexX, apexY);
    g.poly(pts).fill(THATCH).stroke({ color: LINE, width: 0.06, alpha: 0.65, join: 'round' });
    // Shade the east flank, light the west.
    const east: number[] = [apexX, apexY];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * (Math.PI / 2);
      east.push(Math.cos(a) * eave.rx, Math.sin(a) * eave.ry);
    }
    g.poly(east).fill({ color: THATCH_DARK, alpha: 0.5 });
    const west: number[] = [apexX, apexY];
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI - (i / 14) * (Math.PI / 3);
      west.push(Math.cos(a) * eave.rx * 0.95, Math.sin(a) * eave.ry * 0.9);
    }
    g.poly(west).fill({ color: THATCH_LIGHT, alpha: 0.35 });
    // Straw: strokes running from the apex down to the eave.
    for (let i = 1; i < 22; i++) {
      const a = (i / 22) * Math.PI;
      const ex = Math.cos(a) * eave.rx;
      const ey = Math.sin(a) * eave.ry;
      g.moveTo(apexX + (ex - apexX) * 0.15, apexY + (ey - apexY) * 0.15)
        .lineTo(ex * 0.98, ey * 0.98)
        .stroke({ color: i % 2 ? THATCH_DARK : THATCH_LIGHT, width: 0.03, alpha: 0.35 });
    }
    // A binding ring near the top and the ragged eave edge.
    g.ellipse(apexX * 0.8, apexY * 0.72, R * 0.32, R * 0.14).stroke({ color: THATCH_DARK, width: 0.07, alpha: 0.7 });
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI;
      g.circle(Math.cos(a) * eave.rx, Math.sin(a) * eave.ry, 0.07).fill({ color: THATCH_DARK, alpha: 0.6 });
    }
    // Smoke hole.
    g.circle(apexX, apexY + 0.12, 0.1).fill(0x2a1c10);
  }

  private drawConstruction(g: Graphics, R: number, progress: number): void {
    const posts = 12;
    const rise = Math.min(1, Math.max(0, (progress - 0.12) / 0.88));
    // Floor.
    g.ellipse(0, 0.2, R * 0.92, R * 0.52).fill({ color: 0x5e4a32, alpha: 0.7 });
    // Back half of the wall first, then the front, so the ring has depth.
    for (const front of [false, true]) {
      for (let i = 0; i < posts; i++) {
        const a = (i / posts) * Math.PI * 2;
        const isFront = Math.sin(a) > 0;
        if (isFront !== front) continue;
        const x = Math.cos(a) * R * 0.92;
        const y = 0.2 + Math.sin(a) * R * 0.52;
        const height = 0.35 + rise * 0.75;
        if (rise > 0) {
          // Wattle between this post and the next, as high as the timber allows.
          const b = ((i + 1) / posts) * Math.PI * 2;
          const x2 = Math.cos(b) * R * 0.92;
          const y2 = 0.2 + Math.sin(b) * R * 0.52;
          g.poly([x, y, x2, y2, x2, y2 - height * 0.85, x, y - height * 0.85]).fill(front ? WATTLE : WATTLE_DARK).stroke({
            color: LINE,
            width: 0.03,
            alpha: 0.35,
          });
        }
        g.rect(x - 0.06, y - height, 0.12, height).fill(STAKE);
      }
    }
    // A woodpile waiting to be used, shrinking as the walls rise.
    const logs = Math.max(1, Math.round((1 - rise) * 4));
    for (let i = 0; i < logs; i++) {
      const y = R * 0.9 + 0.2 - i * 0.12;
      g.roundRect(R * 0.8, y, 0.9, 0.16, 0.08).fill(0x8a5e32).stroke({ color: LINE, width: 0.025, alpha: 0.6 });
      g.circle(R * 0.8 + 0.9, y + 0.08, 0.08).fill(0xd8a868);
    }
  }
}
