import { describe, expect, it } from "vitest";
import {
  beginNexusDesktopPaneActivation,
  beginNexusDesktopProviders,
  cancelNexusDesktopRun,
  completeNexusDesktopPanePaint,
  completeNexusDesktopProviders,
  NEXUS_DESKTOP_PANE_ACTIVATE,
  NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
} from "./performance";

describe("Nexus desktop performance marks", () => {
  it("records the exact public measure name and cold/warm phase", () => {
    performance.clearMarks();
    performance.clearMeasures();
    beginNexusDesktopProviders("revision-1", "Openables");
    completeNexusDesktopProviders("revision-1", "Cold", "Openables");

    const [measure] = performance.getEntriesByName(
      NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
      "measure",
    );
    expect(measure?.name).toBe(
      "nexus-desktop-providers-first-usable",
    );
    expect((measure as PerformanceMeasure | undefined)?.detail).toEqual({
      phase: "Cold",
      source: "Openables",
    });
  });

  it("records only the first usable provider in a concurrent revision", () => {
    performance.clearMarks();
    performance.clearMeasures();
    beginNexusDesktopProviders("openables-1", "Openables");
    beginNexusDesktopProviders("owned-1", "Owned");

    cancelNexusDesktopRun(
      NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
      "owned-1",
    );
    completeNexusDesktopProviders("owned-1", "Cold", "Owned");
    completeNexusDesktopProviders(
      "openables-1",
      "Warm",
      "Openables",
    );

    const measures = performance.getEntriesByName(
      NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
      "measure",
    );
    expect(measures).toHaveLength(1);
    expect((measures[0] as PerformanceMeasure | undefined)?.detail).toEqual({
      phase: "Warm",
      source: "Openables",
    });
  });

  it("does not let a stale or wrong-pane run complete the current measure", () => {
    performance.clearMarks();
    performance.clearMeasures();
    beginNexusDesktopPaneActivation("first", "notes:/notes");
    beginNexusDesktopPaneActivation("second", "search:/search");

    completeNexusDesktopPanePaint("first", "notes:/notes");
    completeNexusDesktopPanePaint("second", "notes:/notes");
    expect(
      performance.getEntriesByName(NEXUS_DESKTOP_PANE_ACTIVATE, "measure"),
    ).toHaveLength(0);

    completeNexusDesktopPanePaint("second", "search:/search");
    expect(
      performance.getEntriesByName(NEXUS_DESKTOP_PANE_ACTIVATE, "measure"),
    ).toHaveLength(1);
    cancelNexusDesktopRun(NEXUS_DESKTOP_PANE_ACTIVATE, "second");
  });
});
