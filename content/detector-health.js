/*
 * Small, side-effect-free health state used by the isolated content script.
 * It is kept separate so the connection state can be tested without a DOM.
 */
(function installDetectorHealth(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ChatGPTRouteDetectorHealth = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createApi() {
  const HEALTH_STATUSES = Object.freeze([
    "installed",
    "overwritten",
    "unavailable",
    "failed"
  ]);
  const HEALTH_STATUS_SET = new Set(HEALTH_STATUSES);
  const TELEMETRY_COUNTERS = Object.freeze([
    "observed",
    "readable",
    "associated",
    "modelFound",
    "droppedNoCandidate",
    "droppedAmbiguous",
    "droppedExpired"
  ]);

  function clean(value, maxLength = 40) {
    if (typeof value !== "string") return null;
    const result = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();
    return result ? result.slice(0, maxLength) : null;
  }

  function normalizeHealth(health) {
    try {
      if (!health || typeof health !== "object") return null;
      const detectorVersion = clean(health.detectorVersion);
      if (!detectorVersion) return null;

      const result = { detectorVersion };
      for (const key of ["fetch", "xhr", "beacon"]) {
        const value = health[key];
        if (typeof value !== "string" || !HEALTH_STATUS_SET.has(value)) {
          return null;
        }
        result[key] = value;
      }
      if (!health.telemetry || typeof health.telemetry !== "object") return null;
      result.telemetry = {};
      for (const key of TELEMETRY_COUNTERS) {
        const value = health.telemetry[key];
        if (!Number.isFinite(value) || value < 0) return null;
        result.telemetry[key] = Math.min(Math.floor(value), 100000);
      }
      return result;
    } catch {
      return null;
    }
  }

  function createState() {
    return {
      status: "connecting",
      health: null
    };
  }

  function accept(state, health) {
    const normalized = normalizeHealth(health);
    if (!state || !normalized) return null;
    state.status = "connected";
    state.health = normalized;
    return normalized;
  }

  function timeout(state, stale = false) {
    if (!state || (state.status === "connected" && !stale)) return state;
    state.status = "disconnected";
    return state;
  }

  return Object.freeze({
    HEALTH_STATUSES,
    TELEMETRY_COUNTERS,
    normalizeHealth,
    createState,
    accept,
    timeout
  });
});
