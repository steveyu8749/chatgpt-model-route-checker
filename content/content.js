/* global chrome, document, window, MutationObserver, navigator */
(function installContentScript() {
  "use strict";

  const CHANNEL = "__CHATGPT_MODEL_ROUTE_CHECKER_V1__";
  const HOST_ID = "__chatgpt_model_route_checker_host__";
  const MAX_TURNS = 8;
  const RESPONSE_END_GRACE_MS = 1500;
  const NETWORK_EVIDENCE_TYPES = new Set([
    "server-model",
    "assistant-model",
    "resolved-model",
    "requested-experience",
    "thinking-effort",
    "response-end"
  ]);
  const api = window.ChatGPTRouteVerdict;
  const rules = window.CHATGPT_ROUTE_CHECKER_RULES || {
    equivalent: [],
    incompatible: []
  };

  if (!api || document.getElementById(HOST_ID)) return;

  const turns = new Map();
  let currentId = null;
  let expanded = false;
  let ui = null;

  function clean(value, maxLength = 200) {
    return api.clean(value, maxLength);
  }

  function newTurn(id) {
    return {
      id,
      requestModel: null,
      serverModel: null,
      assistantModel: null,
      resolvedModel: null,
      requestedExperience: null,
      domModel: null,
      thinkingEffort: null,
      complete: false,
      completionTimer: null,
      startedAt: Date.now()
    };
  }

  function getTurn(id, create = true) {
    if (!id) return null;

    let turn = turns.get(id);
    if (!turn && create) {
      turn = newTurn(id);
      turns.set(id, turn);
      while (turns.size > MAX_TURNS) {
        turns.delete(turns.keys().next().value);
      }
    }
    return turn;
  }

  function currentTurn() {
    return currentId ? turns.get(currentId) : null;
  }

  function scheduleCompletion(turn) {
    if (!turn || turn.complete) return;
    if (turn.completionTimer) window.clearTimeout(turn.completionTimer);

    // Telemetry can carry the same route metadata shortly after the
    // conversation stream closes. Keep the turn in a neutral checking state
    // during this short grace period so "无法检测" does not flash early.
    turn.completionTimer = window.setTimeout(() => {
      turn.completionTimer = null;
      turn.complete = true;
      if (currentId === turn.id) render();
    }, RESPONSE_END_GRACE_MS);
  }

  function displayValue(value, waiting = false, optional = false) {
    if (value) return value;
    return waiting ? "等待服务端…" : optional ? "未提供（可选）" : "未获取";
  }

  function modelLine(result) {
    if (!result.requestModel && !result.serverModel) {
      return "发送消息后显示本轮模型";
    }
    return `${displayValue(result.requestModel)} → ${displayValue(result.serverModel)}`;
  }

  function resultForTurn(turn) {
    if (!turn) return api.emptyResult();

    return api.classify(
      {
        requestModel: turn.requestModel,
        serverModel: turn.serverModel,
        assistantModel: turn.assistantModel,
        resolvedModel: turn.resolvedModel,
        domModel: turn.domModel,
        complete: turn.complete
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
    if (!value && optional) valueElement.classList.add("is-optional");
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
    const copy = makeElement("button", "route-copy", "复制结果");
    copy.type = "button";
    footer.append(note, copy);

    details.append(reason, fields, footer);
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
        copy.textContent = "复制结果";
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
      fields,
      copy
    };
  }

  function formatCopyText(turn, result) {
    const current = turn || {};
    const optional = (value) => value || "未提供（可选）";
    return [
      `状态：${result.label}`,
      `判定理由：${result.reason}`,
      `客户端 request.model：${current.requestModel || "未获取"}`,
      `服务端 server_ste_metadata.model_slug：${current.serverModel || "未获取"}`,
      `assistant metadata.model_slug：${optional(current.assistantModel)}`,
      `resolved_model_slug：${optional(current.resolvedModel)}`,
      `requested_model_experience：${optional(current.requestedExperience)}`,
      `DOM data-message-model-slug：${optional(current.domModel)}`,
      `request.thinking_effort：${optional(current.thinkingEffort)}`
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
    ui.status.textContent = `${statusIcon(result.status)} ${result.label}`;
    ui.line.textContent = modelLine(result);
    ui.reason.textContent = result.reason;
    ui.summary.title = result.reason;

    const fields = [
      ["客户端 request.model", turn && turn.requestModel, false],
      ["服务端 server_ste_metadata.model_slug", turn && turn.serverModel, false],
      ["assistant metadata.model_slug", turn && turn.assistantModel, true],
      ["resolved_model_slug", turn && turn.resolvedModel, true],
      ["requested_model_experience", turn && turn.requestedExperience, true],
      ["DOM data-message-model-slug", turn && turn.domModel, true],
      ["request.thinking_effort", turn && turn.thinkingEffort, true]
    ];

    ui.fields.replaceChildren(
      ...fields.map(([label, value, optional]) => makeField(label, value, optional))
    );
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

      const existing = turns.get(id);
      const turn = existing || getTurn(id);
      if (!turn) return;

      // The bridge can send a second request event after cloning a Request.
      // Keep response evidence already collected for this same turn.
      if (typeof data.model === "string") {
        const model = clean(data.model);
        if (model) turn.requestModel = model;
      }
      if (typeof data.thinkingEffort === "string") {
        const thinkingEffort = clean(data.thinkingEffort, 80);
        if (thinkingEffort) turn.thinkingEffort = thinkingEffort;
      }
      // A first request event starts the visible turn. A duplicate request
      // event can arrive later when a Request clone finishes reading; never
      // let that late update switch the card back to an older turn.
      if (!existing || !currentId) currentId = id;
      if (currentId === id) render();
      return;
    }

    const eventId = clean(data.requestId, 80);
    if (NETWORK_EVIDENCE_TYPES.has(data.type) && !eventId) return;
    const wasCurrent = !currentId || !eventId || eventId === currentId;
    const turn = eventTurn(data);
    if (!turn) return;

    const value = clean(data.value);
    switch (data.type) {
      case "server-model":
        turn.serverModel = value;
        break;
      case "assistant-model":
        turn.assistantModel = value;
        break;
      case "resolved-model":
        turn.resolvedModel = value;
        break;
      case "requested-experience":
        turn.requestedExperience = value;
        break;
      case "dom-model":
        turn.domModel = value;
        break;
      case "thinking-effort":
        turn.thinkingEffort = value;
        break;
      case "response-end":
        scheduleCompletion(turn);
        break;
      default:
        return;
    }

    // A delayed response from an older concurrent request may still arrive.
    // It updates its own in-memory record, but must not pull the visible card
    // away from the newest request.
    if (!currentId && eventId) currentId = eventId;
    if (wasCurrent) render();
  }

  function lastAssistantNode() {
    const nodes = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function maybeReadDomModel(node) {
    const turn = currentTurn();
    if (!turn || !node || node !== lastAssistantNode()) return;

    const value = clean(node.getAttribute("data-message-model-slug"));
    if (!value) return;

    turn.domModel = value;
    render();
  }

  function inspectAddedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    maybeReadDomModel(node);
    for (const child of node.querySelectorAll(
      '[data-message-author-role="assistant"]'
    )) {
      maybeReadDomModel(child);
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
