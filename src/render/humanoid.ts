import { Container, Graphics } from 'pixi.js';
import { looksKey, readLooks, type Looks } from './morph';

/**
 * Procedural creature sprites: people and the predators that hunt them.
 *
 * Drawn from primitives created inside this repository — no external or
 * copyrighted assets. Both are seen the way the rest of the world is: from
 * above and slightly in front, lit from the north-west, standing on a soft
 * shadow. A person is about one and a half tiles tall — a third of a hut — so
 * the village has a believable scale.
 *
 * Each body is a small articulated rig whose joints are animated from the
 * entity's current action. The genome's colour is what a person *wears*; skin
 * and hair come from the same genes, so relatives look related.
 */

/**
 * Action poses, keyed by *motor index*.
 *
 * These must match `M` in `simulation/brain/channels.ts` exactly. An earlier
 * version of this table was offset by one (it had an `Idle` entry at 0 that no
 * motor ever produces), which meant a resting human was drawn drinking and an
 * eating human was drawn sprinting — a bug that is invisible in a screenshot and
 * obvious the moment you compare the panel to the sprite.
 */
export const ACTION = {
  MoveFwd: 0,
  MoveBack: 1,
  TurnLeft: 2,
  TurnRight: 3,
  Sprint: 4,
  Eat: 5,
  Drink: 6,
  Rest: 7,
  Attack: 8,
  Signal: 9,
  Mate: 10,
  Interact: 11,
  Harvest: 12,
  Build: 13,
  // v2 motors. Without entries here the farming actions fell through to the
  // default pose and a human sowing a field looked exactly like one walking.
  Plant: 14,
  Tend: 15,
  Dig: 16,
} as const;

export interface HumanoidOptions {
  /** Base body height in world tiles for a full-grown adult. */
  baseHeight: number;
  /** Render a four-legged predator instead of a person. */
  predator?: boolean;
}

/** Natural skin tones, light to deep. */
const SKIN = [0xf1d2b6, 0xe2b48f, 0xc98f63, 0xa86d45, 0x7d4d2f, 0x5b3622];
/** Hair: black, dark brown, brown, auburn, dark blond, grey-brown. */
const HAIR = [0x1d1612, 0x3a2618, 0x5e3d22, 0x7a3a1c, 0xa47a44, 0x6b6258];

const FLAG_INJURED = 1;
const FLAG_SLEEPING = 2;
const FLAG_MATING = 4;
const FLAG_PREGNANT = 8;
const FLAG_ATTACKING = 32;
const FLAG_FEEDING = 64;
const FLAG_HARVESTING = 256;
const FLAG_BUILDING = 512;

export class HumanoidSprite extends Container {
  private readonly shadow = new Graphics();
  private readonly body = new Container();
  // Person rig.
  private readonly torso = new Graphics();
  private readonly head = new Graphics();
  private readonly armLeft = new Graphics();
  private readonly armRight = new Graphics();
  private readonly legLeft = new Graphics();
  private readonly legRight = new Graphics();
  private readonly belly = new Graphics();
  // Beast rig.
  private readonly legs: Graphics[] = [];
  private readonly tail = new Graphics();
  private readonly beastHead = new Container();

  private readonly options: HumanoidOptions;
  private appearanceKey = -1;
  private phase = 0;
  private currentScale = 1;
  private facing = 1;
  private targetFacing = 1;

  constructor(options: HumanoidOptions) {
    super();
    this.options = options;
    this.addChild(this.shadow, this.body);
    if (options.predator) {
      for (let i = 0; i < 4; i++) this.legs.push(new Graphics());
      // Far-side legs first, then the body, then the near-side legs.
      this.body.addChild(this.legs[1], this.legs[3], this.tail, this.torso, this.beastHead, this.legs[0], this.legs[2]);
      this.beastHead.addChild(this.head);
    } else {
      this.armLeft.pivot.set(0, 0);
      this.body.addChild(this.legLeft, this.legRight, this.armLeft, this.torso, this.belly, this.head, this.armRight);
      this.armLeft.position.set(-0.155, -0.73);
      this.armRight.position.set(0.155, -0.73);
      this.legLeft.position.set(-0.07, -0.44);
      this.legRight.position.set(0.07, -0.44);
    }
  }

  /** Face the direction of travel: sprites are mirrored, never rotated. */
  face(heading: number): void {
    const c = Math.cos(heading);
    if (Math.abs(c) > 0.2) this.targetFacing = c >= 0 ? 1 : -1;
  }

  /** Recolour and reshape for a genome. Cheap: the shapes are only redrawn when the looks change. */
  setAppearance(hue: number, saturation: number, lightness: number, morph?: ArrayLike<number> | null): void {
    const key =
      (Math.round(hue * 1000) * 1e6 + Math.round(saturation * 1000) * 1e3 + Math.round(lightness * 1000)) * 7 +
      looksKey(morph);
    if (key === this.appearanceKey) return;
    this.appearanceKey = key;
    if (this.options.predator) this.drawBeast(hue, saturation, lightness);
    else this.drawPerson(hue, saturation, lightness, morph ? readLooks(morph) : null);
  }

  private drawPerson(hue: number, saturation: number, lightness: number, looks: Looks | null): void {
    const tunic = hslToHex(hue, Math.min(0.62, saturation * 0.78), clamp(0.26 + lightness * 0.42, 0.3, 0.62));
    const tunicDark = shade(tunic, 0.62);
    const tunicLight = shade(tunic, 1.22);
    const pick = fract(hue * 7.13 + lightness * 3.1 + saturation * 1.7);
    const skin = SKIN[Math.floor(pick * SKIN.length) % SKIN.length];
    const skinDark = shade(skin, 0.78);
    const hair = looks ? looks.hair : HAIR[Math.floor(fract(hue * 3.7 + saturation * 5.3) * HAIR.length) % HAIR.length];
    // Build widens the shoulders and hips; head shape stretches the skull.
    const b = looks ? looks.build : 1;
    const headRx = 0.105 * (looks ? 1.1 - 0.2 * looks.headShape : 1);
    const headRy = 0.105 * (looks ? 0.9 + 0.22 * looks.headShape : 1);
    this.armLeft.position.set(-0.155 * b, -0.73);
    this.armRight.position.set(0.155 * b, -0.73);
    this.legLeft.position.set(-0.07 * b, -0.44);
    this.legRight.position.set(0.07 * b, -0.44);
    const trousers = shade(hslToHex(hue + 0.08, 0.18, 0.28), 1);
    const line = 0x14100c;

    this.shadow.clear();
    this.shadow.ellipse(0.02, 0.01, 0.34, 0.11).fill({ color: 0x0a120c, alpha: 0.14 });
    this.shadow.ellipse(0.02, 0.01, 0.22, 0.07).fill({ color: 0x0a120c, alpha: 0.3 });

    for (const leg of [this.legLeft, this.legRight]) {
      leg.clear();
      leg.roundRect(-0.052, 0, 0.104, 0.42, 0.05).fill(trousers).stroke({ color: line, width: 0.014, alpha: 0.5 });
      leg.ellipse(0.02, 0.42, 0.07, 0.04).fill(0x2a1e14);
    }

    for (const [arm, near] of [
      [this.armLeft, false],
      [this.armRight, true],
    ] as const) {
      arm.clear();
      arm.roundRect(-0.045, 0, 0.09, 0.2, 0.04).fill(near ? tunic : tunicDark);
      arm.roundRect(-0.038, 0.17, 0.076, 0.18, 0.035).fill(near ? skin : skinDark);
      arm.circle(0, 0.36, 0.042).fill(near ? skin : skinDark);
    }

    // Tunic: rounded shoulders, a belted waist, a flared hem.
    const t = this.torso;
    t.clear();
    const X = (v: number): number => v * b;
    t.poly([X(-0.15), -0.78, X(0.15), -0.78, X(0.17), -0.7, X(0.13), -0.48, X(0.17), -0.34, X(-0.17), -0.34, X(-0.13), -0.48, X(-0.17), -0.7])
      .fill(tunic)
      .stroke({ color: line, width: 0.016, alpha: 0.55, join: 'round' });
    // Shade the side away from the light, catch the light on the other.
    t.poly([0.02, -0.78, X(0.15), -0.78, X(0.17), -0.7, X(0.13), -0.48, X(0.17), -0.34, 0.03, -0.34]).fill({ color: tunicDark, alpha: 0.5 });
    t.poly([X(-0.14), -0.77, X(-0.08), -0.77, X(-0.1), -0.5, X(-0.13), -0.5]).fill({ color: tunicLight, alpha: 0.45 });
    if (looks) this.drawPaint(t, looks, b);
    t.rect(X(-0.14), -0.5, X(0.28), 0.035).fill(0x5a3a1e);
    t.rect(-0.02, -0.5, 0.04, 0.035).fill(0xc9a45a);
    // Neck.
    t.rect(-0.035, -0.83, 0.07, 0.06).fill(skinDark);
    if (looks?.ornament === 'beads') {
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (0.15 + (i / 6) * 0.7);
        t.circle(Math.cos(a) * 0.075, -0.8 + Math.sin(a) * 0.05, 0.016).fill(i % 2 ? looks.paintColor : 0xe8d8b0);
      }
    }

    const h = this.head;
    h.clear();
    const style = looks?.hairStyle ?? 'cropped';
    // Hair that falls behind the head is drawn first.
    if (style === 'long') h.roundRect(-0.1, -0.95, 0.15, 0.25, 0.06).fill(shade(hair, 0.85));
    if (style === 'braided') {
      for (let i = 0; i < 4; i++) h.ellipse(-0.085, -0.84 + i * 0.055, 0.028, 0.032).fill(i % 2 ? hair : shade(hair, 0.8));
    }
    h.ellipse(0, -0.9, headRx, headRy).fill(skin).stroke({ color: line, width: 0.014, alpha: 0.5 });
    // Seen from above: the crown of the head is mostly hair.
    if (style === 'shorn') {
      h.ellipse(-0.01, -0.94, headRx * 0.95, headRy * 0.62).fill({ color: hair, alpha: 0.45 });
    } else {
      h.ellipse(-0.012, -0.935, headRx * 1.03, headRy * 0.78).fill(hair);
      h.ellipse(-0.06, -0.9, 0.05, 0.07).fill(hair);
    }
    if (style === 'crested') {
      h.poly([-0.07, -0.97, -0.03, -1.07, 0.01, -0.99, 0.04, -1.06, 0.07, -0.96]).fill(hair).stroke({ color: line, width: 0.01, alpha: 0.4 });
    }
    if (style === 'knotted') h.circle(-0.02, -0.9 - headRy - 0.03, 0.045).fill(hair).stroke({ color: line, width: 0.01, alpha: 0.4 });
    // Face toward the direction of travel (the sprite mirrors), lit on the left.
    h.ellipse(0.035, -0.875, 0.05, 0.045).fill({ color: shade(skin, 1.08), alpha: 0.9 });
    h.circle(0.06, -0.885, 0.011).fill(0x1a1410);
    if (looks && looks.paint !== 'none') {
      // A stroke of the same paint across the cheek.
      h.rect(0.02, -0.865, 0.05, 0.012).fill({ color: looks.paintColor, alpha: 0.85 });
    }
    if (looks) this.drawOrnament(h, looks, headRx, headRy);

    this.belly.clear();
    this.belly.ellipse(0.05, -0.5, 0.13, 0.11).fill(tunic).stroke({ color: line, width: 0.014, alpha: 0.45 });
    this.belly.ellipse(0.02, -0.53, 0.06, 0.05).fill({ color: tunicLight, alpha: 0.4 });
  }

  /** Body paint on the tunic's front: stripes, dots, a band or chevrons. */
  private drawPaint(t: Graphics, looks: Looks, b: number): void {
    const c = { color: looks.paintColor, alpha: 0.85 };
    switch (looks.paint) {
      case 'stripes':
        for (let i = 0; i < 3; i++) t.rect(-0.11 * b, -0.74 + i * 0.07, 0.22 * b, 0.018).fill(c);
        break;
      case 'dots':
        for (let i = 0; i < 6; i++) t.circle((-0.08 + (i % 3) * 0.08) * b, -0.72 + Math.floor(i / 3) * 0.09, 0.018).fill(c);
        break;
      case 'band':
        t.poly([-0.14 * b, -0.76, -0.08 * b, -0.76, 0.13 * b, -0.52, 0.07 * b, -0.52]).fill(c);
        break;
      case 'chevrons':
        for (let i = 0; i < 2; i++) {
          const y = -0.74 + i * 0.1;
          t.moveTo(-0.1 * b, y).lineTo(0, y + 0.06).lineTo(0.1 * b, y).stroke({ ...c, width: 0.022 });
        }
        break;
      default:
        break;
    }
  }

  /** Headwear and adornment. */
  private drawOrnament(h: Graphics, looks: Looks, rx: number, ry: number): void {
    const line = 0x14100c;
    const top = -0.9 - ry;
    switch (looks.ornament) {
      case 'feather':
        h.ellipse(-0.07, top - 0.06, 0.022, 0.08).fill(looks.paintColor).stroke({ color: line, width: 0.008, alpha: 0.5 });
        h.moveTo(-0.07, top + 0.02).lineTo(-0.07, top - 0.13).stroke({ color: 0xf0e6d0, width: 0.008 });
        break;
      case 'headband':
        h.rect(-rx, -0.93, rx * 2, 0.026).fill(looks.paintColor);
        break;
      case 'horns':
        h.poly([-rx * 0.7, top + 0.03, -rx * 1.05, top - 0.09, -rx * 0.35, top + 0.01]).fill(0xe9dcc0).stroke({ color: line, width: 0.008, alpha: 0.5 });
        h.poly([rx * 0.7, top + 0.03, rx * 1.05, top - 0.09, rx * 0.35, top + 0.01]).fill(0xe9dcc0).stroke({ color: line, width: 0.008, alpha: 0.5 });
        break;
      case 'flowers':
        for (let i = 0; i < 5; i++) {
          const a = Math.PI * (1.1 + (i / 4) * 0.8);
          h.circle(Math.cos(a) * rx, -0.9 + Math.sin(a) * ry * 0.95, 0.022).fill(i % 2 ? 0xf6d34a : looks.paintColor);
        }
        break;
      default:
        break;
    }
  }

  private drawBeast(hue: number, saturation: number, lightness: number): void {
    // Fur: the genome picks the coat, kept to the tawny-grey range of real hunters.
    const fur = hslToHex(0.07 + (hue - 0.5) * 0.08, 0.28 + saturation * 0.25, clamp(0.22 + lightness * 0.3, 0.24, 0.46));
    const furDark = shade(fur, 0.55);
    const furLight = shade(fur, 1.35);
    const line = 0x0e0a08;

    this.shadow.clear();
    this.shadow.ellipse(0.02, 0.01, 0.62, 0.14).fill({ color: 0x0a120c, alpha: 0.16 });
    this.shadow.ellipse(0.02, 0.01, 0.46, 0.09).fill({ color: 0x0a120c, alpha: 0.3 });

    const legAt: Array<[number, number]> = [
      [0.26, -0.3],
      [0.3, -0.32],
      [-0.28, -0.3],
      [-0.24, -0.32],
    ];
    this.legs.forEach((leg, i) => {
      leg.clear();
      const far = i === 1 || i === 3;
      leg.roundRect(-0.05, 0, 0.1, 0.3, 0.045).fill(far ? furDark : shade(fur, 0.8));
      leg.ellipse(0.015, 0.3, 0.065, 0.035).fill(line);
      leg.position.set(legAt[i][0], legAt[i][1]);
    });

    const b = this.torso;
    b.clear();
    b.ellipse(0, -0.42, 0.42, 0.17).fill(fur).stroke({ color: line, width: 0.018, alpha: 0.6 });
    b.ellipse(0.02, -0.36, 0.34, 0.08).fill({ color: furLight, alpha: 0.45 });
    b.ellipse(-0.02, -0.52, 0.36, 0.06).fill({ color: furDark, alpha: 0.6 });
    // Shoulder hump: reads as powerful rather than as a sausage.
    b.ellipse(0.24, -0.48, 0.17, 0.15).fill(fur);
    b.ellipse(0.24, -0.55, 0.12, 0.06).fill({ color: furDark, alpha: 0.5 });

    this.tail.clear();
    this.tail.moveTo(-0.38, -0.46).quadraticCurveTo(-0.62, -0.5, -0.74, -0.66).stroke({ color: furDark, width: 0.07, cap: 'round' });
    this.tail.circle(-0.74, -0.66, 0.045).fill(shade(furDark, 0.7));

    const h = this.head;
    h.clear();
    h.ellipse(0, 0, 0.16, 0.12).fill(fur).stroke({ color: line, width: 0.016, alpha: 0.6 });
    h.ellipse(0.15, 0.03, 0.1, 0.065).fill(furLight).stroke({ color: line, width: 0.012, alpha: 0.5 });
    h.circle(0.24, 0.02, 0.024).fill(line);
    h.poly([-0.06, -0.08, -0.02, -0.2, 0.03, -0.09]).fill(furDark);
    h.poly([0.03, -0.09, 0.08, -0.19, 0.1, -0.07]).fill(furDark);
    // Eyes catch the light: the one detail you notice from across the map.
    h.circle(0.08, -0.03, 0.022).fill(0xffc24a);
    h.circle(0.085, -0.032, 0.008).fill(0x1a0e04);
    this.beastHead.position.set(0.46, -0.56);
  }

  /**
   * Update pose + animation.
   *
   * @param dt         seconds since the previous frame (render time, not sim time)
   * @param action     motor index of the winning output
   * @param speed      locomotion speed in tiles/s
   * @param flags      packed EntityFlags
   * @param pregnancy  0..1 gestation progress
   * @param mating     0..1 mating progress
   * @param size       body scale
   */
  update(
    dt: number,
    action: number,
    speed: number,
    flags: number,
    pregnancy: number,
    mating: number,
    size: number,
    hue: number,
    saturation: number,
    lightness: number,
    morph?: ArrayLike<number> | null,
  ): void {
    this.setAppearance(hue, saturation, lightness, morph);

    const moving = Math.abs(speed) > 0.15;
    const strideRate = moving ? Math.min(13, 3.4 + Math.abs(speed) * 2.4) : 2;
    this.phase += dt * strideRate;

    // Smoothly approach the target scale so growth is visible rather than a pop,
    // and turn around through a brief squash rather than an instant flip.
    this.currentScale += (size - this.currentScale) * Math.min(1, dt * 3);
    this.facing += (this.targetFacing - this.facing) * Math.min(1, dt * 12);
    const sx = this.currentScale * (Math.abs(this.facing) < 0.15 ? 0.15 * Math.sign(this.facing || 1) : this.facing);
    this.body.scale.set(sx, this.currentScale);
    this.shadow.scale.set(this.currentScale);

    if (this.options.predator) this.animateBeast(action, moving, flags);
    else this.animatePerson(action, moving, flags, pregnancy, mating);

    // Injury reads as a red flash rather than a health bar.
    const injured = (flags & FLAG_INJURED) !== 0;
    const flash = injured ? 0.3 + 0.3 * Math.sin(this.phase * 4) : 0;
    const tint = flash > 0 ? blendTint(flash) : 0xffffff;
    this.torso.tint = tint;
    this.head.tint = tint;
  }

  private animatePerson(action: number, moving: boolean, flags: number, pregnancy: number, mating: number): void {
    const sleeping = (flags & FLAG_SLEEPING) !== 0;
    const isMating = (flags & FLAG_MATING) !== 0;
    const pregnant = (flags & FLAG_PREGNANT) !== 0;
    const attacking = (flags & FLAG_ATTACKING) !== 0;
    const feeding = (flags & FLAG_FEEDING) !== 0;
    const harvesting = (flags & FLAG_HARVESTING) !== 0;
    const building = (flags & FLAG_BUILDING) !== 0;

    const swing = moving ? Math.sin(this.phase) : Math.sin(this.phase) * 0.06;
    let bodyRotation = 0;
    let legLeft = swing * 0.6;
    let legRight = -swing * 0.6;
    let armLeft = -swing * 0.55;
    let armRight = swing * 0.55;
    let bob = moving ? Math.abs(Math.sin(this.phase)) * 0.035 : Math.sin(this.phase * 0.6) * 0.008;
    let lift = 0;
    let headTilt = 0;

    if (sleeping) {
      bodyRotation = Math.PI / 2;
      lift = 0.12;
      legLeft = 0.1;
      legRight = -0.1;
      armLeft = 0.15;
      armRight = -0.1;
      bob = Math.sin(this.phase * 0.35) * 0.006;
    } else if (action === ACTION.Rest) {
      // Sitting, knees drawn up.
      lift = -0.2;
      legLeft = -1.35;
      legRight = -1.2;
      armLeft = -0.5;
      armRight = -0.6;
      headTilt = 0.1;
      bob = Math.sin(this.phase * 0.5) * 0.006;
    } else if (isMating) {
      const rhythm = Math.sin(mating * Math.PI * 14);
      bob = rhythm * 0.02;
      legLeft = 0.2;
      legRight = -0.2;
      armLeft = -0.9 + rhythm * 0.1;
      armRight = -0.9 - rhythm * 0.1;
    } else if (attacking) {
      const strike = Math.abs(Math.sin(this.phase * 1.6));
      armRight = -2.2 + strike * 1.6;
      armLeft = 0.3;
      legLeft = 0.35;
      legRight = -0.3;
      bodyRotation = strike * 0.14;
    } else if (feeding || action === ACTION.Eat || action === ACTION.Drink) {
      const chew = Math.abs(Math.sin(this.phase * 1.4));
      armRight = -2.4 - chew * 0.2;
      armLeft = 0.1;
      headTilt = 0.12 + chew * 0.06;
      bodyRotation = 0.05;
    } else if (action === ACTION.Signal) {
      const wave = Math.sin(this.phase * 2.2);
      armRight = -2.7 + wave * 0.3;
      armLeft = 0.1;
      bob = Math.abs(wave) * 0.02;
    } else if (action === ACTION.Interact) {
      armLeft = -1.1;
      armRight = -1.1;
    } else if (action === ACTION.Plant || action === ACTION.Tend) {
      // Bent over the soil.
      const reach = Math.abs(Math.sin(this.phase * 1.2));
      bodyRotation = 0.45;
      lift = -0.06;
      armRight = -0.6 - reach * 0.5;
      armLeft = -0.4;
      legLeft = -0.2;
      legRight = 0.25;
    } else if (harvesting || action === ACTION.Harvest || action === ACTION.Dig) {
      // Overhead swing of an axe or a hoe, with the body following through.
      const chop = Math.sin(this.phase * 1.1);
      const raise = Math.max(0, chop);
      armRight = -0.6 - raise * 2.3;
      armLeft = -0.5 - raise * 2.0;
      bodyRotation = 0.1 + (1 - raise) * 0.25;
      bob = -raise * 0.02;
    } else if (building || action === ACTION.Build) {
      armLeft = -1.5;
      armRight = -1.5;
      bodyRotation = 0.2;
      lift = -0.04;
      legLeft = 0.3;
      legRight = -0.3;
      bob = Math.abs(Math.sin(this.phase * 1.3)) * 0.014;
    }

    this.body.rotation = bodyRotation * Math.sign(this.facing || 1);
    this.body.y = -bob - lift;
    this.legLeft.rotation = legLeft;
    this.legRight.rotation = legRight;
    this.armLeft.rotation = armLeft;
    this.armRight.rotation = armRight;
    this.head.rotation = headTilt;
    this.head.pivot.set(0, -0.8);
    this.head.position.set(0, -0.8);

    this.belly.visible = pregnant && pregnancy > 0.05;
    if (this.belly.visible) this.belly.scale.set(0.5 + pregnancy * 0.7);
  }

  private animateBeast(action: number, moving: boolean, flags: number): void {
    const attacking = (flags & FLAG_ATTACKING) !== 0;
    const feeding = (flags & FLAG_FEEDING) !== 0;
    const gait = moving ? Math.sin(this.phase) : 0;
    // Diagonal pairs move together, like a trot.
    const swings = [gait * 0.6, -gait * 0.6, -gait * 0.6, gait * 0.6];
    let bodyY = moving ? -Math.abs(Math.sin(this.phase)) * 0.03 : Math.sin(this.phase * 0.5) * 0.006;
    let headY = -0.56;
    let headX = 0.46;
    let headRot = 0;
    let tail = Math.sin(this.phase * 0.7) * 0.15;

    if (attacking) {
      const lunge = Math.abs(Math.sin(this.phase * 1.8));
      headX = 0.52 + lunge * 0.1;
      headY = -0.5;
      headRot = 0.25;
      swings[0] = swings[1] = -0.7 * lunge;
      swings[2] = swings[3] = 0.5;
      bodyY = -lunge * 0.05;
      tail = 0.5;
    } else if (feeding || action === ACTION.Eat) {
      headY = -0.34;
      headRot = 0.7;
      tail = Math.sin(this.phase * 1.5) * 0.3;
    } else if (action === ACTION.Rest) {
      bodyY = 0.14;
      swings.fill(-1.3);
      headY = -0.46;
      tail = 0.1;
    }

    this.legs.forEach((leg, i) => (leg.rotation = swings[i]));
    this.torso.y = bodyY;
    this.tail.y = bodyY;
    this.tail.rotation = tail;
    this.tail.pivot.set(-0.38, -0.46);
    this.tail.position.set(-0.38, -0.46 + bodyY);
    this.beastHead.position.set(headX, headY + bodyY);
    this.beastHead.rotation = headRot;
  }
}

function blendTint(amount: number): number {
  const r = 255;
  const g = Math.round(255 * (1 - amount));
  const b = Math.round(255 * (1 - amount));
  return (r << 16) | (g << 8) | b;
}

/** Scale a packed colour's brightness. */
function shade(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * k));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * k));
  const b = Math.min(255, Math.round((color & 0xff) * k));
  return (r << 16) | (g << 8) | b;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

/** HSL (0..1, 0..1, 0..1) to a packed 0xRRGGBB integer. */
export function hslToHex(h: number, s: number, l: number): number {
  const hue = ((h % 1) + 1) % 1;
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  const sector = Math.floor(hue * 6);
  switch (sector % 6) {
    case 0:
      r = c;
      g = x;
      break;
    case 1:
      r = x;
      g = c;
      break;
    case 2:
      g = c;
      b = x;
      break;
    case 3:
      g = x;
      b = c;
      break;
    case 4:
      r = x;
      b = c;
      break;
    default:
      r = c;
      b = x;
      break;
  }
  const toByte = (value: number): number => Math.max(0, Math.min(255, Math.round((value + m) * 255)));
  return (toByte(r) << 16) | (toByte(g) << 8) | toByte(b);
}

export { HumanoidSprite as default };
