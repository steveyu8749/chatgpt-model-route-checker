/*
 * Conservative, local rules for model route classification.
 *
 * Keep this list empty until a request/response pair has been observed and
 * verified. A different-looking slug is not, by itself, proof of a mismatch.
 * Entries are intentionally exact (case-insensitive after trimming).
 */
(function installModelRules(root) {
  root.CHATGPT_ROUTE_CHECKER_RULES = Object.freeze({
    equivalent: Object.freeze([]),
    incompatible: Object.freeze([])
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
