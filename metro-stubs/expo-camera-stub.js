"use strict";
let __create = Object.create;
let __defProp = Object.defineProperty;
let __getOwnPropDesc = Object.getOwnPropertyDescriptor;
let __getOwnPropNames = Object.getOwnPropertyNames;
let __getProtoOf = Object.getPrototypeOf;
let __hasOwnProp = Object.prototype.hasOwnProperty;
let __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
let __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
let ExpoCamera = __toESM(require("expo-camera"));
let import_nativewind = require("nativewind");
(0, import_nativewind.cssInterop)(ExpoCamera.CameraView, { className: "style" });
module.exports = ExpoCamera;
//# sourceMappingURL=expo-camera-stub.js.map