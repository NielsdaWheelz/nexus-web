import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";

describe("requestWithRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries network and server failures three total times", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const controller = new AbortController();
    const request = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(0, "E_NETWORK", "offline"))
      .mockRejectedValueOnce(new ApiError(503, "E_UPSTREAM", "down"))
      .mockResolvedValueOnce("ready");

    const result = requestWithRetry(request, controller.signal);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ready");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("never relabels or retries an unexpected same-system defect", async () => {
    const defect = new TypeError("Navigation response violated its contract");
    const request = vi.fn(async () => {
      throw defect;
    });

    await expect(
      requestWithRetry(request, new AbortController().signal),
    ).rejects.toBe(defect);
    expect(request).toHaveBeenCalledOnce();
  });

  it("never retries client errors", async () => {
    const request = vi.fn(async () => {
      throw new ApiError(400, "E_BAD_REQUEST", "bad");
    });

    await expect(
      requestWithRetry(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("never retries same-system response defects", async () => {
    const request = vi.fn(async () => {
      throw new ApiError(500, "E_INVALID_RESPONSE", "malformed");
    });

    await expect(
      requestWithRetry(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "E_INVALID_RESPONSE" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels a pending backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn(async () => {
      throw new ApiError(503, "E_UPSTREAM", "down");
    });
    const result = requestWithRetry(request, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledOnce();
  });
});
