#!/usr/bin/env node
/**
 * dev-api-proxy.cjs — loopback CORS bridge for the Expo **web** preview.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app is shipped as a native binary: React Native's fetch never sends an
 * `Origin` header, so the API needs no CORS at all. The web preview is a real
 * browser page (http://127.0.0.1:8081), so it DOES send `Origin` and the browser
 * demands `Access-Control-Allow-Origin` on the response plus a successful
 * preflight for `POST … application/json`.
 *
 * The PHP API already implements that (backend/src/Middleware/CorsMiddleware.php)
 * but the browser origin must be present in the server's `CORS_ALLOWED_ORIGINS`
 * env var. When it is not — e.g. a deployed server whose env does not list
 * localhost — every call fails in the browser with:
 *
 *     Access to fetch at '…/auth/login' from origin 'http://127.0.0.1:8081'
 *     has been blocked by CORS policy … No 'Access-Control-Allow-Origin' header
 *     → AUTH_NETWORK_FAILURE — Failed to fetch
 *     → UI: "Network error: could not connect to the server."
 *
 * The backend is fine (curl gets JSON); only the browser policy fails. This
 * script bridges that locally and NOTHING else: it forwards bytes to the real
 * API, answers preflights itself, and adds the headers a browser needs.
 *
 * It is a diagnostics tool, not a security change: it binds 127.0.0.1 only, it
 * never mocks or alters a response body, and no server-side rule is relaxed.
 * The permanent fix is one env var on the deployed server:
 *
 *     CORS_ALLOWED_ORIGINS=https://medacademy.site,http://localhost:8081,http://127.0.0.1:8081
 *
 * USAGE
 * -----
 *   node scripts/dev-api-proxy.cjs                # listens on 127.0.0.1:8788
 *   EXPO_PUBLIC_PHP_API_URL=http://127.0.0.1:8788/backend/public/index.php \
 *     npx expo start --web --port 8081
 *
 *   # different upstream / port:
 *   DEV_API_TARGET=https://api.medacademy.site/backend/public/index.php \
 *     DEV_API_PORT=8788 node scripts/dev-api-proxy.cjs
 *
 * Env:
 *   DEV_API_TARGET  upstream base (default: the production PHP API)
 *   DEV_API_PORT    loopback port  (default: 8788)
 *   DEV_API_LOG=0   silence the per-request log line
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const TARGET = new URL(
  process.env.DEV_API_TARGET ?? 'https://api.medacademy.site/backend/public/index.php',
);
/** Upstream base path, e.g. `/backend/public/index.php` (never repeated). */
const TARGET_BASE_PATH = TARGET.pathname.replace(/\/$/, '');
const PORT = Number(process.env.DEV_API_PORT ?? 8788);
const LOG = process.env.DEV_API_LOG !== '0';
const UPSTREAM_TIMEOUT_MS = 120_000;

// Headers that belong to the browser↔proxy hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  'host',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'accept-encoding', // let the upstream send identity/plain so we can re-serve it
  'content-length', // recomputed per request by the runtime
]);

const DEFAULT_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Cache-Control',
  'Pragma',
  'X-Idempotency-Key',
  'X-Upload-Id',
  'X-Chunk-Index',
  'X-Total-Chunks',
  'X-Chunk-Size',
  'X-File-Name',
  'X-Mime-Type',
  'X-App-Integrity',
  'X-Device-Evidence',
  'X-App-Version',
  'X-App-Build',
];

/**
 * Reflect the caller's origin so credentials + preflight both succeed locally.
 *
 * `requestedHeaders` (from `Access-Control-Request-Headers`) is echoed as well:
 * a header the client really sends — e.g. `cache-control` on the maintenance
 * probe — must be allowed, otherwise the browser blocks the request with
 * "Request header field cache-control is not allowed by Access-Control-Allow-Headers".
 */
function corsHeaders(origin, requestedHeaders) {
  const allowedHeaders = [...DEFAULT_ALLOWED_HEADERS];
  for (const name of String(requestedHeaders ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed && !allowedHeaders.some((h) => h.toLowerCase() === trimmed.toLowerCase())) {
      allowedHeaders.push(trimmed);
    }
  }

  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': allowedHeaders.join(', '),
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Content-Disposition',
    'Access-Control-Max-Age': '600',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin, Access-Control-Request-Headers',
  };
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;

  const requestedHeaders = req.headers['access-control-request-headers'];

  // Preflight is answered here: the upstream needs no OPTIONS route.
  if (req.method === 'OPTIONS') {
    if (LOG) {
      console.log(
        `OPTIONS ${req.url} → 204 (preflight answered locally` +
          `${requestedHeaders ? `, headers: ${requestedHeaders}` : ''})`,
      );
    }
    res.writeHead(204, corsHeaders(origin, requestedHeaders));
    res.end();
    return;
  }

  // The client's base URL already contains the upstream base path
  // (…/backend/public/index.php), so a request arrives as
  // `/backend/public/index.php/auth/login`. Never prepend it twice.
  const requestPath = req.url ?? '/';
  const upstreamPath = requestPath.startsWith(TARGET_BASE_PATH)
    ? requestPath
    : `${TARGET_BASE_PATH}${requestPath}`;
  const upstreamUrl = new URL(`${TARGET.origin}${upstreamPath}`);
  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) headers[key] = value;
  }
  headers['accept-encoding'] = 'identity';

  const startedAt = Date.now();

  /** True when the failure happened while CONNECTING — no bytes were sent, so
   *  retrying even a POST cannot duplicate a write. */
  const isConnectPhaseFailure = (err) =>
    /^connect /.test(err?.message ?? '') &&
    ['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(err?.code);

  const forward = (attempt) => {
    const upstreamReq = transport.request(
      upstreamUrl,
      { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS },
      (upstreamRes) => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          // Upstream CORS headers would duplicate ours (and may be stale).
          if (key.toLowerCase().startsWith('access-control-')) continue;
          if (key.toLowerCase() === 'transfer-encoding') continue;
          if (value !== undefined) responseHeaders[key] = value;
        }
        Object.assign(responseHeaders, corsHeaders(origin, requestedHeaders));

        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
        if (LOG) {
          console.log(
            `${req.method} ${requestPath} → ${upstreamRes.statusCode} ` +
              `(${Date.now() - startedAt}ms${attempt > 1 ? `, attempt ${attempt}` : ''})`,
          );
        }
      },
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
    });

    upstreamReq.on('error', (err) => {
      // One retry on a CONNECT-phase failure: the upstream occasionally drops
      // the TCP handshake on this host, and re-running is safe (nothing sent).
      if (attempt === 1 && isConnectPhaseFailure(err)) {
        if (LOG) console.log(`${req.method} ${requestPath} → retrying after ${err.code}`);
        setTimeout(() => forward(2), 400);
        return;
      }
      if (LOG) console.log(`${req.method} ${requestPath} → 502 (${err.message})`);
      if (!res.headersSent) {
        // Still CORS-clean: the browser must be able to READ this failure.
        res.writeHead(502, {
          ...corsHeaders(origin, requestedHeaders),
          'Content-Type': 'application/json; charset=utf-8',
        });
      }
      res.end(
        JSON.stringify({
          error: { message: `Dev proxy upstream error: ${err.message}`, code: 'proxy_upstream_error' },
        }),
      );
    });

    // Re-pipe from the buffered body on a retry, otherwise stream it once.
    if (attempt === 1) {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
        upstreamReq.write(chunk);
      });
      req.on('end', () => upstreamReq.end());
      req.on('error', () => upstreamReq.destroy());
      forward.body = chunks;
    } else {
      if (forward.body?.length) for (const chunk of forward.body) upstreamReq.write(chunk);
      upstreamReq.end();
    }
  };

  forward(1);
});

server.on('error', (err) => {
  console.error(`[dev-api-proxy] could not listen on 127.0.0.1:${PORT} — ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-api-proxy] http://127.0.0.1:${PORT} → ${TARGET.href}`);
  console.log('[dev-api-proxy] point the web preview at it with:');
  console.log(`  EXPO_PUBLIC_PHP_API_URL=http://127.0.0.1:${PORT}${TARGET.pathname} npx expo start --web --port 8081`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
