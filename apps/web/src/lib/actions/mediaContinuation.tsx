"use client";

/**
 * One account's external-media intention, retained independently of its row or
 * picker. URL admission saves; episode resolution establishes catalogue identity.
 * Placement retains its exact guards through response loss. Nothing survives a
 * reload. Podcast subscription is a separate operation. A refusal reports once; a save
 * that may have gone through stands until it is retried or resolved. Either way the
 * subject's own lectern or library control then carries its recovery.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import type { Line, Verb } from "@/components/feedback/stage";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isApiError, isSameSystemApiDefect, outcomeUnknown, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchBrowsePreview, type BrowsePreview } from "@/lib/browse/api";
import { isAbortError } from "@/lib/errors";
import { publishImportsInvalidation } from "@/lib/imports/api";
import { useImports } from "@/lib/imports/ImportsProvider";
import { acquirePreviewMedia, fetchAcceptedSource, mediaAcquisitionAvailable, type MediaAcceptance } from "@/lib/imports/ingest";
import type { Schema } from "@/lib/api/wire";
import { placements, readAcquisitionGuard, type AcquisitionGuard, type LibraryDestination } from "@/lib/libraries/api";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import { useWorkGuard } from "@/lib/unsavedWork";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

export type MediaDestination = { readonly kind: "All" } | { readonly kind: "Lectern" } | { readonly kind: "Library"; readonly library: LibraryDestination };
export interface MediaContinuation {
  readonly intentId: string;
  readonly subject: Extract<MediaSubject, { kind: "External" }>;
  readonly destination: MediaDestination;
  readonly pickerKey: number | null;
  /** Complete means canonical handoff; a domain command owns any remaining placement. */
  readonly phase: "acquiring" | "resolving" | "applying" | "complete" | "unavailable";
  readonly accepted: MediaAcceptance | null;
  readonly preview: BrowsePreview | null;
  readonly guard: AcquisitionGuard | null;
  readonly finalMediaId: string | null;
  readonly placement: { readonly libraryId: string; readonly body: Schema<"PlaceItemRequest"> } | null;
  readonly failure: ContinuationFailure | null;
  readonly retryRevision: number;
}
/** `unknown`: the save may have gone through. `review`: the next press chooses again rather
 * than resends. `error`: a transport failure, whose reason is the transport's. */
type ContinuationFailure = { readonly line: Line; readonly unknown: boolean; readonly review: boolean; readonly error: ApiError | null };
type Context = Pick<ActionContext, "sessionSignal" | "isActive" | "lectern" | "reportDefect" | "workspace" | "podcasts">;
const destinationLabel = (destination: MediaDestination) => destination.kind === "Lectern" ? "lectern" : destination.kind === "All" ? "All" : destination.library.name;
const addLine = (operation: MediaContinuation, reason?: string): Line =>
  ({ fact: `couldn’t add “${operation.subject.title}” to ${destinationLabel(operation.destination)}.`, reason });
const UNAVAILABLE = (operation: MediaContinuation): ContinuationFailure =>
  ({ line: { fact: `couldn’t save “${operation.subject.title}”.`, reason: "it’s no longer available." }, unknown: false, review: true, error: null });

/** The one recovery a failed continuation offers, wherever it is shown: a library's review
 * opens the picker; anything else sends again. */
export function continuationRecoveryLabel(operation: MediaContinuation, failure: ContinuationFailure): string {
  return failure.review && operation.destination.kind === "Library" ? "choose libraries" : "retry";
}

export function useMediaContinuationOwner(ctx: Context) {
  const placement = useLibraryPlacementController();
  const latest = useRef({ ctx, placement });
  latest.current = { ctx, placement };
  const [operations, setOperations] = useState<readonly MediaContinuation[]>([]);
  const current = useRef(operations);
  const listeners = useRef(new Set<() => void>());
  const guard = useWorkGuard();
  const update = (id: string, change: (operation: MediaContinuation) => MediaContinuation) => {
    current.current = current.current.map(operation => operation.intentId === id ? change(operation) : operation);
    setOperations(current.current);
    for (const listener of listeners.current) listener();
  };
  const get = (id: string) => current.current.find(operation => operation.intentId === id) ?? null;
  const fail = (id: string, error: unknown, write = false) => {
    const { ctx } = latest.current;
    if (!ctx.isActive() || isAbortError(error) || handleUnauthenticatedApiError(error)) return;
    if (!isApiError(error) || isSameSystemApiDefect(error)) {
      ctx.reportDefect({ error });
      return;
    }
    const operation = get(id);
    if (!operation) return;
    const code = isApiError(error) ? error.code : null;
    const unavailable = code === "E_NOT_FOUND" || code === "E_IMPORT_NOT_FOUND";
    const failure: ContinuationFailure = write && outcomeUnknown(error)
      ? { line: { fact: `not sure “${operation.subject.title}” was saved.`, reason: UNKNOWN_OUTCOME_REASON }, unknown: true, review: false, error: null }
      : unavailable ? UNAVAILABLE(operation)
      : code === "E_RESOURCE_CONFLICT" ? { line: addLine(operation, `${destinationLabel(operation.destination)} changed since you chose it.`), unknown: false, review: true, error: null }
      : code === "E_FORBIDDEN" || code === "E_LIBRARY_FORBIDDEN" ? { line: addLine(operation, `you can’t add to ${destinationLabel(operation.destination)}.`), unknown: false, review: true, error: null }
      : { line: operation.accepted === null ? { fact: `couldn’t import “${operation.subject.title}”.` } : addLine(operation), unknown: false, review: false, error };
    update(id, value => ({ ...value, phase: unavailable ? "unavailable" : value.phase, failure }));
  };
  const apply = async (id: string, mediaId: string) => {
    const operation = get(id);
    if (!operation || operation.phase === "complete" || operation.phase === "applying" || !latest.current.ctx.isActive()) return;
    update(id, value => ({ ...value, finalMediaId: mediaId, phase: "applying", failure: null }));
    const { ctx, placement } = latest.current;
    const signal = ctx.sessionSignal();
    try {
      let confirmed: boolean;
      if (!await mediaAcquisitionAvailable(mediaId, signal)) {
        update(id, value => ({ ...value, phase: "unavailable", failure: UNAVAILABLE(value) }));
        return;
      }
      if (operation.accepted?.kind === "Episode" && operation.destination.kind !== "Lectern") {
        const subject = `episode-save:${mediaId}`;
        if (ctx.podcasts.pending(subject) !== null) {
          update(id, value => ({ ...value, phase: "complete", failure: null }));
          if (operation.pickerKey !== null) placement.retargetLibraryPlacement(operation.pickerKey, { kind: "Media", id: mediaId });
          return;
        }
        let request = operation.placement;
        if (request === null) {
          const snapshot = await placements({ kind: "Media", id: mediaId }, signal);
          const libraryId = operation.destination.kind === "Library" ? operation.destination.library.id : snapshot.all_membership.library_id;
          const destination = operation.destination.kind === "All" ? snapshot.all_membership
            : snapshot.placements.find(cell => cell.library_id === libraryId);
          if (destination === undefined || operation.guard === null) throw new Error("resolved episode has no reviewed destination");
          request = { libraryId: destination.library_id, body: { included: true,
            expected_order_revision: destination.order_revision,
            expected_removal_revision: operation.guard.expected_removal_revision } };
          update(id, value => ({ ...value, placement: request }));
        }
        confirmed = await ctx.podcasts.submit({ subject, title: operation.subject.title,
          library: operation.destination.kind === "Library" ? operation.destination.library.name : null,
          shown: () => false,
          command: { kind: "EpisodeSave", mediaId, libraryId: request.libraryId, body: request.body },
          onAccepted: () => {
            if (signal.aborted || !ctx.isActive()) return;
            update(id, value => ({ ...value, phase: "complete", failure: null }));
            if (operation.pickerKey !== null) placement.retargetLibraryPlacement(operation.pickerKey, { kind: "Media", id: mediaId });
          },
        });
        if (signal.aborted || !ctx.isActive()) return;
        if (!confirmed) {
          update(id, value => ({ ...value, phase: "complete", failure: null }));
          if (operation.pickerKey !== null) placement.retargetLibraryPlacement(operation.pickerKey, { kind: "Media", id: mediaId });
          return;
        }
      } else if (operation.destination.kind === "Library") {
        // URL admission filed it; source deduplication transfers only current entries.
        // Never replay that old intent after a later removal or filing change.
        const snapshot = await placements({ kind: "Media", id: mediaId }, signal);
        const libraryId = operation.destination.library.id;
        const cell = snapshot.placements.find(cell => cell.library_id === libraryId);
        confirmed = cell !== undefined && cell.relation !== "Absent";
      } else {
        if (operation.destination.kind !== "Lectern") throw new Error("only episodes can be added directly to all");
        const outcome = await ctx.lectern.ensure({ mediaId, title: operation.subject.title });
        confirmed = outcome === "Acknowledged";
      }
      if (signal.aborted) return;
      if (!confirmed) {
        const library = operation.destination.kind === "Library";
        update(id, value => ({ ...value, failure: { line: addLine(value, library ? `${destinationLabel(value.destination)} changed since you chose it.` : undefined),
          unknown: false, review: library, error: null } }));
        return;
      }
      update(id, value => ({ ...value, phase: "complete", failure: null }));
      if (operation.pickerKey !== null)
        placement.retargetLibraryPlacement(operation.pickerKey, { kind: "Media", id: mediaId });
    } catch (error) { fail(id, error); }
  };
  const acquire = async (id: string) => {
    const operation = get(id);
    if (!operation || operation.accepted !== null) throw new Error("media acquisition is no longer pending");
    const signal = latest.current.ctx.sessionSignal();
    update(id, value => ({ ...value, phase: "acquiring", failure: null, retryRevision: value.retryRevision + 1 }));
    try {
      const accepted = await requestWithDeadline({ signal, timeoutMs: 30_000, request: async requestSignal => {
        const guard = operation.guard ?? await readAcquisitionGuard(
          operation.destination.kind === "Library" ? [operation.destination.library] : [], requestSignal);
        requestSignal.throwIfAborted();
        update(id, value => ({ ...value, guard }));
        const preview = operation.preview ?? await fetchBrowsePreview(operation.subject.target, requestSignal);
        requestSignal.throwIfAborted();
        update(id, value => ({ ...value, preview }));
        return acquirePreviewMedia({ preview,
          guard,
          id: operation.intentId, signal: requestSignal,
          onAccepted: accepted => { if (latest.current.ctx.isActive()) update(id, value => ({ ...value, accepted })); },
        });
      } });
      if (!latest.current.ctx.isActive()) return;
      // Record the exact acceptance before beginning any remaining membership.
      update(id, value => ({ ...value, accepted, phase: "resolving", failure: null }));
      if (!accepted.available) {
        update(id, value => ({ ...value, phase: "unavailable", failure: UNAVAILABLE(value) }));
        return;
      }
      if (accepted.kind === "Episode") void apply(id, accepted.mediaId);
    } catch (error) {
      const current = get(id);
      fail(id, error, current !== null && current.accepted === null && current.guard !== null && current.preview !== null);
    }
  };
  const start = (subject: Extract<MediaSubject, { kind: "External" }>, destination: MediaDestination, pickerKey: number | null) => {
    const held = current.current.find(operation => operation.subject.target === subject.target && operation.phase !== "complete");
    if (held || latest.current.placement.hasPendingExternalCreation(subject.target) || !latest.current.ctx.isActive()) return;
    const operation: MediaContinuation = { intentId: crypto.randomUUID(), subject, destination, pickerKey,
      phase: "acquiring", accepted: null, preview: null, guard: null,
      finalMediaId: null, placement: null, failure: null, retryRevision: 0 };
    current.current = [...current.current.filter(item => item.subject.target !== subject.target), operation];
    setOperations(current.current);
    for (const listener of listeners.current) listener();
    void acquire(operation.intentId);
  };
  useLayoutEffect(() => guard.register({ id: "media-continuations", scope: { kind: "account" },
    subscribe(listener) { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
    read: () => ({ changed: false,
      unconfirmed: current.current.some(operation => operation.phase === "acquiring" && operation.accepted === null && (operation.failure === null || operation.failure.unknown)),
      stopsBrowserWork: current.current.some(operation => operation.phase !== "complete"),
    }),
  }), [guard]);
  const api = {
    operations, start,
    forSubject: (target: string) => operations.find(operation => operation.subject.target === target) ?? null,
    forgetDeletedMedia(mediaId: string) {
      current.current = current.current.filter(operation => operation.phase !== "complete" || operation.finalMediaId !== mediaId);
      setOperations(current.current);
      for (const listener of listeners.current) listener();
    },
    fail,
    resolve(id: string, source: Awaited<ReturnType<typeof fetchAcceptedSource>>) {
      const operation = get(id);
      if (operation?.phase === "resolving" && operation.failure === null && source.settled) void apply(id, source.media_id);
    },
    review(id: string) {
      const operation = get(id);
      if (!operation?.failure?.review || operation.failure.unknown) return;
      current.current = current.current.filter(item => item.intentId !== id);
      setOperations(current.current);
      for (const listener of listeners.current) listener();
      const { placement, ctx } = latest.current;
      if (operation.accepted?.kind === "Episode") {
        const pending = ctx.podcasts.pending(`episode-save:${operation.accepted.mediaId}`);
        if (pending !== null) ctx.podcasts.review(pending.key);
      }
      const paneId = ctx.workspace().state.active_primary_pane_id;
      const anchor = () => findPaneLandmarkFocusTarget(paneId);
      const options = { anchor, returnFocusFallback: anchor };
      if (operation.accepted !== null && operation.phase !== "unavailable" && operation.destination.kind === "Library") {
        placement.openLibraryPlacement([{ kind: "Media", id: operation.finalMediaId ?? operation.accepted.mediaId }], options);
      } else if (operation.destination.kind === "Library") {
        placement.openExternalLibraryPlacement({ target: operation.subject.target, pending: false,
          choose: (library, key) => start(operation.subject, { kind: "Library", library }, key),
        }, options);
      } else start(operation.subject, operation.destination, null);
    },
    retry(id: string) {
      const operation = get(id);
      if (!operation || operation.failure === null || operation.failure.review) return;
      if (operation.accepted === null) void acquire(id);
      else {
        update(id, value => ({ ...value, phase: "resolving", failure: null, retryRevision: value.retryRevision + 1 }));
        if (operation.finalMediaId !== null || operation.accepted.kind === "Episode")
          void apply(id, operation.finalMediaId ?? operation.accepted.mediaId);
      }
    },
  };
  return {
    ...api,
    /** Imports refresh first, so a retry never reads the failure it recovers from. */
    recover(id: string) {
      const failure = get(id)?.failure;
      if (!failure) return;
      publishImportsInvalidation();
      if (failure.review) api.review(id); else api.retry(id);
    },
  };
}

/** The Imports observation clock is retained only while accepted identity needs it. */
export function MediaContinuationHost() {
  const { ctx } = useActionRuntime();
  const { retainObserver } = useImports();
  const owner = ctx.mediaContinuations;
  const resolving = owner.operations.some(operation => operation.phase === "resolving" && operation.failure === null);
  useEffect(() => resolving ? retainObserver() : undefined, [resolving, retainObserver]);
  return <>{owner.operations.map(operation => <ContinuationObservation key={operation.intentId} operation={operation} />)}</>;
}

function ContinuationObservation({ operation }: { readonly operation: MediaContinuation }) {
  const { ctx } = useActionRuntime();
  const imports = useImports();
  const { mediaContinuations: owner } = ctx;
  const attempt = operation.accepted?.kind === "Url" ? operation.accepted.sourceAttemptId : null;
  const resolving = operation.phase === "resolving" && operation.failure === null && attempt !== null;
  const source = usePaneFreeServerValue({
    key: resolving ? `media-continuation:${operation.intentId}:${attempt}` : null,
    stale: `${imports.observation}:${operation.retryRevision}`,
    load: signal => {
      if (attempt === null) throw new Error("source continuation has no accepted attempt");
      return fetchAcceptedSource(attempt, signal);
    },
  });
  useEffect(() => {
    if (!resolving) return;
    if (source.status === "ready") {
      if (source.error !== null) owner.fail(operation.intentId, source.error);
      else owner.resolve(operation.intentId, source.data);
    } else if (source.status === "failed") owner.fail(operation.intentId, source.error);
    const error = imports.summary.status === "failed" && !imports.summary.retrying ? imports.summary.error
      : imports.summary.status === "ready" && !imports.summary.refreshing ? imports.summary.error : null;
    if (source.status === "ready" && !source.data.settled && error !== null) owner.fail(operation.intentId, error);
  }, [source, resolving, imports.summary, owner, operation.intentId]);
  const { say, fail } = useOutcome();
  const failure = operation.failure;
  const recover: Verb | null = failure === null || operation.phase === "unavailable" ? null
    : { label: continuationRecoveryLabel(operation, failure), commandKey: `recover ${operation.intentId}`, run: () => owner.recover(operation.intentId) };
  useEffect(() => {
    if (failure === null || failure.unknown) return;
    return failure.error !== null ? fail(failure.error, failure.line.fact, recover ?? undefined) : say(failure.line, recover ? [recover] : undefined);
    // One report per refusal the owner records, retracted once it resolves or retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: keyed to the failure identity alone
  }, [failure]);
  return failure?.unknown ? <Hold id={operation.intentId} line={failure.line} verbs={recover ? [recover] : undefined} /> : null;
}
