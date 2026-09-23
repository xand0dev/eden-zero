/**
 * One visual language for the whole world.
 *
 * Every object in the scene is drawn from the same three primitives:
 *
 *   1. a soft shadow on the ground beneath it,
 *   2. a filled silhouette,
 *   3. a darker outline of the same hue around that silhouette.
 *
 * Before this existed, humans and huts had shadows but no outlines, trees had
 * outlines but no shadows, and fields and canals had neither. The result was a
 * map of five unrelated sprite sets pasted on top of each other. Sharing the
 * three primitives is what makes a hut, a tree and an inhabitant read as
 * belonging to one world.
 *
 * Everything here is expressed in world tiles, because that is the unit the
 * renderer works in — the camera zoom is applied by the parent container.
 */

/** Ground shadows. One value, used by every object, so the light agrees. */
export const SHADOW_COLOR = 0x0a0f14;
export const SHADOW_ALPHA = 0.3;

/**
 * Outline width in world tiles.
 *
 * Thick enough to separate two touching shapes at island zoom, thin enough not
 * to eat a human, who is well under one tile tall.
 */
export const OUTLINE_WIDTH = 0.038;

/**
 * Darken a packed 0xRRGGBB colour.
 *
 * Used to derive an object's outline from its own fill, so every outline is
 * automatically in the right hue instead of being black or an arbitrary brown.
 */
export function outlineOf(color: number, amount = 0.5): number {
  const r = Math.round(((color >> 16) & 0xff) * (1 - amount));
  const g = Math.round(((color >> 8) & 0xff) * (1 - amount));
  const b = Math.round((color & 0xff) * (1 - amount));
  return (r << 16) | (g << 8) | b;
}

/** Lighten a packed 0xRRGGBB colour, for a highlight on top of a fill. */
export function lightenOf(color: number, amount = 0.2): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) + (255 - ((color >> 16) & 0xff)) * amount));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) + (255 - ((color >> 8) & 0xff)) * amount));
  const b = Math.min(255, Math.round((color & 0xff) + (255 - (color & 0xff)) * amount));
  return (r << 16) | (g << 8) | b;
}

/**
 * Terrain palette.
 *
 * Water, sand and rock are deliberately desaturated. The living world is the
 * subject; the ground it stands on should sit behind it, not compete with it.
 */
export const TERRAIN_COLORS: Record<number, [number, number, number]> = {
  0: [26, 46, 74], // deep water
  1: [42, 78, 106], // shallow
  2: [148, 134, 100], // sand
  3: [58, 74, 52], // grass
  4: [44, 60, 44], // forest floor
  5: [72, 70, 72], // rock
};

/**
 * Structure palette.
 *
 * Warm timber against the cool ground, so a village is visible from the far
 * side of the island without being outlined in a colour the world does not use.
 */
export const STRUCTURE_COLORS = {
  post: 0x6b4f2a,
  wall: 0x9c7846,
  wallDark: 0x76582f,
  roof: 0xc08a4a,
  roofDark: 0x8f6435,
  door: 0x3a2c1c,
  glow: 0xffb45e,
  floor: 0x5a452a,
};

/** Cultivation palette. */
export const CULTIVATION_COLORS = {
  fallow: 0x6f5a38,
  growing: 0x5c9c3c,
  ripe: 0xe0bb46,
  dryRim: 0xd8a63a,
  canalDry: 0x6a5a44,
  canalDug: 0x5c7a8c,
  canalFlowing: 0x3a92d8,
};
