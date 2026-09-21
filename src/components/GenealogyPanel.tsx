import { useEffect } from 'react';
import { sim, useSim } from '../ui/sim';
import type { TreeNode } from '../shared/types';

/** Simple family tree rooted at the founders, including the deceased. */
export function GenealogyPanel({ onClose }: { onClose(): void }): JSX.Element {
  const state = useSim();

  useEffect(() => {
    sim.requestGenealogy();
  }, []);

  const forest = state.genealogy;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>Family tree</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="muted" style={{ marginBottom: 12 }}>
          Roots are the founders. Click any name to select that individual. Struck-through names are
          deceased.
        </div>
        {!forest || forest.length === 0 ? (
          <div className="empty">No genealogy recorded yet.</div>
        ) : (
          <div className="tree">
            {forest.map((root) => (
              <TreeBranch key={root.id} node={root} depth={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeBranch({ node, depth }: { node: TreeNode; depth: number }): JSX.Element {
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 16 }}>
      <div>
        <span
          className={`node-name ${node.alive ? '' : 'dead'}`}
          onClick={() => sim.select(node.id)}
        >
          {node.name}
        </span>
        <span style={{ color: '#46545f' }}>
          {' '}
          · gen {node.generation} · {node.sex === 0 ? 'f' : 'm'}
          {node.alive ? '' : ' †'}
        </span>
      </div>
      {node.children.map((child) => (
        <TreeBranch key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
