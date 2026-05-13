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
  return href === "/settings/local-vault";
}

export function isAndroidShellRestrictedRouteId(routeId: string): boolean {
  return routeId === "settingsLocalVault";
}

export function shouldUseAndroidDebugAuthCallback(
  protocol: string,
  hostname: string,
  userAgent: string
): boolean {
  return (
    protocol === "http:" &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "10.0.2.2") &&
    isAndroidShellUserAgent(userAgent)
  );
}
