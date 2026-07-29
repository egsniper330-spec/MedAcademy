"use strict";
var import_react_native = require("react-native");
var import_web_stub_dialog = require("./web-stub-dialog");
var import_i18n = require("./i18n");
if (import_react_native.Platform.OS !== "web") {
  module.exports = require("expo-file-system/legacy");
} else {
  let showFileSystemDialog = function(title, lines, isValid, errors) {
    (0, import_web_stub_dialog.showWebStubDialog)({
      title,
      details: lines,
      errors: !isValid && errors && errors.length > 0 ? errors : void 0
    });
  }, validateString = function(value, label) {
    const errors = [];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push((0, import_i18n.t)("validation.mustBeNonEmptyString", { label }));
    }
    return { ok: errors.length === 0, errors };
  }, validateRemoteUrl = function(url) {
    const errors = [];
    if (typeof url !== "string" || url.trim().length === 0) {
      errors.push((0, import_i18n.t)("validation.uriMustBeNonEmptyString"));
      return { ok: false, errors };
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      errors.push((0, import_i18n.t)("validation.uriMustStartWithHttp"));
    }
    return { ok: errors.length === 0, errors };
  }, truncate = function(s, max = 60) {
    return s.length > max ? s.slice(0, max) + "\u2026" : s;
  };
  var showFileSystemDialog2 = showFileSystemDialog, validateString2 = validateString, validateRemoteUrl2 = validateRemoteUrl, truncate2 = truncate;
  const cacheDirectory = "cache:/";
  const documentDirectory = "document:/";
  const bundleDirectory = "bundle:/";
  const downloadAsync = async (uri, fileUri, _options = {}) => {
    const { ok: uOk, errors: uErrors } = validateRemoteUrl(uri);
    const { ok: fOk, errors: fErrors } = validateString(fileUri, "fileUri");
    const ok = uOk && fOk;
    const uriStr = typeof uri === "string" ? truncate(uri) : String(uri);
    const fileUriStr = typeof fileUri === "string" ? fileUri : String(fileUri);
    showFileSystemDialog(
      (0, import_i18n.t)("fileSystem.download"),
      [(0, import_i18n.t)("fileSystem.source", { value: uriStr }), (0, import_i18n.t)("fileSystem.target", { value: fileUriStr })],
      ok,
      [...uErrors, ...fErrors]
    );
    return { uri: fileUriStr, status: 200, headers: {} };
  };
  const readAsStringAsync = async (fileUri, _options = {}) => {
    const { ok, errors } = validateString(fileUri, "fileUri");
    showFileSystemDialog((0, import_i18n.t)("fileSystem.readFile"), [`URI: ${typeof fileUri === "string" ? fileUri : String(fileUri)}`], ok, errors);
    return "";
  };
  const writeAsStringAsync = async (fileUri, contents, _options = {}) => {
    const { ok: fOk, errors: fErrors } = validateString(fileUri, "fileUri");
    const { ok: cOk, errors: cErrors } = validateString(contents, "contents");
    const fileUriStr = typeof fileUri === "string" ? fileUri : String(fileUri);
    showFileSystemDialog((0, import_i18n.t)("fileSystem.writeFile"), [`URI: ${fileUriStr}`], fOk && cOk, [...fErrors, ...cErrors]);
  };
  const deleteAsync = async (fileUri, _options = {}) => {
    const { ok, errors } = validateString(fileUri, "fileUri");
    showFileSystemDialog((0, import_i18n.t)("fileSystem.deleteFile"), [`URI: ${typeof fileUri === "string" ? fileUri : String(fileUri)}`], ok, errors);
  };
  const getInfoAsync = async (fileUri, _options = {}) => {
    const { ok, errors } = validateString(fileUri, "fileUri");
    showFileSystemDialog((0, import_i18n.t)("fileSystem.getInfo"), [`URI: ${typeof fileUri === "string" ? fileUri : String(fileUri)}`], ok, errors);
    return { exists: false, isDirectory: false, uri: typeof fileUri === "string" ? fileUri : "" };
  };
  const moveAsync = async (options) => {
    const opts = options ?? {};
    const { ok: fromOk, errors: fromErrors } = validateString(opts.from, "from");
    const { ok: toOk, errors: toErrors } = validateString(opts.to, "to");
    showFileSystemDialog(
      (0, import_i18n.t)("fileSystem.moveFile"),
      [(0, import_i18n.t)("fileSystem.from", { value: String(opts.from) }), (0, import_i18n.t)("fileSystem.to", { value: String(opts.to) })],
      fromOk && toOk,
      [...fromErrors, ...toErrors]
    );
  };
  const copyAsync = async (options) => {
    const opts = options ?? {};
    const { ok: fromOk, errors: fromErrors } = validateString(opts.from, "from");
    const { ok: toOk, errors: toErrors } = validateString(opts.to, "to");
    showFileSystemDialog(
      (0, import_i18n.t)("fileSystem.copyFile"),
      [(0, import_i18n.t)("fileSystem.from", { value: String(opts.from) }), (0, import_i18n.t)("fileSystem.to", { value: String(opts.to) })],
      fromOk && toOk,
      [...fromErrors, ...toErrors]
    );
  };
  const makeDirectoryAsync = async (fileUri, _options = {}) => {
    const { ok, errors } = validateString(fileUri, "fileUri");
    showFileSystemDialog((0, import_i18n.t)("fileSystem.createDir"), [`URI: ${typeof fileUri === "string" ? fileUri : String(fileUri)}`], ok, errors);
  };
  const readDirectoryAsync = async (fileUri) => {
    const { ok, errors } = validateString(fileUri, "fileUri");
    showFileSystemDialog((0, import_i18n.t)("fileSystem.readDir"), [`URI: ${typeof fileUri === "string" ? fileUri : String(fileUri)}`], ok, errors);
    return [];
  };
  const uploadAsync = async (url, fileUri, _options = {}) => {
    const { ok: uOk, errors: uErrors } = validateRemoteUrl(url);
    const { ok: fOk, errors: fErrors } = validateString(fileUri, "fileUri");
    const urlStr = typeof url === "string" ? truncate(url) : String(url);
    showFileSystemDialog((0, import_i18n.t)("fileSystem.upload"), [(0, import_i18n.t)("fileSystem.target", { value: urlStr })], uOk && fOk, [...uErrors, ...fErrors]);
    return { status: 200, headers: {}, body: "" };
  };
  const getFreeDiskStorageAsync = async () => 0;
  const getTotalDiskCapacityAsync = async () => 0;
  const getContentUriAsync = async (fileUri) => typeof fileUri === "string" ? fileUri : "";
  const deleteLegacyDocumentDirectoryAndroid = async () => {
  };
  class DownloadResumable {
    constructor(url, fileUri, options = {}, _callback, resumeData) {
      this._url = url;
      this._fileUri = fileUri;
      this._options = options;
      this._resumeData = resumeData;
    }
    get fileUri() {
      return this._fileUri;
    }
    async downloadAsync() {
      const { ok, errors } = validateRemoteUrl(this._url);
      showFileSystemDialog((0, import_i18n.t)("fileSystem.downloadResumable"), [(0, import_i18n.t)("fileSystem.source", { value: truncate(this._url) })], ok, errors);
      return { uri: this._fileUri, status: 200, headers: {} };
    }
    async pauseAsync() {
      return { url: this._url, fileUri: this._fileUri, options: this._options };
    }
    async resumeAsync() {
      return this.downloadAsync();
    }
    async cancelAsync() {
    }
    savable() {
      return {
        url: this._url,
        fileUri: this._fileUri,
        options: this._options,
        resumeData: this._resumeData
      };
    }
  }
  class UploadTask {
    constructor(_url, _fileUri, _options = {}, _callback) {
      this._url = _url;
      this._fileUri = _fileUri;
      this._options = _options;
      this._callback = _callback;
    }
    async uploadAsync() {
      const { ok, errors } = validateRemoteUrl(this._url);
      showFileSystemDialog((0, import_i18n.t)("fileSystem.uploadTask"), [(0, import_i18n.t)("fileSystem.target", { value: truncate(this._url) })], ok, errors);
      return { status: 200, headers: {}, body: "" };
    }
    async cancelAsync() {
    }
  }
  const createDownloadResumable = (uri, fileUri, options, callback, resumeData) => new DownloadResumable(uri, fileUri, options, callback, resumeData);
  const createUploadTask = (url, fileUri, options, callback) => new UploadTask(url, fileUri, options, callback);
  const StorageAccessFramework = {
    getUriForDirectoryInRoot: (folderName) => `content://stub/${folderName}`,
    requestDirectoryPermissionsAsync: async () => ({ granted: false, directoryUri: "" }),
    readDirectoryAsync: async () => [],
    makeDirectoryAsync: async () => "",
    createFileAsync: async () => "",
    writeAsStringAsync: async () => {
    },
    readAsStringAsync: async () => "",
    deleteAsync: async () => {
    },
    moveAsync: async () => {
    },
    copyAsync: async () => {
    }
  };
  const FileSystemUploadType = { BINARY_CONTENT: 0, MULTIPART: 1 };
  const FileSystemSessionType = { BACKGROUND: 0, FOREGROUND: 1 };
  const handlers = {
    cacheDirectory,
    documentDirectory,
    bundleDirectory,
    downloadAsync,
    readAsStringAsync,
    writeAsStringAsync,
    deleteAsync,
    getInfoAsync,
    moveAsync,
    copyAsync,
    makeDirectoryAsync,
    readDirectoryAsync,
    uploadAsync,
    getFreeDiskStorageAsync,
    getTotalDiskCapacityAsync,
    getContentUriAsync,
    deleteLegacyDocumentDirectoryAndroid,
    createDownloadResumable,
    createUploadTask,
    DownloadResumable,
    UploadTask,
    StorageAccessFramework,
    FileSystemUploadType,
    FileSystemSessionType
  };
  const noop = async () => void 0;
  module.exports = new Proxy(handlers, {
    get(target, key) {
      if (key in target) return target[key];
      return noop;
    }
  });
}
//# sourceMappingURL=expo-file-system-stub.js.map