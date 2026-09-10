/* ==========================================================================
   camera.js
   Low-level webcam access only: device enumeration and getUserMedia(),
   returning a raw MediaStream. It knows nothing about the DOM beyond that —
   media.js is what attaches the stream to the actual <video> elements
   across the app's vision panels.
   ========================================================================== */

const ASTRA_CAMERA = (() => {

  const channelStreams = new Map(); // channelId -> { stream, deviceId }
  let cachedDevices = [];

  function stopStreamForChannel(channelId = 'live') {
    const entry = channelStreams.get(channelId);
    if (entry && entry.stream) {
      entry.stream.getTracks().forEach(t => t.stop());
      channelStreams.delete(channelId);
    }
  }

  function stopActiveStream() {
    channelStreams.forEach(entry => {
      if (entry && entry.stream) {
        entry.stream.getTracks().forEach(t => t.stop());
      }
    });
    channelStreams.clear();
  }

  async function listVideoDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cachedDevices = devices.filter(d => d.kind === 'videoinput');
      return cachedDevices;
    } catch (e) {
      return [];
    }
  }

  function getCachedDevices() {
    return cachedDevices;
  }

  async function startLiveCamera(deviceId, channelId = 'live') {
    stopStreamForChannel(channelId);
    try {
      const videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
      if (deviceId) videoConstraints.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      channelStreams.set(channelId, { stream, deviceId: deviceId || null });
      listVideoDevices(); // labels are only populated once permission has been granted
      const track = stream.getVideoTracks()[0];
      return { ok: true, stream, deviceLabel: track ? track.label : '' };
    } catch (err) {
      return { ok: false, error: err.message || 'Camera permission denied' };
    }
  }

  function isLive(channelId = 'live') {
    return channelStreams.has(channelId);
  }

  function getLiveTelemetry(channelId = 'live') {
    const entry = channelStreams.get(channelId);
    if (!entry || !entry.stream) return null;
    const track = entry.stream.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings ? track.getSettings() : {};
    return {
      width: settings.width || 0,
      height: settings.height || 0,
      frameRate: settings.frameRate ? Math.round(settings.frameRate) : null,
      deviceLabel: track.label || 'Camera',
      deviceId: entry.deviceId,
    };
  }

  function isCameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  return {
    startLiveCamera,
    stopStreamForChannel,
    stopActiveStream,
    isCameraSupported,
    listVideoDevices,
    getCachedDevices,
    isLive,
    getLiveTelemetry,
  };
})();
