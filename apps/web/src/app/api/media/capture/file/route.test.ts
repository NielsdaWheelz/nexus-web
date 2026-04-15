import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.spyOn(globalThis, "fetch");
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;

describe("POST /api/media/capture/file", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.FASTAPI_BASE_URL = "http://api.local";
  });

  it("rejects requests without an extension bearer token", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost:3000/api/media/capture/file", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "E_UNAUTHENTICATED",
        message: "Extension token required",
        request_id: expect.any(String),
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards the extension bearer token, metadata headers, and bytes to FastAPI", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            media_id: "media-123",
            idempotency_outcome: "created",
            processing_status: "extracting",
            ingest_enqueued: true,
          },
        }),
        {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-123",
          },
        }
      )
    );

    const { POST } = await import("./route");
    const body = new Uint8Array([37, 80, 68, 70, 45]).buffer;

    const response = await POST(
      new Request("http://localhost:3000/api/media/capture/file", {
        method: "POST",
        headers: {
          authorization: "Bearer extension-token",
          "content-type": "application/pdf",
          "x-request-id": "req-client",
          "x-nexus-filename": "private.pdf",
          "x-nexus-source-url": "https://example.com/private.pdf",
        },
        body,
      })
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(url)).toBe("http://api.local/media/capture/file");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer extension-token");
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(headers.get("x-request-id")).toBe("req-client");
    expect(headers.get("x-nexus-filename")).toBe("private.pdf");
    expect(headers.get("x-nexus-source-url")).toBe("https://example.com/private.pdf");
    expect(Array.from(new Uint8Array(init?.body as ArrayBuffer))).toEqual([37, 80, 68, 70, 45]);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(await response.json()).toEqual({
      data: {
        media_id: "media-123",
        idempotency_outcome: "created",
        processing_status: "extracting",
        ingest_enqueued: true,
      },
    });
  });
});

afterEach(() => {
  if (previousFastApiBaseUrl === undefined) {
    delete process.env.FASTAPI_BASE_URL;
  } else {
    process.env.FASTAPI_BASE_URL = previousFastApiBaseUrl;
  }
});
