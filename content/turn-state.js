/*
 * Pure per-turn state helpers.
 *
 * The content script owns the DOM and timers, while this module owns the
 * small state machine used to associate evidence with one conversation turn.
 * It is deliberately usable from Node-based behavior tests as well as from a
 * browser content script.
 */
(function installTurnState(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ChatGPTRouteTurnState = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createApi() {
  const EVIDENCE_FIELDS = Object.freeze([
    "requestModel",
    "serverModel",
    "assistantModel",
    "resolvedModel",
    "requestedExperience",
    "domModel",
    "thinkingEffort"
  ]);
  const MAX_EVIDENCE_VALUES = 8;

  function clean(value, maxLength = 200) {
    if (typeof value !== "string") return null;

    const result = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();

    return result ? result.slice(0, maxLength) : null;
  }

  function comparable(value) {
    const cleaned = clean(value);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  function evidenceValues() {
    return Object.fromEntries(
      EVIDENCE_FIELDS.map((field) => [field, []])
    );
  }

  function evidenceConflicts() {
    return Object.fromEntries(
      EVIDENCE_FIELDS.map((field) => [field, false])
    );
  }

  function evidenceTruncated() {
    return Object.fromEntries(
      EVIDENCE_FIELDS.map((field) => [field, false])
    );
  }

  function createTurn(id, now = Date.now()) {
    return {
      id,
      requestCaptured: false,
      requestModel: null,
      serverModel: null,
      assistantModel: null,
      resolvedModel: null,
      requestedExperience: null,
      domModel: null,
      thinkingEffort: null,
      evidenceValues: evidenceValues(),
      evidenceConflicts: evidenceConflicts(),
      evidenceTruncated: evidenceTruncated(),
      complete: false,
      roundNumber: null,
      requestCapturedAt: null,
      responseStartedAt: null,
      responseEndedAt: null,
      serverModelAt: null,
      completedAt: null,
      responseStarted: false,
      responseEnded: false,
      responseEndReason: null,
      responseFormat: null,
      responseUnsupported: false,
      responseStats: {
        payloadCount: 0,
        parseErrorCount: 0,
        eventCount: 0,
        byteCount: 0,
        sawDone: false
      },
      completionTimer: null,
      responseWaitTimer: null,
      startedAt: now,
      lastActivityAt: now
    };
  }

  function touch(turn, now = Date.now()) {
    if (turn && Number.isFinite(now)) turn.lastActivityAt = now;
    return turn;
  }

  function addEvidence(turn, field, value, now = Date.now()) {
    if (!turn || !EVIDENCE_FIELDS.includes(field)) {
      return {
        added: false,
        duplicate: false,
        conflict: false,
        values: []
      };
    }

    const maxLength = field === "thinkingEffort" ? 80 : 200;
    const cleaned = clean(value, maxLength);
    if (!cleaned) return {
      added: false,
      duplicate: false,
      conflict: Boolean(
        turn.evidenceConflicts && turn.evidenceConflicts[field]
      ),
      values: getEvidenceValues(turn, field)
    };

    if (!turn.evidenceValues || typeof turn.evidenceValues !== "object") {
      turn.evidenceValues = evidenceValues();
    }
    if (!turn.evidenceConflicts || typeof turn.evidenceConflicts !== "object") {
      turn.evidenceConflicts = evidenceConflicts();
    }
    if (!turn.evidenceTruncated || typeof turn.evidenceTruncated !== "object") {
      turn.evidenceTruncated = evidenceTruncated();
    }
    const values = Array.isArray(turn.evidenceValues[field])
      ? turn.evidenceValues[field]
      : (turn.evidenceValues[field] = []);
    const key = comparable(cleaned);
    const duplicate = values.some((existing) => comparable(existing) === key);
    let added = false;

    if (!duplicate) {
      if (values.length < MAX_EVIDENCE_VALUES) {
        values.push(cleaned);
        added = true;
      } else {
        turn.evidenceTruncated[field] = true;
      }
    }

    // Keep the first observation as the canonical scalar used by the
    // conservative classifier. Later observations remain visible in the
    // bounded evidenceValues list and can therefore never silently overwrite
    // the earlier value.
    if (!turn[field] && values.length) turn[field] = values[0];
    if (added && !Number.isFinite(turn[`${field}At`])) {
      turn[`${field}At`] = now;
    }
    turn.evidenceConflicts[field] = values.length > 1;
    touch(turn, now);

    return {
      added,
      duplicate,
      conflict: turn.evidenceConflicts[field],
      truncated: Boolean(turn.evidenceTruncated[field]),
      values: getEvidenceValues(turn, field)
    };
  }

  function getEvidenceValues(turn, field) {
    if (!turn || !EVIDENCE_FIELDS.includes(field)) return [];
    const values = turn.evidenceValues && turn.evidenceValues[field];
    if (Array.isArray(values)) return values.slice(0, MAX_EVIDENCE_VALUES);
    const value = clean(turn[field], field === "thinkingEffort" ? 80 : 200);
    return value ? [value] : [];
  }

  function hasEvidenceConflict(turn, field) {
    return getEvidenceValues(turn, field).length > 1;
  }

  function primaryConflictFields(turn) {
    return ["requestModel", "serverModel"].filter((field) =>
      hasEvidenceConflict(turn, field)
    );
  }

  function allConflictFields(turn) {
    return EVIDENCE_FIELDS.filter((field) => hasEvidenceConflict(turn, field));
  }

  function shouldAcceptDomEvidence(turn, node, source = "attribute") {
    if (!turn || !node || !turn.responseStarted) return false;
    // Existing attributes on the baseline assistant node are not evidence for
    // a new response. An explicit post-response attribute mutation is the one
    // exception because it represents a fresh DOM update.
    return source === "attribute" || node !== turn.domBaselineNode;
  }

  function captureRequest(turn, fields = {}, now = Date.now()) {
    if (!turn) return null;
    if (!Number.isFinite(turn.requestCapturedAt)) turn.requestCapturedAt = now;
    turn.requestCaptured = true;
    addEvidence(turn, "requestModel", fields.model, now);
    addEvidence(turn, "thinkingEffort", fields.thinkingEffort, now);
    touch(turn, now);
    return turn;
  }

  function startResponse(turn, responseFormat, now = Date.now()) {
    if (!turn) return null;
    touch(turn, now);
    if (!Number.isFinite(turn.responseStartedAt)) turn.responseStartedAt = now;
    turn.responseStarted = true;
    turn.responseFormat = clean(responseFormat, 40) || "unknown";
    turn.responseEnded = false;
    turn.responseEndReason = null;
    turn.responseUnsupported = false;
    turn.complete = false;
    return turn;
  }

  function updateResponseStats(turn, data = {}, now = Date.now()) {
    if (!turn || !data) return null;
    const stats = turn.responseStats || (turn.responseStats = {});
    for (const key of [
      "payloadCount",
      "parseErrorCount",
      "eventCount",
      "byteCount"
    ]) {
      if (Number.isFinite(data[key])) {
        stats[key] = Math.min(Math.max(Math.floor(data[key]), 0), 100000);
      }
    }
    if (typeof data.sawDone === "boolean") stats.sawDone = data.sawDone;
    touch(turn, now);
    return turn;
  }

  function endResponse(turn, details = {}, now = Date.now()) {
    if (!turn) return null;
    if (!Number.isFinite(turn.responseEndedAt)) turn.responseEndedAt = now;
    turn.responseEnded = true;
    turn.responseEndReason = clean(details.endReason, 80) || "completed";
    if (details.responseStarted !== undefined) {
      turn.responseStarted = Boolean(details.responseStarted);
    }
    turn.responseFormat =
      clean(details.responseFormat, 40) || turn.responseFormat || "unknown";
    turn.responseUnsupported = Boolean(details.responseUnsupported);
    updateResponseStats(turn, details.stats || {}, now);
    touch(turn, now);
    return turn;
  }

  function complete(turn, now = Date.now()) {
    if (!turn) return null;
    if (!Number.isFinite(turn.completedAt)) turn.completedAt = now;
    turn.complete = true;
    touch(turn, now);
    return turn;
  }

  function timeout(turn, reason = "no-response", now = Date.now()) {
    if (!turn) return null;
    if (!Number.isFinite(turn.responseEndedAt)) turn.responseEndedAt = now;
    turn.responseEnded = true;
    turn.responseEndReason = clean(reason, 80) || "no-response";
    turn.complete = true;
    if (!Number.isFinite(turn.completedAt)) turn.completedAt = now;
    touch(turn, now);
    return turn;
  }

  function isWaitingForDelayedMetadata(turn) {
    return Boolean(
      turn &&
      turn.responseEnded &&
      !turn.complete &&
      !turn.serverModel
    );
  }

  function delayedMetadataState(
    turn,
    now = Date.now(),
    waitWindowMs
  ) {
    const windowMs = Number.isFinite(waitWindowMs)
      ? Math.max(0, Math.floor(waitWindowMs))
      : null;
    const responseEndedAt = turn && turn.responseEndedAt;
    const waiting = isWaitingForDelayedMetadata(turn);
    if (
      !waiting ||
      !Number.isFinite(now) ||
      !Number.isFinite(responseEndedAt) ||
      windowMs === null
    ) {
      return {
        waiting: false,
        expired: false,
        elapsedMs: null,
        remainingMs: null
      };
    }

    const elapsedMs = Math.max(0, Math.floor(now - responseEndedAt));
    return {
      waiting: true,
      expired: elapsedMs >= windowMs,
      elapsedMs,
      remainingMs: Math.max(0, windowMs - elapsedMs)
    };
  }

  function elapsedSince(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, Math.floor(end - start));
  }

  function relativeTiming(turn, now = Date.now()) {
    if (!turn) {
      return {
        roundNumber: null,
        requestToResponseStartMs: null,
        requestToResponseEndMs: null,
        responseEndToServerModelMs: null,
        responseEndElapsedMs: null,
        totalElapsedMs: null,
        settled: false
      };
    }

    const currentTime = Number.isFinite(now) ? now : Date.now();
    const requestAt = Number.isFinite(turn.requestCapturedAt)
      ? turn.requestCapturedAt
      : turn.startedAt;
    const responseEndToServerModelMs =
      Number.isFinite(turn.responseEndedAt) &&
      Number.isFinite(turn.serverModelAt)
        ? Math.floor(turn.serverModelAt - turn.responseEndedAt)
        : null;
    const settledAt = Number.isFinite(turn.serverModelAt)
      ? turn.serverModelAt
      : Number.isFinite(turn.completedAt)
        ? turn.completedAt
        : null;
    const timingEnd = Number.isFinite(settledAt) ? settledAt : currentTime;

    return {
      roundNumber: Number.isFinite(turn.roundNumber)
        ? turn.roundNumber
        : null,
      requestToResponseStartMs: elapsedSince(
        requestAt,
        turn.responseStartedAt
      ),
      requestToResponseEndMs: elapsedSince(requestAt, turn.responseEndedAt),
      responseEndToServerModelMs,
      responseEndElapsedMs: Number.isFinite(turn.responseEndedAt)
        ? elapsedSince(turn.responseEndedAt, timingEnd)
        : null,
      totalElapsedMs: elapsedSince(requestAt, timingEnd),
      settled: Number.isFinite(settledAt)
    };
  }

  function createStore(options = {}) {
    const maxTurns = Number.isFinite(options.maxTurns)
      ? Math.max(1, Math.floor(options.maxTurns))
      : 8;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const onEvict = typeof options.onEvict === "function" ? options.onEvict : () => {};
    const turns = new Map();
    let currentId = null;
    let nextRoundNumber = 1;

    function get(id, create = true) {
      if (!id) return null;
      let turn = turns.get(id);
      if (!turn && create) {
        turn = createTurn(id, now());
        turns.set(id, turn);
        while (turns.size > maxTurns) {
          const oldestId = turns.keys().next().value;
          const oldest = turns.get(oldestId);
          if (oldest) onEvict(oldest);
          turns.delete(oldestId);
          if (currentId === oldestId) currentId = null;
        }
      }
      return turn;
    }

    function beginRequest(id, fields = {}) {
      if (!id) return null;
      const existing = turns.has(id);
      const turn = get(id, true);
      const hadRequest = Boolean(turn && turn.requestCaptured);
      if (turn && !Number.isFinite(turn.roundNumber)) {
        turn.roundNumber = nextRoundNumber;
        nextRoundNumber += 1;
      }
      captureRequest(turn, fields, now());
      const previousCurrentId = currentId;
      // A newly observed request becomes the visible turn. A duplicate event
      // for an existing request never steals the card from a newer request.
      if (!hadRequest || !currentId) currentId = id;
      return {
        turn,
        existing: hadRequest || existing,
        becameCurrent: previousCurrentId !== currentId,
        isCurrent: currentId === id
      };
    }

    function current() {
      return currentId ? turns.get(currentId) || null : null;
    }

    function isCurrent(id) {
      return Boolean(id && currentId === id);
    }

    function currentKey() {
      return currentId;
    }

    return Object.freeze({
      get,
      beginRequest,
      current,
      currentId: currentKey,
      isCurrent,
      size: () => turns.size,
      values: () => [...turns.values()]
    });
  }

  return Object.freeze({
    EVIDENCE_FIELDS,
    MAX_EVIDENCE_VALUES,
    clean,
    createTurn,
    touch,
    addEvidence,
    getEvidenceValues,
    hasEvidenceConflict,
    primaryConflictFields,
    allConflictFields,
    shouldAcceptDomEvidence,
    captureRequest,
    startResponse,
    updateResponseStats,
    endResponse,
    complete,
    timeout,
    isWaitingForDelayedMetadata,
    delayedMetadataState,
    relativeTiming,
    createStore
  });
});
