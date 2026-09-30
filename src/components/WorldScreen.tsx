import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sim, useSim, formatSimTime, formatDayPhase, debugEnabled } from '../ui/sim';
import { WorldRenderer } from '../render/renderer';
import { generateTerrain } from '../simulation/environment/terrain';
import { Inspector } from './Inspector';
import { EventFeed } from './EventFeed';
import { DevPanel } from './DevPanel';
import { GenomeEditor } from './GenomeEditor';
import { GenealogyPanel } from './GenealogyPanel';
import { ScoreBoard } from './ScoreBoard';
import { readAutosave, readManualSlot, unwrapSave, writeManualSlot, wrapSave, downloadSave, pickSaveFile } from '../simulation/persistence/save';
import { getWorld, putWorld } from '../simulation/persistence/store';
import type { GodCommandKind } from '../shared/protocol';
import { game, useGameUi } from '../ui/game';
import { CrisisBanner, DirectorCaption, AgeChip, EraChip, FavourMeter, GoalCard, SeasonChip, Toasts } from './game/GameHud';
import { Journal } from './game/Journal';
import { Summary } from './game/Summary';
import { FirstDawn } from './game/FirstDawn';

type Tool = GodCommandKind | 'select' | 'genome';

const TOOLS: Array<{ id: Tool; glyph: string; label: string; hint: string; cost?: string }> = [
  { id: 'select', glyph: '◎', label: 'Select', hint: 'Click a human to observe it. Pan by dragging, zoom with the wheel.' },
  { id: 'rain', glyph: '☂', label: 'Rain', hint: 'Call rain over a spot: fields drink, the ground recovers, fires go out.', cost: 'rain' },
  { id: 'spawnFood', glyph: '❋', label: 'Food', hint: 'Place a food pile. The ecosystem does not need it — this is an intervention.', cost: 'spawnFood' },
  { id: 'bless', glyph: '✦', label: 'Bless', hint: 'Click a person: heal their wounds and cure fever.', cost: 'bless' },
  { id: 'lightning', glyph: '⚡', label: 'Lightning', hint: 'Strike a position. Damages everything within a radius, and burns a blighted field clean.', cost: 'lightning' },
  { id: 'moveHuman', glyph: '✥', label: 'Move', hint: 'Click a human, then click a destination to reposition it.', cost: 'moveHuman' },
  { id: 'rewardPulse', glyph: '+', label: 'Reward pulse', hint: 'Click a person: their brain learns that what it was just doing was good.', cost: 'rewardPulse' },
  { id: 'painPulse', glyph: '−', label: 'Pain pulse', hint: 'Click a person: their brain learns that what it was just doing was bad.', cost: 'painPulse' },
  { id: 'spawnHuman', glyph: '✚', label: 'Create person', hint: 'Click anywhere to create a new adult with a fresh genome. Each one costs more.', cost: 'spawnHuman' },
  { id: 'spawnPredator', glyph: '▲', label: 'Predator', hint: 'Release a predator. It runs the same neural architecture as a human.', cost: 'spawnPredator' },
  { id: 'kill', glyph: '☠', label: 'Kill', hint: 'Click a human to end its life. The death is recorded with a reason.', cost: 'kill' },
  { id: 'genome', glyph: '⌬', label: 'Edit genome', hint: 'Click a human to open its genome editor. In a campaign, only a newborn’s.', cost: 'editGenome' },
];

/** Tools that act on one person rather than a place. */
const PERSON_TOOLS = new Set<Tool>(['bless', 'rewardPulse', 'painPulse', 'kill', 'genome']);

export function WorldScreen({
  showHint,
  onDismissHint,
}: {
  showHint: boolean;
  onDismissHint(): void;
}): JSX.Element {
  const state = useSim();
  const ui = useGameUi();
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
    // Read-only handle used by scripts/shared-check.mjs to verify that motion is
    // interpolated rather than snapped to the snapshot rate.
    if (debugEnabled) {
      (window as unknown as Record<string, unknown>).__edenRenderer = renderer;
    }

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

  // The expanded brain cuts a porthole in its overlay; hold the person it shows
  // there, a little closer, so brain and behaviour are on screen together.
  useEffect(() => {
    let savedZoom: number | null = null;
    const onPorthole = (event: Event): void => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const detail = (event as CustomEvent<{ open: boolean; id: number | null; x: number; y: number }>).detail;
      if (detail.open && detail.id !== null) {
        if (savedZoom === null) savedZoom = renderer.camera.zoom;
        renderer.camera.zoom = 3.4;
        renderer.followOffset = { x: detail.x - window.innerWidth / 2, y: detail.y - window.innerHeight / 2 };
        renderer.setFollow(detail.id);
      } else {
        renderer.followOffset = { x: 0, y: 0 };
        if (savedZoom !== null) renderer.camera.zoom = savedZoom;
        savedZoom = null;
      }
    };
    window.addEventListener('eden:brain-porthole', onPorthole);
    return () => window.removeEventListener('eden:brain-porthole', onPorthole);
  }, []);

  useEffect(() => {
    rendererRef.current?.setEffects(state.effects);
  }, [state.effects]);

  useEffect(() => {
    rendererRef.current?.setStructures(state.structures, state.tick);
  }, [state.structures, state.tick]);

  useEffect(() => {
    rendererRef.current?.setCultivation(state.fields, state.canals);
  }, [state.fields, state.canals]);

  useEffect(() => {
    rendererRef.current?.setLight(state.light);
  }, [state.light]);

  useEffect(() => {
    rendererRef.current?.setSelected(state.selectedId);
  }, [state.selectedId]);

  useEffect(() => {
    rendererRef.current?.setGame(state.game);
  }, [state.game]);

  useEffect(() => {
    if (state.trails) rendererRef.current?.setTrails(state.trails);
  }, [state.trails]);

  // Name the selected person over their head, with the epithet the atlas gave them.
  useEffect(() => {
    const detail = state.detail;
    const epithet = detail ? state.game?.epithets[detail.id] : undefined;
    rendererRef.current?.setLabel(detail?.id ?? null, detail ? `${detail.name}${epithet ? ` ${epithet}` : ''}` : '');
  }, [state.detail?.id, state.detail?.name, state.game?.epithets]);

  // The director steers the camera; a chronicle entry can ask to be shown.
  useEffect(() => {
    if (ui.director && ui.directorTarget !== null) {
      rendererRef.current?.setFollow(ui.directorTarget);
      sim.select(ui.directorTarget);
    }
  }, [ui.director, ui.directorTarget]);

  useEffect(() => {
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<{ x: number; y: number }>).detail;
      rendererRef.current?.focusOn(detail.x, detail.y);
    };
    const onFollow = (event: Event): void => {
      const id = (event as CustomEvent<{ id: number }>).detail.id;
      game.setDirector(false);
      rendererRef.current?.setFollow(id);
    };
    window.addEventListener('eden:focus', onFocus);
    window.addEventListener('eden:follow', onFollow);
    return () => {
      window.removeEventListener('eden:focus', onFocus);
      window.removeEventListener('eden:follow', onFollow);
    };
  }, []);

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
      if (PERSON_TOOLS.has(tool)) {
        if (hitId === null) {
          setStatus('Click directly on a person.');
          return;
        }
        if (tool === 'kill') sim.god({ kind: 'kill', id: hitId });
        if (tool === 'bless') sim.god({ kind: 'bless', id: hitId });
        if (tool === 'rewardPulse') sim.god({ kind: 'rewardPulse', id: hitId });
        if (tool === 'painPulse') sim.god({ kind: 'painPulse', id: hitId });
        return;
      }
      if (tool === 'rain') sim.god({ kind: 'rain', x, y });
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
          if (game.getSnapshot().journal) game.openJournal(null);
          break;
        case 'c':
        case 'C':
          game.openJournal('chronicle');
          break;
        case 'a':
        case 'A':
          game.openJournal('atlas');
          break;
        case 'k':
        case 'K':
          game.openJournal('codex');
          break;
        case 'v':
        case 'V':
          game.openJournal('vault');
          break;
        case 'n':
        case 'N':
          game.openJournal('lab');
          break;
        case 'd':
        case 'D':
          game.setDirector(!game.getSnapshot().director);
          break;
        case 'b':
        case 'B':
          game.openJournal('life');
          break;
        case 'g':
        case 'G':
          rendererRef.current?.toggleGrid();
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
    const text = wrapSave(payload, snapshot.config.seed, snapshot.tick, snapshot.simTime);
    const ok = await putWorld(`slot-${snapshot.config.seed}`, text, {
      seed: snapshot.config.seed,
      tick: snapshot.tick,
      savedAt: new Date().toISOString(),
      mode: snapshot.game?.mode,
      era: snapshot.game?.era,
      population: snapshot.stats?.population,
    });
    if (!ok) writeManualSlot(text);
    setStatus(`Saved (${(text.length / 1024 / 1024).toFixed(1)} MB before compression).`);
  }, []);

  const manualLoad = useCallback(async () => {
    const seed = sim.getSnapshot().config.seed;
    const text = (await getWorld(`slot-${seed}`)) ?? readManualSlot() ?? readAutosave();
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
  const view = state.game;
  const activeTool = useMemo(() => TOOLS.find((entry) => entry.id === tool), [tool]);
  const visibleTools = TOOLS.filter((entry) => {
    if (!view) return true;
    if (entry.id !== 'select' && !view.interventionsAllowed) return false;
    if (entry.id === 'spawnHuman' && !view.spawnAllowed) return false;
    return true;
  });
  const priceOf = (kind: string | undefined): string | null => {
    if (!kind || !view?.favour.enabled) return null;
    return String(view.favour.prices[kind] ?? '');
  };
  const cooldownOf = (kind: string | undefined): number => (kind && view ? view.favour.cooldowns[kind] ?? 0 : 0);
  const affordable = (kind: string | undefined): boolean =>
    !kind || !view?.favour.enabled || (view.favour.value >= (view.favour.prices[kind] ?? 0) && cooldownOf(kind) <= 0);

  return (
    <div className="app">
      <div className="world">
        <div className="topbar glass">
          <div className="brand">
            EDEN<span>//0</span>
          </div>
          <EraChip />
          <SeasonChip />
          <AgeChip />
          <div className="stat-strip">
            <span>
              pop <b>{stats?.population ?? 0}</b>
            </span>
            <span>
              gen <b>{stats?.oldestGeneration ?? 0}</b>
            </span>
            <span title="Huts finished / building sites still wanting timber">
              homes
              <b>
                {stats?.huts ?? 0}
                {(stats?.sites ?? 0) > 0 && <em> +{stats?.sites}</em>}
              </b>
            </span>
            <span title="Food held in granaries">
              store <b>{Math.floor(view?.storedFood ?? 0)}</b>
            </span>
            <span title="How much the land around the village has left to give">
              land <b>{Math.round((view?.landHealth ?? 1) * 100)}%</b>
            </span>
            <span>
              births <b>{stats?.births ?? 0}</b>
            </span>
            <span>
              deaths <b>{stats?.deaths ?? 0}</b>
            </span>
          </div>
          <div className="spacer" />
          <FavourMeter />
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
            <button
              className={ui.director ? 'active' : ''}
              onClick={() => game.setDirector(!ui.director)}
              title="Director: after twenty idle seconds the camera follows whoever is most worth watching (D)"
            >
              DIR
            </button>
          </div>
          <div className="clock">
            {formatDayPhase(state.dayPhase)} · {formatSimTime(state.simTime)}
          </div>
        </div>
        <ScoreBoard />
        <CrisisBanner />
        <Toasts />
        <DirectorCaption />
        <FirstDawn />

        <div className="godtools glass">
          <GoalCard />
          <h3>{view?.favour.enabled ? 'Interventions' : 'God tools'}</h3>
          {visibleTools.map((entry) => {
            const price = priceOf(entry.cost);
            const cooldown = cooldownOf(entry.cost);
            return (
              <button
                key={entry.id}
                className={`tool ${tool === entry.id ? 'active' : ''} ${affordable(entry.cost) ? '' : 'poor'}`}
                onClick={() => {
                  setTool(entry.id);
                  setPendingMoveId(null);
                  setStatus(null);
                }}
                title={entry.hint}
              >
                <span className="glyph">{entry.glyph}</span>
                <span className="tool-label">{entry.label}</span>
                {cooldown > 0 ? <span className="tool-cost">{Math.ceil(cooldown)}s</span> : price ? <span className="tool-cost">{price}</span> : null}
              </button>
            );
          })}
          {view && !view.interventionsAllowed ? (
            <div className="tool-hint">This world’s charter makes you only an observer.</div>
          ) : null}
          {activeTool ? <div className="tool-hint">{activeTool.hint}</div> : null}
          {status ? <div className="tool-hint">{status}</div> : null}

          {view?.interventionsAllowed !== false ? (
            <>
              <hr />
              <h3>Environment</h3>
              <div className="field">
                <label>
                  Temperature {temperature >= 0 ? '+' : ''}
                  {temperature.toFixed(1)}°{priceOf('temperature') ? ` · ${priceOf('temperature')}` : ''}
                </label>
                <input
                  type="range"
                  min={-16}
                  max={20}
                  step={0.5}
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                  onPointerUp={() => sim.god({ kind: 'temperature', offset: temperature })}
                  onKeyUp={() => sim.god({ kind: 'temperature', offset: temperature })}
                />
              </div>
            </>
          ) : null}

          <hr />
          <h3>Journal</h3>
          <div className="world-actions">
            <button onClick={() => game.openJournal('chronicle')}>Chronicle</button>
            <button onClick={() => game.openJournal('atlas')}>Atlas</button>
            <button onClick={() => game.openJournal('codex')}>Codex</button>
            <button onClick={() => game.openJournal('lab')}>Neuro-lab</button>
            <button onClick={() => game.openJournal('vault')}>Vault</button>
            <button
              onClick={() => {
                sim.requestGenealogy();
                setShowGenealogy(true);
              }}
            >
              Family tree
            </button>
          </div>
          <hr />
          <h3>World</h3>
          <div className="world-actions">
            <button onClick={manualSave}>Save</button>
            <button onClick={() => void manualLoad()}>Load</button>
            <button onClick={exportSave}>Export</button>
            <button onClick={importSave}>Import</button>
          </div>
          <button className="wide" onClick={() => game.endCampaign()}>
            {view?.mode === 'sandbox' ? 'Close world' : 'End campaign'}
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
              <span className="kbd">space</span> pause · <span className="kbd">1-5</span> speed · <span className="kbd">c</span>{' '}
              chronicle · <span className="kbd">a</span> atlas · <span className="kbd">d</span> director ·{' '}
              <span className="kbd">g</span> grid ·{' '}
              <span className="kbd">f</span> follow
            </div>
          )}
        </div>

        <div className={`inspector glass ${state.selectedId === null ? 'is-empty' : ''}`}>
          <Inspector />
        </div>

        <div className="timeline glass">
          <EventFeed />
        </div>
        <Journal />
      </div>

      {devVisible ? <DevPanel onClose={() => setDevVisible(false)} /> : null}
      {genomeTarget !== null ? (
        <GenomeEditor humanId={genomeTarget} onClose={() => setGenomeTarget(null)} />
      ) : null}
      {showGenealogy ? <GenealogyPanel onClose={() => setShowGenealogy(false)} /> : null}
      <Summary />
    </div>
  );
}
