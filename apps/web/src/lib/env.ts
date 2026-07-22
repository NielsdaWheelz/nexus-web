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
import { parseWebOrigin } from "./security/origin";

type NexusEnv = "local" | "test" | "staging" | "prod";

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

interface ResolvedEnv {
  readonly nexusEnv: NexusEnv;
  /** Canonical browser origin used for absolute metadata URLs. */
  readonly appPublicOrigin: string;
  /** FastAPI/SSE origin + presigned R2 origin. Origin-only, deduped, validated. */
  readonly connectOrigins: readonly string[];
  readonly serverActionAllowedOrigins: readonly string[];
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
 * R2_S3_API_ORIGIN, or NEXUS_INTERNAL_SECRET throws. `next.config.ts` calls this during config
 * evaluation, so a bad deployed env fails `next build` before promotion.
 */
export function getEnv(): ResolvedEnv {
  if (resolved) return resolved;
  const env = nexusEnv();
  const deployed = env === "staging" || env === "prod";

  const connectOrigins = resolveConnectOrigins(deployed);
  validateAuthRedirectOrigins(deployed);
  const serverActionAllowedOrigins = resolveServerActionAllowedOrigins(deployed);

  const internalSecret = process.env.NEXUS_INTERNAL_SECRET?.trim() ?? "";
  if (deployed && !internalSecret) {
    throw new Error("NEXUS_INTERNAL_SECRET is required in staging/prod");
  }
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL?.trim() || (deployed ? "" : "http://localhost:8000");
  const appPublicOrigin = resolveAppPublicOrigin(deployed);

  resolved = Object.freeze({
    nexusEnv: env,
    appPublicOrigin,
    connectOrigins,
    serverActionAllowedOrigins,
    internalApi: Object.freeze({ fastApiBaseUrl, internalSecret }),
    disableCspForE2E: !deployed && process.env.E2E_DISABLE_CSP === "1",
  });
  return resolved;
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

function validateAuthRedirectOrigins(deployed: boolean): void {
  resolveOriginEnv(
    "AUTH_ALLOWED_REDIRECT_ORIGINS",
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS,
    deployed,
    deployed
  );
  resolveOriginEnv(
    "AUTH_TRUSTED_PROXY_ORIGINS",
    process.env.AUTH_TRUSTED_PROXY_ORIGINS,
    deployed,
    false
  );
  resolveOriginEnv(
    "NEXUS_EXTENSION_REDIRECT_ORIGINS",
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS,
    deployed,
    false
  );

  if (
    deployed &&
    process.env.AUTH_TRUSTED_PROXY_ORIGINS?.trim() &&
    !process.env.SERVER_ACTION_ALLOWED_ORIGINS?.trim()
  ) {
    throw new Error(
      "SERVER_ACTION_ALLOWED_ORIGINS is required when AUTH_TRUSTED_PROXY_ORIGINS is set in staging/prod"
    );
  }
}

function resolveOriginEnv(
  name: string,
  rawValue: string | undefined,
  deployed: boolean,
  required: boolean
): string[] {
  const origins = new Set<string>();
  const entries = (rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (required && entries.length === 0) {
    throw new Error(`${name} is required in staging/prod`);
  }

  for (const entry of entries) {
    const origin = parseWebOrigin(entry);
    if (!origin) throw new Error(`Invalid ${name}: ${entry}`);
    if (deployed && origin.protocol !== "https:") {
      throw new Error(`${name} must use HTTPS origins in staging/prod: ${entry}`);
    }
    origins.add(origin.origin);
  }

  return [...origins];
}

function resolveServerActionAllowedOrigins(deployed: boolean): string[] {
  const values = new Set<string>();

  for (const rawEntry of (process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? "").split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (!isServerActionOriginPattern(entry)) {
      throw new Error(`Invalid SERVER_ACTION_ALLOWED_ORIGINS entry: ${rawEntry.trim()}`);
    }
    if (deployed && (entry.includes("localhost") || entry.includes("127.0.0.1"))) {
      throw new Error("SERVER_ACTION_ALLOWED_ORIGINS must not contain localhost in staging/prod");
    }
    values.add(entry);
  }

  return [...values];
}

function isServerActionOriginPattern(value: string): boolean {
  const domain = value.startsWith("*.") ? value.slice(2) : value;
  if (!domain || value === "*" || value.includes("://")) return false;
  if (domain.includes("/") || domain.includes(":") || domain.includes("*")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  const labels = domain.split(".");
  if (value.startsWith("*.") && labels.length < 3) return false;
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
  );
}
