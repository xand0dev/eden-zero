import { Rng } from '../rng';
import { BRAIN_DT, BRAIN_SUBSTEPS } from '../../shared/constants';
import type { Genome } from '../genetics/genome';
import {
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
  [S.fatigue, MOTOR(M.rest), 0.75],
  [S.fatigue, MOTOR(M.moveFwd), -0.38],
  [S.fatigue, MOTOR(M.sprint), -0.4],
  [S.energy, MOTOR(M.rest), -0.32],
  // Thermoregulation-ish bias.
  [S.cold, MOTOR(M.moveFwd), 0.1],
  [S.cold, MOTOR(M.rest), -0.2],
  [S.heat, MOTOR(M.rest), 0.26],
  [S.heat, MOTOR(M.sprint), -0.3],
  // Diurnal bias: darkness favours rest, light favours activity.
  [S.light, MOTOR(M.rest), -0.28],
  [S.light, MOTOR(M.moveFwd), 0.25],
  // Reproductive readiness.
  [S.libido, MOTOR(M.mate), 0.5],
  [S.libido, MOTOR(M.moveFwd), 0.06],
  [S.fertility, MOTOR(M.mate), 0.14],
  // Social affiliation.
  [S.attachment, MOTOR(M.interact), 0.32],
  [S.attachment, MOTOR(M.moveFwd), 0.1],
  [S.familiarity, MOTOR(M.moveFwd), 0.06],
  [S.familiarity, MOTOR(M.signal), 0.08],
  // Threat avoidance.
  [S.threatFront, MOTOR(M.moveBack), 0.55],
  [S.threatFront, MOTOR(M.moveFwd), -0.4],
  [S.threatFront, MOTOR(M.sprint), 0.35],
  [S.threatFront, MOTOR(M.attack), 0.18],
  [S.threatRight, MOTOR(M.turnLeft), 0.4],
  [S.threatLeft, MOTOR(M.turnRight), 0.4],
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
  // Conspecific approach.
  [S.humanFront, MOTOR(M.moveFwd), 0.12],
  [S.humanRight, MOTOR(M.turnRight), 0.1],
  [S.humanLeft, MOTOR(M.turnLeft), 0.1],
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

export interface BrainTopologyStats {
  neurons: number;
  synapses: number;
  excitatory: number;
  inhibitory: number;
}

export class Brain {
  readonly n = NEURON_COUNT;

  /** Membrane potential. */
  readonly v = new Float32Array(NEURON_COUNT);
  /** Refractory countdown in sub-steps. */
  readonly refrac = new Float32Array(NEURON_COUNT);
  /** Current spike flags (0/1) for spiking neurons. */
  readonly spike = new Float32Array(NEURON_COUNT);
  /**
   * What this neuron actually transmits down its axons this sub-step.
   * For sensory neurons this is the graded stimulus intensity; for everything
   * else it is the binary spike flag.
   */
  readonly transmit = new Float32Array(NEURON_COUNT);
  /** Smoothed firing rate — this is what the brain viewer displays. */
  readonly rate = new Float32Array(NEURON_COUNT);
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
  readonly bias = new Float32Array(NEURON_COUNT);
  /** Membrane time constant per neuron, seconds. */
  readonly tau = new Float32Array(NEURON_COUNT);

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
  private readonly current = new Float32Array(NEURON_COUNT);

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

  constructor(genome: Genome) {
    this.build(genome);
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
  private build(genome: Genome): void {
    const rng = new Rng(genome.brainSeed);
    const density = clamp(genome.connDensity, 0.5, 1.6);
    const excRatio = clamp(genome.excRatio, 0.5, 0.95);
    const weightScale = clamp(genome.weightScale, 0.4, 1.8);
    const tauScale = clamp(genome.tauScale, 0.7, 1.35);

    // Per-region membrane time constants (seconds).
    for (let i = 0; i < this.n; i++) {
      const region = regionOf(i);
      const base = region === Region.Sensory ? 0.012 : region === Region.Motor ? 0.02 : 0.024;
      this.tau[i] = base * tauScale;
    }

    // Tonic bias. Real nervous tissue is spontaneously active: without a
    // background hum the sparse recurrent core can never bootstrap itself, and
    // the whole brain sits silently at its resting potential. The values here
    // put recurrent tissue just under threshold so that recurrent + sensory
    // input together produce sparse, ongoing firing.
    for (let i = 0; i < this.n; i++) {
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
    for (let p = 0; p < INNATE_PRIORS.length; p++) {
      const [from, to, weight] = INNATE_PRIORS[p];
      pushEdge(from, to, weight);
    }

    this.synCount = preList.length;
    this.pre = Int32Array.from(preList);
    this.post = Int32Array.from(postList);
    this.w = Float32Array.from(weightList);
    this.elig = new Float32Array(this.synCount);

    this.buildAdjacency();

    this.initialWeights = this.w.slice();
    this.initialInStrength = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let sum = 0;
      for (let s = this.inStart[i]; s < this.inStart[i + 1]; s++) sum += Math.abs(this.w[this.inSyn[s]]);
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
    const n = this.n;
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
      for (let i = MOTOR_START; i < n; i++) this.motorDrive[i - MOTOR_START] = current[i];
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
      for (let s = 0; s < this.synCount; s++) {
        let next = w[s] + lr * elig[s];
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
    for (let i = 0; i < n; i++) {
      const start = inStart[i];
      const end = inStart[i + 1];
      if (end === start) continue;
      let sum = 0;
      for (let s = start; s < end; s++) sum += Math.abs(w[inSyn[s]]);
      const target = this.initialInStrength[i];
      if (sum <= 1e-6 || target <= 1e-6) continue;
      const factor = clamp(target / sum, 0.9, 1.1);
      for (let s = start; s < end; s++) {
        const index = inSyn[s];
        w[index] = clamp(w[index] * factor, -W_MAX, W_MAX);
      }
    }
    void pre;
    void post;
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
    return { neurons: this.n, synapses: this.synCount, excitatory, inhibitory };
  }

  /** Mean absolute change from birth weights — proof that learning happened. */
  weightDrift(): number {
    let sum = 0;
    for (let s = 0; s < this.synCount; s++) sum += Math.abs(this.w[s] - this.initialWeights[s]);
    return sum / this.synCount;
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
  serialize(): number[] {
    const n = this.n;
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

  restore(data: readonly number[], expectedSynapses: number): boolean {
    const n = this.n;
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
