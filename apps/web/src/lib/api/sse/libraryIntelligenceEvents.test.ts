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
      toLibraryIntelligenceEvent("done", {
        status: "ready",
        error_code: null,
        revision_id: "rev-1",
      }),
    ).toEqual({
      type: "done",
      data: { status: "ready", error_code: null, revision_id: "rev-1" },
    });
  });

  it("parses a failed done event", () => {
    expect(
      toLibraryIntelligenceEvent("done", {
        status: "failed",
        error_code: "E_INTERNAL",
        revision_id: "rev-1",
      }),
    ).toEqual({
      type: "done",
      data: { status: "failed", error_code: "E_INTERNAL", revision_id: "rev-1" },
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

  it("throws on a malformed done payload (missing status)", () => {
    expect(() =>
      toLibraryIntelligenceEvent("done", {
        error_code: null,
        revision_id: "rev-1",
      }),
    ).toThrow("Invalid SSE payload for done");
  });

  it("throws on an unknown event type", () => {
    expect(() => toLibraryIntelligenceEvent("bogus", {})).toThrow(
      "Unknown SSE event type: bogus",
    );
  });
});
