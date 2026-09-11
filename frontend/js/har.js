/* ==========================================================================
   har.js
   Human Activity Recognition — the actual classification logic, separated
   from raw pose detection (real_detection.js) and identity tracking
   (tracking.js). This is a transparent, rule-based baseline built on real
   pose geometry and real multi-frame motion — not a per-frame guess, not a
   timer, not a hardcoded label. It's structured so a trained temporal model
   (LSTM/GRU/Transformer, per backend/ai/README.md) can later replace
   classifyVideoFrame()'s scoring step without touching anything else in
   the pipeline: the feature extraction, history buffering, and smoothing
   stay the same either way.

   Two entry points:
     - classifyVideoFrame(trackId, worldPose, pose2D, nearbyObjects)
       Maintains a rolling per-person temporal window keyed by the stable
       track_id from tracking.js. Supports all 10 activities, including the
       motion-only ones (WALKING/RUNNING/OPENING/CLOSING).
     - classifyStaticImage(worldPose, pose2D, nearbyObjects)
       No history exists for a single uploaded image, so motion-only
       activities cannot honestly be claimed — see TEMPORAL_ONLY below.

   Geometry note: all angle/distance features are computed from MediaPipe's
   WORLD landmarks (real metric 3D coordinates, roughly hip-centered) rather
   than 2D image pixels. A bent knee is a bent knee regardless of how the
   camera is rotated relative to the body — this is what makes the
   classification itself orientation-robust, independent of any assumption
   about which way is "down" in the frame. (The pose *detector* underneath
   is still Earth-trained and has its own limits in truly arbitrary
   orientations — seg backend/ai/README.md's orientation section — but nothing
   in this file assumes gravity or a fixed image-down direction.)
   ========================================================================== */

const ASTRA_HAR = (() => {

  const ACTIVITY_CODES = [
    'STANDING', 'WALKING', 'SITTING', 'RUNNING', 'READING', 'WRITING',
    'USING_LAPTOP', 'USING_PHONE', 'OPENING', 'CLOSING',
  ];
  const TEMPORAL_ONLY = new Set(['WALKING', 'RUNNING', 'OPENING', 'CLOSING']);

  // User-defined AI activity descriptions
  const ACTIVITY_DESCRIPTIONS = {
    STANDING: 'Standing = upright body + extended legs + low movement',
    SITTING: 'Sitting = bent hips + bent knees + supported body',
    WALKING: 'Walking = alternating leg movement + changing body position',
    RUNNING: 'Running = fast hands & legs movement + dynamic alternation',
    READING: 'Reading = bowed head + document inspection',
    WRITING: 'Writing = bowed head + focal hand movement',
    USING_LAPTOP: 'Using laptop = seated posture + hands resting in front',
    USING_PHONE: 'Using phone = hand raised to head + elbow flexed',
    OPENING: 'Opening = reaching forward with displacement',
    CLOSING: 'Closing = reaching with retracting displacement',
  };

  const WINDOW_SIZE = 24;             // rolling history length (frames)
  const MIN_TEMPORAL_FRAMES = 4;      // minimum samples before motion features are trusted
  const SMOOTH_WINDOW = 4;            // majority-vote window for label stability
  const SMOOTH_MAJORITY = 2;          // votes needed out of SMOOTH_WINDOW to switch the displayed label
  const CONFIDENCE_FLOOR = 40;        // below this, report UNCERTAIN instead of guessing
  // Ceiling for activities that are fundamentally person-USES-object actions
  // (reading/writing/laptop/phone) when that object was NOT actually
  // detected. Body pose alone genuinely cannot separate "sitting" from
  // "sitting reading a book", so without object evidence these stay below a
  // confident posture/motion reading rather than overriding it. With the
  // object detected they are uncapped and can legitimately win.
  const OBJECTLESS_CAP = 55;

  /* ------------------------------- 3D vector helpers ------------------------------- */

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
  const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0);
  const mag = (a) => Math.sqrt(dot(a, a));
  const dist3 = (a, b) => mag(sub(a, b));
  const norm = (v) => {
    const m = mag(v);
    return m < 1e-6 ? { x: 0, y: 1, z: 0 } : { x: v.x / m, y: v.y / m, z: (v.z || 0) / m };
  };
  const cross = (a, b) => ({
    x: a.y * (b.z || 0) - (a.z || 0) * b.y,
    y: (a.z || 0) * b.x - a.x * (b.z || 0),
    z: a.x * b.y - a.y * b.x,
  });

  /** Angle at vertex b formed by a-b-c, in degrees. Pure vector geometry — no assumption about "up". */
  function angleAt(a, b, c) {
    if (!a || !b || !c) return null;
    const v1 = sub(a, b), v2 = sub(c, b);
    const m1 = mag(v1), m2 = mag(v2);
    if (m1 < 1e-5 || m2 < 1e-5) return null;
    let cos = dot(v1, v2) / (m1 * m2);
    cos = Math.max(-1, Math.min(1, cos));
    return Math.acos(cos) * 180 / Math.PI;
  }

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  function stddev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(mean(a.map(v => (v - m) ** 2)));
  }
  /** Pearson correlation of two equal-length series; ~-1 = perfectly alternating, the gait signature. */
  function correlation(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    a = a.slice(-n); b = b.slice(-n);
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    if (da === 0 || db === 0) return 0;
    return num / Math.sqrt(da * db);
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const clampScore = (v) => Math.max(0, Math.min(100, v));
  /** Bump function peaked at `center`, 1.0 at the peak, decaying over `width`. */
  const gaussian = (value, center, width) => Math.exp(-((value - center) ** 2) / (2 * width * width));

  /* ------------------------------- Body-Centric Microgravity Frame ------------------------------- */

  /**
   * Constructs an orthonormal Body-Centric Coordinate Basis attached to the astronaut:
   *   - Origin: Mid-hip point (0, 0, 0)
   *   - uY (Longitudinal / Spinal Axis): Mid-Hip -> Mid-Shoulder (cranial, towards head)
   *   - uX (Lateral / Transverse Axis): Left-to-Right shoulder, Gram-Schmidt orthogonalized
   *   - uZ (Anterior / Sagittal Axis): uX x uY (pointing forward out of chest)
   *
   * This guarantees that whether the astronaut is floating at 0 deg, 90 deg, or 180 deg (upside down),
   * all normalized body coordinates and joint relative vectors remain 100% orientation-invariant.
   */
  function buildBodyBasis(w) {
    const hipCenter = mid(w.lHip, w.rHip);
    const shoulderCenter = mid(w.lShoulder, w.rShoulder);
    const vSpine = sub(shoulderCenter, hipCenter);
    const uY = norm(vSpine);

    let vLat = sub(w.rShoulder, w.lShoulder);
    let proj = dot(vLat, uY);
    let vLatOrtho = { x: vLat.x - proj * uY.x, y: vLat.y - proj * uY.y, z: (vLat.z || 0) - proj * uY.z };

    // In side profile, both shoulders may collapse onto each other in 2D/3D.
    // Fall back to pelvis lateral vector (rHip - lHip) if shoulders are degenerate.
    if (mag(vLatOrtho) < 0.06 && w.lHip && w.rHip) {
      const vHipLat = sub(w.rHip, w.lHip);
      const projHip = dot(vHipLat, uY);
      vLatOrtho = { x: vHipLat.x - projHip * uY.x, y: vHipLat.y - projHip * uY.y, z: (vHipLat.z || 0) - projHip * uY.z };
    }

    let uX = norm(vLatOrtho);
    let uZ = norm(cross(uX, uY));
    if (w.nose) {
      const vNose = sub(w.nose, shoulderCenter);
      if (dot(vNose, uZ) < 0) {
        uZ = { x: -uZ.x, y: -uZ.y, z: -uZ.z };
      }
    }
    return { origin: hipCenter, shoulderCenter, uX, uY, uZ, torsoLen: mag(vSpine) };
  }

  function projectToBody(p, basis, scale) {
    const r = sub(p, basis.origin);
    return {
      x: dot(r, basis.uX) / scale,
      y: dot(r, basis.uY) / scale,
      z: dot(r, basis.uZ) / scale,
    };
  }

  /* ------------------------------- per-frame feature extraction ------------------------------- */

  /**
   * worldPose: {jointName: {x,y,z,visibility}} in MediaPipe world (metric,
   * hip-centered) coordinates — see poseFromWorldLandmarks() in
   * real_detection.js for how it's built.
   */
  function extractFeatures(w) {
    const need = ['nose', 'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist',
      'lHip', 'rHip', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle'];
    for (const k of need) if (!w[k]) return null;

    const vis = (j) => (w[j] && typeof w[j].visibility === 'number') ? w[j].visibility : 1;
    const allVis = need.map(vis);
    const meanVis = allVis.reduce((s, v) => s + v, 0) / allVis.length;
    const coreJoints = ['lHip', 'rHip', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle'];
    const coreVis = coreJoints.map(vis).reduce((s, v) => s + v, 0) / coreJoints.length;
    const minVis = Math.min(...allVis);

    const basis = buildBodyBasis(w);
    const bodyScale = Math.max(basis.torsoLen, dist3(w.lShoulder, w.rShoulder), 0.15);

    // Body-centric projected coordinates (normalized to torso scale)
    const bodyAnkleL = projectToBody(w.lAnkle, basis, bodyScale);
    const bodyAnkleR = projectToBody(w.rAnkle, basis, bodyScale);
    const bodyKneeL = projectToBody(w.lKnee, basis, bodyScale);
    const bodyKneeR = projectToBody(w.rKnee, basis, bodyScale);
    const bodyWristL = projectToBody(w.lWrist, basis, bodyScale);
    const bodyWristR = projectToBody(w.rWrist, basis, bodyScale);

    // Stride separation & inter-leg angle at hips (detects open walking stride in side & front views)
    const strideDist = dist3(w.lAnkle, w.rAnkle) / bodyScale;
    const legAngle = angleAt(w.lAnkle, basis.origin, w.rAnkle);
    const isStride = strideDist > 0.40 || (legAngle != null && legAngle > 22);

    // Intrinsic 3D joint angles (pure vector dot products, invariant to space rotation)
    const lKneeAngle = angleAt(w.lHip, w.lKnee, w.lAnkle);
    const rKneeAngle = angleAt(w.rHip, w.rKnee, w.rAnkle);
    const lElbowAngle = angleAt(w.lShoulder, w.lElbow, w.lWrist);
    const rElbowAngle = angleAt(w.rShoulder, w.rElbow, w.rWrist);
    const lHipAngle = angleAt(w.lShoulder, w.lHip, w.lKnee);
    const rHipAngle = angleAt(w.rShoulder, w.rHip, w.rKnee);

    // Torso-to-Femur Collinearity:
    // In extended posture, spine (hip->shoulder) and femur (hip->knee) point in opposing directions (-Y vs +Y).
    // Negated dot product is ~+1.0 when aligned, ~0 when seated/bent.
    const spineUnit = basis.uY;
    const lFemurNorm = norm(sub(w.lKnee, w.lHip));
    const rFemurNorm = norm(sub(w.rKnee, w.rHip));
    const lLegLinearity = -dot(spineUnit, lFemurNorm);
    const rLegLinearity = -dot(spineUnit, rFemurNorm);
    const legLinearity = (lLegLinearity + rLegLinearity) / 2;

    // Rack-Relative Angles (torso orientation relative to camera / payload rack coordinate frame)
    const rackPitchDeg = Math.asin(Math.max(-1, Math.min(1, basis.uY.z))) * 180 / Math.PI;
    const rackRollDeg = Math.atan2(basis.uY.x, basis.uY.y) * 180 / Math.PI;

    // Head tilt relative to the astronaut's own spinal axis
    const headTiltAngle = angleAt(w.nose, basis.shoulderCenter, basis.origin);

    return {
      t: performance.now(),
      minVis, meanVis, coreVis,
      bodyScale,
      hipCenter: basis.origin,
      shoulderCenter: basis.shoulderCenter,
      basis,
      bodyAnkleL, bodyAnkleR,
      bodyKneeL, bodyKneeR,
      bodyWristL, bodyWristR,
      nose: w.nose, lWrist: w.lWrist, rWrist: w.rWrist, lAnkle: w.lAnkle, rAnkle: w.rAnkle,
      strideDist, isStride,
      lKneeAngle, rKneeAngle,
      lElbowAngle, rElbowAngle,
      lHipAngle, rHipAngle,
      legLinearity,
      rackPitchDeg, rackRollDeg,
      headTiltAngle,
      wristToNoseL: dist3(w.lWrist, w.nose) / bodyScale,
      wristToNoseR: dist3(w.rWrist, w.nose) / bodyScale,
      wristToHipL: dist3(w.lWrist, basis.origin) / bodyScale,
      wristToHipR: dist3(w.rWrist, basis.origin) / bodyScale,
    };
  }

  /* ------------------------------- temporal window aggregation ------------------------------- */

  function computeTemporalStats(frames) {
    if (frames.length < 2) return null;
    const first = frames[0], last = frames[frames.length - 1];
    const dtTotal = (last.t - first.t) / 1000;
    if (dtTotal <= 0) return null;

    // Net displacement rate of body center (hips) relative to payload rack
    const hipDisp = dist3(last.hipCenter, first.hipCenter) / last.bodyScale;
    const hipDispRate = hipDisp / dtTotal; // body-scales per second

    const hipVar = (stddev(frames.map(f => f.hipCenter.x)) +
                    stddev(frames.map(f => f.hipCenter.y)) +
                    stddev(frames.map(f => f.hipCenter.z))) / last.bodyScale;

    // Joint velocities & accelerations computed frame-by-frame
    let ankleVelSum = 0, nVel = 0;
    const ankleVelocities = [];
    const vLSeries = [], vRSeries = [];

    let wristVelSum = 0;
    const wristVelocities = [];
    const wLSeries = [], wRSeries = [];

    for (let i = 1; i < frames.length; i++) {
      const dt = (frames[i].t - frames[i - 1].t) / 1000;
      if (dt <= 0) continue;
      const lv = dist3(frames[i].lAnkle, frames[i - 1].lAnkle) / frames[i].bodyScale / dt;
      const rv = dist3(frames[i].rAnkle, frames[i - 1].rAnkle) / frames[i].bodyScale / dt;
      vLSeries.push(lv);
      vRSeries.push(rv);
      const meanV = (lv + rv) / 2;
      ankleVelSum += meanV;
      ankleVelocities.push(meanV);

      const lwv = dist3(frames[i].lWrist, frames[i - 1].lWrist) / frames[i].bodyScale / dt;
      const rwv = dist3(frames[i].rWrist, frames[i - 1].rWrist) / frames[i].bodyScale / dt;
      wLSeries.push(lwv);
      wRSeries.push(rwv);
      const meanWV = (lwv + rwv) / 2;
      wristVelSum += meanWV;
      wristVelocities.push(meanWV);

      nVel++;
    }
    const ankleVel = nVel ? ankleVelSum / nVel : 0;
    const wristVel = nVel ? wristVelSum / nVel : 0;
    const ankleVelAlternation = vLSeries.length >= 3 ? correlation(vLSeries, vRSeries) : 0;
    const wristVelAlternation = wLSeries.length >= 3 ? correlation(wLSeries, wRSeries) : 0;

    // Joint acceleration (rate of change of velocity)
    let ankleAccSum = 0, nAcc = 0;
    for (let i = 1; i < ankleVelocities.length; i++) {
      const dt = (frames[i + 1] ? (frames[i + 1].t - frames[i].t) / 1000 : 0.05);
      if (dt <= 0) continue;
      ankleAccSum += Math.abs(ankleVelocities[i] - ankleVelocities[i - 1]) / dt;
      nAcc++;
    }
    const ankleAcc = nAcc ? ankleAccSum / nAcc : 0;

    let wristAccSum = 0, nWAcc = 0;
    for (let i = 1; i < wristVelocities.length; i++) {
      const dt = (frames[i + 1] ? (frames[i + 1].t - frames[i].t) / 1000 : 0.05);
      if (dt <= 0) continue;
      wristAccSum += Math.abs(wristVelocities[i] - wristVelocities[i - 1]) / dt;
      nWAcc++;
    }
    const wristAcc = nWAcc ? wristAccSum / nWAcc : 0;

    // Combined limb movement speed (hands + legs moving fast)
    const maxLimbVel = Math.max(ankleVel, wristVel);
    const meanLimbVel = (ankleVel + wristVel) / 2;
    const limbSpeed = ankleVel * 0.55 + wristVel * 0.45;

    // Sagittal Gait Alternation along the astronaut's body-centric anterior axis (Z_body)
    const zL = frames.map(f => f.bodyAnkleL.z);
    const zR = frames.map(f => f.bodyAnkleR.z);
    const gaitCorrelation = correlation(zL, zR);

    // Stride displacement vectors across time
    const sVecs = frames.map(f => sub(f.lAnkle, f.rAnkle));
    const sX = sVecs.map(v => v.x / last.bodyScale);
    const sZ = sVecs.map(v => (v.z || 0) / last.bodyScale);
    const stdX = stddev(sX), stdZ = stddev(sZ);

    // Choose the most dynamic stride axis (handles side-view walking along X and front-view along Z)
    let strideSeries = zL.map((zl, idx) => zl - zR[idx]);
    if (stdX > 0.08 && stdX >= stdZ) strideSeries = sX;
    else if (stdZ > 0.08) strideSeries = sZ;

    const gaitAmplitude = stddev(strideSeries) * 2;
    const meanStride = mean(strideSeries);
    let zeroCrossings = 0;
    for (let i = 1; i < strideSeries.length; i++) {
      const prev = strideSeries[i - 1] - meanStride;
      const curr = strideSeries[i] - meanStride;
      if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) {
        zeroCrossings++;
      }
    }
    const cadenceHz = dtTotal > 0.25 ? (zeroCrossings / 2) / dtTotal : 0;
    const effectiveAlternation = Math.min(gaitCorrelation, ankleVelAlternation, wristVelAlternation);

    const lKnees = frames.map(f => f.lKneeAngle).filter(v => v != null);
    const rKnees = frames.map(f => f.rKneeAngle).filter(v => v != null);
    const lKneeStd = stddev(lKnees);
    const rKneeStd = stddev(rKnees);

    const lWristAmp = (stddev(frames.map(f => f.lWrist.x)) + stddev(frames.map(f => f.lWrist.y)) + stddev(frames.map(f => f.lWrist.z))) / last.bodyScale;
    const rWristAmp = (stddev(frames.map(f => f.rWrist.x)) + stddev(frames.map(f => f.rWrist.y)) + stddev(frames.map(f => f.rWrist.z))) / last.bodyScale;

    const wristAwayL = (dist3(last.lWrist, last.hipCenter) - dist3(first.lWrist, first.hipCenter)) / last.bodyScale;
    const wristAwayR = (dist3(last.rWrist, last.hipCenter) - dist3(first.rWrist, first.hipCenter)) / last.bodyScale;

    return {
      dtTotal,
      hipDispRate, hipVar,
      ankleVel, ankleAcc,
      wristVel, wristAcc,
      maxLimbVel, meanLimbVel, limbSpeed,
      gaitCorrelation, effectiveAlternation, gaitAmplitude, cadenceHz,
      lKneeStd, rKneeStd,
      lWristAmp, rWristAmp, wristAwayL, wristAwayR,
      frameCount: frames.length,
    };
  }

  /* ------------------------------- per-activity scoring ------------------------------- */

  function scoreStanding(f, s) {
    if (!f || f.lKneeAngle == null || f.rKneeAngle == null || f.lHipAngle == null || f.rHipAngle == null) return 0;
    const kneeExt = Math.min(f.lKneeAngle, f.rKneeAngle);
    const hipExt = Math.min(f.lHipAngle, f.rHipAngle);
    const linearity = f.legLinearity != null ? f.legLinearity : 0.9;

    // Stable extended posture:
    // Torso, hips, knees, and ankles are extended and aligned.
    // In microgravity this posture is valid regardless of 0°, 90°, or 180° rotation.
    const kneeScore = clamp01((kneeExt - 130) / 40); // 0 at <=130°, 1.0 at >=170°
    const hipScore = clamp01((hipExt - 130) / 40);   // 0 at <=130°, 1.0 at >=170°
    const linScore = clamp01((linearity - 0.70) / 0.25); // 0 at <=0.70, 1.0 at >=0.95

    let score = kneeScore * 35 + hipScore * 25 + linScore * 15;

    // Heavily penalize standing if the legs are spread open in a walking stride!
    if (f.isStride) {
      score -= 35;
    }

    // Temporal stability check: low joint velocity, low body center variance
    if (s) {
      const stability = clamp01(1 - s.hipVar / 0.15) * 15 + clamp01(1 - s.ankleVel / 0.35) * 10;
      // If there's motion or gait alternation, penalize standing!
      const motionPenalty = (s.hipDispRate > 0.30 || s.ankleVel > 0.40 || s.gaitAmplitude > 0.12) ? 45 : 0;
      score += stability - motionPenalty;
    } else {
      score += 25; // default stability credit for static images
    }

    return clampScore(score);
  }

  function scoreSitting(f, s) {
    if (!f || f.lKneeAngle == null || f.rKneeAngle == null || f.lHipAngle == null || f.rHipAngle == null) return 0;
    const kneeBend = (f.lKneeAngle + f.rKneeAngle) / 2;
    const hipBend = (f.lHipAngle + f.rHipAngle) / 2;

    // Seated / folded posture:
    // Both knees and hips are flexed tightly around ~75°-115°.
    // Thighs project anteriorly (+Z) in the astronaut's body-centric frame.
    const kneeScore = gaussian(kneeBend, 92, 24);
    const hipScore = gaussian(hipBend, 92, 26);

    let anteriorThighScore = 0.5;
    if (f.bodyKneeL && f.bodyKneeR) {
      const zThigh = (f.bodyKneeL.z + f.bodyKneeR.z) / 2;
      anteriorThighScore = clamp01(zThigh / 0.40); // positive anterior extension
    }

    let score = kneeScore * 35 + hipScore * 35 + anteriorThighScore * 10;

    if (s) {
      const stability = clamp01(1 - s.hipVar / 0.12) * 12 + clamp01(1 - s.ankleVel / 0.25) * 8;
      score += stability;
    } else {
      score += 20;
    }

    return clampScore(score);
  }

  function scoreWalking(f, s) {
    // Strictly multi-frame temporal requirement (never single image)
    if (!s || s.frameCount < MIN_TEMPORAL_FRAMES) return 0;

    // Alternating leg movement along body anterior axis or stride vector
    const altScore = clamp01(-s.effectiveAlternation) * 25;

    // Amplitude of alternating leg swing
    const ampScore = clamp01(s.gaitAmplitude / 0.15) * 20;

    // Walking cadence: low-frequency periodic movement (peaked around 1.05 - 1.35 Hz)
    let cadenceScore = 0;
    if (s.cadenceHz > 0) {
      cadenceScore = gaussian(s.cadenceHz, 1.20, 0.40) * 25;
    } else if (s.ankleVel > 0.35) {
      cadenceScore = gaussian(s.ankleVel, 1.05, 0.45) * 20;
    }

    // Moderate joint velocity (walking speed: peaked around 1.05, sharp drop-off above 1.5)
    const velScore = gaussian(s.ankleVel, 1.05, 0.40) * 15;

    // Body translation relative to payload rack (person moving across space)
    const dispScore = clamp01(s.hipDispRate / 0.25) * 15;

    // Stride bonus: open stride detected in pose
    const strideBonus = (f && f.isStride) ? 15 : 0;

    const total = altScore + ampScore + cadenceScore + velScore + dispScore + strideBonus;

    // Running suppression: if hands and legs are moving fast, this is RUNNING, not walking!
    // User definition: "running meanings when the hands and legs moving fast"
    // Treadmill / stationary runners have low hip displacement, so we base fast movement on limbSpeed.
    const limbSpeed = s.limbSpeed != null ? s.limbSpeed : (s.ankleVel * 0.55 + (s.wristVel || 0) * 0.45);
    const isFastRunning = (limbSpeed > 1.35 && (s.wristVel || 0) >= 1.0) ||
                          (s.cadenceHz >= 1.70 && s.ankleVel >= 1.80) ||
                          (limbSpeed > 2.0 && s.ankleVel > 2.5);

    if (isFastRunning) {
      const runExcess = Math.max(
        (limbSpeed - 1.25) / 0.70,
        (s.ankleVel - 1.50) / 0.70,
        (s.cadenceHz - 1.60) / 0.50
      );
      const suppression = Math.max(0.10, 1.0 - clamp01(runExcess) * 0.85);
      return Math.round(total * suppression);
    }

    return clampScore(total);
  }

  function scoreRunning(f, s) {
    // Strictly multi-frame temporal requirement (never single image)
    if (!s || s.frameCount < MIN_TEMPORAL_FRAMES) return 0;

    // Running = hands and legs moving fast with dynamic alternating locomotion
    const limbSpeed = s.limbSpeed != null ? s.limbSpeed : (s.ankleVel * 0.55 + (s.wristVel || 0) * 0.45);
    const maxLimbVel = s.maxLimbVel != null ? s.maxLimbVel : Math.max(s.ankleVel, s.wristVel || 0);

    // 1. Fast limb speed: Primary driver of running vs walking (ankles and wrists moving fast)
    // In walking, limbSpeed is ~0.6 - 1.25.
    // In running, limbSpeed is > 1.35, typically 1.6 - 3.5+.
    const velScore = clamp01((limbSpeed - 1.20) / 1.0) * 30;
    const peakLimbScore = clamp01((maxLimbVel - 1.40) / 1.0) * 15;

    // 2. Alternating limb movement (using effectiveAlternation across all axes and limb velocities)
    const alt = s.effectiveAlternation != null ? s.effectiveAlternation : s.gaitCorrelation;
    const alternationScore = clamp01(-alt) * 15;

    // 3. Amplitude of leg swing / stride
    const amplitudeScore = clamp01(s.gaitAmplitude / 0.18) * 10;

    // 4. Cadence & dynamic frequency
    // Running cadence is usually >= 1.5 Hz. But if zero crossings are sparse or phase-jittered,
    // limb speed and acceleration compensate smoothly.
    let cadenceScore = 0;
    if (s.cadenceHz >= 1.45) {
      cadenceScore = clamp01((s.cadenceHz - 1.40) / 0.65) * 15;
    } else if (s.ankleVel > 1.55 || limbSpeed > 1.50) {
      cadenceScore = clamp01((Math.max(s.ankleVel, limbSpeed) - 1.45) / 0.85) * 12;
    }

    // 5. Dynamic knee range of motion (running involves deep back-kick and rapid knee flexion/extension)
    const maxKneeStd = Math.max(s.lKneeStd || 0, s.rKneeStd || 0);
    const kneeScore = clamp01((maxKneeStd - 10) / 14) * 10;

    // 6. Joint acceleration (rapid velocity changes)
    const maxAcc = Math.max(s.ankleAcc || 0, s.wristAcc || 0);
    const accScore = clamp01((maxAcc - 1.0) / 1.8) * 10;

    // 7. Stride bonus
    const strideBonus = (f && f.isStride) ? 5 : 0;

    const score = velScore + peakLimbScore + alternationScore + amplitudeScore + cadenceScore + kneeScore + accScore + strideBonus;

    // Suppress running if limbs are moving at walking speeds or hands are not moving fast at walking cadence
    // User definition: "running meanings when the hands and legs moving fast"
    if (limbSpeed < 1.25) {
      return Math.min(10, Math.round(score * 0.15));
    }
    if ((s.wristVel || 0) < 1.0 && s.cadenceHz < 1.65) {
      return Math.min(12, Math.round(score * 0.15));
    }

    return clampScore(score);
  }

  function scoreReading(f, s, objs) {
    if (f.headTiltAngle == null) return 0;
    const handsLow = f.wristToNoseL > 0.9 && f.wristToNoseR > 0.9; // not raised to head (rules out phone)
    // Reading needs a genuinely BOWED head, not merely a head that isn't
    // perfectly in line with the spine — a normal upright stance measures
    // ~140-170deg here, so anything in that band must score near zero or
    // every standing person reads. Full credit only well under ~150deg.
    let score = clamp01((150 - f.headTiltAngle) / 40) * 40;
    score += s ? clamp01(1 - s.hipVar / 0.10) * 20 : 15;
    score += handsLow ? 15 : 0;
    if (objs.has('BOOK')) return clampScore(score + 25);
    // No book detected: a bowed head alone is real evidence but weak — cap it
    // so it can never outrank a confident posture/motion reading.
    return Math.min(OBJECTLESS_CAP, clampScore(score));
  }

  function scoreWriting(f, s, objs) {
    if (f.headTiltAngle == null || !s) return 0;
    const lMoving = s.lWristAmp > 0.03 && s.lWristAmp < 0.35;
    const rMoving = s.rWristAmp > 0.03 && s.rWristAmp < 0.35;
    const oneHandWriting = (lMoving && s.rWristAmp <= 0.03) || (rMoving && s.lWristAmp <= 0.03);
    const elbowBent = (f.lElbowAngle != null && f.lElbowAngle < 150) || (f.rElbowAngle != null && f.rElbowAngle < 150);
    const wristLow = f.wristToNoseL > 0.7 && f.wristToNoseR > 0.7;
    let score = clamp01((150 - f.headTiltAngle) / 45) * 25;
    score += oneHandWriting ? 30 : 0;
    score += elbowBent ? 15 : 0;
    score += wristLow ? 10 : 0;
    score += clamp01(1 - s.hipVar / 0.10) * 10;
    if (objs.has('BOOK')) return clampScore(score + 10);
    return Math.min(OBJECTLESS_CAP, clampScore(score));
  }

  function scoreUsingLaptop(f, s, objs) {
    if (f.lHipAngle == null || f.rHipAngle == null || !s) return 0;
    const sittingLike = gaussian(Math.min(f.lHipAngle, f.rHipAngle), 95, 45);
    const wristsInFront = f.wristToHipL < 1.4 && f.wristToHipR < 1.4;
    const bothLowMotion = s.lWristAmp < 0.30 && s.rWristAmp < 0.30;
    let score = sittingLike * 25 + (wristsInFront ? 25 : 0) + (bothLowMotion ? 20 : 0);
    score += clamp01(1 - s.hipVar / 0.10) * 10;
    // "Sitting still with hands in your lap" is pose-identical to "typing on a
    // laptop" — pose alone genuinely cannot separate them, so without an
    // actual detected laptop this stays capped below what a clean SITTING
    // reading scores. Only a real object detection earns the full claim.
    if (objs.has('LAPTOP')) return clampScore(score + 25);
    // Stricter than OBJECTLESS_CAP: unlike reading (bowed head) or phone
    // (hand at face), "typing on a laptop" has NO pose signature at all that
    // distinguishes it from simply sitting still. Never claim it unseen.
    return Math.min(CONFIDENCE_FLOOR - 1, clampScore(score));
  }

  function scoreUsingPhone(f, s, objs) {
    const lRaised = f.wristToNoseL < 0.9 && f.lElbowAngle != null && f.lElbowAngle < 110;
    const rRaised = f.wristToNoseR < 0.9 && f.rElbowAngle != null && f.rElbowAngle < 110;
    if (!lRaised && !rRaised) return 0;
    let score = 45;
    score += s ? clamp01(1 - s.hipVar / 0.12) * 20 : 15;
    if (objs.has('CELL_PHONE')) return clampScore(score + 30);
    // A hand raised to the face is genuinely phone-like, but is equally
    // scratching your head / holding a mug / shielding your eyes — capped
    // until an actual phone is detected.
    return Math.min(OBJECTLESS_CAP, clampScore(score + 10));
  }

  /** OPENING/CLOSING — the weakest of the ten: Pose landmarks carry no finger/hand
      articulation and the object detector has no door/drawer/cabinet class, so this
      can only reason about hand-to-object approach + net displacement direction.
      Deliberately confidence-capped below — treat as a directional hint, not a
      confident classification, until real hand + object-state data exists. */
  function scoreOpenClose(f, s, objs) {
    if (!s || objs.size === 0) return { open: 0, close: 0 };
    const handNearObject = f.wristToHipL < 1.6 || f.wristToHipR < 1.6;
    if (!handNearObject) return { open: 0, close: 0 };
    const netAway = Math.max(s.wristAwayL, s.wristAwayR);
    const base = clamp01((s.lWristAmp + s.rWristAmp) / 0.5) * 30 + 15; // some hand motion near an object at all
    const openScore = base + clamp01(netAway / 0.6) * 20;
    const closeScore = base + clamp01(-netAway / 0.6) * 20;
    return { open: Math.min(62, clampScore(openScore)), close: Math.min(62, clampScore(closeScore)) };
  }

  /* ------------------------------- per-person state ------------------------------- */

  class PersonHistory {
    constructor() {
      this.frames = [];
      this.rawVotes = [];
      this.displayed = null;   // {activity, confidence}
      this.previous = null;
      this.since = Date.now();
    }

    pushFrame(features) {
      this.frames.push(features);
      if (this.frames.length > WINDOW_SIZE) this.frames.shift();
    }

    /** Majority-vote smoothing: only switch the displayed label once a new
        candidate has actually been the top pick for most of the recent window. */
    smooth(candidate) {
      this.rawVotes.push(candidate);
      if (this.rawVotes.length > SMOOTH_WINDOW) this.rawVotes.shift();

      const counts = {};
      this.rawVotes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      let winner = candidate, winnerCount = 0;
      Object.entries(counts).forEach(([code, n]) => { if (n > winnerCount) { winner = code; winnerCount = n; } });

      if (!this.displayed) return winner;
      if (winner !== this.displayed.activity && winnerCount >= SMOOTH_MAJORITY) return winner;
      return this.displayed.activity;
    }

    commit(activity, confidence, reason, bodyTelemetry) {
      if (this.displayed && this.displayed.activity !== activity) {
        this.previous = this.displayed.activity;
        this.since = Date.now();
      } else if (!this.displayed) {
        this.since = Date.now();
      }
      this.displayed = {
        activity,
        confidence,
        reason: reason || null,
        bodyTelemetry: bodyTelemetry || (this.displayed ? this.displayed.bodyTelemetry : null),
      };
      return {
        activity: this.displayed.activity,
        confidence: this.displayed.confidence,
        reason: this.displayed.reason,
        previous: this.previous,
        transition: this.previous ? `${this.previous} -> ${this.displayed.activity}` : null,
        sinceMs: this.since,
        bodyTelemetry: this.displayed.bodyTelemetry,
      };
    }
  }

  const people = new Map(); // trackId -> PersonHistory

  function getHistory(trackId) {
    let h = people.get(trackId);
    if (!h) { h = new PersonHistory(); people.set(trackId, h); }
    return h;
  }

  /* ------------------------------- classification core ------------------------------- */

  function rank(f, s, objs, allowTemporal) {
    const candidates = [
      ['STANDING', scoreStanding(f, s)],
      ['SITTING', scoreSitting(f, s)],
      ['READING', scoreReading(f, s, objs)],
      ['WRITING', scoreWriting(f, s, objs)],
      ['USING_LAPTOP', scoreUsingLaptop(f, s, objs)],
      ['USING_PHONE', scoreUsingPhone(f, s, objs)],
    ];
    if (allowTemporal) {
      candidates.push(['WALKING', scoreWalking(f, s)]);
      candidates.push(['RUNNING', scoreRunning(f, s)]);
      const oc = scoreOpenClose(f, s, objs);
      candidates.push(['OPENING', oc.open]);
      candidates.push(['CLOSING', oc.close]);
    }
    candidates.sort((a, b) => b[1] - a[1]);
    return candidates;
  }

  function decide(f, s, objs, allowTemporal) {
    if (!f) return { activity: 'UNCERTAIN', confidence: 0, reason: 'Insufficient pose information' };
    if (f.coreVis < 0.20 || f.meanVis < 0.20) {
      return { activity: 'UNCERTAIN', confidence: Math.round(f.coreVis * 100), reason: 'Insufficient pose information' };
    }

    const ranked = rank(f, s, objs, allowTemporal);
    const [topCode, topScore] = ranked[0];

    if (topScore < CONFIDENCE_FLOOR) {
      const legAsymmetry = (f.lKneeAngle != null && f.rKneeAngle != null) ? Math.abs(f.lKneeAngle - f.rKneeAngle) : 0;
      const reason = (!allowTemporal && (legAsymmetry > 35 || f.isStride))
        ? 'Possible mid-motion posture — temporal video required for Walking/Running/Opening/Closing'
        : 'Insufficient pose information';
      return { activity: 'UNCERTAIN', confidence: Math.round(topScore), reason };
    }
    return { activity: topCode, confidence: Math.round(topScore), reason: ACTIVITY_DESCRIPTIONS[topCode] || null };
  }

  /* ------------------------------- public API ------------------------------- */

  function classifyVideoFrame(trackId, worldPose, nearbyObjects) {
    const history = getHistory(trackId);
    const f = worldPose ? extractFeatures(worldPose) : null;
    if (f) history.pushFrame(f);
    const s = computeTemporalStats(history.frames);
    const objs = new Set(nearbyObjects || []);

    const raw = decide(f, s, objs, true);
    const smoothed = raw.activity === 'UNCERTAIN' ? raw.activity : history.smooth(raw.activity);
    const finalActivity = smoothed;
    const finalConfidence = finalActivity === raw.activity ? raw.confidence : (history.displayed ? history.displayed.confidence : raw.confidence);

    const bodyTelemetry = f ? {
      rackPitchDeg: Math.round(f.rackPitchDeg),
      rackRollDeg: Math.round(f.rackRollDeg),
      kneeExtDeg: Math.round((f.lKneeAngle + f.rKneeAngle) / 2),
      hipExtDeg: Math.round((f.lHipAngle + f.rHipAngle) / 2),
      cadenceHz: s ? Number(s.cadenceHz.toFixed(1)) : 0,
      ankleVel: s ? Number(s.ankleVel.toFixed(2)) : 0,
      wristVel: s ? Number(s.wristVel.toFixed(2)) : 0,
      limbSpeed: s ? Number(s.limbSpeed.toFixed(2)) : 0,
      gaitCorr: s ? Number(s.gaitCorrelation.toFixed(2)) : 0,
      gravityDependent: false,
      frameType: 'BODY-CENTRIC (3D)',
    } : null;

    const reason = raw.activity === 'UNCERTAIN' ? raw.reason : (ACTIVITY_DESCRIPTIONS[finalActivity] || raw.reason);
    return history.commit(finalActivity, finalConfidence, reason, bodyTelemetry);
  }

  /** No per-image history exists, so motion-only activities are never offered — see TEMPORAL_ONLY. */
  function classifyStaticImage(worldPose, nearbyObjects) {
    const f = worldPose ? extractFeatures(worldPose) : null;
    const objs = new Set(nearbyObjects || []);
    const result = decide(f, null, objs, false);
    const bodyTelemetry = f ? {
      rackPitchDeg: Math.round(f.rackPitchDeg),
      rackRollDeg: Math.round(f.rackRollDeg),
      kneeExtDeg: Math.round((f.lKneeAngle + f.rKneeAngle) / 2),
      hipExtDeg: Math.round((f.lHipAngle + f.rHipAngle) / 2),
      cadenceHz: 0,
      ankleVel: 0,
      gaitCorr: 0,
      gravityDependent: false,
      frameType: 'BODY-CENTRIC (3D)',
    } : null;
    return {
      activity: result.activity,
      confidence: result.confidence,
      reason: result.activity === 'UNCERTAIN' ? result.reason : (ACTIVITY_DESCRIPTIONS[result.activity] || null),
      previous: null,
      transition: null,
      sinceMs: Date.now(),
      bodyTelemetry,
    };
  }

  function resetPerson(trackId) { people.delete(trackId); }
  function resetAll() { people.clear(); }

  return {
    ACTIVITY_CODES, ACTIVITY_DESCRIPTIONS, TEMPORAL_ONLY,
    classifyVideoFrame, classifyStaticImage,
    resetPerson, resetAll,
  };
})();
