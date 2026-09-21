import { DAY_SECONDS } from '../../shared/constants';
import type { Shelter, TerrainData } from './terrain';

/**
 * Climate: day/night cycle, latitude gradient and local shelter moderation.
 *
 * Note that the biological clock is deliberately NOT tied to DAY_SECONDS — see
 * `BIO_YEAR_SECONDS`. Ageing runs on its own accelerated clock so a full
 * lifetime is observable in minutes regardless of how long a "day" lasts.
 */
export interface Climate {
  /** 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk. */
  dayPhase: number;
  /** 0 at night, 1 at midday. */
  light: number;
  /** Global temperature offset applied by the god tool, in degrees. */
  globalOffset: number;
}

export function createClimate(): Climate {
  return { dayPhase: 0.2, light: 0.5, globalOffset: 0 };
}

export function updateClimate(climate: Climate, simTime: number): void {
  climate.dayPhase = ((simTime / DAY_SECONDS) % 1 + 1) % 1;
  // Smooth solar elevation: -1 at midnight, +1 at noon.
  const sun = Math.sin((climate.dayPhase - 0.25) * Math.PI * 2);
  climate.light = clamp01((sun + 0.35) / 1.35);
}

/**
 * Ambient temperature at a world position.
 *
 * Components: latitude gradient + diurnal swing + gentle spatial variation.
 * Shelters pull the local temperature toward a comfortable 6 degrees, which is
 * what makes them worth walking to when the network learns to care.
 */
export function ambientTemperature(
  terrain: TerrainData,
  climate: Climate,
  x: number,
  y: number,
): number {
  const latitude = (y / terrain.height) * 2 - 1; // -1 north .. +1 south
  const latitudeTerm = 4.5 - latitude * 3.5;

  const diurnal = (climate.light - 0.5) * 9;

  const cell = 17;
  const cellX = Math.floor(x / cell);
  const cellY = Math.floor(y / cell);
  const spatial = pseudoNoise(cellX, cellY) * 2.2 - 1.1;

  let temperature = latitudeTerm + diurnal + spatial + climate.globalOffset;

  for (let i = 0; i < terrain.shelters.length; i++) {
    const shelter = terrain.shelters[i];
    const distance = Math.hypot(shelter.x - x, shelter.y - y);
    if (distance < shelter.radius) {
      const t = 1 - distance / shelter.radius;
      temperature += (6.5 - temperature) * t * 0.85;
    }
  }

  return temperature;
}

/** Is (x, y) inside a shelter zone? */
export function inShelter(terrain: TerrainData, x: number, y: number): Shelter | null {
  for (let i = 0; i < terrain.shelters.length; i++) {
    const shelter = terrain.shelters[i];
    if (Math.hypot(shelter.x - x, shelter.y - y) < shelter.radius) return shelter;
  }
  return null;
}

/** Cheap deterministic hash-based noise in [-1, 1]. */
function pseudoNoise(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
