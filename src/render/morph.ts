/**
 * Reading a person's looks from their genes.
 *
 * Seven heritable genes (v3) shape the figure: build, head shape, hairstyle,
 * hair colour, body paint and its colour, adornment. They mutate like any gene
 * and nothing selects on them, so they drift — twice as fast as the rest — and
 * a village that has been isolated for a dozen generations looks like itself:
 * crested hair, ochre stripes, feathers, where the founders were plain. Nobody
 * designed that look; the rule "looks are inherited and drift" produced it.
 *
 * Each gene arrives as a byte (0..255). Continuous genes stay continuous; the
 * categorical ones are read in bands, so a small mutation near a boundary is
 * what turns a braid into a crest.
 */

export interface Looks {
  /** Shoulder and hip width multiplier, 0.8..1.25. */
  build: number;
  /** 0 round .. 1 long. */
  headShape: number;
  hairStyle: HairStyle;
  hair: number;
  paint: PaintPattern;
  paintColor: number;
  ornament: Ornament;
}

export type HairStyle = 'shorn' | 'cropped' | 'long' | 'braided' | 'crested' | 'knotted';
export type PaintPattern = 'none' | 'stripes' | 'dots' | 'band' | 'chevrons';
export type Ornament = 'none' | 'feather' | 'beads' | 'headband' | 'horns' | 'flowers';

const HAIR_STYLES: HairStyle[] = ['shorn', 'cropped', 'long', 'braided', 'crested', 'knotted'];

/** Natural shades first, then ochre, indigo and lime-white dyes. */
const HAIR_RAMP = [0x1d1612, 0x3a2618, 0x5e3d22, 0x7a3a1c, 0xa47a44, 0xcdb487, 0xb8452a, 0x2d3d74, 0xe6e1d6];

const PAINT_COLORS = [0xc8452c, 0xe0a030, 0xf2eee0, 0x2f6fb0, 0x3a9a5a, 0x7a3aa0, 0x1a1a1a, 0xd05a8a];

export const NEUTRAL_LOOKS: Looks = {
  build: 1,
  headShape: 0.5,
  hairStyle: 'cropped',
  hair: HAIR_RAMP[2],
  paint: 'none',
  paintColor: PAINT_COLORS[0],
  ornament: 'none',
};

const unit = (byte: number): number => Math.max(0, Math.min(1, byte / 255));

export function readLooks(morph: ArrayLike<number> | null | undefined): Looks {
  if (!morph || morph.length < 7) return NEUTRAL_LOOKS;
  const [build, head, style, hair, marks, markHue, ornament] = Array.from({ length: 7 }, (_, i) => unit(morph[i]));
  return {
    build: 0.8 + build * 0.45,
    headShape: head,
    hairStyle: HAIR_STYLES[Math.min(HAIR_STYLES.length - 1, Math.floor(style * HAIR_STYLES.length))],
    hair: HAIR_RAMP[Math.min(HAIR_RAMP.length - 1, Math.floor(hair * HAIR_RAMP.length))],
    paint: marks < 0.3 ? 'none' : marks < 0.46 ? 'stripes' : marks < 0.62 ? 'dots' : marks < 0.78 ? 'band' : 'chevrons',
    paintColor: PAINT_COLORS[Math.min(PAINT_COLORS.length - 1, Math.floor(markHue * PAINT_COLORS.length))],
    ornament:
      ornament < 0.35
        ? 'none'
        : ornament < 0.5
          ? 'feather'
          : ornament < 0.65
            ? 'beads'
            : ornament < 0.8
              ? 'headband'
              : ornament < 0.9
                ? 'horns'
                : 'flowers',
  };
}

/** A number that changes when anything visible changes, for redraw caching. */
export function looksKey(morph: ArrayLike<number> | null | undefined): number {
  if (!morph) return 0;
  let key = 0;
  for (let i = 0; i < morph.length; i++) key = (key * 31 + morph[i]) % 2147483647;
  return key;
}
