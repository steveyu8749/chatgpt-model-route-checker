/* global chrome, document, window, MutationObserver, navigator */
(function installContentScript() {
  "use strict";

  const CHANNEL = "__CHATGPT_MODEL_ROUTE_CHECKER_V1__";
  const HOST_ID = "__chatgpt_model_route_checker_host__";
  const MAX_TURNS = 8;
  const RESPONSE_WAIT_TIMEOUT_MS = 30000;
  const RESPONSE_INACTIVITY_TIMEOUT_MS = 30000;
  const FALLBACK_DISPLAY_METADATA_WAIT_WINDOW_MS = 3000;
  function displayMetadataWaitWindow() {
    try {
      const shared = window.ChatGPTRouteTiming;
      const value = shared && shared.DISPLAY_METADATA_WAIT_WINDOW_MS;
      const normalized = Number.isFinite(value) ? Math.floor(value) : null;
      return normalized === FALLBACK_DISPLAY_METADATA_WAIT_WINDOW_MS
        ? normalized
        : FALLBACK_DISPLAY_METADATA_WAIT_WINDOW_MS;
    } catch {
      return FALLBACK_DISPLAY_METADATA_WAIT_WINDOW_MS;
    }
  }
  const DISPLAY_METADATA_WAIT_WINDOW_MS = displayMetadataWaitWindow();
  const DETECTOR_CONNECT_TIMEOUT_MS = 5000;
  const DETECTOR_PING_INTERVAL_MS = 250;
  const DETECTOR_RETRY_INTERVAL_MS = 1000;
  const DETECTOR_HEALTHCHECK_INTERVAL_MS = 5000;
  const NETWORK_EVIDENCE_TYPES = new Set([
    "response-start",
    "response-progress",
    "server-model",
    "assistant-model",
    "resolved-model",
    "requested-experience",
    "thinking-effort",
    "telemetry-observation",
    "response-end"
  ]);
  const api = window.ChatGPTRouteVerdict;
  const turnState = window.ChatGPTRouteTurnState;
  const detectorHealth = window.ChatGPTRouteDetectorHealth;
  const rules = window.CHATGPT_ROUTE_CHECKER_RULES || {
    equivalent: [],
    incompatible: []
  };

  if (
    !api ||
    !turnState ||
    !detectorHealth ||
    document.getElementById(HOST_ID)
  ) return;

  let expanded = false;
  let ui = null;
  const detectorConnection = {
    ...detectorHealth.createState(),
    pingTimer: null,
    timeoutTimer: null,
    healthCheckTimer: null,
    lastHealthAt: null
  };

  function clean(value, maxLength = 200) {
    return api.clean(value, maxLength);
  }

  function detectorConnectionLabel() {
    switch (detectorConnection.status) {
      case "connected":
        return "已连接";
      case "disconnected":
        return "未连接";
      default:
        return "连接中";
    }
  }

  function healthStatusLabel(value) {
    switch (value) {
      case "installed":
        return "已安装";
      case "overwritten":
        return "已被页面覆盖";
      case "failed":
        return "安装失败";
      default:
        return "不可用";
    }
  }

  function detectorHealthSummary() {
    const health = detectorConnection.health;
    if (!health) return "未确认";
    return `fetch=${healthStatusLabel(health.fetch)}，XHR=${healthStatusLabel(
      health.xhr
    )}，beacon=${healthStatusLabel(health.beacon)}`;
  }

  function telemetryCounters() {
    const telemetry = detectorConnection.health?.telemetry;
    if (!telemetry) return null;
    return Object.fromEntries(
      Object.entries(telemetry).map(([key, value]) => [key, safeCount(value)])
    );
  }

  function telemetryDelta(turn) {
    const current = telemetryCounters();
    if (!current) return null;
    const baseline = turn?.telemetryBaseline || {};
    return Object.fromEntries(
      Object.entries(current).map(([key, value]) => [
        key,
        Math.max(0, value - safeCount(baseline[key]))
      ])
    );
  }

  function telemetrySummary(turn) {
    if (!turn) return "本轮尚未开始";
    const delta = telemetryDelta(turn);
    if (!delta) return "未确认";
    const observation = turn.telemetryObservation;
    const delay = observation && Number.isFinite(observation.delayMs)
      ? `，最近关联延迟 ${durationLabel(observation.delayMs, true)}`
      : "";
    return [
      `观察 ${delta.observed}`,
      `可读 ${delta.readable}`,
      `已关联 ${delta.associated}`,
      `含模型 ${delta.modelFound}`,
      `无候选丢弃 ${delta.droppedNoCandidate}`,
      `多轮歧义丢弃 ${delta.droppedAmbiguous}`,
      `超窗丢弃 ${delta.droppedExpired}`
    ].join("，") + delay;
  }

  function stopDetectorPing() {
    if (detectorConnection.pingTimer) {
      window.clearTimeout(detectorConnection.pingTimer);
      detectorConnection.pingTimer = null;
    }
    if (detectorConnection.timeoutTimer) {
      window.clearTimeout(detectorConnection.timeoutTimer);
      detectorConnection.timeoutTimer = null;
    }
  }

  function scheduleHealthCheck() {
    if (detectorConnection.healthCheckTimer) {
      window.clearTimeout(detectorConnection.healthCheckTimer);
    }
    detectorConnection.healthCheckTimer = window.setTimeout(() => {
      detectorConnection.healthCheckTimer = null;
      if (detectorConnection.status !== "connected") return;
      if (Date.now() - detectorConnection.lastHealthAt >= 2 * DETECTOR_HEALTHCHECK_INTERVAL_MS) {
        detectorHealth.timeout(detectorConnection, true);
        render();
        sendDetectorPing();
        scheduleDetectorPing(DETECTOR_RETRY_INTERVAL_MS);
        return;
      }
      sendDetectorPing();
      scheduleHealthCheck();
    }, DETECTOR_HEALTHCHECK_INTERVAL_MS);
  }

  function sendDetectorPing() {
    try {
      window.postMessage(
        {
          channel: CHANNEL,
          version: 1,
          type: "detector-ping"
        },
        window.location.origin
      );
    } catch {
      // A page navigation may temporarily make postMessage unavailable.
    }
  }

  function scheduleDetectorPing(delay = DETECTOR_PING_INTERVAL_MS) {
    if (detectorConnection.status === "connected") return;
    if (detectorConnection.pingTimer) {
      window.clearTimeout(detectorConnection.pingTimer);
    }
    detectorConnection.pingTimer = window.setTimeout(() => {
      detectorConnection.pingTimer = null;
      if (detectorConnection.status === "connected") return;
      sendDetectorPing();
      scheduleDetectorPing(
        detectorConnection.status === "disconnected"
          ? DETECTOR_RETRY_INTERVAL_MS
          : DETECTOR_PING_INTERVAL_MS
      );
    }, delay);
  }

  function startDetectorHandshake() {
    sendDetectorPing();
    scheduleDetectorPing();
    detectorConnection.timeoutTimer = window.setTimeout(() => {
      detectorConnection.timeoutTimer = null;
      if (detectorConnection.status === "connected") return;
      detectorHealth.timeout(detectorConnection);
      render();
      // Keep a low-frequency retry alive so a MAIN-world script that was
      // injected late can still connect without requiring a page reload.
      scheduleDetectorPing(DETECTOR_RETRY_INTERVAL_MS);
    }, DETECTOR_CONNECT_TIMEOUT_MS);
  }

  function acceptDetectorHealth(health) {
    const normalized = detectorHealth.accept(detectorConnection, health);
    if (!normalized) return false;
    detectorConnection.lastHealthAt = Date.now();
    stopDetectorPing();
    scheduleHealthCheck();
    render();
    return true;
  }

  function clearTurnTimers(turn) {
    if (!turn) return;
    if (turn.completionTimer) window.clearTimeout(turn.completionTimer);
    if (turn.responseWaitTimer) window.clearTimeout(turn.responseWaitTimer);
    turn.completionTimer = null;
    turn.responseWaitTimer = null;
    if (turn.inactivityTimer) window.clearTimeout(turn.inactivityTimer);
    turn.inactivityTimer = null;
  }

  const turnStore = turnState.createStore({
    maxTurns: MAX_TURNS,
    onEvict: clearTurnTimers
  });

  function getTurn(id, create = true) {
    return turnStore.get(id, create);
  }

  function currentTurn() {
    return turnStore.current();
  }

  function scheduleCompletion(turn) {
    if (!turn || turn.complete) return;
    if (turn.completionTimer) window.clearTimeout(turn.completionTimer);

    // A server model that arrived before response-end already settles the
    // model check; no delayed-metadata timer is needed in that case.
    if (turn.serverModel) {
      turnState.complete(turn);
      return;
    }

    // Telemetry can carry the same route metadata shortly after the
    // conversation stream closes. Keep the turn in a neutral checking state
    // during the shared metadata window so "无法检测" does not flash early.
    const waitState = turnState.delayedMetadataState(
      turn,
      Date.now(),
      DISPLAY_METADATA_WAIT_WINDOW_MS
    );
    const delay = waitState.waiting && Number.isFinite(waitState.remainingMs)
      ? waitState.remainingMs
      : DISPLAY_METADATA_WAIT_WINDOW_MS;

    turn.completionTimer = window.setTimeout(() => {
      turn.completionTimer = null;
      if (turn.serverModel) {
        turnState.complete(turn);
        if (turnStore.isCurrent(turn.id)) render();
        return;
      }

      // Timers are best-effort and may run before their requested delay in a
      // test harness or after a clock adjustment. Re-check the pure lifecycle
      // state so the full shared window is honored before finalizing.
      const currentWaitState = turnState.delayedMetadataState(
        turn,
        Date.now(),
        DISPLAY_METADATA_WAIT_WINDOW_MS
      );
      if (currentWaitState.waiting && !currentWaitState.expired) {
        scheduleCompletion(turn);
        return;
      }
      turnState.complete(turn);
      if (turnStore.isCurrent(turn.id)) render();
    }, delay);
  }

  function scheduleResponseWait(turn) {
    if (!turn || turn.responseStarted || turn.responseEnded) return;
    if (turn.responseWaitTimer) window.clearTimeout(turn.responseWaitTimer);
    turn.responseWaitTimer = window.setTimeout(() => {
      turn.responseWaitTimer = null;
      if (turn.responseStarted || turn.responseEnded) return;
      turnState.timeout(turn, "no-response");
      if (turnStore.isCurrent(turn.id)) render();
    }, RESPONSE_WAIT_TIMEOUT_MS);
  }

  function scheduleResponseInactivity(turn) {
    if (!turn || !turn.responseStarted || turn.responseEnded) return;
    if (turn.inactivityTimer) window.clearTimeout(turn.inactivityTimer);
    turn.inactivityTimer = window.setTimeout(() => {
      turn.inactivityTimer = null;
      if (turn.responseEnded) return;
      turnState.timeout(turn, "stream-stalled");
      if (turnStore.isCurrent(turn.id)) render();
    }, RESPONSE_INACTIVITY_TIMEOUT_MS);
  }

  function displayValue(
    value,
    waiting = false,
    optional = false,
    waitingLabel = "等待服务端…"
  ) {
    if (value) return value;
    return waiting ? waitingLabel : optional ? "未提供（可选）" : "未获取";
  }

  const FIELD_LABELS = Object.freeze({
    requestModel: "客户端 request.model",
    serverModel: "服务端 server_ste_metadata.model_slug",
    assistantModel: "assistant metadata.model_slug",
    resolvedModel: "resolved_model_slug",
    requestedExperience: "requested_model_experience",
    domModel: "DOM data-message-model-slug",
    thinkingEffort: "request.thinking_effort"
  });

  function evidenceValues(turn, field) {
    return turn ? turnState.getEvidenceValues(turn, field) : [];
  }

  function formatEvidenceValue(
    turn,
    field,
    optional = false,
    waiting = false,
    waitingLabel
  ) {
    const values = evidenceValues(turn, field);
    if (values.length > 1) return `${values.join(" / ")}（冲突）`;
    return displayValue(values[0], waiting, optional, waitingLabel);
  }

  function evidenceConflictSummary(turn) {
    if (!turn) return "";
    return turnState
      .allConflictFields(turn)
      .map((field) => `${FIELD_LABELS[field]}=${evidenceValues(turn, field).join(" / ")}`)
      .join("；");
  }

  function serverValue(turn) {
    if (!turn) return "未获取";
    let label = "未获取";
    if (turn.responseEndReason === "stream-stalled") label = "采集停滞，可恢复";
    else if (turn.responseUnsupported) label = "响应格式不支持";
    else if (["read-error", "aborted", "interrupted"].includes(turn.responseEndReason)) label = "响应中断，未获取";
    else if (turnState.isWaitingForDelayedMetadata(turn)) label = "等待延迟模型元数据…";
    else if (turn.complete && turn.responseStarted && turn.responseEnded) label = "本轮未观察到标注";
    else if (!turn.complete) label = turn.responseStarted ? "等待服务端…" : "等待响应…";
    return formatEvidenceValue(turn, "serverModel", false, true, label);
  }

  function modelLine(result, turn) {
    if (!turn) return "发送消息后显示本轮模型";
    return `${formatEvidenceValue(turn, "requestModel")} → ${serverValue(turn)}`;
  }

  function resultForTurn(turn) {
    if (!turn) return api.emptyResult();

    return api.classify(
      {
        requestModel: turn.requestModel,
        serverModel: turn.serverModel,
        assistantModel: turn.assistantModel,
        resolvedModel: turn.resolvedModel,
        requestedExperience: turn.requestedExperience,
        domModel: turn.domModel,
        thinkingEffort: turn.thinkingEffort,
        complete: turn.complete,
        requestCaptured: turn.requestCaptured,
        responseStarted: turn.responseStarted,
        responseEnded: turn.responseEnded,
        responseEndReason: turn.responseEndReason,
        responseFormat: turn.responseFormat,
        responseUnsupported: turn.responseUnsupported,
        evidenceValues: turn.evidenceValues,
        evidenceConflicts: turn.evidenceConflicts
      },
      { rules }
    );
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function makeField(label, value, optional = false) {
    const row = makeElement("div", "route-field");
    const labelElement = makeElement("dt", "route-field-label", label);
    const valueElement = makeElement(
      "dd",
      "route-field-value",
      displayValue(value, false, optional)
    );
    if (
      optional &&
      (!value || value === "未提供（可选）")
    ) {
      valueElement.classList.add("is-optional");
    }
    row.valueElement = valueElement;
    row.append(labelElement, valueElement);
    return row;
  }

  function createUI() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-live", "polite");

    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("content/style.css");
    shadow.appendChild(stylesheet);

    const card = makeElement("section", "route-card");
    card.setAttribute("aria-label", "ChatGPT 模型路由检测");

    const summary = makeElement("button", "route-summary");
    summary.type = "button";
    summary.setAttribute("aria-expanded", "false");
    summary.setAttribute("aria-controls", "route-details");

    const summaryTop = makeElement("span", "route-summary-top");
    const title = makeElement("span", "route-title", "模型检测");
    const status = makeElement("span", "route-status");
    const line = makeElement("span", "route-model-line");
    summaryTop.append(title, status);
    summary.append(summaryTop, line);

    const details = makeElement("div", "route-details");
    details.id = "route-details";
    details.hidden = true;

    const reason = makeElement("p", "route-reason");
    const diagnostic = makeElement("p", "route-diagnostic");
    const fields = makeElement("dl", "route-fields");
    const fieldRows = new Map();
    for (const [field, label] of Object.entries(FIELD_LABELS)) {
      const optional = field !== "requestModel" && field !== "serverModel";
      const row = makeField(label, null, optional);
      fieldRows.set(field, row);
      fields.append(row);
    }
    const warning = makeElement("p", "route-warning");
    warning.hidden = true;

    const footer = makeElement("div", "route-footer");
    const note = makeElement(
      "span",
      "route-note",
      "仅核对浏览器可见的模型路由元数据"
    );
    const copy = makeElement("button", "route-copy", "复制诊断");
    copy.type = "button";
    footer.append(note, copy);

    details.append(reason, diagnostic, fields, footer);
    card.append(summary, warning, details);
    shadow.appendChild(card);

    summary.addEventListener("click", () => {
      expanded = !expanded;
      details.hidden = !expanded;
      summary.setAttribute("aria-expanded", String(expanded));
      host.classList.toggle("is-expanded", expanded);
      render();
    });

    copy.addEventListener("click", async (event) => {
      event.stopPropagation();
      const turn = currentTurn();
      const result = resultForTurn(turn);
      const text = formatCopyText(turn, result);
      const copied = await copyText(text);
      copy.textContent = copied ? "已复制" : "复制失败";
      window.setTimeout(() => {
        copy.textContent = "复制诊断";
      }, 1600);
    });

    return {
      host,
      card,
      summary,
      status,
      line,
      details,
      reason,
      diagnostic,
      fields,
      fieldRows,
      warning,
      copy
    };
  }

  function safeCount(value) {
    return Number.isFinite(value) && value >= 0
      ? Math.min(Math.floor(value), 100000)
      : 0;
  }

  function responseReasonLabel(reason) {
    if (reason === "stream-stalled") return "响应采集停滞";
    const labels = {
      completed: "正常结束",
      "fetch-error": "请求失败",
      "read-error": "读取失败",
      interrupted: "请求被中断",
      aborted: "请求被取消",
      "no-response": "未收到响应"
    };
    return labels[reason] || (reason ? "未知结束原因" : "尚未结束");
  }

  function responseFormatLabel(format) {
    const labels = {
      sse: "SSE 流",
      json: "JSON",
      unknown: "未知"
    };
    return labels[format] || "未知";
  }

  function durationLabel(value, signed = false) {
    if (!Number.isFinite(value)) return "未记录";
    const rounded = Math.floor(value);
    const prefix = signed && rounded >= 0 ? "+" : "";
    return `${prefix}${rounded} ms`;
  }

  function timingSummary(turn) {
    if (!turn) return "本地轮次：未知";

    const timing = turnState.relativeTiming(turn);
    const round = Number.isFinite(timing.roundNumber)
      ? `#${timing.roundNumber}`
      : "未知";
    const parts = [`本地轮次：${round}`];

    if (Number.isFinite(timing.requestToResponseStartMs)) {
      parts.push(
        `请求→响应开始：${durationLabel(timing.requestToResponseStartMs)}`
      );
    }
    if (Number.isFinite(timing.requestToResponseEndMs)) {
      parts.push(
        `请求→响应结束：${durationLabel(timing.requestToResponseEndMs)}`
      );
    }
    if (Number.isFinite(timing.responseEndToServerModelMs)) {
      parts.push(
        `响应结束→服务端模型：${durationLabel(
          timing.responseEndToServerModelMs,
          true
        )}`
      );
    } else if (Number.isFinite(timing.responseEndElapsedMs)) {
      parts.push(
        timing.settled
          ? `响应结束→完成判定：${durationLabel(
              timing.responseEndElapsedMs
            )}`
          : `响应结束后已等待：${durationLabel(
              timing.responseEndElapsedMs
            )}`
      );
    }
    parts.push(
      `${timing.settled ? "检测结论耗时" : "当前轮次已耗时"}：${durationLabel(
        timing.totalElapsedMs
      )}`
    );
    return parts.join("；");
  }

  function diagnosticSummary(turn) {
    if (!turn) {
      return detectorConnection.status === "connected"
        ? "检测器已就绪，等待 ChatGPT 对话请求。"
        : detectorConnection.status === "disconnected"
          ? "采集器未连接，暂时无法捕获 ChatGPT 对话请求。"
          : "正在连接采集器，等待采集桥确认。";
    }

    const stats = turn.responseStats || {};
    const requestState = turn.requestCaptured
      ? turn.requestModel
        ? "已捕获，模型已获取"
        : "已捕获，模型未获取"
      : "未捕获";
    const delayedMetadataWaiting = turnState.isWaitingForDelayedMetadata(turn);
    const responseState = turn.responseStarted
      ? turn.responseEnded
        ? delayedMetadataWaiting
          ? `已捕获，${responseReasonLabel(
              turn.responseEndReason
            )}，等待延迟模型元数据`
          : `已捕获，${responseReasonLabel(turn.responseEndReason)}`
        : "已捕获，仍在接收"
      : turn.responseEnded
        ? `未捕获，${responseReasonLabel(turn.responseEndReason)}`
        : "未捕获，等待中";

    const parts = [
      `采集器：${detectorConnectionLabel()}`,
      `请求：${requestState}`,
      `响应：${responseState}`,
      `格式：${responseFormatLabel(turn.responseFormat)}`,
      `事件：${safeCount(stats.eventCount)}，JSON 载荷：${safeCount(
        stats.payloadCount
      )}，解析异常：${safeCount(stats.parseErrorCount)}，字节数：${safeCount(
        stats.byteCount
      )}`,
      `telemetry：${telemetrySummary(turn)}`
    ];
    const conflicts = evidenceConflictSummary(turn);
    if (conflicts) parts.push(`证据冲突：${conflicts}`);
    return parts.join("；");
  }

  function extensionVersion() {
    try {
      return clean(chrome.runtime.getManifest().version, 40) || "未知";
    } catch {
      return "未知";
    }
  }

  function formatCopyText(turn, result) {
    const current = turn || {};
    return [
      `扩展版本：${extensionVersion()}`,
      `采集器状态：${detectorConnectionLabel()}`,
      `采集器版本：${
        detectorConnection.health
          ? detectorConnection.health.detectorVersion
          : "未确认"
      }`,
      `采集器健康：${detectorHealthSummary()}`,
      `本轮 telemetry：${telemetrySummary(turn)}`,
      `状态：${displayStatusLabel(result)}`,
      `判定理由：${result.reason}`,
      `不可用原因：${
        result.unavailableReason || "不适用"
      }`,
      `诊断摘要：${diagnosticSummary(turn)}`,
      `本地时序：${timingSummary(turn)}`,
      `${FIELD_LABELS.requestModel}：${formatEvidenceValue(
        turn,
        "requestModel"
      )}`,
      `${FIELD_LABELS.serverModel}：${serverValue(turn)}`,
      `${FIELD_LABELS.assistantModel}：${formatEvidenceValue(
        turn,
        "assistantModel",
        true
      )}`,
      `${FIELD_LABELS.resolvedModel}：${formatEvidenceValue(
        turn,
        "resolvedModel",
        true
      )}`,
      `${FIELD_LABELS.requestedExperience}：${formatEvidenceValue(
        turn,
        "requestedExperience",
        true
      )}`,
      `${FIELD_LABELS.domModel}：${formatEvidenceValue(turn, "domModel", true)}`,
      `${FIELD_LABELS.thinkingEffort}：${formatEvidenceValue(
        turn,
        "thinkingEffort",
        true
      )}`,
      `响应格式：${responseFormatLabel(current.responseFormat)}`,
      `响应结束原因：${responseReasonLabel(current.responseEndReason)}`,
      `响应事件数：${safeCount(current.responseStats?.eventCount)}`,
      `JSON 载荷数：${safeCount(current.responseStats?.payloadCount)}`,
      `解析异常数：${safeCount(current.responseStats?.parseErrorCount)}`,
      `响应字节数：${safeCount(current.responseStats?.byteCount)}`
    ].join("\n");
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the local textarea fallback.
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }

  let renderFrame = null;
  let renderFallback = null;
  function render() {
    if (!ui || renderFallback !== null) return;
    const flush = () => {
      if (renderFallback === null) return;
      window.clearTimeout(renderFallback);
      renderFallback = null;
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
      renderFrame = null;
      renderNow();
    };
    // requestAnimationFrame can pause in hidden tabs; bound UI staleness too.
    renderFallback = window.setTimeout(flush, 100);
    if (typeof window.requestAnimationFrame === "function") {
      renderFrame = window.requestAnimationFrame(flush);
    }
  }

  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function renderNow() {
    if (!ui) return;

    const turn = currentTurn();
    const result = resultForTurn(turn);
    ui.host.dataset.status = result.status;
    ui.host.dataset.collector = detectorConnection.status;
    if (detectorConnection.status === "connecting") {
      setText(ui.status, "◌ 正在连接采集器");
      setText(ui.line, "等待采集器确认");
      setText(ui.reason, "正在等待 MAIN world 采集桥响应。");
    } else if (detectorConnection.status === "disconnected") {
      setText(ui.status, "? 采集器未连接");
      setText(ui.line, "暂时无法捕获 ChatGPT 对话请求");
      setText(ui.reason, "未收到 MAIN world 采集桥的健康确认，当前轮次无法可靠检测。");
    } else {
      setText(ui.status, `${statusIcon(result.status)} ${displayStatusLabel(
        result
      )}`);
      setText(ui.line, modelLine(result, turn));
      setText(ui.reason, result.reason);
    }
    setText(ui.diagnostic, `诊断：${diagnosticSummary(turn)}`);
    ui.summary.title =
      detectorConnection.status === "connected"
        ? result.reason
        : ui.reason.textContent;

    const health = detectorConnection.health;
    const impaired = health && ["fetch", "xhr", "beacon"].filter(key =>
      health[key] === "failed" || health[key] === "overwritten"
    );
    ui.warning.hidden = detectorConnection.status !== "connected" || !impaired?.length;
    if (!ui.warning.hidden) {
      setText(ui.warning, `部分采集不可用（${impaired.join("、")}），结果可能不完整。刷新页面后重试。`);
    }
    // Collapsing the panel only defers detail rendering, never collection.
    if (!expanded) return;
    for (const [field, row] of ui.fieldRows) {
      const optional = field !== "requestModel" && field !== "serverModel";
      const value = field === "serverModel" ? serverValue(turn)
        : formatEvidenceValue(turn, field, optional);
      setText(row.valueElement, value);
      row.valueElement.classList.toggle("is-optional", optional && value === "未提供（可选）");
    }
  }

  function displayStatusLabel(result) {
    if (
      result &&
      result.status === api.STATUS.UNAVAILABLE &&
      result.unavailableReason &&
      api.UNAVAILABLE_LABELS &&
      api.UNAVAILABLE_LABELS[result.unavailableReason]
    ) {
      return api.UNAVAILABLE_LABELS[result.unavailableReason];
    }
    return result ? result.label : api.LABELS[api.STATUS.IDLE];
  }

  function statusIcon(status) {
    switch (status) {
      case api.STATUS.MATCH:
        return "✓";
      case api.STATUS.MISMATCH:
        return "✕";
      case api.STATUS.REVIEW:
        return "!";
      case api.STATUS.UNAVAILABLE:
        return "?";
      case api.STATUS.CHECKING:
        return "◌";
      default:
        return "●";
    }
  }

  function eventTurn(event) {
    const id = clean(event.requestId, 80);
    if (id) return getTurn(id);
    return currentTurn();
  }

  function handleRouteEvent(event) {
    const data = event.data;
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      !data ||
      data.channel !== CHANNEL ||
      data.version !== 1 ||
      typeof data.type !== "string"
    ) {
      return;
    }

    if (
      data.type === "detector-pong" ||
      data.type === "detector-ready" ||
      data.type === "detector-telemetry"
    ) {
      acceptDetectorHealth(data.health);
      return;
    }

    if (data.type === "request") {
      const id = clean(data.requestId, 80);
      if (!id) return;

      const result = turnStore.beginRequest(id, {
        model: data.model,
        thinkingEffort: data.thinkingEffort
      });
      const turn = result && result.turn;
      if (!turn) return;

      if (!turn.telemetryBaseline) {
        turn.telemetryBaseline = telemetryCounters() || {};
      }

      // Capture the last assistant node before this request starts. Existing
      // DOM nodes can be detached and re-mounted while a new response is
      // being built; their old slug must not become evidence for this turn.
      if (!turn.domBaselineSet) {
        turn.domBaselineNode = lastAssistantNode();
        turn.domBaselineSet = true;
      }

      scheduleResponseWait(turn);
      // A first request event starts the visible turn. A duplicate request
      // event can arrive later when a Request clone finishes reading; never
      // let that late update switch the card back to an older turn.
      if (result.isCurrent) render();
      return;
    }

    const eventId = clean(data.requestId, 80);
    if (NETWORK_EVIDENCE_TYPES.has(data.type) && !eventId) return;
    const wasCurrent = !eventId || turnStore.isCurrent(eventId);
    const turn = eventTurn(data);
    if (!turn) return;

    const value = clean(data.value);
    switch (data.type) {
      case "response-start":
        if (turn.responseWaitTimer) {
          window.clearTimeout(turn.responseWaitTimer);
          turn.responseWaitTimer = null;
        }
        turnState.startResponse(turn, data.responseFormat);
        scheduleResponseInactivity(turn);
        // The page can set the new assistant node's model attribute before
        // this postMessage reaches the isolated world. Check it once after
        // marking responseStarted so that a new node is still captured. A
        // baseline node is rejected here unless a later attribute mutation
        // explicitly changes it (see maybeReadDomModel).
        if (wasCurrent) {
          maybeReadDomModel(lastAssistantNode(), "response-start");
        }
        if (turn.completionTimer) {
          window.clearTimeout(turn.completionTimer);
          turn.completionTimer = null;
        }
        break;
      case "response-progress":
        if (turn.responseEndReason === "stream-stalled") {
          turnState.startResponse(turn, data.responseFormat);
        }
        scheduleResponseInactivity(turn);
        if (typeof data.responseFormat === "string") {
          turn.responseFormat = clean(data.responseFormat, 40) || turn.responseFormat;
        }
        turnState.updateResponseStats(turn, data);
        break;
      case "server-model":
        turnState.addEvidence(turn, "serverModel", value);
        // A delayed server field settles a completed response immediately.
        // This keeps the visible state checking only until the evidence is
        // actually available and cancels the remaining grace timer.
        if (turn.serverModel && turn.responseEnded && !turn.complete) {
          if (turn.completionTimer) {
            window.clearTimeout(turn.completionTimer);
            turn.completionTimer = null;
          }
          turnState.complete(turn);
        }
        break;
      case "assistant-model":
        turnState.addEvidence(turn, "assistantModel", value);
        break;
      case "resolved-model":
        turnState.addEvidence(turn, "resolvedModel", value);
        break;
      case "requested-experience":
        turnState.addEvidence(turn, "requestedExperience", value);
        break;
      case "dom-model":
        turnState.addEvidence(turn, "domModel", value);
        break;
      case "thinking-effort":
        turnState.addEvidence(turn, "thinkingEffort", value);
        break;
      case "telemetry-observation":
        turn.telemetryObservation = {
          readable: Boolean(data.readable),
          modelFound: Boolean(data.modelFound),
          delayMs: Number.isFinite(data.delayMs)
            ? Math.min(Math.max(Math.floor(data.delayMs), 0), 15000)
            : null
        };
        break;
      case "response-end":
        if (turn.inactivityTimer) window.clearTimeout(turn.inactivityTimer);
        turn.inactivityTimer = null;
        if (turn.responseEndReason === "stream-stalled" || turn.responseEndReason === "no-response") {
          turnState.startResponse(turn, data.responseFormat);
        }
        if (turn.responseWaitTimer) {
          window.clearTimeout(turn.responseWaitTimer);
          turn.responseWaitTimer = null;
        }
        turnState.endResponse(turn, {
          endReason: data.endReason,
          responseStarted: data.responseStarted,
          responseFormat: data.responseFormat,
          responseUnsupported: data.responseUnsupported,
          stats: data
        });
        scheduleCompletion(turn);
        break;
      default:
        return;
    }

    // A delayed response from an older concurrent request may still arrive.
    // It updates its own in-memory record, but must not pull the visible card
    // away from the newest request.
    if (wasCurrent) render();
  }

  function lastAssistantNode() {
    const nodes = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function maybeReadDomModel(node, source = "attribute") {
    const turn = currentTurn();
    if (!turnState.shouldAcceptDomEvidence(turn, node, source)) return;
    const value = clean(node.getAttribute("data-message-model-slug"));
    if (!value || node !== lastAssistantNode()) return;

    const change = turnState.addEvidence(turn, "domModel", value);
    if (change.added) render();
  }

  function inspectAddedNode(node) {
    if (!node || node.nodeType !== 1) return;
    maybeReadDomModel(node, "childList");
    for (const child of node.querySelectorAll(
      '[data-message-author-role="assistant"]'
    )) {
      maybeReadDomModel(child, "childList");
    }
  }

  function observeDom() {
    const root = document.documentElement;
    if (!root) return;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.type === "attributes" &&
          record.attributeName === "data-message-model-slug"
        ) {
          maybeReadDomModel(record.target);
        } else if (record.type === "childList") {
          for (const node of record.addedNodes) inspectAddedNode(node);
        }
      }
    });

    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-message-model-slug"]
    });
  }

  function mount() {
    if (!document.documentElement) {
      window.setTimeout(mount, 0);
      return;
    }

    ui = createUI();
    document.documentElement.appendChild(ui.host);
    render();
    observeDom();
  }

  window.addEventListener("message", handleRouteEvent, false);
  mount();
  startDetectorHandshake();
  window.setTimeout(render, 500);
})();
