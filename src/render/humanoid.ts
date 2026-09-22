import { Container, Graphics } from 'pixi.js';

/**
 * Procedural humanoid sprite.
 *
 * Everything is drawn from primitives created inside this repository — no
 * external or copyrighted assets. The same class renders humans and predators;
 * only the palette, proportions and scale differ.
 *
 * The body is a small articulated rig (torso + head + two arms + two legs) whose
 * joints are animated from the entity's current action. That is what makes the
 * world read as alive rather than as a field of coloured dots.
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
} as const;

export interface HumanoidOptions {
  /** Base body height in world tiles for a full-grown adult. */
  baseHeight: number;
  /** Render a predator silhouette (heavier, no clothing, visible head crest). */
  predator?: boolean;
}

export class HumanoidSprite extends Container {
  private readonly body = new Container();
  private readonly torso = new Graphics();
  private readonly head = new Graphics();
  private readonly armLeft = new Graphics();
  private readonly armRight = new Graphics();
  private readonly legLeft = new Graphics();
  private readonly legRight = new Graphics();
  private readonly shadow = new Graphics();
  private readonly belly = new Graphics();
  private readonly crest = new Graphics();

  private readonly options: HumanoidOptions;
  private color = 0xffffff;
  private outline = 0x000000;

  /** Animation phase accumulator. */
  private phase = 0;
  private currentScale = 1;

  constructor(options: HumanoidOptions) {
    super();
    this.options = options;

    this.shadow.ellipse(0, 0, 0.34, 0.16).fill({ color: 0x000000, alpha: 0.28 });
    this.shadow.position.set(0, 0.06);

    this.torso.roundRect(-0.13, -0.42, 0.26, 0.44, 0.08);
    this.head.circle(0, -0.52, 0.135);
    this.armLeft.roundRect(-0.05, -0.02, 0.1, 0.34, 0.045);
    this.armRight.roundRect(-0.05, -0.02, 0.1, 0.34, 0.045);
    this.legLeft.roundRect(-0.05, 0, 0.1, 0.34, 0.045);
    this.legRight.roundRect(-0.05, 0, 0.1, 0.34, 0.045);
    this.belly.circle(0, -0.2, 0.16);
    this.crest
      .moveTo(-0.12, -0.6)
      .lineTo(0, -0.74)
      .lineTo(0.12, -0.6)
      .closePath();

    // Pivots: arms hang from the shoulders, legs from the hips.
    this.armLeft.pivot.set(0, 0);
    this.armRight.pivot.set(0, 0);
    this.legLeft.pivot.set(0, 0);
    this.legRight.pivot.set(0, 0);
    this.armLeft.position.set(-0.16, -0.36);
    this.armRight.position.set(0.16, -0.36);
    this.legLeft.position.set(-0.07, 0.0);
    this.legRight.position.set(0.07, 0.0);

    this.body.addChild(
      this.legLeft,
      this.legRight,
      this.torso,
      this.belly,
      this.armLeft,
      this.armRight,
      this.head,
      this.crest,
    );

    this.addChild(this.shadow, this.body);
    this.belly.visible = false;
    this.crest.visible = options.predator === true;
  }

  /** Recolour for a genome. Cheap: the shapes only need re-filling. */
  setAppearance(hue: number, saturation: number, lightness: number): void {
    const color = hslToHex(hue, saturation, lightness);
    const outline = hslToHex(hue, saturation * 0.7, Math.max(0.06, lightness * 0.35));
    if (color === this.color && outline === this.outline) return;
    this.color = color;
    this.outline = outline;

    this.torso.clear().roundRect(-0.13, -0.42, 0.26, 0.44, 0.08).fill(color).stroke({ color: outline, width: 0.02 });
    this.head.clear().circle(0, -0.52, 0.135).fill(color).stroke({ color: outline, width: 0.02 });
    this.armLeft.clear().roundRect(-0.05, -0.02, 0.1, 0.34, 0.045).fill(color);
    this.armRight.clear().roundRect(-0.05, -0.02, 0.1, 0.34, 0.045).fill(color);
    this.legLeft.clear().roundRect(-0.05, 0, 0.1, 0.34, 0.045).fill(outline);
    this.legRight.clear().roundRect(-0.05, 0, 0.1, 0.34, 0.045).fill(outline);
    this.belly.clear().circle(0, -0.2, 0.16).fill(hslToHex(hue, saturation * 0.8, Math.min(0.95, lightness + 0.18)));
    this.crest.clear().moveTo(-0.12, -0.6).lineTo(0, -0.74).lineTo(0.12, -0.6).closePath().fill(outline);
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
  ): void {
    this.setAppearance(hue, saturation, lightness);

    const moving = Math.abs(speed) > 0.15;
    const strideRate = moving ? Math.min(14, 3.2 + Math.abs(speed) * 2.6) : 2.2;
    this.phase += dt * strideRate;

    const injured = (flags & 1) !== 0;
    const sleeping = (flags & 2) !== 0;
    const isMating = (flags & 4) !== 0;
    const pregnant = (flags & 8) !== 0;
    const attacking = (flags & 32) !== 0;
    const feeding = (flags & 64) !== 0;
    const harvesting = (flags & 256) !== 0;
    const building = (flags & 512) !== 0;

    // Smoothly approach the target scale so growth is visible rather than a pop.
    this.currentScale += (size - this.currentScale) * Math.min(1, dt * 3);
    this.body.scale.set(this.currentScale);

    const swing = moving ? Math.sin(this.phase) : Math.sin(this.phase) * 0.08;

    // Defaults.
    let bodyRotation = 0;
    let legLeft = swing * 0.75;
    let legRight = -swing * 0.75;
    let armLeft = -swing * 0.55;
    let armRight = swing * 0.55;
    let bodyBob = moving ? Math.abs(Math.sin(this.phase)) * 0.03 : Math.sin(this.phase * 0.6) * 0.012;
    let bodyLift = 0;

    if (sleeping || action === ACTION.Rest) {
      // Lie down: rotate the whole body and tuck the limbs.
      bodyRotation = Math.PI / 2;
      bodyLift = 0.1;
      legLeft = 0.15;
      legRight = -0.15;
      armLeft = 0.1;
      armRight = -0.1;
      bodyBob = Math.sin(this.phase * 0.35) * 0.006;
    } else if (isMating) {
      // Rhythmic coupled motion — readable as mating without being explicit.
      const rhythm = Math.sin(mating * Math.PI * 14);
      bodyRotation = 0;
      bodyBob = rhythm * 0.022;
      legLeft = 0.32;
      legRight = -0.32;
      armLeft = 0.45 + rhythm * 0.12;
      armRight = -0.45 - rhythm * 0.12;
    } else if (attacking) {
      const strike = Math.abs(Math.sin(this.phase * 1.6));
      armRight = -1.5 - strike * 0.7;
      armLeft = 0.4;
      legLeft = 0.2;
      legRight = -0.2;
      bodyRotation = strike * 0.12;
    } else if (feeding || action === ACTION.Eat || action === ACTION.Drink) {
      const chew = Math.abs(Math.sin(this.phase * 1.4));
      armRight = -1.15 - chew * 0.25;
      armLeft = 0.1;
      bodyBob = chew * 0.012;
      bodyRotation = 0.06;
    } else if (action === ACTION.Signal) {
      armLeft = -1.5;
      armRight = -1.5;
      bodyBob = Math.abs(Math.sin(this.phase * 1.2)) * 0.03;
    } else if (action === ACTION.Interact) {
      armLeft = -0.9;
      armRight = -0.9;
    } else if (harvesting || action === ACTION.Harvest) {
      // Overhead axe swing: both arms up, then down, with a body twist.
      const chop = Math.sin(this.phase * 1.1);
      const raise = Math.max(0, chop);
      armRight = -0.5 - raise * 1.9;
      armLeft = -0.4 - raise * 1.6;
      bodyRotation = raise * 0.22;
      bodyBob = -raise * 0.02;
    } else if (building || action === ACTION.Build) {
      // Crouched, arms forward laying a log.
      armLeft = -1.25;
      armRight = -1.25;
      bodyRotation = 0.12;
      bodyLift = -0.03;
      legLeft = 0.25;
      legRight = -0.25;
      bodyBob = Math.abs(Math.sin(this.phase * 1.3)) * 0.014;
    }

    this.body.rotation = bodyRotation;
    this.body.y = -bodyBob - bodyLift;

    this.legLeft.rotation = legLeft;
    this.legRight.rotation = legRight;
    this.armLeft.rotation = armLeft;
    this.armRight.rotation = armRight;

    // Pregnancy is visible as a growing belly.
    this.belly.visible = pregnant && pregnancy > 0.05;
    if (this.belly.visible) {
      const bulge = 0.55 + pregnancy * 0.9;
      this.belly.scale.set(bulge);
    }

    // Injury reads as a red flash rather than a health bar.
    const flash = injured ? 0.35 + 0.35 * Math.sin(this.phase * 4) : 0;
    this.body.alpha = 1;
    if (flash > 0) {
      this.torso.tint = blendTint(flash);
      this.head.tint = blendTint(flash);
    } else {
      this.torso.tint = 0xffffff;
      this.head.tint = 0xffffff;
    }
  }
}

function blendTint(amount: number): number {
  const r = 255;
  const g = Math.round(255 * (1 - amount));
  const b = Math.round(255 * (1 - amount));
  return (r << 16) | (g << 8) | b;
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
