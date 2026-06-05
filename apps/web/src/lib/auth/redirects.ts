import { type OAuthProvider } from "@/lib/auth/identities";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

export type AuthReturnTarget = string & {
  readonly __authReturnTarget: unique symbol;
};

export const DEFAULT_AUTH_RETURN_TARGET =
  APP_AUTHENTICATED_HOME_HREF as AuthReturnTarget;

const LOGIN_PATH = "/login";
const AUTH_PATH = "/auth";
const AUTH_PATH_PREFIX = "/auth/";
const AUTH_RETURN_TARGET_BASE = "http://localhost";

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

function isLocalPathStart(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function isBlockedAuthPath(pathname: string): boolean {
  return (
    pathname === LOGIN_PATH ||
    pathname === AUTH_PATH ||
    pathname.startsWith(AUTH_PATH_PREFIX)
  );
}

export function parseAuthReturnTarget(
  rawValue: string | null | undefined
): AuthReturnTarget {
  return parseAuthReturnTargetWithFallback(rawValue, DEFAULT_AUTH_RETURN_TARGET);
}

export function parseAuthReturnTargetWithFallback(
  rawValue: string | null | undefined,
  fallback: AuthReturnTarget
): AuthReturnTarget {
  if (!rawValue) {
    return fallback;
  }

  const trimmed = rawValue.trim();
  if (!isLocalPathStart(trimmed)) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, AUTH_RETURN_TARGET_BASE);
  } catch {
    return fallback;
  }
  if (parsed.origin !== AUTH_RETURN_TARGET_BASE) {
    return fallback;
  }

  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!isLocalPathStart(normalized) || isBlockedAuthPath(parsed.pathname)) {
    return fallback;
  }

  return normalized as AuthReturnTarget;
}

export function authReturnTargetToHref(target: AuthReturnTarget): string {
  return target;
}

export function isDefaultAuthReturnTarget(target: AuthReturnTarget): boolean {
  return target === DEFAULT_AUTH_RETURN_TARGET;
}

function setNonDefaultNext(url: URL, target: AuthReturnTarget): void {
  if (!isDefaultAuthReturnTarget(target)) {
    url.searchParams.set("next", authReturnTargetToHref(target));
  }
}

export function buildLoginUrl(
  origin: string,
  target: AuthReturnTarget,
  options: { mode?: "create"; errorDescription?: string } = {}
): URL {
  const loginUrl = new URL(LOGIN_PATH, origin);
  if (options.mode === "create") {
    loginUrl.searchParams.set("mode", "create");
  }
  setNonDefaultNext(loginUrl, target);
  if (options.errorDescription) {
    loginUrl.searchParams.set("error_description", options.errorDescription);
  }
  return loginUrl;
}

export function buildAuthRefreshUrl(
  origin: string,
  target: AuthReturnTarget
): URL {
  const refreshUrl = new URL("/auth/refresh", origin);
  setNonDefaultNext(refreshUrl, target);
  return refreshUrl;
}

export function buildAuthCallbackUrl(
  redirectOrigin: string,
  target: AuthReturnTarget,
  options?: { flow?: "handoff"; challenge?: string }
): string {
  const callbackUrl = new URL("/auth/callback", redirectOrigin);
  setNonDefaultNext(callbackUrl, target);
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
  target: AuthReturnTarget
): string {
  const deepLink = new URL("nexus://auth/handoff");
  deepLink.searchParams.set("code", code);
  setNonDefaultNext(deepLink, target);
  return deepLink.toString();
}

export function buildAuthHandoffErrorDeepLink(
  errorCode: string,
  target: AuthReturnTarget
): string {
  const deepLink = new URL("nexus://auth/handoff");
  deepLink.searchParams.set("error", errorCode);
  setNonDefaultNext(deepLink, target);
  return deepLink.toString();
}

export function buildAuthStartDeepLink(
  provider: OAuthProvider,
  mode: "signin" | "link",
  target: AuthReturnTarget
): string {
  const deepLink = new URL("nexus://auth/start");
  deepLink.searchParams.set("provider", provider);
  deepLink.searchParams.set("mode", mode);
  setNonDefaultNext(deepLink, target);
  return deepLink.toString();
}

export function buildAuthNativeGoogleDeepLink(
  target: AuthReturnTarget
): string {
  const deepLink = new URL("nexus://auth/native");
  deepLink.searchParams.set("provider", "google");
  setNonDefaultNext(deepLink, target);
  return deepLink.toString();
}

export function buildAuthReturnTargetUrl(
  origin: string,
  target: AuthReturnTarget
): URL {
  return new URL(authReturnTargetToHref(target), origin);
}
