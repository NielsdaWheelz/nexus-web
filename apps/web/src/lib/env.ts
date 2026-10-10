/**
 * Single source of truth for the deployment environment (NEXUS_ENV) and every value that
 * depends on it: the CSP connect origins and the internal-API (BFF) config. Resolved and
 * validated once per process, then frozen — the frontend mirror of the
 * backend's python/nexus/config.py (Environment enum + validate-once `get_settings()`).
 *
 * SERVER / DEPLOY ONLY. This module owns NEXUS_INTERNAL_SECRET; import it from middleware,
 * server components, server actions, route handlers, and next.config.ts — never from a Client
 * Component, which would bundle the secret-owning module. The NODE_ENV build-mode predicate
 * lives in the client-safe ./build-mode.
 * env.ts is not marked `import "server-only"` because next.config.ts imports it (a Node build
 * context, where server-only throws).
 *
 * Two orthogonal axes, never conflated:
 *   - Deployment env (NEXUS_ENV):  local | test | staging | prod
 *   - Build/run mode (NODE_ENV):   isDevBuild — `next start` forces production
 */
import { parseWebOrigin, parseWebOriginList } from "./security/origin";

type NexusEnv = "local" | "test" | "staging" | "prod";
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Exact immutable identity of the Vercel deployment serving this process. */
export function vercelSourceSha(): string {
  const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("VERCEL_GIT_COMMIT_SHA must be exactly 40 lowercase hex characters");
  }
  return sourceSha;
}

/** The deployment env from NEXUS_ENV. Unset → "local" (backend default). Unknown → throws. */
function nexusEnv(): NexusEnv {
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

interface ResolvedEnv {
  /** Supabase project the server-side auth clients talk to. */
  readonly supabase: {
    readonly url: string;
    readonly anonKey: string;
  };
  /**
   * The one browser origin (APP_PUBLIC_URL): every absolute auth redirect, every
   * Origin check, the auth cookies' Secure flag and absolute metadata URLs.
   */
  readonly appPublicOrigin: string;
  /** FastAPI/SSE origin + presigned R2 origin. Origin-only, deduped, validated. */
  readonly connectOrigins: readonly string[];
  /** Explicit browser media origins beyond the default same-origin/HTTPS policy. */
  readonly mediaOrigins: readonly string[];
  /** The firefox extension's identity redirect origin; null disables connect. */
  readonly extensionRedirectOrigin: string | null;
  readonly internalApi: {
    readonly fastApiBaseUrl: string;
    readonly internalSecret: string;
  };
}

let resolved: ResolvedEnv | null = null;

/**
 * Resolve + validate the deployment env once, then return the frozen result (mirrors
 * `get_settings()`). In a deployed env (staging|prod) a missing/invalid FASTAPI_BASE_URL,
 * R2_S3_API_ORIGIN, or NEXUS_INTERNAL_SECRET throws. `next.config.ts` calls this during config
 * evaluation, so a bad deployed env fails `next build` before promotion.
 */
export function getEnv(): ResolvedEnv {
  if (resolved) return resolved;
  const env = nexusEnv();
  const deployed = env === "staging" || env === "prod";

  const connectOrigins = resolveConnectOrigins(deployed);
  const mediaOrigins = resolveMediaOrigins(deployed);
  const extensionRedirectOrigin = resolveExtensionRedirectOrigin(deployed);

  const internalSecret = process.env.NEXUS_INTERNAL_SECRET?.trim() ?? "";
  if (deployed && !internalSecret) {
    throw new Error("NEXUS_INTERNAL_SECRET is required in staging/prod");
  }
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL?.trim() || (deployed ? "" : "http://localhost:8000");
  const appPublicOrigin = resolveAppPublicOrigin(deployed);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  if (deployed && (!supabaseUrl || !supabaseAnonKey)) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required in staging/prod",
    );
  }

  resolved = Object.freeze({
    supabase: Object.freeze({ url: supabaseUrl, anonKey: supabaseAnonKey }),
    appPublicOrigin,
    connectOrigins,
    mediaOrigins,
    extensionRedirectOrigin,
    internalApi: Object.freeze({ fastApiBaseUrl, internalSecret }),
  });
  return resolved;
}

function resolveMediaOrigins(deployed: boolean): readonly string[] {
  const { origins, invalidValues } = parseWebOriginList(
    process.env.CSP_MEDIA_ORIGINS,
  );
  if (invalidValues.length > 0) {
    throw new Error(`Invalid CSP_MEDIA_ORIGINS: ${invalidValues.join(", ")}`);
  }
  const insecure = origins.find((origin) => origin.protocol !== "https:");
  if (deployed && insecure) {
    throw new Error(
      `CSP_MEDIA_ORIGINS must use HTTPS in staging/prod: ${insecure.origin}`,
    );
  }
  return origins.map((origin) => origin.origin);
}

function resolveAppPublicOrigin(deployed: boolean): string {
  const rawValue = process.env.APP_PUBLIC_URL?.trim();
  if (!rawValue) {
    if (deployed) {
      throw new Error("APP_PUBLIC_URL is required in staging/prod");
    }
    return "http://localhost:3000";
  }

  const origin = parseWebOrigin(rawValue);
  if (!origin) {
    throw new Error(`Invalid APP_PUBLIC_URL: ${rawValue}`);
  }
  if (deployed && origin.protocol !== "https:") {
    throw new Error(`APP_PUBLIC_URL must use HTTPS in staging/prod: ${rawValue}`);
  }
  return origin.origin;
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
    const origin = parseWebOrigin(fastApiBaseUrl);
    if (origin) {
      if (deployed && origin.protocol !== "https:" && !origin.isLocalhost) {
        throw new Error(`Invalid FASTAPI_BASE_URL for CSP connect-src: ${fastApiBaseUrl}`);
      }
      origins.add(origin.origin);
    } else if (deployed) {
      throw new Error(`Invalid FASTAPI_BASE_URL for CSP connect-src: ${fastApiBaseUrl}`);
    }
  } else if (deployed) {
    throw new Error("FASTAPI_BASE_URL is required in staging/prod for CSP connect-src");
  }

  const r2S3ApiOrigin = process.env.R2_S3_API_ORIGIN?.trim();
  if (r2S3ApiOrigin) {
    const origin = parseWebOrigin(r2S3ApiOrigin);
    if (origin) {
      if (deployed && origin.protocol !== "https:" && !origin.isLocalhost) {
        throw new Error(`Invalid R2_S3_API_ORIGIN for CSP connect-src: ${r2S3ApiOrigin}`);
      }
      if (deployed && !origin.hostname.endsWith(".r2.cloudflarestorage.com")) {
        throw new Error(`Invalid R2_S3_API_ORIGIN for CSP connect-src: ${r2S3ApiOrigin}`);
      }
      origins.add(origin.origin);
    } else if (deployed) {
      throw new Error(`Invalid R2_S3_API_ORIGIN for CSP connect-src: ${r2S3ApiOrigin}`);
    }
  } else if (deployed) {
    throw new Error("R2_S3_API_ORIGIN is required in staging/prod for CSP connect-src");
  }

  return [...origins];
}

// NEXUS_EXTENSION_REDIRECT_ORIGINS keeps its plural name and holds exactly one
// origin (browser.identity.getRedirectURL()'s), https when deployed.
function resolveExtensionRedirectOrigin(deployed: boolean): string | null {
  const rawValue = process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS?.trim();
  if (!rawValue) return null;
  const origin = parseWebOrigin(rawValue);
  if (!origin || (deployed && origin.protocol !== "https:")) {
    throw new Error(
      `NEXUS_EXTENSION_REDIRECT_ORIGINS must be one ${deployed ? "https " : ""}origin: ${rawValue}`,
    );
  }
  return origin.origin;
}
