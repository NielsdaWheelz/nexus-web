"use client";

import { createContext, useEffect, useRef, type ReactNode } from "react";
import { isApiError } from "./client";
import { requestWithRetry } from "./retryPolicy";
import { clearPendingReaderPulsesForCache, type ReaderPulseInput } from "@/lib/reader/pulseEvent";
import { READER_DECODE_RESERVATION_FACTOR, READER_RETAINED_PAYLOAD_FACTOR } from "@/lib/reader/readerCapacity";
import type { ReaderMemberRef, ReaderPublicationUnit } from "@/lib/reader/publicationContract";

// Server-prefetched initial data, keyed by the same cacheKey the client hook reads.
// Serialized by the server data root; the provider wraps each value as a ready entry.
export type DehydratedResources = Record<string, unknown>;

// Separate retained-entry and running-request bounds. Adoption never frees an
// execution slot, and cancellation retains its slot until the promise settles.
export const PREFETCH_CACHE_LIMIT = 16;

export type ResourceCacheEntry =
  | { status: "ready"; data: unknown }
  | { status: "pending"; promise: Promise<unknown>; signal: AbortSignal; abort: () => void };

export interface PublicationCacheLimits {
  /** Retained/decoding primitive payload; excludes engine-dependent JS/DOM heap. */
  readonly maxPayloadBytes: number;
  readonly maxReads: number;
  /**
   * Reads speculation may never occupy, so a warm can never refuse a view.
   * Speculation runs in the strict remainder: `maxReads - reservedViewReads`.
   */
  readonly reservedViewReads: number;
}

/**
 * The settled member, tagged: the API's terminal 422
 * `E_READER_CONTENT_TOO_LARGE` is a capacity answer for this publication under
 * the qualified profile, not a transport failure, so it is delivered rather
 * than thrown — and no consumer recognises success by a missing field.
 */
export type PublicationUnitSettlement =
  | { readonly kind: "Unit"; readonly unit: ReaderPublicationUnit }
  | { readonly kind: "Capacity"; readonly reason: "Content" };

export interface PublicationUnitLease {
  /** Borrow before release; an already borrowed promise cannot be revoked. */
  readonly promise: Promise<PublicationUnitSettlement>;
  release(): void;
}
export type ResourceReadCapacity = { readonly kind: "Capacity"; readonly reason: "Reads" };
export interface ResourceReadPermit { readonly kind: "Acquired"; release(): void }

export interface ReaderSourceInputLease {
  readonly cache: ResourceCache;
  release(): void;
}

interface PublicationEntry {
  readonly reference: ReaderMemberRef;
  readonly controller: AbortController;
  readonly promise: Promise<PublicationUnitSettlement>;
  consumers: number;
  pending: boolean;
  payloadBytes: number;
}

/** Conservative primitive payload, including keys; excludes object/allocator/DOM overhead. */
export function publicationPayloadBytes(value: unknown): number {
  if (value === null) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 1;
  if (Array.isArray(value)) return value.reduce((bytes, item) => bytes + publicationPayloadBytes(item), 0);
  if (typeof value === "object") return Object.entries(value).reduce(
    (bytes, [key, item]) => bytes + key.length * 2 + publicationPayloadBytes(item), 0,
  );
  throw new Error("Publication payload must be a decoded JSON value");
}

// One per-load resource cache holding server seeds (ready) and client prefetches
// (pending → ready). Ready seeds are consumed once; adopted pending reads stay
// owned until settlement, then are removed so later opens fetch fresh. `useResource`
// peeks it at mount; prefetch-on-intent fills it. Writes never trigger a re-render
// (useResource reads at mount only; prefetch must not re-render hover targets).
export class ResourceCache {
  private entries = new Map<string, ResourceCacheEntry>();
  private prefetchOrder: string[] = [];
  private pending = new Set<ResourceCacheEntry>();
  private claimed = new WeakSet<ResourceCacheEntry>();
  private settledFrom = new WeakMap<ResourceCacheEntry, ResourceCacheEntry>();
  private intents = new WeakMap<ResourceCacheEntry, number>();
  private publicationEntries = new Map<string, PublicationEntry>();
  private activeReads = 0;
  private publicationPayloadBytes = 0;

  constructor(seeds: DehydratedResources, private readonly publicationLimits: PublicationCacheLimits) {
    if (!Number.isSafeInteger(publicationLimits.maxPayloadBytes) || publicationLimits.maxPayloadBytes < 1 ||
         !Number.isSafeInteger(publicationLimits.maxReads) || publicationLimits.maxReads < 1) {
      throw new Error("Publication cache limits must be positive integers");
    }
    if (!Number.isSafeInteger(publicationLimits.reservedViewReads) || publicationLimits.reservedViewReads < 1 ||
         publicationLimits.reservedViewReads > publicationLimits.maxReads) {
      throw new Error("Reserved view reads must be a positive integer within the read budget");
    }
    for (const [key, data] of Object.entries(seeds)) {
      this.entries.set(key, { status: "ready", data });
    }
  }

  /** The pending source delivery owns this charge until its actual consumers retire. */
  retainReaderSourceInput(input: ReaderPulseInput): { readonly kind: "Acquired"; readonly lease: ReaderSourceInputLease } | { readonly kind: "Capacity"; readonly reason: "Payload" } {
    const bytes = publicationPayloadBytes(input);
    if (!this.makePublicationPayloadRoom(bytes)) return { kind: "Capacity", reason: "Payload" };
    this.publicationPayloadBytes += bytes;
    let released = false;
    return { kind: "Acquired", lease: { cache: this, release: () => {
      if (released) return;
      released = true;
      this.publicationPayloadBytes -= bytes;
    } } };
  }

  private makePublicationPayloadRoom(bytes: number): boolean {
    for (const [key, entry] of this.publicationEntries) {
      if (this.publicationPayloadBytes + bytes <= this.publicationLimits.maxPayloadBytes) break;
      if (entry.pending || entry.consumers !== 0) continue;
      this.publicationEntries.delete(key);
      this.releasePublicationPayload(entry);
    }
    return this.publicationPayloadBytes + bytes <= this.publicationLimits.maxPayloadBytes;
  }

  /**
   * Foreground (view) read admission against the whole budget. Release only
   * after physical read/decode settlement, including cancellation.
   */
  acquireRead(): ResourceReadPermit | ResourceReadCapacity {
    if (this.activeReads >= this.publicationLimits.maxReads) return { kind: "Capacity", reason: "Reads" };
    this.activeReads += 1;
    let released = false;
    return { kind: "Acquired", release: () => {
      if (released) return;
      released = true;
      this.activeReads -= 1;
    } };
  }

  /**
   * Speculation admits only into the remainder the view reservation leaves, so
   * concurrent warms can never hold the reads a visible view needs. A permit
   * already taken is never revoked: cancellation keeps its slot until the work
   * settles, so a reservation is the only way to keep views in front.
   */
  private acquireSpeculativeRead(): ResourceReadPermit | ResourceReadCapacity {
    const { maxReads, reservedViewReads } = this.publicationLimits;
    if (this.activeReads >= maxReads - reservedViewReads) return { kind: "Capacity", reason: "Reads" };
    return this.acquireRead();
  }

  /** End account lookup ownership without pretending its active consumers vanished. */
  clear(): void {
    clearPendingReaderPulsesForCache(this);
    for (const entry of this.entries.values()) if (entry.status === "pending") entry.abort();
    this.entries.clear();
    this.prefetchOrder.length = 0;
    for (const [key, entry] of this.publicationEntries) {
      this.publicationEntries.delete(key);
      if (entry.pending) entry.controller.abort();
      else if (entry.consumers === 0) this.releasePublicationPayload(entry);
    }
  }

  // Read-only — safe during render (no mutation).
  peek(key: string): ResourceCacheEntry | null {
    return this.entries.get(key) ?? null;
  }

  // consume-once — call post-commit (in an effect), never during render.
  consume(key: string, observed: ResourceCacheEntry): void {
    const entry = this.entries.get(key);
    if (entry === undefined || (entry !== observed && this.settledFrom.get(entry) !== observed)) return;
    if (observed.status === "pending") this.claimed.add(observed);
    if (entry.status === "ready") this.entries.delete(key);
    this.forgetPrefetch(key);
  }

  // Warm a key's data on intent: idempotent (a present key is a no-op), bounded (LRU),
  // abortable. Never poisons — a failed/aborted prefetch is removed so the mount fetches
  // normally. At most one in-flight fetch per key, deduping concurrent prefetch + mount.
  prefetch(key: string, run: (signal: AbortSignal) => Promise<unknown>): (() => void) | undefined {
    const existing = this.entries.get(key);
    if (existing?.status === "pending") return this.retainIntent(key, existing);
    if (existing !== undefined || this.pending.size >= PREFETCH_CACHE_LIMIT) return;
    const permit = this.acquireSpeculativeRead();
    if (permit.kind === "Capacity") return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => run(controller.signal));
    const entry: ResourceCacheEntry = {
      status: "pending",
      promise,
      signal: controller.signal,
      abort: () => controller.abort(),
    };
    this.entries.set(key, entry);
    this.pending.add(entry);
    this.prefetchOrder.push(key);
    promise.then(
      (data) => {
        permit.release();
        this.pending.delete(entry);
        if (this.entries.get(key) === entry) {
          if (this.claimed.has(entry)) this.entries.delete(key);
          else {
            const ready: ResourceCacheEntry = { status: "ready", data };
            this.settledFrom.set(ready, entry);
            this.entries.set(key, ready);
          }
        }
      },
      () => {
        permit.release();
        this.pending.delete(entry);
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
          this.forgetPrefetch(key);
        }
      },
    );
    while (this.prefetchOrder.length > PREFETCH_CACHE_LIMIT) {
      const evicted = this.prefetchOrder.shift();
      if (evicted === undefined) {
        break;
      }
      const entry = this.entries.get(evicted);
      if (entry?.status === "pending") {
        entry.abort();
      }
      this.entries.delete(evicted);
    }
    return this.retainIntent(key, entry);
  }

  acquirePublicationUnit({ accountId, mediaId, generation, leaseId, reference, read }: {
    readonly accountId: string;
    readonly mediaId: string;
    readonly generation: number;
    /** Verified native package grant; hosted immutable publications omit it. */
    readonly leaseId?: string;
    readonly reference: ReaderMemberRef;
    /** One transport attempt. This shared entry owns the entire retry schedule. */
    readonly read: (signal: AbortSignal) => Promise<ReaderPublicationUnit>;
  }): { readonly kind: "Acquired"; readonly lease: PublicationUnitLease } | { readonly kind: "Capacity"; readonly reason: "Payload" | "Reads" } {
    const key = JSON.stringify([accountId, mediaId, generation, leaseId ?? null, reference.key]);
    const existing = this.publicationEntries.get(key);
    if (existing !== undefined) {
      if (existing.reference.bytes !== reference.bytes || existing.reference.sha256 !== reference.sha256) {
        throw new Error("Immutable reader member changed its representation");
      }
      this.publicationEntries.delete(key);
      this.publicationEntries.set(key, existing);
      return { kind: "Acquired", lease: this.retainPublication(key, existing) };
    }
    const reservation = reference.bytes * READER_DECODE_RESERVATION_FACTOR;
    // Admit first: eviction is a side effect of work that will actually start,
    // so a refused read must not have discarded retained ready content for it.
    const permit = this.acquireRead();
    if (permit.kind === "Capacity") return permit;
    if (!this.makePublicationPayloadRoom(reservation)) {
      permit.release();
      return { kind: "Capacity", reason: "Payload" };
    }
    const controller = new AbortController();
    this.publicationPayloadBytes += reservation;
    const entry: PublicationEntry = {
      reference, controller, consumers: 0, pending: true, payloadBytes: reservation,
      // The one permit covers this entry's whole retry schedule, including
      // backoff and cancellation. Re-admitting per attempt would let a competing
      // read take the slot mid-schedule and report capacity in place of the
      // upstream failure the schedule was retrying.
      promise: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return requestWithRetry(async (attemptSignal): Promise<PublicationUnitSettlement> => {
          try {
            return { kind: "Unit", unit: await read(attemptSignal) };
          } catch (error) {
            if (isApiError(error) && error.code === "E_READER_CONTENT_TOO_LARGE") return { kind: "Capacity", reason: "Content" };
            throw error;
          }
        }, controller.signal);
      }).then((settled) => {
        if (settled.kind === "Capacity") {
          // A refusal is permanent for this member, and retaining it would hold
          // its decode reservation against every later read for nothing.
          if (this.publicationEntries.get(key) === entry) this.publicationEntries.delete(key);
          return settled;
        }
        const payloadBytes = publicationPayloadBytes(settled.unit);
        if (payloadBytes > reference.bytes * READER_RETAINED_PAYLOAD_FACTOR) throw new Error("Reader payload exceeded its reserved representation");
        if (this.publicationEntries.get(key) === entry) {
          this.publicationPayloadBytes += payloadBytes - entry.payloadBytes;
          entry.payloadBytes = payloadBytes;
        }
        return settled;
      }).catch((error: unknown) => {
        if (this.publicationEntries.get(key) === entry) this.publicationEntries.delete(key);
        throw error;
      }).finally(() => {
        entry.pending = false;
        permit.release();
        if (this.publicationEntries.get(key) !== entry) this.releasePublicationPayload(entry);
      }),
    };
    this.publicationEntries.set(key, entry);
    return { kind: "Acquired", lease: this.retainPublication(key, entry) };
  }

  private retainPublication(key: string, entry: PublicationEntry): PublicationUnitLease {
    entry.consumers += 1;
    let retained: PublicationEntry | null = entry;
    return {
      get promise() {
        if (retained === null) throw new Error("Reader unit lease has retired");
        return retained.promise;
      },
      release: () => {
        const current = retained;
        if (current === null) return;
        retained = null;
        current.consumers -= 1;
        if (current.consumers !== 0) return;
        if (!current.pending) {
          if (this.publicationEntries.get(key) !== current) this.releasePublicationPayload(current);
          return;
        }
        if (this.publicationEntries.get(key) === current) this.publicationEntries.delete(key);
        current.controller.abort();
      },
    };
  }

  private releasePublicationPayload(entry: PublicationEntry): void {
    this.publicationPayloadBytes -= entry.payloadBytes;
    entry.payloadBytes = 0;
  }

  private retainIntent(key: string, entry: Extract<ResourceCacheEntry, { status: "pending" }>): () => void {
    this.intents.set(entry, (this.intents.get(entry) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.intents.get(entry) ?? 1) - 1;
      this.intents.set(entry, remaining);
      if (remaining > 0 || this.claimed.has(entry) || !this.pending.has(entry)) return;
      entry.abort();
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        this.forgetPrefetch(key);
      }
    };
  }

  private forgetPrefetch(key: string): void {
    const index = this.prefetchOrder.indexOf(key);
    if (index !== -1) {
      this.prefetchOrder.splice(index, 1);
    }
  }
}

export const ResourceCacheContext = createContext<ResourceCache | null>(null);

export function ResourceCacheProvider({
  value,
  publicationLimits,
  children,
}: {
  value: DehydratedResources;
  publicationLimits: PublicationCacheLimits;
  children: ReactNode;
}) {
  const cacheRef = useRef<ResourceCache | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new ResourceCache(value, publicationLimits);
  }
  useEffect(() => {
    const cache = cacheRef.current!;
    return () => cache.clear();
  }, []);
  return (
    <ResourceCacheContext.Provider value={cacheRef.current}>
      {children}
    </ResourceCacheContext.Provider>
  );
}
