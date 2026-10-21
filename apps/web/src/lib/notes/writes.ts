"use client";

// The tab's sole online mutation FIFO. Each head builds and seals its bytes once.
// Transport uncertainty (no answer, 429, 502-504) retries those bytes; any answered
// failure ends the job (a modeled rejection, or a reported defect), so one bad
// request never holds the queue. Callback defects cannot resend an acknowledged
// request or prevent later jobs from running. Nothing survives the tab's lifetime.
import { useSyncExternalStore } from "react";
import {
  ApiError,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import type { OutlinePosition } from "./outline";

export interface WriteRequest {
  readonly path: ApiPath;
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body: unknown;
  /** Endpoints whose links order this write may change (commands: derived). */
  readonly link_refs?: readonly string[];
}
export interface WriteJob<R> {
  build(): WriteRequest | null;
  cancelled?(): boolean;
  cancel?(): void;
  /** Acknowledged queue serial is causal evidence for dependent positions. */
  settle(reply: R, serial: number): void;
  /** Terminal: not sent, rejected, or answered with a defect. */
  fail(error: unknown): void;
  /** Transport doubt: the sealed request stays at the head and is resent. */
  retrying?(error: unknown): void;
  /** Runs once after acknowledgement, refusal, skipped build or callback defect. */
  finalize?(): void;
}
export type WriteStatus = "idle" | "saving" | "retrying";
const KEEPALIVE_LIMIT = 60_000;
/** The BFF refuses larger bodies before the api sees them (vercel's 4.5 MB). */
const BODY_LIMIT = 4_500_000;
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
let accountGeneration = 0;

export function subscribeWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Forced account teardown forgets browser requests and fences late callbacks. */
export function clearWrites(): void {
  accountGeneration += 1;
  queue.length = 0;
  versions.length = 0;
  completedSerial = 0;
  serial = 0;
  running = false;
  wake?.();
  publish("idle");
}

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
/** Resolve an exact local predecessor only from its originating acknowledged
 * insertion. Ordinary positions advance through the same FIFO proof. */
export function sealOutlinePosition(
  ref: string,
  position: OutlinePosition,
  afterSerial: number,
): { sourceRef: string; position: Schema<"Position"> } {
  let sourceRef = ref;
  let base: number;
  let serial = afterSerial;
  if (position.expected_links_version === null) {
    const proof = position.proof;
    if (
      proof.acknowledged === null ||
      (proof.sourceRef !== ref && proof.originSourceRef !== ref)
    )
      throw new ApiError(
        409,
        "E_RESOURCE_CONFLICT",
        "the preceding insertion wasn’t acknowledged",
      );
    sourceRef = proof.sourceRef;
    base = proof.acknowledged.linksVersion;
    serial = proof.acknowledged.serial;
  } else base = position.expected_links_version;
  const version = advanceLinksVersion(sourceRef, base, serial);
  if (version === null)
    throw new ApiError(
      409,
      "E_RESOURCE_CONFLICT",
      "placement changed; review this position again",
    );
  const after =
    position.expected_links_version === null &&
    position.after === position.proof.requestedEdgeId
      ? position.proof.acknowledged!.edgeId
      : position.after;
  return {
    sourceRef,
    position: { after, expected_links_version: version },
  };
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
function commandRefs(body: unknown): string[] {
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
/** A known deletion wakes only a head that its own owner has cancelled. */
export function wakeCancelledWrite(): void {
  if (queue[0]?.job.cancelled?.()) wake?.();
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
  const generation = accountGeneration;
  try {
    while (queue.length) {
      const head = queue[0]!;
      const { job } = head;
      let request: WriteRequest | null;
      let body: string | undefined;
      let bytes = 0;
      try {
        request = job.cancelled?.() ? null : job.build();
        if (request === null && job.cancelled?.()) call(() => job.cancel?.());
        body =
          request === null || request.body === undefined
            ? undefined
            : JSON.stringify(request.body);
        bytes = new TextEncoder().encode(body ?? "").length;
        if (bytes > BODY_LIMIT)
          throw new ApiError(413, "E_INVALID_REQUEST", "this change is too large to save");
      } catch (error) {
        versions.push({ serial: head.serial, facts: [], failedRefs: ["*"] });
        completedSerial = head.serial;
        queue.shift();
        if (!isWriteRejection(error)) reportError(error);
        call(() => job.fail(error));
        call(() => job.finalize?.());
        continue;
      }
      if (request !== null) {
        for (let attempt = 0; ; attempt += 1) {
          if (job.cancelled?.()) {
            call(() => job.cancel?.());
            break;
          }
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
            if (generation !== accountGeneration) return;
            if (reply === undefined && request.method !== "DELETE")
              throw new ApiError(
                200,
                "E_INVALID_RESPONSE",
                "Write returned no acknowledgement",
              );
            data = reply?.data;
          } catch (error) {
            if (generation !== accountGeneration) return;
            if (job.cancelled?.()) {
              call(() => job.cancel?.());
              break;
            }
            if (
              !isApiError(error) ||
              ![0, 429, 502, 503, 504].includes(error.status)
            ) {
              const refs = request.link_refs ?? commandRefs(request.body);
              versions.push({
                serial: head.serial,
                facts: [],
                failedRefs: refs.length || request.link_refs ? [...refs] : ["*"],
              });
              if (!isWriteRejection(error)) reportError(error);
              call(() => job.fail(error));
              break;
            }
            publish("retrying");
            call(() => job.retrying?.(error));
            await pause(Math.min(30_000, 1000 * 2 ** attempt));
            if (generation !== accountGeneration) return;
            continue;
          }
          if (job.cancelled?.()) {
            call(() => job.cancel?.());
            break;
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
          call(() => job.settle(data, head.serial));
          break;
        }
      }
      completedSerial = head.serial;
      queue.shift();
      call(() => job.finalize?.());
    }
  } finally {
    if (generation === accountGeneration) {
      running = false;
      publish("idle");
      if (queue.length) void pump();
    }
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
