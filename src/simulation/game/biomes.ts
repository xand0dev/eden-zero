import type { WorldRules } from './laws';

/**
 * Biomes — different islands with different physics.
 *
 * A biome changes how the terrain is generated and adds its own law-like
 * modifiers. The river valley is the world the simulation was built on; the
 * others are unlocked by what the observer has seen survive.
 */

export interface TerrainParams {
  /** Added to the elevation threshold for open water; positive floods more land. */
  seaLevel: number;
  /** Added to moisture before the forest threshold. */
  moistureBias: number;
  /** Elevation above which land is rock. */
  rockLevel: number;
  /** How strongly the edges fall away: higher gives a smaller island. */
  falloff: number;
  /** Frequency multiplier on the base noise: higher gives more, smaller islands. */
  scale: number;
  /** Whether sea water (connected to the map edge) is drinkable. */
  saltSea: boolean;
  /** Whether shallow tiles grow reeds (fertile). */
  fertileShallows: boolean;
  /** Raise the centre into a volcanic cone. */
  volcano: number;
}

export const DEFAULT_TERRAIN: TerrainParams = {
  seaLevel: 0,
  moistureBias: 0,
  rockLevel: 0.78,
  falloff: 1.02,
  scale: 1,
  saltSea: false,
  fertileShallows: false,
  volcano: 0,
};

export interface BiomeDefinition {
  id: string;
  name: string;
  description: string;
  unlock?: string;
  terrain: Partial<TerrainParams>;
  apply(rules: WorldRules): void;
  /** Legacy multiplier, as for laws. */
  multiplier: number;
}

export const BIOMES: BiomeDefinition[] = [
  {
    id: 'valley',
    name: 'River valley',
    description: 'A temperate island cut by fresh water. Where every world begins.',
    terrain: {},
    multiplier: 1,
    apply: () => undefined,
  },
  {
    id: 'archipelago',
    name: 'Archipelago',
    description: 'Water everywhere, little forest, reeds in the shallows. Timber is precious.',
    unlock: 'reach-era-3',
    terrain: { seaLevel: 0.05, scale: 1.7, moistureBias: -0.06, fertileShallows: true, falloff: 0.85 },
    multiplier: 1.2,
    apply: (r) => {
      r.timberRegen *= 0.7;
    },
  },
  {
    id: 'steppe',
    name: 'Steppe',
    description: 'Wide dry grassland with few rivers. Wells and canals decide who lives.',
    unlock: 'survive-drought',
    terrain: { seaLevel: -0.035, moistureBias: -0.14 },
    multiplier: 1.35,
    apply: (r) => {
      r.dryness *= 1.35;
      r.thirstRate *= 1.1;
      r.crisisWeights.drought = (r.crisisWeights.drought ?? 1) * 2;
    },
  },
  {
    id: 'taiga',
    name: 'Taiga',
    description: 'Dense cold forest. Long winters, abundant timber, hungry predators.',
    unlock: 'survive-harsh-winter',
    terrain: { moistureBias: 0.12 },
    multiplier: 1.4,
    apply: (r) => {
      r.temperatureOffset -= 3;
      r.seasonAmplitude *= 1.4;
      r.timberRegen *= 1.4;
      r.predatorsAtGenesis *= 1.5;
      r.crisisWeights.harshWinter = (r.crisisWeights.harshWinter ?? 1) * 2;
    },
  },
  {
    id: 'volcanic',
    name: 'Volcanic island',
    description: 'Rich black soil around a smoking cone. Fertile, warm, and prone to fire.',
    unlock: 'survive-5-crises',
    terrain: { volcano: 0.55, rockLevel: 0.74 },
    multiplier: 1.3,
    apply: (r) => {
      r.plantRegen *= 1.25;
      r.soilRecovery *= 1.5;
      r.temperatureOffset += 2;
      r.crisisWeights.fire = (r.crisisWeights.fire ?? 1) * 3;
    },
  },
  {
    id: 'salt-coast',
    name: 'Salt coast',
    description: 'The sea is salt. Fresh water is only in inland lakes, and in wells, if anyone digs them.',
    unlock: 'reach-era-5',
    terrain: { saltSea: true, seaLevel: -0.01 },
    multiplier: 1.6,
    apply: (r) => {
      r.crisisWeights.drought = (r.crisisWeights.drought ?? 1) * 1.5;
    },
  },
];

const BIOME_BY_ID = new Map(BIOMES.map((biome) => [biome.id, biome]));

export function biomeById(id: string | undefined): BiomeDefinition {
  return BIOME_BY_ID.get(id ?? 'valley') ?? BIOMES[0];
}

export function terrainParamsFor(biomeId: string | undefined): TerrainParams {
  return { ...DEFAULT_TERRAIN, ...biomeById(biomeId).terrain };
}
