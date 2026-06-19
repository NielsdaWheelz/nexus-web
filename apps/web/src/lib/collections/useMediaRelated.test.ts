import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { queryMediaRelated } from "./useMediaRelated";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

describe("queryMediaRelated", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("queries the media related BFF route with abort support", async () => {
    const controller = new AbortController();
    apiFetchMock.mockResolvedValueOnce({ data: { peers: [] } });

    await expect(
      queryMediaRelated("22222222-2222-4222-8222-222222222222", {
        signal: controller.signal,
      }),
    ).resolves.toEqual([]);

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/media/22222222-2222-4222-8222-222222222222/related",
      { signal: controller.signal },
    );
  });
});
