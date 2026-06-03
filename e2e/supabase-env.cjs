const { execSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const FORBIDDEN_SUPABASE_ADMIN_ENV = [
  "SERVICE_ROLE_KEY",
  "SUPABASE_DATABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const APP_RUNTIME_FORBIDDEN_ENV = [
  "SUPABASE_AUTH_ADMIN_KEY",
  ...FORBIDDEN_SUPABASE_ADMIN_ENV,
];

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const parsed = {};
  const raw = readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function localApiUrlFromConfig(rootDir) {
  try {
    const config = readFileSync(path.join(rootDir, "supabase/config.toml"), "utf-8");
    const match = config.match(/\[api\][\s\S]*?\nport\s*=\s*([0-9]+)/);
    return match ? `http://127.0.0.1:${match[1]}` : null;
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSupabaseStatus(rawStatus) {
  const normalized = rawStatus
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("Stopped services:"))
    .join("\n");

  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized);
    const apiUrl = stringValue(parsed.API_URL);
    const anonKey = stringValue(parsed.ANON_KEY) ?? stringValue(parsed.PUBLISHABLE_KEY);
    const adminKey = stringValue(parsed.SECRET_KEY);
    if (!apiUrl && !anonKey && !adminKey) {
      return null;
    }
    return { apiUrl, anonKey, adminKey };
  } catch {
    return null;
  }
}

function readLiveSupabaseStatus(cwd) {
  try {
    const rawStatus = execSync("supabase status --output json", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseSupabaseStatus(rawStatus);
  } catch {
    return null;
  }
}

function loadRootFileEnv(rootDir) {
  const env = {
    ...loadEnvFile(path.join(rootDir, ".env")),
    ...loadEnvFile(path.join(rootDir, ".dev-ports")),
  };
  for (const key of APP_RUNTIME_FORBIDDEN_ENV) {
    delete env[key];
  }
  return env;
}

function assertNoLegacyAdminEnv(env) {
  const forbidden = FORBIDDEN_SUPABASE_ADMIN_ENV.filter(
    (key) => stringValue(env[key]) !== null,
  );
  if (forbidden.length > 0) {
    throw new Error(
      "Supabase E2E bootstrap does not accept legacy admin env aliases: " +
        `${forbidden.join(", ")}. Use command-scoped SUPABASE_AUTH_ADMIN_KEY.`,
    );
  }
}

function assertLocalSupabaseUrl(supabaseUrl) {
  let parsed;
  try {
    parsed = new URL(supabaseUrl);
  } catch (error) {
    throw new Error(
      `Supabase E2E URL is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error(
      `Supabase E2E bootstrap is local-only; refusing Supabase URL origin ${parsed.origin}.`,
    );
  }
}

function missingSupabaseConfigMessage(missing) {
  return (
    "Missing Supabase E2E bootstrap configuration: " +
    `${missing.join(", ")}.\n` +
    "Run through `make test-e2e`/`make test-csp`, or start local Supabase and provide " +
    "command-scoped SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_AUTH_ADMIN_KEY."
  );
}

function applyPublicValues(env, resolved) {
  env.SUPABASE_URL = resolved.supabaseUrl;
  env.NEXT_PUBLIC_SUPABASE_URL = resolved.supabaseUrl;
  env.SUPABASE_ANON_KEY = resolved.anonKey;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = resolved.anonKey;
  env.SUPABASE_ISSUER = `${resolved.supabaseUrl}/auth/v1`;
  env.SUPABASE_JWKS_URL = `${resolved.supabaseUrl}/auth/v1/.well-known/jwks.json`;
  env.SUPABASE_AUDIENCES = env.SUPABASE_AUDIENCES ?? "authenticated";
}

function resolveSupabaseE2EEnv(rootDir, env = process.env, options = {}) {
  const fileEnv = options.loadFiles === false ? {} : loadRootFileEnv(rootDir);
  assertNoLegacyAdminEnv(env);
  const liveStatus = readLiveSupabaseStatus(rootDir);

  const supabaseUrl =
    liveStatus?.apiUrl ??
    env.SUPABASE_URL ??
    env.NEXT_PUBLIC_SUPABASE_URL ??
    fileEnv.SUPABASE_URL ??
    fileEnv.NEXT_PUBLIC_SUPABASE_URL ??
    localApiUrlFromConfig(rootDir);

  const anonKey =
    liveStatus?.anonKey ??
    env.SUPABASE_ANON_KEY ??
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    fileEnv.SUPABASE_ANON_KEY ??
    fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    env.SUPABASE_PUBLISHABLE_KEY ??
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    fileEnv.SUPABASE_PUBLISHABLE_KEY ??
    fileEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  const adminKey = liveStatus?.adminKey ?? env.SUPABASE_AUTH_ADMIN_KEY;

  const missing = [];
  if (!supabaseUrl) {
    missing.push("SUPABASE_URL");
  }
  if (!anonKey) {
    missing.push("SUPABASE_ANON_KEY");
  }
  if (options.requireAdmin && !adminKey) {
    missing.push("SUPABASE_AUTH_ADMIN_KEY");
  }
  if (missing.length > 0) {
    throw new Error(missingSupabaseConfigMessage(missing));
  }
  if (supabaseUrl) {
    assertLocalSupabaseUrl(supabaseUrl);
  }

  return { supabaseUrl, anonKey, adminKey };
}

function applySupabasePublicEnv(rootDir, env = process.env, options = {}) {
  const resolved = resolveSupabaseE2EEnv(rootDir, env, options);
  applyPublicValues(env, resolved);
  return resolved;
}

function requireSupabaseAdminEnv(rootDir, env = process.env, options = {}) {
  const resolved = resolveSupabaseE2EEnv(rootDir, env, {
    ...options,
    requireAdmin: true,
  });
  applyPublicValues(env, resolved);
  env.SUPABASE_AUTH_ADMIN_KEY = resolved.adminKey;
  return resolved;
}

function buildE2eAppRuntimeEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of APP_RUNTIME_FORBIDDEN_ENV) {
    delete env[key];
  }
  return env;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function printShellEnv(rootDir, requireAdmin) {
  const env = requireAdmin
    ? requireSupabaseAdminEnv(rootDir, process.env)
    : applySupabasePublicEnv(rootDir, process.env);
  const shellExports = {
    SUPABASE_URL: env.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_URL: env.supabaseUrl,
    SUPABASE_ANON_KEY: env.anonKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.anonKey,
    SUPABASE_ISSUER: `${env.supabaseUrl}/auth/v1`,
    SUPABASE_JWKS_URL: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
    SUPABASE_AUDIENCES: process.env.SUPABASE_AUDIENCES ?? "authenticated",
    ...(requireAdmin ? { SUPABASE_AUTH_ADMIN_KEY: env.adminKey } : {}),
  };
  for (const [key, value] of Object.entries(shellExports)) {
    console.log(`export ${key}=${shellQuote(value)}`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const printShell = args.includes("--print-shell");
  const requireAdmin = args.includes("--require-admin");
  const unknown = args.filter(
    (arg) => !["--print-shell", "--require-admin"].includes(arg),
  );

  if (!printShell || unknown.length > 0) {
    console.error("Usage: node e2e/supabase-env.cjs --print-shell [--require-admin]");
    process.exit(2);
  }

  try {
    printShellEnv(path.resolve(__dirname, ".."), requireAdmin);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  applySupabasePublicEnv,
  buildE2eAppRuntimeEnv,
  loadRootFileEnv,
  requireSupabaseAdminEnv,
  resolveSupabaseE2EEnv,
};
