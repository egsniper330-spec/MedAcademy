"use strict";
var import_react_native = require("react-native");
var import_expo = require("expo");
var import_web_stub_dialog = require("./web-stub-dialog");
var import_i18n = require("./i18n");
if (import_react_native.Platform.OS !== "web" && !(0, import_expo.isRunningInExpoGo)()) {
  module.exports = require("expo-media-library");
} else {
  let showMediaLibraryAlert = function(title, lines, isValid, errors) {
    if (import_react_native.Platform.OS === "web") {
      (0, import_web_stub_dialog.showWebStubDialog)({
        title,
        details: lines,
        errors: !isValid && errors && errors.length > 0 ? errors : void 0
      });
      return;
    }
    const statusLine = isValid ? (0, import_i18n.t)("preview.statusValid") : (0, import_i18n.t)("preview.statusInvalid");
    const parts = [(0, import_i18n.t)("preview.scanUnsupportedMediaLibrary"), "", ...lines, "", statusLine];
    if (!isValid && errors && errors.length > 0) {
      parts.push((0, import_i18n.t)("alert.issues", { value: errors.join(" / ") }));
      parts.push("");
      parts.push((0, import_i18n.t)("preview.screenshotForAgent"));
    } else {
      parts.push("");
      parts.push((0, import_i18n.t)("preview.availableAfterPublish"));
    }
    import_react_native.Alert.alert(title, parts.join("\n"), [{ text: (0, import_i18n.t)("common.dismiss") }]);
  }, validateUri = function(uri) {
    const errors = [];
    if (typeof uri !== "string" || uri.trim().length === 0) {
      errors.push((0, import_i18n.t)("validation.uriMustBeNonEmptyString"));
      return { ok: false, errors };
    }
    const validPrefixes = ["file://", "content://", "ph://"];
    if (!validPrefixes.some((p) => uri.startsWith(p))) {
      errors.push((0, import_i18n.t)("validation.uriFormatInvalid"));
    }
    return { ok: errors.length === 0, errors };
  }, usePermissions = function() {
    const [permission, setPermission] = useState(GRANTED_PERMISSION);
    const requestPermission = useCallback(async () => {
      setPermission(GRANTED_PERMISSION);
      return GRANTED_PERMISSION;
    }, []);
    const getPermission = useCallback(async () => permission, [permission]);
    return [permission, requestPermission, getPermission];
  };
  var showMediaLibraryAlert2 = showMediaLibraryAlert, validateUri2 = validateUri, usePermissions2 = usePermissions;
  const UNDETERMINED_PERMISSION = {
    status: "undetermined",
    granted: false,
    canAskAgain: true,
    expires: "never"
  };
  const DENIED_PERMISSION = {
    status: "denied",
    granted: false,
    canAskAgain: false,
    expires: "never"
  };
  const GRANTED_PERMISSION = {
    status: "granted",
    granted: true,
    canAskAgain: true,
    expires: "never",
    accessPrivileges: "all"
  };
  const { useState, useCallback } = require("react");
  const saveToLibraryAsync = async (uri) => {
    const { ok, errors } = validateUri(uri);
    const uriStr = typeof uri === "string" ? uri : String(uri);
    const uriDisplay = uriStr.length > 60 ? uriStr.slice(0, 60) + "\u2026" : uriStr;
    if (!ok) {
      showMediaLibraryAlert((0, import_i18n.t)("mediaLibrary.saveToLibrary"), [`URI: ${uriDisplay}`], ok, errors);
    }
  };
  const createAssetAsync = async (uri) => {
    const { ok, errors } = validateUri(uri);
    const uriStr = typeof uri === "string" ? uri : String(uri);
    const filename = uriStr.split("/").pop() ?? (0, import_i18n.t)("common.unknownFilename");
    const uriDisplay = uriStr.length > 60 ? uriStr.slice(0, 60) + "\u2026" : uriStr;
    if (!ok) {
      showMediaLibraryAlert((0, import_i18n.t)("mediaLibrary.createAsset"), [`URI: ${uriDisplay}`, (0, import_i18n.t)("mediaLibrary.filename", { value: filename })], ok, errors);
    }
    return {
      id: "stub",
      filename,
      uri: uriStr,
      mediaType: "photo",
      mediaSubtypes: [],
      width: 0,
      height: 0,
      creationTime: 0,
      modificationTime: 0,
      duration: 0
    };
  };
  const requestPermissionsAsync = async () => GRANTED_PERMISSION;
  const getPermissionsAsync = async () => GRANTED_PERMISSION;
  const enums = {
    PermissionStatus: {
      GRANTED: "granted",
      DENIED: "denied",
      UNDETERMINED: "undetermined",
      LIMITED: "limited"
    },
    MediaType: {
      photo: "photo",
      video: "video",
      audio: "audio",
      unknown: "unknown"
    },
    SortBy: {
      default: "default",
      creationTime: "creationTime",
      modificationTime: "modificationTime",
      mediaType: "mediaType",
      width: "width",
      height: "height",
      duration: "duration"
    }
  };
  const coreHandlers = {
    usePermissions,
    saveToLibraryAsync,
    createAssetAsync,
    requestPermissionsAsync,
    getPermissionsAsync
  };
  const noopPermission = async () => GRANTED_PERMISSION;
  const noop = async () => void 0;
  module.exports = new Proxy(enums, {
    get(target, key) {
      if (key in target) return target[key];
      if (key in coreHandlers) return coreHandlers[key];
      if (key.endsWith("PermissionsAsync")) return noopPermission;
      return noop;
    }
  });
}
//# sourceMappingURL=expo-media-library-stub.js.map