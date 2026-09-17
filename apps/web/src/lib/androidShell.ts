export const ANDROID_SHELL_USER_AGENT_TOKEN = "NexusAndroidShell";

export function isAndroidShellUserAgent(userAgent: string): boolean {
  return userAgent.includes(ANDROID_SHELL_USER_AGENT_TOKEN);
}

export function isAndroidShellRestrictedRouteId(routeId: string): boolean {
  return routeId === "settingsLocalVault";
}
