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

  function clean(value, maxLength = 40) {
    if (typeof value !== "string") return null;
    const result = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();
    return result ? result.slice(0, maxLength) : null;
  }

  function normalizeHealth(health) {
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
    return result;
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

  function timeout(state) {
    if (!state || state.status === "connected") return state;
    state.status = "disconnected";
    return state;
  }

  return Object.freeze({
    HEALTH_STATUSES,
    normalizeHealth,
    createState,
    accept,
    timeout
  });
});
