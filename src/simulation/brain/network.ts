import { Rng } from '../rng';
import { base64ToFloat32, float32ToBase64 } from '../persistence/binary';
import { BRAIN_DT, BRAIN_SUBSTEPS } from '../../shared/constants';
import { TUNING } from '../game/tuning';
import type { Genome } from '../genetics/genome';
import {
  BRAIN_SLOTS,
  GROWN_START,
  GROWTH_CAPACITY,
  LOCAL_COUNT,
  LOCAL_START,
  M,
  MOD_COUNT,
  MOD_START,
  MOTOR_COUNT,
  MOTOR_START,
  NEURON_COUNT,
  RECURRENT_COUNT,
  RECURRENT_START,
  S,
  SENSORY_COUNT,
  Region,
  regionOf,
} from './channels';

/**
 * Leaky Integrate-and-Fire network with sparse connectivity.
 *
 * Membrane equation (explicit Euler, dt = BRAIN_DT):
 *
 *     v <- v + (dt/tau) * (-v + I)
 *     if v >= V_THRESHOLD: emit spike, v <- 0, refractory for one sub-step
 *
 * `I` is the sum of: tonic bias, weighted pre-synaptic spikes, injected sensory
 * current, and diffuse neuromodulatory gain.
 *
 * Motor read-out uses an exponential moving average of the spike train, which
 * gives a smooth, continuous command signal that can drive movement physics
 * without a behaviour tree in between.
 *
 * Determinism: all loops iterate over dense index ranges in a fixed order, all
 * arithmetic is Float32Array based, and all randomness comes from a seeded Rng.
 */

const V_THRESHOLD = 1;
const V_RESET = 0;
const REFRACTORY_SUBSTEPS = 1;

/** Rate EMA coefficient per sub-step. */
const RATE_ALPHA = 0.22;
/** Scales the drive above the adaptive baseline into the [0,1] command range. */
const MOTOR_READOUT_GAIN = 0.6;
/** Adaptation rate of the common-drive baseline, per sub-step. */
const MOTOR_BASELINE_ADAPT = 0.01;

/** Shared tonic bias of every motor neuron (see `build`). */
const MOTOR_TONIC = 0.74;

/** Synaptic weight clamp. */
export const W_MAX = 1.8;

/** Global inhibitory feedback: gain and adaptation rate. */
const INHIB_GAIN = 5.2;
const INHIB_ADAPT = 0.06;

/**
 * Afferent gain. Sensory neurons project with stronger synapses than the
 * intrinsic recurrent matrix, mirroring the thalamocortical afferents that
 * dominate a real sensory pathway. Without this the recurrent background
 * swamps the senses and the animal cannot react to anything.
 */
const AFFERENT_GAIN = 2.1;

/**
 * Scale applied to the recurrent and modulatory projections onto motor neurons.
 *
 * Motor output is where the reflex arc and the recurrent core compete. Biology
 * resolves this in favour of the reflex: a withdrawal reflex fires before the
 * cortex has finished processing. If the recurrent core is allowed to drive the
 * motor pool as hard as the innate priors do, a randomly-initialised network
 * produces loud, meaningless motor noise and the animal starves while turning
 * in circles. Attenuating the descending drive leaves the priors in charge of
 * *survival-critical* behaviour while the recurrent core supplies modulation,
 * context and — crucially — the plastic substrate that learning reshapes.
 */
const MOTOR_DRIVE_SCALE = 0.09;

/** Plasticity constants (reward-modulated Hebbian). */
const ELIG_DECAY = 0.92;
const ELIG_GAIN = 1;
const LEARN_RATE = 0.008;
const WEIGHT_DECAY = 4e-6;
/**
 * Minimum |valence| required to open the plasticity window.
 *
 * Neuromodulation *gates* plasticity in real nervous systems: synapses are not
 * rewritten continuously, they are rewritten when something salient happens.
 * Without this gate the accumulated noise of a lifetime of tiny valence
 * fluctuations swamped the innate reflexes — the founders learned their way out
 * of being able to walk toward water.
 */
const PLASTICITY_THRESHOLD = 0.1;
/** Ticks between homeostatic synaptic scaling passes. */
const HOMEOSTASIS_INTERVAL = 120;

// --- neurogenesis (v3) -------------------------------------------------------
//
// The second Rule of Creation (genesis/rules.ts): at a moment that matters —
// a sharp swing in how the body is doing — a brain with room to spare grows one
// new neuron. Its inputs are the senses that were loudest at that moment, its
// output is the muscle that was acting, and the sign of the swing decides
// whether it drives that muscle or holds it back. It is one-shot learning of a
// context -> action rule that nobody wrote, and from then on it is an ordinary
// plastic neuron: learning reshapes it, and if it stops earning its keep it is
// pruned and its slot freed.

/** |valence| that counts as a moment worth remembering. */
export const GROWTH_VALENCE = 0.5;
/** Ticks between two growths in one brain (20 s at 20 Hz). */
export const GROWTH_COOLDOWN = 400;
/** Senses a grown neuron listens to. */
const GROWN_INPUTS = 3;
/** Below this rate a sense is not part of the moment. */
const GROWN_INPUT_FLOOR = 0.15;
/** Drive a grown neuron receives when its moment recurs exactly. */
const GROWN_DRIVE = 1.35;
/** Tonic bias of a grown neuron: quiet until its inputs line up. */
const GROWN_BIAS = 0.15;
/** Birth weight of a grown neuron's synapse onto its muscle. */
const GROWN_OUT = 0.55;
/** Per-tick decay of a grown neuron's running credit (half-life ~70 s). */
const UTILITY_DECAY = 0.9995;
/** A grown neuron is not judged before this many ticks (one simulated day). */
const PRUNE_MIN_AGE = 2400;
/** Ticks between pruning passes. */
const PRUNE_INTERVAL = 200;
/** Credit below which a neuron is pruned. */
const PRUNE_UTILITY = -0.4;
/** An output this weak does nothing any more. */
const PRUNE_WEIGHT = 0.08;
/** Credit a neuron needs for its wiring to be passed to a child as an instinct. */
export const INSTINCT_UTILITY = 0.15;
/** Instincts a genome carries at most. */
export const MAX_INSTINCTS = 4;
/** Numbers per instinct in `Genome.instincts`. */
export const INSTINCT_STRIDE = 9;
/** Per-tick adaptation of the sense baseline (time constant ~25 s). */
const BASELINE_ADAPT = 0.002;
/** Default neurogenesis gene for genomes that predate it. */
const DEFAULT_NEUROGENESIS = 0.4;

/**
 * Senses that never make up a moment: the noise channel (it is noise), the
 * standing capabilities (seed in hand is always on) and the slow settlement-wide
 * signals, which would tie a skill to an era rather than to a situation.
 */
const NOT_A_CONTEXT = new Set<number>([S.noise, S.seeds, S.settlementStage, S.storedFood, S.light, S.health, S.energy]);

/** A neuron a brain grew, or was born with because an ancestor grew it. */
export interface GrownNeuron {
  /** Presynaptic sensory neurons, loudest first. */
  inputs: number[];
  /** Birth weights of those inputs. */
  inW: number[];
  /** Motor index, 0..16. */
  motor: number;
  /** Birth weight onto the motor; its sign is the skill's direction. */
  outW: number;
  /** World tick it grew at; -1 for an instinct present from birth. */
  born: number;
  /** 0 if grown in this life; k if inherited through k generations. */
  generations: number;
  /** Running credit: how often it was active when things went the way it pushes. */
  utility: number;
}

/**
 * Innate low-level reflexes.
 *
 * These are the "minimal biological priors" the brief explicitly allows:
 * nociceptive withdrawal, homeostatic drive routing, sexual maturity routing.
 * They are ordinary plastic synapses — lifetime learning is free to reshape
 * them. There is no high-level decision logic anywhere in this file.
 */
/**
 * Maps a motor-output index (0..11) to its absolute neuron index.
 *
 * Every entry below MUST use this helper for motor targets and sources. A
 * previous version of this table used the bare `M.*` constants, which silently
 * wired the entire reflex repertoire into sensory neurons 0..11 instead of the
 * motor pool — the founders then had no innate behaviour at all and starved
 * while standing still.
 */
const MOTOR = (index: number): number => MOTOR_START + index;

const INNATE_PRIORS: ReadonlyArray<readonly [number, number, number]> = [
  // Nociceptive withdrawal: pain pulls backward and suppresses forward drive.
  //
  // Note there is deliberately NO `pain -> attack` prior. An earlier version had
  // one, and because pain is caused by being attacked it created a runaway
  // retaliation loop: the founders injured each other until the whole village
  // died of its wounds within three minutes. Aggression is driven by threat and
  // by learning, not by the withdrawal reflex.
  [S.pain, MOTOR(M.moveBack), 1.15],
  [S.pain, MOTOR(M.moveFwd), -0.95],
  [S.pain, MOTOR(M.turnLeft), 0.22],
  [S.pain, MOTOR(M.turnRight), 0.22],
  [S.pain, MOTOR(M.rest), -0.2],
  // Homeostatic drive routing.
  //
  // Note there is deliberately NO `hunger -> move-forward` / `thirst ->
  // move-forward` prior. Locomotion toward a resource is driven entirely by the
  // *directional* channels, which collapse once the resource is within reach. A
  // separate "keep walking because you are hungry" prior kept the founders at
  // full speed permanently, so they ran straight past the river they were dying
  // of thirst beside and starved in a landscape covered in food.
  [S.hunger, MOTOR(M.eat), 2.2],
  [S.hunger, MOTOR(M.rest), -0.15],
  [S.thirst, MOTOR(M.drink), 2.4],
  [S.fatigue, MOTOR(M.rest), 1.4],
  [S.fatigue, MOTOR(M.moveFwd), -0.38],
  [S.fatigue, MOTOR(M.sprint), -0.4],
  [S.energy, MOTOR(M.rest), -0.45],
  // Thermoregulation-ish bias.
  [S.cold, MOTOR(M.moveFwd), 0.1],
  [S.cold, MOTOR(M.rest), -0.2],
  [S.heat, MOTOR(M.rest), 0.4],
  [S.heat, MOTOR(M.sprint), -0.3],
  // Diurnal bias: darkness favours rest, light favours activity.
  [S.light, MOTOR(M.rest), -0.28],
  [S.light, MOTOR(M.moveFwd), 0.25],
  // Reproductive readiness. The mate drive has to be able to clear its action
  // gate on its own: the read-out measures drive against an adapting baseline, so
  // a prior of 0.5 against a baseline set by locomotion produces a command of
  // ~0.2 and no adult ever initiates anything.
  [S.libido, MOTOR(M.mate), 1.1],
  [S.libido, MOTOR(M.moveFwd), 0.06],
  [S.fertility, MOTOR(M.mate), 0.25],
  // Social affiliation.
  [S.attachment, MOTOR(M.interact), 0.32],
  [S.attachment, MOTOR(M.moveFwd), 0.1],
  [S.familiarity, MOTOR(M.moveFwd), 0.06],
  [S.familiarity, MOTOR(M.signal), 0.08],
  // Threat avoidance — flight.
  //
  // These have to be strong enough to actually outrun a predator, and the
  // original values (0.55 retreat, 0.35 sprint) were nowhere near. The read-out
  // measures drive against an adapting baseline, so 0.55 produced a command of
  // about 0.17 and the animal backed away at roughly 0.5 tiles/s while a predator
  // closed at 3.4. Flight was, in effect, disabled: humans stood still and were
  // eaten. With these weights a frightened adult retreats at about 4.8 tiles/s,
  // which is faster than a predator, so being caught means being cornered rather
  // than merely noticed.
  [S.threatFront, MOTOR(M.moveBack), 1.9],
  [S.threatFront, MOTOR(M.moveFwd), -0.4],
  [S.threatFront, MOTOR(M.sprint), 1.5],
  [S.threatFront, MOTOR(M.attack), 0.18],
  [S.threatRight, MOTOR(M.turnLeft), 0.8],
  [S.threatLeft, MOTOR(M.turnRight), 0.8],
  // Resource approach (salience is already scaled by internal need upstream).
  //
  // These are by far the strongest innate weights in the brain, and deliberately
  // so. The command read-out is the drive above tonic bias, so an approach
  // gradient that only contributes ~0.1 produces a walk of ~0.1 tiles/s and the
  // founders die of thirst a few tiles from a river. The reflex arc has to be
  // loud enough to actually move the animal; the recurrent core then modulates
  // *whether* and *how* it acts on that gradient, and plasticity reshapes these
  // very synapses over a lifetime.
  [S.foodFront, MOTOR(M.moveFwd), 1.8],
  [S.waterFront, MOTOR(M.moveFwd), 2.2],
  [S.foodRight, MOTOR(M.turnRight), 1.1],
  [S.foodLeft, MOTOR(M.turnLeft), 1.1],
  [S.waterRight, MOTOR(M.turnRight), 1.3],
  [S.waterLeft, MOTOR(M.turnLeft), 1.3],
  // A resource directly behind the animal slows it down rather than steering.
  // Steering a target that is behind you is ambiguous, and a hard-wired
  // preference for one direction turned the founders into spinning tops.
  [S.foodBack, MOTOR(M.moveFwd), -0.15],
  [S.waterBack, MOTOR(M.moveFwd), -0.2],
  // Conspecific approach — mate search.
  //
  // These weights are deliberately strong. With the original weak values (0.12)
  // a willing adult could see a partner three tiles away and still not walk
  // over; instrumenting the mating pipeline showed two willing adults coming
  // within range only once per ten thousand ticks, which is why populations
  // never replaced themselves. Approaching another animal is a real behaviour
  // and it needs a real prior.
  [S.humanFront, MOTOR(M.moveFwd), 0.5],
  [S.humanRight, MOTOR(M.turnRight), 0.45],
  [S.humanLeft, MOTOR(M.turnLeft), 0.45],
  // --- construction -----------------------------------------------------
  //
  // Harvesting and building are the only behaviours that change the world
  // permanently, so they need innate scaffolding like any other reflex: an
  // animal has to be able to find a tree, fell it, carry the timber home and lay
  // it. Everything above that — who builds, when, how much, whether they bother
  // at all — is left to the network and to learning.
  //
  // Note that these priors are deliberately weaker than the survival drives
  // (food 2.2, water 2.2, threat 1.9). A hungry human should eat, not chop.
  [S.woodFront, MOTOR(M.moveFwd), 0.85],
  [S.woodRight, MOTOR(M.turnRight), 0.6],
  [S.woodLeft, MOTOR(M.turnLeft), 0.6],
  [S.woodFront, MOTOR(M.harvest), 1.5],
  [S.buildFront, MOTOR(M.moveFwd), 1.0],
  [S.buildRight, MOTOR(M.turnRight), 0.7],
  [S.buildLeft, MOTOR(M.turnLeft), 0.7],
  [S.buildFront, MOTOR(M.build), 1.7],
  // Carrying a load biases toward delivering it; an empty-handed human is not
  // drawn to the village.
  [S.woodCarried, MOTOR(M.build), 1.3],
  [S.woodCarried, MOTOR(M.harvest), -0.9],
  [S.buildNeed, MOTOR(M.build), 0.5],
  // Shelter is pleasant: a completed hut pulls its occupants back to it,
  // especially at night and when tired.
  [S.shelter, MOTOR(M.rest), 0.7],
  [S.dayPhase, MOTOR(M.rest), 0.25],
  // Hunger and fatigue suppress work.
  [S.hunger, MOTOR(M.harvest), -0.7],
  [S.hunger, MOTOR(M.build), -0.5],
  [S.thirst, MOTOR(M.harvest), -0.7],
  [S.fatigue, MOTOR(M.harvest), -0.6],
  [S.fatigue, MOTOR(M.build), -0.4],
  [S.energy, MOTOR(M.harvest), 0.3],
  [S.pain, MOTOR(M.harvest), -0.8],
  [S.pain, MOTOR(M.build), -0.6],
  // --- v2: agriculture and irrigation -----------------------------------
  //
  // The scaffolding the three new motors need. Without a prior, `plant`, `tend`
  // and `dig` start with random weights and never fire — the same cold-start
  // problem mate search had, and the same fix: make the behaviour loud enough to
  // clear the action gate, then let learning reshape it.
  //
  // Deliberately weaker than the survival drives, like the construction priors
  // above. A hungry human eats; it does not irrigate.
  //
  // Walking toward what you can see.
  // Steering weights are deliberately low. These channels are *added* to the
  // food, water and build gradients rather than replacing them, and the first
  // values were high enough that the sum pulled harder than any single survival
  // drive — the population declined while the fields flourished. A new sense
  // must not outshout the ones that keep the animal alive.
  [S.fieldFront, MOTOR(M.moveFwd), 0.32],
  [S.fieldRight, MOTOR(M.turnRight), 0.22],
  [S.fieldLeft, MOTOR(M.turnLeft), 0.22],
  [S.canalFront, MOTOR(M.moveFwd), 0.26],
  [S.canalRight, MOTOR(M.turnRight), 0.18],
  [S.canalLeft, MOTOR(M.turnLeft), 0.18],
  [S.forestFront, MOTOR(M.moveFwd), 0.24],
  [S.forestRight, MOTOR(M.turnRight), 0.16],
  [S.forestLeft, MOTOR(M.turnLeft), 0.16],
  // Sowing: driven by a field that actually wants planting, and nothing else.
  //
  // The first version also wired `seeds -> plant`, and `seeds` is a constant, so
  // that prior was permanently live. The settlement farmed itself to death:
  // population hit zero while the fields were immaculate. A behaviour that is
  // always available has to be gated on a need, not on a standing capability.
  [S.fieldNeed, MOTOR(M.plant), 1.4],
  // Bringing in a ripe crop.
  [S.cropReady, MOTOR(M.tend), 1.7],
  [S.fieldGrowth, MOTOR(M.tend), 0.5],
  // Digging: ground that is drying out with no canal to it yet.
  [S.irrigationNeed, MOTOR(M.dig), 1.6],
  [S.soilMoisture, MOTOR(M.dig), -0.8],
  // Hunger and fatigue suppress farm work, and harder than they suppress
  // building. Farming is the most optional thing in the world: a starving
  // settlement must forage, not irrigate. The first values were too gentle and
  // the population died with a perfect canal network.
  [S.hunger, MOTOR(M.plant), -1.6],
  [S.hunger, MOTOR(M.tend), -1.6],
  [S.hunger, MOTOR(M.dig), -1.8],
  [S.fatigue, MOTOR(M.plant), -1.0],
  [S.fatigue, MOTOR(M.tend), -1.0],
  [S.fatigue, MOTOR(M.dig), -1.4],
  // NOTE: there is deliberately no `noise -> motor` prior here. Wiring one
  // noise channel to both `turn-left` and `turn-right` with opposite signs
  // would cancel itself out exactly. Instead the noise channel projects into
  // the recurrent core with random signs (see `build`), so the same value
  // perturbs different parts of the network differently.
  // Mutual exclusion so opposing motors do not fight each other.
  [MOTOR(M.moveFwd), MOTOR(M.moveBack), -0.55],
  [MOTOR(M.moveBack), MOTOR(M.moveFwd), -0.55],
  [MOTOR(M.turnLeft), MOTOR(M.turnRight), -0.5],
  [MOTOR(M.turnRight), MOTOR(M.turnLeft), -0.5],
];

/**
 * Additional innate priors for predators.
 *
 * Predators run the *same* network as humans — there is no separate controller.
 * What differs is which modality is wired to which motor. For a predator the
 * `food.*` channels carry meat rather than plant matter, so `food -> attack` is
 * literally the predatory reflex arc expressed in the same generic architecture.
 * Without it, a predator has no innate drive strong enough to clear its attack
 * gate and starves standing next to its prey.
 *
 * Note the asymmetry with humans, who get no `food -> attack` prior: for them
 * `food.*` points at plants, and wiring plants to attack would have them
 * assaulting each other over a bush.
 */
const PREDATOR_PRIORS: ReadonlyArray<readonly [number, number, number]> = [
  [S.foodFront, MOTOR(M.attack), 2.2],
  [S.foodFront, MOTOR(M.sprint), 0.6],
  [S.foodRight, MOTOR(M.turnRight), 0.7],
  [S.foodLeft, MOTOR(M.turnLeft), 0.7],
  [S.foodBack, MOTOR(M.turnRight), 0.3],
];

/** Number of innate reflex synapses every human brain carries, in `INNATE_PRIORS` order. */
export const INNATE_PRIOR_COUNT = INNATE_PRIORS.length;

/** Position of an innate reflex in `INNATE_PRIORS`, or -1. */
export function innatePriorIndex(from: number, to: number): number {
  return INNATE_PRIORS.findIndex(([a, b]) => a === from && b === to);
}

/** The innate reflexes as [from, to, birth weight], for the observatory and the atlas. */
export function innatePriors(): ReadonlyArray<readonly [number, number, number]> {
  return INNATE_PRIORS;
}

export interface BrainOptions {
  /**
   * Scale on the innate reflex synapses at birth. 1 is the normal brain; the
   * "tabula rasa" law sets 0.1. Deterministic, so a saved brain regenerates the
   * same birth weights on load.
   */
  innateScale: number;
}

export interface BrainTopologyStats {
  neurons: number;
  synapses: number;
  excitatory: number;
  inhibitory: number;
}

export class Brain {
  /** Neuron slots: the 341 of the core plus room for grown neurons. */
  readonly n = BRAIN_SLOTS;

  /** Membrane potential. */
  readonly v = new Float32Array(BRAIN_SLOTS);
  /** Refractory countdown in sub-steps. */
  readonly refrac = new Float32Array(BRAIN_SLOTS);
  /** Current spike flags (0/1) for spiking neurons. */
  readonly spike = new Float32Array(BRAIN_SLOTS);
  /**
   * What this neuron actually transmits down its axons this sub-step.
   * For sensory neurons this is the graded stimulus intensity; for everything
   * else it is the binary spike flag.
   */
  readonly transmit = new Float32Array(BRAIN_SLOTS);
  /** Smoothed firing rate — this is what the brain viewer displays. */
  readonly rate = new Float32Array(BRAIN_SLOTS);
  /**
   * Spikes fired since the observer last read them, per neuron.
   *
   * Pure observability: nothing in the simulation reads it and it is not saved,
   * so it cannot affect behaviour or determinism. `World.brainView` drains it,
   * which is what lets the brain viewer draw the impulses that actually fired
   * rather than impulses implied by a rate.
   */
  readonly spikeCount = new Uint32Array(BRAIN_SLOTS);
  /**
   * Integrated synaptic drive of each motor neuron (last sub-step).
   *
   * This, not the spike rate, is what drives behaviour. A LIF neuron with a
   * one-sub-step refractory has essentially two states — fire every other
   * sub-step, or stay silent — so a spike-rate read-out quantises the motor
   * command into "full" or "nothing" and the whole motor pool collapses into a
   * synchronised two-state limit cycle. Reading the *integrated drive* gives the
   * smooth, graded command a muscle system actually needs, and it is exactly
   * what a rate-coded output layer does.
   */
  readonly motorDrive = new Float32Array(MOTOR_COUNT);
  /** Tonic bias current. */
  readonly bias = new Float32Array(BRAIN_SLOTS);
  /** Membrane time constant per neuron, seconds. */
  readonly tau = new Float32Array(BRAIN_SLOTS);

  // Sparse synapse storage.
  synCount = 0;
  pre!: Int32Array;
  post!: Int32Array;
  w!: Float32Array;
  /** Reward-modulated Hebbian eligibility trace. */
  elig!: Float32Array;

  /** CSR-style incoming adjacency (post -> pre). */
  inStart!: Int32Array;
  inSyn!: Int32Array;
  /** CSR-style outgoing adjacency (pre -> post). */
  outStart!: Int32Array;
  outSyn!: Int32Array;

  /** Snapshot of birth weights, so we can prove that brains change. */
  initialWeights!: Float32Array;
  /** Birth total |w| per neuron — the set point for homeostatic scaling. */
  initialInStrength!: Float32Array;

  /** Scratch buffer for input currents (avoids per-tick allocation). */
  private readonly current = new Float32Array(BRAIN_SLOTS);

  /**
   * Slowly-adapting global inhibitory pool.
   *
   * Cortical tissue is dominated by inhibition: a rise in overall activity
   * recruits proportional inhibitory feedback that normalises the network back
   * toward a sparse operating point. Without it a purely excitatory recurrent
   * core either sits silent forever or runs away to saturation — both of which
   * we observed while tuning this model. The pool is low-pass filtered so that
   * the feedback loop is slower than the spiking dynamics and therefore stable.
   */
  private inhibPool = 0;
  private homeostasisCounter = 0;
  /** Running estimate of the motor pool's common drive. */
  private motorBaseline = MOTOR_TONIC;

  /** Diffuse neuromodulatory gain, updated each sub-step. */
  modGain = 1;
  /** Last computed valence signal (-1..1). */
  lastValence = 0;
  /**
   * Index of the first innate reflex synapse. The reflexes are the last
   * `INNATE_PRIOR_COUNT` synapses a human brain is built with (predators add
   * their own after), so synapse `innateStart + k` is the same reflex in every
   * human — the one place two different brains line up synapse for synapse.
   */
  innateStart = 0;

  /** Synapses of the core network; grown neurons' synapses follow. */
  coreSynCount = 0;
  /** Neurons grown or inherited, packed from `GROWN_START`. */
  readonly grown: GrownNeuron[] = [];
  /** How many grown neurons this brain has room for, from the genome. */
  growthCapacity = 0;
  private lastGrowthTick = -1e9;
  private pruneCounter = 0;
  /**
   * Slow running average of each sense. A moment is made of the senses that
   * stand out against it — thirst and water ahead at the instant of drinking —
   * not of the ones that are always on in a village (kin nearby, a partner
   * close, wet ground), which would otherwise be part of every skill.
   */
  readonly senseBaseline = new Float32Array(SENSORY_COUNT);
  private tauGrown = 0.024;

  constructor(genome: Genome, options: BrainOptions = { innateScale: 1 }) {
    this.build(genome, options.innateScale);
    this.coreSynCount = this.synCount;
    const gene = Number.isFinite(genome.neurogenesis) ? genome.neurogenesis : DEFAULT_NEUROGENESIS;
    this.growthCapacity = genome.species === 0 ? Math.round(GROWTH_CAPACITY * clamp(gene, 0, 1)) : 0;
    this.tauGrown = 0.024 * clamp(genome.tauScale, 0.7, 1.35);
    for (const spec of decodeInstincts(genome.instincts)) this.grow(spec);
  }

  /** Neurons that exist: the core and whatever has grown. */
  get neuronCount(): number {
    return NEURON_COUNT + this.grown.length;
  }

  /** One past the last live neuron slot. */
  get activeEnd(): number {
    return GROWN_START + this.grown.length;
  }

  // ---------------------------------------------------------------------
  // Topology
  // ---------------------------------------------------------------------

  /**
   * Generate a sparse, layered, recurrent topology from the genome.
   *
   * Connectivity AND the initial weights are derived purely from
   * `genome.brainSeed` — not from the caller's RNG stream. That matters for two
   * reasons:
   *
   *  1. The genome fully determines the initial brain, which is what the project
   *     claims: "initial neural weights or weight-generation parameters" are
   *     heritable.
   *  2. A save file therefore only has to persist the *learned* weights and the
   *     transient state; the birth weights can be regenerated exactly, which is
   *     what makes `weightDrift` (the proof that learning happened) survive a
   *     save/load round trip.
   */
  private build(genome: Genome, innateScale: number): void {
    const rng = new Rng(genome.brainSeed);
    const density = clamp(genome.connDensity, 0.5, 1.6);
    const excRatio = clamp(genome.excRatio, 0.5, 0.95);
    const weightScale = clamp(genome.weightScale, 0.4, 1.8);
    const tauScale = clamp(genome.tauScale, 0.7, 1.35);

    // Per-region membrane time constants (seconds).
    for (let i = 0; i < NEURON_COUNT; i++) {
      const region = regionOf(i);
      const base = region === Region.Sensory ? 0.012 : region === Region.Motor ? 0.02 : 0.024;
      this.tau[i] = base * tauScale;
    }

    // Tonic bias. Real nervous tissue is spontaneously active: without a
    // background hum the sparse recurrent core can never bootstrap itself, and
    // the whole brain sits silently at its resting potential. The values here
    // put recurrent tissue just under threshold so that recurrent + sensory
    // input together produce sparse, ongoing firing.
    for (let i = 0; i < NEURON_COUNT; i++) {
      const region = regionOf(i);
      if (region === Region.Sensory) this.bias[i] = rng.normal(0.04, 0.05);
      // Motor neurons share an identical tonic bias. They are a homogeneous
      // pool, and any per-neuron bias variance would show up in the differential
      // read-out as a constant phantom command (a permanent limp or spin).
      else if (region === Region.Motor) this.bias[i] = MOTOR_TONIC;
      else if (region === Region.Modulatory) this.bias[i] = rng.normal(0.7, 0.15);
      else if (region === Region.Local) this.bias[i] = rng.normal(0.86, 0.18);
      else this.bias[i] = rng.normal(0.92, 0.2);
    }

    // --- Build the edge list ------------------------------------------------
    const preList: number[] = [];
    const postList: number[] = [];
    const weightList: number[] = [];

    const pushEdge = (pre: number, post: number, weight: number): void => {
      preList.push(pre);
      postList.push(post);
      weightList.push(clamp(weight, -W_MAX, W_MAX));
    };

    const drawWeight = (): number => {
      // Magnitude is half-normal; sign follows the genome's excitatory ratio.
      const magnitude = Math.abs(rng.normal(0, 0.21)) * weightScale + 0.02;
      return rng.next() < excRatio ? magnitude : -magnitude;
    };

    const connect = (
      from: number,
      candidates: Int32Array,
      count: number,
      gain = 1,
    ): void => {
      const k = Math.max(1, Math.min(count, candidates.length));
      for (let s = 0; s < k; s++) {
        // Sample without replacement using a deterministic partial shuffle.
        const j = s + Math.floor(rng.next() * (candidates.length - s));
        const tmp = candidates[s];
        candidates[s] = candidates[j];
        candidates[j] = tmp;
        pushEdge(from, candidates[s], drawWeight() * gain);
      }
    };

    const sensoryIdx = rangeArray(0, SENSORY_COUNT);
    const localIdx = rangeArray(LOCAL_START, LOCAL_COUNT);
    const recurrentIdx = rangeArray(RECURRENT_START, RECURRENT_COUNT);
    const motorIdx = rangeArray(MOTOR_START, MOTOR_COUNT);

    // sensory -> local (strong afferents)
    const kSensLocal = Math.round(6 * density);
    for (let i = 0; i < SENSORY_COUNT; i++) {
      connect(sensoryIdx[i], localIdx.slice(), kSensLocal, AFFERENT_GAIN);
    }

    // sensory -> recurrent (direct fast pathway, biologically plausible)
    const kSensRec = Math.round(2 * density);
    for (let i = 0; i < SENSORY_COUNT; i++) {
      connect(sensoryIdx[i], recurrentIdx.slice(), kSensRec, AFFERENT_GAIN);
    }

    // local -> local (2 hops) + local -> recurrent
    const kLocalLocal = Math.round(2 * density);
    const kLocalRec = Math.round(3 * density);
    for (let i = 0; i < LOCAL_COUNT; i++) {
      connect(localIdx[i], localIdx.slice(), kLocalLocal);
      connect(localIdx[i], recurrentIdx.slice(), kLocalRec);
    }

    // recurrent -> recurrent (the sparse recurrent core)
    const kRecRec = Math.round(13 * density);
    for (let i = 0; i < RECURRENT_COUNT; i++) {
      connect(recurrentIdx[i], recurrentIdx.slice(), kRecRec);
    }

    // recurrent -> motor, with a *balanced* in-degree.
    //
    // Every motor neuron receives exactly the same number of recurrent
    // afferents. With purely random wiring, chance gives some motors
    // systematically more excitatory drive than others, which showed up during
    // tuning as a constant spurious "attack" output that made the founders beat
    // each other up. Balancing the in-degree leaves the innate priors as the
    // only systematic asymmetry, which is exactly what we want.
    const kRecMotor = Math.max(1, Math.round(3 * density));
    for (let i = 0; i < RECURRENT_COUNT; i++) {
      for (let j = 0; j < kRecMotor; j++) {
        const target = MOTOR_START + ((i + j * 5) % MOTOR_COUNT);
        pushEdge(recurrentIdx[i], target, drawWeight() * MOTOR_DRIVE_SCALE);
      }
    }

    // --- Symmetry breaking --------------------------------------------------
    // The single `noise` channel projects into the recurrent core with random
    // signs. Because the projections are asymmetric, an identical noise value
    // nudges different parts of the network differently, which is what stops a
    // perfectly deterministic network from freezing into a fixed point.
    // (Wiring noise straight to opposing motor outputs would cancel itself out.)
    const kNoiseRec = Math.round(14 * density);
    for (let i = 0; i < kNoiseRec; i++) {
      const target = recurrentIdx[Math.floor(rng.next() * RECURRENT_COUNT)];
      const magnitude = 0.28 + rng.next() * 0.34;
      pushEdge(S.noise, target, rng.next() < 0.5 ? magnitude : -magnitude);
    }
    for (let i = 0; i < 6; i++) {
      const target = localIdx[Math.floor(rng.next() * LOCAL_COUNT)];
      const magnitude = 0.2 + rng.next() * 0.3;
      pushEdge(S.noise, target, rng.next() < 0.5 ? magnitude : -magnitude);
    }

    // modulatory -> recurrent + motor (diffuse, motor side balanced)
    const kModRec = Math.round(9 * density);
    const kModMotor = Math.max(1, Math.round(3 * density));
    for (let i = 0; i < MOD_COUNT; i++) {
      const from = MOD_START + i;
      connect(from, recurrentIdx.slice(), kModRec);
      for (let j = 0; j < kModMotor; j++) {
        pushEdge(from, MOTOR_START + ((i * 3 + j) % MOTOR_COUNT), drawWeight() * MOTOR_DRIVE_SCALE);
      }
    }

    // recurrent + local -> modulatory (the loop that lets the network monitor
    // its own activity). Connections are diffuse and sampled with replacement,
    // which is how real neuromodulatory pools behave.
    const kToMod = Math.round(7 * density);
    const kLocalToMod = Math.round(2 * density);
    for (let i = 0; i < MOD_COUNT; i++) {
      const to = MOD_START + i;
      for (let r = 0; r < kToMod; r++) {
        pushEdge(recurrentIdx[Math.floor(rng.next() * RECURRENT_COUNT)], to, drawWeight());
      }
      for (let r = 0; r < kLocalToMod; r++) {
        pushEdge(localIdx[Math.floor(rng.next() * LOCAL_COUNT)], to, drawWeight());
      }
    }

    // --- Innate priors ------------------------------------------------------
    this.innateStart = preList.length;
    for (let p = 0; p < INNATE_PRIORS.length; p++) {
      const [from, to, weight] = INNATE_PRIORS[p];
      pushEdge(from, to, weight * innateScale);
    }
    if (genome.species === 1) {
      for (let p = 0; p < PREDATOR_PRIORS.length; p++) {
        const [from, to, weight] = PREDATOR_PRIORS[p];
        pushEdge(from, to, weight);
      }
    }

    this.synCount = preList.length;
    this.pre = Int32Array.from(preList);
    this.post = Int32Array.from(postList);
    this.w = Float32Array.from(weightList);
    this.elig = new Float32Array(this.synCount);

    this.buildAdjacency();

    this.initialWeights = this.w.slice();
    // The set point for homeostatic scaling covers the learned inputs only; the
    // innate reflexes are left out of it (see `applyHomeostasis`).
    const innateEnd = this.innateStart + INNATE_PRIORS.length;
    this.initialInStrength = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let sum = 0;
      for (let s = this.inStart[i]; s < this.inStart[i + 1]; s++) {
        const index = this.inSyn[s];
        if (index >= this.innateStart && index < innateEnd) continue;
        sum += Math.abs(this.w[index]);
      }
      this.initialInStrength[i] = sum;
    }
  }

  private buildAdjacency(): void {
    const n = this.n;
    const inCount = new Int32Array(n + 1);
    const outCount = new Int32Array(n + 1);
    for (let s = 0; s < this.synCount; s++) {
      inCount[this.post[s] + 1]++;
      outCount[this.pre[s] + 1]++;
    }
    for (let i = 0; i < n; i++) {
      inCount[i + 1] += inCount[i];
      outCount[i + 1] += outCount[i];
    }
    this.inStart = inCount;
    this.outStart = outCount;

    const inSyn = new Int32Array(this.synCount);
    const outSyn = new Int32Array(this.synCount);
    const inCursor = inCount.slice(0, n);
    const outCursor = outCount.slice(0, n);
    for (let s = 0; s < this.synCount; s++) {
      inSyn[inCursor[this.post[s]]++] = s;
      outSyn[outCursor[this.pre[s]]++] = s;
    }
    this.inSyn = inSyn;
    this.outSyn = outSyn;
  }

  // ---------------------------------------------------------------------
  // Dynamics
  // ---------------------------------------------------------------------

  /**
   * Advance the network by one simulation tick.
   *
   * @param sensory  length-32 sensory current vector (0..1 per channel)
   * @param valence  homeostasis-derived reward signal in [-1, 1]
   */
  step(sensory: Float32Array, valence: number): void {
    // Only live slots: the core and the grown neurons, not the empty room after.
    const n = this.activeEnd;
    const current = this.current;
    const { v, refrac, spike, rate, bias, tau, pre, w, inStart, inSyn, transmit } = this;

    // Reward is injected into the neuromodulatory pool: this is the biological
    // "this is going well / badly" signal, and it is also the third factor in
    // the plasticity rule applied below.
    const rewardDrive = valence * 0.85;
    this.lastValence = valence;

    // The sensory layer is rate-coded, not spiking.
    //
    // Receptor neurons have an approximately linear rate/intensity curve across
    // their operating range, and an artificial animal cannot afford to have its
    // senses silently dropped because a weak stimulus failed to cross a spike
    // threshold. Everything downstream of the sensory layer is genuinely spiking
    // and recurrent; only the periphery is graded. This is also why a hungry
    // founder can react to a distant water source at all.
    for (let i = 0; i < SENSORY_COUNT; i++) {
      const value = sensory[i];
      rate[i] = value;
      transmit[i] = value;
      v[i] = value;
      spike[i] = 0;
    }

    for (let sub = 0; sub < BRAIN_SUBSTEPS; sub++) {
      // 1. Gather input currents (sensory neurons are pure sources).
      for (let i = SENSORY_COUNT; i < n; i++) {
        let sum = bias[i];
        const end = inStart[i + 1];
        for (let s = inStart[i]; s < end; s++) {
          const idx = inSyn[s];
          const preIdx = pre[idx];
          const signal = transmit[preIdx];
          if (signal !== 0) sum += w[idx] * signal;
        }
        current[i] = sum;
      }
      for (let i = 0; i < SENSORY_COUNT; i++) current[i] = 0;

      // 3. Global inhibitory pool over the *interneuron* tissue only
      //    (local + recurrent + modulatory). Motor neurons are deliberately
      //    excluded: their threshold should be a stable function of the innate
      //    priors and the descending drive, not of how loud the cortex happens
      //    to be this sub-step.
      let poolSum = 0;
      for (let i = LOCAL_START; i < MOD_START; i++) poolSum += rate[i];
      const poolTarget = poolSum / (MOD_START - LOCAL_START);
      this.inhibPool += (poolTarget - this.inhibPool) * INHIB_ADAPT;
      const globalInhibition = this.inhibPool * INHIB_GAIN;
      for (let i = LOCAL_START; i < MOD_START; i++) current[i] -= globalInhibition;

      // 4. Neuromodulatory pool + diffuse gain.
      let modSum = 0;
      for (let i = MOD_START; i < MOTOR_START; i++) {
        current[i] += rewardDrive + rate[i] * 0.1;
        modSum += rate[i];
      }
      const meanMod = modSum / MOD_COUNT;
      this.modGain = 1 + 0.35 * meanMod;
      for (let i = LOCAL_START; i < MOD_START; i++) current[i] *= this.modGain;
      for (let i = MOTOR_START; i < n; i++) current[i] *= this.modGain;

      // 5. Integrate + fire (sensory layer already settled above).
      for (let i = MOTOR_START; i < GROWN_START; i++) this.motorDrive[i - MOTOR_START] = current[i];
      for (let i = SENSORY_COUNT; i < n; i++) {
        if (refrac[i] > 0) {
          refrac[i] -= 1;
          v[i] = V_RESET;
          spike[i] = 0;
        } else {
          const dv = (BRAIN_DT / tau[i]) * (-v[i] + current[i]);
          v[i] += dv;
          if (v[i] >= V_THRESHOLD) {
            v[i] = V_RESET;
            refrac[i] = REFRACTORY_SUBSTEPS;
            spike[i] = 1;
            this.spikeCount[i]++;
          } else {
            spike[i] = 0;
          }
        }
        transmit[i] = spike[i];
        rate[i] += RATE_ALPHA * (spike[i] - rate[i]);
      }
    }
  }

  /**
   * Reward-modulated Hebbian plasticity.
   *
   * Three-factor rule:  dw = lr * plasticity * valence * eligibility
   *
   * `valence` comes from homeostasis (see `valenceFromHomeostasis`), NOT from a
   * hand-authored reward table. Eligibility is a decaying trace of coincident
   * pre/post activity, which is what gives the rule its "Hebbian" character.
   */
  applyPlasticity(plasticity: number, valence: number): void {
    const { w, elig, pre, post, rate } = this;
    for (let s = 0; s < this.synCount; s++) {
      // Eligibility always tracks coincidence, so a salient event can act on
      // the recent history of activity rather than only on this instant.
      elig[s] = elig[s] * ELIG_DECAY + ELIG_GAIN * rate[pre[s]] * rate[post[s]];
    }

    const gated = Math.abs(valence) < PLASTICITY_THRESHOLD;
    if (gated) {
      this.applyWeightDecay();
    } else {
      const lr = LEARN_RATE * clamp(plasticity, 0, 3) * clamp(valence, -1, 1);
      // The innate reflex arcs are brainstem, not cortex: far less plastic.
      //
      // Measured before this existed (vela, 12 000 ticks): the thirst -> drink
      // synapse fell from 1.80 to 0.05-0.3 in every brain, children included, and
      // thirsty people stood at the shore with a drink command of zero until the
      // emergency override fired. The cause is the credit assignment of a global
      // learning signal: every costly action (felling, digging, pain) is a
      // negative valence event, and the thirst sensor and the drink motor are
      // almost always somewhat active, so each one depresses the reflex a little,
      // while only the moment of drinking strengthens it. Reflexes can still
      // change over a life — the atlas records it when they do — just slowly.
      const innateEnd = this.innateStart + INNATE_PRIORS.length;
      const innateLr = lr * TUNING.innatePlasticity;
      for (let s = 0; s < this.synCount; s++) {
        let next = w[s] + (s >= this.innateStart && s < innateEnd ? innateLr : lr) * elig[s];
        next *= 1 - WEIGHT_DECAY;
        w[s] = clamp(next, -W_MAX, W_MAX);
      }
    }

    // Homeostatic regulation runs on a slow schedule.
    this.homeostasisCounter += 1;
    if (this.homeostasisCounter >= HOMEOSTASIS_INTERVAL) {
      this.homeostasisCounter = 0;
      this.applyHomeostasis();
    }
  }

  private applyWeightDecay(): void {
    const { w } = this;
    for (let s = 0; s < this.synCount; s++) w[s] *= 1 - WEIGHT_DECAY;
  }

  /**
   * Homeostatic synaptic scaling.
   *
   * Every so often, each neuron's incoming weights are nudged so that their
   * total absolute strength stays near its birth value. This is the standard
   * biological counterweight to Hebbian potentiation, and it is what keeps
   * lifetime learning from running away: without it, a valence signal that is
   * even slightly biased positive grows every synapse to its clamp, motor drives
   * reach ~17 instead of ~1, and every muscle group saturates at full command.
   *
   * The per-application factor is clamped so scaling is smooth rather than a
   * sudden reset, and the learned *pattern* is preserved — only the overall
   * gain is regulated.
   */
  applyHomeostasis(): void {
    const n = this.n;
    const { w, pre, post, inStart, inSyn } = this;
    // Scaling regulates what learning grows, and leaves the reflex arcs alone.
    //
    // It used to scale every input of a neuron together. As lifetime learning
    // strengthened a motor neuron's recurrent inputs, the scaling pulled the
    // whole set back down — the innate reflex with it — so the reflex's share of
    // the drive shrank toward nothing even with its own plasticity switched off
    // (measured: thirst -> drink 1.80 -> 0.17 in 15 000 ticks at zero plasticity).
    const innateStart = this.innateStart;
    const innateEnd = innateStart + INNATE_PRIORS.length;
    for (let i = 0; i < n; i++) {
      const start = inStart[i];
      const end = inStart[i + 1];
      if (end === start) continue;
      let sum = 0;
      for (let s = start; s < end; s++) {
        const index = inSyn[s];
        if (index >= innateStart && index < innateEnd) continue;
        sum += Math.abs(w[index]);
      }
      const target = this.initialInStrength[i];
      if (sum <= 1e-6 || target <= 1e-6) continue;
      const factor = clamp(target / sum, 0.9, 1.1);
      for (let s = start; s < end; s++) {
        const index = inSyn[s];
        if (index >= innateStart && index < innateEnd) continue;
        w[index] = clamp(w[index] * factor, -W_MAX, W_MAX);
      }
    }
    void pre;
    void post;
  }

  // ---------------------------------------------------------------------
  // Neurogenesis
  // ---------------------------------------------------------------------

  /**
   * Grow one neuron with the given wiring. False if the brain is full.
   *
   * The neuron takes the next free slot; its synapses are appended after every
   * existing synapse, so the core network and the innate reflexes keep their
   * indices and the order of grown synapses always follows the order of grown
   * neurons (which is what lets a save regrow them exactly).
   */
  grow(spec: GrownNeuron): boolean {
    if (this.grown.length >= GROWTH_CAPACITY) return false;
    const index = GROWN_START + this.grown.length;
    const k = spec.inputs.length;
    const total = this.synCount + k + 1;
    const pre = new Int32Array(total);
    const post = new Int32Array(total);
    const w = new Float32Array(total);
    const elig = new Float32Array(total);
    const initial = new Float32Array(total);
    pre.set(this.pre);
    post.set(this.post);
    w.set(this.w);
    elig.set(this.elig);
    initial.set(this.initialWeights);
    let s = this.synCount;
    let inStrength = 0;
    for (let j = 0; j < k; j++) {
      const weight = clamp(spec.inW[j], -W_MAX, W_MAX);
      pre[s] = spec.inputs[j];
      post[s] = index;
      w[s] = initial[s] = weight;
      inStrength += Math.abs(weight);
      s++;
    }
    const target = MOTOR_START + spec.motor;
    const out = clamp(spec.outW, -W_MAX, W_MAX);
    pre[s] = index;
    post[s] = target;
    w[s] = initial[s] = out;
    this.pre = pre;
    this.post = post;
    this.w = w;
    this.elig = elig;
    this.initialWeights = initial;
    this.synCount = total;

    this.bias[index] = GROWN_BIAS;
    this.tau[index] = this.tauGrown;
    this.v[index] = 0;
    this.refrac[index] = 0;
    this.spike[index] = 0;
    this.transmit[index] = 0;
    this.rate[index] = 0;
    this.spikeCount[index] = 0;
    this.buildAdjacency();
    this.initialInStrength[index] = inStrength;
    // The muscle's homeostatic set point grows with it, or scaling would shrink
    // everything else the muscle listens to to make room.
    this.initialInStrength[target] += Math.abs(out);
    this.grown.push({ ...spec, inputs: spec.inputs.slice(), inW: spec.inW.slice() });
    return true;
  }

  /** Remove grown neuron `k` and its synapses; the neurons after it move down a slot. */
  prune(k: number): void {
    const spec = this.grown[k];
    if (!spec) return;
    const index = GROWN_START + k;
    const end = this.activeEnd;
    let kept = 0;
    for (let s = 0; s < this.synCount; s++) {
      if (this.pre[s] === index || this.post[s] === index) continue;
      this.pre[kept] = this.pre[s] > index ? this.pre[s] - 1 : this.pre[s];
      this.post[kept] = this.post[s] > index ? this.post[s] - 1 : this.post[s];
      this.w[kept] = this.w[s];
      this.elig[kept] = this.elig[s];
      this.initialWeights[kept] = this.initialWeights[s];
      kept++;
    }
    this.pre = this.pre.slice(0, kept);
    this.post = this.post.slice(0, kept);
    this.w = this.w.slice(0, kept);
    this.elig = this.elig.slice(0, kept);
    this.initialWeights = this.initialWeights.slice(0, kept);
    this.synCount = kept;
    const target = MOTOR_START + spec.motor;
    this.initialInStrength[target] = Math.max(0, this.initialInStrength[target] - Math.abs(spec.outW));
    for (let i = index; i < end - 1; i++) {
      this.v[i] = this.v[i + 1];
      this.refrac[i] = this.refrac[i + 1];
      this.spike[i] = this.spike[i + 1];
      this.transmit[i] = this.transmit[i + 1];
      this.rate[i] = this.rate[i + 1];
      this.bias[i] = this.bias[i + 1];
      this.tau[i] = this.tau[i + 1];
      this.spikeCount[i] = this.spikeCount[i + 1];
      this.initialInStrength[i] = this.initialInStrength[i + 1];
    }
    const last = end - 1;
    this.v[last] = this.refrac[last] = this.spike[last] = this.transmit[last] = this.rate[last] = 0;
    this.bias[last] = this.tau[last] = this.initialInStrength[last] = 0;
    this.spikeCount[last] = 0;
    this.grown.splice(k, 1);
    this.buildAdjacency();
  }

  /** Remove every grown neuron and grow `specs` instead, in order. Used by a load. */
  resetGrowth(specs: readonly GrownNeuron[]): void {
    for (let k = this.grown.length - 1; k >= 0; k--) this.prune(k);
    for (const spec of specs) this.grow(spec);
  }

  /** Current weight of grown neuron `k`'s synapse onto its muscle. */
  grownOutWeight(k: number): number {
    const index = GROWN_START + k;
    const target = MOTOR_START + (this.grown[k]?.motor ?? 0);
    for (let s = this.outStart[index]; s < this.outStart[index + 1]; s++) {
      const syn = this.outSyn[s];
      if (this.post[syn] === target) return this.w[syn];
    }
    return 0;
  }

  /**
   * The neurogenesis rule, run once a tick after plasticity.
   *
   * `motor` is the muscle that was acting when this tick's valence arrived.
   * Returns the neuron grown this tick, or null. Deterministic: no randomness,
   * only the brain's own state.
   */
  considerGrowth(valence: number, motor: number, tick: number): GrownNeuron | null {
    // Credit: a grown neuron earns when it is active and things go the way it pushes.
    for (let k = 0; k < this.grown.length; k++) {
      const g = this.grown[k];
      const r = this.rate[GROWN_START + k];
      g.utility = g.utility * UTILITY_DECAY + r * valence * (g.outW >= 0 ? 1 : -1) * 0.05;
    }

    // Pruning: neurons that stopped earning their keep, or that learning has silenced.
    if (++this.pruneCounter >= PRUNE_INTERVAL) {
      this.pruneCounter = 0;
      for (let k = this.grown.length - 1; k >= 0; k--) {
        const g = this.grown[k];
        const age = g.born < 0 ? Infinity : tick - g.born;
        if (age < PRUNE_MIN_AGE) continue;
        if (g.utility < PRUNE_UTILITY || Math.abs(this.grownOutWeight(k)) < PRUNE_WEIGHT) this.prune(k);
      }
    }

    if (this.growthCapacity === 0) return null;
    const baseline = this.senseBaseline;
    for (let i = 0; i < SENSORY_COUNT; i++) baseline[i] += (this.rate[i] - baseline[i]) * BASELINE_ADAPT;
    if (Math.abs(valence) < GROWTH_VALENCE) return null;
    if (tick - this.lastGrowthTick < GROWTH_COOLDOWN) return null;
    if (motor < 0 || motor >= MOTOR_COUNT) return null;

    // The moment: the senses that stand out most against their usual level.
    const inputs: number[] = [];
    for (let pick = 0; pick < GROWN_INPUTS; pick++) {
      let best = -1;
      let bestSalience = 0.05;
      for (let i = 0; i < SENSORY_COUNT; i++) {
        if (NOT_A_CONTEXT.has(i) || inputs.includes(i)) continue;
        if (this.rate[i] < GROWN_INPUT_FLOOR) continue;
        const salience = this.rate[i] - baseline[i];
        if (salience > bestSalience) {
          bestSalience = salience;
          best = i;
        }
      }
      if (best < 0) break;
      inputs.push(best);
    }
    if (inputs.length < 2) return null;
    this.lastGrowthTick = tick;
    const sign = valence > 0 ? 1 : -1;

    // Already known: the same muscle, the same direction, the same leading sense.
    for (const g of this.grown) {
      if (g.motor === motor && Math.sign(g.outW) === sign && g.inputs[0] === inputs[0]) {
        g.utility += 0.2;
        return null;
      }
    }

    // Full: make room by letting go of the least useful thing grown in this life.
    if (this.grown.length >= this.growthCapacity) {
      let worst = -1;
      let worstUtility = 0;
      for (let k = 0; k < this.grown.length; k++) {
        const g = this.grown[k];
        if (g.born < 0 || tick - g.born < PRUNE_MIN_AGE) continue;
        if (g.utility < worstUtility) {
          worstUtility = g.utility;
          worst = k;
        }
      }
      if (worst < 0) return null;
      this.prune(worst);
    }

    let norm = 0;
    for (const i of inputs) norm += this.rate[i] * this.rate[i];
    const inW = inputs.map((i) => clamp((GROWN_DRIVE * this.rate[i]) / Math.max(norm, 1e-3), 0.2, W_MAX));
    const spec: GrownNeuron = { inputs, inW, motor, outW: sign * GROWN_OUT, born: tick, generations: 0, utility: 0 };
    if (!this.grow(spec)) return null;
    return this.grown[this.grown.length - 1];
  }

  /** Grown neurons as plain data, for a save. */
  serializeGrowth(): GrownNeuron[] {
    return this.grown.map((g) => ({ ...g, inputs: g.inputs.slice(), inW: g.inW.slice() }));
  }

  /** The growth rule's own slow state, for a save: without it a restored brain grows at different moments. */
  serializeGrowthState(): { baseline: string; last: number; prune: number } {
    return { baseline: float32ToBase64(this.senseBaseline), last: this.lastGrowthTick, prune: this.pruneCounter };
  }

  restoreGrowthState(state: { baseline?: string; last?: number; prune?: number } | undefined): void {
    if (!state) return;
    if (typeof state.baseline === 'string') base64ToFloat32(state.baseline, this.senseBaseline);
    this.lastGrowthTick = Number.isFinite(state.last) ? (state.last as number) : -1e9;
    this.pruneCounter = Number.isFinite(state.prune) ? (state.prune as number) : 0;
  }

  // ---------------------------------------------------------------------
  // Read-out
  // ---------------------------------------------------------------------

  /**
   * Continuous motor command vector in [0, 1].
   *
   * The command is each motor's drive measured against a *slowly adapting
   * baseline* — a running estimate of the common drive shared by the whole motor
   * pool — and scaled into [0, 1].
   *
   * This is the fourth and final read-out design, and each earlier one failed
   * for a reason worth recording:
   *
   *  1. Raw spike rate — a LIF neuron with a one-sub-step refractory has only two
   *     states, so commands quantised to "full" or "nothing" and the pool fell
   *     into a synchronised limit cycle.
   *  2. Absolute drive — saturated as soon as several innate priors were active.
   *  3. Mean-subtracted / divisively normalised drive — scale-invariant, but it
   *     made every output depend on what the other eleven were doing, so a single
   *     strong prior could not reliably hold a command above its action gate.
   *  4. Absolute drive minus a *fixed* tonic bias — broke as soon as the common
   *     drive drifted, which it does: the recurrent core, the diffuse
   *     neuromodulatory gain and lifetime plasticity all add a slowly varying
   *     offset that is identical across the pool and means nothing.
   *
   * Tracking the common component out adapts to all of those sources at once,
   * so what remains is the part of each motor's drive that is actually specific
   * to that motor. Motor neurons adapting to their background input is also what
   * real motor pools do.
   */
  readMotor(out: Float32Array): void {
    const { motorDrive } = this;
    let mean = 0;
    for (let i = 0; i < MOTOR_COUNT; i++) mean += motorDrive[i];
    mean /= MOTOR_COUNT;

    this.motorBaseline += (mean - this.motorBaseline) * MOTOR_BASELINE_ADAPT;

    for (let i = 0; i < MOTOR_COUNT; i++) {
      out[i] = clamp((motorDrive[i] - this.motorBaseline) * MOTOR_READOUT_GAIN, 0, 1);
    }
  }

  /**
   * Net command of an antagonist pair (e.g. turn-right against turn-left), in
   * -1..1, from the two motor neurons' drives rather than from their clamped
   * commands.
   *
   * Measured (solace): a thirsty person with water sensed hard to the right had
   * turn-right and turn-left both at 1.00 — both drives far above the pool's
   * baseline — so the clamped difference was zero and they walked straight past
   * the river they were dying beside. Antagonist muscles pull against each
   * other; the joint moves by the difference of their activations, and that
   * difference survives when both are strongly driven.
   */
  pairCommand(agonist: number, antagonist: number): number {
    return clamp((this.motorDrive[agonist] - this.motorDrive[antagonist]) * MOTOR_READOUT_GAIN, -1, 1);
  }

  /** Index of the strongest motor output (0..11). */
  winningMotor(): number {
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < MOTOR_COUNT; i++) {
      const value = this.rate[MOTOR_START + i];
      if (value > bestVal) {
        bestVal = value;
        best = i;
      }
    }
    return best;
  }

  stats(): BrainTopologyStats {
    let excitatory = 0;
    let inhibitory = 0;
    for (let s = 0; s < this.synCount; s++) {
      if (this.w[s] >= 0) excitatory++;
      else inhibitory++;
    }
    return { neurons: this.neuronCount, synapses: this.synCount, excitatory, inhibitory };
  }

  /** Mean absolute change from birth weights — proof that learning happened. */
  weightDrift(): number {
    let sum = 0;
    for (let s = 0; s < this.synCount; s++) sum += Math.abs(this.w[s] - this.initialWeights[s]);
    return sum / this.synCount;
  }

  /** Change since birth of innate reflex `k` (in `INNATE_PRIORS` order). */
  innateDrift(k: number): number {
    const s = this.innateStart + k;
    return this.w[s] - this.initialWeights[s];
  }

  /**
   * Whether a *driving* reflex born at w >= `strength` now pulls the other way,
   * by at least `margin`. Only excitatory reflexes count: the strong inhibitory
   * ones (hunger suppressing farm work) turn around routinely — that is learning
   * to work when hungry, and the atlas has its own entry for it.
   */
  strongReflexReversed(strength: number, margin: number): boolean {
    for (let k = 0; k < INNATE_PRIORS.length; k++) {
      const s = this.innateStart + k;
      const w0 = this.initialWeights[s];
      if (w0 >= strength && this.w[s] <= -margin) return true;
    }
    return false;
  }

  /** Current weight of innate reflex `k`. */
  innateWeight(k: number): number {
    return this.w[this.innateStart + k];
  }

  /** Largest change since birth of any innate reflex, and which one. */
  maxInnateDrift(): { index: number; drift: number } {
    let index = -1;
    let drift = 0;
    for (let k = 0; k < INNATE_PRIORS.length; k++) {
      const d = Math.abs(this.innateDrift(k));
      if (d > drift) {
        drift = d;
        index = k;
      }
    }
    return { index, drift };
  }

  /** Mean absolute weight, used by the inspector. */
  meanAbsWeight(): number {
    let sum = 0;
    for (let s = 0; s < this.synCount; s++) sum += Math.abs(this.w[s]);
    return sum / this.synCount;
  }

  // ---------------------------------------------------------------------
  // Serialisation
  // ---------------------------------------------------------------------

  /**
   * Pack the full dynamic state of the network.
   *
   * Topology and *birth* weights are regenerated from the genome, so they do not
   * need to be stored. Everything that has changed since birth does:
   *
   *  - membrane potentials, spike flags, smoothed rates and refractory counters,
   *  - the learned weights,
   *  - the eligibility traces (they gate the next plasticity update, so leaving
   *    them out makes a restored brain diverge immediately),
   *  - the inhibitory pool, the motor baseline and the homeostasis counter,
   *    which are all slow variables that feed back into behaviour.
   *
   * The spike flags matter more than they look: they are what the network
   * transmits during the *first* sub-step after a load. Without them the
   * restored brain spends one sub-step with a silent network and immediately
   * diverges from the world it was saved from.
   */
  serialize(): string {
    // Packed as raw float32 bytes in base64. Every array here is a Float32Array,
    // so this is exact — a restored brain continues identically — and about a
    // third of the size of the same numbers written out as JSON decimals, which
    // was 176 KB per person and the main reason saves outgrew browser storage.
    // The four slow scalars are JS doubles, not float32, so they ride alongside
    // as text: squeezing them through a Float32Array would round them, and a
    // restored brain would drift from the original within a few hundred ticks.
    const values = this.serializeValues();
    const arrays = Float32Array.from(values.slice(0, values.length - 4));
    return `${float32ToBase64(arrays)}|${values.slice(values.length - 4).join(',')}`;
  }

  private serializeValues(): number[] {
    const n = this.activeEnd;
    const out = new Array<number>(n * 4 + this.synCount * 2 + 4);
    let k = 0;
    for (let i = 0; i < n; i++) out[k++] = this.v[i];
    for (let i = 0; i < n; i++) out[k++] = this.spike[i];
    for (let i = 0; i < n; i++) out[k++] = this.rate[i];
    for (let i = 0; i < n; i++) out[k++] = this.refrac[i];
    for (let s = 0; s < this.synCount; s++) out[k++] = this.w[s];
    for (let s = 0; s < this.synCount; s++) out[k++] = this.elig[s];
    out[k++] = this.inhibPool;
    out[k++] = this.motorBaseline;
    out[k++] = this.modGain;
    out[k++] = this.homeostasisCounter;
    return out;
  }

  restore(packed: readonly number[] | string, expectedSynapses: number): boolean {
    let data: ArrayLike<number> = packed as readonly number[];
    if (typeof packed === 'string') {
      const [bytes, scalars = ''] = packed.split('|');
      const arrays = decodeFloat32(bytes, this.activeEnd * 4 + expectedSynapses * 2);
      const tail = scalars.split(',').map(Number);
      const all = new Array<number>(arrays.length + 4);
      for (let i = 0; i < arrays.length; i++) all[i] = arrays[i];
      for (let i = 0; i < 4; i++) all[arrays.length + i] = tail[i] ?? 0;
      data = all;
    }
    // Live slots only. A save from before neurogenesis has exactly the 341 of
    // the core, which is what a brain with nothing grown has live.
    const n = this.activeEnd;
    const expected = n * 4 + expectedSynapses * 2 + 4;
    if (data.length !== expected || expectedSynapses !== this.synCount) return false;
    let k = 0;
    for (let i = 0; i < n; i++) this.v[i] = data[k++];
    for (let i = 0; i < n; i++) {
      this.spike[i] = data[k++];
      this.transmit[i] = this.spike[i];
    }
    for (let i = 0; i < n; i++) this.rate[i] = data[k++];
    for (let i = 0; i < n; i++) this.refrac[i] = data[k++];
    for (let s = 0; s < this.synCount; s++) this.w[s] = data[k++];
    for (let s = 0; s < this.synCount; s++) this.elig[s] = data[k++];
    this.inhibPool = data[k++];
    this.motorBaseline = data[k++];
    this.modGain = data[k++];
    this.homeostasisCounter = data[k++];
    return true;
  }
}

// ---------------------------------------------------------------------------

/**
 * Grown neurons from a genome's instinct genes. Each instinct is
 * `INSTINCT_STRIDE` numbers: three inputs (-1 for none), the motor, three input
 * weights, the output weight and how many generations it has been inherited.
 * Anything malformed is skipped, so a hand-edited or old genome cannot break a
 * brain.
 */
export function decodeInstincts(genes: readonly number[] | undefined): GrownNeuron[] {
  const out: GrownNeuron[] = [];
  if (!Array.isArray(genes)) return out;
  for (let o = 0; o + INSTINCT_STRIDE <= genes.length && out.length < MAX_INSTINCTS; o += INSTINCT_STRIDE) {
    const inputs: number[] = [];
    const inW: number[] = [];
    for (let j = 0; j < 3; j++) {
      const input = genes[o + j];
      const weight = genes[o + 4 + j];
      if (!Number.isInteger(input) || input < 0 || input >= SENSORY_COUNT || !Number.isFinite(weight)) continue;
      inputs.push(input);
      inW.push(weight);
    }
    const motor = genes[o + 3];
    const outW = genes[o + 7];
    if (inputs.length === 0 || !Number.isInteger(motor) || motor < 0 || motor >= MOTOR_COUNT || !Number.isFinite(outW)) continue;
    out.push({ inputs, inW, motor, outW, born: -1, generations: Math.max(1, Math.round(genes[o + 8] || 1)), utility: 0 });
  }
  return out;
}

/** The instinct genes for one grown neuron, one generation further on. */
function encodeInstinct(g: GrownNeuron): number[] {
  const out = new Array<number>(INSTINCT_STRIDE).fill(-1);
  for (let j = 0; j < 3; j++) {
    out[j] = g.inputs[j] ?? -1;
    out[4 + j] = g.inW[j] ?? 0;
  }
  out[3] = g.motor;
  out[7] = g.outW;
  out[8] = g.generations + 1;
  return out;
}

/**
 * The third Rule of Creation: what a parent's brain grew and found useful can
 * be born into the child. The most useful grown neurons of each parent (two at
 * most from each, `MAX_INSTINCTS` in all) are written into the child's genome as
 * instincts, with mutation: now and then one is lost, its weights drift, or one
 * of its senses is swapped for another. Over generations the useful ones spread
 * and the rest fade — new reflexes, evolved rather than written.
 */
export function inheritInstincts(mother: Brain, father: Brain, rng: Rng): number[] {
  const pick = (brain: Brain): GrownNeuron[] =>
    brain.grown
      .filter((g) => g.utility >= INSTINCT_UTILITY)
      .sort((a, b) => b.utility - a.utility)
      .slice(0, 2);
  const chosen = [...pick(mother), ...pick(father)];
  const genes: number[] = [];
  const seen = new Set<string>();
  for (const g of chosen) {
    if (genes.length / INSTINCT_STRIDE >= MAX_INSTINCTS) break;
    const key = `${g.inputs[0]}>${g.motor}${Math.sign(g.outW)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rng.next() < 0.08) continue; // lost
    const instinct = encodeInstinct(g);
    if (rng.next() < 0.2) {
      for (let j = 4; j <= 7; j++) if (instinct[j] !== 0) instinct[j] *= 1 + rng.normal(0, 0.12);
    }
    if (rng.next() < 0.05) {
      const slot = Math.floor(rng.next() * 3);
      let sense = Math.floor(rng.next() * SENSORY_COUNT);
      if (NOT_A_CONTEXT.has(sense)) sense = S.hunger;
      if (instinct[slot] >= 0) instinct[slot] = sense;
    }
    genes.push(...instinct);
  }
  return genes;
}

function decodeFloat32(text: string, length: number): Float32Array {
  const out = new Float32Array(length);
  base64ToFloat32(text, out);
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function rangeArray(start: number, count: number): Int32Array {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) out[i] = start + i;
  return out;
}

/** Human-readable summary of a motor vector. */
export function describeMotor(motor: Float32Array): string {
  let best = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < motor.length; i++) {
    if (motor[i] > bestVal) {
      bestVal = motor[i];
      best = i;
    }
  }
  const names = [
    'Move Forward',
    'Move Backward',
    'Turn Left',
    'Turn Right',
    'Sprint',
    'Eat',
    'Drink',
    'Rest',
    'Attack',
    'Signal',
    'Mate',
    'Interact',
  ];
  return names[best] ?? 'Idle';
}

export { SENSORY_COUNT, MOTOR_COUNT, MOTOR_START, MOD_START, LOCAL_START, RECURRENT_START };
