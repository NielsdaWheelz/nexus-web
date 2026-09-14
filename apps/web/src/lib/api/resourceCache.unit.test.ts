import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { describe, expect, it } from "vitest";
import { PREFETCH_CACHE_LIMIT, ResourceCache, type ResourceCacheEntry } from "./resourceCache";

function pendingRead() {
  let complete!: (value: string) => void;
  const promise = new Promise<string>((resolve) => { complete = resolve; });
  return { promise, complete };
}

/** The entry speculation actually created, so a refused warm fails its scenario. */
function admitted(cache: ResourceCache, key: string): Extract<ResourceCacheEntry, { status: "pending" }> {
  const entry = cache.peek(key);
  if (entry === null || entry.status !== "pending") {
    throw new Error(`Speculative read for ${key} was not admitted`);
  }
  return entry;
}

/**
 * Awaiting the entry's own promise resumes after the cache's settlement
 * handlers, which were registered at admission. Nothing here counts microtasks.
 */
async function settled(cache: ResourceCache, key: string): Promise<void> {
  await admitted(cache, key).promise;
}

/** A mounting consumer adopts the running read; its admission stays charged. */
function adopt(cache: ResourceCache, key: string, read: Promise<string>) {
  cache.prefetch(key, () => read);
  const entry = admitted(cache, key);
  cache.consume(key, entry);
  return entry;
}

describe("speculative read ownership", () => {
  it("keeps a read reserved for views while speculation is running", async () => {
    const cache = new ResourceCache({}, READER_CAPACITY.cache);
    const warm = pendingRead();
    cache.prefetch("warm-first", () => warm.promise);
    const running = admitted(cache, "warm-first");
    cache.prefetch("warm-second", async () => "second");
    expect(cache.peek("warm-second"), "speculation took a read reserved for views").toBeNull();
    expect(cache.acquireRead(), "a view lost its read to speculation").toMatchObject({ kind: "Acquired" });
    expect(cache.acquireRead(), "reads were admitted beyond the budget").toMatchObject({ kind: "Capacity", reason: "Reads" });
    warm.complete("first");
    await running.promise;
  });

  it("does not consume a replacement using an observation of an evicted request", async () => {
    // Reads are deliberately plentiful: eviction and consume identity decide this.
    const cache = new ResourceCache({}, { ...READER_CAPACITY.cache, maxReads: PREFETCH_CACHE_LIMIT + 2 });
    const old = pendingRead();
    cache.prefetch("same", () => old.promise);
    const observed = admitted(cache, "same");
    for (let index = 0; index < PREFETCH_CACHE_LIMIT; index += 1) {
      cache.prefetch(`other-${index}`, async () => "other");
      await settled(cache, `other-${index}`);
    }
    expect(cache.peek("same"), "the oldest speculative entry survived its eviction").toBeNull();
    cache.prefetch("same", async () => "replacement");
    await settled(cache, "same");
    cache.consume("same", observed);
    expect(cache.peek("same"), "an old render consumed a newer resource").toMatchObject({ status: "ready", data: "replacement" });
    // Retire the evicted request inside the scenario that started it.
    old.complete("old");
    await observed.promise;
  });

  it("holds the read budget for adopted speculation until it settles", async () => {
    // Two speculative reads are the whole execution budget and far below the
    // sixteen-entry retention bound, so only admission can refuse the third.
    const cache = new ResourceCache({}, { ...READER_CAPACITY.cache, maxReads: 3, reservedViewReads: 1 });
    const first = pendingRead();
    const second = pendingRead();
    const adoptedFirst = adopt(cache, "adopted-first", first.promise);
    const adoptedSecond = adopt(cache, "adopted-second", second.promise);
    let overflowStarted = false;
    cache.prefetch("overflow", async () => { overflowStarted = true; return "overflow"; });
    expect(cache.peek("overflow"), "adoption freed capacity while requests were still running").toBeNull();
    expect(overflowStarted, "a refused speculative read started work anyway").toBe(false);
    first.complete("settled");
    await adoptedFirst.promise;
    cache.prefetch("later", async () => "available");
    await settled(cache, "later");
    expect(cache.peek("later"), "a settled adopted read never returned its slot").toMatchObject({ status: "ready", data: "available" });
    second.complete("settled");
    await adoptedSecond.promise;
  });

  it("cannot settle a replacement from an older evicted request", async () => {
    const cache = new ResourceCache({}, { ...READER_CAPACITY.cache, maxReads: PREFETCH_CACHE_LIMIT + 2 });
    const old = pendingRead();
    const replacement = pendingRead();
    cache.prefetch("same", () => old.promise);
    const evicted = admitted(cache, "same");
    for (let index = 0; index < PREFETCH_CACHE_LIMIT; index += 1) {
      cache.prefetch(`other-${index}`, async () => "other");
      await settled(cache, `other-${index}`);
    }
    cache.prefetch("same", () => replacement.promise);
    const current = admitted(cache, "same");
    old.complete("obsolete");
    await evicted.promise;
    expect(cache.peek("same"), "an evicted request's settlement took over its old key").toBe(current);
    replacement.complete("current");
    await current.promise;
    expect(cache.peek("same"), "the replacement did not settle into its own key").toMatchObject({ status: "ready", data: "current" });
  });
});
