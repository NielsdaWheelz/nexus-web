import { describe, expect, it } from "vitest";
import {
  decodePaneResourceLocator,
  paneResourceLocatorKey,
  resolvePaneResourceLocator,
  resolvePaneRouteShareIdentity,
} from "./paneResourceLocator";
import { resolvePaneRouteModel } from "./paneRouteModel";

const PAGE_ID = "44444444-4444-4444-8444-444444444444";

describe("pane resource identity", () => {
  it("strictly decodes locator variants and gives each identity one key", () => {
    const resourceLocator = {
      kind: "resource_ref" as const,
      ref: `page:${PAGE_ID}`,
    };
    const contributorLocator = {
      kind: "contributor_handle" as const,
      handle: "ursula-le-guin",
    };

    expect(decodePaneResourceLocator(resourceLocator)).toEqual(resourceLocator);
    expect(decodePaneResourceLocator(contributorLocator)).toEqual(
      contributorLocator,
    );
    expect(paneResourceLocatorKey(resourceLocator)).toBe(
      `resource_ref:page:${PAGE_ID}`,
    );
    expect(paneResourceLocatorKey(contributorLocator)).toBe(
      "contributor_handle:ursula-le-guin",
    );
  });

  it.each([
    null,
    {},
    { kind: "resource_ref", ref: `page:${PAGE_ID}`, extra: true },
    { kind: "resource_ref", ref: "not-a-resource-ref" },
    { kind: "contributor_handle", handle: "Ursula Le Guin" },
    { kind: "future_locator", value: PAGE_ID },
  ])("rejects malformed locator wire values: %j", (raw) => {
    expect(() => decodePaneResourceLocator(raw)).toThrow();
  });

  it("withholds identity from a latent daily route but locates its materialized Page", () => {
    const latentDaily = resolvePaneRouteModel("/daily/2099-06-15");
    expect(resolvePaneResourceLocator(latentDaily)).toBeNull();
    expect(
      resolvePaneRouteShareIdentity(latentDaily, latentDaily.defaultLabel),
    ).toBeNull();

    expect(
      resolvePaneResourceLocator(resolvePaneRouteModel(`/pages/${PAGE_ID}`)),
    ).toEqual({ kind: "resource_ref", ref: `page:${PAGE_ID}` });
  });
});
