import { useEffect, useMemo, useState } from 'react';
import { sim } from '../ui/sim';
import { game, useGameUi } from '../ui/game';
import { IslandPreview } from './IslandPreview';
import { NEURON_COUNT } from '../simulation/brain/channels';
import { LAWS, charterMultiplier, charterProblem, type LawCategory } from '../simulation/game/laws';
import { BIOMES, biomeById } from '../simulation/game/biomes';
import { unlocked } from '../meta/achievements';
import { maxLaws } from '../meta/profile';
import { CHALLENGES, GOAL_TEXT, dailyFor } from '../meta/challenges';
import { listWorlds, getWorld, type StoredWorldMeta } from '../simulation/persistence/store';
import { readAutosave, unwrapSave } from '../simulation/persistence/save';
import { ERA_NAMES } from '../simulation/game/eras';
import type { WorldConfig } from '../shared/protocol';

type Tab = 'campaign' | 'challenges' | 'daily' | 'sandbox';

const CATEGORY_LABEL: Record<LawCategory, string> = {
  physics: 'Physics',
  biology: 'Biology',
  brain: 'Brain',
  ecology: 'Ecology',
  observer: 'Observer',
};

export function Genesis(): JSX.Element {
  const ui = useGameUi();
  const profile = ui.profile;
  const [tab, setTab] = useState<Tab>(profile.tutorialDone ? 'campaign' : 'campaign');
  const [seed, setSeed] = useState(() => randomSeed());
  const [biome, setBiome] = useState('valley');
  const [charter, setCharter] = useState<string[]>([]);
  const [founders, setFounders] = useState<string[]>([]);
  const [humans, setHumans] = useState(8);
  const [predators, setPredators] = useState(2);
  const [saved, setSaved] = useState<StoredWorldMeta[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void listWorlds().then(setSaved);
  }, []);

  const limit = maxLaws(profile);
  const problem = charterProblem(charter, limit);
  const multiplier = charterMultiplier(charter) * biomeById(biome).multiplier;
  const daily = useMemo(() => dailyFor(new Date()), []);
  const previewSeed = tab === 'daily' ? daily.seed : seed;
  const previewBiome = tab === 'daily' ? daily.biome : tab === 'sandbox' ? 'valley' : biome;

  const toggleLaw = (id: string): void => {
    setCharter((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const launch = (config: WorldConfig): void => {
    game.resetForNewWorld();
    sim.start(config);
  };

  const startCampaign = (): void => {
    const genomes = founders
      .map((id) => profile.vault.find((v) => v.id === id)?.genome)
      .filter((g): g is NonNullable<typeof g> => Boolean(g));
    launch({
      seed: seed || 'eden',
      initialHumans: 8,
      initialPredators: 2,
      plantDensity: 1,
      mode: 'campaign',
      charter,
      biome,
      founderGenomes: genomes,
    });
  };

  const continueWorld = async (meta?: StoredWorldMeta): Promise<void> => {
    const text = meta ? await getWorld(meta.key) : readAutosave();
    if (!text) {
      setNotice('That world could not be read.');
      return;
    }
    const result = unwrapSave(text);
    if (!result.ok || !result.payload) {
      setNotice(result.error ?? 'That world could not be read.');
      return;
    }
    game.resetForNewWorld();
    sim.restore(result.payload);
  };

  return (
    <div className="app">
      <div className="genesis">
        <IslandPreview seed={previewSeed} biome={previewBiome} />
        <div className="genesis-shade" />
        <div className="genesis-content">
          <div className="genesis-intro">
            <div className="kicker">An artificial life observatory</div>
            <h1>
              EDEN<span>//0</span>
            </h1>
            <p className="tagline">You don’t control life. You define its laws.</p>
            <p className="lede">
              People wake beside fresh water with {NEURON_COUNT}-neuron brains, a genome and no instructions. Nothing in this world is
              scripted: behaviour is whatever their neural activity, their bodies and a lifetime of learning produce. Write the laws,
              intervene sparingly, and try to understand what comes of it.
            </p>
            {saved.length > 0 ? (
              <div className="continue-list">
                <div className="kicker">Continue</div>
                {saved.slice(0, 3).map((meta) => (
                  <button key={meta.key} onClick={() => void continueWorld(meta)}>
                    <b>{meta.seed}</b>
                    <span>
                      {meta.mode ?? 'world'} · {meta.era !== undefined ? ERA_NAMES[meta.era] : ''} · {meta.population ?? '?'} people ·{' '}
                      {(meta.bytes / 1024 / 1024).toFixed(1)} MB
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="card glass genesis-card">
            <div className="genesis-tabs">
              {(
                [
                  ['campaign', 'Campaign'],
                  ['challenges', 'Challenges'],
                  ['daily', 'Daily'],
                  ['sandbox', 'Sandbox'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'campaign' ? (
              <div className="genesis-panel">
                <div className="field">
                  <label htmlFor="seed">World seed</label>
                  <input id="seed" type="text" value={seed} spellCheck={false} onChange={(e) => setSeed(e.target.value)} />
                </div>
                <div className="field">
                  <label>Island</label>
                  <div className="biome-grid">
                    {BIOMES.map((b) => {
                      const open = unlocked(profile, b.unlock);
                      return (
                        <button
                          key={b.id}
                          className={`biome ${biome === b.id ? 'active' : ''}`}
                          disabled={!open}
                          title={open ? b.description : `Locked — ${unlockText(b.unlock)}`}
                          onClick={() => setBiome(b.id)}
                        >
                          <b>{b.name}</b>
                          <span>{open ? `×${b.multiplier.toFixed(2)}` : 'locked'}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="muted small">{biomeById(biome).description}</div>
                </div>
                <div className="field">
                  <label>
                    Charter <b>{charter.length}/{limit} laws</b> · legacy <b>×{multiplier.toFixed(2)}</b>
                  </label>
                  <div className="charter">
                    {(Object.keys(CATEGORY_LABEL) as LawCategory[]).map((category) => (
                      <div key={category} className="charter-group">
                        <span className="charter-cat">{CATEGORY_LABEL[category]}</span>
                        {LAWS.filter((law) => law.category === category).map((law) => {
                          const open = unlocked(profile, law.unlock);
                          const on = charter.includes(law.id);
                          const excluded = !on && (law.excludes ?? []).some((x) => charter.includes(x));
                          return (
                            <button
                              key={law.id}
                              className={`law ${on ? 'on' : ''}`}
                              disabled={!open || excluded || (!on && charter.length >= limit)}
                              title={open ? `${law.description} (×${law.multiplier})` : `Locked — ${unlockText(law.unlock)}`}
                              onClick={() => toggleLaw(law.id)}
                            >
                              {open ? law.name : `${law.name} · locked`}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {problem ? <div className="warning small">{problem}</div> : null}
                </div>
                {profile.vault.length > 0 ? (
                  <div className="field">
                    <label>Founders from the vault (up to 3)</label>
                    <div className="chips">
                      {profile.vault.map((v) => {
                        const on = founders.includes(v.id);
                        return (
                          <button
                            key={v.id}
                            className={`chip ${on ? 'on' : ''}`}
                            disabled={!on && founders.length >= 3}
                            onClick={() => setFounders(on ? founders.filter((x) => x !== v.id) : [...founders, v.id])}
                          >
                            {v.name}
                            {v.epithet ? ` ${v.epithet}` : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="actions">
                  <button className="primary" disabled={problem !== null} onClick={startCampaign}>
                    Genesis
                  </button>
                </div>
              </div>
            ) : null}

            {tab === 'challenges' ? (
              <div className="genesis-panel challenge-list">
                {CHALLENGES.map((c) => {
                  const medal = profile.medals[c.id];
                  const open = c.charter.every((id) => unlocked(profile, LAWS.find((l) => l.id === id)?.unlock)) &&
                    unlocked(profile, biomeById(c.biome).unlock);
                  return (
                    <button
                      key={c.id}
                      className={`challenge ${medal ? `medal-${medal}` : ''}`}
                      disabled={!open}
                      onClick={() =>
                        launch({
                          seed: c.seed,
                          initialHumans: c.founders ?? 8,
                          initialPredators: c.predators ?? 2,
                          plantDensity: 1,
                          mode: 'challenge',
                          charter: c.charter,
                          biome: c.biome,
                          challengeId: c.id,
                        })
                      }
                    >
                      <b>
                        {c.name} {medal ? <em>{medal}</em> : null}
                      </b>
                      <span>{open ? c.brief : 'Locked — unlock its island and laws first.'}</span>
                      <span className="muted">
                        Goal: {GOAL_TEXT[c.goal.kind](c.goal.target)} within {c.deadline} years
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {tab === 'daily' ? (
              <div className="genesis-panel">
                <div className="kicker">{daily.date}</div>
                <p className="small">
                  Everyone gets the same world today: {biomeById(daily.biome).name} under{' '}
                  {daily.charter.map((id) => LAWS.find((l) => l.id === id)?.name).join(' and ')}. Your score is taken when year 6
                  begins.
                </p>
                {profile.daily[daily.date] ? (
                  <div className="row">
                    <span>Your best today</span>
                    <b>{profile.daily[daily.date].score}</b>
                  </div>
                ) : null}
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() =>
                      launch({
                        seed: daily.seed,
                        initialHumans: 8,
                        initialPredators: 2,
                        plantDensity: 1,
                        mode: 'daily',
                        charter: daily.charter,
                        biome: daily.biome,
                      })
                    }
                  >
                    Play today’s world
                  </button>
                </div>
              </div>
            ) : null}

            {tab === 'sandbox' ? (
              <div className="genesis-panel">
                <div className="field">
                  <label htmlFor="sandbox-seed">World seed</label>
                  <input id="sandbox-seed" type="text" value={seed} spellCheck={false} onChange={(e) => setSeed(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="humans">
                    Founders <b>{humans}</b>
                  </label>
                  <input id="humans" type="range" min={2} max={40} value={humans} onChange={(e) => setHumans(Number(e.target.value))} />
                </div>
                <div className="field">
                  <label htmlFor="predators">
                    Predators <b>{predators}</b>
                  </label>
                  <input
                    id="predators"
                    type="range"
                    min={0}
                    max={12}
                    value={predators}
                    onChange={(e) => setPredators(Number(e.target.value))}
                  />
                </div>
                <div className="muted small">Sandbox: every tool is free, nothing is scored, and the codex does not count.</div>
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() =>
                      launch({ seed: seed || 'eden', initialHumans: humans, initialPredators: predators, plantDensity: 1, mode: 'sandbox' })
                    }
                  >
                    Genesis
                  </button>
                </div>
              </div>
            ) : null}
            {notice ? <div className="muted small">{notice}</div> : null}
          </div>
        </div>
        <div className="genesis-foot">
          Island preview · <b>{previewSeed || 'eden'}</b> · {biomeById(previewBiome).name} · codex{' '}
          {Object.keys(profile.achievements).length} · atlas {Object.keys(profile.atlas).length}
        </div>
      </div>
    </div>
  );
}

function unlockText(key: string | undefined): string {
  if (!key) return '';
  if (key.startsWith('reach-era-')) return `reach era ${['', '', 'III', 'IV', 'V'][Number(key.slice(-1)) - 1] ?? key.slice(-1)} in any world`;
  if (key.startsWith('survive-')) return `come through ${key.replace('survive-', '').replace(/-/g, ' ')}`;
  if (key === 'lab-conditioned') return 'see the atlas record a person you conditioned';
  return key;
}

function randomSeed(): string {
  const words = ['eden', 'orion', 'vela', 'lumen', 'tessera', 'auriga', 'kepler', 'solace'];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${Math.floor(Math.random() * 900 + 100)}`;
}
