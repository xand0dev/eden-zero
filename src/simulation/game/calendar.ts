import { DAY_SECONDS } from '../../shared/constants';
import { TUNING } from './tuning';

/**
 * The calendar: a year of four seasons on top of the day/night cycle.
 *
 * A year is eight days — 32 simulated minutes — so a person with the typical
 * forty-year lifespan (`BIO_YEAR_SECONDS` = 150) lives through about three
 * winters. That ratio is the point: long enough for a winter to be something a
 * village prepares for, short enough that one life sees several.
 *
 * Seasons change the *physics* of the world — how fast plants regrow, how cold
 * the nights are, how quickly water evaporates. Nothing here tells anyone what to
 * do about it.
 */

export const YEAR_DAYS = 8;
export const YEAR_SECONDS = YEAR_DAYS * DAY_SECONDS;

export const Season = {
  Spring: 0,
  Summer: 1,
  Autumn: 2,
  Winter: 3,
} as const;
export type Season = (typeof Season)[keyof typeof Season];

export const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'] as const;

export interface CalendarState {
  /** Whole years since genesis, starting at 1. */
  year: number;
  /** 0..1 through the current year. */
  yearPhase: number;
  season: Season;
  /** 0..1 through the current season. */
  seasonPhase: number;
  /** Whole days since genesis. */
  day: number;
}

export function calendarAt(simTime: number): CalendarState {
  const years = Math.max(0, simTime) / YEAR_SECONDS;
  const yearPhase = years - Math.floor(years);
  const seasonFloat = yearPhase * 4;
  const season = Math.min(3, Math.floor(seasonFloat)) as Season;
  return {
    year: Math.floor(years) + 1,
    yearPhase,
    season,
    seasonPhase: seasonFloat - season,
    day: Math.floor(Math.max(0, simTime) / DAY_SECONDS),
  };
}

/**
 * Multipliers the seasons apply to the world, blended smoothly between the
 * middle of one season and the middle of the next so nothing jumps at a
 * boundary.
 */
export interface SeasonFactors {
  /** Degrees added to the ambient temperature. */
  temperature: number;
  /** Wild plant food regrowth. */
  plantRegen: number;
  /** Seed dispersal. Nothing sprouts in winter. */
  plantSpread: number;
  /** Crop growth in fields. */
  fieldGrowth: number;
  /** Rate at which people get thirsty. */
  thirst: number;
  /** Rate at which stored and loose food spoils. */
  spoilage: number;
  /** Food a crop yields when brought in. */
  harvestYield: number;
  /** Rate at which exhausted ground recovers. */
  soilRecovery: number;
}

/** Values at the middle of each season: spring, summer, autumn, winter. */
const TABLE: Record<keyof SeasonFactors, [number, number, number, number]> = {
  temperature: [0.5, 3, -0.5, -3],
  plantRegen: [1.3, 1, 0.85, 0.3],
  plantSpread: [1.6, 1, 0.6, 0],
  fieldGrowth: [1.15, 1.1, 0.9, 0.2],
  thirst: [1, 1.2, 1, 0.9],
  spoilage: [1, 2.4, 1, 0.5],
  harvestYield: [1, 1, 1.35, 0.8],
  soilRecovery: [1.5, 1, 1, 0.5],
};

export interface SeasonOptions {
  /** Scales the temperature swing; 0 flattens the year. */
  amplitude: number;
  /** A year with no winter: winter is replaced by a second spring. */
  eternalSpring: boolean;
}

export const DEFAULT_SEASON_OPTIONS: SeasonOptions = { amplitude: 1, eternalSpring: false };

export function seasonFactors(simTime: number, options: SeasonOptions = DEFAULT_SEASON_OPTIONS): SeasonFactors {
  const yearPhase = calendarAt(simTime).yearPhase;
  // Season centres sit at 0.125, 0.375, 0.625, 0.875 of the year.
  const position = yearPhase * 4 - 0.5;
  const index = Math.floor(position);
  const t = position - index;
  const blend = 0.5 - 0.5 * Math.cos(Math.PI * t);
  const a = ((index % 4) + 4) % 4;
  const b = (a + 1) % 4;
  const out = {} as SeasonFactors;
  for (const key of Object.keys(TABLE) as Array<keyof SeasonFactors>) {
    const row = TABLE[key];
    const va = options.eternalSpring && a === 3 ? row[0] : row[a];
    const vb = options.eternalSpring && b === 3 ? row[0] : row[b];
    let value = va + (vb - va) * blend;
    const depth = TUNING.seasonDepth;
    if (key === 'temperature') value *= options.amplitude * depth;
    else value = 1 + (value - 1) * Math.min(2, Math.max(0, options.amplitude)) * depth;
    // Nothing regrows below zero, however deep the season.
    out[key] = key === 'temperature' ? value : Math.max(0, value);
  }
  return out;
}
