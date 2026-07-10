import { describe, expect, it } from "vitest";
import { standingHeadForRoute } from "@/lib/navigation/standingHead";
import { PANE_ROUTE_MODELS } from "@/lib/panes/paneRouteModel";

describe("standingHeadForRoute", () => {
  it("resolves every pane route to a non-empty natural-case section label", () => {
    for (const model of PANE_ROUTE_MODELS) {
      const label = standingHeadForRoute(model.id);
      expect(label.length).toBeGreaterThan(0);
      // Natural-case (casing is CSS's job) — the label carries a lowercase letter.
      expect(label).toMatch(/[a-z]/);
    }
  });

  it("maps index, detail, and reader routes to their parent section", () => {
    expect(standingHeadForRoute("lectern")).toBe("Lectern");
    expect(standingHeadForRoute("libraries")).toBe("Libraries");
    expect(standingHeadForRoute("library")).toBe("Libraries");
    expect(standingHeadForRoute("media")).toBe("Libraries");
    expect(standingHeadForRoute("authors")).toBe("Authors");
    expect(standingHeadForRoute("author")).toBe("Authors");
    expect(standingHeadForRoute("podcasts")).toBe("Podcasts");
    expect(standingHeadForRoute("podcastDetail")).toBe("Podcasts");
    expect(standingHeadForRoute("notes")).toBe("Notes");
    expect(standingHeadForRoute("page")).toBe("Notes");
    expect(standingHeadForRoute("note")).toBe("Notes");
    expect(standingHeadForRoute("conversations")).toBe("Chats");
    expect(standingHeadForRoute("conversationNew")).toBe("Chats");
    expect(standingHeadForRoute("conversation")).toBe("Chats");
    expect(standingHeadForRoute("search")).toBe("Search");
    expect(standingHeadForRoute("settings")).toBe("Settings");
    expect(standingHeadForRoute("settingsBilling")).toBe("Settings");
    expect(standingHeadForRoute("settingsKeybindings")).toBe("Settings");
    expect(standingHeadForRoute("atlas")).toBe("Atlas");
    expect(standingHeadForRoute("oracle")).toBe("Oracle");
    expect(standingHeadForRoute("oracleReading")).toBe("Oracle");
  });
});
