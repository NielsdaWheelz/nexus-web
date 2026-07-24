import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  apiKeepaliveJson,
  apiPostFormData,
  isSameSystemApiDefect,
} from "./client";

describe("same-system API defects", () => {
  it("classifies owned response and internal failures by code, not status", () => {
    for (const [status, code] of [
      [200, "E_INVALID_RESPONSE"],
      [502, "E_UNKNOWN"],
      [500, "E_INTERNAL"],
    ] as const) {
      expect(isSameSystemApiDefect(new ApiError(status, code, code))).toBe(
        true,
      );
    }
    expect(
      isSameSystemApiDefect(new ApiError(502, "E_UPSTREAM", "Unavailable")),
    ).toBe(false);
  });
});

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
      }),
    );

    await expect(apiFetch("/api/libraries")).rejects.toMatchObject({
      status: 200,
      code: "E_INVALID_RESPONSE",
      message: "API returned a non-JSON response",
    });
  });

  it("allows successful empty responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

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
        { status: 401 },
      ),
    );

    await expect(apiFetch("/api/libraries")).rejects.toEqual(
      new ApiError(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required",
        "request-1",
      ),
    );
  });

  it("coalesces concurrent identical GET requests while they are in flight", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = apiFetch<{ data: string }>("/api/libraries/library-1");
    const second = apiFetch<{ data: string }>("/api/libraries/library-1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch?.(Response.json({ data: "ok" }));

    await expect(first).resolves.toEqual({ data: "ok" });
    await expect(second).resolves.toEqual({ data: "ok" });
  });

  it("does not keep completed GET responses as a cache", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: "first" }))
      .mockResolvedValueOnce(Response.json({ data: "second" }));

    await expect(apiFetch<{ data: string }>("/api/libraries")).resolves.toEqual(
      {
        data: "first",
      },
    );
    await expect(apiFetch<{ data: string }>("/api/libraries")).resolves.toEqual(
      {
        data: "second",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce state-changing requests", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: { id: "library-1" } }))
      .mockResolvedValueOnce(Response.json({ data: { id: "library-1" } }));

    await Promise.all([
      apiFetch("/api/libraries", {
        method: "POST",
        body: JSON.stringify({ name: "A" }),
      }),
      apiFetch("/api/libraries", {
        method: "POST",
        body: JSON.stringify({ name: "A" }),
      }),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce GET requests with custom fetch behavior", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: "ok" }))
      .mockResolvedValueOnce(Response.json({ data: "ok" }));

    await Promise.all([
      apiFetch("/api/libraries", { cache: "reload" }),
      apiFetch("/api/libraries", { cache: "reload" }),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent no-store GET requests while they are in flight", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = apiFetch<{ data: string }>("/api/libraries", {
      cache: "no-store",
    });
    const second = apiFetch<{ data: string }>("/api/libraries", {
      cache: "no-store",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch?.(Response.json({ data: "ok" }));

    await expect(first).resolves.toEqual({ data: "ok" });
    await expect(second).resolves.toEqual({ data: "ok" });
  });

  it("does not coalesce signaled GET requests", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: "ok" }))
      .mockResolvedValueOnce(Response.json({ data: "ok" }));

    await Promise.all([
      apiFetch("/api/libraries", { signal: new AbortController().signal }),
      apiFetch("/api/libraries", { signal: new AbortController().signal }),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws unauthenticated API errors without navigating", async () => {
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
        { status: 401 },
      ),
    );

    await expect(apiFetch("/api/libraries")).rejects.toEqual(
      new ApiError(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required",
        "request-1",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("posts form data without overriding multipart headers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ data: { imported: 1 } }, { status: 200 }),
      );
    const formData = new FormData();
    formData.append("file", new Blob(["opml"]), "feeds.opml");

    await expect(
      apiPostFormData<{ data: { imported: number } }>(
        "/api/podcasts/import/opml",
        formData,
      ),
    ).resolves.toEqual({ data: { imported: 1 } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/podcasts/import/opml", {
      method: "POST",
      body: formData,
    });
  });

  it("sends keepalive JSON through the shared API helper", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      apiKeepaliveJson("/api/test/keepalive", { value: "example" }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith("/api/test/keepalive", {
      method: "PUT",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "example" }),
    });
  });
});
