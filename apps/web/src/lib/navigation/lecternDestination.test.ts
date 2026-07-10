import { describe, expect, it } from "vitest";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { PANE_ROUTE_MODELS } from "@/lib/panes/paneRouteModel";

describe("Lectern destination", () => {
  it("has a primary nav slot (AC-8)", () => {
    const dest = DESTINATIONS.find((d) => d.id === "lectern");
    expect(dest?.slot).toBe("primary");
    expect(dest?.href).toBe("/lectern");
  });

  it("is ordered before Libraries for mobile-first nav", () => {
    const ids = DESTINATIONS.map((d) => d.id);
    expect(ids.indexOf("lectern")).toBeLessThan(ids.indexOf("libraries"));
  });

  it("is a resolvable pane route", () => {
    expect(PANE_ROUTE_MODELS.some((model) => model.id === "lectern")).toBe(true);
  });
});
