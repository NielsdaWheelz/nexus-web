import { describe, expect, it } from "vitest";
import {
  resolvePaneResourceLocator,
  resolvePaneRouteShareIdentity,
} from "./paneResourceLocator";
import { resolvePaneRouteModel } from "./paneRouteModel";

const PAGE_ID = "44444444-4444-4444-8444-444444444444";

describe("pane resource identity", () => {
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
