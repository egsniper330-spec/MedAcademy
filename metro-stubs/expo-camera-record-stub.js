"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_react = __toESM(require("react"));
var import_nativewind = require("nativewind");
const ExpoCamera = require("expo-camera");
const OriginalCameraView = ExpoCamera.CameraView;
const MIME_TYPE = "video/mp4;codecs=avc1";
class WebRecordableCameraView extends OriginalCameraView {
  constructor() {
    super(...arguments);
    this._recorder = null;
    this._maxDurationTimer = null;
    this._audioTracks = [];
    this._containerRef = null;
  }
  render() {
    const original = super.render();
    return import_react.default.createElement(
      "div",
      {
        ref: (el) => {
          this._containerRef = el;
        },
        style: { display: "contents" }
      },
      original
    );
  }
  async recordAsync(options) {
    if (this._recorder && this._recorder.state !== "inactive") {
      this._recorder.stop();
    }
    const videoEl = this._findVideoElement();
    if (!videoEl) {
      throw new Error("[expo-camera-record-stub] Cannot find <video> element for recording.");
    }
    const stream = videoEl.srcObject;
    if (!stream) {
      throw new Error("[expo-camera-record-stub] No MediaStream on video element.");
    }
    if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
      throw new Error(
        "[expo-camera-record-stub] Browser does not support MediaRecorder with " + MIME_TYPE + ". This stub requires Chrome 116+ or Safari 14.1+."
      );
    }
    let recordStream = stream;
    this._audioTracks = [];
    if (options?.mute !== true) {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this._audioTracks = audioStream.getAudioTracks();
        const combinedTracks = [...stream.getVideoTracks(), ...this._audioTracks];
        recordStream = new MediaStream(combinedTracks);
      } catch {
      }
    }
    const recorder = new MediaRecorder(recordStream, { mimeType: MIME_TYPE });
    this._recorder = recorder;
    const localChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        localChunks.push(e.data);
      }
    };
    const recordingPromise = new Promise((resolve, reject) => {
      recorder.onstop = () => {
        if (this._recorder === recorder) {
          this._cleanupTimer();
          this._recorder = null;
        }
        this._stopAudioTracks();
        const blob = new Blob(localChunks, { type: "video/mp4" });
        const uri = URL.createObjectURL(blob);
        resolve({ uri });
      };
      recorder.onerror = (event) => {
        if (this._recorder === recorder) {
          this._cleanupTimer();
          this._recorder = null;
        }
        this._stopAudioTracks();
        const errorEvent = event;
        reject(new Error(
          "[expo-camera-record-stub] Recording failed: " + (errorEvent.message || "Unknown error")
        ));
      };
    });
    recorder.start();
    if (options?.maxDuration) {
      this._maxDurationTimer = setTimeout(() => {
        this.stopRecording();
      }, options.maxDuration * 1e3);
    }
    return recordingPromise;
  }
  stopRecording() {
    if (this._recorder && this._recorder.state !== "inactive") {
      this._recorder.stop();
    }
  }
  _cleanupTimer() {
    if (this._maxDurationTimer) {
      clearTimeout(this._maxDurationTimer);
      this._maxDurationTimer = null;
    }
  }
  _stopAudioTracks() {
    for (const track of this._audioTracks) {
      track.stop();
    }
    this._audioTracks = [];
  }
  _findVideoElement() {
    return this._containerRef?.querySelector("video") ?? null;
  }
}
(0, import_nativewind.cssInterop)(WebRecordableCameraView, { className: "style" });
module.exports = {
  ...ExpoCamera,
  CameraView: WebRecordableCameraView
};
//# sourceMappingURL=expo-camera-record-stub.js.map