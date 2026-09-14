import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaneRouteErrorBoundary } from "@/components/workspace/PaneRouteErrorBoundary";
import { apiFetch } from "./client";
import { ResourceCache, ResourceCacheContext } from "./resourceCache";
import { useResource } from "./useResource";

afterEach(() => vi.unstubAllGlobals());

it("counts an adopted prefetch as the first attempt in one bounded read", async () => {
  let completeFirst!: (response: Response) => void;
  let attempts = 0;
  vi.stubGlobal("fetch", () => {
    attempts += 1;
    return attempts === 1
      ? new Promise<Response>((resolve) => { completeFirst = resolve; })
      : Promise.resolve(new Response(null, { status: 503 }));
  });
  const cache = new ResourceCache({}, READER_CAPACITY.cache);
  cache.prefetch("read", (signal) => apiFetch("/api/read", { signal }));
  function Consumer() {
    const result = useResource({ cacheKey: "read", path: () => "/api/read" as const });
    return <p>{result.status}</p>;
  }
  render(
    <ResourceCacheContext.Provider value={cache}>
      <PaneRouteErrorBoundary paneId="read" visitId="read" resetKey="read" slotMinWidth="0" isActive={false}>
        <Consumer />
      </PaneRouteErrorBoundary>
    </ResourceCacheContext.Provider>,
  );
  completeFirst(new Response(null, { status: 503 }));
  expect(await screen.findByText("This pane couldn’t load", {}, { timeout: 3_000 })).toBeVisible();
  expect(attempts, "adoption started a second complete retry budget").toBe(3);
});
