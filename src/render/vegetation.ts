import { Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import { EntityKind } from '../shared/types';
import type { EntityView } from '../worker/client';
import { PlantSpecies } from '../simulation/entities/plant';

/**
 * Vegetation: every plant on the map as a textured particle.
 *
 * Plants are the most numerous thing in the world — thousands of them — so they
 * are drawn from one generated atlas through three particle containers (cast
 * shadows, ground cover, tree canopies), which is three draw calls whatever the
 * count. The atlas is painted once with Canvas 2D: leaf clusters lit from the
 * north-west like the terrain, so a tree sits *on* the relief rather than being
 * a disc stamped over it.
 */

/** Stamp names in the atlas. */
type Stamp =
  | 'tree0'
  | 'tree1'
  | 'tree2'
  | 'tree3'
  | 'young'
  | 'stump'
  | 'bush0'
  | 'bush1'
  | 'berry0'
  | 'berry1'
  | 'grass0'
  | 'grass1'
  | 'grass2'
  | 'pile'
  | 'shadow';

const CELL = 128;
const LAYOUT: Stamp[] = [
  'tree0', 'tree1', 'tree2', 'tree3', 'young', 'stump', 'shadow', 'pile',
  'bush0', 'bush1', 'berry0', 'berry1', 'grass0', 'grass1', 'grass2',
];

/** Drawn diameters in world tiles. */
const TREE_SIZE = 1.95;
const STUMP_SIZE = 0.95;
const BUSH_SIZE = 1.35;
const GRASS_SIZE = 0.95;
const PILE_SIZE = 1.25;
const CLEARING_CELL = 6;
function cellKey(x: number, y: number): number {
  return Math.floor(x / CLEARING_CELL) * 4096 + Math.floor(y / CLEARING_CELL);
}
/** Timber fraction below which a tree is a stump. Mirrors the simulation constant. */
const STUMP_THRESHOLD = 0.2;

interface PlantParticles {
  main: Particle;
  shadow: Particle | null;
  canopy: boolean;
}

export class VegetationLayer {
  readonly shadows: ParticleContainer;
  readonly ground: ParticleContainer;
  readonly canopy: ParticleContainer;
  private readonly frames = new Map<Stamp, Texture>();
  private readonly byId = new Map<number, PlantParticles>();
  /** Worked ground (fields, huts) by coarse cell, so crowns over it can thin out. */
  private clearings = new Map<number, Array<{ x: number; y: number; r: number }>>();

  /**
   * Places the settlement has cleared: fields and hut footprints.
   *
   * A tree standing on one is drawn thin and translucent. The simulation lets
   * plants seed anywhere fertile, fields included, and at full opacity an
   * orchard of crowns buried the very farmland the observer is watching.
   */
  setClearings(points: Array<{ x: number; y: number; r: number }>): void {
    this.clearings = new Map();
    for (const p of points) {
      const key = cellKey(p.x, p.y);
      let list = this.clearings.get(key);
      if (!list) this.clearings.set(key, (list = []));
      list.push(p);
    }
  }

  private inClearing(x: number, y: number): boolean {
    const cx = Math.floor(x / CLEARING_CELL);
    const cy = Math.floor(y / CLEARING_CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.clearings.get((cx + dx) * 4096 + (cy + dy));
        if (!list) continue;
        for (const p of list) if (Math.hypot(p.x - x, p.y - y) < p.r) return true;
      }
    }
    return false;
  }

  constructor() {
    const atlas = paintAtlas();
    const source = Texture.from(atlas).source;
    source.scaleMode = 'linear';
    source.autoGenerateMipmaps = true;
    source.updateMipmaps();
    LAYOUT.forEach((name, i) => {
      const frame = new Rectangle((i % 8) * CELL, Math.floor(i / 8) * CELL, CELL, CELL);
      this.frames.set(name, new Texture({ source, frame }));
    });
    const options = { dynamicProperties: { position: false, vertex: false, rotation: false, uvs: false, color: false } };
    this.shadows = new ParticleContainer(options);
    this.ground = new ParticleContainer(options);
    this.canopy = new ParticleContainer(options);
  }

  /** Bring the particles in line with the plants in a snapshot. */
  sync(entities: EntityView[]): void {
    const seen = new Set<number>();
    for (const entity of entities) {
      if (entity.kind !== EntityKind.Plant) continue;
      seen.add(entity.id);
      const species = entity.sex; // plant species rides in the sex byte
      let entry = this.byId.get(entity.id);
      const wantCanopy = species === PlantSpecies.Tree && entity.size >= STUMP_THRESHOLD;
      if (!entry || entry.canopy !== wantCanopy) {
        entry = this.create(entity.id, wantCanopy, species);
        this.byId.set(entity.id, entry);
      }
      this.style(entry, entity, species);
    }
    for (const id of this.byId.keys()) if (!seen.has(id)) this.byId.delete(id);

    const shadows: Particle[] = [];
    const ground: Particle[] = [];
    const canopy: Particle[] = [];
    for (const entry of this.byId.values()) {
      if (entry.shadow) shadows.push(entry.shadow);
      (entry.canopy ? canopy : ground).push(entry.main);
    }
    // Draw south over north, so a tree lower on the screen overlaps the one behind it.
    canopy.sort((a, b) => a.y - b.y);
    ground.sort((a, b) => a.y - b.y);
    this.shadows.particleChildren = shadows;
    this.ground.particleChildren = ground;
    this.canopy.particleChildren = canopy;
    this.shadows.update();
    this.ground.update();
    this.canopy.update();
  }

  private create(id: number, canopy: boolean, species: number): PlantParticles {
    const main = new Particle({ texture: Texture.EMPTY, anchorX: 0.5, anchorY: 0.5 });
    const castsShadow = species === PlantSpecies.Tree || species === PlantSpecies.Bush;
    const shadow = castsShadow ? new Particle({ texture: this.frames.get('shadow')!, anchorX: 0.5, anchorY: 0.5 }) : null;
    void id;
    return { main, shadow, canopy };
  }

  private style(entry: PlantParticles, entity: EntityView, species: number): void {
    const h = hash(entity.id);
    const food = entity.health; // food fraction
    const main = entry.main;
    main.x = entity.x;
    main.y = entity.y;
    let size = 1;
    let texture: Stamp = 'grass0';
    main.alpha = 1;
    main.tint = 0xffffff;

    if (species === PlantSpecies.Tree) {
      const timber = entity.size;
      if (timber < STUMP_THRESHOLD) {
        texture = 'stump';
        size = STUMP_SIZE;
      } else {
        // A felled tree regrows as a young crown and fills out as timber returns.
        texture = timber < 0.45 ? 'young' : (`tree${Math.floor(h * 4)}` as Stamp);
        size = TREE_SIZE * (0.5 + 0.5 * timber) * (0.88 + 0.24 * fract(h * 7.3));
        main.tint = tintFor(h, 0.1);
        if (this.inClearing(entity.x, entity.y)) {
          main.alpha = 0.38;
          size *= 0.8;
        }
      }
    } else if (species === PlantSpecies.Bush) {
      texture = food > 0.55 ? (`berry${Math.floor(h * 2)}` as Stamp) : (`bush${Math.floor(h * 2)}` as Stamp);
      size = BUSH_SIZE * (0.85 + 0.3 * fract(h * 5.1));
      main.tint = tintFor(h, 0.08);
    } else if (species === PlantSpecies.FoodPile) {
      texture = 'pile';
      size = PILE_SIZE * (0.75 + 0.25 * Math.min(1, food));
    } else {
      texture = `grass${Math.floor(h * 3)}` as Stamp;
      size = GRASS_SIZE * (0.8 + 0.4 * fract(h * 3.7));
      // Grazed grass thins out rather than vanishing.
      main.alpha = 0.45 + 0.55 * Math.min(1, food);
    }
    main.texture = this.frames.get(texture)!;
    main.scaleX = main.scaleY = size / CELL;

    if (entry.shadow) {
      const s = entry.shadow;
      const reach = species === PlantSpecies.Tree ? (texture === 'stump' ? 0.2 : 0.5) : 0.22;
      s.x = entity.x + size * 0.16;
      s.y = entity.y + size * 0.2;
      s.scaleX = (size * (1 + reach * 0.4)) / CELL;
      s.scaleY = (size * (0.8 + reach * 0.2)) / CELL;
      s.alpha = (texture === 'stump' ? 0.35 : 0.8) * (main.alpha < 1 && species === PlantSpecies.Tree ? 0.4 : 1);
    }
  }
}

// --- atlas -----------------------------------------------------------------

function paintAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * 8;
  canvas.height = CELL * Math.ceil(LAYOUT.length / 8);
  const ctx = canvas.getContext('2d')!;
  LAYOUT.forEach((name, i) => {
    ctx.save();
    ctx.translate((i % 8) * CELL + CELL / 2, Math.floor(i / 8) * CELL + CELL / 2);
    const rand = seeded(i * 977 + 13);
    switch (name) {
      case 'tree0':
        paintCanopy(ctx, rand, ['#2f5a2a', '#4d8a3a', '#8cc15a'], 7);
        break;
      case 'tree1':
        paintCanopy(ctx, rand, ['#2c5230', '#467f41', '#7fb566'], 8);
        break;
      case 'tree2':
        paintCanopy(ctx, rand, ['#3a5a24', '#5e8f34', '#a8c95c'], 6);
        break;
      case 'tree3':
        paintCanopy(ctx, rand, ['#244a2e', '#3c7343', '#6fae6a'], 9);
        break;
      case 'young':
        paintCanopy(ctx, rand, ['#3f6a2c', '#62a042', '#a6d56a'], 5, 0.72);
        break;
      case 'stump':
        paintStump(ctx);
        break;
      case 'shadow':
        paintShadow(ctx);
        break;
      case 'pile':
        paintPile(ctx, rand);
        break;
      case 'bush0':
      case 'bush1':
        paintBush(ctx, rand, false);
        break;
      case 'berry0':
      case 'berry1':
        paintBush(ctx, rand, true);
        break;
      default:
        paintGrass(ctx, rand);
    }
    ctx.restore();
  });
  return canvas;
}

/** A crown of overlapping leaf clumps, each lit from the north-west. */
function paintCanopy(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  [dark, mid, light]: [string, string, string],
  clumps: number,
  spread = 1,
): void {
  const R = CELL * 0.46 * spread;
  // Dark underside first: gives the crown its silhouette and depth.
  ctx.fillStyle = dark;
  blob(ctx, 0, 0, R * 0.92, rand, 14);
  const centres: Array<[number, number, number]> = [];
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * Math.PI * 2 + rand() * 0.6;
    const d = R * (0.38 + rand() * 0.22);
    centres.push([Math.cos(a) * d, Math.sin(a) * d, R * (0.36 + rand() * 0.14)]);
  }
  centres.push([-R * 0.08, -R * 0.1, R * 0.42]);
  // Clumps further south-east first, so the lit north-west ones sit on top.
  centres.sort((a, b) => b[0] + b[1] - (a[0] + a[1]));
  for (const [x, y, r] of centres) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, light);
    g.addColorStop(0.55, mid);
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    blob(ctx, x, y, r, rand, 9);
  }
  // Leaf texture: small highlights on the lit side.
  for (let i = 0; i < 70; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * R * 0.85;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const lit = (-x - y) / (R * 1.4);
    ctx.globalAlpha = Math.max(0, 0.12 + lit * 0.35);
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(x, y, 1.2 + rand() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // A soft rim so crowns separate from each other in a dense stand.
  ctx.strokeStyle = 'rgba(12, 28, 14, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.93, 0, Math.PI * 2);
  ctx.stroke();
}

function paintStump(ctx: CanvasRenderingContext2D): void {
  const R = CELL * 0.3;
  const g = ctx.createRadialGradient(-R * 0.3, -R * 0.3, 2, 0, 0, R);
  g.addColorStop(0, '#d7b07a');
  g.addColorStop(0.7, '#a77b4a');
  g.addColorStop(1, '#5b3f22');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, R, R * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(90, 60, 30, 0.55)';
  ctx.lineWidth = 1.5;
  for (let r = R * 0.25; r < R; r += R * 0.22) {
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = '#3e2a16';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, 0, R, R * 0.92, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function paintShadow(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(0, 0, CELL * 0.08, 0, 0, CELL * 0.48);
  g.addColorStop(0, 'rgba(8, 18, 12, 0.55)');
  g.addColorStop(0.65, 'rgba(8, 18, 12, 0.32)');
  g.addColorStop(1, 'rgba(8, 18, 12, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, CELL * 0.48, 0, Math.PI * 2);
  ctx.fill();
}

function paintBush(ctx: CanvasRenderingContext2D, rand: () => number, berries: boolean): void {
  const R = CELL * 0.4;
  ctx.fillStyle = '#26431f';
  blob(ctx, 0, 0, R * 0.95, rand, 12);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand();
    const d = R * 0.42;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const r = R * (0.42 + rand() * 0.12);
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 1, x, y, r);
    g.addColorStop(0, '#79a954');
    g.addColorStop(0.6, '#3f6d31');
    g.addColorStop(1, '#223d1d');
    ctx.fillStyle = g;
    blob(ctx, x, y, r, rand, 8);
  }
  if (berries) {
    for (let i = 0; i < 16; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * R * 0.78;
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      ctx.fillStyle = '#5a0f1c';
      ctx.beginPath();
      ctx.arc(x + 1, y + 1, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d6384a';
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 220, 220, 0.8)';
      ctx.beginPath();
      ctx.arc(x - 1.1, y - 1.1, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function paintGrass(ctx: CanvasRenderingContext2D, rand: () => number): void {
  // A tuft of blades from a common root, lighter at the tips.
  for (let i = 0; i < 22; i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 2.4;
    const len = CELL * (0.18 + rand() * 0.24);
    const bx = (rand() - 0.5) * CELL * 0.22;
    const by = CELL * 0.1 + (rand() - 0.5) * CELL * 0.12;
    const tx = bx + Math.cos(a) * len;
    const ty = by + Math.sin(a) * len;
    const g = ctx.createLinearGradient(bx, by, tx, ty);
    g.addColorStop(0, '#2f5424');
    g.addColorStop(1, rand() < 0.3 ? '#c9d77a' : '#86b95a');
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.2 + rand() * 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + (tx - bx) * 0.3 + (rand() - 0.5) * 8, by + (ty - by) * 0.6, tx, ty);
    ctx.stroke();
  }
}

function paintPile(ctx: CanvasRenderingContext2D, rand: () => number): void {
  // A woven basket of produce: grain, roots and berries.
  const R = CELL * 0.32;
  ctx.fillStyle = 'rgba(10, 16, 10, 0.35)';
  ctx.beginPath();
  ctx.ellipse(R * 0.2, R * 0.3, R * 1.05, R * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(-R * 0.3, -R * 0.3, 2, 0, 0, R);
  g.addColorStop(0, '#d9a45c');
  g.addColorStop(1, '#6b4420');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(70, 40, 16, 0.6)';
  ctx.lineWidth = 1.4;
  for (let r = R * 0.35; r < R; r += R * 0.2) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const colours = ['#e8c35a', '#f0d27a', '#c84a3a', '#e07b3a', '#b8d06a'];
  for (let i = 0; i < 20; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * R * 0.72;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const r = 3 + rand() * 3.5;
    ctx.fillStyle = colours[Math.floor(rand() * colours.length)];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 250, 230, 0.55)';
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#3e2610';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.stroke();
}

/** A slightly irregular disc: a circle whose radius wobbles around the edge. */
function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rand: () => number, lobes: number): void {
  const phases = Array.from({ length: 3 }, () => rand() * Math.PI * 2);
  ctx.beginPath();
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble =
      1 + 0.07 * Math.sin(a * lobes + phases[0]) + 0.04 * Math.sin(a * (lobes + 3) + phases[1]) + 0.03 * Math.sin(a * 2 + phases[2]);
    const px = x + Math.cos(a) * r * wobble;
    const py = y + Math.sin(a) * r * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hash(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

/** A near-white tint, so otherwise identical stamps differ slightly in hue and value. */
function tintFor(h: number, amount: number): number {
  const k = 1 - amount * fract(h * 13.7);
  const warm = fract(h * 29.1) > 0.5;
  const r = Math.round(255 * (warm ? 1 : k));
  const g = Math.round(255 * (1 - amount * 0.3 * fract(h * 3.3)));
  const b = Math.round(255 * k);
  return (r << 16) | (g << 8) | b;
}
