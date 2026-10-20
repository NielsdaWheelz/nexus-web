"use client";

// The tab's sole online mutation FIFO. Each head builds and seals its bytes once.
// Transport uncertainty retries those bytes; unmodeled responses retain them until
// an explicit nudge. Callback defects cannot resend an acknowledged request or
// prevent later jobs from running. Nothing survives the tab's lifetime.
import { useSyncExternalStore } from "react";
import {
  ApiError,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";

export interface WriteRequest {
  readonly path: ApiPath;
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body: unknown;
  readonly link_refs?: readonly string[];
}
export interface WriteJob<R> {
  build(): WriteRequest | null;
  settle(reply: R): void;
  /** Terminal: the request was not sent, or was transactionally rejected. */
  fail(error: unknown): void;
  /** The sealed request remains at the head, including an unmodeled outcome. */
  retrying?(error: unknown): void;
}
export type WriteStatus = "idle" | "saving" | "retrying";
const KEEPALIVE_LIMIT = 60_000;
const queue: { serial: number; job: WriteJob<unknown> }[] = [];
const listeners = new Set<() => void>();
const versions: {
  serial: number;
  facts: Schema<"LinkVersionOut">[];
  failedRefs: string[];
}[] = [];
let completedSerial = 0;
let serial = 0;
let status: WriteStatus = "idle";
let running = false;
let wake: (() => void) | null = null;

export function captureWriteSerial(): number {
  return completedSerial;
}
/** Only acknowledged causal proof may advance a captured placement version. */
export function advanceLinksVersion(
  ref: string,
  base: number,
  afterSerial: number,
): number | null {
  let current = base;
  for (const completed of versions) {
    if (completed.serial <= afterSerial) continue;
    if (
      completed.failedRefs.includes("*") ||
      completed.failedRefs.includes(ref)
    )
      return null;
    const fact = completed.facts.find((item) => item.ref === ref);
    if (!fact) continue;
    if (fact.checked_from_version !== current) return null;
    current = fact.links_version;
  }
  return current;
}
const REJECTIONS = new Set([
  "E_UNAUTHENTICATED",
  "E_WIRE_MISMATCH",
  "E_FORBIDDEN",
  "E_NOT_FOUND",
  "E_CONVERSATION_NOT_FOUND",
  "E_INVALID_REQUEST",
  "E_INVALID_KIND",
  "E_NOTE_CONFLICT",
  "E_RESOURCE_CONFLICT",
  "E_CONTEXT_CHANGED",
  "E_READER_CONTENT_CHANGED",
  "E_READER_STATE_CONFLICT",
  "E_MEDIA_NOT_READY",
  "E_MEDIA_NOT_FOUND",
  "E_MEDIA_DELETING",
  "E_HIGHLIGHT_INVALID_RANGE",
  "E_HIGHLIGHT_CONFLICT",
  "E_LINK_SELF",
  "E_LINK_CAPABILITY",
  "E_LINK_TARGET_AMBIGUOUS",
  "E_LINK_TARGET_STALE",
]);
/** Queue removal and draft correction share exactly one transactional boundary. */
export function isWriteRejection(error: unknown): boolean {
  return (
    isApiError(error) &&
    !isSameSystemApiDefect(error) &&
    error.status >= 400 &&
    error.status < 500 &&
    REJECTIONS.has(error.code)
  );
}
function affectedRefs(body: unknown): string[] {
  if (
    body === null ||
    typeof body !== "object" ||
    !("commands" in body) ||
    !Array.isArray(body.commands)
  )
    return [];
  const refs: string[] = [];
  for (const command of body.commands) {
    if (command === null || typeof command !== "object") continue;
    if (typeof command.endpoint === "string") refs.push(command.endpoint);
    if (typeof command.destination === "string") refs.push(command.destination);
    if (typeof command.note_id === "string")
      refs.push(`note_block:${command.note_id}`);
    if (typeof command.page_id === "string")
      refs.push(`page:${command.page_id}`);
    for (const key of ["source", "target", "destination"]) {
      const endpoint = command[key];
      if (
        endpoint &&
        typeof endpoint === "object" &&
        endpoint.kind === "resource" &&
        typeof endpoint.ref === "string"
      )
        refs.push(endpoint.ref);
    }
  }
  return refs;
}
function call(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    reportError(error);
  }
}
function publish(next: WriteStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) call(listener);
}
export function enqueueWrite<R>(job: WriteJob<R>): void {
  // justify-type-assertion: each job settles only its own reply.
  queue.push({ serial: ++serial, job: job as WriteJob<unknown> });
  if (!running) void pump();
}
export function nudgeWrites(): void {
  wake?.();
}
export function writesPending(): boolean {
  return queue.length > 0;
}

function pause(delay: number | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = delay === null ? null : window.setTimeout(done, delay);
    function done() {
      if (timer !== null) window.clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
  });
}
async function pump(): Promise<void> {
  running = true;
  try {
    while (queue.length) {
      const head = queue[0]!;
      const { job } = head;
      let request: WriteRequest | null;
      let body: string | undefined;
      try {
        request = job.build();
        body =
          request === null || request.body === undefined
            ? undefined
            : JSON.stringify(request.body);
      } catch (error) {
        versions.push({ serial: head.serial, facts: [], failedRefs: ["*"] });
        completedSerial = head.serial;
        queue.shift();
        call(() => job.fail(error));
        continue;
      }
      if (request !== null) {
        const bytes = new TextEncoder().encode(body ?? "").length;
        for (let attempt = 0; ; attempt += 1) {
          publish("saving");
          let data: unknown;
          try {
            // Sending and presence of an acknowledgement belong here; callbacks never do.
            const reply = await apiFetch<{ data: unknown } | undefined>(
              request.path,
              {
                method: request.method,
                body,
                keepalive: bytes < KEEPALIVE_LIMIT,
              },
            );
            if (reply === undefined)
              throw new ApiError(
                200,
                "E_INVALID_RESPONSE",
                "Write returned no acknowledgement",
              );
            data = reply.data;
          } catch (error) {
            const transport =
              isApiError(error) &&
              [0, 429, 502, 503, 504].includes(error.status);
            const rejected = isWriteRejection(error);
            if (rejected && !transport) {
              const refs = [
                ...affectedRefs(request.body),
                ...(request.link_refs ?? []),
              ];
              versions.push({
                serial: head.serial,
                facts: [],
                failedRefs: refs.length ? refs : ["*"],
              });
              call(() => job.fail(error));
              break;
            }
            publish("retrying");
            call(() => job.retrying?.(error));
            if (!transport) reportError(error);
            await pause(
              transport ? Math.min(30_000, 1000 * 2 ** attempt) : null,
            );
            continue;
          }
          if (request.path === "/api/resource-graph/commands") {
            // justify-type-assertion: graph commands return their generated version facts.
            versions.push({
              serial: head.serial,
              facts: (data as Schema<"OutlineCommandsOut">).link_versions,
              failedRefs: [],
            });
          } else if (request.link_refs?.length)
            versions.push({
              serial: head.serial,
              facts: [],
              failedRefs: [...request.link_refs],
            });
          call(() => job.settle(data));
          break;
        }
      }
      completedSerial = head.serial;
      queue.shift();
    }
  } finally {
    running = false;
    publish("idle");
    if (queue.length) void pump();
  }
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
