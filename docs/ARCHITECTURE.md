# EDEN//0 — Architecture

This document explains how the pieces fit together, why the boundaries are where
they are, and what has to stay true for the project to keep working.

---

## 1. Layers

```
src/
├── shared/          Types, constants, worker protocol, name generation
├── simulation/      The world. No DOM, no PixiJS, no React.
│   ├── brain/       LIF network, channels, contribution trace
│   ├── genetics/    Genome definition, crossover, mutation
│   ├── entities/    Human, predator, plant, and the SimWorld interface
│   ├── environment/ Terrain generation, climate, day/night
│   ├── memory/      Per-individual social memory
│   ├── spatial/     Uniform spatial hash grid
│   ├── persistence/ Save envelope + local storage
│   ├── rng.ts       Deterministic PRNG
│   └── world.ts     The tick loop and everything above it
├── worker/          The simulation worker and its main-thread client
├── render/          PixiJS world renderer and procedural sprites
├── components/      React UI
├── app/             Screen composition
└── ui/              Store bridge between worker and React
```

The dependency rule is one-directional: `components` and `render` may import from
`shared` and from `worker/client`, but **never** from `simulation` internals —
except for a small number of read-only constants (channel names, plant profiles,
terrain tile types) that the renderer needs for colour and layout.

`simulation/` imports nothing from `render/`, `components/` or `worker/`.

---

## 2. Threading

There are exactly two threads.

**The main thread** runs React, the PixiJS renderer, and the input handling. It
never executes a simulation tick.

**The simulation worker** owns the `World` instance and runs the tick loop.

They communicate through a typed message protocol (`src/shared/protocol.ts`):

```
main → worker   genesis · setSpeed · stepOnce · select · god · serialize · restore
worker → main   ready · snapshot · detail · brain · explain · genealogy · serialized
```

Snapshots are transferred, not copied: the worker builds typed arrays
(`Int32Array` ids, `Float32Array` entity data, `Uint8Array` metadata) and hands
over their buffers.

### Two notification channels

`SimClient` deliberately exposes two separate subscription paths:

- `onEntities` fires on every snapshot and is consumed **directly** by the PixiJS
  renderer. React is not involved.
- `subscribe` fires at most ~10 times per second and drives the React UI.

This is what lets the world animate smoothly at frame rate while the inspector
and statistics panels update at a readable pace without re-rendering the tree 18
times a second.

---

## 3. The timing model

The simulation advances in fixed steps.

```
SIM_HZ  = 20          ticks per simulated second
DT      = 1 / 20      seconds per tick
```

A speed setting changes **how many fixed ticks are executed per unit of
wall-clock time**, never the size of the step:

```
accumulator += elapsed_seconds × SIM_HZ × speed
ticks = min(floor(accumulator), budget_for_speed)
```

This is the difference between "run the same simulation faster" and "run a
different, unstable simulation". Scaling `dt` would change the neural solver's
numerical behaviour, the collision response and the integration error — the world
would be a different world at ×100. Running more fixed ticks keeps every speed
numerically identical.

**MAX mode** runs ticks in a wall-clock-budgeted burst (12 ms), checks the clock
every 16 ticks, and then yields to the message queue so that "pause" is still
responsive. Snapshot cadence drops from 18/s to 3/s in MAX mode, and the renderer
keeps interpolating from the last snapshot.

---

## 4. Determinism

This is a hard requirement, not a nice-to-have.

- All randomness flows through `Rng` (sfc32 seeded via splitmix32). `Math.random()`
  is never called inside `simulation/`.
- Every entity has its own forked stream, and those streams are serialised.
- Iteration is always in stable array order; the spatial grid is rebuilt from the
  arrays at the start of every tick and returns buckets in insertion order.
- The world's PRNG state is restored **last** during deserialisation, because
  building entities forks from it.
- The brain's topology and *birth* weights are derived purely from
  `genome.brainSeed`, so they never depend on the caller's stream position.

`tests/determinism.test.ts` asserts that two worlds with the same seed produce a
byte-identical fingerprint after 600 ticks, that wall-clock time does not leak
into the simulation, and that a save/load round trip is exact.

The fingerprint covers the PRNG state, the climate, every entity's position,
physiology, memory size, pregnancy progress and a sample of learned weights.

---

## 5. The `SimWorld` boundary

Entities do not receive the concrete `World`. They receive a `SimWorld` interface
(`src/simulation/entities/context.ts`) exposing exactly what they are allowed to
touch:

```ts
interface SimWorld {
  tick; simTime; dt; terrain; climate;
  humans: Human[]; predators: Predator[]; plants: Plant[];
  random(): number;
  getHuman(id); getPredator(id);
  queryHumans/queryPredators/queryPlants(x, y, radius, out);
  ambientTemperatureAt(x, y);
  consumePlant(index, amount);
  damageHuman(target, amount, reason, attackerId);
  relatedness(a, b);
  emitEvent(kind, text, entityIds);
}
```

Two reasons this matters:

1. **It keeps the dependency graph acyclic.** `Human` imports the interface;
   `World` implements it. No circular runtime imports.
2. **It is the Rust migration seam.** A Rust-backed world only has to satisfy this
   contract. `src-tauri/src/lib.rs` already exposes a `sim_backend_info` command
   to establish the shape of that boundary.

Entity indices returned by the `query*` methods index directly into the entity
arrays. Those arrays are only compacted at the *end* of a tick, so indices stay
valid for the whole duration of one tick.

---

## 6. Rendering

PixiJS, with three efficiency decisions that matter:

**Terrain and vegetation are canvases, not sprites.** The terrain is painted once
into a 176×128 canvas (one pixel per tile) and uploaded as a nearest-neighbour
texture. The vegetation layer is a second canvas of the same size, redrawn about
four times a second from the entity snapshot. Tens of thousands of tiles and
plants therefore cost two draw calls.

**Entities get real pooled sprites** because they need articulation: a humanoid
rig of torso, head, two arms and two legs, animated from the entity's current
action, locomotion speed (derived from frame-to-frame displacement) and flags.

**The renderer never touches React.** It subscribes to `onEntities` and paints in
the Pixi ticker.

The camera supports drag-to-pan, wheel zoom, double-click reset and follow-selected,
and exposes `screenToWorld` so god tools can target the world by clicking.

---

## 7. Persistence

A save is a versioned envelope:

```json
{
  "format": "eden0-save",
  "version": 1,
  "savedAt": "2026-09-21T16:00:00.000Z",
  "seed": "eden",
  "tick": 12345,
  "simTime": 617.25,
  "payload": { "...": "world.serialize()" }
}
```

The envelope exists so a future schema change can be detected and migrated instead
of silently producing a broken world.

**What is stored.** PRNG state, climate, tick, every entity's full dynamic state
(including cached sensor state, cooldowns and cached water direction), learned
weights, eligibility traces, the slow network variables, social memory, genealogy,
pregnancy state, the event log, and the name registry.

**What is not.** Neural *topology* and *birth* weights — both are regenerated
exactly from the genome, which is why the payload stays a reasonable size and why
`weightDrift` survives a round trip.

Getting this exactly right took several iterations, and each omission produced a
subtly divergent world: the eligibility traces, the spike flags, the cached water
direction, the bite/attack cooldowns, the valence accumulator, and even the
scalar `speed` (which feeds back into energy expenditure) all had to be persisted
before `tests/persistence.test.ts` went green.

**Where it lives.** `localStorage` for autosave and the manual slot — this
persists across app restarts inside the Tauri webview. Export/import use a Blob
download and a file input, so no additional Tauri plugins or filesystem
permissions are required.

---

## 8. Performance notes

Measured on the development machine (Apple silicon, single worker thread):

- ~6,000–11,000 ticks/s headless with 8–10 humans, ~4,000 plants.
- One tick with 10 humans costs roughly 0.08 ms; the neural update dominates.
- Snapshot size scales with entity count: ~48 bytes per entity.

Techniques in use: spatial hashing for neighbour queries, CSR adjacency for
synapse traversal, typed arrays throughout the hot loops, preallocated scratch
buffers (no per-tick allocation in the neural update), sprite pooling, snapshot
throttling, and two canvas textures instead of per-tile sprites.

The developer panel (`Cmd+Shift+D`) reports TPS, per-tick cost, brain cost,
worker latency and snapshot size so regressions are visible immediately.
