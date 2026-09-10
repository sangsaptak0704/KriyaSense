/* ==========================================================================
   experiment.js
   Owns the experiment sequence, the client-side Finite State Machine (FSM)
   simulation, sequence validation, violation handling, event logging and
   voice guidance. In the real system this logic is mirrored server-side
   in backend/experiment/fsm.py + validator.py — the frontend only ever
   *displays* what the backend FSM decides. Today it simulates that
   decision locally so the UI is fully demoable with zero backend.
   ========================================================================== */

const ASTRA_EXPERIMENT = (() => {

  const ACTIVITY_MASTER_LIST = [
    // The Experiment Builder's step picker — kept to exactly the same 10
    // codes the real Human Activity Recognition system (har.js) can
    // classify, so a custom experiment's expected steps line up with what
    // General Activity Mode can actually detect. The BAS chemical-handling
    // codes (PICK_UP/OPEN_CAP/DRAW_LIQUID/POUR_LIQUID/MIX/PLACE_BACK) are
    // intentionally not offered here — those are experiment/object-
    // interaction actions, not general human activity recognition; the
    // default BAS demo sequence below still uses them directly.
    { code: 'STANDING', label: 'Standing' },
    { code: 'WALKING', label: 'Walking' },
    { code: 'SITTING', label: 'Sitting' },
    { code: 'RUNNING', label: 'Running' },
    { code: 'READING', label: 'Reading' },
    { code: 'WRITING', label: 'Writing' },
    { code: 'USING_LAPTOP', label: 'Use Laptop' },
    { code: 'USING_PHONE', label: 'Use Phone' },
    { code: 'OPENING', label: 'Open' },
    { code: 'CLOSING', label: 'Close' },
  ];

  const GUIDANCE_TEXT = {
    PICK_UP: 'Pick up the chemical/dropper bottle from the payload rack.',
    OPEN_CAP: 'Open the bottle cap carefully.',
    DRAW_LIQUID: 'Use the syringe or pipette to draw liquid from the bottle.',
    POUR_LIQUID: 'Transfer the liquid drop-by-drop into the test tube.',
    MIX: 'Gently mix or stir the test tube contents.',
    PLACE_BACK: 'Place the equipment back in its original position on the rack.',
    STANDING: 'Stand upright and remain stationary until posture is confirmed.',
    WALKING: 'Walk steadily across the experiment area toward the workstation.',
    SITTING: 'Lower yourself into the seated position at the workstation.',
    RUNNING: 'Move at a brisk, controlled pace across the module.',
    PICK_OBJECT: 'Reach toward the target object and pick it up.',
    PUT_OBJECT_DOWN: 'Place the object back down carefully on the surface.',
    READING: 'Pick up the reference material and read the procedure.',
    WRITING: 'Use the writing surface to record observations.',
    USING_LAPTOP: 'Open the laptop and interact with the onboard console.',
    USING_PHONE: 'Pick up the communication device and hold it to operate.',
    OPENING: 'Open the designated payload compartment.',
    CLOSING: 'Close the designated payload compartment securely.',
    REACH: 'Extend your arm toward the target object.',
    CARRY: 'Carry the object to the designated location.',
    LIE_DOWN: 'Move into the horizontal restrained position.',
  };

  const DEFAULT_SEQUENCE = ['PICK_UP', 'OPEN_CAP', 'DRAW_LIQUID', 'POUR_LIQUID', 'MIX', 'PLACE_BACK']
    .map(code => ({ code, label: labelFor(code) }));

  function labelFor(code) {
    const found = ACTIVITY_MASTER_LIST.find(a => a.code === code);
    return found ? found.label.toUpperCase() : code.replace(/_/g, ' ');
  }

  const state = {
    experimentName: 'BAS Chemical Handling Protocol',
    sequence: DEFAULT_SEQUENCE.slice(),
    currentIndex: 0,
    status: 'VALID',
    lastViolation: null,
    eventLog: [],
    timeline: [],
    voiceEnabled: true,
    completed: false,
  };

  const subscribers = [];
  function subscribe(fn) { subscribers.push(fn); }
  function notify() { subscribers.forEach(fn => fn(getStatus())); }

  function nowTime() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  function pushEvent(type, activity, confidence, expected, status) {
    state.eventLog.unshift({
      time: nowTime(), type, activity, confidence: `${confidence.toFixed(1)}%`, expected, status,
    });
    if (state.eventLog.length > 200) state.eventLog.pop();
  }

  function pushTimeline(text, cls) {
    state.timeline.unshift({ time: nowTime(), text, cls });
    if (state.timeline.length > 100) state.timeline.pop();
  }

  function playAlertBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {}
  }

  function speak(text) {
    if (!state.voiceEnabled) return;
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.0;
      utter.lang = 'en-US';
      window.speechSynthesis.speak(utter);
    } catch (e) { /* speech synthesis unavailable — non-fatal for the demo */ }
  }

  let liveTracking = {
    candidateActivity: null,
    candidateCount: 0,
    lastSatisfiedIndex: -1,
    currentHeldActivity: null,
    violationReportedFor: null,
    gracePeriodUntil: 0,
    latestConfidence: null,
  };

  function resetLiveTracking() {
    liveTracking = {
      candidateActivity: null,
      candidateCount: 0,
      lastSatisfiedIndex: -1,
      currentHeldActivity: null,
      violationReportedFor: null,
      gracePeriodUntil: Date.now() + 2500,
      latestConfidence: null,
    };
  }

  function jitter(base, spread) {
    return Math.max(80, Math.min(99.9, base + (Math.random() * spread * 2 - spread)));
  }

  /* ------------------------------------------------------------------ */

  function getStatus() {
    const expectedStep = state.sequence[state.currentIndex] || null;
    return {
      experimentName: state.experimentName,
      sequence: state.sequence,
      currentIndex: state.currentIndex,
      lastSatisfiedIndex: liveTracking.lastSatisfiedIndex,
      currentStepNumber: Math.min(state.currentIndex + 1, state.sequence.length),
      totalSteps: state.sequence.length,
      expected: expectedStep ? expectedStep.label : '—',
      expectedCode: expectedStep ? expectedStep.code : null,
      status: state.status,
      lastViolation: state.lastViolation,
      completed: state.completed,
      voiceEnabled: state.voiceEnabled,
      currentDetectedActivity: liveTracking.candidateActivity ? labelFor(liveTracking.candidateActivity) : null,
      currentConfidence: liveTracking.latestConfidence,
    };
  }

  function getEventLog() { return state.eventLog; }
  function getTimeline() { return state.timeline; }
  function getActivityMasterList() { return ACTIVITY_MASTER_LIST; }

  function getGuidance() {
    const expectedStep = state.sequence[state.currentIndex];
    if (!expectedStep || state.completed) {
      return { action: 'SEQUENCE COMPLETE', instruction: 'All experiment steps validated successfully. No further action required.' };
    }
    return {
      action: expectedStep.label,
      instruction: GUIDANCE_TEXT[expectedStep.code] || 'Proceed with the next protocol step.',
    };
  }

  function triggerActivity(code) {
    if (state.completed) return getStatus();
    const expectedStep = state.sequence[state.currentIndex];
    const confidence = jitter(95, 3);
    const label = labelFor(code);

    if (!expectedStep) return getStatus();

    if (code === expectedStep.code) {
      state.status = 'VALID';
      state.lastViolation = null;
      pushEvent('Activity', expectedStep.label, confidence, expectedStep.label, 'SUCCESS');
      pushTimeline(`✓ ${expectedStep.label}`, 'success');
      state.currentIndex += 1;
      if (state.currentIndex >= state.sequence.length) {
        state.completed = true;
        pushTimeline('✓ EXPERIMENT COMPLETE', 'success');
      }
    } else {
      state.status = 'INVALID';
      state.lastViolation = {
        expected: expectedStep.label,
        detected: label,
        step: state.currentIndex + 1,
        severity: 'HIGH',
      };
      pushEvent('Validation', label, confidence, expectedStep.label, 'VIOLATION');
      pushTimeline(`⚠ SEQUENCE VIOLATION`, 'violation');
      speak(`Warning. Sequence violation detected. Expected ${expectedStep.label} but ${label} was detected.`);
    }
    notify();
    return getStatus();
  }

  function simulateViolation() {
    if (state.completed) return getStatus();
    const expectedStep = state.sequence[state.currentIndex];
    if (!expectedStep) return getStatus();
    // Prefer a realistic "skipped a step" violation (performing the step
    // after next instead of the expected one); fall back to any other
    // known activity if the sequence is too short for that.
    const skipAhead = state.sequence[state.currentIndex + 2];
    const fallback = ACTIVITY_MASTER_LIST.find(a => a.code !== expectedStep.code);
    const wrong = skipAhead ? skipAhead.code : (fallback ? fallback.code : null);
    if (!wrong) return getStatus();
    return triggerActivity(wrong);
  }

  function processLiveDetection(person) {
    if (state.completed) return;
    if (!person || !person.activity || person.activity === 'UNCERTAIN') {
      liveTracking.candidateCount = 0;
      return;
    }
    const conf = typeof person.confidence === 'number' ? person.confidence : 80;
    if (conf < 40) return;

    liveTracking.latestConfidence = conf;
    const rawCode = person.activity;
    const now = Date.now();

    // Stability debounce: 2 consecutive frames (~300ms) for snappy auto-shifting
    if (liveTracking.candidateActivity === rawCode) {
      liveTracking.candidateCount += 1;
    } else {
      liveTracking.candidateActivity = rawCode;
      liveTracking.candidateCount = 1;
    }

    if (liveTracking.candidateCount < 2) return;

    const stableCode = liveTracking.candidateActivity;
    const currentStep = state.sequence[state.currentIndex];
    if (!currentStep) return;

    // --- PHASE 1: Step 0 awaiting initial start ---
    if (liveTracking.lastSatisfiedIndex === -1 && state.currentIndex === 0) {
      if (stableCode === currentStep.code) {
        // Initial required posture detected!
        liveTracking.lastSatisfiedIndex = 0;
        liveTracking.currentHeldActivity = stableCode;
        liveTracking.violationReportedFor = null;
        state.status = 'VALID';
        state.lastViolation = null;

        pushEvent('Activity', currentStep.label, conf, currentStep.label, 'ACTIVE');
        pushTimeline(`● Step 1: ${currentStep.label} started`, 'success');
        speak(`${currentStep.label} detected. Step 1 active.`);
        notify();
        return;
      }

      // Initial grace period so user can settle into first position
      if (!liveTracking.gracePeriodUntil) {
        liveTracking.gracePeriodUntil = now + 2500;
      }
      if (now < liveTracking.gracePeriodUntil) {
        return;
      }

      // Out of order before starting step 1
      if (state.status !== 'INVALID' || liveTracking.violationReportedFor !== stableCode) {
        const detectedLabel = labelFor(stableCode);
        state.status = 'INVALID';
        state.lastViolation = {
          expected: currentStep.label,
          detected: detectedLabel,
          step: 1,
          severity: 'HIGH',
        };
        liveTracking.violationReportedFor = stableCode;
        playAlertBeep();
        speak(`Warning. Expected ${currentStep.label} at Step 1, but ${detectedLabel} was detected.`);
        pushEvent('Validation', detectedLabel, conf, currentStep.label, 'VIOLATION');
        pushTimeline(`⚠ VIOLATION on Step 1: Expected ${currentStep.label}, got ${detectedLabel}`, 'violation');
        notify();
      }
      return;
    }

    // --- PHASE 2: Human is maintaining posture of current active step ---
    if (stableCode === liveTracking.currentHeldActivity) {
      return;
    }

    // --- PHASE 3: Human has CHANGED movement! ---
    const nextIndex = state.currentIndex + 1;

    if (nextIndex < state.sequence.length) {
      const nextStep = state.sequence[nextIndex];
      if (stableCode === nextStep.code) {
        // MATCH! Automatically shift from previous step to next step
        const prevStep = state.sequence[state.currentIndex];
        pushEvent('Activity', prevStep.label, conf, prevStep.label, 'DONE');
        pushTimeline(`✓ Step ${state.currentIndex + 1}: ${prevStep.label} completed`, 'success');

        state.currentIndex = nextIndex;
        liveTracking.lastSatisfiedIndex = nextIndex;
        liveTracking.currentHeldActivity = stableCode;
        liveTracking.violationReportedFor = null;
        state.status = 'VALID';
        state.lastViolation = null;

        speak(`${prevStep.label} complete. Shifted to Step ${nextIndex + 1}: ${nextStep.label}.`);

        // If this is the final step in the sequence:
        if (nextIndex === state.sequence.length - 1) {
          pushTimeline(`● Final Step: ${nextStep.label} active`, 'success');
        }
        notify();
        return;
      } else {
        // Human changed to an unexpected movement -> Sequence violation on next step!
        if (state.status !== 'INVALID' || liveTracking.violationReportedFor !== stableCode) {
          const detectedLabel = labelFor(stableCode);
          state.status = 'INVALID';
          state.lastViolation = {
            expected: nextStep.label,
            detected: detectedLabel,
            step: nextIndex + 1,
            severity: 'HIGH',
          };
          liveTracking.violationReportedFor = stableCode;
          playAlertBeep();
          speak(`Warning. Sequence violation detected. Expected ${nextStep.label} at Step ${nextIndex + 1}, but ${detectedLabel} was detected.`);
          pushEvent('Validation', detectedLabel, conf, nextStep.label, 'VIOLATION');
          pushTimeline(`⚠ VIOLATION on Step ${nextIndex + 1}: Expected ${nextStep.label}, got ${detectedLabel}`, 'violation');
          notify();
        }
        return;
      }
    } else {
      // Sequence was already on last step and human moved away -> Finish!
      state.completed = true;
      state.status = 'VALID';
      state.lastViolation = null;
      pushTimeline('✓ ALL STEPS VALIDATED', 'success');
      speak('Experiment complete! All sequence steps validated successfully.');
      notify();
      return;
    }
  }

  function reset() {
    state.currentIndex = 0;
    state.status = 'VALID';
    state.lastViolation = null;
    state.completed = false;
    resetLiveTracking();
    pushTimeline('↺ EXPERIMENT RESET', 'success');
    pushEvent('System', '—', 100, '—', 'RESET');
    notify();
    return getStatus();
  }

  function setSequence(name, codes) {
    state.experimentName = name || 'Custom Experiment';
    state.sequence = codes.map(code => ({ code, label: labelFor(code) }));
    state.currentIndex = 0;
    state.status = 'VALID';
    state.lastViolation = null;
    state.completed = false;
    resetLiveTracking();
    pushTimeline(`⚙ EXPERIMENT LOADED: ${state.experimentName}`, 'success');
    pushEvent('System', '—', 100, '—', 'LOADED');
    notify();
    return getStatus();
  }

  function setVoiceEnabled(v) { state.voiceEnabled = v; }

  function repeatGuidance() {
    const g = getGuidance();
    speak(`Next expected action: ${g.action}. ${g.instruction}`);
  }

  function exportEventLogTxt() {
    const lines = [
      'KRIYA-SENSE EXPERIMENT EVENT LOG',
      `Experiment: ${state.experimentName}`,
      `Exported: ${new Date().toString()}`,
      '='.repeat(70),
      'TIME       | TYPE        | ACTIVITY          | CONF   | EXPECTED          | STATUS',
      '-'.repeat(70),
      ...state.eventLog.map(e =>
        `${pad(e.time,10)} | ${pad(e.type,11)} | ${pad(e.activity,17)} | ${pad(e.confidence,6)} | ${pad(e.expected,17)} | ${e.status}`
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kriya-sense-event-log-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function pad(str, len) {
    str = String(str);
    return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
  }

  // Seed a couple of initial log/timeline entries for a populated first render.
  (function seed() {
    pushTimeline('⚙ SYSTEM INITIALIZED', 'success');
    pushEvent('System', '—', 100, '—', 'READY');
  })();

  return {
    subscribe,
    getStatus,
    getEventLog,
    getTimeline,
    getGuidance,
    getActivityMasterList,
    triggerActivity,
    simulateViolation,
    reset,
    setSequence,
    setVoiceEnabled,
    repeatGuidance,
    exportEventLogTxt,
    speak,
    processLiveDetection,
    resetLiveTracking,
  };
})();

window.ASTRA_EXPERIMENT = ASTRA_EXPERIMENT;
