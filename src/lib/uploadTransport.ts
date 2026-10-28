/**
 * uploadTransport.ts — multipart upload with real byte progress + cancellation.
 *
 * WHY NOT fetch()
 * ──────────────
 * `fetch()` (and therefore the storage client's original upload path) exposes
 * no upload progress: there is no `onprogress` on the request body. The only
 * way to report bytes actually leaving the device, and to abort a transfer the
 * doctor no longer wants, is XMLHttpRequest — which React Native implements,
 * including `xhr.upload.onprogress` and `xhr.abort()`.
 *
 * The transport deliberately does NOT parse the response or know about auth:
 * it takes a prepared FormData + headers and returns the raw status/body, so
 * the existing storage client stays the single owner of the wire contract,
 * the security-lock check and the response validation.
 *
 * The XHR constructor is injectable so the test suite can drive the progress,
 * abort, timeout and network-error paths for real without a device.
 */

export interface UploadTransportProgress {
  bytesSent: number;
  totalBytes: number;
}

/** The slice of AbortSignal this transport needs (works with a real one). */
export interface UploadCancelSignal {
  aborted: boolean;
  addEventListener?: (type: 'abort', listener: () => void) => void;
  removeEventListener?: (type: 'abort', listener: () => void) => void;
}

export interface UploadXhrRequest {
  upload?: { onprogress: ((event: { loaded?: number; total?: number; lengthComputable?: boolean }) => void) | null } | null;
  status: number;
  responseText: string;
  timeout: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  open: (method: string, url: string) => void;
  setRequestHeader: (name: string, value: string) => void;
  send: (body: unknown) => void;
  abort: () => void;
}

export interface UploadTransportOptions {
  url: string;
  formData: FormData;
  headers?: Record<string, string>;
  onProgress?: (progress: UploadTransportProgress) => void;
  signal?: UploadCancelSignal | null;
  /** 0 (default) = no artificial limit; the server/proxy decides. */
  timeoutMs?: number;
  /** Test seam: defaults to `new XMLHttpRequest()`. */
  xhrFactory?: () => UploadXhrRequest;
}

export interface UploadTransportResponse {
  status: number;
  bodyText: string;
}

export class UploadTransportError extends Error {
  code: 'NETWORK' | 'TIMEOUT' | 'UNSUPPORTED';
  status: number;
  constructor(message: string, code: 'NETWORK' | 'TIMEOUT' | 'UNSUPPORTED', status = 0) {
    super(message);
    this.name = 'UploadTransportError';
    this.code = code;
    this.status = status;
  }
}

function abortError(): Error {
  // React Native's fetch uses DOMException('Aborted', 'AbortError'); a plain
  // Error with the same name is enough for every caller here and does not rely
  // on DOMException existing.
  const err = new Error('The upload was cancelled.');
  err.name = 'AbortError';
  return err;
}

function defaultFactory(): UploadXhrRequest {
  // Structural narrowing: React Native and browsers both expose this class, but
  // the DOM lib types it as the full XMLHttpRequest, which is wider than the
  // slice used here.
  const Xhr = (globalThis as unknown as { XMLHttpRequest?: new () => UploadXhrRequest }).XMLHttpRequest;
  if (typeof Xhr !== 'function') {
    throw new UploadTransportError(
      'XMLHttpRequest is not available in this runtime.',
      'UNSUPPORTED',
    );
  }
  return new Xhr();
}

/**
 * Send `formData` to `url`, reporting transferred bytes and honouring abort.
 *
 * Resolves for ANY HTTP status (the caller decides what a non-2xx body means,
 * exactly as it does for fetch); rejects only for transport-level failures.
 */
export function uploadWithProgress(options: UploadTransportOptions): Promise<UploadTransportResponse> {
  const { url, formData, headers = {}, onProgress, signal, timeoutMs = 0 } = options;

  if (signal?.aborted) return Promise.reject(abortError());

  let xhr: UploadXhrRequest;
  try {
    xhr = (options.xhrFactory ?? defaultFactory)();
  } catch (e) {
    return Promise.reject(e);
  }

  return new Promise<UploadTransportResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
      fn();
    };

    function onAbort() {
      finish(() => {
        try { xhr.abort(); } catch { /* already finished */ }
        reject(abortError());
      });
    }

    if (signal?.addEventListener) signal.addEventListener('abort', onAbort);

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (settled) return;
        const total = Number(event?.total ?? 0);
        const loaded = Number(event?.loaded ?? 0);
        onProgress({ bytesSent: loaded, totalBytes: total });
      };
    }

    xhr.onload = () => {
      finish(() => resolve({ status: Number(xhr.status) || 0, bodyText: String(xhr.responseText ?? '') }));
    };
    xhr.onerror = () => {
      finish(() => reject(new UploadTransportError('The connection dropped during the upload.', 'NETWORK')));
    };
    xhr.ontimeout = () => {
      finish(() => reject(new UploadTransportError('The upload timed out.', 'TIMEOUT')));
    };
    xhr.onabort = () => {
      finish(() => reject(abortError()));
    };

    try {
      xhr.open('POST', url);
      xhr.timeout = timeoutMs > 0 ? timeoutMs : 0;
      for (const [name, value] of Object.entries(headers)) {
        if (name && value) xhr.setRequestHeader(name, value);
      }
      xhr.send(formData);
    } catch (e) {
      finish(() => reject(
        e instanceof UploadTransportError
          ? e
          : new UploadTransportError(e instanceof Error ? e.message : String(e), 'NETWORK'),
      ));
    }
  });
}
