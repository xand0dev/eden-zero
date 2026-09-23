# Civilisation — development roadmap

**Goal:** a god should want to stay for twenty minutes. Not because the world is
pretty, but because something is *happening* that they can affect — a settlement
growing, fields appearing, a drought they can break, a forest they can watch
disappear and come back.

This document is the plan for getting there. It is written before the code, so it
is a set of intentions, not a claim of what exists. Where something already
exists, it says so.

---

## 1. Why the current world runs out of things to do

The world is alive and it is not scripted, but it is *flat in time*. Three
reasons:

**Nothing accumulates.** A human eats a berry and the berry is gone. A hut is
built and then nothing depends on it. There is no stock, no store, no surplus —
so there is no reason for one hour to differ from the next.

**Nothing degrades.** Trees hold `maxTimber` and regrow at `0.0025/s`, but a
felled tree leaves no visible scar and the regrowth is invisible. The forest
looks the same whether it has been logged or not. There is no scarcity to react
to.

**The god has no stake.** The god tools are omnipotent and consequence-free:
lightning strikes, food appears, humans move. Nothing is at risk, so nothing
needs protecting, so there is nothing to do after the first few minutes.

The fix is not more god powers. It is **giving the world something to lose**.

---

## 2. Five systems

Each is independently testable. They build on each other in order, but systems 1
and 2 need no change to the brain, so they can ship first and be observed.

### S1 — The forest as a finite, regrowing resource

**Already there:** `Plant.maxTimber`, `timberRegen: 0.0025`, `takeTimber()`,
`S.wood.*` sensing, the `harvest` motor.

**Missing:** any consequence. A tree that has been stripped to zero should look
like a stump, and the wood within walking distance of the settlement should run
out after enough building.

- Render a tree's remaining timber: canopy shrinks as `timber/maxTimber` falls,
  and a felled tree becomes a stump that regrows over minutes.
- Sense the *local* timber density so the network can prefer a rich stand over a
  stripped one — the `wood.*` channels already point at trees; this is a matter
  of weighting by remaining timber rather than mere presence.
- **Consequence:** a settlement that keeps building exhausts its surroundings and
  must reach further. Distance becomes a real cost.

### S2 — The settlement spreads into the forest

**Already there:** `foundStructure()` with a minimum separation, `settlementSites()`
for the initial ring, `S.build.*` sensing.

**Missing:** the ring is fixed at world creation, so the village never actually
grows outward. Sites should appear where the network decides to place them, not
only on a predetermined circle.

- Add `forest.{front,right,back,left}` sensory channels — where the nearest
  forest tile is. Clearing forest to build in it becomes a learnable behaviour.
- Allow new sites anywhere the minimum separation is met, and let the priors
  favour forest edges near water (the same reasoning that put the founders near
  water in the first place).
- **Consequence:** the village visibly eats into the tree line, and a second
  cluster can appear across the map when the first is exhausted.

### S3 — Fields

**Nothing exists yet.** This is the first genuinely new system.

- New entity `Field`, placed on `fertile` grass, with `growth` and
  `soilMoisture` state.
- A field yields far more food per tile than wild forage — the reason to farm.
- A field depletes its soil moisture and stops growing when dry. This is the
  hook for S4.
- New sensory channels: `field.{front,right,back,left}`, `fieldNeed`,
  `soilMoisture`, `seeds`, `cropReady`.
- New motors: `plant` (sow), `tend` (harvest and weed).
- **Consequence:** food stops being scattered berries and becomes a place the
  settlement defends and expands.

### S4 — Irrigation

**Already there:** `computeWaterDistance()` — a multi-source BFS giving every
tile its distance to fresh water. It exists today so founders do not dehydrate.
It is exactly the structure irrigation needs.

- New entity `Canal`, dug tile by tile from a water source toward a field.
- New motor: `dig`.
- A canal carries water: tiles adjacent to it gain moisture, so fields beside it
  keep growing through a dry spell.
- New sensory channels: `canal.{front,right,back,left}`, `irrigationNeed`.
- **Consequence:** the most legible thing in the whole simulation — a line of
  dug earth from the river to the fields, made by agents, for a reason.

### S5 — Settlement stages and the god's arc

**Nothing exists yet.**

- A `Settlement` with a stage: **camp → village → town → city**, unlocked by
  huts, fields, population and generation depth.
- Each stage unlocks a structure (camp: huts, village: fields, town: canals,
  city: a monument).
- Crisis events on a timer: **drought** (fields stop growing), **cold snap**
  (shelter matters), **predator incursion**, **blight**. Each is survivable and
  each is something the god can blunt — rain, warmth, lightning, food.
- Milestones surfaced in the event feed: *first field*, *first canal*, *city*,
  *tenth generation*. These are the beats a twenty-minute session is built from.

---

## 3. The brain budget

New behaviour means new inputs and outputs, and the brain is a fixed-size typed
array. This is the single largest technical cost in the plan and it should be
done **once**, not five times.

| Region | Now | Proposed | Why |
|---|---|---|---|
| sensory | 44 | 64 | +forest×4, field×4, canal×4, soilMoisture, fieldNeed, irrigationNeed, seeds, cropReady, storedFood, settlementStage |
| local | 64 | 80 | proportional |
| recurrent | 132 | 160 | proportional |
| modulatory | 16 | 20 | room for a stage signal |
| motor | 14 | 17 | +plant, tend, dig |
| **total** | **270** | **341** |

**Cost, stated honestly:** `Brain.step` is already 57% of tick time (see
`docs/PROFILING.md`). Growing the network by ~26% grows that cost roughly
proportionally, and the world currently runs at about half the headroom MAX speed
wants. The refractory-skipping optimisation in the profiling report stops being
optional at that point.

**Behavioural cost:** a bigger brain with new outputs starts from nothing. The
new motors have random priors, so `plant` and `dig` will not be used until
evolution finds them. This is the same problem mate search had, and it has the
same fix — the mate-search breakthrough came from raising approach priors, not
from more neurons. Expect to seed the new channels with hand-set priors and then
measure, exactly as `scripts/predator-probe.ts` measures kill time.

---

## 4. Save compatibility

`SAVE_VERSION` is 1. Changing the neuron count changes the length of every
serialised brain, so every existing save becomes unreadable.

Two honest options:

1. **Version 2 with migration.** Pad the old weight arrays with zeros and offset
   the region boundaries. Preserves saves; costs a migration path that must be
   tested against a real v1 file.
2. **Version 2 without migration.** Refuse old saves with a clear message. The
   save envelope already does this correctly for *newer* versions; extending it
   to reject older ones is a few lines.

For a course project, option 2 is defensible **if it is stated plainly** in the
UI and the docs. Silently producing a broken world — which the envelope comment
says was the original concern — is the thing to avoid, not the rejection itself.

---

## 5. Order of work

Deliberately ordered so that the brain change happens once, after the systems
that do not need it.

| # | Step | Brain change | Risk |
|---|---|---|---|
| 1 | S1 forest exhaustion, visible stumps, regrowth | no | low |
| 2 | S2 emergent sites, spread into forest | no (priors only) | medium |
| 3 | **Brain v2: all new channels and motors at once** | **yes** | **high** |
| 4 | S3 fields | uses v2 | medium |
| 5 | S4 canals and irrigation | uses v2 | medium |
| 6 | S5 stages, crises, milestones | no | low |
| 7 | Balance pass with `npm run balance` and a 20-minute soak | no | — |

Steps 1 and 2 ship first because they change the world without touching the
brain, so they can be watched in a real browser before anything irreversible.

---

## 6. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| New motors never fire | The network ignores `plant`/`dig` and nothing is built | Seed priors, then measure with a probe script before declaring it done |
| Tick cost outgrows the frame budget | A larger brain at 57% of tick time leaves no headroom | Do the refractory-skip optimisation from `PROFILING.md` in step 3 |
| Villages starve into extinction | A failed farming system is worse than none | Fields must be *additional* food, never the only food |
| Save format breaks silently | A corrupt world is worse than a refused save | Bump `SAVE_VERSION`, refuse cleanly, say so in the UI |
| Scope creep | Five systems is a lot for one project | Each system ships and is measured on its own; none depends on a later one |

---

## 7. How we will know it works

Not by assertion. By a soak test and a measurement, the same way the
interpolation claim was settled.

- **A twenty-minute soak.** Run the world at a realistic speed for twenty
  simulated minutes and record: huts built, fields sown, canals dug, settlement
  stage reached, generations. If the numbers are flat after minute five, the
  design failed and the plan is wrong.
- **A farming probe.** A script that reports, per simulated hour, how many
  `plant` and `dig` actions fired. Zero means the priors need work; this is the
  `predator-probe.ts` pattern applied to a new behaviour.
- **A browser check.** Screenshots at minute 0, 5, 10, 20 showing the village
  growing, because the renderer being wrong while all tests pass is a mistake
  this repository has already made once.

The measure of success is not "the agents build things". It is that at minute
fifteen there is something a god can still lose.
