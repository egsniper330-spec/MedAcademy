"use strict";
var import_react_native = require("react-native");
var import_web_stub_dialog = require("./web-stub-dialog");
var import_i18n = require("./i18n");
if (import_react_native.Platform.OS !== "web") {
  module.exports = require("expo-file-system");
} else {
  let joinUris = function(...parts) {
    const strings = parts.map((p) => typeof p === "string" ? p : p.uri);
    if (strings.length === 0) return "";
    let result = strings[0] ?? "";
    for (let i = 1; i < strings.length; i++) {
      const part = strings[i] ?? "";
      result = result.replace(/\/?$/, "/") + part.replace(/^\//, "");
    }
    return result;
  }, uriBasename = function(uri) {
    return uri.split("/").filter(Boolean).pop() ?? "";
  }, uriDirname = function(uri) {
    const parts = uri.split("/");
    parts.pop();
    return parts.join("/") || "/";
  };
  var joinUris2 = joinUris, uriBasename2 = uriBasename, uriDirname2 = uriDirname;
  console.warn("[devkit] expo-file-system-next-stub loaded (web)");
  class Directory {
    constructor(...uris) {
      this.uri = joinUris(...uris);
    }
    /** 真实基类方法，此处 no-op 防止 TypeError */
    validatePath() {
    }
    get exists() {
      return false;
    }
    create(_options) {
      (0, import_web_stub_dialog.showWebStubDialog)({ title: (0, import_i18n.t)("fileSystemNext.createDir"), details: [`URI: ${this.uri}`] });
    }
    delete() {
      (0, import_web_stub_dialog.showWebStubDialog)({ title: (0, import_i18n.t)("fileSystemNext.deleteDir"), details: [`URI: ${this.uri}`] });
    }
    list() {
      return [];
    }
    listAsRecords() {
      return [];
    }
    get name() {
      return uriBasename(this.uri);
    }
    get parentDirectory() {
      return new Directory(uriDirname(this.uri));
    }
    createFile(name, _mimeType) {
      return new File(this, name);
    }
    createDirectory(name) {
      return new Directory(this, name);
    }
  }
  class File {
    constructor(...uris) {
      this.uri = joinUris(...uris);
    }
    /** 真实基类方法，此处 no-op 防止 TypeError */
    validatePath() {
    }
    get exists() {
      return false;
    }
    get size() {
      return 0;
    }
    get type() {
      return "";
    }
    get extension() {
      const name = uriBasename(this.uri);
      const dot = name.lastIndexOf(".");
      return dot >= 0 ? name.slice(dot) : "";
    }
    get name() {
      return uriBasename(this.uri);
    }
    get parentDirectory() {
      return new Directory(uriDirname(this.uri));
    }
    copy(destination) {
      (0, import_web_stub_dialog.showWebStubDialog)({
        title: (0, import_i18n.t)("fileSystemNext.copyFile"),
        details: [(0, import_i18n.t)("fileSystem.from", { value: this.uri }), (0, import_i18n.t)("fileSystem.to", { value: destination.uri })]
      });
    }
    move(destination) {
      (0, import_web_stub_dialog.showWebStubDialog)({
        title: (0, import_i18n.t)("fileSystemNext.moveFile"),
        details: [(0, import_i18n.t)("fileSystem.from", { value: this.uri }), (0, import_i18n.t)("fileSystem.to", { value: destination.uri })]
      });
    }
    delete() {
      (0, import_web_stub_dialog.showWebStubDialog)({ title: (0, import_i18n.t)("fileSystemNext.deleteFile"), details: [`URI: ${this.uri}`] });
    }
    open() {
      return null;
    }
    // ─── Blob interface（Web 环境所需，返回空值）
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
    async text() {
      return "";
    }
    async bytes() {
      return new Uint8Array(0);
    }
    bytesSync() {
      return new Uint8Array(0);
    }
    slice(_start, _end, _contentType) {
      return new Blob([]);
    }
    stream() {
      return new ReadableStream();
    }
    readableStream() {
      return new ReadableStream();
    }
    writableStream() {
      return new WritableStream();
    }
  }
  File.downloadFileAsync = async (_url, destination) => {
    (0, import_web_stub_dialog.showWebStubDialog)({ title: (0, import_i18n.t)("fileSystemNext.downloadFile"), details: [(0, import_i18n.t)("fileSystem.target", { value: destination.uri })] });
    return new File(destination.uri);
  };
  File.pickFileAsync = async () => {
    (0, import_web_stub_dialog.showWebStubDialog)({ title: (0, import_i18n.t)("fileSystemNext.pickFile"), details: [] });
    return new File("document:/stub-pick");
  };
  Directory.pickDirectoryAsync = async () => {
    (0, import_web_stub_dialog.showWebStubDialog)({ title: (0, import_i18n.t)("fileSystemNext.pickDir"), details: [] });
    return new Directory("document:/stub-pick");
  };
  const Paths = {
    get document() {
      return new Directory("document:/");
    },
    get cache() {
      return new Directory("cache:/");
    },
    get bundle() {
      return new Directory("bundle:/");
    },
    get totalDiskSpace() {
      return 0;
    },
    get availableDiskSpace() {
      return 0;
    },
    get appleSharedContainers() {
      return {};
    },
    join(...uris) {
      return joinUris(...uris);
    },
    basename(uri) {
      return uriBasename(uri);
    },
    dirname(uri) {
      return uriDirname(uri);
    },
    extname(uri) {
      const name = uriBasename(uri);
      const dot = name.lastIndexOf(".");
      return dot >= 0 ? name.slice(dot) : "";
    },
    normalize(uri) {
      return uri;
    },
    isAbsolute(_uri) {
      return true;
    },
    resolve(...uris) {
      return joinUris(...uris);
    },
    relative(_from, to) {
      return to;
    },
    info(_uri) {
      return { isDirectory: false };
    },
    sep: "/",
    delimiter: ":"
  };
  const handlers = { File, Directory, Paths };
  const noop = async () => void 0;
  module.exports = new Proxy(handlers, {
    get(target, key) {
      if (key in target) return target[key];
      return noop;
    }
  });
}
//# sourceMappingURL=expo-file-system-next-stub.js.map