"use strict";
var import_expo = require("expo");
var import_react_native = require("react-native");
var import_web_stub_dialog = require("./web-stub-dialog");
var import_i18n = require("./i18n");
if (import_react_native.Platform.OS !== "web" && !(0, import_expo.isRunningInExpoGo)()) {
  module.exports = require("expo-haptics");
} else {
  let validateImpactStyle = function(style) {
    const valid = Object.values(ImpactFeedbackStyle);
    if (style == null) return { ok: true, errors: [] };
    if (typeof style !== "string" || !valid.includes(style)) {
      return {
        ok: false,
        errors: [(0, import_i18n.t)("haptics.styleMustBeEnum", { valid: valid.join(" / "), received: JSON.stringify(style) })]
      };
    }
    return { ok: true, errors: [] };
  }, validateNotificationType = function(type) {
    const valid = Object.values(NotificationFeedbackType);
    if (type == null) return { ok: true, errors: [] };
    if (typeof type !== "string" || !valid.includes(type)) {
      return {
        ok: false,
        errors: [(0, import_i18n.t)("haptics.typeMustBeEnum", { valid: valid.join(" / "), received: JSON.stringify(type) })]
      };
    }
    return { ok: true, errors: [] };
  };
  var validateImpactStyle2 = validateImpactStyle, validateNotificationType2 = validateNotificationType;
  const ImpactFeedbackStyle = {
    Light: "light",
    Medium: "medium",
    Heavy: "heavy",
    Rigid: "rigid",
    Soft: "soft"
  };
  const NotificationFeedbackType = {
    Success: "success",
    Warning: "warning",
    Error: "error"
  };
  const SelectionFeedbackType = {};
  const handleImpactAsync = async (style) => {
    const { ok, errors } = validateImpactStyle(style);
    (0, import_web_stub_dialog.showWebStubDialog)({
      title: (0, import_i18n.t)("haptics.impact"),
      details: [`style: ${style != null ? JSON.stringify(style) : (0, import_i18n.t)("common.defaultMedium")}`, (0, import_i18n.t)("haptics.webUnsupported")],
      errors: ok ? void 0 : errors
    });
  };
  const handleNotificationAsync = async (type) => {
    const { ok, errors } = validateNotificationType(type);
    (0, import_web_stub_dialog.showWebStubDialog)({
      title: (0, import_i18n.t)("haptics.notification"),
      details: [`type: ${type != null ? JSON.stringify(type) : (0, import_i18n.t)("common.defaultSuccess")}`, (0, import_i18n.t)("haptics.webUnsupported")],
      errors: ok ? void 0 : errors
    });
  };
  const handleSelectionAsync = async () => {
    (0, import_web_stub_dialog.showWebStubDialog)({
      title: (0, import_i18n.t)("haptics.selection"),
      details: [(0, import_i18n.t)("haptics.webUnsupported")]
    });
  };
  const enums = {
    ImpactFeedbackStyle,
    NotificationFeedbackType,
    SelectionFeedbackType
  };
  const coreHandlers = {
    impactAsync: handleImpactAsync,
    notificationAsync: handleNotificationAsync,
    selectionAsync: handleSelectionAsync
  };
  const noop = async () => void 0;
  module.exports = new Proxy(enums, {
    get(target, key) {
      if (key in target) return target[key];
      if (key in coreHandlers) return coreHandlers[key];
      return noop;
    }
  });
}
//# sourceMappingURL=expo-haptics-stub.js.map