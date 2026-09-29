import { sim, useSim, formatSimTime } from '../../ui/sim';
import { game, useGameUi } from '../../ui/game';
import { ERA_NAMES, ERA_NUMERALS } from '../../simulation/game/eras';
import { charterMultiplier, lawById } from '../../simulation/game/laws';
import { biomeById } from '../../simulation/game/biomes';
import { updateProfile } from '../../meta/profile';

/**
 * The end of a campaign: extinction, a city, a challenge decided, a daily scored,
 * or the observer closing the book. The page reads like the last page of a
 * history — turning points, the best-known lives, what fate did — and it is
 * where the legacy of this world is counted.
 */
export function Summary(): JSX.Element | null {
  const ui = useGameUi();
  const state = useSim();
  const view = state.game;
  const stats = state.stats;
  if (!ui.summary || !view || !stats) return null;

  const reason = ui.summary.reason;
  const headline =
    reason === 'extinct'
      ? 'The last of them is gone.'
      : reason === 'city'
        ? 'A city stands where eight people woke.'
        : reason === 'challenge'
          ? ui.summary.medal
            ? `Challenge complete — ${ui.summary.medal}.`
            : 'The challenge was not met in time.'
          : reason === 'daily'
            ? `Daily world scored: ${ui.summary.score ?? 0}.`
            : 'The observer closes the book.';

  const multiplier = charterMultiplier(view.charter) * biomeById(view.biome).multiplier;
  const legacy = Math.round(
    (view.era * 100 + stats.oldestGeneration * 20 + view.crisesSurvived * 40 + view.discovered.length * 10) * multiplier,
  );
  const turning = state.chronicle.filter((e) => e.importance >= 3).slice(-8);
  const lives = state.chronicle.filter((e) => e.kind === 'death' && e.importance >= 2).slice(-4);

  return (
    <div className="modal-backdrop summary-backdrop">
      <div className="modal glass summary">
        <div className="kicker">
          {view.mode === 'campaign' ? 'Campaign' : view.mode} · {biomeById(view.biome).name} · year {view.year}
        </div>
        <h2>{headline}</h2>
        <div className="summary-stats">
          <div>
            <b>
              {ERA_NUMERALS[view.era]} · {ERA_NAMES[view.era]}
            </b>
            <span>era reached</span>
          </div>
          <div>
            <b>{stats.population}</b>
            <span>alive · peak {Math.max(0, ...view.populationHistory)}</span>
          </div>
          <div>
            <b>{stats.oldestGeneration}</b>
            <span>generations</span>
          </div>
          <div>
            <b>{view.crisesSurvived}</b>
            <span>crises weathered</span>
          </div>
          <div>
            <b>{view.discovered.length}</b>
            <span>behaviours seen</span>
          </div>
          <div>
            <b>{legacy}</b>
            <span>legacy ×{multiplier.toFixed(2)}</span>
          </div>
        </div>
        {view.charter.length > 0 ? (
          <div className="chips">
            {view.charter.map((id) => (
              <span key={id} className="chip">
                {lawById(id)?.name ?? id}
              </span>
            ))}
          </div>
        ) : null}
        <h3>Turning points</h3>
        <div className="summary-list">
          {turning.map((e) => (
            <div key={e.id}>
              <span className="chronicle-time">{formatSimTime(e.simTime)}</span> <b>{e.title}</b> — {e.text}
            </div>
          ))}
        </div>
        {lives.length > 0 ? (
          <>
            <h3>Remembered</h3>
            <div className="summary-list">
              {lives.map((e) => (
                <div key={e.id}>{e.text}</div>
              ))}
            </div>
          </>
        ) : null}
        <div className="muted small">
          Keep a genome from this world in the vault before you leave (Journal → Vault) — it can found another.
        </div>
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              updateProfile((p) => {
                p.stats.legacy += legacy;
              });
              game.closeSummary();
              sim.leave();
            }}
          >
            New world
          </button>
          <button onClick={() => game.openJournal('vault')}>Vault</button>
          <button
            onClick={() => {
              game.closeSummary();
              if (!view.extinct) sim.setSpeed(1);
            }}
          >
            {view.extinct ? 'Look around' : 'Keep watching'}
          </button>
        </div>
      </div>
    </div>
  );
}
