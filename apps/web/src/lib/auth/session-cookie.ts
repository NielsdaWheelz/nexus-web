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

  if (!parsed || typeof parsed !== "object") {
    return { state: "anonymous", reason: "malformed", cookieNames };
  }

  const accessToken = (parsed as { access_token?: unknown }).access_token;
  const expiresAt = (parsed as { expires_at?: unknown }).expires_at;
  const tokenType = (parsed as { token_type?: unknown }).token_type;
  const refreshToken = (parsed as { refresh_token?: unknown }).refresh_token;

  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresAt !== "number" ||
    typeof tokenType !== "string"
  ) {
    return { state: "anonymous", reason: "malformed", cookieNames };
  }

  if (tokenType.toLowerCase() !== "bearer") {
    return { state: "anonymous", reason: "non_bearer", cookieNames };
  }

  if (expiresAt * 1000 > nowMs + REFRESH_MARGIN_SECONDS * 1000) {
    return { state: "active", accessToken, expiresAt, cookieNames };
  }

  if (typeof refreshToken === "string" && refreshToken.length > 0) {
    return { state: "refreshable", cookieNames };
  }

  return { state: "ended", reason: "no_refresh_token", cookieNames };
}
