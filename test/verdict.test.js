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
