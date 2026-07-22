import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSourceUrl } from "./sourceUrlCapture";

describe("captureSourceUrl defect boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rethrows same-system defects independent of HTTP status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(500, "E_INTERNAL"),
    );

    await expect(
      captureSourceUrl({ url: "https://example.com/internal", libraryIds: [] }),
    ).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("keeps an approved upstream failure as modeled capture feedback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(502, "E_UPSTREAM"),
    );

    await expect(
      captureSourceUrl({ url: "https://example.com/upstream", libraryIds: [] }),
    ).resolves.toMatchObject({
      ok: false,
      feedback: { severity: "error" },
    });
  });
});

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: code, request_id: `req-${code}` } },
    { status },
  );
}
