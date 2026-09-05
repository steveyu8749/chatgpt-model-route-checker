const test = require("node:test");
const assert = require("node:assert/strict");

const verdict = require("../content/verdict.js");

test("exactly equal model slugs are a confirmed match", () => {
  const result = verdict.classify({
    requestModel: "gpt-example",
    serverModel: "GPT-EXAMPLE",
    complete: true
  });

  assert.equal(result.status, verdict.STATUS.MATCH);
  assert.match(result.reason, /完全一致/);
});

test("an explicitly verified equivalent mapping is directional", () => {
  const rules = {
    equivalent: [["product-model", "product-model-routing-1"]]
  };

  const forward = verdict.classify(
    {
      requestModel: "product-model",
      serverModel: "product-model-routing-1",
      complete: true
    },
    { rules }
  );
  const reverse = verdict.classify(
    {
      requestModel: "product-model-routing-1",
      serverModel: "product-model",
      complete: true
    },
    { rules }
  );

  assert.equal(forward.status, verdict.STATUS.MATCH);
  assert.equal(reverse.status, verdict.STATUS.REVIEW);
});

test("a verified equivalent mapping with conflicting auxiliary evidence is review", () => {
  const result = verdict.classify(
    {
      requestModel: "product-model",
      serverModel: "product-model-routing-1",
      assistantModel: "product-model-other",
      complete: true
    },
    {
      rules: {
        equivalent: [["product-model", "product-model-routing-1"]]
      }
    }
  );

  assert.equal(result.status, verdict.STATUS.REVIEW);
  assert.match(result.reason, /辅助模型字段.*serverModel/);
});

test("an explicitly verified incompatible mapping is directional", () => {
  const rules = {
    incompatible: [["product-a", "product-b"]]
  };

  const forward = verdict.classify(
    {
      requestModel: "product-a",
      serverModel: "product-b",
      complete: true
    },
    { rules }
  );
  const reverse = verdict.classify(
    {
      requestModel: "product-b",
      serverModel: "product-a",
      complete: true
    },
    { rules }
  );

  assert.equal(forward.status, verdict.STATUS.MISMATCH);
  assert.equal(reverse.status, verdict.STATUS.REVIEW);
});

test("an unknown mapping is never guessed from a shared-looking family", () => {
  const result = verdict.classify({
    requestModel: "gpt-5.6",
    serverModel: "gpt-5.6-sol",
    resolvedModel: "gpt-5.6-sol",
    assistantModel: "gpt-5.6-sol",
    complete: true
  });

  assert.equal(result.status, verdict.STATUS.REVIEW);
  assert.match(result.reason, /未配置|未确认/);
});

test("missing server metadata is checking before stream completion", () => {
  const result = verdict.classify({
    requestModel: "gpt-example",
    serverModel: null,
    complete: false
  });

  assert.equal(result.status, verdict.STATUS.CHECKING);
  assert.match(result.reason, /服务端/);
});

test("missing key fields become unavailable after the response ends", () => {
  const noRequest = verdict.classify({
    requestModel: null,
    serverModel: "gpt-example",
    complete: true
  });
  const noServer = verdict.classify({
    requestModel: "gpt-example",
    serverModel: null,
    complete: true
  });

  assert.equal(noRequest.status, verdict.STATUS.UNAVAILABLE);
  assert.equal(noServer.status, verdict.STATUS.UNAVAILABLE);
});

test("conflicting auxiliary fields remain review, not mismatch", () => {
  const result = verdict.classify({
    requestModel: "product-a",
    serverModel: "product-b",
    assistantModel: "product-b",
    resolvedModel: "product-c",
    domModel: "product-b",
    complete: true
  });

  assert.equal(result.status, verdict.STATUS.REVIEW);
  assert.match(result.reason, /辅助模型字段.*彼此不一致/);
});

test("one auxiliary value that differs from serverModel is a conflict", () => {
  const result = verdict.classify({
    requestModel: "product-a",
    serverModel: "product-b",
    assistantModel: "product-c",
    complete: true
  });

  assert.equal(result.status, verdict.STATUS.REVIEW);
  assert.match(result.reason, /与 serverModel 不同/);
});

test("equal primary fields become review when an auxiliary field disagrees", () => {
  const result = verdict.classify({
    requestModel: "product-a",
    serverModel: "product-a",
    resolvedModel: "product-b",
    complete: true
  });

  assert.equal(result.status, verdict.STATUS.REVIEW);
  assert.match(result.reason, /主字段一致/);
});

test("equal primary fields remain a match when auxiliary fields are absent", () => {
  const result = verdict.classify({
    requestModel: "product-a",
    serverModel: "product-a",
    complete: true
  });

  assert.equal(result.status, verdict.STATUS.MATCH);
});

test("a red result requires an explicit incompatible pair", () => {
  const result = verdict.classify(
    {
      requestModel: "product-a",
      serverModel: "product-b",
      assistantModel: "product-b",
      resolvedModel: "product-b",
      complete: true
    },
    {
      rules: {
        incompatible: [{ request: "product-a", server: "product-b" }]
      }
    }
  );

  assert.equal(result.status, verdict.STATUS.MISMATCH);
  assert.match(result.reason, /不兼容/);
});

test("default rules contain no invented model mappings", () => {
  assert.deepEqual(global.CHATGPT_ROUTE_CHECKER_RULES, undefined);
  // The browser-side file is checked separately; this assertion documents
  // that the pure engine does not silently carry an allowlist.
  const unknown = verdict.classify({
    requestModel: "gpt-5.6",
    serverModel: "gpt-5.6-sol",
    complete: true
  });
  assert.equal(unknown.status, verdict.STATUS.REVIEW);
});

test("unavailable reasons identify a missing request separately", () => {
  const noRequest = verdict.classify({ complete: true });
  const noModel = verdict.classify({
    requestCaptured: true,
    requestModel: null,
    serverModel: null,
    complete: true
  });

  assert.equal(
    noRequest.unavailableReason,
    verdict.UNAVAILABLE_REASONS.NO_REQUEST
  );
  assert.match(noRequest.reason, /未捕获.*请求/);
  assert.equal(
    noModel.unavailableReason,
    verdict.UNAVAILABLE_REASONS.REQUEST_MODEL_MISSING
  );
  assert.match(noModel.reason, /没有 request\.model/);
});

test("unavailable reasons identify response stages", () => {
  const noResponse = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: false,
    responseEndReason: "fetch-error",
    complete: true
  });
  const noFields = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: true,
    responseEnded: true,
    responseEndReason: "completed",
    complete: true
  });
  const interrupted = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: true,
    responseEnded: true,
    responseEndReason: "read-error",
    complete: true
  });
  const unsupported = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: true,
    responseEnded: true,
    responseEndReason: "completed",
    responseUnsupported: true,
    complete: true
  });

  assert.equal(
    noResponse.unavailableReason,
    verdict.UNAVAILABLE_REASONS.RESPONSE_NOT_CAPTURED
  );
  assert.equal(
    noFields.unavailableReason,
    verdict.UNAVAILABLE_REASONS.RESPONSE_NO_FIELDS
  );
  assert.equal(
    interrupted.unavailableReason,
    verdict.UNAVAILABLE_REASONS.RESPONSE_INTERRUPTED
  );
  assert.equal(
    unsupported.unavailableReason,
    verdict.UNAVAILABLE_REASONS.UNSUPPORTED_RESPONSE
  );
});

test("checking reason follows the current request lifecycle stage", () => {
  const waitingResponse = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: false,
    complete: false
  });
  const waitingMetadata = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: true,
    responseEnded: false,
    complete: false
  });
  const waitingTelemetry = verdict.classify({
    requestCaptured: true,
    requestModel: "gpt-example",
    responseStarted: true,
    responseEnded: true,
    complete: false
  });

  assert.match(waitingResponse.reason, /等待 ChatGPT 响应/);
  assert.match(waitingMetadata.reason, /服务端模型/);
  assert.match(waitingTelemetry.reason, /延迟.*元数据/);
});
