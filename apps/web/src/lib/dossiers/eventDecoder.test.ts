import { describe, expect, it } from "vitest";
import { decodeDossierStreamEvent } from "@/lib/dossiers/eventDecoder";

describe("Dossier event decoder", () => {
  it("decodes the hard-cut Started shape", () => {
    expect(
      decodeDossierStreamEvent("Started", {
        build_handle: "build-1",
        artifact_ref: "artifact:a1",
      }),
    ).toEqual({
      kind: "Started",
      buildHandle: "build-1",
      artifactRef: "artifact:a1",
    });
  });

  it("rejects extra Started fields", () => {
    expect(() =>
      decodeDossierStreamEvent("Started", {
        build_handle: "build-1",
        artifact_ref: "artifact:a1",
        extra: "drift",
      }),
    ).toThrow("Invalid SSE payload for Started fields");
  });

  it.each([
    ["Progress", { phase: "research", message: "Reading", extra: true }],
    [
      "Succeeded",
      { artifact_revision_ref: "artifact_revision:r1", extra: true },
    ],
    [
      "Failed",
      {
        failure_code: "CitationValidationFailed",
        detail: { kind: "Absent" },
        support: { kind: "Absent" },
        extra: true,
      },
    ],
    [
      "Cancelled",
      {
        actor: { kind: "Absent" },
        at: "2026-07-28T00:00:00Z",
        extra: true,
      },
    ],
    ["ExecutionAdvisory", { phase: "Running", extra: true }],
  ])("rejects extra %s fields", (type, payload) => {
    expect(() => decodeDossierStreamEvent(type, payload)).toThrow(
      `Invalid SSE payload for ${type} fields`,
    );
  });
});
