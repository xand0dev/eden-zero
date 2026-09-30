# The Rules of Creation (v3 — the Evolution update)

EDEN//0 used to be a world where behaviour was emergent but the *content* was
written: a fixed brain, a fixed set of looks, a list of eras that ended at the
city. v3 moves the line. What is written now is a short list of base rules;
the skills people have, the instincts they are born with, how they look, the
peoples they form, the style of their buildings and the ages the world passes
through are all **generated while the world runs**, and none of them is a list
anyone typed in.

The list lives in code at [`src/simulation/genesis/rules.ts`](../src/simulation/genesis/rules.ts)
and in the game in the journal (**B** — *Book of Life*).

| # | Rule | What it produces | Code |
|---|---|---|---|
| I | **Land.** The island is a grid; every standing thing owns the cells under it and no cell holds two things. Living things walk freely. | An ordered map: nothing sprouts inside a hut, no harvest lands on a canal, fields never overlap. | `spatial/occupancy.ts` |
| II | **Body.** Senses → spiking brain → muscles. The world answers only the muscles; the only reward is the body doing better or worse. | All behaviour. | `entities/human.ts`, `brain/network.ts` |
| III | **Growth.** At a moment that matters a brain with room grows one neuron from what stood out in its senses to what it was doing; neurons that stop earning their keep are pruned. | Skills, different in every life, named from their wiring. | `brain/network.ts` (`considerGrowth`), `brain/skills.ts` |
| IV | **Heredity.** Genes cross over and mutate; the grown neurons that served a parent best are born into the child as instincts. | Evolved reflexes nobody designed. | `genetics/evolution.ts`, `inheritInstincts` |
| V | **Drift.** Looks are inherited and nothing selects on them, so they drift; a group that settles apart becomes a people; a people that drifts far enough becomes another. | Peoples with generated names, faces, paint, adornment and building styles. | `game/peoples.ts`, `render/morph.ts` |
| VI | **Time.** Every year a new age begins, drawn from the world's seed, leaning the physics one way and carrying an omen. | An endless run of chapters. | `game/ages.ts` |
| VII | **Fate.** Crises arrive by chance, harder as the settlement grows; the observer may intervene at a price. | Different stories on the same island. | `game/crises.ts`, `game/favour.ts` |

## I. Land — one cell, one object

The island is 176 × 128 one-tile cells. A plant, a food pile or a length of
canal owns one cell; a field or a building owns a 3 × 3 square. A seed takes
only in an empty cell and grows at its centre; a harvest, a carcass or a gift of
food lands on the nearest free cell; a field, a canal or a building clears the
grass and bushes under it but is refused by a tree. People and predators are not
on the grid — they walk across it freely, which is what keeps the movement
organic while the landscape reads as ordered. Press **G** to see the grid.

The grid is rebuilt from the objects at the start of every tick and claimed
incrementally as things appear during it, so nothing has to track removals.
Saves from before v3 are snapped to cell centres on load.

## II. Body

Unchanged from v1/v2: 64 sensory channels, a 341-neuron LIF core, 17 motors,
reward-modulated Hebbian plasticity with a valence taken from the body's own
physiology. See [SIMULATION.md](SIMULATION.md).

## III. Growth — neurogenesis

Every brain has 24 extra neuron slots after the motor pool; how many it may use
is a gene (`neurogenesis`, 0–1 of the 24). Once a tick, after plasticity:

1. **Trigger.** |valence| ≥ 0.5 — a sharp gain or loss — and at least 20 s since
   the brain last grew.
2. **Context.** The (up to) three senses that stand out most against their own
   running average (a ~25 s baseline). This matters: measured before the
   baseline existed, nearly every grown neuron listened to "among kin / near a
   partner / touched", which are always on in a village.
3. **Action.** The act that was under way — eating, drinking, resting,
   building, felling, sowing — rather than the gait; a person eating is usually
   also drifting forward, and crediting the legs made every neuron a walking
   rule.
4. **Wiring.** Input weights are set so the same moment recurring drives the
   neuron to ~1.35 (it fires); the output is +0.55 onto the motor after a gain,
   −0.55 after a loss. From then on it is an ordinary plastic neuron.
5. **Credit and pruning.** A running credit grows when the neuron is active
   while things go the way it pushes. After a day, a neuron with credit below
   −0.4, or whose output learning has driven below 0.08, is pruned and its slot
   freed. A full brain makes room by pruning its least useful neuron grown in
   this life.

Everything is deterministic (no randomness, only brain state) and survives a
save/load round trip exactly, including the running baseline and cooldown.

A skill's name is built from its wiring — "Thirst Drink", "Dusk Rest",
"Pain-curbed Felling" — with a sentence: *"When thirsty and water ahead:
drink."* The world keeps a book of every distinct skill grown, who grew it first
and how often it has been grown since. In a 30 000-tick run one world grew 219
distinct skills.

## IV. Heredity — instincts

At conception each parent's grown neurons with credit ≥ 0.15 are ranked; the
best two of each (four in all) are written into the child's genome as
`instincts`, nine numbers each (three inputs, the motor, four weights and the
number of generations inherited). Mutation: 8 % are lost, 20 % have their weights
jittered, 5 % have one sense swapped for another. A child is born with them as
grown neurons; if they serve it, they pass on again. The atlas records *Born
knowing*, *Ancestral instinct* (5 generations) and *Instinct of ages* (12).

## V. Drift — looks and peoples

Seven new genes shape the figure — build, head shape, hairstyle (shorn,
cropped, long, braided, crested, knotted), hair colour (natural shades to ochre,
indigo and lime-white dyes), body paint (stripes, dots, band, chevrons), paint
colour and adornment (feather, beads, headband, horns, flower crown). Nothing
selects on them, so they mutate twice as often and twice as far as other genes.
Founders share a look drawn for their world, loosely, so a village starts
coherent and drifts from there.

Everyone belongs to a people; a child to its mother's. Once a day:

- **Divergence.** If a people's members split into two groups (two-means on
  where each spends their days) whose centres are 24+ tiles apart, each a real
  cluster and at least four strong, for two days running, the smaller group is
  a new people with a generated name. From then on it drifts on its own — a
  small group drifts fast (the founder effect).
- **Becoming.** If a whole people's average look has drifted 0.22 (normalised)
  from what it looked like when named, it takes a new name and the chronicle
  records what it used to be.

A people's colour dyes its buildings' thatch, its roof pitch is its own, and a
pennant in its colour stands beside each finished house.

## VI. Time — ages

Every in-game year a new age begins, generated from the seed and its number:
one of 16 traits (Plenty, Long Winters, Thirst, Change, Minds, Hunters, Calm,
Omens, Warmth, Frost, Cradles, Elders, Forests, Long Nights, Healing, Rich
Earth) at 60–140 % strength, a generated name, and an omen — children born,
skills grown, a new people, people alive at the end, fields sown, atlas
discoveries — sized to the population at the start of the age. A fulfilled
omen pays favour. Traits always lean on the charter's base rules, so ages never
compound. The same seed meets the same ages; there is no last one.

## What this is not

- It is not open-ended evolution in the research sense: the rules are fixed, the
  motor repertoire is fixed (17 muscles), and a grown neuron can only wire
  senses to one muscle.
- The credit assignment for a grown neuron (the act under way when the valence
  arrived) is a heuristic. It produces odd skills as well as sensible ones, and
  the pruning is what removes the odd ones that cost the body.
- Peoples are descriptions: nothing in a person's behaviour reads which people
  they belong to.

## Measured

8 seeds × 150 000 ticks with every v3 rule on: 7 thriving, 1 declining,
0 extinct; three worlds reached era III. Details in
[IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).
