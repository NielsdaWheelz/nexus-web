import { describe, expect, it } from "vitest";
import { resolvePaneRoute } from "./paneRouteTable";

describe("pane route table android shell chrome", () => {
  it("keeps billing normal and marks local vault as restricted", () => {
    expect(
      resolvePaneRoute("/settings/billing").definition?.getChrome?.({
        href: "/settings/billing",
        params: {},
        androidShell: true,
      })
    ).toMatchObject({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    });
    expect(
      resolvePaneRoute("/settings/local-vault").definition?.getChrome?.({
        href: "/settings/local-vault",
        params: {},
        androidShell: true,
      })
    ).toMatchObject({
      title: "Local Vault",
      subtitle:
        "Not available in the Android app. Use a supported desktop browser for Local Vault.",
    });
  });
});
