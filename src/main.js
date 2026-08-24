// CROSSTOWN — renderer, shell, input and HUD. The sim lives in sim.js and
// knows nothing about any of this.

import * as THREE from '../vendor/three.module.js';
import * as S from './sim.js';
import { makeAudio } from './audio.js';
import { makeTutorial } from './tutorial.js';

const { W, H, N, Z, T, idx } = S;
const TAU = Math.PI * 2;

const ELEV = 1.0;          // sim elevation is already in world units
const GRES = 4;            // ground-texture texels per tile
const TICK_HZ = 3;         // sim ticks per second at Run
const AUTOSAVE_SEC = 60;
const DAY_SEC = 300;       // real seconds for a full day at Run
const RISE_SEC = 0.85;     // how long a building takes to go up
const RUBBLE_SEC = 2.2;
const CAR_MAX = 340;
const LS = { settings: 'crosstown.settings', slots: 'crosstown.slots', last: 'crosstown.last', save: 'crosstown.save.' };

let city = null;
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
const DEFAULT_SET = { shadows: 1, scale: 1, haze: 1, smoke: 1, lots: 0, autosave: 1, daynight: 1, sound: 1, traffic: 1, tutorial: 1, music: 1 };
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
const FOG = new THREE.Fog(0xa8bfcc, 150, 420);
// The iso camera sits 150 units out, so its haze must start beyond that. At eye
// height the same numbers put the fog past the edge of the world.
function setFogFor(m) {
  if (m === 'iso') { FOG.near = 150; FOG.far = 420; }
  else { FOG.near = 6; FOG.far = 105; }
}

const sun = new THREE.DirectionalLight(0xfff2d6, 2.05);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0012;
sun.shadow.normalBias = 0.03;
{
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 260; sc.left = -54; sc.right = 54; sc.top = 54; sc.bottom = -54;
}
const hemi = new THREE.HemisphereLight(0xcfe2ee, 0x6b6552, 1.25);
scene.add(sun, sun.target, hemi);

// ------------------------------------------------------------- day and sky
// Time of day is not the calendar. The year stays 1955; only the light moves.
let dayT = 0.36;            // 0 = midnight, 0.5 = noon
let nightness = 0;
let skyDrawn = -9;

const skyCv = document.createElement('canvas');
skyCv.width = 4; skyCv.height = 256;
const skyCtx = skyCv.getContext('2d');
const skyTex = new THREE.CanvasTexture(skyCv);
skyTex.colorSpace = THREE.SRGBColorSpace;
scene.background = skyTex;

const SKY = {
  night: ['#151f2e', '#1f2d3d', '#2b3d4e'],
  dawn: ['#3d5678', '#9c7a72', '#dcb188'],
  day: ['#7d9ec0', '#a8bfcc', '#d3d3c2'],
};
const mixHex = (a, b, t) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round((pa >> 16) + ((pb >> 16) - (pa >> 16)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
};
function skyStops(t) {
  // Two blends: night→dawn as the sun approaches the horizon, dawn→day after.
  const el = Math.sin((t - 0.25) * TAU);
  const dawnK = Math.min(1, Math.max(0, (el + 0.35) / 0.45));
  const dayK = Math.min(1, Math.max(0, (el - 0.05) / 0.35));
  return SKY.night.map((c, k) => mixHex(mixHex(c, SKY.dawn[k], dawnK), SKY.day[k], dayK));
}
function paintSky(force) {
  if (!force && Math.abs(dayT - skyDrawn) < 0.012) return;
  skyDrawn = dayT;
  const [a, b, c] = skyStops(dayT);
  const g = skyCtx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, a); g.addColorStop(0.55, b); g.addColorStop(1, c);
  skyCtx.fillStyle = g; skyCtx.fillRect(0, 0, 4, 256);
  skyTex.needsUpdate = true;
  FOG.color.set(b);
}
function applyDaylight() {
  const el = Math.sin((dayT - 0.25) * TAU);
  const az = (dayT - 0.25) * TAU;
  // Biased towards daylight, and with a floor under the night: this is a game
  // you build in, and a pitch-dark map you cannot zone on is a worse toy than
  // one with no night at all.
  // Floored at 0.34, so this is an evening rather than a midnight. The SKY is
  // allowed to go properly dark — it is only backdrop — but the city itself has
  // to stay readable, because at full dark every zone colour converges on the
  // same warm smear and you can no longer tell dwellings from works.
  const day = Math.min(1, Math.max(0.34, el * 1.75 + 0.44));
  nightness = 1 - day;
  // A key light at night as well as by day. With only the hemisphere lamp a box
  // gets nearly the same value on every vertical face, so the whole town goes
  // flat — the darkness was never the problem, the missing key light was.
  const moon = Math.max(0, -el);
  sun.intensity = Math.max(0, el) * 2.4 + moon * 0.5;
  sun.color.setHex(el <= 0 ? 0x93aacb : el < 0.28 ? 0xffbe86 : 0xfff2d6);
  hemi.intensity = 0.62 + day * 0.82;
  hemi.color.setHex(day > 0.5 ? 0xcfe2ee : 0x6d86a6);
  hemi.groundColor.setHex(day > 0.5 ? 0x6b6552 : 0x353c46);
  // instanceColor only multiplies DIFFUSE, so a "lit" instance colour is still
  // dark under a dim lamp. The glow has to come from emissive, which is uniform
  // across the mesh — every building gets a little, the powered ones get the
  // warm instance colour on top.
  // Kept low on purpose. Emissive is added flat across every face, so pushing it
  // hard erases the Lambert shading and the whole town turns into paper cutouts;
  // this is just enough to lift the shadow side, and the warm instance colour on
  // the powered lots does the actual work of looking lit.
  // The blanket emissive is gone: lit WINDOWS carry the night now, which is
  // both prettier and does not flatten the Lambert shading the way a uniform
  // glow across every face did.
  setFacadeNight(nightness);
  // Cloud shade follows the sun that casts it. Left at full strength after
  // dark it just drops a flat grey veil over an already dim map.
  cloudPlane.material.opacity = 0.05 + day * 0.16;
  sunAz = az; sunEl = el;
  paintSky(false);
}
let sunAz = 0, sunEl = 1;

// ------------------------------------------------------------------ camera
const camera = new THREE.OrthographicCamera(-30, 30, 30, -30, 0.1, 500);
// Two more steps at the close end than before: at 16 you could see that streets
// had cars on them, but not watch one.
const ZOOMS = [7, 11, 16, 26, 42, 66];
const DEFAULT_ZOOM = 4;
const view = { yaw: 0, yawNow: 0, zoom: DEFAULT_ZOOM, zoomNow: ZOOMS[DEFAULT_ZOOM], cx: W / 2, cz: H / 2, tx: W / 2, tz: H / 2 };

// Street level. A separate perspective camera rather than the iso one pushed in
// close: an orthographic camera at eye height has no perspective at all, which
// is exactly the thing that makes standing in a street feel like standing.
const EYE = 0.26;                                   // ~2m at this map's scale
const camPersp = new THREE.PerspectiveCamera(64, 1, 0.02, 420);
let mode = 'iso';
const walk = { x: W / 2, z: H / 2, yaw: 0, pitch: -0.05, ride: null };
const activeCam = () => (mode === 'iso' ? camera : camPersp);
const inB = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const PITCH = 34 * Math.PI / 180;
const CAM_DIST = 150;

function placeCamera() {
  const a = view.yawNow * Math.PI / 180 + Math.PI / 4;
  const hx = Math.cos(PITCH), hy = Math.sin(PITCH);
  camera.position.set(view.cx + Math.cos(a) * CAM_DIST * hx, hy * CAM_DIST, view.cz + Math.sin(a) * CAM_DIST * hx);
  camera.lookAt(view.cx, 0, view.cz);
  sun.target.position.set(view.cx, 0, view.cz);
  sun.position.set(view.cx + Math.cos(sunAz) * 72, Math.max(9, sunEl * 86), view.cz + Math.sin(sunAz) * 54);
  const k = view.zoomNow, ar = innerWidth / innerHeight;
  camera.left = -k * ar; camera.right = k * ar; camera.top = k; camera.bottom = -k;
  camera.updateProjectionMatrix();
}
function placeWalkCamera() {
  const tx = Math.max(0, Math.min(W - 1, Math.floor(walk.x)));
  const tz = Math.max(0, Math.min(H - 1, Math.floor(walk.z)));
  let ex = walk.x, ez = walk.z, ey = padH(tx, tz) + EYE, yaw = walk.yaw, pitch = walk.pitch;
  if (walk.ride) {
    const c = walk.ride;
    if (!cars.includes(c)) walk.ride = null;
    else {
      const fx = c.from % W, fy = (c.from / W) | 0, tx2 = c.to % W, ty2 = (c.to / W) | 0;
      const dx = tx2 - fx, dz = ty2 - fy;
      ex = fx + 0.5 + dx * c.p - dz * 0.17;
      ez = fy + 0.5 + dz * c.p + dx * 0.17;
      ey = hAt(fx, fy) + (hAt(tx2, ty2) - hAt(fx, fy)) * c.p + 0.20;
      // rotateY(t) sends -Z to (-sin t, -cos t), so facing (dx,dz) is
      // atan2(-dx,-dz). With atan2(dx,dz) you ride backwards down the street.
      yaw = Math.atan2(-dx, -dz);
      pitch = -0.06;
      walk.x = ex; walk.z = ez;
    }
  }
  camPersp.position.set(ex, ey, ez);
  camPersp.rotation.set(0, 0, 0);
  camPersp.rotateY(yaw);
  camPersp.rotateX(pitch);
  camPersp.aspect = innerWidth / innerHeight;
  camPersp.updateProjectionMatrix();
  sun.target.position.set(ex, 0, ez);
  sun.position.set(ex + Math.cos(sunAz) * 72, Math.max(9, sunEl * 86), ez + Math.sin(sunAz) * 54);
}

function onResize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * (SET.scale ? 1 : 0.55));
  renderer.setSize(innerWidth, innerHeight, false);
  placeCamera();
}
addEventListener('resize', onResize);

// ---------------------------------------------------------- ground texture
const hAt = (x, y) => city.terrain[idx(x, y)] === T.WATER ? -0.14 : city.elev[idx(x, y)] * ELEV;
function padH(x, y) {
  let m = Infinity;
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) m = Math.min(m, cornerH(x + dx, y + dy));
  return m === Infinity ? hAt(x, y) : m;
}
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
  water: ['#3c6b88', '#41708c', '#48789a', '#4d7fa0', '#457694', '#3f6d8a'],
  shore: ['#a8a077', '#b0a880', '#9d956d'],
  tree: ['#4e6b41', '#587448', '#47623c'],
  road: { 1: '#7d6c50', 2: '#54524c', 3: '#5c5a53', 4: '#6b6157' },   // dirt/street/blvd/bridge
  roadLine: '#b9b29a', gravel: '#93815f', median: '#5f7c46', kerb: '#8e897c',
  park: '#5d8348', parkPath: '#a89a76',
  lot: { [Z.R]: '#9aa872', [Z.C]: '#7f96a8', [Z.I]: '#a89a72' },
  plant: '#6a6258', rubble: '#8a8074',
};
const hash = i => { let h = (i * 2654435761) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const nearWater = (x, y) => {
  for (let k = 0; k < 4; k++) {
    const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && city.terrain[idx(nx, ny)] === T.WATER) return true;
  }
  return false;
};

let waterPhase = 0;
const rubble = new Map();      // tile -> seconds of dust left

function paintTile(x, y) {
  const g = gTex.g, i = idx(x, y), px = x * GRES, py = y * GRES;
  const t = city.terrain[i], r = hash(i);

  if (t === T.WATER) {
    // Bands stepping along the channel, not random flicker — flicker reads as
    // a rendering fault, a moving band reads as current.
    const k = ((x * 0.7 + y * 1.1 + waterPhase) | 0) % PAL.water.length;
    g.fillStyle = PAL.water[(k + PAL.water.length) % PAL.water.length];
    g.fillRect(px, py, GRES, GRES);
    return;
  }

  const bare = nearWater(x, y) ? PAL.shore[(r * 3) | 0]
    : t === T.TREE ? PAL.tree[(r * 3) | 0] : fieldOf(x, y)[(r * 3) | 0];
  g.fillStyle = bare;
  g.fillRect(px, py, GRES, GRES);
  g.fillStyle = `rgba(255,246,214,${0.05 + Math.min(1, city.elev[i] * 1.7) * 0.10})`;
  g.fillRect(px, py, GRES, GRES);

  if (city.plant[i]) { g.fillStyle = PAL.plant; g.fillRect(px, py, GRES, GRES); return; }

  if (rubble.has(i)) { g.fillStyle = PAL.rubble; g.fillRect(px, py, GRES, GRES); return; }

  if (city.park[i]) {
    g.fillStyle = PAL.park; g.fillRect(px, py, GRES, GRES);
    g.fillStyle = PAL.parkPath; g.fillRect(px + 1, py + 1, 1, 1); g.fillRect(px + 2, py + 2, 1, 1);
    return;
  }

  const grade = city.road[i];
  if (grade) {
    g.fillStyle = PAL.road[grade]; g.fillRect(px, py, GRES, GRES);
    const c0 = px + (GRES >> 1) - 1, c1 = py + (GRES >> 1) - 1;
    const E = x + 1 < W && city.road[idx(x + 1, y)], Wn = x > 0 && city.road[idx(x - 1, y)];
    const Sn = y + 1 < H && city.road[idx(x, y + 1)], Nn = y > 0 && city.road[idx(x, y - 1)];
    if (grade === S.ROAD.DIRT) {
      // No markings on a dirt track — just wheel ruts and loose stone.
      g.fillStyle = PAL.gravel;
      if (r < 0.5) g.fillRect(px + 1, py + 2, 1, 1); else g.fillRect(px + 2, py + 1, 1, 1);
    } else if (grade === S.ROAD.STREET) {
      g.fillStyle = PAL.roadLine;
      if (E) g.fillRect(c0 + 1, c1, GRES >> 1, 1);
      if (Wn) g.fillRect(px, c1, GRES >> 1, 1);
      if (Sn) g.fillRect(c0, c1 + 1, 1, GRES >> 1);
      if (Nn) g.fillRect(c0, py, 1, GRES >> 1);
    } else if (grade === S.ROAD.BRIDGE) {
      // The deck itself is a mesh above the water; this is only what shows
      // through underneath, so keep it dark and quiet.
      g.fillStyle = PAL.water[2];
      g.fillRect(px, py, GRES, GRES);
    } else {
      // A boulevard reads by its planted median and its kerbs, not by a stripe.
      g.fillStyle = PAL.kerb;
      g.fillRect(px, py, GRES, 1); g.fillRect(px, py + GRES - 1, GRES, 1);
      g.fillRect(px, py, 1, GRES); g.fillRect(px + GRES - 1, py, 1, GRES);
      g.fillStyle = PAL.median;
      if (E || Wn) g.fillRect(px, c1, GRES, 1);
      if (Sn || Nn) g.fillRect(c0, py, 1, GRES);
      if (!E && !Wn && !Sn && !Nn) g.fillRect(c0, c1, 2, 2);
    }
    return;
  }

  const z = city.zone[i];
  if (z) {
    g.fillStyle = PAL.lot[z]; g.globalAlpha = city.bld[i] ? 0.95 : 0.62;
    g.fillRect(px, py, GRES, GRES); g.globalAlpha = 1;
    if (!city.bld[i]) {
      g.fillStyle = 'rgba(50,44,30,.38)';
      g.fillRect(px, py, 1, 1); g.fillRect(px + GRES - 1, py + GRES - 1, 1, 1);
      // A hard blocker gets a mark. NO_DEMAND deliberately does not: waiting for
      // demand is the game working, not the player having made a mistake.
      const st = city.stall[i];
      if (st === S.STALL.NO_ROAD || st === S.STALL.NO_POWER) {
        g.fillStyle = st === S.STALL.NO_ROAD ? '#b4402f' : '#d09a26';
        g.fillRect(px + 1, py + 1, 2, 2);
      }
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
let waterTiles = [];
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

// A detail layer, tiled once per lot and multiplied into the ground colour.
// The tile map is only 4 texels per lot, which is fine from the air and turns
// into acres of flat wash the moment you stand on it — and flat wash is most of
// what makes a rendered landscape look synthetic.
const detailTex = (() => {
  const n = 128, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  const img = g.createImageData(n, n);
  // Value noise at two frequencies plus per-texel grain: the low frequency
  // gives patches of wear, the grain keeps it from banding.
  const lat = (m, seed) => {
    const r = S.mulberry32(seed), a = new Float32Array(m * m);
    for (let i = 0; i < a.length; i++) a[i] = r();
    return { n: m, a };
  };
  const L1 = lat(8, 0xd57a11), L2 = lat(23, 0x51ee);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n;
    const lo = latAt(L1, u, v), hi = latAt(L2, u, v);
    const grain = Math.random();
    const val = 0.52 * lo + 0.30 * hi + 0.18 * grain;
    const c = Math.round(120 + val * 135);
    const o = (y * n + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = c;
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();

const groundGeo = new THREE.PlaneGeometry(W, H, W, H);
groundGeo.rotateX(-Math.PI / 2);
const groundMat = new THREE.MeshLambertMaterial({ map: gTex.tex });
groundMat.onBeforeCompile = sh => {
  sh.uniforms.uDetail = { value: detailTex };
  sh.uniforms.uDetailScale = { value: W * 1.5 };
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>',
      '#include <common>\nuniform sampler2D uDetail;\nuniform float uDetailScale;')
    // vMapUv is three r160's varying for a material that has a map; reusing it
    // avoids adding a varying and keeps this to a two-line patch.
    .replace('#include <map_fragment>',
      '#include <map_fragment>\n'
      + 'float det = texture2D( uDetail, vMapUv * uDetailScale ).r;\n'
      + 'diffuseColor.rgb *= 0.80 + 0.34 * det;');
};
const ground = new THREE.Mesh(groundGeo, groundMat);
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

// ------------------------------------------------------------ survey sheets
// One texel per tile, written through ImageData — far faster than 25,600
// fillRects, and it shares the ground's displaced geometry so it drapes over
// the relief for free.
const ovrCv = document.createElement('canvas');
ovrCv.width = W; ovrCv.height = H;
const ovrCtx = ovrCv.getContext('2d');
const ovrImg = ovrCtx.createImageData(W, H);
const ovrTex = new THREE.CanvasTexture(ovrCv);
ovrTex.colorSpace = THREE.SRGBColorSpace;
ovrTex.magFilter = THREE.NearestFilter;
const ovrMesh = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial({
  map: ovrTex, transparent: true, opacity: 0.78, depthWrite: false,
}));
ovrMesh.position.set(W / 2, 0.07, H / 2);
ovrMesh.visible = false;
ovrMesh.renderOrder = 2;
scene.add(ovrMesh);

let ovrMode = 'none', ovrAcc = 0;
function paintOverlay() {
  const d = ovrImg.data;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    let r = 0, g = 0, b = 0, a = 0;
    if (ovrMode === 'value') {
      const v = city.lv[i];
      r = 236 - v * 200; g = 226 - v * 150; b = 190 + v * 60;   // ochre → mimeo blue
      a = 150 + v * 90;
    } else if (ovrMode === 'power') {
      if (city.powered[i]) { r = 214; g = 154; b = 44; a = 190; }
      else if (city.bld[i] || city.zone[i]) { r = 168; g = 58; b = 44; a = 200; }
      else { a = 0; }
    } else if (ovrMode === 'cover') {
      // Three services stacked into one sheet: red where housing has no school,
      // amber where nothing is in reach of a fire station, blue for unpoliced.
      const noSchool = !city.cover[S.SVC.SCHOOL][i];
      const noFire = !city.cover[S.SVC.FIRE][i];
      const noPolice = !city.cover[S.SVC.POLICE][i];
      if (!city.zone[i] && !city.bld[i]) { a = 0; }
      else if (noSchool) { r = 178; g = 62; b = 48; a = 205; }
      else if (noFire) { r = 214; g = 154; b = 44; a = 185; }
      else if (noPolice) { r = 62; g = 96; b = 168; a = 165; }
      // Barely there where everything is in reach: this sheet exists to show
      // the HOLES, and a strong wash over the served majority hides them.
      else { r = 92; g = 140; b = 84; a = 38; }
    } else if (ovrMode === 'smoke') {
      const v = Math.min(1, city.soot[i] * 2.2);
      if (v < 0.02) { a = 0; } else { r = 92 + v * 40; g = 84 + v * 26; b = 76; a = 40 + v * 200; }
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
  }
  ovrCtx.putImageData(ovrImg, 0, 0);
  ovrTex.needsUpdate = true;
}
function setOverlay(m) {
  ovrMode = m;
  ovrMesh.visible = m !== 'none';
  for (const b of document.querySelectorAll('#ovr button')) b.classList.toggle('on', b.dataset.o === m);
  if (m !== 'none') paintOverlay();
}

// ---------------------------------------------------------------- geometry
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
const box = (w, h, d, x = 0, y = 0, z = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); return g; };
const pyr = (r, h, y) => { const g = new THREE.ConeGeometry(r, h, 4); g.rotateY(Math.PI / 4); g.translate(0, y + h / 2, 0); return g; };
const stack = (r, h, x, y, z) => { const g = new THREE.CylinderGeometry(r * 0.8, r, h, 6); g.translate(x, y + h / 2, z); return g; };

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
// A tier-1 dwelling on land below SHACK_LV. Small, flat- or lean-roofed, drab —
// the whole point is that you can tell the bad ground from the good at a glance
// instead of having to open the land value sheet.
const SHACK_VARIANTS = [
  () => mergeGeos([box(.40, .24, .36), box(.46, .05, .42, .01, .24)]),
  () => mergeGeos([box(.34, .28, .42), box(.40, .04, .46, -.01, .28), stack(.035, .18, .13, .32, .12)]),
  () => mergeGeos([box(.44, .20, .30), box(.48, .05, .34, .02, .20)]),
];
const TINT_SHACK = ['#8a7f6e', '#7b7263', '#948976', '#6f675a', '#877c68'];

const TINT = {
  [Z.R]: ['#c9b499', '#b9a68c', '#d2c2a6', '#a8917a', '#c2b6a4'],
  [Z.C]: ['#d8d2c2', '#c6c9c6', '#e0dccb', '#b9bfc0', '#cfc8b4'],
  [Z.I]: ['#8d6a58', '#7d6154', '#96786a', '#6e5f57', '#8a7160'],
};
// Lit windows after dark. Instanced meshes cannot carry per-instance emissive,
// but ambient light falls at night, so pushing the instance COLOUR warm and
// bright reads exactly like a block with its lights on.
const LIT = { [Z.R]: 0xffd79a, [Z.C]: 0xfff0c4, [Z.I]: 0xffc98a };


// ------------------------------------------------------------------ facades
// Buildings are merged boxes, and from the air that is plenty. From the
// pavement they were blank slabs — which is most of what "looks computer
// generated" actually means. Rather than texture every box, the facade is drawn
// procedurally in the fragment shader from OBJECT space: each box is built with
// its base at y=0, so position.y is height above that building's own ground and
// the storeys line up per building instead of against a world grid.
const STOREY = 0.34;      // one floor, in world units, across every tier
const facadeMats = {};
function makeFacadeMaterial(zoneKey) {
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = sh => {
    sh.uniforms.uNight = { value: 0 };
    sh.uniforms.uZone = { value: zoneKey };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNrm;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvObjPos = position;\nvObjNrm = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNrm;\n'
        + 'uniform float uNight;\nuniform float uZone;\n'
        + 'float hash11(float p){ return fract(sin(p*12.9898)*43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gWin = 0.0;
        if (abs(vObjNrm.y) < 0.5) {
          // Which way the wall faces decides which axis runs across it.
          float across = abs(vObjNrm.x) > abs(vObjNrm.z) ? vObjPos.z : vObjPos.x;
          float cw = uZone > 2.5 ? 0.20 : 0.155;      // works get wider sashes
          float fx = across / cw;
          float fy = vObjPos.y / ${STOREY.toFixed(3)};
          vec2 f = vec2(fract(fx), fract(fy));
          float wx = step(0.20, f.x) * step(f.x, 0.80);
          float wy = step(0.26, f.y) * step(f.y, 0.84);
          gWin = wx * wy;
          // The ground floor is a different building: shopfronts on trade,
          // loading doors on works, a plain door on a dwelling.
          if (vObjPos.y < ${STOREY.toFixed(3)}) {
            if (uZone > 1.5) gWin = step(0.08, f.x) * step(f.x, 0.92) * step(0.10, f.y) * step(f.y, 0.86);
            else gWin = step(0.40, f.x) * step(f.x, 0.60) * step(0.05, f.y) * step(f.y, 0.72);
          }
          float id = floor(fx) * 13.0 + floor(fy) * 7.0 + uZone;
          float lit = step(0.42, hash11(id));
          vec3 glass = mix(vec3(0.15,0.17,0.19), vec3(1.0,0.84,0.55), uNight * lit);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, gWin * 0.88);
          gWin *= lit;
          // A string course under each floor, and grime gathering low down.
          float band = 1.0 - smoothstep(0.0, 0.055, abs(f.y - 0.05));
          diffuseColor.rgb *= 1.0 - band * 0.13;
          diffuseColor.rgb *= 0.90 + 0.10 * smoothstep(0.0, 1.2, vObjPos.y);
        } else {
          // Roofs: tar and gravel, not the wall colour.
          diffuseColor.rgb *= 0.78 + 0.10 * hash11(floor(vObjPos.x*22.0) + floor(vObjPos.z*22.0)*3.0);
        }`)
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + 'totalEmissiveRadiance += gWin * uNight * vec3(1.0, 0.82, 0.50) * 1.15;');
    m.userData.shader = sh;
  };
  return m;
}
for (const z of [Z.R, Z.C, Z.I]) facadeMats[z] = makeFacadeMaterial(z);
const shackMat = makeFacadeMaterial(0.5);
function setFacadeNight(n) {
  for (const m of [...Object.values(facadeMats), shackMat]) {
    const sh = m.userData.shader;
    if (sh) sh.uniforms.uNight.value = n;
  }
}

const bmat = new THREE.MeshLambertMaterial();
const flatBuckets = [];
const mkBucket = (list, mat) => list.map(make => {
  const e = { geo: make(), mesh: null, cap: 0, mat, id: flatBuckets.length };
  flatBuckets.push(e);
  return e;
});
const bucket = {};
for (const z of [Z.R, Z.C, Z.I]) {
  bucket[z] = [];
  for (let t = 1; t <= 3; t++) bucket[z][t] = mkBucket(VARIANTS[z][t - 1], facadeMats[z]);
}
const shackBucket = mkBucket(SHACK_VARIANTS, shackMat);
// One place decides which mesh a lot belongs in, so the counting pass and the
// filling pass can never disagree about where a building went.
const bucketFor = (i, z, t) =>
  (z === Z.R && t === 1 && S.isShack(city, i)) ? shackBucket[variantOf(i)] : bucket[z][t][variantOf(i)];
function ensureCap(e, need) {
  if (e.mesh && e.cap >= need) return;
  const cap = Math.max(256, 1 << (32 - Math.clz32(Math.max(1, need - 1))));
  if (e.mesh) { scene.remove(e.mesh); e.mesh.dispose(); }
  const m = new THREE.InstancedMesh(e.geo, e.mat || bmat, cap);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = true; m.receiveShadow = true;
  m.frustumCulled = false; m.count = 0;
  scene.add(m);
  e.mesh = m; e.cap = cap;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();
const _sc = new THREE.Vector3(1, 1, 1), _col = new THREE.Color(), _lit = new THREE.Color();
const YAXIS = new THREE.Vector3(0, 1, 0);

// Which instance a tile's building lives in, so a rise can be animated in place
// instead of rebuilding all 27 meshes on every frame of it.
const slotBucket = new Int16Array(N).fill(-1);
const slotIndex = new Int32Array(N).fill(-1);
const prevBld = new Uint8Array(N);
const rising = new Map();       // tile -> progress 0..1

const variantOf = i => (hash(i + 991) * 3) | 0;
function placeTile(i, e, k, scaleY, scaleXZ) {
  const x = i % W, y = (i / W) | 0, r = hash(i), z = city.zone[i];
  // A few degrees off square and a few centimetres off centre. Perfectly
  // aligned lots are the other half of why a generated town looks generated.
  const jr = hash(i + 1301), jx = hash(i + 2609), jz = hash(i + 3907);
  _q.setFromAxisAngle(YAXIS, ((r * 4) | 0) * Math.PI / 2 + (jr - 0.5) * 0.13);
  _v.set(x + 0.5 + (jx - 0.5) * 0.11, padH(x, y), y + 0.5 + (jz - 0.5) * 0.11);
  _sc.set(scaleXZ, scaleY, scaleXZ);
  _m.compose(_v, _q, _sc);
  e.mesh.setMatrixAt(k, _m);
  const pal = (z === Z.R && city.bld[i] === 1 && S.isShack(city, i)) ? TINT_SHACK : TINT[z];
  _col.set(pal[(r * pal.length) | 0]);
  if (!city.powered[i]) _col.multiplyScalar(0.5);
  else if (nightness > 0.15) _col.lerp(_lit.setHex(LIT[z]), Math.min(0.30, nightness * 0.55));
  else _col.multiplyScalar(1 - nightness * 0.35);
  e.mesh.setColorAt(k, _col);
}

let bldDirty = true, litDrawn = 0;
function rebuildBuildings() {
  const need = new Int32Array(flatBuckets.length);
  for (const i of city._zonedList) {
    const t = city.bld[i], z = city.zone[i];
    if (!t || !z) continue;
    need[bucketFor(i, z, t).id]++;
  }
  for (let k = 0; k < flatBuckets.length; k++) ensureCap(flatBuckets[k], need[k]);

  slotBucket.fill(-1); slotIndex.fill(-1);
  const n = new Int32Array(flatBuckets.length);
  let sheds = 0;
  for (const i of city._zonedList) {
    const t = city.bld[i], z = city.zone[i];
    if (!t || !z) continue;
    if (z === Z.R && t <= 2 && sheds < 6000 && hash(i + 4242) < 0.45) {
      const sx = i % W, sy = (i / W) | 0, sr = hash(i + 61);
      _q.setFromAxisAngle(YAXIS, sr * TAU);
      _v.set(sx + 0.18 + sr * 0.12, padH(sx, sy), sy + 0.74 - sr * 0.10);
      _sc.set(1, 1, 1);
      _m.compose(_v, _q, _sc);
      shedMesh.setMatrixAt(sheds, _m);
      _col.set(SHED_TINT[(sr * SHED_TINT.length) | 0]);
      if (!city.powered[i]) _col.multiplyScalar(0.5);
      shedMesh.setColorAt(sheds, _col);
      sheds++;
    }
    const e = bucketFor(i, z, t);
    const k = n[e.id]++;
    if (k >= e.cap) continue;
    slotBucket[i] = e.id; slotIndex[i] = k;
    const p = rising.get(i);
    const s = p === undefined ? 1 : easeRise(p);
    placeTile(i, e, k, s, 0.82 + 0.18 * s);
  }
  for (const e of flatBuckets) {
    if (!e.mesh) continue;
    e.mesh.count = Math.min(n[e.id], e.cap);
    e.mesh.instanceMatrix.needsUpdate = true;
    if (e.mesh.instanceColor) e.mesh.instanceColor.needsUpdate = true;
  }
  rebuildServices();
  shedMesh.count = sheds;
  shedMesh.instanceMatrix.needsUpdate = true;
  if (shedMesh.instanceColor) shedMesh.instanceColor.needsUpdate = true;
  rebuildFarms();
  bldDirty = false;
  litDrawn = nightness;
}
const easeRise = p => 1 - Math.pow(1 - p, 3);

// Only the lots actually going up are touched per frame; everything else keeps
// the matrix it already had.
function stepRising(dt) {
  if (!rising.size) return;
  const dirty = new Set();
  for (const [i, p] of rising) {
    const np = p + dt / RISE_SEC;
    if (np >= 1) { rising.delete(i); } else { rising.set(i, np); }
    const b = slotBucket[i];
    if (b < 0) continue;
    const e = flatBuckets[b];
    const s = easeRise(Math.min(1, np));
    placeTile(i, e, slotIndex[i], s, 0.82 + 0.18 * s);
    dirty.add(e);
  }
  for (const e of dirty) {
    e.mesh.instanceMatrix.needsUpdate = true;
    if (e.mesh.instanceColor) e.mesh.instanceColor.needsUpdate = true;
  }
}

// What changed since the last tick: things going up get an animation, things
// coming down leave dust on the lot for a couple of seconds.
function noteChanges() {
  for (const i of city._zonedList) {
    const b = city.bld[i];
    if (b === prevBld[i]) continue;
    if (b > prevBld[i]) rising.set(i, 0);
    else if (prevBld[i] > 0) { rubble.set(i, RUBBLE_SEC); touch(i % W, (i / W) | 0); }
    prevBld[i] = b;
  }
}
function stepRubble(dt) {
  if (!rubble.size) return;
  for (const [i, left] of rubble) {
    const n = left - dt;
    if (n <= 0) { rubble.delete(i); touch(i % W, (i / W) | 0); }
    else rubble.set(i, n);
  }
}

// ----------------------------------------------------------------- bridges
// A real deck, because a bridge painted into the ground texture would sit at
// the river bed and read as a ford.
const bridgeMesh = (() => {
  const m = new THREE.InstancedMesh(
    mergeGeos([
      box(1.02, .12, .74, 0, .46),          // deck
      box(1.02, .09, .07, 0, .58, .36),     // railings
      box(1.02, .09, .07, 0, .58, -.36),
      box(.16, .62, .16, -.34, -.16),       // piers
      box(.16, .62, .16, .34, -.16),
    ]),
    new THREE.MeshLambertMaterial({ color: 0x8c8377 }), 400);
  m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
  scene.add(m);
  return m;
})();
function rebuildBridges() {
  let k = 0;
  for (let i = 0; i < N; i++) {
    if (city.road[i] !== S.ROAD.BRIDGE || k >= 400) continue;
    const x = i % W, y = (i / W) | 0;
    // Lay the deck along whichever way its neighbours run.
    const ew = (x + 1 < W && city.road[idx(x + 1, y)]) || (x > 0 && city.road[idx(x - 1, y)]);
    _q.setFromAxisAngle(YAXIS, ew ? 0 : Math.PI / 2);
    _v.set(x + 0.5, -0.14, y + 0.5);
    _sc.set(1, 1, 1);
    _m.compose(_v, _q, _sc);
    bridgeMesh.setMatrixAt(k++, _m);
  }
  bridgeMesh.count = k;
  bridgeMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- services
const SVC_GEO = {
  [S.SVC.SCHOOL]: () => mergeGeos([box(.68, .40, .52), pyr(.46, .22, .40), box(.13, .17, .13, 0, .62)]),
  [S.SVC.FIRE]: () => mergeGeos([box(.60, .44, .58), box(.20, .52, .20, .24, .44), box(.66, .07, .64, 0, .44)]),
  [S.SVC.POLICE]: () => mergeGeos([box(.64, .40, .56), box(.70, .09, .62, 0, .40), box(.16, .14, .16, 0, .49)]),
  [S.SVC.CIVIC]: () => mergeGeos([box(.82, .62, .68), box(.88, .10, .74, 0, .62), pyr(.44, .40, .72)]),
  [S.SVC.CHURCH]: () => mergeGeos([box(.44, .40, .66), pyr(.34, .22, .40), box(.19, .86, .19, 0, .40, -.26), pyr(.16, .34, 1.26)]),
};
const SVC_TINT = {
  [S.SVC.SCHOOL]: 0xb8483a, [S.SVC.FIRE]: 0x8e3a2e, [S.SVC.POLICE]: 0x6d7480,
  [S.SVC.CIVIC]: 0xd8d2c0, [S.SVC.CHURCH]: 0xe4dfcc,
};
const svcMeshes = {};
for (const k of Object.keys(SVC_GEO)) {
  const m = new THREE.InstancedMesh(SVC_GEO[k](), new THREE.MeshLambertMaterial({ color: SVC_TINT[k] }), 160);
  m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
  scene.add(m);
  svcMeshes[k] = m;
}
function rebuildServices() {
  const n = {};
  for (const k of Object.keys(SVC_GEO)) n[k] = 0;
  for (const sv of city.services) {
    const m = svcMeshes[sv.kind];
    if (!m || n[sv.kind] >= 160) continue;
    _q.setFromAxisAngle(YAXIS, ((hash(idx(sv.x, sv.y)) * 4) | 0) * Math.PI / 2);
    _v.set(sv.x + 0.5, padH(sv.x, sv.y), sv.y + 0.5);
    _sc.set(1, 1, 1);
    _m.compose(_v, _q, _sc);
    m.setMatrixAt(n[sv.kind]++, _m);
  }
  for (const k of Object.keys(SVC_GEO)) {
    svcMeshes[k].count = n[k];
    svcMeshes[k].instanceMatrix.needsUpdate = true;
    // An unfunded station is a dark station.
    svcMeshes[k].material.color.setHex(SVC_TINT[k]).multiplyScalar(city.funded ? 1 : 0.45);
  }
}

// -------------------------------------------- farmsteads and outbuildings
// Barns, silos and farmhouses scattered over open ground, so the land you have
// not zoned yet reads as working farmland rather than as blank space waiting
// for you. Sites are seeded, so a given tract always has the same farms.
// A farmstead is a GROUP — barn, silo and house together on neighbouring tiles.
// Scattering the three types independently produced lone pale specks that read
// as render artefacts rather than as farms.
const FARM_GEO = [
  () => mergeGeos([box(.84, .40, .60), pyr(.62, .32, .40)]),                     // barn
  () => mergeGeos([stack(.21, .82, 0, 0, 0), box(.36, .08, .36, 0, .82)]),       // silo
  () => mergeGeos([box(.54, .34, .48), pyr(.42, .26, .34)]),                     // farmhouse
];
const FARM_TINT = ['#8d3a2c', '#c2bcab', '#d6cab0'];
const FARM_CAP = 200;
const farmMeshes = FARM_GEO.map(make => {
  const m = new THREE.InstancedMesh(make(), new THREE.MeshLambertMaterial(), FARM_CAP);
  m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
  scene.add(m);
  return m;
});
let farmSites = [];
function computeFarmSites() {
  farmSites = [];
  for (let i = 0; i < N; i++) {
    if (city.terrain[i] !== T.LAND) continue;
    if (hash(i + 31337) > 0.0026) continue;
    const x = i % W, y = (i / W) | 0;
    if (x + 1 >= W || y + 1 >= H) continue;
    farmSites.push(i);
  }
}
// Claimed ground is no longer a farm — the plough goes when the plat comes.
const farmFree = i => !city.zone[i] && !city.road[i] && !city.park[i]
  && !city.plant[i] && city.terrain[i] === T.LAND;

function rebuildFarms() {
  const n = [0, 0, 0];
  const put = (k, x, y, salt) => {
    const m = farmMeshes[k];
    if (n[k] >= FARM_CAP) return;
    const r = hash(idx(x, y) + salt);
    _q.setFromAxisAngle(YAXIS, ((r * 4) | 0) * Math.PI / 2);
    _v.set(x + 0.5, padH(x, y), y + 0.5);
    _sc.set(1, 1, 1);
    _m.compose(_v, _q, _sc);
    m.setMatrixAt(n[k], _m);
    _col.set(FARM_TINT[k]).offsetHSL(0, 0, (hash(idx(x, y) + 5) - 0.5) * 0.10);
    m.setColorAt(n[k], _col);
    n[k]++;
  };
  for (const i of farmSites) {
    if (!farmFree(i)) continue;
    const x = i % W, y = (i / W) | 0;
    put(0, x, y, 777);                                        // the barn anchors it
    if (farmFree(idx(x + 1, y))) put(1, x + 1, y, 91);        // silo alongside
    if (farmFree(idx(x, y + 1))) put(2, x, y + 1, 313);       // house across the yard
  }
  farmMeshes.forEach((m, k) => {
    m.count = n[k];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
}

// Sheds and garages beside the low dwellings. Pure texture at close zoom, and
// it is what stops a street of cottages looking like a row of identical dice.
const shedMesh = (() => {
  const m = new THREE.InstancedMesh(
    mergeGeos([box(.24, .17, .20), pyr(.19, .09, .17)]),
    new THREE.MeshLambertMaterial(), 6000);
  m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
  scene.add(m);
  return m;
})();
const SHED_TINT = ['#9c8f79', '#8a7f6b', '#a8997f', '#7d7362'];

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
    _v.set(x + 0.2 + r * 0.6, padH(x, y), y + 0.2 + hash(i + 7) * 0.6);
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

// ------------------------------------------------------------------ traffic
// The road grid is already a graph. A car holds two tiles and a fraction, picks
// a neighbour that is not where it came from, and repeats — no pathfinding, and
// from this height it reads exactly like traffic.
// Deliberately oversized against a 1-unit lot: at this camera height a
// to-scale motor car is three pixels and reads as noise on the tarmac.
const carGeo = mergeGeos([
  box(.48, .13, .23),                    // body, long axis on +X
  box(.22, .10, .21, -.03, .13),         // cabin
  box(.50, .04, .17, 0, .03),            // running boards
]);
const carMesh = new THREE.InstancedMesh(carGeo, new THREE.MeshLambertMaterial(), CAR_MAX);
carMesh.frustumCulled = false; carMesh.castShadow = true; carMesh.count = 0;
scene.add(carMesh);
const CAR_COL = ['#2f3338', '#6d7378', '#8a2f2a', '#25415e', '#b9b2a2', '#3d5c48', '#7d6a4a', '#a8a49a'];

let roadList = [], roadVer = -1;
const cars = [];
function refreshRoadList() {
  roadList = [];
  for (let i = 0; i < N; i++) if (city.road[i]) roadList.push(i);
  roadVer = city.roadVersion;
}
// The road list is not the traffic system's private property. It used to be
// refreshed only inside stepTraffic, so turning traffic off in settings left it
// permanently stale and Street level set you down in the middle of a field.
function ensureRoadList() {
  if (city.roadVersion !== roadVer) { refreshRoadList(); rebuildBridges(); }
}
function roadNext(from, notThis) {
  const x = from % W, y = (from / W) | 0;
  const opts = [];
  for (let k = 0; k < 4; k++) {
    const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = idx(nx, ny);
    if (!city.road[j]) continue;
    if (j !== notThis) opts.push(j);
  }
  if (!opts.length) return notThis >= 0 && city.road[notThis] ? notThis : -1;
  return opts[(Math.random() * opts.length) | 0];
}
function spawnCar() {
  if (!roadList.length) return null;
  const from = roadList[(Math.random() * roadList.length) | 0];
  const to = roadNext(from, -1);
  if (to < 0) return null;
  return { from, to, p: Math.random(), spd: 1.5 + Math.random() * 1.4, col: CAR_COL[(Math.random() * CAR_COL.length) | 0] };
}
function stepTraffic(dt) {
  if (!SET.traffic) { carMesh.count = 0; return; }
  ensureRoadList();
  const busy = city.pop.res + city.pop.jobsC + city.pop.jobsI;
  const target = Math.min(CAR_MAX, Math.round(busy / 42));
  while (cars.length > target) cars.pop();
  // In batches, not one a frame: opening a saved city of 8,000 people should
  // show its traffic straight away, not trickle it in over five seconds.
  for (let k = 0; k < 24 && cars.length < target; k++) {
    const c = spawnCar();
    if (!c) break;
    cars.push(c);
  }

  let k = 0;
  for (const c of cars) {
    c.p += dt * c.spd;
    let guard = 0;
    while (c.p >= 1 && guard++ < 4) {
      c.p -= 1;
      const prev = c.from;
      c.from = c.to;
      c.to = roadNext(c.from, prev);
      if (c.to < 0) { c.to = c.from; c.p = 0; break; }
    }
    if (!city.road[c.from] || !city.road[c.to]) {   // the street was razed under it
      const n = spawnCar(); if (!n) continue;
      c.from = n.from; c.to = n.to; c.p = 0;
    }
    const fx = c.from % W, fy = (c.from / W) | 0;
    const tx = c.to % W, ty = (c.to / W) | 0;
    const dx = tx - fx, dz = ty - fy;
    // Keep right: offset perpendicular to travel so the two directions separate.
    const ox = -dz * 0.17, oz = dx * 0.17;
    const x = fx + 0.5 + dx * c.p + ox;
    const z = fy + 0.5 + dz * c.p + oz;
    const yh = hAt(fx, fy) + (hAt(tx, ty) - hAt(fx, fy)) * c.p + 0.055;
    _q.setFromAxisAngle(YAXIS, Math.atan2(-dz, dx));
    _v.set(x, yh, z);
    _sc.set(1, 1, 1);
    _m.compose(_v, _q, _sc);
    carMesh.setMatrixAt(k, _m);
    _col.set(c.col);
    if (nightness > 0.3) _col.lerp(new THREE.Color(0xfff0c0), (nightness - 0.3) * 0.5);
    carMesh.setColorAt(k, _col);
    k++;
  }
  carMesh.count = k;
  carMesh.instanceMatrix.needsUpdate = true;
  if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------- pedestrians
// Same wander as the cars but on the kerb and at walking pace. They are the
// reason street level is worth going down to — an empty pavement reads as a
// model of a town rather than a town.
const PED_MAX = 320;
const pedMesh = new THREE.InstancedMesh(
  mergeGeos([box(.075, .135, .075), box(.062, .062, .062, 0, .135)]),
  new THREE.MeshLambertMaterial(), PED_MAX);
pedMesh.frustumCulled = false; pedMesh.castShadow = true; pedMesh.count = 0;
scene.add(pedMesh);
const PED_COL = ['#3a3f47', '#6b6257', '#8a5a48', '#2f4356', '#7d7468', '#4a5a45', '#9a8e78', '#55504a'];
const peds = [];
function spawnPed() {
  if (!roadList.length) return null;
  const from = roadList[(Math.random() * roadList.length) | 0];
  const to = roadNext(from, -1);
  if (to < 0) return null;
  return { from, to, p: Math.random(), spd: 0.30 + Math.random() * 0.22,
    side: Math.random() < 0.5 ? 1 : -1, col: PED_COL[(Math.random() * PED_COL.length) | 0] };
}
function stepPeds(dt) {
  if (!SET.traffic) { pedMesh.count = 0; return; }
  const target = Math.min(PED_MAX, Math.round(city.pop.res / 55));
  while (peds.length > target) peds.pop();
  for (let k = 0; k < 20 && peds.length < target; k++) {
    const p = spawnPed();
    if (!p) break;
    peds.push(p);
  }
  let k = 0;
  for (const q of peds) {
    q.p += dt * q.spd;
    let guard = 0;
    while (q.p >= 1 && guard++ < 4) {
      q.p -= 1;
      const prev = q.from;
      q.from = q.to;
      q.to = roadNext(q.from, prev);
      if (q.to < 0) { q.to = q.from; q.p = 0; break; }
    }
    if (!city.road[q.from] || !city.road[q.to]) {
      const n = spawnPed(); if (!n) continue;
      q.from = n.from; q.to = n.to; q.p = 0;
    }
    const fx = q.from % W, fy = (q.from / W) | 0;
    const tx = q.to % W, ty = (q.to / W) | 0;
    const dx = tx - fx, dz = ty - fy;
    const ox = -dz * 0.36 * q.side, oz = dx * 0.36 * q.side;
    const yh = hAt(fx, fy) + (hAt(tx, ty) - hAt(fx, fy)) * q.p + 0.01;
    // A little bob, so a crowd does not glide like chess pieces.
    const bob = Math.abs(Math.sin((q.p + q.spd) * Math.PI * 6)) * 0.012;
    _q.setFromAxisAngle(YAXIS, Math.atan2(-dz, dx));
    _v.set(fx + 0.5 + dx * q.p + ox, yh + bob, fy + 0.5 + dz * q.p + oz);
    _sc.set(1, 1, 1);
    _m.compose(_v, _q, _sc);
    pedMesh.setMatrixAt(k, _m);
    _col.set(q.col);
    if (nightness > 0.3) _col.multiplyScalar(0.7);
    pedMesh.setColorAt(k, _col);
    k++;
  }
  pedMesh.count = k;
  pedMesh.instanceMatrix.needsUpdate = true;
  if (pedMesh.instanceColor) pedMesh.instanceColor.needsUpdate = true;
}

// --------------------------------------------------------------------- birds
// Flocks on lazy circles. Cheap, and the first thing in the scene that moves
// without the player having built it.
const BIRD_FLOCKS = 5, BIRD_PER = 11;
const birdMesh = (() => {
  const m = new THREE.InstancedMesh(
    mergeGeos([box(.10, .012, .028), box(.028, .012, .11)]),   // a crude cross
    new THREE.MeshLambertMaterial({ color: 0x2e3138 }), BIRD_FLOCKS * BIRD_PER);
  m.frustumCulled = false; m.count = BIRD_FLOCKS * BIRD_PER;
  scene.add(m);
  return m;
})();
const flocks = [];
function seedFlocks() {
  flocks.length = 0;
  for (let f = 0; f < BIRD_FLOCKS; f++) {
    const r = S.mulberry32(city.seed ^ (0xb1d + f * 977));
    flocks.push({
      cx: 20 + r() * (W - 40), cz: 20 + r() * (H - 40),
      rad: 5 + r() * 9, h: 5 + r() * 7, phase: r() * TAU,
      spd: 0.09 + r() * 0.08, drift: r() * TAU,
    });
  }
}
function stepBirds(dt, now) {
  let k = 0;
  for (const f of flocks) {
    f.phase += dt * f.spd;
    f.cx += Math.cos(f.drift) * dt * 0.35;
    f.cz += Math.sin(f.drift) * dt * 0.35;
    if (f.cx < 10 || f.cx > W - 10 || f.cz < 10 || f.cz > H - 10) f.drift += Math.PI * 0.55;
    for (let b = 0; b < BIRD_PER; b++) {
      const a = f.phase + b * 0.42;
      const rr = f.rad * (0.72 + 0.28 * Math.sin(b * 1.7));
      const x = f.cx + Math.cos(a) * rr;
      const z = f.cz + Math.sin(a) * rr * 0.8;
      const y = f.h + Math.sin(a * 2.1 + b) * 0.5;
      _q.setFromAxisAngle(YAXIS, -a + Math.PI / 2);
      // Wingbeat, as a squash on the cross rather than real wings.
      const beat = 0.7 + 0.5 * Math.abs(Math.sin(now * 6 + b * 1.3));
      _v.set(x, y, z);
      _sc.set(1, beat, 1);
      _m.compose(_v, _q, _sc);
      birdMesh.setMatrixAt(k++, _m);
    }
  }
  birdMesh.count = k;
  birdMesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------ cloud shadows
const cloudTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  // Wrapped blobs: each is drawn nine times so nothing is cut at the seam.
  for (let k = 0; k < 26; k++) {
    const cx = Math.random() * 256, cy = Math.random() * 256, r = 22 + Math.random() * 52;
    for (let ox = -256; ox <= 256; ox += 256) for (let oy = -256; oy <= 256; oy += 256) {
      const rad = g.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
      rad.addColorStop(0, 'rgba(255,255,255,.52)');
      rad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rad;
      g.beginPath(); g.arc(cx + ox, cy + oy, r, 0, TAU); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.2, 2.2);
  return t;
})();
// Sits above the whole scene rather than on the ground: at this pitch the
// parallax is invisible, and clouds get to shade the buildings too.
const cloudPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(W * 3, H * 3).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: 0.19, color: 0x1a2630, depthWrite: false })
);
cloudPlane.renderOrder = 3;
scene.add(cloudPlane);

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
    const base = new THREE.Vector3(p.x + P.w / 2, padH(p.x, p.y), p.y + P.h / 2);
    g.position.copy(base);
    plantGroup.add(g);

    const per = p.kind === 'coal' ? 5 : 3;
    for (const top of tops) for (let k = 0; k < per; k++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: puffTex, transparent: true, depthWrite: false,
        color: p.kind === 'coal' ? 0xb9b2a4 : 0xd8d4c8,
      }));
      const origin = base.clone().add(top).add(new THREE.Vector3(0, 1.3, 0));
      sp.position.copy(origin);
      smokeGroup.add(sp);
      puffs.push({ sp, origin, phase: k / per + Math.random() * 0.1 });
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
// Trees now refuse everything but Raze and Green, and a refusal that shows
// nothing at all just reads as a broken mouse.
const CURSOR_OK = 0xfff4d0, CURSOR_NO = 0xd8503c;
const ROAD_TOOLS = { dirt: 1, street: 1, boulevard: 1 };
const SVC_TOOLS = { school: 1, fire: 1, police: 1, church: 1, civic: 1 };
function cursorAllows(x, y) {
  const i = idx(x, y);
  if (tool === 'inspect') return true;
  if (tool === 'bridge') return city.terrain[i] === T.WATER;
  if (city.terrain[i] === T.WATER) return false;
  if (city.terrain[i] === T.TREE) return tool === 'bulldoze' || tool === 'park';
  if (tool === 'bulldoze') return true;
  // Pavement climbs what a foundation cannot, so the two limits differ.
  const limit = ROAD_TOOLS[tool] ? S.MAX_ROAD_SLOPE : S.MAX_BUILD_SLOPE;
  if (tool !== 'park' && city.slope[i] > limit) return false;
  if (SVC_TOOLS[tool] || tool === 'coal' || tool === 'oil') return !city.road[i] && !city.service[i];
  return true;
}
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
  rubble.clear(); rising.clear(); cars.length = 0;
  prevBld.set(city.bld);
  roadVer = -1;
  reshapeGround();
  paintAll();
  computeFarmSites();
  seedFlocks();
  peds.length = 0;
  rebuildBridges();
  rebuildTrees();
  rebuildPlants();
  rebuildBuildings();
  waterTiles = [];
  for (let i = 0; i < N; i++) if (city.terrain[i] === T.WATER) waterTiles.push(i);
  if (ovrMode !== 'none') paintOverlay();
}

// ------------------------------------------------------------------- audio
const audio = makeAudio();
audio.loadPlaylist();
// A discreet line in the clock bar naming what is on, the way a set would.
audio.setOnTrack(t => {
  const el = document.getElementById('nowPlaying');
  if (!el) return;
  el.textContent = t ? t.title : '';
  el.classList.remove('hide');
});

// ---------------------------------------------------------------- induction
// Only ever on a NEW city. Opening a saved one means you have played before,
// and being told to pave a street over a city of nine thousand is insulting.
const tutorial = makeTutorial({ onFinish: () => toast('Induction complete') });
let tutAcc = 0;

// ---------------------------------------------------------------- settings
const OPTS = [
  { k: 'daynight', lab: 'Day and night', sub: 'The light moves; the year does not' },
  { k: 'traffic', lab: 'Traffic', sub: 'Motor cars on the streets' },
  { k: 'sound', lab: 'Sound', sub: 'Ambience, whistles and bells' },
  { k: 'music', lab: 'Music', sub: 'Period records, shuffled' },
  { k: 'shadows', lab: 'Cast shadows', sub: 'Sunlight and building shadows' },
  { k: 'scale', lab: 'Render detail', sub: 'Lower this if the map stutters', on: 'Full', off: 'Half' },
  { k: 'haze', lab: 'Distance haze', sub: 'Atmospheric fade at the map edge' },
  { k: 'smoke', lab: 'Stack smoke', sub: 'Plumes from the generating stations' },
  { k: 'lots', lab: 'Lot lines', sub: 'Survey boundaries drawn on zoned land' },
  { k: 'autosave', lab: 'Autosave', sub: 'File the city every minute' },
  { k: 'tutorial', lab: 'Induction', sub: 'Commission memoranda on a new city' },
];
function applySettings() {
  renderer.shadowMap.enabled = !!SET.shadows;
  scene.fog = SET.haze ? FOG : null;
  setFogFor(mode);
  smokeGroup.visible = !!SET.smoke;
  cloudPlane.visible = !!SET.haze;
  audio.setEnabled(!!SET.sound);
  audio.setMusic(!!SET.music);
  if (!SET.daynight) { dayT = 0.36; applyDaylight(); bldDirty = true; }
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
    const set = v => { SET[o.k] = v; sync(); saveSettings(); applySettings(); if (o.k === 'lots') paintAll(); };
    bOn.onclick = () => set(1);
    bOff.onclick = () => set(0);
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
  S.computeDistricts(city);
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
  hideCard();
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

function enterCity() {
  if (mode === 'street') leaveStreet();
  tutorial.stop();
  applyWorld();
  document.getElementById('mastName').textContent = current.name;
  document.title = 'CROSSTOWN — ' + current.name;
  view.cx = view.tx = W / 2; view.cz = view.tz = H / 2;
  view.yaw = 0; view.yawNow = 0; view.zoom = DEFAULT_ZOOM; view.zoomNow = ZOOMS[DEFAULT_ZOOM];
  lastRank = city.rank;
  playing = true;
  setSpeed(1);
  setOverlay('none');
  refreshTools(); updateHUD();
  hideOverlay();
  autosaveAcc = 0;
}
function startNew(name, seed) {
  city = S.makeCity(seed);
  S.stepCity(city);
  current = { slotId: null, name };
  enterCity();
  if (SET.tutorial) tutorial.start(city); else tutorial.stop();
}
function showTitle() {
  if (mode === 'street') leaveStreet();
  playing = false;
  bullEl.innerHTML = '';
  labelsEl.innerHTML = ''; labelPool.clear();
  const seed = (Math.random() * 1e6) | 0;
  city = S.makeCity(seed);
  S.stepCity(city);
  lastRank = city.rank;
  applyWorld();
  view.cx = view.tx = W / 2; view.cz = view.tz = H / 2;
  view.zoom = 3; view.zoomNow = ZOOMS[3];
  cursor.visible = false;
  setOverlay('none');
  show('scrTitle');
}

// -------------------------------------------------------------------- tools
const RS = S.ROAD_SPEC, SS = S.SVC_SPEC;
const TOOLS = [
  { id: 'dirt', k: 'Dirt', p: '$' + RS[S.ROAD.DIRT].cost, need: null, sw: '#7d6c50', key: '1' },
  { id: 'street', k: 'Street', p: '$' + RS[S.ROAD.STREET].cost, need: null, sw: '#54524c', key: '2' },
  { id: 'boulevard', k: 'Blvd', p: '$' + RS[S.ROAD.BOULEVARD].cost, need: null, sw: '#5f7c46', key: '3' },
  { id: 'bridge', k: 'Bridge', p: '$' + RS[S.ROAD.BRIDGE].cost, need: null, sw: '#8c8377', key: '4' },
  { id: 'line', k: 'Wire', p: '$' + S.COST.line, need: null, sw: '#4b4438', key: '5' },
  { id: 'bulldoze', k: 'Raze', p: '$' + S.COST.bulldoze + '/' + S.COST.fell, need: null, sw: '#9e3b2e', key: '6' },
  { id: 'zoneR', k: 'Dwelling', p: '$' + S.COST.zone, need: null, sw: '#9aa872', key: '7' },
  { id: 'zoneC', k: 'Trade', p: '$' + S.COST.zone, need: null, sw: '#7f96a8', key: '8' },
  { id: 'zoneI', k: 'Works', p: '$' + S.COST.zone, need: null, sw: '#a89a72', key: '9' },
  { id: 'coal', k: 'Coal', p: '$' + S.PLANTS.coal.cost, need: null, sw: '#6a6258', key: '0' },
  { id: 'oil', k: 'Oil', p: '$' + S.PLANTS.oil.cost, need: 'plant_oil', sw: '#7a7469', key: 'o' },
  { id: 'school', k: 'School', p: '$' + SS[S.SVC.SCHOOL].cost, need: null, sw: '#b8483a', key: 's' },
  { id: 'fire', k: 'Fire Stn', p: '$' + SS[S.SVC.FIRE].cost, need: null, sw: '#8e3a2e', key: 'f' },
  { id: 'police', k: 'Police', p: '$' + SS[S.SVC.POLICE].cost, need: 'police', sw: '#6d7480', key: 'l' },
  { id: 'church', k: 'Church', p: '$' + SS[S.SVC.CHURCH].cost, need: 'church', sw: '#e4dfcc', key: 'h' },
  { id: 'civic', k: 'Civic Hall', p: '$' + SS[S.SVC.CIVIC].cost, need: 'civic_hall', sw: '#d8d2c0', key: 'c' },
  { id: 'park', k: 'Green', p: '$' + S.COST.park, need: 'park', sw: '#5d8348', key: 'g' },
  { id: 'inspect', k: 'Inspect', p: 'free', need: null, sw: '#33488c', key: 'v' },
];
let tool = 'street';
const toolsEl = document.getElementById('tools');
TOOLS.forEach((t, n) => {
  const d = document.createElement('div');
  d.className = 'tool'; d.dataset.id = t.id;
  d.innerHTML = `<span class="swatch" style="background:${t.sw}"></span>
    <span class="k">${t.k}</span><span class="p">${t.p}</span>`;
  d.onclick = () => { if (!d.classList.contains('locked')) setTool(t.id); };
  toolsEl.appendChild(d);
  t.el = d; t.hotkey = t.key;
});
function setTool(id) {
  tool = id;
  if (id !== 'inspect') hideCard();
  for (const t of TOOLS) t.el.classList.toggle('on', t.id === id);
}
function refreshTools() {
  for (const t of TOOLS) {
    const locked = t.need && !city.unlocked.has(t.need);
    t.el.classList.toggle('locked', !!locked);
    if (locked && tool === t.id) setTool('street');
  }
}
// NOT called here: setTool reaches hideCard, whose card element is declared
// further down and would still be in its temporal dead zone. It runs in `go`.

// -------------------------------------------------------------- index card
const cardEl = document.getElementById('card');
const VALUE_BAND = v => v < 0.22 ? 'Poor' : v < 0.38 ? 'Modest' : v < 0.56 ? 'Fair' : v < 0.74 ? 'Good' : 'Prime';
const ZONE_NAME = { [Z.R]: 'Dwelling', [Z.C]: 'Trade', [Z.I]: 'Works' };
function hideCard() { cardEl.classList.remove('show'); }
function showCard(x, y, sx, sy) {
  const i = idx(x, y);
  const d = S.districtAt(city, i);
  const num = 100 + ((x * 17 + y * 7) % 420);
  const street = d ? d.name : city.road[i] ? 'Unnamed street' : 'Unplatted land';
  document.getElementById('cardAddr').textContent =
    city.zone[i] || city.road[i] ? `${num} ${street}` : street;
  document.getElementById('cardDist').textContent = d
    ? `${d.n} lots · ${d.pop.toLocaleString('en-US')} ${d.zone === Z.R ? 'residents' : 'jobs'}`
    : `tract ${city.seed} · ${x}, ${y}`;

  const rows = [];
  const put = (k, v) => rows.push(`<div class="cr"><span>${k}</span><b>${v}</b></div>`);
  if (city.service[i]) put('Use', S.SVC_SPEC[city.service[i]].name);
  else if (city.plant[i]) put('Use', 'Generating station');
  else if (city.road[i]) put('Use', S.ROAD_SPEC[city.road[i]].name);
  else if (city.park[i]) put('Use', 'Public green');
  else if (city.zone[i]) {
    put('Zoned', ZONE_NAME[city.zone[i]]);
    put('Storeys', city.bld[i] || '—');
    const shack = S.isShack(city, i);
    if (shack) put('Built as', 'Shack');
    const occ = !city.bld[i] ? 0
      : shack ? S.CAP_SHACK : S.CAP[city.zone[i]][city.bld[i]];
    put(city.zone[i] === Z.R ? 'Residents' : 'Jobs', city.powered[i] ? occ : 0);
  } else {
    put('Use', city.terrain[i] === T.WATER ? 'River' : city.terrain[i] === T.TREE ? 'Woodland' : 'Open ground');
    if (city.terrain[i] === T.TREE) put('To clear', '$' + S.COST.fell);
  }
  if (city.terrain[i] !== T.WATER) {
    put('Land value', VALUE_BAND(city.lv[i]));
    put('Ground', city.slope[i] > S.MAX_ROAD_SLOPE ? 'Cliff'
      : city.slope[i] > S.MAX_BUILD_SLOPE ? 'Too steep to build'
        : city.slope[i] > S.MAX_BUILD_SLOPE * 0.6 ? 'Sloping' : 'Level');
    if (city.zone[i] || city.bld[i]) {
      const miss = [];
      if (!city.cover[S.SVC.SCHOOL][i]) miss.push('school');
      if (!city.cover[S.SVC.FIRE][i]) miss.push('fire');
      if (!city.cover[S.SVC.POLICE][i]) miss.push('police');
      put('Served by', miss.length ? 'no ' + miss.join(', no ') : 'all services');
    }
    put('Frontage', city.roadDist[i] === 0 ? 'On the road'
      : !city.served[i] ? 'Out of reach'
        : city.roadDist[i] + (city.roadDist[i] === 1 ? ' lot away' : ' lots away'));
    put('Current', city.powered[i] ? 'Connected' : 'None');
    if (city.soot[i] > 0.12) put('Smoke', city.soot[i] > 0.34 ? 'Heavy' : 'Some');
  }
  document.getElementById('cardRows').innerHTML = rows.join('');

  const why = document.getElementById('cardWhy');
  const st = city.zone[i] ? city.stall[i] : 0;
  why.className = st === S.STALL.NO_ROAD || st === S.STALL.NO_POWER ? 'bad' : st === S.STALL.CAPPED ? 'warn' : '';
  why.textContent = st && S.STALL_TEXT[st] ? S.STALL_TEXT[st] : '';
  why.style.display = why.textContent ? '' : 'none';

  cardEl.classList.add('show');
  const w = 222, h = cardEl.offsetHeight || 190;
  cardEl.style.left = Math.min(innerWidth - w - 12, Math.max(12, sx + 16)) + 'px';
  cardEl.style.top = Math.min(innerHeight - h - 12, Math.max(12, sy - 40)) + 'px';
}

// --------------------------------------------------------- district labels
const labelsEl = document.getElementById('labels');
const labelPool = new Map();
const _proj = new THREE.Vector3();
function updateLabels() {
  if (!playing || mode === 'street' || !overlay.classList.contains('hide')) { labelsEl.style.display = 'none'; return; }
  labelsEl.style.display = '';
  const live = new Set();
  for (const d of city.districts) {
    live.add(d.anchor);
    let el = labelPool.get(d.anchor);
    if (!el) {
      el = document.createElement('div');
      el.className = 'dlab';
      labelsEl.appendChild(el);
      labelPool.set(d.anchor, el);
    }
    if (el.textContent !== d.name) el.textContent = d.name;
    _proj.set(d.x + 0.5, hAt(Math.round(d.x), Math.round(d.y)) + 2.6, d.y + 0.5).project(activeCam());
    if (_proj.z > 1) { el.style.opacity = '0'; continue; }
    el.style.left = ((_proj.x * 0.5 + 0.5) * innerWidth) + 'px';
    el.style.top = ((-_proj.y * 0.5 + 0.5) * innerHeight) + 'px';
    // Fades out when you are close enough to read the buildings themselves.
    el.style.opacity = view.zoomNow < 22 ? '0' : String(Math.min(1, (view.zoomNow - 22) / 12));
  }
  for (const [k, el] of labelPool) if (!live.has(k)) { el.remove(); labelPool.delete(k); }
}

// --------------------------------------------------------------- street level
function enterStreet() {
  if (!playing) return;
  mode = 'street';
  ensureRoadList();
  // Stand on the nearest piece of pavement to whatever you were looking at,
  // because standing in the middle of a field is a poor first impression.
  let best = -1, bd = 1e9;
  for (const i of roadList) {
    const x = i % W, y = (i / W) | 0;
    const d = (x - view.cx) ** 2 + (y - view.cz) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) {
    const bx = best % W, by = (best / W) | 0;
    walk.x = bx + 0.5; walk.z = by + 0.5;
    // Face ALONG the street. Inheriting the iso yaw drops you nose-first into
    // whichever wall happened to be there, which is a poor way to arrive.
    let dx = 0, dz = 1;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (inB(bx + ax, by + az) && city.road[idx(bx + ax, by + az)]) { dx = ax; dz = az; break; }
    }
    walk.yaw = Math.atan2(-dx, -dz);
  } else { walk.x = view.cx; walk.z = view.cz; }
  walk.pitch = -0.02;
  walk.ride = null;
  cursor.visible = false;
  setFogFor('street');
  document.body.classList.add('street');
  labelsEl.style.display = 'none';
}
function leaveStreet() {
  mode = 'iso';
  walk.ride = null;
  setFogFor('iso');
  document.body.classList.remove('street');
  view.tx = view.cx = Math.max(0, Math.min(W, walk.x));
  view.tz = view.cz = Math.max(0, Math.min(H, walk.z));
}
function toggleRide() {
  if (mode !== 'street') return;
  if (walk.ride) { walk.ride = null; toast('Stepped down'); return; }
  let best = null, bd = 1e9;
  for (const c of cars) {
    const fx = c.from % W, fy = (c.from / W) | 0;
    const d = (fx - walk.x) ** 2 + (fy - walk.z) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  if (best) { walk.ride = best; toast('Riding along'); }
  else toast('No traffic nearby');
}

// -------------------------------------------------------------------- input
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
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
    case 'dirt': did = S.setRoad(city, x, y, S.ROAD.DIRT); break;
    case 'street': did = S.setRoad(city, x, y, S.ROAD.STREET); break;
    case 'boulevard': did = S.setRoad(city, x, y, S.ROAD.BOULEVARD); break;
    case 'bridge': did = S.setRoad(city, x, y, S.ROAD.BRIDGE); if (did) rebuildBridges(); break;
    case 'school': did = S.placeService(city, x, y, S.SVC.SCHOOL); break;
    case 'fire': did = S.placeService(city, x, y, S.SVC.FIRE); break;
    case 'police': did = S.placeService(city, x, y, S.SVC.POLICE); break;
    case 'church': did = S.placeService(city, x, y, S.SVC.CHURCH); break;
    case 'civic': did = S.placeService(city, x, y, S.SVC.CIVIC); break;
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
  if (tool === 'bulldoze') { rebuildPlants(); rebuildBridges(); }
  prevBld[idx(x, y)] = city.bld[idx(x, y)];
  bldDirty = true;
  return true;
}

let painting = false, panning = false, panFrom = null;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', ev => {
  audio.start();
  if (!playing) return;
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic event */ }
  if (mode === 'street') { panning = true; panFrom = { x: ev.clientX, y: ev.clientY }; return; }
  if (ev.button === 2 || ev.button === 1) { panning = true; panFrom = { x: ev.clientX, y: ev.clientY }; return; }
  const p = pick(ev);
  if (tool === 'inspect') { if (p) showCard(p.x, p.y, ev.clientX, ev.clientY); return; }
  painting = true;
  if (p) apply(p.x, p.y);
});
canvas.addEventListener('pointermove', ev => {
  if (!playing) return;
  if (mode === 'street') {
    if (!panning || !panFrom) return;
    const dx = ev.clientX - panFrom.x, dy = ev.clientY - panFrom.y;
    panFrom = { x: ev.clientX, y: ev.clientY };
    walk.yaw -= dx * 0.004;
    walk.pitch = Math.max(-1.2, Math.min(0.9, walk.pitch - dy * 0.003));
    return;
  }
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
    cursor.material.color.setHex(cursorAllows(p.x, p.y) ? CURSOR_OK : CURSOR_NO);
    cursor.visible = true;
    if (painting) apply(p.x, p.y);
  } else { cursor.visible = false; }
});
const endPointer = () => { painting = false; panning = false; panFrom = null; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', ev => {
  if (!playing || mode === 'street') return;
  ev.preventDefault();
  setZoom(view.zoom + Math.sign(ev.deltaY));
}, { passive: false });
function setZoom(z) {
  view.zoom = Math.max(0, Math.min(ZOOMS.length - 1, z));
  const b = document.getElementById('zoomOut');
  if (b) {
    b.classList.toggle('off', view.zoom >= ZOOMS.length - 1);
    document.getElementById('zoomIn').classList.toggle('off', view.zoom <= 0);
  }
}

const keys = new Set();
addEventListener('keydown', ev => {
  const k = ev.key.toLowerCase();
  audio.start();
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
  if (k === 'z') setZoom(view.zoom - 1);
  if (k === 'x') setZoom(view.zoom + 1);
  if (k === 'tab') { ev.preventDefault(); mode === 'iso' ? enterStreet() : leaveStreet(); return; }
  if (k === 'r' && mode === 'street') { toggleRide(); return; }
  if (mode === 'street') return;                     // no building from the pavement
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
// document.getElementById directly, not the `$` helper: that is declared with
// the HUD further down and would still be in its temporal dead zone here.
document.getElementById('zoomIn').onclick = () => setZoom(view.zoom - 1);
document.getElementById('zoomOut').onclick = () => setZoom(view.zoom + 1);
document.getElementById('streetBtn').onclick = () => (mode === 'iso' ? enterStreet() : leaveStreet());
document.getElementById('rideBtn').onclick = () => toggleRide();
document.getElementById('tutSkip').onclick = () => tutorial.skip();
document.getElementById('nowPlaying').onclick = () => audio.nextTrack();
for (const b of document.querySelectorAll('#ovr button')) b.onclick = () => setOverlay(b.dataset.o);

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
// A district crossing into existence is worth a line of its own — it is the
// city telling you it has decided a piece of itself is now a place.
let firesSeen = 0;
function noteFires() {
  if (city.fires.length <= firesSeen) { firesSeen = city.fires.length; return; }
  for (let k = firesSeen; k < city.fires.length; k++) {
    const f = city.fires[k];
    const d = S.districtAt(city, f.i);
    rubble.set(f.i, RUBBLE_SEC * 2);
    touch(f.i % W, (f.i / W) | 0);
    if (playing) bulletin('Fire', d ? `A block burned in ${d.name}. No station in reach.`
      : 'A block burned. No station in reach.');
  }
  firesSeen = city.fires.length;
}

const knownDistricts = new Set();
function noteDistricts() {
  for (const d of city.districts) {
    if (knownDistricts.has(d.anchor)) continue;
    knownDistricts.add(d.anchor);
    if (!playing || city.t < 20) continue;
    const kind = d.zone === Z.R ? 'now counted as a neighbourhood'
      : d.zone === Z.C ? 'now counted as a trading quarter'
      : 'now counted as an industrial quarter';
    bulletin(d.name, `${d.n} lots on the survey, ${kind}.`);
  }
}

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
  $('taxVal').textContent = Math.round(city.taxRate * 100) + '%';
  $('brokeWarn').classList.toggle('hide', city.funded);
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
  const hour = Math.floor(dayT * 24);
  $('season').textContent = SEASONS[Math.floor(city.t / 12) % 4] + ' · ' +
    String(hour).padStart(2, '0') + ':00';

  if (city.rank !== lastRank) {
    if (playing) {
      const title = S.MILESTONES[city.rank].title;
      bulletin(title, RANK_BLURB[title] || '');
      refreshTools();
    }
    lastRank = city.rank;
  }
}

// The tax lever. Raising it pays for the stations and puts people off in the
// same stroke — without the second half the only sane rate would be the cap.
for (const b of document.querySelectorAll('#taxRow [data-d]')) {
  b.onclick = () => {
    S.setTax(city, city.taxRate + (+b.dataset.d) * 0.01);
    updateHUD();
  };
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
  knownDistricts.clear(); firesSeen = 0;
  startNew(name, seed);
};
$('btnNewBack').onclick = () => show('scrTitle');
$('btnLoad').onclick = () => show('scrLoad');
$('btnLoadBack').onclick = () => show('scrTitle');
$('btnContinue').onclick = ev => {
  const id = ev.currentTarget.dataset.id;
  if (id) { knownDistricts.clear(); firesSeen = 0; loadCity(id); }
};
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
    $('mastName').textContent = current.name;
    document.title = 'CROSSTOWN — ' + current.name;
    toast('City filed'); refreshPause();
  }
};
$('btnQuit').onclick = () => {
  if (confirm('Close the file? Anything unsaved is lost.')) showTitle();
};

// --------------------------------------------------------------------- loop
let last = performance.now(), acc = 0, hudAcc = 0, autosaveAcc = 0, waterAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  const active = playing && overlay.classList.contains('hide');

  if (!playing) {
    view.yaw += dt * 4.5;                     // slow turntable behind the title
  } else if (active) {
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

  if (SET.daynight && (active || !playing)) {
    dayT = (dayT + dt / DAY_SEC * (playing ? Math.max(1, speed) : 1)) % 1;
    applyDaylight();
    if (Math.abs(nightness - litDrawn) > 0.045) bldDirty = true;
  }

  const k = 1 - Math.pow(0.0022, dt);
  if (mode === 'street') {
    // Walk relative to where you are looking, which is the only thing that
    // feels right once the camera can turn.
    const sp = (keys.has('shift') ? 5.2 : 2.1) * dt;
    let fwd = 0, strafe = 0;
    if (keys.has('w') || keys.has('arrowup')) fwd += 1;
    if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
    if (keys.has('a') || keys.has('arrowleft')) strafe -= 1;
    if (keys.has('d') || keys.has('arrowright')) strafe += 1;
    if ((fwd || strafe) && !walk.ride) {
      walk.x += (Math.sin(walk.yaw) * -fwd + Math.cos(walk.yaw) * strafe) * sp;
      walk.z += (Math.cos(walk.yaw) * -fwd - Math.sin(walk.yaw) * strafe) * sp;
      walk.x = Math.max(0.5, Math.min(W - 0.5, walk.x));
      walk.z = Math.max(0.5, Math.min(H - 0.5, walk.z));
    }
    placeWalkCamera();
    // Hidden at street level: a dark sheet 14 units overhead is a low ceiling
    // when your eye is at 0.26.
    cloudPlane.visible = false;
  } else {
    view.cx += (view.tx - view.cx) * k;
    view.cz += (view.tz - view.cz) * k;
    view.yawNow += (view.yaw - view.yawNow) * (playing ? k : 1);
    view.zoomNow += (ZOOMS[view.zoom] - view.zoomNow) * k;
    placeCamera();
    cloudPlane.visible = !!SET.haze;
    cloudPlane.position.set(view.cx, 14, view.cz);
  }
  cloudTex.offset.x = (cloudTex.offset.x + dt * 0.0055) % 1;
  cloudTex.offset.y = (cloudTex.offset.y + dt * 0.0026) % 1;

  if (playing && speed) {
    acc += dt * TICK_HZ * speed;
    let n = 0;
    while (acc >= 1 && n < 8) { S.stepCity(city); acc -= 1; n++; }
    if (n) {
      noteChanges();
      noteDistricts();
      noteFires();
      bldDirty = true;
      markStallChanges();
      if (ovrMode !== 'none') { ovrAcc += dt; if (ovrAcc > 0.4) { paintOverlay(); ovrAcc = 0; } }
    }
  }

  waterAcc += dt;
  if (waterAcc > 0.28 && waterTiles.length) {
    waterAcc = 0; waterPhase += 1;
    for (const i of waterTiles) dirtyTiles.add(i);
  }

  stepRubble(dt);
  stepSmoke(dt);
  stepBirds(dt, now / 1000);
  if (active) { stepTraffic(dt); stepPeds(dt); }
  flushGround();
  if (bldDirty) rebuildBuildings();
  stepRising(dt);
  updateLabels();

  if (tutorial.active && active) {
    tutAcc += dt;
    if (tutAcc > 0.4) { tutorial.tick(city, tutAcc); tutAcc = 0; }
  }

  hudAcc += dt;
  if (hudAcc > 0.12) {
    updateHUD();
    audio.update(hudAcc, { res: city.pop.res, jobsI: city.pop.jobsI, dayT, speed: playing ? speed : 0 });
    hudAcc = 0;
  }

  if (playing && SET.autosave && current.slotId && speed) {
    autosaveAcc += dt;
    if (autosaveAcc > AUTOSAVE_SEC) { autosaveAcc = 0; saveCity(current.slotId, current.name); toast('Autosaved'); }
  }

  renderer.render(scene, activeCam());
}

// Blockers appear and clear as the grid changes; the marks have to follow.
const stallShadow = new Uint8Array(N);
function markStallChanges() {
  for (const i of city._zonedList) {
    if (stallShadow[i] === city.stall[i]) continue;
    stallShadow[i] = city.stall[i];
    dirtyTiles.add(i);
  }
}

// ---------------------------------------------------------------------- go
setTool('street');
applySettings();
paintSky(true);
applyDaylight();
onResize();
showTitle();
requestAnimationFrame(frame);

window.CROSSTOWN = {
  get city() { return city; }, S,
  sim: (n = 100) => {
    S.sim(city, n); S.computeDistricts(city);
    prevBld.set(city.bld); rising.clear();
    paintAll(); rebuildPlants(); rebuildBuildings(); updateHUD();
    return city.pop;
  },
  refresh: () => { applyWorld(); updateHUD(); },
  startNew, showTitle, saveCity, loadCity, listSlots, setOverlay, audio, SET, tutorial,
  enterStreet, leaveStreet, toggleRide, setZoom, get mode() { return mode; },
  get view() { return view; },
  setDay: t => { dayT = t; applyDaylight(); paintSky(true); bldDirty = true; },
  three: { scene, renderer, camera, camPersp, carMesh, cars, peds, walk, get roadList() { return roadList; } },
};
