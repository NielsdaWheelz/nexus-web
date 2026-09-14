import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiErrorFromResponse, apiFetch, isSameSystemApiDefect } from "./client";
import { READ_RETRY_BUDGET_MS, requestWithRetry } from "./retryPolicy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gateway failures at the browser boundary", () => {
  it.each([502, 503, 504])("classifies raw %s as availability and preserves the request id", async (status) => {
    const response = () => new Response("upstream failed", {
      status,
      headers: { "x-request-id": "gateway-request" },
    });
    const error = await apiErrorFromResponse(response());
    expect(error).toMatchObject({ status, requestId: "gateway-request" });
    expect(isSameSystemApiDefect(error)).toBe(false);
    vi.stubGlobal("fetch", async () => response());
    await expect(apiFetch("/api/gateway")).rejects.toMatchObject({ code: error.code });
  });

  it("retains explicit internal defects and rejects malformed successful bodies", async () => {
    const error = await apiErrorFromResponse(Response.json({
      error: { code: "E_INTERNAL", message: "broken invariant" },
    }, { status: 503 }));
    expect(isSameSystemApiDefect(error)).toBe(true);
    vi.stubGlobal("fetch", async () => new Response("not json"));
    await expect(apiFetch("/api/malformed")).rejects.toMatchObject({ code: "E_INVALID_RESPONSE" });
  });

  it("fences a late successful completion without concealing a strict decode defect", async () => {
    // The read budget is measured against the platform clock, so the proof
    // moves the clock rather than waiting out the 30s deadline: the late read
    // is one that consumed the whole budget before producing its value.
    let elapsedMs = 0;
    vi.stubGlobal(
      "performance",
      Object.create(performance, { now: { value: () => elapsedMs } }) as Performance,
    );
    const parent = new AbortController();
    const late = requestWithRetry(async () => {
      elapsedMs = READ_RETRY_BUDGET_MS;
      return "late decoded value";
    }, parent.signal);
    const invalid = requestWithRetry(async () => {
      throw new ApiError(200, "E_INVALID_RESPONSE", "Invalid authoritative reader data");
    }, parent.signal);
    const results = await Promise.allSettled([late, invalid]);
    expect(results, "deadline settlement accepted late success or concealed an independent decode defect").toMatchObject([
      { status: "rejected", reason: { name: "ApiRetryExhausted" } },
      { status: "rejected", reason: { code: "E_INVALID_RESPONSE" } },
    ]);
  });

  it("classifies a body that fails mid-stream as availability, not a decode defect", async () => {
    const truncated = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(new TypeError("terminated"));
      },
    }), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async () => truncated());
    const failure = await apiFetch("/api/reader").catch((error: unknown) => error);
    expect(failure, "a dropped connection was reported as a broken same-system invariant")
      .toMatchObject({ code: "E_NETWORK" });
    expect(isSameSystemApiDefect(failure)).toBe(false);
  });

  it("exhausts the foreground budget without replaying earlier than long retry guidance", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return Response.json({ error: { code: "E_READ_CAPACITY", message: "Read capacity is occupied" } }, {
        status: 503, headers: { "Retry-After": "31" },
      });
    });
    await expect(requestWithRetry(
      (signal) => apiFetch("/api/search", { signal }), new AbortController().signal,
    )).rejects.toMatchObject({ name: "ApiRetryExhausted", cause: { code: "E_READ_CAPACITY" } });
    expect(attempts, "read ignored the server interval to manufacture another attempt").toBe(1);
  });

  it("refuses a terminal oversize read once instead of replaying the payload it broke", async () => {
    // E_READ_CAPACITY means "occupied, come back"; this one means "this content
    // cannot be served under the qualified profile". Replaying it would
    // re-materialize the oversized response three times to learn nothing.
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return Response.json({ error: {
        code: "E_READER_CONTENT_TOO_LARGE", message: "Reader query exceeds response capacity",
        details: { limit: "index_bytes", limit_value: 262_144, measured: 393_216 },
      } }, { status: 422 });
    });
    const failure = await requestWithRetry(
      (signal) => apiFetch("/api/media/one/reader-publications/2/find", { method: "POST", body: "{}", signal }),
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure, "a permanent content refusal was reported as an exhausted availability budget").toMatchObject({
      name: "ApiError", status: 422, code: "E_READER_CONTENT_TOO_LARGE",
      details: { limit: "index_bytes", limit_value: 262_144, measured: 393_216 },
    });
    expect(attempts, "the reader re-requested a response the API had already refused to build").toBe(1);
  });

  it("honors admission's retry-after interval before another semantic read", async () => {
    let availableAt = 0;
    const premature: number[] = [];
    vi.stubGlobal("fetch", async () => {
      const now = performance.now();
      if (availableAt === 0) {
        availableAt = now + 1_000;
        return Response.json({ error: { code: "E_READ_CAPACITY", message: "Read capacity is occupied" } }, {
          status: 503, headers: { "Retry-After": "1" },
        });
      }
      if (now < availableAt) premature.push(now);
      return Response.json({ data: { admitted: true } });
    });
    const result = await requestWithRetry(
      (signal) => apiFetch("/api/search", { method: "POST", body: "{}", signal }),
      new AbortController().signal,
    );
    expect(result).toEqual({ data: { admitted: true } });
    expect(premature, "read was replayed before the server's admission interval").toEqual([]);
  });

  it("retries a semantic read then defects with the final cause when its budget is exhausted", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return new Response(null, { status: 502, headers: { "x-request-id": "outage" } });
    });
    const controller = new AbortController();
    const result = requestWithRetry(
      (signal) => apiFetch("/api/search", { method: "POST", body: "{}", signal }),
      controller.signal,
    );
    await expect(result).rejects.toMatchObject({
      name: "ApiRetryExhausted",
      cause: { status: 502, requestId: "outage" },
    });
    expect(attempts).toBe(3);
  });
});
