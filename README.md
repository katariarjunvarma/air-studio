<div align="center">

<img src="public/logo.svg" width="72" height="44" alt="Air Studio Logo" />

# Air Studio

**Draw in the air with your hands. No touch required.**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-fxairstudio.vercel.app-00d4ff?style=flat-square&logo=vercel&logoColor=white)](https://fxairstudio.vercel.app)
[![Built with Vite](https://img.shields.io/badge/Built%20with-Vite-646cff?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![MediaPipe](https://img.shields.io/badge/Powered%20by-MediaPipe-ff6d00?style=flat-square)](https://developers.google.com/mediapipe)
[![License](https://img.shields.io/badge/License-MIT-white?style=flat-square)](LICENSE)

[**→ Try it live**](https://fxairstudio.vercel.app)

</div>

---

## Overview

Air Studio is a real-time gesture-controlled creative tool that lets you draw and create visual effects using nothing but your webcam and hands. Point a finger to draw, open your palm to erase, pinch to move strokes — all powered by on-device hand tracking.

No installation. No plugins. Just a browser and a camera.

---

## Features

### Air Draw
- **6 brush types** — Normal, Neon, Calligraphy, Spray, Glitter, Gradient
- **Velocity-sensitive strokes** — slow = thick, fast = thin, just like real ink
- **Catmull-Rom spline rendering** — smooth curves from sparse hand data
- **Mirror mode** — symmetrical drawing along a vertical axis
- **Grab & move** — pinch any stroke and drag it anywhere
- **Undo / Redo** — full history stack
- **Save PNG** — with or without camera background

### Air FX
- **Dual-hand particle system** — distance between hands controls intensity
- **Real-time visual effects** — powered by both hands simultaneously
- **Hand detection HUD** — live status indicator (no hands / one hand / both)

### Gesture Controls

| Gesture | Action |
|---|---|
| ☝️ Single finger | Draw |
| ✋ Open palm | Erase (swipe to clear) |
| 🤏 Pinch | Move / grab stroke |
| ✊ Fist | Pause (idle) |

**Left hand controls:**

| Gesture | Action |
|---|---|
| 🖐 Open palm | Undo |
| ☝️ Index finger | Next color |
| ✌️ Peace sign | Next brush |
| 🤏 Pinch | Toggle grid |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Hand tracking | [MediaPipe HandLandmarker](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) (WASM, on-device) |
| Smoothing | One-Euro Filter — adaptive, zero-lag at speed |
| Rendering | HTML5 Canvas (3-layer compositing) |
| Strokes | Catmull-Rom spline → variable-width ribbon |
| Build tool | Vite 5 |
| Deployment | Vercel |

---

## Getting Started

```bash
# Clone
git clone https://github.com/katariarjunvarma/air-studio.git
cd air-studio

# Install
npm install

# Run dev server
npm run dev
```

Open `http://localhost:5173` — allow camera access when prompted.

```bash
# Production build
npm run build
```

---

## How It Works

1. **MediaPipe** detects 21 hand landmarks per hand at ~30fps via webcam
2. Landmarks pass through a **One-Euro Filter** (adaptive smoothing — kills jitter at rest, zero lag during fast movement)
3. A **gesture classifier** reads joint angles across all 4 fingers, applying a strict priority pipeline: `ERASE > MOVE > DRAW`
4. A **mode lock** (350ms) prevents accidental gesture switching mid-stroke
5. Draw strokes are collected as sparse control points → interpolated through a **Catmull-Rom spline** → rendered as variable-width filled ribbons with glow layers

---

## Project Structure

```
air-studio/
├── index.html          # App shell + UI markup
├── public/
│   └── logo.svg
├── src/
│   ├── main.js         # Core app — hand tracking, gesture engine, rendering
│   ├── effects.js      # Air FX — dual-hand particle effects
│   └── style.css       # Glass UI design system
└── vite.config.js
```

---

## Browser Support

Requires a browser with:
- **WebRTC** (camera access)
- **WebAssembly** (MediaPipe runtime)
- **Canvas 2D**

Tested on Chrome 120+, Safari 17+, Edge 120+. Firefox works but may have lower performance.

> Camera access is required. All processing happens **locally on your device** — no video is ever sent to a server.

---

<div align="center">

Made with ☕ and too many hand gestures

[fxairstudio.vercel.app](https://fxairstudio.vercel.app)

</div>
