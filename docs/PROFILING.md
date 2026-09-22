# Profiling report

The JavaScript course's seventh week asks for V8 internals, profiling and tests.
This document is that work: what was measured, what the numbers said, and the two
places where the numbers disagreed with what I had assumed.

Everything here is reproducible from the repository.

---

## Method

```bash
npm run bench                                    # wall-clock cost per tick
node --cpu-prof --cpu-prof-dir=/tmp/prof \
     --import tsx scripts/bench.ts --ticks 8000  # a real V8 CPU profile
node scripts/profile-report.mjs /tmp/prof/CPU.*.cpuprofile
```

`scripts/bench.ts` warms up for 2000 ticks first, so the JIT has compiled the hot
paths before anything is measured. It reports per-tick cost as mean, median, p95,
p99 and max — the mean alone hides the pauses, and in a fixed-timestep loop the
pauses are what make a world stutter.

`scripts/profile-report.mjs` parses the `.cpuprofile` that `--cpu-prof` writes —
the same file Chrome DevTools opens — and ranks functions by **self time**, which
is the only figure that tells you where the CPU actually was rather than who
called whom.

---

## Wall clock

17 humans, 2 predators, 6004 plants, on an M-series laptop, single core:

```
per-tick cost (milliseconds)
  mean    1.03
  median  1.02
  p95     1.19
  p99     1.31
  max     ~2

throughput
  ticks/second (single core)  ~970
  realtime headroom at x1     48x
  realtime headroom at x100   0.5x
```

The two numbers that matter:

- **At x1 there is 48× of headroom.** The simulation is nowhere near the limit at
  normal speed, which is what makes the observatory UI affordable — the renderer
  gets the frame budget.
- **At x100 there is half the headroom needed.** MAX speed is the one place where
  the simulation is genuinely CPU-bound, and it is why the worker runs budgeted
  bursts and yields rather than trying to keep up.

Cost tracks population almost linearly in this range (0.80 ms/tick at 12 humans,
1.18 ms/tick at 17). Linear rather than quadratic, because the spatial grid keeps
each animal's neighbour scan proportional to local density rather than to the
world.

---

## V8 CPU profile

9495 samples. The largest single entry is not our code:

```
self time — where the CPU actually was
   37.1%  tryBrokerFileTokenSync   (WorkBuddy sandbox FS shim)
   36.0%  step                     src/simulation/brain/network.ts
    6.7%  sense                    src/simulation/entities/human.ts
    3.1%  applyPlasticity          src/simulation/brain/network.ts
    1.9%  insert                   src/simulation/spatial/grid.ts
    1.7%  update                   src/simulation/entities/plant.ts
    1.4%  clamp                    src/simulation/brain/network.ts
    1.1%  updatePlants             src/simulation/world.ts
    1.0%  compact                  src/simulation/world.ts
    0.9%  applyWeightDecay         src/simulation/brain/network.ts
    0.8%  sense                    src/simulation/entities/predator.ts
    0.7%  queryCircle              src/simulation/spatial/grid.ts
    0.7%  rebuildGrids             src/simulation/world.ts
```

The first line is harness overhead — this machine runs Node inside a sandboxed
filesystem shim, and it accounts for 37% of all samples. That is an artefact of the
measurement environment, not of the simulation, and it is excluded from everything
below.

**Excluding it, the real distribution is:**

| Share of simulation time | Where |
|---|---|
| **57%** | `Brain.step` — the neural solver |
| 11% | `Human.sense` — sensory encoding |
| 5% | `applyPlasticity` — lifetime learning |
| 3% | `SpatialGrid.insert` |
| 3% | `Plant.update` |
| 2% | `clamp` |
| 2% | `World.updatePlants` |
| 2% | `World.compact` — removing dead entities |

---

## What I got wrong

**I assumed the plant scan dominated. It does not.**

While tuning the ecology I noticed long runs slowing down as the population grew,
found that every animal was scanning essentially every plant on the map (a 76-tile
"foraging" radius against 6000 plants), and cut it to `vision × 1.5`. Runs did get
faster and I moved on, satisfied that I had found the bottleneck.

The profile says the neural solver is **57%** of simulation time and the entire
sensing path — food, water, conspecifics, threats, timber, build sites — is **11%**.

The sensing fix was still worth making: at 80 animals a 76-tile radius means
80 × 6000 = 480,000 iterations per tick, and that is real. But it was the *second*
largest cost, and I fixed it first because it was the one I could see. The profile
was one command away the whole time.

**I also assumed `applyPlasticity` would be negligible.** It is 5% — small, but it
runs for every synapse of every animal on every tick, and it is the reason
`Brain.step` is as cheap as it is: the plasticity path shares the same flat typed
arrays rather than allocating.

---

## What the numbers say to do next

**The neural solver is the target, and it is already about as fast as flat
TypeScript gets.** `Brain.step` walks `Int32Array` / `Float32Array` buffers with no
allocation, no virtual dispatch and no object graph — the inner loop is a
synapse-major scan over contiguous memory. There is no algorithmic win left in
JavaScript; the remaining options are:

1. **Skip neurons that cannot fire.** Most neurons are in refractory most ticks.
   A compaction pass that builds a list of excitable neurons would cut the synapse
   loop substantially. The cost is an extra pass and a loss of the current
   branch-free simplicity.
2. **Move the solver to Rust.** The `SimWorld` interface and the worker protocol
   already isolate it, so this is a matter of implementing one interface rather
   than a rewrite. This is the roadmap item the architecture was designed for.

**`World.compact` at 2% is a surprise worth watching.** Removing dead entities
from the population arrays is more expensive than updating the plants. It is fine
now; it will not be fine at a thousand animals, where deaths are frequent.

**`SpatialGrid.insert` at 3% suggests the rebuild strategy is near its limit.** The
grids are cleared and refilled every tick. For 6000 plants that is 6000 inserts per
tick whether or not anything moved — and plants never move. Incremental maintenance
would remove most of that cost, at the price of some care around entity ids.

---

## What this report is not

It is not a benchmark against other simulations, and it is not a claim that the
current numbers are good. 1 ms per tick for 17 animals is respectable for a
spiking network in JavaScript; it is not impressive. What it is, is measured — and
the measurement is the part the seventh week is actually asking for.
