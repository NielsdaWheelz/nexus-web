import { expect, type BrowserContext } from "@playwright/test";

/**
 * Mutators for the live Supabase auth cookie, used by the silent-refresh E2E
 * specs to drive a real session into the `refreshable` and `ended` lifecycle
 * states without waiting an hour for a genuine access token to expire.
 *
 * A session is bootstrapped for real (see `auth-bootstrap.ts`); these helpers
 * then rewrite only the `expires_at` (and optionally the `refresh_token`) field
 * of the already-issued auth cookie, leaving the rest of the real session
 * intact. The cookie shape — `sb-<projectRef>-auth-token`, value
 * `base64-<base64url(JSON)>`, chunked at `.0`, `.1`, … — is exactly the shape
 * `@supabase/ssr` writes and the boundary parser reads.
 */

// @supabase/ssr splits a cookie value into chunks of this size. The bootstrap
// helper uses the same bound; a rewritten value must re-chunk identically so a
// chunked session stays chunked.
const MAX_COOKIE_VALUE_BYTES = 3_800;

// Pushes `expires_at` this far into the past. Comfortably beyond the parser's
// 60-second refresh margin, so the cookie classifies as `refreshable`/`ended`
// and never as `active`.
const EXPIRED_BY_SECONDS = 3_600;

interface SupabaseSessionPayload {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown>;
}

function authCookieBaseName(): string {
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

function authCookieChunkPattern(baseName: string): RegExp {
  // The unchunked cookie, or a numeric chunk suffix (`.0`, `.1`, …).
  return new RegExp(`^${baseName}(\\.\\d+)?$`);
}

function decodeCookieValue(value: string): SupabaseSessionPayload {
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

function encodeCookieValue(session: SupabaseSessionPayload): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function chunkCookie(
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

async function readAuthSession(
  context: BrowserContext,
): Promise<SupabaseSessionPayload> {
  const baseName = authCookieBaseName();
  const pattern = authCookieChunkPattern(baseName);
  const chunks = (await context.cookies())
    .filter((cookie) => pattern.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  expect(
    chunks.length,
    "Expected a Supabase auth cookie on the context — bootstrap a session first.",
  ).toBeGreaterThan(0);
  return decodeCookieValue(chunks.map((cookie) => cookie.value).join(""));
}

async function writeAuthSession(
  context: BrowserContext,
  appBaseUrl: string,
  session: SupabaseSessionPayload,
): Promise<void> {
  const baseName = authCookieBaseName();
  // Clear every existing chunk first: a rewrite that produced fewer chunks
  // would otherwise leave a stale tail chunk and corrupt the reconstructed
  // value.
  await context.clearCookies({ name: authCookieChunkPattern(baseName) });
  await context.addCookies(
    chunkCookie(baseName, encodeCookieValue(session)).map((cookie) => ({
      ...cookie,
      url: appBaseUrl,
      sameSite: "Lax" as const,
      httpOnly: false,
      secure: false,
    })),
  );
}

/**
 * Rewrites the live auth cookie so its access token reads as long expired while
 * its real, still-valid `refresh_token` is preserved. The boundary parser then
 * classifies the cookie `refreshable`, and a real `/auth/refresh` succeeds.
 */
export async function expireAccessTokenKeepingRefreshToken(
  context: BrowserContext,
  appBaseUrl: string,
): Promise<void> {
  const session = await readAuthSession(context);
  expect(
    session.refresh_token.length,
    "Bootstrapped session has no refresh token — cannot exercise the refresh path.",
  ).toBeGreaterThan(0);
  await writeAuthSession(context, appBaseUrl, {
    ...session,
    expires_at: Math.floor(Date.now() / 1000) - EXPIRED_BY_SECONDS,
  });
}

/**
 * Rewrites the live auth cookie so its access token reads as expired and its
 * `refresh_token` is replaced with a garbage value Supabase will reject. The
 * cookie still classifies `refreshable` (the parser is deliberately
 * optimistic), so `/auth/refresh` is reached — and fails, ending the session.
 */
export async function expireAccessTokenWithRevokedRefreshToken(
  context: BrowserContext,
  appBaseUrl: string,
): Promise<void> {
  const session = await readAuthSession(context);
  await writeAuthSession(context, appBaseUrl, {
    ...session,
    expires_at: Math.floor(Date.now() / 1000) - EXPIRED_BY_SECONDS,
    refresh_token: "e2e-revoked-refresh-token",
  });
}
