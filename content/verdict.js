/*
 * Pure classification engine. It is deliberately usable both in a browser
 * content script and from Node-based tests (CommonJS).
 */
(function installVerdict(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ChatGPTRouteVerdict = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createApi() {
  const STATUS = Object.freeze({
    IDLE: "idle",
    CHECKING: "checking",
    MATCH: "match",
    MISMATCH: "mismatch",
    REVIEW: "review",
    UNAVAILABLE: "unavailable"
  });

  // These reasons describe where an otherwise valid turn stopped producing
  // evidence. They are deliberately separate from STATUS.UNAVAILABLE so the
  // UI can explain a failure without treating it as a model mismatch.
  const UNAVAILABLE_REASONS = Object.freeze({
    REQUEST_MODEL_MISSING: "request-model-missing",
    RESPONSE_NOT_CAPTURED: "response-not-captured",
    RESPONSE_NO_FIELDS: "response-no-fields",
    RESPONSE_INTERRUPTED: "response-interrupted",
    RESPONSE_STALLED: "response-stalled",
    UNSUPPORTED_RESPONSE: "unsupported-response"
  });

  const UNAVAILABLE_LABELS = Object.freeze({
    [UNAVAILABLE_REASONS.REQUEST_MODEL_MISSING]: "请求无模型",
    [UNAVAILABLE_REASONS.RESPONSE_NOT_CAPTURED]: "未捕获响应",
    [UNAVAILABLE_REASONS.RESPONSE_NO_FIELDS]: "未观察到标注",
    [UNAVAILABLE_REASONS.RESPONSE_INTERRUPTED]: "响应中断",
    [UNAVAILABLE_REASONS.RESPONSE_STALLED]: "响应采集停滞",
    [UNAVAILABLE_REASONS.UNSUPPORTED_RESPONSE]: "格式不支持"
  });

  const LABELS = Object.freeze({
    [STATUS.IDLE]: "模型检测",
    [STATUS.CHECKING]: "检测中",
    [STATUS.MATCH]: "模型对应",
    [STATUS.MISMATCH]: "模型不对应",
    [STATUS.REVIEW]: "待确认",
    [STATUS.UNAVAILABLE]: "无法检测"
  });

  const REASON_TEXT = Object.freeze({
    [UNAVAILABLE_REASONS.REQUEST_MODEL_MISSING]:
      "已捕获对话请求，但请求中没有 request.model。",
    [UNAVAILABLE_REASONS.RESPONSE_NOT_CAPTURED]:
      "已捕获请求，但未捕获到对应的响应。",
    [UNAVAILABLE_REASONS.RESPONSE_NO_FIELDS]:
      "本轮尚未观察到服务端模型标注；若迟到 telemetry 仍在关联窗口内到达，结果会自动更新。",
    [UNAVAILABLE_REASONS.RESPONSE_STALLED]:
      "连续 30 秒未观察到响应进度，暂时结束检测；后续收到数据时会自动恢复。",
    [UNAVAILABLE_REASONS.RESPONSE_INTERRUPTED]:
      "响应在读取过程中被中断，未能完成模型字段采集。",
    [UNAVAILABLE_REASONS.UNSUPPORTED_RESPONSE]:
      "已收到响应，但其格式暂不支持解析。"
  });

  function clean(value, maxLength = 200) {
    if (typeof value !== "string") return null;

    const result = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();

    return result ? result.slice(0, maxLength) : null;
  }

  function normalizeModel(value) {
    const result = clean(value, 200);
    return result ? result.toLowerCase() : null;
  }

  function pairMatches(pair, requestModel, serverModel) {
    if (!pair) return false;

    const request = Array.isArray(pair)
      ? pair[0]
      : pair.request ?? pair.requestModel;
    const server = Array.isArray(pair)
      ? pair[1]
      : pair.server ?? pair.serverModel;

    return (
      normalizeModel(request) === requestModel &&
      normalizeModel(server) === serverModel
    );
  }

  function hasPair(pairs, requestModel, serverModel) {
    if (!Array.isArray(pairs)) return false;

    // Model route rules are directional: the first value is what the
    // browser requested and the second is what the server returned. A
    // reverse route must be configured separately if it is valid.
    return pairs.some((pair) => pairMatches(pair, requestModel, serverModel));
  }

  function modelValues(evidence) {
    return ["assistantModel", "resolvedModel", "domModel"].flatMap((field) =>
      normalizedFieldValues(evidence, field)
    );
  }

  function rawFieldValues(evidence, field) {
    const suppliedValues =
      evidence &&
      evidence.evidenceValues &&
      Array.isArray(evidence.evidenceValues[field])
        ? evidence.evidenceValues[field]
        : null;
    const supplied =
      suppliedValues && suppliedValues.length
        ? suppliedValues
        : [evidence && evidence[field]];
    const values = [];
    const seen = new Set();
    for (const value of supplied.slice(0, 8)) {
      const cleaned = clean(value, field === "thinkingEffort" ? 80 : 200);
      const key = normalizeModel(cleaned);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      values.push(cleaned);
    }
    return values;
  }

  function normalizedFieldValues(evidence, field) {
    return rawFieldValues(evidence, field)
      .map(normalizeModel)
      .filter(Boolean);
  }

  function firstFieldValue(evidence, field) {
    return rawFieldValues(evidence, field)[0] || null;
  }

  function hasFieldConflict(evidence, field) {
    return (
      rawFieldValues(evidence, field).length > 1 ||
      Boolean(evidence && evidence.evidenceConflicts && evidence.evidenceConflicts[field])
    );
  }

  function conflictDetails(evidence) {
    const fields = [
      "requestModel",
      "serverModel",
      "assistantModel",
      "resolvedModel",
      "domModel",
      "requestedExperience",
      "thinkingEffort"
    ];
    return Object.fromEntries(
      fields
        .filter((field) => hasFieldConflict(evidence, field))
        .map((field) => [field, rawFieldValues(evidence, field)])
    );
  }

  function hasAuxiliaryConflict(evidence, auxiliary, serverModel) {
    // Comparing every non-empty auxiliary value to the primary server value
    // covers both cases: one value disagrees with serverModel, or auxiliary
    // values disagree with each other (because at least one then differs
    // from serverModel). A field's repeated identical value is not a conflict.
    return (
      ["assistantModel", "resolvedModel", "domModel"].some((field) =>
        hasFieldConflict(evidence, field)
      ) || auxiliary.some((value) => value !== serverModel)
    );
  }

  function unavailableReason(evidence, requestModel, serverModel) {
    if (!requestModel) {
      return UNAVAILABLE_REASONS.REQUEST_MODEL_MISSING;
    }

    if (serverModel) return null;

    const endReason = clean(evidence.responseEndReason, 80);
    if (!evidence.responseStarted) {
      return UNAVAILABLE_REASONS.RESPONSE_NOT_CAPTURED;
    }

    if (endReason === "stream-stalled") return UNAVAILABLE_REASONS.RESPONSE_STALLED;

    if (
      endReason === "read-error" ||
      endReason === "aborted" ||
      endReason === "interrupted"
    ) {
      return UNAVAILABLE_REASONS.RESPONSE_INTERRUPTED;
    }

    if (evidence.responseUnsupported) {
      return UNAVAILABLE_REASONS.UNSUPPORTED_RESPONSE;
    }

    return UNAVAILABLE_REASONS.RESPONSE_NO_FIELDS;
  }

  function checkingReason(evidence, requestModel, serverModel) {
    if (
      Object.prototype.hasOwnProperty.call(evidence, "requestCaptured") &&
      !evidence.requestCaptured &&
      !requestModel
    ) {
      return "正在等待捕获 ChatGPT 对话请求。";
    }
    if (!requestModel) return "已捕获请求，正在确认 request.model。";
    if (
      Object.prototype.hasOwnProperty.call(evidence, "responseStarted") &&
      !evidence.responseStarted
    ) {
      return "已捕获请求，正在等待 ChatGPT 响应。";
    }
    if (serverModel) return "正在核对服务端模型路由元数据。";
    if (evidence.responseEnded) {
      return "响应已结束，等待延迟模型元数据。";
    }
    return "已捕获响应，正在等待服务端模型路由元数据。";
  }

  function classify(input = {}, options = {}) {
    const evidence = input || {};
    const requestValues = normalizedFieldValues(evidence, "requestModel");
    const serverValues = normalizedFieldValues(evidence, "serverModel");
    const requestModel = requestValues[0] || null;
    const serverModel = serverValues[0] || null;
    const complete = Boolean(evidence.complete);
    const rules = options.rules || {};
    const auxiliary = modelValues(evidence);
    const uniqueAuxiliary = [...new Set(auxiliary)];
    const primaryConflicts = ["requestModel", "serverModel"].filter((field) =>
      hasFieldConflict(evidence, field)
    );
    const conflicts = conflictDetails(evidence);

    if (primaryConflicts.length) {
      const details = primaryConflicts
        .map((field) => `${field}=${rawFieldValues(evidence, field).join(" / ")}`)
        .join("；");
      return {
        status: STATUS.REVIEW,
        label: LABELS[STATUS.REVIEW],
        unavailableReason: null,
        reason: `主证据字段冲突：${details}。无法使用后到值覆盖先到值。`,
        requestModel: firstFieldValue(evidence, "requestModel"),
        serverModel: firstFieldValue(evidence, "serverModel"),
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    // No turn has been observed yet. This is the detector-ready/idle state,
    // not a formal detection failure; a content script cannot observe a
    // missing request without adding intrusive input/send listeners.
    if (!evidence.requestCaptured && !requestModel && !serverModel) {
      return {
        status: STATUS.IDLE,
        label: LABELS[STATUS.IDLE],
        unavailableReason: null,
        reason: "检测器已就绪，等待 ChatGPT 对话请求。",
        requestModel: null,
        serverModel: null,
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    if (!requestModel || !serverModel) {
      const reasonCode = complete
        ? unavailableReason(evidence, requestModel, serverModel)
        : null;
      return {
        status: complete ? STATUS.UNAVAILABLE : STATUS.CHECKING,
        label: LABELS[complete ? STATUS.UNAVAILABLE : STATUS.CHECKING],
        unavailableReason: reasonCode,
        reason: complete
          ? REASON_TEXT[reasonCode] || "本轮关键模型证据不足。"
          : checkingReason(evidence, requestModel, serverModel),
        requestModel: firstFieldValue(evidence, "requestModel"),
        serverModel: firstFieldValue(evidence, "serverModel"),
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    const auxiliaryConflict = hasAuxiliaryConflict(
      evidence,
      auxiliary,
      serverModel
    );

    if (requestModel === serverModel && auxiliaryConflict) {
      return {
        status: STATUS.REVIEW,
        label: LABELS[STATUS.REVIEW],
        unavailableReason: null,
        reason:
          "主字段一致，但一个或多个辅助模型字段与 serverModel 不同，或辅助字段彼此不一致。",
        requestModel: firstFieldValue(evidence, "requestModel"),
        serverModel: firstFieldValue(evidence, "serverModel"),
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    if (requestModel === serverModel) {
      return {
        status: STATUS.MATCH,
        label: LABELS[STATUS.MATCH],
        unavailableReason: null,
        reason: "客户端请求模型与服务端公开模型标注完全一致。",
        requestModel: firstFieldValue(evidence, "requestModel"),
        serverModel: firstFieldValue(evidence, "serverModel"),
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    const equivalent = hasPair(
      rules.equivalent,
      requestModel,
      serverModel
    );

    if (equivalent && !auxiliaryConflict) {
      return {
        status: STATUS.MATCH,
        label: LABELS[STATUS.MATCH],
        unavailableReason: null,
        reason: "两者属于已明确配置的合法路由映射。",
        requestModel: firstFieldValue(evidence, "requestModel"),
        serverModel: firstFieldValue(evidence, "serverModel"),
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    if (hasPair(rules.incompatible, requestModel, serverModel)) {
      return {
        status: STATUS.MISMATCH,
        label: LABELS[STATUS.MISMATCH],
        unavailableReason: null,
        reason: "两者命中了已明确配置的不兼容模型对。",
        requestModel: firstFieldValue(evidence, "requestModel"),
        serverModel: firstFieldValue(evidence, "serverModel"),
        auxiliary: uniqueAuxiliary,
        evidenceConflicts: conflicts
      };
    }

    const serverAgreement = auxiliary.filter(
      (value) => value === serverModel
    ).length;
    const requestAgreement = auxiliary.filter(
      (value) => value === requestModel
    ).length;

    let reason = "模型名称不同，尚未配置这组路由的明确映射。";

    if (auxiliaryConflict) {
      reason =
        "一个或多个辅助模型字段与 serverModel 不同，或辅助字段彼此不一致，无法据此确认路由关系。";
    } else if (serverAgreement > 0 && requestAgreement === 0) {
      reason = "辅助字段与服务端标注一致，但这组名称仍未配置为合法映射。";
    }

    // Unknown mappings are never promoted to a red result. This is the safe
    // default for private/unstable ChatGPT response fields.
    return {
      status: STATUS.REVIEW,
      label: LABELS[STATUS.REVIEW],
      unavailableReason: null,
      reason,
      requestModel: firstFieldValue(evidence, "requestModel"),
      serverModel: firstFieldValue(evidence, "serverModel"),
      auxiliary: uniqueAuxiliary,
      evidenceConflicts: conflicts
    };
  }

  function emptyResult() {
    return {
      status: STATUS.IDLE,
      label: LABELS[STATUS.IDLE],
      unavailableReason: null,
      reason: "发送一条消息后开始核对本轮模型路由。",
      requestModel: null,
      serverModel: null,
      auxiliary: []
    };
  }

  return Object.freeze({
    STATUS,
    LABELS,
    UNAVAILABLE_REASONS,
    UNAVAILABLE_LABELS,
    clean,
    normalizeModel,
    classify,
    emptyResult
  });
});
