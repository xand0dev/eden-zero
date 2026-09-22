import type { Brain } from './network';
import { MOTOR_NAMES, MOTOR_START, Region, labelNeuron, regionOf, shortLabel } from './channels';

/**
 * Approximate activation/contribution trace — surfaced in the UI as
 * "Why did it do that?".
 *
 * HONESTY NOTE
 * ------------
 * The network is recurrent, so there is no single true cause for an action.
 * What we compute here is an engineering-level attribution: for the motor
 * neuron that won the read-out, we look at its incoming synapses and score each
 * one as `weight * presynaptic activity`. We then walk backwards, always
 * following the strongest contributors, for a bounded depth.
 *
 * We deliberately do not claim this is a causal explanation. The UI labels it
 * "approximate activation / contribution trace" and the wording of the panel
 * makes the approximation explicit.
 */

export interface ContributionNode {
  neuron: number;
  label: string;
  short: string;
  region: Region;
  /** Signed contribution of this neuron to its parent. */
  contribution: number;
  /** Presynaptic activity at trace time. */
  activation: number;
  /** Weight of the synapse connecting this neuron to its parent. */
  weight: number;
  depth: number;
  children: ContributionNode[];
}

export interface Explanation {
  tick: number;
  motorIndex: number;
  action: string;
  /** Motor read-out strength of the winning output, 0..1. */
  strength: number;
  /** Top contributors into the winning motor neuron. */
  contributors: ContributionNode[];
  /**
   * Strongest chain from the winning motor output back to an input, *including*
   * the motor neuron itself. Always at least two nodes.
   */
  path: ContributionNode[];
  /**
   * Strongest chain that passes through the recurrent core, if one carries
   * meaningful signal. This is the learned component of the decision, and it is
   * often invisible in `path` because the innate priors dominate the read-out.
   */
  learnedPath: ContributionNode[];
  /** Human-readable summary lines, already formatted for the panel. */
  summary: string[];
  note: string;
}

const MAX_BRANCH = 5;
const MAX_DEPTH = 3;
const CHILD_BRANCH = 3;
/** Below this, a contribution is noise and not worth descending into. */
const MIN_CONTRIBUTION = 1e-4;

interface Scored {
  neuron: number;
  contribution: number;
  activation: number;
  weight: number;
  synapse: number;
}

/**
 * Build the explanation for a brain's most recent motor decision.
 *
 * @param brain       the network
 * @param motorIndex  index of the winning motor output (0..11)
 * @param sensory     the sensory vector used for the last tick, for annotation
 * @param tick        simulation tick at which this decision was taken
 */
export function explainAction(
  brain: Brain,
  motorIndex: number,
  sensory: Float32Array,
  tick: number,
): Explanation {
  const target = MOTOR_START + motorIndex;

  const rootContributors = incoming(brain, target, MAX_BRANCH).map((s) =>
    buildNode(brain, s, 1, new Set<number>([target])),
  );

  const contributors = rootContributors
    .slice()
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // The chain must start at the motor output, not at its strongest input.
  //
  // An earlier version built the path from the top contributor downwards, which
  // meant that whenever an innate prior dominated — which is most of the time —
  // the chain terminated immediately at that sensory neuron, because sensory
  // neurons have no parents. The panel showed a single node and looked broken.
  // Anchoring at the motor neuron makes the chain read `motor:mate <- libido`,
  // which is what it actually is.
  const root: ContributionNode = {
    neuron: target,
    label: labelNeuron(target),
    short: shortLabel(target),
    region: regionOf(target),
    contribution: 0,
    activation: brain.rate[target],
    weight: 0,
    depth: 0,
    children: contributors,
  };

  const path = descend(root);

  // The learned pathway: the strongest chain that passes through the recurrent
  // core. The innate priors usually dominate the read-out, so the learned
  // component is frequently absent from `path` altogether and the observer would
  // never see that the animal has, in fact, learned anything.
  const learnedRoot = contributors.find(
    (node) =>
      (node.region === Region.Recurrent || node.region === Region.Local || node.region === Region.Modulatory) &&
      Math.abs(node.contribution) > MIN_CONTRIBUTION,
  );
  const learnedPath = learnedRoot ? descend(learnedRoot) : [];

  const strength = Math.max(0, Math.min(1, brain.rate[target] * 3.6));

  return {
    tick,
    motorIndex,
    action: MOTOR_NAMES[motorIndex],
    strength,
    contributors,
    path,
    learnedPath,
    summary: summarise(contributors, sensory),
    note:
      'Approximate activation/contribution trace over a recurrent network. ' +
      'Contributions are weight x presynaptic activity for the last tick, ' +
      'recovered to a bounded depth. Not a causal proof.',
  };
}

/**
 * Walk from a node down through its strongest child until the chain runs out.
 *
 * The `children` arrays are already truncated to the strongest few by
 * `buildNode`, so the chain always follows the dominant branch rather than
 * wandering into noise.
 */
function descend(start: ContributionNode): ContributionNode[] {
  const chain: ContributionNode[] = [start];
  let cursor = start;
  // MAX_DEPTH bounds the recursion in buildNode; this bounds the walk.
  for (let guard = 0; guard < MAX_DEPTH + 2; guard++) {
    let best: ContributionNode | undefined;
    for (const child of cursor.children) {
      if (Math.abs(child.contribution) <= MIN_CONTRIBUTION) continue;
      if (!best || Math.abs(child.contribution) > Math.abs(best.contribution)) best = child;
    }
    if (!best) break;
    chain.push(best);
    cursor = best;
  }
  return chain;
}

function incoming(brain: Brain, neuron: number, limit: number): Scored[] {
  const { inStart, inSyn, pre, w, rate } = brain;
  const start = inStart[neuron];
  const end = inStart[neuron + 1];
  const scored: Scored[] = [];
  for (let s = start; s < end; s++) {
    const idx = inSyn[s];
    const preIdx = pre[idx];
    const contribution = w[idx] * rate[preIdx];
    scored.push({
      neuron: preIdx,
      contribution,
      activation: rate[preIdx],
      weight: w[idx],
      synapse: idx,
    });
  }
  scored.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return scored.slice(0, limit);
}

function buildNode(
  brain: Brain,
  scored: Scored,
  depth: number,
  ancestors: Set<number>,
): ContributionNode {
  const node: ContributionNode = {
    neuron: scored.neuron,
    label: labelNeuron(scored.neuron),
    short: shortLabel(scored.neuron),
    region: regionOf(scored.neuron),
    contribution: scored.contribution,
    activation: scored.activation,
    weight: scored.weight,
    depth,
    children: [],
  };

  if (depth >= MAX_DEPTH) return node;
  if (ancestors.has(scored.neuron)) return node;

  // Only descend through neurons that actually carried signal.
  if (Math.abs(scored.activation) < 1e-4) return node;

  const next = new Set(ancestors);
  next.add(scored.neuron);
  const children = incoming(brain, scored.neuron, CHILD_BRANCH);
  for (const child of children) {
    if (next.has(child.neuron)) continue;
    node.children.push(buildNode(brain, child, depth + 1, next));
  }
  return node;
}

function summarise(contributors: ContributionNode[], sensory: Float32Array): string[] {
  const lines: string[] = [];
  for (const node of contributors) {
    const sign = node.contribution >= 0 ? '+' : '-';
    const drive = describeSource(node, sensory);
    lines.push(`${drive}  ${sign}${Math.abs(node.contribution).toFixed(3)}`);
  }
  return lines;
}

function describeSource(node: ContributionNode, sensory: Float32Array): string {
  if (node.region === Region.Sensory) {
    const value = sensory[node.neuron] ?? 0;
    const label = node.label.replace('sensory:', '');
    return `${label} (input ${value.toFixed(2)})`;
  }
  if (node.region === Region.Motor) return `motor feedback ${node.short}`;
  if (node.region === Region.Modulatory) return `neuromodulatory pool ${node.short}`;
  if (node.region === Region.Local) return `local processing ${node.short}`;
  return `recurrent interneuron ${node.short}`;
}
