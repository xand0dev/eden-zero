/**
 * The chronicle — the world's history, kept.
 *
 * The event feed is a firehose that forgets after four hundred lines. The
 * chronicle keeps what a person reading the history of this world would want:
 * eras, crises, firsts, notable lives and their ends. Every sentence in it is
 * built from recorded data; nothing is invented to make a better story.
 */

export type ChronicleKind =
  | 'genesis'
  | 'era'
  | 'crisis'
  | 'first'
  | 'life'
  | 'death'
  | 'discovery'
  | 'epithet'
  | 'milestone'
  | 'observer'
  | 'people'
  | 'age';

export interface ChronicleEntry {
  id: number;
  tick: number;
  simTime: number;
  kind: ChronicleKind;
  /** 1 routine, 2 notable, 3 a turning point. Drives the director's slow-down. */
  importance: 1 | 2 | 3;
  title: string;
  text: string;
  entityIds: number[];
  /** Where it happened, when that is meaningful, for the camera. */
  x?: number;
  y?: number;
}

export const MAX_CHRONICLE = 600;

export class Chronicle {
  entries: ChronicleEntry[] = [];
  private nextId = 1;
  /** One-off firsts already recorded ("first hut", "first canal", ...). */
  readonly firsts = new Set<string>();

  add(entry: Omit<ChronicleEntry, 'id'>): ChronicleEntry {
    const full = { ...entry, id: this.nextId++ };
    this.entries.push(full);
    if (this.entries.length > MAX_CHRONICLE) {
      // Drop the least important old entries first so turning points survive.
      const index = this.entries.findIndex((e) => e.importance === 1);
      this.entries.splice(index >= 0 ? index : 0, 1);
    }
    return full;
  }

  /** Record a first, once per world. Returns the entry, or null if already recorded. */
  first(key: string, entry: Omit<ChronicleEntry, 'id' | 'kind'>): ChronicleEntry | null {
    if (this.firsts.has(key)) return null;
    this.firsts.add(key);
    return this.add({ ...entry, kind: 'first' });
  }

  since(id: number): ChronicleEntry[] {
    const out: ChronicleEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].id > id; i--) out.push(this.entries[i]);
    return out.reverse();
  }

  get lastId(): number {
    return this.nextId - 1;
  }

  serialize(): Record<string, unknown> {
    return { entries: this.entries, nextId: this.nextId, firsts: [...this.firsts] };
  }

  restore(data: Record<string, unknown> | undefined): void {
    if (!data) return;
    this.entries = (data.entries as ChronicleEntry[]) ?? [];
    this.nextId = (data.nextId as number) ?? this.entries.length + 1;
    this.firsts.clear();
    for (const key of (data.firsts as string[]) ?? []) this.firsts.add(key);
  }
}

export interface ObituaryInput {
  name: string;
  epithet: string | null;
  generation: number;
  ageYears: number;
  children: number;
  reason: string;
  /** A short clause the atlas can vouch for, e.g. "shielding a grandchild". */
  circumstance: string | null;
}

const REASONS: Record<string, string> = {
  starvation: 'of hunger',
  dehydration: 'of thirst',
  exposure: 'of cold',
  'old age': 'of old age',
  predation: 'to a predator',
  injuries: 'of injuries',
  lightning: 'struck by lightning',
  fever: 'of fever',
  fire: 'in a fire',
  'the observer': 'by the observer’s hand',
};

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function obituary(input: ObituaryInput): string {
  const who = input.epithet ? `${input.name} ${input.epithet}` : input.name;
  const generation = input.generation === 0 ? 'a founder' : `of the ${ordinal(input.generation)} generation`;
  const age = `${Math.round(input.ageYears)} years`;
  const children =
    input.children === 0 ? 'no children' : input.children === 1 ? 'one child' : `${input.children} children`;
  const reason = REASONS[input.reason] ?? `of ${input.reason}`;
  const circumstance = input.circumstance ? `, ${input.circumstance}` : '';
  return `${who}, ${generation}, lived ${age} and left ${children}. Died ${reason}${circumstance}.`;
}
