/* ==========================================================================
   media.js
   Multi-channel media management architecture. Supports completely isolated
   media channels (e.g. 'live' for Dashboard / Live Analysis / Streaming,
   and 'exp' for Experiment Mode). Each channel independently owns its
   lifecycle (file upload, live camera, play/pause, clear) and keeps its
   registered panels in sync without cross-channel leakage or conflict.
   ========================================================================== */

class MediaChannel {
  constructor(id, label) {
    this.id = id;
    this.label = label || id;
    this.panels = []; // { video, img, canvas }
    this.currentType = 'none'; // 'none' | 'image' | 'video' | 'camera'
    this.currentUrl = null;
    this.currentStream = null;
    this.currentLabel = '';
    this.subscribers = [];
  }

  notify() {
    const s = this.getState();
    this.subscribers.forEach(fn => {
      try { fn(s); } catch (e) { console.error('MediaChannel subscriber error:', e); }
    });
  }

  subscribe(fn) {
    this.subscribers.push(fn);
  }

  getState() {
    return { channel: this.id, type: this.currentType, label: this.currentLabel };
  }

  findStage(panel) {
    if (panel.stage) return panel.stage;
    if (panel.video) {
      if (typeof panel.video.closest === 'function') return panel.video.closest('.vision-stage');
      if (panel.video.parentElement) return panel.video.parentElement;
    }
    if (panel.img) {
      if (typeof panel.img.closest === 'function') return panel.img.closest('.vision-stage');
      if (panel.img.parentElement) return panel.img.parentElement;
    }
    return null;
  }

  updatePanelStage(panel) {
    const stage = this.findStage(panel);
    if (!stage || !stage.style) return;

    let naturalW = 0, naturalH = 0;
    if (this.currentType === 'video' || this.currentType === 'camera') {
      if (panel.video && panel.video.videoWidth && panel.video.videoHeight) {
        naturalW = panel.video.videoWidth;
        naturalH = panel.video.videoHeight;
      }
    } else if (this.currentType === 'image') {
      if (panel.img && panel.img.naturalWidth && panel.img.naturalHeight) {
        naturalW = panel.img.naturalWidth;
        naturalH = panel.img.naturalHeight;
      }
    }

    if (naturalW > 0 && naturalH > 0) {
      const ratio = naturalW / naturalH;
      stage.style.aspectRatio = `${naturalW} / ${naturalH}`;
      const maxH = Math.min(540, typeof window !== 'undefined' && window.innerHeight ? Math.round(window.innerHeight * 0.65) : 540);
      if (ratio < 1) {
        // Vertical / portrait media (e.g. 9:16 like 1080x1920)
        const targetW = Math.max(220, Math.round(maxH * ratio));
        stage.style.width = `min(100%, ${targetW}px)`;
      } else if (ratio < 1.35) {
        // Square or ~4:3 media
        const targetW = Math.round(maxH * ratio);
        stage.style.width = `min(100%, ${targetW}px)`;
      } else {
        // Standard landscape (16:9 or wider)
        stage.style.width = '100%';
      }
    } else {
      // Idle / no active media: reset to 16:9 full width
      stage.style.aspectRatio = '16 / 9';
      stage.style.width = '100%';
    }
  }

  updateAllStages() {
    this.panels.forEach(p => this.updatePanelStage(p));
  }

  applyToPanel(panel) {
    const { video, img } = panel;
    if (!video || !img) return;

    if (this.currentType === 'camera') {
      video.pause();
      video.removeAttribute('src');
      video.srcObject = this.currentStream;
      video.muted = true;
      video.hidden = false;
      img.hidden = true;
      video.play().catch(() => {});
      this.updatePanelStage(panel);
    } else if (this.currentType === 'video') {
      video.srcObject = null;
      video.src = this.currentUrl;
      video.loop = true;
      video.muted = true;
      video.hidden = false;
      img.hidden = true;
      video.play().catch(() => {});
      this.updatePanelStage(panel);
    } else if (this.currentType === 'image') {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      img.src = this.currentUrl;
      video.hidden = true;
      img.hidden = false;
      this.updatePanelStage(panel);
    } else {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      img.removeAttribute('src');
      video.hidden = true;
      img.hidden = true;
      this.updatePanelStage(panel);
    }
  }

  applyToAllPanels() {
    this.panels.forEach(p => this.applyToPanel(p));
  }

  registerPanel(panel) {
    if (!panel.stage) {
      panel.stage = this.findStage(panel);
    }
    this.panels.push(panel);

    const onMediaReady = () => this.updatePanelStage(panel);
    if (panel.video && typeof panel.video.addEventListener === 'function') {
      panel.video.addEventListener('loadedmetadata', onMediaReady);
      panel.video.addEventListener('loadeddata', onMediaReady);
      panel.video.addEventListener('canplay', onMediaReady);
      panel.video.addEventListener('resize', onMediaReady);
    }
    if (panel.img && typeof panel.img.addEventListener === 'function') {
      panel.img.addEventListener('load', onMediaReady);
    }

    this.applyToPanel(panel);
  }

  clearPrevious() {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    if (this.currentStream) {
      ASTRA_CAMERA.stopStreamForChannel(this.id);
      this.currentStream = null;
    }
  }

  async startCamera(deviceId) {
    this.clearPrevious();
    const res = await ASTRA_CAMERA.startLiveCamera(deviceId, this.id);
    if (!res.ok) {
      this.currentType = 'none';
      this.currentLabel = '';
      this.applyToAllPanels();
      this.notify();
      return res;
    }
    this.currentStream = res.stream;
    this.currentType = 'camera';
    this.currentLabel = res.deviceLabel || 'Live Camera';
    this.applyToAllPanels();
    this.notify();
    return res;
  }

  loadFile(file) {
    this.clearPrevious();
    const url = URL.createObjectURL(file);
    this.currentUrl = url;
    this.currentType = file.type.startsWith('image/') ? 'image' : 'video';
    this.currentLabel = file.name;
    this.applyToAllPanels();
    this.notify();
    return { ok: true, type: this.currentType, name: file.name };
  }

  stop() {
    this.clearPrevious();
    this.currentType = 'none';
    this.currentLabel = '';
    this.applyToAllPanels();
    this.notify();
  }

  isPaused() {
    const v = this.getVideoElement();
    return v ? v.paused : true;
  }

  play() {
    this.panels.forEach(p => {
      if (p.video && !p.video.hidden) p.video.play().catch(() => {});
    });
  }

  pause() {
    this.panels.forEach(p => {
      if (p.video && !p.video.hidden) p.video.pause();
    });
  }

  togglePlay() {
    if (this.isPaused()) {
      this.play();
      return true;
    } else {
      this.pause();
      return false;
    }
  }

  isActive() { return this.currentType !== 'none'; }
  getType() { return this.currentType; }

  getVideoElement() {
    for (const p of this.panels) {
      if (p.video && !p.video.hidden) return p.video;
    }
    return this.panels[0] ? this.panels[0].video : null;
  }

  getImageElement() {
    for (const p of this.panels) {
      if (p.img && !p.img.hidden) return p.img;
    }
    return this.panels[0] ? this.panels[0].img : null;
  }
}

const ASTRA_MEDIA = (() => {
  const channels = {
    live: new MediaChannel('live', 'Live Vision'),
    exp: new MediaChannel('exp', 'Experiment Mode'),
  };

  function getChannel(id) {
    if (!channels[id]) {
      channels[id] = new MediaChannel(id, id);
    }
    return channels[id];
  }

  return {
    getChannel,
    get live() { return channels.live; },
    get exp() { return channels.exp; },

    // Backward-compatible delegating methods defaulting to 'live'
    registerPanel: (panel, ch = 'live') => getChannel(ch).registerPanel(panel),
    startCamera: (deviceId, ch = 'live') => getChannel(ch).startCamera(deviceId),
    loadFile: (file, ch = 'live') => getChannel(ch).loadFile(file),
    stop: (ch = 'live') => getChannel(ch).stop(),
    isActive: (ch = 'live') => getChannel(ch).isActive(),
    getType: (ch = 'live') => getChannel(ch).getType(),
    getState: (ch = 'live') => getChannel(ch).getState(),
    subscribe: (fn, ch = 'live') => getChannel(ch).subscribe(fn),
    updateAllStages: () => {
      channels.live.updateAllStages();
      channels.exp.updateAllStages();
    },
  };
})();

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    ASTRA_MEDIA.updateAllStages();
  });
}
