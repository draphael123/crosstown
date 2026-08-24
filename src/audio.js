// CROSSTOWN — ambience. Entirely synthesised: no asset loading, nothing to
// vendor, nothing to wait for. Two noise beds whose level follows the city,
// plus three rare events that give the place a sense of scale.
//
// Browsers will not start an AudioContext without a gesture, so nothing here
// exists until start() is called from a real click or keypress.

const NOISE_SEC = 2;

// The music is ordinary <audio> elements rather than decoded buffers: an hour
// of it would be several hundred megabytes in memory as PCM, and the browser
// streams a file happily on its own.
const MUSIC_DIR = 'music/';

export function makeAudio() {
  let ctx = null, master = null, noiseBuf = null;
  let country = null, traffic = null, works = null;
  let enabled = true, running = false;
  let tracks = [], order = [], cursor = 0, player = null;
  let musicOn = true, musicVol = 0.5, onTrack = null;
  let whistleIn = 90 + Math.random() * 90;
  let birdIn = 12 + Math.random() * 20;
  let lastChime = -1;

  function noiseSource(buf) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true; s.start();
    return s;
  }
  // A bed is looping noise through one filter and its own gain, so the mix is
  // just three numbers that the city drives.
  function bed(type, freq, q, gain) {
    const src = noiseSource(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(master);
    return g;
  }

  function start() {
    if (running) { if (musicOn && player && player.paused) player.play().catch(() => {}); return; }
    if (musicOn && tracks.length && !player) playCurrent();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.34 : 0;
    master.connect(ctx.destination);

    const n = ctx.sampleRate * NOISE_SEC;
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    // Brown-ish: integrated white, which sits far lower than plain white noise
    // and reads as distance rather than as hiss.
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v + (Math.random() * 2 - 1) * 0.06);
      if (v > 1) v = 1; if (v < -1) v = -1;
      d[i] = v * 0.9;
    }

    country = bed('lowpass', 1100, 0.5, 0.055);   // open ground, always there
    traffic = bed('lowpass', 320, 0.9, 0.0);      // rises with population
    works = bed('bandpass', 180, 1.4, 0.0);       // rises with industry
    running = true;
  }

  function ramp(param, to, t = 1.5) {
    if (!ctx) return;
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(to, ctx.currentTime, t);
  }

  // A works whistle: two detuned saws, slow on, slow off. The beat between them
  // is what stops it sounding like a synth tone.
  function whistle() {
    if (!running || !enabled) return;
    const t = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.35);
    g.gain.setValueAtTime(0.16, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 2.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1200;
    for (const hz of [232, 235.5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = hz;
      o.connect(f); o.start(t); o.stop(t + 2.7);
    }
    f.connect(g); g.connect(master);
  }

  // A bell is a stack of inharmonic partials with different decay lengths —
  // equal-tempered harmonics sound like an organ, not a bell.
  function bell() {
    if (!running || !enabled) return;
    const t = ctx.currentTime;
    const partials = [[1, 0.5, 3.4], [2.02, 0.28, 2.1], [3.01, 0.16, 1.3], [4.18, 0.09, 0.8], [5.43, 0.05, 0.5]];
    for (const [mul, amp, dec] of partials) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 293.66 * mul;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * 0.22, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dec + 0.05);
    }
  }

  function chirp(at, base) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(base, at);
    o.frequency.exponentialRampToValueAtTime(base * 1.5, at + 0.05);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.035, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, at + 0.09);
    o.connect(g); g.connect(master);
    o.start(at); o.stop(at + 0.12);
  }
  function birds() {
    if (!running || !enabled) return;
    const t = ctx.currentTime, base = 2400 + Math.random() * 900;
    const n = 2 + ((Math.random() * 3) | 0);
    for (let k = 0; k < n; k++) chirp(t + k * (0.11 + Math.random() * 0.07), base);
  }

  // state: { res, jobsI, dayT (0..1), speed }
  function update(dt, state) {
    if (!running) return;
    const { res = 0, jobsI = 0, dayT = 0.4, speed = 1 } = state;
    const night = dayT < 0.22 || dayT > 0.80;

    ramp(country.gain, night ? 0.030 : 0.055, 2.5);
    ramp(traffic.gain, Math.min(0.10, res / 9000 * 0.10) * (night ? 0.35 : 1), 2.5);
    ramp(works.gain, Math.min(0.055, jobsI / 2500 * 0.055) * (night ? 0.6 : 1), 2.5);

    if (!enabled || !speed) return;

    whistleIn -= dt;
    if (whistleIn <= 0) {
      whistleIn = 150 + Math.random() * 180;
      if (jobsI > 250 && !night) whistle();
    }
    birdIn -= dt;
    if (birdIn <= 0) {
      birdIn = 9 + Math.random() * 26;
      if (res < 4000 && !night) birds();
    }
    // On the hour, four times a "day", once the town is big enough to have a church.
    const quarter = Math.floor(dayT * 4);
    if (quarter !== lastChime) {
      if (lastChime >= 0 && res > 600 && !night) bell();
      lastChime = quarter;
    }
  }

  // ---------------------------------------------------------------- music
  async function loadPlaylist() {
    try {
      const r = await fetch(MUSIC_DIR + 'manifest.json');
      if (!r.ok) return;
      const m = await r.json();
      tracks = m.tracks || [];
      reshuffle();
    } catch { /* no music shipped; the ambience beds still work */ }
  }
  // Shuffled, but never the same track twice in a row across a reshuffle.
  function reshuffle() {
    const last = order.length ? order[order.length - 1] : -1;
    order = tracks.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1], order[0]];
    cursor = 0;
  }
  function playCurrent() {
    if (!tracks.length || !musicOn) return;
    if (cursor >= order.length) reshuffle();
    const t = tracks[order[cursor]];
    if (!player) {
      player = new Audio();
      player.addEventListener('ended', () => { cursor++; playCurrent(); });
      // A missing or unplayable file must not stall the whole playlist.
      player.addEventListener('error', () => { cursor++; setTimeout(playCurrent, 400); });
    }
    player.src = MUSIC_DIR + t.slug + '.mp3';
    player.volume = musicVol;
    player.play().catch(() => { /* still waiting on a gesture */ });
    if (onTrack) onTrack(t);
  }

  return {
    start,
    loadPlaylist,
    get tracks() { return tracks; },
    get nowPlaying() { return tracks.length ? tracks[order[cursor]] : null; },
    setOnTrack(fn) { onTrack = fn; },
    setMusic(on) {
      musicOn = !!on;
      if (!musicOn) { if (player) player.pause(); }
      else if (player && player.src) player.play().catch(() => {});
      else playCurrent();
    },
    setMusicVolume(v) { musicVol = Math.max(0, Math.min(1, v)); if (player) player.volume = musicVol; },
    get musicVolume() { return musicVol; },
    nextTrack() { cursor++; playCurrent(); },
    get running() { return running; },
    setEnabled(on) {
      enabled = !!on;
      if (master) ramp(master.gain, enabled ? 0.34 : 0, 0.4);
    },
    update, whistle, bell, birds,
  };
}
