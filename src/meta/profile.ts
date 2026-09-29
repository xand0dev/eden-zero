import type { Genome } from '../simulation/genetics/genome';

/**
 * The observer's profile — everything that outlives a world.
 *
 * Atlas discoveries, achievements, challenge medals, daily results and the
 * genome vault. Kept in `localStorage` because it is small (tens of kilobytes)
 * and must survive every world being deleted; worlds themselves are too large
 * for it and live in IndexedDB (see persistence/store.ts).
 *
 * Metaprogression unlocks *questions*, not power: new laws, new islands, new
 * tools to look with. A veteran is never stronger inside a world, only able to
 * set up stranger ones.
 */

export interface VaultGenome {
  id: string;
  name: string;
  epithet: string | null;
  world: string;
  biome: string;
  generation: number;
  /** Crises this person's world had come through when they were kept. */
  crises: string[];
  savedAt: string;
  genome: Genome;
}

export interface DailyResult {
  date: string;
  score: number;
  era: number;
  population: number;
  replayHash: string;
}

export interface Profile {
  version: 1;
  /** Atlas entry id -> first time seen. */
  atlas: Record<string, { at: string; world: string; name: string }>;
  /** Achievement id -> when earned. */
  achievements: Record<string, string>;
  /** Challenge id -> best medal. */
  medals: Record<string, 'bronze' | 'silver' | 'gold'>;
  daily: Record<string, DailyResult>;
  vault: VaultGenome[];
  /** Observer tools ever used. */
  toolsUsed: string[];
  stats: {
    worlds: number;
    campaignsFinished: number;
    yearsObserved: number;
    favourSpent: number;
    legacy: number;
    pulses: number;
  };
  tutorialDone: boolean;
  /** Names the observer gave to behaviours the atlas could not classify. */
  namedBehaviours: Array<{ name: string; note: string; world: string; at: string }>;
}

const KEY = 'eden0.profile.v1';
export const VAULT_LIMIT = 12;
export const VAULT_PER_WORLD = 3;

export function emptyProfile(): Profile {
  return {
    version: 1,
    atlas: {},
    achievements: {},
    medals: {},
    daily: {},
    vault: [],
    toolsUsed: [],
    stats: { worlds: 0, campaignsFinished: 0, yearsObserved: 0, favourSpent: 0, legacy: 0, pulses: 0 },
    tutorialDone: false,
    namedBehaviours: [],
  };
}

let cached: Profile | null = null;
const listeners = new Set<() => void>();

export function loadProfile(): Profile {
  if (cached) return cached;
  try {
    const text = window.localStorage.getItem(KEY);
    cached = text ? { ...emptyProfile(), ...(JSON.parse(text) as Profile) } : emptyProfile();
  } catch {
    cached = emptyProfile();
  }
  return cached;
}

export function saveProfile(profile: Profile): void {
  cached = profile;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Storage full or blocked: the profile still lives for this session.
  }
  for (const listener of listeners) listener();
}

export function updateProfile(mutate: (profile: Profile) => void): Profile {
  const profile = structuredClone(loadProfile());
  mutate(profile);
  saveProfile(profile);
  return profile;
}

export function subscribeProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getProfileSnapshot(): Profile {
  return loadProfile();
}

/** How many laws a charter may hold: three, rising to five with experience. */
export function maxLaws(profile: Profile): number {
  const earned = Object.keys(profile.achievements).length;
  return earned >= 60 ? 5 : earned >= 25 ? 4 : 3;
}

/** A genome as a short string another observer can paste. */
export function encodeGenome(entry: VaultGenome): string {
  const json = JSON.stringify({ n: entry.name, e: entry.epithet, w: entry.world, b: entry.biome, g: entry.generation, genome: entry.genome });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `EDEN0-GENOME:${btoa(binary)}`;
}

export function decodeGenome(text: string): VaultGenome | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('EDEN0-GENOME:')) return null;
  try {
    const binary = atob(trimmed.slice('EDEN0-GENOME:'.length));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes)) as {
      n: string;
      e: string | null;
      w: string;
      b: string;
      g: number;
      genome: Genome;
    };
    if (!data.genome || typeof data.genome !== 'object') return null;
    return {
      id: `import-${Date.now().toString(36)}`,
      name: String(data.n ?? 'Stranger'),
      epithet: data.e ?? null,
      world: String(data.w ?? 'elsewhere'),
      biome: String(data.b ?? 'valley'),
      generation: Number(data.g ?? 0),
      crises: [],
      savedAt: new Date().toISOString(),
      genome: data.genome,
    };
  } catch {
    return null;
  }
}
