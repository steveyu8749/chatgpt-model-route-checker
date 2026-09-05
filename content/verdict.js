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

  const LABELS = Object.freeze({
    [STATUS.IDLE]: "模型检测",
    [STATUS.CHECKING]: "检测中",
    [STATUS.MATCH]: "模型对应",
    [STATUS.MISMATCH]: "模型不对应",
    [STATUS.REVIEW]: "待确认",
    [STATUS.UNAVAILABLE]: "无法检测"
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
    return [
      evidence.assistantModel,
      evidence.resolvedModel,
      evidence.domModel
    ]
      .map(normalizeModel)
      .filter(Boolean);
  }

  function hasAuxiliaryConflict(auxiliary, serverModel) {
    // Comparing every non-empty auxiliary value to the primary server value
    // covers both cases: one value disagrees with serverModel, or auxiliary
    // values disagree with each other (because at least one then differs
    // from serverModel).
    return auxiliary.some((value) => value !== serverModel);
  }

  function classify(input = {}, options = {}) {
    const evidence = input || {};
    const requestModel = normalizeModel(evidence.requestModel);
    const serverModel = normalizeModel(evidence.serverModel);
    const complete = Boolean(evidence.complete);
    const rules = options.rules || {};
    const auxiliary = modelValues(evidence);
    const uniqueAuxiliary = [...new Set(auxiliary)];

    if (!requestModel || !serverModel) {
      return {
        status: complete ? STATUS.UNAVAILABLE : STATUS.CHECKING,
        label: LABELS[complete ? STATUS.UNAVAILABLE : STATUS.CHECKING],
        reason: !requestModel
          ? "未取得客户端请求模型。"
          : "尚未取得服务端模型路由元数据。",
        requestModel: clean(evidence.requestModel),
        serverModel: clean(evidence.serverModel),
        auxiliary: uniqueAuxiliary
      };
    }

    const auxiliaryConflict = hasAuxiliaryConflict(auxiliary, serverModel);

    if (requestModel === serverModel && auxiliaryConflict) {
      return {
        status: STATUS.REVIEW,
        label: LABELS[STATUS.REVIEW],
        reason:
          "主字段一致，但一个或多个辅助模型字段与 serverModel 不同，或辅助字段彼此不一致。",
        requestModel: clean(evidence.requestModel),
        serverModel: clean(evidence.serverModel),
        auxiliary: uniqueAuxiliary
      };
    }

    if (requestModel === serverModel) {
      return {
        status: STATUS.MATCH,
        label: LABELS[STATUS.MATCH],
        reason: "客户端请求模型与服务端公开模型标注完全一致。",
        requestModel: clean(evidence.requestModel),
        serverModel: clean(evidence.serverModel),
        auxiliary: uniqueAuxiliary
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
        reason: "两者属于已明确配置的合法路由映射。",
        requestModel: clean(evidence.requestModel),
        serverModel: clean(evidence.serverModel),
        auxiliary: uniqueAuxiliary
      };
    }

    if (hasPair(rules.incompatible, requestModel, serverModel)) {
      return {
        status: STATUS.MISMATCH,
        label: LABELS[STATUS.MISMATCH],
        reason: "两者命中了已明确配置的不兼容模型对。",
        requestModel: clean(evidence.requestModel),
        serverModel: clean(evidence.serverModel),
        auxiliary: uniqueAuxiliary
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
      reason,
      requestModel: clean(evidence.requestModel),
      serverModel: clean(evidence.serverModel),
      auxiliary: uniqueAuxiliary
    };
  }

  function emptyResult() {
    return {
      status: STATUS.IDLE,
      label: LABELS[STATUS.IDLE],
      reason: "发送一条消息后开始核对本轮模型路由。",
      requestModel: null,
      serverModel: null,
      auxiliary: []
    };
  }

  return Object.freeze({
    STATUS,
    LABELS,
    clean,
    normalizeModel,
    classify,
    emptyResult
  });
});
