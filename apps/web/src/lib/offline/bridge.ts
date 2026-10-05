// The one client of Android's `window.nexusOffline` bridge, bundled into both
// the hosted app and the packaged shelf. Both ends ship in the same release
// train, so frames are trusted json: no versions, no decoders. The object's
// name is the compatibility identity; where it is absent (desktop, Android
// < 14, an older apk) offline is "not supported on this device".
//
// request {id, op, ...args} -> reply {id, ok: true, ...} | {id, ok: false, error}
// push    {snapshot}, always before the reply to the op that caused it.
import { useSyncExternalStore } from "react";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";

export type MediaKind = "podcast_episode" | "pdf" | "epub" | "web_article";
export type FailureReason =
  | "AuthorizationRequired" | "SourceUnavailable" | "Changed" | "Storage"
  | "Network" | "Server" | "Invalid" | "Stopped";

export interface OfflineItem {
  readonly mediaId: string;
  readonly kind: MediaKind;
  readonly title: string;
  readonly state: "Queued" | "Downloading" | "Ready" | "Failed" | "Removing";
  readonly failure: FailureReason | null;
  readonly attempts: number;
  readonly received: number;
  readonly total: number | null;
  readonly sizeBytes: number;
  readonly savedAt: string | null;
  /** Non-null only for a Ready reading copy. */
  readonly progress: ReaderProgressView | null;
}

export interface OfflineSnapshot {
  readonly policy: "UnmeteredOnly" | "AnyConnected";
  readonly authRequired: boolean;
  /** In enqueue order. */
  readonly items: readonly OfflineItem[];
}

type Frame =
  | { readonly snapshot: OfflineSnapshot }
  | ({ readonly id: number; readonly ok: true } & Record<string, unknown>)
  | { readonly id: number; readonly ok: false; readonly error: string };

interface Port {
  postMessage(frame: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

const port = typeof window === "undefined"
  ? undefined
  : (window as Window & { nexusOffline?: Port }).nexusOffline;

export const offlineAvailable = port !== undefined;

let snapshot: OfflineSnapshot | null = null;
let connected = false;
let nextId = 1;
const listeners = new Set<() => void>();
const pending = new Map<number, {
  readonly resolve: (reply: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}>();

function publish(next: OfflineSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Says hello once per document; the hosted app names its account, the shelf does not. */
export function connectOffline(accountId?: string): void {
  if (port === undefined || connected) return;
  connected = true;
  port.onmessage = (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    if (!("id" in frame)) {
      publish(frame.snapshot);
      return;
    }
    const reply = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.ok) reply?.resolve(frame);
    else reply?.reject(new Error(frame.error));
  };
  void offlineCall("hello", accountId === undefined ? {} : { accountId }).then(
    (reply) => publish(reply.snapshot as OfflineSnapshot),
    () => undefined,
  );
}

/** Rejects with `Error(code)`, e.g. `Storage`, `Unsupported`, `NotFound`. */
export function offlineCall(
  op: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (port === undefined) return Promise.reject(new Error("Unsupported"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage(JSON.stringify({ ...args, id, op }));
  });
}

/** The latest pushed snapshot, for code that acts after a reply (the shelf's progress port). */
export function currentOfflineSnapshot(): OfflineSnapshot | null {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Null until `hello` has replied. */
export function useOfflineSnapshot(): OfflineSnapshot | null {
  return useSyncExternalStore(subscribe, currentOfflineSnapshot, () => null);
}
