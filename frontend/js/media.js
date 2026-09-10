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
    } else if (this.currentType === 'video') {
      video.srcObject = null;
      video.src = this.currentUrl;
      video.loop = true;
      video.muted = true;
      video.hidden = false;
      img.hidden = true;
      video.play().catch(() => {});
    } else if (this.currentType === 'image') {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      img.src = this.currentUrl;
      video.hidden = true;
      img.hidden = false;
    } else {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      img.removeAttribute('src');
      video.hidden = true;
      img.hidden = true;
    }
  }

  applyToAllPanels() {
    this.panels.forEach(p => this.applyToPanel(p));
  }

  registerPanel(panel) {
    this.panels.push(panel);
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
  };
})();
