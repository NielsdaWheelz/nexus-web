"use client";

// The tab's notes writes, online only. One FIFO sends one request at a time, in the
// order the user acted. A job builds its request once, when it reaches the head, and
// the request is resent unchanged until it gets a definitive answer: its primitives
// are idempotent, so an unknown outcome is settled by resending. Network failures, 429
// and an unreachable or overloaded api (502, 503, 504) retry with backoff (1 s doubling
// to 30 s, sooner when the browser comes back online or the tab becomes visible); any
// other answer, a 500 included, is definitive and the job's to handle. Callback
// defects finalize and dequeue the job, surface separately, and never retry transport.
// Nothing is persisted: a tab that dies offline loses what is queued (owner decision).
import { useSyncExternalStore } from "react";
import { apiFetch, isApiError, type ApiPath } from "@/lib/api/client";

export interface WriteRequest {
  readonly path: ApiPath;
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body: unknown;
}

export interface WriteJob<R> {
  /** Called once, at the head of the queue; null skips the job. */
  build(): WriteRequest | null;
  settle(reply: R): void;
  fail(error: unknown): void;
  /** Runs once after every outcome, including skipped builds and callback defects. */
  finalize?(): void;
}

export type WriteStatus = "idle" | "saving" | "retrying";

// keepalive (body bytes under fetch's 64 KiB-per-page quota) lets a save outlive its tab.
const KEEPALIVE_LIMIT = 60_000;
const queue: WriteJob<unknown>[] = [];
const listeners = new Set<() => void>();
let status: WriteStatus = "idle";
let running = false;
let wake: (() => void) | null = null;

function publish(next: WriteStatus) {
  if (status === next) return;
  status = next;
  const defects: unknown[] = [];
  for (const listener of listeners) {
    try { listener(); } catch (error) { defects.push(error); }
  }
  if (defects.length) queueMicrotask(() => { throw new AggregateError(defects, "write status observers failed"); });
}

/** Starts the request at once (inside the caller's event handler) when the queue is idle. */
export function enqueueWrite<R>(job: WriteJob<R>): void {
  // justify-type-assertion: each job settles only its own reply.
  queue.push(job as WriteJob<unknown>);
  if (!running) void pump();
}

/** Retry a backed-off request now. */
export function nudgeWrites(): void {
  wake?.();
}

export function writesPending(): boolean {
  return queue.length > 0;
}

async function pump(): Promise<void> {
  running = true;
  while (queue.length) {
    const job = queue[0]!;
    const defects: unknown[] = [];
    try {
      const request = job.build();
      if (request) {
        publish("saving");
        const body = request.body === undefined ? undefined : JSON.stringify(request.body);
        const bytes = new TextEncoder().encode(body ?? "").length;
        for (let attempt = 0; ; attempt += 1) {
          let reply: { data: unknown } | undefined;
          try {
            reply = await apiFetch<{ data: unknown } | undefined>(request.path, {
              method: request.method,
              body,
              keepalive: bytes < KEEPALIVE_LIMIT,
            });
          } catch (error) {
            if (!retryable(error)) {
              job.fail(error);
              break;
            }
            publish("retrying");
            await new Promise<void>((resolve) => {
              wake = resolve;
              window.setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt));
            });
            wake = null;
            continue;
          }
          // callbacks are outside the transport retry boundary.
          job.settle(reply?.data);
          break;
        }
      }
    } catch (error) {
      defects.push(error);
    } finally {
      queue.shift();
      try { job.finalize?.(); } catch (error) { defects.push(error); }
    }
    if (defects.length) queueMicrotask(() => { throw new AggregateError(defects, "write callbacks failed"); });
  }
  running = false;
  publish("idle");
}

function retryable(error: unknown): boolean {
  return (
    isApiError(error) &&
    [0, 429, 502, 503, 504].includes(error.status)
  );
}

export function useWriteStatus(): WriteStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => status,
    () => "idle",
  );
}
