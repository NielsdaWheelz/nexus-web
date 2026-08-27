import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/client";
import {
  cancelDossierBuild,
  createDossierBuild,
  learnDossierFromHighlight,
  makeDossierRevisionCurrent,
  openDossierBuildStream,
} from "@/lib/dossiers/generationAdapter";
import {
  decodeDossierStreamEvent,
  isTerminalDossierStreamEvent,
  type DossierStreamEvent,
} from "@/lib/dossiers/eventDecoder";

const ARTIFACT_REF = "artifact:11111111-1111-4111-8111-111111111111";
const REVISION_REF = "artifact-revision:22222222-2222-4222-8222-222222222222";

function invalidResponse(): ApiError {
  return expect.objectContaining({
    name: "ApiError",
    code: "E_INVALID_RESPONSE",
  }) as ApiError;
}

describe("Dossier transport boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only the exact success envelope for Learn outcomes", async () => {
    const canonical = {
      data: { kind: "Opened", artifact_ref: ARTIFACT_REF },
    };
    const responses: unknown[] = [
      canonical,
      canonical.data,
      { ...canonical, compatibility: true },
      { data: { ...canonical.data, extra: true } },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(responses.shift())),
    );

    await expect(
      learnDossierFromHighlight({
        highlightRef: "highlight:33333333-3333-4333-8333-333333333333",
        idempotencyKey: "learn-contract",
      }),
    ).resolves.toEqual({ kind: "Opened", artifactRef: ARTIFACT_REF });

    for (const idempotencyKey of ["direct", "extra-envelope", "extra-data"]) {
      await expect(
        learnDossierFromHighlight({
          highlightRef: "highlight:33333333-3333-4333-8333-333333333333",
          idempotencyKey,
        }),
      ).rejects.toEqual(invalidResponse());
    }
  });

  it("validates the accepted-build response instead of discarding its shape", async () => {
    const created = {
      artifact_ref: ARTIFACT_REF,
      build_handle: "build-contract",
      created: true,
    };
    const responses: unknown[] = [{ data: created }, created];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(responses.shift(), { status: 202 })),
    );

    const request = {
      target: {
        kind: "Subject" as const,
        subject: { scheme: "media", handle: "media-contract" },
      },
      artifactRef: null,
      instruction: null,
      idempotencyKey: "build-contract",
    };
    await expect(createDossierBuild(request)).resolves.toBeUndefined();
    await expect(createDossierBuild(request)).rejects.toEqual(invalidResponse());
  });

  it.each([
    ["cancel", () => cancelDossierBuild("build-contract")],
    ["make current", () => makeDossierRevisionCurrent(REVISION_REF)],
  ])("requires HTTP 204 for the %s command", async (_name, command) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 200 })));
    await expect(command()).rejects.toEqual(invalidResponse());
  });

  it("opens an encoded Artifact-build stream through the generation transport", async () => {
    const buildHandle = "build/with reserved?characters";
    const streamUrl =
      `https://stream.nexus.test/stream/artifact-builds/` +
      `${encodeURIComponent(buildHandle)}/events`;
    const events: DossierStreamEvent[] = [];
    let completeStream: ((terminalEventSeen: boolean) => void) | null = null;
    let failStream: ((error: Error) => void) | null = null;
    const completion = new Promise<boolean>((resolve, reject) => {
      completeStream = resolve;
      failStream = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/stream-token") {
          expect(init?.method).toBe("POST");
          return Response.json({
            data: {
              token: "dossier-stream-token",
              stream_base_url: "https://stream.nexus.test",
              expires_at: "2026-08-25T10:00:00Z",
            },
          });
        }
        expect(url).toBe(streamUrl);
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer dossier-stream-token",
        );
        return new Response(
          `id: 1\nevent: Succeeded\ndata: ${JSON.stringify({ artifact_revision_ref: REVISION_REF })}\n\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      }),
    );

    const stop = await openDossierBuildStream(buildHandle, {
      decode: decodeDossierStreamEvent,
      isTerminal: isTerminalDossierStreamEvent,
      onEvent: (event) => events.push(event),
      onError: (error) => failStream?.(error),
      onComplete: (terminalEventSeen) => completeStream?.(terminalEventSeen),
    });

    await expect(completion).resolves.toBe(true);
    expect(events).toEqual([
      { kind: "Succeeded", artifactRevisionRef: REVISION_REF },
    ]);
    stop();
  });
});
