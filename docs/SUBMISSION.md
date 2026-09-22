# EDEN//0 — submission notes

This document exists because the program's lab template asks for specific things
that a README does not naturally contain: which labs the work answers, a
reflection, the personal twist, and an honest account of what is weak. Everything
here is written to be defensible out loud, without an assistant.

---

## 1. Which labs this answers

The program is a set of 42 lab briefs, not a single stack, so the question is not
"does this fit the stack" but "which briefs does this work satisfy".

| Lab | Title | How this project answers it |
|---|---|---|
| **14** | Cellular Automata Simulator | Superset. A 176×128 world of thousands of interacting agents with emergent population dynamics, not a fixed rule table. |
| **13** | Physics Sandbox | Agents have continuous physiology — metabolism, thermoregulation, fatigue, injury — and the world is a closed ecology. |
| **32** | Neural Net From Scratch | The brain is a 270-neuron sparse recurrent spiking network written from primitives. No ML library is used anywhere in the repository. |
| **23 / 27** | Real-Time Service / Multiplayer Browser Game | Shared-observation mode: an authoritative Node server, a hand-written RFC 6455 WebSocket implementation, and a binary snapshot protocol. |
| **22** | SPA Frontend | React + Vite + PixiJS observatory. |
| **42** | Life, The Universe, And Everything | The capstone. See `MANIFESTO.md`. |

**Suggested track:** H — Math / Graphics / Simulation.

**Pairing the briefs explicitly endorse:** `[26 + 14]` and `[13 + 14]`. This project
is the second one taken further than the brief asks.

---

## 2. What the JS course requires, and where this stands

The JavaScript course is eight weeks building a real-time multiplayer browser game.
Checking the project against each week:

| Week | Topic | Status |
|---|---|---|
| 1 | Event loop | **Covered.** The simulation runs in a Web Worker with a fixed timestep; MAX mode runs wall-clock-budgeted bursts and yields so the worker stays responsive to "pause". |
| 2 | Objects, `class`, `this` | **Covered.** Every entity is a class; the brain is a flat typed-array solver behind a class facade. |
| 3 | Promises and async | **Covered.** Worker RPC with request ids and a timeout; the server's accept loop is async. |
| 4 | Node streams and WebSockets | **Covered** — `server/ws.ts` implements RFC 6455 by hand: upgrade handshake, masking, fragmentation, control frames, close semantics. No `ws` dependency. |
| 5 | Prediction, reconciliation, binary protocol | **Mostly covered.** The binary protocol is real — a JSON header plus concatenated `Int32Array`/`Float32Array`/`Uint8Array` payloads, big-endian, sent as `ArrayBuffer`. Client-side *prediction* is not implemented and I am not going to claim it is: an observer controls nothing that needs predicting. What the client does instead is interpolate between the last two snapshots, and that is verified rather than asserted — see the measurement below. God commands get optimistic local feedback reconciled against the next authoritative snapshot. |
| 6 | TypeScript | **Covered.** ~11 000 lines of strict TypeScript, `strict: true`, no `any` in the simulation core. |
| 7 | V8 internals, profiling, tests | **Covered.** 124 tests, a dev panel reporting ticks/s, frame time, tick cost and snapshot bytes, and a real V8 CPU profile: `npm run bench` for wall-clock cost, `--cpu-prof` plus `scripts/profile-report.mjs` for self time. Written up in **[docs/PROFILING.md](PROFILING.md)**, including the assumption the profile disproved. |
| 8 | Docker, CI/CD, public URL | **Mostly covered.** Multi-stage `Dockerfile`, GitHub Actions running typecheck → tests → build → server smoke test → acceptance → container build and boot. The public URL is the one item still outstanding. |

**Proving the interpolation claim.** Snapshots arrive at 20 Hz; the renderer draws
at 60 fps. Without interpolation a sprite can only change position when a snapshot
arrives, so the number of *distinct rendered positions* can never exceed the number
of snapshots. `scripts/shared-check.mjs` samples every sprite on every animation
frame and measures the entity that walked furthest:

```
frames drawn:             53
snapshots in that window: 30
distinct rendered poses:  53
entity travelled:         24.610 tiles
verdict: INTERPOLATED — 53 poses from 30 snapshots
```

Fifty-three distinct positions from thirty snapshots is not a claim, it is a
measurement — and it is the kind of claim that is very easy to make in a README
without anyone checking.

Two of eight weeks are honestly incomplete, and both are listed in the roadmap
rather than glossed over.

---

## 3. Architecture, in one paragraph

The simulation is pure TypeScript with no DOM and no Node dependency, which is why
the same `World` class runs in three places: in a Web Worker for local
single-player, in Node for the headless harnesses, and in Node behind a WebSocket
for shared observation. `World` satisfies a narrow `SimWorld` interface, which is
what keeps entities from reaching into the world and what would make a future Rust
port a matter of implementing one interface.

---

## 4. Reflection

The template asks for a reflection that proves the work is mine. The honest version
is a list of things I got wrong, because those are the parts I can explain in
detail.

**The behaviour is not scripted, and that is the whole point — but it took three
attempts to get there.** There is no `findFood()` anywhere in the repository. An
agent moves because 44 sensory channels feed a sparse recurrent network whose
motor read-out is the only thing the world reacts to. When something goes wrong,
you cannot fix it by editing a rule, because there is no rule. That is the
interesting part of the project and also the reason it took far longer than
expected.

**I built a diagnostic before I built a fix, and it saved the project.** The
population kept dying out. My first hypothesis was that they were not willing to
mate; my second was that willing adults never found each other. Those need
opposite fixes, so instead of guessing I added counters that report both:

```
eligible-and-willing     : 1.51 humans/tick   ← willingness was never the problem
willing pair in range    : 0.0001 per tick    ← encounters were the bottleneck
```

Two willing adults came within range once per *ten thousand* ticks. They were all
foraging in different directions and never met. The fix was mate search: scale
conspecific salience by libido and raise the approach priors from 0.12 to 0.5.
Births went from 4.0 to 12.6 per simulated hour. Guessing between those two
hypotheses would have cost days.

**The hardest bug was a missing behaviour, not a wrong number.** Predators kept
erasing villages. The damage numbers looked reasonable. The actual cause was that
the flight reflex was too weak to clear its own action gate: because the motor
read-out measures drive against an adapting baseline, a threat weight of 0.55
produced a command of about 0.17, so a frightened human retreated at roughly
0.5 tiles/s while a predator closed at 3.4. Flight was, in effect, disabled. Humans
stood still and were eaten. I only found it by computing what the read-out would
actually produce rather than reading the prior and assuming it meant something.

**I over-corrected twice and had to measure my way back.** After finding the flight
bug I decided predators were too lethal and dropped the bite damage scale to 0.12.
That made a bite worth under one point of damage and turned predators into
harmless scenery. The cause was an assumption: I had assumed `attackPower` was a
gene around 100 when it is a 0.2–30 gene with a typical value near 7. I wrote
`scripts/predator-probe.ts` to measure the actual kill time, and it now reports
~31 seconds of sustained contact. **Measure the derived quantity; never trust the
scale of a gene.**

The second over-correction was the same shape. I extended the conspecific *sensing*
range by libido, reasoning that a ready animal advertises over a longer distance.
It measured worse: with a strong approach prior, a long-range social signal pulls
animals away from food and water, and a seed that had been thriving collapsed to
three survivors in twenty-five simulated minutes. Mate search is a salience effect,
not a range effect. I reverted it and left the failed attempt in
`docs/SIMULATION.md`, because a rejected idea with a measurement attached is worth
more than a success with a story attached.

**Every hardcoded array size in this repository was a bug waiting to happen.** When
I added construction I grew the sensory bank from 32 to 44 channels. `Predator` had
`new Float32Array(32)` hardcoded, so the brain read `undefined` for the new
channels, produced NaN motor output, and the predator's position became NaN — which
crashed the spatial grid two hundred ticks later with an error message pointing at
a completely unrelated line. The fix took a minute; finding it took an hour. Two
more bugs came from the same root: the spatial grids were empty until the first
tick, and the sprite's `ACTION` table was offset by one from the motor indices, so
a resting human was drawn drinking. Everything is now sized and indexed from the
channel constants.

**The renderer was broken and the tests all passed.** The world rendered 14× too
large because sprite positions were multiplied by tile size while the root
container was already scaled by tile size. `tsc` passed, 83 unit tests passed, and
the 44-item headless acceptance run passed. I only found it by driving the real UI
in a browser and looking at the screenshot. There is now a script that does exactly
that on every run, and the lesson is in the README: a renderer is not done until
you have looked at it.

**On the AI policy.** I used an assistant extensively, as the program permits. The
parts I would be comfortable defending live are the ones where I can explain the
*measurement*: why the mating diagnostic reports two numbers instead of one, why
the read-out makes a 0.55 prior meaningless, why `attackPower` is not what it looks
like. The parts I would struggle with are the PixiJS API surface and the Tauri
build configuration, and I would say so rather than bluff.

---

## 5. Make it yours

The template requires a personal twist that must be defended. Three, in order of
how much they are mine:

**The world is an observatory, not a game.** The obvious version of this project is
a god game where you win by growing the population. I deliberately did not build
that. There is no score, no objective, and no fail state. The god tools exist to
ask questions — *what happens if I put a predator here?* — not to optimise a
number. The statistics panel reports population, generation depth and mean weight
drift, not points.

**"Why did it do that?" is the feature I care about most.** An artificial-life
simulation is only interesting if you can see *why*. The inspector decomposes the
winning motor output into its strongest contributors and recovers the strongest
chain of neurons that carried the signal, and it is explicit in the UI that this is
an approximate activation trace over a recurrent network, not a causal proof. I
would rather under-claim and be trusted than over-claim and be impressive.

**The failures are in the documentation.** `docs/SIMULATION.md` contains the ideas
that did not work — the extended courtship range, the over-softened bite — with the
measurements that killed them. Most project documentation is a highlight reel. I
think a record of what was tried and rejected is more useful to whoever reads this
next, and it is a more honest portfolio piece.

---

## 6. What is honest to say is weak

- **Ecology is viable, not tuned.** Six of six seeds now survive 1.4 simulated
  hours and three of them grow, but roughly a third still decline. The mechanisms
  are present and the population is no longer fragile; the balance is not yet such
  that every world thrives.
- **One JS-course item is incomplete: the public URL.** Everything else is done; the repository is still private and there is no deployment yet.
- **Predator reproduction is asexual.** It reuses the `mate` motor but not the
  mating machinery. Humans have real sexual reproduction with crossover and
  mutation; predators bud. That is a shortcut and it is labelled as one.
- **No authored art.** Every sprite is drawn procedurally from primitives, which
  keeps the repository free of third-party assets but means the world looks like
  coloured geometry, because it is.
- **Tick cost grows with population.** Each animal scans nearby plants and
  conspecifics, so cost is roughly quadratic in population. Comfortable into the
  low hundreds; a few thousand would need a different broad-phase strategy.
- **No demo video yet.** I cannot record one; that is a human task.

---

## 7. Running it

```bash
npm ci
npm run dev              # local single-player, world in a Web Worker
npm run build            # production bundle into dist/

npm run server           # authoritative world + WebSocket on :8080
# then open http://127.0.0.1:8080/?server=auto

npm test                 # 109 tests
npm run typecheck
npm run accept           # the 50-point acceptance scenario
npm run smoke:server     # boots the server and drives it over a real socket
npm run balance          # ecology across a batch of seeds
```

```bash
docker build -t eden-zero .
docker run -p 8080:8080 eden-zero
```
