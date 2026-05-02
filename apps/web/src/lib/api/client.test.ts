import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./client";

describe("apiFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws an API error for successful non-JSON responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!doctype html><title>Login</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );

    await expect(apiFetch("/api/libraries")).rejects.toMatchObject({
      status: 200,
      code: "E_INVALID_RESPONSE",
      message: "API returned a non-JSON response",
    });
  });

  it("allows successful empty responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch("/api/libraries/library-1")).resolves.toBeUndefined();
  });

  it("preserves structured API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: {
            code: "E_UNAUTHENTICATED",
            message: "Authentication required",
            request_id: "request-1",
          },
        },
        { status: 401 }
      )
    );

    await expect(apiFetch("/api/libraries")).rejects.toEqual(
      new ApiError(401, "E_UNAUTHENTICATED", "Authentication required", "request-1")
    );
  });
});
