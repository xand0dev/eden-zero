import { useEffect, useState } from 'react';
import { sim, useSim } from '../ui/sim';
import { wrapSave, writeAutosave } from '../simulation/persistence/save';
import { putWorld } from '../simulation/persistence/store';
import { WorldScreen } from '../components/WorldScreen';
import { Genesis } from '../components/Genesis';
import '../ui/game';

/**
 * Application shell: the Genesis screen, and the world itself.
 */
export function App(): JSX.Element {
  const state = useSim();
  const [hintDismissed, setHintDismissed] = useState(false);

  // Autosave every twenty seconds while a world is open — into IndexedDB,
  // compressed, so a grown world no longer outgrows the browser's storage.
  useEffect(() => {
    if (state.phase !== 'world') return undefined;
    const interval = window.setInterval(async () => {
      const snapshot = sim.getSnapshot();
      if (snapshot.paused && snapshot.tick === 0) return;
      const payload = await sim.serialize();
      const now = sim.getSnapshot();
      const text = wrapSave(payload, now.config.seed, now.tick, now.simTime);
      const ok = await putWorld(`auto-${now.config.seed}`, text, {
        seed: now.config.seed,
        tick: now.tick,
        savedAt: new Date().toISOString(),
        mode: now.game?.mode,
        era: now.game?.era,
        population: now.stats?.population,
      });
      // The small-world fallback keeps working where IndexedDB is unavailable.
      if (!ok) writeAutosave(text);
    }, 20000);
    return () => window.clearInterval(interval);
  }, [state.phase]);

  if (state.phase === 'genesis') return <Genesis />;

  return <WorldScreen showHint={!hintDismissed} onDismissHint={() => setHintDismissed(true)} />;
}
