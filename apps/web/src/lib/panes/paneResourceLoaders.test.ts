import { describe, expect, it, vi } from "vitest";
import {
  LECTERN_RECENT_LIMIT,
  lecternRecentResource,
  type ResourceDescriptor,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";

describe("Lectern pane resource loader", () => {
  it("seeds only the independent strict recent-consumption snapshot", async () => {
    const requestSpy = vi.fn();
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
      params: P,
    ): Promise<T> => {
      requestSpy(descriptor, params);
      return { data: { items: [] } } as T;
    };
    const loader = paneResourceLoaders.lectern;
    if (!loader) throw new Error("Lectern recent loader missing");

    expect(loader.cacheKey({})).toBe(
      lecternRecentResource.cacheKey({
        limit: LECTERN_RECENT_LIMIT,
        refreshVersion: 0,
      }),
    );
    await expect(loader.load(request, {})).resolves.toEqual({ items: [] });
    expect(requestSpy).toHaveBeenCalledWith(lecternRecentResource, {
      limit: LECTERN_RECENT_LIMIT,
      refreshVersion: 0,
    });
  });
});
