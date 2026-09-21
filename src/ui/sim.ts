import { useSyncExternalStore } from 'react';
import { SimClient, type SimState } from '../worker/client';

/** Single simulation client for the whole app. */
export const sim = new SimClient();

export function useSim(): SimState {
  return useSyncExternalStore(sim.subscribe, sim.getSnapshot, sim.getSnapshot);
}

export function useSimSelector<T>(selector: (state: SimState) => T): T {
  return useSyncExternalStore(
    sim.subscribe,
    () => selector(sim.getSnapshot()),
    () => selector(sim.getSnapshot()),
  );
}

/** Short human-readable elapsed time from simulated seconds. */
export function formatSimTime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Clock time from a 0..1 day phase. */
export function formatDayPhase(phase: number): string {
  const totalMinutes = phase * 24 * 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function formatAge(years: number): string {
  if (years < 1) return `${Math.round(years * 12)}mo`;
  return `${years.toFixed(1)}y`;
}

export function stageName(stage: number): string {
  return ['Baby', 'Child', 'Adult', 'Older adult'][stage] ?? 'Unknown';
}
