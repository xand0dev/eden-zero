import { useSim } from '../ui/sim';
import { sim } from '../ui/sim';

/**
 * Developer panel (Cmd+Shift+D).
 *
 * Everything needed to reason about the simulation's health: tick rate, timing
 * breakdown, worker latency, snapshot size and raw state.
 */
export function DevPanel({ onClose }: { onClose(): void }): JSX.Element {
  const state = useSim();
  const metrics = state.metrics;
  const stats = state.stats;

  const row = (label: string, value: string): JSX.Element => (
    <div className="kv">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );

  return (
    <div className="devpanel">
      <h3>Developer — Cmd+Shift+D to hide</h3>
      {row('seed', state.config.seed)}
      {row('tick', String(state.tick))}
      {row('sim time', `${(state.simTime / 60).toFixed(1)} min`)}
      {row('sim TPS', metrics.tps.toFixed(0))}
      {row('render FPS', state.fps.toFixed(0))}
      {row('tick cost', `${metrics.tickTimeMs.toFixed(3)} ms`)}
      {row('brain cost', `${metrics.brainTimeMs.toFixed(3)} ms/tick`)}
      {row('worker latency', `${metrics.workerLatencyMs.toFixed(1)} ms`)}
      {row('snapshot size', `${(metrics.snapshotBytes / 1024).toFixed(1)} KiB`)}
      {row('entities', String(metrics.entityCount))}
      {row('humans / predators', `${metrics.humanCount} / ${metrics.predatorCount}`)}
      {row('plants', String(metrics.plantCount))}
      {row('avg neurons', (stats?.averageNeurons ?? 0).toFixed(0))}
      {row('avg synapses', (stats?.averageSynapses ?? 0).toFixed(0))}
      {row('avg weight drift', (stats?.averageWeightDrift ?? 0).toFixed(4))}
      {row('speed setting', state.paused ? 'paused' : state.speed === -1 ? 'MAX' : `x${state.speed}`)}
      <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
        <button onClick={() => sim.setSpeed(state.paused ? 1 : 0)}>{state.paused ? 'Resume' : 'Pause'}</button>
        <button onClick={() => sim.stepOnce()}>Step</button>
        <button onClick={onClose}>Hide</button>
      </div>
      <div className="kv" style={{ marginTop: 8, color: '#46545f' }}>
        <span>selected</span>
        <b>{state.selectedId === null ? 'none' : `#${state.selectedId}`}</b>
      </div>
    </div>
  );
}
