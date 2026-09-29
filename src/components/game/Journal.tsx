import { useEffect, useMemo, useRef, useState } from 'react';
import { sim, useSim, formatSimTime } from '../../ui/sim';
import { game, useGameUi } from '../../ui/game';
import { ATLAS, RARITY_ORDER, SECTION_NAMES, type AtlasSection } from '../../simulation/game/atlas';
import { ACHIEVEMENTS, CATEGORY_NAMES, type AchievementCategory } from '../../meta/achievements';
import { decodeGenome, encodeGenome, updateProfile, VAULT_LIMIT, VAULT_PER_WORLD, type VaultGenome } from '../../meta/profile';
import { CRISES } from '../../simulation/game/crises';
import { BrainScope } from '../../render/brainScope';
import type { BrainView, ChronicleView } from '../../shared/types';

const TABS = [
  ['chronicle', 'Chronicle', 'C'],
  ['atlas', 'Atlas', 'A'],
  ['codex', 'Codex', 'K'],
  ['vault', 'Vault', 'V'],
  ['lab', 'Neuro-lab', 'N'],
] as const;

/** The journal drawer: everything the observer has learned about this world and all others. */
export function Journal(): JSX.Element | null {
  const ui = useGameUi();
  if (!ui.journal) return null;
  return (
    <div className="journal glass">
      <div className="journal-tabs">
        {TABS.map(([id, label, key]) => (
          <button key={id} className={ui.journal === id ? 'active' : ''} onClick={() => game.openJournal(id)}>
            {label}
            <span className="kbd">{key}</span>
          </button>
        ))}
        <button className="journal-close" onClick={() => game.openJournal(null)} title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="journal-body">
        {ui.journal === 'chronicle' ? <ChronicleTab /> : null}
        {ui.journal === 'atlas' ? <AtlasTab /> : null}
        {ui.journal === 'codex' ? <CodexTab /> : null}
        {ui.journal === 'vault' ? <VaultTab /> : null}
        {ui.journal === 'lab' ? <LabTab /> : null}
      </div>
    </div>
  );
}

function focus(entry: ChronicleView): void {
  if (entry.entityIds[0] !== undefined && sim.getSnapshot().entities.some((e) => e.id === entry.entityIds[0])) {
    sim.select(entry.entityIds[0]);
  }
  if (entry.x !== undefined && entry.y !== undefined) {
    window.dispatchEvent(new CustomEvent('eden:focus', { detail: { x: entry.x, y: entry.y } }));
  }
}

// --- chronicle ---------------------------------------------------------------------

function PopulationGraph({ history }: { history: number[] }): JSX.Element | null {
  if (history.length < 2) return null;
  const width = 400;
  const height = 64;
  const max = Math.max(10, ...history);
  const step = width / (history.length - 1);
  const points = history.map((p, i) => `${(i * step).toFixed(1)},${(height - (p / max) * (height - 6) - 3).toFixed(1)}`);
  return (
    <svg className="pop-graph" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={`0,${height} ${points.join(' ')} ${width},${height}`} className="pop-area" />
      <polyline points={points.join(' ')} className="pop-line" />
      <text x={width - 4} y={12} textAnchor="end" className="pop-label">
        peak {Math.max(...history)}
      </text>
    </svg>
  );
}

function ChronicleTab(): JSX.Element {
  const state = useSim();
  const [level, setLevel] = useState<1 | 2 | 3>(2);
  const entries = useMemo(
    () => state.chronicle.filter((e) => e.importance >= level).slice().reverse(),
    [state.chronicle, level],
  );
  const view = state.game;
  return (
    <div>
      <div className="journal-section">
        <h3>Population</h3>
        {view ? <PopulationGraph history={view.populationHistory} /> : null}
        {view && view.crisisHistory.length > 0 ? (
          <div className="chips">
            {view.crisisHistory.map((c, i) => (
              <span key={i} className={`chip ${c.survived ? 'ok' : 'bad'}`}>
                year {c.year} · {CRISES[c.kind as keyof typeof CRISES]?.name ?? c.kind}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="journal-filter">
        {([
          [3, 'Turning points'],
          [2, 'Notable'],
          [1, 'Everything'],
        ] as const).map(([value, label]) => (
          <button key={value} className={level === value ? 'active' : ''} onClick={() => setLevel(value)}>
            {label}
          </button>
        ))}
      </div>
      {entries.length === 0 ? <div className="empty">Nothing recorded yet.</div> : null}
      <div className="chronicle">
        {entries.map((entry) => (
          <button key={entry.id} className={`chronicle-entry kind-${entry.kind} imp-${entry.importance}`} onClick={() => focus(entry)}>
            <span className="chronicle-time">{formatSimTime(entry.simTime)}</span>
            <b>{entry.title}</b>
            <span>{entry.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// --- atlas ----------------------------------------------------------------------------

function AtlasTab(): JSX.Element {
  const ui = useGameUi();
  const state = useSim();
  const seenHere = new Set(state.game?.discovered ?? []);
  const seen = ui.profile.atlas;
  const total = ATLAS.length;
  const found = ATLAS.filter((e) => seen[e.id]).length;
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  return (
    <div>
      <div className="journal-section">
        <div className="atlas-progress">
          <b>
            {found} / {total}
          </b>{' '}
          behaviours seen · {seenHere.size} in this world
          <span className="atlas-bar">
            <i style={{ width: `${(found / total) * 100}%` }} />
          </span>
        </div>
        <div className="muted small">
          Nobody wrote these behaviours. The atlas only watches, and names a pattern when a person’s record matches it.
        </div>
      </div>
      {(Object.keys(SECTION_NAMES) as AtlasSection[]).map((section) => (
        <div key={section} className="journal-section">
          <h3>{SECTION_NAMES[section]}</h3>
          <div className="atlas-grid">
            {ATLAS.filter((e) => e.section === section)
              .sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity))
              .map((entry) => {
                const known = seen[entry.id];
                return (
                  <div key={entry.id} className={`atlas-card rarity-${entry.rarity} ${known ? 'known' : 'unknown'}`}>
                    <div className="atlas-card-head">
                      <b>{known ? entry.name : '? ? ?'}</b>
                      <span className="rarity">{entry.rarity}</span>
                    </div>
                    {known ? (
                      <>
                        <div className="atlas-desc">{entry.description}</div>
                        <div className="atlas-crit">{entry.criterion}</div>
                        <div className="atlas-meta">
                          first seen in {known.name} · {known.world}
                          {entry.epithet ? ` · epithet “${entry.epithet}”` : ''}
                          {seenHere.has(entry.id) ? ' · seen here' : ''}
                        </div>
                      </>
                    ) : (
                      <div className="atlas-crit">{entry.criterion}</div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      <div className="journal-section">
        <h3>Behaviours the atlas cannot name</h3>
        <div className="muted small">
          If you see someone do something regular that no entry describes, name it here. Your own entries stay in your profile.
        </div>
        <div className="name-behaviour">
          <input id="behaviour-name" type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input id="behaviour-note" type="text" placeholder="What they do, and when" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            disabled={!name.trim()}
            onClick={() => {
              updateProfile((p) => {
                p.namedBehaviours.push({ name: name.trim(), note: note.trim(), world: sim.getSnapshot().config.seed, at: new Date().toISOString() });
              });
              game.refreshProfile();
              setName('');
              setNote('');
            }}
          >
            Record
          </button>
        </div>
        {ui.profile.namedBehaviours.map((b, i) => (
          <div key={i} className="row">
            <span>
              <b>{b.name}</b> — {b.note}
            </span>
            <em className="muted">{b.world}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- codex -----------------------------------------------------------------------------

function CodexTab(): JSX.Element {
  const ui = useGameUi();
  const earned = ui.profile.achievements;
  const count = Object.keys(earned).length;
  return (
    <div>
      <div className="journal-section">
        <div className="atlas-progress">
          <b>
            {count} / {ACHIEVEMENTS.length}
          </b>{' '}
          in the codex
          <span className="atlas-bar">
            <i style={{ width: `${(count / ACHIEVEMENTS.length) * 100}%` }} />
          </span>
        </div>
        <div className="muted small">
          The codex unlocks laws and islands. Charters hold three laws; four after twenty-five entries, five after sixty.
        </div>
      </div>
      {(Object.keys(CATEGORY_NAMES) as AchievementCategory[]).map((category) => {
        const items = ACHIEVEMENTS.filter((a) => a.category === category);
        const got = items.filter((a) => earned[a.id]).length;
        return (
          <div key={category} className="journal-section">
            <h3>
              {CATEGORY_NAMES[category]} · {got}/{items.length}
            </h3>
            <div className="codex-grid">
              {items.map((a) => {
                const has = Boolean(earned[a.id]);
                const secret = a.hidden && !has;
                return (
                  <div key={a.id} className={`codex-item ${has ? 'earned' : ''}`} title={secret ? 'Hidden' : a.description}>
                    <b>{secret ? '???' : a.name}</b>
                    <span>{secret ? 'Something rare.' : a.description}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- vault -----------------------------------------------------------------------------

function VaultTab(): JSX.Element {
  const ui = useGameUi();
  const state = useSim();
  const [paste, setPaste] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const detail = state.detail;
  const seed = state.config.seed;
  const fromThisWorld = ui.profile.vault.filter((v) => v.world === seed).length;
  const canKeep =
    detail !== null && ui.profile.vault.length < VAULT_LIMIT && fromThisWorld < VAULT_PER_WORLD;

  const keep = (): void => {
    if (!detail) return;
    const genome = Object.fromEntries(detail.genome.map((g) => [g.key, g.value]));
    const entry: VaultGenome = {
      id: `${seed}-${detail.id}`,
      name: detail.name,
      epithet: detail.epithet,
      world: seed,
      biome: state.game?.biome ?? 'valley',
      generation: detail.generation,
      crises: (state.game?.crisisHistory ?? []).filter((c) => c.survived).map((c) => c.kind),
      savedAt: new Date().toISOString(),
      genome: { ...(genome as Record<string, number>), species: 0 } as unknown as VaultGenome['genome'],
    };
    updateProfile((p) => {
      if (!p.vault.some((v) => v.id === entry.id)) p.vault.push(entry);
    });
    game.refreshProfile();
    setMessage(`${detail.name}’s genome is in the vault.`);
  };

  return (
    <div>
      <div className="journal-section">
        <div className="muted small">
          Keep up to {VAULT_PER_WORLD} genomes from each world, {VAULT_LIMIT} in all. A kept genome can found a new world — only the
          genome travels: a brain is rebuilt from it at birth and learns its own life.
        </div>
        <button disabled={!canKeep} onClick={keep} className="wide">
          {detail ? `Keep ${detail.name}’s genome` : 'Select a person to keep their genome'}
        </button>
        {message ? <div className="muted small">{message}</div> : null}
      </div>
      <div className="journal-section">
        <h3>
          Vault · {ui.profile.vault.length}/{VAULT_LIMIT}
        </h3>
        {ui.profile.vault.length === 0 ? <div className="empty">Empty.</div> : null}
        {ui.profile.vault.map((v) => (
          <div key={v.id} className="vault-item">
            <div>
              <b>
                {v.name}
                {v.epithet ? ` ${v.epithet}` : ''}
              </b>
              <span className="muted">
                {' '}
                · gen {v.generation} · {v.world} · {v.biome}
                {v.crises.length ? ` · survived ${v.crises.join(', ')}` : ''}
              </span>
            </div>
            <div className="vault-actions">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(encodeGenome(v)).then(
                    () => setMessage('Copied. Anyone can paste it into their vault.'),
                    () => setMessage(encodeGenome(v)),
                  );
                }}
              >
                Copy
              </button>
              <button
                onClick={() => {
                  updateProfile((p) => {
                    p.vault = p.vault.filter((x) => x.id !== v.id);
                  });
                  game.refreshProfile();
                }}
              >
                Release
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="journal-section">
        <h3>Receive a genome</h3>
        <div className="name-behaviour">
          <input id="genome-paste" type="text" placeholder="EDEN0-GENOME:…" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button
            disabled={!paste.trim() || ui.profile.vault.length >= VAULT_LIMIT}
            onClick={() => {
              const entry = decodeGenome(paste);
              if (!entry) {
                setMessage('That is not a genome string.');
                return;
              }
              updateProfile((p) => {
                p.vault.push(entry);
              });
              game.refreshProfile();
              setPaste('');
              setMessage(`${entry.name} is in your vault.`);
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// --- neuro-lab ----------------------------------------------------------------------------

function PairScope({ brain, name }: { brain: BrainView | null; name: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const scope = useRef<BrainScope | null>(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    scope.current = new BrainScope(ref.current);
    scope.current.setMode('compact');
    scope.current.setLearning(true);
    return () => {
      scope.current?.destroy();
      scope.current = null;
    };
  }, []);
  useEffect(() => {
    scope.current?.setData(brain, null, name);
  }, [brain, name]);
  return <canvas ref={ref} className="brain-canvas lab-canvas" />;
}

function LabTab(): JSX.Element {
  const state = useSim();
  const view = state.game;
  const detail = state.detail;
  const [pinned, setPinned] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    if (!pinned || state.selectedId === null) return undefined;
    const id = window.setInterval(() => sim.requestBrainPair(state.selectedId!, pinned.id), 900);
    return () => window.clearInterval(id);
  }, [pinned, state.selectedId]);

  const price = (kind: string): string => (view?.favour.enabled ? ` · ${view.favour.prices[kind] ?? 0}` : '');
  const cooldown = (kind: string): number => view?.favour.cooldowns[kind] ?? 0;

  return (
    <div>
      <div className="journal-section">
        <div className="muted small">
          The only lever here is the learning signal. A pulse adds to the valence this brain learns from, for half a second: whatever
          it was doing in that moment is strengthened (reward) or weakened (pain). You choose the moment; the brain decides what is
          learned. Gold synapses in the view are the ones that have moved since birth.
        </div>
      </div>
      {!detail ? (
        <div className="empty">Select a person to work with.</div>
      ) : (
        <div className="journal-section">
          <h3>
            Subject · {detail.name}
            {detail.epithet ? ` ${detail.epithet}` : ''}
          </h3>
          <div className="row">
            <span>Doing now</span>
            <b>{detail.currentAction}</b>
          </div>
          <div className="row">
            <span>Mean drift since birth</span>
            <b>{detail.weightDrift.toFixed(4)}</b>
          </div>
          <div className="row">
            <span>Atlas entries</span>
            <b>{detail.atlas.length}</b>
          </div>
          <div className="lab-buttons">
            <button
              className="reward"
              disabled={cooldown('rewardPulse') > 0}
              onClick={() => sim.god({ kind: 'rewardPulse', id: detail.id })}
            >
              Reward pulse{price('rewardPulse')}
            </button>
            <button className="pain" disabled={cooldown('painPulse') > 0} onClick={() => sim.god({ kind: 'painPulse', id: detail.id })}>
              Pain pulse{price('painPulse')}
            </button>
          </div>
          <div className="lab-buttons">
            <button onClick={() => setPinned({ id: detail.id, name: detail.name })}>Pin for comparison</button>
            {pinned ? <button onClick={() => setPinned(null)}>Unpin {pinned.name}</button> : null}
          </div>
        </div>
      )}
      {pinned && detail && pinned.id !== detail.id ? (
        <div className="journal-section">
          <h3>
            {detail.name} ↔ {pinned.name}
          </h3>
          <div className="lab-pair">
            <div>
              <PairScope brain={state.brainPair?.a ?? null} name={detail.name} />
              <div className="muted small">drift {state.brainPair?.a?.weightDrift.toFixed(4) ?? '—'}</div>
            </div>
            <div>
              <PairScope brain={state.brainPair?.b ?? null} name={pinned.name} />
              <div className="muted small">drift {state.brainPair?.b?.weightDrift.toFixed(4) ?? '—'}</div>
            </div>
          </div>
        </div>
      ) : pinned ? (
        <div className="muted small journal-section">Now select someone else to compare with {pinned.name}.</div>
      ) : null}
      <div className="journal-section">
        <h3>Experiments worth trying</h3>
        <ul className="lab-list">
          <li>Reward someone each time they eat from a harvest pile — does the atlas start calling them a grain eater?</li>
          <li>Pulse pain when a person approaches the water at night. Do they learn to drink by day?</li>
          <li>Under the Lamarck law, condition a mother and watch whether her children start where she ended.</li>
          <li>Pin two siblings and compare: same parents, different lives, different brains.</li>
        </ul>
      </div>
    </div>
  );
}
