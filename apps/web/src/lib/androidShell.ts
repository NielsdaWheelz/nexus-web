export const ANDROID_SHELL_USER_AGENT_TOKEN = "NexusAndroidShell";

/** Delivery policy only; this marker grants no remote or account authority. */
export const androidShellDocument = typeof navigator !== "undefined" && isAndroidShellUserAgent(navigator.userAgent);

export function isAndroidShellUserAgent(userAgent: string): boolean {
  return userAgent.includes(ANDROID_SHELL_USER_AGENT_TOKEN);
}
