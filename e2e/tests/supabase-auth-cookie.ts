import { expect } from "@playwright/test";

/**
 * Single owner for the Supabase auth-cookie wire format shared by the e2e auth
 * helpers (`auth-bootstrap.ts` writes a real session; `session-cookie-fixtures.ts`
 * rewrites it to drive lifecycle states). Shape — cookie `sb-<projectRef>-auth-token`,
 * value `base64-<base64url(JSON)>`, chunked at 3800 bytes (`.0`, `.1`, …) — is
 * exactly what `@supabase/ssr` writes and the boundary parser reads.
 */

export interface SupabaseSessionPayload {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown>;
}

// @supabase/ssr splits a cookie value into chunks of this size; a rewritten
// value must re-chunk identically so a chunked session stays chunked.
const MAX_COOKIE_VALUE_BYTES = 3_800;

export function supabaseAuthCookieBaseName(): string {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL — cannot derive the auth cookie name.",
    );
  }
  const host = new URL(supabaseUrl).hostname;
  const projectRef = host.split(".")[0] || host;
  return `sb-${projectRef}-auth-token`;
}

export function authCookieChunkPattern(baseName: string): RegExp {
  // The unchunked cookie, or a numeric chunk suffix (`.0`, `.1`, …).
  return new RegExp(`^${baseName}(\\.\\d+)?$`);
}

export function encodeSupabaseCookieValue(session: SupabaseSessionPayload): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

export function decodeSupabaseCookieValue(value: string): SupabaseSessionPayload {
  expect(
    value.startsWith("base64-"),
    `Auth cookie value is not the expected base64- shape: ${value.slice(0, 32)}…`,
  ).toBeTruthy();
  const json = Buffer.from(
    value.slice("base64-".length),
    "base64url",
  ).toString("utf-8");
  return JSON.parse(json) as SupabaseSessionPayload;
}

export function chunkSupabaseCookie(
  name: string,
  value: string,
): Array<{ name: string; value: string }> {
  if (value.length <= MAX_COOKIE_VALUE_BYTES) {
    return [{ name, value }];
  }
  const chunks: Array<{ name: string; value: string }> = [];
  for (let idx = 0; idx < value.length; idx += MAX_COOKIE_VALUE_BYTES) {
    chunks.push({
      name: `${name}.${chunks.length}`,
      value: value.slice(idx, idx + MAX_COOKIE_VALUE_BYTES),
    });
  }
  return chunks;
}
