import { describe, expect, it } from "vitest";
import {
  APP_NAVIGATION,
  NAV_ACCOUNT,
  NAV_HOME,
  NAV_MODEL,
} from "@/components/appnav/navModel";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

describe("app navigation model", () => {
  it("makes Lectern the canonical authenticated home", () => {
    expect(APP_NAVIGATION.destinations[0].id).toBe("lectern");
    expect(NAV_HOME.href).toBe(APP_AUTHENTICATED_HOME_HREF);
    expect(APP_AUTHENTICATED_HOME_HREF).toBe("/lectern");
  });

  it("owns one flat, exact destination order for desktop and mobile projections", () => {
    expect(NAV_MODEL.map(({ id }) => id)).toEqual([
      "lectern",
      "libraries",
      "podcasts",
      "chats",
      "notes",
      "atlas",
      "oracle",
    ]);
  });

  it("maps every fixed, home, and account destination to its supported pane section", () => {
    for (const destination of [NAV_HOME, ...NAV_MODEL, NAV_ACCOUNT]) {
      const route = resolvePaneRouteModel(destination.href);
      expect(
        route.id,
        `${destination.id} (${destination.href}) must resolve to a pane route`,
      ).not.toBe("unsupported");
      expect(
        route.definition?.sectionDestinationId,
        `${destination.id} (${destination.href}) must activate its own nav section`,
      ).toBe(destination.id);
    }
  });

  it("owns optional fixed-navigation presentation without changing destination identity", () => {
    expect(NAV_MODEL.filter(({ presentation }) => presentation === "accent")).toEqual([
      expect.objectContaining({ id: "oracle" }),
    ]);
  });
});
