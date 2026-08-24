# CROSSTOWN

**SimCity, frozen in 1955.** No clock, no ending, no fail state. You are an
unelected commissioner of a city planning board, handed 160×160 tiles of
American river country and told to make a city of it.

    python CROSSTOWN/serve.py 5825      →  http://localhost:5825
    node test/sim-test.mjs              →  the whole sim, headless

Repo: <https://github.com/draphael123/crosstown>
Live: <https://crosstown-daniel-8982s-projects.vercel.app>

Two deploy notes. The directory is uppercase, so `vercel` derives an invalid
project name from it and refuses — deploy with `npx vercel@latest --prod --yes
--name crosstown`. And `crosstown.vercel.app` belongs to somebody else, so the
production alias is the longer team-scoped one above.

## What it is

The distinctiveness rides on setting, art, UI and texture rather than on a
novel mechanic — the RCI loop underneath is deliberately the familiar one.
The period is the point: nobody has made this era well, so the 1950s detail
has to carry it.

| | |
|---|---|
| Role | Unelected planning commissioner |
| Control | Hybrid — zone R/C/I, hand-place streets, wire, plants, greens |
| Progression | Population milestones unlock building tiers and instruments |
| Camera | Fixed isometric pitch, 4-way snap rotate, 4 zoom steps |
| UI | 1950s municipal paperwork — manila, typewriter, rubber stamps |
| Voice | Period-boosterish. It never winks. |

## The loop

Zone a lot, run a street to it, and get current to it. A lot needs all three
or it stays a surveyed rectangle forever:

- **frontage** — within 3 tiles of pavement, or it never builds
- **current** — power runs from a plant through streets, wire and buildings
- **demand** — the R/C/I meter, which answers what you have already built

Land value decides how *tall* a lot may go; the milestone gate decides the
ceiling over the whole city. Riverbank and greens lift value, works and coal
smoke drop it — so a coal station dropped in the middle of a residential
quarter caps those blocks at one storey, permanently.

**Woodland is an obstacle, not scenery.** Nothing may be built on standing
trees; fell them with Raze first, at a higher price than scraping a lot. The
cursor turns red where the tool would be refused. Felling also removes the
amenity the trees were adding, so clearing a wood costs you twice.

## Three grades of road

The thing you draw most used to be the thing you never made a decision about.
There is still no traffic model — the cars are decoration — so the trade-off
runs on the two levers the sim already has: how far back a lot can sit, and
what the road does to the land beside it.

| | cost | upkeep | frontage reach | land value |
|---|---|---|---|---|
| **Dirt track** | $4 | 0.12 | 2 lots | slight penalty |
| **Street** | $12 | 0.40 | 3 lots | neutral |
| **Boulevard** | $40 | 1.20 | 4 lots | planted median, bonus |

Measured over one identical town built three times, differing only in grade:
dirt reaches 2,022 residents, street 5,348, boulevard 8,788. That spread was
deliberately tuned **down** — at the first numbers the boulevard reached 9,828
against dirt's 1,329, which is not a trade-off, it is a dominant strategy.
Boulevard now costs 3.3x a street grid and 3x its upkeep for roughly 1.6x the
city, which is a decision rather than an answer.

## Shacks

A tier-1 dwelling on land below `SHACK_LV` is built as a shack — smaller, flat-
or lean-roofed, drab, and housing 3 instead of 8. Without it land value could
only ever *cap* a lot's height; it could never show in what actually got built,
and the worst ground in the city looked exactly like the best.

Worth knowing: shacks need bad land **and** live residential demand. A city
that has reached its equilibrium population will not put up new ones however
foul the ground, because nobody is looking for housing. They show up while a
city is growing into ground it has already spoiled.

## Shell

Title sheet → charter a new city (name + tract number, both rollable) or open
a saved one. **Esc** or the **File** button opens the pause sheet: save, save
under a new name, settings, or close the file.

Saves live in `localStorage`, many slots, listed newest first with population,
rank and tract. A city run-length-encodes to about **9 kb**, so the browser
holds plenty of them. Autosave writes to the current slot once a minute.

The growth RNG keeps its state on the city rather than in a closure, so a
resumed save continues on the exact die roll it was suspended on — test 10
runs both copies 120 ticks past the save point and requires they still match.

Settings: day and night, traffic, sound, shadows, render detail, distance haze,
stack smoke, lot lines, autosave. Fog and shadows are compiled into the shader,
so toggling either forces a material rebuild — without it the switch appears to
do nothing at all.

## The land

Terrain used to be 1.03 world units of relief across the whole tract against a
3.4-unit office tower, with a steepest tile step of 3.5 degrees — a flat plane
with a wobble, on which no grade rule could ever fire. It now runs about 5.2
units with steps up to 27 degrees, from four noise octaves put through a power
curve: the curve flattens the low ground into valley floors you can plat and
leaves the high ground as distinct hills.

- lots refuse ground steeper than `MAX_BUILD_SLOPE`; about 78% of dry land takes a building
- roads climb to `MAX_ROAD_SLOPE`, and cost more the steeper they go
- **bridges** are the one road that goes ON water, and the only way over a river
  that cuts every seed in two

One bug worth recording: the slope test was first folded into the shared
`buildable()` predicate, which roads also call — so pavement was silently held
to the *building* limit and `MAX_ROAD_SLOPE` was dead code.

## Services

By RADIUS, not by network. Power already occupies the source-and-network shape;
giving water the same shape would double the plumbing without adding a new kind
of decision, so there is no water system and won't be.

| | covers | and if it doesn't |
|---|---|---|
| **Schoolhouse** | 17 | dwellings never pass one storey |
| **Fire station** | 15 | blocks burn down |
| **Police station** | 15 | crime drags land value |
| **Church**, **Civic hall** | 13 / 20 | amenity only |

Crime is not its own accumulator — it is what unpoliced housing does to the
ground around it, which the land-value blur already models. Its coefficient is
deliberately tiny (0.008 against industry's 0.16) because housing is *dense*:
industry contributes from a handful of lots per cell, residential can fill all
sixteen, and the same number swamped every other term on the map.

Police used to unlock at Town rank. That was a deadlock: crime held land value
down, which held the tier down, which held population below the rank that would
have unlocked the remedy. A township has a constable from the start.

## Money

Upkeep was tuned until it bites. At the old numbers a well-run city of 9,000 ran
a 2,400/quarter surplus against a 570 bill, and the treasury was a readout.
There is still no fail state: an overdrawn city does not die, its services stop
working until the books are back in order — visible, and reversible.

The tax rate is a lever in the ledger. It pays for the stations and it puts
people off in the same stroke; without the second half the only sane rate would
be the cap.

## Making it feel alive

Traffic wanders the road graph — no pathfinding, a car just holds two tiles and
a fraction and picks a neighbour that is not where it came from. Farmsteads
(barn, silo and house together, not scattered singly — lone pieces read as
render artefacts) sit on open ground and disappear when you plat over them.
Sheds stand beside the low dwellings. Buildings rise
over about a second instead of appearing, and leave dust on the lot on the way
down. Cloud shadows drift, the river runs in bands, coal stacks smoke, and the
light moves through a day while the year stays 1955.

Two things worth knowing if you touch the lighting. `instanceColor` only
multiplies **diffuse**, so a "lit window" colour is still dim under a dim lamp —
the glow has to come from `emissive`, which is uniform per mesh, so it must stay
low or it erases the Lambert shading and the town turns into paper cutouts. And
the reason night first looked flat was not darkness, it was the **missing key
light**: with only a hemisphere lamp a box gets nearly the same value on every
vertical face. Daylight is floored at 0.34 so the sky can go properly dark while
the city stays legible.

## Getting down to the pavement

Six zoom steps rather than four, and **Tab** (or the Street button) drops you to
eye height on the nearest piece of pavement, facing along the street. Drag to
look, WASD to walk, Shift to hurry, **R** to ride along with a passing car.

A separate `PerspectiveCamera`, not the isometric one pushed in close: an
orthographic camera at eye height has no perspective at all, which is exactly
the thing that makes standing in a street feel like standing. The fog range
swaps with it — 150-420 is right for a camera 150 units out and puts the haze
past the edge of the world when your eye is at 0.26.

Pedestrians walk the kerbs on the same wander the cars use, and flocks of birds
turn on lazy circles overhead — the first thing in the scene that moves without
the player having built it.

The ground carries a **detail layer** tiled once per lot and multiplied into its
colour. The tile map is 4 texels per lot, which is fine from the air and becomes
acres of flat wash the moment you stand on it — and flat wash is most of what
makes a rendered landscape look synthetic.

One bug worth recording: `roadList` was refreshed only inside `stepTraffic`, so
turning traffic off in settings left it permanently stale and Street level set
you down in the middle of a field.

## Telling the player what is happening

Every zoned lot carries a stall reason — no frontage, no current, no demand,
capped by land value, built out. Hard blockers get a coloured tick on the lot;
`markStalls` deliberately sits next to `growthPass` and applies the same tests,
because if one changes and the other does not the game starts lying about its
own rules.

Survey sheets (land value, current, smoke) draw through `ImageData` at one texel
per tile and share the ground's displaced geometry, so they drape over the
relief for free. The Inspect tool gives any tile an index card.

Districts are contiguous masses of buildings **of one kind** — flooding over all
built tiles regardless of zone swallows the whole road-connected city into one
blob and names it once. Names derive from the lowest tile index in the mass, not
the centroid, because a centroid drifts as the district grows and the place
would keep renaming itself.

## Sound

Ambience is synthesised at runtime in `src/audio.js` — a country bed and a
traffic bed whose levels follow the city, plus a works whistle, a church bell on
the hour and birds over open ground. No files, nothing to load.

Music is 20 tracks, about **67 minutes**, by Kevin MacLeod under CC BY 4.0,
re-encoded to 96 kbps so the repository stays near 47 MB rather than 170. It
shuffles, never repeats a track back to back, and the clock bar names what is
playing — click it to skip. See `ATTRIBUTION.md`.

**Why none of it is a real 1955 recording:** sound recordings published in 1955
are still under copyright in the United States. The Music Modernization Act
brought pre-1972 recordings under federal protection on a rolling schedule that
has so far only reached the mid-1920s, so anything that sounds like 1955
*because it is 1955* is off limits. These are modern freely-licensed pieces
chosen for period feel.

## The induction

Eleven memoranda from the Commission, in the order a city actually has to be
built: pave, power, connect, zone, wait, work, trade, school, fire station,
books, Village. Non-blocking — nothing locks a tool or stops the clock, because
a tutorial that takes the controls away teaches you to wait rather than to
build. Each memo shows a live count so you can see the game noticing. New cities
only; opening a save means you have played before.

## Two things the tests found

**The demand model was a thermostat.** Residents need jobs and jobs need
residents, so with each job justifying 2.0 residents the loop converged on a
fixed population and zoning more land did nothing at all. `HOUSEHOLDS = 2.5`
leaves ~7% headroom per cycle: the city always wants to grow, and what stops
it is land, frontage and generation — things the player owns. See `sim.js`.

**A milestone gate can strand you.** Tier 3 originally unlocked at 5,000
residents, but a town built out to tier 2 plateaus near 4,800 — you needed the
population to unlock the storey and the storey to get the population. Test 8b
now builds out one full town per tier cap and asserts every gate clears the
plateau below it.

Both were invisible from a screenshot and obvious from the headless run.

## Also worth knowing

- **Two zones out of three still converge.** Houses and works with no commerce
  settle at a few hundred people, because jobs cap at `workforce × 0.48`. Only
  all three tip the loop into growth. The meter says so — C sits pegged.
- Terrain is seeded: `?seed=1955` (default). The city name is derived from it.
- `CROSSTOWN.sim(n)` in the console runs *n* ticks headless and repaints.

## Not in this slice

Water supply, road congestion (the cars are decoration, they do not model
flow), services, crime, education, and civic buildings beyond the generating
stations. The redlining layer is deliberately absent: HOLC maps
graded neighbourhoods that already existed, and there is nothing to grade on a
map you build yourself from bare ground. It needs an inherited city to mean
anything, so it waits until there is one.

## Layout

    index.html          the paperwork UI
    src/sim.js          pure, headless, deterministic — no DOM, no three.js
    src/main.js         renderer, input, HUD
    src/audio.js        synthesised ambience — no assets, nothing to vendor
    test/sim-test.mjs   100+ assertions, positive control first
    vendor/             three.js, vendored — a CDN import map is a dead screen
