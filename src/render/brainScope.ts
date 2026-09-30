import {
  LOCAL_COUNT,
  LOCAL_START,
  MOD_COUNT,
  MOD_START,
  MOTOR_COUNT,
  MOTOR_NAMES,
  MOTOR_START,
  NEURON_COUNT,
  RECURRENT_COUNT,
  RECURRENT_START,
  S,
  SENSORY_COUNT,
  SENSORY_NAMES,
  labelNeuron,
  regionOf,
} from '../simulation/brain/channels';
import type { BrainView, ExplanationView } from '../shared/types';

/**
 * BrainScope — the live brain, drawn as an instrument.
 *
 * Layout follows the signal: senses on an arc to the left, grouped by what they
 * sense; local circuits inside them; the recurrent core as a disc in the centre
 * with the neuromodulatory ring around it; motors on an arc to the right, each
 * with its command. Synapses curve in through the core.
 *
 * Everything that moves is data from the simulation:
 *
 *  - **Spikes.** The worker reports how many times each neuron fired since the
 *    last update; each spike sends an impulse down that neuron's displayed
 *    synapses over the next ~120 ms and pops the neuron white. Sensory channels
 *    are graded, not spiking, so their impulses are drawn at a density set by the
 *    input strength — the legend says so.
 *  - **Feeling.** The plasticity valence (reward positive, pain negative) sends a
 *    gold or crimson wave out from the core when it swings.
 *  - **Learning.** In learning view, synapses are coloured by how far they have
 *    moved from the weight the individual was born with, including the ones a
 *    lifetime has rewritten most.
 *  - **Decisions.** The winning motor is haloed; a change of action sends a
 *    shockwave out from its neuron, and a ribbon of past choices runs above the
 *    spike raster on the same time axis.
 *  - **Body.** Around the porthole onto the world: which way the person senses
 *    food, water, kin and threat, and how hungry, thirsty, tired and hurt they are.
 *
 * Pure Canvas 2D: additive sprites, a quarter-resolution bloom pass, one
 * requestAnimationFrame loop. Optional WebAudio sonification of the same data.
 */

export type ScopeMode = 'compact' | 'full';

/** Region colours: sensory, local, recurrent, modulatory, motor. */
const REGION_RGB: Array<[number, number, number]> = [
  [110, 231, 168],
  [110, 178, 255],
  [184, 146, 255],
  [255, 206, 92],
  [255, 138, 61],
  [255, 236, 150],
];
const REGION_LABEL = ['SENSES', 'LOCAL CIRCUITS', 'RECURRENT CORE', 'NEUROMODULATION', 'ACTIONS', 'GROWN'];
/** A grown neuron that drives its muscle, and one that holds it back. */
const GROWN_DRIVE_RGB: [number, number, number] = [255, 214, 110];
const GROWN_CURB_RGB: [number, number, number] = [120, 220, 240];

/** Sensory channels grouped by what they sense: [label, first, end). */
const SENSORY_GROUPS: Array<[string, number, number]> = [
  ['FOOD', 0, 4],
  ['WATER', 4, 8],
  ['KIN', 8, 12],
  ['THREAT', 12, 16],
  ['BODY', 16, 21],
  ['NEEDS', 21, 27],
  ['BOND', 27, 32],
  ['WOOD', 32, 36],
  ['BUILD', 36, 40],
  ['CAMP', 40, 44],
  ['FOREST', 44, 48],
  ['FIELD', 48, 52],
  ['CANAL', 52, 56],
  ['FARM', 56, 64],
];

/** What each motor is, for the decision ribbon: [category, colour]. */
const ACTION_KIND: Array<[string, string]> = [
  ['move', '#5f7a96'],
  ['move', '#5f7a96'],
  ['move', '#5f7a96'],
  ['move', '#5f7a96'],
  ['move', '#7f9ab6'],
  ['eat & drink', '#5fd08a'],
  ['eat & drink', '#4fb8e8'],
  ['rest', '#8a7fe0'],
  ['fight', '#ef5a4a'],
  ['social', '#f08ab8'],
  ['social', '#f08ab8'],
  ['social', '#f08ab8'],
  ['build', '#c8905a'],
  ['build', '#c8905a'],
  ['farm', '#e8c85a'],
  ['farm', '#e8c85a'],
  ['farm', '#e8c85a'],
];
const RIBBON_LEGEND: Array<[string, string]> = [
  ['move', '#5f7a96'],
  ['eat & drink', '#5fd08a'],
  ['rest', '#8a7fe0'],
  ['social', '#f08ab8'],
  ['build', '#c8905a'],
  ['farm', '#e8c85a'],
  ['fight', '#ef5a4a'],
];

const EXCITE = [255, 176, 96] as const;
const INHIBIT = [96, 196, 255] as const;
const GROWN = [255, 214, 110] as const;
const WEAKENED = [168, 120, 255] as const;

interface Curve {
  pre: number;
  post: number;
  w: number;
  drift: number;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
}

interface Pulse {
  curve: Curve;
  t: number;
  speed: number;
  /** A recorded spike, rather than graded sensory drive. */
  real: boolean;
}

interface Pending {
  curve: Curve;
  at: number;
  real: boolean;
}

interface Ring {
  x: number;
  y: number;
  t: number;
  life: number;
  rgb: readonly [number, number, number] | [number, number, number];
  reach: number;
  width: number;
}

interface Layout {
  x: Float32Array;
  y: Float32Array;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  coreX: number;
  coreY: number;
  coreR: number;
  groupLabels: Array<{ text: string; x: number; y: number }>;
  motorDir: Array<[number, number]>;
  rasterY: number;
  rasterH: number;
  /** Full view only: a window onto the living world, where the person is shown. */
  porthole: { x: number; y: number; r: number } | null;
}

/** Map from `labelNeuron(i)` to `i`, to find the trace's neurons by name. */
const LABEL_INDEX = new Map<string, number>();
for (let i = 0; i < NEURON_COUNT; i++) LABEL_INDEX.set(labelNeuron(i), i);

/**
 * Raster, population trace and decision ribbon, shared by every scope on the
 * page, so expanding shows the last forty seconds at once and each brain
 * update is recorded once however many scopes are open.
 */
const history: {
  entityId: number;
  lastBrain: BrainView | null;
  raster: HTMLCanvasElement | null;
  population: number[];
  actions: number[];
} = { entityId: -1, lastBrain: null, raster: null, population: [], actions: [] };
const HISTORY = 360;

export class BrainScope {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private mode: ScopeMode = 'compact';
  private width = 0;
  private height = 0;
  private dpr = 1;
  private layout: Layout | null = null;
  private raf = 0;
  private last = 0;
  private clock = 0;

  private brain: BrainView | null = null;
  private explain: ExplanationView | null = null;
  private name = '';
  private readonly shown = new Float32Array(NEURON_COUNT);
  private readonly target = new Float32Array(NEURON_COUNT);
  private readonly pop = new Float32Array(NEURON_COUNT);
  private readonly motorShown = new Float32Array(MOTOR_COUNT);
  private lead = 0;
  private leadSince = 0;
  private valence = 0;
  private valenceShown = 0;
  private lastWave = -10;

  private curves: Curve[] = [];
  private learnedCurves: Curve[] = [];
  private pending: Pending[] = [];
  private pulses: Pulse[] = [];
  private rings: Ring[] = [];
  private path: number[] = [];
  private learnedPath: number[] = [];

  private learning = false;
  private sound: BrainSound | null = null;

  private readonly glow: HTMLCanvasElement[];
  private readonly spark: HTMLCanvasElement[];
  private bloom: HTMLCanvasElement | null = null;
  private readonly bloomSupported: boolean;

  hover = -1;
  private pointer = { x: 0, y: 0 };
  private portholeEnabled = false;
  private onPorthole: ((geometry: { x: number; y: number; r: number } | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.glow = REGION_RGB.map((rgb) => glowSprite(rgb, 64));
    this.spark = [
      glowSprite([255, 200, 130], 32),
      glowSprite([130, 210, 255], 32),
      glowSprite([255, 255, 255], 32),
      glowSprite([255, 226, 150], 32),
      glowSprite([180, 140, 255], 32),
    ];
    // Canvas filters (for the bloom blur) are missing in older WebKit; without
    // them an unblurred copy would just double the brightness, so skip it.
    ctx.filter = 'blur(1px)';
    this.bloomSupported = ctx.filter === 'blur(1px)';
    ctx.filter = 'none';
    canvas.addEventListener('mousemove', this.onMove);
    canvas.addEventListener('mouseleave', this.onLeave);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('mousemove', this.onMove);
    this.canvas.removeEventListener('mouseleave', this.onLeave);
    this.sound?.close();
    this.sound = null;
  }

  setMode(mode: ScopeMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.layout = null;
  }

  setLearning(on: boolean): void {
    this.learning = on;
  }

  /** Turn the sonification on or off. Must be called from a user gesture to start audio. */
  setSound(on: boolean): void {
    if (on && !this.sound) this.sound = new BrainSound();
    if (!on && this.sound) {
      this.sound.close();
      this.sound = null;
    }
  }

  /** Cut a window onto the world in the full view; the callback learns where it is. */
  enablePorthole(onChange: (geometry: { x: number; y: number; r: number } | null) => void): void {
    this.portholeEnabled = true;
    this.onPorthole = onChange;
    this.layout = null;
  }

  setData(brain: BrainView | null, explain: ExplanationView | null, name: string): void {
    this.name = name;
    this.explain = explain;
    if (explain) {
      this.path = explain.path.map((node) => LABEL_INDEX.get(node.label) ?? -1).filter((i) => i >= 0);
      this.learnedPath = explain.learnedPath.map((node) => LABEL_INDEX.get(node.label) ?? -1).filter((i) => i >= 0);
    }
    if (!brain || brain === this.brain) return;
    const first = this.brain === null || this.brain.entityId !== brain.entityId;
    this.brain = brain;
    const L = this.layout;

    for (let i = 0; i < NEURON_COUNT; i++) {
      const next = Math.max(0, Math.min(1, brain.activity[i] ?? 0));
      if (!first && next - this.target[i] > 0.3 && L) this.ring(L.x[i], L.y[i], 0.8, REGION_RGB[regionOf(i)], this.full ? 26 : 14, 1.4);
      this.target[i] = next;
      if (first) this.shown[i] = next;
      const spikes = brain.spikes?.[i] ?? 0;
      if (spikes > 0) this.pop[i] = Math.min(1, 0.45 + spikes * 0.2);
    }

    let lead = 0;
    for (let m = 1; m < MOTOR_COUNT; m++) if ((brain.motor[m] ?? 0) > (brain.motor[lead] ?? 0)) lead = m;
    if (lead !== this.lead) {
      this.lead = lead;
      this.leadSince = this.clock;
      if (L && !first) {
        const i = MOTOR_START + lead;
        // A decision: a shockwave out of the winning motor across the brain.
        this.ring(L.x[i], L.y[i], 1.4, [255, 190, 130], Math.max(L.rx, L.ry) * 1.3, 2.2);
        this.ring(L.x[i], L.y[i], 0.7, [255, 236, 210], this.full ? 44 : 22, 2);
        this.sound?.decision(lead);
      }
    }

    // Feeling: a wave from the core when the valence swings.
    const valence = brain.valence ?? 0;
    if (L && !first && Math.abs(valence) > 0.12 && (this.clock - this.lastWave > 0.7 || Math.sign(valence) !== Math.sign(this.valence))) {
      this.lastWave = this.clock;
      const rgb: [number, number, number] = valence > 0 ? [255, 206, 110] : [255, 70, 80];
      this.ring(L.coreX, L.coreY, 1.8, rgb, Math.max(L.rx, L.ry) * 1.25, 3 + Math.abs(valence) * 6);
      this.sound?.feeling(valence);
    }
    this.valence = valence;

    if (first) {
      this.pulses = [];
      this.pending = [];
    }
    this.buildCurves();
    this.schedulePulses(brain);
    this.sound?.spikes(brain);
    recordHistory(brain, lead);
  }

  private get full(): boolean {
    return this.mode === 'full';
  }

  private ring(
    x: number,
    y: number,
    life: number,
    rgb: readonly [number, number, number] | [number, number, number],
    reach: number,
    width: number,
  ): void {
    this.rings.push({ x, y, t: 0, life, rgb, reach, width });
    if (this.rings.length > 80) this.rings.splice(0, this.rings.length - 80);
  }

  // --- layout ------------------------------------------------------------------

  private resize(): boolean {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return false;
    if (width !== this.width || height !== this.height || dpr !== this.dpr || !this.layout) {
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.layout = this.computeLayout();
      this.bloom = document.createElement('canvas');
      this.bloom.width = Math.max(1, Math.round(width / 4));
      this.bloom.height = Math.max(1, Math.round(height / 4));
      this.buildCurves();
      this.onPorthole?.(this.layout.porthole);
    }
    return true;
  }

  private computeLayout(): Layout {
    const full = this.full;
    const w = this.width;
    const h = this.height;
    const rasterH = full ? Math.min(110, h * 0.12) : 0;
    const top = full ? 136 : 10;
    const bottom = full ? rasterH + 64 : 10;
    const availH = h - top - bottom;
    const cx = w * (full ? 0.43 : 0.5);
    const cy = top + availH / 2;
    const rx = Math.min(w * (full ? 0.3 : 0.42), availH * (full ? 1.05 : 1.2));
    const ry = availH * 0.46;
    const x = new Float32Array(NEURON_COUNT);
    const y = new Float32Array(NEURON_COUNT);
    const onEllipse = (angle: number, k: number): [number, number] => [cx + Math.cos(angle) * rx * k, cy + Math.sin(angle) * ry * k];
    const deg = Math.PI / 180;

    const gap = 1.8;
    const slots = SENSORY_GROUPS.reduce((n, [, a, b]) => n + (b - a), 0) + gap * (SENSORY_GROUPS.length - 1);
    const from = 236 * deg;
    const to = 124 * deg;
    let slot = 0;
    const groupLabels: Layout['groupLabels'] = [];
    for (const [label, a, b] of SENSORY_GROUPS) {
      const startSlot = slot;
      for (let i = a; i < b; i++) {
        const angle = from + ((slot + 0.5) / slots) * (to - from);
        [x[i], y[i]] = onEllipse(angle, 1);
        slot++;
      }
      const mid = from + (((startSlot + slot) / 2) / slots) * (to - from);
      const [lx, ly] = onEllipse(mid, 1.1);
      groupLabels.push({ text: label, x: lx, y: ly });
      slot += gap;
    }

    for (let i = 0; i < LOCAL_COUNT; i++) {
      const row = i % 2;
      const k = row === 0 ? 0.8 : 0.72;
      const angle = 228 * deg + ((Math.floor(i / 2) + 0.25 + row * 0.5) / (LOCAL_COUNT / 2)) * (132 - 228) * deg;
      [x[LOCAL_START + i], y[LOCAL_START + i]] = onEllipse(angle, k);
    }

    const coreX = cx + rx * 0.06;
    const coreY = cy;
    const coreR = Math.min(ry * 0.5, rx * 0.36);
    for (let i = 0; i < RECURRENT_COUNT; i++) {
      const r = coreR * Math.sqrt((i + 0.5) / RECURRENT_COUNT);
      const a = i * 2.39996323;
      x[RECURRENT_START + i] = coreX + Math.cos(a) * r * 1.18;
      y[RECURRENT_START + i] = coreY + Math.sin(a) * r;
    }
    for (let i = 0; i < MOD_COUNT; i++) {
      const a = -Math.PI / 2 + (i / MOD_COUNT) * Math.PI * 2;
      x[MOD_START + i] = coreX + Math.cos(a) * coreR * 1.18 * 1.22;
      y[MOD_START + i] = coreY + Math.sin(a) * coreR * 1.22;
    }

    const motorDir: Array<[number, number]> = [];
    for (let i = 0; i < MOTOR_COUNT; i++) {
      const angle = (-50 + (i / (MOTOR_COUNT - 1)) * 100) * deg;
      [x[MOTOR_START + i], y[MOTOR_START + i]] = onEllipse(angle, 1);
      const dx = Math.cos(angle) / rx;
      const dy = Math.sin(angle) / ry;
      const len = Math.hypot(dx, dy);
      motorDir.push([dx / len, dy / len]);
    }

    const rasterY = h - rasterH - 30;
    let porthole: Layout['porthole'] = null;
    if (full && this.portholeEnabled && w > 900) {
      const r = Math.min(132, h * 0.13, w * 0.075);
      porthole = { x: w - r - 80, y: rasterY - r - 132, r };
    }
    return { x, y, cx, cy, rx, ry, coreX, coreY, coreR, groupLabels, motorDir, rasterY, rasterH, porthole };
  }

  private buildCurves(): void {
    const brain = this.brain;
    const L = this.layout;
    if (!brain || !L) return;
    const curve = ([pre, post, w, drift]: [number, number, number, number]): Curve => {
      const x0 = L.x[pre];
      const y0 = L.y[pre];
      const x1 = L.x[post];
      const y1 = L.y[post];
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const inCore = regionOf(pre) >= 2 && regionOf(post) >= 2 && regionOf(pre) <= 3 && regionOf(post) <= 3;
      let cx = mx + (L.coreX - mx) * (inCore ? 0 : 0.45);
      let cy = my + (L.coreY - my) * (inCore ? 0 : 0.45);
      if (inCore) {
        cx += -(y1 - y0) * 0.25;
        cy += (x1 - x0) * 0.25;
      }
      return { pre, post, w, drift: drift ?? 0, x0, y0, cx, cy, x1, y1 };
    };
    this.curves = brain.synapses.map(curve);
    this.learnedCurves = (brain.learned ?? []).map(curve);
  }

  /** Turn this update's spikes into impulses spread over the next update interval. */
  private schedulePulses(brain: BrainView): void {
    const cap = this.full ? 1800 : 500;
    const window = 0.12;
    const curves = this.learning ? [...this.curves, ...this.learnedCurves] : this.curves;
    for (const c of curves) {
      if (this.pending.length > cap) break;
      if (c.pre < SENSORY_COUNT) {
        // Graded input: impulses at a density set by how strongly it is sensed.
        const drive = this.target[c.pre];
        const expected = drive * drive * Math.min(1.4, Math.abs(c.w)) * (this.full ? 0.5 : 0.25);
        if (Math.random() < expected) this.pending.push({ curve: c, at: this.clock + Math.random() * window, real: false });
        continue;
      }
      // One impulse per synapse per update at most: at thousands of spikes a
      // second, drawing every one turned the core into a single white blob.
      // Stronger synapses carry a spike more often, so the thinning keeps the
      // picture of which pathways are busy.
      const spikes = brain.spikes?.[c.pre] ?? 0;
      if (spikes > 0 && Math.random() < Math.min(0.85, 0.25 + Math.abs(c.w) * 0.35 + spikes * 0.08)) {
        this.pending.push({ curve: c, at: this.clock + Math.random() * window, real: true });
      }
    }
  }

  // --- frame ---------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    if (!this.resize() || !this.layout) return;
    const ctx = this.ctx;
    const L = this.layout;
    const full = this.full;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const k = Math.min(1, dt * 9);
    for (let i = 0; i < NEURON_COUNT; i++) {
      this.shown[i] += (this.target[i] - this.shown[i]) * k;
      this.pop[i] *= Math.exp(-dt * 7);
    }
    if (this.brain) {
      for (let m = 0; m < MOTOR_COUNT; m++) this.motorShown[m] += ((this.brain.motor[m] ?? 0) - this.motorShown[m]) * k;
    }
    this.valenceShown += (this.valence - this.valenceShown) * Math.min(1, dt * 4);
    this.advance(dt);

    this.drawBackground(ctx, L);
    if (!this.brain) {
      ctx.fillStyle = 'rgba(160, 180, 200, 0.6)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('select someone to see their brain', this.width / 2, this.height / 2);
      return;
    }

    this.drawRings(ctx, 'back');
    if (this.learning) this.drawLearning(ctx);
    else this.drawSynapses(ctx);
    this.drawPulses(ctx);
    if (!this.learning) this.drawPath(ctx, L);
    this.drawNeurons(ctx, L);
    this.drawGrown(ctx, L);
    this.drawMotors(ctx, L);
    this.drawRings(ctx, 'front');
    this.drawBloom(ctx);
    if (full) {
      this.drawLabels(ctx, L);
      this.drawHud(ctx);
      this.drawHistory(ctx, L);
      this.drawPorthole(ctx, L);
    }
    this.drawHover(ctx, L);
  };

  private advance(dt: number): void {
    // Release impulses whose moment has come.
    const due: Pending[] = [];
    const later: Pending[] = [];
    for (const p of this.pending) (p.at <= this.clock ? due : later).push(p);
    this.pending = later;
    for (const p of due) {
      this.pulses.push({ curve: p.curve, t: 0, speed: 1 / (p.real ? 0.38 + Math.random() * 0.2 : 0.55 + Math.random() * 0.3), real: p.real });
    }
    for (const p of this.pulses) p.t += p.speed * dt;
    this.pulses = this.pulses.filter((p) => p.t < 1);
    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < r.life);
  }

  private drawBackground(ctx: CanvasRenderingContext2D, L: Layout): void {
    const w = this.width;
    const h = this.height;
    const bg = ctx.createRadialGradient(L.coreX, L.coreY, 0, L.coreX, L.coreY, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#0b1422');
    bg.addColorStop(0.55, '#060b14');
    bg.addColorStop(1, '#02040a');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';
    const nebula = (x: number, y: number, r: number, rgb: [number, number, number], a: number): void => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    const breath = 0.8 + 0.2 * Math.sin(this.clock * 0.6);
    nebula(L.cx - L.rx * 0.9, L.cy, L.ry * 0.9, REGION_RGB[0], 0.05 * breath);
    nebula(L.cx - L.rx * 0.6, L.cy, L.ry * 0.7, REGION_RGB[1], 0.05 * breath);
    nebula(L.coreX, L.coreY, L.coreR * 1.9, REGION_RGB[2], 0.09 * breath);
    nebula(L.cx + L.rx * 0.95, L.cy, L.ry * 0.8, REGION_RGB[4], 0.05 * breath);
    // Feeling tints the whole brain, faintly, while it lasts.
    const v = this.valenceShown;
    if (Math.abs(v) > 0.03) {
      nebula(L.coreX, L.coreY, Math.max(L.rx, L.ry) * 1.4, v > 0 ? [255, 190, 90] : [255, 60, 70], Math.min(0.12, Math.abs(v) * 0.16));
    }
    ctx.globalCompositeOperation = 'source-over';

    if (this.full) {
      ctx.strokeStyle = 'rgba(160, 190, 220, 0.05)';
      ctx.lineWidth = 1;
      for (const s of [0.76, 1, 1.18]) {
        ctx.beginPath();
        ctx.ellipse(L.cx, L.cy, L.rx * s, L.ry * s, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(L.coreX, L.coreY, L.coreR * 1.18 * 1.22, L.coreR * 1.22, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawSynapses(ctx: CanvasRenderingContext2D): void {
    const full = this.full;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const c of this.curves) {
      const drive = this.shown[c.pre];
      const strength = Math.min(1, Math.abs(c.w) * 0.7);
      const alpha = (0.035 + 0.22 * drive) * (0.35 + 0.65 * strength) * (full ? 1 : 0.8);
      if (alpha < 0.01) continue;
      const col = c.w >= 0 ? EXCITE : INHIBIT;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
      ctx.lineWidth = (full ? 0.6 : 0.4) + strength * (full ? 1.2 : 0.6) + drive * (full ? 0.8 : 0.4);
      ctx.beginPath();
      ctx.moveTo(c.x0, c.y0);
      ctx.quadraticCurveTo(c.cx, c.cy, c.x1, c.y1);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Learning view: every drawn synapse coloured by how far it has moved since birth. */
  private drawLearning(ctx: CanvasRenderingContext2D): void {
    const full = this.full;
    let maxDrift = 0.05;
    for (const c of [...this.curves, ...this.learnedCurves]) maxDrift = Math.max(maxDrift, Math.abs(c.drift));
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const shimmer = 0.75 + 0.25 * Math.sin(this.clock * 2.4);
    for (const c of [...this.curves, ...this.learnedCurves]) {
      const change = Math.abs(c.drift) / maxDrift;
      const col = c.drift >= 0 ? GROWN : WEAKENED;
      const alpha = 0.04 + change * 0.7 * shimmer;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
      ctx.lineWidth = (full ? 0.5 : 0.3) + change * (full ? 3.2 : 1.6);
      ctx.beginPath();
      ctx.moveTo(c.x0, c.y0);
      ctx.quadraticCurveTo(c.cx, c.cy, c.x1, c.y1);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawPulses(ctx: CanvasRenderingContext2D): void {
    ctx.globalCompositeOperation = 'lighter';
    const size = this.full ? 11 : 7;
    for (const p of this.pulses) {
      const c = p.curve;
      const sprite = this.learning ? this.spark[c.drift >= 0 ? 3 : 4] : this.spark[c.w >= 0 ? 0 : 1];
      const trail = p.real ? 4 : 2;
      for (let k = 0; k < trail; k++) {
        const t = p.t - k * 0.03;
        if (t < 0) break;
        const [px, py] = bezier(c.x0, c.y0, c.cx, c.cy, c.x1, c.y1, t);
        const fade = Math.sin(Math.PI * Math.min(1, p.t)) * (1 - k / trail) * (p.real ? 1 : 0.55);
        const d = size * (p.real ? 1.15 : 0.8) * (1 - k * 0.18);
        ctx.globalAlpha = Math.max(0, fade);
        ctx.drawImage(sprite, px - d / 2, py - d / 2, d, d);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawPath(ctx: CanvasRenderingContext2D, L: Layout): void {
    const full = this.full;
    const trace = (nodes: number[], rgb: [number, number, number], width: number): void => {
      if (nodes.length < 2) return;
      const route = [...nodes].reverse();
      ctx.globalCompositeOperation = 'lighter';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${pass === 0 ? 0.16 : 0.75})`;
        ctx.lineWidth = pass === 0 ? width * 5 : width;
        ctx.setLineDash(pass === 0 ? [] : [6, 7]);
        ctx.lineDashOffset = -this.clock * 38;
        ctx.beginPath();
        ctx.moveTo(L.x[route[0]], L.y[route[0]]);
        for (let i = 1; i < route.length; i++) {
          const a = route[i - 1];
          const b = route[i];
          const mx = (L.x[a] + L.x[b]) / 2;
          const my = (L.y[a] + L.y[b]) / 2;
          ctx.quadraticCurveTo(mx + (L.coreX - mx) * 0.3, my + (L.coreY - my) * 0.3, L.x[b], L.y[b]);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const n of route) {
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.9)`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(L.x[n], L.y[n], full ? 9 : 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    trace(this.learnedPath, [196, 160, 255], full ? 1.6 : 1.1);
    trace(this.path, [255, 236, 200], full ? 2 : 1.3);
  }

  private drawNeurons(ctx: CanvasRenderingContext2D, L: Layout): void {
    const full = this.full;
    const dim = this.learning ? 0.35 : 1;
    const base = full ? 3.2 : 2;
    for (let i = 0; i < NEURON_COUNT; i++) {
      const [r, g, b] = REGION_RGB[regionOf(i)];
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.28 + this.shown[i] * 0.5) * dim})`;
      ctx.beginPath();
      ctx.arc(L.x[i], L.y[i], base * (0.7 + this.shown[i] * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    const glowSize = full ? 34 : 18;
    for (let i = 0; i < NEURON_COUNT; i++) {
      const a = this.shown[i];
      if (a >= 0.06) {
        const d = glowSize * (0.35 + a * 0.9);
        ctx.globalAlpha = Math.min(1, a * 1.15) * dim;
        ctx.drawImage(this.glow[regionOf(i)], L.x[i] - d / 2, L.y[i] - d / 2, d, d);
      }
      // A spike: a white pop that fades within a few frames.
      const p = this.pop[i];
      if (p > 0.04) {
        const c = (full ? 16 : 9) * (0.6 + p * 0.6);
        ctx.globalAlpha = p * dim;
        ctx.drawImage(this.spark[2], L.x[i] - c / 2, L.y[i] - c / 2, c, c);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Neurons this brain grew: a second arc between the core and the actions,
   * each wired from the senses it listens to and into the muscle it drives
   * (gold) or holds back (cyan). They are not in the 341-neuron layout because
   * they did not exist when this individual was born — or their ancestors grew
   * them, in which case they carry a small ring per generation.
   */
  private drawGrown(ctx: CanvasRenderingContext2D, L: Layout): void {
    const grown = this.brain?.grown;
    if (!grown || grown.length === 0) return;
    const full = this.full;
    const deg = Math.PI / 180;
    const count = grown.length;
    ctx.save();
    for (let k = 0; k < count; k++) {
      const g = grown[k];
      const angle = (count === 1 ? 0 : -38 + (k / (count - 1)) * 76) * deg;
      const gx = L.cx + Math.cos(angle) * L.rx * 0.8;
      const gy = L.cy + Math.sin(angle) * L.ry * 0.8;
      const rgb = g.sign > 0 ? GROWN_DRIVE_RGB : GROWN_CURB_RGB;
      const a = Math.max(0, Math.min(1, g.activity));
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 3 + k);
      // Wiring: senses in, muscle out.
      ctx.lineWidth = full ? 1.1 : 0.7;
      for (const input of g.inputs) {
        if (input < 0 || input >= NEURON_COUNT) continue;
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.12 + a * 0.45})`;
        ctx.beginPath();
        ctx.moveTo(L.x[input], L.y[input]);
        ctx.quadraticCurveTo(L.coreX, L.coreY - L.coreR * 0.4, gx, gy);
        ctx.stroke();
      }
      const motor = MOTOR_START + g.motor;
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.3 + a * 0.6})`;
      ctx.lineWidth = (full ? 1.6 : 1) * (0.6 + Math.min(1.4, Math.abs(g.outWeight)));
      if (g.sign < 0) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(L.x[motor], L.y[motor]);
      ctx.stroke();
      ctx.setLineDash([]);
      // The neuron: a diamond, rings for each inherited generation.
      const r = (full ? 6 : 4) * (0.8 + a * 0.5);
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.55 + a * 0.45})`;
      ctx.beginPath();
      ctx.moveTo(gx, gy - r);
      ctx.lineTo(gx + r, gy);
      ctx.lineTo(gx, gy + r);
      ctx.lineTo(gx - r, gy);
      ctx.closePath();
      ctx.fill();
      for (let gen = 0; gen < Math.min(4, g.generations); gen++) {
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.4 - gen * 0.07})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(gx, gy, r + 3 + gen * 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (a > 0.1) {
        ctx.globalCompositeOperation = 'lighter';
        const d = (full ? 30 : 16) * (0.5 + a * 0.8 + pulse * 0.1);
        ctx.globalAlpha = Math.min(1, a * 1.2);
        ctx.drawImage(this.glow[5], gx - d / 2, gy - d / 2, d, d);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      if (full) {
        ctx.font = '600 10px Inter, -apple-system, sans-serif';
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.55 + a * 0.45})`;
        ctx.textAlign = 'right';
        ctx.fillText(g.name, gx - r - 6, gy + 3);
      }
    }
    ctx.restore();
  }

  private drawRings(ctx: CanvasRenderingContext2D, layer: 'back' | 'front'): void {
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const big = r.reach > 60;
      if ((layer === 'back') !== big) continue;
      const t = r.t / r.life;
      const ease = 1 - (1 - t) * (1 - t);
      const radius = 4 + ease * r.reach;
      ctx.strokeStyle = `rgba(${r.rgb[0]},${r.rgb[1]},${r.rgb[2]},${(1 - t) * (big ? 0.5 : 0.85)})`;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.beginPath();
      if (big) ctx.ellipse(r.x, r.y, radius, radius * 0.72, 0, 0, Math.PI * 2);
      else ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawMotors(ctx: CanvasRenderingContext2D, L: Layout): void {
    const full = this.full;
    const maxBar = full ? Math.min(110, this.width * 0.065) : 22;
    for (let m = 0; m < MOTOR_COUNT; m++) {
      const i = MOTOR_START + m;
      const [dx, dy] = L.motorDir[m];
      const value = Math.max(0, Math.min(1, this.motorShown[m]));
      const x0 = L.x[i] + dx * (full ? 12 : 6);
      const y0 = L.y[i] + dy * (full ? 12 : 6);
      const lead = m === this.lead;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 138, 61, 0.12)';
      ctx.lineWidth = full ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + dx * maxBar, y0 + dy * maxBar);
      ctx.stroke();
      ctx.strokeStyle = lead ? '#ffb07a' : `rgba(255, 138, 61, ${0.35 + value * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + dx * maxBar * value, y0 + dy * maxBar * value);
      ctx.stroke();
      if (full) {
        const lx = x0 + dx * (maxBar + 12);
        const ly = y0 + dy * (maxBar + 12);
        ctx.font = `${lead ? 600 : 400} ${lead ? 14 : 12}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = lead ? '#ffe2c8' : `rgba(200, 215, 228, ${0.45 + value * 0.5})`;
        ctx.fillText(MOTOR_NAMES[m], lx, ly);
      }
    }
    const i = MOTOR_START + this.lead;
    const age = this.clock - this.leadSince;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 5);
    ctx.globalCompositeOperation = 'lighter';
    const d = (full ? 70 : 34) * (1 + Math.max(0, 0.6 - age));
    ctx.globalAlpha = 0.55 + 0.35 * pulse;
    ctx.drawImage(this.glow[4], L.x[i] - d / 2, L.y[i] - d / 2, d, d);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Bloom: a quarter-resolution copy of the frame, thresholded and blurred,
   * added back on top. Bright things — firing cells, impulses, waves — bleed
   * light into the dark around them the way they would through a lens.
   */
  private drawBloom(ctx: CanvasRenderingContext2D): void {
    if (!this.bloomSupported || !this.bloom) return;
    const b = this.bloom.getContext('2d');
    if (!b) return;
    const bw = this.bloom.width;
    const bh = this.bloom.height;
    b.globalCompositeOperation = 'copy';
    b.filter = `brightness(0.62) contrast(3.4) blur(${this.full ? 3 : 2}px)`;
    b.drawImage(this.canvas, 0, 0, bw, bh);
    b.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = this.full ? 0.42 : 0.35;
    ctx.drawImage(this.bloom, 0, 0, this.canvas.width, this.canvas.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private drawLabels(ctx: CanvasRenderingContext2D, L: Layout): void {
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const label of L.groupLabels) {
      ctx.fillStyle = 'rgba(110, 231, 168, 0.72)';
      ctx.fillText(spaced(label.text), label.x, label.y);
    }
    ctx.textAlign = 'center';
    const caption = (text: string, x: number, y: number, rgb: [number, number, number]): void => {
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`;
      ctx.fillText(spaced(text), x, y);
    };
    caption(REGION_LABEL[2], L.coreX, L.coreY + L.coreR * 1.22 + 22, REGION_RGB[2]);
    caption(REGION_LABEL[3], L.coreX, L.coreY - L.coreR * 1.22 - 18, REGION_RGB[3]);
    caption(REGION_LABEL[1], L.cx - L.rx * 0.34, L.cy + L.ry * 0.86, REGION_RGB[1]);
    const first = L.groupLabels[0];
    if (first) caption(REGION_LABEL[0], first.x - 30, first.y - 34, REGION_RGB[0]);
    ctx.textAlign = 'right';
    caption(REGION_LABEL[4], L.x[MOTOR_START] - 26, L.y[MOTOR_START] - 4, REGION_RGB[4]);
  }

  private drawHud(ctx: CanvasRenderingContext2D): void {
    const brain = this.brain!;
    const x = 34;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#ff8a3d';
    const title = spaced(this.learning ? 'LEARNING VIEW' : 'LIVE BRAIN');
    ctx.fillText(title, x, 38);
    const titleWidth = ctx.measureText(title).width;
    ctx.fillStyle = 'rgba(200, 215, 228, 0.55)';
    let spikesNow = 0;
    for (const s of brain.spikes ?? []) spikesNow += s;
    ctx.fillText(
      `  ·  ${this.brain?.neuronCount ?? NEURON_COUNT} NEURONS  ·  ${this.curves.length + (this.learning ? this.learnedCurves.length : 0)} SYNAPSES SHOWN  ·  ${Math.round(spikesNow / 0.12)} SPIKES/S`,
      x + titleWidth + 4,
      38,
    );
    ctx.font = '300 30px -apple-system, BlinkMacSystemFont, Inter, sans-serif';
    ctx.fillStyle = '#eef4f8';
    ctx.fillText(this.name, x, 74);
    const nameWidth = ctx.measureText(this.name).width;
    if (this.explain) {
      ctx.font = '500 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#ffb07a';
      ctx.fillText(`→ ${this.explain.action.toUpperCase()}  ${Math.round(this.explain.strength * 100)}%`, x + nameWidth + 18, 72);
    }
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    if (this.learning) {
      ctx.fillStyle = 'rgba(255, 226, 150, 0.85)';
      ctx.fillText(
        `gold: strengthened since birth  ·  violet: weakened  ·  mean change ${(brain.weightDrift ?? 0).toFixed(4)} per synapse`,
        x,
        98,
      );
    } else if (this.explain) {
      ctx.fillStyle = 'rgba(255, 236, 200, 0.75)';
      const why = this.explain.summary.slice(0, 3).map((line) => line.replace(/\s*\(input [^)]*\)/, '')).join('   ·   ');
      if (why) ctx.fillText(`because  ${why}`, x, 98);
    }

    // Feeling: pain on the left, reward on the right, the needle where learning is now.
    const fx = x;
    const fy = 120;
    const fw = 220;
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(200, 215, 228, 0.5)';
    ctx.fillText(spaced('FEELING'), fx, fy - 4);
    const mx = fx + 84;
    const grad = ctx.createLinearGradient(mx, 0, mx + fw, 0);
    grad.addColorStop(0, 'rgba(255, 70, 80, 0.8)');
    grad.addColorStop(0.5, 'rgba(120, 130, 150, 0.35)');
    grad.addColorStop(1, 'rgba(255, 206, 110, 0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(mx, fy - 8, fw, 3);
    const nx = mx + fw / 2 + (fw / 2) * Math.max(-1, Math.min(1, this.valenceShown));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(nx, fy - 6.5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(200, 215, 228, 0.45)';
    ctx.fillText('pain', mx, fy + 8);
    ctx.textAlign = 'right';
    ctx.fillText('reward', mx + fw, fy + 8);

    // Legend, top right.
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const lx = this.width - 34;
    if (this.learning) {
      ctx.fillStyle = `rgb(${GROWN.join(',')})`;
      ctx.fillText('● strengthened', lx - 110, 38);
      ctx.fillStyle = `rgb(${WEAKENED.join(',')})`;
      ctx.fillText('● weakened', lx, 38);
    } else {
      ctx.fillStyle = `rgb(${EXCITE.join(',')})`;
      ctx.fillText('● excites', lx - 170, 38);
      ctx.fillStyle = `rgb(${INHIBIT.join(',')})`;
      ctx.fillText('● inhibits', lx - 84, 38);
      ctx.fillStyle = 'rgba(255, 236, 200, 0.85)';
      ctx.fillText('— why', lx, 38);
      ctx.fillStyle = 'rgba(200, 215, 228, 0.45)';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('bright impulses are recorded spikes · faint ones graded sensory input', lx, 56);
    }
  }

  private drawHistory(ctx: CanvasRenderingContext2D, L: Layout): void {
    const raster = history.raster;
    if (!raster) return;
    const x = 34;
    const w = this.width - 68;
    const y = L.rasterY;
    const h = L.rasterH;
    ctx.fillStyle = 'rgba(2, 5, 10, 0.8)';
    ctx.fillRect(x, y, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(raster, x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';

    // Decision ribbon: what they chose, column for column above the raster.
    const ribbonY = y - 14;
    const n = history.actions.length;
    const col = w / HISTORY;
    for (let i = 0; i < n; i++) {
      const px = x + w - (n - i) * col;
      ctx.fillStyle = ACTION_KIND[history.actions[i]]?.[1] ?? '#444';
      ctx.fillRect(px, ribbonY, Math.ceil(col), 8);
    }
    ctx.imageSmoothingEnabled = true;

    // Population activity over the same window.
    const population = history.population;
    ctx.strokeStyle = 'rgba(255, 236, 200, 0.75)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < population.length; i++) {
      const px = x + w - (population.length - i) * col;
      const py = ribbonY - 6 - Math.min(1, population[i] * 2.2) * 26;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(200, 215, 228, 0.6)';
    ctx.fillText(spaced('SPIKE RASTER · 341 NEURONS · LAST ~40 s'), x, y + h + 16);
    // Ribbon legend.
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    let lx = x + ctx.measureText(spaced('SPIKE RASTER · 341 NEURONS · LAST ~40 s')).width + 40;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const [label, colour] of RIBBON_LEGEND) {
      ctx.fillStyle = colour;
      ctx.fillRect(lx, y + h + 8, 10, 8);
      ctx.fillStyle = 'rgba(200, 215, 228, 0.6)';
      ctx.fillText(label, lx + 14, y + h + 16);
      lx += ctx.measureText(label).width + 34;
    }
    ctx.textAlign = 'right';
    ctx.fillText(spaced('NOW'), x + w, y + h + 16);
    const bounds = [0, LOCAL_START, RECURRENT_START, MOD_START, MOTOR_START, NEURON_COUNT];
    for (let r = 0; r < 5; r++) {
      const [cr, cg, cb] = REGION_RGB[r];
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      const y0 = y + (bounds[r] / NEURON_COUNT) * h;
      const y1 = y + (bounds[r + 1] / NEURON_COUNT) * h;
      ctx.fillRect(x - 6, y0, 3, Math.max(1, y1 - y0 - 1));
    }
  }

  /**
   * The window onto the world, and the body around it.
   *
   * Inside the rim: which way the person senses food, water, kin and threat —
   * the egocentric channels turned through their heading. Outside it: hunger,
   * thirst, fatigue and pain. The hole itself is a CSS mask on the canvas.
   */
  private drawPorthole(ctx: CanvasRenderingContext2D, L: Layout): void {
    const p = L.porthole;
    const brain = this.brain;
    if (!p || !brain) return;
    const m = MOTOR_START + this.lead;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255, 176, 122, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 6]);
    ctx.lineDashOffset = -this.clock * 30;
    ctx.beginPath();
    ctx.moveTo(L.x[m], L.y[m]);
    const toward = Math.atan2(L.y[m] - p.y, L.x[m] - p.x);
    ctx.quadraticCurveTo((L.x[m] + p.x) / 2 + 60, (L.y[m] + p.y) / 2, p.x + Math.cos(toward) * (p.r + 30), p.y + Math.sin(toward) * (p.r + 30));
    ctx.stroke();
    ctx.setLineDash([]);

    // Directional senses, just inside the rim.
    const sensors = brain.sensors ?? [];
    const heading = brain.heading ?? 0;
    const offsets = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const modalities: Array<[number, [number, number, number], string]> = [
      [S.foodFront, [110, 231, 140], 'food'],
      [S.waterFront, [90, 190, 255], 'water'],
      [S.humanFront, [240, 140, 190], 'kin'],
      [S.threatFront, [255, 80, 70], 'threat'],
    ];
    modalities.forEach(([base, rgb], k) => {
      const radius = p.r - 7 - k * 8;
      for (let d = 0; d < 4; d++) {
        const v = Math.max(0, Math.min(1, sensors[base + d] ?? 0));
        if (v < 0.04) continue;
        const a = heading + offsets[d];
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.25 + v * 0.7})`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, a - 0.42, a + 0.42);
        ctx.stroke();
      }
    });

    // Rim.
    const sweep = this.clock * 0.9;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? 'rgba(255, 138, 61, 0.18)' : 'rgba(255, 176, 122, 0.85)';
      ctx.lineWidth = pass === 0 ? 10 : 1.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 236, 200, 0.9)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 3, sweep, sweep + 0.7);
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(255, 176, 122, 0.9)';
    ctx.fillText(spaced('LIVE'), p.x, p.y - p.r - 16);
    ctx.fillStyle = 'rgba(220, 230, 238, 0.8)';
    ctx.fillText(spaced(`${this.name.toUpperCase()} IN THE WORLD`), p.x, p.y + p.r + 26);
    // Sense legend under the caption.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    let lx = p.x - 110;
    for (const [, rgb, label] of modalities) {
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.textAlign = 'left';
      ctx.fillText(`◠ ${label}`, lx, p.y + p.r + 46);
      lx += 58;
    }
    // The body: four small gauges in a row.
    const body: Array<[string, number, [number, number, number]]> = [
      ['hunger', sensors[S.hunger] ?? 0, [255, 150, 70]],
      ['thirst', sensors[S.thirst] ?? 0, [90, 190, 255]],
      ['fatigue', sensors[S.fatigue] ?? 0, [168, 140, 255]],
      ['pain', sensors[S.pain] ?? 0, [255, 80, 80]],
    ];
    const gw = 52;
    let gx = p.x - (body.length * (gw + 10) - 10) / 2;
    const gy = p.y + p.r + 62;
    for (const [label, value, rgb] of body) {
      ctx.fillStyle = 'rgba(160, 180, 200, 0.14)';
      ctx.fillRect(gx, gy, gw, 4);
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.fillRect(gx, gy, gw * Math.max(0.03, Math.min(1, value)), 4);
      ctx.fillStyle = 'rgba(200, 215, 228, 0.6)';
      ctx.textAlign = 'left';
      ctx.fillText(label, gx, gy + 16);
      gx += gw + 10;
    }
  }

  private drawHover(ctx: CanvasRenderingContext2D, L: Layout): void {
    const i = this.hover;
    if (i < 0) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const c of this.learning ? [...this.curves, ...this.learnedCurves] : this.curves) {
      if (c.pre !== i && c.post !== i) continue;
      ctx.strokeStyle = c.pre === i ? 'rgba(255, 236, 200, 0.8)' : 'rgba(190, 230, 255, 0.8)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(c.x0, c.y0);
      ctx.quadraticCurveTo(c.cx, c.cy, c.x1, c.y1);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    const name = i < SENSORY_NAMES.length ? `sense: ${SENSORY_NAMES[i]}` : labelNeuron(i).replace(':', ': ');
    const spikes = i >= SENSORY_COUNT ? `  ·  ${this.brain?.spikes?.[i] ?? 0} spikes` : '';
    const text = `${name}   ${Math.round(this.shown[i] * 100)}%${spikes}`;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(text).width;
    let bx = L.x[i] + 14;
    let by = L.y[i] - 14;
    if (bx + tw + 16 > this.width) bx = L.x[i] - tw - 26;
    if (by < 20) by = L.y[i] + 26;
    ctx.fillStyle = 'rgba(6, 11, 18, 0.92)';
    ctx.strokeStyle = 'rgba(160, 190, 220, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx - 8, by - 15, tw + 16, 22, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e6eef5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, bx, by);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(L.x[i], L.y[i], 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  private onMove = (event: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const L = this.layout;
    if (!L) return;
    let best = -1;
    let bestD = 14 * 14;
    for (let i = 0; i < NEURON_COUNT; i++) {
      const d = (L.x[i] - this.pointer.x) ** 2 + (L.y[i] - this.pointer.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.hover = best;
    this.canvas.style.cursor = best >= 0 ? 'crosshair' : 'default';
  };

  private onLeave = (): void => {
    this.hover = -1;
  };
}

/**
 * The brain, audible. Off unless the observer turns it on.
 *
 * Each update, every region that fired plays a short soft note — pitch by
 * region, loudness by how many spikes it fired — so a burst sounds like a
 * burst. A change of action rings a two-note chime; a swing of feeling is a low
 * swell, warm for reward and dark for pain.
 */
class BrainSound {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  /** Pentatonic, low to high: local, recurrent, neuromodulation, motor. */
  private readonly notes = [392, 293.66, 523.25, 587.33];

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    const verb = this.ctx.createDelay(1);
    verb.delayTime.value = 0.23;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.32;
    verb.connect(feedback).connect(verb);
    this.master.connect(this.ctx.destination);
    this.master.connect(verb);
    verb.connect(this.ctx.destination);
  }

  close(): void {
    void this.ctx.close();
  }

  spikes(brain: BrainView): void {
    const totals = [0, 0, 0, 0];
    const spikes = brain.spikes ?? [];
    for (let i = SENSORY_COUNT; i < NEURON_COUNT; i++) totals[regionOf(i) - 1] += spikes[i] ?? 0;
    totals.forEach((total, r) => {
      if (total <= 0) return;
      const level = Math.min(1, total / [60, 120, 18, 14][r]);
      this.note(this.notes[r] * (1 + (Math.random() - 0.5) * 0.004), 0.035 * level, 0.18 + 0.1 * level, r === 1 ? 'triangle' : 'sine');
    });
  }

  decision(motor: number): void {
    const base = 659.25 * Math.pow(2, (motor % 5) / 12);
    this.note(base, 0.05, 0.6, 'sine');
    window.setTimeout(() => this.note(base * 1.5, 0.04, 0.8, 'sine'), 90);
  }

  feeling(valence: number): void {
    this.note(valence > 0 ? 130.81 : 98, 0.07 * Math.min(1, Math.abs(valence) * 2), 1.6, 'sine', 0.35);
  }

  private note(freq: number, gain: number, decay: number, type: OscillatorType, attack = 0.006): void {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }
}

function recordHistory(brain: BrainView, lead: number): void {
  if (history.lastBrain === brain) return;
  history.lastBrain = brain;
  if (history.entityId !== brain.entityId || !history.raster) {
    history.entityId = brain.entityId;
    history.population = [];
    history.actions = [];
    history.raster = document.createElement('canvas');
    history.raster.width = HISTORY;
    history.raster.height = NEURON_COUNT;
    const r = history.raster.getContext('2d')!;
    r.fillStyle = '#03060b';
    r.fillRect(0, 0, HISTORY, NEURON_COUNT);
  }
  const r = history.raster.getContext('2d')!;
  r.globalCompositeOperation = 'copy';
  r.drawImage(history.raster, -1, 0);
  r.globalCompositeOperation = 'source-over';
  const column = r.createImageData(1, NEURON_COUNT);
  let total = 0;
  const spikes = brain.spikes ?? [];
  for (let i = 0; i < NEURON_COUNT; i++) {
    const a = Math.max(0, Math.min(1, brain.activity[i] ?? 0));
    total += a;
    const [cr, cg, cb] = REGION_RGB[regionOf(i)];
    // A cell that actually spiked in this interval is drawn at full brightness.
    const k = i >= SENSORY_COUNT && (spikes[i] ?? 0) > 0 ? 0.35 + 0.65 * Math.min(1, (spikes[i] ?? 0) / 3) : a * a * 0.8;
    column.data[i * 4] = 3 + cr * k;
    column.data[i * 4 + 1] = 6 + cg * k;
    column.data[i * 4 + 2] = 11 + cb * k;
    column.data[i * 4 + 3] = 255;
  }
  r.putImageData(column, HISTORY - 1, 0);
  history.population.push(total / NEURON_COUNT);
  history.actions.push(lead);
  if (history.population.length > HISTORY) history.population.shift();
  if (history.actions.length > HISTORY) history.actions.shift();
}

function bezier(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number): [number, number] {
  const u = 1 - t;
  return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
}

/** A soft additive light: white-hot centre, the colour, then nothing. */
function glowSprite([r, g, b]: readonly [number, number, number] | [number, number, number], size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, `rgba(${Math.min(255, r + 120)},${Math.min(255, g + 120)},${Math.min(255, b + 120)},1)`);
  grad.addColorStop(0.18, `rgba(${r},${g},${b},0.85)`);
  grad.addColorStop(0.5, `rgba(${r},${g},${b},0.22)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function spaced(text: string): string {
  return text.split('').join(' ');
}
