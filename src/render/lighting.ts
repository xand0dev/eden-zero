import { Texture } from 'pixi.js';

/**
 * Light and atmosphere.
 *
 * The world is colour-graded rather than dimmed: a flat black wash over the map
 * at night made everything a muddier version of itself. Grading shifts the whole
 * palette instead — rich and slightly warm at midday, gold at dawn and dusk,
 * desaturated moonlit blue at night — and the settlement's own lights are drawn
 * on top of the grade so a lit doorway actually glows in the dark.
 */

/** A 5x4 colour matrix (row-major, offsets in 0..1) for a sun level in 0..1. */
export function gradeMatrix(light: number): number[] {
  const night = smoothstep(0.38, 0.02, light);
  const golden = Math.exp(-(((light - 0.42) / 0.17) ** 2)) * (1 - night * 0.6);

  const saturation = 1.03 - 0.58 * night + 0.06 * golden;
  const brightness = 1.02 - 0.6 * night - 0.04 * golden;
  const tint = [
    lerp3([1.02, 1.0, 0.96], [1.14, 0.95, 0.76], golden),
    lerp3([1.02, 1.0, 0.96], [0.66, 0.82, 1.28], night),
  ];
  const t: [number, number, number] = [tint[0][0] * tint[1][0], tint[0][1] * tint[1][1], tint[0][2] * tint[1][2]];

  const lr = 0.2126;
  const lg = 0.7152;
  const lb = 0.0722;
  const s = saturation;
  const rows = [
    [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s)],
    [lr * (1 - s), lg * (1 - s) + s, lb * (1 - s)],
    [lr * (1 - s), lg * (1 - s), lb * (1 - s) + s],
  ];
  const lift = [0.0, 0.006 * night, 0.03 * night];
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const k = brightness * t[c];
    out.push(rows[c][0] * k, rows[c][1] * k, rows[c][2] * k, 0, lift[c]);
  }
  out.push(0, 0, 0, 1, 0);
  return out;
}

/** How strongly lamps and hearths show: nothing at noon, full at night. */
export function lampStrength(light: number): number {
  return smoothstep(0.55, 0.12, light);
}

/** A soft warm pool of light, for a hearth or a doorway. */
export function makeGlowTexture(): Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255, 200, 120, 0.9)');
  g.addColorStop(0.25, 'rgba(255, 160, 80, 0.45)');
  g.addColorStop(0.6, 'rgba(255, 120, 50, 0.12)');
  g.addColorStop(1, 'rgba(255, 120, 50, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'linear';
  return texture;
}

/** Darkened corners: frames the diorama and pulls the eye to the centre. */
export function makeVignetteTexture(): Texture {
  const w = 512;
  const h = 320;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.scale(1, h / w);
  const g = ctx.createRadialGradient(w / 2, w / 2, w * 0.28, w / 2, w / 2, w * 0.74);
  g.addColorStop(0, 'rgba(2, 6, 10, 0)');
  g.addColorStop(0.7, 'rgba(2, 6, 10, 0.35)');
  g.addColorStop(1, 'rgba(2, 6, 10, 0.8)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, w);
  ctx.restore();
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'linear';
  return texture;
}

function lerp3(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
