/* ==========================================================================
   activity.js
   Per-person activity bookkeeping: current/previous activity, how long
   they've held it, and a short history log. Consumes the tracked persons
   array produced each tick (detection.js -> tracking.js) and is the single
   source of truth for activity labels/history shown across the dashboard,
   General Activity page, and Live Analysis panels.
   ========================================================================== */

const ASTRA_ACTIVITY = (() => {

  const ACTIVITY_LABELS = {
    PICK_UP: 'Pick Up',
    OPEN_CAP: 'Open Cap',
    DRAW_LIQUID: 'Draw Liquid',
    POUR_LIQUID: 'Pour Liquid',
    MIX: 'Mix',
    PLACE_BACK: 'Place Back',
    STANDING: 'Standing',
    WALKING: 'Walking',
    SITTING: 'Sitting',
    RUNNING: 'Running',
    READING: 'Reading',
    WRITING: 'Writing',
    PHONE_USE: 'Using Phone',
    USE_LAPTOP: 'Using Laptop',
    USING_LAPTOP: 'Using Laptop',
    USING_PHONE: 'Using Phone',
    PICKING_OBJECT: 'Picking Object',
    PUT_OBJECT_DOWN: 'Putting Object Down',
    OPENING: 'Opening',
    CLOSING: 'Closing',
    REACHING: 'Reaching',
    CARRYING: 'Carrying',
    LYING_DOWN: 'Lying Down',
    UNCERTAIN: 'Uncertain',
  };

  const persons = new Map(); // id -> record

  function labelFor(code) {
    if (!code) return 'PERSON DETECTED';
    return ACTIVITY_LABELS[code] || code.replace(/_/g, ' ');
  }

  function formatPersonId(id) {
    return `PERSON ${id}`;
  }

  function nowStr() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  function update(trackedPersons) {
    const now = Date.now();
    const seenIds = new Set();

    trackedPersons.forEach(p => {
      seenIds.add(p.id);
      let rec = persons.get(p.id);
      if (!rec) {
        rec = {
          id: p.id,
          activity: p.activity,
          confidence: p.confidence,
          reason: p.harReason || null,
          bodyTelemetry: p.bodyTelemetry || null,
          since: now,
          previous: null,
          history: [],
        };
        rec.history.unshift({ time: nowStr(), label: labelFor(p.activity) });
        persons.set(p.id, rec);
      } else {
        rec.confidence = p.confidence;
        rec.reason = p.harReason || null;
        if (p.bodyTelemetry) rec.bodyTelemetry = p.bodyTelemetry;
        if (rec.activity !== p.activity) {
          rec.previous = rec.activity;
          rec.activity = p.activity;
          rec.since = now;
          rec.history.unshift({ time: nowStr(), label: labelFor(p.activity) });
          if (rec.history.length > 20) rec.history.length = 20;
        }
      }
    });

    // Anyone not present this round has left the frame — forget them.
    Array.from(persons.keys()).forEach(id => { if (!seenIds.has(id)) persons.delete(id); });
  }

  function getAll() {
    return Array.from(persons.values())
      .sort((a, b) => a.id - b.id)
      .map(r => ({
        ...r,
        label: labelFor(r.activity),
        previousLabel: labelFor(r.previous),
        durationMs: Date.now() - r.since,
        bodyTelemetry: r.bodyTelemetry || null,
      }));
  }

  function getPrimary() {
    const all = getAll();
    return all.length ? all[0] : null;
  }

  function getById(id) {
    const r = persons.get(id);
    if (!r) return null;
    return { ...r, label: labelFor(r.activity), previousLabel: labelFor(r.previous), durationMs: Date.now() - r.since };
  }

  function reset() {
    persons.clear();
  }

  return { update, getAll, getPrimary, getById, labelFor, formatPersonId, reset };
})();
