import { expect, type BrowserContext } from "@playwright/test";
import {
  authCookieChunkPattern,
  chunkSupabaseCookie,
  decodeSupabaseCookieValue,
  encodeSupabaseCookieValue,
  supabaseAuthCookieBaseName,
  type SupabaseSessionPayload,
} from "./supabase-auth-cookie";

/**
 * Mutators for the live Supabase auth cookie, used by the silent-refresh E2E
 * specs to drive a real session into the `refreshable` and `ended` lifecycle
 * states without waiting an hour for a genuine access token to expire.
 *
 * A session is bootstrapped for real (see `auth-bootstrap.ts`); these helpers
 * then rewrite only the `expires_at` (and optionally the `refresh_token`) field
 * of the already-issued auth cookie, leaving the rest of the real session
 * intact. The cookie wire format is owned by `supabase-auth-cookie.ts`.
 */

// Pushes `expires_at` this far into the past. Comfortably beyond the parser's
// 60-second refresh margin, so the cookie classifies as `refreshable`/`ended`
// and never as `active`.
const EXPIRED_BY_SECONDS = 3_600;

async function readAuthSession(
  context: BrowserContext,
): Promise<SupabaseSessionPayload> {
  const baseName = supabaseAuthCookieBaseName();
  const pattern = authCookieChunkPattern(baseName);
  const chunks = (await context.cookies())
    .filter((cookie) => pattern.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  expect(
    chunks.length,
    "Expected a Supabase auth cookie on the context — bootstrap a session first.",
  ).toBeGreaterThan(0);
  return decodeSupabaseCookieValue(chunks.map((cookie) => cookie.value).join(""));
}

async function writeAuthSession(
  context: BrowserContext,
  appBaseUrl: string,
  session: SupabaseSessionPayload,
): Promise<void> {
  const baseName = supabaseAuthCookieBaseName();
  // Clear every existing chunk first: a rewrite that produced fewer chunks
  // would otherwise leave a stale tail chunk and corrupt the reconstructed
  // value.
  await context.clearCookies({ name: authCookieChunkPattern(baseName) });
  await context.addCookies(
    chunkSupabaseCookie(baseName, encodeSupabaseCookieValue(session)).map((cookie) => ({
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
