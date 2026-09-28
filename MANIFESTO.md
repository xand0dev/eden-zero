# MANIFESTO

_Lab 42 — Life, The Universe, And Everything. Path A: the synthesis._

---

## The Question

**If you write down every rule a creature follows, and none of the rules say "be alive" — is what comes out alive, or only a machine that looks like one?**

## The Premise

Every artificial-life demo I had seen cheated in the same place. The creatures
"decided" to eat because someone wrote `if (hungry) findFood()`. That is not a
world asking a question; it is the author's assumptions wearing a lab coat. The
moment a behaviour is written down, you have decided it in advance — and the
interesting thing about life is that nobody decided it.

So EDEN//0 is a world where the question can be asked honestly. Eight founders
wake up beside a river with a genome, a body that gets hungry, thirsty, cold and
tired, and a 341-neuron spiking brain wired from that genome. Everything they do —
walk, eat, drink, rest, court, fell trees, build huts, sow fields, dig canals — is
the motor read-out of that brain. Their children inherit a recombined, mutated
genome, and their brains keep rewriting themselves through a reward-modulated
learning rule driven by the body's own physiology.

What already exists: cellular automata that look alive but have no bodies; games
with scripted villagers; neural-network toys that learn but never die. What was
missing, for me, was a place where all three meet — bodies, heredity and learning —
and an observatory that lets you open any creature and see *why* it just did what
it did, without lying about how certain that answer is.

## The Stack

- **TypeScript, strict, no ML library.** The brain is a sparse leaky
  integrate-and-fire network written from primitives: 64 sensory channels,
  80 local, 160 recurrent and 20 neuromodulatory neurons, 17 motors.
- **A pure simulation core.** No DOM, no Node dependency. The same `World` class
  runs in a Web Worker in the browser, headless in Node for the test and balance
  harnesses, and behind a hand-written RFC 6455 WebSocket server for shared worlds.
  Deterministic: same seed, same interventions, byte-identical history.
- **React + PixiJS observatory.** A top-down living diorama; a live brain view
  that draws the spikes that actually fired, the reward signal the brain learns
  from, and how far each synapse has moved since birth.
- **Tauri** for a desktop build, **Docker** for the shared server, **Vitest** and
  headless acceptance/balance harnesses for evidence.

Which earlier labs it fuses, and what the combination does that none of them can
do alone, is in [docs/SUBMISSION.md](docs/SUBMISSION.md).

## The Constraints

What I will **not** do:

1. **No written behaviour.** No `findFood()`, no `flee()`, no behaviour tree, state
   machine, utility scorer or scripted sequence. Innate reflexes exist only as
   ordinary plastic synapses that learning is free to rewrite.
2. **No lying observatory.** "Why did it do that?" is labelled, in the UI itself,
   as an approximate activation trace, not a causal proof. The brain view says
   which impulses are recorded spikes and which are graded sensory input.
3. **No score, no fail state, no god game.** The tools exist to ask questions, not
   to win.
4. **No fudged evidence.** Balance claims come from multi-seed headless runs whose
   commands and numbers are logged; the failures stay in the record.
5. **No claim that it is alive.** It is a system where the question is unusually
   well posed. That is all I will say about it.

## What building it taught me

**Measure the derived quantity.** I assumed a gene called `attackPower` was around
100. It is 0.2–30. I softened a bite by a factor of two and made predators harmless,
and only found out by writing a probe that measures kill time.

**A missing behaviour looks exactly like a wrong number.** Predators kept wiping out
villages. The flight reflex was too weak to clear its own action gate — a threat
weight of 0.55 produced a motor command of 0.17. Flight was disabled and nobody
noticed, because "0.55" looks like a reasonable number.

**Diagnose before you fix.** When villages died out I could not edit a rule —
there was no rule. So I built probes that measure the reproductive pipeline, and
they found a canal-digging cost charged 24× too often: the pain of it was, through
the learning rule, slowly erasing the innate mating reflex.

**Passing tests prove nothing about a renderer.** The world once rendered fourteen
times too large with every test green. A renderer is not done until you have seen
it.

## The Answer

> **42**

The shipped world, and the observatory to look into it. The failures, with their
measurements, are in [docs/SIMULATION.md](docs/SIMULATION.md) and
[docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md); what is still broken is in
[docs/RETRO.md](docs/RETRO.md).

**Don't Panic.**
