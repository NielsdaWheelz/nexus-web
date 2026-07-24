import { afterEach, describe, expect, it, vi } from "vitest";
import { readPublicAsset } from "./publicClient";

describe("public asset client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reauthorizes every opaque EPUB asset without ambient credentials", async () => {
    const token = `nxshr1_${"A".repeat(43)}`;
    const handle = `nxpa1_${"B".repeat(48)}`;
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(["image"]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      readPublicAsset(token, handle, controller.signal)
    ).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/public/resource-share/assets/${handle}`,
      {
        method: "GET",
        headers: { "X-Nexus-Share-Token": token },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }
    );
  });
});
