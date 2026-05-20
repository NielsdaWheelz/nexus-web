import { describe, expect, it } from "vitest";
import {
  isAndroidShellRestrictedHref,
  isAndroidShellRestrictedRouteId,
} from "./androidShell";

describe("Android shell detection", () => {
  it("identifies product surfaces restricted in the Android shell", () => {
    expect(isAndroidShellRestrictedHref("/settings/billing")).toBe(false);
    expect(isAndroidShellRestrictedHref("/settings/local-vault")).toBe(true);
    expect(isAndroidShellRestrictedHref("/settings/local-vault/")).toBe(true);
    expect(isAndroidShellRestrictedHref("/settings/local-vault?source=palette")).toBe(true);
    expect(isAndroidShellRestrictedHref("/settings/local-vault#sync")).toBe(true);
    expect(isAndroidShellRestrictedHref("https://nexus.local/settings/local-vault")).toBe(true);
    expect(isAndroidShellRestrictedHref("https://example.com/settings/local-vault")).toBe(false);
    expect(isAndroidShellRestrictedHref("/settings/identities")).toBe(false);
    expect(isAndroidShellRestrictedRouteId("settingsBilling")).toBe(false);
    expect(isAndroidShellRestrictedRouteId("settingsLocalVault")).toBe(true);
    expect(isAndroidShellRestrictedRouteId("settingsIdentities")).toBe(false);
  });
});
