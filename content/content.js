/* global chrome, document, window, MutationObserver, navigator */
(function installContentScript() {
  "use strict";

  const CHANNEL = "__CHATGPT_MODEL_ROUTE_CHECKER_V1__";
  const HOST_ID = "__chatgpt_model_route_checker_host__";
  const MAX_TURNS = 8;
  const RESPONSE_WAIT_TIMEOUT_MS = 30000;
  const timing = window.ChatGPTRouteTiming;
  const MODEL_METADATA_WAIT_WINDOW_MS =
    timing && timing.MODEL_METADATA_WAIT_WINDOW_MS;
  const NETWORK_EVIDENCE_TYPES = new Set([
    "response-start",
    "response-progress",
    "server-model",
    "assistant-model",
    "resolved-model",
    "requested-experience",
    "thinking-effort",
    "response-end"
  ]);
  const api = window.ChatGPTRouteVerdict;
  const turnState = window.ChatGPTRouteTurnState;
  const rules = window.CHATGPT_ROUTE_CHECKER_RULES || {
    equivalent: [],
    incompatible: []
  };

  if (
    !api ||
    !turnState ||
    !Number.isFinite(MODEL_METADATA_WAIT_WINDOW_MS) ||
    document.getElementById(HOST_ID)
  ) return;

  let expanded = false;
  let ui = null;

  function clean(value, maxLength = 200) {
    return api.clean(value, maxLength);
  }

  function clearTurnTimers(turn) {
    if (!turn) return;
    if (turn.completionTimer) window.clearTimeout(turn.completionTimer);
    if (turn.responseWaitTimer) window.clearTimeout(turn.responseWaitTimer);
    turn.completionTimer = null;
    turn.responseWaitTimer = null;
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
      MODEL_METADATA_WAIT_WINDOW_MS
    );
    const delay = waitState.waiting && Number.isFinite(waitState.remainingMs)
      ? waitState.remainingMs
      : MODEL_METADATA_WAIT_WINDOW_MS;

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
        MODEL_METADATA_WAIT_WINDOW_MS
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

  function modelLine(result, turn) {
    if (!turn) {
      return "发送消息后显示本轮模型";
    }
    const delayedMetadataWaiting = turnState.isWaitingForDelayedMetadata(turn);
    const serverWaiting = turn.responseStarted && !turn.responseEnded;
    return `${formatEvidenceValue(turn, "requestModel")} → ${formatEvidenceValue(
      turn,
      "serverModel",
      false,
      serverWaiting || delayedMetadataWaiting,
      delayedMetadataWaiting ? "等待延迟模型元数据…" : undefined
    )}`;
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
    fields.append(
      makeField("客户端 request.model", null),
      makeField("服务端 server_ste_metadata.model_slug", null),
      makeField("assistant metadata.model_slug", null, true),
      makeField("resolved_model_slug", null, true),
      makeField("requested_model_experience", null, true),
      makeField("DOM data-message-model-slug", null, true),
      makeField("request.thinking_effort", null, true)
    );

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
    card.append(summary, details);
    shadow.appendChild(card);

    summary.addEventListener("click", () => {
      expanded = !expanded;
      details.hidden = !expanded;
      summary.setAttribute("aria-expanded", String(expanded));
      host.classList.toggle("is-expanded", expanded);
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
      copy
    };
  }

  function safeCount(value) {
    return Number.isFinite(value) && value >= 0
      ? Math.min(Math.floor(value), 100000)
      : 0;
  }

  function responseReasonLabel(reason) {
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
    if (!turn) return "检测器已就绪，等待 ChatGPT 对话请求。";

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
      `请求：${requestState}`,
      `响应：${responseState}`,
      `格式：${responseFormatLabel(turn.responseFormat)}`,
      `事件：${safeCount(stats.eventCount)}，JSON 载荷：${safeCount(
        stats.payloadCount
      )}，解析异常：${safeCount(stats.parseErrorCount)}，字节数：${safeCount(
        stats.byteCount
      )}`
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
      `${FIELD_LABELS.serverModel}：${formatEvidenceValue(
        turn,
        "serverModel",
        false,
        turnState.isWaitingForDelayedMetadata(turn),
        "等待延迟模型元数据…"
      )}`,
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

  function render() {
    if (!ui) return;

    const turn = currentTurn();
    const result = resultForTurn(turn);
    ui.host.dataset.status = result.status;
    ui.status.textContent = `${statusIcon(result.status)} ${displayStatusLabel(
      result
    )}`;
    ui.line.textContent = modelLine(result, turn);
    ui.reason.textContent = result.reason;
    ui.diagnostic.textContent = `诊断：${diagnosticSummary(turn)}`;
    ui.summary.title = result.reason;

    const fields = [
      [FIELD_LABELS.requestModel, "requestModel", false],
      [FIELD_LABELS.serverModel, "serverModel", false],
      [FIELD_LABELS.assistantModel, "assistantModel", true],
      [FIELD_LABELS.resolvedModel, "resolvedModel", true],
      [FIELD_LABELS.requestedExperience, "requestedExperience", true],
      [FIELD_LABELS.domModel, "domModel", true],
      [FIELD_LABELS.thinkingEffort, "thinkingEffort", true]
    ];

    ui.fields.replaceChildren(
      ...fields.map(([label, field, optional]) =>
        makeField(
          label,
          turn
            ? formatEvidenceValue(
                turn,
                field,
                optional,
                field === "serverModel" &&
                  turnState.isWaitingForDelayedMetadata(turn),
                field === "serverModel"
                  ? "等待延迟模型元数据…"
                  : undefined
              )
            : null,
          optional
        )
      )
    );
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

    if (data.type === "request") {
      const id = clean(data.requestId, 80);
      if (!id) return;

      const result = turnStore.beginRequest(id, {
        model: data.model,
        thinkingEffort: data.thinkingEffort
      });
      const turn = result && result.turn;
      if (!turn) return;

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
      case "response-end":
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
    if (node !== lastAssistantNode()) return;

    const value = clean(node.getAttribute("data-message-model-slug"));
    if (!value) return;

    turnState.addEvidence(turn, "domModel", value);
    render();
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
  window.setTimeout(render, 500);
})();
