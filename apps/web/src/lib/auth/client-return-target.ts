import { buildLoginUrl, parseAuthReturnTarget } from "@/lib/auth/redirects";

export function buildLoginUrlForCurrentLocation(): string | null {
  if (typeof window === "undefined" || window.location.pathname === "/login") {
    return null;
  }
  const target = parseAuthReturnTarget(
    `${window.location.pathname}${window.location.search}`
  );
  return buildLoginUrl(window.location.origin, target).toString();
}

export function redirectToLoginForCurrentLocation(): boolean {
  const loginUrl = buildLoginUrlForCurrentLocation();
  if (!loginUrl) {
    return false;
  }
  window.location.assign(loginUrl);
  return true;
}
