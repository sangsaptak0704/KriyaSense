/* ==========================================================================
   api.js
   Backend communication abstraction layer.

   Every exported function here is a stand-in for a real HTTP/WebSocket call
   to the future Python/FastAPI backend. Today they resolve from one of two
   local pipelines, selectable at runtime as "detection mode":

     REAL       — genuine on-device inference via real_detection.js
                  (MediaPipe person/pose/object detection, fully offline).
                  What it can't honestly claim (BAS-specific actions like
                  "open cap") it reports as null, not a guess.
     SIMULATED  — the scripted mock pipeline (detection.js -> tracking.js)
                  that acts out the full BAS chemical-handling sequence,
                  useful for demoing the experiment/FSM/violation flow
                  without needing a camera pointed at real lab equipment.

   Either way, every consumer — canvas overlay, detected-persons panel,
   event log — reads the exact same computeFrame() output, so there's
   never two disagreeing copies of "what's currently detected."

   To connect a real backend later: keep every function signature and
   returned JSON shape identical, and swap connectWebSocket()'s body from
   the setInterval mock to `new WebSocket(CONFIG.wsUrl)`, forwarding each
   parsed message straight to onFrame() — the payload shape already matches
   what the backend will send (see README "Future Backend Contract").
   ========================================================================== */

const ASTRA_API = (() => {

  const CONFIG = {
    apiBase: 'http://localhost:8000',
    wsUrl: 'ws://localhost:8000/ws/ai-stream',
    mode: 'MOCK', // 'MOCK' | 'LIVE' — backend connection mode (Settings page)
  };

  let socketInterval = null;
  let analysisRunning = true;
  const trackers = { live: null, exp: null };
  let subscribedToMedia = false;

  let detectionMode = 'REAL'; // 'REAL' | 'SIMULATED' — which inference pipeline drives the overlay
  let realEls = { video: null, img: null };
  const cachedImages = {
    live: { mock: null, real: null },
    exp: { mock: null, real: null },
  };
  const modeSubscribers = [];

  function ensureTracker(channel = 'live') {
    if (!trackers[channel]) trackers[channel] = ASTRA_TRACKING.createTracker();
    return trackers[channel];
  }

  function setRealDetectionElements(els) {
    realEls = els;
  }

  function onModeChange(fn) { modeSubscribers.push(fn); }
  function notifyModeChange() { modeSubscribers.forEach(fn => fn(detectionMode)); }

  /** Object labels (from frame.objects) within proximity of either of a person's wrists — used by
      har.js to boost READING/WRITING/USING_LAPTOP/USING_PHONE/OPENING/CLOSING confidence. 2D/image-space
      on purpose: object boxes only exist in 2D, unlike the 3D world pose used for body geometry. */
  function nearbyObjectLabels(person, objects) {
    if (!person.pose) return [];
    const wrists = [person.pose.lWrist, person.pose.rWrist].filter(Boolean);
    if (!wrists.length || !objects.length) return [];
    const found = new Set();
    objects.forEach(o => {
      const cx = o.bbox.x + o.bbox.width / 2, cy = o.bbox.y + o.bbox.height / 2;
      wrists.forEach(w => {
        if (Math.hypot(w.x - cx, w.y - cy) < 0.18) found.add(o.label);
      });
    });
    return Array.from(found);
  }

  // The object detector can find a person the pose landmarker couldn't fit a
  // skeleton to (small, occluded, or partially out of frame). That person is
  // genuinely detected but has no body geometry to reason about — report it
  // as UNCERTAIN with a reason rather than guessing or showing a bare label.
  const NO_POSE_RESULT = { activity: 'UNCERTAIN', harReason: 'No pose landmarks for this person' };

  function applyHarVideo(channel, persons, objects) {
    return persons.map(p => {
      if (!p.worldPose) return { ...p, ...NO_POSE_RESULT };
      const trackKey = `${channel}_${p.id}`;
      const result = ASTRA_HAR.classifyVideoFrame(trackKey, p.worldPose, nearbyObjectLabels(p, objects));
      return {
        ...p,
        activity: result.activity,
        confidence: result.confidence,
        harReason: result.reason,
        harPrevious: result.previous,
        bodyTelemetry: result.bodyTelemetry,
      };
    });
  }

  function applyHarImage(persons, objects) {
    return persons.map(p => {
      if (!p.worldPose) return { ...p, ...NO_POSE_RESULT };
      const result = ASTRA_HAR.classifyStaticImage(p.worldPose, nearbyObjectLabels(p, objects));
      return {
        ...p,
        activity: result.activity,
        confidence: result.confidence,
        harReason: result.reason,
        bodyTelemetry: result.bodyTelemetry,
      };
    });
  }

  function getImageForChannel(channel = 'live') {
    if (channel === 'exp') {
      return document.getElementById('imgFeedExp');
    }
    return document.getElementById('imgFeedLive') || (realEls ? realEls.img : null);
  }

  function getVideoForChannel(channel = 'live') {
    if (channel === 'exp') {
      const v = document.getElementById('videoFeedExp');
      return (v && !v.hidden && v.videoWidth > 0) ? v : null;
    }
    const list = [
      document.getElementById('videoFeedLive'),
      document.getElementById('videoFeedDash'),
      document.getElementById('videoFeedStream'),
    ];
    for (const v of list) {
      if (v && !v.hidden && v.videoWidth > 0 && v.offsetParent !== null) {
        return v;
      }
    }
    for (const v of list) {
      if (v && !v.hidden && v.videoWidth > 0) {
        return v;
      }
    }
    return realEls ? realEls.video : null;
  }

  async function refreshForChannel(channel = 'live') {
    const tr = ensureTracker(channel);
    tr.reset();
    const mediaChan = ASTRA_MEDIA.getChannel(channel);
    const type = mediaChan ? mediaChan.getType() : 'none';
    cachedImages[channel] = { mock: null, real: null };

    if (type === 'image') {
      cachedImages[channel].mock = ASTRA_DETECTION.generateImageDetections();
      const imgEl = getImageForChannel(channel);
      if (detectionMode === 'REAL' && ASTRA_REAL_DETECTION.isReady() && imgEl) {
        const frame = await ASTRA_REAL_DETECTION.detectImageAsync(imgEl);
        frame.persons = applyHarImage(frame.persons, frame.objects);
        cachedImages[channel].real = frame;
      }
      return;
    }

    if ((type === 'video' || type === 'camera') && detectionMode === 'REAL' && ASTRA_REAL_DETECTION.isReady()) {
      await ASTRA_REAL_DETECTION.prepareForVideo();
    }
  }

  async function refreshForCurrentMedia() {
    await refreshForChannel('live');
    await refreshForChannel('exp');
  }

  function setDetectionMode(m) {
    if (m !== 'REAL' && m !== 'SIMULATED') return;
    if (m === detectionMode) return;
    detectionMode = m;
    refreshForCurrentMedia();
    notifyModeChange();
  }

  function getDetectionMode() { return detectionMode; }
  function isRealDetectionReady() { return ASTRA_REAL_DETECTION.isReady(); }
  function getRealDetectionError() { return ASTRA_REAL_DETECTION.getUnsupportedReason(); }

  function initRealDetectionEagerly() {
    ASTRA_REAL_DETECTION.init().then((res) => {
      if (res.ok) {
        refreshForCurrentMedia();
      } else if (detectionMode === 'REAL') {
        // Real CV unavailable (e.g. opened via file:// instead of a local server) — fall back honestly.
        detectionMode = 'SIMULATED';
        refreshForCurrentMedia();
      }
      notifyModeChange();
    });
  }

  function computeFrame(channel = 'live') {
    const tr = ensureTracker(channel);
    const mediaChan = ASTRA_MEDIA.getChannel(channel);
    const type = mediaChan ? mediaChan.getType() : 'none';
    const useReal = detectionMode === 'REAL' && ASTRA_REAL_DETECTION.isReady();

    if (type === 'image') {
      const entry = cachedImages[channel] || {};
      const f = (useReal ? entry.real : entry.mock) || { persons: [], objects: [] };
      return { timestamp: new Date().toISOString(), persons: f.persons || [], objects: f.objects || [], channel };
    }

    if (type === 'video' || type === 'camera') {
      const activeVideo = getVideoForChannel(channel);
      if (useReal && activeVideo) {
        const raw = ASTRA_REAL_DETECTION.detectVideoFrameSync(activeVideo, Math.round(performance.now()));
        const tracked = tr.update([...raw.persons, ...raw.objects]);
        const objects = tracked.filter(x => x.kind === 'object');
        const persons = applyHarVideo(channel, tracked.filter(x => x.kind === 'person'), objects);
        return { timestamp: new Date().toISOString(), persons, objects, channel };
      }
      if (detectionMode === 'SIMULATED') {
        const t = performance.now() / 1000;
        const { persons, objects } = ASTRA_DETECTION.generateLiveCandidates(t);
        const tracked = tr.update([...persons, ...objects]);
        return {
          timestamp: new Date().toISOString(),
          persons: tracked.filter(x => x.kind === 'person'),
          objects: tracked.filter(x => x.kind === 'object'),
          channel,
        };
      }
    }

    return { timestamp: new Date().toISOString(), persons: [], objects: [], channel };
  }

  /* ---------------------------------------------------------------------
     Public API — this is the surface the rest of the frontend calls.
     Every function returns a Promise, matching the shape a fetch() call
     would return, so swapping mock -> live requires no caller changes.
     --------------------------------------------------------------------- */

  function connectWebSocket(onFrame) {
    if (!subscribedToMedia) {
      subscribedToMedia = true;
      ASTRA_MEDIA.live.subscribe(() => refreshForChannel('live'));
      ASTRA_MEDIA.exp.subscribe(() => refreshForChannel('exp'));
      refreshForCurrentMedia();
      initRealDetectionEagerly();
    }
    // LIVE MODE (future): socket = new WebSocket(CONFIG.wsUrl);
    // socket.onmessage = (evt) => onFrame(JSON.parse(evt.data));
    if (socketInterval) clearInterval(socketInterval);
    socketInterval = setInterval(() => {
      if (!analysisRunning) return;
      onFrame(computeFrame('live'));
      onFrame(computeFrame('exp'));
    }, 150); // ~6.6 Hz — a realistic inference cadence; canvas redraw itself still runs at 60fps
    return Promise.resolve({ status: 'connected', mode: CONFIG.mode });
  }

  function disconnectWebSocket() {
    if (socketInterval) clearInterval(socketInterval);
    socketInterval = null;
  }

  function getCurrentActivity() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/activity`).then(r => r.json());
    return Promise.resolve(computeFrame());
  }

  function getDetections() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/detections`).then(r => r.json());
    return Promise.resolve(computeFrame().objects);
  }

  function getPose() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/pose`).then(r => r.json());
    const frame = computeFrame();
    return Promise.resolve(frame.persons.map(p => ({ person_id: p.id, keypoints: p.pose })));
  }

  function getTracking() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/tracking`).then(r => r.json());
    const frame = computeFrame();
    return Promise.resolve([
      ...frame.persons.map(p => ({ id: ASTRA_ACTIVITY.formatPersonId(p.id), type: 'person', confidence: p.confidence })),
      ...frame.objects.map(o => ({ id: `OBJECT #${o.id}`, type: o.label, confidence: o.confidence })),
    ]);
  }

  function getExperimentStatus() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/experiment`).then(r => r.json());
    return Promise.resolve(window.ASTRA_EXPERIMENT ? window.ASTRA_EXPERIMENT.getStatus() : null);
  }

  function getSystemMetrics() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/system`).then(r => r.json());
    const jitter = (base, spread) => Math.max(0, Math.min(100, base + (Math.random() * 2 - 1) * spread));
    return Promise.resolve({
      cpu: jitter(42, 8),
      gpu: jitter(68, 6),
      ram: jitter(61, 5),
      vram: jitter(54, 6),
      inference_fps: Math.round(jitter(30, 1)),
      latency_ms: Math.round(jitter(42, 6)),
      yolo_fps: Math.round(jitter(31, 1)),
      pose_fps: Math.round(jitter(30, 1)),
      har_fps: Math.round(jitter(28, 1)),
      model: 'HAR-v1.0',
      temporal_model: 'LSTM',
      device: 'EDGE AI DEVICE',
    });
  }

  function startAnalysis() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/analysis/start`, { method: 'POST' });
    analysisRunning = true;
    return Promise.resolve({ status: 'started' });
  }

  function stopAnalysis() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/analysis/stop`, { method: 'POST' });
    analysisRunning = false;
    return Promise.resolve({ status: 'stopped' });
  }

  function isAnalysisRunning() {
    return analysisRunning;
  }

  function getEventLog() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/events`).then(r => r.json());
    return Promise.resolve(window.ASTRA_EXPERIMENT ? window.ASTRA_EXPERIMENT.getEventLog() : []);
  }

  function createExperiment(payload) {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/experiment/create`, {
    //   method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    // }).then(r => r.json());
    return Promise.resolve({ status: 'created', experiment: payload });
  }

  function resetExperiment() {
    // LIVE: return fetch(`${CONFIG.apiBase}/api/experiment/reset`, { method: 'POST' });
    return Promise.resolve({ status: 'reset' });
  }

  function tryConnectBackend(apiBase, wsUrl) {
    CONFIG.apiBase = apiBase || CONFIG.apiBase;
    CONFIG.wsUrl = wsUrl || CONFIG.wsUrl;
    return fetch(`${CONFIG.apiBase}/api/status`, { method: 'GET', mode: 'cors' })
      .then(r => r.json())
      .then(data => {
        CONFIG.mode = 'LIVE';
        return { connected: true, mode: 'LIVE', data };
      })
      .catch(() => {
        CONFIG.mode = 'MOCK';
        return { connected: false, mode: 'MOCK' };
      });
  }

  function getMode() {
    return CONFIG.mode;
  }

  return {
    CONFIG,
    connectWebSocket,
    disconnectWebSocket,
    getCurrentActivity,
    getDetections,
    getPose,
    getTracking,
    getExperimentStatus,
    getSystemMetrics,
    startAnalysis,
    stopAnalysis,
    isAnalysisRunning,
    getEventLog,
    createExperiment,
    resetExperiment,
    tryConnectBackend,
    getMode,
    setDetectionMode,
    getDetectionMode,
    isRealDetectionReady,
    getRealDetectionError,
    onModeChange,
    setRealDetectionElements,
  };
})();
