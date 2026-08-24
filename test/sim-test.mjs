// CROSSTOWN sim test — run with: node test/sim-test.mjs
//
// The first job of this file is the positive control: prove a properly served
// block ACTUALLY BUILDS. Every negative test below ("no power, no growth") is
// worthless if the city never grows under any conditions — it would pass for
// the wrong reason and report a healthy zero.

import {
  makeCity, sim, setRoad, setLine, setZone, placePlant, bulldoze,
  tierCeiling, serialize, deserialize, computeDistricts, idx, Z, T, W, H, N, MILESTONES, STALL,
  ROAD, ROAD_SPEC, SHACK_LV, CAP_SHACK, isShack, COST, roadCost,
  MAX_BUILD_SLOPE, MAX_ROAD_SLOPE, SVC, SVC_SPEC, placeService, setTax,
  TAX_MIN, TAX_MAX, stepCity,
} from '../src/sim.js';

let failures = 0;
const ok = (cond, msg, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg + (detail ? '   [' + detail + ']' : ''));
  if (!cond) failures++;
};
const head = s => console.log('\n' + s);
const builtCount = c => { let n = 0; for (let i = 0; i < N; i++) if (c.bld[i] > 0) n++; return n; };

// ---------------------------------------------------------------- fixtures
// The FLATTEST dry square on the map, via a summed-area table over "this tile
// refuses building". Terrain now has real relief and roughly a fifth of the dry
// land is too steep to build on, so a fixture that only avoids WATER lands on a
// site full of holes and every measurement downstream turns to noise. This
// picks the best available site and reports how good it was.
function siteScan(c, size) {
  const bad = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    const v = (c.terrain[i] === T.WATER || c.slope[i] > MAX_BUILD_SLOPE) ? 1 : 0;
    bad[(y + 1) * (W + 1) + (x + 1)] = v + bad[y * (W + 1) + (x + 1)]
      + bad[(y + 1) * (W + 1) + x] - bad[y * (W + 1) + x];
  }
  const at = (x, y) => bad[y * (W + 1) + x];
  let best = null, bestN = Infinity;
  for (let y = 4; y <= H - size - 4; y++) for (let x = 4; x <= W - size - 4; x++) {
    const n = at(x + size, y + size) - at(x, y + size) - at(x + size, y) + at(x, y);
    if (n < bestN) { bestN = n; best = { x, y }; }
    if (!bestN) break;
  }
  if (!best) throw new Error('no ' + size + 'x' + size + ' site at all');
  best.bad = bestN;
  return best;
}
const findDry = (c, size) => siteScan(c, size);
// A town plus a clear margin on its left for the generating station, so plants
// can be sited OUT of town. Siting them among the houses drops land value on
// exactly the lots being measured, which quietly turns a power experiment into
// a soot experiment.
function findSite(c, size) {
  const o = findDry(c, size + 8);
  return { px: o.x, x: o.x + 6, y: o.y + 2, size, bad: o.bad };
}

// A gridiron: avenues every 4 rows, one spine road, lots between them.
// zoneOf(col,row) decides what each lot becomes, so one call builds a mixed town.
// Drop a service somewhere near (cx,cy) — spiral out until a tile takes it.
function svcNear(c, cx, cy, kind) {
  for (let r = 0; r < 14; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (placeService(c, cx + dx, cy + dy, kind)) return true;
    }
  return false;
}

function buildTown(c, site, zoneOf, { roads = true, plants = 4, grade = ROAD.STREET, services = true } = {}) {
  const { x: x0, y: y0, px, size } = site;
  c.funds = 1e9;
  // Trees block construction now, so the town clears its site first — exactly
  // what a player has to do.
  for (let y = y0 - 1; y < y0 + size + 1; y++)
    for (let x = px; x < x0 + size + 1; x++)
      if (x >= 0 && y >= 0 && x < W && y < H && c.terrain[idx(x, y)] === T.TREE) bulldoze(c, x, y);
  if (roads) {
    for (let y = y0; y < y0 + size; y += 4)
      for (let x = x0; x < x0 + size; x++) setRoad(c, x, y, grade);
    for (let y = y0; y < y0 + size; y++) setRoad(c, x0, y, grade);
  }
  for (let y = y0; y < y0 + size; y++)
    for (let x = x0 + 1; x < x0 + size; x++) {
      if (c.road[idx(x, y)]) continue;
      setZone(c, x, y, zoneOf(x - x0, y - y0));
    }
  // A schoolhouse, or nothing above one storey will ever be built. The gate is
  // a hard requirement now, so every fixture has to satisfy it exactly as a
  // player would — and the ones that deliberately do not are testing the gate.
  if (services) {
    // TWO schools: one 17-tile radius does not reach the corners of a 28-tile
    // town, and half-covered corners quietly cap at one storey.
    const q = Math.max(4, size >> 2);
    svcNear(c, x0 + q, y0 + q, SVC.SCHOOL);
    svcNear(c, x0 + size - q, y0 + size - q, SVC.SCHOOL);
    svcNear(c, x0 + (size >> 1), y0 + (size >> 1), SVC.FIRE);
    svcNear(c, x0 + (size >> 1) + 2, y0 + (size >> 1), SVC.POLICE);
  }
  // Out of town, on the far side of the margin, wired back to the spine road.
  for (let k = 0; k < plants; k++) {
    const py = y0 + 1 + k * 6;
    if (!placePlant(c, px, py, 'coal')) continue;
    for (let x = px + 2; x <= x0; x++) setLine(c, x, py);
  }
  c.funds = 1e9;
  return c;
}
// findDry only guarantees no WATER. Trees now block construction, so any
// fixture building on raw ground has to fell its site first.
const clearWood = (c, x0, y0, w, h) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++)
    if (x >= 0 && y >= 0 && x < W && y < H && c.terrain[idx(x, y)] === T.TREE) bulldoze(c, x, y);
};
const razeAllPlants = c => { while (c.plants.length) { const p = c.plants[0]; bulldoze(c, p.x, p.y); } };

const thirds = size => cx => cx < size / 3 ? Z.R : cx < 2 * size / 3 ? Z.C : Z.I;
const allR = () => Z.R;

// ============================================================== 1. it builds
head('1. positive control — a served, powered, zoned town actually builds');
const A = makeCity(1955);
{
  const s = findSite(A, 28);
  buildTown(A, s, thirds(28));
  sim(A, 400);
  const { res, jobsC, jobsI } = A.pop;
  console.log(`        pop ${res}  jobsC ${jobsC}  jobsI ${jobsI}  rank ${MILESTONES[A.rank].title}  built ${builtCount(A)}`);
  ok(res > 3000, 'residents grew past three thousand', `res=${res}`);
  ok(jobsC > 400, 'commerce took hold', `jobsC=${jobsC}`);
  ok(jobsI > 600, 'industry took hold', `jobsI=${jobsI}`);
  ok(A.rank >= 3, 'it climbed to City rank and unlocked tier 3', `rank=${MILESTONES[A.rank].title}`);
  ok(builtCount(A) > 400, 'most lots developed, not a lucky few', `built=${builtCount(A)}`);
}

// ========================================================== 2. power is real
head('2. the same town with no plant builds nothing');
{
  const B = makeCity(1955);
  buildTown(B, findSite(B, 28), thirds(28), { plants: 0 });
  sim(B, 400);
  console.log(`        pop ${B.pop.res}  supply ${B.power.supply}`);
  ok(B.pop.res === 0, 'no residents without a power plant', `res=${B.pop.res}`);
  ok(builtCount(B) === 0, 'not one lot developed', `built=${builtCount(B)}`);
}

// =========================================================== 3. roads are real
head('3. lots with no frontage build nothing, even with power');
{
  const C = makeCity(1955);
  const p = findDry(C, 30);
  C.funds = 1e9;
  clearWood(C, p.x, p.y, 20, 20);
  // A solid zoned field, no roads at all, and a plant right in it so current is
  // available — frontage is the only thing missing.
  for (let y = p.y; y < p.y + 20; y++) for (let x = p.x; x < p.x + 20; x++) setZone(C, x, y, Z.R);
  placePlant(C, p.x + 8, p.y + 8, 'coal');
  sim(C, 400);
  console.log(`        pop ${C.pop.res}  supply ${C.power.supply}`);
  ok(C.power.supply > 0, 'the plant is there and supplying', `supply=${C.power.supply}`);
  ok(C.pop.res === 0, 'no residents without road frontage', `res=${C.pop.res}`);
}

// ==================================================== 4. cutting power hurts
head('4. razing every plant under a grown city makes it go dark');
{
  const D = makeCity(1955);
  buildTown(D, findSite(D, 28), thirds(28));
  sim(D, 400);
  const peak = D.pop.res, peakBuilt = builtCount(D);
  razeAllPlants(D);
  sim(D, 1);
  const dark = D.pop.res;
  sim(D, 150);
  console.log(`        peak ${peak} (${peakBuilt} lots) -> dark ${dark} -> 150 ticks later ${builtCount(D)} lots`);
  ok(peak > 3000, 'it was a real city before the lights went out', `peak=${peak}`);
  ok(dark === 0, 'unpowered buildings house nobody');
  ok(builtCount(D) < peakBuilt * 0.5, 'and the buildings themselves decay away',
    `${peakBuilt} -> ${builtCount(D)}`);
}

// ================================================= 5. land value reads the map
head('5. land value — the riverbank beats the smokestack');
{
  const E = makeCity(1955);
  E.funds = 1e9;
  const bank = [];
  for (let y = 6; y < H - 6; y++) for (let x = 6; x < W - 6; x++) {
    const i = idx(x, y);
    if (E.terrain[i] === T.WATER) continue;
    let nearWater = false;
    for (let dy = -3; dy <= 3 && !nearWater; dy++) for (let dx = -3; dx <= 3; dx++)
      if (E.terrain[idx(x + dx, y + dy)] === T.WATER) { nearWater = true; break; }
    if (nearWater) bank.push(i);
  }
  // A filthy industrial quarter, with its own stack right in the middle of it.
  const s = findSite(E, 22);
  buildTown(E, s, () => Z.I);
  placePlant(E, s.x + 10, s.y + 6, 'coal');
  sim(E, 300);
  const works = [];
  for (let y = s.y; y < s.y + 22; y++) for (let x = s.x; x < s.x + 22; x++) works.push(idx(x, y));
  const mean = arr => arr.reduce((t, i) => t + E.lv[i], 0) / arr.length;
  const mb = mean(bank), mw = mean(works);
  console.log(`        riverbank lv ${mb.toFixed(3)}   industrial quarter lv ${mw.toFixed(3)}`);
  ok(bank.length > 200, 'the river actually generated a bank to sample', `n=${bank.length}`);
  ok(mb > mw, 'riverbank land is worth more than the works', `${mb.toFixed(3)} vs ${mw.toFixed(3)}`);
}

// ============================================ 6. demand answers what you built
head('6. demand — an all-residential town starves for work');
{
  const F = makeCity(1955);
  buildTown(F, findSite(F, 28), allR);
  sim(F, 300);
  console.log(`        pop ${F.pop.res}  built ${builtCount(F)}  demand R ${F.demand.r.toFixed(2)} C ${F.demand.c.toFixed(2)} I ${F.demand.i.toFixed(2)}`);
  // The point is the STALL, not the number: a town of nothing but houses builds
  // a few streets of them and then stops, because there is no work.
  ok(F.pop.res > 40, 'some houses did get built', `res=${F.pop.res}`);
  ok(builtCount(F) < 60, 'but it stalled — most lots stayed empty', `built=${builtCount(F)}`);
  ok(F.demand.i > 0.5, 'industrial demand is high — nobody has a job', `dI=${F.demand.i.toFixed(2)}`);
  ok(F.demand.c > 0.3, 'commercial demand is high too', `dC=${F.demand.c.toFixed(2)}`);
  ok(F.demand.r < 0.2, 'residential demand has fallen off', `dR=${F.demand.r.toFixed(2)}`);
}

// ==================================== 6b. and giving it work releases the stall
head('6b. rezoning a third of that town for work lets it grow again');
{
  const F2 = makeCity(1955);
  const s = findSite(F2, 28);
  buildTown(F2, s, allR);
  sim(F2, 300);
  const stalled = F2.pop.res;
  F2.funds = 1e9;
  for (let y = s.y; y < s.y + 28; y++)
    for (let x = s.x + 18; x < s.x + 28; x++) setZone(F2, x, y, Z.I);
  sim(F2, 300);
  console.log(`        stalled at ${stalled} -> with work ${F2.pop.res}  (jobsI ${F2.pop.jobsI}, dC ${F2.demand.c.toFixed(2)})`);
  // A magnitude, not a target: the exact equilibrium moves with the terrain.
  ok(F2.pop.jobsI > 25, 'the works did get built', `jobsI=${F2.pop.jobsI}`);
  ok(F2.pop.res > stalled * 1.5, 'and housing grew markedly once there were jobs',
    `${stalled} -> ${F2.pop.res}`);
  // But houses and works alone still converge: jobs settle at workforce x WORK_I,
  // and 0.24 x residents x HOUSEHOLDS is less than one. Only all three zones
  // together tip the loop into growth — and the meter says so.
  ok(F2.pop.res < 1000, 'two zones out of three still converge on a small town',
    `res=${F2.pop.res}`);
  ok(F2.demand.c > 0.5, 'and commercial demand is pegged, telling you what is missing',
    `dC=${F2.demand.c.toFixed(2)}`);
}

// ============================================== 7. the dice are pinned
head('7. determinism — same seed and same orders give the same city');
{
  const run = () => {
    const G = makeCity(1955);
    buildTown(G, findSite(G, 28), thirds(28));
    sim(G, 300);
    return G.pop;
  };
  const a = run(), b = run();
  console.log(`        run A ${a.res}/${a.jobsC}/${a.jobsI}   run B ${b.res}/${b.jobsC}/${b.jobsI}`);
  ok(a.res === b.res && a.jobsC === b.jobsC && a.jobsI === b.jobsI, 'two identical runs agree exactly');
}

// ======================================== 8. milestones gate building height
head('8. the milestone gate caps height regardless of land value');
{
  const I2 = makeCity(1955);
  const i0 = idx(80, 40);
  I2.lv[i0] = 0.95;
  I2.maxTier = 1;
  ok(tierCeiling(I2, i0) === 1, 'prime land still caps at tier 1 before the gate opens');
  I2.maxTier = 3;
  ok(tierCeiling(I2, i0) === 3, 'and reaches tier 3 once it does');
  I2.lv[i0] = 0.10;
  ok(tierCeiling(I2, i0) === 1, 'poor land caps itself at tier 1 whatever the gate says');
}

// ============================================ 8b. no gate strands the player
head('8b. every milestone is reachable from the tier below it');
{
  // A gate that sits above the plateau of the previous tier is a dead end: you
  // need the population to unlock the storey, and the storey to get the
  // population. Build out one full town per tier cap and check each gate clears.
  for (let r = 1; r < MILESTONES.length - 1; r++) {
    const cap = MILESTONES[r - 1].maxTier;
    const c = makeCity(1955);
    buildTown(c, findSite(c, 28), thirds(28));
    // Freeze the ladder at the previous tier and let it build out completely.
    const frozen = () => { c.maxTier = Math.min(c.maxTier, cap); };
    for (let k = 0; k < 600; k++) { frozen(); sim(c, 1); }
    const plateau = c.pop.res, gate = MILESTONES[r].pop;
    console.log(`        tier ${cap} plateau ${plateau}  vs  ${MILESTONES[r].title} gate ${gate}`);
    ok(plateau > gate, `${MILESTONES[r].title} is reachable at tier ${cap}`, `${plateau} > ${gate}`);
  }
}

// ================================================ 9. generation capacity bites
head('9. power capacity is a real ceiling — more plants, more city');
{
  const mk = plants => {
    const c = makeCity(1955);
    buildTown(c, findSite(c, 28), thirds(28), { plants });
    sim(c, 500);
    return c;
  };
  const one = mk(1), four = mk(4);
  console.log(`        1 plant:  pop ${one.pop.res}  draw ${one.power.draw}/${one.power.supply}  short=${one.power.short}`);
  console.log(`        4 plants: pop ${four.pop.res}  draw ${four.power.draw}/${four.power.supply}  short=${four.power.short}`);
  ok(one.power.short, 'one plant browns the town out', `draw=${one.power.draw}/${one.power.supply}`);
  ok(one.power.draw <= one.power.supply, 'draw never exceeds supply', `${one.power.draw}/${one.power.supply}`);
  ok(four.pop.res > one.pop.res * 1.5, 'four plants carry a much larger city',
    `${one.pop.res} -> ${four.pop.res}`);
}

// ============================================ 10. a save is the same city
head('10. save/load round trip — and the loaded city runs on the same dice');
{
  const K = makeCity(1955);
  buildTown(K, findSite(K, 28), thirds(28));
  sim(K, 260);
  const blob = JSON.parse(JSON.stringify(serialize(K, 'Test City')));
  const L = deserialize(blob);
  ok(!!L, 'the save deserialises at all');
  console.log(`        saved pop ${K.pop.res}  loaded pop ${L.pop.res}  json ${(JSON.stringify(blob).length / 1024) | 0}kb`);
  ok(L.pop.res === K.pop.res && L.pop.jobsC === K.pop.jobsC && L.pop.jobsI === K.pop.jobsI,
    'population survives the round trip', `${K.pop.res} vs ${L.pop.res}`);
  ok(L.funds === K.funds && L.rank === K.rank && L.maxTier === K.maxTier, 'so do funds and rank');
  ok(L.unlocked.size === K.unlocked.size, 'and the unlock set');
  let same = true;
  for (let i = 0; i < N; i++) if (K.bld[i] !== L.bld[i] || K.zone[i] !== L.zone[i] || K.road[i] !== L.road[i]) { same = false; break; }
  ok(same, 'every tile of the map is identical');
  // The whole point of storing randState: resuming must not fork the timeline.
  sim(K, 120); sim(L, 120);
  console.log(`        after 120 more ticks: original ${K.pop.res}  loaded ${L.pop.res}`);
  ok(K.pop.res === L.pop.res && K.pop.jobsI === L.pop.jobsI,
    'and 120 ticks later the two runs are still the same city', `${K.pop.res} vs ${L.pop.res}`);
  ok(JSON.stringify(blob).length < 400 * 1024, 'the save is small enough for localStorage',
    `${(JSON.stringify(blob).length / 1024) | 0}kb`);
}

// ================================== 11. the map can say why a lot won't build
head('11. stall reasons — each failing rule reports itself, not silence');
{
  // No frontage: zone a field, wire it for power, lay no streets at all.
  const P1 = makeCity(1955);
  const a = findDry(P1, 24);
  P1.funds = 1e9;
  clearWood(P1, a.x, a.y, 14, 14);
  for (let y = a.y; y < a.y + 14; y++) for (let x = a.x; x < a.x + 14; x++) setZone(P1, x, y, Z.R);
  placePlant(P1, a.x + 6, a.y + 6, 'coal');
  sim(P1, 30);
  ok(P1.stall[idx(a.x + 1, a.y + 1)] === STALL.NO_ROAD, 'a lot with no street reports NO_ROAD',
    `got ${P1.stall[idx(a.x + 1, a.y + 1)]}`);

  // No current: a proper gridiron town with no generating station at all.
  const P2 = makeCity(1955);
  const s2 = findSite(P2, 20);
  buildTown(P2, s2, thirds(20), { plants: 0 });
  sim(P2, 30);
  ok(P2.stall[idx(s2.x + 2, s2.y + 2)] === STALL.NO_POWER, 'a lot with no plant reports NO_POWER',
    `got ${P2.stall[idx(s2.x + 2, s2.y + 2)]}`);

  // No demand: an all-residential town that has stalled for want of work. Its
  // empty lots are served and lit — the only thing missing is anyone wanting one.
  const P3 = makeCity(1955);
  const s3 = findSite(P3, 28);
  buildTown(P3, s3, allR);
  sim(P3, 300);
  let noDemand = 0, total = 0;
  for (const i of P3._zonedList) {
    if (P3.bld[i]) continue;
    total++;
    if (P3.stall[i] === STALL.NO_DEMAND) noDemand++;
  }
  console.log(`        stalled all-R town: ${noDemand}/${total} empty lots blame demand`);
  ok(noDemand > total * 0.5, 'most empty lots in the stalled town blame demand',
    `${noDemand}/${total}`);

  // Capped vs full: a built-out town at tier 2 with the gate open to 3 should
  // report CAPPED where land value holds it down, FULL where nothing more is possible.
  const P4 = makeCity(1955);
  buildTown(P4, findSite(P4, 28), thirds(28));
  sim(P4, 400);
  const counts = [0, 0, 0, 0, 0, 0];
  for (const i of P4._zonedList) if (P4.bld[i]) counts[P4.stall[i]]++;
  console.log(`        built lots by reason: ok ${counts[0]} road ${counts[1]} power ${counts[2]} demand ${counts[3]} capped ${counts[4]} full ${counts[5]}`);
  ok(counts[STALL.CAPPED] > 0, 'some lots report being capped by land value', `n=${counts[STALL.CAPPED]}`);
  ok(counts[STALL.FULL] > 0, 'and some report being built out', `n=${counts[STALL.FULL]}`);
  ok(counts[STALL.NO_ROAD] === 0 && counts[STALL.NO_POWER] === 0,
    'no standing building claims it lacks a street or current');
}

// ======================================== 12. the city names its own districts
head('12. districts — a grown town names its parts, and the names hold still');
{
  const D2 = makeCity(1955);
  const s = findSite(D2, 28);
  buildTown(D2, s, thirds(28));
  sim(D2, 400);
  const ds = computeDistricts(D2);
  console.log('        ' + ds.map(d => `${d.name} (${d.n} lots)`).join('   '));
  ok(ds.length >= 3, 'the mixed town produced at least three named districts', `n=${ds.length}`);
  ok(ds.every(d => d.n >= 14), 'no district is below the minimum size');
  const zones = new Set(ds.map(d => d.zone));
  ok(zones.size === 3, 'residential, commercial and industrial each got their own',
    `zones=${[...zones].join(',')}`);
  ok(new Set(ds.map(d => d.name)).size === ds.length, 'every district has a distinct name');

  // Names must not wander as the district grows, or the place renames itself
  // every few seconds and stops being a place.
  const before = ds.map(d => d.name).sort().join('|');
  sim(D2, 200);
  const after = computeDistricts(D2).map(d => d.name).sort().join('|');
  console.log(`        after 200 more ticks: ${after === before ? 'unchanged' : after}`);
  ok(after === before, 'the names are the same 200 ticks later');
}

// ================================= 13. the road grade you buy actually matters
head('13. road grades — reach, cost and land value all differ');
{
  // Frontage reach, measured directly: one road tile, count the lots served.
  const reachOf = grade => {
    const c = makeCity(1955);
    const p = findDry(c, 20);
    c.funds = 1e9;
    clearWood(c, p.x, p.y, 14, 14);
    setRoad(c, p.x + 6, p.y + 6, grade);
    sim(c, 2);
    let far = 0;
    for (let d = 1; d <= 5; d++) if (c.served[idx(p.x + 6 + d, p.y + 6)]) far = d;
    return far;
  };
  const rd = reachOf(ROAD.DIRT), rs = reachOf(ROAD.STREET), rb = reachOf(ROAD.BOULEVARD);
  console.log(`        reach — dirt ${rd}  street ${rs}  boulevard ${rb}`);
  ok(rd === 2 && rs === 3 && rb === 4, 'each grade reaches exactly its spec', `${rd}/${rs}/${rb}`);
  ok(ROAD_SPEC[ROAD.DIRT].cost < ROAD_SPEC[ROAD.STREET].cost
    && ROAD_SPEC[ROAD.STREET].cost < ROAD_SPEC[ROAD.BOULEVARD].cost, 'and costs rise with it');

  // Land value: the same town twice, differing only in the grade of its roads.
  const valueOf = grade => {
    const c = makeCity(1955);
    const st = findSite(c, 24);
    buildTown(c, st, thirds(24), { grade });
    sim(c, 320);
    let t = 0, n = 0;
    for (let y = st.y; y < st.y + 24; y++) for (let x = st.x; x < st.x + 24; x++) { t += c.lv[idx(x, y)]; n++; }
    return { lv: t / n, pop: c.pop.res };
  };
  const vd = valueOf(ROAD.DIRT), vs = valueOf(ROAD.STREET), vb = valueOf(ROAD.BOULEVARD);
  for (const [n, v] of [['dirt', vd], ['street', vs], ['boulevard', vb]])
    console.log(`        ${n.padEnd(10)} lv ${v.lv.toFixed(3)}  pop ${String(v.pop).padStart(6)}`);
  ok(vd.lv < vs.lv && vs.lv < vb.lv, 'land value rises with the grade',
    `${vd.lv.toFixed(3)} / ${vs.lv.toFixed(3)} / ${vb.lv.toFixed(3)}`);
  ok(vd.pop < vs.pop && vs.pop < vb.pop, 'and so does population',
    `${vd.pop} / ${vs.pop} / ${vb.pop}`);
  // A principled bound rather than a magic number: the dear grade must never be
  // MORE EFFICIENT PER DOLLAR than the cheap one. If it were, there would be no
  // reason ever to lay anything else and the choice would be decoration.
  const costRatio = ROAD_SPEC[ROAD.BOULEVARD].cost / ROAD_SPEC[ROAD.STREET].cost;
  const popRatio = vb.pop / vs.pop;
  console.log(`        boulevard costs ${costRatio.toFixed(2)}x a street and returns ${popRatio.toFixed(2)}x the city`);
  ok(popRatio < costRatio, 'boulevard is a premium, not a free lunch',
    `${popRatio.toFixed(2)}x city for ${costRatio.toFixed(2)}x cost`);
  ok(vd.pop > 400, 'and dirt is a compromise, not a dead end', `${vd.pop}`);
}

// =============================== 14. woodland is an obstacle, and it can be cut
head('14. trees block construction until they are felled');
{
  const F3 = makeCity(1955);
  F3.funds = 1e9;
  let wood = -1;
  for (let i = 0; i < N; i++) if (F3.terrain[i] === T.TREE) { wood = i; break; }
  ok(wood >= 0, 'the map generated some woodland to test against');
  const wx = wood % W, wy = (wood / W) | 0;

  ok(!setRoad(F3, wx, wy, ROAD.STREET), 'no street may be laid through standing trees');
  ok(!setZone(F3, wx, wy, Z.R), 'no lot may be zoned on standing trees');
  ok(!placePlant(F3, wx, wy, 'coal'), 'no plant may be sited on standing trees');
  ok(F3.terrain[wood] === T.TREE, 'and the refusals left the trees standing');

  const before = F3.funds;
  ok(bulldoze(F3, wx, wy), 'razing fells them');
  ok(before - F3.funds === COST.fell, 'and felling is charged at its own rate',
    `paid ${before - F3.funds}`);
  ok(F3.terrain[wood] === T.LAND, 'the tile is now open ground');
  ok(setRoad(F3, wx, wy, ROAD.STREET), 'and the street can be laid');
}

// ==================================== 15. bad ground builds shacks, not cottages
head('15. shacks — poor land shows in WHAT is built, not only how tall');
{
  // A works quarter with its own coal station in the middle of it: soot drives
  // land value through the floor. Then zone dwellings right in the muck.
  const G3 = makeCity(1955);
  const st = findSite(G3, 26);
  buildTown(G3, st, () => Z.I, { grade: ROAD.DIRT });
  placePlant(G3, st.x + 12, st.y + 8, 'coal');
  sim(G3, 250);
  G3.funds = 1e9;
  for (let y = st.y + 4; y < st.y + 12; y++)
    for (let x = st.x + 8; x < st.x + 16; x++) setZone(G3, x, y, Z.R);
  sim(G3, 250);

  let shacks = 0, cottages = 0, minLv = 1;
  for (const i of G3._zonedList) {
    if (G3.zone[i] !== Z.R || G3.bld[i] !== 1) continue;
    minLv = Math.min(minLv, G3.lv[i]);
    if (isShack(G3, i)) shacks++; else cottages++;
  }
  console.log(`        tier-1 dwellings in the works: ${shacks} shacks, ${cottages} cottages`);
  console.log(`        lowest land value there ${minLv.toFixed(3)} (shack threshold ${SHACK_LV})`);
  ok(shacks > 0, 'the worst ground built shacks', `n=${shacks}`);
  ok(CAP_SHACK < 8, 'and a shack houses fewer people than a cottage', `${CAP_SHACK} vs 8`);

  // On decent ground the same tier is a cottage and never a shack.
  const H3 = makeCity(1955);
  buildTown(H3, findSite(H3, 24), allR);
  sim(H3, 200);
  let badOnGood = 0;
  for (const i of H3._zonedList) if (isShack(H3, i)) badOnGood++;
  ok(badOnGood === 0, 'and a clean residential town builds no shacks at all', `n=${badOnGood}`);
}

// ============================================ 16. the river can be crossed
head('16. bridges — the only road that goes on water');
{
  const B2 = makeCity(1955);
  B2.funds = 1e9;
  let wet = -1;
  for (let i = 0; i < N; i++) if (B2.terrain[i] === T.WATER) { wet = i; break; }
  ok(wet >= 0, 'the map has a river to cross');
  const wx = wet % W, wy = (wet / W) | 0;

  ok(!setRoad(B2, wx, wy, ROAD.STREET), 'a street may not be laid on water');
  ok(!setRoad(B2, wx, wy, ROAD.DIRT), 'nor a dirt track');
  ok(setRoad(B2, wx, wy, ROAD.BRIDGE), 'a bridge may');
  ok(B2.road[wet] === ROAD.BRIDGE, 'and the tile now carries one');

  // The reverse must also hold, or bridges would be a free upgrade on land.
  let dryTile = -1;
  for (let i = 0; i < N; i++) if (B2.terrain[i] === T.LAND && B2.slope[i] < 0.05) { dryTile = i; break; }
  ok(!setRoad(B2, dryTile % W, (dryTile / W) | 0, ROAD.BRIDGE), 'and a bridge may not be built on dry land');

  // A bridge has to actually carry current, or it connects nothing that matters.
  const C2 = makeCity(1955);
  C2.funds = 1e9;
  let span = -1;
  for (let y = 2; y < H - 2 && span < 0; y++) for (let x = 2; x < W - 2; x++) {
    // a west-east run: land, water, land
    if (C2.terrain[idx(x, y)] === T.LAND && C2.terrain[idx(x + 1, y)] === T.WATER
      && C2.terrain[idx(x + 2, y)] === T.WATER && C2.terrain[idx(x + 4, y)] === T.LAND) { span = idx(x, y); break; }
  }
  if (span >= 0) {
    const sx = span % W, sy = (span / W) | 0;
    for (let d = 0; d < 6; d++) {
      const t = C2.terrain[idx(sx + d, sy)];
      if (t === T.TREE) bulldoze(C2, sx + d, sy);
      setRoad(C2, sx + d, sy, t === T.WATER ? ROAD.BRIDGE : ROAD.STREET);
    }
    placePlant(C2, sx - 3, sy, 'coal');
    for (let d = -3; d < 0; d++) setLine(C2, sx + d, sy);
    sim(C2, 4);
    const farSide = idx(sx + 5, sy);
    ok(C2.powered[idx(sx + 2, sy)] === 1, 'current runs out along the bridge deck');
    console.log(`        span at ${sx},${sy} — far bank powered: ${!!C2.powered[farSide]}`);
  } else {
    console.log('        (no short span found on this seed; skipped the current check)');
  }
}

// ================================================ 17. slope is a real limit
head('17. slope — steep ground refuses buildings and dearer roads');
{
  const S2 = makeCity(1955);
  S2.funds = 1e9;
  let steep = -1, flat = -1;
  for (let i = 0; i < N; i++) {
    if (S2.terrain[i] !== T.LAND) continue;
    if (steep < 0 && S2.slope[i] > MAX_BUILD_SLOPE && S2.slope[i] < MAX_ROAD_SLOPE) steep = i;
    if (flat < 0 && S2.slope[i] < 0.02) flat = i;
    if (steep >= 0 && flat >= 0) break;
  }
  ok(steep >= 0, 'the map has ground too steep to build on');
  ok(flat >= 0, 'and ground flat enough to build on');
  const sx = steep % W, sy = (steep / W) | 0;
  ok(!setZone(S2, sx, sy, Z.R), 'no lot may be zoned on a steep hillside');
  ok(setRoad(S2, sx, sy, ROAD.STREET), 'but pavement can still climb it');
  const cheap = roadCost(S2, flat, ROAD.STREET), dear = roadCost(S2, steep, ROAD.STREET);
  console.log(`        a street costs ${cheap} on the flat and ${dear} on the slope`);
  ok(dear > cheap, 'and the earthwork is charged for', `${cheap} -> ${dear}`);

  let tooSteep = -1;
  for (let i = 0; i < N; i++) if (S2.terrain[i] === T.LAND && S2.slope[i] > MAX_ROAD_SLOPE) { tooSteep = i; break; }
  if (tooSteep >= 0) ok(!setRoad(S2, tooSteep % W, (tooSteep / W) | 0, ROAD.DIRT),
    'and the very steepest ground takes no road at all');
  else console.log('        (no ground above the road limit on this seed)');
}

// ================================================= 18. the school gate bites
head('18. schools — no school in reach, no second storey');
{
  const mk = withSchool => {
    const c = makeCity(1955);
    buildTown(c, findSite(c, 26), thirds(26), { services: false });
    // a fire station either way, so only the SCHOOL differs between the two
    const st = findSite(c, 26);
    svcNear(c, st.x + 13, st.y + 13, SVC.FIRE);
    if (withSchool) {
      svcNear(c, st.x + 6, st.y + 6, SVC.SCHOOL);
      svcNear(c, st.x + 20, st.y + 20, SVC.SCHOOL);
    }
    c.funds = 1e9;
    sim(c, 400);
    let maxR = 0;
    for (const i of c._zonedList) if (c.zone[i] === Z.R) maxR = Math.max(maxR, c.bld[i]);
    return { pop: c.pop.res, maxR, rank: MILESTONES[c.rank].title };
  };
  const no = mk(false), yes = mk(true);
  console.log(`        without a school: pop ${no.pop}, tallest dwelling ${no.maxR} storey`);
  console.log(`        with schools    : pop ${yes.pop}, tallest dwelling ${yes.maxR} storeys`);
  ok(no.maxR === 1, 'unschooled dwellings never pass one storey', `got ${no.maxR}`);
  ok(yes.maxR > 1, 'schooled ones do', `got ${yes.maxR}`);
  ok(yes.pop > no.pop * 1.5, 'and the school is worth real population',
    `${no.pop} -> ${yes.pop}`);
}

// ====================================================== 19. things can burn
head('19. fire — uncovered blocks burn, covered ones do not');
{
  const mk = withFire => {
    const c = makeCity(1955);
    const st = findSite(c, 26);
    buildTown(c, st, thirds(26), { services: false });
    svcNear(c, st.x + 6, st.y + 6, SVC.SCHOOL);
    svcNear(c, st.x + 20, st.y + 20, SVC.SCHOOL);
    if (withFire) {
      svcNear(c, st.x + 8, st.y + 8, SVC.FIRE);
      svcNear(c, st.x + 19, st.y + 19, SVC.FIRE);
    }
    c.funds = 1e9;
    sim(c, 400);
    const burnedBefore = c.fires.length;
    sim(c, 1800);
    return { fires: c.fires.length, before: burnedBefore, pop: c.pop.res };
  };
  const bare = mk(false), kept = mk(true);
  console.log(`        no station : ${bare.fires} burnings on record`);
  console.log(`        stationed  : ${kept.fires} burnings on record`);
  ok(bare.fires > 0, 'an unprotected town loses buildings to fire', `n=${bare.fires}`);
  ok(kept.fires < bare.fires, 'and stations cut that down', `${bare.fires} -> ${kept.fires}`);
}

// ============================================= 20. policing shows in the land
head('20. police — unpoliced housing drags the ground down');
{
  const mk = withPolice => {
    const c = makeCity(1955);
    const st = findSite(c, 26);
    buildTown(c, st, thirds(26), { services: false });
    svcNear(c, st.x + 6, st.y + 6, SVC.SCHOOL);
    svcNear(c, st.x + 20, st.y + 20, SVC.SCHOOL);
    if (withPolice) {
      svcNear(c, st.x + 8, st.y + 13, SVC.POLICE);
      svcNear(c, st.x + 18, st.y + 13, SVC.POLICE);
    }
    c.funds = 1e9;
    sim(c, 320);
    // A FIXED rectangle, not "the tiles that happened to build". Averaging over
    // built lots flatters the unpoliced town, because there only the very best
    // ground ever manages to build at all.
    let t = 0, n = 0;
    for (let y = st.y; y < st.y + 26; y++) for (let x = st.x; x < st.x + 26; x++) { t += c.lv[idx(x, y)]; n++; }
    return { lv: t / n, pop: c.pop.res };
  };
  const bare = mk(false), kept = mk(true);
  console.log(`        unpoliced lv ${bare.lv.toFixed(3)} pop ${bare.pop}`);
  console.log(`        policed   lv ${kept.lv.toFixed(3)} pop ${kept.pop}`);
  ok(kept.lv > bare.lv, 'policed ground is worth more', `${bare.lv.toFixed(3)} -> ${kept.lv.toFixed(3)}`);
  ok(kept.pop > bare.pop, 'and carries more people', `${bare.pop} -> ${kept.pop}`);
}

// ================================== 21. money is a constraint, tax is a lever
head('21. budget — upkeep can sink the books, and services go dark when it does');
{
  const c = makeCity(1955);
  const st = findSite(c, 26);
  buildTown(c, st, thirds(26));
  sim(c, 300);
  ok(c.funded, 'a solvent city keeps its services funded');

  // Overspend deliberately: a wall of stations no tax base could carry.
  const baseNet = c.ledger.net;
  let built = 0;
  for (let y = st.y; y < st.y + 24; y += 2)
    for (let x = st.x; x < st.x + 24; x += 2) {
      c.funds += 2000;
      if (placeService(c, x, y, SVC.POLICE)) built++;
    }
  c.funds = 40;
  sim(c, 40);
  console.log(`        quarterly was ${baseNet.toFixed(0)} before; ${built} extra stations added`);
  console.log(`        now quarterly ${c.ledger.net.toFixed(0)}, funds ${c.funds | 0}, funded=${c.funded}`);
  ok(c.ledger.net < 0, 'the quarterly went negative', `${c.ledger.net.toFixed(0)}`);
  ok(c.funds < 0, 'and the treasury followed it under', `${c.funds | 0}`);
  ok(!c.funded, 'which unfunds the services');
  let anyCover = 0;
  for (let i = 0; i < N; i++) if (c.cover[SVC.SCHOOL][i]) anyCover++;
  ok(anyCover === 0, 'an unfunded schoolhouse covers nothing', `n=${anyCover}`);

  // And it is reversible — this is a sandbox, not a death spiral.
  c.funds = 200000;
  sim(c, 20);
  ok(c.funded, 'paying the books back restores them');
}

head('21b. the tax lever cuts both ways');
{
  const run = rate => {
    const c = makeCity(1955);
    buildTown(c, findSite(c, 26), thirds(26));
    setTax(c, rate);
    sim(c, 400);
    return { pop: c.pop.res, income: c.ledger.income, dR: c.demand.r };
  };
  const lo = run(0.03), hi = run(0.18);
  console.log(`        3% tax : pop ${lo.pop}  income ${lo.income.toFixed(0)}`);
  console.log(`        18% tax: pop ${hi.pop}  income ${hi.income.toFixed(0)}`);
  ok(hi.pop < lo.pop, 'a heavy rate puts people off', `${lo.pop} -> ${hi.pop}`);
  ok(setTax(c0Dummy(), 0.9) === TAX_MAX, 'and the rate is clamped at the top');
  ok(setTax(c0Dummy(), -1) === TAX_MIN, 'and at the bottom');
}
function c0Dummy() { return makeCity(1955); }

// ====================== 22. a cottage degrades when the ground goes bad under it
head('22. a standing cottage becomes a shack when its ground is spoiled');
{
  const D2 = makeCity(1955);
  const st = findSite(D2, 26);
  buildTown(D2, st, allR);
  sim(D2, 300);
  // Choose the spot FIRST, then watch only the cottages around it. Watching the
  // whole town and then fouling one corner of it measures mostly untouched
  // houses and reports, correctly but uselessly, that nothing changed.
  const cx = st.x + 13, cy = st.y + 13;
  const watched = [];
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) continue;      // the plant's own footprint
    const i = idx(cx + dx, cy + dy);
    if (D2.zone[i] === Z.R && D2.bld[i] === 1 && !isShack(D2, i)) watched.push(i);
  }
  console.log(`        watching ${watched.length} tier-1 cottages on clean ground near ${cx},${cy}`);
  ok(watched.length > 0, 'there are cottages to spoil');

  const lvBefore = watched.reduce((a, i) => a + D2.lv[i], 0) / watched.length;

  // A whole generating yard, not one shed. A single coal station cannot drag an
  // all-residential neighbourhood from 0.5-odd down under the 0.28 threshold,
  // and a test that never crosses the threshold is not testing the rule.
  D2.funds = 1e9;
  let up = 0;
  for (const [ox, oy] of [[0, 0], [3, 0], [0, 3], [3, 3]]) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = idx(cx + ox + dx, cy + oy + dy);
      D2.zone[i] = 0; D2.bld[i] = 0;
    }
    D2.dirtyZones = true;
    if (placePlant(D2, cx + ox, cy + oy, 'coal')) up++;
  }
  ok(up > 0, 'the generating yard goes up among the houses', `n=${up}`);
  sim(D2, 200);
  const lvAfter = watched.reduce((a, i) => a + D2.lv[i], 0) / watched.length;
  console.log(`        land value under them: ${lvBefore.toFixed(3)} -> ${lvAfter.toFixed(3)} (shack below ${SHACK_LV})`);
  ok(lvAfter < lvBefore, 'the ground under them is worth less than it was',
    `${lvBefore.toFixed(3)} -> ${lvAfter.toFixed(3)}`);

  let stillStanding = 0, nowShacks = 0;
  for (const i of watched) {
    if (D2.bld[i] !== 1) continue;
    stillStanding++;
    if (isShack(D2, i)) nowShacks++;
  }
  console.log(`        of those, ${stillStanding} still stand and ${nowShacks} are now shacks`);
  ok(nowShacks > 0, 'cottages that never moved are now shacks', `n=${nowShacks}`);
}

console.log('\n' + (failures ? `${failures} FAILED` : 'all passed'));
process.exit(failures ? 1 : 0);
