// CROSSTOWN — the simulation. Pure, headless, deterministic.
// No DOM and no three.js in this file: `node test/sim-test.mjs` runs all of it.
//
// A frozen 1955. The calendar never advances; the city does.

export const W = 160, H = 160;
export const N = W * H;

export const Z = { NONE: 0, R: 1, C: 2, I: 3 };
export const T = { LAND: 0, WATER: 1, TREE: 2 };

// Why a zoned lot is not building. Without this the failure is silent: a lot
// three tiles too far from pavement looks exactly like one waiting its turn,
// and the player has no way to tell those apart.
export const STALL = {
  OK: 0,          // growing, or about to
  NO_ROAD: 1,     // no frontage within ROAD_REACH
  NO_POWER: 2,    // current does not reach it
  NO_DEMAND: 3,   // nobody wants this kind of building right now
  CAPPED: 4,      // as tall as this land value allows — raise the value
  FULL: 5,        // as tall as the city's charter allows
};
export const STALL_TEXT = {
  1: 'No street frontage',
  2: 'No current',
  3: 'No demand',
  4: 'Land value too low to build higher',
  5: 'Built out',
};

export const idx = (x, y) => y * W + x;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

// ---------------------------------------------------------------- randomness
// Seeded everywhere. A run must be reproducible or the balance numbers are
// noise dressed up as findings.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------- tuning
// Occupancy per tile by zone and tier. Tier 0 is a graded empty lot.
export const CAP = {
  [Z.R]: [0, 8, 26, 78],
  [Z.C]: [0, 6, 20, 58],
  [Z.I]: [0, 10, 30, 76],
};
// Power drawn per tile by zone and tier.
const DRAW = {
  [Z.R]: [0, 2, 5, 12],
  [Z.C]: [0, 3, 8, 20],
  [Z.I]: [0, 6, 16, 38],
};

export const PLANTS = {
  coal: { supply: 2200, cost: 3000, upkeep: 90, soot: 1.0, w: 2, h: 2 },
  oil: { supply: 4400, cost: 6500, upkeep: 190, soot: 0.55, w: 2, h: 2 },
};

export const COST = { road: 12, line: 6, zone: 30, park: 140, bulldoze: 4 };

const ROAD_REACH = 3;       // tiles a lot may sit from pavement and still build
const GROWTH_SAMPLES = 220; // zoned tiles considered per tick
const LV_EVERY = 4;         // ticks between land-value recomputes
const QUARTER = 12;         // ticks per budget quarter

// Population gates. Nothing here can be lost — the city only ratchets up.
//
// These have to clear the PLATEAU of the tier below them. A town built out to
// tier 2 tops out near 4800, so putting the tier-3 gate at 5000 strands the
// player one storey below the unlock that would let them grow. Every gate sits
// comfortably under the ceiling of the tier before it.
export const MILESTONES = [
  { pop: 0, title: 'Township', maxTier: 1, unlock: [] },
  { pop: 350, title: 'Village', maxTier: 2, unlock: ['park'] },
  { pop: 1500, title: 'Town', maxTier: 2, unlock: ['civic_hall'] },
  { pop: 3000, title: 'City', maxTier: 3, unlock: ['plant_oil'] },
  { pop: 12000, title: 'Metropolis', maxTier: 3, unlock: ['civic_tower'] },
];

// ------------------------------------------------------------------ terrain
function makeLattice(rand, n) {
  const a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = rand();
  return { n, a };
}
function latAt(L, u, v) {
  const fx = u * (L.n - 1), fy = v * (L.n - 1);
  const x0 = Math.min(L.n - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(L.n - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(x0 + 1, L.n - 1), y1 = Math.min(y0 + 1, L.n - 1);
  let tx = fx - x0, ty = fy - y0;
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
  const a = L.a[y0 * L.n + x0], b = L.a[y0 * L.n + x1];
  const c = L.a[y1 * L.n + x0], d = L.a[y1 * L.n + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// A river, because every American industrial city has one and it is the
// strongest single thing on the map: it lifts land value on its banks, and it
// is the reason the first mill went where it went.
function riverCentre(u, p) {
  return 0.5 + 0.15 * Math.sin(u * 3.1 + p.a) + 0.07 * Math.sin(u * 7.7 + p.b);
}

export function makeTerrain(seed = 1955) {
  const rand = mulberry32(seed);
  const big = makeLattice(rand, 6), mid = makeLattice(rand, 13), fine = makeLattice(rand, 27);
  const trees = makeLattice(rand, 19);
  const p = { a: rand() * 6.28, b: rand() * 6.28 };

  const terrain = new Uint8Array(N);
  const elev = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), v = y / (H - 1), i = idx(x, y);
      const e = 0.60 * latAt(big, u, v) + 0.30 * latAt(mid, u, v) + 0.10 * latAt(fine, u, v);
      const bank = Math.abs(v - riverCentre(u, p));
      const width = 0.020 + 0.010 * latAt(mid, u * 0.7, 0.4);
      if (bank < width) { terrain[i] = T.WATER; elev[i] = 0; continue; }
      elev[i] = e * 0.35 + Math.min(0.25, (bank - width) * 1.6);
      // Two octaves: one lattice alone lays woodland down in obvious diagonal
      // stripes, which reads as a texture bug rather than as forest.
      const wood = 0.62 * latAt(trees, u * 1.6, v * 1.6) + 0.38 * latAt(fine, u * 3.1, v * 2.7);
      if (wood > 0.60 && bank > width * 1.7) terrain[i] = T.TREE;
    }
  }
  return { terrain, elev, riverPhase: p };
}

// ---------------------------------------------------------------------- city
// The growth RNG keeps its state ON the city rather than in a closure, so a
// saved game resumes on the exact same die roll it was suspended on. Same
// algorithm as mulberry32 — only the storage moves.
function attachRng(c) {
  c.rand = () => {
    c.randState = (c.randState + 0x6D2B79F5) >>> 0;
    let t = Math.imul(c.randState ^ (c.randState >>> 15), 1 | c.randState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return c;
}

export function makeCity(seed = 1955) {
  const { terrain, elev, riverPhase } = makeTerrain(seed);
  const c = {
    seed, riverPhase, randState: (seed ^ 0x9e37) >>> 0,
    w: W, h: H,
    terrain, elev,
    zone: new Uint8Array(N),
    road: new Uint8Array(N),
    line: new Uint8Array(N),
    park: new Uint8Array(N),
    bld: new Uint8Array(N),     // tier 0..3
    plant: new Uint8Array(N),   // 1 = coal footprint, 2 = oil footprint
    powered: new Uint8Array(N),
    stall: new Uint8Array(N),
    districts: [],
    districtOf: new Uint8Array(N),   // 0 = none, else index into districts + 1
    roadDist: new Uint8Array(N).fill(255),
    lv: new Float32Array(N).fill(0.3),
    soot: new Float32Array(N),
    plants: [],                 // {x,y,kind}
    dirtyRoads: true,
    dirtyZones: true,
    roadVersion: 0,
    _zonedList: [],

    t: 0,
    funds: 20000,
    taxRate: 0.07,
    demand: { r: 0.5, c: 0.2, i: 0.6 },
    pop: { res: 0, jobsC: 0, jobsI: 0 },
    power: { supply: 0, draw: 0, short: false },
    ledger: { income: 0, upkeep: 0, net: 0 },
    rank: 0, maxTier: 1,
    unlocked: new Set(['road', 'line', 'plant_coal', 'zone', 'bulldoze']),
    log: [],
  };
  return attachRng(c);
}

// ------------------------------------------------------------- persistence
// Every grid is one byte per tile and overwhelmingly repetitive, so run-length
// encoding takes a 25,600-tile map down to a few hundred pairs. Elevation is a
// pure function of the seed and is never saved; terrain IS saved, because
// razing a wood mutates it.
export const SAVE_VERSION = 1;
const GRIDS = ['terrain', 'zone', 'road', 'line', 'park', 'bld', 'plant'];

function rle(a) {
  const out = [];
  let v = a[0], n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === v) { n++; continue; }
    out.push(v, n); v = a[i]; n = 1;
  }
  out.push(v, n);
  return out;
}
function unrle(list, len) {
  const a = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < list.length; i += 2) {
    const n = list[i + 1];
    a.fill(list[i], p, p + n);
    p += n;
  }
  return a;
}

export function serialize(c, name) {
  const o = {
    v: SAVE_VERSION, seed: c.seed, name,
    t: c.t, funds: c.funds, taxRate: c.taxRate,
    rank: c.rank, maxTier: c.maxTier, randState: c.randState,
    demand: { ...c.demand },
    unlocked: [...c.unlocked],
    plants: c.plants.map(p => ({ x: p.x, y: p.y, kind: p.kind })),
    pop: { ...c.pop },
  };
  for (const g of GRIDS) o[g] = rle(c[g]);
  return o;
}

export function deserialize(o) {
  if (!o || o.v !== SAVE_VERSION) return null;
  const c = makeCity(o.seed);
  for (const g of GRIDS) c[g] = unrle(o[g], N);
  c.t = o.t; c.funds = o.funds; c.taxRate = o.taxRate;
  c.rank = o.rank; c.maxTier = o.maxTier; c.randState = o.randState >>> 0;
  c.demand = { ...o.demand };
  c.unlocked = new Set(o.unlocked);
  c.plants = o.plants.map(p => ({ ...p }));
  c.dirtyRoads = true; c.dirtyZones = true;
  rebuildZonedList(c);
  recomputeRoadDist(c);
  recomputeLandValue(c);
  recomputePower(c);
  tally(c);
  return c;
}

// ------------------------------------------------------------- player edits
const buildable = (c, i) => c.terrain[i] !== T.WATER && !c.plant[i];

export function spend(c, n) { if (c.funds < n) return false; c.funds -= n; return true; }

export function setRoad(c, x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (c.road[i] || !buildable(c, i)) return false;
  if (!spend(c, COST.road)) return false;
  c.road[i] = 1; c.zone[i] = Z.NONE; c.bld[i] = 0; c.park[i] = 0;
  if (c.terrain[i] === T.TREE) c.terrain[i] = T.LAND;
  c.dirtyRoads = true; c.dirtyZones = true;
  return true;
}

export function setLine(c, x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (c.line[i] || c.plant[i] || c.terrain[i] === T.WATER) return false;
  if (!spend(c, COST.line)) return false;
  c.line[i] = 1;
  return true;
}

export function setZone(c, x, y, z) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (c.road[i] || !buildable(c, i) || c.zone[i] === z) return false;
  if (!spend(c, COST.zone)) return false;
  c.zone[i] = z; c.bld[i] = 0; c.park[i] = 0;
  if (c.terrain[i] === T.TREE) c.terrain[i] = T.LAND;   // lots get cleared
  c.dirtyZones = true;
  return true;
}

export function setPark(c, x, y) {
  if (!inBounds(x, y) || !c.unlocked.has('park')) return false;
  const i = idx(x, y);
  if (c.park[i] || c.road[i] || !buildable(c, i)) return false;
  if (!spend(c, COST.park)) return false;
  c.park[i] = 1; c.zone[i] = Z.NONE; c.bld[i] = 0;
  c.dirtyZones = true;
  return true;
}

export function placePlant(c, x, y, kind = 'coal') {
  const P = PLANTS[kind];
  if (!P) return false;
  if (kind === 'oil' && !c.unlocked.has('plant_oil')) return false;
  for (let dy = 0; dy < P.h; dy++) for (let dx = 0; dx < P.w; dx++) {
    if (!inBounds(x + dx, y + dy)) return false;
    const i = idx(x + dx, y + dy);
    if (!buildable(c, i) || c.road[i]) return false;
  }
  if (!spend(c, P.cost)) return false;
  const mark = kind === 'coal' ? 1 : 2;
  for (let dy = 0; dy < P.h; dy++) for (let dx = 0; dx < P.w; dx++) {
    const i = idx(x + dx, y + dy);
    c.plant[i] = mark; c.zone[i] = Z.NONE; c.bld[i] = 0;
    c.line[i] = 0; c.park[i] = 0;
    if (c.terrain[i] === T.TREE) c.terrain[i] = T.LAND;
  }
  c.plants.push({ x, y, kind });
  c.dirtyZones = true;
  return true;
}

export function bulldoze(c, x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (c.plant[i]) {
    const k = c.plants.findIndex(p => {
      const P = PLANTS[p.kind];
      return x >= p.x && y >= p.y && x < p.x + P.w && y < p.y + P.h;
    });
    if (k < 0) return false;
    const p = c.plants[k], P = PLANTS[p.kind];
    if (!spend(c, COST.bulldoze * 4)) return false;
    for (let dy = 0; dy < P.h; dy++) for (let dx = 0; dx < P.w; dx++) c.plant[idx(p.x + dx, p.y + dy)] = 0;
    c.plants.splice(k, 1);
    return true;
  }
  const something = c.road[i] || c.line[i] || c.zone[i] || c.park[i] || c.terrain[i] === T.TREE;
  if (!something) return false;
  if (!spend(c, COST.bulldoze)) return false;
  if (c.road[i]) c.dirtyRoads = true;
  c.road[i] = 0; c.line[i] = 0; c.zone[i] = Z.NONE; c.bld[i] = 0; c.park[i] = 0;
  if (c.terrain[i] === T.TREE) c.terrain[i] = T.LAND;
  c.dirtyZones = true;
  return true;
}

// ------------------------------------------------------------ road distance
// Multi-source BFS out from every paved tile, capped at ROAD_REACH. A lot
// beyond that has no frontage and will never build, however good the land.
function recomputeRoadDist(c) {
  const d = c.roadDist; d.fill(255);
  let frontier = [];
  for (let i = 0; i < N; i++) if (c.road[i]) { d[i] = 0; frontier.push(i); }
  for (let step = 1; step <= ROAD_REACH && frontier.length; step++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        if (d[j] !== 255 || c.terrain[j] === T.WATER) continue;
        d[j] = step; next.push(j);
      }
    }
    frontier = next;
  }
  c.dirtyRoads = false;
  // Bumped rather than flagged: anything downstream that caches the road graph
  // can compare a number it owns instead of trusting every caller to have set a
  // flag. A console session poking the grids directly gets it right for free.
  c.roadVersion++;
}

// ------------------------------------------------------------------- power
// Current runs from a plant through pavement, wire, its own footprint, and any
// standing building. BFS order is also the order the grid browns out in, so a
// shortfall bites the far edge of town first — which is what it should look like.
function recomputePower(c) {
  const seen = c.powered; seen.fill(0);
  let supply = 0;
  for (const p of c.plants) supply += PLANTS[p.kind].supply;

  const order = [];
  const q = [];
  for (const p of c.plants) {
    const P = PLANTS[p.kind];
    for (let dy = 0; dy < P.h; dy++) for (let dx = 0; dx < P.w; dx++) {
      const i = idx(p.x + dx, p.y + dy);
      if (!seen[i]) { seen[i] = 1; q.push(i); }
    }
  }
  const conducts = i => c.road[i] || c.line[i] || c.plant[i] || c.bld[i] > 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (c.bld[i] > 0) order.push(i);
    const x = i % W, y = (i / W) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (seen[j] || !conducts(j)) continue;
      seen[j] = 1; q.push(j);
    }
  }

  // Charge the grid in reach order; whatever supply will not cover gets cut.
  let draw = 0, cut = 0;
  for (const i of order) {
    const need = DRAW[c.zone[i]][c.bld[i]];
    if (draw + need > supply) { seen[i] = 0; cut++; continue; }
    draw += need;
  }
  c.power.supply = supply;
  c.power.draw = draw;
  c.power.short = cut > 0;
}

// -------------------------------------------------------------- land value
// A coarse 40x40 field, blurred. Cheap, and the diffusion is the whole point:
// a park three blocks away should still be worth something to you.
const LVW = W >> 2, LVH = H >> 2;
function blur(src, dst, w, h) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      s += src[ny * w + nx]; n++;
    }
    dst[y * w + x] = s / n;
  }
}
function recomputeLandValue(c) {
  const amen = new Float32Array(LVW * LVH);
  const nuis = new Float32Array(LVW * LVH);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y), ci = (y >> 2) * LVW + (x >> 2);
    if (c.terrain[i] === T.WATER) amen[ci] += 0.30;
    else if (c.terrain[i] === T.TREE) amen[ci] += 0.10;
    if (c.park[i]) amen[ci] += 0.55;
    if (c.zone[i] === Z.C) amen[ci] += 0.10 * c.bld[i];
    if (c.zone[i] === Z.I) nuis[ci] += 0.16 * c.bld[i];
    if (c.plant[i]) nuis[ci] += PLANTS[c.plant[i] === 1 ? 'coal' : 'oil'].soot * 0.45;
  }
  const a2 = new Float32Array(LVW * LVH), n2 = new Float32Array(LVW * LVH);
  blur(amen, a2, LVW, LVH); blur(a2, amen, LVW, LVH); blur(amen, a2, LVW, LVH);
  blur(nuis, n2, LVW, LVH); blur(n2, nuis, LVW, LVH); blur(nuis, n2, LVW, LVH);

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y), ci = (y >> 2) * LVW + (x >> 2);
    const rd = c.roadDist[i];
    const frontage = rd === 0 ? 0 : rd <= ROAD_REACH ? 0.18 - 0.04 * rd : 0;
    const v = 0.30 + 1.05 * a2[ci] - 1.20 * n2[ci] + frontage;
    c.lv[i] = v < 0.02 ? 0.02 : v > 1 ? 1 : v;
    c.soot[i] = n2[ci];
  }
}

// ------------------------------------------------------------------ demand
// Half of everyone works. Industry is the base employer and it exports, so it
// keeps a floor under itself; commerce only serves people who already live here.
//
// HOUSEHOLDS is the one number that decides whether this is a city builder or
// a thermostat. Jobs settle at (WORK_I + WORK_C) x workforce = 0.43 x residents,
// so if each job only ever justified 2.0 residents the loop would converge on a
// fixed population and zoning more land would do nothing at all. At 2.5 there is
// ~7% headroom every cycle: the city keeps wanting to grow, and what actually
// stops it is land, frontage and generation — which are things the player owns.
const HOUSEHOLDS = 2.5;   // residents each job supports
const WORK_I = 0.48;      // share of the workforce industry wants
const WORK_C = 0.38;      // share of the workforce commerce wants

function updateDemand(c) {
  const { res, jobsC, jobsI } = c.pop;
  const workforce = res * 0.5;
  const targetRes = Math.max(40, (jobsC + jobsI) * HOUSEHOLDS);
  const targetI = Math.max(30, workforce * WORK_I);
  const targetC = Math.max(12, workforce * WORK_C);
  const cl = v => v < -1 ? -1 : v > 1 ? 1 : v;
  const goal = {
    r: cl((targetRes - res) / Math.max(60, res * 0.5)),
    c: cl((targetC - jobsC) / Math.max(25, targetC * 0.6)),
    i: cl((targetI - jobsI) / Math.max(30, targetI * 0.6)),
  };
  // Smoothed: demand that snaps makes the RCI meter unreadable.
  c.demand.r += (goal.r - c.demand.r) * 0.15;
  c.demand.c += (goal.c - c.demand.c) * 0.15;
  c.demand.i += (goal.i - c.demand.i) * 0.15;
}

// ------------------------------------------------------------------ growth
export function tierCeiling(c, i) {
  const v = c.lv[i];
  const byValue = v < 0.30 ? 1 : v < 0.58 ? 2 : 3;
  return Math.min(byValue, c.maxTier);
}

// An empty lot draws nothing of its own yet, so it asks whether current
// reaches anything it touches.
function nearPower(c, i) {
  const x = i % W, y = (i / W) | 0;
  for (let k = 0; k < 4; k++) {
    const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
    const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
    if (inBounds(nx, ny) && c.powered[idx(nx, ny)]) return true;
  }
  return false;
}

function growthPass(c) {
  const zoned = c._zonedList;
  if (!zoned.length) return;
  const R = c.rand;
  const samples = Math.min(GROWTH_SAMPLES, zoned.length);
  for (let s = 0; s < samples; s++) {
    const i = zoned[(R() * zoned.length) | 0];
    const z = c.zone[i];
    if (!z) continue;
    const served = c.roadDist[i] <= ROAD_REACH;
    const lit = c.bld[i] > 0 ? c.powered[i] === 1 : nearPower(c, i);
    const d = z === Z.R ? c.demand.r : z === Z.C ? c.demand.c : c.demand.i;

    if (!served || !lit) {
      // Nothing builds off the grid, and what is already there starts to go.
      if (c.bld[i] > 0 && R() < 0.030) c.bld[i]--;
      continue;
    }
    const ceil = tierCeiling(c, i);
    if (d > 0.05 && c.bld[i] < ceil) {
      if (R() < 0.05 + 0.20 * d) c.bld[i]++;
    } else if (c.bld[i] > ceil) {
      if (R() < 0.025) c.bld[i]--;      // land value fell out from under it
    } else if (d < -0.35 && c.bld[i] > 0) {
      if (R() < 0.020) c.bld[i]--;
    }
  }
}

// Same tests the growth pass applies, run over every zoned lot so the map can
// show them. Kept next to growthPass deliberately: if one changes and the other
// does not, the game starts lying to the player about its own rules.
function markStalls(c) {
  const s = c.stall;
  for (const i of c._zonedList) {
    const z = c.zone[i];
    if (!z) { s[i] = STALL.OK; continue; }
    if (c.roadDist[i] > ROAD_REACH) { s[i] = STALL.NO_ROAD; continue; }
    const lit = c.bld[i] > 0 ? c.powered[i] === 1 : nearPower(c, i);
    if (!lit) { s[i] = STALL.NO_POWER; continue; }
    const ceil = tierCeiling(c, i);
    if (c.bld[i] >= ceil) {
      s[i] = ceil >= c.maxTier ? STALL.FULL : STALL.CAPPED;
      continue;
    }
    const d = z === Z.R ? c.demand.r : z === Z.C ? c.demand.c : c.demand.i;
    s[i] = d > 0.05 ? STALL.OK : STALL.NO_DEMAND;
  }
}

// ---------------------------------------------------------------- districts
// A district is a contiguous mass of buildings OF ONE KIND. Flooding over all
// built tiles regardless of zone would swallow the whole road-connected city
// into a single blob and name it once; splitting by zone gives you the terraces,
// downtown and the works as separate places, which is how anyone talks about a
// town anyway.
const DIST_MIN = 14;          // built lots before a cluster earns a name
const DIST_GAP = 2;           // Chebyshev gap still counted as the same mass
const DIST_EVERY = 24;        // ticks between recomputes

const DIST_STEM = ['Ashland', 'Corliss', 'Marlow', 'Wheeler', 'Kessler', 'Brant',
  'Locust', 'Verity', 'Draeger', 'Hollis', 'Camden', 'Pemberton', 'Stillman',
  'Ranney', 'Ambler', 'Sherwood', 'Fairmont', 'Delano'];
const DIST_FORM = {
  [Z.R]: ['{} Terrace', '{} Heights', '{} Row', 'The {} Homes', '{} Park', 'Old {}'],
  [Z.C]: ['{} Square', '{} Street', 'The {} Blocks', 'Downtown {}', '{} Exchange'],
  [Z.I]: ['The {} Works', '{} Yards', '{} Flats', 'The {} Shops', '{} Sidings'],
};
// Named off the lowest tile index in the mass, not the centroid: a centroid
// drifts as the district grows and the place would keep renaming itself.
function districtName(z, anchor) {
  let h = (anchor * 2654435761) >>> 0; h ^= h >>> 13;
  const forms = DIST_FORM[z];
  return forms[(h >>> 0) % forms.length].replace('{}', DIST_STEM[(h >>> 7) % DIST_STEM.length]);
}

export function computeDistricts(c) {
  const seen = new Uint8Array(N);
  const out = [];
  const stack = [];
  const member = c.districtOf;
  member.fill(0);
  const cells = [];
  for (const start of c._zonedList) {
    if (seen[start] || !c.bld[start]) continue;
    const z = c.zone[start];
    if (!z) continue;
    seen[start] = 1; stack.length = 0; stack.push(start);
    cells.length = 0;
    let n = 0, sx = 0, sy = 0, anchor = start, pop = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i / W) | 0;
      n++; sx += x; sy += y; cells.push(i);
      pop += CAP[z][c.bld[i]];
      if (i < anchor) anchor = i;
      for (let dy = -DIST_GAP; dy <= DIST_GAP; dy++) for (let dx = -DIST_GAP; dx <= DIST_GAP; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        if (seen[j] || c.zone[j] !== z || !c.bld[j]) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    if (n < DIST_MIN) continue;
    // 255 districts is far more than any map produces, and a byte per tile
    // keeps the lookup free for the query tool.
    if (out.length < 255) { const tag = out.length + 1; for (const i of cells) member[i] = tag; }
    out.push({ zone: z, n, pop, x: sx / n, y: sy / n, anchor, name: districtName(z, anchor) });
  }
  c.districts = out;
  return out;
}
export const districtAt = (c, i) => c.districts[c.districtOf[i] - 1] || null;

function rebuildZonedList(c) {
  if (!c.dirtyZones) return;
  const list = [];
  for (let i = 0; i < N; i++) if (c.zone[i]) list.push(i);
  c._zonedList = list;
  c.dirtyZones = false;
}

function tally(c) {
  let res = 0, jobsC = 0, jobsI = 0;
  for (const i of c._zonedList) {
    const t = c.bld[i]; if (!t) continue;
    if (!c.powered[i]) continue;              // a dark building houses nobody
    const z = c.zone[i];
    if (z === Z.R) res += CAP[Z.R][t];
    else if (z === Z.C) jobsC += CAP[Z.C][t];
    else if (z === Z.I) jobsI += CAP[Z.I][t];
  }
  c.pop.res = res; c.pop.jobsC = jobsC; c.pop.jobsI = jobsI;
}

function budget(c) {
  const { res, jobsC, jobsI } = c.pop;
  const income = res * c.taxRate * 3.2 + jobsC * c.taxRate * 4.0 + jobsI * c.taxRate * 3.4;
  let upkeep = 0;
  for (let i = 0; i < N; i++) {
    if (c.road[i]) upkeep += 0.40;
    if (c.line[i]) upkeep += 0.15;
    if (c.park[i]) upkeep += 3.0;
  }
  for (const p of c.plants) upkeep += PLANTS[p.kind].upkeep;
  c.ledger = { income, upkeep, net: income - upkeep };
  c.funds += income - upkeep;
}

function checkRank(c) {
  for (let r = c.rank + 1; r < MILESTONES.length; r++) {
    if (c.pop.res < MILESTONES[r].pop) break;
    c.rank = r;
    c.maxTier = Math.max(c.maxTier, MILESTONES[r].maxTier);
    for (const u of MILESTONES[r].unlock) c.unlocked.add(u);
    c.log.push({ t: c.t, title: MILESTONES[r].title });
  }
}

// -------------------------------------------------------------------- tick
export function stepCity(c) {
  rebuildZonedList(c);
  if (c.dirtyRoads) recomputeRoadDist(c);
  if (c.t % LV_EVERY === 0) recomputeLandValue(c);
  recomputePower(c);
  tally(c);
  updateDemand(c);
  growthPass(c);
  recomputePower(c);
  tally(c);
  markStalls(c);
  checkRank(c);
  if (c.t % DIST_EVERY === 0) computeDistricts(c);
  if (c.t > 0 && c.t % QUARTER === 0) budget(c);
  c.t++;
  return c;
}

// Headless convenience: CROSSTOWN.sim(200) in the console, or from the test.
export function sim(c, ticks = 100) { for (let k = 0; k < ticks; k++) stepCity(c); return c; }
