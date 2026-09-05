const test = require("node:test");
const assert = require("node:assert/strict");

const turnState = require("../content/turn-state.js");
const verdict = require("../content/verdict.js");

test("a new request becomes current while its duplicate cannot steal a newer turn", () => {
  const store = turnState.createStore({ maxTurns: 4, now: () => 1000 });
  const first = store.beginRequest("first", { model: "model-first" });
  const second = store.beginRequest("second", { model: "model-second" });
  const duplicate = store.beginRequest("first", { model: "model-first" });

  assert.equal(first.isCurrent, true);
  assert.equal(second.isCurrent, true);
  assert.equal(store.currentId(), "second");
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.isCurrent, false);
  assert.equal(store.current().requestModel, "model-second");
});

test("late evidence updates its old turn without changing the current turn", () => {
  const store = turnState.createStore({ maxTurns: 4, now: () => 1000 });
  store.beginRequest("first", { model: "model-first" });
  store.beginRequest("second", { model: "model-second" });

  const oldTurn = store.get("first");
  turnState.addEvidence(oldTurn, "serverModel", "model-first");

  assert.equal(store.currentId(), "second");
  assert.equal(store.current().id, "second");
  assert.equal(oldTurn.serverModel, "model-first");
  assert.equal(store.isCurrent("first"), false);
});

test("repeated identical evidence is deduplicated, while a different value is retained as a conflict", () => {
  const turn = turnState.createTurn("turn-1", 1000);

  const first = turnState.addEvidence(turn, "serverModel", "gpt-test");
  const duplicate = turnState.addEvidence(turn, "serverModel", "GPT-TEST");
  const conflict = turnState.addEvidence(turn, "serverModel", "gpt-other");

  assert.equal(first.added, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.conflict, false);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(turnState.getEvidenceValues(turn, "serverModel"), [
    "gpt-test",
    "gpt-other"
  ]);
  assert.equal(turn.serverModel, "gpt-test");
});

test("primary evidence conflict is review and includes all retained values", () => {
  const turn = turnState.createTurn("turn-1", 1000);
  turnState.captureRequest(turn, { model: "client-a" }, 1000);
  turnState.addEvidence(turn, "serverModel", "server-a", 1001);
  turnState.addEvidence(turn, "serverModel", "server-b", 1002);
  turn.complete = true;

  const result = verdict.classify({
    requestModel: turn.requestModel,
    serverModel: turn.serverModel,
    requestCaptured: turn.requestCaptured,
    complete: turn.complete,
    evidenceValues: turn.evidenceValues,
    evidenceConflicts: turn.evidenceConflicts
  });

  assert.equal(result.status, verdict.STATUS.REVIEW);
  assert.match(result.reason, /主证据字段冲突/);
  assert.match(result.reason, /serverModel=server-a \/ server-b/);
  assert.deepEqual(result.evidenceConflicts.serverModel, [
    "server-a",
    "server-b"
  ]);
});

test("DOM baseline gating accepts only fresh nodes or explicit attribute mutations", () => {
  const turn = turnState.createTurn("turn-1", 1000);
  const baseline = {};
  const fresh = {};
  turn.domBaselineNode = baseline;

  assert.equal(
    turnState.shouldAcceptDomEvidence(turn, fresh, "response-start"),
    false
  );

  turn.responseStarted = true;
  assert.equal(
    turnState.shouldAcceptDomEvidence(turn, baseline, "response-start"),
    false
  );
  assert.equal(
    turnState.shouldAcceptDomEvidence(turn, baseline, "childList"),
    false
  );
  assert.equal(
    turnState.shouldAcceptDomEvidence(turn, baseline, "attribute"),
    true
  );
  assert.equal(
    turnState.shouldAcceptDomEvidence(turn, fresh, "response-start"),
    true
  );
});

test("response lifecycle and timeout transitions are pure and timestamped", () => {
  const turn = turnState.createTurn("turn-1", 1000);
  turnState.captureRequest(turn, { model: "gpt-test" }, 1000);
  turnState.startResponse(turn, "sse", 1100);
  turnState.updateResponseStats(
    turn,
    { eventCount: 2, payloadCount: 1, byteCount: 64 },
    1200
  );

  assert.equal(turn.responseStarted, true);
  assert.equal(turn.responseEnded, false);
  assert.equal(turn.lastActivityAt, 1200);
  assert.equal(turn.responseStats.eventCount, 2);

  turnState.endResponse(
    turn,
    {
      endReason: "completed",
      responseFormat: "sse",
      stats: { eventCount: 3, payloadCount: 2 }
    },
    1300
  );
  assert.equal(turn.responseEnded, true);
  assert.equal(turn.responseEndReason, "completed");
  assert.equal(turn.lastActivityAt, 1300);

  const waiting = turnState.createTurn("turn-2", 2000);
  turnState.captureRequest(waiting, { model: "gpt-waiting" }, 2000);
  turnState.timeout(waiting, "no-response", 32000);
  assert.equal(waiting.responseEnded, true);
  assert.equal(waiting.responseEndReason, "no-response");
  assert.equal(waiting.complete, true);
  assert.equal(waiting.lastActivityAt, 32000);
});

test("evidence retention is bounded", () => {
  const turn = turnState.createTurn("turn-1", 1000);
  for (let i = 0; i < turnState.MAX_EVIDENCE_VALUES + 4; i += 1) {
    turnState.addEvidence(turn, "serverModel", `model-${i}`, 1000 + i);
  }

  assert.equal(
    turnState.getEvidenceValues(turn, "serverModel").length,
    turnState.MAX_EVIDENCE_VALUES
  );
  assert.equal(turn.evidenceTruncated.serverModel, true);
  assert.equal(turnState.hasEvidenceConflict(turn, "serverModel"), true);
});
