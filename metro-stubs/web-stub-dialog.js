"use strict";
/**
 * web-stub-dialog.js
 *
 * Renders a non-blocking banner/toast in the browser DOM when a native-only
 * Expo API is called on web during development/preview.
 *
 * showWebStubDialog({ title, details?, errors? })
 *   title   – API name, e.g. "FileSystem.downloadAsync"
 *   details – string[] of informational lines
 *   errors  – string[] of validation error lines (renders in red)
 *
 * The banner auto-dismisses after 6 s and can be manually closed.
 * Safe to call from any stub — silently no-ops in non-browser environments.
 */

/** @returns {boolean} */
function isBrowser() {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

/** Inject shared CSS once per page load */
let _cssInjected = false;
function ensureStyles() {
  if (_cssInjected || !isBrowser()) return;
  _cssInjected = true;
  const style = document.createElement("style");
  style.textContent = [
    ".__stub-banner{",
    "  position:fixed;bottom:16px;right:16px;z-index:999999;",
    "  max-width:360px;min-width:240px;",
    "  background:#1a1a2e;color:#e2e8f0;",
    "  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;",
    "  border:1px solid #4c1d95;border-radius:8px;",
    "  box-shadow:0 4px 24px rgba(0,0,0,.5);",
    "  padding:10px 14px 10px 12px;",
    "  animation:__stub-slidein .2s ease;",
    "  pointer-events:auto;",
    "}",
    "@keyframes __stub-slidein{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}",
    ".__stub-banner.__stub-fadeout{",
    "  animation:__stub-fadeout .3s ease forwards;",
    "}",
    "@keyframes __stub-fadeout{to{opacity:0;transform:translateY(8px)}}",
    ".__stub-title{",
    "  font-weight:700;color:#a78bfa;font-size:12px;",
    "  display:flex;align-items:center;justify-content:space-between;gap:8px;",
    "}",
    ".__stub-close{",
    "  background:none;border:none;color:#6b7280;cursor:pointer;",
    "  font-size:14px;line-height:1;padding:0 2px;flex-shrink:0;",
    "}",
    ".__stub-close:hover{color:#e2e8f0;}",
    ".__stub-detail{color:#94a3b8;margin-top:4px;line-height:1.45;}",
    ".__stub-error{color:#f87171;margin-top:4px;line-height:1.45;}",
    ".__stub-badge{",
    "  display:inline-block;background:#581c87;color:#d8b4fe;",
    "  font-size:10px;padding:1px 5px;border-radius:4px;",
    "  margin-bottom:4px;letter-spacing:.03em;",
    "}",
  ].join("\n");
  document.head.appendChild(style);
}

/** Container node that stacks banners */
let _container = null;
function getContainer() {
  if (_container && document.body.contains(_container)) return _container;
  _container = document.createElement("div");
  Object.assign(_container.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "999999",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    alignItems: "flex-end",
    pointerEvents: "none",
  });
  document.body.appendChild(_container);
  return _container;
}

/**
 * @param {{ title: string, details?: string[], errors?: string[] }} opts
 */
function showWebStubDialog(opts) {
  if (!isBrowser()) {
    // Non-browser environment (SSR, Node test, native) — log to console only
    const lines = [
      "[stub] " + (opts && opts.title ? opts.title : "native API"),
    ];
    if (opts && Array.isArray(opts.details)) lines.push(...opts.details);
    if (opts && Array.isArray(opts.errors)) lines.push(...opts.errors.map((e) => "⚠ " + e));
    console.warn(lines.join("\n"));
    return;
  }

  ensureStyles();
  const container = getContainer();

  const title = (opts && opts.title) ? String(opts.title) : "Native API";
  const details = (opts && Array.isArray(opts.details)) ? opts.details : [];
  const errors = (opts && Array.isArray(opts.errors)) ? opts.errors : [];

  const banner = document.createElement("div");
  banner.className = "__stub-banner";

  // Header row: badge + title + close button
  const header = document.createElement("div");
  header.className = "__stub-title";

  const badge = document.createElement("span");
  badge.className = "__stub-badge";
  badge.textContent = "stub";

  const titleNode = document.createElement("span");
  titleNode.style.flex = "1";
  titleNode.textContent = title;

  const closeBtn = document.createElement("button");
  closeBtn.className = "__stub-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "dismiss");

  header.appendChild(badge);
  header.appendChild(titleNode);
  header.appendChild(closeBtn);
  banner.appendChild(header);

  // Detail lines
  for (const line of details) {
    if (!line && line !== 0) continue;
    const p = document.createElement("div");
    p.className = "__stub-detail";
    p.textContent = String(line);
    banner.appendChild(p);
  }

  // Error lines
  for (const err of errors) {
    if (!err && err !== 0) continue;
    const p = document.createElement("div");
    p.className = "__stub-error";
    p.textContent = "⚠ " + String(err);
    banner.appendChild(p);
  }

  container.appendChild(banner);

  function dismiss() {
    banner.classList.add("__stub-fadeout");
    banner.addEventListener("animationend", () => {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }, { once: true });
  }

  closeBtn.addEventListener("click", dismiss);
  const timer = setTimeout(dismiss, 6000);

  // Clean up timer if element is forcibly removed
  const obs = new MutationObserver(() => {
    if (!document.contains(banner)) {
      clearTimeout(timer);
      obs.disconnect();
    }
  });
  obs.observe(container, { childList: true });
}

module.exports = { showWebStubDialog };
