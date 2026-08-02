import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSourceUrl } from "./sourceUrlCapture";

describe("captureSourceUrl defect boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rethrows same-system defects independent of HTTP status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(500, "E_INTERNAL"),
    );

    await expect(
      captureSourceUrl({
        url: "https://example.com/internal",
        libraryIds: [],
        operation: "SaveSource",
      }),
    ).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("keeps an approved upstream failure as modeled capture feedback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(502, "E_UPSTREAM"),
    );

    await expect(
      captureSourceUrl({
        url: "https://example.com/upstream",
        libraryIds: [],
        operation: "SaveSource",
      }),
    ).resolves.toMatchObject({
      ok: false,
      feedback: { tone: "Danger", requestId: "req-E_UPSTREAM" },
    });
  });

  it.each([
    "E_BAD_REQUEST",
    "E_X_PROVIDER_UNAVAILABLE",
    "E_X_PROVIDER_CREDITS_DEPLETED",
    "E_X_PROVIDER_AUTH_REJECTED",
    "E_X_PROVIDER_RATE_LIMITED",
    "E_X_PROVIDER_TIMEOUT",
  ])("keeps endpoint-owned %s as modeled capture feedback", async (code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(503, code));

    await expect(
      captureSourceUrl({
        url: "https://x.com/nexus/status/1",
        libraryIds: [],
        operation: "SaveSource",
      }),
    ).resolves.toMatchObject({
      ok: false,
      feedback: { tone: "Danger", requestId: `req-${code}` },
    });
  });

  it("defects on an unknown capture error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(500, "E_INVENTED"),
    );

    await expect(
      captureSourceUrl({
        url: "https://example.com/unknown",
        libraryIds: [],
        operation: "SaveSource",
      }),
    ).rejects.toMatchObject({ code: "E_INVENTED" });
  });
});

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: code, request_id: `req-${code}` } },
    { status },
  );
}
