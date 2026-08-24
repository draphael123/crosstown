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
quarter caps those blocks at one storey, permanently, and nothing tells you
that but the buildings.

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

## Making it feel alive

Traffic wanders the road graph — no pathfinding, a car just holds two tiles and
a fraction and picks a neighbour that is not where it came from. Buildings rise
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
    test/sim-test.mjs   47 assertions, positive control first
    vendor/             three.js, vendored — a CDN import map is a dead screen
