import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDossierBuild,
  learnDossierFromHighlight,
} from "@/lib/dossiers/generationAdapter";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dossier generation adapter", () => {
  it("decodes Learn and preserves the caller-owned replay key", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        kind: "BuildAccepted",
        artifact_ref: "artifact:a1",
        build_handle: "build-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      learnDossierFromHighlight({
        highlightRef: "highlight:h1",
        idempotencyKey: "learn-1",
      }),
    ).resolves.toEqual({
      kind: "BuildAccepted",
      artifactRef: "artifact:a1",
      buildHandle: "build-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/artifacts/dossiers/learn",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "learn-1" }),
        body: JSON.stringify({ highlight_ref: "highlight:h1" }),
      }),
    );
  });

  it("uses the by-ref build route for regeneration", async () => {
    const fetchMock = vi.fn(async () => response({}));
    vi.stubGlobal("fetch", fetchMock);

    await createDossierBuild({
      target: { kind: "Artifact", artifactRef: "artifact:a1" },
      artifactRef: "artifact:a1",
      instruction: "  Focus on examples.  ",
      idempotencyKey: "regen-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/artifacts/artifact%3Aa1/builds",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": "regen-1" }),
      }),
    );
  });

  it("fails closed on an unknown Learn response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ kind: "Building" })));
    await expect(
      learnDossierFromHighlight({
        highlightRef: "highlight:h1",
        idempotencyKey: "learn-1",
      }),
    ).rejects.toThrow("Invalid Learn Dossier response");
  });
});
