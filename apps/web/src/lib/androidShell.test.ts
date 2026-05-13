import { describe, expect, it } from "vitest";
import {
  ANDROID_SHELL_USER_AGENT_TOKEN,
  isAndroidShellRestrictedHref,
  isAndroidShellRestrictedRouteId,
  shouldUseAndroidDebugAuthCallback,
} from "./androidShell";

describe("Android shell detection", () => {
  it("uses the debug auth callback for local Android WebView hosts only", () => {
    expect(
      shouldUseAndroidDebugAuthCallback(
        "http:",
        "10.0.2.2",
        `Mozilla/5.0 ${ANDROID_SHELL_USER_AGENT_TOKEN}`
      )
    ).toBe(true);
    expect(
      shouldUseAndroidDebugAuthCallback(
        "http:",
        "localhost",
        "Mozilla/5.0 (Linux; Android 14; wv)"
      )
    ).toBe(false);
    expect(
      shouldUseAndroidDebugAuthCallback(
        "https:",
        "app.example.com",
        `Mozilla/5.0 ${ANDROID_SHELL_USER_AGENT_TOKEN}`
      )
    ).toBe(false);
  });

  it("identifies product surfaces restricted in the Android shell", () => {
    expect(isAndroidShellRestrictedHref("/settings/billing")).toBe(false);
    expect(isAndroidShellRestrictedHref("/settings/local-vault")).toBe(true);
    expect(isAndroidShellRestrictedHref("/settings/identities")).toBe(false);
    expect(isAndroidShellRestrictedRouteId("settingsBilling")).toBe(false);
    expect(isAndroidShellRestrictedRouteId("settingsLocalVault")).toBe(true);
    expect(isAndroidShellRestrictedRouteId("settingsIdentities")).toBe(false);
  });
});
