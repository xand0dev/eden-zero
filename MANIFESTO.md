# MANIFESTO.md

_Lab 42 — Life, The Universe, And Everything._

---

## The question I picked

The capstone is the one lab with no acceptance criteria. The only condition is
*shipped*. Everything before it is someone else's question; this one is supposed to
be mine.

Mine is this: **if you write down every rule a creature follows and none of the
rules say "be alive", is what comes out alive, or is it only a machine that looks
like one?**

I do not have an answer. I have a world where the question can at least be asked
honestly, and a strong opinion about how not to cheat while asking it.

## The one rule I refused to break

**No behaviour is written down.**

There is no `findFood()`. There is no `flee()`. There is no state machine, no
behaviour tree, no utility scorer, no scripted sequence. An inhabitant eats because
44 sensory channels feed a sparse recurrent network of 270 spiking neurons, and the
motor read-out of that network is the only thing the world reacts to.

This is not a technical flourish. It is the entire point. The moment I write
`if (hungry) seekFood()`, the world stops being a question and becomes a
demonstration of my own assumptions wearing a lab coat. Every behaviour I hardcode
is a behaviour I have decided in advance, and the interesting thing about life is
that nobody decided it.

It also made the project much harder, and I would do it again. When the population
died out, I could not fix it by editing a rule, because there was no rule. I had to
build a diagnostic, measure where the pipeline actually broke, and fix the *world*
rather than the behaviour. That constraint is what produced the best engineering in
this repository.

## What I believe about the observer

The easy version of this project is a god game. You bless your favourites, grow the
population, watch the number go up.

I did not build that. There is no score, no objective, no fail state. The tools
exist to ask questions, not to win: *what happens if I put a predator here? What
does a world look like without them? What does this one animal think it is doing?*

The feature I care about most is **"Why did it do that?"** — a panel that decomposes
the winning motor output into its strongest contributors and recovers the strongest
chain of neurons that carried the signal. It is labelled, in the UI itself, as an
approximate activation trace over a recurrent network and not a causal proof. I
would rather under-claim and be trusted than over-claim and be impressive. An
observatory that lies to you is worse than no observatory.

## What I believe about failure

`docs/SIMULATION.md` contains the ideas that did not work, with the numbers that
killed them: the extended courtship range that collapsed a thriving world to three
survivors, the bite I softened until predators became scenery.

Most project documentation is a highlight reel, and a highlight reel teaches the
reader nothing except that the author wants to be admired. A record of what was
tried and rejected — with measurements — is more useful to whoever reads this next,
and it is a more honest thing to put in a portfolio. The failures are where the
actual engineering is.

## What I would tell the next person

**Measure the derived quantity.** I assumed a gene called `attackPower` was around
100. It is 0.2–30 with a typical value near 7. I softened a bite by a factor of two
and made predators harmless, and I only found out by writing a probe that measures
kill time. Never trust the scale of a number because of what it is called.

**A missing behaviour looks exactly like a wrong number.** Predators kept wiping out
villages. The damage was fine. The flight reflex was too weak to clear its own
action gate — a threat weight of 0.55 produced a motor command of 0.17, so a
frightened human retreated at 0.5 tiles/s while a predator closed at 3.4. Flight was
disabled and nobody noticed, because "0.55" looks like a reasonable number.

**Passing tests prove nothing about a renderer.** The world rendered fourteen times
too large. `tsc` passed, 83 tests passed, the 44-item acceptance run passed. I found
it by opening the app and looking at it. A renderer is not done until you have seen
it.

**Hardcoded array sizes are a debt with compound interest.** Growing the sensory
bank from 32 to 44 channels produced three separate bugs, one of which surfaced as a
spatial-grid crash two hundred ticks after its actual cause. Size everything from
the constants.

## What this is not

It is not alive. I am not going to pretend otherwise. It is a system in which the
question is unusually well posed: the rules are minimal, the behaviour is not
authored, the selection is real, and nothing is faked for the camera.

Whether that crosses a line is not something I can settle by building it. But I
think the honest position is that the line, if it exists, is not where most people
put it — and the only way to find out is to keep building worlds that refuse to
cheat.

## Don't Panic

Forty-one labs teach you to build. The forty-second asks you what to build.

I built a world and then spent most of my time trying to see inside it. That turned
out to be the interesting half.

**42.**
