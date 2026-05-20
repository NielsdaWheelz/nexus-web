export const ANDROID_SHELL_USER_AGENT_TOKEN = "NexusAndroidShell";

export function isAndroidShellUserAgent(userAgent: string): boolean {
  return userAgent.includes(ANDROID_SHELL_USER_AGENT_TOKEN);
}

export function isAndroidShell(): boolean {
  return (
    typeof navigator !== "undefined" &&
    isAndroidShellUserAgent(navigator.userAgent)
  );
}

export function isAndroidShellRestrictedHref(href: string): boolean {
  try {
    const baseOrigin =
      typeof window === "undefined" ? "https://nexus.local" : window.location.origin;
    const url = new URL(href, baseOrigin);
    if (url.origin !== baseOrigin) {
      return false;
    }
    const pathname =
      url.pathname === "/" ? url.pathname : url.pathname.replace(/\/+$/, "");
    return pathname === "/settings/local-vault";
  } catch {
    return false;
  }
}

export function isAndroidShellRestrictedRouteId(routeId: string): boolean {
  return routeId === "settingsLocalVault";
}
