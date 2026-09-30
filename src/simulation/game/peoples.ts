import { Rng } from '../rng';
import { GENE_DEFS, type GeneKey, type Genome } from '../genetics/genome';
import { makeName } from './ages';

/**
 * Peoples: kinds of humans the world makes on its own.
 *
 * The fourth Rule of Creation (genesis/rules.ts). Everyone belongs to a people,
 * and a child to its mother's. A people is a lineage with a look — the drift of
 * the neutral genes (colouring, hair, paint, adornment, build) — and two things
 * turn one people into more:
 *
 *  - **Divergence**: part of a people has settled apart from the rest — its
 *    members spend their days far from the others' — for two days running. It
 *    becomes a people of its own, and from then on drifts on its own (a small
 *    group drifts fast: the founder effect).
 *  - **Becoming**: a whole people has drifted so far from what it was when it
 *    was named that it is no longer that people. It takes a new name, and the
 *    chronicle remembers what it used to be.
 *
 * Names are generated, never listed, so there is no last people. None of this
 * feeds back into behaviour: a people is how the world describes what heredity
 * and drift have done, and the only thing it changes is how a people's
 * buildings look (their style is the people's).
 */

/** The genes that make a look. All drift freely: nothing selects on them. */
const LOOK_GENES: GeneKey[] = [
  'hue',
  'saturation',
  'lightness',
  'stature',
  'build',
  'headShape',
  'hairStyle',
  'hairHue',
  'markings',
  'markingHue',
  'ornament',
];
const LOOK_DEFS = LOOK_GENES.map((key) => GENE_DEFS.find((d) => d.key === key)!);

/** How far a people must drift from its founding look to become another. */
export const BECOME_DISTANCE = 0.22;
/** Tiles apart two groups' haunts must be, centre to centre, to part. */
export const DIVERGE_SPACE = 24;
/** Days running a people must stay split before the world calls it two. */
export const DIVERGE_DAYS = 2;
/** Smallest group that can be a people. */
export const MIN_PEOPLE = 4;

export interface People {
  id: number;
  name: string;
  /** Tick it was named. */
  founded: number;
  /** The people it came from, and how: parted from it, or became it. */
  parent: number | null;
  origin: 'genesis' | 'diverged' | 'became';
  /** Look at founding, normalised genes in LOOK_GENES order. */
  reference: number[];
  /** Look now (mean of the living), same space. */
  look: number[];
  members: number;
  /** Tick the last member died, or null. */
  extinct: number | null;
  /** Colour of the people's buildings and banner: a hue, 0..1. */
  hue: number;
  /** Roof shape of the people's buildings, 0..2. */
  roof: number;
  /** Consecutive daily checks on which the people has been split in two. */
  splitDays?: number;
}

export function lookOf(genome: Genome): number[] {
  return LOOK_DEFS.map((def) => (genome[def.key] - def.min) / (def.max - def.min));
}

export function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    let d = Math.abs(a[i] - b[i]);
    // Hues wrap around.
    if (i === 0 || i === 9) d = Math.min(d, 1 - d);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function mean(vectors: number[][]): number[] {
  const out = new Array<number>(LOOK_GENES.length).fill(0);
  if (vectors.length === 0) return out;
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}

/** A new people's name and style, from a stream of its own. */
export function namePeople(seed: string, id: number): { name: string; hue: number; roof: number } {
  const rng = new Rng(`${seed}:people:${id}`);
  const name = makeName(rng);
  return { name, hue: rng.next(), roof: Math.floor(rng.next() * 3) };
}

export interface Member {
  id: number;
  /** Where the member spends their days (a slow average of position). */
  x: number;
  y: number;
  look: number[];
}

export interface Split {
  /** Ids of the members who part. */
  leaving: number[];
  look: number[];
}

/**
 * Whether part of a people has settled apart. Two-means on where members spend
 * their days, seeded from the two members farthest apart, a fixed number of
 * rounds — deterministic and cheap. Returns the smaller group if both are big
 * enough, their centres are `DIVERGE_SPACE` apart, and each is a real cluster
 * (tighter than half the gap), so a people strung along a river does not count.
 */
export function findDivergence(members: Member[]): Split | null {
  if (members.length < MIN_PEOPLE * 2) return null;
  const gap = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
  let a = members[0];
  let b = members[0];
  let far = -1;
  for (const m of members) {
    const d = gap(m, members[0]);
    if (d > far) {
      far = d;
      a = m;
    }
  }
  far = -1;
  for (const m of members) {
    const d = gap(m, a);
    if (d > far) {
      far = d;
      b = m;
    }
  }
  let ca = { x: a.x, y: a.y };
  let cb = { x: b.x, y: b.y };
  let side: boolean[] = [];
  const centre = (group: Member[]): { x: number; y: number } => ({
    x: group.reduce((s, m) => s + m.x, 0) / Math.max(1, group.length),
    y: group.reduce((s, m) => s + m.y, 0) / Math.max(1, group.length),
  });
  for (let round = 0; round < 6; round++) {
    side = members.map((m) => gap(m, cb) < gap(m, ca));
    ca = centre(members.filter((_, i) => !side[i]));
    cb = centre(members.filter((_, i) => side[i]));
  }
  const groupA = members.filter((_, i) => !side[i]);
  const groupB = members.filter((_, i) => side[i]);
  if (groupA.length < MIN_PEOPLE || groupB.length < MIN_PEOPLE) return null;
  const between = gap(ca, cb);
  if (between < DIVERGE_SPACE) return null;
  const spread = (group: Member[], c: { x: number; y: number }): number => group.reduce((s, m) => s + gap(m, c), 0) / group.length;
  if (spread(groupA, ca) > between / 2 || spread(groupB, cb) > between / 2) return null;
  const leaving = groupA.length < groupB.length ? groupA : groupB;
  return { leaving: leaving.map((m) => m.id), look: mean(leaving.map((m) => m.look)) };
}

/** A people's look, averaged over its living members. */
export function meanLook(members: Member[]): number[] {
  return mean(members.map((m) => m.look));
}

/** Words for a people's look, for the chronicle: "crested, ochre-painted". */
export function describeLook(look: readonly number[]): string {
  const words: string[] = [];
  const style = look[6];
  const hair = ['shorn', 'short-haired', 'long-haired', 'braided', 'crested', 'top-knotted'][Math.min(5, Math.floor(style * 6))];
  words.push(hair);
  const marks = look[8];
  if (marks >= 0.3) words.push(['striped', 'dotted', 'banded', 'chevroned'][marks < 0.46 ? 0 : marks < 0.62 ? 1 : marks < 0.78 ? 2 : 3]);
  const ornament = look[10];
  if (ornament >= 0.35) {
    words.push(
      ornament < 0.5 ? 'feathered' : ornament < 0.65 ? 'beaded' : ornament < 0.8 ? 'head-banded' : ornament < 0.9 ? 'horned' : 'flower-crowned',
    );
  }
  if (look[4] > 0.7) words.push('broad');
  else if (look[4] < 0.3) words.push('slight');
  return words.join(', ');
}
