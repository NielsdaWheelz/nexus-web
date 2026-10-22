"use client";

/**
 * One account's external-media intention, retained independently of its row or
 * picker. Import acceptance is a hard boundary: retries after it resolve the
 * accepted source and apply only the remaining membership. Nothing survives a
 * reload. Podcast subscription is a separate operation.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import type { ActionContext } from "@/lib/actions/ResourceActionsProvider";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isApiError, isSameSystemApiDefect, outcomeUnknown, requestWithDeadline } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchBrowsePreview, type BrowsePreview } from "@/lib/browse/api";
import { isAbortError } from "@/lib/errors";
import { useImports } from "@/lib/imports/ImportsProvider";
import { acquirePreviewMedia, fetchAcceptedSource, type AcceptedMediaAcquisition } from "@/lib/imports/ingest";
import type { LibraryDestination } from "@/lib/libraries/api";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { resolveResourceItem } from "@/lib/resources/items";
import { useWorkGuard } from "@/lib/unsavedWork";

export type MediaDestination = { readonly kind: "Lectern" } | { readonly kind: "Library"; readonly library: LibraryDestination };
export interface MediaContinuation {
  readonly intentId: string;
  readonly subject: Extract<MediaSubject, { kind: "External" }>;
  readonly destination: MediaDestination;
  readonly pickerKey: number | null;
  readonly phase: "acquiring" | "resolving" | "applying" | "complete";
  readonly accepted: AcceptedMediaAcquisition | null;
  readonly preview: BrowsePreview | null;
  readonly finalMediaId: string | null;
  readonly failure: { readonly content: FeedbackContent; readonly unknown: boolean } | null;
  readonly retryRevision: number;
  readonly resultLabel: string | null;
}
type Context = Pick<ActionContext, "sessionSignal" | "isActive" | "lectern" | "reportDefect" | "workspace">;
const destinationLabel = (destination: MediaDestination) => destination.kind === "Lectern" ? "lectern" : destination.library.name;

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
  const fail = (id: string, error: unknown) => {
    const { ctx } = latest.current;
    if (!ctx.isActive() || handleUnauthenticatedApiError(error)) return;
    if ((!isApiError(error) && !isAbortError(error)) || isSameSystemApiDefect(error)) {
      ctx.reportDefect({ error });
      return;
    }
    const operation = get(id);
    if (!operation) return;
    const saved = operation.accepted !== null;
    update(id, value => ({ ...value,
      failure: {
      unknown: isAbortError(error) || outcomeUnknown(error),
      content: { tone: "Warning", title: saved
        ? operation.phase === "resolving" ? "saved; resolving item"
          : `saved; not yet ${operation.destination.kind === "Lectern" ? "on lectern" : `in ${operation.destination.library.name}`}`
        : `couldn’t import for ${operation.subject.title}`,
        message: saved ? "the saved item is retained. retry the remaining action."
          : "retry this same request when the source is available.",
        requestId: isApiError(error) ? error.requestId : undefined,
      },
    } }));
  };
  const apply = async (id: string, mediaId: string) => {
    const operation = get(id);
    if (!operation || operation.phase === "complete" || operation.phase === "applying" || !latest.current.ctx.isActive()) return;
    update(id, value => ({ ...value, finalMediaId: mediaId, phase: "applying", failure: null }));
    const { ctx, placement } = latest.current;
    const signal = ctx.sessionSignal();
    try {
      let confirmed: boolean;
      if (operation.destination.kind === "Library")
        confirmed = await placement.addToLibrary({ kind: "Media", id: mediaId }, operation.destination.library.id);
      else {
        const outcome = await ctx.lectern.ensure({ mediaId, title: operation.subject.title });
        confirmed = outcome === "Acknowledged";
      }
      if (signal.aborted) return;
      if (!confirmed) {
        update(id, value => ({ ...value, failure: { unknown: false, content: {
          tone: "Warning", title: `saved; not yet ${operation.destination.kind === "Lectern" ? "on lectern" : `in ${operation.destination.library.name}`}`,
          message: "check the current destination, then retry adding the saved item.",
        } } }));
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
    update(id, value => ({ ...value, phase: "acquiring", failure: null }));
    try {
      const accepted = await requestWithDeadline({ signal, timeoutMs: 30_000, request: async requestSignal => {
        const preview = operation.preview ?? await fetchBrowsePreview(operation.subject.target, requestSignal);
        requestSignal.throwIfAborted();
        update(id, value => ({ ...value, preview }));
        return acquirePreviewMedia({ preview,
          namedLibraryIds: operation.destination.kind === "Library" ? [operation.destination.library.id] : [],
          id: operation.intentId, signal: requestSignal });
      } });
      if (!latest.current.ctx.isActive()) return;
      // Record the exact acceptance before beginning any remaining membership.
      update(id, value => ({ ...value, accepted, phase: "resolving", failure: null }));
      if (accepted.kind === "Episode") void apply(id, accepted.mediaId);
    } catch (error) { fail(id, error); }
  };
  const start = (subject: Extract<MediaSubject, { kind: "External" }>, destination: MediaDestination, pickerKey: number | null) => {
    const held = current.current.find(operation => operation.subject.target === subject.target && operation.phase !== "complete");
    if (held || latest.current.placement.hasPendingExternalCreation(subject.target) || !latest.current.ctx.isActive()) return;
    const operation: MediaContinuation = { intentId: crypto.randomUUID(), subject, destination, pickerKey,
      phase: "acquiring", accepted: null, preview: null,
      finalMediaId: null, failure: null, retryRevision: 0, resultLabel: null };
    current.current = [...current.current.filter(item => item.subject.target !== subject.target), operation];
    setOperations(current.current);
    for (const listener of listeners.current) listener();
    void acquire(operation.intentId);
  };
  useLayoutEffect(() => guard.register({ id: "media-continuations", scope: { kind: "account" },
    subscribe(listener) { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
    read: () => ({ changed: false,
      unconfirmed: current.current.some(operation => operation.phase === "acquiring" && (operation.failure === null || operation.failure.unknown)),
      stopsBrowserWork: current.current.some(operation => operation.phase !== "complete"),
    }),
  }), [guard]);
  return {
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
    retry(id: string) {
      const operation = get(id);
      if (!operation || operation.failure === null) return;
      if (operation.accepted === null) void acquire(id);
      else {
        update(id, value => ({ ...value, phase: "resolving", failure: null, retryRevision: value.retryRevision + 1 }));
        if (operation.finalMediaId !== null || operation.accepted.kind === "Episode")
          void apply(id, operation.finalMediaId ?? operation.accepted.mediaId);
      }
    },
    labelResult(id: string, label: string) { update(id, value => ({ ...value, resultLabel: label })); },
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
  const completed = operation.phase === "complete";
  const label = usePaneFreeServerValue({
    key: completed && operation.resultLabel === null ? `media-continuation-result:${operation.intentId}` : null,
    stale: "",
    load: async signal => (await resolveResourceItem(`media:${operation.finalMediaId}`, signal)).label,
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
  useEffect(() => {
    if (!completed || operation.resultLabel !== null) return;
    if (label.status === "ready") owner.labelResult(operation.intentId, label.data);
    else if (label.status === "failed") owner.labelResult(operation.intentId, "saved item");
  }, [completed, label, owner, operation.intentId, operation.resultLabel]);
  const resultLabel = operation.resultLabel ?? "saved item";
  const href = operation.finalMediaId === null ? null : `/media/${operation.finalMediaId}`;
  const failure = operation.failure;
  useWorkspaceCondition(`media-continuation:${operation.intentId}`, {
    priority: completed ? "Status" : "Write", announcement: "Polite",
    content: failure?.content ?? { tone: completed ? "Success" : "Neutral",
      title: completed ? `added to ${destinationLabel(operation.destination)}: ${resultLabel}`
        : operation.phase === "applying" ? `saved; adding to ${destinationLabel(operation.destination)}`
        : operation.accepted !== null ? "saved; resolving item" : `importing for ${operation.subject.title}`,
    },
    actions: failure !== null ? [{ label: operation.accepted === null ? "retry import"
      : `retry adding to ${destinationLabel(operation.destination)}`,
      onClick: () => { imports.refresh(); owner.retry(operation.intentId); } }]
      : completed && href !== null ? [{ label: `open ${resultLabel}`, href, onActivate: event => activateTargetLink({ event,
        target: { href, labelHint: resultLabel }, runtime: { activateTarget: request => ctx.workspace().activateWorkspaceTarget({
          ...request, originPaneId: ctx.workspace().state.active_primary_pane_id,
        }) },
      }) }] : undefined,
  });
  return null;
}
