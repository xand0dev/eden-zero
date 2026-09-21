import { useMemo, useState } from 'react';
import { sim, useSim } from '../ui/sim';

/**
 * Genome editor.
 *
 * Deliberately loud about what it does: editing a genome breaks natural lineage
 * conditions, and the change becomes part of that individual's future
 * inheritance. The warning is part of the design, not a legal footnote.
 */
export function GenomeEditor({ humanId, onClose }: { humanId: number; onClose(): void }): JSX.Element {
  const state = useSim();
  const detail = state.detail;
  const [draft, setDraft] = useState<Record<string, number>>({});

  const groups = useMemo(() => {
    if (!detail) return [];
    const map = new Map<string, typeof detail.genome>();
    for (const gene of detail.genome) {
      const list = map.get(gene.group) ?? [];
      list.push(gene);
      map.set(gene.group, list);
    }
    return [...map.entries()];
  }, [detail]);

  if (!detail || detail.id !== humanId) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(event) => event.stopPropagation()}>
          <div className="empty">Reading genome…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>Edit genome — {detail.name}</h2>
          <button onClick={onClose}>Close</button>
        </div>

        <div className="warning">
          <b>This breaks natural lineage conditions.</b> Any value you change here is written into
          this individual's genome and will be inherited by its descendants exactly as if it had
          evolved. Changes are recorded in the world event feed so the intervention stays visible.
        </div>

        <div className="gene-editor">
          {groups.map(([group, genes]) => (
            <div key={group}>
              <div className="group-title">{group}</div>
              {genes.map((gene) => {
                const value = draft[gene.key] ?? gene.value;
                const changed = Math.abs(value - gene.value) > 1e-9;
                return (
                  <div className="gene-row" key={gene.key}>
                    <div>
                      <div className="meta">
                        <span title={gene.description}>{gene.label}</span>
                        <b style={{ color: changed ? '#ff8a3d' : undefined }}>
                          {gene.integer ? Math.round(value) : value.toFixed(3)}
                        </b>
                      </div>
                      <input
                        type="range"
                        min={gene.min}
                        max={gene.max}
                        step={gene.step}
                        value={value}
                        onChange={(event) =>
                          setDraft((previous) => ({ ...previous, [gene.key]: Number(event.target.value) }))
                        }
                      />
                      {gene.motherValue !== null || gene.fatherValue !== null ? (
                        <div className="inherit">
                          inherited: mother {gene.motherValue?.toFixed(3) ?? '—'} · father{' '}
                          {gene.fatherValue?.toFixed(3) ?? '—'}
                        </div>
                      ) : (
                        <div className="inherit">founder — no inherited baseline</div>
                      )}
                    </div>
                    <button
                      disabled={!changed}
                      onClick={() => {
                        sim.god({ kind: 'editGenome', id: humanId, key: gene.key, value });
                        setDraft((previous) => {
                          const next = { ...previous };
                          delete next[gene.key];
                          return next;
                        });
                      }}
                    >
                      Apply
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
