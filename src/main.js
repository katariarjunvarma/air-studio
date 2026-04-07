import './style.css';
import { AirFX } from './effects.js';

// ─────────────────────────────────────────────────
//  Per-hand state factory
//  Each hand gets: Kalman filter, velocity tracker,
//  gesture debounce, and predicted position.
// ─────────────────────────────────────────────────
function makeHandState() {
  return {
    gesture:     'none',
    prevGesture: 'none',
    stableCount: 0,
    gestureTs:   0,
    gestureHistory: [],

    // ── 4-State Constant-Velocity Kalman ─────────────
    // State vector: [x, y, vx, vy]
    // Each axis is independent so we store two 2×2 sub-systems.
    // p_pos = position variance, p_vel = velocity variance,
    // p_cov = position-velocity cross-covariance.
    kf: {
      x:  0, y:  0,     // estimated position
      vx: 0, vy: 0,     // estimated velocity (px/frame)
      // Error covariance (per axis, 2×2 symmetric)
      pxx: 1, pyy: 1,   // position variance
      pvx: 1, pvy: 1,   // velocity variance
      pxvx: 0, pyvy: 0, // position-velocity covariance
      seeded: false,
    },

    // ── EMA post-filter (adaptive alpha) ─────────────
    // Applied after Kalman to kill residual micro-jitter.
    // Alpha increases with speed so fast motion stays responsive.
    ema: null,

    // Velocity (EMA-smoothed, px/frame) — for stroke width + prediction
    vel:   { x: 0, y: 0 },
    speed: 0,

    // Final predicted position (Kalman estimate + velocity * PRED_F)
    pos: { x: 0, y: 0 },
    lastSmoothed: null,  // unused — kept for compatibility only
    _shortWarmup: false,
  };
}

// ─────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────
const S = {
  landmarker: null,
  isReady:    false,
  isModal:    true,

  strokes:   [],
  redoStack: [],
  current:   null,

  color:     '#00f0ff',
  thickness: 6,
  glow:      60,
  brush:     'normal',
  mirror:    false,
  grid:      false,

  // Per-hand states
  draw: makeHandState(),   // primary  (right) hand — draws
  ctrl: makeHandState(),   // secondary (left)  hand — controls

  // grab
  grabIdx:   -1,
  grabLast:  null,

  // camera
  camMode:   0,   // 0=on  1=dim  2=dark
  camAlpha:  0.35,
  pianoPaused: false,  // true while Air Piano tab is active

  // particles
  particles: [],

  W: 0, H: 0,
  audio: null,
  scratchGain: null,
  analyser: null,
  micWMod: 1,
};

// ─────────────────────────────────────────────────
//  DOM refs
// ─────────────────────────────────────────────────
const el    = id => document.getElementById(id);
const camCv = el('camera-canvas'),   camCtx = camCv.getContext('2d');
const drCv  = el('drawing-canvas'),  drCtx  = drCv.getContext('2d');
const uiCv  = el('ui-canvas'),       uiCtx  = uiCv.getContext('2d');
const video = el('video');

// Off-screen buffer canvas — caches all committed strokes for fast compositing
const bufCv  = document.createElement('canvas');
const bufCtx = bufCv.getContext('2d');

const COLORS = [
  '#00f0ff', '#ff00e5', '#39ff14', '#4d6dff',
  '#ff2d6b', '#ffd700', '#b400ff', '#ffffff',
];

// ── Feature 3: Finger → color mapping ─────────────
// index finger = currently selected S.color
// middle/ring/pinky get preset colours
const FINGER_COLORS = {
  middle: '#ff00e5',
  ring:   '#39ff14',
  pinky:  '#ffd700',
};

// Landmark index for each finger tip
const FINGER_TIP = { index: 8, middle: 12, ring: 16, pinky: 20 };

const DRAW_SET = new Set(['index', 'middle', 'ring', 'pinky']);
const IS_DRAW = g => DRAW_SET.has(g);

// ─────────────────────────────────────────────────
//  Audio
// ─────────────────────────────────────────────────
function ensureAudio() {
  if (!S.audio) {
    S.audio = new AudioContext();
    
    // Scratch continuous sound
    const bufferSize = Math.floor(S.audio.sampleRate * 0.5); // 0.5s is enough since it loops
    const noiseBuffer = S.audio.createBuffer(1, bufferSize, S.audio.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
    }
    const noise = S.audio.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const filter = S.audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1000;

    S.scratchGain = S.audio.createGain();
    S.scratchGain.gain.value = 0;

    noise.connect(filter);
    filter.connect(S.scratchGain);
    S.scratchGain.connect(S.audio.destination);
    noise.start(0);
  }
  if (S.audio.state === 'suspended') S.audio.resume();
}

function beep(freq, type = 'sine', ms = 80, vol = 0.035) {
  try {
    ensureAudio();
    const osc  = S.audio.createOscillator();
    const gain = S.audio.createGain();
    osc.connect(gain); gain.connect(S.audio.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, S.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, S.audio.currentTime + ms / 1000);
    osc.start(); osc.stop(S.audio.currentTime + ms / 1000);
  } catch (_) {}
}

function playTone(gesture) {
  try {
    ensureAudio();
    const now = S.audio.currentTime;
    const osc = S.audio.createOscillator();
    const gain = S.audio.createGain();
    osc.connect(gain); gain.connect(S.audio.destination);
    
    if (gesture === 'draw') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(554.37, now + 0.1);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now); osc.stop(now + 0.2);
    } else if (gesture === 'erase') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.15);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now); osc.stop(now + 0.2);
    } else if (gesture === 'idle') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(330, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.15);
      gain.gain.setValueAtTime(0.03, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now); osc.stop(now + 0.2);
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────────
//  Canvas resize
// ─────────────────────────────────────────────────
function resize() {
  const oldW = S.W || window.innerWidth;
  const oldH = S.H || window.innerHeight;
  S.W = window.innerWidth; S.H = window.innerHeight;
  for (const cv of [camCv, drCv, uiCv, bufCv]) { cv.width = S.W; cv.height = S.H; }
  vignetteGrad = null;  // invalidate cached gradient

  // Scale all stroke positions proportionally to survive resize
  if (oldW > 0 && oldH > 0 && (oldW !== S.W || oldH !== S.H)) {
    const sx = S.W / oldW;
    const sy = S.H / oldH;
    for (const s of S.strokes) {
      for (const p of s.pts) { p.x *= sx; p.y *= sy; }
    }
    if (S.current) {
      for (const p of S.current.pts) { p.x *= sx; p.y *= sy; }
    }
  }
  redraw();
}

// ─────────────────────────────────────────────────
//  HAND TRACKING — ONE-EURO FILTER
//
//  Replaces the Kalman + EMA + Prediction pipeline.
//
//  Why One-Euro is better for air drawing:
//    • Kalman assumes constant-velocity — hands violate this
//      constantly (stop, start, reverse direction).
//    • The One-Euro filter adapts cutoff based on SPEED:
//      - Slow/stationary → heavy smoothing (kills jitter)
//      - Fast motion     → light smoothing (zero lag)
//    • Single algorithm, no 3-layer stack fighting itself.
//    • No velocity prediction that overshoots on direction change.
//
//  Reference: Casiez, Roussel, Vogel — CHI 2012
//  "1€ Filter: A Simple Speed-based Low-pass Filter"
// ─────────────────────────────────────────────────

// ── One-Euro Filter parameters ──────────────────
// Tuned for MediaPipe landmarks at ~30fps webcam:
//   min_cutoff: lower = less jitter when still, more lag
//   beta:       higher = more responsive during fast motion
//   d_cutoff:   smoothing on the speed estimate (rarely change)
const OEF_MIN_CUTOFF = 1.2;   // Hz — jitter removal when stationary
const OEF_BETA       = 0.015; // speed coefficient — responsiveness during motion
const OEF_D_CUTOFF   = 1.0;   // Hz — derivative smoothing

// ── Outlier rejection ───────────────────────────
// If a landmark jumps more than this many px in one frame,
// clamp it to max step — prevents single-frame spikes.
const MAX_STEP_PX = 80;

// One-Euro Filter — single axis instance
class OneEuro {
  constructor(minCutoff = OEF_MIN_CUTOFF, beta = OEF_BETA, dCutoff = OEF_D_CUTOFF) {
    this.minCutoff = minCutoff;
    this.beta      = beta;
    this.dCutoff   = dCutoff;
    this.xPrev     = null;
    this.dxPrev    = 0;
    this.tPrev     = 0;
  }

  _alpha(cutoff, Te) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Te);
  }

  filter(x, t) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }

    const Te = Math.max(t - this.tPrev, 1e-6);  // seconds between frames
    this.tPrev = t;

    // Filter the derivative (speed)
    const dx = (x - this.xPrev) / Te;
    const aD = this._alpha(this.dCutoff, Te);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    // Adaptive cutoff: fast motion → higher cutoff → less smoothing
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);

    // Filter the signal
    const a = this._alpha(cutoff, Te);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;

    return xHat;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }
}

// Per-hand smoothing state: separate One-Euro filters for X and Y
function makeFilters() {
  return {
    x: new OneEuro(),
    y: new OneEuro(),
    // Speed filter for stroke width (separate, more aggressive smoothing)
    speed: new OneEuro(0.8, 0.005, 1.0),
    lastRawX: null,
    lastRawY: null,
  };
}

function smoothPos(hs, rawPx) {
  const f = hs.kf;  // reuse the 'kf' field to store our filters
  const now = performance.now() / 1000;  // seconds

  // ── Seed on first appearance ──────────────────
  if (!f._isOEF) {
    // First call: initialize One-Euro filters
    const filters = makeFilters();
    Object.assign(f, filters, { _isOEF: true, seeded: true });
    hs.vel = { x: 0, y: 0 };
    hs.speed = 0;
    hs.pos = { x: rawPx.x, y: rawPx.y };
    hs.ema = { x: rawPx.x, y: rawPx.y };  // compat: stored but not used for smoothing
    // Prime the filters
    f.x.filter(rawPx.x, now);
    f.y.filter(rawPx.y, now);
    f.lastRawX = rawPx.x;
    f.lastRawY = rawPx.y;
    return hs.pos;
  }

  // ── Outlier rejection: clamp jumps ────────────
  let rx = rawPx.x, ry = rawPx.y;
  if (f.lastRawX !== null) {
    const dx = rx - f.lastRawX, dy = ry - f.lastRawY;
    const jump = Math.hypot(dx, dy);
    if (jump > MAX_STEP_PX) {
      const scale = MAX_STEP_PX / jump;
      rx = f.lastRawX + dx * scale;
      ry = f.lastRawY + dy * scale;
    }
  }
  f.lastRawX = rx;
  f.lastRawY = ry;

  // ── One-Euro filter (X and Y) ─────────────────
  const sx = f.x.filter(rx, now);
  const sy = f.y.filter(ry, now);

  // ── Velocity + speed for stroke width ─────────
  // Compute from filtered positions (smooth)
  const prevX = hs.pos.x, prevY = hs.pos.y;
  const vx = sx - prevX, vy = sy - prevY;
  const rawSpeed = Math.hypot(vx, vy);
  const smoothSpeed = f.speed.filter(rawSpeed, now);

  hs.vel   = { x: vx, y: vy };
  hs.speed = smoothSpeed;

  // ── Output — no prediction needed ─────────────
  // One-Euro has near-zero lag at speed, so prediction would overshoot.
  hs.pos = { x: sx, y: sy };
  hs.ema = { x: sx, y: sy };  // compat field
  return hs.pos;
}

// Reset helper — called when hand disappears/reappears
function resetFilters(hs) {
  const f = hs.kf;
  if (f._isOEF) {
    f.x.reset(); f.y.reset(); f.speed.reset();
    f.lastRawX = null; f.lastRawY = null;
    f._isOEF = false;
  }
  f.seeded = false;
  hs.ema = null;
  hs.vel = { x: 0, y: 0 };
  hs.speed = 0;
}

// ─────────────────────────────────────────────────
//  Colour helpers
// ─────────────────────────────────────────────────
function brighten(hex) {
  // Guard: only process valid 7-char hex strings (e.g. #00f0ff)
  if (!hex || hex.length !== 7 || hex[0] !== '#') return hex;
  const r = Math.min(255, (parseInt(hex.slice(1,3),16) * 1.28) | 0);
  const g = Math.min(255, (parseInt(hex.slice(3,5),16) * 1.28) | 0);
  const b = Math.min(255, (parseInt(hex.slice(5,7),16) * 1.28) | 0);
  return `rgb(${r},${g},${b})`;
}

// ─────────────────────────────────────────────────
//  GESTURE ENGINE v4 — STRICT MUTUAL-EXCLUSIVE CLASSIFIER
//
//  Core design:
//    DRAW:  ONE finger clearly up, ALL others clearly down.
//           Physically impossible to confuse with erase.
//    ERASE: ALL 4 fingers uniformly high + wide spread.
//           Also requires wrist motion (wave) to activate.
//    MOVE:  Thumb-index pinch only, rest curled.
//
//  Priority (hard): ERASE > MOVE > DRAW
//  All gestures need multi-frame confirmation before activating.
//  Hysteresis prevents mode-switching flicker.
// ─────────────────────────────────────────────────

// ── Temporal stability (frames at ~30fps) ────────
const STABLE        = 4;    // frames to confirm DRAW (~133ms at 30fps)
const STABLE_CTRL   = 3;    // ctrl hand — faster response is fine
const STABLE_P      = 4;    // frames to confirm MOVE/pinch
const STABLE_ERASE  = 3;    // ERASE activates fast — instant palm = instant eraser
const STABLE_EXIT   = 3;    // frames of inertia before gesture releases
const WARMUP        = 100;  // ms before first draw point (avoids entry marks)
const HISTORY_LEN   = 6;    // majority-vote window
const MODE_LOCK_MS  = 350;  // hard mode lock — ignore gesture changes for this long after switch

// ── Detection thresholds ─────────────────────────
// All angles in degrees. Higher = more extended (straighter).
//   fully extended: ~160–170°
//   natural rest:   ~110–125°
//   clearly curled: ~60–90°
const T_EXTENDED   = 133;  // clearly pointing up (achievable for most users)
const T_FOLDED     = 122;  // clearly down — above natural rest (~110-125°)
const T_PALM_MIN   = 138;  // all fingers for open palm
const T_PALM_VAR   = 35;   // max variance in palm (uniform spread)
const T_PALM_SPAN  = 0.72; // min index-pinky span / palm width
const T_PINCH      = 0.24; // thumb-index dist / palm width
const T_PINCH_REST = 118;  // max curl for non-pinching fingers

// ── Mode lock state ───────────────────────────────
// Once a mode commits, ignore gesture changes for MODE_LOCK_MS.
// Prevents accidental mode switches mid-stroke.
let modeLockUntil = 0;

// ── Geometry helpers ─────────────────────────────
function dist3d(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z||0) - (b.z||0);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// Angle at vertex B, in degrees (0–180). 180 = straight.
function jointAngle(a, b, c) {
  const ba = { x: a.x-b.x, y: a.y-b.y, z: (a.z||0)-(b.z||0) };
  const bc = { x: c.x-b.x, y: c.y-b.y, z: (c.z||0)-(b.z||0) };
  const dot = ba.x*bc.x + ba.y*bc.y + ba.z*bc.z;
  const mag = (Math.sqrt(ba.x*ba.x+ba.y*ba.y+ba.z*ba.z)||1e-9) *
              (Math.sqrt(bc.x*bc.x+bc.y*bc.y+bc.z*bc.z)||1e-9);
  return Math.acos(Math.max(-1, Math.min(1, dot/mag))) * (180/Math.PI);
}

// Average of PIP and DIP joint angles — composite extension score.
// Returns ~160–170° for fully extended, ~60–80° for fully curled.
// Signature: (lm, mcp, pip, dip, tip) matching landmark indices.
function fingerCurl(lm, mcp, pip, dip, tip) {
  const pipAngle = jointAngle(lm[mcp], lm[pip], lm[dip]);
  const dipAngle = jointAngle(lm[pip], lm[dip], lm[tip]);
  return (pipAngle + dipAngle) * 0.5;
}

// Majority vote over a string array — returns most frequent element.
function majorityVote(arr) {
  if (!arr.length) return 'idle';
  const counts = {};
  let best = arr[0], bestN = 0;
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestN) { best = v; bestN = counts[v]; }
  }
  return best;
}

// ── Main gesture classifier — DRAW hand ──────────
//
//  Priority: ERASE > MOVE > DRAW
//
//  ERASE: all 4 fingers ≥ T_PALM_MIN, low variance, wide span
//         PHYSICALLY IMPOSSIBLE to also satisfy DRAW (one-finger-up)
//
//  MOVE:  thumb-index pinch + middle/ring/pinky clearly curled
//
//  DRAW:  one finger ≥ T_EXTENDED, all others ≤ T_FOLDED
//         Strict "others down" gate prevents palm-open false-draws.
//
function detect(lm) {
  const iCurl = fingerCurl(lm, 5,  6,  7,  8);   // index
  const mCurl = fingerCurl(lm, 9,  10, 11, 12);   // middle
  const rCurl = fingerCurl(lm, 13, 14, 15, 16);   // ring
  const pCurl = fingerCurl(lm, 17, 18, 19, 20);   // pinky

  const palmSc = Math.hypot(lm[5].x-lm[17].x, lm[5].y-lm[17].y) || 0.01;

  // ── PRIORITY 1: ERASE ────────────────────────
  // Requires all 4 fingers uniformly and highly extended + spread.
  // This is geometrically incompatible with DRAW (any single-finger-up pose).
  const palmMin  = Math.min(iCurl, mCurl, rCurl, pCurl);
  const palmMax  = Math.max(iCurl, mCurl, rCurl, pCurl);
  const palmSpan = Math.hypot(lm[8].x-lm[20].x, lm[8].y-lm[20].y) / palmSc;
  if (palmMin >= T_PALM_MIN && (palmMax - palmMin) <= T_PALM_VAR && palmSpan >= T_PALM_SPAN) {
    return 'open_palm';
  }

  // ── PRIORITY 2: MOVE (pinch) ─────────────────
  // Thumb+index touching, middle/ring/pinky clearly folded.
  const pinchNorm = Math.hypot(lm[4].x-lm[8].x, lm[4].y-lm[8].y) / palmSc;
  const restCurled = mCurl < T_PINCH_REST && rCurl < T_PINCH_REST && pCurl < T_PINCH_REST;
  if (pinchNorm < T_PINCH && restCurled) return 'pinch';

  // ── PRIORITY 3: DRAW ─────────────────────────
  // One finger clearly extended AND all others clearly folded.
  // The "others down" gate is the key strictness requirement.
  const FINGER_DEFS = [
    { name: 'index',  curl: iCurl, others: [mCurl, rCurl, pCurl] },
    { name: 'middle', curl: mCurl, others: [iCurl, rCurl, pCurl] },
    { name: 'ring',   curl: rCurl, others: [iCurl, mCurl, pCurl] },
    { name: 'pinky',  curl: pCurl, others: [iCurl, mCurl, rCurl] },
  ];

  for (const f of FINGER_DEFS) {
    const othersDown = f.others.every(c => c <= T_FOLDED);
    if (f.curl >= T_EXTENDED && othersDown) return f.name;
  }

  // ── Fallback: dominance-based ─────────────────────
  // If strict gate fails (others not perfectly curled), use relative
  // approach: the most extended finger wins if it clearly dominates.
  const fingers = [
    { name: 'index',  curl: iCurl },
    { name: 'middle', curl: mCurl },
    { name: 'ring',   curl: rCurl },
    { name: 'pinky',  curl: pCurl },
  ].sort((a, b) => b.curl - a.curl);
  const top = fingers[0], second = fingers[1];
  if (top.curl >= 128 && (top.curl - second.curl) >= 25) return top.name;

  return 'idle';
}

// ── Control-hand gesture classifier ──────────────
function detectCtrl(lm) {
  const iCurl = fingerCurl(lm, 5,  6,  7,  8);
  const mCurl = fingerCurl(lm, 9,  10, 11, 12);
  const rCurl = fingerCurl(lm, 13, 14, 15, 16);
  const pCurl = fingerCurl(lm, 17, 18, 19, 20);

  const palmSc = Math.hypot(lm[5].x-lm[17].x, lm[5].y-lm[17].y) || 0.01;
  const pinchN = Math.hypot(lm[4].x-lm[8].x,  lm[4].y-lm[8].y)  / palmSc;

  // Ctrl pinch: thumb+index, others clearly down
  if (pinchN < 0.26 && mCurl < T_PINCH_REST && rCurl < T_PINCH_REST && pCurl < T_PINCH_REST) {
    return 'ctrl_pinch';
  }

  // Open palm: all 4 up + uniform + spread (undo gesture)
  const palmMin  = Math.min(iCurl, mCurl, rCurl, pCurl);
  const palmMax  = Math.max(iCurl, mCurl, rCurl, pCurl);
  const palmSpan = Math.hypot(lm[8].x-lm[20].x, lm[8].y-lm[20].y) / palmSc;
  if (palmMin >= T_PALM_MIN && (palmMax - palmMin) <= T_PALM_VAR && palmSpan >= T_PALM_SPAN) {
    return 'ctrl_palm';
  }

  // Peace sign: index+middle both clearly up, ring+pinky clearly down
  if (iCurl >= 138 && mCurl >= 138 && rCurl < T_FOLDED && pCurl < T_FOLDED) {
    return 'ctrl_peace';
  }

  // Single index: index up and all others clearly down
  if (iCurl >= T_EXTENDED && mCurl <= T_FOLDED && rCurl <= T_FOLDED && pCurl <= T_FOLDED) {
    return 'ctrl_index';
  }

  // Fist
  if (Math.max(iCurl, mCurl, rCurl, pCurl) < 118) return 'ctrl_idle';

  return 'ctrl_idle';
}

// ── Stabilized gesture resolver ───────────────────
//    Majority vote over history + frame-count gate + hysteresis.
//    A gesture must win the majority AND persist for N frames
//    before it is committed. Current gesture is held for STABLE_EXIT
//    frames even if the raw signal has already changed — prevents
//    single-frame glitches from breaking strokes mid-draw.
function resolveGesture(hs, rawGesture, isCtrlHand = false) {
  hs.gestureHistory.push(rawGesture);
  if (hs.gestureHistory.length > HISTORY_LEN) hs.gestureHistory.shift();

  const voted = majorityVote(hs.gestureHistory);

  let threshold;
  if (isCtrlHand)                  threshold = STABLE_CTRL;
  else if (voted === 'open_palm')  threshold = STABLE_ERASE;
  else if (voted === 'pinch')      threshold = STABLE_P;
  else                             threshold = STABLE;

  if (voted === hs.gesture) {
    hs.stableCount = Math.min(hs.stableCount + 1, threshold + 3);
  } else {
    const exitThresh = IS_DRAW(hs.prevGesture) ? STABLE_EXIT + 2 : STABLE_EXIT;
    if (hs.stableCount > exitThresh) {
      hs.stableCount--;
      return hs.prevGesture;   // hold — hysteresis
    }
    hs.gesture     = voted;
    hs.stableCount = 1;
  }
  return hs.stableCount >= threshold ? hs.gesture : hs.prevGesture;
}

// ═══════════════════════════════════════════════════════════
//  STROKE RENDERING v2 — Catmull-Rom Ribbon Pipeline
//
//  Architecture:
//    Sparse control points → Catmull-Rom spline → Dense
//    resample with interpolated width → Variable-width
//    filled ribbon polygon → Anti-aliased edges
//
//  Why this replaces the v1 per-segment lineWidth approach:
//    • Zero visible joints — one continuous filled shape
//    • Perfectly smooth width transitions along the curve
//    • True anti-aliased edges from Canvas polygon fill
//    • Geometrically correct round endcaps
//    • Minimal controlled glow (not heavy multi-layer blur)
//    • Premium Apple-Pencil-quality visual output
// ═══════════════════════════════════════════════════════════
const DEAD_ZONE  = 2.8;   // px — minimum movement to register a point
const VMAX       = 22;    // px/frame → maximum speed for width mapping
const SPLINE_RES = 2.5;   // px between interpolated points (lower = smoother)

// ── Catmull-Rom Spline ──────────────────────────────────
// Uniform Catmull-Rom interpolation between p1↔p2.
// p0 and p3 guide the tangent at segment endpoints.
// Returns {x, y, w} at parameter t ∈ [0, 1].
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const h = (a, b, c, d) =>
    0.5 * ((-a + 3*b - 3*c + d)*t3 + (2*a - 5*b + 4*c - d)*t2 + (-a + c)*t + 2*b);
  return {
    x: h(p0.x, p1.x, p2.x, p3.x),
    y: h(p0.y, p1.y, p2.y, p3.y),
    w: Math.max(0.1, h(p0.w ?? 1, p1.w ?? 1, p2.w ?? 1, p3.w ?? 1)),
  };
}

// Densely interpolate control points through a Catmull-Rom spline.
// Output spacing ≈ `res` px → smooth curves even from sparse input.
function splinePoints(pts, res = SPLINE_RES) {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: pts[0].x, y: pts[0].y, w: pts[0].w ?? 1 }];
  if (n === 2) {
    const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const steps = Math.max(2, Math.ceil(d / res));
    return Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps;
      return {
        x: pts[0].x + (pts[1].x - pts[0].x) * t,
        y: pts[0].y + (pts[1].y - pts[0].y) * t,
        w: (pts[0].w ?? 1) + ((pts[1].w ?? 1) - (pts[0].w ?? 1)) * t,
      };
    });
  }
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(2, Math.ceil(chord / res));
    for (let j = 0; j < steps; j++) out.push(catmullRom(p0, p1, p2, p3, j / steps));
  }
  const last = pts[n - 1];
  out.push({ x: last.x, y: last.y, w: last.w ?? 1 });
  return out;
}

// ── Ribbon Geometry Engine ──────────────────────────────
// Computes left/right edge offset curves from a dense centerline.
// Each point is offset by ±half-width along the local perpendicular.
// Returns flat Float64Arrays for efficient Canvas path building.
function ribbonEdges(pts, thickness) {
  const N = pts.length;
  const L = new Float64Array(N * 2);
  const R = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    const hw = thickness * p.w * 0.5;
    // Central-difference tangent; forward/backward at endpoints
    let tx, ty;
    if (i === 0)       { tx = pts[1].x - p.x;           ty = pts[1].y - p.y; }
    else if (i === N-1){ tx = p.x - pts[i-1].x;         ty = p.y - pts[i-1].y; }
    else               { tx = pts[i+1].x - pts[i-1].x;  ty = pts[i+1].y - pts[i-1].y; }
    const mag = Math.hypot(tx, ty) || 1e-9;
    const nx = -ty / mag, ny = tx / mag;  // perpendicular
    const j = i << 1;
    L[j] = p.x + nx * hw;  L[j+1] = p.y + ny * hw;
    R[j] = p.x - nx * hw;  R[j+1] = p.y - ny * hw;
  }
  return { L, R, N };
}

// Fill a ribbon polygon: left edge forward → right edge backward → close.
function fillRibbon(ctx, { L, R, N }, color, alpha) {
  if (N < 2) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(L[0], L[1]);
  for (let i = 2; i < N * 2; i += 2) ctx.lineTo(L[i], L[i+1]);
  for (let i = (N-1) * 2; i >= 0; i -= 2) ctx.lineTo(R[i], R[i+1]);
  ctx.closePath();
  ctx.fill();
}

// Round endcaps — geometrically correct circles at stroke tips.
function ribbonCaps(ctx, pts, thickness, color, alpha) {
  if (pts.length < 1) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const f = pts[0], l = pts[pts.length - 1];
  const r0 = thickness * f.w * 0.5;
  ctx.beginPath(); ctx.arc(f.x, f.y, Math.max(0.5, r0), 0, Math.PI * 2); ctx.fill();
  if (pts.length > 1) {
    const r1 = thickness * l.w * 0.5;
    ctx.beginPath(); ctx.arc(l.x, l.y, Math.max(0.5, r1), 0, Math.PI * 2); ctx.fill();
  }
}

// Mirror-flip helper for symmetry mode
function flipX(pts) {
  return pts.map(p => ({ x: S.W - p.x, y: p.y, w: p.w ?? 1, s: p.s }));
}

// ── Extract base hue from hex colour (shared by gradient brush) ──
function hexToHue(hex) {
  if (!hex || hex[0] !== '#') return 0;
  const r = parseInt(hex.slice(1,3),16) / 255;
  const g = parseInt(hex.slice(3,5),16) / 255;
  const b = parseInt(hex.slice(5,7),16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r)      h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

// ═════════════════════════════════════════════════════════
//  BRUSH RENDERERS — Each uses the spline→ribbon pipeline
// ═════════════════════════════════════════════════════════

// ── Normal: Clean, solid, Apple-Pencil-quality stroke ───
// Two-pass: subtle expanded softness + solid core ribbon.
// Center highlight adds depth without heavy glow.
function renderNormal(ctx, s, flip) {
  if (s.pts.length < 2) return;
  const src   = flip ? flipX(s.pts) : s.pts;
  const dense = splinePoints(src);
  const th    = s.thickness;
  const g     = s.glow / 100;

  // Pass 1 — Soft edge bloom (subtle, not neon)
  if (g > 0.05) {
    const outerE = ribbonEdges(dense, th * 2.0);
    fillRibbon(ctx, outerE, s.color, 0.055 * g);
    ribbonCaps(ctx, dense, th * 2.0, s.color, 0.055 * g);

    const midE = ribbonEdges(dense, th * 1.35);
    fillRibbon(ctx, midE, s.color, 0.13 * g);
    ribbonCaps(ctx, dense, th * 1.35, s.color, 0.13 * g);
  }

  // Pass 2 — Solid core ribbon (the actual stroke)
  const coreE = ribbonEdges(dense, th);
  fillRibbon(ctx, coreE, s.color, 1);
  ribbonCaps(ctx, dense, th, s.color, 1);

  // Pass 3 — Center highlight spine (adds ink depth)
  const hlE = ribbonEdges(dense, th * 0.32);
  fillRibbon(ctx, hlE, brighten(s.color), 0.45);

  ctx.globalAlpha = 1;
}

// ── Neon: Atmospheric glow with bright thin core ────────
// Layered expanded ribbons create light-tube effect.
// Core is narrow and white-hot for contrast.
function renderNeon(ctx, s, flip) {
  if (s.pts.length < 2) return;
  const src   = flip ? flipX(s.pts) : s.pts;
  const dense = splinePoints(src);
  const th    = s.thickness;
  const g     = s.glow / 100;

  // Glow layers (outer → inner, decreasing width, increasing alpha)
  const layers = [
    [th * 5.0, 0.022 * g],
    [th * 3.0, 0.045 * g],
    [th * 1.8, 0.10  * g],
    [th * 1.1, 0.30  * g],
  ];
  for (const [w, a] of layers) {
    const e = ribbonEdges(dense, w);
    fillRibbon(ctx, e, s.color, a);
    ribbonCaps(ctx, dense, w, s.color, a);
  }

  // Bright coloured core
  const coreE = ribbonEdges(dense, th * 0.5);
  fillRibbon(ctx, coreE, brighten(s.color), 1);
  ribbonCaps(ctx, dense, th * 0.5, brighten(s.color), 1);

  // White-hot center spine
  const spineE = ribbonEdges(dense, th * 0.16);
  fillRibbon(ctx, spineE, '#ffffff', 0.82);

  ctx.globalAlpha = 1;
}

// ── Calligraphy: Angle-modulated nib width ──────────────
// Width varies with stroke direction vs a fixed 45° nib angle.
// Produces thick downstrokes / thin cross-strokes.
function renderCalligraphy(ctx, s, flip) {
  if (s.pts.length < 2) return;
  const src   = flip ? flipX(s.pts) : s.pts;
  const dense = splinePoints(src);
  const th    = s.thickness;
  const NIB   = Math.PI / 4;  // 45° nib angle

  // Modulate each point's width by direction vs nib angle
  for (let i = 0; i < dense.length; i++) {
    let angle;
    if (i === 0) angle = Math.atan2(dense[1].y - dense[0].y, dense[1].x - dense[0].x);
    else angle = Math.atan2(dense[i].y - dense[i-1].y, dense[i].x - dense[i-1].x);
    const perp = Math.abs(Math.sin(angle - NIB));
    dense[i].w = dense[i].w * (0.15 + perp * 1.1);
  }

  const coreE = ribbonEdges(dense, th);
  fillRibbon(ctx, coreE, s.color, 0.92);
  ribbonCaps(ctx, dense, th, s.color, 0.92);
  ctx.globalAlpha = 1;
}

// ── Spray: Scattered dots along spline-smoothed path ────
function renderSpray(ctx, s, flip) {
  const src = flip ? flipX(s.pts) : s.pts;
  const pts = splinePoints(src, 6);  // wider spacing for scatter
  ctx.fillStyle = s.color;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const R = s.thickness * (p.w ?? 1) * 2.2;
    const seed = (s.pts[Math.min(i, s.pts.length - 1)]?.s) ?? (i * 17);
    for (let j = 0; j < 18; j++) {
      const angle = ((seed + j * 43) % 628) * 0.01;
      const dist  = ((seed * 3 + j * 7) % 100) / 100 * R;
      ctx.globalAlpha = 0.12 + ((seed + j) % 4) * 0.06;
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(angle) * dist, p.y + Math.sin(angle) * dist,
              0.5 + ((seed + j) % 3) * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ── Glitter: Sparkle pattern along smoothed path ────────
function renderGlitter(ctx, s, flip) {
  const src = flip ? flipX(s.pts) : s.pts;
  const pts = splinePoints(src, 5);
  ctx.strokeStyle = s.color; ctx.lineCap = 'round';
  for (let i = 0; i < pts.length; i += 2) {
    const p  = pts[i];
    const sz = s.thickness * (p.w ?? 1) * 0.6;
    for (let arm = 0; arm < 4; arm++) {
      const a  = (arm / 4) * Math.PI * 2 + (i % 8) * 0.22;
      const jx = ((i * 13 + arm * 7) % 8) - 4;
      const jy = ((i * 7  + arm * 11) % 8) - 4;
      ctx.beginPath();
      ctx.lineWidth = sz * 0.45; ctx.globalAlpha = 0.55 + (i % 3) * 0.15;
      ctx.moveTo(p.x + jx, p.y + jy);
      ctx.lineTo(p.x + jx + Math.cos(a) * sz, p.y + jy + Math.sin(a) * sz);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.globalAlpha = 0.9;
    ctx.arc(p.x, p.y, sz * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = brighten(s.color); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── Gradient: Hue-shifting ribbon with subtle glow ──────
// Colour rotates along the stroke length via chunked ribbons.
function renderGradient(ctx, s, flip) {
  if (s.pts.length < 2) return;
  const src   = flip ? flipX(s.pts) : s.pts;
  const dense = splinePoints(src);
  const th    = s.thickness;
  const g     = s.glow / 100;
  const baseHue = hexToHue(s.color);

  // Render in chunks of ~8 dense points, each with a shifted hue
  const CHUNK = 8;
  for (let start = 0; start < dense.length - 1; start += CHUNK) {
    const end = Math.min(dense.length, start + CHUNK + 1);
    const seg = dense.slice(start, end);
    if (seg.length < 2) continue;

    const hue     = (baseHue + start * 1.5) % 360;
    const hslCore = `hsl(${hue}, 100%, 72%)`;
    const hslGlow = `hsl(${hue}, 100%, 50%)`;

    // Subtle glow
    if (g > 0.05) {
      const ge = ribbonEdges(seg, th * 1.8);
      fillRibbon(ctx, ge, hslGlow, 0.07 * g);
    }

    // Core
    const ce = ribbonEdges(seg, th);
    fillRibbon(ctx, ce, hslCore, 1);
  }

  // Endcaps
  const startHue = baseHue;
  const endHue   = (baseHue + (dense.length - 1) * 1.5) % 360;
  ctx.globalAlpha = 1;
  ctx.fillStyle = `hsl(${startHue}, 100%, 72%)`;
  const f = dense[0];
  ctx.beginPath(); ctx.arc(f.x, f.y, th * f.w * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `hsl(${endHue}, 100%, 72%)`;
  const l = dense[dense.length - 1];
  ctx.beginPath(); ctx.arc(l.x, l.y, th * l.w * 0.5, 0, Math.PI * 2); ctx.fill();

  ctx.globalAlpha = 1;
}

// ── Stroke dispatch ─────────────────────────────────────
function renderStroke(ctx, s, flip = false) {
  if (!s.pts || s.pts.length < 2) return;
  switch (s.brush) {
    case 'neon':        renderNeon(ctx, s, flip);        break;
    case 'calligraphy': renderCalligraphy(ctx, s, flip); break;
    case 'spray':       renderSpray(ctx, s, flip);       break;
    case 'glitter':     renderGlitter(ctx, s, flip);     break;
    case 'gradient':    renderGradient(ctx, s, flip);    break;
    default:            renderNormal(ctx, s, flip);      break;
  }
}

function paintStroke(ctx, s) {
  renderStroke(ctx, s, false);
  if (S.mirror) renderStroke(ctx, s, true);
}

// Rebuild the off-screen buffer from all committed strokes
// Called only when strokes change: undo, erase, grab, clear, resize
function rebuildBuffer() {
  bufCtx.clearRect(0, 0, S.W, S.H);
  for (const s of S.strokes) paintStroke(bufCtx, s);
}

// Composite buffer + live stroke onto the visible drawing canvas
function compositeDrawLayer() {
  drCtx.clearRect(0, 0, S.W, S.H);
  drCtx.drawImage(bufCv, 0, 0);
  if (S.current && S.current.pts.length > 1) paintStroke(drCtx, S.current);
}

// Commit a completed stroke: push to array + render onto buffer
function commitStroke(stroke) {
  if (stroke && stroke.pts.length > 1) {
    S.strokes.push(stroke);
    paintStroke(bufCtx, stroke);
    S.redoStack = [];  // new stroke clears redo history
    updateActionBtns();
  }
}

// Full redraw = rebuild buffer + composite to screen
function redraw() {
  rebuildBuffer();
  drCtx.clearRect(0, 0, S.W, S.H);
  drCtx.drawImage(bufCv, 0, 0);
}

// ─────────────────────────────────────────────────
//  Erase — POINT-BASED (not stroke-based)
//  Removes individual points within the erase radius
//  instead of deleting entire strokes. Much safer
//  against accidental wipes.
// ─────────────────────────────────────────────────
const ERASE_R        = 36;   // px radius of eraser circle
const ERASE_VEL_MIN  = 2.5;  // px/frame — minimum velocity to erase (prevents accidental)
let   erasePrevPos   = null; // previous frame's erase position (for line interpolation)
let   lastEraseBeep  = 0;    // throttle erase beeps to avoid rapid-fire buzz

function eraseAt(x, y) {
  const r2 = ERASE_R * ERASE_R;
  let changed = false;

  for (let i = S.strokes.length - 1; i >= 0; i--) {
    const s = S.strokes[i];
    const before = s.pts.length;
    s.pts = s.pts.filter(p => (p.x - x) ** 2 + (p.y - y) ** 2 >= r2);
    if (s.pts.length < before) changed = true;
    // Remove stroke entirely if too few points remain to be visible
    if (s.pts.length < 2) {
      S.strokes.splice(i, 1);
    }
  }
  if (changed) {
    redraw();
    updateActionBtns();
    // Throttle beep to max once every 200ms
    const now = performance.now();
    if (now - lastEraseBeep > 200) {
      beep(200, 'triangle', 50, 0.022);
      lastEraseBeep = now;
    }
  }
}

// Line-based erase: interpolate circles along the path from (x1,y1)→(x2,y2).
// Step size = ERASE_R * 0.4 so circles overlap — no gaps even at high velocity.
function eraseAlongPath(x1, y1, x2, y2) {
  const dist  = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(dist / (ERASE_R * 0.4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    eraseAt(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
  }
}

// ─────────────────────────────────────────────────
//  Grab / move stroke
// ─────────────────────────────────────────────────
function nearestStroke(x, y) {
  let best = Infinity, idx = -1;
  const GRAB_RANGE = 88;
  const GRAB_R2 = GRAB_RANGE * GRAB_RANGE;
  S.strokes.forEach((s, i) => {
    // Bounding-box pre-filter: skip strokes that are too far
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (x < minX - GRAB_RANGE || x > maxX + GRAB_RANGE ||
        y < minY - GRAB_RANGE || y > maxY + GRAB_RANGE) return;
    // Fine check within bounding box
    for (const p of s.pts) {
      const d = (p.x-x)**2 + (p.y-y)**2;
      if (d < best) { best = d; idx = i; }
    }
  });
  return best < GRAB_R2 ? idx : -1;
}

// ─────────────────────────────────────────────────
//  Particles
// ─────────────────────────────────────────────────
const MAX_PARTICLES = 200;

function spark(x, y, color) {
  // Cap particles to prevent unbounded growth
  while (S.particles.length > MAX_PARTICLES - 3) S.particles.shift();
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 0.6 + Math.random() * 1.8;
    S.particles.push({ x, y, vx: Math.cos(a)*v, vy: Math.sin(a)*v - 0.3,
                        life: 1, color, r: 1 + Math.random()*2.2 });
  }
}
function tickParticles() {
  S.particles = S.particles.filter(p => p.life > 0);
  for (const p of S.particles) { p.x+=p.vx; p.y+=p.vy; p.vy+=0.08; p.life-=0.042; }
}
function drawParticles() {
  for (const p of S.particles) {
    uiCtx.globalAlpha = Math.max(0, p.life * 0.85);
    uiCtx.fillStyle   = p.color;
    uiCtx.beginPath(); uiCtx.arc(p.x, p.y, p.r, 0, Math.PI*2); uiCtx.fill();
  }
  uiCtx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────
//  Hand skeleton overlay
//  Draw hand = full colour overlay
//  Ctrl hand = muted blue-grey overlay (Feature 2)
// ─────────────────────────────────────────────────
const BONES = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];

// ── Per-finger tip color map for skeleton overlay (draw hand only) ──
const TIP_COLORS = { 8: null, 12: '#ff00e5', 16: '#39ff14', 20: '#ffd700' };
// tip 8 (index) uses S.color (user-selected)

// ── Landmark → pixel conversion with cover-crop adjustment ──
// MediaPipe landmarks are normalized to the full video frame.
// We map them through the cover-crop so they align with the drawn camera.
function lmX(landmark) {
  const vw = video.videoWidth || 1280;
  // landmark.x is 0–1 in video space; coverCrop.sx/sw defines the visible portion
  const px = (landmark.x * vw - coverCrop.sx) / (coverCrop.sw || vw) * S.W;
  return S.W - px;  // mirror (camera is flipped)
}
function lmY(landmark) {
  const vh = video.videoHeight || 720;
  return (landmark.y * vh - coverCrop.sy) / (coverCrop.sh || vh) * S.H;
}

function drawSkeleton(lm, isCtrl = false) {
  const lx = i => lmX(lm[i]);
  const ly = i => lmY(lm[i]);
  uiCtx.globalAlpha = isCtrl ? 0.20 : 0.32;
  uiCtx.strokeStyle = isCtrl ? 'rgba(140,160,200,0.5)' : 'rgba(255,255,255,0.6)';
  uiCtx.lineWidth   = 1;
  for (const [a,b] of BONES) {
    uiCtx.beginPath(); uiCtx.moveTo(lx(a),ly(a)); uiCtx.lineTo(lx(b),ly(b)); uiCtx.stroke();
  }
  uiCtx.globalAlpha = isCtrl ? 0.35 : 0.55;
  for (let i = 0; i < lm.length; i++) {
    const isTip = (i === 8 || i === 12 || i === 16 || i === 20);
    const tipRadius = isTip ? 5 : 2;
    let color;
    if (isCtrl) {
      color = 'rgba(140,160,200,0.6)';
    } else if (isTip) {
      // Each fingertip gets its designated drawing color
      color = TIP_COLORS[i] ?? S.color;
    } else {
      color = 'rgba(255,255,255,0.45)';
    }
    uiCtx.beginPath();
    uiCtx.arc(lx(i), ly(i), tipRadius, 0, Math.PI * 2);
    uiCtx.fillStyle = color;
    uiCtx.fill();
    // Draw a subtle glow ring around active fingertips (draw hand only)
    if (!isCtrl && isTip) {
      uiCtx.beginPath();
      uiCtx.arc(lx(i), ly(i), tipRadius + 4, 0, Math.PI * 2);
      uiCtx.strokeStyle = color;
      uiCtx.lineWidth = 1;
      uiCtx.globalAlpha = 0.25;
      uiCtx.stroke();
      uiCtx.globalAlpha = isCtrl ? 0.35 : 0.55;
    }
  }
  uiCtx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────
//  Finger extension visualizer
//  Shows 4 vertical bars near the wrist — one per finger.
//  Bar height = extension score (0–180°, mapped 0–100%).
//  Color:  cyan   = this is the active draw finger
//          green  = clearly extended (>140°)
//          yellow = borderline (125–140°)
//          orange = below draw threshold (<125°)
//  Also pulses a bright ring on the dominant fingertip.
// ─────────────────────────────────────────────────
function drawFingerStateViz(lm, currentGesture) {
  const FINGER_DEFS = [
    { name: 'index',  tip: 8,  mcp: 5,  pip: 6,  dip: 7  },
    { name: 'middle', tip: 12, mcp: 9,  pip: 10, dip: 11 },
    { name: 'ring',   tip: 16, mcp: 13, pip: 14, dip: 15 },
    { name: 'pinky',  tip: 20, mcp: 17, pip: 18, dip: 19 },
  ];

  const wristX = lmX(lm[0]);
  const wristY = lmY(lm[0]);

  // Bars start below the wrist
  const BAR_W    = 7;
  const BAR_GAP  = 5;
  const BAR_MAXH = 36;
  const startX   = wristX - (FINGER_DEFS.length * (BAR_W + BAR_GAP)) / 2;
  const baseY    = wristY + 22;

  for (let i = 0; i < FINGER_DEFS.length; i++) {
    const f    = FINGER_DEFS[i];
    const curl = fingerCurl(lm, f.mcp, f.pip, f.dip, f.tip);
    // Normalise: 50° (fully curled) → 0%, 175° (fully straight) → 100%
    const norm = Math.max(0, Math.min(1, (curl - 50) / 125));
    const barH = norm * BAR_MAXH;
    const bx   = startX + i * (BAR_W + BAR_GAP);
    const isDom = (f.name === currentGesture);

    // Bar colour
    let barColor;
    if (isDom)        barColor = '#00f0ff';
    else if (curl > 140) barColor = '#39ff14';
    else if (curl > 125) barColor = '#ffd700';
    else                 barColor = '#ff6a00';

    // Background track
    uiCtx.globalAlpha = 0.18;
    uiCtx.fillStyle = 'rgba(255,255,255,0.4)';
    uiCtx.fillRect(bx, baseY - BAR_MAXH, BAR_W, BAR_MAXH);

    // Filled portion (bottom-up)
    uiCtx.globalAlpha = isDom ? 0.9 : 0.55;
    uiCtx.fillStyle = barColor;
    uiCtx.fillRect(bx, baseY - barH, BAR_W, barH);

    // Pulsing ring on dominant fingertip
    if (isDom) {
      const tx = lmX(lm[f.tip]);
      const ty = lmY(lm[f.tip]);
      const t  = performance.now();
      const pulse = 1 + 0.35 * Math.sin(t * 0.012);
      uiCtx.beginPath();
      uiCtx.arc(tx, ty, 11 * pulse, 0, Math.PI * 2);
      uiCtx.strokeStyle = barColor;
      uiCtx.lineWidth = 2;
      uiCtx.globalAlpha = 0.75;
      uiCtx.stroke();

      // Small filled dot at tip
      uiCtx.beginPath();
      uiCtx.arc(tx, ty, 4, 0, Math.PI * 2);
      uiCtx.fillStyle = barColor;
      uiCtx.globalAlpha = 1;
      uiCtx.fill();
    }
  }
  uiCtx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────
//  Gesture HUD
// ─────────────────────────────────────────────────
const HUD = {
  none:      { e:'👋', t:'Show hand',  c:''      },
  idle:      { e:'✋', t:'Ready',      c:''      },
  fist:      { e:'✊', t:'Idle',       c:''      },
  index:     { e:'☝️', t:'Drawing',   c:'draw'  },
  middle:    { e:'✌️', t:'Color 2',   c:'draw'  },
  ring:      { e:'🤞', t:'Color 3',   c:'draw'  },
  pinky:     { e:'🤙', t:'Color 4',   c:'draw'  },
  open_palm: { e:'✋', t:'Erasing',   c:'erase' },
  pinch:     { e:'🤏', t:'Moving',    c:'grab'  },
};
let hudCurrent = 'none';    // what's currently displayed
let hudPending = 'none';    // what's waiting to be displayed
let hudStable  = 0;         // frames the pending gesture has been stable
const HUD_DEBOUNCE = 3;     // frames before HUD update applies

function setHUD(g) {
  if (g === hudPending) {
    hudStable++;
  } else {
    hudPending = g;
    hudStable = 1;
  }
  // Only update display when stable for enough frames (or returning to current)
  if (hudStable >= HUD_DEBOUNCE || g === hudCurrent) {
    if (g !== hudCurrent) {
      hudCurrent = g;
      const info = HUD[g] ?? HUD.none;
      el('hud-emoji').textContent = info.e;
      el('hud-text').textContent  = info.t;
      el('hud').className = `hud ${info.c}`;
    }
  }
}

// ─────────────────────────────────────────────────
//  Camera / background
// ─────────────────────────────────────────────────
let gridT = 0;
let vignetteGrad = null;  // cached vignette gradient

// Cover-crop parameters so video fills canvas without distortion.
// Also used to adjust landmark→pixel mapping.
const coverCrop = { sx: 0, sy: 0, sw: 0, sh: 0 };

function updateCoverCrop() {
  const vw = video.videoWidth  || 1280;
  const vh = video.videoHeight || 720;
  const canvasAR = S.W / S.H;
  const videoAR  = vw / vh;
  if (videoAR > canvasAR) {
    // Video is wider → crop sides
    coverCrop.sh = vh;
    coverCrop.sw = vh * canvasAR;
    coverCrop.sx = (vw - coverCrop.sw) / 2;
    coverCrop.sy = 0;
  } else {
    // Video is taller → crop top/bottom
    coverCrop.sw = vw;
    coverCrop.sh = vw / canvasAR;
    coverCrop.sx = 0;
    coverCrop.sy = (vh - coverCrop.sh) / 2;
  }
}

function renderCamera() {
  camCtx.clearRect(0, 0, S.W, S.H);

  if (S.camMode === 2) {
    camCtx.fillStyle = '#060608';
    camCtx.fillRect(0, 0, S.W, S.H);
  } else {
    updateCoverCrop();
    camCtx.save();
    camCtx.globalAlpha = S.camAlpha;
    camCtx.translate(S.W, 0); camCtx.scale(-1, 1);
    // Draw with cover-crop: source rect → dest canvas (no stretching)
    camCtx.drawImage(video,
      coverCrop.sx, coverCrop.sy, coverCrop.sw, coverCrop.sh,
      0, 0, S.W, S.H);
    camCtx.restore();
    // Use cached gradient (created/invalidated on resize)
    if (!vignetteGrad) {
      vignetteGrad = camCtx.createRadialGradient(S.W/2,S.H/2,0, S.W/2,S.H/2,S.W*0.72);
      vignetteGrad.addColorStop(0, 'rgba(6,6,8,0)');
      vignetteGrad.addColorStop(1, 'rgba(6,6,8,0.5)');
    }
    camCtx.fillStyle = vignetteGrad; camCtx.fillRect(0, 0, S.W, S.H);
  }

  if (S.grid) {
    gridT = (gridT + 0.2) % 36;
    const a = S.camMode === 2 ? 0.18 : 0.07;
    camCtx.fillStyle = `rgba(255,255,255,${a})`;
    for (let x = gridT % 36; x < S.W; x += 36) {
      for (let y = 0; y < S.H; y += 36) {
        camCtx.beginPath(); camCtx.arc(x, y, 1, 0, Math.PI*2); camCtx.fill();
      }
    }
  }
}

// ─────────────────────────────────────────────────
//  Gesture transitions — draw hand
// ─────────────────────────────────────────────────
function onGestureChange(from, to, pos) {
  const prevDraw = IS_DRAW(from);
  const nextDraw = IS_DRAW(to);
  const now      = performance.now();

  // ── CRITICAL: Immediately abort drawing when switching to ERASE or MOVE ──
  // No partial strokes left dangling on the canvas.
  if (S.current && (to === 'open_palm' || to === 'pinch')) {
    commitStroke(S.current);
    S.current = null;
  }

  // Ending a draw stroke (draw → any non-draw)
  if (prevDraw && !nextDraw && S.current) {
    commitStroke(S.current);
    S.current = null;
    playTone('idle');
  }

  // Finger switch (draw→draw, different finger)
  if (prevDraw && nextDraw && from !== to) {
    commitStroke(S.current);
    S.current = null;
    S.draw._shortWarmup = true;
    beep(660, 'sine', 30, 0.016);
  }

  if (from === 'pinch') {
    S.grabIdx = -1; S.grabLast = null;
    beep(330, 'sine', 120, 0.028);
  }

  // Reset erase path tracker when entering/leaving open_palm
  if (to === 'open_palm' || from === 'open_palm') {
    erasePrevPos = null;
  }

  // ── Set mode lock on any meaningful mode change ────────────────────────
  // Prevents immediate re-entry into a different mode for MODE_LOCK_MS.
  if (from !== to && from !== 'none' && to !== 'idle') {
    modeLockUntil = now + MODE_LOCK_MS;
  }

  if (!prevDraw && nextDraw) playTone('draw');
  if (to === 'open_palm')    playTone('erase');
  if (to === 'pinch') {
    S.draw.kf.seeded = false; S.draw.ema = null;
    S.grabIdx  = nearestStroke(pos.x, pos.y);
    S.grabLast = { ...pos };
    beep(660, 'sine', 80, 0.032);
  }
}

// ─────────────────────────────────────────────────
//  Control hand one-shot actions (Feature 2)
//  600 ms cooldown prevents repeated triggers
// ─────────────────────────────────────────────────
const BRUSHES = ['normal', 'neon', 'calligraphy', 'spray', 'glitter', 'gradient'];
let ctrlLastAction = 0;

function flashButton(id) {
  const btn = el(id);
  if (!btn) return;
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 250);
}

function onCtrlGestureChange(to) {
  const now = performance.now();
  if (now - ctrlLastAction < 600) return;  // reduced cooldown for snappier response

  switch (to) {
    case 'ctrl_palm':
      if (!S.strokes.length) break;
      S.redoStack.push(S.strokes.pop()); redraw();
      beep(380, 'sine', 70, 0.025);
      flashButton('undo-btn');  // visual feedback
      updateActionBtns();
      ctrlLastAction = now;
      break;

    case 'ctrl_index': {
      const ci = (COLORS.indexOf(S.color) + 1) % COLORS.length;
      S.color = COLORS[ci];
      getSwatches().forEach(s =>
        s.classList.toggle('active', s.dataset.color === S.color));
      beep(600, 'sine', 50, 0.022);
      ctrlLastAction = now;
      break;
    }

    case 'ctrl_peace': {
      const bi = (BRUSHES.indexOf(S.brush) + 1) % BRUSHES.length;
      S.brush = BRUSHES[bi];
      getBrBtns().forEach(b =>
        b.classList.toggle('active', b.dataset.brush === S.brush));
      beep(700, 'sine', 50, 0.022);
      ctrlLastAction = now;
      break;
    }

    case 'ctrl_pinch':
      S.grid = !S.grid;
      el('grid-btn').dataset.on = String(S.grid);
      beep(800, 'sine', 45, 0.022);
      ctrlLastAction = now;
      break;
  }
}

// Floating label shown near ctrl hand wrist
const CTRL_LABELS = {
  ctrl_palm:  '↩ Undo',
  ctrl_index: '🎨 Next Color',
  ctrl_peace: '🖌 Next Brush',
  ctrl_pinch: '⊞ Grid',
};

// ─────────────────────────────────────────────────
//  Active gesture handlers
// ─────────────────────────────────────────────────

// Feature 1 — Velocity-based width
// Feature 3 — Finger-colour mapping
// Feature 7 — Dead zone
function handleDraw(pos, gesture) {
  const warmup = S.draw._shortWarmup ? 50 : WARMUP;
  S.draw._shortWarmup = false;
  if (performance.now() - S.draw.gestureTs < warmup) return;

  // Start new stroke with the finger's designated colour
  if (!S.current) {
    const drawColor = FINGER_COLORS[gesture] ?? S.color;
    S.current = {
      color:     drawColor,
      thickness: S.thickness,
      glow:      S.glow,
      brush:     S.brush,
      pts:       [],
    };
  }

  // Feature 7 — Dead zone: skip if not moved enough
  const last = S.current.pts[S.current.pts.length - 1];
  if (last && Math.hypot(pos.x - last.x, pos.y - last.y) < DEAD_ZONE) return;

  // Feature 1 — Velocity width: slow=thick, fast=thin
  // Beat-sync drawing: scale thickness by mic volume
  const wMod = Math.max(0.3, Math.min(1.8, 1.8 - (S.draw.speed / VMAX) * 1.4)) * S.micWMod;
  S.current.pts.push({ x: pos.x, y: pos.y, w: wMod, s: (Math.random() * 65536) | 0 });

  if (S.current.pts.length % 4 === 0) spark(pos.x, pos.y, S.current.color);

  // Composite buffer + live stroke (no full repaint)
  compositeDrawLayer();

  // Fingertip dot
  uiCtx.beginPath();
  uiCtx.arc(pos.x, pos.y, Math.max(3, S.thickness/2 + 3), 0, Math.PI*2);
  uiCtx.fillStyle = S.current.color; uiCtx.globalAlpha = 0.45; uiCtx.fill();
  uiCtx.globalAlpha = 1;

  // Mirror axis
  if (S.mirror) {
    uiCtx.save();
    uiCtx.setLineDash([4, 6]);
    uiCtx.strokeStyle = 'rgba(255,255,255,0.1)';
    uiCtx.lineWidth = 1;
    uiCtx.beginPath(); uiCtx.moveTo(S.W/2, 0); uiCtx.lineTo(S.W/2, S.H); uiCtx.stroke();
    uiCtx.restore();
    uiCtx.beginPath();
    uiCtx.arc(S.W - pos.x, pos.y, 3, 0, Math.PI*2);
    uiCtx.fillStyle = S.current.color; uiCtx.globalAlpha = 0.2; uiCtx.fill();
    uiCtx.globalAlpha = 1;
  }
}

// ── handleErase: INSTANT velocity-based swipe eraser ──────────────────
// Activated immediately when open_palm commits — no dwell, no wave gate.
// Erases along the path between the previous and current palm position.
// Velocity gate (ERASE_VEL_MIN) prevents static-palm from erasing by accident.
function handleErase(lm) {
  // Use palm center (index MCP = lm[9]) as eraser anchor — most stable
  const ex = lmX(lm[9]);
  const ey = lmY(lm[9]);

  if (!erasePrevPos) {
    erasePrevPos = { x: ex, y: ey };
  }

  const vel = Math.hypot(ex - erasePrevPos.x, ey - erasePrevPos.y);

  // Only erase if the hand is actually moving (prevents phantom erase when still)
  if (vel >= ERASE_VEL_MIN) {
    eraseAlongPath(erasePrevPos.x, erasePrevPos.y, ex, ey);
  }

  erasePrevPos = { x: ex, y: ey };

  // ── Eraser cursor — scales with velocity (bigger swipe = bigger visual) ──
  const cursorR = ERASE_R + Math.min(16, vel * 1.2);
  const alpha   = 0.55 + Math.min(0.35, vel * 0.025);

  // Outer ring
  uiCtx.beginPath(); uiCtx.arc(ex, ey, cursorR, 0, Math.PI * 2);
  uiCtx.strokeStyle = `rgba(255,60,180,${alpha})`; uiCtx.lineWidth = 2.5; uiCtx.stroke();

  // Inner fill (semi-transparent, shows erase zone)
  uiCtx.beginPath(); uiCtx.arc(ex, ey, ERASE_R, 0, Math.PI * 2);
  uiCtx.fillStyle = `rgba(255,30,140,${0.08 + Math.min(0.10, vel * 0.008)})`; uiCtx.fill();

  // Crosshair
  uiCtx.strokeStyle = `rgba(255,60,180,0.25)`; uiCtx.lineWidth = 1;
  uiCtx.beginPath(); uiCtx.moveTo(ex - cursorR - 4, ey); uiCtx.lineTo(ex + cursorR + 4, ey); uiCtx.stroke();
  uiCtx.beginPath(); uiCtx.moveTo(ex, ey - cursorR - 4); uiCtx.lineTo(ex, ey + cursorR + 4); uiCtx.stroke();

  // Velocity indicator — small dot trails show movement direction
  if (vel >= ERASE_VEL_MIN) {
    const dx = ex - erasePrevPos.x || 0;
    const dy = ey - erasePrevPos.y || 0;
    const mag = Math.hypot(dx, dy) || 1;
    uiCtx.beginPath();
    uiCtx.arc(ex - (dx / mag) * (cursorR + 8), ey - (dy / mag) * (cursorR + 8), 3, 0, Math.PI * 2);
    uiCtx.fillStyle = 'rgba(255,60,180,0.6)'; uiCtx.fill();
  }
}

function handleGrab(pos, lm) {
  // ── Check fingers are still touching ─────────────
  // If the two fingers have separated, stop moving immediately.
  if (lm) {
    const palmSc = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y) || 0.01;
    const imNorm = Math.hypot(lm[8].x - lm[12].x, lm[8].y - lm[12].y) / palmSc;
    // Also check classic thumb-index pinch as fallback
    const pinchN = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / palmSc;
    // Keep threshold a bit looser than entry (0.45 vs 0.40) to avoid flicker at boundary
    const stillConnected = imNorm < 0.45 || pinchN < 0.30;
    if (!stillConnected) {
      // Fingers separated — release grip immediately without waiting for gesture debounce
      if (S.grabIdx >= 0) { S.grabIdx = -1; S.grabLast = null; }
      return;
    }
  }

  // ── Find nearest stroke on first frame ───────────
  if (S.grabIdx < 0) {
    S.grabIdx  = nearestStroke(pos.x, pos.y);
    S.grabLast = { ...pos };
  }
  if (!S.grabLast) { S.grabLast = { ...pos }; return; }

  // ── Move the grabbed stroke ───────────────────────
  const dx = pos.x - S.grabLast.x;
  const dy = pos.y - S.grabLast.y;
  S.grabLast = { ...pos };
  const s = S.strokes[S.grabIdx];
  if (!s) { S.grabIdx = -1; S.grabLast = null; return; }

  s.pts = s.pts.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
  rebuildBuffer();
  compositeDrawLayer();

  // Highlight grabbed stroke with bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  uiCtx.setLineDash([4, 4]);
  uiCtx.strokeStyle = 'rgba(255,210,0,0.4)'; uiCtx.lineWidth = 1;
  uiCtx.strokeRect(minX - 8, minY - 8, maxX - minX + 16, maxY - minY + 16);
  uiCtx.setLineDash([]);

  // Grab cursor ring at midpoint
  uiCtx.beginPath(); uiCtx.arc(pos.x, pos.y, 14, 0, Math.PI*2);
  uiCtx.strokeStyle = 'rgba(255,210,0,0.75)'; uiCtx.lineWidth = 2; uiCtx.stroke();

  // Show index + middle fingertip dots and connecting line when lm is available
  if (lm) {
    const ix = lmX(lm[8]), iy = lmY(lm[8]);
    const mx = lmX(lm[12]), my = lmY(lm[12]);
    // Connecting line between the two fingertips
    uiCtx.beginPath(); uiCtx.moveTo(ix, iy); uiCtx.lineTo(mx, my);
    uiCtx.strokeStyle = 'rgba(255,210,0,0.5)'; uiCtx.lineWidth = 1.5;
    uiCtx.setLineDash([3, 3]); uiCtx.stroke(); uiCtx.setLineDash([]);
    // Index tip dot
    uiCtx.beginPath(); uiCtx.arc(ix, iy, 5, 0, Math.PI*2);
    uiCtx.fillStyle = 'rgba(255,240,80,0.9)'; uiCtx.fill();
    // Middle tip dot
    uiCtx.beginPath(); uiCtx.arc(mx, my, 5, 0, Math.PI*2);
    uiCtx.fillStyle = 'rgba(255,240,80,0.9)'; uiCtx.fill();
  }
}

// ─────────────────────────────────────────────────
//  Main loop
// ─────────────────────────────────────────────────
let lastVt = -1;
let tooManyHands = false;  // flag to freeze drawing when 3+ hands detected
let fpsFrames = 0, fpsLast = performance.now(), showFps = false;

// Cached DOM collections for toolbar (avoid repeated querySelectorAll)
let cachedSwatches = null;
let cachedBrBtns   = null;
let _tbEl          = null;   // toolbar element — cached for auto-dim
function getSwatches() { return cachedSwatches || (cachedSwatches = document.querySelectorAll('.swatch')); }
function getBrBtns()   { return cachedBrBtns   || (cachedBrBtns   = document.querySelectorAll('.br-btn')); }

// Update undo/redo/clear button disabled states
function updateActionBtns() {
  el('undo-btn').classList.toggle('dim', !S.strokes.length);
  el('redo-btn').classList.toggle('dim', !S.redoStack.length);
  el('clear-btn').classList.toggle('dim', !S.strokes.length);
}

function loop() {
  requestAnimationFrame(loop);
  if (!S.isReady || S.isModal || S.pianoPaused) return;

  // FPS counter
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    if (showFps) el('fps-badge').textContent = `${fpsFrames} fps`;
    fpsFrames = 0; fpsLast = now;
  }

  // Beat sync logic (microphone)
  if (S.analyser) {
    const data = new Uint8Array(S.analyser.frequencyBinCount);
    S.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += data[i]; // sum lowest bins
    const avg = sum / 10;
    S.micWMod = 1 + (avg / 255) * 1.5; // Up to 2.5x thickness on loud bass
  }

  // Continuous draw scratch sound modulation
  if (S.scratchGain) {
    if (S.draw.gesture !== 'none' && S.draw.gesture !== 'open_palm' && S.draw.gesture !== 'fist' && S.draw.gesture !== 'pinch' && S.draw.gesture !== 'idle') {
      const targetVol = Math.min(0.08, S.draw.speed * 0.003);
      S.scratchGain.gain.setTargetAtTime(targetVol, S.audio?.currentTime || performance.now()/1000, 0.05);
    } else {
      S.scratchGain.gain.setTargetAtTime(0, S.audio?.currentTime || performance.now()/1000, 0.05);
    }
  }

  renderCamera();

  if (video.currentTime === lastVt) return;
  lastVt = video.currentTime;

  // Wrap detection in try-catch for resilience (e.g. GPU context lost)
  let result;
  try {
    result = S.landmarker.detectForVideo(video, performance.now());
  } catch (e) {
    console.warn('MediaPipe detection error:', e.message);
    return;  // skip this frame, try again next
  }
  const allLM    = result.landmarks    ?? [];
  const allHands = result.handedness   ?? [];

  uiCtx.clearRect(0, 0, S.W, S.H);
  tickParticles();
  drawParticles();

  // ── BUG FIX 1: Too many hands detection ───────────
  const warningEl = el('hand-warning');
  if (allLM.length > 2) {
    if (!tooManyHands) {
      tooManyHands = true;
      warningEl.classList.remove('hidden');
      beep(180, 'triangle', 200, 0.04);
      // Commit any in-progress stroke before freezing
      if (S.current) {
        commitStroke(S.current);
        S.current = null;
      }
    }
    setHUD('none');
    // Draw all detected skeletons in red-tinted warning style
    for (const lm of allLM) {
      const lx = i => lmX(lm[i]);
      const ly = i => lmY(lm[i]);
      uiCtx.globalAlpha = 0.15;
      uiCtx.strokeStyle = 'rgba(255,60,80,0.5)';
      uiCtx.lineWidth = 1;
      for (const [a,b] of BONES) {
        uiCtx.beginPath(); uiCtx.moveTo(lx(a),ly(a)); uiCtx.lineTo(lx(b),ly(b)); uiCtx.stroke();
      }
    }
    uiCtx.globalAlpha = 1;
    return;  // FREEZE — skip all drawing/erasing/grabbing
  } else if (tooManyHands) {
    // Hands back to ≤ 2 — resume
    tooManyHands = false;
    warningEl.classList.add('hidden');
    beep(660, 'sine', 80, 0.025);
  }

  // ── Feature 2: Identify draw vs ctrl hand ─────────
  // MediaPipe 'Right' = user's right (dominant) hand = draw
  // MediaPipe 'Left'  = user's left               hand = ctrl
  let drawLM = null, ctrlLM = null;

  if (allLM.length === 1) {
    // Check handedness: if only a left hand is detected, use it as ctrl
    const label = allHands[0]?.[0]?.categoryName;
    if (label === 'Left') {
      ctrlLM = allLM[0];
    } else {
      drawLM = allLM[0];
    }
  } else if (allLM.length >= 2) {
    for (let i = 0; i < allLM.length; i++) {
      const label = allHands[i]?.[0]?.categoryName;
      if (label === 'Right') drawLM = allLM[i];
      else                   ctrlLM = allLM[i];
    }
    // fallback if handedness unavailable
    if (!drawLM) { drawLM = allLM[0]; ctrlLM = allLM[1]; }
  }

  // ── Toolbar auto-dim when any hand is on screen ──────────────────────
  if (_tbEl && !_tbEl.classList.contains('collapsed')) {
    _tbEl.classList.toggle('hand-present', allLM.length > 0);
  }

  // ── Draw hand ─────────────────────────────────────
  if (!drawLM) {
    setHUD('none');
    if (S.current) {
      commitStroke(S.current);
      S.current = null; beep(440, 'sine', 80, 0.022);
    }
    // Full reset so next appearance starts clean (no filter jump, no stale vel)
    S.draw.gesture = 'none'; S.draw.prevGesture = 'none'; S.draw.stableCount = 0;
    S.draw.gestureHistory = [];
    resetFilters(S.draw);
    S.draw._shortWarmup = false;
    // Reset eraser path tracker when hand leaves
    erasePrevPos = null;
    modeLockUntil = 0;
  } else {
    drawSkeleton(drawLM, false);

    // Position source depends on current mode:
    //  • grab  → midpoint between index tip (lm[8]) and middle tip (lm[12])
    //  • draw  → tip of the active drawing finger
    //  • other → index tip as fallback
    let rawPx;
    if (S.draw.prevGesture === 'pinch') {
      rawPx = {
        x: (lmX(drawLM[8]) + lmX(drawLM[12])) * 0.5,
        y: (lmY(drawLM[8]) + lmY(drawLM[12])) * 0.5,
      };
    } else {
      const activeFinger = IS_DRAW(S.draw.prevGesture) ? S.draw.prevGesture : 'index';
      const tipIdx = FINGER_TIP[activeFinger];
      rawPx = { x: lmX(drawLM[tipIdx]), y: lmY(drawLM[tipIdx]) };
    }
    const pos = smoothPos(S.draw, rawPx);   // Kalman + prediction

    const det = detect(drawLM);

    // ── Mode lock: during lock period, freeze the committed gesture ──────────
    // Prevents flickering between modes mid-transition.
    const locked = performance.now() < modeLockUntil;
    const committed = locked ? S.draw.prevGesture : resolveGesture(S.draw, det);

    if (committed !== S.draw.prevGesture) {
      onGestureChange(S.draw.prevGesture, committed, pos);
      S.draw.prevGesture = committed;
      S.draw.gestureTs   = performance.now();
    }

    // ── Hard mode separation: ERASE and MOVE fully block DRAW ───────────────
    if (committed === 'open_palm') {
      // Erase mode: drawing is COMPLETELY disabled
      if (S.current) { commitStroke(S.current); S.current = null; }
      handleErase(drawLM);
    } else if (committed === 'pinch') {
      // Move mode: drawing is COMPLETELY disabled
      if (S.current) { commitStroke(S.current); S.current = null; }
      handleGrab(pos, drawLM);
    } else if (IS_DRAW(committed)) {
      // Draw mode: only runs when NOT in erase or move
      handleDraw(pos, committed);
    }

    // Finger state visualizer — shows per-finger extension bars + dominant tip ring
    drawFingerStateViz(drawLM, committed);

    // Pending gesture preview — if raw detection differs from committed,
    // show a faint ghost emoji above the index tip so the user can see
    // that the system IS reading the gesture before it commits.
    if (det !== committed && det !== 'idle' && det !== 'fist') {
      const previewInfo = HUD[det];
      if (previewInfo) {
        const px = lmX(drawLM[8]);
        const py = lmY(drawLM[8]) - 28;
        uiCtx.globalAlpha = 0.38;
        uiCtx.font = '16px sans-serif';
        uiCtx.textAlign = 'center';
        uiCtx.fillStyle = '#ffffff';
        uiCtx.fillText(previewInfo.e, px, py);
        uiCtx.textAlign = 'left';
        uiCtx.globalAlpha = 1;
      }
    }

    setHUD(committed);
  }

  // ── Control hand (Feature 2) ──────────────────────
  if (!ctrlLM && S.ctrl.prevGesture !== 'none') {
    // Reset ctrl state when hand leaves so re-entry starts fresh
    S.ctrl.gesture = 'none'; S.ctrl.prevGesture = 'none'; S.ctrl.stableCount = 0;
    S.ctrl.gestureHistory = [];
    resetFilters(S.ctrl);
  }

  if (ctrlLM) {
    drawSkeleton(ctrlLM, true);

    // Still Kalman-smooth the ctrl hand (for future cursor use)
    const ctrlRaw = { x: lmX(ctrlLM[8]), y: lmY(ctrlLM[8]) };
    smoothPos(S.ctrl, ctrlRaw);

    const det = detectCtrl(ctrlLM);
    const committed = resolveGesture(S.ctrl, det, true);  // isCtrlHand = true for faster debounce

    if (committed !== S.ctrl.prevGesture) {
      onCtrlGestureChange(committed);
      S.ctrl.prevGesture = committed;
    }

    // Floating label near ctrl hand wrist
    const label = CTRL_LABELS[committed];
    if (label) {
      const wx = lmX(ctrlLM[0]);
      const wy = lmY(ctrlLM[0]);
      uiCtx.font = '12px Inter, sans-serif';
      uiCtx.fillStyle = 'rgba(255,255,255,0.72)';
      uiCtx.textAlign = 'center';
      uiCtx.fillText(label, wx, Math.max(18, wy - 22));
      uiCtx.textAlign = 'left';
    }
  }
}

// ─────────────────────────────────────────────────
//  Toolbar setup
// ─────────────────────────────────────────────────
function hexShift(h, amt) {
  const r = Math.max(0, Math.min(255, parseInt(h.slice(1,3),16) + Math.round(255*amt)));
  const g = Math.max(0, Math.min(255, parseInt(h.slice(3,5),16) + Math.round(255*amt)));
  const b = Math.max(0, Math.min(255, parseInt(h.slice(5,7),16) + Math.round(255*amt)));
  return `rgb(${r},${g},${b})`;
}

function buildSwatches() {
  const container = el('swatches');
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.className = 'swatch' + (color === S.color ? ' active' : '');
    btn.dataset.color = color;
    btn.title = color;
    const light = hexShift(color, 0.45);
    const dark  = hexShift(color, -0.3);
    btn.style.background = `radial-gradient(circle at 35% 30%, ${light}, ${color} 55%, ${dark})`;
    btn.style.boxShadow  = `0 2px 8px ${color}44, inset 0 1px 0 rgba(255,255,255,0.2)`;
    btn.addEventListener('click', () => {
      S.color = color;
      document.querySelectorAll('.swatch').forEach(s =>
        s.classList.toggle('active', s.dataset.color === color));
      beep(600, 'sine', 50, 0.022);
    });
    container.appendChild(btn);
  }
}

function setupToolbar() {
  buildSwatches();

  el('brush-row').addEventListener('click', e => {
    const btn = e.target.closest('.br-btn');
    if (!btn) return;
    document.querySelectorAll('.br-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    S.brush = btn.dataset.brush;
    beep(700, 'sine', 50, 0.022);
  });

  el('thickness').addEventListener('input', e => {
    S.thickness = +e.target.value;
    el('thickness-val').textContent = S.thickness + 'px';
  });

  el('glow').addEventListener('input', e => {
    S.glow = +e.target.value;
    el('glow-val').textContent = S.glow + '%';
  });

  el('grid-btn').addEventListener('click', () => {
    S.grid = !S.grid;
    el('grid-btn').dataset.on = String(S.grid);
    beep(800, 'sine', 45, 0.022);
  });

  el('sym-btn').addEventListener('click', () => {
    S.mirror = !S.mirror;
    el('sym-btn').dataset.on = String(S.mirror);
    redraw();
    beep(900, 'sine', 45, 0.022);
  });

  el('undo-btn').addEventListener('click', () => {
    if (!S.strokes.length) return;
    S.redoStack.push(S.strokes.pop()); redraw();
    beep(380, 'sine', 70, 0.025);
    updateActionBtns();
  });

  el('redo-btn').addEventListener('click', () => {
    if (!S.redoStack.length) return;
    const stroke = S.redoStack.pop();
    S.strokes.push(stroke);
    paintStroke(bufCtx, stroke);
    redraw();
    beep(440, 'sine', 70, 0.025);
    updateActionBtns();
  });

  el('clear-btn').addEventListener('click', () => {
    if (!S.strokes.length) return;
    // Push all strokes to redo stack so clear is undoable
    S.redoStack.push(...S.strokes);
    S.strokes = []; S.current = null; redraw();
    beep(220, 'sine', 100, 0.022);
    updateActionBtns();
  });

  // Camera — 3 states
  const camStates = [
    { label: 'Camera ON',  alpha: 0.35, mode: 0, cls: ''    },
    { label: 'Camera DIM', alpha: 0.10, mode: 1, cls: 'dim' },
    { label: 'Dark Mode',  alpha: 0,    mode: 2, cls: 'dark'},
  ];
  let camIdx = 0;
  function applyCamera() {
    const st = camStates[camIdx];
    S.camAlpha = st.alpha; S.camMode = st.mode;
    el('cam-label').textContent = st.label;
    el('cam-pill').className    = `cam-pill ${st.cls}`.trim();
    beep(1100, 'sine', 42, 0.022);
  }
  el('cam-pill').addEventListener('click',    () => { camIdx = (camIdx+1) % 3; applyCamera(); });
  el('camera-btn').addEventListener('click',  () => { camIdx = (camIdx+1) % 3; applyCamera(); });

  // Save: click = with background, Shift+click = transparent drawing only
  // Save button — original SVG stored for restore after flash
  const _saveSvg = el('save-btn').innerHTML;
  const _checkSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3.5 3.5 6.5-7"/></svg>`;

  function savePNG(transparent = false) {
    const out = document.createElement('canvas');
    out.width = S.W; out.height = S.H;
    const ctx = out.getContext('2d');
    if (!transparent) ctx.drawImage(camCv, 0, 0);
    ctx.drawImage(drCv, 0, 0);
    const suffix = transparent ? '-transparent' : '';
    const a = document.createElement('a');
    a.download = `air-draw${suffix}-${Date.now()}.png`; a.href = out.toDataURL(); a.click();
    beep(900, 'sine', 65, 0.028);

    // Flash checkmark feedback
    const btn = el('save-btn');
    btn.innerHTML = _checkSvg;
    btn.classList.add('save-success');
    setTimeout(() => {
      btn.innerHTML = _saveSvg;
      btn.classList.remove('save-success');
    }, 1800);
  }
  el('save-btn').addEventListener('click', (e) => {
    savePNG(e.shiftKey);
  });

  // Toolbar collapse/expand
  function toggleToolbar() {
    const tb = document.querySelector('.toolbar');
    const isCollapsed = tb.classList.toggle('collapsed');
    el('tb-expand').classList.toggle('hidden', !isCollapsed);
  }
  el('tb-collapse').addEventListener('click', toggleToolbar);
  el('tb-expand').addEventListener('click', toggleToolbar);
  // Expose for keyboard shortcut
  window._toggleToolbar = toggleToolbar;

  // Cache toolbar element for per-frame auto-dim
  _tbEl = document.querySelector('.toolbar');
}

// ─────────────────────────────────────────────────
//  Keyboard shortcuts
// ─────────────────────────────────────────────────
function setupKeys() {
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    // Block destructive shortcuts during active drawing
    const blocked = S.current !== null;
    switch (e.key.toLowerCase()) {
      case 'z': if (!blocked) el('undo-btn').click();    break;
      case 'y': if (!blocked) el('redo-btn').click();    break;
      case 'x': if (!blocked) el('clear-btn').click();   break;
      case 'c': el('camera-btn').click();  break;
      case 'g': el('grid-btn').click();    break;
      case 'm': el('sym-btn').click();     break;
      case 's':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          // Shift+Cmd+S = transparent, Cmd+S = with background
          el('save-btn').dispatchEvent(new MouseEvent('click', { shiftKey: e.shiftKey }));
        }
        break;
      case 'f':
        showFps = !showFps;
        el('fps-badge').classList.toggle('hidden', !showFps);
        break;
      case 'h':
        if (!blocked) el('help-btn').click();
        break;
      case 't':
        if (window._toggleToolbar) window._toggleToolbar();
        break;
      case '1': case '2': case '3': case '4': case '5': case '6':
        document.querySelectorAll('.br-btn')[+e.key-1]?.click(); break;
    }
  });
}

// ─────────────────────────────────────────────────
//  Modal
// ─────────────────────────────────────────────────
function setupModal() {
  el('help-btn').addEventListener('click', () => {
    el('modal').classList.remove('hidden');
    S.isModal = true;
    beep(800, 'sine', 42, 0.022);
  });
  el('modal-btn').addEventListener('click', () => {
    el('modal').classList.add('hidden');
    S.isModal = false;
    beep(1200, 'sine', 42, 0.022);
  });
}

// ─────────────────────────────────────────────────
//  MediaPipe — numHands:2 for two-hand support
// ─────────────────────────────────────────────────
// Split into stages for progress tracking
async function initMP(setProgress) {
  setProgress(5, 'Loading vision library...');
  const { FilesetResolver, HandLandmarker } = await import(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
  );

  setProgress(20, 'Loading WASM runtime...');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
  );

  setProgress(40, 'Downloading hand model...');
  S.landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.70,
    minHandPresenceConfidence: 0.70,
    minTrackingConfidence: 0.65,
  });
  setProgress(70, 'Hand model ready');
}

async function initCam() {
  // Request video first — this is required
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });

  video.srcObject = stream;
  await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
  await video.play();

  // Try to get microphone for beat-sync — optional, gracefully skip if denied
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ensureAudio();
    const source = S.audio.createMediaStreamSource(audioStream);
    S.analyser = S.audio.createAnalyser();
    S.analyser.fftSize = 256;
    source.connect(S.analyser);
  } catch (_) {
    // Mic denied or unavailable — beat-sync disabled, app still works
    console.info('Microphone not available — beat-sync disabled');
  }
}

// ─────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────
async function init() {
  resize();
  window.addEventListener('resize', resize);
  setupToolbar();
  setupModal();
  setupKeys();
  setHUD('none');

  const status = el('loader-status');
  const bar    = el('loader-bar');

  // Real progress tracking across stages
  bar.style.animation  = 'none';
  bar.style.width      = '0%';
  bar.style.transition = 'width 0.4s ease';
  function setProgress(pct, msg) {
    bar.style.width = pct + '%';
    if (msg) status.textContent = msg;
  }

  try {
    // Stage 1+2: MediaPipe model (0→70%)
    await initMP(setProgress);

    // Stage 3: Camera (70→90%)
    setProgress(75, 'Starting camera...');
    await initCam();
    setProgress(90, 'Camera ready');

    // Stage 4: Done (90→100%)
    setProgress(100, 'Ready');
    await sleep(380);

    el('loader-area').classList.add('hidden');
    const btn = el('modal-btn');
    btn.textContent = 'Continue';
    btn.classList.remove('dim');
    btn.disabled = false;

    el('app').classList.remove('hidden');

    S.isReady = true;
    requestAnimationFrame(loop);
    setupNav();

  } catch (err) {
    console.error(err);
    let userMsg;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      userMsg = 'Camera access denied — please allow camera in your browser settings and reload.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      userMsg = 'No camera found — please connect a webcam and reload.';
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      userMsg = 'Camera is in use by another app — close it and reload.';
    } else {
      userMsg = err.message || 'Something went wrong. Please reload and try again.';
    }
    status.textContent      = userMsg;
    status.style.color      = '#ff4466';
    status.style.letterSpacing = '0';
    status.style.textTransform = 'none';
    status.style.fontSize   = '0.72rem';
    status.style.lineHeight = '1.5';
    status.style.maxWidth   = '320px';
    status.style.textAlign  = 'center';
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────
//  Tab switching — Draw ↔ Piano
// ─────────────────────────────────────────────────
let _fx        = null;
let _activeTab = 'draw';

function switchTab(tab) {
  if (tab === _activeTab) return;
  _activeTab = tab;

  const navTabs = document.querySelectorAll('.nav-tab');
  const appEl   = el('app');
  const fxEl    = el('fx-section');

  navTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

  if (tab === 'fx') {
    // ── Enter FX ─────────────────────────────────────
    if (S.current) { commitStroke(S.current); S.current = null; }
    S.pianoPaused = true;

    appEl.classList.add('hidden');
    fxEl.classList.remove('hidden');

    if (!_fx) _fx = new AirFX(fxEl);
    _fx.start(video, S.landmarker);

  } else {
    // ── Return to Draw ────────────────────────────────
    _fx?.stop();
    fxEl.classList.add('hidden');
    appEl.classList.remove('hidden');

    resetFilters(S.draw);
    S.pianoPaused = false;
  }
}

function setupNav() {
  const nav = el('top-nav');
  nav.classList.remove('hidden');
  document.body.classList.add('nav-visible');

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

init();
