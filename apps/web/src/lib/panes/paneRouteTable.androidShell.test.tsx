import { describe, expect, it } from "vitest";
import { resolvePaneRoute } from "./paneRouteTable";

describe("pane route table android shell chrome", () => {
  it("resolves stable chrome titles regardless of shell", () => {
    // The android-shell restriction is enforced in the pane body itself; the
    // chrome header no longer carries a per-shell subtitle description.
    expect(
      resolvePaneRoute("/settings/billing").definition?.getChrome?.({
        href: "/settings/billing",
        params: {},
        androidShell: true,
      })
    ).toMatchObject({ title: "Billing" });
    expect(
      resolvePaneRoute("/settings/local-vault").definition?.getChrome?.({
        href: "/settings/local-vault",
        params: {},
        androidShell: true,
      })
    ).toMatchObject({ title: "Local Vault" });
  });
});
