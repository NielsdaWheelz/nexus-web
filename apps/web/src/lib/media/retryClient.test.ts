import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { retryMediaMetadata, retryMediaSource } from "@/lib/media/retryClient";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

describe("retryClient", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(undefined);
  });

  it("posts the source retry stage explicitly", async () => {
    await retryMediaSource("media-1");

    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/retry", {
      method: "POST",
      body: JSON.stringify({ from_stage: "source" }),
    });
  });

  it("posts the metadata retry stage explicitly", async () => {
    await retryMediaMetadata("media-1");

    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/retry", {
      method: "POST",
      body: JSON.stringify({ from_stage: "metadata" }),
    });
  });
});
