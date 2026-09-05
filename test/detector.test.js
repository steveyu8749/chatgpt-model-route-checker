const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const detectorSource = fs.readFileSync(
  path.join(__dirname, "..", "content", "detector.js"),
  "utf8"
);

function makeContext(responseText, fetchImpl, options = {}) {
  const messages = [];
  const window = {
    location: {
      origin: "https://chatgpt.com",
      href: "https://chatgpt.com/"
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
    WeakSet,
    setTimeout,
    clearTimeout,
    Date: options.clock
      ? { now: () => options.clock.now }
      : Date,
    console
  };

  // Browser globals referenced without `window.` in MAIN-world code.
  context.XMLHttpRequest = undefined;
  context.globalThis = context;
  vm.runInNewContext(detectorSource, context, { filename: "detector.js" });
  return { window, messages };
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
});

test("non-ChatGPT URLs are not intercepted", async () => {
  const { window, messages } = makeContext("{}");
  await window.fetch("https://example.com/backend-api/f/conversation", {
    method: "POST",
    body: JSON.stringify({ model: "not-captured" })
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages, []);
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
  assert.ok(messages.some((message) => message.type === "response-end"));
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
