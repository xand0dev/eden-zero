import { useSyncExternalStore } from 'react';
import { sim } from './sim';
import { loadProfile, updateProfile, type Profile } from '../meta/profile';
import { newlyEarned, type Achievement } from '../meta/achievements';
import { atlasEntry } from '../simulation/game/atlas';
import { CHALLENGES, MEDAL_RANK, challengeFailed, dailyScore, medalFor, type Medal } from '../meta/challenges';
import type { ChronicleView, GameView } from '../shared/types';

/**
 * The main-thread side of the game layer.
 *
 * The worker owns the world; this owns everything that outlives it or is only
 * about the observer: the profile (atlas, achievements, medals), notifications,
 * the director camera's choice of subject, and the automatic slow-down when
 * something important happens. None of it can reach into the simulation except
 * through the same commands the observer's own clicks send.
 */

export interface Toast {
  id: number;
  kind: 'discovery' | 'achievement' | 'crisis' | 'chronicle' | 'command' | 'medal' | 'era';
  title: string;
  text: string;
  /** Person to focus when the toast is clicked. */
  focusId?: number;
  x?: number;
  y?: number;
  at: number;
}

export interface GameUiState {
  toasts: Toast[];
  /** Whether the director camera is choosing who to follow. */
  director: boolean;
  directorTarget: number | null;
  directorReason: string;
  /** Automatic slow-down on important moments. */
  autoSlow: boolean;
  /** The journal drawer and which tab it shows. */
  journal: null | 'chronicle' | 'atlas' | 'codex' | 'vault' | 'lab';
  /** Set when a campaign ends (extinction, a city, or the observer closes it). */
  summary: null | { reason: 'extinct' | 'city' | 'closed' | 'challenge' | 'daily'; medal?: Medal | null; score?: number };
  /** A challenge medal earned this session. */
  medal: Medal | null;
  profile: Profile;
}

type Listener = () => void;

class GameController {
  state: GameUiState = {
    toasts: [],
    director: false,
    directorTarget: null,
    directorReason: '',
    autoSlow: true,
    journal: null,
    summary: null,
    medal: null,
    profile: loadProfile(),
  };
  private listeners = new Set<Listener>();
  private nextToast = 1;
  private lastInteraction = performance.now();
  private slowUntil = 0;
  private speedBeforeSlow: number | null = null;
  private lastAchievementCheck = 0;
  private lastYear = 0;
  private summarised = false;
  private lastCommandAt = 0;

  constructor() {
    sim.onGame((game) => this.onGame(game));
    sim.subscribe(() => this.onSim());
    for (const type of ['pointerdown', 'wheel', 'keydown']) {
      window.addEventListener(type, () => (this.lastInteraction = performance.now()), { passive: true });
    }
    window.setInterval(() => this.tick(), 500);
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GameUiState => this.state;

  private set(partial: Partial<GameUiState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  // --- toasts ----------------------------------------------------------------

  toast(toast: Omit<Toast, 'id' | 'at'>): void {
    const entry: Toast = { ...toast, id: this.nextToast++, at: performance.now() };
    this.set({ toasts: [...this.state.toasts, entry].slice(-5) });
  }

  dismiss(id: number): void {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  // --- journal, director, summary ---------------------------------------------

  openJournal(tab: GameUiState['journal']): void {
    if (tab === 'chronicle') sim.requestChronicle();
    this.set({ journal: this.state.journal === tab ? null : tab });
  }

  setDirector(on: boolean): void {
    this.set({ director: on, directorTarget: on ? this.state.directorTarget : null });
  }

  setAutoSlow(on: boolean): void {
    this.set({ autoSlow: on });
  }

  closeSummary(): void {
    this.set({ summary: null });
  }

  /** The observer ends a campaign by choice. */
  endCampaign(): void {
    this.finish('closed');
  }

  resetForNewWorld(): void {
    this.summarised = false;
    this.lastYear = 0;
    this.set({ summary: null, medal: null, toasts: [], directorTarget: null });
    updateProfile((p) => {
      p.stats.worlds += 1;
    });
    this.refreshProfile();
  }

  refreshProfile(): void {
    this.set({ profile: loadProfile() });
  }

  // --- the game stream --------------------------------------------------------------

  private onGame(game: GameView): void {
    // New atlas entries: the first time this observer has ever seen them goes into
    // the profile; every first-in-this-world gets a toast.
    for (const found of game.discoveries) {
      const entry = atlasEntry(found.id);
      if (!entry) continue;
      const known = Boolean(loadProfile().atlas[found.id]);
      if (!known) {
        updateProfile((p) => {
          p.atlas[found.id] = { at: new Date().toISOString(), world: sim.getSnapshot().config.seed, name: found.name };
        });
      }
      this.toast({
        kind: 'discovery',
        title: `${known ? 'Atlas' : 'New in the atlas'} · ${entry.name}`,
        text: `${entry.description} — ${found.name}`,
        focusId: found.humanId,
      });
      if (!known || entry.rarity === 'rare' || entry.rarity === 'legendary') this.slowDown(found.humanId);
    }
    for (const entry of game.chronicle) this.onChronicle(entry, game);

    if (game.extinct && !this.summarised && sim.getSnapshot().tick > 100) this.finish('extinct');
    if (game.era >= 4 && !this.summarised && game.mode === 'campaign') this.finish('city');

    // Years observed, for the profile.
    if (this.lastYear && game.year > this.lastYear) {
      updateProfile((p) => {
        p.stats.yearsObserved += game.year - this.lastYear;
      });
    }
    this.lastYear = game.year;

    this.checkPlayGoals(game);
  }

  private onChronicle(entry: ChronicleView, game: GameView): void {
    if (entry.importance < 3) return;
    if (entry.kind === 'discovery') return;
    this.toast({
      kind: entry.kind === 'crisis' ? 'crisis' : entry.kind === 'era' ? 'era' : 'chronicle',
      title: entry.title,
      text: entry.text,
      focusId: entry.entityIds[0],
      x: entry.x,
      y: entry.y,
    });
    this.slowDown(entry.entityIds[0] ?? null);
    void game;
  }

  private checkPlayGoals(game: GameView): void {
    const state = sim.getSnapshot();
    const stats = state.stats;
    if (!stats) return;
    const config = state.config;
    if (config.mode === 'challenge' && config.challengeId) {
      const challenge = CHALLENGES.find((c) => c.id === config.challengeId);
      if (!challenge) return;
      const medal = medalFor(challenge, game, stats);
      const best = loadProfile().medals[challenge.id];
      if (medal && (!best || MEDAL_RANK[medal] > MEDAL_RANK[best])) {
        updateProfile((p) => {
          p.medals[challenge.id] = medal;
        });
        this.set({ medal });
        this.toast({ kind: 'medal', title: `${medal[0].toUpperCase()}${medal.slice(1)} — ${challenge.name}`, text: challenge.brief });
        if (!this.summarised) this.finish('challenge', medal);
      } else if (!medal && challengeFailed(challenge, game, stats) && !this.summarised) {
        this.finish('challenge', null);
      }
    }
    if (config.mode === 'daily' && game.year >= 6 && !this.summarised) {
      const score = dailyScore(game, stats);
      const date = config.seed.replace('daily-', '');
      updateProfile((p) => {
        const previous = p.daily[date];
        if (!previous || score > previous.score) {
          p.daily[date] = { date, score, era: game.era, population: stats.population, replayHash: '' };
        }
      });
      this.finish('daily', null, score);
    }
  }

  private finish(reason: NonNullable<GameUiState['summary']>['reason'], medal?: Medal | null, score?: number): void {
    this.summarised = true;
    if (reason === 'city' || reason === 'closed' || reason === 'extinct') {
      updateProfile((p) => {
        p.stats.campaignsFinished += 1;
      });
    }
    sim.setSpeed(0);
    this.set({ summary: { reason, medal, score } });
    this.refreshProfile();
  }

  private onSim(): void {
    const state = sim.getSnapshot();
    const command = state.lastCommand;
    if (command && command.at !== this.lastCommandAt) {
      this.lastCommandAt = command.at;
      if (!command.ok) {
        this.toast({ kind: 'command', title: 'Not possible', text: command.message });
      } else {
        const game = state.game;
        updateProfile((p) => {
          if (!p.toolsUsed.includes(command.kind)) p.toolsUsed.push(command.kind);
          if (command.kind === 'rewardPulse' || command.kind === 'painPulse') p.stats.pulses += 1;
          if (game?.favour.enabled) p.stats.favourSpent += game.favour.prices[command.kind] ?? 0;
        });
      }
    }
  }

  /** Slow to x1 for a few seconds so an important moment is seen, then resume. */
  private slowDown(focusId: number | null | undefined): void {
    if (!this.state.autoSlow) return;
    const state = sim.getSnapshot();
    // Only at the watching speeds: at x100 and MAX the observer is skipping ahead
    // on purpose, and the chronicle keeps what they skip.
    if (state.paused || (state.speed !== 5 && state.speed !== 20)) return;
    if (this.speedBeforeSlow === null) this.speedBeforeSlow = state.speed;
    sim.setSpeed(1);
    this.slowUntil = performance.now() + 8000;
    if (this.state.director && focusId) this.set({ directorTarget: focusId, directorReason: 'something happened' });
  }

  private tick(): void {
    const now = performance.now();
    // Toasts fade after twelve seconds.
    const alive = this.state.toasts.filter((t) => now - t.at < 12_000);
    if (alive.length !== this.state.toasts.length) this.set({ toasts: alive });

    if (this.speedBeforeSlow !== null && now > this.slowUntil) {
      const state = sim.getSnapshot();
      if (!state.paused && state.speed === 1) sim.setSpeed(this.speedBeforeSlow);
      this.speedBeforeSlow = null;
    }

    // The director takes over after twenty idle seconds and cuts every half minute.
    const game = sim.getSnapshot().game;
    if (this.state.director && game && now - this.lastInteraction > 20_000) {
      const current = this.state.directorTarget;
      const top = game.spotlight[0];
      const stillAlive = current !== null && sim.getSnapshot().entities.some((e) => e.id === current);
      if (top && (!stillAlive || now - this.lastCut > 30_000)) {
        this.lastCut = now;
        this.set({ directorTarget: top.id, directorReason: top.reason });
      }
    }

    // Achievements, once a second at most.
    if (now - this.lastAchievementCheck > 1000) {
      this.lastAchievementCheck = now;
      this.checkAchievements();
    }
  }

  private lastCut = 0;

  private checkAchievements(): void {
    const state = sim.getSnapshot();
    if (!state.game || !state.stats) return;
    const profile = loadProfile();
    const earned: Achievement[] = newlyEarned({
      game: state.game,
      stats: state.stats,
      structures: state.structures,
      events: state.events,
      profile,
    });
    if (earned.length === 0) return;
    updateProfile((p) => {
      for (const achievement of earned) p.achievements[achievement.id] = new Date().toISOString();
    });
    for (const achievement of earned.slice(0, 3)) {
      this.toast({ kind: 'achievement', title: `Codex · ${achievement.name}`, text: achievement.description });
    }
    this.refreshProfile();
  }
}

export const game = new GameController();

export function useGameUi(): GameUiState {
  return useSyncExternalStore(game.subscribe, game.getSnapshot, game.getSnapshot);
}
