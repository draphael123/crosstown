// CROSSTOWN — renderer, shell, input and HUD. The sim lives in sim.js and
// knows nothing about any of this.

import * as THREE from '../vendor/three.module.js';
import * as S from './sim.js';

const { W, H, Z, T, idx } = S;

const ELEV = 2.0;          // world units per unit of sim elevation
const GRES = 4;            // ground-texture texels per tile
const TICK_HZ = 3;         // sim ticks per second at Run
const AUTOSAVE_SEC = 60;
const LS = { settings: 'crosstown.settings', slots: 'crosstown.slots', last: 'crosstown.last', save: 'crosstown.save.' };

let city = null;                       // the live sim
let current = { slotId: null, name: 'Crosstown' };
let playing = false;

// ------------------------------------------------------------------ naming
const NAME_A = ['Wheeler', 'Marlow', 'Cedar', 'Fairmont', 'Brantley', 'Kessler', 'Locust',
  'Ashland', 'Delano', 'Corliss', 'Ranney', 'Sherwood', 'Ambler', 'Quarry', 'Hollis',
  'Pemberton', 'Draeger', 'Stillman', 'Verity', 'Camden'];
const NAME_B = ['Falls', 'Junction', 'Bend', 'Forge', 'Landing', 'Mills', 'Crossing',
  'Basin', 'Springs', 'Works', 'Point', 'Ferry', 'Reach', 'Hollow'];
function nameFor(seed) {
  const r = S.mulberry32(seed ^ 0x5eed);
  return NAME_A[(r() * NAME_A.length) | 0] + ' ' + NAME_B[(r() * NAME_B.length) | 0];
}

// ---------------------------------------------------------------- settings
const DEFAULT_SET = { shadows: 1, scale: 1, haze: 1, smoke: 1, lots: 0, autosave: 1 };
let SET = { ...DEFAULT_SET };
try { Object.assign(SET, JSON.parse(localStorage.getItem(LS.settings) || '{}')); } catch { /* first run */ }
const saveSettings = () => { try { localStorage.setItem(LS.settings, JSON.stringify(SET)); } catch { /* private mode */ } };

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

// A vertical wash rather than a flat plate — the horizon is visible at low zoom
// and a single colour there reads as a missing skybox.
scene.background = (() => {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#7d9ec0');
  grad.addColorStop(0.55, '#a8bfcc');
  grad.addColorStop(1.00, '#d3d3c2');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
// The camera orbits at CAM_DIST, so fog has to START beyond it or the whole
// map sits inside the haze and every colour washes to sky-grey.
const FOG = new THREE.Fog(0xa8bfcc, 150, 420);

const sun = new THREE.DirectionalLight(0xfff2d6, 2.05);
sun.position.set(-46, 62, 34);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.03;
{
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 240; sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52;
}
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe2ee, 0x6b6552, 1.25));

// ------------------------------------------------------------------ camera
const camera = new THREE.OrthographicCamera(-30, 30, 30, -30, 0.1, 500);
const ZOOMS = [16, 26, 42, 66];
const view = { yaw: 0, yawNow: 0, zoom: 2, zoomNow: ZOOMS[2], cx: W / 2, cz: H / 2, tx: W / 2, tz: H / 2 };
const PITCH = 34 * Math.PI / 180;
const CAM_DIST = 150;

function placeCamera() {
  const a = view.yawNow * Math.PI / 180 + Math.PI / 4;
  const hx = Math.cos(PITCH), hy = Math.sin(PITCH);
  camera.position.set(view.cx + Math.cos(a) * CAM_DIST * hx, hy * CAM_DIST, view.cz + Math.sin(a) * CAM_DIST * hx);
  camera.lookAt(view.cx, 0, view.cz);
  sun.target.position.set(view.cx, 0, view.cz);
  sun.position.set(view.cx - 46, 62, view.cz + 34);
  const k = view.zoomNow, ar = innerWidth / innerHeight;
  camera.left = -k * ar; camera.right = k * ar; camera.top = k; camera.bottom = -k;
  camera.updateProjectionMatrix();
}
function onResize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * (SET.scale ? 1 : 0.55));
  renderer.setSize(innerWidth, innerHeight, false);
  placeCamera();
}
addEventListener('resize', onResize);

// ---------------------------------------------------------- ground texture
const hAt = (x, y) => city.terrain[idx(x, y)] === T.WATER ? -0.14 : city.elev[idx(x, y)] * ELEV;
function cornerH(vx, vy) {
  let s = 0, n = 0;
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
    const x = vx + dx, y = vy + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    s += hAt(x, y); n++;
  }
  return n ? s / n : 0;
}

const gTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = W * GRES; cv.height = H * GRES;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;   // unflagged canvas textures render washed out
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { cv, g, tex };
})();

// Farmland, not lawn. A single green makes 25,000 tiles of countryside read as
// one flat sheet; a coarse lattice quantised into five field tones gives the
// patchwork an aerial photograph of 1955 America actually shows.
const FIELD = [
  ['#7c8a58', '#87945f', '#73824f'],   // pasture
  ['#9aa06a', '#a3a874', '#93995f'],   // hay
  ['#8c8355', '#978d5e', '#84794d'],   // stubble
  ['#6f8050', '#78885a', '#687a4a'],   // meadow
  ['#a49b6b', '#ada474', '#9a9162'],   // fallow
];
let fieldLat = null;
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
const fieldOf = (x, y) => FIELD[Math.min(FIELD.length - 1,
  (latAt(fieldLat, x / (W - 1), y / (H - 1)) * FIELD.length) | 0)];

const PAL = {
  water: ['#41708c', '#3a6580', '#4a7a95'],
  shore: ['#a8a077', '#b0a880', '#9d956d'],
  tree: ['#4e6b41', '#587448', '#47623c'],
  road: '#54524c', roadLine: '#b9b29a', kerb: '#6f6c64',
  park: '#5d8348', parkPath: '#a89a76',
  lot: { [Z.R]: '#9aa872', [Z.C]: '#7f96a8', [Z.I]: '#a89a72' },
  plant: '#6a6258',
};
const hash = i => { let h = (i * 2654435761) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const nearWater = (x, y) => {
  for (let k = 0; k < 4; k++) {
    const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && city.terrain[idx(nx, ny)] === T.WATER) return true;
  }
  return false;
};

function paintTile(x, y) {
  const g = gTex.g, i = idx(x, y), px = x * GRES, py = y * GRES;
  const t = city.terrain[i], r = hash(i);

  if (t === T.WATER) { g.fillStyle = PAL.water[(r * 3) | 0]; g.fillRect(px, py, GRES, GRES); return; }

  // Bare ground, shaded a little by height so relief reads even where it is flat.
  // Dry land touching the river gets a silt bank, which is what stops the water
  // reading as a strip of blue paint laid over a lawn.
  const bare = nearWater(x, y) ? PAL.shore[(r * 3) | 0]
    : t === T.TREE ? PAL.tree[(r * 3) | 0] : fieldOf(x, y)[(r * 3) | 0];
  g.fillStyle = bare;
  g.fillRect(px, py, GRES, GRES);
  g.fillStyle = `rgba(255,246,214,${0.05 + Math.min(1, city.elev[i] * 1.7) * 0.10})`;
  g.fillRect(px, py, GRES, GRES);

  if (city.plant[i]) { g.fillStyle = PAL.plant; g.fillRect(px, py, GRES, GRES); return; }

  if (city.park[i]) {
    g.fillStyle = PAL.park; g.fillRect(px, py, GRES, GRES);
    g.fillStyle = PAL.parkPath; g.fillRect(px + 1, py + 1, 1, 1); g.fillRect(px + 2, py + 2, 1, 1);
    return;
  }

  if (city.road[i]) {
    g.fillStyle = PAL.kerb; g.fillRect(px, py, GRES, GRES);
    g.fillStyle = PAL.road; g.fillRect(px, py, GRES, GRES);
    // Centreline stubs toward each paved neighbour, so junctions read as junctions.
    g.fillStyle = PAL.roadLine;
    const c0 = px + (GRES >> 1) - 1, c1 = py + (GRES >> 1) - 1;
    if (x + 1 < W && city.road[idx(x + 1, y)]) g.fillRect(c0 + 1, c1, GRES >> 1, 1);
    if (x > 0 && city.road[idx(x - 1, y)]) g.fillRect(px, c1, GRES >> 1, 1);
    if (y + 1 < H && city.road[idx(x, y + 1)]) g.fillRect(c0, c1 + 1, 1, GRES >> 1);
    if (y > 0 && city.road[idx(x, y - 1)]) g.fillRect(c0, py, 1, GRES >> 1);
    return;
  }

  const z = city.zone[i];
  if (z) {
    g.fillStyle = PAL.lot[z]; g.globalAlpha = city.bld[i] ? 0.95 : 0.62;
    g.fillRect(px, py, GRES, GRES); g.globalAlpha = 1;
    if (!city.bld[i]) {
      g.fillStyle = 'rgba(50,44,30,.38)';
      g.fillRect(px, py, 1, 1); g.fillRect(px + GRES - 1, py + GRES - 1, 1, 1);
    }
    if (SET.lots) {
      g.fillStyle = 'rgba(40,34,22,.32)';
      g.fillRect(px, py, GRES, 1); g.fillRect(px, py, 1, GRES);
    }
  }
  if (city.line[i]) {
    g.fillStyle = '#4b4438';
    g.fillRect(px + (GRES >> 1) - 1, py + (GRES >> 1) - 1, 1, 1);
  }
}

const dirtyTiles = new Set();
function touch(x, y) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) dirtyTiles.add(idx(nx, ny));
  }
}
function paintAll() {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) paintTile(x, y);
  dirtyTiles.clear();
  gTex.tex.needsUpdate = true;
}
function flushGround() {
  if (!dirtyTiles.size) return;
  for (const i of dirtyTiles) paintTile(i % W, (i / W) | 0);
  dirtyTiles.clear();
  gTex.tex.needsUpdate = true;
}

const groundGeo = new THREE.PlaneGeometry(W, H, W, H);
groundGeo.rotateX(-Math.PI / 2);
const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: gTex.tex }));
ground.position.set(W / 2, 0, H / 2);
ground.receiveShadow = true;
scene.add(ground);

function reshapeGround() {
  const pos = groundGeo.attributes.position;
  for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++)
    pos.setY(vy * (W + 1) + vx, cornerH(vx, vy));
  pos.needsUpdate = true;
  groundGeo.computeVertexNormals();
}

// ---------------------------------------------------------------- geometry
// Merge helper: BoxGeometry is indexed, so everything is converted to
// non-indexed triangle soup first and the attribute arrays simply concatenated.
function mergeGeos(list) {
  const geos = list.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
// y is the BASE of each part, not its centre — makes the tables readable.
const box = (w, h, d, x = 0, y = 0, z = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); return g; };
const pyr = (r, h, y) => { const g = new THREE.ConeGeometry(r, h, 4); g.rotateY(Math.PI / 4); g.translate(0, y + h / 2, 0); return g; };
const stack = (r, h, x, y, z) => { const g = new THREE.CylinderGeometry(r * 0.8, r, h, 6); g.translate(x, y + h / 2, z); return g; };

// Three silhouettes per zone per tier. One box per tier makes a block read as a
// tray of sugar cubes; the variety is what sells it as a town from the air.
const VARIANTS = {
  [Z.R]: [
    [() => mergeGeos([box(.56, .38, .56), pyr(.44, .26, .38)]),
     () => mergeGeos([box(.64, .32, .48), pyr(.46, .22, .32)]),
     () => mergeGeos([box(.48, .44, .60), pyr(.40, .24, .44)])],
    [() => mergeGeos([box(.72, .92, .72), pyr(.56, .28, .92)]),
     () => mergeGeos([box(.76, 1.12, .64), box(.28, .16, .28, 0, 1.12)]),
     () => mergeGeos([box(.68, .84, .76), pyr(.54, .24, .84)])],
    [() => mergeGeos([box(.80, 2.10, .80), box(.48, .22, .48, 0, 2.10)]),
     () => mergeGeos([box(.84, 2.70, .68)]),
     () => mergeGeos([box(.74, 1.30, .84), box(.60, 1.10, .70, 0, 1.30)])],
  ],
  [Z.C]: [
    [() => mergeGeos([box(.72, .46, .72), box(.84, .06, .22, 0, .46, .30)]),
     () => mergeGeos([box(.66, .54, .78)]),
     () => mergeGeos([box(.76, .42, .66), box(.80, .07, .80, 0, .42)])],
    [() => mergeGeos([box(.78, 1.20, .78), box(.84, .09, .84, 0, 1.20)]),
     () => mergeGeos([box(.70, 1.55, .70)]),
     () => mergeGeos([box(.82, .95, .72), box(.62, .45, .62, 0, .95)])],
    [() => mergeGeos([box(.80, 2.60, .80), box(.56, .70, .56, 0, 2.60)]),
     () => mergeGeos([box(.66, 3.40, .66), box(.20, .45, .20, 0, 3.40)]),
     () => mergeGeos([box(.86, 1.60, .86), box(.62, 1.70, .62, 0, 1.60)])],
  ],
  [Z.I]: [
    [() => mergeGeos([box(.82, .40, .82), stack(.07, .42, .28, .40, .28)]),
     () => mergeGeos([box(.86, .34, .74)]),
     () => mergeGeos([box(.74, .46, .86), stack(.06, .34, -.24, .46, .22)])],
    [() => mergeGeos([box(.86, .76, .86), stack(.09, .62, .30, .76, -.28)]),
     () => mergeGeos([box(.80, .62, .88), box(.34, .30, .34, -.18, .62)]),
     () => mergeGeos([box(.88, .84, .78), stack(.08, .50, .26, .84, .24)])],
    [() => mergeGeos([box(.88, 1.35, .88), stack(.11, .95, .30, 1.35, .30), stack(.11, .80, -.28, 1.35, -.24)]),
     () => mergeGeos([box(.90, 1.10, .82), box(.50, .60, .50, 0, 1.10), stack(.10, .70, .32, 1.70, 0)]),
     () => mergeGeos([box(.84, 1.60, .90), stack(.12, 1.00, -.26, 1.60, .26)])],
  ],
};
const TINT = {
  [Z.R]: ['#c9b499', '#b9a68c', '#d2c2a6', '#a8917a', '#c2b6a4'],
  [Z.C]: ['#d8d2c2', '#c6c9c6', '#e0dccb', '#b9bfc0', '#cfc8b4'],
  [Z.I]: ['#8d6a58', '#7d6154', '#96786a', '#6e5f57', '#8a7160'],
};

const bmat = new THREE.MeshLambertMaterial();
// Capacity grows on demand: a fixed cap either wastes tens of megabytes on 27
// meshes or silently clips a block the player can see is missing.
const bucket = {};
for (const z of [Z.R, Z.C, Z.I]) {
  bucket[z] = [];
  for (let t = 1; t <= 3; t++) {
    bucket[z][t] = VARIANTS[z][t - 1].map(make => ({ geo: make(), mesh: null, cap: 0 }));
  }
}
function ensureCap(e, need) {
  if (e.mesh && e.cap >= need) return;
  const cap = Math.max(256, 1 << (32 - Math.clz32(Math.max(1, need - 1))));
  if (e.mesh) { scene.remove(e.mesh); e.mesh.dispose(); }
  const m = new THREE.InstancedMesh(e.geo, bmat, cap);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = true; m.receiveShadow = true;
  m.frustumCulled = false; m.count = 0;
  scene.add(m);
  e.mesh = m; e.cap = cap;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1), _col = new THREE.Color();
const YAXIS = new THREE.Vector3(0, 1, 0);

let bldDirty = true;
function rebuildBuildings() {
  // pass 1 — how many of each variant, so capacity is right before filling
  const need = {};
  for (const z of [Z.R, Z.C, Z.I]) { need[z] = [null, [0, 0, 0], [0, 0, 0], [0, 0, 0]]; }
  for (const i of city._zonedList) {
    const t = city.bld[i], z = city.zone[i];
    if (!t || !z) continue;
    need[z][t][(hash(i + 991) * 3) | 0]++;
  }
  for (const z of [Z.R, Z.C, Z.I]) for (let t = 1; t <= 3; t++)
    bucket[z][t].forEach((e, v) => ensureCap(e, need[z][t][v]));

  // pass 2 — fill
  const n = {};
  for (const z of [Z.R, Z.C, Z.I]) n[z] = [null, [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of city._zonedList) {
    const t = city.bld[i], z = city.zone[i];
    if (!t || !z) continue;
    const x = i % W, y = (i / W) | 0, r = hash(i);
    const v = (hash(i + 991) * 3) | 0, e = bucket[z][t][v];
    const k = n[z][t][v]++;
    if (k >= e.cap) continue;
    _q.setFromAxisAngle(YAXIS, ((r * 4) | 0) * Math.PI / 2);
    _v.set(x + 0.5, hAt(x, y), y + 0.5);
    _m.compose(_v, _q, _one);
    e.mesh.setMatrixAt(k, _m);
    const pal = TINT[z];
    _col.set(pal[(r * pal.length) | 0]);
    if (!city.powered[i]) _col.multiplyScalar(0.55);   // a dark building looks dark
    e.mesh.setColorAt(k, _col);
  }
  for (const z of [Z.R, Z.C, Z.I]) for (let t = 1; t <= 3; t++)
    bucket[z][t].forEach((e, v) => {
      if (!e.mesh) return;
      e.mesh.count = Math.min(n[z][t][v], e.cap);
      e.mesh.instanceMatrix.needsUpdate = true;
      if (e.mesh.instanceColor) e.mesh.instanceColor.needsUpdate = true;
    });
  bldDirty = false;
}

// -------------------------------------------------------------------- trees
const treeMesh = (() => {
  const geo = new THREE.ConeGeometry(0.34, 0.9, 5);
  geo.translate(0, 0.45, 0);
  const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), 12000);
  m.castShadow = true; m.frustumCulled = false; m.count = 0;
  scene.add(m);
  return m;
})();
function rebuildTrees() {
  let k = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    if (city.terrain[i] !== T.TREE || k >= 12000) continue;
    const r = hash(i), s = 0.7 + r * 0.7;
    _v.set(x + 0.2 + r * 0.6, hAt(x, y), y + 0.2 + hash(i + 7) * 0.6);
    _q.setFromAxisAngle(YAXIS, r * 6.28);
    _m.compose(_v, _q, new THREE.Vector3(s, 0.8 + r * 0.6, s));
    treeMesh.setMatrixAt(k, _m);
    _col.set(PAL.tree[(r * 3) | 0]).offsetHSL(0, 0, (hash(i + 3) - 0.5) * 0.10);
    treeMesh.setColorAt(k, _col);
    k++;
  }
  treeMesh.count = k;
  treeMesh.instanceMatrix.needsUpdate = true;
  if (treeMesh.instanceColor) treeMesh.instanceColor.needsUpdate = true;
}

// ------------------------------------------------------------------- plants
const plantGroup = new THREE.Group();
const smokeGroup = new THREE.Group();
scene.add(plantGroup, smokeGroup);

const puffTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const rad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  rad.addColorStop(0, 'rgba(228,224,214,.95)');
  rad.addColorStop(1, 'rgba(228,224,214,0)');
  g.fillStyle = rad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
let puffs = [];
function rebuildPlants() {
  plantGroup.clear(); smokeGroup.clear(); puffs = [];
  for (const p of city.plants) {
    const P = S.PLANTS[p.kind];
    const g = new THREE.Group();
    const shed = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.9, 1.85),
      new THREE.MeshLambertMaterial({ color: p.kind === 'coal' ? 0x6f665c : 0x7a7469 }));
    shed.position.y = 0.45; shed.castShadow = true; shed.receiveShadow = true;
    g.add(shed);
    const tops = [];
    for (let k = 0; k < 2; k++) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.25, 2.5, 8),
        new THREE.MeshLambertMaterial({ color: p.kind === 'coal' ? 0x9d8f80 : 0xa8a196 }));
      st.position.set(k ? 0.5 : -0.5, 2.05, k ? 0.45 : -0.45);
      st.castShadow = true;
      g.add(st);
      tops.push(st.position.clone());
    }
    const base = new THREE.Vector3(p.x + P.w / 2, hAt(p.x, p.y), p.y + P.h / 2);
    g.position.copy(base);
    plantGroup.add(g);

    // Plumes. Coal makes more of them and darker.
    const per = p.kind === 'coal' ? 5 : 3;
    for (const top of tops) for (let k = 0; k < per; k++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: puffTex, transparent: true, depthWrite: false,
        color: p.kind === 'coal' ? 0xb9b2a4 : 0xd8d4c8,
      }));
      sp.position.copy(base).add(top).add(new THREE.Vector3(0, 1.3, 0));
      smokeGroup.add(sp);
      puffs.push({ sp, origin: base.clone().add(top).add(new THREE.Vector3(0, 1.3, 0)), phase: k / per + Math.random() * 0.1 });
    }
  }
  smokeGroup.visible = !!SET.smoke;
}
function stepSmoke(dt) {
  if (!SET.smoke) return;
  for (const q of puffs) {
    q.phase += dt * 0.22;
    if (q.phase > 1) q.phase -= 1;
    const t = q.phase;
    q.sp.position.set(q.origin.x + t * 1.9, q.origin.y + t * 4.4, q.origin.z + t * 1.1);
    const s = 0.5 + t * 2.3;
    q.sp.scale.set(s, s, s);
    q.sp.material.opacity = Math.min(1, t * 4) * (1 - t) * 0.55;
  }
}

// ------------------------------------------------------------------ cursor
const cursor = new THREE.Mesh(
  new THREE.BoxGeometry(1, 0.06, 1),
  new THREE.MeshBasicMaterial({ color: 0xfff4d0, transparent: true, opacity: 0.6, depthTest: false })
);
cursor.renderOrder = 5;
cursor.visible = false;
scene.add(cursor);

// ------------------------------------------------------------- world setup
function applyWorld() {
  fieldLat = (() => {
    const rnd = S.mulberry32(city.seed ^ 0xf1e1d), n = 15, a = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) a[i] = rnd();
    return { n, a };
  })();
  reshapeGround();
  paintAll();
  rebuildTrees();
  rebuildPlants();
  rebuildBuildings();
}

// ---------------------------------------------------------------- settings
const OPTS = [
  { k: 'shadows', lab: 'Cast shadows', sub: 'Sunlight and building shadows' },
  { k: 'scale', lab: 'Render detail', sub: 'Lower this if the map stutters', on: 'Full', off: 'Half' },
  { k: 'haze', lab: 'Distance haze', sub: 'Atmospheric fade at the map edge' },
  { k: 'smoke', lab: 'Stack smoke', sub: 'Plumes from the generating stations' },
  { k: 'lots', lab: 'Lot lines', sub: 'Survey boundaries drawn on zoned land' },
  { k: 'autosave', lab: 'Autosave', sub: 'File the city every minute' },
];
function applySettings() {
  renderer.shadowMap.enabled = !!SET.shadows;
  scene.fog = SET.haze ? FOG : null;
  smokeGroup.visible = !!SET.smoke;
  // Fog and shadow are compiled into the shader, so every material has to be
  // told to rebuild or the toggle does nothing until something else changes.
  scene.traverse(o => {
    if (!o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.needsUpdate = true;
  });
  onResize();
}
function buildOptList() {
  const el = document.getElementById('optList');
  el.innerHTML = '';
  for (const o of OPTS) {
    const row = document.createElement('div');
    row.className = 'opt';
    row.innerHTML = `<div class="lab">${o.lab}<i>${o.sub}</i></div>
      <div class="seg"><button data-v="1">${o.on || 'On'}</button><button data-v="0">${o.off || 'Off'}</button></div>`;
    const [bOn, bOff] = row.querySelectorAll('.seg button');
    const sync = () => { bOn.classList.toggle('on', !!SET[o.k]); bOff.classList.toggle('on', !SET[o.k]); };
    bOn.onclick = () => { SET[o.k] = 1; sync(); saveSettings(); applySettings(); if (o.k === 'lots') paintAll(); };
    bOff.onclick = () => { SET[o.k] = 0; sync(); saveSettings(); applySettings(); if (o.k === 'lots') paintAll(); };
    sync();
    el.appendChild(row);
  }
}

// ------------------------------------------------------------------- saves
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const listSlots = () => readJSON(LS.slots, []);
function writeSlots(l) { try { localStorage.setItem(LS.slots, JSON.stringify(l)); } catch { /* full */ } }

function saveCity(slotId, name) {
  const id = slotId || 'c' + Date.now().toString(36);
  try {
    localStorage.setItem(LS.save + id, JSON.stringify(S.serialize(city, name)));
  } catch {
    toast('No room to file it'); return null;
  }
  const slots = listSlots().filter(s => s.id !== id);
  slots.unshift({ id, name, seed: city.seed, pop: city.pop.res, rank: S.MILESTONES[city.rank].title, at: Date.now() });
  writeSlots(slots);
  try { localStorage.setItem(LS.last, id); } catch { /* ignore */ }
  current = { slotId: id, name };
  return id;
}
function loadCity(id) {
  const blob = readJSON(LS.save + id, null);
  const c = blob && S.deserialize(blob);
  if (!c) { toast('That file is unreadable'); return false; }
  city = c;
  current = { slotId: id, name: blob.name || nameFor(c.seed) };
  try { localStorage.setItem(LS.last, id); } catch { /* ignore */ }
  enterCity();
  return true;
}
function deleteSlot(id) {
  try { localStorage.removeItem(LS.save + id); } catch { /* ignore */ }
  writeSlots(listSlots().filter(s => s.id !== id));
  if (readJSON(LS.last, null) === id) { try { localStorage.removeItem(LS.last); } catch { /* ignore */ } }
}
const ago = ms => {
  const m = Math.max(0, (Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + ' min ago';
  const h = m / 60;
  if (h < 24) return Math.round(h) + ' hr ago';
  return Math.round(h / 24) + ' days ago';
};

// ------------------------------------------------------------------ screens
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const SHEETS = ['scrTitle', 'scrNew', 'scrLoad', 'scrSettings', 'scrPause'];
let settingsFrom = 'scrTitle';

function show(which) {
  overlay.classList.remove('hide');
  hud.classList.add('hide');
  for (const s of SHEETS) document.getElementById(s).classList.toggle('hide', s !== which);
  if (which === 'scrTitle') refreshTitle();
  if (which === 'scrLoad') refreshSlots();
  if (which === 'scrSettings') buildOptList();
  if (which === 'scrPause') refreshPause();
}
function hideOverlay() {
  overlay.classList.add('hide');
  hud.classList.remove('hide');
}
function refreshTitle() {
  const last = readJSON(LS.last, null);
  const slots = listSlots();
  const s = slots.find(x => x.id === last) || slots[0];
  const btn = document.getElementById('btnContinue');
  btn.disabled = !s;
  document.getElementById('contSub').textContent = s
    ? `${s.name} — ${s.pop.toLocaleString('en-US')} residents, ${ago(s.at)}`
    : 'No city on file yet';
  btn.dataset.id = s ? s.id : '';
  document.getElementById('loadSub').textContent =
    slots.length ? `${slots.length} saved ${slots.length === 1 ? 'city' : 'cities'}` : 'Nothing on file';
}
function refreshSlots() {
  const el = document.getElementById('slotList');
  const slots = listSlots();
  el.innerHTML = '';
  if (!slots.length) { el.innerHTML = '<div class="empty">No cities have been filed.</div>'; return; }
  for (const s of slots) {
    const row = document.createElement('div');
    row.className = 'slot';
    row.innerHTML = `<div class="info"><div class="nm">${escapeHtml(s.name)}</div>
      <div class="meta">${s.pop.toLocaleString('en-US')} residents &nbsp;·&nbsp; ${s.rank} &nbsp;·&nbsp; tract ${s.seed} &nbsp;·&nbsp; ${ago(s.at)}</div></div>
      <div class="act"><button data-a="load">Open</button><button data-a="del" class="del">Discard</button></div>`;
    row.querySelector('[data-a=load]').onclick = () => loadCity(s.id);
    row.querySelector('[data-a=del]').onclick = () => { deleteSlot(s.id); refreshSlots(); };
    el.appendChild(row);
  }
}
function refreshPause() {
  document.getElementById('pauseName').textContent = current.name;
  document.getElementById('pauseSub').textContent =
    `${city.pop.res.toLocaleString('en-US')} residents · ${S.MILESTONES[city.rank].title} · tract ${city.seed}`;
  document.getElementById('saveSub').textContent =
    current.slotId ? 'Overwrite the existing file' : 'Save progress';
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let toastT = 0;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 1600);
}

// enter a city that is already in `city`
function enterCity() {
  applyWorld();
  document.getElementById('mastName').textContent = current.name;
  document.title = 'CROSSTOWN — ' + current.name;
  view.cx = view.tx = W / 2; view.cz = view.tz = H / 2;
  view.yaw = 0; view.yawNow = 0; view.zoom = 2; view.zoomNow = ZOOMS[2];
  lastRank = city.rank;
  playing = true;
  setSpeed(1);
  refreshTools(); updateHUD();
  hideOverlay();
  autosaveAcc = 0;
}
function startNew(name, seed) {
  city = S.makeCity(seed);
  S.stepCity(city);
  current = { slotId: null, name };
  enterCity();
}

// title backdrop: an unbuilt map, slowly turning
function showTitle() {
  playing = false;
  bullEl.innerHTML = '';
  const seed = (Math.random() * 1e6) | 0;
  city = S.makeCity(seed);
  S.stepCity(city);
  lastRank = city.rank;
  applyWorld();
  view.cx = view.tx = W / 2; view.cz = view.tz = H / 2;
  // Close enough that the map's own edge never enters frame — pulled back, the
  // ground reads as a diamond floating in the sky rather than as country.
  view.zoom = 1; view.zoomNow = ZOOMS[1];
  cursor.visible = false;
  show('scrTitle');
}

// -------------------------------------------------------------------- tools
const TOOLS = [
  { id: 'road', k: 'Street', p: '$' + S.COST.road, need: null, sw: '#54524c' },
  { id: 'line', k: 'Wire', p: '$' + S.COST.line, need: null, sw: '#4b4438' },
  { id: 'bulldoze', k: 'Raze', p: '$' + S.COST.bulldoze, need: null, sw: '#9e3b2e' },
  { id: 'zoneR', k: 'Dwelling', p: '$' + S.COST.zone, need: null, sw: '#9aa872' },
  { id: 'zoneC', k: 'Trade', p: '$' + S.COST.zone, need: null, sw: '#7f96a8' },
  { id: 'zoneI', k: 'Works', p: '$' + S.COST.zone, need: null, sw: '#a89a72' },
  { id: 'coal', k: 'Coal Stn', p: '$' + S.PLANTS.coal.cost, need: null, sw: '#6a6258' },
  { id: 'oil', k: 'Oil Stn', p: '$' + S.PLANTS.oil.cost, need: 'plant_oil', sw: '#7a7469' },
  { id: 'park', k: 'Green', p: '$' + S.COST.park, need: 'park', sw: '#5d8348' },
];
let tool = 'road';
const toolsEl = document.getElementById('tools');
TOOLS.forEach((t, n) => {
  const d = document.createElement('div');
  d.className = 'tool'; d.dataset.id = t.id;
  d.innerHTML = `<span class="swatch" style="background:${t.sw}"></span>
    <span class="k">${t.k}</span><span class="p">${t.p}</span>`;
  d.onclick = () => { if (!d.classList.contains('locked')) setTool(t.id); };
  toolsEl.appendChild(d);
  t.el = d; t.hotkey = String(n + 1);
});
function setTool(id) {
  tool = id;
  for (const t of TOOLS) t.el.classList.toggle('on', t.id === id);
}
function refreshTools() {
  for (const t of TOOLS) {
    const locked = t.need && !city.unlocked.has(t.need);
    t.el.classList.toggle('locked', !!locked);
    if (locked && tool === t.id) setTool('road');
  }
}
setTool('road');

// -------------------------------------------------------------------- input
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
// Ray against the terrain: intersect y=0, sample the height there, then
// re-intersect at that height. Two corrections is plenty on relief this gentle.
function pick(ev) {
  ndc.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  let h = 0, x = 0, y = 0;
  for (let k = 0; k < 3; k++) {
    const t = (h - o.y) / d.y;
    x = Math.floor(o.x + d.x * t); y = Math.floor(o.z + d.z * t);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    h = hAt(x, y);
  }
  return { x, y };
}

function apply(x, y) {
  let did = false;
  switch (tool) {
    case 'road': did = S.setRoad(city, x, y); break;
    case 'line': did = S.setLine(city, x, y); break;
    case 'bulldoze': did = S.bulldoze(city, x, y); break;
    case 'zoneR': did = S.setZone(city, x, y, Z.R); break;
    case 'zoneC': did = S.setZone(city, x, y, Z.C); break;
    case 'zoneI': did = S.setZone(city, x, y, Z.I); break;
    case 'park': did = S.setPark(city, x, y); break;
    case 'coal': did = S.placePlant(city, x, y, 'coal'); break;
    case 'oil': did = S.placePlant(city, x, y, 'oil'); break;
  }
  if (!did) return false;
  touch(x, y);
  if (tool === 'coal' || tool === 'oil') { touch(x + 1, y); touch(x, y + 1); touch(x + 1, y + 1); rebuildPlants(); }
  if (tool === 'bulldoze') rebuildPlants();
  bldDirty = true;
  return true;
}

let painting = false, panning = false, panFrom = null, hoverTile = null;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', ev => {
  if (!playing) return;
  canvas.setPointerCapture(ev.pointerId);
  if (ev.button === 2 || ev.button === 1) { panning = true; panFrom = { x: ev.clientX, y: ev.clientY }; return; }
  painting = true;
  const p = pick(ev); if (p) apply(p.x, p.y);
});
canvas.addEventListener('pointermove', ev => {
  if (!playing) return;
  if (panning && panFrom) {
    const dx = ev.clientX - panFrom.x, dy = ev.clientY - panFrom.y;
    panFrom = { x: ev.clientX, y: ev.clientY };
    const a = view.yawNow * Math.PI / 180 + Math.PI / 4;
    const k = view.zoomNow / innerHeight * 2.2;
    view.tx -= (Math.cos(a) * -dy - Math.sin(a) * dx) * k;
    view.tz -= (Math.sin(a) * -dy + Math.cos(a) * dx) * k;
    view.tx = Math.max(0, Math.min(W, view.tx));
    view.tz = Math.max(0, Math.min(H, view.tz));
    return;
  }
  const p = pick(ev);
  if (p) {
    cursor.position.set(p.x + 0.5, hAt(p.x, p.y) + 0.10, p.y + 0.5);
    cursor.visible = true;
    if (painting) apply(p.x, p.y);
    hoverTile = p;
  } else { cursor.visible = false; hoverTile = null; }
});
const endPointer = () => { painting = false; panning = false; panFrom = null; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', ev => {
  if (!playing) return;
  ev.preventDefault();
  view.zoom = Math.max(0, Math.min(ZOOMS.length - 1, view.zoom + Math.sign(ev.deltaY)));
}, { passive: false });

const keys = new Set();
addEventListener('keydown', ev => {
  const k = ev.key.toLowerCase();
  if (k === 'escape') {
    ev.preventDefault();
    if (!playing) return;
    if (overlay.classList.contains('hide')) { setSpeed(0); show('scrPause'); }
    else { hideOverlay(); setSpeed(1); }
    return;
  }
  if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
  if (!playing || !overlay.classList.contains('hide')) return;
  keys.add(k);
  if (k === 'q') view.yaw -= 90;
  if (k === 'e') view.yaw += 90;
  if (k === 'z') view.zoom = Math.max(0, view.zoom - 1);
  if (k === 'x') view.zoom = Math.min(ZOOMS.length - 1, view.zoom + 1);
  if (k === ' ') { ev.preventDefault(); setSpeed(speed ? 0 : 1); }
  const t = TOOLS.find(t => t.hotkey === k);
  if (t && !t.el.classList.contains('locked')) setTool(t.id);
});
addEventListener('keyup', ev => keys.delete(ev.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

// -------------------------------------------------------------------- clock
let speed = 1;
function setSpeed(s) {
  speed = s;
  for (const el of document.querySelectorAll('.sp')) el.classList.toggle('on', +el.dataset.sp === s);
}
for (const el of document.querySelectorAll('.sp')) el.onclick = () => setSpeed(+el.dataset.sp);

// ---------------------------------------------------------------- bulletins
const bullEl = document.getElementById('bulletins');
function bulletin(head, body) {
  const d = document.createElement('div');
  d.className = 'bull';
  d.innerHTML = `<div class="h">${escapeHtml(head)}</div><div class="b">${escapeHtml(body)}</div>`;
  bullEl.appendChild(d);
  setTimeout(() => { d.style.transition = 'opacity .6s'; d.style.opacity = '0'; }, 4200);
  setTimeout(() => d.remove(), 4900);
}
const RANK_BLURB = {
  Village: 'The Commission approves construction to two storeys. Public greens authorised.',
  Town: 'A seat of local government is now warranted.',
  City: 'Height limits lifted to three storeys. Oil-fired generation approved.',
  Metropolis: 'The Commission commends the city to the State.',
};

// -------------------------------------------------------------------- HUD
const $ = id => document.getElementById(id);
const money = n => '$' + Math.round(n).toLocaleString('en-US');
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
let lastRank = 0;

function updateHUD() {
  if (!city) return;
  $('funds').textContent = money(city.funds);
  $('pop').textContent = city.pop.res.toLocaleString('en-US');
  $('jobs').textContent = (city.pop.jobsC + city.pop.jobsI).toLocaleString('en-US');
  const net = city.ledger.net, nEl = $('net');
  nEl.textContent = (net >= 0 ? '+' : '−') + money(Math.abs(net)).slice(1);
  nEl.style.color = net >= 0 ? 'var(--green)' : 'var(--stamp)';
  $('rank').textContent = S.MILESTONES[city.rank].title;

  for (const [k, v] of [['dR', city.demand.r], ['dC', city.demand.c], ['dI', city.demand.i]]) {
    const el = $(k), w = Math.abs(v) * 50;
    el.style.width = w + '%';
    el.style.left = v >= 0 ? '50%' : (50 - w) + '%';
    el.style.background = v >= 0 ? 'var(--green)' : 'var(--stamp)';
  }
  const p = city.power;
  $('pwrFill').style.width = p.supply ? Math.min(100, p.draw / p.supply * 100) + '%' : '0%';
  $('pwrFill').style.background = p.short ? 'var(--stamp)' : 'var(--amber)';
  $('pwrVal').textContent = p.draw + ' / ' + p.supply;
  $('pwrLbl').textContent = p.short ? 'Generation short' : 'Generation';
  $('pwrLbl').classList.toggle('short', p.short);
  $('season').textContent = SEASONS[Math.floor(city.t / 12) % 4];

  if (city.rank !== lastRank) {
    // Only while actually playing. Swapping in the title screen's throwaway map
    // is a rank CHANGE too, and it would announce "Township" over the title.
    if (playing) {
      const title = S.MILESTONES[city.rank].title;
      bulletin(title, RANK_BLURB[title] || '');
      refreshTools();
    }
    lastRank = city.rank;
  }
}

// ------------------------------------------------------------ screen wiring
const rollSeed = () => Math.floor(Math.random() * 999999);
$('btnNew').onclick = () => {
  const seed = rollSeed();
  $('inSeed').value = seed;
  $('inName').value = nameFor(seed);
  show('scrNew');
};
$('btnRollSeed').onclick = () => {
  const seed = rollSeed();
  $('inSeed').value = seed;
  $('inName').value = nameFor(seed);
};
$('btnRollName').onclick = () => { $('inName').value = nameFor(rollSeed()); };
$('btnBegin').onclick = () => {
  const seed = Math.abs(parseInt($('inSeed').value, 10) || 1955) % 1000000;
  const name = ($('inName').value || '').trim() || nameFor(seed);
  startNew(name, seed);
};
$('btnNewBack').onclick = () => show('scrTitle');
$('btnLoad').onclick = () => show('scrLoad');
$('btnLoadBack').onclick = () => show('scrTitle');
$('btnContinue').onclick = ev => { const id = ev.currentTarget.dataset.id; if (id) loadCity(id); };
$('btnSettingsT').onclick = () => { settingsFrom = 'scrTitle'; show('scrSettings'); };
$('btnSettingsP').onclick = () => { settingsFrom = 'scrPause'; show('scrSettings'); };
$('btnSetBack').onclick = () => show(settingsFrom);
$('fileBtn').onclick = () => { setSpeed(0); show('scrPause'); };
$('btnResume').onclick = () => { hideOverlay(); setSpeed(1); };
$('btnSave').onclick = () => {
  if (saveCity(current.slotId, current.name)) { toast('City filed'); refreshPause(); }
};
$('btnSaveAs').onclick = () => {
  const name = prompt('File the city under what name?', current.name);
  if (!name) return;
  if (saveCity(null, name.trim().slice(0, 26))) {
    document.getElementById('mastName').textContent = current.name;
    document.title = 'CROSSTOWN — ' + current.name;
    toast('City filed'); refreshPause();
  }
};
$('btnQuit').onclick = () => {
  if (confirm('Close the file? Anything unsaved is lost.')) showTitle();
};

// --------------------------------------------------------------------- loop
// dt-driven throughout: a background tab throttles rAF, and anything built on
// setTimeout would silently run the city at a different speed than the clock.
let last = performance.now(), acc = 0, hudAcc = 0, autosaveAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000); last = now;

  if (!playing) {
    view.yaw += dt * 4.5;                     // slow turntable behind the title
  } else if (overlay.classList.contains('hide')) {
    const a = view.yawNow * Math.PI / 180 + Math.PI / 4;
    const pv = view.zoomNow * 1.6 * dt;
    let fx = 0, fz = 0;
    if (keys.has('w') || keys.has('arrowup')) fz -= 1;
    if (keys.has('s') || keys.has('arrowdown')) fz += 1;
    if (keys.has('a') || keys.has('arrowleft')) fx -= 1;
    if (keys.has('d') || keys.has('arrowright')) fx += 1;
    if (fx || fz) {
      view.tx += (Math.cos(a) * fz + Math.cos(a + Math.PI / 2) * fx) * pv;
      view.tz += (Math.sin(a) * fz + Math.sin(a + Math.PI / 2) * fx) * pv;
      view.tx = Math.max(0, Math.min(W, view.tx));
      view.tz = Math.max(0, Math.min(H, view.tz));
    }
  }

  const k = 1 - Math.pow(0.0022, dt);
  view.cx += (view.tx - view.cx) * k;
  view.cz += (view.tz - view.cz) * k;
  view.yawNow += (view.yaw - view.yawNow) * (playing ? k : 1);
  view.zoomNow += (ZOOMS[view.zoom] - view.zoomNow) * k;
  placeCamera();

  if (playing && speed) {
    acc += dt * TICK_HZ * speed;
    let n = 0;
    while (acc >= 1 && n < 8) { S.stepCity(city); acc -= 1; n++; bldDirty = true; }
  }

  stepSmoke(dt);
  flushGround();
  if (bldDirty) rebuildBuildings();

  hudAcc += dt;
  if (hudAcc > 0.12) { updateHUD(); hudAcc = 0; }

  if (playing && SET.autosave && current.slotId && speed) {
    autosaveAcc += dt;
    if (autosaveAcc > AUTOSAVE_SEC) { autosaveAcc = 0; saveCity(current.slotId, current.name); toast('Autosaved'); }
  }

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------- go
applySettings();
onResize();
showTitle();
requestAnimationFrame(frame);

// Headless handle for tuning from the console, same entry point the test uses.
window.CROSSTOWN = {
  get city() { return city; }, S,
  // Rebuilds everything, not just the sim: a console session that pokes the
  // grids directly bypasses the tool path that keeps the meshes in step.
  sim: (n = 100) => { S.sim(city, n); paintAll(); rebuildPlants(); rebuildBuildings(); updateHUD(); return city.pop; },
  refresh: () => { applyWorld(); updateHUD(); },
  startNew, showTitle, saveCity, loadCity, listSlots, SET,
};
