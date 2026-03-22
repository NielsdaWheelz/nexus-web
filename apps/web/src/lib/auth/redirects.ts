export const DEFAULT_AUTH_REDIRECT = "/libraries";

const LOGIN_PATH = "/login";
const AUTH_PATH_PREFIX = "/auth/";

export type AuthSearchParam = string | string[] | undefined;

export function getFirstSearchParamValue(value: AuthSearchParam): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return null;
}

export function normalizeAuthRedirect(
  rawValue: string | null | undefined,
  fallback: string = DEFAULT_AUTH_REDIRECT
): string {
  if (!rawValue) {
    return fallback;
  }

  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, "http://localhost");
  } catch {
    return fallback;
  }

  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized === LOGIN_PATH || normalized.startsWith(AUTH_PATH_PREFIX)) {
    return fallback;
  }

  return normalized;
}

export function buildLoginRedirectUrl(requestUrl: URL): URL {
  const loginUrl = new URL(LOGIN_PATH, requestUrl.origin);
  const nextPath = normalizeAuthRedirect(
    `${requestUrl.pathname}${requestUrl.search}`,
    DEFAULT_AUTH_REDIRECT
  );

  loginUrl.searchParams.set("next", nextPath);
  return loginUrl;
}

export function buildAuthCallbackUrl(origin: string, nextPath: string): string {
  const callbackUrl = new URL("/auth/callback", origin);
  callbackUrl.searchParams.set("next", normalizeAuthRedirect(nextPath));
  return callbackUrl.toString();
}

export function buildLoginUrlWithError(
  origin: string,
  nextPath: string,
  errorMessage: string
): URL {
  const loginUrl = new URL(LOGIN_PATH, origin);
  loginUrl.searchParams.set("next", normalizeAuthRedirect(nextPath));
  loginUrl.searchParams.set("error_description", errorMessage);
  return loginUrl;
}
