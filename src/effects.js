/**
 * Air FX v4 — Reel-Quality Premium String Network
 *
 * Architecture:
 *   Adaptive EMA+Kalman Stabilization → Persistent Identity
 *   → Frame-Lag Ring Buffers (Elastic trailing) 
 *   → Velocity-Adaptive Bezier Curves → Exaggerated Z-Depth
 *   → Cached Linear Gradients → Premium Sub-Surface Glow
 */

// ── Hand skeleton (MediaPipe 21 landmarks) ────────────────
const BONES = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];
const TIPS = new Set([4, 8, 12, 16, 20]);

// ── Persistent cross-hand string connections (35 total)
const STRING_DEFS = [
  // ── Tier 0: fingertip-to-fingertip mirrors (5)
  { a: 4,  b: 4,  tier: 0 }, 
  { a: 8,  b: 8,  tier: 0 }, 
  { a: 12, b: 12, tier: 0 }, 
  { a: 16, b: 16, tier: 0 }, 
  { a: 20, b: 20, tier: 0 }, 

  // ── Tier 1: adjacent tip cross-links (8)
  { a: 4,  b: 8,  tier: 1 }, 
  { a: 8,  b: 12, tier: 1 }, 
  { a: 12, b: 16, tier: 1 }, 
  { a: 16, b: 20, tier: 1 }, 
  { a: 8,  b: 4,  tier: 1 }, 
  { a: 12, b: 8,  tier: 1 }, 
  { a: 16, b: 12, tier: 1 }, 
  { a: 20, b: 16, tier: 1 }, 

  // ── Tier 2: skip-one + reverse bridges (8)
  { a: 4,  b: 12, tier: 2 }, 
  { a: 8,  b: 16, tier: 2 }, 
  { a: 12, b: 20, tier: 2 }, 
  { a: 12, b: 4,  tier: 2 }, 
  { a: 16, b: 8,  tier: 2 }, 
  { a: 20, b: 12, tier: 2 }, 
  { a: 8,  b: 7,  tier: 2 }, 
  { a: 12, b: 11, tier: 2 }, 

  // ── Tier 3: structural frame — MCP+PIP mirrors (6)
  { a: 0,  b: 0,  tier: 3 }, 
  { a: 5,  b: 5,  tier: 3 }, 
  { a: 9,  b: 9,  tier: 3 }, 
  { a: 13, b: 13, tier: 3 }, 
  { a: 17, b: 17, tier: 3 }, 
  { a: 6,  b: 6,  tier: 3 }, 

  // ── Tier 4: web fill — diagonals (8)
  { a: 4,  b: 16, tier: 4 }, 
  { a: 8,  b: 20, tier: 4 }, 
  { a: 20, b: 4,  tier: 4 }, 
  { a: 4,  b: 20, tier: 4 }, 
  { a: 20, b: 8,  tier: 4 }, 
  { a: 16, b: 4,  tier: 4 }, 
  { a: 0,  b: 5,  tier: 4 }, 
  { a: 0,  b: 17, tier: 4 }
];

// Per-tier visual scaling. Micro-lag (delay frames) adds elastic trailing effect.
const TIER_STYLE = [
  { widthBase: 4.5, alphaBase: 1.00, glowAlpha: 0.15, glowWidth: 2.8, lag: 0 }, // primary: instant 
  { widthBase: 3.2, alphaBase: 0.85, glowAlpha: 0.10, glowWidth: 2.2, lag: 1 }, // secondary: slight lag
  { widthBase: 1.8, alphaBase: 0.60, glowAlpha: 0.05, glowWidth: 1.8, lag: 2 }, // bridges: trailing
  { widthBase: 1.0, alphaBase: 0.35, glowAlpha: 0.03, glowWidth: 1.4, lag: 3 }, // frame
  { widthBase: 0.6, alphaBase: 0.20, glowAlpha: 0.01, glowWidth: 1.2, lag: 4 }, // web
];

// ── 1. Endpoint Stabilization (Adaptive EMA + Kalman) ───────────
class AdaptiveSmoother {
  constructor() {
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.pxx = 8; this.pyy = 8;
    this.pvx = 4; this.pvy = 4;
    this.pxvx = 0; this.pyvy = 0;
    this.emaX = 0; this.emaY = 0;
    this.seeded = false;
  }
  update(rx, ry) {
    if (!this.seeded) {
      this.x = this.emaX = rx;
      this.y = this.emaY = ry;
      this.lastRx = rx; this.lastRy = ry;
      this.seeded = true;
      return { x: rx, y: ry, vx: 0, vy: 0 };
    }
    
    // Outlier rejection (limit massive single-frame spikes)
    let dRx = rx - this.lastRx, dRy = ry - this.lastRy;
    const jump = Math.hypot(dRx, dRy);
    if (jump > 180) {
      const scale = 180 / jump;
      rx = this.lastRx + dRx * scale;
      ry = this.lastRy + dRy * scale;
    }
    this.lastRx = rx; this.lastRy = ry;
    
    // Constant velocity Kalman filter (heavier R for motion damping)
    const qp = 0.5, qv = 2.0, r = 10.0;
    const updateAxis = (p, v, pp, pv, pc, m) => {
      const pp2 = pp + 2*pc + pv + qp, pv2 = pv + qv, pc2 = pc + pv;
      const inn = m - (p + v), S = pp2 + r, Kp = pp2 / S, Kv = pc2 / S;
      return [p + v + Kp * inn, v + Kv * inn, (1-Kp)*pp2, pv2 - Kv*pc2, (1-Kp)*pc2];
    };
    
    [this.x, this.vx, this.pxx, this.pvx, this.pxvx] = updateAxis(this.x, this.vx, this.pxx, this.pvx, this.pxvx, rx);
    [this.y, this.vy, this.pyy, this.pvy, this.pyvy] = updateAxis(this.y, this.vy, this.pyy, this.pvy, this.pyvy, ry);

    // Dynamic smoothing alpha based on instantaneous velocity (fluid zero jitter)
    const speed = Math.hypot(this.vx, this.vy);
    const alpha = Math.min(0.85, Math.max(0.12, speed * 0.06));
    
    this.emaX += (this.x - this.emaX) * alpha;
    this.emaY += (this.y - this.emaY) * alpha;
    
    return { x: this.emaX, y: this.emaY, vx: this.vx, vy: this.vy };
  }
  reset() { this.seeded = false; }
}

function mkHandSmoothers() { return Array.from({length: 21}, () => new AdaptiveSmoother()); }

// ── 2. Persistent String State & Gradient Cache ─────────────────
class StringState {
  constructor(def, idx) {
    this.def = def;
    this.idx = idx;
    this.restLen = 0;
    this.calibrated = false;
    this.tension = 1.0;        
    this.smoothTension = 1.0; 
    
    // Aesthetic seeded randomness
    this.biasX = (Math.random() - 0.5) * 2;
    this.biasY = (Math.random() - 0.5) * 2;
    
    // Gradient caching
    this.gx1 = 0; this.gy1 = 0; this.gx2 = 0; this.gy2 = 0;
    this.cachedGlow = null;
    this.cachedCore = null;
  }

  updatePhysics(p0, p1, dt) {
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (!this.calibrated) {
      this.restLen = Math.max(20, len);
      this.calibrated = true;
    } else {
      this.restLen += (len - this.restLen) * 0.003;
      this.restLen = Math.max(20, this.restLen);
    }
    
    this.tension = len / this.restLen;
    this.smoothTension += (this.tension - this.smoothTension) * 0.12;
    this.smoothTension = Math.max(0.2, Math.min(5.0, this.smoothTension));
  }
  
  getGradients(ctx, x1, y1, x2, y2, finalA, glowA) {
    // Spatial hashing for gradient cache: reuse if moved < 4 px 
    if (this.cachedCore && Math.hypot(x1-this.gx1, y1-this.gy1) < 4 && Math.hypot(x2-this.gx2, y2-this.gy2) < 4) {
      return { core: this.cachedCore, glow: this.cachedGlow };
    }
    this.gx1 = x1; this.gy1 = y1; this.gx2 = x2; this.gy2 = y2;
    
    // Soft Cyan → Light Violet → Warm White Palette
    const coreGrad = ctx.createLinearGradient(x1, y1, x2, y2);
    coreGrad.addColorStop(0, `hsla(190, 85%, 65%, ${finalA})`);    // Cyan
    coreGrad.addColorStop(0.5, `hsla(280, 80%, 75%, ${finalA})`);  // Violet
    coreGrad.addColorStop(1, `hsla(45, 95%, 95%, ${finalA})`);     // Warm White
    
    const glowGrad = ctx.createLinearGradient(x1, y1, x2, y2);
    glowGrad.addColorStop(0, `hsla(190, 85%, 65%, ${glowA})`);
    glowGrad.addColorStop(0.5, `hsla(280, 80%, 75%, ${glowA})`);
    glowGrad.addColorStop(1, `hsla(45, 95%, 95%, ${glowA})`);
    
    this.cachedCore = coreGrad;
    this.cachedGlow = glowGrad;
    return { core: coreGrad, glow: glowGrad };
  }

  reset() {
    this.calibrated = false;
    this.smoothTension = 1.0;
    this.cachedCore = null;
    this.cachedGlow = null;
  }
}

// ═══════════════════════════════════════════════════════════
//  AirFX Controllers
// ═══════════════════════════════════════════════════════════
export class AirFX {
  constructor(section) {
    this._camCv  = section.querySelector('#fx-cam');
    this._fxCv   = section.querySelector('#fx-canvas');
    this._camCtx = this._camCv.getContext('2d');
    this._fxCtx  = this._fxCv.getContext('2d');

    this._running = false;
    this._animId  = null;
    this._video   = null;
    this._lm      = null;

    // Hand tracking & layered buffering
    this._smoothers = [mkHandSmoothers(), mkHandSmoothers()];
    this._history = [[], []]; // Ring-buffers: arrays of {x, y, vx, vy} point arrays
    this._rawZ = [null, null];

    this._strings = STRING_DEFS.map((d, i) => new StringState(d, i));

    this._networkAlpha = 0;
    this._lastTime = performance.now();

    // ── UI feedback state ────────────────────────────────
    this._dotEl    = section.querySelector('#fx-status-dot');
    this._guideEl  = section.querySelector('#fx-guide');
    this._guideTxt = section.querySelector('#fx-guide-text');
    this._pulseEl  = section.querySelector('#fx-pulse');

    // Debounced hand state (0, 1, 2)
    this._handCount      = 0;   // raw count this frame
    this._stableState    = 0;   // debounced display state
    this._stateTimer     = 0;   // ms held in candidate state
    this._candidateState = 0;   // state waiting to be confirmed
    this._DEBOUNCE_MS    = 400; // ms before state change commits

    // Idle fade: track time since last bothHands
    this._idleTimer      = 0;
    this._IDLE_FADE_MS   = 2500; // start fading after this
    
    this._activationGlow = 0;
    this._wasOffScreen   = false;
    this._logTimer       = 0;

    // Onboarding: show once per browser
    this._onboarded = localStorage.getItem('airfx_onboarded') === '1';

    this._onResize = this._resize.bind(this);
    this._loopFn   = this._loop.bind(this);
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  _resize() {
    const W = window.innerWidth;
    const navH = document.body.className.includes('nav-visible') ? 52 : 0;
    const H = window.innerHeight - navH;
    this._W = W; this._H = H;
    for (const cv of [this._camCv, this._fxCv]) { cv.width = W; cv.height = H; }
  }

  start(videoEl, landmarker) {
    this._video = videoEl;
    this._lm = landmarker;
    this._running = true;
    this._networkAlpha = 0;
    this._history = [[], []];
    this._smoothers[0].forEach(s => s.reset());
    this._smoothers[1].forEach(s => s.reset());
    this._strings.forEach(s => s.reset());
    this._lastTime = performance.now();

    // Reset UI state
    this._stableState = 0;
    this._candidateState = 0;
    this._stateTimer = 0;
    this._idleTimer = 0;
    this._activationGlow = 0;
    this._wasOffScreen = false;
    
    this._updateHUD(0, 0);

    this._loop();
  }

  stop() {
    this._running = false;
    if (this._animId) cancelAnimationFrame(this._animId);
    // Hide HUD
    this._dotEl?.classList.remove('visible');
    this._guideEl?.classList.remove('visible');
    this._guideEl?.classList.add('hidden-msg');
  }

  destroy() { this.stop(); window.removeEventListener('resize', this._onResize); }

  _loop() {
    if (!this._running) return;
    this._animId = requestAnimationFrame(this._loopFn);
    this._frame();
  }

  _isHandVisible(lm) {
    if (!lm || lm.length < 21) return false;

    // SOFT VALIDATION: Don't require all landmarks inside.
    let outCount = 0;
    for (const p of lm) {
      if (!p || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) {
        outCount++;
      }
    }

    // Accept if at least ~50% (11 out of 21) landmarks are inside frame
    if (outCount > 10) {
      return false; 
    }

    // Bounding box size sanity check (reject noisy spikes)
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const p of lm) {
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    
    // Reject wildly noisy sizes, but allow very large valid hands stretching across bounding boxes
    if (width > 0.98 || height > 0.98 || width < 0.01 || height < 0.01) {
      return false; 
    }

    return true;
  }

  _frame() {
    const video = this._video;
    if (!video || video.readyState < 2) return;

    const W = this._W, H = this._H;
    const now = performance.now();
    const dt = Math.min(now - this._lastTime, 100);
    this._lastTime = now;

    // Camera rendering
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const scale = Math.min(W / vw, H / vh);
    const dw = vw * scale, dh = vh * scale;
    const dx = (W - dw) * 0.5, dy = (H - dh) * 0.5;

    const cam = this._camCtx;
    cam.fillStyle = '#060608';
    cam.fillRect(0, 0, W, H);
    cam.save();
    cam.translate(W, 0); cam.scale(-1, 1);
    cam.drawImage(video, W - dx - dw, dy, dw, dh);
    cam.restore();
    cam.fillStyle = 'rgba(0,0,0,0.30)'; // Deepen contrast for premium strings
    cam.fillRect(0, 0, W, H);

    // Update Landmarks
    let validHandsList = [];
    if (this._lm) {
      let res;
      try { res = this._lm.detectForVideo(video, now); } catch (_) {}
      
      const rawHands = res?.landmarks ?? [];
      rawHands.forEach(lm => {
         if (this._isHandVisible(lm)) {
            validHandsList.push(lm);
         }
      });
      
    }

    let detected = validHandsList.length;

    validHandsList.forEach((lm, hi) => {
      if (hi >= 2) return;
      
      // Stabilize endpoints, capture velocity & clamp edge coordinates!
      const framePoints = lm.map((p, i) => {
        // Strict boundary clamp so strings never protrude into black space
        const cX = Math.max(0.001, Math.min(p.x, 0.999));
        const cY = Math.max(0.001, Math.min(p.y, 0.999));
        return this._smoothers[hi][i].update((1 - cX) * W, cY * H);
      });
      
      // Unshift into ring buffer (max 6 frames to handle micro-lag)
      this._history[hi].unshift(framePoints);
      if (this._history[hi].length > 6) this._history[hi].pop();
      
      this._rawZ[hi] = lm.map(p => p.z ?? 0);
    });

    const bothHands = (detected === 2);

    // Idle Fade & Network Alpha (Continuous rendering logic)
    if (bothHands) {
      this._idleTimer = 0;
      this._networkAlpha += (1.0 - this._networkAlpha) * 0.15;
    } else {
      this._idleTimer += dt;
      // 200ms grace period keeps previous physics coordinates connected before fading
      if (this._idleTimer > 200) {
        this._networkAlpha -= Math.min(0.005 * dt, 0.04);
      }
    }
    if (this._networkAlpha < 0.005) this._networkAlpha = 0;

    // Only clean history when faded out completely
    if (this._networkAlpha <= 0.005) {
       for (let hi = detected; hi < 2; hi++) {
           this._history[hi] = [];
           this._rawZ[hi] = null;
           this._smoothers[hi].forEach(s => s.reset());
       }
    }

    // Bounds check for auto-center warning
    let xMin = 9999, yMin = 9999, xMax = -9999, yMax = -9999;
    if (detected > 0) {
      for (let hi = 0; hi < detected; hi++) {
        if (this._history[hi].length) {
          for (let p of this._history[hi][0]) {
            if (p.x < xMin) xMin = p.x;
            if (p.x > xMax) xMax = p.x;
            if (p.y < yMin) yMin = p.y;
            if (p.y > yMax) yMax = p.y;
          }
        }
      }
    }
    const margin = Math.min(W, H) * 0.10; // 10% margin
    const offScreen = detected > 0 && (xMin < margin || xMax > W - margin || yMin < margin || yMax > H - margin);
    if (offScreen !== this._wasOffScreen) {
      this._wasOffScreen = offScreen;
      this._updateHUD(this._stableState, this._stableState);
    }

    // Debounced State Logic
    if (detected !== this._candidateState) {
      this._candidateState = detected;
      this._stateTimer = 0;
    }
    this._stateTimer += dt;
    
    if (this._stateTimer >= this._DEBOUNCE_MS && this._stableState !== this._candidateState) {
      const prevState = this._stableState;
      this._stableState = this._candidateState;
      this._updateHUD(this._stableState, prevState);
    }

    const fx = this._fxCtx;
    fx.clearRect(0, 0, W, H);

    if (this._networkAlpha > 0.005) {
      this._drawNetwork(fx, dt);
    }
    
    if (this._stableState === 1 && detected === 1) {
      this._drawSingleHandHighlight(fx);
    }
  }

  _updateHUD(state, prevState) {
    if (!this._running) return;

    if (this._dotEl) {
      this._dotEl.classList.remove('fx-dot--none', 'fx-dot--one', 'fx-dot--both');
      this._dotEl.classList.add('visible');
      if (state === 0) {
        this._dotEl.classList.add('fx-dot--none');
        this._dotEl.querySelector('.fx-dot__label').textContent = 'No Hands';
      } else if (state === 1) {
        this._dotEl.classList.add('fx-dot--one');
        this._dotEl.querySelector('.fx-dot__label').textContent = 'One Hand';
      } else if (state === 2) {
        this._dotEl.classList.add('fx-dot--both');
        this._dotEl.querySelector('.fx-dot__label').textContent = 'Ready';
      }
    }

    if (this._guideEl && this._guideTxt) {
      let msg = '';
      let hide = false;

      if (!this._onboarded) {
        msg = 'Hold both hands in front of camera';
      } else {
        if (state === 0) msg = 'Show both hands to start';
        else if (state === 1) msg = this._wasOffScreen ? 'Move your hand into frame' : 'Show your other hand';
        else {
          if (this._wasOffScreen) msg = 'Move hands into the center';
          else hide = true;
        }
      }

      if (hide) {
        this._guideEl.classList.add('hidden-msg');
        if (prevState < 2 && this._pulseEl) {
          this._pulseEl.classList.remove('flash');
          void this._pulseEl.offsetWidth;
          this._pulseEl.classList.add('flash');
          this._activationGlow = 1.0;
          
          if (!this._onboarded) {
            this._onboarded = true;
            localStorage.setItem('airfx_onboarded', '1');
            setTimeout(() => { if (this._stableState === 2) this._updateHUD(2, 2); }, 2000);
          }
        }
      } else {
        this._guideTxt.textContent = msg;
        this._guideEl.classList.remove('hidden-msg');
        this._guideEl.classList.add('visible');
      }
    }
  }

  _drawSingleHandHighlight(ctx) {
    const hIdx = this._history[0].length > 0 ? 0 : (this._history[1].length > 0 ? 1 : -1);
    if (hIdx === -1) return;
    const pts = this._history[hIdx][0];
    if (!pts) return;

    const t = performance.now() * 0.003;
    const alpha = 0.15 + Math.sin(t) * 0.05;

    ctx.fillStyle = `rgba(180, 200, 255, ${alpha})`;
    for (let i = 0; i < pts.length; i++) {
       const isTip = TIPS.has(i);
       const r = isTip ? 4 : 2;
       ctx.beginPath();
       ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
       ctx.fill();
    }
  }

  // ════════════════════════════════════════════════════════
  //  Engine: Micro-Lag, Exaggerated Depth & Premium Gradients
  // ════════════════════════════════════════════════════════
  _drawNetwork(ctx, dt) {
    const z0 = this._rawZ[0], z1 = this._rawZ[1];
    const netA = this._networkAlpha;
    const nodeMap = new Map();

    this._activationGlow = (this._activationGlow || 0) * 0.9;
    const act = this._activationGlow;

    // 1. Build render list
    const list = this._strings.map(ss => {
      const tierDef = TIER_STYLE[ss.def.tier];
      
      // Look up points with tier-dependent micro-lag (creates elastic trailing)
      const h0_idx = Math.min(this._history[0].length - 1, tierDef.lag);
      const h1_idx = Math.min(this._history[1].length - 1, tierDef.lag);
      
      const p0 = this._history[0][h0_idx][ss.def.a];
      const p1 = this._history[1][h1_idx][ss.def.b];
      
      const avgZ = ((z0[ss.def.a] ?? 0) + (z1[ss.def.b] ?? 0)) * 0.5;
      return { ss, p0, p1, avgZ, tierDef };
    });

    // 2. Depth sort (far to near)
    list.sort((a, b) => b.avgZ - a.avgZ);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const { ss, p0, p1, avgZ, tierDef } of list) {
      // Physics 
      ss.updatePhysics(p0, p1, dt);
      const T = ss.smoothTension;

      // Tension Physics: thinner + dimmer as they stretch
      const thinning = Math.max(0.2, 1.4 - T * 0.35);
      let baseW = tierDef.widthBase * thinning;
      let baseA = tierDef.alphaBase * Math.max(0.3, 1.2 - T * 0.2);

      // Exaggerated Depth (Z) Physics
      // Closer -> massively thick & bright; Distant -> faint web
      const depthMul = Math.pow(1.8, -avgZ * 12); 
      const finalW = Math.max(0.1, baseW * depthMul) + (act * tierDef.widthBase * 1.5);
      const finalA = Math.max(0.01, Math.min(1.0, baseA * netA * depthMul + act * 0.5));
      
      // Velocity Drag & Aerodynamic Bezier
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      
      // Control points resist movement proportionally to endpoint velocity
      const dragFactor = 1.8;
      const c1x = p0.x + dx * 0.33 - (p0.vx * dragFactor) + ss.biasX * 8;
      const c1y = p0.y + dy * 0.33 - (p0.vy * dragFactor) + ss.biasY * 8;
      const c2x = p0.x + dx * 0.67 - (p1.vx * dragFactor) - ss.biasX * 8;
      const c2y = p0.y + dy * 0.67 - (p1.vy * dragFactor) - ss.biasY * 8;

      // ── Stabilized Premium Gradients ──
      const glowA = finalA * tierDef.glowAlpha;
      const { core: gradCore, glow: gradGlow } = ss.getGradients(ctx, p0.x, p0.y, p1.x, p1.y, finalA, glowA);

      // Draw Glow (subtle)
      if (glowA > 0.01 && finalW > 0.5) {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p1.x, p1.y);
        ctx.strokeStyle = gradGlow;
        ctx.lineWidth = finalW * tierDef.glowWidth;
        ctx.stroke();
      }

      // Draw Core (razor sharp premium line)
      if (finalW > 0.1) {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p1.x, p1.y);
        ctx.strokeStyle = gradCore;
        ctx.lineWidth = finalW;
        ctx.stroke();
      }

      // Register Endpoints for clean deduped cap rendering
      const k0 = ss.def.a;
      const k1 = ss.def.b + 100; // Offset hand 2 ID
      if (!nodeMap.has(k0) || nodeMap.get(k0).a < finalA) nodeMap.set(k0, { p: p0, a: finalA, tip: TIPS.has(k0) });
      if (!nodeMap.has(k1) || nodeMap.get(k1).a < finalA) nodeMap.set(k1, { p: p1, a: finalA, tip: TIPS.has(ss.def.b) });
    }

    // 3. Perfect Endpoints (drawn above strings)
    for (const [id, node] of nodeMap) {
      this._drawEndpointNode(ctx, node.p, node.a, node.tip, id < 100);
    }
  }

  _drawEndpointNode(ctx, p, alpha, isTip, isLeft) {
    if (alpha <= 0.02) return;
    const rCore = isTip ? 3.5 : 2;
    const rGlow = isTip ? 12 : 6;
    
    // Pick side color from the gradient palette
    const colorLight = isLeft ? `190, 85%, 85%` : `45, 95%, 98%`;
    const colorGlow = isLeft ? `190, 85%, 65%` : `45, 95%, 75%`;

    // Outer Node soft bloom
    ctx.fillStyle = `hsla(${colorGlow}, ${alpha * 0.2})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rGlow, 0, Math.PI * 2);
    ctx.fill();

    // Inner bright sharp point
    ctx.fillStyle = `hsla(${colorLight}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rCore, 0, Math.PI * 2);
    ctx.fill();
  }
}
