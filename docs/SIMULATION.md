# EDEN//0 — Simulation

The reference for what the simulation actually does, tick by tick.

---

## 1. Time

| Constant | Value | Meaning |
|---|---|---|
| `SIM_HZ` | 20 | fixed ticks per simulated second |
| `DT` | 0.05 s | fixed timestep |
| `BRAIN_SUBSTEPS` | 5 | neural sub-steps per tick (10 ms each) |
| `BIO_YEAR_SECONDS` | 150 | simulated seconds per *biological year* |
| `DAY_SECONDS` | 240 | simulated seconds per day/night cycle |

**Ageing is deliberately decoupled from the day/night cycle.** A full lifetime
runs on its own accelerated clock so that a generation is observable in minutes at
higher speeds, while a "day" stays long enough to be a meaningful environmental
cycle. Tying the two together produced ridiculous pacing in early builds.

A tick, in order:

1. advance `tick` and `simTime`, update the climate
2. rebuild the spatial grids from the entity arrays
3. **humans**: `sense → think → act → updatePhysiology`
4. **predators**: `sense → think → act → updatePhysiology → maybe reproduce`
5. **plants**: grow, produce biomass, spread seeds, die
6. **reproduction**: advance mating pairs, resolve conceptions, advance pregnancies
7. decay effect lifetimes
8. compact dead entities out of the arrays
9. check population milestones

Dead entities stay in the arrays until step 8, which is what keeps entity indices
valid for the whole tick.

---

## 2. Sensory channels (32)

| Index | Channel | Notes |
|---|---|---|
| 0–3 | food front / right / back / left | graded, `cos`/`sin` of relative bearing |
| 4–7 | water front / right / back / left | ray-cast to nearest water, cached 4 ticks |
| 8–11 | conspecific front / right / back / left | nearest individual only |
| 12–15 | threat front / right / back / left | nearest predator only |
| 16 | touch | something within 0.95 tiles |
| 17 | pain | 0..1 |
| 18–19 | cold / heat | deviation outside the genome's comfort band |
| 20 | light | 0 at midnight, 1 at midday |
| 21–23 | hunger / thirst / fatigue | 0..1 |
| 24–26 | energy (inverted) / health (inverted) / stress | |
| 27–28 | libido / fertility | |
| 29–30 | familiarity / attachment | maximum among visible conspecifics |
| 31 | noise | deterministic hash of (id, tick) |

### Directional encoding

A target's direction is encoded as its forward component `cos(Δθ)` and its
lateral component `sin(Δθ)`, split into the four channels by sign. A target at 45°
therefore drives the front and side channels equally, and the steering signal
varies smoothly as the animal turns. Hard quadrant bucketing was tried first and
produced a dead zone directly to the side plus an abrupt all-or-nothing switch at
every boundary — founders twitched instead of steering.

### Salience modulation

Three channels are scaled *upstream* of the network:

- food channels × `(0.22 + 0.78 × hunger)`
- water channels × `(0.22 + 0.78 × thirst)`
- threat channels × `(0.4 + 0.6 × stress)`

plus an urgency multiplier that rises steeply above 60% need. This is homeostatic
gain control on the sensory pathway: a hungry animal literally sees food more
strongly. It is the reason a randomly-initialised network can survive at all.

### Nearest-target sensing

Only the *nearest* food, conspecific and threat are encoded. Summing every plant
in range (there are thousands) lit up all four channels at once and produced a
signal that steered nothing.

### Search terminates on contact

A resource within reach (`REACH = 1.35` tiles) has its directional contribution
damped to 15%, and water within 3 tiles damps the water channels the same way.
Without this the approach drive never switches off: an animal walks straight past
the river it is dying of thirst beside.

---

## 3. Motor outputs (12)

`move-forward`, `move-backward`, `turn-left`, `turn-right`, `sprint`, `eat`,
`drink`, `rest`, `attack`, `signal`, `mate`, `interact`.

The first five drive movement physics directly. The rest are **proximity-gated**:
pressing `eat` only does something if there is food within 1.35 tiles, `drink`
needs water within 2.2 tiles, `attack` needs a target within 1.5 tiles, `mate`
needs an eligible partner within 2.4 tiles. That is a reflex arc, not a decision.

Consumption deliberately does **not** compete with locomotion. An animal can graze
while walking; making `eat` fight `move-forward` for control of the legs meant a
hungry founder either walked past its food or froze next to nothing.

### The read-out

Each motor's command is its **integrated synaptic drive measured against a slowly
adapting baseline** — a running estimate of the drive shared by the whole pool —
scaled into `[0, 1]`.

Four read-outs were tried and each failure is instructive:

1. **Raw spike rate.** A LIF neuron with a one-sub-step refractory has essentially
   two states, so commands quantised to "full" or "nothing" and the whole motor
   pool fell into a synchronised limit cycle (every neuron firing on alternate
   sub-steps, rates pinned at exactly 0.5618 / 0.4382).
2. **Absolute drive.** Saturated as soon as several innate priors were active.
3. **Mean-subtracted / divisively normalised drive.** Scale-invariant, but every
   output depended on what the other eleven were doing, so a single strong prior
   could not reliably hold a command above its action gate.
4. **Absolute drive minus a fixed tonic bias.** Broke as soon as the common drive
   drifted — which it does, because the recurrent core, the diffuse
   neuromodulatory gain and lifetime plasticity all add a slowly varying offset
   that is identical across the pool and means nothing.

Tracking the common component out adapts to all of those at once. What remains is
the part of each motor's drive that is actually specific to that motor.

---

## 4. The neural model

Leaky Integrate-and-Fire, explicit Euler, `dt = 10 ms`:

```
v ← v + (dt/τ) · (−v + I)
if v ≥ 1:  emit spike, v ← 0, refractory for one sub-step
```

`I` is the sum of the tonic bias, weighted presynaptic input, injected sensory
current and diffuse neuromodulatory gain.

### Regions

| Region | Neurons | τ | Tonic bias |
|---|---|---|---|
| sensory | 0–31 (32) | 12 ms | ~0.04 |
| local | 32–95 (64) | 24 ms | ~0.86 |
| recurrent | 96–227 (132) | 24 ms | ~0.92 |
| modulatory | 228–243 (16) | 24 ms | ~0.70 |
| motor | 244–255 (12) | 20 ms | 0.74 (identical) |

Motor neurons share an identical tonic bias because they are a homogeneous pool,
and per-neuron bias variance shows up in the read-out as a constant phantom
command — a permanent limp or spin.

### Connectivity

Generated deterministically from `genome.brainSeed` and the connectivity genes.
Each region projects forward with a density-scaled out-degree, giving roughly
2,000–5,000 synapses. Motor in-degree is **balanced** — every motor neuron
receives exactly the same number of recurrent afferents. Purely random wiring
gave some motors systematically more excitatory drive than others, which showed up
as a constant spurious `attack` output that made the founders beat each other up.

### Three stabilising mechanisms

**Global inhibitory feedback.** A slowly-adapting pool over the interneuron tissue
(local + recurrent + modulatory; motor neurons are excluded so their threshold
stays a stable function of the priors). Rising activity recruits proportional
inhibition. The loop is low-pass filtered so it is slower than the spiking
dynamics and therefore stable. Without it the network either sits silent forever
or runs away to saturation — both were observed.

**Afferent gain.** Sensory projections are 2.1× stronger than the intrinsic
recurrent matrix, mirroring the thalamocortical afferents that dominate a real
sensory pathway. Without it the recurrent background swamps the senses.

**Descending drive attenuation.** The recurrent and modulatory projections onto
motor neurons are scaled to 9%. Motor output is where the reflex arc and the
recurrent core compete; biology resolves this in favour of the reflex, and if the
recurrent core drives the motor pool as hard as the priors do, a
randomly-initialised network produces loud, meaningless motor noise.

### Innate priors

A table of ~50 strong, **plastic** synapses implementing:

- nociceptive withdrawal (pain → backward, suppress forward)
- homeostatic routing (hunger → eat, thirst → drink, fatigue → rest)
- resource approach (food/water direction → forward and turn)
- threat avoidance
- reproductive readiness and social affiliation
- mutual exclusion between opposing motors

There is deliberately **no** `pain → attack` prior. Pain is caused by being
attacked, so that prior created a runaway retaliation loop: the founders injured
each other until the whole village died of its wounds within three minutes.
Aggression is driven by threat and by learning.

There is also deliberately **no** `hunger → move-forward` prior. Locomotion toward
a resource is driven entirely by the directional channels, which collapse on
contact. A separate "keep walking because you are hungry" prior kept the founders
at full speed permanently.

### Symmetry breaking

The single `noise` channel projects into the recurrent core with random signs.
Because the projections are asymmetric, an identical noise value nudges different
parts of the network differently. Wiring noise straight to opposing motor outputs
would cancel itself out exactly.

---

## 5. Physiology

All values are 0–100 unless noted.

| Quantity | Rate |
|---|---|
| hunger | +0.32 /s × metabolism |
| thirst | +0.42 /s × metabolism |
| fatigue | +1.1 /s awake, −5.2 /s resting (×1.35 asleep) |
| energy | −(0.30 + 1.35 × activity) /s, +1.55 /s resting |
| health | +0.55 /s when needs met; −3.2 /s starving; −4.2 /s dehydrated; −1.7 /s thermal |
| pain | −2.4 /s decay |
| body temperature | ambient, moderated by shelter zones |

Body temperature comes from the climate at the individual's position: a latitude
gradient, a diurnal swing of ±4.5°, spatial variation, plus the god tool's global
offset. Shelter zones pull the local temperature toward 6.5°. Comfort is the
deviation outside the genome's `tempOptimum ± tempTolerance` band.

### Survival-critical homeostatic override

When thirst exceeds 85 or hunger exceeds 80, the consummatory reflex fires
regardless of the cortical command. This is brainstem-level homeostatic
modulation — the same class of reflex as nociceptive withdrawal — and it is what
stops an animal that has wandered away from water from dying while its network is
busy doing something else. It engages only in the last ~15% of the need range;
below that, behaviour is entirely whatever the network produces.

### Lifecycle

| Stage | Age (biological years) |
|---|---|
| Baby | 0 – 1.5 |
| Child | 1.5 – 12 |
| Adult | 12 – 45 |
| Older adult | 45+ |

Juveniles are infertile. Body scale grows from 38% of adult size at birth to full
size at 12 years, with a slight decline after 45. Speed follows growth, then
declines with age, low energy, low health and pain.

Mortality after 70% of the genome's lifespan follows a smooth hazard curve rather
than a hard cut-off, so there is a realistic tail of old-age deaths.

---

## 6. Learning

Reward-modulated Hebbian plasticity, applied once per tick:

```
eligibility[s] ← eligibility[s] × 0.92 + rate[pre] × rate[post]
Δw            = 8e-3 × plasticity_gene × valence × eligibility[s]
```

gated by `|valence| ≥ 0.1`, with weight decay `4e-6` and a clamp at ±1.8.

### Valence

Valence is the sign and magnitude of physiological change accumulated over a
0.5-second window:

```
valence = clamp(6 × Σ(Δenergy·1.6 + Δthirst·1.2 + Δpain·2.4 + Δhealth·1.4 + Δhunger·0.8))
```

The window matters. Per-tick homeostatic changes are ~5e-4, so a per-tick valence
is dominated by whatever constant term happens to be in the expression. An early
version included an unconditioned "social contact" bonus, which made valence
permanently positive; every synapse then grew to its clamp, motor drives reached
~17 instead of ~1, and every motor saturated.

### Gating

Neuromodulation *gates* plasticity. Without the threshold, the accumulated noise
of a lifetime of tiny valence fluctuations swamped the innate reflexes — the
founders learned their way out of being able to walk toward water.

### Homeostatic synaptic scaling

Every 120 ticks, each neuron's incoming weights are nudged so their total absolute
strength stays near its birth value (per-pass factor clamped to ±10%). This is the
standard biological counterweight to Hebbian potentiation, and it is what keeps
lifetime learning from running away while preserving the learned *pattern*.

---

## 7. Genetics

26 genes, defined once in `GENE_DEFS` with explicit bounds. That table is the
single source of truth for sampling, mutation, the genome editor and the
validation tests, which is what makes "mutations remain valid" a testable
invariant rather than a hope.

- **Crossover**: each gene is taken from one parent (60%) or blended (20%) or from
  the other (20%). `brainSeed` is inherited wholesale, which makes structural
  mutation a discrete, observable event rather than continuous drift.
- **Mutation**: per-gene probability 16%, perturbation drawn in *normalised* gene
  space so a 0.05 sigma means the same for body size (span 0.62) and lifespan
  (span 64). Symmetric — never biased toward fitness.
- **Structural mutation**: 2% per birth, re-wires the brain by perturbing the
  seed and nudging connectivity genes.

---

## 8. Reproduction

**Eligibility.** Adult, fertile, `libido > 0.18`, not pregnant, not in a mating,
not in refractory, health above 35, and driving the `mate` motor above 0.35.

**Pairing requires mutual participation.** Each tick, every unpaired eligible
individual whose mate motor is above threshold looks for the nearest eligible
opposite-sex partner within 2.4 tiles that is *also* driving its mate motor above
threshold. Both must be willing; there is no one-sided mating.

**Mating lasts 7 simulated seconds**, during which both partners are locked in
place and rendered with a rhythmic coupled animation — clearly recognisable as
mating, with no explicit anatomy.

**Conception** is probabilistic (75% × both parents' fertility) and can fail.
Gestation is 0.72 biological years (108 simulated seconds).

**Birth** creates a baby with the embryo genome, both parents recorded, generation
`max(mother, father) + 1`, an inheritance report attached, and a birth event in
the feed. The mother enters a 140-second recovery period.

---

## 9. Social memory

Per-individual records holding familiarity, attachment, valence, last encounter,
encounter count, mating count and genetic relatedness. Accumulation rates are slow
(4.5%/s familiarity, 1.2%/s attachment, ×1.8 for kin) so bonds form over a
lifetime and the observer can watch them build.

There is **no** hard-coded relationship type. Nothing in the simulation branches
on "is this my friend" or "is this my partner". The values feed the sensory
channels and the valence signal, and behaviour is whatever the network makes of
them. The observer infers relationships from the values.

Instantaneous events (being attacked, witnessing a death, a birth) apply their
deltas directly rather than being scaled by `dt`.

---

## 10. Ecology

**Plants** have no brains. Four species — grass, bush, tree, food pile — each with
a growth curve, biomass regeneration rate, lifespan, seed dispersal range and
probability. Seeds land on fertile tiles (grass and forest). Population is
therefore dynamic: food does not appear from nowhere. The god tool can still place
food directly.

**Carrion.** Every death — human or predator — spawns a food pile at the body, so
biomass re-enters the ecosystem rather than vanishing.

**Predators** use the *same* generic neural controller with different genome
ranges, a different sensor mapping (`food.*` wired to meat rather than plants) and
a different metabolism. There is no `if (humanNearby) chase()`. They are faster
than humans, hit harder, and starve if they cannot find prey.

V0 simplification: **predators reproduce parthenogenetically** — a well-fed adult
buds an offspring with a mutated genome when its `mate` motor fires. This is a
scope decision that does not change the neural architecture; sexual reproduction
for predators would reuse the human mating machinery.

---

## 11. Ecology balance

Getting the population dynamics right was the single hardest part of the project,
and the fix was almost entirely a matter of *measuring the right thing*.

### The diagnostic that mattered

The first hypothesis for a declining population was "they are not willing to
mate". The second was "willing adults never find each other". Those need opposite
fixes, so `World.matingDiagnostics` now reports both:

```
eligible-and-willing     : 1.51 humans/tick     ← willingness was fine
willing pair in range    : 0.0001 per tick      ← encounters were the bottleneck
```

Two willing adults came within range once per ten thousand ticks. They were all
foraging in different directions and simply never met.

### Mate search

The fix was to make a reproductively ready animal pay attention to other animals —
which is what real animals do:

- conspecific sensory salience is multiplied by `0.6 + libido`
- `human → approach` priors were raised from 0.12 to 0.5 (forward) and 0.1 to 0.45
  (turning), so a willing adult can actually walk over to a partner it can see
- the pairing radius is 5 tiles

Result: births went from **4.0 to 12.6 per simulated hour**, pairings from 7 to 16
per 80k ticks, conception success from 42% to 88%, and offspring per female from
1.5 to 3.5.

**A rejected idea, kept here because it is instructive.** Extending the conspecific
*sensing range* by libido (up to ~2.2× visual range) on the theory that a ready
animal advertises over a longer distance measured *worse*. With a strong
`human → approach` prior, a long-range social signal pulls animals away from food
and water: the seed that had been thriving collapsed to three survivors inside
twenty-five simulated minutes. Mate search is a salience effect, not a range
effect.

### Reproductive cycle

The second limiter was female availability: only ~0.35 willing females per tick
against ~2.0 willing males, because a female is unavailable while pregnant, while
recovering and during the mating refractory. Shortening recovery (140 → 85 ticks)
and gestation (0.72 → 0.55 biological years) raised the ceiling directly.

### Predator balance

Predators have no natural enemy and their only limit is prey, so their numbers set
how hard they press the humans. Four things had to change.

- **Flight.** This was the real bug, and it took a while to see because it is a
  *missing* behaviour rather than a wrong number. The threat priors were
  `threatFront → moveBack 0.55` and `→ sprint 0.35`. Because the read-out measures
  drive against an adapting baseline, 0.55 produced a command of about 0.17: a
  frightened human backed away at roughly 0.5 tiles/s while a predator closed at
  3.4. Flight was effectively disabled — humans stood still and were eaten. The
  weights are now 1.9 (retreat) and 1.5 (sprint), giving a retreat speed of about
  4.8 tiles/s, faster than a predator. Being caught now means being *cornered*.

- **Damage per bite.** At one bite every 4 ticks for ~25 damage, a predator killed
  a human in well under a second, and three predators erased a village of eight in
  three simulated minutes — ten of twelve deaths were predation. Bites now land
  every 14 ticks, so a kill takes roughly twenty seconds of sustained contact.

  A caution for anyone tuning this: `attackPower` is a 0.2–30 gene with a typical
  value near **7**, not near 100. A first attempt to soften predation dropped the
  damage scale to 0.12, which made a bite worth under one point and turned
  predators into harmless scenery. `npm run predator` measures the actual kill
  time rather than trusting the constant.

- **Reproduction rate.** At a 900-tick cooldown three predators became six within
  a simulated hour, overshot the prey base and drove the village to a single
  female. The cooldown is now 3000 ticks with a higher energy requirement.

- **Where they are released.** Predators used to spawn uniformly at random across
  a 176×128 map, which is almost always tens of tiles from the only people in the
  world; two predators released that way both starved without ever meeting a
  human. They now appear in the wilderness 16–34 tiles from the founding village.

Predator speed is 3.4 tiles/s: faster than a walking human (3.05), slower than a
sprinting one (up to 5.5). Flight works.

### Current measured behaviour

Use `npm run balance` to measure a batch of seeds, because a single run tells you
almost nothing: with eight founders, genetic drift and plain luck dominate.

```bash
npm run balance
npm run balance -- --seeds eden,orion,vela --ticks 150000
```

Outcomes still vary by seed — some worlds grow tenfold in two simulated hours,
others decline — which is the honest behaviour of a small founder population, and
is exactly the kind of situation the god tools exist for. The README records the
current distribution.
