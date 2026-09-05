/*
 * Shared timing policy for the MAIN and ISOLATED content scripts.
 *
 * This file is loaded in both worlds. The short foreground window limits how
 * long the UI remains in a checking state, while the longer background window
 * still accepts safely attributable telemetry that arrives later.
 */
(function installTiming(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ChatGPTRouteTiming = api;
  // Node VM tests use a context object as globalThis and expose the page
  // object separately as window. Keep the browser and test loading paths
  // equivalent without changing the production world split.
  if (typeof window !== "undefined" && window !== root) {
    window.ChatGPTRouteTiming = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function createApi() {
  const DISPLAY_METADATA_WAIT_WINDOW_MS = 3000;
  const TELEMETRY_ASSOCIATION_WINDOW_MS = 15000;

  return Object.freeze({
    DISPLAY_METADATA_WAIT_WINDOW_MS,
    TELEMETRY_ASSOCIATION_WINDOW_MS
  });
});
