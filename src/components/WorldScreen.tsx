import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sim, useSim, formatSimTime, formatDayPhase } from '../ui/sim';
import { WorldRenderer } from '../render/renderer';
import { generateTerrain } from '../simulation/environment/terrain';
import { Inspector } from './Inspector';
import { EventFeed } from './EventFeed';
import { DevPanel } from './DevPanel';
import { GenomeEditor } from './GenomeEditor';
import { GenealogyPanel } from './GenealogyPanel';
import { readAutosave, readManualSlot, unwrapSave, writeManualSlot, wrapSave, downloadSave, pickSaveFile } from '../simulation/persistence/save';
import type { GodCommandKind } from '../shared/protocol';

type Tool = GodCommandKind | 'select' | 'genome';

const TOOLS: Array<{ id: Tool; glyph: string; label: string; hint: string }> = [
  { id: 'select', glyph: '◎', label: 'Select', hint: 'Click a human to observe it. Pan by dragging, zoom with the wheel.' },
  { id: 'spawnHuman', glyph: '✚', label: 'Spawn human', hint: 'Click anywhere to create a new adult human with a fresh genome.' },
  { id: 'spawnPredator', glyph: '▲', label: 'Spawn predator', hint: 'Release a predator. It runs the same neural architecture as a human.' },
  { id: 'spawnFood', glyph: '❋', label: 'Spawn food', hint: 'Place a food pile. The ecosystem does not need it — this is an intervention.' },
  { id: 'lightning', glyph: '⚡', label: 'Lightning', hint: 'Strike a position. Damages everything within a radius.' },
  { id: 'moveHuman', glyph: '✥', label: 'Move human', hint: 'Click a human, then click a destination to reposition it.' },
  { id: 'kill', glyph: '☠', label: 'Kill', hint: 'Click a human to end its life. The death is recorded with a reason.' },
  { id: 'genome', glyph: '⌬', label: 'Edit genome', hint: 'Click a human to open its genome editor.' },
];

export function WorldScreen({
  showHint,
  onDismissHint,
}: {
  showHint: boolean;
  onDismissHint(): void;
}): JSX.Element {
  const state = useSim();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pendingMoveId, setPendingMoveId] = useState<number | null>(null);
  const [genomeTarget, setGenomeTarget] = useState<number | null>(null);
  const [temperature, setTemperature] = useState(0);
  const [showGenealogy, setShowGenealogy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // --- renderer lifecycle -------------------------------------------------
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return undefined;
    const renderer = new WorldRenderer({
      onSelect: (id) => sim.select(id),
      onWorldClick: (x, y, id) => handleWorldClickRef.current(x, y, id),
      onFps: (fps) => sim.reportFps(fps),
    });
    rendererRef.current = renderer;

    void renderer.init(container).then(() => {
      // React StrictMode mounts, unmounts and remounts effects in development.
      // If this instance was torn down while `app.init` was still awaiting, its
      // canvas must not be attached a second time.
      if (renderer.isDestroyed) return;
      const terrain = generateTerrain(sim.getSnapshot().config.seed);
      renderer.setTerrain(terrain);
    });

    return () => {
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.destroy();
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return undefined;
    const unsubscribe = sim.onEntities((entities) => renderer.onEntities(entities));
    return unsubscribe;
  }, []);

  useEffect(() => {
    rendererRef.current?.setEffects(state.effects);
  }, [state.effects]);

  useEffect(() => {
    rendererRef.current?.setStructures(state.structures, state.tick);
  }, [state.structures, state.tick]);

  useEffect(() => {
    rendererRef.current?.setLight(state.light);
  }, [state.light]);

  useEffect(() => {
    rendererRef.current?.setSelected(state.selectedId);
  }, [state.selectedId]);

  // --- god tool dispatch --------------------------------------------------
  const handleWorldClick = useCallback(
    (x: number, y: number, hitId: number | null) => {
      if (tool === 'select') return;
      if (tool === 'moveHuman') {
        if (pendingMoveId === null) {
          if (hitId !== null) {
            setPendingMoveId(hitId);
            setStatus('Now click a destination.');
          } else {
            setStatus('Click a human first.');
          }
        } else {
          sim.god({ kind: 'moveHuman', id: pendingMoveId, x, y });
          setPendingMoveId(null);
          setStatus(null);
        }
        return;
      }
      if (tool === 'genome') {
        if (hitId !== null) setGenomeTarget(hitId);
        else setStatus('Click directly on a human.');
        return;
      }
      if (tool === 'kill') {
        if (hitId !== null) sim.god({ kind: 'kill', id: hitId });
        else setStatus('Click directly on a human.');
        return;
      }
      if (tool === 'spawnHuman') sim.god({ kind: 'spawnHuman', x, y });
      if (tool === 'spawnPredator') sim.god({ kind: 'spawnPredator', x, y });
      if (tool === 'spawnFood') sim.god({ kind: 'spawnFood', x, y });
      if (tool === 'lightning') sim.god({ kind: 'lightning', x, y });
    },
    [tool, pendingMoveId],
  );

  const handleWorldClickRef = useRef(handleWorldClick);
  handleWorldClickRef.current = handleWorldClick;

  // --- keyboard shortcuts -------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      const current = sim.getSnapshot();

      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setDevVisible((value) => !value);
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          sim.setSpeed(current.paused ? 1 : 0);
          break;
        case '.':
          event.preventDefault();
          sim.stepOnce();
          break;
        case '1':
          sim.setSpeed(1);
          break;
        case '2':
          sim.setSpeed(5);
          break;
        case '3':
          sim.setSpeed(20);
          break;
        case '4':
          sim.setSpeed(100);
          break;
        case '5':
          sim.setSpeed(-1);
          break;
        case 'f':
        case 'F':
          rendererRef.current?.setFollow(current.selectedId);
          break;
        case 'Escape':
          setTool('select');
          setPendingMoveId(null);
          setStatus(null);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [devVisible, setDevVisible] = useState(false);

  // --- save / load --------------------------------------------------------
  const manualSave = useCallback(async () => {
    const payload = await sim.serialize();
    const snapshot = sim.getSnapshot();
    writeManualSlot(wrapSave(payload, snapshot.config.seed, snapshot.tick, snapshot.simTime));
    setStatus('Saved to the local slot.');
  }, []);

  const manualLoad = useCallback(() => {
    const text = readManualSlot() ?? readAutosave();
    if (!text) {
      setStatus('Nothing saved yet.');
      return;
    }
    const result = unwrapSave(text);
    if (!result.ok || !result.payload) {
      setStatus(result.error ?? 'Save could not be read.');
      return;
    }
    sim.restore(result.payload);
    setStatus(`Loaded world "${result.seed ?? '?'}" at tick ${result.tick ?? 0}.`);
  }, []);

  const exportSave = useCallback(async () => {
    const payload = await sim.serialize();
    const snapshot = sim.getSnapshot();
    downloadSave(wrapSave(payload, snapshot.config.seed, snapshot.tick, snapshot.simTime), snapshot.config.seed);
    setStatus('Exported a save file.');
  }, []);

  const importSave = useCallback(async () => {
    const text = await pickSaveFile();
    if (!text) return;
    const result = unwrapSave(text);
    if (!result.ok || !result.payload) {
      setStatus(result.error ?? 'Save could not be read.');
      return;
    }
    sim.restore(result.payload);
    setStatus('Imported world.');
  }, []);

  const stats = state.stats;
  const activeTool = useMemo(() => TOOLS.find((entry) => entry.id === tool), [tool]);

  return (
    <div className="app">
      <div className="world">
        <div className="topbar">
          <div className="brand">
            EDEN<span>//0</span>
          </div>
          <div className="stat-strip">
            <span>
              pop <b>{stats?.population ?? 0}</b>
            </span>
            <span>
              gen <b>{stats?.oldestGeneration ?? 0}</b>
            </span>
            <span>
              births <b>{stats?.births ?? 0}</b>
            </span>
            <span>
              deaths <b>{stats?.deaths ?? 0}</b>
            </span>
            <span>
              predators <b>{stats?.predators ?? 0}</b>
            </span>
            <span>
              plants <b>{stats?.plants ?? 0}</b>
            </span>
            <span title="Huts finished / building sites still wanting timber">
              huts <b>{stats?.huts ?? 0}</b>
              {(stats?.sites ?? 0) > 0 && <em> +{stats?.sites} sites</em>}
            </span>
          </div>
          <div className="spacer" />
          <div className="speed-group">
            <button className={state.paused ? 'active' : ''} onClick={() => sim.setSpeed(0)} title="Pause (Space)">
              ⏸
            </button>
            <button onClick={() => sim.stepOnce()} title="Advance one tick (.)">
              ⏭
            </button>
            {[1, 5, 20, 100].map((preset) => (
              <button
                key={preset}
                className={!state.paused && state.speed === preset ? 'active' : ''}
                onClick={() => sim.setSpeed(preset)}
              >
                ×{preset}
              </button>
            ))}
            <button
              className={!state.paused && state.speed === -1 ? 'active' : ''}
              onClick={() => sim.setSpeed(-1)}
              title="Run as fast as possible"
            >
              MAX
            </button>
          </div>
          <div className="clock">
            {formatDayPhase(state.dayPhase)} · {formatSimTime(state.simTime)} · tick {state.tick}
          </div>
        </div>

        <div className="godtools">
          <h3>God tools</h3>
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              className={`tool ${tool === entry.id ? 'active' : ''}`}
              onClick={() => {
                setTool(entry.id);
                setPendingMoveId(null);
                setStatus(null);
              }}
            >
              <span className="glyph">{entry.glyph}</span>
              {entry.label}
            </button>
          ))}
          {activeTool ? <div className="tool-hint">{activeTool.hint}</div> : null}
          {status ? <div className="tool-hint">{status}</div> : null}

          <hr />
          <h3>Environment</h3>
          <div className="field">
            <label>Temperature {temperature >= 0 ? '+' : ''}{temperature.toFixed(1)}°</label>
            <input
              type="range"
              min={-16}
              max={20}
              step={0.5}
              value={temperature}
              onChange={(event) => {
                const value = Number(event.target.value);
                setTemperature(value);
                sim.god({ kind: 'temperature', offset: value });
              }}
            />
          </div>
          <div className="field">
            <label>Time of day — {formatDayPhase(state.dayPhase)}</label>
            <input
              type="range"
              min={0}
              max={0.999}
              step={0.01}
              value={state.dayPhase}
              onChange={(event) => sim.god({ kind: 'timeOfDay', phase: Number(event.target.value) })}
            />
          </div>

          <hr />
          <h3>World</h3>
          <button onClick={manualSave}>Save</button>
          <button onClick={manualLoad}>Load</button>
          <button onClick={exportSave}>Export file</button>
          <button onClick={importSave}>Import file</button>
          <button
            onClick={() => {
              sim.requestGenealogy();
              setShowGenealogy(true);
            }}
          >
            Family tree
          </button>
        </div>

        <div className="viewport" ref={viewportRef}>
          <div className="readout">
            {stats ? (
              <>
                {stats.ambientTemperature.toFixed(1)}°C · {Math.round(state.light * 100)}% light
                <br />
                tps {state.metrics.tps.toFixed(0)} · fps {state.fps.toFixed(0)}
              </>
            ) : null}
          </div>
          {showHint ? (
            <div className="hint" onClick={onDismissHint} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
              drag to pan · wheel to zoom · click a human · <span className="kbd">space</span> pause ·{' '}
              <span className="kbd">f</span> follow · click to dismiss
            </div>
          ) : (
            <div className="hint">
              <span className="kbd">space</span> pause · <span className="kbd">.</span> step ·{' '}
              <span className="kbd">1-5</span> speed · <span className="kbd">f</span> follow ·{' '}
              <span className="kbd">esc</span> cancel tool
            </div>
          )}
        </div>

        <div className="inspector">
          <Inspector />
        </div>

        <div className="timeline">
          <EventFeed />
        </div>
      </div>

      {devVisible ? <DevPanel onClose={() => setDevVisible(false)} /> : null}
      {genomeTarget !== null ? (
        <GenomeEditor humanId={genomeTarget} onClose={() => setGenomeTarget(null)} />
      ) : null}
      {showGenealogy ? <GenealogyPanel onClose={() => setShowGenealogy(false)} /> : null}
    </div>
  );
}
