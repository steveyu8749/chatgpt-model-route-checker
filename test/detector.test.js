const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const detectorSource = fs.readFileSync(
  path.join(__dirname, "..", "content", "detector.js"),
  "utf8"
);
const timingSource = fs.readFileSync(
  path.join(__dirname, "..", "content", "timing.js"),
  "utf8"
);

function makeContext(responseText, fetchImpl, options = {}) {
  const messages = [];
  const listeners = new Map();
  const window = {
    location: {
      origin: "https://chatgpt.com",
      href: "https://chatgpt.com/"
    },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) || []) {
        callback.call(window, event);
      }
    },
    postMessage(message) {
      messages.push(message);
    },
    fetch: fetchImpl || (async () => new Response(responseText, {
      headers: { "content-type": "text/event-stream" }
    }))
  };

  const context = {
    window,
    navigator: {},
    URL,
    Request,
    Response,
    ReadableStream,
    Blob,
    URLSearchParams,
    ArrayBuffer,
    TextDecoder,
    TextEncoder,
    WeakSet,
    setTimeout,
    clearTimeout,
    Date: options.clock
      ? { now: () => options.clock.now }
      : Date,
    console
  };

  // Browser globals referenced without `window.` in MAIN-world code.
  context.XMLHttpRequest = options.XMLHttpRequest;
  window.XMLHttpRequest = options.XMLHttpRequest;
  window.navigator = context.navigator;
  context.globalThis = context;
  if (!options.omitTiming) {
    vm.runInNewContext(timingSource, context, { filename: "timing.js" });
  }
  if (options.timingOverride) {
    window.ChatGPTRouteTiming = options.timingOverride;
  }
  vm.runInNewContext(detectorSource, context, { filename: "detector.js" });
  return { window, messages, context };
}

test("fetch bridge emits model evidence without forwarding message content", async () => {
  const responseText = [
    `data: ${JSON.stringify({
      type: "server_ste_metadata",
      metadata: {
        model_slug: "gpt-test"
      }
    })}`,
    "",
    `data: ${JSON.stringify({
      message: {
        author: { role: "assistant" },
        metadata: { model_slug: "gpt-test" },
        content: { parts: ["PRIVATE_ASSISTANT_TEXT_SHOULD_NOT_LEAK"] }
      }
    })}`,
    "",
    "data: [DONE]",
    ""
  ].join("\n");

  const { window, messages } = makeContext(responseText);
  await window.fetch(
    "https://chatgpt.com/backend-api/f/conversation",
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-test",
        thinking_effort: "medium",
        messages: [{ content: "PRIVATE_USER_TEXT_SHOULD_NOT_LEAK" }]
      })
    }
  );

  // Let the response clone reader and Request-body microtasks finish.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(serialized, /PRIVATE_(?:USER|ASSISTANT)_TEXT_SHOULD_NOT_LEAK/);
  assert.ok(messages.some((message) => message.type === "request"));
  assert.ok(messages.some((message) => message.type === "server-model"));
  assert.ok(messages.some((message) => message.type === "assistant-model"));
  assert.ok(messages.some((message) => message.type === "response-end"));
  assert.equal(
    messages.find((message) => message.type === "request").model,
    "gpt-test"
  );
  assert.equal(
    messages.find((message) => message.type === "request").thinkingEffort,
    "medium"
  );
  const responseStart = messages.find(
    (message) => message.type === "response-start"
  );
  const responseEnd = messages.find(
    (message) => message.type === "response-end"
  );
  assert.equal(responseStart.responseFormat, "sse");
  assert.equal(responseEnd.responseStarted, true);
  assert.equal(responseEnd.responseFormat, "sse");
  assert.ok(responseEnd.payloadCount >= 2);
  assert.equal(responseEnd.responseUnsupported, false);
});

test("missing timing policy uses the fifteen-second fallback and keeps the bridge active", async () => {
  const responseText = `data: ${JSON.stringify({
    server_ste_metadata: { model_slug: "gpt-timing-fallback" }
  })}\n\ndata: [DONE]\n\n`;
  const { window, messages } = makeContext(responseText, null, {
    omitTiming: true
  });

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-timing-fallback" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(messages.some((message) => message.type === "request"));
  assert.ok(messages.some((message) => message.type === "server-model"));
  assert.ok(messages.some((message) => message.type === "response-end"));
  assert.equal(
    messages.find((message) => message.type === "server-model").value,
    "gpt-timing-fallback"
  );
});

test("malformed timing policy falls back without disabling request capture", async () => {
  const responseText = `data: ${JSON.stringify({
    server_ste_metadata: { model_slug: "gpt-timing-malformed" }
  })}\n\ndata: [DONE]\n\n`;
  const timingOverride = {};
  Object.defineProperty(timingOverride, "TELEMETRY_ASSOCIATION_WINDOW_MS", {
    get() {
      throw new Error("timing policy unavailable");
    }
  });
  const { window, messages } = makeContext(responseText, null, {
    timingOverride
  });

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-timing-malformed" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(messages.some((message) => message.type === "request"));
  assert.ok(messages.some((message) => message.type === "server-model"));
});

test("a non-fifteen-second timing value is treated as malformed", async () => {
  const responseText = `data: ${JSON.stringify({
    server_ste_metadata: { model_slug: "gpt-timing-value" }
  })}\n\ndata: [DONE]\n\n`;
  const { window, messages } = makeContext(responseText, null, {
    timingOverride: { TELEMETRY_ASSOCIATION_WINDOW_MS: 7000 }
  });

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-timing-value" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(messages.some((message) => message.type === "server-model"));
});

test("isolated pings receive a bounded detector health response", () => {
  const { window, messages } = makeContext("{}");
  window.dispatchEvent({
    type: "message",
    source: window,
    origin: window.location.origin,
    data: {
      channel: "__CHATGPT_MODEL_ROUTE_CHECKER_V1__",
      version: 1,
      type: "detector-ping"
    }
  });

  const pong = messages.find((message) => message.type === "detector-pong");
  assert.ok(pong);
  assert.deepEqual(Object.keys(pong.health).sort(), [
    "beacon",
    "detectorVersion",
    "fetch",
    "telemetry",
    "xhr"
  ]);
  assert.equal(pong.health.detectorVersion, "1.1.4");
  assert.equal(pong.health.fetch, "installed");
  assert.equal(pong.health.xhr, "unavailable");
  assert.equal(pong.health.beacon, "unavailable");
  assert.deepEqual(JSON.parse(JSON.stringify(pong.health.telemetry)), {
    observed: 0,
    readable: 0,
    associated: 0,
    modelFound: 0,
    droppedNoCandidate: 0,
    droppedAmbiguous: 0,
    droppedExpired: 0
  });
  assert.doesNotMatch(JSON.stringify(pong), /url|requestId|messages|content|body/i);
});

test("health reports a later fetch overwrite without rewrapping it", () => {
  const { window, messages } = makeContext("{}");
  const replacement = function replacementFetch() {
    return Promise.resolve(new Response("{}"));
  };
  window.fetch = replacement;
  window.dispatchEvent({
    type: "message",
    source: window,
    origin: window.location.origin,
    data: {
      channel: "__CHATGPT_MODEL_ROUTE_CHECKER_V1__",
      version: 1,
      type: "detector-ping"
    }
  });

  const pong = messages.find((message) => message.type === "detector-pong");
  assert.equal(pong.health.fetch, "overwritten");
  assert.equal(window.fetch, replacement);
});

test("long responses emit throttled progress snapshots without response text", async () => {
  const chunks = [
    `data: ${JSON.stringify({ type: "progress-only", value: "ignored" })}\n\n`,
    `data: ${JSON.stringify({ server_ste_metadata: { model_slug: "gpt-progress" } })}\n\n`
  ];
  const clock = { now: 0 };
  let index = 0;
  const response = {
    headers: { get: () => "text/event-stream" },
    clone() {
      return {
        headers: this.headers,
        body: {
          getReader() {
            return {
              async read() {
                if (index >= chunks.length) return { done: true };
                // Advance the detector's injected clock without making the
                // test wait for real time. Each chunk is more than the 1 s
                // production throttle interval apart.
                clock.now += 1001;
                return { done: false, value: chunks[index++] };
              }
            };
          }
        }
      };
    }
  };
  const { window, messages } = makeContext("", async () => response, { clock });

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-progress" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const progress = messages.filter((message) => message.type === "response-progress");
  assert.ok(progress.length >= 2);
  for (const message of progress) {
    assert.ok(message.requestId);
    assert.ok(message.eventCount <= 100000);
    assert.ok(message.payloadCount <= 100000);
    assert.ok(message.byteCount <= 2 * 1024 * 1024);
    assert.equal(Object.prototype.hasOwnProperty.call(message, "text"), false);
    assert.doesNotMatch(JSON.stringify(message), /progress-only|ignored/);
  }
});

test("non-ChatGPT URLs are not intercepted", async () => {
  const { window, messages } = makeContext("{}");
  await window.fetch("https://example.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "not-captured" })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    messages.filter((message) => message.type !== "detector-ready"),
    []
  );
});

test("a rejected native fetch closes the turn while preserving rejection", async () => {
  const nativeError = new Error("native fetch failed");
  const { window, messages } = makeContext("", async () => {
    throw nativeError;
  });

  await assert.rejects(
    () => window.fetch("https://chatgpt.com/backend-api/f/conversation", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-rejected" })
    }),
    (error) => error === nativeError
  );

  assert.ok(messages.some((message) => message.type === "request"));
  const end = messages.find((message) => message.type === "response-end");
  assert.equal(end.endReason, "fetch-error");
  assert.equal(end.responseStarted, false);
});

test("ordinary JSON responses and conversation path variants are detected", async () => {
  const response = new Response(
    '{\n  "server_ste_metadata": { "model_slug": "gpt-json" },\n\n  "resolved_model_slug": "gpt-json"\n}',
    { headers: { "content-type": "application/json" } }
  );
  const { window, messages } = makeContext("", async () => response);

  await window.fetch(
    "https://chatgpt.com/backend-api/conversation/continue?stream=1",
    {
      method: "POST",
      body: JSON.stringify({ model: "gpt-json" })
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  const start = messages.find((message) => message.type === "response-start");
  const end = messages.find((message) => message.type === "response-end");
  assert.equal(start.responseFormat, "json");
  assert.equal(end.responseFormat, "json");
  assert.equal(end.responseStarted, true);
  assert.equal(end.responseUnsupported, false);
  assert.equal(end.parseErrorCount, 0);
  assert.equal(
    messages.find((message) => message.type === "server-model").value,
    "gpt-json"
  );
});

test("XHR JSON responses are captured with the same per-request evidence", async () => {
  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.readyState = 0;
      this.status = 200;
      this.responseType = "";
      this.responseText = JSON.stringify({
        server_ste_metadata: { model_slug: "gpt-xhr" }
      });
    }

    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) || [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }

    dispatch(type) {
      for (const callback of this.listeners.get(type) || []) callback.call(this);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    send() {
      this.readyState = 2;
      this.dispatch("readystatechange");
      this.readyState = 4;
      this.dispatch("readystatechange");
      this.dispatch("loadend");
    }
  }

  const { context, messages } = makeContext("", null, {
    XMLHttpRequest: FakeXMLHttpRequest
  });
  const xhr = new context.XMLHttpRequest();
  xhr.open(
    "POST",
    "https://chatgpt.com/backend-api/f/conversation/regenerate"
  );
  xhr.send(JSON.stringify({ model: "gpt-xhr" }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(messages.some((message) => message.type === "request"));
  assert.ok(messages.some((message) => message.type === "response-start"));
  assert.equal(
    messages.find((message) => message.type === "server-model").value,
    "gpt-xhr"
  );
  assert.equal(
    messages.find((message) => message.type === "response-end").endReason,
    "completed"
  );
});

test("a stream read failure reports an interrupted response", async () => {
  const { window, messages } = makeContext("", async () => ({
    headers: { get: () => "text/event-stream" },
    clone() {
      return {
        headers: this.headers,
        body: {
          getReader() {
            return {
              read() {
                return Promise.reject(new Error("stream interrupted"));
              }
            };
          }
        }
      };
    }
  }));

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-interrupted" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const end = messages.find((message) => message.type === "response-end");
  assert.equal(end.endReason, "read-error");
  assert.equal(end.responseStarted, true);
});

test("a consumed response is reported as an interrupted received response", async () => {
  const { window, messages } = makeContext("", async () => ({
    headers: { get: () => "text/event-stream" },
    clone() {
      throw new Error("body already used");
    }
  }));

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-consumed" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const start = messages.find((message) => message.type === "response-start");
  const end = messages.find((message) => message.type === "response-end");
  assert.ok(start);
  assert.equal(end.endReason, "read-error");
  assert.equal(end.responseStarted, true);
});

test("an unrecognized non-empty response is reported as unsupported format", async () => {
  const response = new Response("not-json-or-sse", {
    headers: { "content-type": "text/plain" }
  });
  const { window, messages } = makeContext("", async () => response);
  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-unsupported" })
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const end = messages.find((message) => message.type === "response-end");
  assert.equal(end.responseStarted, true);
  assert.equal(end.responseFormat, "unknown");
  assert.equal(end.responseUnsupported, true);
  assert.equal(end.payloadCount, 0);
  assert.ok(end.parseErrorCount > 0);
});

test("incremental SSE chunks split inside JSON lines still emit all model fields", async () => {
  const chunks = [
    'data: {"type":"server_ste_metadata","metadata":{"model_',
    'slug":"gpt-stream"}}\n\ndata: {"message":{"author":{"role":"assis',
    'tant"},"metadata":{"model_slug":"gpt-stream"}}}\n\ndata: [DONE]\n\n'
  ];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
  const { window, messages } = makeContext("", async () => response);

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-stream" })
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(
    messages.find((message) => message.type === "server-model").value,
    "gpt-stream"
  );
  assert.equal(
    messages.find((message) => message.type === "assistant-model").value,
    "gpt-stream"
  );
  assert.equal(
    messages.find((message) => message.type === "response-end").parseErrorCount,
    0
  );
  assert.ok(messages.some((message) => message.type === "response-end"));
});

test("metadata nesting, arrays, event fields, and bare-CR separators are supported", async () => {
  const responseText = [
    "event: server_ste_metadata\r",
    `data: ${JSON.stringify({
      type: "server_ste_metadata",
      model_slug: "gpt-direct"
    })}\r`,
    "event: server_ste_metadata\r",
    `data: ${JSON.stringify({
      metadata: {
        server_ste_metadata: { model_slug: "gpt-metadata-nested" }
      }
    })}\r`,
    `data: ${JSON.stringify({
      message: {
        metadata: {
          server_ste_metadata: { model_slug: "gpt-message-nested" }
        }
      }
    })}\r`,
    `data: ${JSON.stringify([
      { server_ste_metadata: { model_slug: "gpt-array" } }
    ])}\r`,
    "\r"
  ].join("");

  const { window, messages } = makeContext(responseText);
  await window.fetch("https://chatgpt.com/backend-api/conversation/", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-direct" })
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const serverModels = messages
    .filter((message) => message.type === "server-model")
    .map((message) => message.value);
  for (const expected of [
    "gpt-direct",
    "gpt-metadata-nested",
    "gpt-message-nested",
    "gpt-array"
  ]) {
    assert.ok(serverModels.includes(expected), `missing ${expected}`);
  }
  assert.ok(messages.some((message) => message.type === "response-end"));
});

test("telemetry is associated only when one recent conversation is unambiguous", async () => {
  const { window, messages } = makeContext("{}");
  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-telemetry" })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: JSON.stringify({
      metadata: {
        server_ste_metadata: { model_slug: "gpt-telemetry" }
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const request = messages.find((message) => message.type === "request");
  const telemetryModel = messages.find(
    (message) => message.type === "server-model"
  );
  assert.ok(request);
  assert.ok(telemetryModel);
  assert.equal(telemetryModel.requestId, request.requestId);
  const observation = messages.find(
    (message) => message.type === "telemetry-observation"
  );
  assert.equal(observation.requestId, request.requestId);
  assert.equal(observation.readable, true);
  assert.equal(observation.modelFound, true);
  const health = messages
    .filter((message) => message.type === "detector-telemetry")
    .at(-1).health.telemetry;
  assert.equal(health.observed, 1);
  assert.equal(health.associated, 1);
  assert.equal(health.modelFound, 1);
});

test("unreadable telemetry without a candidate is counted without leaking data", async () => {
  const { window, messages } = makeContext("{}");
  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: ""
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const health = messages
    .filter((message) => message.type === "detector-telemetry")
    .at(-1).health.telemetry;
  assert.equal(health.observed, 1);
  assert.equal(health.readable, 0);
  assert.equal(health.associated, 0);
  assert.equal(health.droppedNoCandidate, 1);
  assert.doesNotMatch(JSON.stringify(messages), /https:\/\/chatgpt\.com\/ces/);
});

test("ordinary telemetry metadata.model_slug is not promoted to server evidence", async () => {
  const { window, messages } = makeContext("{}");
  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-ordinary-metadata" })
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: JSON.stringify({ metadata: { model_slug: "gpt-ordinary-metadata" } })
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(
    messages.some((message) => message.type === "server-model"),
    false
  );
  const observation = messages.find(
    (message) => message.type === "telemetry-observation"
  );
  assert.equal(observation.readable, true);
  assert.equal(observation.modelFound, false);
});

test("ambiguous telemetry is dropped instead of entering either recent turn", async () => {
  const { window, messages } = makeContext("{}");
  const conversationUrl = "https://chatgpt.com/backend-api/f/conversation";

  await window.fetch(conversationUrl, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-first" })
  });
  await window.fetch(conversationUrl, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-second" })
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: JSON.stringify({
      metadata: {
        server_ste_metadata: { model_slug: "telemetry-must-not-attach" }
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(
    messages
      .filter((message) => message.type === "server-model")
      .map((message) => message.value),
    []
  );
  const health = messages
    .filter((message) => message.type === "detector-telemetry")
    .at(-1).health.telemetry;
  assert.equal(health.droppedAmbiguous, 1);
});

test("telemetry remains attributable for fifteen seconds after response end", async () => {
  const clock = { now: 1000 };
  const { window, messages } = makeContext("{}", null, { clock });
  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-late-telemetry" })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock.now = 12000;

  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: JSON.stringify({
      server_ste_metadata: { model_slug: "gpt-late-telemetry" }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const observation = messages.find(
    (message) => message.type === "telemetry-observation"
  );
  assert.equal(observation.modelFound, true);
  assert.equal(observation.delayMs, 11000);
});

test("telemetry after the association window is diagnosed as expired", async () => {
  const clock = { now: 1000 };
  const { window, messages } = makeContext("{}", null, { clock });
  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-expired-telemetry" })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock.now = 17001;

  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: JSON.stringify({
      server_ste_metadata: { model_slug: "must-not-attach" }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(
    messages.some((message) => message.value === "must-not-attach"),
    false
  );
  const health = messages
    .filter((message) => message.type === "detector-telemetry")
    .at(-1).health.telemetry;
  assert.equal(health.droppedExpired, 1);
});

test("fake model JSON inside assistant content is ignored while real metadata is retained", async () => {
  const responseText = `data: ${JSON.stringify({
    message: {
      author: { role: "assistant" },
      metadata: { model_slug: "gpt-real-assistant" },
      content: {
        parts: [
          '{"server_ste_metadata":{"model_slug":"fake-server"}}',
          '{"resolved_model_slug":"fake-resolved"}'
        ]
      }
    }
  })}\n\ndata: [DONE]\n\n`;
  const { window, messages } = makeContext(responseText);

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-real-assistant" })
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(
    messages.find((message) => message.type === "assistant-model").value,
    "gpt-real-assistant"
  );
  assert.equal(
    messages.some((message) => message.type === "server-model"),
    false
  );
  assert.equal(
    messages.some((message) => message.type === "resolved-model"),
    false
  );
});

test("a long active conversation remains eligible for unambiguous telemetry", async () => {
  const clock = { now: 1000 };
  const activeResponse = {
    clone() {
      return {
        body: {
          getReader() {
            return { read: () => new Promise(() => {}) };
          }
        }
      };
    }
  };
  const { window, messages } = makeContext(
    "",
    async () => activeResponse,
    { clock }
  );

  await window.fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-long-running" })
  });
  clock.now += 4 * 60 * 1000;

  await window.fetch("https://chatgpt.com/ces/v1/telemetry/intake", {
    method: "POST",
    body: JSON.stringify({
      metadata: {
        server_ste_metadata: { model_slug: "gpt-long-running" }
      }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const request = messages.find((message) => message.type === "request");
  const telemetryModel = messages.find(
    (message) => message.type === "server-model"
  );
  assert.ok(request);
  assert.ok(telemetryModel);
  assert.equal(telemetryModel.requestId, request.requestId);
});

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const conversationUrl = 'https://chatgpt.com/backend-api/f/conversation';
const telemetryUrl = 'https://chatgpt.com/ces/v1/telemetry/intake';
const requestOptions = model => ({ method: 'POST', body: JSON.stringify({ model }) });
const telemetryOptions = model => ({ method: 'POST', body: JSON.stringify({ server_ste_metadata: { model_slug: model } }) });

test('settled turns still prevent repeated telemetry from entering a newer turn', async () => {
  const { window, messages } = makeContext('{}');
  await window.fetch(conversationUrl, requestOptions('model-A')); await settle();
  await window.fetch(telemetryUrl, telemetryOptions('model-A')); await settle();
  await window.fetch(conversationUrl, requestOptions('model-B')); await settle();
  await window.fetch(telemetryUrl, telemetryOptions('model-A')); await settle();
  const b = messages.filter(m => m.type === 'request').at(-1).requestId;
  assert.equal(messages.some(m => m.type === 'server-model' && m.requestId === b), false);
  assert.equal(messages.filter(m => m.type === 'detector-telemetry').at(-1).health.telemetry.droppedAmbiguous, 1);
});

test('slow telemetry body decoding cannot retarget an expired turn to a new turn', async () => {
  const clock = { now: 1000 };
  const { window, messages } = makeContext('{}', null, { clock });
  await window.fetch(conversationUrl, requestOptions('model-A')); await settle();
  let release;
  const body = new Blob(['ignored']);
  body.text = () => new Promise(resolve => { release = resolve; });
  await window.fetch(telemetryUrl, { method: 'POST', body });
  clock.now = 40000;
  await window.fetch(conversationUrl, requestOptions('model-B')); await settle();
  release(telemetryOptions('model-A').body); await settle();
  assert.equal(messages.some(m => m.type === 'server-model'), false);
});

test('URL objects and Request inputs capture the same conversation', async () => {
  const { window, messages } = makeContext('{}');
  await window.fetch(new URL(conversationUrl), requestOptions('model-url'));
  await window.fetch(new Request(conversationUrl, requestOptions('model-request')));
  await settle();
  const models = messages.filter(m => m.type === 'request').map(m => m.model);
  assert.ok(models.includes('model-url'));
  assert.ok(models.includes('model-request'));
});

test('malformed completed SSE event is counted beside valid events', async () => {
  const { window, messages } = makeContext('data: {"ok":true}\n\ndata: {broken}\n\ndata: [DONE]\n\n');
  await window.fetch(conversationUrl, requestOptions('model-A')); await settle();
  const end = messages.find(m => m.type === 'response-end');
  assert.equal(end.parseErrorCount, 1);
  assert.equal(end.payloadCount, 1);
});

test('DONE closes detection without awaiting EOF or clone cancellation', async () => {
  let reads = 0, cancelled = 0, released = 0;
  const response = { clone: () => ({ body: { getReader: () => ({
    read: () => ++reads === 1
      ? Promise.resolve({ value: 'data: [DONE]\n\n', done: false })
      : new Promise(() => {}),
    cancel: () => { cancelled++; return new Promise(() => {}); },
    releaseLock: () => { released++; }
  }) } }) };
  const { window, messages } = makeContext('', async () => response);
  assert.equal(await window.fetch(conversationUrl, requestOptions('model-A')), response);
  await settle();
  assert.equal(messages.filter(m => m.type === 'response-end').length, 1);
  assert.equal(reads, 1); assert.equal(cancelled, 1); assert.equal(released, 1);
});

test('finishing the cloned branch leaves the page response readable', async () => {
  const text = 'data: {"ok":true}\n\ndata: [DONE]\n\n';
  const { window, messages } = makeContext(text);
  const response = await window.fetch(conversationUrl, requestOptions('model-A'));
  assert.equal(await response.text(), text);
  await settle();
  assert.equal(messages.filter(m => m.type === 'response-end').length, 1);
});

test('XHR progress is reported during transfer and listeners are cleaned at loadend', async () => {
  class XHR extends EventTarget {
    open() {}
    send() {}
  }
  const clock = { now: 1000 };
  const { context, messages } = makeContext('', null, { XMLHttpRequest: XHR, clock });
  const xhr = new context.XMLHttpRequest();
  xhr.open('POST', conversationUrl); xhr.send('{"model":"model-xhr"}');
  const progress = () => {
    const event = new Event('progress'); event.loaded = 123;
    xhr.dispatchEvent(event);
  };
  progress();
  assert.equal(messages.find(m => m.type === 'response-progress').byteCount, 123);
  xhr.responseText = '{}'; xhr.status = 200;
  xhr.dispatchEvent(new Event('loadend')); await settle();
  const count = messages.filter(m => m.type === 'response-progress').length;
  clock.now += 2000; progress();
  assert.equal(messages.filter(m => m.type === 'response-progress').length, count);
});
