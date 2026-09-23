import { useEffect, useRef, useState } from 'react';
import { sim, useSim, formatAge, stageName } from '../ui/sim';
import {
  LOCAL_COUNT,
  LOCAL_START,
  MOD_COUNT,
  MOD_START,
  MOTOR_COUNT,
  MOTOR_NAMES,
  MOTOR_START,
  NEURON_COUNT,
  RECURRENT_COUNT,
  RECURRENT_START,
  REGION_NAMES,
  SENSORY_COUNT,
  regionOf,
} from '../simulation/brain/channels';

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
 * Live brain visualisation.
 *
 * Drawn on a 2D canvas in its own animation frame so that neither React nor the
 * simulation is involved in painting it. Neurons are laid out in five vertical
 * bands by region; brightness is the smoothed firing rate; the strongest
 * synapses are drawn as lines, coloured by sign.
 */
function BrainPanel(): JSX.Element {
  const state = useSim();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const filterRef = useRef({ showSynapses: true, minWeight: 0.25 });
  const [showSynapses, setShowSynapses] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    filterRef.current.showSynapses = showSynapses;
  }, [showSynapses]);

  // Escape closes the expanded view. Without it the only way out is to find the
  // small button again, which is exactly the wrong thing to ask of someone who
  // just went full screen to look at something.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    let raf = 0;
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const snapshot = sim.getSnapshot();
      const brain = snapshot.brain;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#04070b';
      context.fillRect(0, 0, width, height);

      if (!brain) {
        context.fillStyle = '#46545f';
        context.font = '11px ui-monospace, monospace';
        context.fillText('no brain data', 10, 20);
        return;
      }

      const padding = 12;
      const bands = 5;
      const bandWidth = (width - padding * 2) / bands;

      // Neuron positions, grouped by region.
      const positions: Array<[number, number]> = new Array(NEURON_COUNT);
      // Region sizes come from the channel table, never from a literal. The
      // literals that used to live here were v1's [32, 64, 132, 16, 12] and
      // silently mis-drew every neuron after the brain grew.
      const counts = [SENSORY_COUNT, LOCAL_COUNT, RECURRENT_COUNT, MOD_COUNT, MOTOR_COUNT];
      for (let band = 0; band < bands; band++) {
        const count = counts[band];
        const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
        const rows = Math.ceil(count / columns);
        const x0 = padding + band * bandWidth;
        for (let i = 0; i < count; i++) {
          const col = i % columns;
          const row = Math.floor(i / columns);
          const x = x0 + ((col + 0.5) / columns) * bandWidth * 0.86 + bandWidth * 0.07;
          const y = padding + 16 + ((row + 0.5) / rows) * (height - padding * 2 - 26);
          const index = neuronIndexFor(band, i);
          positions[index] = [x, y];
        }
      }

      // Region labels.
      context.font = '9px ui-monospace, monospace';
      context.fillStyle = '#3d4b57';
      for (let band = 0; band < bands; band++) {
        context.fillText(
          REGION_NAMES[band].toUpperCase(),
          padding + band * bandWidth + bandWidth * 0.07,
          11,
        );
      }

      // Synapses.
      const filter = filterRef.current;
      if (filter.showSynapses) {
        for (const [pre, post, weight] of brain.synapses) {
          if (Math.abs(weight) < filter.minWeight) continue;
          const from = positions[pre];
          const to = positions[post];
          if (!from || !to) continue;
          const alpha = Math.min(0.5, Math.abs(weight) * 0.35);
          context.strokeStyle = weight >= 0 ? `rgba(255,138,61,${alpha})` : `rgba(90,200,216,${alpha})`;
          context.lineWidth = Math.min(1.4, Math.abs(weight) * 1.1);
          context.beginPath();
          context.moveTo(from[0], from[1]);
          context.lineTo(to[0], to[1]);
          context.stroke();
        }
      }

      // Neurons.
      for (let i = 0; i < NEURON_COUNT; i++) {
        const position = positions[i];
        if (!position) continue;
        const activity = Math.max(0, Math.min(1, brain.activity[i] ?? 0));
        const region = regionOf(i);
        const base = region === 4 ? [255, 138, 61] : region === 3 ? [224, 176, 63] : [140, 190, 220];
        const radius = 1.3 + activity * 3.4;
        context.beginPath();
        context.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${0.16 + activity * 0.84})`;
        context.arc(position[0], position[1], radius, 0, Math.PI * 2);
        context.fill();
        if (activity > 0.5) {
          context.beginPath();
          context.strokeStyle = `rgba(255,220,180,${(activity - 0.5) * 1.6})`;
          context.lineWidth = 1;
          context.arc(position[0], position[1], radius + 1.6, 0, Math.PI * 2);
          context.stroke();
        }
      }

      // Motor output bars.
      let lead = 0;
      for (let i = 1; i < MOTOR_COUNT; i++) if ((brain.motor[i] ?? 0) > (brain.motor[lead] ?? 0)) lead = i;
      const barTop = height - 6;
      for (let i = 0; i < MOTOR_COUNT; i++) {
        const value = Math.max(0, Math.min(1, brain.motor[i] ?? 0));
        const x = padding + i * (width / MOTOR_COUNT - 2) * 0.9;
        context.fillStyle = 'rgba(60,72,84,0.5)';
        context.fillRect(x, barTop - 12, 6, 12);
        context.fillStyle = i === lead ? '#ff8a3d' : 'rgba(255,138,61,0.4)';
        context.fillRect(x, barTop - 12 * value, 6, 12 * value);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const brain = state.brain;
  const motor = brain?.motor ?? new Array(MOTOR_COUNT).fill(0);
  let lead = 0;
  for (let i = 1; i < motor.length; i++) if (motor[i] > motor[lead]) lead = i;

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Live brain</h3>
        <button
          className={showSynapses ? 'active' : ''}
          onClick={() => setShowSynapses((value) => !value)}
          style={{ fontSize: 9, padding: '2px 6px' }}
        >
          synapses
        </button>
        <button
          className={expanded ? 'active' : ''}
          onClick={() => setExpanded((value) => !value)}
          style={{ fontSize: 9, padding: '2px 6px' }}
          title="Expand the brain to fill the window (Esc to close)"
        >
          {expanded ? 'shrink' : 'expand'}
        </button>
      </div>
      <canvas className={`brain-canvas ${expanded ? 'expanded' : ''}`} ref={canvasRef} />
      {expanded ? <div className="brain-hint">Esc to close · the graph is live</div> : null}
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

function neuronIndexFor(band: number, index: number): number {
  if (band === 0) return index;
  if (band === 1) return LOCAL_START + index;
  if (band === 2) return RECURRENT_START + index;
  if (band === 3) return MOD_START + index;
  return MOTOR_START + index;
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
