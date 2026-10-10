// the per-request content security policies, built by middleware.ts (the
// static header suite is ./headers.ts). runtime-agnostic: web crypto and btoa
// only, so it runs on the edge. dossier articles render in the app document
// (a shadow root): never add 'unsafe-inline' without a nonce, or
// 'unsafe-hashes', to script-src.
import { YOUTUBE_EMBED_ORIGINS } from "./youtube";

type Directives = Record<string, readonly string[]>;

// directive order is emission order. script-src gains the nonce first and
// 'unsafe-eval' under next dev; connect-src gains next dev's hmr socket.
const APP: Directives = {
  "default-src": ["'self'"],
  "script-src": ["'strict-dynamic'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "connect-src": ["'self'"],
  "media-src": ["'self'", "https:"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": YOUTUBE_EMBED_ORIGINS,
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
};

// the public reader (/s): no forms, no frames, blob media and workers.
const PUBLIC_READER: Directives = {
  ...APP,
  "img-src": ["'self'", "data:", "blob:"],
  "media-src": ["'self'", "blob:"],
  "worker-src": ["'self'", "blob:"],
  "frame-src": ["'none'"],
  "form-action": ["'none'"],
};

// the public share api answers data, never documents.
export const PUBLIC_API_CSP =
  "default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface PolicyRequest {
  readonly nonce: string;
  readonly dev: boolean;
  readonly https: boolean;
  readonly ws: readonly string[];
}

function serialize(
  base: Directives,
  request: PolicyRequest,
  extra: Directives = {},
): string {
  const policy = Object.entries(base).map(([name, sources]) => {
    let all = [...sources, ...(extra[name] ?? [])];
    if (name === "script-src") {
      all = [`'nonce-${request.nonce}'`, ...all];
      if (request.dev) all.push("'unsafe-eval'");
    }
    if (name === "connect-src" && request.dev) all.push(...request.ws);
    return `${name} ${all.join(" ")}`;
  });
  // https documents only: locally it would upgrade http://localhost connects.
  if (request.https) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

// connect: the fastapi/sse and presigned storage origins; media: explicit
// media origins beyond https:.
export const appCsp = (
  request: PolicyRequest & {
    readonly connect: readonly string[];
    readonly media: readonly string[];
  },
) =>
  serialize(APP, request, {
    "connect-src": request.connect,
    "media-src": request.media,
  });

export const publicReaderCsp = (request: PolicyRequest) =>
  serialize(PUBLIC_READER, request);

// 16 random bytes, base64.
export function cspNonce(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
}
