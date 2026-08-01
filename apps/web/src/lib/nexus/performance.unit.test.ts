import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginNexusPerformance,
  cancelNexusPerformance,
  completeNexusPerformance,
  markNexusPerformanceDecoded,
  NEXUS_LOCAL_FIND_PERFORMANCE,
  NEXUS_OPENABLES_PERFORMANCE,
  NEXUS_PANE_ACTIVATE_PERFORMANCE,
} from "./performance";

beforeEach(() => {
  vi.stubGlobal("window", { performance });
});

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
  vi.unstubAllGlobals();
});

describe("Nexus performance lifecycle", () => {
  it("records only the current run for a measure", () => {
    const stale = beginNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
    const current = beginNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);

    completeNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE, stale);
    expect(
      performance.getEntriesByName("nexus-local-find", "measure"),
    ).toHaveLength(0);

    completeNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE, current);
    expect(
      performance.getEntriesByName("nexus-local-find", "measure"),
    ).toHaveLength(1);
  });

  it("waits for decoded Openables before measuring committed results", () => {
    const run = beginNexusPerformance(NEXUS_OPENABLES_PERFORMANCE);

    completeNexusPerformance(NEXUS_OPENABLES_PERFORMANCE, run);
    expect(
      performance.getEntriesByName("nexus-openables", "measure"),
    ).toHaveLength(0);

    markNexusPerformanceDecoded(NEXUS_OPENABLES_PERFORMANCE, run);
    completeNexusPerformance(NEXUS_OPENABLES_PERFORMANCE, run);
    expect(
      performance.getEntriesByName("nexus-openables", "measure"),
    ).toHaveLength(1);
  });

  it("requires a pane identity and cancels rejected activation", () => {
    expect(beginNexusPerformance(NEXUS_PANE_ACTIVATE_PERFORMANCE)).toBeNull();
    const run = beginNexusPerformance(NEXUS_PANE_ACTIVATE_PERFORMANCE, {
      targetId: "notes:/notes",
    });
    expect(run).not.toBeNull();

    cancelNexusPerformance(NEXUS_PANE_ACTIVATE_PERFORMANCE, run);
    completeNexusPerformance(NEXUS_PANE_ACTIVATE_PERFORMANCE, run);
    expect(
      performance.getEntriesByName("nexus-pane-activate", "measure"),
    ).toHaveLength(0);
  });
});
