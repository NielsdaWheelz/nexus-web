import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.spyOn(globalThis, "fetch");
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;

describe("POST /api/media/capture/article", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.FASTAPI_BASE_URL = "http://api.local";
  });

  it("rejects requests without an extension bearer token", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost:3000/api/media/capture/article", {
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
            processing_status: "ready_for_reading",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-123",
          },
        }
      )
    );

    const { POST } = await import("./route");
    const body = JSON.stringify({
      url: "https://example.com/article",
      title: "Title",
      byline: "Byline",
      excerpt: "Excerpt",
      site_name: "Example",
      published_time: "2026-04-15T12:00:00Z",
      content_html: "<article>hello</article>",
    });

    const response = await POST(
      new Request("http://localhost:3000/api/media/capture/article", {
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
    expect(String(url)).toBe("http://api.local/media/capture/article");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer extension-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("req-client");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(await response.json()).toEqual({
      data: {
        media_id: "media-123",
        processing_status: "ready_for_reading",
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
