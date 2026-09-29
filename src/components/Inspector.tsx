import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sim, useSim, formatAge, stageName } from '../ui/sim';
import { MOTOR_COUNT, MOTOR_NAMES, MOTOR_START } from '../simulation/brain/channels';
import { BrainScope } from '../render/brainScope';

/**
 * Human inspector: physiology, relationships, live brain and the
 * "Why did it do that?" trace.
 */
export function Inspector(): JSX.Element {
  const state = useSim();
  const detail = state.detail;

  if (state.selectedId === null) {
    return (
      <div className="empty">
        No human selected.
        <br />
        Click one in the world to open its inspector, its live brain and the
        contribution trace behind its last action.
      </div>
    );
  }

  if (!detail) {
    return <div className="empty">Reading…</div>;
  }

  return (
    <div>
      <div className="panel">
        <div className="panel-header">
          <h3>{detail.name}</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <span className={`badge ${detail.sex === 0 ? 'sex-f' : 'sex-m'}`}>
              {detail.sex === 0 ? 'female' : 'male'}
            </span>
            <span className={`badge ${detail.alive ? 'alive' : 'dead'}`}>
              {detail.alive ? 'alive' : 'dead'}
            </span>
          </div>
        </div>
        {detail.epithet ? <div className="epithet">{detail.name} {detail.epithet}</div> : null}
        <button
          className="wide follow-life"
          onClick={() => window.dispatchEvent(new CustomEvent('eden:follow', { detail: { id: detail.id } }))}
          title="Keep the camera on this person (F)"
        >
          Follow this life
        </button>
        <div className="row">
          <span>ID</span>
          <b>#{detail.id}</b>
        </div>
        <div className="row">
          <span>Age</span>
          <b>
            {formatAge(detail.ageBio)} · {stageName(detail.stage)}
          </b>
        </div>
        <div className="row">
          <span>Generation</span>
          <b>{detail.generation}</b>
        </div>
        {!detail.alive ? (
          <div className="row">
            <span>Died</span>
            <b>
              tick {detail.deathTick} · {detail.deathReason}
            </b>
          </div>
        ) : null}
        <div className="row">
          <span>Action</span>
          <b>{detail.currentAction}</b>
        </div>
        <div className="row">
          <span>Sensory focus</span>
          <b>{detail.currentFocus}</b>
        </div>
        <div className="row">
          <span>Body temp / ambient</span>
          <b>
            {detail.bodyTemperature.toFixed(1)}° / {detail.ambientTemperature.toFixed(1)}°
          </b>
        </div>
      </div>

      <div className="panel">
        <h3>Physiology</h3>
        <Meter label="Health" value={detail.health} color="#63c07a" />
        <Meter label="Energy" value={detail.energy} color="#e0b03f" />
        <Meter label="Hunger" value={detail.hunger} color="#e08a3f" invert />
        <Meter label="Thirst" value={detail.thirst} color="#5ac8d8" invert />
        <Meter label="Fatigue" value={detail.fatigue} color="#a08ad8" invert />
        <Meter label="Pain" value={detail.pain} color="#e05252" invert />
        <Meter label="Stress" value={detail.stress} color="#c06060" invert />
        <Meter label="Fertility" value={detail.fertility * 100} color="#e0a5c0" />
        <Meter label="Libido" value={detail.libido * 100} color="#d88ab0" />
      </div>

      {detail.pregnancy ? (
        <div className="panel">
          <h3>Pregnancy</h3>
          <div className="row">
            <span>Father</span>
            <b>{detail.pregnancy.fatherName}</b>
          </div>
          <div className="row">
            <span>Conceived</span>
            <b>tick {detail.pregnancy.conceptionTick}</b>
          </div>
          <div className="row">
            <span>Embryo generation</span>
            <b>{detail.pregnancy.embryoGeneration}</b>
          </div>
          <Meter label="Gestation" value={detail.pregnancy.progress * 100} color="#ffd9a0" />
        </div>
      ) : null}

      {detail.matingWith !== null ? (
        <div className="panel">
          <h3>Mating</h3>
          <div className="row">
            <span>Partner</span>
            <b>{detail.matingWithName}</b>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <h3>Genealogy</h3>
        <div className="row">
          <span>Mother</span>
          <b>{detail.mother ? detail.mother.name : '— (founder)'}</b>
        </div>
        <div className="row">
          <span>Father</span>
          <b>{detail.father ? detail.father.name : '— (founder)'}</b>
        </div>
        <div className="row">
          <span>Children</span>
          <b>{detail.children.length}</b>
        </div>
        {detail.children.length > 0 ? (
          <div className="chips" style={{ marginTop: 4 }}>
            {detail.children.map((child) => (
              <span
                key={child.id}
                className="chip"
                onClick={() => sim.select(child.id)}
                title={child.alive ? 'alive' : 'deceased'}
              >
                {child.name}
                {child.alive ? '' : ' †'}
              </span>
            ))}
          </div>
        ) : null}
        {detail.siblings.length > 0 ? (
          <>
            <div className="row" style={{ marginTop: 6 }}>
              <span>Siblings</span>
              <b>{detail.siblings.length}</b>
            </div>
            <div className="chips">
              {detail.siblings.slice(0, 10).map((sibling) => (
                <span key={sibling.id} className="chip" onClick={() => sim.select(sibling.id)}>
                  {sibling.name}
                  {sibling.alive ? '' : ' †'}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="panel">
        <h3>Social memory</h3>
        {detail.social.length === 0 ? (
          <div className="muted">Has not met anyone yet.</div>
        ) : (
          <div className="chips">
            {detail.social.map((record) => (
              <span
                key={record.id}
                className={`chip ${record.related > 0.3 ? 'related' : ''} ${record.attachment > 0.35 ? 'attached' : ''}`}
                onClick={() => sim.select(record.id)}
                title={`familiarity ${record.familiarity.toFixed(2)} · attachment ${record.attachment.toFixed(
                  2,
                )} · valence ${record.valence.toFixed(2)} · encounters ${record.encounters} · matings ${record.matings}${
                  record.related > 0 ? ` · relatedness ${record.related.toFixed(2)}` : ''
                }`}
              >
                {record.name} {record.attachment > 0.35 ? '♥' : ''}
                {record.matings > 0 ? ' ⚭' : ''}
              </span>
            ))}
          </div>
        )}
        <div className="note">
          Attachment is a continuous value, not a relationship type. There are no husbands, wives or
          friends in this simulation — only familiarity, attachment and valence that you can read.
        </div>
      </div>

      <div className="panel">
        <h3>Genome</h3>
        <div className="row">
          <span>Neurons / synapses</span>
          <b>
            {detail.neuronCount} / {detail.synapseCount}
          </b>
        </div>
        <div className="row">
          <span>Excitatory / inhibitory</span>
          <b>
            {detail.excitatorySynapses} / {detail.inhibitorySynapses}
          </b>
        </div>
        <div className="row">
          <span>Weight drift from birth</span>
          <b>{detail.weightDrift.toFixed(4)}</b>
        </div>
        <div className="row">
          <span>Mean |weight|</span>
          <b>{detail.meanAbsWeight.toFixed(4)}</b>
        </div>
        <div className="row">
          <span>Lifespan gene</span>
          <b>{detail.lifespan.toFixed(1)}y</b>
        </div>
        <div className="note">
          Weight drift is the mean absolute change from the weights this individual was born with.
          Zero means no learning has happened; a positive value is direct evidence that lifetime
          plasticity has rewritten its synapses.
        </div>
      </div>

      <BrainPanel />
      <WhyPanel />
    </div>
  );
}

function Meter({
  label,
  value,
  color,
  invert,
}: {
  label: string;
  value: number;
  color: string;
  invert?: boolean;
}): JSX.Element {
  const clamped = Math.max(0, Math.min(100, value));
  const display = invert ? clamped : clamped;
  return (
    <div>
      <div className="meter-label">
        <span>{label}</span>
        <b>{display.toFixed(0)}</b>
      </div>
      <div className="meter">
        <div style={{ width: `${clamped}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * Live brain.
 *
 * The drawing lives in `BrainScope` (src/render/brainScope.ts), which runs its
 * own animation loop; this panel only feeds it the latest brain and trace and
 * owns the expand / close controls. Expanded, it fills the window and cuts a
 * porthole through which the world renderer shows the same person, held there
 * by the camera, so the observer sees the brain and the behaviour at once.
 */
function BrainPanel(): JSX.Element {
  const state = useSim();
  const [expanded, setExpanded] = useState(false);
  const [porthole, setPorthole] = useState<{ x: number; y: number; r: number } | null>(null);
  const [learning, setLearning] = useState(false);
  const [sound, setSound] = useState(false);

  // Hold the person in the porthole while the brain is expanded.
  useEffect(() => {
    const open = expanded && porthole !== null;
    window.dispatchEvent(
      new CustomEvent('eden:brain-porthole', {
        detail: { open, id: state.selectedId, x: porthole?.x ?? 0, y: porthole?.y ?? 0 },
      }),
    );
  }, [expanded, porthole, state.selectedId]);
  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent('eden:brain-porthole', { detail: { open: false, id: null, x: 0, y: 0 } }));
    },
    [],
  );

  // While the brain is open, the world's own panels step aside so the porthole
  // looks onto the world, not onto a panel that happens to be behind it.
  useEffect(() => {
    document.body.classList.toggle('brain-open', expanded);
    return () => document.body.classList.remove('brain-open');
  }, [expanded]);

  // Escape closes the expanded view. Without it the only way out is to find the
  // small button again, which is exactly the wrong thing to ask of someone who
  // just went full screen to look at something.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false);
      if (event.key === 'l' || event.key === 'L') setLearning((value) => !value);
      if (event.key === 's' || event.key === 'S') setSound((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const brain = state.brain;
  const motor = brain?.motor ?? new Array(MOTOR_COUNT).fill(0);
  let lead = 0;
  for (let i = 1; i < motor.length; i++) if (motor[i] > motor[lead]) lead = i;

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Live brain</h3>
        <button
          className={expanded ? 'active' : ''}
          onClick={() => setExpanded((value) => !value)}
          style={{ fontSize: 9, padding: '2px 6px' }}
          title="Expand the brain to fill the window (Esc to close)"
        >
          {expanded ? 'shrink' : 'expand'}
        </button>
      </div>
      <BrainCanvas mode="compact" />
      <div className="brain-legend">
        hover a cell to see what it is · <span>warm</span> excites · <span>cold</span> inhibits · the lit route is why
      </div>
      {/* Portalled to <body>: the glass panels use backdrop-filter, which makes
          them the containing block for `position: fixed`, so an overlay inside
          one would fill the panel rather than the window. */}
      {expanded
        ? createPortal(
            <div className="brain-overlay">
              <BrainCanvas mode="full" porthole={porthole} onPorthole={setPorthole} learning={learning} sound={sound} />
              <div className="brain-controls">
                <button className={learning ? 'active' : ''} onClick={() => setLearning((value) => !value)}>
                  <span className="kbd">L</span> Learning
                </button>
                <button className={sound ? 'active' : ''} onClick={() => setSound((value) => !value)}>
                  <span className="kbd">S</span> Sound
                </button>
                <button onClick={() => setExpanded(false)}>
                  <span className="kbd">Esc</span> Close
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      <div className="motor-bars">
        {MOTOR_NAMES.map((name, index) => (
          <div key={name} className={`motor-bar ${index === lead ? 'lead' : ''}`}>
            <span>{name}</span>
            <span className="track">
              <span className="fill" style={{ width: `${Math.round(motor[index] * 100)}%`, display: 'block' }} />
            </span>
            <span>{motor[index].toFixed(2)}</span>
          </div>
        ))}
      </div>
      {brain ? (
        <div className="note">
          {brain.neuronCount} neurons · {brain.stats.excitatory} excitatory / {brain.stats.inhibitory}{' '}
          inhibitory synapses · {brain.stats.activeNeurons} neurons active · mean activity{' '}
          {brain.stats.meanActivity.toFixed(3)}
        </div>
      ) : null}
    </div>
  );
}

/** One BrainScope on one canvas, fed from the store. */
function BrainCanvas({
  mode,
  porthole,
  onPorthole,
  learning = false,
  sound = false,
}: {
  mode: 'compact' | 'full';
  porthole?: { x: number; y: number; r: number } | null;
  onPorthole?: (geometry: { x: number; y: number; r: number } | null) => void;
  learning?: boolean;
  sound?: boolean;
}): JSX.Element {
  const state = useSim();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scopeRef = useRef<BrainScope | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const scope = new BrainScope(canvas);
    scope.setMode(mode);
    if (onPorthole) scope.enablePorthole(onPorthole);
    scopeRef.current = scope;
    const snapshot = sim.getSnapshot();
    scope.setData(snapshot.brain, snapshot.explain, snapshot.detail?.name ?? '');
    return () => {
      scope.destroy();
      scopeRef.current = null;
      onPorthole?.(null);
    };
    // The scope is created once per canvas; mode and callback are fixed per use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scopeRef.current?.setData(state.brain, state.explain, state.detail?.name ?? '');
  }, [state.brain, state.explain, state.detail?.name]);

  useEffect(() => scopeRef.current?.setLearning(learning), [learning]);
  useEffect(() => scopeRef.current?.setSound(sound), [sound]);

  const mask = porthole
    ? `radial-gradient(circle ${porthole.r}px at ${porthole.x}px ${porthole.y}px, transparent 98%, #000 100%)`
    : undefined;
  return (
    <canvas
      className={`brain-canvas ${mode === 'full' ? 'expanded' : ''}`}
      ref={canvasRef}
      style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
    />
  );
}

/** "Why did it do that?" — the approximate activation/contribution trace. */
function WhyPanel(): JSX.Element {
  const state = useSim();
  const explain = state.explain;

  if (!explain) {
    return (
      <div className="panel">
        <h3>Why did it do that?</h3>
        <div className="muted">Waiting for a motor decision…</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Why did it do that?</h3>
        <span className="badge">{explain.strength.toFixed(2)}</span>
      </div>
      <div className="row">
        <span>Action</span>
        <b>{explain.action}</b>
      </div>
      <div className="why-summary" style={{ marginTop: 8 }}>
        <div style={{ color: '#6c7d8d', fontSize: 10, letterSpacing: '0.1em' }}>
          STRONGEST CURRENT CONTRIBUTORS
        </div>
        {explain.summary.length === 0 ? (
          <div className="muted">No measurable contributors this tick.</div>
        ) : (
          explain.summary.map((line, index) => <div key={index}>{line}</div>)
        )}
      </div>
      <div className="why-path">
        <div style={{ color: '#6c7d8d', fontSize: 10, letterSpacing: '0.1em', marginBottom: 4 }}>
          STRONGEST CHAIN
        </div>
        {explain.path.map((node, index) => (
          <div key={index}>
            <span className="node" style={index === 0 ? { color: '#ff8a3d' } : undefined}>
              {node.label}
            </span>{' '}
            {index > 0 && (
              <span className="arrow">
                ({node.contribution >= 0 ? '+' : ''}
                {node.contribution.toFixed(3)})
              </span>
            )}
            {index < explain.path.length - 1 && (
              <div className="arrow" style={{ marginLeft: 2 }}>
                ↓
              </div>
            )}
          </div>
        ))}
      </div>
      {explain.learnedPath.length > 0 && (
        <div className="why-path">
          <div style={{ color: '#6c7d8d', fontSize: 10, letterSpacing: '0.1em', marginBottom: 4 }}>
            LEARNED PATHWAY (THROUGH THE RECURRENT CORE)
          </div>
          {explain.learnedPath.map((node, index) => (
            <div key={index}>
              <span className="node">{node.label}</span>{' '}
              <span className="arrow">
                ({node.contribution >= 0 ? '+' : ''}
                {node.contribution.toFixed(3)})
              </span>
              {index < explain.learnedPath.length - 1 && (
                <div className="arrow" style={{ marginLeft: 2 }}>
                  ↓
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="note">{explain.note}</div>
    </div>
  );
}

export { MOTOR_START };
