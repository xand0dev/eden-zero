import { Container, Graphics } from 'pixi.js';
import type { CanalView, FieldView } from '../shared/types';
import { isWater, type TerrainData } from '../simulation/environment/terrain';

/**
 * Fields and the canals that water them.
 *
 * A field is tilled ground: furrows, then rows of a crop that thickens and
 * turns gold as it ripens. The soil itself carries the irrigation state — dark
 * and wet where water reaches it, pale and cracked where it does not — so the
 * observer can see a canal's effect without reading a number.
 *
 * Canals are drawn as what they are: a channel. Lengths within reach of each
 * other are joined by a trench cut through an earth bank, the lengths nearest
 * the shore are joined to the water, and the trench fills once water flows.
 */

/** Two canal lengths this close are one channel. Mirrors `CANAL_LINK` in the world. */
const CANAL_LINK = 3.2;
/** A flowing length this close to open water is fed by it. Mirrors `CANAL_SOURCE_RANGE`. */
const SOURCE_RANGE = 4;
const PLOT = 2.8;

const SOIL_WET = 0x3d2a1a;
const SOIL = 0x6a4a2c;
const SOIL_DRY = 0x9c8360;
const FURROW = 0x2a1c10;
const BANK = 0x7a5e3c;
const TRENCH = 0x3a2a1a;
const WATER = 0x3a8fb4;
const WATER_LIGHT = 0x8fd0e4;

export class CultivationLayer {
  readonly container = new Container();
  private readonly canals = new Graphics();
  private readonly fields = new Map<number, { graphic: Graphics; key: string }>();
  private canalKey = '';

  constructor() {
    this.container.addChild(this.canals);
  }

  update(fields: FieldView[], canals: CanalView[], terrain: TerrainData | null): void {
    this.drawCanals(canals, terrain);

    const seen = new Set<number>();
    for (const field of fields) {
      seen.add(field.id);
      const key = `${field.stage}|${Math.round(field.growth * 12)}|${Math.round(Math.min(1, field.moisture) * 8)}`;
      let entry = this.fields.get(field.id);
      if (!entry) {
        entry = { graphic: new Graphics(), key: '' };
        entry.graphic.position.set(field.x, field.y);
        this.container.addChild(entry.graphic);
        this.fields.set(field.id, entry);
      }
      if (entry.key !== key) {
        entry.key = key;
        drawField(entry.graphic, field);
      }
    }
    for (const [id, entry] of this.fields) {
      if (seen.has(id)) continue;
      entry.graphic.destroy();
      this.fields.delete(id);
    }
  }

  private drawCanals(canals: CanalView[], terrain: TerrainData | null): void {
    let key = '';
    for (const canal of canals) key += `${canal.id}${canal.complete ? 'c' : Math.round(canal.progress * 5)}${canal.flowing ? 'f' : ''},`;
    if (key === this.canalKey) return;
    this.canalKey = key;

    const g = this.canals.clear();
    // A channel is a branching line, not a mesh: every length was staked
    // beside one that already existed (or beside the shore), so join each length
    // to its nearest *older* neighbour and nothing else. Ids grow with time.
    const segments: Array<{ ax: number; ay: number; bx: number; by: number; wet: boolean; dug: boolean }> = [];
    const ordered = [...canals].sort((a, b) => a.id - b.id);
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      let parent: CanalView | null = null;
      let best = CANAL_LINK;
      for (let j = 0; j < i; j++) {
        const b = ordered[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d <= best) {
          best = d;
          parent = b;
        }
      }
      const shore = terrain ? nearestWater(terrain, a.x, a.y, SOURCE_RANGE + 0.5) : null;
      if (parent && (!shore || Math.hypot(shore.x - a.x, shore.y - a.y) > best)) {
        segments.push({ ax: a.x, ay: a.y, bx: parent.x, by: parent.y, dug: a.complete && parent.complete, wet: a.flowing && parent.flowing });
      } else if (shore) {
        segments.push({ ax: a.x, ay: a.y, bx: shore.x, by: shore.y, dug: a.complete, wet: a.flowing });
      }
    }

    // A length staked on the shallows is already in the water: no bank, no
    // trench, nothing to draw over the sea.
    const wetTile = (x: number, y: number): boolean =>
      terrain !== null && isWater(terrain.tiles[Math.floor(y) * terrain.width + Math.floor(x)]);
    const land = canals.filter((c) => !wetTile(c.x, c.y));

    // Earth banks under everything, then trenches, then water: three passes so
    // joins between segments are seamless.
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      const aWet = wetTile(s.ax, s.ay);
      const bWet = wetTile(s.bx, s.by);
      if (aWet && bWet) {
        segments.splice(i, 1);
        continue;
      }
      // A channel ends at the water's edge; it does not run out into the sea.
      if (bWet) [s.bx, s.by] = pullToShore(s.bx, s.by, s.ax, s.ay, wetTile);
      if (aWet) [s.ax, s.ay] = pullToShore(s.ax, s.ay, s.bx, s.by, wetTile);
    }
    for (const s of segments) g.moveTo(s.ax, s.ay).lineTo(s.bx, s.by).stroke({ color: BANK, width: 0.82, cap: 'round', alpha: 0.8 });
    for (const c of land) g.circle(c.x, c.y, 0.42).fill({ color: BANK, alpha: 0.8 });
    for (const s of segments) {
      if (!s.dug) continue;
      g.moveTo(s.ax, s.ay).lineTo(s.bx, s.by).stroke({ color: TRENCH, width: 0.5, cap: 'round' });
    }
    for (const c of land) {
      if (c.complete) g.circle(c.x, c.y, 0.25).fill(TRENCH);
    }
    for (const s of segments) {
      if (!s.wet) continue;
      g.moveTo(s.ax, s.ay).lineTo(s.bx, s.by).stroke({ color: WATER, width: 0.36, cap: 'round' });
      g.moveTo(s.ax, s.ay).lineTo(s.bx, s.by).stroke({ color: WATER_LIGHT, width: 0.09, cap: 'round', alpha: 0.55 });
    }
    for (const c of land) {
      if (c.flowing) g.circle(c.x, c.y, 0.18).fill(WATER);
      if (!c.complete) {
        // An unfinished length: a pit that deepens as it is dug, and a stake.
        g.circle(c.x, c.y, 0.18 + 0.2 * c.progress).fill({ color: TRENCH, alpha: 0.9 });
        g.rect(c.x + 0.35, c.y - 0.45, 0.07, 0.4).fill(0xb58a52);
      }
    }
  }
}

function drawField(g: Graphics, field: FieldView): void {
  g.clear();
  const h = hash(field.id);
  const half = PLOT / 2;
  const moisture = Math.max(0, Math.min(1, field.moisture));
  const soil = moisture > 0.5 ? mix(SOIL, SOIL_WET, (moisture - 0.5) / 0.5) : mix(SOIL_DRY, SOIL, moisture / 0.5);

  // The plot: tilled ground with a raised edge, slightly irregular.
  const wob = (k: number): number => (hash(field.id * 7 + k) - 0.5) * 0.18;
  const corners = [
    [-half + wob(1), -half + wob(2)],
    [half + wob(3), -half + wob(4)],
    [half + wob(5), half + wob(6)],
    [-half + wob(7), half + wob(8)],
  ].flat();
  g.poly(corners).fill({ color: 0x000000, alpha: 0.18 });
  g.poly(corners.map((v, i) => v - (i % 2 === 0 ? 0.06 : 0.06))).fill(soil).stroke({ color: mix(soil, 0x1a120a, 0.5), width: 0.07, join: 'round' });

  // Furrows, in one of two orientations per field.
  const across = h > 0.5;
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    const t = -half + 0.32 + (r * (PLOT - 0.64)) / (rows - 1);
    const [x0, y0, x1, y1] = across ? [-half + 0.25, t, half - 0.25, t] : [t, -half + 0.25, t, half - 0.25];
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: FURROW, width: 0.1, alpha: 0.55, cap: 'round' });
    g.moveTo(x0 - 0.05, y0 - 0.06).lineTo(x1 - 0.05, y1 - 0.06).stroke({ color: 0xffffff, width: 0.035, alpha: 0.08 });
  }

  // Cracks when the ground has dried out.
  if (moisture < 0.3) {
    const crack = 0x5a4430;
    for (let i = 0; i < 5; i++) {
      const cx = (hash(field.id * 13 + i) - 0.5) * (PLOT - 0.8);
      const cy = (hash(field.id * 17 + i) - 0.5) * (PLOT - 0.8);
      g.moveTo(cx, cy)
        .lineTo(cx + 0.22, cy + 0.1)
        .lineTo(cx + 0.3, cy + 0.32)
        .stroke({ color: crack, width: 0.04, alpha: 0.8 });
    }
  }

  if (field.stage === 0) return;

  // The crop: rows of plants that fill out and turn gold.
  const ripe = field.stage === 2;
  const growth = ripe ? 1 : Math.max(0.05, field.growth);
  const leaf = ripe ? 0xd9b04a : mix(0x6fae3e, 0xa8b848, Math.max(0, growth - 0.6) / 0.4);
  const tip = ripe ? 0xf5dc86 : mix(0x9fd46a, 0xd8d27a, Math.max(0, growth - 0.7) / 0.3);
  // Each row is a continuous line of stems with leaves or ears along it.
  const stems = 9;
  for (let r = 0; r < rows; r++) {
    const t = -half + 0.32 + (r * (PLOT - 0.64)) / (rows - 1) - 0.05;
    const [x0, y0, x1, y1] = across ? [-half + 0.28, t, half - 0.28, t] : [t, -half + 0.28, t, half - 0.28];
    const width = 0.05 + 0.16 * growth;
    g.moveTo(x0 + 0.04, y0 + 0.06).lineTo(x1 + 0.04, y1 + 0.06).stroke({ color: 0x000000, width, alpha: 0.2, cap: 'round' });
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: leaf, width, cap: 'round' });
    for (let k = 0; k < stems; k++) {
      const u = (k + 0.5) / stems;
      const px = x0 + (x1 - x0) * u;
      const py = y0 + (y1 - y0) * u;
      const lean = (hash(field.id * 31 + r * 11 + k) - 0.5) * 0.12;
      const len = (0.07 + 0.16 * growth) * (ripe ? 1.1 : 1);
      // Leaves (or ears) tilt toward the light, north-west.
      const ex = px - len * 0.7 + lean;
      const ey = py - len;
      g.moveTo(px, py).lineTo(ex, ey).stroke({ color: tip, width: ripe ? 0.075 : 0.05, cap: 'round' });
      if (ripe) g.ellipse(ex, ey, 0.06, 0.035).fill(0xf8e39a);
    }
  }
  if (ripe) {
    // A soft golden glow: a ripe field should be the brightest thing in the valley.
    g.poly(corners).fill({ color: 0xffd76a, alpha: 0.08 });
  }
}

/** Walk a wet endpoint back toward the dry one until it reaches the shore. */
function pullToShore(
  wx: number,
  wy: number,
  dx: number,
  dy: number,
  wet: (x: number, y: number) => boolean,
): [number, number] {
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = wx + (dx - wx) * t;
    const y = wy + (dy - wy) * t;
    if (!wet(x, y)) return [x, y];
  }
  return [dx, dy];
}

function nearestWater(terrain: TerrainData, x: number, y: number, range: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  const r = Math.ceil(range);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= terrain.width || ty >= terrain.height) continue;
      if (!isWater(terrain.tiles[ty * terrain.width + tx])) continue;
      const px = tx + 0.5;
      const py = ty + 0.5;
      const d = Math.hypot(px - x, py - y);
      if (d < bestD && d <= range) {
        bestD = d;
        best = { x: px, y: py };
      }
    }
  }
  return best;
}

function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const r = ((a >> 16) & 0xff) + ((((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
  const g = ((a >> 8) & 0xff) + ((((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
  const bl = (a & 0xff) + (((b & 0xff) - (a & 0xff)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

function hash(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
