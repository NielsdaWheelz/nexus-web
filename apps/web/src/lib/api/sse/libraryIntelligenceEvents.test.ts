import { describe, expect, it } from "vitest";
import { toLibraryIntelligenceEvent } from "./libraryIntelligenceEvents";

describe("toLibraryIntelligenceEvent", () => {
  it("parses meta events", () => {
    expect(
      toLibraryIntelligenceEvent("meta", {
        revision_id: "rev-1",
        library_id: "lib-1",
      }),
    ).toEqual({
      type: "meta",
      data: { revision_id: "rev-1", library_id: "lib-1" },
    });
  });

  it("parses progress events with and without a stage", () => {
    expect(
      toLibraryIntelligenceEvent("progress", { message: "Reducing sources" }),
    ).toEqual({
      type: "progress",
      data: { message: "Reducing sources", stage: null },
    });
    expect(
      toLibraryIntelligenceEvent("progress", {
        message: "Reducing sources",
        stage: "reduce",
      }),
    ).toEqual({
      type: "progress",
      data: { message: "Reducing sources", stage: "reduce" },
    });
  });

  it("parses a successful done event", () => {
    expect(
      toLibraryIntelligenceEvent("done", { revision_id: "rev-1" }),
    ).toEqual({
      type: "done",
      data: { revision_id: "rev-1", error: null },
    });
  });

  it("parses a failed done event", () => {
    expect(toLibraryIntelligenceEvent("done", { error: "E_INTERNAL" })).toEqual({
      type: "done",
      data: { revision_id: null, error: "E_INTERNAL" },
    });
  });

  it("throws on a malformed meta payload", () => {
    expect(() =>
      toLibraryIntelligenceEvent("meta", { revision_id: "rev-1" }),
    ).toThrow("Invalid SSE payload for meta");
  });

  it("throws on a malformed progress payload", () => {
    expect(() =>
      toLibraryIntelligenceEvent("progress", { message: 42 }),
    ).toThrow("Invalid SSE payload for progress");
  });

  it("throws on a malformed done payload", () => {
    expect(() =>
      toLibraryIntelligenceEvent("done", { revision_id: 7 }),
    ).toThrow("Invalid SSE payload for done");
  });

  it("throws on an unknown event type", () => {
    expect(() => toLibraryIntelligenceEvent("bogus", {})).toThrow(
      "Unknown SSE event type: bogus",
    );
  });
});
