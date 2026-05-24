import { type OAuthProvider } from "@/lib/auth/identities";

export const DEFAULT_AUTH_REDIRECT = "/libraries";

const LOGIN_PATH = "/login";
const AUTH_PATH_PREFIX = "/auth/";

type AuthSearchParam = string | string[] | undefined;

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

export function buildAuthCallbackUrl(
  redirectOrigin: string,
  nextPath: string,
  options?: { flow?: "handoff"; challenge?: string }
): string {
  const callbackUrl = new URL("/auth/callback", redirectOrigin);
  callbackUrl.searchParams.set("next", normalizeAuthRedirect(nextPath));
  if (options?.flow === "handoff") {
    callbackUrl.searchParams.set("flow", "handoff");
  }
  if (options?.challenge) {
    callbackUrl.searchParams.set("hc", options.challenge);
  }
  return callbackUrl.toString();
}

export function buildAuthHandoffSuccessDeepLink(
  code: string,
  nextPath: string
): string {
  const deepLink = new URL("nexus://auth/handoff");
  deepLink.searchParams.set("code", code);
  deepLink.searchParams.set("next", normalizeAuthRedirect(nextPath));
  return deepLink.toString();
}

export function buildAuthHandoffErrorDeepLink(
  errorCode: string,
  nextPath: string
): string {
  const deepLink = new URL("nexus://auth/handoff");
  deepLink.searchParams.set("error", errorCode);
  deepLink.searchParams.set("next", normalizeAuthRedirect(nextPath));
  return deepLink.toString();
}

export function buildAuthStartDeepLink(
  provider: OAuthProvider,
  mode: "signin" | "link",
  nextPath: string
): string {
  const deepLink = new URL("nexus://auth/start");
  deepLink.searchParams.set("provider", provider);
  deepLink.searchParams.set("mode", mode);
  deepLink.searchParams.set("next", normalizeAuthRedirect(nextPath));
  return deepLink.toString();
}

export function buildAuthNativeGoogleDeepLink(nextPath: string): string {
  const deepLink = new URL("nexus://auth/native");
  deepLink.searchParams.set("provider", "google");
  deepLink.searchParams.set("next", normalizeAuthRedirect(nextPath));
  return deepLink.toString();
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
