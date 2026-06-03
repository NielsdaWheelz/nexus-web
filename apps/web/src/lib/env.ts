/**
 * Single source of truth for the deployment environment (NEXUS_ENV) and every value that
 * depends on it: the CSP connect origins, the internal-API (BFF) config, and the E2E CSP
 * bypass. Resolved + validated once per process, then frozen — the frontend mirror of the
 * backend's python/nexus/config.py (Environment enum + validate-once `get_settings()`).
 *
 * SERVER / DEPLOY ONLY. This module owns NEXUS_INTERNAL_SECRET; import it from middleware,
 * server components, server actions, route handlers, and next.config.ts — never from a Client
 * Component, which would bundle the secret-owning module. The NODE_ENV build-mode helpers a
 * client needs live in the client-safe ./build-mode (re-exported below for server ergonomics).
 * env.ts is not marked `import "server-only"` because next.config.ts imports it (a Node build
 * context, where server-only throws); the client boundary is enforced by a guard test
 * (env.test.ts).
 *
 * Two orthogonal axes, never conflated:
 *   - Deployment env (NEXUS_ENV):  local | test | staging | prod
 *   - Build/run mode (NODE_ENV):   isDevBuild / isProdBuild — `next start` forces production
 */
export { isDevBuild, isProdBuild } from "./build-mode";

export type NexusEnv = "local" | "test" | "staging" | "prod";

/** The deployment env from NEXUS_ENV. Unset → "local" (backend default). Unknown → throws. */
export function nexusEnv(): NexusEnv {
  const raw = process.env.NEXUS_ENV?.trim();
  if (!raw) return "local";
  if (raw === "local" || raw === "test" || raw === "staging" || raw === "prod") {
    return raw;
  }
  throw new Error(`Invalid NEXUS_ENV: "${raw}" (expected local | test | staging | prod)`);
}

/** staging || prod — the strict-env / served-over-HTTPS gate (mirrors the backend). */
export const isDeployed = (): boolean => {
  const env = nexusEnv();
  return env === "staging" || env === "prod";
};

export interface ResolvedEnv {
  readonly nexusEnv: NexusEnv;
  /** FastAPI/SSE origin + presigned R2 origin. Origin-only, deduped, validated. */
  readonly connectOrigins: readonly string[];
  readonly internalApi: {
    readonly fastApiBaseUrl: string;
    readonly internalSecret: string;
  };
  /** !isDeployed() && E2E_DISABLE_CSP === "1". staging & prod can never disable CSP. */
  readonly disableCspForE2E: boolean;
}

let resolved: ResolvedEnv | null = null;

/**
 * Resolve + validate the deployment env once, then return the frozen result (mirrors
 * `get_settings()`). In a deployed env (staging|prod) a missing/invalid FASTAPI_BASE_URL,
 * R2_S3_API_ORIGIN, or NEXUS_INTERNAL_SECRET throws — the build gate (`assertDeploymentEnv`)
 * turns that into a failed `next build`, so a deployed runtime never reaches here with bad env.
 */
export function getEnv(): ResolvedEnv {
  if (resolved) return resolved;
  const env = nexusEnv();
  const deployed = env === "staging" || env === "prod";

  const connectOrigins = resolveConnectOrigins(deployed);

  const internalSecret = process.env.NEXUS_INTERNAL_SECRET?.trim() ?? "";
  if (deployed && !internalSecret) {
    throw new Error("NEXUS_INTERNAL_SECRET is required in staging/prod");
  }
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL?.trim() || (deployed ? "" : "http://localhost:8000");

  resolved = Object.freeze({
    nexusEnv: env,
    connectOrigins,
    internalApi: Object.freeze({ fastApiBaseUrl, internalSecret }),
    disableCspForE2E: !deployed && process.env.E2E_DISABLE_CSP === "1",
  });
  return resolved;
}

/**
 * Build-time gate, called at next.config eval. On a deployed build (staging|prod) with
 * missing/invalid connect origins or internal secret, `getEnv()` throws → `next build` fails →
 * the bad artifact is never promoted (the last-good deploy keeps serving). No-op otherwise.
 */
export function assertDeploymentEnv(): void {
  if (isDeployed()) getEnv();
}

/** Clears the memo so `vi.stubEnv()` takes effect (mirrors clear_settings_cache). Test-only. */
export function __resetEnvForTests(): void {
  resolved = null;
}

/**
 * External browser-connect origins: the FASTAPI_BASE_URL origin plus the shared
 * R2_S3_API_ORIGIN origin for presigned storage. In a deployed env both are required,
 * origin-only, HTTPS, and R2 must be the Cloudflare R2 host — otherwise this throws (a
 * misconfiguration is a hard error, never a silent `connect-src 'self'` fallback).
 */
function resolveConnectOrigins(deployed: boolean): readonly string[] {
  const origins = new Set<string>();

  const fastApiBaseUrl = process.env.FASTAPI_BASE_URL?.trim();
  if (fastApiBaseUrl) {
    const origin = parseConnectOrigin(fastApiBaseUrl, deployed);
    if (origin) origins.add(origin);
    else if (deployed) {
      throw new Error(`Invalid FASTAPI_BASE_URL for CSP connect-src: ${fastApiBaseUrl}`);
    }
  } else if (deployed) {
    throw new Error("FASTAPI_BASE_URL is required in staging/prod for CSP connect-src");
  }

  const r2S3ApiOrigin = process.env.R2_S3_API_ORIGIN?.trim();
  if (r2S3ApiOrigin) {
    const origin = parseConnectOrigin(r2S3ApiOrigin, deployed);
    if (origin) {
      if (deployed && !new URL(origin).hostname.endsWith(".r2.cloudflarestorage.com")) {
        throw new Error(`Invalid R2_S3_API_ORIGIN for CSP connect-src: ${r2S3ApiOrigin}`);
      }
      origins.add(origin);
    } else if (deployed) {
      throw new Error(`Invalid R2_S3_API_ORIGIN for CSP connect-src: ${r2S3ApiOrigin}`);
    }
  } else if (deployed) {
    throw new Error("R2_S3_API_ORIGIN is required in staging/prod for CSP connect-src");
  }

  return [...origins];
}

/**
 * Parse an origin-only value (scheme://host[:port], no path/query/fragment). Returns the
 * normalized origin, or null if invalid. HTTP is accepted only for localhost or outside a
 * deployed env.
 */
function parseConnectOrigin(value: string, deployed: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return null;
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && (isLocalhost || !deployed)) return url.origin;
  return null;
}
