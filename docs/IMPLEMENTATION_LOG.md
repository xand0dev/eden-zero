# EDEN//0 — implementation log

Working log for the roadmap in `docs/ROADMAP.md`. Written so that work can be
resumed after an interruption without repeating it: every entry records what
was done, the exact command, the seeds and configuration, and the measured
result. Numbers here are measured, never estimated; anything not measured says so.

Branch: `codex/eden-roadmap`. Session start: 2026-09-28 12:33 (local).

## Conventions

- **Seed set A (8):** `eden,orion,vela,lumen,tessera,auriga,kepler,solace`.
- **Long run:** 200 000 ticks = 10 000 simulated seconds ≈ 2.8 simulated hours
  ≈ 66 biological years (`BIO_YEAR_SECONDS = 150`). This is the horizon of
  acceptance check #29. `SPEED_TICK_BUDGET` is ticks per real second, so a
  20-minute session is 120 000 ticks at ×5 and 480 000 ticks at ×20; 200 000
  ticks is a 20-minute session at roughly ×8.
- **p0 / p2:** 0 or 2 initial predators, 8 founders.
- Baselines and after-runs are JSON files in `docs/evidence/`, produced by
  `npm run balance:parallel -- --seeds <A> --ticks 200000 --predators <0|2> --out <file>`.
  Simulation numbers in those files are deterministic; wall time / ticks per
  second are measured under CPU contention (up to 16 processes on 15 cores) and
  are not tick-rate evidence. Tick-rate evidence comes from sequential runs.

---

## Stage 0 — reliable baseline

### 0.1 Audit of the working tree (12:33)

`git status` on `codex/eden-roadmap` (8 commits after `95ced1f`):

- Modified, from the Codex pass: `scripts/acceptance.ts`, `scripts/brain-probe.ts`,
  `scripts/trace-probe.ts`, `scripts/simulate.ts` — hard-coded 256 neurons / 12
  motors replaced by `NEURON_COUNT` / `MOTOR_COUNT` / `S.*` constants. Reviewed;
  correct, kept as is.
- Modified + new, from the interrupted OpenCode pass: `scripts/balance.ts`,
  `scripts/balance-metrics.ts`, `tests/balance.test.ts` — inconsistent.
- New docs: `docs/ROADMAP.md`, `docs/OPENCODE_HANDOFF.md`, `docs/CLAUDE_OPUS_5_5_PROMPT.md`.

Measured before any edit:

| Command | Result |
|---|---|
| `npm run typecheck` | **fail** — 9 errors, all in `tests/balance.test.ts` (`collectDeathReasons`, `harvested`, `harvestedFields`, `flowingCanals`, missing `tally`) |
| `npm test` | **6 failed / 148 passed** (154), all failures in `tests/balance.test.ts` |

### 0.2 Balance diagnostics repair (12:34–12:40)

The OpenCode design — an event-id cursor advanced every tick, tracking which
ids are humans — was sound and kept. Finished and hardened it:

- `BalanceTally` (`scripts/balance-metrics.ts`)
  - counts harvests, sowings and finished canal lengths from events every tick,
    so counts survive the 400-event log rollover (`MAX_EVENTS`);
  - counts **ripenings** by watching field stages (ripening emits no event);
  - human vs predator: only ids ever seen in `world.humans` count as human
    deaths. `killPredator` emits the same `death` shape and shares the id
    counter, so predator deaths are excluded;
  - known humans are refreshed before deaths are judged, so a human spawned and
    killed between observations is still counted;
  - **reconciles against `World.deaths`**: a human death the log could not
    explain (trimmed event) is recorded as `unattributed`, so death reasons
    always sum to the deaths column;
  - `eventsMissed` reports trimmed events; nonzero means event-derived counts are
    lower bounds (the output never calls a partial count exact).
- `collectCultivation`: canals reported separately as staked / complete /
  flowing; fields as lifetime / sown / ripe / moist; pile food separated from
  wild plant food.
- `BalanceRow`: + trough after peak, extinction tick, mating pipeline counters,
  population samples every `--sample-every` ticks (default 6000).
- `summarize`: batch ticks/s = total ticks / total wall time (not the mean of
  per-seed rates); empty batch no longer yields `-Infinity`.
- `scripts/balance.ts`: `performance.now()`, new columns, JSON format v3.
- New `scripts/balance-parallel.ts` (`npm run balance:parallel`): one process per
  seed, merged JSON.
- New `scripts/population-probe.ts` (`npm run probe:population`): reproductive
  pipeline (adults → fertile → eligible → willing → pairs → conceptions →
  births), adult motor distribution, deaths by life stage.

Tests (`tests/balance.test.ts`, 17): fresh world; one field through **two**
cycles (repeated harvests of one field = 2 harvests, 1 field); canal staked →
complete → flowing; deaths by reason; **predator death not counted**; spawned
human counted; **harvests survive log rollover** (3 harvests, then 1000 filler
events, log has 0 harvest events, tally has 3); missed events reported with
deaths reconciled as `unattributed`; `buildRow` consistency; **batch ticks/s =
2000 ticks / 10 s = 200**, not the mean of rates (555.6).

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `vitest run tests/balance.test.ts` | 17/17 pass |
| `npm test` | **160/160 pass** (11 files, 131 s) |
| `npm run balance -- --seeds eden,orion --ticks 5000` | eden: pop 12, gen 1, 4 sown / 1 ripened / 1 harvested, canals 1/1/0; orion: pop 12, 7/4/2 canals staked/dug/flowing; 1332 ticks/s |
| `npm run accept` | **43 pass, 1 fail, 8 manual** (104 s). #29: "reached generation 1 with 10 births" in 200 000 ticks (seed `generations`, 0 predators). Unchanged from the Codex report. |

### 0.3 Findings during the audit (not yet acted on)

1. **Proximity gates ignore their radius.** `SpatialGrid.queryCircle` returns
   every index in the 8-tile cells overlapping the circle (documented), and
   several callers never filter by distance:
   - `Human.tryEat / tryHarvest / tryBuild / trySow / tryTend / tryDig / tryAttack`
   - `Predator.tryAttack / tryEat` — a predator can strike a human ~8–10 tiles
     away instead of `ATTACK_REACH = 1.5`.
   - `World.foundField` (4.5), `foundCanal` (2.2 / 3.2), `foundStructure` (5.5),
     canal flow propagation (2.5), `waterAt` (`CANAL_REACH = 3.5`).
   Measured (`scripts/.scratch/grid-check.ts`, seed `grid`): 85 of 91 plants
   returned by a 1.35-tile reach query were farther than 1.35 tiles; a canal
   2.4 tiles from another was refused, 3 tiles away was accepted — placement
   depends on cell boundaries, not distance.
2. **Harvests can yield nothing in a long run.** `World.harvestField` only spawns
   the food pile while `plants.length < MAX_PLANTS` (6000). Acceptance #30 shows
   plants saturate at the cap (1091 → 6004) within 6000 ticks.
3. **Shared motor baseline.** `Brain.readMotor` subtracts the mean drive of all
   17 motors. Strongly driven agriculture motors raise that baseline for every
   other motor, including `mate` (gate 0.35 in `World.resolveMating`).
   Hypothesis only — to be tested with `probe:population`.
4. `Human.farming` is set but never reset (render-only flag).

### 0.4 Interruption (13:35–14:01)

The session was interrupted by the owner at ~13:35; all background runs were
killed. Survived: `docs/evidence/baseline-p2-200k.json` (pre-E1 code, uncapped,
8 seeds × 200 000 ticks, 2 predators, finished 13:33). Lost: the uncapped p0
baseline, the population probes except `orion`, and the first E1 batch.

Lesson recorded for resuming: uncapped runs of thriving seeds take ~50 min each
(eden: 3140 s for 200 000 ticks at 689 humans ≈ 16 ms/tick). All later batches
use `--stop-above 250`, which ends a seed early and marks it `runaway`.

Second lesson: zsh does not word-split `$VAR`; a batch launched with
`tsx ... $A` silently ran defaults (150 000 ticks, no cap, 13 jobs) and was
killed. Batches are launched through `scratchpad/run_batch.sh` (bash).

### 0.5 Baseline (pre-change code, 2 predators, uncapped)

`docs/evidence/baseline-p2-200k.json` — seed set A, 200 000 ticks, 2 predators, commit `981011d` sim code.

| seed | final pop | peak | gen | births | deaths | huts | fields | sown / ripened / harvested | canals staked / dug / flowing | wall s |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|
| eden | 689 | 689 | 5 | 733 | 52 | 22 | 14 | 557 / 550 / 543 | 66 / 66 / 43 | 3140 |
| orion | 0 (t 127 037) | 15 | 2 | 11 | 19 | 22 | 15 | 473 / 473 / 458 | 64 / 64 / 56 | 203 |
| vela | 0 (t 96 246) | 12 | 1 | 9 | 17 | 10 | 23 | 171 / 162 / 148 | 86 / 86 / 38 | 138 |
| lumen | 248 | 248 | 5 | 337 | 97 | 29 | 21 | 1862 / 1841 / 1841 | 96 / 96 / 64 | 1424 |
| tessera | 0 (t 197 805) | 21 | 1 | 15 | 23 | 25 | 24 | 266 / 256 / 242 | 88 / 86 / 31 | 172 |
| auriga | 46 | 46 | 4 | 72 | 34 | 31 | 25 | 581 / 559 / 557 | 82 / 82 / 22 | 492 |
| kepler | 0 (t 99 440) | 14 | 1 | 12 | 20 | 38 | 25 | 339 / 333 / 314 | 96 / 92 / 56 | 118 |
| solace | 1 | 19 | 2 | 23 | 30 | 32 | 16 | 664 / 661 / 648 | 78 / 78 / 45 | 227 |

Human deaths (all seeds): dehydration 107, starvation 87, predation 54, old age 23,
injuries 16, exposure 5. `eventsMissed` = 0 on every seed.

**Reading.** The population is *bimodal*, not uniformly declining: 4 of 8
extinct and 1 at a single survivor, 3 growing without bound. 5/8 reached
generation 2 in this batch; acceptance #29 fails because its seed
(`generations`) falls in the dying mode.

- **Food is not limiting.** Every world is at the plant cap (6000–6009 plants,
  ~5 700–6 000 food units of wild forage). Starvation and dehydration deaths are
  behavioural/local, not scarcity. Nothing bounds a thriving world below
  `MAX_POPULATION = 900`, and tick cost is linear in population.
- **Harvests yield almost no food.** With plants at the cap, `harvestField` skips
  the pile. 4 751 harvests across the batch and 0–4 food piles standing at the
  end. The farming loop runs but does not feed anyone.
- **Allee effect in the mating pipeline.** Dying worlds average 0.30–0.57 willing
  adults per tick and 11–22 matings in ~100 000 ticks; pairings ≈ opportunities
  (every willing encounter pairs). Thriving worlds: 1.9–5.8 willing per tick,
  200–889 matings. The binding constraint is willing adults meeting, which
  scales with density — small villages cannot recover.
- Probe `orion`, 0 predators, 200 000 ticks (pre-E1): population 8–15 throughout,
  generation 5, 29 births / 27 deaths; adults willing 10–53% of ticks; 0–8
  pairings per 10 000 ticks; deaths mostly starvation/dehydration of children and
  adults, few of old age.

---

## Stage 1 — population viability (in progress)

Experiments are cumulative. Each lives in its own copy under the session
scratchpad (`base` = commit `981011d` sim code + new diagnostic scripts; `e1` =
this worktree; `e2`, `e2b`, `e3`, `e4`, `e5` = copies, each the previous plus
one change) so a running batch never picks up an edit. Patches for e2b/e4/e5
are `scratchpad/patch_*.py`; they are ported into this worktree once accepted.

| id | change | where |
|---|---|---|
| E1 | enforce reach in human/predator action gates (eat, fell, build, sow, tend, dig, attack; predator attack/eat) | `human.ts`, `predator.ts` (applied here) |
| E2 | `World.within()`: real distances for canal spacing/flow link, field watering reach, field and hut spacing; canal staking rules equal to the flow model (link 3.2, source 4) | `world.ts` |
| E2b | no new hut site / canal length while an unfinished one is within 10 tiles | `world.ts` |
| E3 | a harvest always leaves its food pile (was skipped at the plant cap); `World.foodEaten` {wild, crop, pile} counters; `Plant.crop` | `world.ts`, `plant.ts` |
| E4 | digging charged per tick at felling's rate (2.2/24 energy, 3/24 fatigue) instead of a full swing per tick | `human.ts` |
| E5 | conspecific *direction* sensed out to `buildRange` (2.4 × vision); social memory still only within vision | `human.ts` |

### 14:04–14:30 capped batches (partial)

`run_batch.sh <dir> <0|2> <out>`: seed set A, 200 000 ticks, `--stop-above 250`,
3 jobs per batch, 6 batches at once. **Stopped at 14:30 by the owner** because the
machine was saturated (18 simulation processes on 15 cores); no batch wrote its
JSON. Seeds that had finished (from the `.log` files):

| batch | finished seeds (final pop / generation) |
|---|---|
| base p0 | orion 10/g5, vela 27/g5 |
| E1 p0 | orion 0/g1, vela 0/g1, tessera 0/g1 |
| E2 p0 | vela 0/g1, orion 0/g2, lumen 0/g1, tessera 0/g2, kepler 0/g1, solace 17/g4 |
| base p2 | vela 0/g1, orion 0/g2, tessera 0/g1, auriga 46/g4, kepler 0/g1, solace 1/g2 (identical to the uncapped baseline — determinism holds across runs) |
| E1 p2 | vela 0/g1, orion 2/g4, lumen 0/g1, tessera 0/g1, kepler 0/g1 |
| E2 p2 | all 7 finished seeds extinct (g1–g3) |

**Reading.** E1 removes survival that the reach bug was providing: with 0
predators, orion and vela go from generation 5 to extinct in generation 1. The
fix is kept (it is a correctness fix: a human "within reach" of food was eating
from up to 16 tiles away), so viability has to come from fixing real causes.

### Probes (single process each, 60 000 ticks, 0 predators)

`scripts/population-probe.ts`, now also reporting the motor read-out baseline,
raw mate drive, the innate `libido -> mate` weight, distance to the settlement
centre / nearest human / water, and `--no-farming` (counterfactual that forbids
founding fields and canals in the probe's world only).

vela, E1 code, farming vs `--no-farming`, at 35 000–40 000 ticks:
`libido -> mate` weight 0.87 → −0.08…0.07 with farming vs 0.47–0.59 without;
willing adults 2–6 % vs 22–25 %; fatigue 38–47 vs 9–19; population at 60 000
4 vs 11.

**Cause found (E4).** `tryDig` ran every tick the dig motor was held and charged
2.2 energy + 3 fatigue per tick: one 50-tick canal length cost ~110 energy and
~150 fatigue (felling costs ≤2.24 / 3.08 per 24-tick swing). The resulting
valence crashes depress every eligible synapse, and `libido -> mate` is always
active, so farming villages unlearned mating. With E4 (vela, E3 vs E4 code):
`libido -> mate` 0.05–0.29 → 0.47–0.75; fatigue 44–77 → 10–22; willing 3–11 % →
21–34 %.

**Second cause (dispersal), not yet fixed.** With E4, vela still falls 20 → 5 by
60 000 ticks with 7–8 adults, a quarter of them willing, and **zero** mating
opportunities. Adults drift 14 → 50 tiles from the centre, nearest neighbour
4 → 18 tiles, mean water distance 3 → 10; dehydration deaths occur 16–20 tiles
from water. The same happens without farming (33–52 tiles from centre, nearest
10–14), so it is not caused by farming. The thriving seed (eden, E4) also moves
~70 tiles from its origin but *as a group* (nearest human 5–7, water 5). The
difference is cohesion: people are sensed only within vision (~8.5 tiles) while
work targets are sensed to 2.4 × vision. E5 addresses this; not yet measured.

### CPU budget (owner instruction, 14:30)

Do not saturate the machine: at most ~4 simulation processes at once, run under
`nice -n 15`, one batch at a time (`--jobs 2`–`3`).

### Ported to this worktree (15:05, owner request)

E2, E2b, E3, E4 copied from the experiment copy into `src/` so the owner can
see them in the running game. `tests/cultivation.test.ts` updated (the broken-
chain case is now made by un-finishing one length, since E2b forbids staking past
an unfinished one) and a spacing test added: 8/8 pass; cultivation + balance +
persistence + determinism: 38 pass. Full suite, acceptance and a multi-seed batch
on the ported code have **not** been run yet.

## Promo video (15:10–15:50, owner request)

`scratchpad/promo/EDEN0-promo.mp4` — 57.8 s, 1920×1080, H.264 30 fps, AAC.
Recorded from the dev server (worktree code with E1–E4) in headless Chromium on
the Metal GPU via CDP screencast; scenes, cards and edit are reproducible with
`scripts/.scratch/make-save.ts` (eden, 80 000 ticks), `promo-record.mjs`,
`promo-cards.mjs` and `scratchpad/promo/assemble.sh`. Daylight in the world
scenes is set with the game's own time-of-day god command. Audio is a
synthesised ambient pad (no third-party music). Captions in English.

Product issues the recording surfaced (for stages 2, 4, 5):

1. **Autosave silently fails for grown worlds.** The eden save at 80 000 ticks
   (58 humans) is 10 MB; `localStorage` refuses it and `writeAutosave` swallows
   the error. Roughly 170 KB per human, mostly brain arrays.
2. **Canal lengths hit `MAX_CANALS = 160` by ~30 000 ticks** in eden and auriga
   even with E2b; auriga also hits `MAX_FIELDS = 80`.
3. **Canals render as separate blue squares**, not channels; at 160 lengths the
   close-up village view is cluttered and the irrigation network is unreadable.

## Stage 4 (brought forward) — visual rework (15:55–17:10, owner request)

Owner: "graphics and all models look very cheap … do a full design rework".
Direction chosen by the owner: **living diorama + observatory UI** on PixiJS 2D.
One consistent view for everything: from above and slightly in front, lit from
the north-west, shadows to the south-east, one scale (person ≈ 1.45 tiles,
tree crown ≈ 2 tiles, roundhouse ≈ 3 tiles). Simulation untouched.

| layer | before | after | file |
|---|---|---|---|
| terrain | 1 colour per tile, nearest-scaled (stair-step coasts) | baked 12 px/tile from the continuous elevation/moisture fields with the simulation's thresholds; hillshade, depth-graded water, foam line, beach blend, meadow patches; animated sea glints | `src/render/terrain.ts` |
| vegetation | discs redrawn into a 1760×1280 canvas and re-uploaded every 260 ms | generated atlas (4 crowns, young tree, stump, bushes, berry bushes, grass tufts, produce basket, soft shadow) drawn through 3 `ParticleContainer`s; crowns over fields/huts thin out | `src/render/vegetation.ts` |
| people | side-view polygon figure at 3.2× scale, not facing travel | three-quarter figure at 1.45×: tunic from the genome colour, skin and hair from the genome, shading, belt, face; mirrors to face travel | `src/render/humanoid.ts` |
| predators | the person rig with a crest | four-legged beast: trot, lunge, rest, tail, glowing eyes | `src/render/humanoid.ts` |
| huts | front-view house rotated at random | roundhouse: stakes → wattle walls rising with timber + woodpile → conical thatch, door, hearth glow, smoke | `src/render/structure.ts` |
| fields / canals | flat squares, all Graphics rebuilt every snapshot | tilled plots with furrows, crop rows that thicken and turn gold, soil darkness = moisture, cracks when dry; canals as a branching channel (each length joined to its nearest older neighbour or to the shore), water in the trench when flowing; redrawn only on change | `src/render/cultivation.ts` |
| light | black overlay at night | colour grade by sun (midday / golden hour / moonlit night), additive hut-door lamps at night, vignette | `src/render/lighting.ts` |
| effects | thick flat rings | ground-projected ellipses, rising motes, jagged lightning with glow and scorch, dust puffs | `renderer.ts: drawEffect` |
| UI | boxed canvas between dark sidebars | full-screen world, floating glass panels (top bar with large mono stats, tools, inspector, events); responsive at ≤1180 px and ≤820 px | `src/styles.css`, `WorldScreen.tsx` |
| Genesis | centred form | the real island for the seed as a live backdrop (same painter), title block, glass card | `App.tsx`, `IslandPreview.tsx` |
| Sprite Lab | its own copies of old models | every model drawn by the game's own renderers at one world scale | `SpriteLab.tsx` |

Also fixed: human and predator sprites shared one recycle pool, so a recycled
predator rig could come back as a person.

Verification (headless Chromium on the Metal GPU, `scripts/.scratch/shot.mjs`,
screenshots in `scratchpad/visual/`): fresh `eden` world and the 80 000-tick
`eden` save; midday / golden hour / night; zoom 0.55–4.5; selected human with
inspector; Sprite Lab; Genesis. 60 fps reported, no console errors in any run.
World visible 0.6–0.9 s after pressing Genesis (includes the terrain bake).
`npm run build`: pass. `vitest` (3 threads): **168/168 pass** (12 files).

Not verified: the Tauri desktop build, a long session's memory profile with the
new layers, Retina (devicePixelRatio 2) rendering, and the competitive-mode
scoreboard position in the new layout.

### Redesign video report (17:15–17:55, owner request — cannot test on a phone)

`scratchpad/promo/EDEN0-redesign-report.mp4` — 1:40, 1920×1080, 24 MB, Ukrainian
captions. Before/after split screens use frames recorded from the old renderer
for the promo (same save, same camera path). Scenes recorded headless on the
Metal GPU: `scripts/.scratch/report-record.mjs`, cards
`report-cards.mjs`, edit `scratchpad/promo/assemble-report.sh`.

Fixes made while recording:
- **Phone layout (390×844):** top bar lost population/generation and the speed
  buttons overflowed; the event log overlapped the inspector sheet. Now: pop and
  gen shown, step/MAX hidden on phones, event log hidden while a person is open.
  Genesis also scrolls instead of clipping on short windows (≤640 px high).
- **Canals ran into the sea:** the link to the shore went to the centre of the
  nearest water tile. Segment ends on water are now pulled back to the shore.

## Live-brain rework + video (owner request, 18:05–19:20)

Owner: the one thing that could be "top" is the visualisation of neural activity.

`src/render/brainScope.ts` (new) replaces the five-column dot grid in
`Inspector.tsx`. Canvas 2D, own rAF loop, additive glow sprites.
- **Layout follows signal flow:** senses on a left arc in 14 labelled groups
  (food, water, kin, threat, body, needs, bond, wood, build, camp, forest,
  field, canal, farm); local circuits inside; the 160-cell recurrent core as a
  phyllotaxis disc; the 20 neuromodulatory cells as a ring around it; the 17
  motors on a right arc with command bars and names; synapses as curves bundled
  through the core.
- **Motion is data:** glow = firing rate, smoothed between the ~8 Hz worker
  updates; burst rings on sharp rises; impulses along synapses at a rate
  ∝ presynaptic activity² × |w| (warm = excite, cold = inhibit) — drawn by rule,
  not individual recorded spikes, and the video says so; the trace's path and
  learned path drawn as a lit route (neurons found by `labelNeuron` name).
- **Full view:** HUD (name, action, strength, "because …" from the trace), a
  shared spike raster of all 341 cells over ~43 s plus the population trace, and a
  **porthole**: a CSS mask cuts a circle in the overlay and the world camera holds
  the person in it (`renderer.followOffset`, `eden:brain-porthole` event); the
  world's panels are hidden while it is open.
- Overlay portalled to `<body>`: glass panels use `backdrop-filter`, which makes
  them the containing block for `position: fixed` (the first version filled the
  inspector, not the window).
- `World.brainView` now sends the strongest 26 synapses **per region pair**
  (290 in practice) instead of the global top 280, which were nearly all innate
  sensory→motor reflexes. Read-only; no simulation state touched.

**Bug found and fixed on the way (affects every Retina Mac):** `updateCamera` and
`screenToWorld` computed the screen centre as `renderer.width / resolution`, but
`renderer.width` is already logical in Pixi v8. At DPR 2 the camera centre was a
quarter of the way across the screen, so "follow" put the person off-centre.
Verified with `scripts/.scratch/dpr-check.mjs`: followed human drawn at
(800, 500) of a 1600×1000 viewport at both DPR 1 and DPR 2.

Video: `scratchpad/promo/EDEN0-live-brain.mp4`, 1:06, 1080p, 22 MB, Ukrainian
captions (`brain-record.mjs`, `brain-cards.mjs`, `assemble-brain.sh`). Screencast
returned 1920×1080 frames even at DPR 1.5, so the three close-ups are 1.5×
upscales. The predator scene was recorded but cut: the predator did not appear
in the porthole on the final take, and the video does not claim it.

`npm run build`: pass. `vitest` (3 threads): 168/168.

## Live brain 2.0 + video (owner: "do it as you see it, I want a top result")

Data (observability only — the simulation never reads any of it, nothing new is saved):
- `Brain.spikeCount` (Uint32 per neuron) counts spikes; `World.brainView` drains it.
- `BrainView` gains `spikes`, `valence` (`Human.lastValence`), `sensors`, `heading`,
  `weightDrift`, a change-since-birth value on every shown synapse, and `learned`:
  the 40 synapses lifetime plasticity has moved furthest.

`src/render/brainScope.ts` rewritten on top of that:
- **Real spikes:** after each update a spiking neuron sends at most one impulse per
  displayed synapse (thinned by weight; at ~4 000 spikes/s drawing all of them was
  a white blob) and pops white. Sensory channels are graded, not spiking; their
  impulses stay density-based and are drawn fainter; the legend says which is which.
- **Feeling:** valence swings > 0.12 send a gold (reward) or crimson (pain) wave
  from the core; a pain ↔ reward needle in the HUD.
- **Learning view (L):** synapses coloured by change since birth (gold = stronger,
  violet = weaker), width by amount, plus the 40 most-changed synapses.
- **Decisions:** shockwave from the motor on a change of action; decision ribbon
  above the raster on the same time axis, with a legend.
- **Body in the porthole:** egocentric food/water/kin/threat channels turned
  through the heading into arcs inside the rim; hunger/thirst/fatigue/pain gauges.
- **Bloom:** quarter-resolution thresholded, blurred copy added back (skipped where
  canvas filters are unsupported).
- **Sound (S):** WebAudio, off by default: a note per region per update (loudness
  by spike count), a chime per decision, a swell per valence swing.
- Overlay controls: Learning / Sound / Close buttons.

Video: `scratchpad/promo/EDEN0-live-brain-2-share.mp4` (1:25, 1080p, 23 MB; master
52 MB). Soundtrack synthesised offline from a log of every brain update during
recording (`brain2-record.mjs` → `brainlog.json` → `sonify.mjs`), aligned to each
scene's first frame, under a quiet drone. The reward scene is real: food placed at
the person's feet, valence reached +0.30 at 6.7 s into the take. The person in the
long take did not change action (always move-forward), so the video does not claim
activity precedes decisions.

`npm run build`: pass. `vitest` (3 threads): 168/168 pass.

## The game layer (owner: "implement all of it" — docs/GAMEPLAY_PLAN.md)

Built in `src/simulation/game/` (simulation) and `src/meta/`, `src/ui/game.ts`,
`src/components/game/` (observer side). The rule from the plan held throughout:
the observer changes physics, bodies, genomes and the learning signal; nothing
writes a decision.

Simulation (deterministic, saved, replayable):
- **Calendar** — year = 8 days (32 min at ×1); seasons scale plant regrowth,
  seed dispersal, field growth, thirst, spoilage, harvest yield, temperature.
- **Soil** — grazing lowers a tile's fertility; wild regrowth ∝ fertility²; seeds
  refuse exhausted ground; recovery toward full. Fields have their own fertility,
  lose it per harvest, recover 15× faster fallow (crop rotation pays).
- **Eras I–V** — read from world state, held two days; sensed on `settlementStage`
  (channel 63, zero until now); granary store sensed on `storedFood` (62).
- **Structure kinds** — granary, well, workshop, stone house, palisade, shrine; the
  kind is decided by the site's surroundings and era (`game/buildings.ts`), never
  by a new motor. Dwellings now warm the air around them.
- **Fate** — 8 crises from a separate `seed:fate` stream, a day's warning,
  era-gated, physics-only (drought, harsh winter, predator migration, blight,
  flood, fever, fire, eclipse).
- **Favour** — single-player budget (costs, cooldowns, rewards for births,
  generations, discoveries, crises weathered); off in sandbox.
- **Laws** (42) and **biomes** (6, terrain parameters; the valley generates the
  original island bit for bit — tested).
- **Atlas** (44 entries) — an observational classifier over per-person counters;
  epithets; chronicle with data-only obituaries; replays = options + command log
  (`game/replay.ts`, verified by state hash in tests).
- New observer tools: rain, bless, reward pulse, pain pulse.

Observer side: profile in `localStorage` (atlas, 152-entry codex, medals, dailies,
vault of up to 12 genomes with copy/paste strings), 30 challenges, a daily world
from the date, new Genesis (campaign / challenges / daily / sandbox, biome and
charter pickers with unlocks), HUD (era with requirements, season, favour, crisis
banner, toasts), journal (chronicle with population graph, atlas, codex, vault,
neuro-lab with side-by-side brains), campaign summary, first-dawn tutorial,
director camera and auto slow-down at ×5/×20.

Saves: brain state packed as exact float32 base64 (the four double scalars kept as
text — squeezing them through float32 made a restored brain diverge), soil and
trails exact, worlds in IndexedDB gzip-compressed with a `localStorage` fallback.
A brain went from 176 KB of JSON to about 53 KB.

### Measured: the reflexes were being erased (a brain bug, not balance)

A 100k-tick sweep of the new code on 8 seeds: dehydration 83 of 163 deaths.
`scripts/.scratch/drink-probe.ts` then showed thirsty people *standing at the
shore* with a mean drink command of 0.013 (adults) and 0.000 (children); they only
drank when the emergency override fired at thirst 85.

`drink-weights.ts`: the innate `thirst → drink` synapse fell from 1.80 to
0.05–0.3 within 12 000 ticks in every brain, children included; `hunger → eat`
likewise. Turning the reflexes' own plasticity to zero did **not** stop it
(1.80 → 0.17 in 15 000 ticks). The cause was homeostatic synaptic scaling: it held
each neuron's total input strength at its birth value, so as learning grew a motor
neuron's recurrent inputs, the scaling pulled every input down together — the
reflex's share of the drive shrank toward nothing.

Fix (`Brain.applyHomeostasis`): scaling regulates only the learned inputs and
leaves the innate reflex synapses alone. After it, over 30 000 ticks the reflex
means stay at drink 1.78, eat 1.78, mate ~1.1. This is very likely also what erased
`libido → mate` in the E4 investigation.

Second finding: even with the reflex intact, the drink command sat at 0.05–0.3,
because the motor read-out subtracts an adaptive common baseline and locomotion
drives of 6–9 lift it. The consumption gate (0.25) is now `TUNING.consumeGate`.
Single-seed probe (vela, 40 000 ticks): gate 0.12 → pop 11, gate 0.06 → pop 29.

Third: with the scaling fixed, reflexes do learn — the median largest reflex drift
at 30 000 ticks is 1.7–2.3 — so the atlas's legendary "Relearned" was earned by
everyone. It now requires a reflex born at |w| ≥ 1.2 to have reversed sign.

`npm run build`: pass. `vitest` (1 thread): 202/202 pass.

### Sweep after the reflex fix (8 seeds × 100 000 ticks, 2 predators)

| variant | extinct | thriving | stable | declining | deaths (dehydration) |
|---|---|---|---|---|---|
| A: old gate 0.25, reflex bug (before the fix) | 1 | 3 | 0 | 4 | 163 (83) |
| g1: gate 0.06 | 0 | 4 | 1 | 3 | 239 (171) |
| g2: gate 0.06 + social range 2.4 (E5) | 1 | 4 | 1 | 2 | — (partial, stopped) |

g1 grew more (births 375 vs 191) but dehydration still dominates. E5 did not help
and is off by default (`TUNING.socialRange = 1`).

`thirst-probe.ts` / `steer-probe.ts` on the remaining deaths: people now die 5–11
tiles from water with the water channels *saturated* (front 1.00 and right 1.00 at
once) and both turn motors at 1.00, so the clamped difference that steers them is
zero. Two fixes were tried behind switches and measured on solace and kepler
(40 000 ticks): divisive normalisation of each direction group
(`TUNING.senseNormalize`) and antagonist push-pull locomotion from motor drives
(`Brain.pairCommand`, `TUNING.pushPull`). Neither changed dehydration deaths beyond
single-seed noise (solace 9 → 10/11, kepler 16 → 13), so both stay off. Recorded
here so the next attempt starts from the measurement, not from the idea.

Crisis severity now depends on era (0.6 camp → 1.25 city): with a flat severity of
1 a camp drought took villages from 20 to 10 and 15 to 5.

### Choosing defaults (8 seeds × 100 000 ticks, severity by era)

| variant | extinct | thriving | stable | declining | births | dehydration |
|---|---|---|---|---|---|---|
| h1: gate 0.06 | 0 | 5 | 1 | 2 | 386 | 171 |
| h2: gate 0.06, thirst ×0.8 | 2 | 4 | 0 | 2 | 377 | 163 |

Slower thirst did not reduce thirst deaths and lost two worlds; outcomes are very
seed-sensitive at this length. Shipped: `consumeGate` 0.06, everything else at its
neutral value. Dehydration is still the leading cause of death — the steering
saturation above is the open problem, and the next thing to fix in the brain.

### Confirmation run with the shipped defaults (8 seeds × 200 000 ticks, 2 predators)

| seed | outcome | pop | gen | era | crises (pop before → after) | built |
|---|---|---|---|---|---|---|
| eden | thriving | 152 | 5 | III | drought 100→99 | 25 huts, 3 granaries |
| lumen | thriving | 117 | 5 | III | drought 26→27, flood 104→106 | 53 huts, 9 granaries, 4 wells |
| tessera | thriving | 33 | 5 | III | drought 22→17, drought 32→29 | 50 huts, 9 granaries, 2 wells |
| vela | thriving | 23 | 4 | II | drought 20→18 | 36 huts, 7 granaries |
| auriga | runaway (251) | 251 | 5 | III | drought 35→40, predators 160→183 | 77 huts, 11 granaries, 3 wells |
| solace | declining | 3 | 3 | II | drought 15→7, drought 4→5 | 24 huts |
| orion | extinct | 0 | 2 | II | harsh winter 9→6 | 20 huts |
| kepler | extinct | 0 | 2 | I | — | 18 huts |

Deaths: dehydration 506, starvation 201, old age 25, predation 5, exposure 4.
Against the pre-game-layer baseline (2 extinct, 1 declining, 1 runaway on the same
seeds) the extinction count is unchanged, but four worlds now reach the village era
with granaries, wells and weathered crises. Still open: no carrying capacity bites
below the hard cap (auriga), small worlds die after one bad winter, and dehydration
is the leading cause of death (the steering saturation above).

### Atlas, second wave

Eighteen more entries on counters the atlas already keeps (lumberjack, master
farmer, the builders of each new structure kind, long walker, trail walker, twice
bitten, crisis veteran, weathered, elder, centenarian, restless, sound sleeper,
gloomy, fed by the gods, canal digger): 65 entries — 14 common, 21 uncommon, 22
rare, 8 legendary. The codex gains atlas milestones at 50 and 60 (153 entries; an
earlier note said 152 where the real count was 151).
