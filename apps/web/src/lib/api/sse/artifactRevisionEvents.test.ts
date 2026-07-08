import { describe, expect, it } from "vitest";
import { toArtifactRevisionEvent } from "./artifactRevisionEvents";

describe("toArtifactRevisionEvent", () => {
  it("parses meta events with subject fields", () => {
    expect(
      toArtifactRevisionEvent("meta", {
        revision_id: "rev-1",
        subject_scheme: "conversation",
        subject_id: "conv-1",
      }),
    ).toEqual({
      type: "meta",
      data: {
        revision_id: "rev-1",
        subject_scheme: "conversation",
        subject_id: "conv-1",
      },
    });
  });

  it("parses a meta event with only a revision id", () => {
    expect(toArtifactRevisionEvent("meta", { revision_id: "rev-1" })).toEqual({
      type: "meta",
      data: { revision_id: "rev-1", subject_scheme: null, subject_id: null },
    });
  });

  it("parses progress events with and without a stage", () => {
    expect(
      toArtifactRevisionEvent("progress", { message: "Reducing sources" }),
    ).toEqual({
      type: "progress",
      data: { message: "Reducing sources", stage: null },
    });
    expect(
      toArtifactRevisionEvent("progress", {
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
      toArtifactRevisionEvent("done", {
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
      toArtifactRevisionEvent("done", {
        status: "failed",
        error_code: "E_INTERNAL",
        revision_id: "rev-1",
      }),
    ).toEqual({
      type: "done",
      data: { status: "failed", error_code: "E_INTERNAL", revision_id: "rev-1" },
    });
  });

  it("throws on a malformed meta payload (missing revision_id)", () => {
    expect(() =>
      toArtifactRevisionEvent("meta", { subject_scheme: "conversation" }),
    ).toThrow("Invalid SSE payload for meta");
  });

  it("throws on a malformed progress payload", () => {
    expect(() =>
      toArtifactRevisionEvent("progress", { message: 42 }),
    ).toThrow("Invalid SSE payload for progress");
  });

  it("throws on a malformed done payload (missing status)", () => {
    expect(() =>
      toArtifactRevisionEvent("done", {
        error_code: null,
        revision_id: "rev-1",
      }),
    ).toThrow("Invalid SSE payload for done");
  });

  it("throws on an unknown event type", () => {
    expect(() => toArtifactRevisionEvent("bogus", {})).toThrow(
      "Unknown SSE event type: bogus",
    );
  });
});
