// the web process's one validated configuration (the mirror of python's
// get_settings()). server and build only: it owns NEXUS_INTERNAL_SECRET, so
// never import it from a client component. next.config.ts resolves it, so a
// deployed build with missing or invalid env fails `next build`, and any env
// fails `next start`. not marked server-only because next.config.ts imports it.

interface WebOrigin {
  readonly origin: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly isLocalhost: boolean;
}

interface ResolvedEnv {
  readonly supabase: {
    readonly url: string;
    readonly anonKey: string;
    /** SUPABASE_ISSUER, SUPABASE_AUDIENCES: what the api accepts (local: the url's). */
    readonly issuer: string;
    readonly audiences: readonly string[];
  };
  /** APP_PUBLIC_URL: every absolute redirect, Origin check, Secure cookie and metadata url. */
  readonly appPublicOrigin: string;
  /** the presigned storage origin the browser PUTs and GETs (CSP connect-src). */
  readonly connectOrigins: readonly string[];
  /** the extension's identity redirect origin; null disables connect. */
  readonly extensionRedirectOrigin: string | null;
  readonly internalApi: {
    readonly fastApiBaseUrl: string;
    readonly internalSecret: string;
  };
}

let resolved: ResolvedEnv | null = null;

/** staging or prod: strict env, served over https (mirrors Settings.deployed). */
export function isDeployed(): boolean {
  const env = process.env.NEXUS_ENV?.trim() || "local";
  if (!["local", "test", "staging", "prod"].includes(env))
    throw new Error(
      `Invalid NEXUS_ENV: "${env}" (expected local | test | staging | prod)`,
    );
  return env === "staging" || env === "prod";
}

/** The exact commit this deployment serves (the Makefile sets it locally). */
export function vercelSourceSha(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error(
      "VERCEL_GIT_COMMIT_SHA must be exactly 40 lowercase hex characters",
    );
  return sha;
}

// a bare http(s) origin: no credentials, path, query or fragment.
function parseOrigin(value: string): WebOrigin | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  const hostname = url.hostname.toLowerCase();
  return {
    origin: url.origin,
    protocol: url.protocol,
    hostname,
    isLocalhost: ["localhost", "127.0.0.1", "[::1]"].includes(hostname),
  };
}

// one optional origin key: unset is null (or the local default), anything set
// must parse, and a deployed one must be https (or localhost where allowed). the
// value is read by the caller: middleware runs on the edge, where only static
// `process.env.KEY` reads are dependable.
function origin(
  name: string,
  value: string | undefined,
  deployed: boolean,
  options: { localDefault?: string; localhost?: boolean } = {},
): WebOrigin | null {
  const raw = value?.trim() || (deployed ? "" : options.localDefault);
  if (!raw) return null;
  const parsed = parseOrigin(raw);
  const secure =
    parsed?.protocol === "https:" || (options.localhost && parsed?.isLocalhost);
  if (!parsed || (deployed && !secure))
    throw new Error(
      `${name} must be ${deployed ? "an https" : "an"} origin: ${raw}`,
    );
  return parsed;
}

/** Resolve and validate once, then return the frozen result. */
export function getEnv(): ResolvedEnv {
  if (resolved) return resolved;
  const deployed = isDeployed();
  const required = (name: string, value: unknown) => {
    if (deployed && !value)
      throw new Error(`${name} is required in staging/prod`);
  };
  const fastApi = origin(
    "FASTAPI_BASE_URL",
    process.env.FASTAPI_BASE_URL,
    deployed,
    { localDefault: "http://localhost:8000", localhost: true },
  );
  const app = origin("APP_PUBLIC_URL", process.env.APP_PUBLIC_URL, deployed, {
    localDefault: "https://127.0.0.1:3000",
  });
  if (app && app.protocol !== "https:")
    throw new Error("APP_PUBLIC_URL must be an https origin");
  const storage = origin(
    "R2_S3_API_ORIGIN",
    process.env.R2_S3_API_ORIGIN,
    deployed,
  );
  if (
    storage &&
    deployed &&
    !storage.hostname.endsWith(".r2.cloudflarestorage.com")
  )
    throw new Error(
      `R2_S3_API_ORIGIN must be the Cloudflare R2 origin: ${storage.origin}`,
    );
  const extension = origin(
    "NEXUS_EXTENSION_REDIRECT_ORIGINS",
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS,
    deployed,
  );
  const internalSecret = process.env.NEXUS_INTERNAL_SECRET?.trim() ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const issuer = (
    process.env.SUPABASE_ISSUER?.trim() ||
    (deployed ? "" : `${supabaseUrl}/auth/v1`)
  ).replace(/\/+$/, "");
  const audiences = (
    process.env.SUPABASE_AUDIENCES?.trim() || (deployed ? "" : "authenticated")
  )
    .split(",")
    .map((audience) => audience.trim())
    .filter(Boolean);
  required("FASTAPI_BASE_URL", fastApi);
  required("APP_PUBLIC_URL", app);
  required("R2_S3_API_ORIGIN", storage);
  required("NEXUS_INTERNAL_SECRET", internalSecret);
  required("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
  required("NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey);
  required("SUPABASE_ISSUER", issuer);
  required("SUPABASE_AUDIENCES", audiences.length);
  resolved = Object.freeze({
    supabase: Object.freeze({
      url: supabaseUrl,
      anonKey,
      issuer,
      audiences: Object.freeze(audiences),
    }),
    appPublicOrigin: app!.origin,
    connectOrigins: Object.freeze(storage ? [storage.origin] : []),
    extensionRedirectOrigin: extension?.origin ?? null,
    internalApi: Object.freeze({
      fastApiBaseUrl: fastApi!.origin,
      internalSecret,
    }),
  });
  return resolved;
}
