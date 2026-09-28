import { useCallback, useEffect, useMemo, useState } from 'react';
import { sim, useSim } from '../ui/sim';
import { readAutosave, unwrapSave, writeAutosave, wrapSave } from '../simulation/persistence/save';
import { WorldScreen } from '../components/WorldScreen';
import { IslandPreview } from '../components/IslandPreview';
import type { WorldConfig } from '../shared/protocol';
import { NEURON_COUNT } from '../simulation/brain/channels';

/**
 * Application shell: the Genesis screen, and the world itself.
 *
 * Genesis is intentionally minimal — a seed, a population size, and two buttons.
 * A giant configuration menu would be premature for V0.
 */
export function App(): JSX.Element {
  const state = useSim();
  const [seed, setSeed] = useState(() => randomSeed());
  const [humans, setHumans] = useState(8);
  const [predators, setPredators] = useState(2);
  const [hasAutosave, setHasAutosave] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [hintDismissed, setHintDismissed] = useState(false);

  useEffect(() => {
    setHasAutosave(readAutosave() !== null);
  }, []);

  const config = useMemo<WorldConfig>(
    () => ({ seed, initialHumans: humans, initialPredators: predators, plantDensity: 1 }),
    [seed, humans, predators],
  );

  const startWorld = useCallback(() => {
    sim.start(config);
  }, [config]);

  const loadAutosave = useCallback(async () => {
    const text = readAutosave();
    if (!text) {
      setNotice('No autosave found yet.');
      return;
    }
    const result = unwrapSave(text);
    if (!result.ok || !result.payload) {
      setNotice(result.error ?? 'Autosave could not be read.');
      return;
    }
    sim.restore(result.payload);
  }, []);

  // Autosave every 20 simulated seconds of wall-clock time while a world is open.
  useEffect(() => {
    if (state.phase !== 'world') return undefined;
    const interval = window.setInterval(async () => {
      const payload = await sim.serialize();
      const text = wrapSave(payload, state.config.seed, sim.getSnapshot().tick, sim.getSnapshot().simTime);
      writeAutosave(text);
      setHasAutosave(true);
    }, 20000);
    return () => window.clearInterval(interval);
  }, [state.phase, state.config.seed]);

  if (state.phase === 'genesis') {
    return (
      <div className="app">
        <div className="genesis">
          <IslandPreview seed={seed} />
          <div className="genesis-shade" />
          <div className="genesis-content">
            <div className="genesis-intro">
              <div className="kicker">An artificial life observatory</div>
              <h1>
                EDEN<span>//0</span>
              </h1>
              <p className="tagline">Create a world. Watch what survives.</p>
              <p className="lede">
                {humans} humans wake up beside fresh water with {NEURON_COUNT}-neuron brains, a genome and
                no instructions. Nothing in this world is scripted: behaviour is whatever their neural
                activity, their physiology and their lifetime learning produce.
              </p>
            </div>

            <div className="card glass">
              <div className="field">
                <label htmlFor="seed">World seed</label>
                <input
                  id="seed"
                  type="text"
                  value={seed}
                  spellCheck={false}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="humans">
                  Founders <b>{humans}</b>
                </label>
                <input
                  id="humans"
                  type="range"
                  min={2}
                  max={40}
                  value={humans}
                  onChange={(event) => setHumans(Number(event.target.value))}
                />
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
                  onChange={(event) => setPredators(Number(event.target.value))}
                />
              </div>

              <div className="actions">
                <button className="primary" onClick={startWorld}>
                  Genesis
                </button>
                <button onClick={loadAutosave} disabled={!hasAutosave}>
                  Load world
                </button>
              </div>

              <div className="muted">
                {hasAutosave ? 'An autosaved world is available.' : 'No autosaved world yet — genesis will create one.'}
              </div>
              {notice ? <div className="muted">{notice}</div> : null}
            </div>
          </div>
          <div className="genesis-foot">
            Island preview · seed <b>{seed || 'eden'}</b>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <WorldScreen
        showHint={!hintDismissed}
        onDismissHint={() => setHintDismissed(true)}
      />
    </>
  );
}

function randomSeed(): string {
  const words = ['eden', 'orion', 'vela', 'lumen', 'tessera', 'auriga', 'kepler', 'solace'];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${Math.floor(Math.random() * 900 + 100)}`;
}
