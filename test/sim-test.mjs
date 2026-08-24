// CROSSTOWN sim test — run with: node test/sim-test.mjs
//
// The first job of this file is the positive control: prove a properly served
// block ACTUALLY BUILDS. Every negative test below ("no power, no growth") is
// worthless if the city never grows under any conditions — it would pass for
// the wrong reason and report a healthy zero.

import {
  makeCity, sim, setRoad, setLine, setZone, placePlant, bulldoze,
  tierCeiling, serialize, deserialize, idx, Z, T, W, H, N, MILESTONES,
} from '../src/sim.js';

let failures = 0;
const ok = (cond, msg, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg + (detail ? '   [' + detail + ']' : ''));
  if (!cond) failures++;
};
const head = s => console.log('\n' + s);
const builtCount = c => { let n = 0; for (let i = 0; i < N; i++) if (c.bld[i] > 0) n++; return n; };

// ---------------------------------------------------------------- fixtures
function isDry(c, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    if (c.terrain[idx(x, y)] === T.WATER) return false;
  }
  return true;
}
// A dry square well away from the river, so terrain never decides a test.
function findDry(c, size) {
  for (let y = 4; y < H - size - 4; y += 2)
    for (let x = 4; x < W - size - 4; x += 2)
      if (isDry(c, x, y, size, size)) return { x, y };
  throw new Error('no dry ' + size + 'x' + size + ' block on this map');
}
// A town plus a clear margin on its left for the generating station, so plants
// can be sited OUT of town. Siting them among the houses drops land value on
// exactly the lots being measured, which quietly turns a power experiment into
// a soot experiment.
function findSite(c, size) {
  const o = findDry(c, size + 8);
  return { px: o.x, x: o.x + 6, y: o.y + 2, size };
}

// A gridiron: avenues every 4 rows, one spine road, lots between them.
// zoneOf(col,row) decides what each lot becomes, so one call builds a mixed town.
function buildTown(c, site, zoneOf, { roads = true, plants = 4 } = {}) {
  const { x: x0, y: y0, px, size } = site;
  c.funds = 1e9;
  if (roads) {
    for (let y = y0; y < y0 + size; y += 4)
      for (let x = x0; x < x0 + size; x++) setRoad(c, x, y);
    for (let y = y0; y < y0 + size; y++) setRoad(c, x0, y);
  }
  for (let y = y0; y < y0 + size; y++)
    for (let x = x0 + 1; x < x0 + size; x++) {
      if (c.road[idx(x, y)]) continue;
      setZone(c, x, y, zoneOf(x - x0, y - y0));
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
  ok(F2.pop.jobsI > 80, 'the works got built', `jobsI=${F2.pop.jobsI}`);
  ok(F2.pop.res > stalled * 3, 'and housing tripled once there were jobs',
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

console.log('\n' + (failures ? `${failures} FAILED` : 'all passed'));
process.exit(failures ? 1 : 0);
