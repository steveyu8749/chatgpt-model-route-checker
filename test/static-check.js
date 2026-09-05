const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const detector = fs.readFileSync(
  path.join(root, "content", "detector.js"),
  "utf8"
);
const content = fs.readFileSync(
  path.join(root, "content", "content.js"),
  "utf8"
);
const turnState = fs.readFileSync(
  path.join(root, "content", "turn-state.js"),
  "utf8"
);
const detectorHealth = fs.readFileSync(
  path.join(root, "content", "detector-health.js"),
  "utf8"
);
const timingSource = fs.readFileSync(
  path.join(root, "content", "timing.js"),
  "utf8"
);
const rules = fs.readFileSync(
  path.join(root, "content", "model-rules.js"),
  "utf8"
);
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.1.4");
assert.equal(packageJson.version, "1.1.4");
assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
assert.equal(manifest.content_scripts.length, 2);
assert.ok(manifest.content_scripts[0].js.includes("content/turn-state.js"));
assert.ok(manifest.content_scripts[0].js.includes("content/detector-health.js"));
assert.ok(manifest.content_scripts[0].js.includes("content/timing.js"));
assert.ok(manifest.content_scripts[1].js.includes("content/timing.js"));
assert.deepEqual(manifest.web_accessible_resources, [
  {
    resources: ["content/style.css"],
    matches: ["https://chatgpt.com/*"]
  }
]);

const worlds = new Set(manifest.content_scripts.map((script) => script.world));
assert.deepEqual(worlds, new Set(["MAIN", "ISOLATED"]));
for (const script of manifest.content_scripts) {
  assert.deepEqual(script.matches, ["https://chatgpt.com/*"]);
  assert.equal(script.run_at, "document_start");
}

assert.match(detector, /window\.fetch/);
assert.match(detector, /XMLHttpRequest/);
assert.match(detector, /server_ste_metadata/);
assert.match(detector, /window\.postMessage/);
assert.match(detector, /ChatGPTRouteTiming/);
assert.match(detector, /TELEMETRY_ASSOCIATION_WINDOW_MS/);
assert.match(detector, /FALLBACK_TELEMETRY_ASSOCIATION_WINDOW_MS = 15000/);
assert.match(detector, /DETECTOR_VERSION = "1\.1\.4"/);
assert.match(detector, /detector-ping/);
assert.match(detector, /detector-pong/);
assert.match(detector, /detector-ready/);
assert.match(detector, /healthSnapshot/);
assert.match(detector, /processTelemetryText/);
assert.match(detector, /droppedAmbiguous/);
assert.match(detector, /droppedExpired/);
assert.match(detector, /fetchInstallSucceeded/);
assert.match(detector, /xhrInstallSucceeded/);
assert.match(detector, /beaconInstallSucceeded/);
assert.doesNotMatch(detector, /setInterval/);
assert.match(detector, /response-start/);
assert.match(detector, /response-progress/);
assert.match(detector, /RESPONSE_PROGRESS_INTERVAL_MS/);
assert.match(detector, /RESPONSE_PROGRESS_INTERVAL_MS = 1000/);
assert.match(detector, /lastActivityAt/);
assert.match(detector, /touchConversation\(requestIdValue\)/);
assert.match(detector, /responseFormatHint/);
assert.doesNotMatch(detector, /telemetryModelHints/);
assert.match(detector, /endReason/);
assert.match(detector, /createStreamParser/);
for (const key of ["content", "parts", "messages", "attachments", "files", "prompt", "body"]) {
  assert.match(detector, new RegExp(`"${key}"`));
}
assert.doesNotMatch(detector, /chrome\.storage/);
assert.doesNotMatch(detector, /localStorage/);
assert.doesNotMatch(content, /chrome\.storage/);
assert.match(content, /NETWORK_EVIDENCE_TYPES/);
assert.match(content, /ChatGPTRouteTurnState/);
assert.match(content, /ChatGPTRouteTiming/);
assert.match(content, /DISPLAY_METADATA_WAIT_WINDOW_MS/);
assert.match(content, /FALLBACK_DISPLAY_METADATA_WAIT_WINDOW_MS = 3000/);
assert.match(content, /正在连接采集器/);
assert.match(content, /采集器未连接/);
assert.match(content, /detector-ping/);
assert.match(content, /detector-pong/);
assert.match(content, /detector-ready/);
assert.match(content, /采集器健康/);
assert.match(content, /telemetrySummary/);
assert.match(content, /本轮未观察到标注/);
assert.doesNotMatch(content, /2500/);
assert.match(content, /evidenceConflictSummary/);
assert.match(content, /getManifest\(\)\.version/);
assert.match(content, /RESPONSE_WAIT_TIMEOUT_MS/);
assert.match(content, /NETWORK_EVIDENCE_TYPES\.has\(data\.type\) && !eventId/);
assert.match(content, /等待延迟模型元数据/);
assert.match(content, /timingSummary/);
assert.match(content, /diagnosticSummary/);
assert.match(content, /复制诊断/);
assert.match(content, /UNAVAILABLE_LABELS/);
assert.match(content, /未提供（可选）/);
assert.match(content, /request\.model/);
assert.match(content, /resolved_model_slug/);
assert.match(content, /data-message-model-slug/);
assert.match(content, /getURL\("content\/style\.css"\)/);
assert.match(turnState, /createStore/);
assert.match(turnState, /MAX_EVIDENCE_VALUES/);
assert.match(turnState, /lastActivityAt/);
assert.match(turnState, /delayedMetadataState/);
assert.match(turnState, /relativeTiming/);
assert.match(detectorHealth, /createState/);
assert.match(detectorHealth, /normalizeHealth/);
assert.match(detectorHealth, /detectorVersion/);
assert.match(detectorHealth, /TELEMETRY_COUNTERS/);
assert.doesNotMatch(detectorHealth, /requestId/);
assert.doesNotMatch(detectorHealth, /messages/);
assert.match(rules, /equivalent: Object\.freeze\(\[\]\)/);
assert.match(rules, /incompatible: Object\.freeze\(\[\]\)/);
assert.match(timingSource, /DISPLAY_METADATA_WAIT_WINDOW_MS = 3000/);
assert.match(timingSource, /TELEMETRY_ASSOCIATION_WINDOW_MS = 15000/);
assert.match(readme, /不上传/);
assert.match(readme, /未捕获响应/);
assert.match(readme, /诊断摘要/);
assert.match(readme, /不能证明 OpenAI GPU/);
assert.match(readme, /当前版本：`1\.1\.4`/);
assert.match(readme, /1\.1\.4/);
assert.match(readme, /78 项行为测试/);
assert.doesNotMatch(readme, /未捕获请求/);

console.log("Static extension checks passed.");
