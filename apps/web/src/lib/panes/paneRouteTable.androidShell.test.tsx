import { afterEach, describe, expect, it } from "vitest";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";
import { resolvePaneRoute } from "./paneRouteTable";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

describe("pane route table android shell chrome", () => {
  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
  });

  it("keeps billing normal and marks local vault as restricted", () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);

    expect(
      resolvePaneRoute("/settings/billing").definition?.getChrome?.({
        href: "/settings/billing",
        params: {},
      })
    ).toMatchObject({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    });
    expect(
      resolvePaneRoute("/settings/local-vault").definition?.getChrome?.({
        href: "/settings/local-vault",
        params: {},
      })
    ).toMatchObject({
      title: "Local Vault",
      subtitle:
        "Not available in the Android app. Use a supported desktop browser for Local Vault.",
    });
  });
});
