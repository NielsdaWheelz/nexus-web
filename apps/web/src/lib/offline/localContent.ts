// The one client of Android's `window.nexusLocalContent` bridge, bundled into the hosted
// workspace and the packaged shelf. Frames carry commands, receipts and invalidations;
// the download index is one fixed local read, never a frame. Where the object is absent
// (desktop, Android < 14) downloads are "not supported on this device".
//
// request {id, op, ...args} -> reply {id, ok: true, revision} | {id, ok: false, error}
// push    {revision}, always before the receipt of the mutation that caused it.
// Revisions are process-monotone decimal strings: an older or other-account index read is
// dropped, and a causal caller waits until the index it can read covers its receipt.
import { useSyncExternalStore } from "react";
import { WIRE_HEADER } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { CursorSnapshot, Locator } from "@/lib/documentReader/model";
import {
  expectArray, expectBoolean, expectCanonicalRfcUuid, expectExactRecord, expectIsoInstant, expectNonnegativeInteger,
  expectNullableString, expectOneOf, expectRecord, expectString,
} from "@/lib/validation";

const KINDS = ["podcast_episode", "pdf", "epub", "web_article"] as const;
export type MediaKind = (typeof KINDS)[number];
const FAILURES = ["AuthorizationRequired", "SourceUnavailable", "Changed", "Storage", "Network", "Server",
  "Invalid", "Stopped", "NeedsDownload", "Scheduler"] as const;
/** `Scheduler`: Android refused to schedule the transfer; `NeedsDownload`: converted audio without a package. */
export type FailureReason = (typeof FAILURES)[number];
/** Optional episode material; audio readiness never waits for it. */
export interface ExtraState {
  readonly kind: "Absent" | "Pending" | "Ready" | "Failed";
  readonly reason: string | null;
}
export type LocalProgress =
  | { readonly kind: "Canonical"; readonly snapshot: CursorSnapshot }
  | {
      readonly kind: "Pending" | "ContentChanged" | "SourceUnavailable";
      readonly baseline: CursorSnapshot;
      readonly device: Locator;
      readonly adopt_unresolved: boolean;
    }
  | {
      readonly kind: "Conflict";
      readonly canonical: CursorSnapshot;
      readonly device: Locator;
      readonly adopt_unresolved: boolean;
    };

export interface LocalItem {
  readonly media_id: string;
  readonly kind: MediaKind;
  readonly title: string;
  readonly state: "Queued" | "Downloading" | "Ready" | "Failed" | "Removing";
  readonly failure: FailureReason | null;
  readonly attempts: number;
  readonly received: number;
  readonly total: number | null;
  readonly size_bytes: number;
  readonly saved_at: string | null;
  /** Non-null only for a Ready reading copy. */
  readonly progress: LocalProgress | null;
  /** The publication generation the device pinned when it saved a reading copy: positive for a
   * Ready copy, whose offsets address exactly it; 0 before publication and for episodes. */
  readonly generation: number;
  /** The immutable acquisition a Ready episode plays; null before publication and for copies. */
  readonly package_id: string | null;
  /** Episodes with a capture (always when Ready); null before capture and for copies. */
  readonly extras: { readonly artwork: ExtraState; readonly transcript: ExtraState } | null;
}

export interface LocalIndex {
  readonly account_id: string;
  readonly revision: string;
  readonly policy: "UnmeteredOnly" | "AnyConnected";
  readonly auth_required: boolean;
  /** Accepted reading saves; unrelated to server observation and index revisions. */
  readonly consumption_revision: number;
  /** In enqueue order. */
  readonly items: readonly LocalItem[];
}

export type EnqueueSubject =
  | { readonly kind: "Episode"; readonly media_id: string; readonly title: string }
  | { readonly kind: "ReadingCopy"; readonly media_id: string; readonly media_kind: Exclude<MediaKind, "podcast_episode">; readonly title: string };

/** Loading is `index === null && error === null`; a failed read keeps the last good index. */
export interface LocalContentState {
  readonly index: LocalIndex | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

interface Port {
  postMessage(frame: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}
type Reply = { readonly id: number; readonly ok: true; readonly revision: string };
type Frame =
  | { readonly revision: string }
  | Reply
  | { readonly id: number; readonly ok: false; readonly error: string };

const port = typeof window === "undefined"
  ? undefined
  : (window as Window & { nexusLocalContent?: Port }).nexusLocalContent;

export const localContentAvailable = port !== undefined;

const EMPTY: LocalContentState = { index: null, error: null };
let state: LocalContentState = EMPTY;
let binding: { readonly accountId: string | null; readonly indexPath: string } | null = null;
let lifetime = 0;
let announced: bigint | null = null;
let reading = false;
let nextId = 1;
const listeners = new Set<() => void>();
const pending = new Map<number, {
  readonly resolve: (reply: Reply) => void;
  readonly reject: (error: Error) => void;
}>();
const waits = new Set<{ readonly revision: bigint; readonly resolve: () => void; readonly reject: (error: Error) => void }>();

function publish(next: LocalContentState): void {
  if (next.index !== null && next.index.consumption_revision !== state.index?.consumption_revision)
    publishChange("Consumption");
  state = next;
  for (const wait of waits) {
    if (next.index !== null && BigInt(next.index.revision) >= wait.revision) {
      waits.delete(wait);
      wait.resolve();
    }
  }
  for (const listener of listeners) listener();
}

function announce(revision: string): void {
  const value = BigInt(revision);
  if (announced === null || value > announced) announced = value;
  void readIndex();
}

function rejectWaits(code: string): void {
  for (const wait of waits) wait.reject(new Error(code));
  waits.clear();
}

const REVISION = /^(0|[1-9][0-9]{0,18})$/;
function expectRevision(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!REVISION.test(value)) throw new TypeError(`${name} must be a decimal revision`);
  return value;
}

function decodeExtra(raw: unknown, name: string): ExtraState {
  const value = expectExactRecord(raw, ["kind", "reason"], name);
  return { kind: expectOneOf(value.kind, ["Absent", "Pending", "Ready", "Failed"] as const, `${name}.kind`),
    reason: expectNullableString(value.reason, `${name}.reason`) };
}

/** Cursor snapshots and locators are the server's reader types, carried through native.
 * justify-type-assertion: native stores them verbatim from the same-deploy server; the
 * reader port owns their semantics, so only their object shape is checked here. */
function decodeProgress(raw: unknown, name: string): LocalProgress | null {
  if (raw === null) return null;
  const kind = expectOneOf(expectRecord(raw, name).kind, ["Canonical", "Pending", "ContentChanged", "SourceUnavailable", "Conflict"] as const, `${name}.kind`);
  if (kind === "Canonical") {
    const value = expectExactRecord(raw, ["kind", "snapshot"], name);
    return { kind, snapshot: expectRecord(value.snapshot, `${name}.snapshot`) as CursorSnapshot };
  }
  if (kind === "Conflict") {
    const value = expectExactRecord(raw, ["kind", "canonical", "device", "adopt_unresolved"], name);
    return { kind, canonical: expectRecord(value.canonical, `${name}.canonical`) as CursorSnapshot,
      device: expectRecord(value.device, `${name}.device`) as Locator, adopt_unresolved: expectBoolean(value.adopt_unresolved, `${name}.adopt_unresolved`) };
  }
  const value = expectExactRecord(raw, ["kind", "baseline", "device", "adopt_unresolved"], name);
  return { kind, baseline: expectRecord(value.baseline, `${name}.baseline`) as CursorSnapshot,
    device: expectRecord(value.device, `${name}.device`) as Locator, adopt_unresolved: expectBoolean(value.adopt_unresolved, `${name}.adopt_unresolved`) };
}

function decodeItem(raw: unknown, index: number): LocalItem {
  const name = `items[${index}]`;
  const value = expectExactRecord(raw, ["media_id", "kind", "title", "state", "failure", "attempts", "received", "total",
    "size_bytes", "saved_at", "progress", "package_id", "extras", "generation"], name);
  const kind = expectOneOf(value.kind, KINDS, `${name}.kind`);
  const state = expectOneOf(value.state, ["Queued", "Downloading", "Ready", "Failed", "Removing"] as const, `${name}.state`);
  const extras = value.extras === null ? null : expectExactRecord(value.extras, ["artwork", "transcript"], `${name}.extras`);
  // Episode extras exist once a capture does (always when Ready); copies never have them.
  if (kind !== "podcast_episode" ? extras !== null : state === "Ready" && extras === null)
    throw new TypeError(`${name}.extras must be present for a ready episode and absent for a copy`);
  const generation = expectNonnegativeInteger(value.generation, `${name}.generation`);
  if (kind !== "podcast_episode" && state === "Ready" && generation === 0)
    throw new TypeError(`${name}.generation must be positive for a ready reading copy`);
  return {
    media_id: expectCanonicalRfcUuid(value.media_id, `${name}.media_id`),
    kind,
    title: expectString(value.title, `${name}.title`),
    state,
    failure: value.failure === null ? null : expectOneOf(value.failure, FAILURES, `${name}.failure`),
    attempts: expectNonnegativeInteger(value.attempts, `${name}.attempts`),
    received: expectNonnegativeInteger(value.received, `${name}.received`),
    total: value.total === null ? null : expectNonnegativeInteger(value.total, `${name}.total`),
    size_bytes: expectNonnegativeInteger(value.size_bytes, `${name}.size_bytes`),
    saved_at: value.saved_at === null ? null : expectIsoInstant(value.saved_at, `${name}.saved_at`),
    progress: decodeProgress(value.progress, `${name}.progress`),
    package_id: value.package_id === null ? null : expectCanonicalRfcUuid(value.package_id, `${name}.package_id`),
    generation,
    extras: extras === null ? null : { artwork: decodeExtra(extras.artwork, `${name}.extras.artwork`), transcript: decodeExtra(extras.transcript, `${name}.extras.transcript`) },
  };
}

/** Strict at the native boundary: malformed bytes are a typed local error, never an empty index. */
function decodeIndex(raw: unknown): LocalIndex {
  const value = expectExactRecord(raw, ["account_id", "revision", "policy", "auth_required", "consumption_revision", "items"], "downloads");
  return {
    account_id: expectCanonicalRfcUuid(value.account_id, "account_id"),
    revision: expectRevision(value.revision, "revision"),
    policy: expectOneOf(value.policy, ["UnmeteredOnly", "AnyConnected"] as const, "policy"),
    auth_required: expectBoolean(value.auth_required, "auth_required"),
    consumption_revision: expectNonnegativeInteger(value.consumption_revision, "consumption_revision"),
    items: expectArray(value.items, decodeItem, "items"),
  };
}

async function fetchIndex(path: string): Promise<LocalIndex | { readonly code: string; readonly message: string }> {
  const io = { code: "E_LOCAL_CONTENT_IO", message: "downloads couldn’t be read" };
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(path, { cache: "no-store", headers: { [WIRE_HEADER]: String(WIRE_REVISION) } });
    body = await response.json();
  } catch {
    return io;
  }
  try {
    if (response.ok) return decodeIndex(body);
    const error = expectExactRecord(expectExactRecord(body, ["error"], "error body").error, ["code", "message"], "error");
    return { code: expectString(error.code, "error.code"), message: expectString(error.message, "error.message") };
  } catch {
    return { code: "E_LOCAL_CONTENT_INVALID", message: "downloads couldn’t be read" };
  }
}

/** One flight; it reads until the index covers the newest announcement. */
async function readIndex(): Promise<void> {
  if (reading || binding === null) return;
  reading = true;
  const mine = lifetime;
  const { accountId, indexPath } = binding;
  try {
    while (announced !== null && (state.index === null || BigInt(state.index.revision) < announced)) {
      const wanted = announced;
      const read = await fetchIndex(indexPath);
      if (mine !== lifetime) return;
      if (!("revision" in read)) {
        publish({ index: state.index, error: read });
        rejectWaits(read.code);
        return;
      }
      // A retired account's index never replaces this document's; retirement clears its waits.
      if (accountId !== null && read.account_id !== accountId) return;
      if (state.index === null || BigInt(read.revision) >= BigInt(state.index.revision)) publish({ index: read, error: null });
      if (BigInt(read.revision) < wanted && announced === wanted) {
        // Native announced a revision its own index does not cover.
        publish({ index: state.index, error: { code: "E_LOCAL_CONTENT_INVALID", message: "downloads couldn’t be read" } });
        rejectWaits("E_LOCAL_CONTENT_INVALID");
        return;
      }
    }
  } finally {
    if (mine === lifetime) reading = false;
  }
}

/** Strict at the native boundary: every frame is a push, a receipt or a refusal. */
function decodeFrame(data: unknown): Frame {
  const value = expectRecord(JSON.parse(expectString(data, "frame")), "frame");
  if (!("id" in value)) return { revision: expectRevision(expectExactRecord(value, ["revision"], "push").revision, "push.revision") };
  const id = expectNonnegativeInteger(value.id, "frame.id");
  if (!expectBoolean(value.ok, "frame.ok")) return { id, ok: false, error: expectString(expectExactRecord(value, ["id", "ok", "error"], "frame").error, "frame.error") };
  expectExactRecord(value, ["id", "ok", "revision"], "frame");
  return { id, ok: true, revision: expectRevision(value.revision, "frame.revision") };
}

/** Subscribes this document; `accountId` null (the shelf) accepts the bound account.
 * Retirement rejects every pending command and wait; later frames of the retired
 * lifetime are dropped, so no old-account receipt resolves after it. */
export function connectLocalContent(input: { readonly accountId: string | null; readonly indexPath: string }): () => void {
  if (port === undefined) return () => {};
  const mine = ++lifetime;
  binding = input;
  port.onmessage = (event) => {
    if (mine !== lifetime) return;
    const frame = decodeFrame(event.data);
    if (!("id" in frame)) {
      announce(frame.revision);
      return;
    }
    const reply = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.ok) reply?.resolve(frame);
    else reply?.reject(new Error(frame.error));
  };
  void localCall("hello").then((reply) => announce(reply.revision), () => undefined);
  return () => {
    if (mine !== lifetime) return;
    lifetime += 1;
    binding = null;
    announced = null;
    reading = false;
    port.onmessage = null;
    for (const command of pending.values()) command.reject(new Error("Retired"));
    pending.clear();
    rejectWaits("Retired");
    state = EMPTY;
    for (const listener of listeners) listener();
  };
}

/** Rejects with `Error(code)`, e.g. `Storage`, `Unsupported`, `NotFound`, `Invalid`, `Retired`. */
export function localCall(
  op: string,
  args: Record<string, unknown> = {},
): Promise<Reply> {
  if (port === undefined) return Promise.reject(new Error("Unsupported"));
  if (binding === null) return Promise.reject(new Error("Retired"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage(JSON.stringify({ ...args, id, op }));
  });
}

/** Resolves once the readable index covers the mutation's durable receipt. */
export async function localMutation(op: string, args: Record<string, unknown>): Promise<void> {
  const receipt = (await localCall(op, args)).revision;
  const revision = BigInt(receipt);
  if (state.index !== null && BigInt(state.index.revision) >= revision) return;
  await new Promise<void>((resolve, reject) => {
    waits.add({ revision, resolve, reject });
    announce(receipt);
  });
}

export function currentLocalContent(): LocalContentState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocalContent(): LocalContentState {
  return useSyncExternalStore(subscribe, currentLocalContent, () => EMPTY);
}

/** The Ready episode's downloaded acquisition, independent of catalog and remote reads. */
export function readyEpisode(index: LocalIndex | null, mediaId: string): (LocalItem & { readonly package_id: string }) | null {
  const item = index?.items.find(candidate => candidate.media_id === mediaId);
  return item?.kind === "podcast_episode" && item.state === "Ready" && item.package_id !== null
    ? { ...item, package_id: item.package_id } : null;
}
