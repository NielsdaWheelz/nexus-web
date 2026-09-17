type AccountSignOutOwner = "WebPost" | "Native" | "Unavailable";

export function accountSignOutOwner(
  androidShell: boolean,
  readingCapability: "Unavailable" | "Connecting" | "Ready",
): AccountSignOutOwner {
  if (!androidShell) return "WebPost";
  if (readingCapability === "Ready") return "Native";
  // An Android bridge that is absent, still connecting, or failed cannot prove
  // that native reading/audio state was purged. Never fall through to the web
  // POST merely because capability detection has not completed.
  return "Unavailable";
}
