import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, apiPostFormData } from "./client";

describe("apiFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      new ApiError(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required",
        "request-1"
      )
    );
  });

  it("redirects browser callers to login on unauthenticated API responses", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: {
        assign,
        origin: "http://localhost:3000",
        pathname: "/libraries",
        search: "?view=mine",
      },
    });
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
      new ApiError(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required",
        "request-1"
      )
    );
    expect(assign).toHaveBeenCalledWith(
      "http://localhost:3000/login?next=%2Flibraries%3Fview%3Dmine"
    );
  });

  it("posts form data without overriding multipart headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { imported: 1 } }, { status: 200 })
    );
    const formData = new FormData();
    formData.append("file", new Blob(["opml"]), "feeds.opml");

    await expect(
      apiPostFormData<{ data: { imported: number } }>("/api/podcasts/import/opml", formData)
    ).resolves.toEqual({ data: { imported: 1 } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/podcasts/import/opml", {
      method: "POST",
      body: formData,
    });
  });
});
