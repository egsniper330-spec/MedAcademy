"use strict";
var import_expo = require("expo");
var import_react_native = require("react-native");
var import_web_stub_dialog = require("./web-stub-dialog");
var import_i18n = require("./i18n");
if (import_react_native.Platform.OS !== "web" && !(0, import_expo.isRunningInExpoGo)()) {
  module.exports = require("expo-notifications");
} else {
  let showDetailedAlert = function(apiName, lines, isValid, errors) {
    if (import_react_native.Platform.OS === "web") {
      (0, import_web_stub_dialog.showWebStubDialog)({
        title: apiName,
        details: lines,
        errors: !isValid && errors && errors.length > 0 ? errors : void 0
      });
      return;
    }
    const statusLine = isValid ? (0, import_i18n.t)("notifications.validationPassed") : (0, import_i18n.t)("notifications.validationFailed");
    const parts = [statusLine, "", ...lines];
    if (!isValid && errors && errors.length > 0) {
      parts.push("");
      parts.push((0, import_i18n.t)("alert.issues", { value: errors.join(" / ") }));
      parts.push("");
      parts.push((0, import_i18n.t)("notifications.fixAndRetry"));
    } else {
      parts.push("");
      parts.push((0, import_i18n.t)("notifications.configCorrect"));
    }
    import_react_native.Alert.alert(apiName, parts.join("\n"), [{ text: (0, import_i18n.t)("common.dismiss") }]);
  }, formatScheduleRequest = function(request) {
    if (!request || typeof request !== "object") {
      return [(0, import_i18n.t)("notifications.invalidRequest")];
    }
    const req = request;
    const content = req["content"] && typeof req["content"] === "object" ? req["content"] : void 0;
    const trigger = req["trigger"];
    const lines = [];
    const titleVal = content?.["title"];
    const bodyVal = content?.["body"];
    lines.push((0, import_i18n.t)("notifications.title", { value: titleVal != null ? JSON.stringify(String(titleVal)) : (0, import_i18n.t)("common.notFilled") }));
    lines.push((0, import_i18n.t)("notifications.body", { value: bodyVal != null ? JSON.stringify(String(bodyVal)) : (0, import_i18n.t)("common.notFilled") }));
    if (content?.["subtitle"] != null) {
      const sub = JSON.stringify(String(content["subtitle"]));
      lines.push((0, import_i18n.t)("notifications.subtitle", { value: sub.length > 42 ? sub.slice(0, 42) + "\u2026" : sub }));
    }
    if (content?.["data"] != null) {
      const dataStr = JSON.stringify(content["data"]);
      lines.push((0, import_i18n.t)("notifications.data", { value: dataStr.length > 40 ? dataStr.slice(0, 40) + "\u2026" : dataStr }));
    }
    if (trigger == null) {
      lines.push((0, import_i18n.t)("notifications.triggerImmediate"));
    } else if (typeof trigger === "object") {
      const trig = trigger;
      if (trig["type"] === "timeInterval") {
        lines.push((0, import_i18n.t)("notifications.triggerDelay", { seconds: String(trig["seconds"]) }));
      } else if (trig["type"] === "date") {
        lines.push((0, import_i18n.t)("notifications.triggerDate", { value: String(trig["value"] ?? (0, import_i18n.t)("notifications.unknown")) }));
      } else {
        const ts = JSON.stringify(trigger);
        lines.push((0, import_i18n.t)("notifications.triggerOther", { value: ts.length > 40 ? ts.slice(0, 40) + "\u2026" : ts }));
      }
    } else {
      lines.push((0, import_i18n.t)("notifications.triggerOther", { value: String(trigger) }));
    }
    return lines;
  }, validateScheduleRequest = function(request) {
    const errors = [];
    if (!request || typeof request !== "object") {
      errors.push((0, import_i18n.t)("notifications.requestCannotBeEmpty"));
      return { ok: false, errors };
    }
    const req = request;
    if (!req["content"] || typeof req["content"] !== "object") {
      errors.push((0, import_i18n.t)("notifications.contentCannotBeEmpty"));
      return { ok: false, errors };
    }
    const content = req["content"];
    const titleOk = typeof content["title"] === "string" && content["title"].trim().length > 0;
    const bodyOk = typeof content["body"] === "string" && content["body"].trim().length > 0;
    if (!titleOk && !bodyOk) {
      errors.push((0, import_i18n.t)("notifications.titleAndBodyEmpty"));
    }
    const trigger = req["trigger"];
    if (trigger != null && typeof trigger === "object") {
      const trig = trigger;
      if (trig["type"] === "timeInterval") {
        if (typeof trig["seconds"] !== "number" || trig["seconds"] <= 0) {
          errors.push((0, import_i18n.t)("notifications.triggerSecondsMustBePositive"));
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }, validateChannel = function(channelId, channel) {
    const errors = [];
    if (typeof channelId !== "string" || channelId.trim().length === 0) {
      errors.push((0, import_i18n.t)("notifications.channelIdMustBeNonEmpty"));
    }
    if (!channel || typeof channel !== "object") {
      errors.push((0, import_i18n.t)("notifications.channelCannotBeEmpty"));
      return { ok: false, errors };
    }
    const ch = channel;
    if (typeof ch["name"] !== "string" || ch["name"].trim().length === 0) {
      errors.push((0, import_i18n.t)("notifications.channelNameMustBeNonEmpty"));
    }
    return { ok: errors.length === 0, errors };
  };
  var showDetailedAlert2 = showDetailedAlert, formatScheduleRequest2 = formatScheduleRequest, validateScheduleRequest2 = validateScheduleRequest, validateChannel2 = validateChannel;
  const DENIED_PERMISSION = {
    status: "denied",
    granted: false,
    canAskAgain: false,
    expires: "never"
  };
  const handleRequestPermissionsAsync = async () => {
    showDetailedAlert(
      (0, import_i18n.t)("notifications.requestPermission"),
      [(0, import_i18n.t)("notifications.scanPreviewDenied"), (0, import_i18n.t)("notifications.publishWillShowSystemPrompt")],
      true
    );
    return DENIED_PERMISSION;
  };
  const handleSetNotificationChannelAsync = async (channelId, channel) => {
    const { ok, errors } = validateChannel(channelId, channel);
    const ch = channel && typeof channel === "object" ? channel : {};
    const chStr = JSON.stringify(channel);
    const lines = [
      (0, import_i18n.t)("notifications.channelId", { value: JSON.stringify(channelId) }),
      (0, import_i18n.t)("notifications.channelName", { value: JSON.stringify(ch["name"] ?? (0, import_i18n.t)("common.notSet")) }),
      (0, import_i18n.t)("notifications.fullConfig", { value: chStr.length > 60 ? chStr.slice(0, 60) + "\u2026" : chStr })
    ];
    showDetailedAlert((0, import_i18n.t)("notifications.createChannel"), lines, ok, ok ? void 0 : errors);
    return null;
  };
  const handleScheduleNotificationAsync = async (request) => {
    const { ok, errors } = validateScheduleRequest(request);
    const lines = formatScheduleRequest(request);
    showDetailedAlert((0, import_i18n.t)("notifications.scheduleNotification"), lines, ok, ok ? void 0 : errors);
    return void 0;
  };
  const noopPermission = async () => DENIED_PERMISSION;
  const noopListener = () => ({ remove: () => {
  } });
  const noop = async () => void 0;
  const enums = {
    AndroidNotificationPriority: {
      MIN: "min",
      LOW: "low",
      DEFAULT: "default",
      HIGH: "high",
      MAX: "max"
    },
    AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 },
    SchedulableTriggerInputTypes: {
      DATE: "date",
      TIME_INTERVAL: "timeInterval",
      CALENDAR: "calendar",
      DAILY: "daily",
      WEEKLY: "weekly",
      YEARLY: "yearly"
    }
  };
  const coreHandlers = {
    requestPermissionsAsync: handleRequestPermissionsAsync,
    setNotificationChannelAsync: handleSetNotificationChannelAsync,
    scheduleNotificationAsync: handleScheduleNotificationAsync
  };
  module.exports = new Proxy(enums, {
    get(target, key) {
      if (key in target) return target[key];
      if (key in coreHandlers) return coreHandlers[key];
      if (key.endsWith("PermissionsAsync")) return noopPermission;
      if (key.endsWith("Listener")) return noopListener;
      return noop;
    }
  });
}
//# sourceMappingURL=expo-notifications-stub.js.map