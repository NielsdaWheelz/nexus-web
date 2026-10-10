// the edge-safe half of the supabase boundary (auth.ts is the server half): the
// session cookie's grammar and its network-free classification. it imports no
// sdk, so middleware's edge bundle stays free of @supabase/*. replacing the
// provider means rewriting this file and auth.ts behind the same exports.
import { getEnv } from "@/lib/env";
import { isRecord } from "@/lib/validation";

export interface CookieValue {
  readonly name: string;
  readonly value: string;
}

// what the presented cookie says, never whether the provider agrees.
export type Session =
  | { readonly state: "anonymous" }
  | {
      readonly state: "active";
      readonly accessToken: string;
      readonly canRefresh: boolean;
      readonly cookieNames: readonly string[];
    }
  | { readonly state: "refreshable"; readonly cookieNames: readonly string[] }
  | { readonly state: "ended"; readonly cookieNames: readonly string[] };

// auth-js refreshes a session it loads by itself when fewer than 90 s remain
// (EXPIRY_MARGIN_MS in @supabase/auth-js 2.108.2). an active session leaves it
// nothing to refresh for a whole operation (the 5 s deadline in auth.ts), so
// refresh() stays the only place a refresh token is spent. the provider's
// jwt_expiry must exceed this margin, or no refreshed session is ever active.
const REFRESH_MARGIN_MS = 120_000;

// `sb-<first label of the supabase host>-auth-token`. an unparseable url
// throws: a startup defect, not a session state.
function baseName(): string {
  const ref = new URL(getEnv().supabase.url).hostname.split(".")[0];
  if (!ref) throw new Error("NEXT_PUBLIC_SUPABASE_URL names no project");
  return `sb-${ref}-auth-token`;
}

// the session cookie's names: whole, or chunked as `.0`..`.n`.
export function authCookieNames(cookies: readonly CookieValue[]): string[] {
  const base = baseName();
  return cookies
    .map(({ name }) => name)
    .filter(
      (name) =>
        name === base ||
        (name.startsWith(`${base}.`) &&
          /^\d+$/.test(name.slice(base.length + 1))),
    );
}

// lib/supabase internal: the assembled value (the whole cookie wins over
// chunks) and its payload, or null when absent or unreadable (untrusted bytes).
export function decodeSessionCookie(cookies: readonly CookieValue[]): {
  readonly value: string;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly bearer: boolean;
  readonly refreshToken: string | null;
} | null {
  const base = baseName();
  const whole = cookies.find((c) => c.name === base && c.value);
  let value = whole?.value ?? "";
  for (let index = 0; !whole; index += 1) {
    const chunk = cookies.find((c) => c.name === `${base}.${index}` && c.value);
    if (!chunk) break;
    value += chunk.value;
  }
  if (!value.startsWith("base64-")) return null;
  let raw: unknown;
  try {
    const base64 = value.slice(7).replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    const unreadable =
      error instanceof SyntaxError ||
      error instanceof DOMException ||
      error instanceof TypeError;
    if (!unreadable) throw error;
    return null;
  }
  if (!isRecord(raw) || typeof raw.access_token !== "string") return null;
  if (typeof raw.expires_at !== "number" || typeof raw.token_type !== "string")
    return null;
  if (!raw.access_token) return null;
  return {
    value,
    accessToken: raw.access_token,
    expiresAt: raw.expires_at,
    bearer: raw.token_type.toLowerCase() === "bearer",
    refreshToken:
      typeof raw.refresh_token === "string" && raw.refresh_token
        ? raw.refresh_token
        : null,
  };
}

// anonymous: no session cookie at all. ended: unreadable, not a bearer, or
// expired with nothing to refresh it.
export function readSession(
  cookies: readonly CookieValue[],
  nowMs = Date.now(),
): Session {
  const cookieNames = authCookieNames(cookies);
  const session = decodeSessionCookie(cookies);
  if (!session && cookieNames.length === 0) return { state: "anonymous" };
  if (!session || !session.bearer) return { state: "ended", cookieNames };
  if (session.expiresAt * 1000 > nowMs + REFRESH_MARGIN_MS) {
    return {
      state: "active",
      accessToken: session.accessToken,
      canRefresh: session.refreshToken !== null,
      cookieNames,
    };
  }
  return session.refreshToken
    ? { state: "refreshable", cookieNames }
    : { state: "ended", cookieNames };
}

// lib/supabase internal: the jar a response leaves behind, writes applied in
// order and deletions (maxAge 0) removed.
export function applyWrites(
  cookies: readonly CookieValue[],
  writes: readonly {
    name: string;
    value: string;
    options?: { maxAge?: number };
  }[],
): CookieValue[] {
  const jar = new Map(cookies.map((c) => [c.name, c.value]));
  for (const { name, value, options } of writes) {
    if (options?.maxAge === 0) jar.delete(name);
    else jar.set(name, value);
  }
  return Array.from(jar, ([name, value]) => ({ name, value }));
}
