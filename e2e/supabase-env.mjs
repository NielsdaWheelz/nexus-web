import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
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
    const apiUrl = parsed.API_URL;
    const anonKey = parsed.ANON_KEY ?? null;
    const publishableKey = parsed.PUBLISHABLE_KEY ?? null;
    const serviceRoleKey = parsed.SERVICE_ROLE_KEY ?? null;
    const secretKey = parsed.SECRET_KEY ?? null;
    if (!apiUrl || (!anonKey && !publishableKey) || (!serviceRoleKey && !secretKey)) {
      return null;
    }
    return { apiUrl, anonKey, publishableKey, serviceRoleKey, secretKey };
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

export function loadRootFileEnv(rootDir) {
  return {
    ...loadEnvFile(path.join(rootDir, ".env")),
    ...loadEnvFile(path.join(rootDir, ".dev-ports")),
  };
}

export function resolveSupabaseEnv(rootDir, env = process.env) {
  const fileEnv = loadRootFileEnv(rootDir);
  const liveStatus = readLiveSupabaseStatus(rootDir);

  const supabaseUrl =
    liveStatus?.apiUrl ??
    env.NEXT_PUBLIC_SUPABASE_URL ??
    env.SUPABASE_URL ??
    fileEnv.NEXT_PUBLIC_SUPABASE_URL ??
    fileEnv.SUPABASE_URL;

  const anonKey =
    liveStatus?.anonKey ??
    liveStatus?.publishableKey ??
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    env.SUPABASE_ANON_KEY ??
    fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    fileEnv.SUPABASE_ANON_KEY ??
    fileEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    fileEnv.SUPABASE_PUBLISHABLE_KEY;

  const adminKey =
    liveStatus?.secretKey ??
    liveStatus?.serviceRoleKey ??
    env.SUPABASE_ADMIN_KEY ??
    env.SUPABASE_SECRET_KEY ??
    env.SUPABASE_SERVICE_ROLE_KEY ??
    env.SUPABASE_SERVICE_KEY ??
    fileEnv.SUPABASE_ADMIN_KEY ??
    fileEnv.SUPABASE_SECRET_KEY ??
    fileEnv.SUPABASE_SERVICE_ROLE_KEY ??
    fileEnv.SUPABASE_SERVICE_KEY;

  return {
    ...fileEnv,
    supabaseUrl,
    anonKey,
    adminKey,
  };
}

export function applyResolvedSupabaseEnv(rootDir, env = process.env) {
  const resolved = resolveSupabaseEnv(rootDir, env);

  if (resolved.supabaseUrl) {
    env.SUPABASE_URL = resolved.supabaseUrl;
    env.NEXT_PUBLIC_SUPABASE_URL = resolved.supabaseUrl;
    env.SUPABASE_ISSUER = `${resolved.supabaseUrl}/auth/v1`;
    env.SUPABASE_JWKS_URL = `${resolved.supabaseUrl}/auth/v1/.well-known/jwks.json`;
  }

  if (resolved.anonKey) {
    env.SUPABASE_ANON_KEY = resolved.anonKey;
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = resolved.anonKey;
  }

  if (resolved.adminKey) {
    env.SUPABASE_ADMIN_KEY = resolved.adminKey;
    env.SUPABASE_SERVICE_KEY = resolved.adminKey;
  }

  env.SUPABASE_AUDIENCES = env.SUPABASE_AUDIENCES ?? "authenticated";

  return resolved;
}
