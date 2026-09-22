import { useSyncExternalStore } from 'react';
import { SimClient, type SimState } from '../worker/client';

/** Single simulation client for the whole app. */
export const sim = new SimClient();

/**
 * Shared-observation mode.
 *
 * If the page is opened with `?server=<url>` the client attaches to a
 * server-hosted world instead of running its own in a Web Worker. Passing
 * `?server=auto` derives the URL from the page origin, which is what the
 * container image and the deployed build use — same origin, `/world` path.
 *
 * This is a URL flag rather than a UI toggle on purpose: it is a deployment
 * decision, not something an observer should have to discover in a menu.
 */
const params = new URLSearchParams(window.location.search);

/**
 * Whether the page exposes debug handles on `window`.
 *
 * Development builds always do. A production build requires an explicit
 * `?debug=1`, so a deployed world has no back door unless whoever deployed it
 * asked for one — and the URL makes that visible rather than hidden.
 */
export const debugEnabled = import.meta.env.DEV || params.has('debug');

const server = params.get('server');
if (server) {
  const url = server === 'auto' ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/world` : server;
  sim.connectRemote(url);
}

// Expose the client so the UI can be driven from a script
// (see scripts/verify-ui.mjs and scripts/shared-check.mjs).
if (debugEnabled) {
  (window as unknown as Record<string, unknown>).__eden = sim;
}

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
