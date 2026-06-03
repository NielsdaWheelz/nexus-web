/**
 * Content-Security-Policy source of truth for the Next.js document responses.
 *
 * The policy is defined here as data and assembled by `buildContentSecurityPolicy`.
 * It is applied per-request in `middleware.ts` (the nonce and connect origins are
 * dynamic); the static header suite lives in `./headers.ts`. Nothing else may inline a
 * CSP string — see docs/cutovers/csp-and-security-headers-hardening.md.
 *
 * Runtime-agnostic: no Node-only APIs (Web Crypto + btoa only), so it runs in both the
 * edge and node runtimes.
 */

import { YOUTUBE_EMBED_ORIGINS } from "./youtube";

export const CSP_REPORT_PATH = "/api/csp-report";

const NONCE_PLACEHOLDER = "{NONCE}";

/**
 * Static directive map. Dynamic slots are applied by `buildContentSecurityPolicy`:
 * - `script-src`: `{NONCE}` is substituted; `'unsafe-eval'` is added iff `isDev`.
 * - `connect-src`: external connect origins (+ dev websocket origins) are appended.
 * - `upgrade-insecure-requests`: emitted only for HTTPS document requests (handled in
 *   the builder, not stored here).
 *
 * This object is the assertion target for `csp.test.ts` and the CSP-Evaluator gate.
 */
export const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": [`'nonce-${NONCE_PLACEHOLDER}'`, "'strict-dynamic'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "connect-src": ["'self'"],
  "media-src": ["'self'", "https:"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": [...YOUTUBE_EMBED_ORIGINS],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "report-to": ["csp"],
  "report-uri": [CSP_REPORT_PATH],
} as const satisfies Record<string, readonly string[]>;

/**
 * Deterministic emission order. `upgrade-insecure-requests` is value-less and inserted
 * (when applicable) just before the reporting directives.
 */
const DIRECTIVE_ORDER = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "worker-src",
  "manifest-src",
  "frame-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "upgrade-insecure-requests",
  "report-to",
  "report-uri",
] as const;

export interface CspBuildOptions {
  /** Fresh per-request nonce. */
  nonce: string;
  /** Adds `'unsafe-eval'` to script-src (React dev stacks / HMR) and dev websocket origins. */
  isDev: boolean;
  /** Adds `upgrade-insecure-requests` only for HTTPS document requests. */
  isHttpsRequest: boolean;
  /** External browser-connect origins (FastAPI/SSE + presigned storage). */
  connectOrigins: readonly string[];
  /** Dev-only HMR websocket origins; included only when `isDev`. */
  devWebSocketOrigins?: readonly string[];
}

/**
 * Serialize `CSP_DIRECTIVES` into a header string with the nonce/dev/connect values
 * applied. Always includes `report-to csp` and `report-uri /api/csp-report`. Pure and
 * deterministic given its options.
 */
export function buildContentSecurityPolicy(opts: CspBuildOptions): string {
  const {
    nonce,
    isDev,
    isHttpsRequest,
    connectOrigins,
    devWebSocketOrigins = [],
  } = opts;

  const values: Record<string, string[]> = {};
  for (const [name, sources] of Object.entries(CSP_DIRECTIVES)) {
    values[name] = [...sources];
  }

  values["script-src"] = values["script-src"].map((source) =>
    source.replace(NONCE_PLACEHOLDER, nonce),
  );
  if (isDev) {
    values["script-src"].push("'unsafe-eval'");
  }

  values["connect-src"].push(...connectOrigins);
  if (isDev) {
    values["connect-src"].push(...devWebSocketOrigins);
  }

  // Value-less directive; only meaningful for HTTPS documents (omitting it locally keeps
  // http://localhost SSE/connect from being upgraded to https).
  if (isHttpsRequest) {
    values["upgrade-insecure-requests"] = [];
  }

  const serialized: string[] = [];
  for (const name of DIRECTIVE_ORDER) {
    if (!(name in values)) continue;
    const sources = values[name];
    serialized.push(sources.length > 0 ? `${name} ${sources.join(" ")}` : name);
  }
  return serialized.join("; ");
}

/** 16 random bytes, base64. Web Crypto + btoa only (edge + node safe). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** `Reporting-Endpoints` header value (absolute, same-origin sink). */
export function buildReportingEndpoints(origin: string): string {
  return `csp="${origin}${CSP_REPORT_PATH}"`;
}
