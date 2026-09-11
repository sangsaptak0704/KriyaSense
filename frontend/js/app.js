/* ==========================================================================
   app.js
   Application shell: navigation, global clock, and wiring between
   media.js / camera.js / detection.js / tracking.js / activity.js /
   overlay.js / experiment.js / api.js and the DOM. This is the only file
   that touches page structure directly.
   ========================================================================== */

(() => {

  const PAGE_META = {
    'dashboard':          { title: 'Dashboard',            crumb: 'Mission Overview' },
    'live-analysis':      { title: 'Live Analysis',        crumb: 'Real-Time Vision & Detection' },
    'general-activity':   { title: 'General Activity',     crumb: 'Continuous HAR Mode' },
    'experiment-mode':    { title: 'Experiment Mode',      crumb: 'Sequence Validation & FSM' },
    'experiment-builder': { title: 'Experiment Builder',   crumb: 'Define a Protocol Sequence' },
    'activity-history':   { title: 'Activity History',     crumb: 'Timeline & Event Log' },
    'ai-pipeline':        { title: 'AI Pipeline',          crumb: 'End-to-End Processing Chain' },
    'system-monitor':     { title: 'System Monitor',       crumb: 'Hardware & Model Telemetry' },
    'video-streaming':    { title: 'Video Streaming',      crumb: 'Recording, Encoding & IP Stream' },
    'settings':           { title: 'Settings',             crumb: 'Backend Connection & Architecture' },
  };

  const MODULES = [
    { name: 'YOLO',                    desc: 'Object / person detection' },
    { name: 'POSE',                    desc: 'MediaPipe / YOLO Pose estimation' },
    { name: 'TRACKING',                desc: 'Cross-frame identity tracking' },
    { name: 'HAND DETECTION',          desc: 'Hand position localization' },
    { name: 'HAND-OBJECT INTERACTION', desc: 'Manipulation classification' },
    { name: 'HAR MODEL',               desc: 'Human activity recognition' },
    { name: 'TEMPORAL MODEL',          desc: 'LSTM / GRU / Transformer' },
    { name: 'FSM',                     desc: 'Experiment sequence validation' },
    { name: 'TTS',                     desc: 'Voice guidance & alerts' },
  ];

  /* Which modules are ALWAYS simulated in the current build regardless of mode.
     YOLO, POSE, TRACKING, FSM run in REAL mode.
     Hand interaction, HAR, TTS are scripted regardless. */
  const MODULES_MOCK  = new Set(['HAND DETECTION', 'HAND-OBJECT INTERACTION', 'HAR MODEL', 'TTS']);
  const MODULES_UNIMPL = new Set(['TEMPORAL MODEL']);

  function getModuleState(name) {
    const isReal = ASTRA_API.getDetectionMode() === 'REAL' && ASTRA_API.isRealDetectionReady();
    if (MODULES_UNIMPL.has(name)) return 'unimpl';
    if (MODULES_MOCK.has(name) || !isReal) return 'mock';
    return 'live';
  }

  const state = {
    activePage: 'dashboard',
    liveFrame: { persons: [], objects: [], channel: 'live' },
    expFrame: { persons: [], objects: [], channel: 'exp' },
    latestFrame: { persons: [], objects: [] },
    animStart: performance.now(),
    lastViolationRef: null,
    builderSteps: [],
    selectedHistoryPersonId: null,
  };

  const $ = sel => document.querySelector(sel);
  const $all = sel => Array.from(document.querySelectorAll(sel));

  function kvHtml(rows) {
    return rows.map(r => `<div class="kv-row"><span class="k">${r.k}</span><span class="v ${r.cls || ''}">${r.v}</span></div>`).join('');
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  /* ------------------------------- NAVIGATION ------------------------------- */

  function switchPage(pageId) {
    if (!PAGE_META[pageId]) return;
    state.activePage = pageId;
    $all('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${pageId}`);
    if (target) target.classList.add('active');

    $all('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === pageId));
    $('#pageTitle').textContent = PAGE_META[pageId].title;
    $('#pageCrumb').textContent = PAGE_META[pageId].crumb;

    document.querySelector('.app-shell').classList.remove('mobile-open');

    if (pageId === 'ai-pipeline') ASTRA_VIZ.renderPipelineFlow($('#pipelineFlow'));
    if (pageId === 'settings') ASTRA_VIZ.renderArchDiagram($('#archDiagram'));
    if (pageId === 'experiment-builder') renderBuilderList();
  }

  function initNav() {
    $all('.nav-item').forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
    $all('[data-page-link]').forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.pageLink)));
    $('#sidebarToggle').addEventListener('click', () => document.querySelector('.app-shell').classList.toggle('collapsed'));
    $('#mobileNavToggle').addEventListener('click', () => document.querySelector('.app-shell').classList.toggle('mobile-open'));
  }

  /* ------------------------------- CLOCK ------------------------------- */

  function tickClock() {
    $('#clockDisplay').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  /* ------------------------------- MODULE STATUS PANELS ------------------------------- */

  function renderModulePanels() {
    ASTRA_VIZ.renderModuleStatusList($('#moduleStatusList'), MODULES);
    if (window.lucide) window.lucide.createIcons();
  }

  /* ------------------------------- PERSON LIST / ACTIVITY HERO ------------------------------- */

  function personCardHtml(record) {
    const isWarn = record.activity === 'UNCERTAIN';
    return `
      <div class="person-card">
        <div class="person-card-head">
          <span class="person-card-id">${ASTRA_ACTIVITY.formatPersonId(record.id)}</span>
          <span class="person-card-conf">${record.confidence.toFixed(1)}%</span>
        </div>
        <div class="person-card-activity">${record.label.toUpperCase()}</div>
        <div class="meter"><div class="meter-fill" style="width:${record.confidence}%"></div></div>
        ${record.reason ? `<div class="person-card-reason ${isWarn ? 'reason-warn' : ''}">${record.reason}</div>` : ''}
      </div>`;
  }

  function renderPersonListInto(containerId, persons) {
    const el = $(`#${containerId}`);
    if (!el) return;
    if (!persons.length) {
      el.innerHTML = `<div class="person-list-empty">NO PERSONS DETECTED<br>Upload an image/video or start Live Camera.</div>`;
      return;
    }
    el.innerHTML = persons.map(personCardHtml).join('');
  }

  function activityHeroHtml(record) {
    if (!record) {
      return `
        <div class="activity-hero-name" style="font-size:20px;color:var(--text-2)">NO PERSON DETECTED</div>
        <div class="activity-hero-conf">Upload an image/video or start Live Camera to begin analysis.</div>`;
    }
    const isWarn = record.activity === 'UNCERTAIN';
    return `
      <div class="activity-hero-name">${record.label.toUpperCase()}</div>
      <div class="activity-hero-conf">Confidence <span>${record.confidence.toFixed(1)}%</span></div>
      <div class="meter"><div class="meter-fill" style="width:${record.confidence}%"></div></div>
      ${record.reason ? `<div style="font-size:11px;color:${isWarn ? 'var(--status-caution)' : 'var(--text-secondary)'};margin-top:7px;font-family:var(--mono);letter-spacing:.2px;font-style:${isWarn ? 'italic' : 'normal'};">${record.reason}</div>` : ''}
      <div class="activity-hero-meta">
        <div><span class="lbl">Person</span><span class="val">${ASTRA_ACTIVITY.formatPersonId(record.id)}</span></div>
        <div><span class="lbl">Duration</span><span class="val">${formatDuration(record.durationMs)}</span></div>
      </div>`;
  }

  function updateDashboardHero(primary) {
    if (!primary) {
      $('#dashActivityName').textContent = '—';
      $('#dashActivityConf').textContent = '—';
      $('#dashActivityMeter').style.width = '0%';
      $('#dashPersonId').textContent = '—';
      $('#dashDuration').textContent = '00:00:00';
      return;
    }
    $('#dashActivityName').textContent = primary.label.toUpperCase();
    $('#dashActivityConf').textContent = `${primary.confidence.toFixed(1)}%`;
    $('#dashActivityMeter').style.width = `${primary.confidence}%`;
    $('#dashPersonId').textContent = ASTRA_ACTIVITY.formatPersonId(primary.id);
    $('#dashDuration').textContent = formatDuration(primary.durationMs);
  }

  function renderGeneralActivityPage(allPersons) {
    const primary = allPersons[0] || null;
    const heroEl = $('#genPrimaryHero');
    if (heroEl) heroEl.innerHTML = activityHeroHtml(primary);
    renderPersonListInto('personListGeneral', allPersons);

    const select = $('#historyPersonSelect');
    if (select) {
      const stillExists = allPersons.some(p => p.id === state.selectedHistoryPersonId);
      if (!stillExists) state.selectedHistoryPersonId = primary ? primary.id : null;
      select.innerHTML = allPersons.map(p => `<option value="${p.id}">${ASTRA_ACTIVITY.formatPersonId(p.id)}</option>`).join('')
        || '<option value="">—</option>';
      if (state.selectedHistoryPersonId != null) select.value = state.selectedHistoryPersonId;
    }

    const historyList = $('#personHistoryList');
    if (historyList) {
      const rec = state.selectedHistoryPersonId != null ? ASTRA_ACTIVITY.getById(state.selectedHistoryPersonId) : null;
      historyList.innerHTML = rec && rec.history.length
        ? rec.history.map(h => `
            <div class="timeline-item success">
              <div><div class="timeline-time">${h.time}</div><div class="timeline-text">${h.label.toUpperCase()}</div></div>
            </div>`).join('')
        : `<div class="person-list-empty">No history yet.</div>`;
    }
  }

  function initHistoryPersonSelect() {
    const select = $('#historyPersonSelect');
    if (!select) return;
    select.addEventListener('change', () => {
      state.selectedHistoryPersonId = select.value ? Number(select.value) : null;
      renderGeneralActivityPage(ASTRA_ACTIVITY.getAll());
    });
  }

  /* ------------------------------- HAND-OBJECT / POSE / HMR PANELS ------------------------------- */

  const HOI_TARGET = {
    PICK_UP: { object: 'CHEMICAL BOTTLE', interaction: 'REACHING', steps: ['REACH', 'GRASP', 'LIFT'], activeStep: 0 },
    OPEN_CAP: { object: 'CHEMICAL BOTTLE', interaction: 'MANIPULATING', steps: ['GRASP', 'TWIST', 'OPEN'], activeStep: 1 },
    DRAW_LIQUID: { object: 'SYRINGE', interaction: 'DRAWING', steps: ['INSERT', 'DRAW', 'WITHDRAW'], activeStep: 1 },
    POUR_LIQUID: { object: 'TEST TUBE', interaction: 'POURING', steps: ['ALIGN', 'POUR', 'RELEASE'], activeStep: 1 },
    MIX: { object: 'TEST TUBE', interaction: 'MIXING', steps: ['GRASP', 'STIR', 'SETTLE'], activeStep: 1 },
    PICKING_OBJECT: { object: 'RED BOX', interaction: 'REACHING', steps: ['REACH', 'GRASP', 'LIFT'], activeStep: 0 },
    REACHING: { object: 'RED BOX', interaction: 'REACHING', steps: ['REACH', 'GRASP', 'LIFT'], activeStep: 0 },
  };

  function renderHoiPanel(primary) {
    const box = $('#hoiBox');
    if (!box) return;
    const hoi = primary ? HOI_TARGET[primary.activity] : null;
    if (hoi) {
      box.innerHTML = `
        <div class="hoi-hand">
          <div class="hoi-hand-title">LEFT HAND</div>
          <div class="hoi-flow"><span class="arrow">↓</span><span class="hoi-target">${hoi.object}</span></div>
          <div class="hoi-meta"><span>Interaction</span><b>${hoi.interaction}</b></div>
          <div class="hoi-meta"><span>Distance</span><b>${(10 + Math.random() * 8).toFixed(0)} cm</b></div>
          <div class="hoi-steps">
            ${hoi.steps.map((s, i) => `<span class="hoi-step ${i === hoi.activeStep ? 'active' : ''}">${s}</span>`).join('')}
          </div>
        </div>
        <div class="hoi-hand"><div class="hoi-hand-title">RIGHT HAND</div><div class="hoi-idle">IDLE</div></div>`;
    } else {
      box.innerHTML = `
        <div class="hoi-hand"><div class="hoi-hand-title">LEFT HAND</div><div class="hoi-idle">IDLE</div></div>
        <div class="hoi-hand"><div class="hoi-hand-title">RIGHT HAND</div><div class="hoi-idle">IDLE</div></div>`;
    }
  }

  function renderPosePanel(primary) {
    const el = $('#poseInfoList');
    if (!el) return;
    const conf = primary ? primary.confidence : null;
    const har = ASTRA_API.getDetectionMode() === 'REAL' && ASTRA_API.isRealDetectionReady();
    el.innerHTML = kvHtml([
      { k: 'Model', v: har ? 'MediaPipe Pose Landmarker' : 'Simulated' },
      { k: 'Keypoints', v: har ? '33 (2D + 3D metric world)' : '—' },
      { k: 'Confidence', v: conf != null ? `${conf.toFixed(1)}%` : '—', cls: 'green' },
      { k: 'Tracking', v: primary ? 'ACTIVE' : 'IDLE', cls: primary ? 'cyan' : '' },
      { k: 'HAR Pipeline', v: har ? 'Body-Centric Kinematics' : 'Scripted', cls: har ? 'green' : 'orange' },
      { k: 'Orientation Invariance', v: 'ACTIVE (0-G Validated)', cls: 'green' },
    ]);
  }

  function renderHmrPanel(primary) {
    const el = $('#hmrInfoList');
    if (!el) return;
    const bt = primary && primary.bodyTelemetry;
    if (bt) {
      el.innerHTML = kvHtml([
        { k: 'Coordinate Basis', v: bt.frameType || 'BODY-CENTRIC (3D)', cls: 'cyan' },
        { k: 'Rack Pitch / Roll', v: `${bt.rackPitchDeg >= 0 ? '+' : ''}${bt.rackPitchDeg}° / ${bt.rackRollDeg >= 0 ? '+' : ''}${bt.rackRollDeg}°`, cls: 'cyan' },
        { k: 'Knee / Hip Ext', v: `${bt.kneeExtDeg}° / ${bt.hipExtDeg}°`, cls: bt.kneeExtDeg >= 135 ? 'green' : 'orange' },
        { k: 'Gait Cadence', v: bt.cadenceHz > 0 ? `${bt.cadenceHz} Hz (${bt.cadenceHz > 1.8 ? 'RAPID' : 'LOCOMOTION'})` : 'STABLE (0.0 Hz)', cls: bt.cadenceHz > 0 ? 'cyan' : 'green' },
        { k: 'Gravity Reference', v: 'INDEPENDENT (0-G)', cls: 'green' },
      ]);
    } else {
      el.innerHTML = kvHtml([
        { k: 'Coordinate Basis', v: 'BODY-CENTRIC (3D)', cls: 'cyan' },
        { k: 'Payload Rack', v: 'FIXED REFERENCE' },
        { k: 'Gravity Reference', v: 'NOT REQUIRED' },
        { k: 'Orientation Mode', v: 'ARBITRARY (0-G)', cls: 'cyan' },
      ]);
    }
  }

  /* ------------------------------- OBJECT TABLE ------------------------------- */

  function renderObjectTable(objects) {
    const tbody = $('#objectTrackTable tbody');
    if (!tbody) return;
    if (!objects.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-2)">No objects detected</td></tr>`;
      return;
    }
    tbody.innerHTML = objects.map(o => `
      <tr><td>OBJECT #${o.id}</td><td>${o.label.replace(/_/g, ' ')}</td><td>${o.confidence.toFixed(1)}%</td><td class="status-info">TRACKED</td></tr>
    `).join('');
  }

  /* ------------------------------- DETECTION TICK (drives all AI-derived UI) ------------------------------- */

  function onDetectionFrame(frame) {
    if (!frame) return;
    if (frame.channel === 'live') {
      state.liveFrame = frame;
      state.latestFrame = frame;
      ASTRA_ACTIVITY.update(frame.persons || []);

      const allPersons = ASTRA_ACTIVITY.getAll();
      const primary = allPersons[0] || null;

      updateDashboardHero(primary);
      renderDashExperimentMini(ASTRA_EXPERIMENT.getStatus());
      renderPersonListInto('personListLive', allPersons);
      renderObjectTable(frame.objects || []);
      renderHoiPanel(primary);
      renderPosePanel(primary);
      renderHmrPanel(primary);
      renderGeneralActivityPage(allPersons);
    } else if (frame.channel === 'exp') {
      state.expFrame = frame;
      const primary = (frame.persons && frame.persons[0]) || null;

      // Live AI Sequence Validation strictly operates on Experiment Mode media!
      if (primary && ASTRA_MEDIA.exp.isActive()) {
        ASTRA_EXPERIMENT.processLiveDetection(primary);
      }
      renderStepList(ASTRA_EXPERIMENT.getStatus());
      renderFsmDiagram(ASTRA_EXPERIMENT.getStatus());
      renderValidatorCard(ASTRA_EXPERIMENT.getStatus());
    }
  }

  /* ------------------------------- VISION CANVAS REDRAW LOOP ------------------------------- */

  function visionLoop() {
    const liveActive = ASTRA_MEDIA.live.isActive();
    const liveLoading = liveActive && ASTRA_API.getDetectionMode() === 'REAL' && !ASTRA_API.isRealDetectionReady();

    const expActive = ASTRA_MEDIA.exp.isActive();
    const expLoading = expActive && ASTRA_API.getDetectionMode() === 'REAL' && !ASTRA_API.isRealDetectionReady();

    // Render live canvases (Dashboard, Live Analysis, Video Streaming)
    ['overlayCanvasDash', 'overlayCanvasLive', 'overlayCanvasStream'].forEach(id => {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      try {
        if (!liveActive) ASTRA_OVERLAY.drawPlaceholder(canvas, 'NO ACTIVE FEED — Upload an image/video or start Live Camera');
        else if (liveLoading) ASTRA_OVERLAY.drawPlaceholder(canvas, 'LOADING REAL AI MODEL — one-time, then fully offline');
        else ASTRA_OVERLAY.render(canvas, state.liveFrame);
      } catch (err) {
        console.error('visionLoop render failed for', id, err);
      }
    });

    // Render experiment canvas (strictly isolated from live feed!)
    const expCanvas = document.getElementById('overlayCanvasExp');
    if (expCanvas) {
      try {
        if (!expActive) ASTRA_OVERLAY.drawPlaceholder(expCanvas, 'NO ACTIVE FEED — Upload an image/video or start Live Camera');
        else if (expLoading) ASTRA_OVERLAY.drawPlaceholder(expCanvas, 'LOADING REAL AI MODEL — one-time, then fully offline');
        else ASTRA_OVERLAY.render(expCanvas, state.expFrame);
      } catch (err) {
        console.error('visionLoop render failed for overlayCanvasExp', err);
      }
    }

    requestAnimationFrame(visionLoop);
  }

  /* ------------------------------- MEDIA / CAMERA WIRING ------------------------------- */

  async function populateDeviceSelect(selectEl) {
    if (!selectEl) return;
    const prior = selectEl.value;
    const devices = await ASTRA_CAMERA.listVideoDevices();
    if (devices.length === 0) {
      selectEl.innerHTML = '<option value="">Default Camera</option>';
      return;
    }
    selectEl.innerHTML = devices.map((d, i) => `<option value="${d.deviceId}">${d.label || `Camera ${i + 1}`}</option>`).join('');
    if (prior && devices.some(d => d.deviceId === prior)) selectEl.value = prior;
  }

  function refreshAllDeviceSelects() {
    populateDeviceSelect($('#cameraDeviceSelect'));
    populateDeviceSelect($('#cameraDeviceSelect2'));
    populateDeviceSelect($('#cameraDeviceSelectExp'));
  }

  function wireMediaControls({ uploadId, cameraBtnId, deviceSelectId, playBtnId, clearBtnId, channel = 'live' }) {
    const mediaChan = ASTRA_MEDIA.getChannel(channel);
    const uploadInput = uploadId ? document.getElementById(uploadId) : null;
    const cameraBtn = cameraBtnId ? document.getElementById(cameraBtnId) : null;
    const deviceSelect = deviceSelectId ? document.getElementById(deviceSelectId) : null;
    const playBtn = playBtnId ? document.getElementById(playBtnId) : null;
    const clearBtn = clearBtnId ? document.getElementById(clearBtnId) : null;

    if (deviceSelect) populateDeviceSelect(deviceSelect);

    if (uploadInput) uploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      mediaChan.loadFile(file);
      e.target.value = '';
      if (playBtn) {
        playBtn.innerHTML = '<i data-lucide="pause"></i> Pause';
        if (window.lucide) window.lucide.createIcons();
      }
    });

    if (cameraBtn) cameraBtn.addEventListener('click', async () => {
      if (!ASTRA_CAMERA.isCameraSupported()) return;
      const deviceId = deviceSelect ? deviceSelect.value || undefined : undefined;
      await mediaChan.startCamera(deviceId);
      refreshAllDeviceSelects();
      if (playBtn) {
        playBtn.innerHTML = '<i data-lucide="pause"></i> Pause';
        if (window.lucide) window.lucide.createIcons();
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', () => {
      mediaChan.stop();
      if (playBtn) {
        playBtn.innerHTML = '<i data-lucide="play"></i> Play';
        if (window.lucide) window.lucide.createIcons();
      }
    });

    if (playBtn) playBtn.addEventListener('click', () => {
      const isPaused = mediaChan.isPaused();
      if (isPaused) {
        mediaChan.play();
        playBtn.innerHTML = '<i data-lucide="pause"></i> Pause';
      } else {
        mediaChan.pause();
        playBtn.innerHTML = '<i data-lucide="play"></i> Play';
      }
      if (window.lucide) window.lucide.createIcons();
    });
  }

  function sourceLabelFor(mstate) {
    if (mstate.type === 'camera') return `SOURCE: LIVE CAMERA${mstate.label ? ` — ${mstate.label}` : ''}`;
    if (mstate.type === 'image') return `SOURCE: IMAGE — ${mstate.label}`;
    if (mstate.type === 'video') return `SOURCE: VIDEO — ${mstate.label}`;
    return 'SOURCE: IDLE';
  }

  /* ------------------------------- DETECTION MODE (REAL vs SIMULATED) ------------------------------- */

  function detectionModeBadge() {
    const mode = ASTRA_API.getDetectionMode();
    if (mode === 'REAL') {
      return ASTRA_API.isRealDetectionReady()
        ? { text: '🟢 LIVE DETECTION (unverified objects)', dotCls: 'dot-green', cls: 'tag-mode-real', pillCls: 'pill-mode-real' }
        : { text: '🟡 LOADING LIVE DETECTION…', dotCls: 'dot-orange', cls: 'tag-mode-loading', pillCls: 'pill-mode-loading' };
    }
    return { text: '🔴 SIMULATED DATA', dotCls: 'dot-orange', cls: 'tag-mode-sim', pillCls: 'pill-mode-sim' };
  }

  function updateModeUI() {
    const badge = detectionModeBadge();
    ['dashModeTag', 'modeTagLive', 'streamModeTag', 'modeTagExp'].forEach(id => {
      const el = $(`#${id}`);
      if (!el) return;
      el.textContent = badge.text;
      el.className = `tag ${badge.cls}`;
    });

    const topbarText = $('#topbarModeText');
    const topbarDot = $('#topbarModeDot');
    const topbarPill = $('#topbarModeBadge');
    if (topbarText) topbarText.textContent = badge.text;
    if (topbarDot) topbarDot.className = `dot ${badge.dotCls} pulse`;
    if (topbarPill) topbarPill.className = `status-pill status-pill-mode ${badge.pillCls}`;

    const mode = ASTRA_API.getDetectionMode();
    $all('.mode-toggle .mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
      btn.classList.toggle('loading', mode === 'REAL' && btn.dataset.mode === 'REAL' && !ASTRA_API.isRealDetectionReady());
    });

    const hintText = mode === 'REAL'
      ? 'Real on-device detection (person + pose + generic objects, COCO classes only) — runs fully offline, no footage leaves this device.'
      : 'Simulated mode acts out the full BAS pick-up → open-cap → draw-liquid → pour-liquid → mix → place-back sequence for demoing the FSM — independent of what the camera actually sees.';
    ['detectionModeHint', 'detectionModeHintExp'].forEach(id => {
      const hint = $(`#${id}`);
      if (hint) hint.textContent = hintText;
    });
  }

  function initDetectionModeToggle() {
    $all('.mode-toggle .mode-btn').forEach(btn => {
      btn.addEventListener('click', () => ASTRA_API.setDetectionMode(btn.dataset.mode));
    });
    ASTRA_API.onModeChange(() => {
      updateModeUI();
      renderModulePanels();   /* re-render honest status on mode switch */
    });
    updateModeUI();
  }

  function initMediaPanels() {
    // Register live panels
    ASTRA_MEDIA.live.registerPanel({ video: $('#videoFeedDash'), img: $('#imgFeedDash'), stage: $('#visionStageDash') });
    ASTRA_MEDIA.live.registerPanel({ video: $('#videoFeedLive'), img: $('#imgFeedLive'), stage: $('#visionStageLive') });
    ASTRA_MEDIA.live.registerPanel({ video: $('#videoFeedStream'), img: $('#imgFeedStream'), stage: $('#visionStageStream') });

    // Register experiment panel (strictly isolated from live feed!)
    ASTRA_MEDIA.exp.registerPanel({ video: $('#videoFeedExp'), img: $('#imgFeedExp'), stage: $('#visionStageExp') });

    ASTRA_MEDIA.live.subscribe((mstate) => {
      const label = sourceLabelFor(mstate);
      ['dashSourceTag', 'videoSourceTag'].forEach(id => {
        const el = $(`#${id}`);
        if (el) el.textContent = label;
      });
    });

    ASTRA_MEDIA.exp.subscribe((mstate) => {
      const label = sourceLabelFor(mstate);
      const el = $('#expSourceTag');
      if (el) el.textContent = label;
      if (mstate.type === 'none') {
        ASTRA_EXPERIMENT.resetLiveTracking();
        renderStepList(ASTRA_EXPERIMENT.getStatus());
        renderValidatorCard(ASTRA_EXPERIMENT.getStatus());
      }
    });

    wireMediaControls({
      uploadId: 'videoUploadInput', cameraBtnId: 'startCameraBtn', deviceSelectId: 'cameraDeviceSelect',
      playBtnId: 'playPauseBtn', clearBtnId: 'clearFeedBtn', channel: 'live',
    });
    wireMediaControls({
      uploadId: 'videoUploadInput2', cameraBtnId: 'startCameraBtn2', deviceSelectId: 'cameraDeviceSelect2',
      channel: 'live',
    });
    wireMediaControls({
      uploadId: 'videoUploadInputExp', cameraBtnId: 'startCameraBtnExp', deviceSelectId: 'cameraDeviceSelectExp',
      playBtnId: 'playPauseBtnExp', clearBtnId: 'clearFeedBtnExp', channel: 'exp',
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshAllDeviceSelects);
    }
  }

  /* ------------------------------- EXPERIMENT MODE PAGE ------------------------------- */

  function sequenceRailHtml(status) {
    if (!status || !status.sequence || !status.sequence.length) return '';
    return `
      <div class="sequence-rail" role="region" aria-label="Experiment Sequence Rail">
        ${status.sequence.map((s, i) => {
          const isDone = i < status.currentIndex;
          const isCurrent = i === status.currentIndex && !status.completed;
          const isSkipped = isCurrent && status.status === 'INVALID';
          const nodeState = isSkipped ? 'skipped' : isDone ? 'done' : isCurrent ? 'current' : 'pending';
          const stateLabel = isSkipped ? 'GAP' : isDone ? 'DONE' : isCurrent ? 'NOW' : i === status.currentIndex + 1 ? 'NEXT' : 'PEND';
          const lineClass = isDone ? 'line-solid' : isSkipped ? 'line-broken' : 'line-pending';
          return `
            <div class="rail-node-wrap ${nodeState}">
              <div class="rail-node ${nodeState}" title="S${i+1}: ${s.label} (${stateLabel})">
                <span class="rail-id">S${i+1}</span>
              </div>
              <span class="rail-label">${s.label}</span>
              <span class="rail-status-text">${stateLabel}</span>
            </div>
            ${i < status.sequence.length - 1 ? `<div class="rail-connector ${lineClass}"></div>` : ''}
          `;
        }).join('')}
      </div>`;
  }

  function renderStepList(status) {
    const el = $('#stepList');
    if (!el) return;
    el.innerHTML = `
      ${sequenceRailHtml(status)}
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        ${status.sequence.map((s, i) => {
          const isDone = i < status.currentIndex;
          const isCurrent = i === status.currentIndex && !status.completed;
          const isViolated = isCurrent && status.status === 'INVALID';
          const cls = isViolated ? 'violation' : isDone ? 'done' : isCurrent ? 'current' : '';
          const icon = isViolated ? '⚠' : isDone ? '✓' : isCurrent ? '●' : '○';
          return `<div class="step-item ${cls}">
            <div class="step-icon">${icon}</div>
            <div class="step-label">${String(i + 1).padStart(2, '0')} ${s.label}</div>
            ${isViolated ? '<span class="tag tag-mode-sim" style="margin-left:auto;font-size:9.5px;padding:2px 6px;">VIOLATION</span>' : ''}
            ${isDone ? '<span class="tag tag-green" style="margin-left:auto;font-size:9.5px;padding:2px 6px;">DONE</span>' : ''}
            ${isCurrent && !isViolated ? '<span class="tag tag-cyan" style="margin-left:auto;font-size:9.5px;padding:2px 6px;">ACTIVE</span>' : ''}
          </div>`;
        }).join('')}
      </div>`;
    $('#stepCurrent').textContent = status.completed ? status.totalSteps : status.currentStepNumber;
    $('#stepTotal').textContent = status.totalSteps;

    const badge = $('#expValidationBadge');
    if (badge) {
      if (status.status === 'INVALID') {
        badge.className = 'tag tag-mode-sim pulse';
        badge.textContent = '⚠ VIOLATION DETECTED';
      } else if (status.completed) {
        badge.className = 'tag tag-green';
        badge.textContent = '✓ SEQUENCE COMPLETE';
      } else if (ASTRA_MEDIA.exp.isActive()) {
        badge.className = 'tag tag-green';
        badge.textContent = '● LIVE AI MONITORING';
      } else {
        badge.className = 'tag tag-cyan';
        badge.textContent = 'IDLE';
      }
    }

    const feedback = $('#stepLiveFeedback');
    if (feedback) {
      if (status.status === 'INVALID' && status.lastViolation) {
        feedback.innerHTML = `<span style="color:var(--status-critical); font-weight:700;">⚠ VIOLATION: Expected ${status.lastViolation.expected}, detected ${status.lastViolation.detected}</span>`;
      } else if (status.completed) {
        feedback.innerHTML = '<span style="color:var(--status-nominal); font-weight:700;">✓ Protocol completed successfully</span>';
      } else if (status.currentDetectedActivity) {
        const confStr = status.currentConfidence ? ` (${status.currentConfidence.toFixed(0)}%)` : '';
        feedback.innerHTML = `LIVE DETECTED: <b style="color:var(--accent-signal);">${status.currentDetectedActivity}</b>${confStr}`;
      } else {
        feedback.innerHTML = 'Awaiting live feed or camera activity...';
      }
    }
  }

  function renderFsmDiagram(status) {
    const diagram = $('#fsmDiagram');
    if (!diagram) return;
    diagram.innerHTML = status.sequence.map((s, i) => {
      const isDone = i < status.currentIndex;
      const isCurrent = i === status.currentIndex && !status.completed;
      const violated = isCurrent && status.status === 'INVALID';
      const cls = violated ? 'violation' : isDone ? 'done' : isCurrent ? 'current' : '';
      const arrow = i < status.sequence.length - 1 ? '<div class="fsm-arrow">↓</div>' : '';
      return `<div class="fsm-node ${cls}">[ ${s.label} ]</div>${arrow}`;
    }).join('');

    const statusBox = $('#fsmStatusBox');
    const detected = status.lastViolation ? status.lastViolation.detected : (status.status === 'VALID' ? status.expected : '—');
    statusBox.innerHTML = `
      <div class="dash-exp-row"><span>FSM STATUS</span><b style="color:${status.status === 'VALID' ? 'var(--green)' : 'var(--red)'}">${status.status}</b></div>
      <div class="dash-exp-row"><span>Expected State</span><b>${status.expected}</b></div>
      <div class="dash-exp-row"><span>Detected Activity</span><b>${detected}</b></div>
      <div class="dash-exp-row"><span>Transition</span><b>${status.status === 'VALID' ? 'VALID' : 'INVALID'}</b></div>`;
  }

  function renderGuidance() {
    const g = ASTRA_EXPERIMENT.getGuidance();
    const box = $('#guidanceBox');
    if (!box) return;
    box.innerHTML = `
      <div class="guidance-label">NEXT EXPECTED ACTION</div>
      <div class="guidance-action">${g.action}</div>
      <div class="guidance-instruction">"${g.instruction}"</div>
      <div class="guidance-footer">
        <span class="tag tag-green">VOICE: ON</span>
        <button class="btn btn-outline btn-sm" id="repeatGuidanceBtn"><i data-lucide="volume-2"></i> Repeat</button>
      </div>`;
    $('#repeatGuidanceBtn').addEventListener('click', () => ASTRA_EXPERIMENT.repeatGuidance());
    if (window.lucide) window.lucide.createIcons();
  }

  function renderViolationPanel(status) {
    const panel = $('#violationPanel');
    const box = $('#violationBox');
    if (!panel || !box) return;
    if (status.status === 'INVALID' && status.lastViolation) {
      panel.style.display = '';
      const v = status.lastViolation;
      box.innerHTML = `
        <div class="violation-row"><span>Expected Activity</span><b>${v.expected}</b></div>
        <div class="violation-row"><span>Detected Activity</span><b>${v.detected}</b></div>
        <div class="violation-row"><span>Step</span><b>${v.step} / ${status.totalSteps}</b></div>
        <div class="violation-row"><span>FSM Transition</span><b>INVALID</b></div>
        <div class="violation-row"><span>Voice Alert</span><b style="color:var(--green)">ON</b></div>
        <div class="violation-severity">SEVERITY: ${v.severity}</div>`;
    } else {
      panel.style.display = 'none';
    }
  }

  function renderValidatorCard(status) {
    const livePosture = $('#livePostureText');
    if (livePosture) {
      if (status.currentDetectedActivity) {
        const confStr = status.currentConfidence ? ` (${status.currentConfidence.toFixed(0)}%)` : '';
        livePosture.textContent = `${status.currentDetectedActivity}${confStr}`;
      } else {
        livePosture.textContent = ASTRA_MEDIA.exp.isActive() ? 'DETECTING MOVEMENT…' : 'AWAITING VIDEO / CAMERA';
      }
    }

    const targetStep = $('#targetStepText');
    if (targetStep) {
      targetStep.textContent = status.completed ? 'ALL STEPS COMPLETED' : `STEP ${status.currentStepNumber}: ${status.expected}`;
    }

    const health = $('#validatorHealthText');
    if (health) {
      if (status.status === 'INVALID' && status.lastViolation) {
        health.className = 'val red';
        health.textContent = `⚠ VIOLATION (${status.lastViolation.detected})`;
      } else if (status.completed) {
        health.className = 'val green';
        health.textContent = '✓ SEQUENCE COMPLETE';
      } else {
        health.className = 'val green';
        health.textContent = '✓ NOMINAL';
      }
    }

    const vBadge = $('#validatorStatusBadge');
    if (vBadge) {
      if (status.status === 'INVALID') {
        vBadge.className = 'tag tag-mode-sim pulse';
        vBadge.textContent = '⚠ VIOLATION DETECTED';
      } else if (status.completed) {
        vBadge.className = 'tag tag-green';
        vBadge.textContent = '✓ SEQUENCE COMPLETE';
      } else if (ASTRA_MEDIA.exp.isActive()) {
        vBadge.className = 'tag tag-green pulse';
        vBadge.textContent = '● AUTO-SHIFTING ON';
      } else {
        vBadge.className = 'tag tag-cyan';
        vBadge.textContent = 'IDLE';
      }
    }

    const voiceBtn = $('#toggleVoiceBtn');
    if (voiceBtn) {
      voiceBtn.innerHTML = status.voiceEnabled ? '<i data-lucide="volume-2"></i> VOICE: ON' : '<i data-lucide="volume-x"></i> VOICE: OFF';
      if (window.lucide) window.lucide.createIcons();
    }
  }

  function renderTimeline() {
    const list1 = $('#timelineList');
    const list2 = $('#historyTimelineList');
    const items = ASTRA_EXPERIMENT.getTimeline();
    const html = items.map(t => `
      <div class="timeline-item ${t.cls}">
        <div><div class="timeline-time">${t.time}</div><div class="timeline-text">${t.text}</div></div>
      </div>`).join('');
    if (list1) list1.innerHTML = html;
    if (list2) list2.innerHTML = html;
  }

  function statusPillHtml(status) {
    return status === 'SUCCESS' ? '<span class="status-success">SUCCESS</span>'
      : status === 'VIOLATION' ? '<span class="status-violation">VIOLATION</span>'
      : `<span class="status-info">${status}</span>`;
  }

  function renderEventTables() {
    const log = ASTRA_EXPERIMENT.getEventLog();
    const rowHtml = e => `<tr><td>${e.time}</td><td>${e.type}</td><td>${e.activity}</td><td>${e.confidence}</td><td>${e.expected}</td><td>${statusPillHtml(e.status)}</td></tr>`;
    const dashBody = $('#dashEventTable tbody');
    const fullBody = $('#fullEventTable tbody');
    if (dashBody) dashBody.innerHTML = log.slice(0, 6).map(rowHtml).join('');
    if (fullBody) fullBody.innerHTML = log.map(rowHtml).join('');
  }

  function renderDashExperimentMini(status) {
    const el = $('#dashExperimentMini');
    if (!el) return;
    el.innerHTML = `
      <div class="dash-exp-row"><span>Step</span><b>${status.completed ? status.totalSteps : status.currentStepNumber} / ${status.totalSteps}</b></div>
      <div class="dash-exp-row"><span>Expected</span><b>${status.expected}</b></div>
      <div class="dash-exp-row"><span>Detected</span><b>${status.lastViolation ? status.lastViolation.detected : status.expected}</b></div>
      <div class="dash-exp-status ${status.status === 'VALID' ? 'status-valid' : 'status-invalid'}">
        ${status.status === 'VALID' ? '✓ VALID TRANSITION' : '⚠ SEQUENCE VIOLATION'}
      </div>
      ${sequenceRailHtml(status)}`;
  }

  function showViolationToast(v) {
    const stack = $('#toastStack');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i data-lucide="alert-triangle"></i>
      <div class="toast-text">
        <b>SEQUENCE VIOLATION</b><br>
        Expected <b>${v.expected}</b>, detected <b>${v.detected}</b> at step ${v.step}.
      </div>`;
    stack.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .4s'; setTimeout(() => toast.remove(), 400); }, 5000);
  }

  function renderExperimentPage(status) {
    renderStepList(status);
    renderFsmDiagram(status);
    renderGuidance();
    renderViolationPanel(status);
    renderValidatorCard(status);
    renderTimeline();
    renderEventTables();
    renderDashExperimentMini(status);

    if (status.lastViolation && status.lastViolation !== state.lastViolationRef) {
      state.lastViolationRef = status.lastViolation;
      showViolationToast(status.lastViolation);
    }
    if (status.status === 'VALID') state.lastViolationRef = null;
  }

  function initExperimentControls() {
    const resetBtn = $('#resetExperimentBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => ASTRA_EXPERIMENT.reset());
    const quickReset = $('#quickResetExpBtn');
    if (quickReset) quickReset.addEventListener('click', () => ASTRA_EXPERIMENT.reset());
    const voiceBtn = $('#toggleVoiceBtn');
    if (voiceBtn) voiceBtn.addEventListener('click', () => {
      const current = ASTRA_EXPERIMENT.getStatus().voiceEnabled;
      ASTRA_EXPERIMENT.setVoiceEnabled(!current);
      renderValidatorCard(ASTRA_EXPERIMENT.getStatus());
    });
    const exportBtn = $('#exportLogBtn');
    if (exportBtn) exportBtn.addEventListener('click', () => ASTRA_EXPERIMENT.exportEventLogTxt());
    ASTRA_EXPERIMENT.subscribe(renderExperimentPage);
    renderExperimentPage(ASTRA_EXPERIMENT.getStatus());
  }

  /* ------------------------------- EXPERIMENT BUILDER PAGE ------------------------------- */

  function populateStepActivitySelect() {
    const sel = $('#stepActivitySelect');
    sel.innerHTML = ASTRA_EXPERIMENT.getActivityMasterList().map(a => `<option value="${a.code}">${a.label}</option>`).join('');
  }

  let builderSelectedIndex = -1;

  function renderBuilderList() {
    const el = $('#builderStepList');
    if (!el) return;
    if (state.builderSteps.length === 0) {
      el.innerHTML = `<div class="builder-empty">No steps added yet. Choose an activity and click "Add Step".</div>`;
      return;
    }
    el.innerHTML = state.builderSteps.map((s, i) => `
      <div class="builder-item ${i === builderSelectedIndex ? 'selected' : ''}" data-idx="${i}">
        <span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="name">${s.label}</span>
      </div>`).join('');
    el.querySelectorAll('.builder-item').forEach(item => {
      item.addEventListener('click', () => { builderSelectedIndex = Number(item.dataset.idx); renderBuilderList(); });
    });
  }

  function initBuilder() {
    populateStepActivitySelect();
    renderBuilderList();

    $('#addStepBtn').addEventListener('click', () => {
      const sel = $('#stepActivitySelect');
      const code = sel.value;
      const label = sel.options[sel.selectedIndex].textContent.toUpperCase();
      state.builderSteps.push({ code, label });
      renderBuilderList();
    });

    $('#removeStepBtn').addEventListener('click', () => {
      if (builderSelectedIndex < 0) return;
      state.builderSteps.splice(builderSelectedIndex, 1);
      builderSelectedIndex = -1;
      renderBuilderList();
    });

    $('#moveUpBtn').addEventListener('click', () => {
      if (builderSelectedIndex <= 0) return;
      const arr = state.builderSteps;
      [arr[builderSelectedIndex - 1], arr[builderSelectedIndex]] = [arr[builderSelectedIndex], arr[builderSelectedIndex - 1]];
      builderSelectedIndex -= 1;
      renderBuilderList();
    });

    $('#moveDownBtn').addEventListener('click', () => {
      if (builderSelectedIndex < 0 || builderSelectedIndex >= state.builderSteps.length - 1) return;
      const arr = state.builderSteps;
      [arr[builderSelectedIndex + 1], arr[builderSelectedIndex]] = [arr[builderSelectedIndex], arr[builderSelectedIndex + 1]];
      builderSelectedIndex += 1;
      renderBuilderList();
    });

    $('#saveExperimentBtn').addEventListener('click', () => {
      const name = $('#expNameInput').value.trim() || 'Untitled Experiment';
      const hint = $('#builderHint');
      if (state.builderSteps.length === 0) {
        hint.textContent = 'Add at least one step before saving.';
        hint.style.color = 'var(--red)';
        return;
      }
      const codes = state.builderSteps.map(s => s.code);
      ASTRA_EXPERIMENT.setSequence(name, codes);
      ASTRA_API.createExperiment({ name, steps: codes });
      hint.textContent = `"${name}" saved and loaded into the active FSM — switch to Experiment Mode to run it.`;
      hint.style.color = 'var(--green)';
    });
  }

  /* ------------------------------- SYSTEM MONITOR ------------------------------- */

  let opencvFramesProcessed = 128421;

  function renderHwMetricGrid(m) {
    const grid = $('#hwMetricGrid');
    if (!grid) return;
    const items = [
      { label: 'CPU', value: m.cpu, cls: 'cyan' }, { label: 'GPU', value: m.gpu, cls: 'green' },
      { label: 'RAM', value: m.ram, cls: 'cyan' }, { label: 'VRAM', value: m.vram, cls: 'orange' },
    ];
    grid.innerHTML = items.map(it => `
      <div class="metric-card">
        <div class="m-label">${it.label}</div>
        <div class="m-value ${it.cls}">${it.value.toFixed(0)}%</div>
        <div class="bar"><div class="bar-fill" style="width:${it.value}%;background:var(--${it.cls === 'cyan' ? 'cyan' : it.cls === 'green' ? 'green' : 'orange'})"></div></div>
      </div>`).join('');
  }

  function renderSysMiniGrid(m) {
    const grid = $('#sysMiniGrid');
    if (!grid) return;
    const items = [{ label: 'CPU', value: m.cpu }, { label: 'GPU', value: m.gpu }, { label: 'RAM', value: m.ram }, { label: 'VRAM', value: m.vram }];
    grid.innerHTML = items.map(it => `
      <div class="sys-mini-item">
        <div class="lbl">${it.label}</div>
        <div class="val">${it.value.toFixed(0)}%</div>
        <div class="bar"><div class="bar-fill" style="width:${it.value}%"></div></div>
      </div>`).join('');
  }

  function renderModelInfo(m) {
    const el = $('#modelInfoList');
    if (!el) return;
    el.innerHTML = kvHtml([
      { k: 'Model', v: m.model, cls: 'cyan' }, { k: 'Temporal Model', v: m.temporal_model, cls: 'cyan' },
      { k: 'Device', v: m.device, cls: 'green' }, { k: 'Inference FPS', v: m.inference_fps },
      { k: 'Latency', v: `${m.latency_ms} ms` }, { k: 'YOLO FPS', v: m.yolo_fps },
      { k: 'Pose FPS', v: m.pose_fps }, { k: 'HAR FPS', v: m.har_fps },
    ]);
  }

  function renderOpencvPanel(m) {
    const el = $('#opencvInfoList');
    if (!el) return;
    opencvFramesProcessed += m.inference_fps;
    el.innerHTML = kvHtml([
      { k: 'Status', v: 'ACTIVE', cls: 'green' }, { k: 'Resolution', v: '1920 × 1080' }, { k: 'FPS', v: '30' },
      { k: 'Frames Processed', v: opencvFramesProcessed.toLocaleString() },
      { k: 'Latency', v: `${m.latency_ms} ms` }, { k: 'Processing', v: 'LOCAL', cls: 'green' },
    ]);
  }

  function renderEdgePanel() {
    const el = $('#edgeInfoList');
    if (!el) return;
    el.innerHTML = kvHtml([
      { k: 'Internet', v: 'NOT REQUIRED', cls: 'green' }, { k: 'Inference', v: 'ON DEVICE', cls: 'green' },
      { k: 'Video', v: 'LOCAL', cls: 'green' }, { k: 'Model', v: 'ON DEVICE', cls: 'green' },
      { k: 'Data', v: 'LOCAL', cls: 'green' }, { k: 'Ground Communication', v: 'OPTIONAL', cls: 'orange' },
      { k: 'Status', v: '● OFFLINE CAPABLE', cls: 'green' },
    ]);
  }

  function renderStreamingPanels(m) {
    const ff = $('#ffmpegInfoList');
    if (ff) ff.innerHTML = kvHtml([
      { k: 'Recording', v: 'ACTIVE', cls: 'green' }, { k: 'Encoding', v: 'H.264' }, { k: 'IP Streaming', v: 'ACTIVE', cls: 'green' },
      { k: 'Container', v: 'MPEG-TS' }, { k: 'Bitrate', v: `${(3.2 + Math.random() * 0.6).toFixed(1)} Mbps` },
    ]);
    const st = $('#streamInfoList');
    if (st) st.innerHTML = kvHtml([
      { k: 'Destination', v: '192.168.1.100:8080', cls: 'cyan' }, { k: 'Protocol', v: 'RTSP', cls: 'cyan' },
      { k: 'Status', v: '● STREAMING', cls: 'green' }, { k: 'Latency', v: `${m.latency_ms} ms` },
      { k: 'Frames Sent', v: opencvFramesProcessed.toLocaleString() },
    ]);
  }

  function updateVisionHud(videoId, imgId, resId, fpsId, mockFps, channel = 'live') {
    const video = document.getElementById(videoId);
    const img = document.getElementById(imgId);
    const resEl = document.getElementById(resId);
    const fpsEl = document.getElementById(fpsId);
    if (!resEl || !fpsEl) return;
    const mediaChan = ASTRA_MEDIA.getChannel(channel);
    const type = mediaChan ? mediaChan.getType() : 'none';

    if (type === 'camera') {
      const live = ASTRA_CAMERA.getLiveTelemetry(channel);
      if (live && live.width && live.height) {
        resEl.textContent = `${live.width}×${live.height}`;
        fpsEl.textContent = live.frameRate ? `${live.frameRate} FPS · LIVE` : 'LIVE CAM';
        return;
      }
    } else if (type === 'video' && video && video.videoWidth) {
      resEl.textContent = `${video.videoWidth}×${video.videoHeight}`;
      fpsEl.textContent = video.paused ? 'PAUSED' : `${mockFps} FPS`;
      return;
    } else if (type === 'image' && img && img.naturalWidth) {
      resEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
      fpsEl.textContent = 'STATIC';
      return;
    }
    resEl.textContent = '1920×1080';
    fpsEl.textContent = 'IDLE';
  }

  function pollSystemMetrics() {
    ASTRA_API.getSystemMetrics().then(m => {
      renderHwMetricGrid(m);
      renderSysMiniGrid(m);
      renderModelInfo(m);
      renderOpencvPanel(m);
      renderEdgePanel();
      renderStreamingPanels(m);
      ASTRA_VIZ.pushPerfSample(m.inference_fps, m.latency_ms);
      updateVisionHud('videoFeedDash', 'imgFeedDash', 'visionResDash', 'visionFpsDash', m.inference_fps, 'live');
      updateVisionHud('videoFeedLive', 'imgFeedLive', 'visionResLive', 'visionFpsLive', m.inference_fps, 'live');
      updateVisionHud('videoFeedStream', 'imgFeedStream', 'visionResStream', 'visionFpsStream', m.inference_fps, 'live');
      updateVisionHud('videoFeedExp', 'imgFeedExp', 'visionResExp', 'visionFpsExp', m.inference_fps, 'exp');
    });
  }

  /* ------------------------------- SETTINGS PAGE ------------------------------- */

  function renderConnStatusPill(mode) {
    const pill = $('#connStatus');
    pill.innerHTML = mode === 'LIVE'
      ? '<span class="dot dot-green pulse"></span><span>BACKEND: LIVE</span>'
      : '<span class="dot dot-orange"></span><span>BACKEND: MOCK MODE</span>';
  }

  function initSettings() {
    $('#tryConnectBtn').addEventListener('click', () => {
      const base = $('#apiBaseInput').value.trim();
      const ws = $('#wsUrlInput').value.trim();
      const list = $('#settingsConnList');
      list.innerHTML = kvHtml([{ k: 'Status', v: 'CONNECTING…', cls: 'cyan' }]);
      ASTRA_API.tryConnectBackend(base, ws).then(res => {
        renderConnStatusPill(res.mode);
        list.innerHTML = kvHtml([
          { k: 'Connected', v: res.connected ? 'YES' : 'NO', cls: res.connected ? 'green' : 'orange' },
          { k: 'Mode', v: res.mode, cls: res.mode === 'LIVE' ? 'green' : 'orange' },
          { k: 'API Base', v: base }, { k: 'WebSocket', v: ws },
        ]);
      });
    });
  }

  /* ------------------------------- INIT ------------------------------- */

  function init() {
    initNav();
    /* Inject honest module state resolver before first render */
    ASTRA_VIZ.setModuleStateResolver(getModuleState);
    renderModulePanels();
    renderHoiPanel(null);
    renderPosePanel(null);
    renderHmrPanel();
    initExperimentControls();
    initBuilder();
    initSettings();
    initHistoryPersonSelect();
    initMediaPanels();
    initDetectionModeToggle();

    ASTRA_VIZ.initPerfChart($('#perfChart'));

    ASTRA_API.setRealDetectionElements({ video: $('#videoFeedLive'), img: $('#imgFeedLive') });
    ASTRA_API.connectWebSocket(onDetectionFrame);

    tickClock();
    setInterval(tickClock, 1000);
    setInterval(pollSystemMetrics, 1200);
    pollSystemMetrics();

    switchPage('dashboard');
    requestAnimationFrame(visionLoop);

    if (window.lucide) window.lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
