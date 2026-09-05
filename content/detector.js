/* global window, navigator, XMLHttpRequest, Request, Blob, URLSearchParams */
/*
 * MAIN-world bridge.
 *
 * This file deliberately forwards only model-related scalar values. It never
 * forwards request messages, response text, attachments, URLs, headers, or
 * account information to the isolated content script.
 */
(function installDetector() {
  "use strict";

  const CHANNEL = "__CHATGPT_MODEL_ROUTE_CHECKER_V1__";
  const MAX_VALUE_LENGTH = 200;
  const MAX_SCAN_DEPTH = 18;
  const MAX_SCAN_NODES = 12000;
  const STREAM_BUFFER_LIMIT = 2 * 1024 * 1024;
  const TELEMETRY_ASSOCIATION_WINDOW_MS = 4000;
  const ACTIVE_RECORD_RETENTION_MS = 5 * 60 * 1000;
  const ENDED_RECORD_RETENTION_MS = 10000;
  const SKIP_RECURSION_KEYS = new Set([
    "content",
    "parts",
    "text",
    "messages",
    "attachments",
    "files",
    "prompt",
    "body"
  ]);
  const stateKey = "__CHATGPT_MODEL_ROUTE_CHECKER_MAIN_V1__";

  if (window[stateKey]) return;
  window[stateKey] = true;

  let sequence = 0;
  const conversationRecords = new Map();

  function scalar(value, maxLength = MAX_VALUE_LENGTH) {
    if (typeof value !== "string") return null;

    const result = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();

    return result ? result.slice(0, maxLength) : null;
  }

  function requestId() {
    sequence += 1;
    return `turn-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function cleanupConversationRecords(now = Date.now()) {
    for (const [id, record] of conversationRecords) {
      const referenceTime = record.endedAt || record.startedAt;
      const retention = record.endedAt
        ? ENDED_RECORD_RETENTION_MS
        : ACTIVE_RECORD_RETENTION_MS;
      if (now - referenceTime > retention) {
        conversationRecords.delete(id);
      }
    }
  }

  function registerConversation(id) {
    const now = Date.now();
    cleanupConversationRecords(now);
    conversationRecords.set(id, {
      startedAt: now,
      endedAt: null
    });
  }

  function endConversation(id) {
    const record = conversationRecords.get(id);
    if (record && !record.endedAt) record.endedAt = Date.now();
    cleanupConversationRecords();
  }

  function telemetryRequestId() {
    const now = Date.now();
    cleanupConversationRecords(now);

    const candidates = [...conversationRecords.entries()].filter(([, record]) => {
      const referenceTime = record.endedAt || record.startedAt;
      const window = record.endedAt
        ? TELEMETRY_ASSOCIATION_WINDOW_MS
        : ACTIVE_RECORD_RETENTION_MS;
      return now - referenceTime <= window;
    });

    // If more than one conversation is still plausible, do not attach
    // telemetry to the wrong turn. The normal stream evidence remains
    // authoritative, and a later unambiguous telemetry event can still be
    // accepted.
    return candidates.length === 1 ? candidates[0][0] : null;
  }

  function closeConversation(id) {
    endConversation(id);
    emit("response-end", { requestId: id });
  }

  function emit(type, payload = {}) {
    try {
      window.postMessage(
        {
          channel: CHANNEL,
          version: 1,
          type,
          ...payload
        },
        window.location.origin
      );
    } catch {
      // The page may be navigating or have an unusual origin. Detection is
      // best-effort and must never interfere with ChatGPT itself.
    }
  }

  function absoluteUrl(input) {
    try {
      return new URL(String(input || ""), window.location.href);
    } catch {
      return null;
    }
  }

  function isConversation(url, method) {
    const target = absoluteUrl(url);
    return Boolean(
      target &&
      target.origin === window.location.origin &&
      method === "POST" &&
      /^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(target.pathname)
    );
  }

  function isTelemetry(url, method) {
    const target = absoluteUrl(url);
    return Boolean(
      target &&
      target.origin === window.location.origin &&
      method === "POST" &&
      /^\/ces\/v1\/telemetry\/intake(?:\/|$)/.test(target.pathname)
    );
  }

  function bodyToText(body) {
    try {
      if (body == null) return Promise.resolve("");
      if (typeof body === "string") return Promise.resolve(body);
      if (body instanceof Blob) return body.text();
      if (body instanceof URLSearchParams) return Promise.resolve(body.toString());
      if (body instanceof ArrayBuffer) {
        return Promise.resolve(new TextDecoder().decode(body));
      }
      if (ArrayBuffer.isView(body)) {
        return Promise.resolve(new TextDecoder().decode(body));
      }
    } catch {
      return Promise.resolve("");
    }

    return Promise.resolve("");
  }

  function requestBodyText(input, init) {
    if (init && init.body != null) return bodyToText(init.body);

    if (typeof Request !== "undefined" && input instanceof Request) {
      try {
        return input.clone().text();
      } catch {
        return Promise.resolve("");
      }
    }

    return Promise.resolve("");
  }

  function requestFieldsFromText(text) {
    if (!text || typeof text !== "string") return null;

    try {
      const parsed = JSON.parse(text);
      return {
        model: scalar(parsed && parsed.model),
        thinkingEffort: scalar(parsed && parsed.thinking_effort, 80)
      };
    } catch {
      return null;
    }
  }

  function captureRequestAsync(id, input, init) {
    // Notify the isolated world synchronously when possible. Reading a
    // Request clone is asynchronous; without this early event a very fast
    // response could be observed before the request record exists.
    let initialModel = null;
    let initialThinkingEffort = null;
    if (init && typeof init.body === "string") {
      const fields = requestFieldsFromText(init.body);
      initialModel = fields && fields.model;
      initialThinkingEffort = fields && fields.thinkingEffort;
    }
    emit("request", {
      requestId: id,
      model: initialModel,
      thinkingEffort: initialThinkingEffort
    });

    requestBodyText(input, init)
      .then((text) => {
        const fields = requestFieldsFromText(text);
        const model = fields && fields.model;
        const thinkingEffort = fields && fields.thinkingEffort;
        if (
          (model && model !== initialModel) ||
          (thinkingEffort && thinkingEffort !== initialThinkingEffort)
        ) {
          emit("request", {
            requestId: id,
            ...(model ? { model } : {}),
            ...(thinkingEffort ? { thinkingEffort } : {})
          });
        }
      })
      .catch(() => {});
  }

  function emitModelField(type, requestIdValue, value) {
    const cleaned = scalar(value);
    if (!cleaned) return;

    const targetRequestId = requestIdValue || telemetryRequestId();
    // Every network-derived field must be tied to one known conversation.
    // In particular, never emit a null id that the isolated world could
    // accidentally attach to whichever turn is currently visible.
    if (!targetRequestId) return;

    emit(type, {
      requestId: targetRequestId,
      value: cleaned
    });
  }

  function inspectObject(value, requestIdValue, depth = 0, seen = new WeakSet(), budget = { count: 0 }) {
    if (value == null || depth > MAX_SCAN_DEPTH || budget.count >= MAX_SCAN_NODES) return;

    if (typeof value === "string") {
      const text = value.trim();
      if (
        text.startsWith("{") &&
        (text.includes("model_slug") ||
          text.includes("server_ste_metadata") ||
          text.includes("resolved_model_slug"))
      ) {
        try {
          inspectObject(JSON.parse(text), requestIdValue, depth + 1, seen, budget);
        } catch {
          // This may be ordinary streamed text; it is intentionally ignored.
        }
      }
      return;
    }

    if (typeof value !== "object") return;

    if (seen.has(value)) return;
    seen.add(value);
    budget.count += 1;

    if (value.type === "server_ste_metadata") {
      // Some streams put model_slug directly on the typed event; others put
      // it under metadata/data. The metadata scanner handles both forms.
      inspectServerMetadata(value, requestIdValue);
    }

    // Search by key rather than assuming one fixed nesting path. This covers
    // metadata.server_ste_metadata, message.metadata.server_ste_metadata,
    // turn_analytics.server_ste_metadata, and future shallow wrappers.
    if (Object.prototype.hasOwnProperty.call(value, "server_ste_metadata")) {
      inspectServerMetadata(value.server_ste_metadata, requestIdValue);
    }

    if (
      value.author &&
      value.author.role === "assistant" &&
      value.metadata &&
      typeof value.metadata === "object"
    ) {
      emitModelField(
        "assistant-model",
        requestIdValue,
        value.metadata.model_slug
      );
    }

    if (
      value.message &&
      value.message.author &&
      value.message.author.role === "assistant" &&
      value.message.metadata &&
      typeof value.message.metadata === "object"
    ) {
      emitModelField(
        "assistant-model",
        requestIdValue,
        value.message.metadata.model_slug
      );
    }

    if (typeof value.resolved_model_slug === "string") {
      emitModelField(
        "resolved-model",
        requestIdValue,
        value.resolved_model_slug
      );
    }

    if (typeof value.requested_model_experience === "string") {
      emitModelField(
        "requested-experience",
        requestIdValue,
        value.requested_model_experience
      );
    }

    for (const [key, child] of Object.entries(value)) {
      // The response's text/content/attachment trees can contain arbitrary
      // JSON-looking strings. They are not model evidence and must never be
      // traversed or interpreted.
      if (SKIP_RECURSION_KEYS.has(String(key).toLowerCase())) continue;
      if (budget.count >= MAX_SCAN_NODES) break;
      inspectObject(child, requestIdValue, depth + 1, seen, budget);
    }
  }

  function inspectServerMetadata(metadata, requestIdValue, depth = 0, seen = new WeakSet()) {
    if (metadata == null || depth > 8) return;

    if (typeof metadata === "string") {
      const text = metadata.trim();
      if (
        text.startsWith("{") &&
        (text.includes("model_slug") ||
          text.includes("server_ste_metadata") ||
          text.includes("requested_model_experience"))
      ) {
        try {
          inspectServerMetadata(
            JSON.parse(text),
            requestIdValue,
            depth + 1,
            seen
          );
        } catch {
          // Ignore non-JSON metadata strings.
        }
      }
      return;
    }

    if (typeof metadata !== "object" || seen.has(metadata)) return;
    seen.add(metadata);

    emitModelField("server-model", requestIdValue, metadata.model_slug);
    emitModelField(
      "requested-experience",
      requestIdValue,
      metadata.requested_model_experience
    );

    // Stay inside the metadata envelope. In particular, do not recursively
    // walk arbitrary assistant content while looking for model_slug.
    const nestedKeys = new Set([
      "metadata",
      "server_ste_metadata",
      "data",
      "payload",
      "value"
    ]);
    for (const [key, child] of Object.entries(metadata)) {
      if (nestedKeys.has(key)) {
        inspectServerMetadata(child, requestIdValue, depth + 1, seen);
      }
    }
  }

  function parseJSONCandidate(text, requestIdValue) {
    if (!text || typeof text !== "string") return false;

    let value = text.trim();
    if (!value || value === "[DONE]") return Boolean(value);
    if (value.startsWith("data:")) value = value.slice(5).trim();
    if (!value || value === "[DONE]") return Boolean(value);

    try {
      inspectObject(JSON.parse(value), requestIdValue);
      return true;
    } catch {
      // Ignore non-JSON stream fragments; do not inspect or forward them.
      return false;
    }
  }

  function createStreamParser(requestIdValue) {
    let lineBuffer = "";
    let eventData = [];
    let rawJson = "";

    function finishRawJson(force = false) {
      if (!rawJson) return;
      const complete = parseJSONCandidate(rawJson, requestIdValue);
      if (complete || force) rawJson = "";
    }

    function finishEvent() {
      if (eventData.length) {
        parseJSONCandidate(eventData.join("\n"), requestIdValue);
        eventData = [];
      }
      finishRawJson(true);
    }

    function processLine(rawLine) {
      const line = rawLine.trim();
      if (!line) {
        finishEvent();
        return;
      }

      // SSE comments and fields which do not carry model data are ignored.
      if (line.startsWith(":")) return;
      if (line.startsWith("event:")) {
        // Be tolerant of servers that omit the usual blank line between
        // events: a new event field closes the prior data envelope.
        if (eventData.length) finishEvent();
        return;
      }
      if (
        line.startsWith("id:") ||
        line.startsWith("retry:")
      ) {
        return;
      }

      if (line.startsWith("data:")) {
        finishRawJson(true);
        const piece = line.slice(5).trimStart();

        // Parse complete data lines immediately. If a JSON value is split
        // across data lines, retain the pieces and retry after each append.
        if (!eventData.length && parseJSONCandidate(piece, requestIdValue)) {
          return;
        }
        eventData.push(piece);
        if (parseJSONCandidate(eventData.join("\n"), requestIdValue)) {
          eventData = [];
        }
        if (eventData.join("\n").length > STREAM_BUFFER_LIMIT) {
          eventData = [];
        }
        return;
      }

      if (line.startsWith("{") || line.startsWith("[")) {
        rawJson = rawJson ? `${rawJson}\n${line}` : line;
        if (parseJSONCandidate(rawJson, requestIdValue)) rawJson = "";
        if (rawJson.length > STREAM_BUFFER_LIMIT) rawJson = "";
      }
    }

    function push(text, final = false) {
      if (typeof text === "string" && text) lineBuffer += text;

      while (lineBuffer) {
        let index = -1;
        let endingLength = 1;

        for (let i = 0; i < lineBuffer.length; i += 1) {
          if (lineBuffer[i] === "\n") {
            index = i;
            endingLength = 1;
            break;
          }
          if (lineBuffer[i] === "\r") {
            // A CR at the end of a non-final chunk may be the first half of
            // CRLF, so retain it until the next chunk arrives.
            if (i + 1 === lineBuffer.length && !final) break;
            index = i;
            endingLength = lineBuffer[i + 1] === "\n" ? 2 : 1;
            break;
          }
        }

        if (index === -1) break;

        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + endingLength);
        processLine(line);
      }

      if (lineBuffer.length > STREAM_BUFFER_LIMIT) lineBuffer = "";

      if (final) {
        if (lineBuffer) {
          processLine(lineBuffer);
          lineBuffer = "";
        }
        finishEvent();
      }
    }

    return { push };
  }

  function scanWholeText(text, requestIdValue) {
    if (!text || typeof text !== "string") return;
    const parser = createStreamParser(requestIdValue);
    parser.push(text, true);
  }

  async function watchStream(response, requestIdValue) {
    try {
      if (!response || !response.body) {
        scanWholeText(await response.text(), requestIdValue);
        closeConversation(requestIdValue);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createStreamParser(requestIdValue);

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        parser.push(decoder.decode(result.value, { stream: true }));
      }

      parser.push(decoder.decode(), true);
      closeConversation(requestIdValue);
    } catch {
      // Reading a clone can fail if the page cancels/navigation closes it.
      closeConversation(requestIdValue);
    }
  }

  function methodFor(input, init) {
    return String(
      (init && init.method) ||
        (input && input.method) ||
        "GET"
    ).toUpperCase();
  }

  function wrapFetch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;

    window.fetch = function routeCheckerFetch(input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const method = methodFor(input, init);
      const conversation = isConversation(url, method);
      const telemetry = isTelemetry(url, method);
      const id = conversation ? requestId() : null;

      if (conversation) {
        registerConversation(id);
        captureRequestAsync(id, input, init);
      } else if (telemetry) {
        requestBodyText(input, init)
          .then((text) => scanWholeText(text, telemetryRequestId()))
          .catch(() => {});
      }

      let result;
      try {
        result = nativeFetch.apply(this, arguments);
      } catch (error) {
        if (conversation) closeConversation(id);
        throw error;
      }

      if (!conversation) return result;

      return Promise.resolve(result).then(
        (response) => {
          try {
            watchStream(response.clone(), id);
          } catch {
            closeConversation(id);
          }
          return response;
        },
        (error) => {
          // Preserve the page's original rejection semantics while closing
          // the detector's turn so its UI cannot remain in "checking".
          closeConversation(id);
          throw error;
        }
      );
    };
  }

  function wrapXHR() {
    if (typeof XMLHttpRequest === "undefined") return;

    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    if (typeof nativeOpen !== "function" || typeof nativeSend !== "function") return;

    proto.open = function routeCheckerOpen(method, url) {
      this.__chatgptRouteMethod = String(method || "GET").toUpperCase();
      this.__chatgptRouteUrl = String(url || "");
      return nativeOpen.apply(this, arguments);
    };

    proto.send = function routeCheckerSend(body) {
      const method = this.__chatgptRouteMethod || "GET";
      const url = this.__chatgptRouteUrl || "";
      const conversation = isConversation(url, method);
      const telemetry = isTelemetry(url, method);
      const id = conversation ? requestId() : null;

      if (conversation) {
        registerConversation(id);
        const initialFields =
          typeof body === "string" ? requestFieldsFromText(body) : null;
        const initialModel = initialFields && initialFields.model;
        const initialThinkingEffort =
          initialFields && initialFields.thinkingEffort;
        emit("request", {
          requestId: id,
          model: initialModel,
          thinkingEffort: initialThinkingEffort
        });
        bodyToText(body)
          .then((text) => {
            const fields = requestFieldsFromText(text);
            const model = fields && fields.model;
            const thinkingEffort = fields && fields.thinkingEffort;
            if (
              (model && model !== initialModel) ||
              (thinkingEffort && thinkingEffort !== initialThinkingEffort)
            ) {
              emit("request", {
                requestId: id,
                ...(model ? { model } : {}),
                ...(thinkingEffort ? { thinkingEffort } : {})
              });
            }
          })
          .catch(() => {});

        this.addEventListener(
          "loadend",
          () => {
            try {
              if (!this.responseType || this.responseType === "text") {
                scanWholeText(this.responseText, id);
              }
            } catch {
              // Response may be binary or inaccessible.
            }
            closeConversation(id);
          },
          { once: true }
        );
      } else if (telemetry) {
        bodyToText(body)
          .then((text) => scanWholeText(text, telemetryRequestId()))
          .catch(() => {});
      }

      return nativeSend.apply(this, arguments);
    };
  }

  function wrapBeacon() {
    if (!navigator.sendBeacon) return;

    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    try {
      navigator.sendBeacon = function routeCheckerBeacon(url, data) {
        if (isTelemetry(url, "POST")) {
          bodyToText(data)
            .then((text) => scanWholeText(text, telemetryRequestId()))
            .catch(() => {});
        }
        return nativeBeacon(url, data);
      };
    } catch {
      // Some browsers expose a non-writable sendBeacon.
    }
  }

  wrapFetch();
  wrapXHR();
  wrapBeacon();
})();
