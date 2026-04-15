import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.spyOn(globalThis, "fetch");
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;

describe("POST /api/media/capture/url", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.FASTAPI_BASE_URL = "http://api.local";
  });

  it("rejects requests without an extension bearer token", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost:3000/api/media/capture/url", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com" }),
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

  it("forwards the extension bearer token and JSON body to FastAPI", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            media_id: "media-123",
            idempotency_outcome: "created",
            processing_status: "pending",
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
    const body = JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

    const response = await POST(
      new Request("http://localhost:3000/api/media/capture/url", {
        method: "POST",
        headers: {
          authorization: "Bearer extension-token",
          "content-type": "application/json",
          "x-request-id": "req-client",
        },
        body,
      })
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(url)).toBe("http://api.local/media/capture/url");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer extension-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("req-client");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(await response.json()).toEqual({
      data: {
        media_id: "media-123",
        idempotency_outcome: "created",
        processing_status: "pending",
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
