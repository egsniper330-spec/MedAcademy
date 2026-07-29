"use strict";
var import_react_native = require("react-native");
var import_i18n = require("./i18n");
function isDesktopBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return !isMobile;
}
function showMobilePassthroughToast() {
  const toast = document.createElement("div");
  toast.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:99999",
    "background:#1a1a1a",
    "color:#a78bfa",
    "font-size:12px",
    "font-family:monospace",
    "padding:8px 14px",
    "border-radius:6px",
    "border:1px solid #4c1d95",
    "pointer-events:none",
    "white-space:nowrap"
  ].join(";");
  toast.textContent = (0, import_i18n.t)("imagePicker.mobilePassthrough");
  document.body.appendChild(toast);
  setTimeout(() => {
    if (document.body.contains(toast)) document.body.removeChild(toast);
  }, 2500);
}
function openCameraDialog(facingMode) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "__devkit_camera_overlay__";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:99999",
      "background:rgba(0,0,0,0.85)",
      "display:flex",
      "align-items:center",
      "justify-content:center"
    ].join(";");
    const panel = document.createElement("div");
    panel.style.cssText = [
      "background:#1a1a1a",
      "border-radius:12px",
      "overflow:hidden",
      "display:flex",
      "flex-direction:column",
      "align-items:stretch",
      "max-width:90vw",
      "max-height:90vh",
      "box-shadow:0 8px 32px rgba(0,0,0,0.6)",
      "border:1px solid #4c1d95"
    ].join(";");
    const header = document.createElement("div");
    header.style.cssText = [
      "background:#2e1065",
      "padding:12px 16px 10px",
      "display:flex",
      "flex-direction:column",
      "gap:4px"
    ].join(";");
    const headerTitle = document.createElement("div");
    headerTitle.textContent = (0, import_i18n.t)("imagePicker.pcCameraTitle");
    headerTitle.style.cssText = "color:#e9d5ff;font-size:14px;font-weight:600;font-family:sans-serif";
    const headerDesc = document.createElement("div");
    headerDesc.textContent = (0, import_i18n.t)("imagePicker.pcCameraDesc");
    headerDesc.style.cssText = "color:#a78bfa;font-size:11px;font-family:sans-serif;line-height:1.6;max-width:480px";
    header.appendChild(headerTitle);
    header.appendChild(headerDesc);
    const body = document.createElement("div");
    body.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "padding:16px",
      "gap:12px"
    ].join(";");
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.cssText = [
      "width:100%",
      "max-width:480px",
      "border-radius:8px",
      "background:#000"
    ].join(";");
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:12px;width:100%;justify-content:center";
    const btnCapture = document.createElement("button");
    btnCapture.textContent = (0, import_i18n.t)("imagePicker.capture");
    btnCapture.style.cssText = [
      "padding:10px 28px",
      "border-radius:8px",
      "border:none",
      "cursor:pointer",
      "background:#7C3AED",
      "color:#fff",
      "font-size:15px",
      "font-weight:600",
      "font-family:sans-serif"
    ].join(";");
    const btnLocal = document.createElement("button");
    btnLocal.textContent = (0, import_i18n.t)("imagePicker.localSelect");
    btnLocal.style.cssText = [
      "padding:10px 20px",
      "border-radius:8px",
      "border:1px solid #7C3AED",
      "cursor:pointer",
      "background:transparent",
      "color:#a78bfa",
      "font-size:15px",
      "font-family:sans-serif"
    ].join(";");
    const btnCancel = document.createElement("button");
    btnCancel.textContent = (0, import_i18n.t)("common.cancel");
    btnCancel.style.cssText = [
      "padding:10px 20px",
      "border-radius:8px",
      "border:1px solid #555",
      "cursor:pointer",
      "background:transparent",
      "color:#ccc",
      "font-size:15px",
      "font-family:sans-serif"
    ].join(";");
    const errorMsg = document.createElement("p");
    errorMsg.style.cssText = "margin:0;color:#f87171;font-size:13px;font-family:sans-serif;display:none";
    btnRow.appendChild(btnCapture);
    btnRow.appendChild(btnLocal);
    btnRow.appendChild(btnCancel);
    body.appendChild(video);
    body.appendChild(btnRow);
    body.appendChild(errorMsg);
    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    let stream = null;
    function cleanup() {
      stream?.getTracks().forEach((t2) => t2.stop());
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false }).then((s) => {
      stream = s;
      video.srcObject = s;
    }).catch((err) => {
      errorMsg.textContent = (0, import_i18n.t)("imagePicker.cameraAccessError", { error: err.message ?? err });
      errorMsg.style.display = "block";
      btnCapture.disabled = true;
    });
    btnCapture.addEventListener("click", () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        cleanup();
        resolve({ canceled: true });
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      cleanup();
      resolve({ canceled: false, dataUrl, mimeType: "image/jpeg" });
    });
    btnLocal.addEventListener("click", () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result;
          if (!dataUrl) {
            cleanup();
            resolve({ canceled: true });
            return;
          }
          cleanup();
          resolve({ canceled: false, dataUrl, mimeType: file.type || "image/jpeg" });
        };
        reader.onerror = () => {
          cleanup();
          resolve({ canceled: true });
        };
        reader.readAsDataURL(file);
      });
      fileInput.click();
    });
    btnCancel.addEventListener("click", () => {
      cleanup();
      resolve({ canceled: true });
    });
  });
}
function dataUrlToFile(dataUrl, fileName) {
  const [header, b64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new File([bytes], fileName, { type: mime });
}
async function dataUrlToPickerResult(dataUrl, includeBase64) {
  return new Promise((resolve) => {
    const fileName = `photo_${Date.now()}.jpg`;
    const b64Part = dataUrl.split(",")[1] ?? "";
    const fileSize = Math.round(b64Part.length * 3 / 4);
    const file = dataUrlToFile(dataUrl, fileName);
    const asset = {
      uri: dataUrl,
      type: "image",
      fileName,
      mimeType: "image/jpeg",
      fileSize,
      file,
      ...includeBase64 ? { base64: b64Part } : {}
    };
    const img = new Image();
    img.onload = () => {
      resolve({
        canceled: false,
        assets: [{ ...asset, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }]
      });
    };
    img.onerror = () => {
      resolve({ canceled: false, assets: [{ ...asset, width: 0, height: 0 }] });
    };
    img.src = dataUrl;
  });
}
function getFacingMode(options) {
  const cameraType = options.cameraType;
  return cameraType === "front" ? "user" : "environment";
}
if (import_react_native.Platform.OS === "web") {
  const ExpoImagePicker = require("expo-image-picker");
  const patchedLaunchCameraAsync = async (options = {}) => {
    if (!isDesktopBrowser()) {
      showMobilePassthroughToast();
      return ExpoImagePicker.launchCameraAsync(options);
    }
    const facingMode = getFacingMode(options);
    const result = await openCameraDialog(facingMode);
    if (result.canceled || !result.dataUrl) {
      return { canceled: true, assets: null };
    }
    return dataUrlToPickerResult(result.dataUrl, options.base64 === true);
  };
  module.exports = {
    ...ExpoImagePicker,
    launchCameraAsync: patchedLaunchCameraAsync
  };
} else {
  module.exports = require("expo-image-picker");
}
//# sourceMappingURL=expo-image-picker-stub.js.map