/*
 * Shared timing policy for the MAIN and ISOLATED content scripts.
 *
 * This file is loaded in both worlds so the telemetry association window and
 * the UI's delayed-metadata grace period cannot drift apart. It contains no
 * page data and is also directly require-able by the Node test suite.
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
  const MODEL_METADATA_WAIT_WINDOW_MS = 6000;

  return Object.freeze({
    MODEL_METADATA_WAIT_WINDOW_MS
  });
});
