// CROSSTOWN — the induction. A run of memoranda from the Commission, one at a
// time, in the order a city actually has to be built.
//
// Non-blocking on purpose: nothing here locks a tool or stops the clock. It
// tells you what to do next and notices when you have done it. A tutorial that
// takes the controls away teaches you to wait rather than to build.

import * as S from './sim.js';

const { Z, N } = S;

// Counting helpers. All O(N) and run a couple of times a second, which is
// nothing next to a growth tick.
const countZone = (c, z) => { let n = 0; for (const i of c._zonedList) if (c.zone[i] === z) n++; return n; };
const countBuilt = (c, z) => { let n = 0; for (const i of c._zonedList) if (c.zone[i] === z && c.bld[i]) n++; return n; };
const countRoad = c => { let n = 0; for (let i = 0; i < N; i++) if (c.road[i]) n++; return n; };
const countSvc = (c, k) => c.services.filter(v => v.kind === k).length;
const poweredRoad = c => { for (let i = 0; i < N; i++) if (c.road[i] && c.powered[i]) return true; return false; };

// Each step: what to do, and how the game can tell you have done it. `need` is
// the target and `have` the progress, so the card can show a count instead of
// leaving you guessing whether it noticed.
export const STEPS = [
  {
    head: 'The tract',
    body: 'Pave a street. Lots build only within a few plots of a road, so the '
      + 'street comes before everything. Pick the Street tool and drag a line.',
    need: 10, have: c => countRoad(c),
    hint: 'lots paved',
  },
  {
    head: 'Current',
    body: 'Nothing will be built in the dark. Site a coal station on open '
      + 'ground beside your street — current runs along the pavement.',
    need: 1, have: c => c.plants.length,
    hint: 'generating stations',
  },
  {
    head: 'The connection',
    body: 'The station must touch the street, or the current has nowhere to go. '
      + 'Move it, or run Wire from the station to the road.',
    need: 1, have: c => (poweredRoad(c) ? 1 : 0),
    hint: 'streets carrying current',
  },
  {
    head: 'Dwellings',
    body: 'Zone for dwellings along your street. Zoning does not build anything '
      + '— it surveys the lots, and the city decides what goes up on them.',
    need: 24, have: c => countZone(c, Z.R),
    hint: 'lots zoned for dwelling',
  },
  {
    head: 'The first houses',
    body: 'Now wait. Set the clock to Run and watch. A lot needs frontage, '
      + 'current and demand — miss one and it stays a surveyed rectangle.',
    need: 6, have: c => countBuilt(c, Z.R),
    hint: 'houses standing',
  },
  {
    head: 'Work',
    body: 'Nobody will move to a town with no work. Zone for Works — they are '
      + 'dirty, so keep them downwind of where people live.',
    need: 18, have: c => countZone(c, Z.I),
    hint: 'lots zoned for works',
  },
  {
    head: 'Trade',
    body: 'And somewhere to spend a wage. Zone for Trade between the two. '
      + 'Dwellings, trade and works together are what makes a city grow — any '
      + 'two of the three settle at a village.',
    need: 18, have: c => countZone(c, Z.C),
    hint: 'lots zoned for trade',
  },
  {
    head: 'A schoolhouse',
    body: 'No school in reach and no dwelling will ever pass one storey, '
      + 'however good the land. Build one where it covers your houses.',
    need: 1, have: c => countSvc(c, S.SVC.SCHOOL),
    hint: 'schoolhouses',
  },
  {
    head: 'A fire station',
    body: 'Blocks out of reach of a station burn down, and they do not come '
      + 'back on their own. The Served sheet shows what is covered.',
    need: 1, have: c => countSvc(c, S.SVC.FIRE),
    hint: 'fire stations',
  },
  {
    head: 'The books',
    body: 'Stations cost money every quarter. Watch the Quarterly line — if it '
      + 'goes red and the treasury runs out, your services stop working until '
      + 'you fix it. The Rate control raises tax, and puts people off.',
    need: 1, have: c => (c.ledger.income > 0 ? 1 : 0),
    hint: 'quarters collected',
  },
  {
    head: 'Village',
    body: 'Three hundred and fifty residents and the Commission will let you '
      + 'build to two storeys. After that the city is yours — the survey '
      + 'sheets on the right will tell you what it needs.',
    need: 350, have: c => c.pop.res,
    hint: 'residents',
  },
];

export function makeTutorial({ onFinish } = {}) {
  const el = document.getElementById('tutorial');
  const numEl = document.getElementById('tutNum');
  const headEl = document.getElementById('tutHead');
  const bodyEl = document.getElementById('tutBody');
  const progEl = document.getElementById('tutProg');
  const barEl = document.getElementById('tutBar');
  let step = -1, active = false, doneFlash = 0;

  function render(c) {
    const s = STEPS[step];
    if (!s) return;
    numEl.textContent = 'Memorandum No. ' + (step + 1);
    headEl.textContent = s.head;
    bodyEl.textContent = s.body;
    const have = Math.min(s.need, s.have(c));
    progEl.textContent = have + ' / ' + s.need + ' ' + s.hint;
    barEl.style.width = (have / s.need * 100) + '%';
  }

  function advance(c) {
    step++;
    if (step >= STEPS.length) { finish(); return; }
    el.classList.remove('hide');
    el.classList.add('flash');
    doneFlash = 0.5;
    render(c);
  }

  function finish() {
    active = false;
    el.classList.add('hide');
    if (onFinish) onFinish();
  }

  return {
    get active() { return active; },
    get step() { return step; },
    start(c) { active = true; step = -1; advance(c); },
    stop() { finish(); },
    skip() { finish(); },
    // Called on a timer, not every frame — the checks are O(N) scans.
    tick(c, dt) {
      if (!active || !c) return;
      if (doneFlash > 0) { doneFlash -= dt; if (doneFlash <= 0) el.classList.remove('flash'); }
      const s = STEPS[step];
      if (!s) return;
      render(c);
      if (s.have(c) >= s.need) advance(c);
    },
  };
}
