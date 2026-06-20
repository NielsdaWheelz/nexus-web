import { describe, expect, it, vi } from "vitest";
import { ResourceCache } from "./resourceCache";

// Flush microtasks + one macrotask so settled prefetch promises apply.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ResourceCache", () => {
  it("wraps server seeds as ready entries; peek is read-only, consume removes (consume-once)", () => {
    const cache = new ResourceCache({ k1: "seed" });
    expect(cache.peek("k1")).toEqual({ status: "ready", data: "seed" });
    // peek must not mutate — a second peek still sees it.
    expect(cache.peek("k1")).toEqual({ status: "ready", data: "seed" });
    cache.consume("k1");
    expect(cache.peek("k1")).toBeNull();
  });

  it("prefetch deposits a pending entry, then resolves it to ready", async () => {
    const cache = new ResourceCache({});
    let resolve!: (value: unknown) => void;
    cache.prefetch("k1", () => new Promise((r) => (resolve = r)));
    expect(cache.peek("k1")?.status).toBe("pending");
    resolve("data");
    await flush();
    expect(cache.peek("k1")).toEqual({ status: "ready", data: "data" });
  });

  it("is idempotent: a present key (pending or ready) is not re-run", () => {
    const cache = new ResourceCache({ s: 1 });
    const pendingRun = vi.fn(() => new Promise<unknown>(() => {}));
    cache.prefetch("k1", pendingRun);
    cache.prefetch("k1", pendingRun);
    expect(pendingRun).toHaveBeenCalledTimes(1);
    const seededRun = vi.fn(() => new Promise<unknown>(() => {}));
    cache.prefetch("s", seededRun);
    expect(seededRun).not.toHaveBeenCalled();
  });

  it("removes a failed prefetch so the mount fetches normally (never poisons)", async () => {
    const cache = new ResourceCache({});
    cache.prefetch("k1", () => Promise.reject(new Error("boom")));
    await flush();
    expect(cache.peek("k1")).toBeNull();
  });

  it("bounds prefetch entries to the LRU limit, aborting + evicting the oldest", () => {
    const cache = new ResourceCache({});
    const aborted: number[] = [];
    for (let i = 0; i < 17; i += 1) {
      cache.prefetch(`k${i}`, (signal) => {
        signal.addEventListener("abort", () => aborted.push(i));
        return new Promise<unknown>(() => {});
      });
    }
    expect(cache.peek("k0")).toBeNull();
    expect(aborted).toEqual([0]);
    const remaining = Array.from({ length: 17 }, (_, i) => i).filter((i) =>
      cache.peek(`k${i}`),
    );
    expect(remaining).toHaveLength(16);
  });

  it("never evicts server seeds — only prefetch entries are LRU-bound", () => {
    const seeds: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) seeds[`s${i}`] = i;
    const cache = new ResourceCache(seeds);
    for (let i = 0; i < 17; i += 1) {
      cache.prefetch(`p${i}`, () => new Promise<unknown>(() => {}));
    }
    const survivingSeeds = Array.from({ length: 20 }, (_, i) => i).filter((i) =>
      cache.peek(`s${i}`),
    );
    expect(survivingSeeds).toHaveLength(20);
  });

  it("consume frees an LRU slot so a later prefetch is not evicted by the consumed key", () => {
    const cache = new ResourceCache({});
    cache.prefetch("k0", () => new Promise<unknown>(() => {}));
    cache.consume("k0");
    for (let i = 1; i <= 16; i += 1) {
      cache.prefetch(`k${i}`, () => new Promise<unknown>(() => {}));
    }
    // 16 live prefetches after consuming one — none evicted.
    const live = Array.from({ length: 17 }, (_, i) => i).filter((i) =>
      cache.peek(`k${i}`),
    );
    expect(live).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});
