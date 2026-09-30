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
 *
 * Other kinds share the construction stages and finish as themselves: a granary
 * on stilts with its store heaped at the door, a stone-ringed well, an open
 * workshop, a stone house, a length of palisade, a ring of standing stones.
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
const STONE = 0x8c8a84;
const STONE_LIGHT = 0xb8b4aa;
const STONE_DARK = 0x5a5850;
const GRAIN = 0xe0b860;
const WELL_WATER = 0x21465a;

export class StructureSprite extends Container {
  private readonly shadow = new Graphics();
  private readonly base = new Graphics();
  private readonly hut = new Graphics();
  private readonly glow = new Graphics();
  private readonly smoke = new Graphics();
  private readonly pulseRing = new Graphics();

  /** Footprint radius in world tiles: a hut is about three people across. */
  private readonly radius: number;
  private readonly variant: number;
  private readonly kind: number;
  private lastProgress = -1;
  private lastComplete = false;
  private lastStore = -1;
  private clock = 0;
  /** Roof colours, from the builders' people (v3): thatch dyed toward their hue. */
  private thatch = THATCH;
  private thatchLight = THATCH_LIGHT;
  private thatchDark = THATCH_DARK;
  /** The people's colour, for the pennant; null before peoples existed. */
  private banner: number | null = null;
  /** Roof pitch: 1 plain, taller or lower by the people's roof shape. */
  private pitch = 1;

  constructor(seedPhase: number, kind = 0, style?: { hue: number; roof: number }) {
    super();
    this.variant = seedPhase % 1;
    this.kind = kind;
    if (style) {
      const dye = hslToHex(style.hue, 0.5, 0.5);
      this.thatch = mix(THATCH, dye, 0.28);
      this.thatchLight = mix(THATCH_LIGHT, dye, 0.2);
      this.thatchDark = mix(THATCH_DARK, dye, 0.25);
      this.banner = hslToHex(style.hue, 0.7, 0.52);
      this.pitch = [1, 1.3, 0.78][style.roof] ?? 1;
    }
    this.radius = kind === 5 ? 1.1 : kind === 2 ? 0.9 : kind === 3 ? 1.6 : 1.45;
    this.addChild(this.shadow, this.base, this.hut, this.glow, this.smoke, this.pulseRing);
  }

  /** Whether this kind has a hearth: smoke and a night glow. */
  private get hearth(): boolean {
    return this.kind === 0 || this.kind === 4 || this.kind === 6;
  }

  /**
   * @param progress  0..1 of the timber delivered
   * @param complete  true once the hut is finished
   * @param pulse     0..1 animation phase while timber is actively being laid
   */
  update(progress: number, complete: boolean, pulse: number, store = 0): void {
    this.pulseRing.clear();
    if (pulse > 0) {
      this.pulseRing
        .ellipse(0, 0.3, this.radius + 0.4 + pulse * 0.6, (this.radius + 0.4 + pulse * 0.6) * 0.45)
        .stroke({ color: this.thatchLight, width: 0.08, alpha: (1 - pulse) * 0.7 });
    }
    const storeLevel = Math.round(Math.min(1, store / 80) * 6);
    if (progress === this.lastProgress && complete === this.lastComplete && storeLevel === this.lastStore) return;
    this.lastProgress = progress;
    this.lastComplete = complete;
    this.lastStore = storeLevel;
    const R = this.radius;

    // Trampled ground and the shadow a finished roof casts to the south-east.
    this.shadow.clear();
    this.base.clear();
    this.base.ellipse(0, 0.25, R + 0.55, (R + 0.55) * 0.62).fill({ color: GROUND, alpha: 0.55 });
    this.base.ellipse(0, 0.25, R + 0.2, (R + 0.2) * 0.6).fill({ color: GROUND, alpha: 0.5 });
    if (complete) this.shadow.ellipse(0.55, 0.65, R * 1.2, R * 0.62).fill({ color: 0x08100a, alpha: 0.32 });

    const g = this.hut.clear();
    if (complete) {
      switch (this.kind) {
        case 1:
          this.drawGranary(g, R, storeLevel / 6);
          break;
        case 2:
          this.drawWell(g, R);
          break;
        case 3:
          this.drawWorkshop(g, R);
          break;
        case 4:
          this.drawRoundhouse(g, R, true);
          break;
        case 5:
          this.drawPalisade(g, R, 1);
          break;
        case 6:
          this.drawShrine(g, R);
          break;
        default:
          this.drawRoundhouse(g, R);
      }
    } else if (this.kind === 5) {
      this.drawPalisade(g, R, progress);
    } else {
      this.drawConstruction(g, R, progress);
    }

    if (complete && this.banner !== null && (this.kind === 0 || this.kind === 4 || this.kind === 1)) {
      // The people's pennant on a pole beside the door.
      const px = R * 0.95;
      g.moveTo(px, 0.5).lineTo(px, -R * 0.9).stroke({ color: 0x3a2814, width: 0.06 });
      g.poly([px, -R * 0.9, px + 0.55, -R * 0.78, px, -R * 0.64]).fill(this.banner).stroke({ color: LINE, width: 0.03, alpha: 0.5 });
    }

    this.glow.clear();
    if (complete && this.kind === 6) {
      this.glow.ellipse(0, 0.1, 0.8, 0.4).fill({ color: GLOW, alpha: 0.2 });
    } else if (complete && this.hearth) {
      this.glow.ellipse(0, R * 0.62, 0.9, 0.42).fill({ color: GLOW, alpha: 0.14 });
      this.glow.ellipse(0, R * 0.55, 0.45, 0.22).fill({ color: GLOW, alpha: 0.22 });
    }
  }

  /** Smoke from the roof: a slow, looping wisp. Call every frame. */
  animate(dt: number): void {
    if (!this.lastComplete || !this.hearth) {
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

  private drawRoundhouse(g: Graphics, R: number, stone = false): void {
    // Wall band: the part of the drum visible below the eaves at the front.
    g.ellipse(0, 0.35, R * 0.92, R * 0.52).fill(stone ? STONE_DARK : WATTLE_DARK);
    g.rect(-R * 0.92, -0.05, R * 1.84, 0.4).fill(stone ? STONE : WATTLE);
    g.ellipse(0, 0.35, R * 0.92, R * 0.52).stroke({ color: LINE, width: 0.05, alpha: 0.6 });
    if (stone) {
      // Coursed stone: staggered blocks along the wall band.
      for (let row = 0; row < 2; row++) {
        for (let i = -5; i <= 5; i++) {
          const x = (i + (row ? 0.5 : 0)) * (R * 0.17);
          if (Math.abs(x) > R * 0.86) continue;
          const y = 0.02 + row * 0.2 + Math.sqrt(Math.max(0, 1 - (x / (R * 0.92)) ** 2)) * R * 0.28;
          g.roundRect(x - 0.11, y, 0.22, 0.16, 0.04).fill({ color: (i + row) % 2 ? STONE_LIGHT : STONE, alpha: 0.9 });
        }
      }
    } else {
      // Wattle weave on the wall band.
      for (let i = -4; i <= 4; i++) {
        const x = (i / 4.6) * R * 0.88;
        g.moveTo(x, 0.1).lineTo(x, 0.35 + Math.sqrt(Math.max(0, 1 - (x / (R * 0.92)) ** 2)) * R * 0.5).stroke({
          color: WATTLE_DARK,
          width: 0.05,
          alpha: 0.7,
        });
      }
    }
    // Door, facing the observer.
    g.roundRect(-0.28, 0.25, 0.56, 0.62, 0.22).fill(DOOR);
    g.roundRect(-0.2, 0.33, 0.4, 0.5, 0.18).fill({ color: GLOW, alpha: 0.18 });

    // Conical thatched roof: the apex sits north of centre, as a cone does seen
    // from above and in front.
    const apexX = -0.05;
    const apexY = -R * 1.05 * this.pitch;
    const eave = { cx: 0, cy: 0, rx: R * 1.12, ry: R * 0.62 };
    // Roof silhouette: eave ellipse plus the cone up to the apex.
    const pts: number[] = [];
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI; // front half of the eave
      pts.push(eave.cx + Math.cos(a) * eave.rx, eave.cy + Math.sin(a) * eave.ry);
    }
    pts.push(apexX, apexY);
    g.poly(pts).fill(this.thatch).stroke({ color: LINE, width: 0.06, alpha: 0.65, join: 'round' });
    // Shade the east flank, light the west.
    const east: number[] = [apexX, apexY];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * (Math.PI / 2);
      east.push(Math.cos(a) * eave.rx, Math.sin(a) * eave.ry);
    }
    g.poly(east).fill({ color: this.thatchDark, alpha: 0.5 });
    const west: number[] = [apexX, apexY];
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI - (i / 14) * (Math.PI / 3);
      west.push(Math.cos(a) * eave.rx * 0.95, Math.sin(a) * eave.ry * 0.9);
    }
    g.poly(west).fill({ color: this.thatchLight, alpha: 0.35 });
    // Straw: strokes running from the apex down to the eave.
    for (let i = 1; i < 22; i++) {
      const a = (i / 22) * Math.PI;
      const ex = Math.cos(a) * eave.rx;
      const ey = Math.sin(a) * eave.ry;
      g.moveTo(apexX + (ex - apexX) * 0.15, apexY + (ey - apexY) * 0.15)
        .lineTo(ex * 0.98, ey * 0.98)
        .stroke({ color: i % 2 ? this.thatchDark : this.thatchLight, width: 0.03, alpha: 0.35 });
    }
    // A binding ring near the top and the ragged eave edge.
    g.ellipse(apexX * 0.8, apexY * 0.72, R * 0.32, R * 0.14).stroke({ color: this.thatchDark, width: 0.07, alpha: 0.7 });
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI;
      g.circle(Math.cos(a) * eave.rx, Math.sin(a) * eave.ry, 0.07).fill({ color: this.thatchDark, alpha: 0.6 });
    }
    // Smoke hole.
    g.circle(apexX, apexY + 0.12, 0.1).fill(0x2a1c10);
  }

  /** A store raised on stilts against damp and vermin, its harvest heaped at the door. */
  private drawGranary(g: Graphics, R: number, fill: number): void {
    const w = R * 1.5;
    const h = R * 0.8;
    // Stilts.
    for (const x of [-w / 2 + 0.15, w / 2 - 0.15]) {
      for (const y of [0.35, 0.75]) g.rect(x - 0.06, y - 0.2, 0.12, 0.5).fill(STAKE);
    }
    // Body.
    g.rect(-w / 2, -h * 0.35, w, h * 0.75).fill(WATTLE).stroke({ color: LINE, width: 0.05, alpha: 0.6 });
    for (let i = 1; i < 6; i++) g.moveTo(-w / 2 + (w * i) / 6, -h * 0.35).lineTo(-w / 2 + (w * i) / 6, h * 0.4).stroke({ color: WATTLE_DARK, width: 0.04 });
    g.roundRect(-0.22, -0.05, 0.44, 0.45, 0.06).fill(DOOR);
    // Gable roof.
    g.poly([-w / 2 - 0.25, -h * 0.3, 0, -h * 1.35, w / 2 + 0.25, -h * 0.3]).fill(this.thatch).stroke({ color: LINE, width: 0.05, alpha: 0.6 });
    g.poly([0, -h * 1.35, w / 2 + 0.25, -h * 0.3, 0.1, -h * 0.3]).fill({ color: this.thatchDark, alpha: 0.45 });
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      g.moveTo(0, -h * 1.35).lineTo(-w / 2 - 0.25 + (w + 0.5) * t, -h * 0.3).stroke({ color: this.thatchLight, width: 0.03, alpha: 0.35 });
    }
    // The store: sacks and a heap of grain that grows with what is held.
    if (fill > 0) {
      const heap = 0.25 + fill * 0.55;
      g.ellipse(w / 2 + 0.35, 0.75, heap, heap * 0.45).fill(GRAIN).stroke({ color: this.thatchDark, width: 0.03, alpha: 0.5 });
      for (let i = 0; i < Math.round(fill * 4); i++) {
        g.roundRect(-w / 2 - 0.55 + i * 0.28, 0.55 - (i % 2) * 0.12, 0.3, 0.36, 0.1).fill(0xc8a46a).stroke({ color: LINE, width: 0.025, alpha: 0.5 });
      }
    }
  }

  /** A ring of stones around dark water, a frame and a bucket. */
  private drawWell(g: Graphics, R: number): void {
    g.ellipse(0, 0.3, R * 0.95, R * 0.52).fill(STONE_DARK);
    g.ellipse(0, 0.2, R * 0.95, R * 0.52).fill(STONE).stroke({ color: LINE, width: 0.05, alpha: 0.6 });
    g.ellipse(0, 0.18, R * 0.62, R * 0.32).fill(WELL_WATER);
    g.ellipse(-0.12, 0.12, R * 0.3, R * 0.12).fill({ color: 0x6fa8c8, alpha: 0.35 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.roundRect(Math.cos(a) * R * 0.8 - 0.1, 0.2 + Math.sin(a) * R * 0.43 - 0.07, 0.2, 0.14, 0.04).fill({
        color: i % 2 ? STONE_LIGHT : STONE,
        alpha: 0.9,
      });
    }
    // Frame and bucket.
    g.rect(-R * 0.75, -1.1, 0.1, 1.3).fill(STAKE);
    g.rect(R * 0.65, -1.1, 0.1, 1.3).fill(STAKE);
    g.rect(-R * 0.8, -1.15, R * 1.65, 0.1).fill(STAKE);
    g.moveTo(0, -1.05).lineTo(0, -0.35).stroke({ color: 0xc8b088, width: 0.03 });
    g.roundRect(-0.14, -0.4, 0.28, 0.26, 0.05).fill(0x7a5230).stroke({ color: LINE, width: 0.03 });
  }

  /** An open shed: a roof on posts over a bench, a chopping block and cut timber. */
  private drawWorkshop(g: Graphics, R: number): void {
    const w = R * 1.8;
    g.rect(-w / 2, -0.1, w, 0.9).fill({ color: 0x5e4a32, alpha: 0.7 });
    for (const x of [-w / 2 + 0.1, 0, w / 2 - 0.1]) g.rect(x - 0.06, -0.6, 0.12, 1.2).fill(STAKE);
    // Bench, block and axe.
    g.rect(-w / 2 + 0.3, 0.3, 1.1, 0.18).fill(0x8a5e32).stroke({ color: LINE, width: 0.03 });
    g.ellipse(w / 2 - 0.6, 0.55, 0.28, 0.14).fill(0x6a4424);
    g.rect(w / 2 - 0.62, 0.15, 0.05, 0.4).fill(0x9a7040);
    g.poly([w / 2 - 0.62, 0.15, w / 2 - 0.4, 0.12, w / 2 - 0.42, 0.28]).fill(0x9aa4ad);
    // Timber stack.
    for (let i = 0; i < 3; i++) {
      g.roundRect(-w / 2 - 0.2, 0.7 - i * 0.14, 1.2, 0.14, 0.07).fill(0x8a5e32).stroke({ color: LINE, width: 0.02, alpha: 0.6 });
    }
    // Lean-to roof.
    g.poly([-w / 2 - 0.3, -0.35, w / 2 + 0.3, -0.35, w / 2 + 0.15, -1.1, -w / 2 - 0.15, -1.1]).fill(this.thatch).stroke({ color: LINE, width: 0.05, alpha: 0.6 });
    for (let i = 1; i < 10; i++) {
      const x = -w / 2 - 0.2 + ((w + 0.4) * i) / 10;
      g.moveTo(x, -1.08).lineTo(x + 0.05, -0.38).stroke({ color: i % 2 ? this.thatchDark : this.thatchLight, width: 0.03, alpha: 0.4 });
    }
  }

  /** A length of sharpened stakes along a low bank. */
  private drawPalisade(g: Graphics, R: number, progress: number): void {
    const count = 7;
    const shown = Math.max(1, Math.round(count * Math.min(1, progress + 0.15)));
    g.ellipse(0, 0.35, R * 1.25, 0.3).fill({ color: 0x6a5238, alpha: 0.7 });
    for (let i = 0; i < shown; i++) {
      const x = (i - (count - 1) / 2) * (R * 0.34);
      const tall = 1.25 + ((i * 37) % 5) * 0.06;
      g.poly([x - 0.12, 0.35, x + 0.12, 0.35, x + 0.12, 0.35 - tall, x, 0.35 - tall - 0.22, x - 0.12, 0.35 - tall])
        .fill(i % 2 ? STAKE : 0x6e4c2a)
        .stroke({ color: LINE, width: 0.03, alpha: 0.6 });
    }
    if (progress >= 1) g.moveTo(-R * 1.15, -0.35).lineTo(R * 1.15, -0.35).stroke({ color: 0x3a2814, width: 0.06 });
  }

  /** Standing stones in a ring around a small fire. */
  private drawShrine(g: Graphics, R: number): void {
    g.ellipse(0, 0.2, R * 1.05, R * 0.55).fill({ color: 0x6a6258, alpha: 0.35 });
    const stones = 7;
    for (const front of [false, true]) {
      for (let i = 0; i < stones; i++) {
        const a = (i / stones) * Math.PI * 2 + 0.3;
        if (Math.sin(a) > 0 !== front) continue;
        const x = Math.cos(a) * R * 0.9;
        const y = 0.2 + Math.sin(a) * R * 0.48;
        const h = 0.8 + ((i * 13) % 4) * 0.12;
        g.roundRect(x - 0.16, y - h, 0.32, h, 0.1).fill(i % 2 ? STONE : STONE_LIGHT).stroke({ color: LINE, width: 0.03, alpha: 0.6 });
      }
      if (!front) {
        g.ellipse(0, 0.2, 0.3, 0.15).fill(0x3a2a1a);
        g.ellipse(0, 0.05, 0.14, 0.26).fill({ color: 0xff9a2e, alpha: 0.9 });
        g.ellipse(0, 0.1, 0.07, 0.14).fill({ color: 0xffe27a, alpha: 0.95 });
      }
    }
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

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, shift: number): number => (c >> shift) & 255;
  const m = (shift: number): number => Math.round(ch(a, shift) + (ch(b, shift) - ch(a, shift)) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}
