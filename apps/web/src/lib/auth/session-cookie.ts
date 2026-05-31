import type { NextResponse } from "next/server";
import { isRecord } from "@/lib/validation";

// A token within this many seconds of expiry is classified `refreshable` so a
// request never races its own access-token expiry.
const REFRESH_MARGIN_SECONDS = 60;

export type SessionState =
  | {
      state: "anonymous";
      reason: "bad_config" | "missing" | "malformed" | "non_bearer";
      cookieNames: string[];
    }
  | {
      state: "active";
      accessToken: string;
      expiresAt: number;
      cookieNames: string[];
    }
  | { state: "refreshable"; cookieNames: string[] }
  | { state: "ended"; reason: "no_refresh_token"; cookieNames: string[] };

export interface CookieValue {
  name: string;
  value: string;
}

interface SupabaseSessionPayload {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
  refreshToken: string | null;
}

function getSupabaseAuthCookieName(): string | null {
  try {
    const hostname = new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
    ).hostname;
    const projectRef = hostname.split(".")[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    // justify-ignore-error: a missing or malformed Supabase URL means this
    // process cannot identify the trusted auth cookie prefix.
    return null;
  }
}

export function getSupabaseAuthCookieNames(
  cookies: readonly CookieValue[]
): string[] {
  const cookieName = getSupabaseAuthCookieName();
  if (!cookieName) {
    return [];
  }

  return cookies
    .map(({ name }) => name)
    .filter((name) => {
      if (name === cookieName) {
        return true;
      }
      if (!name.startsWith(`${cookieName}.`)) {
        return false;
      }
      return /^\d+$/.test(name.slice(cookieName.length + 1));
    });
}

// Expire every Supabase auth cookie on the outgoing response. The empty value
// plus maxAge: 0 is the browser-supported way to drop a cookie; the path must
// match the original set (the app sets these at `/`).
export function clearSupabaseAuthCookies(
  response: NextResponse,
  cookieNames: readonly string[],
): void {
  for (const name of cookieNames) {
    response.cookies.set(name, "", { maxAge: 0, path: "/" });
  }
}

export function parseCookieHeader(header: string | null): CookieValue[] {
  if (!header) {
    return [];
  }

  return header
    .split(";")
    .map((part) => part.trim())
    .flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        return [];
      }
      return [
        {
          name: part.slice(0, separator),
          value: part.slice(separator + 1),
        },
      ];
    });
}

function parseSupabaseSessionPayload(value: unknown): SupabaseSessionPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const accessToken = value.access_token;
  const expiresAt = value.expires_at;
  const tokenType = value.token_type;
  const refreshToken = value.refresh_token;

  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresAt !== "number" ||
    typeof tokenType !== "string"
  ) {
    return null;
  }

  return {
    accessToken,
    expiresAt,
    tokenType,
    refreshToken: typeof refreshToken === "string" ? refreshToken : null,
  };
}

export function readSupabaseSessionCookie(
  cookies: readonly CookieValue[],
  nowMs: number = Date.now()
): SessionState {
  const cookieName = getSupabaseAuthCookieName();
  if (!cookieName) {
    return { state: "anonymous", reason: "bad_config", cookieNames: [] };
  }

  const cookieNames = getSupabaseAuthCookieNames(cookies);
  const directCookie = cookies.find(
    ({ name, value }) => name === cookieName && value
  );
  let value = directCookie?.value ?? "";

  if (!value) {
    const chunks: string[] = [];
    for (let index = 0; ; index += 1) {
      const chunk = cookies.find(
        ({ name, value: chunkValue }) =>
          name === `${cookieName}.${index}` && chunkValue
      );
      if (!chunk) {
        break;
      }
      chunks.push(chunk.value);
    }
    value = chunks.join("");
  }

  if (!value) {
    return {
      state: "anonymous",
      reason: cookieNames.length > 0 ? "malformed" : "missing",
      cookieNames,
    };
  }

  if (!value.startsWith("base64-")) {
    return { state: "anonymous", reason: "malformed", cookieNames };
  }

  let parsed: unknown;
  try {
    const base64 = value
      .slice("base64-".length)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );
    const bytes = Uint8Array.from(globalThis.atob(padded), (char) =>
      char.charCodeAt(0)
    );
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      !(error instanceof TypeError) &&
      !(error instanceof DOMException)
    ) {
      throw error;
    }
    // justify-ignore-error: malformed browser cookie data is untrusted input and
    // becomes an unrecoverable auth cookie.
    return { state: "anonymous", reason: "malformed", cookieNames };
  }

  const session = parseSupabaseSessionPayload(parsed);
  if (!session) {
    return { state: "anonymous", reason: "malformed", cookieNames };
  }

  if (session.tokenType.toLowerCase() !== "bearer") {
    return { state: "anonymous", reason: "non_bearer", cookieNames };
  }

  if (session.expiresAt * 1000 > nowMs + REFRESH_MARGIN_SECONDS * 1000) {
    return {
      state: "active",
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      cookieNames,
    };
  }

  if (session.refreshToken) {
    return { state: "refreshable", cookieNames };
  }

  return { state: "ended", reason: "no_refresh_token", cookieNames };
}
