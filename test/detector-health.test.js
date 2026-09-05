const test = require("node:test");
const assert = require("node:assert/strict");
const health = require("../content/detector-health.js");

const validHealth = {
  detectorVersion: "1.1.3",
  fetch: "installed",
  xhr: "overwritten",
  beacon: "unavailable"
};

test("collector health starts connecting, then transitions to connected", () => {
  const state = health.createState();
  assert.deepEqual(state, { status: "connecting", health: null });
  assert.deepEqual(health.accept(state, validHealth), validHealth);
  assert.equal(state.status, "connected");
  assert.deepEqual(state.health, validHealth);
});

test("a missing pong transitions to disconnected, while a later pong can recover", () => {
  const state = health.createState();
  health.timeout(state);
  assert.equal(state.status, "disconnected");
  assert.equal(health.accept(state, validHealth).detectorVersion, "1.1.3");
  assert.equal(state.status, "connected");
});

test("malformed health payloads are rejected without changing connection state", () => {
  const state = health.createState();
  for (const payload of [
    null,
    {},
    { ...validHealth, detectorVersion: "" },
    { ...validHealth, fetch: true },
    { ...validHealth, xhr: "changed" },
    { ...validHealth, beacon: "https://chatgpt.com/private" }
  ]) {
    assert.equal(health.accept(state, payload), null);
    assert.equal(state.status, "connecting");
    assert.equal(state.health, null);
  }
});

test("a timeout cannot downgrade an already connected collector", () => {
  const state = health.createState();
  health.accept(state, validHealth);
  health.timeout(state);
  assert.equal(state.status, "connected");
  assert.deepEqual(state.health, validHealth);
});

test("health normalization is bounded and contains only fixed fields", () => {
  const normalized = health.normalizeHealth({
    ...validHealth,
    detectorVersion: `${validHealth.detectorVersion}\u0000${"x".repeat(100)}`,
    url: "https://chatgpt.com/private",
    requestId: "turn-private",
    messages: "private"
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    "beacon",
    "detectorVersion",
    "fetch",
    "xhr"
  ]);
  assert.ok(normalized.detectorVersion.length <= 40);
  assert.doesNotMatch(JSON.stringify(normalized), /url|requestId|messages/i);
});
