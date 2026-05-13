import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.spyOn(globalThis, "fetch");
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;

describe("DELETE /api/extension/session", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.FASTAPI_BASE_URL = "http://api.local";
  });

  it("rejects requests without an extension bearer token", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new Request("http://localhost:3000/api/extension/session", {
        method: "DELETE",
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

  it("forwards the extension bearer token to FastAPI", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: {
          "x-request-id": "req-123",
        },
      })
    );

    const { DELETE } = await import("./route");
    const response = await DELETE(
      new Request("http://localhost:3000/api/extension/session", {
        method: "DELETE",
        headers: {
          authorization: "Bearer extension-token",
          "x-request-id": "req-client",
        },
      })
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(init?.method).toBe("DELETE");

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer extension-token");
    expect(headers.get("x-request-id")).toBe("req-client");

    expect(response.status).toBe(204);
    expect(response.headers.get("x-request-id")).toBe("req-123");
  });
});

afterEach(() => {
  if (previousFastApiBaseUrl === undefined) {
    delete process.env.FASTAPI_BASE_URL;
  } else {
    process.env.FASTAPI_BASE_URL = previousFastApiBaseUrl;
  }
});
