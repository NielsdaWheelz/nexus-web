"use client";

/**
 * The intake (docs/modules/imports.md): one document's lines, each one thing coming in, from
 * enter until it is readable, behind every door. The provider owns the store, the send
 * queue and the work guard, above the workspace's boundary, so work outlives every surface;
 * it publishes a defect and throws nothing. The host, inside the workspace, throws that
 * defect, owns the one library creation, reads the truth of accepted lines on the Imports
 * clock, opens what was armed, and raises a settled batch's slip.
 */

import OpmlImportDialog from "@/components/feeds/OpmlImportDialog";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Hold, useOutcome, type Outcome } from "@/components/feedback/Feedback";
import { verbsForTransport, type Line, type Verb, type Verbs } from "@/components/feedback/stage";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import { publishChange } from "@/lib/api/changes";
import { admissionRefusal, apiFetch, isApiError, isRefusal, isSameSystemApiDefect, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { transportOf, type Transport } from "@/lib/api/failure";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { truncateText } from "@/lib/display/format";
import { isAbortError } from "@/lib/errors";
import { fetchImportDetail, publishImportsInvalidation, UploadSessionError, type SafeFailureCode, type UploadSessionOutcome } from "@/lib/imports/api";
import { reasonLine } from "@/lib/imports/copy";
import { acceptUrl, createUploadAttempt, fetchAcceptedSource, getFileUploadKind, removeUploadSession, reviewUploadAttempt, uploadFileRefusal, uploadIngestFile, type UploadAttempt, type UploadFileKind } from "@/lib/imports/ingest";
import { useImports } from "@/lib/imports/ImportsProvider";
import { batchSlip, linePhase, pointer, type SlipVerb } from "@/lib/imports/lineView";
import { acquisitionGuard, libraryDestinations, type AcquisitionGuard, type LibraryDestination } from "@/lib/libraries/api";
import { remoteAttemptAllowed } from "@/lib/native/admission";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";

/** Most links or files one admission takes; a door says so in its own `Field`. */
export const ADMIT_LIMIT = 100;

export type IntakeSource =
  | { readonly kind: "Link"; readonly url: string }
  /** `file` is null once accepted, since nothing sends it again, or when a share could
   * not stream it. An unreadable share can also have unknown size. */
  | { readonly kind: "File"; readonly name: string; readonly sizeBytes: number | null; readonly file: File | null };

/** What the server says of an accepted line. Readable, Failed and Removed are settled. */
export type Truth =
  | { readonly kind: "Sent" }
  | { readonly kind: "Queued" }
  | { readonly kind: "Processing" }
  | { readonly kind: "Readable"; readonly summary: Schema<"MediaSummaryOut"> }
  | { readonly kind: "Failed"; readonly code: SafeFailureCode | null; readonly reason: string | null }
  | { readonly kind: "Removed" };

/** Why nothing was accepted, each answer the spec's line states name. */
export type LineRefusal =
  | { readonly kind: "Changed" }
  /** `unfiled`: the line's libraries no earlier line of its batch files the same address to. */
  | { readonly kind: "Active"; readonly unfiled: readonly LibraryDestination[] }
  /** `missing`: the line's libraries a reread no longer offers; empty when it could not tell. */
  | { readonly kind: "LibraryGone"; readonly missing: readonly LibraryDestination[] }
  | { readonly kind: "Ambiguous" }
  | { readonly kind: "Deleting" }
  | { readonly kind: "Declared"; readonly code: "E_INVALID_REQUEST" | "E_X_ARTICLE_POST_LINK_REQUIRED" | "E_X_IDENTITY_CONFLICT" }
  | { readonly kind: "Verification"; readonly code: "E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" }
  | { readonly kind: "FileChanged" }
  /** A refusal nexus never declared for this call; nothing landed. */
  | { readonly kind: "Undeclared" }
  /** A sent line answered before any route ran. */
  | { readonly kind: "Handoff"; readonly transport: "SignIn" | "Update" }
  /** Not sent. */
  | { readonly kind: "Offline" }
  /** Acquisition did not run: its destinations read, admission or pre-route auth held it. */
  | { readonly kind: "NoStart"; readonly transport: Exclude<Transport, "Offline"> }
  /** The bytes are in storage, but admission or pre-route auth held the check. The same
   * session's confirmation can still go. */
  | { readonly kind: "CheckHeld"; readonly transport: Transport }
  | { readonly kind: "WrongType" }
  | { readonly kind: "TooBig"; readonly fileKind: UploadFileKind }
  | { readonly kind: "Empty" }
  | { readonly kind: "Nameless" }
  | { readonly kind: "NameTooLong" }
  /** The bytes never all arrived, so nothing imported. */
  | { readonly kind: "BytesLost" }
  /** Nexus could not prepare the put; storage was asked nothing. */
  | { readonly kind: "NotPrepared" }
  /** A first confirm met a storage failure before it could publish. */
  | { readonly kind: "NotChecked" }
  | { readonly kind: "Expired" }
  | { readonly kind: "Superseded" }
  | { readonly kind: "Unreadable" };

export type LineStage =
  | { readonly kind: "Waiting" }
  | { readonly kind: "Sending" }
  | { readonly kind: "Uploading"; readonly sentBytes: number }
  | { readonly kind: "Verifying" }
  /** `href` opens it: a link's waits in its accepted-source pane until settled. */
  | { readonly kind: "Accepted"; readonly mediaId: string; readonly importRef: string; readonly href: string; readonly created: boolean; readonly truth: Truth }
  | { readonly kind: "Refused"; readonly refusal: LineRefusal }
  /** It may have gone through; a retry replays the same id and guard. */
  | { readonly kind: "Unknown" };

export interface IntakeLine {
  readonly id: string;
  readonly source: IntakeSource;
  /** Where it files, beside All; frozen at enter. */
  readonly into: readonly LibraryDestination[];
  readonly batch: string;
  readonly openOnAccept: "Follow" | "Fork" | null;
  readonly stage: LineStage;
}

export interface Admission {
  readonly links: readonly string[];
  readonly files: readonly File[];
  readonly opml?: readonly File[];
  /** Shared files the device named but could not stream. */
  readonly unreadable?: readonly { readonly name: string; readonly sizeBytes: number | null }[];
  /** Default: the intake's `into`, with any library being created for it. */
  readonly into?: readonly LibraryDestination[];
  /** Opens the first line once it is accepted. */
  readonly open?: "Follow" | "Fork";
}

/** A line's queue state, which no surface reads. */
type Entry = IntakeLine & {
  /** A link's from-url id: replayed while its guard stands, minted again with a new guard. */
  readonly attemptId: string;
  readonly guard: AcquisitionGuard | null;
  readonly upload: UploadAttempt | null;
  readonly sourceAttemptId: string | null;
  /** Waiting to replay a send whose answer was lost, which may have landed: its id, guard
   * and confirmation go out unchanged, so no batch reread re-freezes it. */
  readonly replay: boolean;
};

/** An admission waiting on a library create, holding its visit's `into` from when it was
 * entered; a library created during that visit joins it. */
type Deferral = { readonly input: Admission & { readonly into: readonly LibraryDestination[] }; readonly visit: object | null };

type State = {
  readonly opml: readonly { readonly id: string; readonly file: File }[];
  readonly lines: readonly IntakeLine[];
  readonly field: string;
  readonly fieldLine: Line | null;
  /** A public admission this visit, including one waiting on library creation. */
  readonly hasAdmitted: boolean;
  readonly into: readonly LibraryDestination[];
  /** Waiting, sending, uploading or verifying: the guard's browser work. */
  readonly running: number;
  /** Running, plus accepted and not yet settled: the rail's and root row's count. */
  readonly unsettled: number;
  readonly defect: { readonly error: unknown } | null;
  readonly showing: boolean;
  /** First observed whole-batch settlement; retrying drops it until settled again. */
  readonly settledAt: ReadonlyMap<string, number>;
  /** Batches whose held slip stands: settled with an unknown, while no surface showed them. */
  readonly held: readonly string[];
};

type Host = {
  open(target: WorkspaceTarget, disposition: "Follow" | "Fork"): void;
  settled(lines: readonly IntakeLine[]): void;
};

const ANSWER_MS = 30_000;
const EMPTY: State = { opml: [], lines: [], field: "", fieldLine: null, hasAdmitted: false, into: [], running: 0, unsettled: 0, defect: null, showing: false, settledAt: new Map(), held: [] };

/** The address the server keys a link by: no fragment, normalized host. */
const address = (url: string) => { const parsed = new URL(url); parsed.hash = ""; return parsed.href; };
const sameLibraries = (a: readonly LibraryDestination[], b: readonly LibraryDestination[]) =>
  a.length === b.length && a.every(library => b.some(other => other.id === library.id));
const fileOf = (line: Entry) => line.source.kind === "File" ? line.source.file : null;

/** An upload's confirm that admission held at its turn: the confirm never left. */
class ConfirmHeld extends Error {
  constructor(readonly transport: Transport) { super("confirm held unsent"); }
}

function createIntake(guard: WorkGuard, creation: ReturnType<typeof createDestinationCreation>) {
  const listeners = new Set<() => void>();
  let state = EMPTY;
  let entries: readonly Entry[] = [];
  let opml: State["opml"] = [];
  /** Ids waiting to be sent, oldest first. */
  let queue: readonly string[] = [];
  let field = "";
  let fieldLine: Line | null = null;
  let hasAdmitted = false;
  let into: readonly LibraryDestination[] = [];
  let defect: State["defect"] = null;
  let deferred: readonly Deferral[] = [];
  /** Only an open palette has a visit; a closed retry cannot select for a later visit. */
  let visit: object | null = null;
  /** The visit each library create's latest send began in, keyed by the `onCreated` the
   * intake gave it, which its attempt carries: a retry or a retyped name in a later visit
   * sends for that visit. */
  const sentIn = new WeakMap<(destination: LibraryDestination) => void, object | null>();
  let showing = false;
  let lifetime: AbortController | null = null;
  let host: Host | null = null;
  let outcome: Outcome | null = null;
  let freezing = false;
  let linkSending = false;
  let filesSending = 0;
  const stops = new Map<string, AbortController>();
  /** The account's one acquisition step at a time: a link's accept or an upload's confirm,
   * both serializable under the viewer lock, where a waiter always loses an attempt. */
  let slot: Promise<unknown> = Promise.resolve();
  let truthRunning = false;
  let truthAgain = false;
  let settledBatches = new Map<string, number>();
  /** Settled while no surface showed it: its slip was raised, or is held. */
  let unseen = new Set<string>();
  /** Accepted something since its last drain: drained, it invalidates Imports once more. */
  let accepting = new Set<string>();

  const alive = (scope: AbortController) => lifetime === scope && !scope.signal.aborted;
  const get = (id: string) => entries.find(line => line.id === id) ?? null;

  function publish() {
    const batches = new Map<string, Entry[]>();
    for (const line of entries) batches.set(line.batch, [...batches.get(line.batch) ?? [], line]);
    accepting = new Set([...accepting].filter(batch => batches.has(batch)));
    const settledNow = new Map<string, number>();
    for (const [batch, lines] of batches) {
      const phases = lines.map(line => linePhase(line.stage));
      if (accepting.has(batch) && !phases.includes("Running")) {
        accepting.delete(batch);
        publishImportsInvalidation();
        publishChange("Entries");
      }
      if (phases.some(phase => phase !== "Settled")) continue;
      settledNow.set(batch, settledBatches.get(batch) ?? Date.now());
      if (settledBatches.has(batch) || showing) continue;
      unseen.add(batch);
      host?.settled(lines);
    }
    settledBatches = settledNow;
    unseen = new Set([...unseen].filter(batch => settledNow.has(batch)));
    const running = entries.filter(line => linePhase(line.stage) === "Running").length;
    state = {
      opml, lines: entries, field, fieldLine, hasAdmitted, into, defect, running, showing, settledAt: settledNow,
      unsettled: entries.filter(line => linePhase(line.stage) !== "Settled").length,
      held: showing ? [] : [...unseen].filter(batch => batches.get(batch)!.some(line => line.stage.kind === "Unknown")),
    };
    for (const listener of listeners) listener();
  }

  function update(id: string, change: (line: Entry) => Entry) {
    entries = entries.map(line => line.id === id ? change(line) : line);
    publish();
  }
  const settle = (id: string, stage: Extract<LineStage, { kind: "Refused" | "Unknown" }>) =>
    update(id, line => ({ ...line, stage, openOnAccept: null }));
  const refuse = (id: string, refusal: LineRefusal) => settle(id, { kind: "Refused", refusal });

  /** This acquisition did not run; that cannot answer an earlier unanswered send. */
  function didNotRun(line: Entry, refusal: LineRefusal) {
    if (line.upload === null ? line.replay : line.upload.confirmation_unsettled) settle(line.id, { kind: "Unknown" });
    else refuse(line.id, refusal);
  }

  function publishDefect(error: unknown) {
    defect ??= { error };
    publish();
  }
  /** The modeled api error; null after an abort or a defect, which is published. */
  function modeled(error: unknown): ApiError | null {
    if (isAbortError(error)) return null;
    if (isApiError(error) && !isSameSystemApiDefect(error)) return error;
    publishDefect(error);
    return null;
  }

  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const turn = slot.then(run);
    slot = turn.catch(() => undefined);
    return turn;
  }

  /** An acquisition that did not run, by the transport that held it. */
  const notSent = (transport: Transport): LineRefusal => transport === "Offline" ? { kind: "Offline" } : { kind: "NoStart", transport };
  /** Why a send must not go out now: offline, or the refusal `apiFetch` would throw unsent. */
  function held(): Transport | null {
    if (navigator.onLine === false) return "Offline";
    return remoteAttemptAllowed() ? null : transportOf(admissionRefusal());
  }

  function pump() {
    const scope = lifetime;
    if (scope === null || !alive(scope) || defect !== null) return;
    if (!freezing && entries.some(line => line.stage.kind === "Waiting" && line.guard === null)) void freeze(scope);
    const ready = (kind: IntakeSource["kind"]) => queue.map(get)
      .find(line => line !== null && line.source.kind === kind && line.stage.kind === "Waiting" && line.guard !== null) ?? null;
    const take = (line: Entry) => { queue = queue.filter(id => id !== line.id); return line.id; };
    const link = linkSending ? null : ready("Link");
    if (link !== null) void sendLink(take(link), scope);
    for (let file = ready("File"); file !== null && filesSending < 2; file = ready("File")) void sendFile(take(file), scope);
  }

  /** Enter: one destinations read freezes every waiting line's guard, its removal revision
   * and its libraries. A failed read is the start that never happened. */
  async function freeze(scope: AbortController) {
    freezing = true;
    const ids = entries.filter(line => line.stage.kind === "Waiting" && line.guard === null).map(line => line.id);
    try {
      const { removal_revision } = await requestWithDeadline({ signal: scope.signal, timeoutMs: ANSWER_MS, request: libraryDestinations });
      if (!alive(scope)) return;
      entries = entries.map(line => ids.includes(line.id) && line.stage.kind === "Waiting" && line.guard === null
        ? { ...line, guard: acquisitionGuard(line.into, removal_revision) } : line);
      publish();
    } catch (error) {
      if (!alive(scope)) return;
      const failure = modeled(error);
      if (failure === null) return;
      for (const id of ids) if (get(id)?.stage.kind === "Waiting") refuse(id, notSent(transportOf(failure)));
    } finally {
      if (alive(scope)) { freezing = false; pump(); }
    }
  }

  async function sendLink(id: string, scope: AbortController) {
    linkSending = true;
    try {
      await exclusive(async () => {
        const line = get(id);
        if (!alive(scope) || line === null || line.stage.kind !== "Waiting" || line.guard === null || line.source.kind !== "Link") return;
        const holding = held();
        if (holding !== null) return didNotRun(line, notSent(holding));
        const { source: { url }, guard, attemptId } = line;
        update(id, current => ({ ...current, stage: { kind: "Sending" } }));
        try {
          const answer = await requestWithDeadline({ signal: scope.signal, timeoutMs: ANSWER_MS,
            request: signal => acceptUrl({ url, guard, id: attemptId, signal }) });
          if (alive(scope)) accept(id, scope, { mediaId: answer.media_id, importRef: answer.import_ref,
            sourceAttemptId: answer.source_attempt_id, created: answer.created, removed: false });
        } catch (error) {
          if (alive(scope)) await fail(id, error, scope);
        }
      });
    } finally {
      linkSending = false;
      if (alive(scope)) pump();
    }
  }

  async function sendFile(id: string, scope: AbortController) {
    filesSending += 1;
    const stop = new AbortController();
    stops.set(id, stop);
    try {
      const line = get(id);
      const file = line === null ? null : fileOf(line);
      if (!alive(scope) || line === null || file === null || line.upload === null || line.guard === null) return;
      const holding = held();
      if (holding !== null) return didNotRun(line, line.upload.bytes_uploaded ? { kind: "CheckHeld", transport: holding } : notSent(holding));
      const at = (stage: LineStage) => { if (alive(scope) && !stop.signal.aborted) update(id, current => ({ ...current, stage })); };
      at({ kind: "Sending" });
      try {
        const accepted = await uploadIngestFile({ file, attempt: line.upload, guard: line.guard,
          // the confirm may start long after the put, so its turn asks admission again
          exclusive: run => exclusive(() => { const holding = held(); return holding === null ? run() : Promise.reject(new ConfirmHeld(holding)); }),
          signal: AbortSignal.any([scope.signal, stop.signal]),
          onPhaseChange: phase => at(phase === "Uploading" ? { kind: "Uploading", sentBytes: 0 } : phase === "Verifying" ? { kind: "Verifying" } : { kind: "Sending" }),
          onProgress: sentBytes => at({ kind: "Uploading", sentBytes }) });
        if (alive(scope)) accept(id, scope, { mediaId: accepted.mediaId, importRef: accepted.importRef,
          sourceAttemptId: null, created: accepted.created, removed: !accepted.available });
      } catch (error) {
        if (alive(scope) && !stop.signal.aborted) await fail(id, error, scope);
      }
    } finally {
      stops.delete(id);
      filesSending -= 1;
      if (alive(scope)) pump();
    }
  }

  function accept(id: string, scope: AbortController, answer: { mediaId: string; importRef: string; sourceAttemptId: string | null; created: boolean; removed: boolean }) {
    const line = get(id);
    if (line === null) return;
    const href = answer.sourceAttemptId === null ? `/media/${answer.mediaId}`
      : `/media/${answer.mediaId}?source_attempt_id=${encodeURIComponent(answer.sourceAttemptId)}`;
    const first = !accepting.has(line.batch);
    accepting.add(line.batch);
    // a batch's first acceptance starts the Imports clock; its drain, in publish, wakes it again
    update(id, current => ({ ...current, sourceAttemptId: answer.sourceAttemptId, openOnAccept: null,
      source: current.source.kind === "File" ? { ...current.source, file: null } : current.source,
      stage: { kind: "Accepted", mediaId: answer.mediaId, importRef: answer.importRef, href, created: answer.created,
        truth: answer.removed ? { kind: "Removed" } : { kind: "Sent" } } }));
    if (first && accepting.has(line.batch)) {
      publishImportsInvalidation();
      publishChange("Entries");
    }
    if (line.openOnAccept !== null && !answer.removed) host?.open({ href, labelHint: pointer(line) }, line.openOnAccept);
    if (host !== null) void truth(scope);
  }

  /** Every answer a send can meet lands on its line; only a defect reaches the boundary. */
  async function fail(id: string, error: unknown, scope: AbortController) {
    const line = get(id);
    if (line === null || isAbortError(error)) return;
    if (error instanceof ConfirmHeld) return didNotRun(line, { kind: "CheckHeld", transport: error.transport });
    const confirming = line.stage.kind === "Verifying";
    if (error instanceof UploadSessionError) return line.upload?.confirmation_unsettled
      ? settle(id, { kind: "Unknown" }) : uploadFail(line, error.outcome, confirming, scope);
    if (!isApiError(error) || isSameSystemApiDefect(error)) {
      settle(id, { kind: "Unknown" });
      return publishDefect(error);
    }
    const transport = transportOf(error);
    if (transport === "SignIn" || transport === "Update") return didNotRun(line, { kind: "Handoff", transport });
    if (error.code === "E_AUTH_UNAVAILABLE") return didNotRun(line, confirming ? { kind: "CheckHeld", transport } : notSent(transport));
    if (!isRefusal(error)) {
      // without an unsettled confirmation, a pre-confirm failure published nothing
      if (line.source.kind === "File" && !line.upload?.confirmation_unsettled) return refuse(id, { kind: "BytesLost" });
      settle(id, { kind: "Unknown" });
      return;
    }
    switch (error.code) {
      case "E_RESOURCE_CONFLICT": return refuse(id, { kind: "Changed" });
      case "E_SOURCE_IMPORT_ACTIVE": return refuse(id, { kind: "Active", unfiled: unfiled(line) });
      case "E_SOURCE_TARGET_AMBIGUOUS": return refuse(id, { kind: "Ambiguous" });
      case "E_MEDIA_DELETING": return refuse(id, { kind: "Deleting" });
      case "E_LIBRARY_NOT_FOUND": case "E_FORBIDDEN": case "E_LIBRARY_FORBIDDEN": return libraryGone(line, scope);
      case "E_INVALID_REQUEST": case "E_X_ARTICLE_POST_LINK_REQUIRED": case "E_X_IDENTITY_CONFLICT":
        // a file's malformed create or confirm is this client's, not the address's
        if (line.source.kind === "Link") return refuse(id, { kind: "Declared", code: error.code });
    }
    console.warn(JSON.stringify({ event: "import_refusal_undeclared", code: error.code, request_id: error.requestId ?? null }));
    refuse(id, { kind: "Undeclared" });
  }

  async function uploadFail(line: Entry, cause: UploadSessionOutcome, confirming: boolean, scope: AbortController) {
    // a sent line holds its file, which admit found to be a pdf or an epub
    const tooBig = () => ({ kind: "TooBig", fileKind: getFileUploadKind(fileOf(line)!)! }) as const;
    switch (cause.kind) {
      case "VerificationRejected":
        return refuse(line.id, cause.code === "E_SOURCE_INTEGRITY" || cause.code === "E_INVALID_FILE_TYPE"
          ? { kind: "Verification", code: cause.code } : tooBig());
      case "FileTooLarge": return refuse(line.id, tooBig());
      case "UnsupportedFileType": return refuse(line.id, { kind: "WrongType" });
      case "BytesMissing": return refuse(line.id, { kind: "BytesLost" });
      case "Expired": return refuse(line.id, { kind: "Expired" });
      case "Superseded": return refuse(line.id, { kind: "Superseded" });
      case "FileMismatch": return refuse(line.id, { kind: "FileChanged" });
      case "LibraryForbidden": return libraryGone(line, scope);
      case "Unresolved":
        if (!confirming) return refuse(line.id, { kind: "NotPrepared" });
        return refuse(line.id, { kind: "NotChecked" });
      case "IntentMalformed":
        console.warn(JSON.stringify({ event: "import_refusal_undeclared", outcome: cause.kind }));
        return refuse(line.id, { kind: "Undeclared" });
    }
  }

  /** The codes carry no library, so one reread names the line's libraries now missing. */
  async function libraryGone(line: Entry, scope: AbortController) {
    let missing: readonly LibraryDestination[] = [];
    try {
      const { destinations } = await requestWithDeadline({ signal: scope.signal, timeoutMs: ANSWER_MS, request: libraryDestinations });
      missing = line.into.filter(library => !destinations.some(present => present.id === library.id));
    } catch (error) {
      if (!alive(scope) || modeled(error) === null) return;
    }
    if (alive(scope)) refuse(line.id, { kind: "LibraryGone", missing });
  }

  /** An earlier accepted line for the same address and libraries already filed them. */
  function unfiled(line: Entry): readonly LibraryDestination[] {
    if (line.source.kind !== "Link") return line.into;
    const batch = entries.filter(other => other.batch === line.batch);
    const target = address(line.source.url);
    return batch.slice(0, batch.indexOf(line)).some(other => other.stage.kind === "Accepted" && other.source.kind === "Link" && address(other.source.url) === target
      && sameLibraries(other.into, line.into)) ? [] : line.into;
  }

  /** Truth for accepted, unsettled lines, one pass at a time: where each link landed,
   * following supersession, then each media's summary, and for a failure its reason. */
  async function truth(scope: AbortController) {
    if (truthRunning) { truthAgain = true; return; }
    truthRunning = true;
    try {
      do {
        truthAgain = false;
        await truthPass(scope.signal);
      } while (truthAgain && alive(scope) && host !== null);
    } catch (error) {
      // a failed read waits for the next clock advance
      if (alive(scope)) modeled(error);
    } finally {
      truthRunning = false;
    }
  }

  /** Applies to a line still accepted, unsettled and at `mediaId`. */
  function accepted(id: string, mediaId: string, change: (stage: Extract<LineStage, { kind: "Accepted" }>) => LineStage) {
    update(id, line => line.stage.kind === "Accepted" && line.stage.mediaId === mediaId && linePhase(line.stage) === "Accepted"
      ? { ...line, stage: change(line.stage) } : line);
  }

  /** Every read answers within ANSWER_MS. A line whose own read fails waits for the next
   * clock advance and holds no other line back; a failed summaries read fails the pass. */
  async function truthPass(signal: AbortSignal) {
    // freeze membership, not identity: arrivals wait for their own source read next pass.
    // a failed source read sits this pass out because its last media may no longer be its own.
    const reading = new Set(entries.filter(line => linePhase(line.stage) === "Accepted").map(line => line.id));
    const open = () => entries.flatMap(line => line.stage.kind === "Accepted" && linePhase(line.stage) === "Accepted" && reading.has(line.id) ? [{ line, stage: line.stage }] : []);
    const links = open().flatMap(({ line, stage }) => line.sourceAttemptId === null ? [] : [{ id: line.id, attempt: line.sourceAttemptId, mediaId: stage.mediaId }]);
    const sources = await runBoundedTasks({ items: links, concurrency: 2,
      run: link => requestWithDeadline({ signal, timeoutMs: ANSWER_MS, request: signal => fetchAcceptedSource(link.attempt, signal) }) });
    sources.forEach((source, index) => {
      const { id, attempt, mediaId } = links[index]!;
      if (source.kind === "Fulfilled")
        accepted(id, mediaId, stage => ({ ...stage, mediaId: source.value.media_id, importRef: source.value.import_ref,
          href: `/media/${source.value.media_id}?source_attempt_id=${encodeURIComponent(attempt)}` }));
      else if (isApiError(source.error) && source.error.status === 404) accepted(id, mediaId, stage => ({ ...stage, truth: { kind: "Removed" } }));
      else if (isApiError(source.error) && !isSameSystemApiDefect(source.error)) reading.delete(id);
      else throw source.error;
    });
    const ids = [...new Set(open().map(({ stage }) => stage.mediaId))];
    for (let start = 0; start < ids.length; start += 100) {
      const { data } = await requestWithDeadline({ signal, timeoutMs: ANSWER_MS, request: signal =>
        apiFetch<ApiJson<"/media/summaries/resolve", "post">>("/api/media/summaries/resolve", {
          method: "POST", body: JSON.stringify({ media_ids: ids.slice(start, start + 100) }), signal,
        }) });
      for (const { media_id, summary } of data.items) {
        for (const { line, stage } of open().filter(({ stage }) => stage.mediaId === media_id)) {
          const truth: Truth | null = summary === null ? { kind: "Removed" }
            : summary.processing_status === "pending" ? { kind: "Queued" }
            : summary.processing_status === "extracting" ? { kind: "Processing" }
            : summary.processing_status === "ready_for_reading" ? { kind: "Readable", summary }
            : await failedTruth(stage.importRef, summary, signal);
          if (truth !== null) accepted(line.id, media_id, current => ({ ...current, truth }));
        }
      }
    }
  }

  /** A failed or dead run: readable still if a copy can be read or played, else its reason.
   * Null when the detail read failed: the line waits for the next pass. */
  async function failedTruth(importRef: string, summary: Schema<"MediaSummaryOut">, signal: AbortSignal): Promise<Truth | null> {
    try {
      const { item } = await requestWithDeadline({ signal, timeoutMs: ANSWER_MS, request: signal => fetchImportDetail(importRef, signal) });
      if (item.can_read || item.can_play) return { kind: "Readable", summary };
      const code = item.obligations.source?.failure_code ?? null;
      return code === "E_MEDIA_NOT_FOUND" ? { kind: "Removed" } : { kind: "Failed", code, reason: reasonLine(item) };
    } catch (error) {
      if (isApiError(error) && error.status === 404) return { kind: "Removed" };
      if (isApiError(error) && !isSameSystemApiDefect(error)) return null;
      throw error;
    }
  }

  function admitBatch(input: Admission) {
    const scope = lifetime;
    if (scope === null || !alive(scope)) return;
    // an admission into the visit's libraries waits while one is being created, to join it
    if (input.into === undefined && creation.getSnapshot().pending.some(attempt => attempt.sending)) {
      deferred = [...deferred, { input: { ...input, into }, visit }];
      publish();
      return;
    }
    const batch = crypto.randomUUID();
    const libraries = input.into ?? into;
    // a link already listed, fragment and all, adds no line; `#one` and `#two` are two
    const listed = new Set(entries.flatMap(line => line.source.kind === "Link" ? [line.source.url] : []));
    const line = (source: IntakeSource, stage: LineStage): Entry => ({
      id: crypto.randomUUID(), source, into: libraries, batch, openOnAccept: null, stage,
      attemptId: crypto.randomUUID(), guard: null, sourceAttemptId: null, replay: false,
      upload: source.kind === "File" && source.file !== null ? createUploadAttempt() : null,
    });
    const added: Entry[] = [];
    for (const link of input.links) {
      const url = new URL(link).href;
      if (listed.has(url)) continue;
      listed.add(url);
      added.push(line({ kind: "Link", url }, { kind: "Waiting" }));
    }
    for (const file of input.files) {
      const refusal = uploadFileRefusal(file);
      const source = { kind: "File", name: file.name, sizeBytes: file.size, file } as const;
      added.push(line(source, refusal === null ? { kind: "Waiting" }
        : { kind: "Refused", refusal: refusal === "TooBig" ? { kind: "TooBig", fileKind: getFileUploadKind(file)! } : { kind: refusal } }));
    }
    for (const { name, sizeBytes } of input.unreadable ?? [])
      added.push(line({ kind: "File", name, sizeBytes, file: null }, { kind: "Refused", refusal: { kind: "Unreadable" } }));
    const first = added[0];
    if (input.open !== undefined && first?.stage.kind === "Waiting") added[0] = { ...first, openOnAccept: input.open };
    entries = [...added, ...entries];
    queue = [...queue, ...added.filter(entry => entry.stage.kind === "Waiting").map(entry => entry.id)];
    publish();
    pump();
  }

  function admitDeferred() {
    if (creation.getSnapshot().pending.some(attempt => attempt.sending)) return;
    const waiting = deferred;
    deferred = [];
    for (const { input } of waiting) admitBatch(input);
  }

  /** Deferred admissions have no line id yet; every selection or exit disarms them. */
  function disarmExcept(id: string | null) {
    entries = entries.map(line => line.id !== id && line.openOnAccept !== null ? { ...line, openOnAccept: null } : line);
    deferred = deferred.map(waiting => {
      const { open: _open, ...input } = waiting.input;
      return { ...waiting, input };
    });
    publish();
  }

  function enqueue(lines: readonly Entry[]) {
    const ids = new Set(lines.map(line => line.id));
    entries = entries.map(line => ids.has(line.id) ? lines.find(next => next.id === line.id)! : line);
    queue = [...queue.filter(id => !ids.has(id)), ...ids];
    publish();
    pump();
  }
  /** The same id, guard and session again. A line once unknown may have landed, so it stays
   * a replay until it is re-frozen. */
  const resent = (line: Entry): Entry => ({ ...line, stage: { kind: "Waiting" }, replay: line.replay || line.stage.kind === "Unknown" });
  /** A fresh guard at the next freeze: a link takes a fresh id, an upload keeps its session
   * and generation once an authoritative refusal opened it to review. */
  const refrozen = (line: Entry): Entry => {
    if (line.upload !== null) reviewUploadAttempt(line.upload);
    return { ...line, stage: { kind: "Waiting" }, guard: null, attemptId: crypto.randomUUID(), replay: false };
  };
  const refusalOf = (line: Entry) => line.stage.kind === "Refused" ? line.stage.refusal.kind : null;

  function reselect(id: string, file: File) {
    const line = get(id);
    if (line === null || refusalOf(line) !== "Expired") return;
    const refusal = uploadFileRefusal(file);
    const next: Entry = { ...line, source: { kind: "File", name: file.name, sizeBytes: file.size, file }, upload: createUploadAttempt() };
    if (refusal === null) return enqueue([refrozen(next)]);
    entries = entries.map(entry => entry.id === id ? next : entry);
    refuse(id, refusal === "TooBig" ? { kind: "TooBig", fileKind: getFileUploadKind(file)! } : { kind: refusal });
  }

  function drop(id: string) {
    entries = entries.filter(line => line.id !== id);
    queue = queue.filter(entry => entry !== id);
    publish();
  }

  function removeSession(sessionId: string, name: string) {
    removeUploadSession(sessionId).catch(error => {
      if (modeled(error) === null) return;
      // the bytes stopped and the line left; the upload stays in imports
      const retry: Verb = { label: "retry", commandKey: `import-stop:${sessionId}`, run: () => removeSession(sessionId, name) };
      outcome?.fail(error, `couldn’t remove “${name}” from imports.`, retry);
    });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => state,
    creation,
    /** A new library create's `onCreated`: the library joins `into` while the visit its
     * latest send began in lasts, and that visit's waiting admissions either way. */
    created() {
      const joined = (destination: LibraryDestination) => {
        const during = sentIn.get(joined);
        sentIn.delete(joined);
        if (during === null || during === undefined) return;
        const join = (libraries: readonly LibraryDestination[]) => libraries.some(library => library.id === destination.id) ? libraries : [...libraries, destination];
        if (during === visit) into = join(into);
        deferred = deferred.map(waiting => waiting.visit === during ? { ...waiting, input: { ...waiting.input, into: join(waiting.input.into) } } : waiting);
        publish();
      };
      return joined;
    },
    setOutcome(next: Outcome) { outcome = next; },
    start() {
      const scope = new AbortController();
      lifetime = scope;
      const release = guard.register({
        id: "import-intake", scope: { kind: "account" },
        subscribe(listener) {
          listeners.add(listener);
          const unsubscribe = creation.subscribe(listener);
          return () => { listeners.delete(listener); unsubscribe(); };
        },
        read: () => ({
          changed: opml.length > 0,
          unconfirmed: creation.readUnconfirmed() || entries.some(line => ["Sending", "Verifying", "Unknown"].includes(line.stage.kind)),
          stopsBrowserWork: state.running > 0,
        }),
      });
      // a send publishes as it begins, so its visit is the open one. a create that lands
      // leaves the snapshot, keeping its entry, then calls onCreated, which joins the library
      // to the waiting admissions, so they run a microtask later
      const unsubscribe = creation.subscribe(() => {
        for (const attempt of creation.getSnapshot().pending)
          if (!attempt.sending) sentIn.delete(attempt.onCreated);
          else if (!sentIn.has(attempt.onCreated)) sentIn.set(attempt.onCreated, visit);
        queueMicrotask(admitDeferred);
      });
      return () => {
        scope.abort();
        release();
        unsubscribe();
        if (lifetime !== scope) return;
        lifetime = null;
        entries = []; opml = []; queue = []; deferred = []; field = ""; fieldLine = null; hasAdmitted = false; into = []; visit = null;
        freezing = false; linkSending = false; filesSending = 0; showing = false;
        settledBatches = new Map(); unseen = new Set(); accepting = new Set();
        publish();
      };
    },
    attach(next: Host) {
      host = next;
      if (lifetime !== null && entries.some(line => linePhase(line.stage) === "Accepted")) void truth(lifetime);
      return () => { if (host === next) host = null; };
    },
    observe() {
      if (host !== null && lifetime !== null && entries.some(line => linePhase(line.stage) === "Accepted")) void truth(lifetime);
    },
    setShown(next: boolean) {
      if (showing === next) return;
      showing = next;
      if (showing) unseen = new Set();
      publish();
    },
    setField(text: string) { field = text; fieldLine = null; publish(); },
    setFieldLine(line: Line | null) { fieldLine = line; publish(); },
    setInto(next: readonly LibraryDestination[]) { into = next; publish(); },
    dismissOpml() { opml = opml.slice(1); publish(); },
    admit(input: Admission) {
      if (lifetime === null || !alive(lifetime) || input.links.length + input.files.length + (input.opml?.length ?? 0) + (input.unreadable?.length ?? 0) === 0) return;
      const sources = [...input.opml ?? [], ...input.files.filter(file => /\.opml$/i.test(file.name) || /opml/i.test(file.type))];
      if (sources.length > 0) { opml = [...opml, ...sources.map(file => ({ id: crypto.randomUUID(), file }))]; input = { ...input, files: input.files.filter(file => !sources.includes(file)) }; publish(); }
      if (input.links.length + input.files.length + (input.unreadable?.length ?? 0) === 0) return;
      hasAdmitted = true;
      if (input.files.length > 0 || (input.unreadable?.length ?? 0) > 0) fieldLine = null;
      admitBatch(input);
    },
    retry(id: string) {
      const line = get(id);
      if (line === null) return;
      if (line.stage.kind === "Unknown") return enqueue([resent(line)]);
      if (line.stage.kind !== "Refused") return;
      const batch = entries.filter(other => other.batch === line.batch);
      switch (line.stage.refusal.kind) {
        // one reread re-freezes the batch: a removal must not cost a press per line
        case "Changed": return enqueue(batch.filter(other => refusalOf(other) === "Changed" || other.stage.kind === "Waiting" && !other.replay).map(refrozen));
        // acquisition or check did not run, so one press sends the held lines again: a held confirm sends
        // its session's confirm. an id goes out with one guard only, so a line holding one
        // resends what it may have sent before, perhaps as an unknown's replay; a line whose
        // freeze failed holds none and reads afresh
        case "Offline": case "NoStart": case "CheckHeld":
          return enqueue(batch.filter(other => refusalOf(other) === "Offline" || refusalOf(other) === "NoStart" || refusalOf(other) === "CheckHeld")
            .map(other => other.guard === null ? refrozen(other) : resent(other)));
        case "LibraryGone": return enqueue([refrozen(line)]);
        case "Active": case "Undeclared": case "BytesLost": case "NotPrepared": case "NotChecked": return enqueue([resent(line)]);
        case "Expired": {
          const file = fileOf(line);
          return file === null ? undefined : reselect(id, file);
        }
        case "Ambiguous": case "Deleting": case "Declared": case "Verification": case "FileChanged": case "Handoff":
        case "WrongType": case "TooBig": case "Empty": case "Nameless": case "NameTooLong": case "Superseded": case "Unreadable":
          return;
      }
    },
    /** Drops every library the refusal found missing, then sends again with a fresh guard. */
    retryWithout(id: string) {
      const line = get(id);
      if (line?.stage.kind !== "Refused" || line.stage.refusal.kind !== "LibraryGone") return;
      const missing = line.stage.refusal.missing;
      enqueue([refrozen({ ...line, into: line.into.filter(library => !missing.some(gone => gone.id === library.id)) })]);
    },
    reselect,
    /** Stops an upload's bytes and removes its session; the line leaves. */
    stop(id: string) {
      const line = get(id);
      if (line?.stage.kind !== "Uploading") return;
      stops.get(id)?.abort();
      drop(id);
      const session = line.upload?.session ?? null;
      if (session !== null) removeSession(session.session_id, pointer(line));
    },
    /** A waiting or settled line leaves; forgetting an unknown one, or its waiting replay,
     * asks first. */
    remove(id: string) {
      const line = get(id);
      if (line === null) return;
      const forgets = line.stage.kind === "Unknown" ? "dismiss" : line.stage.kind === "Waiting" && line.replay ? "remove" : null;
      if (forgets !== null && !window.confirm(`${forgets} “${pointer(line)}”? it may not have gone through.`)) return;
      if (line.stage.kind === "Waiting" || linePhase(line.stage) === "Settled") drop(id);
    },
    arm(id: string, disposition: "Follow" | "Fork") {
      const line = get(id);
      if (line !== null && linePhase(line.stage) === "Running") update(id, current => ({ ...current, openOnAccept: disposition }));
    },
    disarmExcept,
    beginVisit() { visit = {}; },
    /** The visit's end: the field and `into` reset, and what is done leaves. */
    endVisit() {
      field = "";
      fieldLine = null;
      hasAdmitted = false;
      into = [];
      visit = null;
      entries = entries.filter(line => !(line.stage.kind === "Accepted" && (line.stage.truth.kind === "Readable" || line.stage.truth.kind === "Removed")
        || refusalOf(line) === "Superseded"));
      queue = queue.filter(id => get(id) !== null);
      disarmExcept(null);
    },
  };
}

type Intake = ReturnType<typeof createIntake>;
const IntakeContext = createContext<Intake | null>(null);
/** The `into` chooser's creation. A created library joins `into` through the intake, so
 * `admit` takes no `onCreated`. */
type ImportCreation = Omit<ReturnType<typeof useDestinationCreation>, "admit"> & {
  admit(input: { name: string; scope: string }): boolean;
};
const CreationContext = createContext<ImportCreation | null>(null);

/** Above the workspace's boundary, keyed on the account: share mounts it alone. */
export function ImportIntakeProvider({ accountId, children }: { accountId: string | null; children: ReactNode }) {
  return <IntakeProvider key={accountId}>{children}</IntakeProvider>;
}

function IntakeProvider({ children }: { children: ReactNode }) {
  const guard = useWorkGuard();
  const [creation] = useState(createDestinationCreation);
  const intake = useMemo(() => createIntake(guard, creation), [guard, creation]);
  const outcome = useOutcome();
  useLayoutEffect(() => intake.setOutcome(outcome), [intake, outcome]);
  useLayoutEffect(() => intake.start(), [intake]);
  return <IntakeContext value={intake}>{children}</IntakeContext>;
}

function useIntake(): Intake {
  const intake = useContext(IntakeContext);
  if (intake === null) throw new Error("ImportIntakeProvider is missing");
  return intake;
}

export function useImportIntake() {
  const intake = useIntake();
  const state = useSyncExternalStore(intake.subscribe, intake.snapshot, intake.snapshot);
  return {
    lines: state.lines, field: state.field, fieldLine: state.fieldLine, hasAdmitted: state.hasAdmitted,
    into: state.into, running: state.running, unsettled: state.unsettled, defect: state.defect,
    settledAt: (batch: string): number | null => state.settledAt.get(batch) ?? null,
    setField: intake.setField, setFieldLine: intake.setFieldLine, setInto: intake.setInto, admit: intake.admit, retry: intake.retry, retryWithout: intake.retryWithout,
    reselect: intake.reselect, stop: intake.stop, remove: intake.remove, arm: intake.arm, disarmExcept: intake.disarmExcept, beginVisit: intake.beginVisit, endVisit: intake.endVisit,
  };
}

/** The controller owns presentation before mount and through close. Its setters publish
 * that choice synchronously; speech observes every intake publication, not coalesced renders. */
export function useImportPresentation(readShown: () => boolean, onSettled: (lines: readonly IntakeLine[], at: number) => void) {
  const intake = useIntake();
  const latest = useRef({ readShown, onSettled });
  useLayoutEffect(() => { latest.current = { readShown, onSettled }; });
  useLayoutEffect(() => {
    intake.setShown(latest.current.readShown());
    let previous = intake.snapshot();
    const unsubscribe = intake.subscribe(() => {
      const next = intake.snapshot();
      const before = previous;
      previous = next;
      if (!next.showing) return;
      for (const [batch, at] of next.settledAt) {
        if (!before.settledAt.has(batch)) latest.current.onSettled(next.lines.filter(line => line.batch === batch), at);
      }
    });
    return () => { unsubscribe(); intake.setShown(false); };
  }, [intake]);
  return intake.setShown;
}

/** The `into` chooser's one library creation; the host's. */
export function useImportCreation(): ImportCreation {
  const creation = useContext(CreationContext);
  if (creation === null) throw new Error("ImportIntakeHost is missing");
  return creation;
}

/** Inside the workspace, below Imports: `openPage` opens the surface that shows lines. */
export function ImportIntakeHost({ openPage, children }: { openPage: () => void; children: ReactNode }) {
  const intake = useIntake();
  const state = useSyncExternalStore(intake.subscribe, intake.snapshot, intake.snapshot);
  if (state.defect !== null) throw state.defect.error;
  const destinations = useDestinationCreation("import-intake", intake.creation);
  const creation: ImportCreation = { ...destinations, admit: ({ name, scope }) => destinations.admit({ name, scope, onCreated: intake.created() }) };
  const { observation, retainObserver } = useImports();
  const outcome = useOutcome();
  const workspace = useLatestWorkspace();
  // justify-polling: an accepted line's truth (where it landed, whether it reads, why it
  // failed) has no push plane, so each Imports clock advance, every 5 s while it is retained,
  // rereads only the accepted, unsettled lines. Retention ends when the last one settles.
  const waiting = state.unsettled > state.running;
  useEffect(() => waiting ? retainObserver() : undefined, [waiting, retainObserver]);
  useEffect(() => intake.observe(), [intake, observation]);

  function activate(target: WorkspaceTarget, intent: OpenIntent | "Follow" | "Fork") {
    const current = workspace();
    return current.activateWorkspaceTarget({ originPaneId: current.state.active_primary_pane_id, target,
      disposition: { kind: intent === "new_pane" || intent === "Fork" ? "Fork" : "Follow" } });
  }
  function verbsOf(verb: SlipVerb, lines: readonly IntakeLine[]): Verbs | null {
    const key = `import-slip:${lines[0]!.batch}`;
    const see: Verb = { label: "see", commandKey: `${key}:see`, run: openPage };
    switch (verb.kind) {
      case "Open": return [{ label: "open", commandKey: `${key}:open`, run: intent => activate(verb.target, intent) }];
      case "SeeWhy": case "AllImports": return [{ label: verb.label, commandKey: `${key}:${verb.kind}`, run: intent => activate(verb.target, intent) }];
      case "OpenOriginal": return [{ label: verb.label, href: verb.href, target: "_blank" }];
      case "Retry": return [{ label: verb.label, commandKey: `${key}:retry`, run: () => {
        for (const line of lines) if (lines.length === 1 || line.stage.kind === "Unknown") intake.retry(line.id);
      } }];
      case "RetryWithout": return [{ label: verb.label, commandKey: `${key}:without`, run: () => intake.retryWithout(lines[0]!.id) }];
      case "Reload": return verbsForTransport("Update", { signIn: null });
      case "See": case "Arm": case "ChooseAgain": case "SignIn": return [see];
    }
  }
  const latest = useRef({ outcome, verbsOf, activate });
  useLayoutEffect(() => { latest.current = { outcome, verbsOf, activate }; });
  useLayoutEffect(() => intake.attach({
    open(target, disposition) {
      if (latest.current.activate(target, disposition).kind !== "Cancelled") return;
      latest.current.outcome.say({ fact: `didn’t open · ${truncateText(target.labelHint ?? target.href, 120)}` },
        [{ label: "open", commandKey: `import-open:${target.href}`, run: intent => latest.current.activate(target, intent) }]);
    },
    settled(lines) {
      const slip = batchSlip(lines);
      if (slip !== null && slip.weight === "Plain") latest.current.outcome.say(slip.line, latest.current.verbsOf(slip.verb, lines) ?? undefined);
    },
  }), [intake]);

  return <CreationContext value={creation}>
    {children}
    {state.opml[0] ? <OpmlImportDialog key={state.opml[0].id} input={{ kind: "File", file: state.opml[0].file }} onClose={intake.dismissOpml} /> : null}
    {destinations.holds}
    {state.held.map(batch => {
      const lines = state.lines.filter(line => line.batch === batch);
      const slip = batchSlip(lines)!;
      return <Hold key={batch} id={`import-batch:${batch}`} line={slip.line} verbs={verbsOf(slip.verb, lines) ?? undefined} />;
    })}
  </CreationContext>;
}
