# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository location

The git repository root is `KRIYA-SENSE/`, one level below the usual working directory (`/home/sd/openscanx`). All paths below are relative to `KRIYA-SENSE/`.

## Commands

```bash
# Frontend only (static, no build step) — live-reload dev server on :5173
npm install && npm run dev

# Backend + frontend together on one origin (recommended: real CV needs http://)
cd backend
pip install -r requirements.txt      # Python 3.12
uvicorn main:app --reload            # or: python main.py  (uses HOST/PORT/RELOAD from .env)
# → http://localhost:8000  (dashboard at /, OpenAPI at /docs, health at /health)
```

There is no test suite, linter, or bundler in this repo. `backend/.env` is git-ignored; copy `backend/.env.example` to `backend/.env` if it is missing (`SERVE_FRONTEND=false` runs the API alone, as on Render where the frontend is deployed separately).

**Serving matters:** `real_detection.js` loads MediaPipe from the root-relative path `/assets/mediapipe`, so the frontend must be served at an origin root over http(s). Opening `frontend/index.html` via `file://` still works but silently drops to `SIMULATED` detection mode.

## Architecture

Two halves that speak one JSON contract:

- **`frontend/`** — a zero-build, zero-dependency vanilla-JS SPA that today runs the *entire* system client-side, including genuine on-device inference. This is where the working product lives.
- **`backend/`** — a FastAPI app that serves the frontend as static files and exposes the same REST/WS endpoints returning **mock** data. Its `ai/*` modules are typed interface stubs that raise `NotImplementedError`; `backend/ai/README.md` is the dataset/training plan they are written against. The one genuine backend implementation is `ai/tracking/tracker.py` (classical centroid tracking, mirroring `frontend/js/tracking.js`).

Everything is IIFE globals named `ASTRA_*` (a pre-rename artifact — the project is KRIYA-SENSE, the globals are not). Script order in `frontend/index.html` is the dependency order; there are no modules or imports except the dynamic MediaPipe import.

### Frontend pipeline (the important part)

Each file owns exactly one stage, and the contract between stages is a frame object `{ persons: [...], objects: [...] }` with **normalized 0..1 bboxes**:

```
media.js      single global media source (image / video / camera), the only owner of
              createObjectURL + getUserMedia lifecycle; panels subscribe to it
camera.js     raw getUserMedia + device enumeration, returns a MediaStream, nothing else
real_detection.js  REAL on-device CV: MediaPipe ObjectDetector (EfficientDet-Lite0, ~80 COCO
              classes) + PoseLandmarker (33 landmarks, 2D + metric 3D world landmarks),
              WASM, fully offline after first load
detection.js  SIMULATED alternative: scripted mock detections acting out the BAS sequence
tracking.js   nearest-centroid tracker, assigns the stable track_id both pipelines lack
har.js        activity classification from 3D world-pose geometry + rolling temporal window
activity.js   per-person current/previous activity, hold duration, history
api.js        picks the pipeline, runs it, exposes the future-backend function surface
overlay.js    canvas renderer for boxes/skeletons — never invents a position
experiment.js client-side FSM, sequence validation, violations, TTS, event log, TXT export
visualization.js  non-vision drawing: pipeline/architecture diagrams, Chart.js panels
app.js        the only file that touches DOM structure: nav, wiring, clock, rAF vision loop
```

`api.js` is the seam. `computeFrame()` chooses between the REAL and SIMULATED pipelines (`setDetectionMode`, default `REAL`), runs tracking, then applies HAR, and every consumer reads that one output — so there is never a second, disagreeing copy of "what is currently detected." `connectWebSocket()` is a `setInterval` at 150ms (~6.6Hz inference cadence) while the canvas redraws at 60fps in `app.js`'s `visionLoop()`; swapping it for `new WebSocket(CONFIG.wsUrl)` is intended to be the *only* frontend edit needed to go live.

### Honesty constraints baked into the code

These are deliberate design decisions, not gaps to "fix" by making the UI look better:

- MediaPipe is not trained on BAS lab equipment or the BAS action sequence. Anything the pipeline cannot honestly claim is reported as `null` or `UNCERTAIN` with a `harReason`, never guessed. `har.js` has a `CONFIDENCE_FLOOR` (45) and an `OBJECTLESS_CAP` (55) for person-uses-object activities when the object was not actually detected.
- `har.js` classifies **all geometry from MediaPipe world landmarks**, not image pixels, so classification does not assume which way is "down" — this matters for the microgravity use case. Do not reintroduce image-space/gravity assumptions there.
- Motion-only activities (`WALKING`, `RUNNING`, `OPENING`, `CLOSING` — `TEMPORAL_ONLY`) are refused for static images, which have no history.
- Person counting uses the **object detector's** `person` boxes, not the pose landmarker's own detector, which merges close-together people; poses are then matched to boxes by centroid distance.
- `visionLoop()` wraps rendering in try/catch specifically so one bad frame cannot kill `requestAnimationFrame` for the session.

### Two activity vocabularies

`har.js` recognizes 10 general activities (`STANDING`, `WALKING`, `SITTING`, `RUNNING`, `READING`, `WRITING`, `USING_LAPTOP`, `USING_PHONE`, `OPENING`, `CLOSING`). The BAS chemical-handling codes (`PICK_UP`, `OPEN_CAP`, `DRAW_LIQUID`, `POUR_LIQUID`, `MIX`, `PLACE_BACK`) belong to the simulated demo sequence and are intentionally **not** offered in the Experiment Builder's step picker, because real HAR cannot detect them yet. Keep those two lists distinct when editing `experiment.js` or `activity.js`.

## Backend API contract

`frontend/js/api.js` and `backend/api/routes.py` implement the same surface — change both together:

`GET /api/activity` · `/api/detections` · `/api/pose` · `/api/tracking` · `/api/experiment` · `/api/system` · `/api/events` · `/api/status`, `POST /api/analysis/{start,stop}` · `/api/experiment/{create,reset}`, `WS /ws/ai-stream`, plus unprefixed `GET /health` (Render's health check).

Mock frame assembly lives in one place, `backend/api/state.py`'s `mock_frame()` — that function is what a real pipeline replaces. The Settings page's "Attempt Backend Connection" probes `/api/status` and flips the pill to `BACKEND: LIVE`; failure silently stays on local mock data and must never block the UI.

## Note on README.md

`README.md` is a good conceptual overview but its file listings predate the real-CV work: it describes five frontend modules (there are twelve) and calls `backend/ai/` empty (it holds stubs plus `ai/README.md`). Trust the code over the README's structure sections, and update the README when adding modules.
