import { useState } from 'react';
import { sim, useSim, formatSimTime } from '../../ui/sim';
import { game, useGameUi } from '../../ui/game';
import { ERA_NAMES, ERA_NUMERALS } from '../../simulation/game/eras';
import { SEASON_NAMES } from '../../simulation/game/calendar';
import { CHALLENGES, GOAL_TEXT, goalProgress } from '../../meta/challenges';

const SEASON_GLYPH = ['❀', '☀', '❦', '❄'];

/** Era chip with a popover of what the next era needs. */
export function EraChip(): JSX.Element | null {
  const view = useSim().game;
  const [open, setOpen] = useState(false);
  if (!view) return null;
  const next = view.era + 1;
  const met = view.nextEra.filter((r) => r.met).length;
  return (
    <div className="era-chip-wrap">
      <button className={`era-chip ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title="What the next era needs">
        <span className="era-numeral">{ERA_NUMERALS[view.era]}</span>
        <span className="era-name">{ERA_NAMES[view.era]}</span>
        {view.era < 4 ? (
          <span className="era-progress">
            <i style={{ width: `${(met / Math.max(1, view.nextEra.length)) * 100}%` }} />
          </span>
        ) : null}
      </button>
      {open && view.era < 4 ? (
        <div className="era-pop glass">
          <h3>
            Towards era {ERA_NUMERALS[next]} — {ERA_NAMES[next]}
          </h3>
          {view.nextEra.map((r) => (
            <div key={r.label} className={`era-req ${r.met ? 'met' : ''}`}>
              <span>{r.label}</span>
              <b>
                {r.current} / {r.target}
              </b>
            </div>
          ))}
          {view.eraHold > 0 ? (
            <div className="era-hold">
              Everything is in place. Holding for two days: <b>{Math.round(view.eraHold * 100)}%</b>
            </div>
          ) : (
            <div className="muted small">An era arrives when every condition has held for two days.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The current age and its omen; opens the Book of Life. */
export function AgeChip(): JSX.Element | null {
  const view = useSim().game;
  if (!view) return null;
  const { age } = view;
  const [now, target] = age.progress;
  return (
    <button
      className={`age-chip ${age.omenMet ? 'met' : ''}`}
      onClick={() => game.openJournal('life')}
      title={`${age.title} — ${age.text} Omen: ${age.omen} (B)`}
    >
      <span className="age-index">{age.index}</span>
      <span className="age-name">{age.title.replace('The Age of ', '')}</span>
      {age.index > 1 ? (
        <span className="era-progress">
          <i style={{ width: `${age.omenMet ? 100 : Math.min(100, (now / Math.max(1, target)) * 100)}%` }} />
        </span>
      ) : null}
    </button>
  );
}

export function SeasonChip(): JSX.Element | null {
  const view = useSim().game;
  if (!view) return null;
  const name = SEASON_NAMES[view.season];
  return (
    <div className={`season-chip season-${name}`} title={`Year ${view.year}, day ${view.day + 1} — ${name}`}>
      <span className="season-glyph">{SEASON_GLYPH[view.season]}</span>
      <span className="season-text">
        <b>{name}</b>
        <em>year {view.year}</em>
      </span>
      <span className="season-bar">
        <i style={{ width: `${view.seasonPhase * 100}%` }} />
      </span>
    </div>
  );
}

export function FavourMeter(): JSX.Element | null {
  const view = useSim().game;
  if (!view || !view.favour.enabled) return null;
  const fraction = view.favour.value / view.favour.cap;
  return (
    <div className="favour" title="Favour: what you can afford to do. It grows as the world thrives.">
      <span className="favour-label">favour</span>
      <span className="favour-value">{Math.floor(view.favour.value)}</span>
      <span className="favour-bar">
        <i style={{ width: `${Math.min(100, fraction * 100)}%` }} />
      </span>
    </div>
  );
}

export function CrisisBanner(): JSX.Element | null {
  const view = useSim().game;
  if (!view?.crisis) return null;
  const crisis = view.crisis;
  const warning = crisis.phase === 'warning';
  return (
    <div className={`crisis-banner glass ${warning ? 'omen' : 'active'} crisis-${crisis.kind}`}>
      <div className="crisis-head">
        <span className="crisis-tag">{warning ? 'Omen' : crisis.name}</span>
        <span className="crisis-time">
          {warning ? 'begins in' : 'ends in'} {formatSimTime(Math.max(0, crisis.seconds))}
        </span>
      </div>
      <div className="crisis-text">{crisis.text}</div>
      <div className="crisis-advice">{crisis.advice}</div>
    </div>
  );
}

export function Toasts(): JSX.Element {
  const { toasts } = useGameUi();
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`toast glass toast-${toast.kind}`}
          onClick={() => {
            if (toast.focusId) sim.select(toast.focusId);
            game.dismiss(toast.id);
          }}
        >
          <b>{toast.title}</b>
          <span>{toast.text}</span>
        </button>
      ))}
    </div>
  );
}

/** The challenge's goal and deadline, when a challenge is running. */
export function GoalCard(): JSX.Element | null {
  const state = useSim();
  const ui = useGameUi();
  const view = state.game;
  const stats = state.stats;
  const config = state.config;
  if (!view || !stats) return null;
  if (config.mode === 'challenge' && config.challengeId) {
    const challenge = CHALLENGES.find((c) => c.id === config.challengeId);
    if (!challenge) return null;
    const progress = goalProgress(challenge.goal, view, stats);
    const years = view.year - 1 + (view.day % 8) / 8;
    return (
      <div className="goal-card">
        <h3>{challenge.name}</h3>
        <div className="goal-line">
          <span>{GOAL_TEXT[challenge.goal.kind](challenge.goal.target)}</span>
          <b>
            {progress} / {challenge.goal.target}
          </b>
        </div>
        <div className="goal-line muted">
          <span>year {years.toFixed(1)} of {challenge.deadline}</span>
          <span>
            gold ≤ {challenge.gold} · silver ≤ {challenge.silver}
          </span>
        </div>
        {ui.medal ? <div className={`medal medal-${ui.medal}`}>{ui.medal}</div> : null}
      </div>
    );
  }
  if (config.mode === 'daily') {
    return (
      <div className="goal-card">
        <h3>Daily world</h3>
        <div className="goal-line">
          <span>Score when year 6 begins</span>
          <b>year {view.year}</b>
        </div>
        <div className="goal-line muted">
          <span>people ×10 · era ×50 · atlas ×5 · crises ×25</span>
        </div>
      </div>
    );
  }
  return null;
}

/** The director's current subject, shown while it is steering the camera. */
export function DirectorCaption(): JSX.Element | null {
  const ui = useGameUi();
  const state = useSim();
  if (!ui.director || ui.directorTarget === null) return null;
  const entity = state.entities.find((e) => e.id === ui.directorTarget);
  if (!entity) return null;
  const epithet = state.game?.epithets[entity.id];
  return (
    <div className="director-caption">
      <span className="director-tag">director</span> {state.detail?.id === entity.id ? state.detail.name : `#${entity.id}`}
      {epithet ? ` ${epithet}` : ''} — {ui.directorReason}
    </div>
  );
}
