# Retrospective

_Lab 42 deliverable: what worked, what didn't, what I'd do differently, and which
prior labs flowed into this one._

---

## What worked

**The one constraint.** "No behaviour is written down" made everything harder and
everything better. Because there was no rule to edit, every problem forced a
measurement. Almost every good engineering decision in the repository came from
that pressure.

**A pure, deterministic core.** `World` has no DOM and no Node dependency, and
the same seed plus the same interventions gives a byte-identical history. That
single decision paid for itself many times: the same class runs in a Web Worker,
in the headless harnesses, and behind the WebSocket server; save/load is tested by
replaying and comparing; and every balance experiment could be rerun on identical
seeds.

**Diagnostics before fixes.** The mating diagnostic that separated "nobody is
willing" from "willing adults never meet", the predator kill-time probe, and later
a population probe that records sensor, motor and brain-weight distributions: each
turned a week of guessing into an afternoon. The clearest example is the canal:
the probe showed the innate `libido → mate` weight falling from 0.87 to about zero
in villages that dug canals and staying near 0.5 in the same world with digging
forbidden. The cause was a digging cost charged every tick at the rate of a full
swing — 24× too much — and the valence crash that followed was unlearning the
mating reflex through the brain's own plasticity rule.

**An observatory that under-claims.** The "why did it do that?" trace, and later
the live brain view, both say in the UI what they are and are not. That honesty
cost nothing and makes every screenshot defensible.

**Looking at the renderer.** Driving the real build in a headless browser and
reading the screenshots found things no test would: a world drawn 14× too large, a
camera centred at a quarter of the screen on every Retina display, canals joining
into a mesh of triangles instead of a channel.

## What didn't

**Population viability.** It is still the weakest part. On an 8-seed, 200 000-tick
baseline the outcome is bimodal: some worlds die out, some grow without bound.
Part of the old viability turned out to rest on a bug: action gates ignored their
own reach, so a human could eat from a bush sixteen tiles away and a predator could
strike from as far. Fixing that was correct and made small villages die faster.
The remaining cause I have measured is dispersal — adults drifting out of sight of
each other — and the fix for it is designed but not yet measured on a full batch.
Acceptance check #29 therefore still fails, and CI is red on it.

**Performance at scale.** A world that thrives becomes slow: 689 people cost
~16 ms per tick. There is no carrying capacity below the hard cap, because food is
effectively unlimited. That is both a balance problem and a performance problem.

**Save size.** Every person carries a full brain; a 58-person save is 10 MB and no
longer fits in `localStorage`, so autosave quietly stops working in grown worlds.

**Scope.** The roadmap's settlement stages and crises (camp → village → town,
drought, cold, crop disease) are not built. I chose to fix the foundations and the
observatory first.

## What I'd do differently

1. **Build the balance harness on day one**, with lifetime counters instead of
   reading a capped event log, and multi-seed runs as the only accepted evidence.
2. **Make the spatial query contract impossible to misuse.** The grid returns
   everything in the cells a circle overlaps; a dozen call sites forgot to filter
   by distance. A `within(radius)` helper from the start would have prevented a
   whole class of bugs.
3. **Size everything from constants.** Hardcoded 12s, 32s and 256s broke the
   predator brain, the acceptance script and three probes when the brain grew.
4. **Decide the visual scale early.** People were drawn 3.2× their world size and
   rotated huts were drawn from the front; fixing the art direction late meant
   redoing every model at once.
5. **Keep experiments in separate copies of the code** so a long batch never picks
   up a half-finished edit — and never run so many at once that the machine is
   unusable.

## Which prior labs flowed into this one

| Lab | What it contributed |
|---|---|
| 14 — Cellular Automata | The world as a grid of interacting agents; emergent population dynamics |
| 13 — Physics Sandbox | Continuous physiology: metabolism, thermoregulation, fatigue, injury |
| 32 — Neural Net From Scratch | The spiking network, the learning rule, the motor read-out — no ML library |
| 22 — SPA Frontend | The React + PixiJS observatory |
| 23 / 27 — Real-time multiplayer | The authoritative server, hand-written RFC 6455 WebSocket, binary snapshots, a two-house competitive mode |
| JS course, labs 1–8 | Event loop and fixed timestep, classes, async RPC, streams, interpolation, TypeScript, profiling and tests, Docker and CI |

The unlock was Lab 32: once the network was written from primitives, "don't
script behaviour" stopped being a slogan and became an architecture.

## How it was built

AI coding assistants were used throughout, as the program allows — for
implementation, for the diagnostic harnesses and for the visual rework. The bar I
hold myself to is the program's: I should be able to explain and change any line
live. [DEFENSE.md](DEFENSE.md) lists the parts I have prepared to walk through, and
the parts I would still have to look up.

## What's next

Measure the dispersal fix on the same seeds, get acceptance #29 green, add a real
carrying capacity, and then build settlement stages and crises. Publish a web
build so someone other than me can use it. I intend to keep maintaining it.
