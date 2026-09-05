/* global window, navigator, XMLHttpRequest, Request, Blob, URLSearchParams, TextEncoder */
/*
 * MAIN-world bridge.
 *
 * This file deliberately forwards only model-related scalar values plus
 * bounded parser/lifecycle counters. It never forwards request messages,
 * response text, attachments, URLs, headers, or account information to the
 * isolated content script.
 */
(function installDetector() {
  "use strict";

  const CHANNEL = "__CHATGPT_MODEL_ROUTE_CHECKER_V1__";
  const MAX_VALUE_LENGTH = 200;
  const MAX_SCAN_DEPTH = 18;
  const MAX_SCAN_NODES = 12000;
  const STREAM_BUFFER_LIMIT = 2 * 1024 * 1024;
  const TELEMETRY_ASSOCIATION_WINDOW_MS = 6000;
  const ACTIVE_RECORD_RETENTION_MS = 5 * 60 * 1000;
  const ENDED_RECORD_RETENTION_MS = 15000;
  const RESPONSE_PROGRESS_INTERVAL_MS = 1000;
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

  function utf8ByteLength(value) {
    if (typeof value !== "string" || !value) return 0;
    try {
      return new TextEncoder().encode(value).byteLength;
    } catch {
      // TextEncoder is available in supported browsers; retain a bounded
      // fallback for unusual host objects and the parser's test doubles.
      return value.length;
    }
  }

  function requestId() {
    sequence += 1;
    return `turn-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function cleanupConversationRecords(now = Date.now()) {
    for (const [id, record] of conversationRecords) {
      const referenceTime =
        record.endedAt || record.lastActivityAt || record.startedAt;
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
      lastActivityAt: now,
      endedAt: null,
      responseStarted: false,
      serverModelSeen: false,
      telemetryEligible: true
    });
  }

  function touchConversation(id) {
    const record = conversationRecords.get(id);
    if (record) record.lastActivityAt = Date.now();
    return record;
  }

  function markResponseStarted(id) {
    const record = touchConversation(id);
    if (record) record.responseStarted = true;
  }

  function markModelField(id, type) {
    const record = touchConversation(id);
    if (record && type === "server-model") {
      record.serverModelSeen = true;
      // Direct response evidence is authoritative. A later telemetry event
      // must not be allowed to overwrite or be associated with this turn.
      record.telemetryEligible = false;
    }
  }

  function endConversation(id, details = {}) {
    const record = conversationRecords.get(id);
    if (record && !record.endedAt) {
      record.endedAt = Date.now();
      record.lastActivityAt = record.endedAt;
      record.endReason = details.endReason || "completed";
      record.responseFormat = details.responseFormat || "unknown";
      record.telemetryEligible = !record.serverModelSeen;
    }
    cleanupConversationRecords();
    return record;
  }

  function telemetryRequestId() {
    const now = Date.now();
    cleanupConversationRecords(now);

    const candidates = [...conversationRecords.entries()].filter(([, record]) => {
      if (!record.telemetryEligible || record.serverModelSeen) return false;
      const referenceTime =
        record.endedAt || record.lastActivityAt || record.startedAt;
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

  function closeConversation(id, details = {}) {
    const record = endConversation(id, details);
    if (!record || record.responseEndEmitted) return;
    record.responseEndEmitted = true;
    emit("response-end", {
      requestId: id,
      endReason: record.endReason || details.endReason || "completed",
      responseFormat: record.responseFormat || details.responseFormat || "unknown",
      responseStarted: Boolean(record.responseStarted),
      ...(details.stats || {})
    });
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

    markModelField(targetRequestId, type);

    emit(type, {
      requestId: targetRequestId,
      value: cleaned
    });
  }

  function inspectObject(
    value,
    requestIdValue,
    depth = 0,
    seen = new WeakSet(),
    budget = { count: 0 }
  ) {
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
          inspectObject(
            JSON.parse(text),
            requestIdValue,
            depth + 1,
            seen,
            budget
          );
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
      inspectObject(
        child,
        requestIdValue,
        depth + 1,
        seen,
        budget
      );
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

  function createResponseStats(formatHint = "unknown") {
    return {
      responseFormat: formatHint,
      payloadCount: 0,
      parseErrorCount: 0,
      eventCount: 0,
      byteCount: 0,
      sawDone: false,
      sawSseField: false,
      sawJson: false
    };
  }

  function parseJSONCandidate(
    text,
    requestIdValue,
    stats,
    options = {}
  ) {
    if (!text || typeof text !== "string") return false;

    let value = text.trim();
    if (!value) return false;
    if (value === "[DONE]") {
      stats.sawDone = true;
      return true;
    }
    if (value.startsWith("data:")) value = value.slice(5).trim();
    if (!value) return false;
    if (value === "[DONE]") {
      stats.sawDone = true;
      return true;
    }

    try {
      inspectObject(JSON.parse(value), requestIdValue, 0, new WeakSet(), {
        count: 0
      });
      stats.payloadCount += 1;
      stats.sawJson = true;
      if (stats.responseFormat === "unknown") stats.responseFormat = "json";
      return true;
    } catch {
      // Incremental SSE and pretty-printed JSON commonly fail to parse until
      // their next chunk/line arrives. Count an error only when the parser is
      // being finalized and the complete buffered candidate still fails.
      if (options.countError) stats.parseErrorCount += 1;
      return false;
    }
  }

  function createStreamParser(
    requestIdValue,
    formatHint = "unknown"
  ) {
    let lineBuffer = "";
    let eventData = [];
    let rawJson = "";
    const stats = createResponseStats(formatHint);

    function finishRawJson(force = false, final = false) {
      if (!rawJson) return;
      const complete = parseJSONCandidate(
        rawJson,
        requestIdValue,
        stats,
        { countError: final }
      );
      if (complete || force) rawJson = "";
    }

    function finishEvent(final = false) {
      if (eventData.length) {
        stats.eventCount += 1;
        parseJSONCandidate(
          eventData.join("\n"),
          requestIdValue,
          stats,
          { countError: final }
        );
        eventData = [];
      }
      // A blank line terminates an SSE event, but it is also valid whitespace
      // inside a pretty-printed JSON response. Keep an unframed JSON buffer
      // until finalization unless an SSE field has actually been observed.
      if (stats.sawSseField || !rawJson) finishRawJson(true, final);
    }

    function processLine(rawLine, final = false) {
      const line = rawLine.trim();
      if (!line) {
        finishEvent(final);
        return;
      }

      // SSE comments and fields which do not carry model data are ignored.
      if (line.startsWith(":")) return;
      if (line.startsWith("event:")) {
        stats.sawSseField = true;
        if (stats.responseFormat === "unknown") stats.responseFormat = "sse";
        // Be tolerant of servers that omit the usual blank line between
        // events: a new event field closes the prior data envelope.
        if (eventData.length) finishEvent(final);
        return;
      }
      if (
        line.startsWith("id:") ||
        line.startsWith("retry:")
      ) {
        stats.sawSseField = true;
        if (stats.responseFormat === "unknown") stats.responseFormat = "sse";
        return;
      }

      if (line.startsWith("data:")) {
        stats.sawSseField = true;
        if (stats.responseFormat === "unknown") stats.responseFormat = "sse";
        finishRawJson(true, final);
        const piece = line.slice(5).trimStart();

        // Parse complete data lines immediately. If a JSON value is split
        // across data lines, retain the pieces and retry after each append.
        if (
          !eventData.length &&
          parseJSONCandidate(piece, requestIdValue, stats)
        ) {
          return;
        }
        eventData.push(piece);
        if (
          parseJSONCandidate(
            eventData.join("\n"),
            requestIdValue,
            stats
          )
        ) {
          eventData = [];
        }
        if (eventData.join("\n").length > STREAM_BUFFER_LIMIT) {
          eventData = [];
        }
        return;
      }

      // A non-SSE JSON response may be pretty-printed, so once a JSON object
      // starts, retain subsequent lines until the complete value parses.
      if (rawJson || line.startsWith("{") || line.startsWith("[")) {
        if (stats.responseFormat === "unknown") stats.responseFormat = "json";
        rawJson = rawJson ? `${rawJson}\n${line}` : line;
        if (parseJSONCandidate(rawJson, requestIdValue, stats)) {
          rawJson = "";
        }
        if (rawJson.length > STREAM_BUFFER_LIMIT) rawJson = "";
      }
    }

    function push(text, final = false) {
      if (typeof text === "string" && text) {
        lineBuffer += text;
        stats.byteCount += utf8ByteLength(text);
      }

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
          processLine(lineBuffer, true);
          lineBuffer = "";
        }
        finishEvent(true);

        // If no SSE field or JSON payload was recognized, the complete
        // non-empty response is unsupported. This catches plain text and
        // malformed scalar responses without treating normal incremental
        // parsing retries as errors.
        if (
          stats.byteCount > 0 &&
          stats.payloadCount === 0 &&
          stats.parseErrorCount === 0 &&
          !stats.sawDone
        ) {
          stats.parseErrorCount = 1;
        }
      }
    }

    return { push, stats };
  }

  function scanWholeText(text, requestIdValue, options = {}) {
    const formatHint = options.formatHint || "unknown";
    if (!text || typeof text !== "string") {
      return createResponseStats(formatHint);
    }

    // Parse a complete JSON response directly first. This also handles
    // pretty-printed JSON that has no line-oriented framing.
    const stats = createResponseStats(formatHint);
    stats.byteCount = utf8ByteLength(text);
    const trimmed = text.trim();
    if (
      text.length <= STREAM_BUFFER_LIMIT &&
      (trimmed.startsWith("{") || trimmed.startsWith("["))
    ) {
      try {
        inspectObject(JSON.parse(trimmed), requestIdValue, 0, new WeakSet(), {
          count: 0
        });
        stats.payloadCount = 1;
        stats.sawJson = true;
        stats.responseFormat = "json";
        return stats;
      } catch {
        // It may be an SSE stream whose complete body is not one JSON value.
        stats.parseErrorCount += 1;
      }
    }

    const parser = createStreamParser(requestIdValue, formatHint);
    parser.push(text, true);
    parser.stats.byteCount = Math.max(parser.stats.byteCount, stats.byteCount);
    return parser.stats;
  }

  function responseFormatHint(response) {
    try {
      const contentType = response && response.headers
        ? String(response.headers.get("content-type") || "").toLowerCase()
        : "";
      if (contentType.includes("text/event-stream")) return "sse";
      if (contentType.includes("application/json")) return "json";
    } catch {
      // Some test doubles and older XHR wrappers do not expose headers.
    }
    return "unknown";
  }

  function compactStats(stats) {
    const source = stats || createResponseStats("unknown");
    return {
      payloadCount: Number.isFinite(source.payloadCount)
        ? Math.min(Math.max(source.payloadCount, 0), 100000)
        : 0,
      parseErrorCount: Number.isFinite(source.parseErrorCount)
        ? Math.min(Math.max(source.parseErrorCount, 0), 100000)
        : 0,
      eventCount: Number.isFinite(source.eventCount)
        ? Math.min(Math.max(source.eventCount, 0), 100000)
        : 0,
      byteCount: Number.isFinite(source.byteCount)
        ? Math.min(Math.max(source.byteCount, 0), STREAM_BUFFER_LIMIT)
        : 0,
      sawDone: Boolean(source.sawDone),
      responseUnsupported: Boolean(
        (source.responseFormat === "unknown" || source.parseErrorCount > 0) &&
          source.byteCount > 0 &&
          source.payloadCount === 0
      )
    };
  }

  function emitResponseProgress(requestIdValue, stats, clock = Date.now) {
    if (!requestIdValue || !stats) return;
    const now = clock();
    const record = conversationRecords.get(requestIdValue);
    if (!record) return;
    // The final snapshot is also rate limited. response-end carries the
    // authoritative final counters, so a second progress event immediately
    // before it is unnecessary and would defeat the throttle.
    if (
      Number.isFinite(record.lastProgressAt) &&
      now - record.lastProgressAt < RESPONSE_PROGRESS_INTERVAL_MS
    ) {
      return;
    }

    record.lastProgressAt = now;
    touchConversation(requestIdValue);
    emit("response-progress", {
      requestId: requestIdValue,
      responseFormat: stats.responseFormat || "unknown",
      ...compactStats(stats)
    });
  }

  function networkFailureReason(error, fallback) {
    try {
      return error && error.name === "AbortError" ? "aborted" : fallback;
    } catch {
      return fallback;
    }
  }

  async function watchStream(response, requestIdValue) {
    const formatHint = responseFormatHint(response);
    let parser = null;
    if (response) {
      markResponseStarted(requestIdValue);
      emit("response-start", {
        requestId: requestIdValue,
        responseFormat: formatHint
      });
    }

    try {
      if (!response || !response.body) {
        const text = response && typeof response.text === "function"
          ? await response.text()
          : "";
        const stats = scanWholeText(text, requestIdValue, { formatHint });
        emitResponseProgress(requestIdValue, stats);
        closeConversation(requestIdValue, {
          endReason: "completed",
          responseFormat: stats.responseFormat || formatHint,
          stats: compactStats(stats)
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      parser = createStreamParser(requestIdValue, formatHint);

      while (true) {
        const result = await reader.read();
        // Keep active records alive for long responses. This timestamp is
        // local bookkeeping only; no response text or chunk is forwarded.
        touchConversation(requestIdValue);
        if (result.done) break;
        parser.push(
          typeof result.value === "string"
            ? result.value
            : decoder.decode(result.value, { stream: true })
        );
        emitResponseProgress(requestIdValue, parser.stats);
      }

      parser.push(decoder.decode(), true);
      emitResponseProgress(requestIdValue, parser.stats);
      closeConversation(requestIdValue, {
        endReason: "completed",
        responseFormat: parser.stats.responseFormat,
        stats: compactStats(parser.stats)
      });
    } catch (error) {
      // Reading a clone can fail if the page cancels/navigation closes it.
      if (parser) emitResponseProgress(requestIdValue, parser.stats);
      closeConversation(requestIdValue, {
        endReason: networkFailureReason(error, "read-error"),
        responseFormat: parser && parser.stats.responseFormat,
        stats: parser && compactStats(parser.stats)
      });
    }
  }

  function methodFor(input, init) {
    return String(
      (init && init.method) ||
        (input && input.method) ||
        "GET"
    ).toUpperCase();
  }

  function xhrResponseFormatHint(xhr) {
    try {
      if (xhr.responseType === "json") return "json";
    } catch {
      // Accessing responseType can fail on an unusual host object.
    }
    return "unknown";
  }

  async function scanXHRResponse(xhr, requestIdValue, formatHint) {
    let responseType = "";
    try {
      responseType = xhr.responseType || "";
    } catch {
      responseType = "";
    }

    if (responseType === "json") {
      const stats = createResponseStats("json");
      try {
        if (xhr.response && typeof xhr.response === "object") {
          inspectObject(xhr.response, requestIdValue);
          stats.payloadCount = 1;
        }
      } catch {
        stats.parseErrorCount = 1;
      }
      return stats;
    }

    if (responseType === "blob" || responseType === "arraybuffer") {
      const text = await bodyToText(xhr.response);
      return scanWholeText(text, requestIdValue, { formatHint });
    }

    let text = "";
    try {
      text = xhr.responseText || "";
    } catch {
      text = "";
    }
    return scanWholeText(text, requestIdValue, { formatHint });
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
          .then((text) => {
            const requestIdValue = telemetryRequestId();
            scanWholeText(text, requestIdValue);
          })
          .catch(() => {});
      }

      let result;
      try {
        result = nativeFetch.apply(this, arguments);
      } catch (error) {
        if (conversation) {
          closeConversation(id, {
            endReason: networkFailureReason(error, "fetch-error")
          });
        }
        throw error;
      }

      if (!conversation) return result;

      return Promise.resolve(result).then(
        (response) => {
          try {
            watchStream(response.clone(), id);
          } catch (error) {
            // The page may have consumed or locked the response before the
            // clone was made. A response did arrive, so report this as an
            // interrupted read rather than as a missing response.
            if (response) {
              markResponseStarted(id);
              emit("response-start", {
                requestId: id,
                responseFormat: responseFormatHint(response)
              });
            }
            closeConversation(id, {
              endReason: networkFailureReason(error, "read-error")
            });
          }
          return response;
        },
        (error) => {
          // Preserve the page's original rejection semantics while closing
          // the detector's turn so its UI cannot remain in "checking".
          closeConversation(id, {
            endReason: networkFailureReason(error, "fetch-error")
          });
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

        let responseStartedEmitted = false;
        const markXHRResponseStarted = () => {
          if (responseStartedEmitted) return;
          responseStartedEmitted = true;
          markResponseStarted(id);
          emit("response-start", {
            requestId: id,
            responseFormat: xhrResponseFormatHint(this)
          });
        };

        this.addEventListener(
          "readystatechange",
          () => {
            try {
              if (this.readyState >= 2) markXHRResponseStarted();
            } catch {
              // Ignore host object access failures.
            }
          }
        );

        this.addEventListener(
          "loadend",
          async () => {
            const responseType = (() => {
              try {
                return this.responseType || "";
              } catch {
                return "";
              }
            })();
            let hasResponse = false;
            try {
              hasResponse = Boolean(
                this.response ||
                this.responseText ||
                this.status >= 200
              );
            } catch {
              hasResponse = false;
            }

            if (hasResponse) markXHRResponseStarted();

            try {
              if (hasResponse) {
                const formatHint = xhrResponseFormatHint(this);
                const stats = await scanXHRResponse(this, id, formatHint);
                emitResponseProgress(id, stats);
                closeConversation(id, {
                  endReason: "completed",
                  responseFormat: stats.responseFormat || formatHint,
                  stats: compactStats(stats)
                });
              } else {
                closeConversation(id, { endReason: "interrupted" });
              }
            } catch {
              // Response may be binary or inaccessible.
              closeConversation(id, { endReason: "read-error" });
            }
          },
          { once: true }
        );
      } else if (telemetry) {
        bodyToText(body)
          .then((text) => {
            const requestIdValue = telemetryRequestId();
            scanWholeText(text, requestIdValue);
          })
          .catch(() => {});
      }

      try {
        return nativeSend.apply(this, arguments);
      } catch (error) {
        if (conversation) closeConversation(id, { endReason: "fetch-error" });
        throw error;
      }
    };
  }

  function wrapBeacon() {
    if (!navigator.sendBeacon) return;

    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    try {
      navigator.sendBeacon = function routeCheckerBeacon(url, data) {
        if (isTelemetry(url, "POST")) {
          bodyToText(data)
            .then((text) => {
              const requestIdValue = telemetryRequestId();
              scanWholeText(text, requestIdValue);
            })
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
