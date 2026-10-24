"use client";

// One destination owns resolution, positioning and paint. A visit remembers the
// intent before claiming its delivery, so mobile unmount cannot consume it.
// Acknowledgement retires replay, never the mounted inspection's signal. Failure
// occurrences stay out of the visit; current status separates waiting work from
// a settled refusal that reading input must preserve.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson } from "@/lib/api/wire";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneRouteModel";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { SourceArrivalTarget, SourceTarget } from "@/lib/resources/sourceTarget";
import type { ReaderDestination } from "@/lib/documentReader/location";
import type { ChatFindDestination } from "@/lib/chat/findDestination";
import { getInteractionOwner, hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";

interface ArrivalIntent {
  readonly activationId: string;
  readonly target: SourceArrivalTarget;
  readonly purpose: "Open" | "RestoreVisit";
  readonly phase: "Pending" | "Applied" | "Retired";
  readonly sourceIdentity: string | null;
}
const ARRIVAL = definePaneVisitDataKey<ArrivalIntent>("Source.Inspection");

export interface SourceArrivalContext {
  readonly activationId: string;
  readonly signal: AbortSignal;
  readonly restored: boolean;
  mayFocus(target?: HTMLElement): boolean;
}

export type SourceArrivalApplyTarget =
  | { readonly kind: "source"; readonly source: SourceTarget }
  | { readonly kind: "reader_destination"; readonly destination: ReaderDestination }
  | { readonly kind: "chat_destination"; readonly destination: ChatFindDestination; readonly leaf_id: string };

export type SourceArrivalOutcome = "Applied" | "Unavailable" | "Cancelled" | "FailureHandled";
export interface SourceArrivalFailure {
  readonly title: string;
  readonly error: ApiError | null;
}
interface ArrivalStatus {
  readonly visitId: string;
  readonly activationId: string;
  readonly sourceIdentity: string | null;
  readonly pending: boolean;
  readonly failure: SourceArrivalFailure | null;
}

export function useSourceArrival(input: {
  readonly ready: boolean;
  readonly sourceIdentity: string | null;
  /** Only the destination reader can decide whether its copied view was restored. */
  readonly restoreVisit?: {
    readonly visitId: string;
    readonly sourceIdentity: string | null;
    readonly outcome: "Pending" | "Restored" | "Absent" | "Failed";
  };
  readonly apply: (target: SourceArrivalApplyTarget, context: SourceArrivalContext) => Promise<SourceArrivalOutcome>;
  readonly onAttempt?: (signal: AbortSignal, target: SourceArrivalTarget) => void;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "useSourceArrival");
  const active = usePaneIsActive();
  const mobile = useIsMobileViewport();
  const workspace = useLatestWorkspace();
  const captured = useRef<ArrivalIntent | null>(null);
  const saved = usePaneVisitData(ARRIVAL, () => captured.current);
  const write = usePaneVisitDataWriter(ARRIVAL);
  const [owned, setOwned] = useState({ visitId: runtime.visitId, intent: saved });
  const intent = owned.visitId === runtime.visitId ? owned.intent : saved;
  captured.current = intent;
  const [status, setStatus] = useState<ArrivalStatus | null>(null);
  const currentStatus = useRef<ArrivalStatus | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const latest = useRef({ runtime, input });
  latest.current = { runtime, input };
  const operation = useRef<AbortController | null>(null);
  const focusLease = useRef<{ activationId: string; owned: boolean } | null>(null);
  const freshFocus = useRef<string | null>(null);

  const publishStatus = useCallback((next: ArrivalStatus | null) => {
    currentStatus.current = next;
    setStatus(next);
  }, []);
  const remember = useCallback((next: ArrivalIntent | null) => {
    captured.current = next;
    write(next);
    setOwned({ visitId: latest.current.runtime.visitId, intent: next });
  }, [write]);
  const clear = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    remember(null);
    publishStatus(null);
  }, [publishStatus, remember]);
  const dismissFailure = useCallback((expected: SourceArrivalFailure) => {
    const status = currentStatus.current;
    const intent = captured.current;
    if (!intent || status?.visitId !== latest.current.runtime.visitId ||
        status.activationId !== intent.activationId || status.failure !== expected) return;
    remember({ ...intent, phase: "Retired" });
    publishStatus(null);
  }, [publishStatus, remember]);
  const supersede = useCallback(({ preserveSignal, retireFailure }: {
    preserveSignal: AbortSignal | null;
    retireFailure: boolean;
  }) => {
    if (preserveSignal !== null && operation.current?.signal === preserveSignal) return;
    const intent = captured.current;
    const status = currentStatus.current;
    if (!intent) return;
    const matching = status?.visitId === latest.current.runtime.visitId && status.activationId === intent.activationId;
    if (intent.phase === "Pending" && (!matching || status.pending)) {
      operation.current?.abort();
      remember({ ...intent, phase: "Retired" });
      publishStatus(null);
    } else if (retireFailure && (intent.phase === "Applied" || matching && status.failure !== null)) {
      operation.current?.abort();
      remember({ ...intent, phase: "Retired" });
      publishStatus(null);
    }
  }, [publishStatus, remember]);

  useLayoutEffect(() => {
    const delivery = runtime.paneEntryDelivery;
    if (delivery?.entry.kind !== "InspectSource") return;
    const next: ArrivalIntent = { activationId: delivery.activationId, target: delivery.entry.target, purpose: delivery.entry.purpose, phase: "Pending", sourceIdentity: null };
    write(next);
    if (!runtime.claimPaneEntryDelivery(delivery)) return;
    if (mobile && !(next.target.kind === "reader_destination" && next.target.destination.target.kind === "evidence_item")) runtime.closeSecondaryPane({ restoreFocus: false });
    operation.current?.abort();
    operation.current = null;
    freshFocus.current = next.activationId;
    captured.current = next;
    setOwned({ visitId: runtime.visitId, intent: next });
  }, [mobile, runtime, write]);

  const activationId = intent?.activationId ?? null;
  const { ready, sourceIdentity } = input;
  const restoreOutcome = input.restoreVisit?.outcome ?? null;
  useLayoutEffect(() => () => {
    operation.current?.abort();
    operation.current = null;
  }, [activationId, runtime.visitId]);
  useLayoutEffect(() => {
    if (!activationId) { focusLease.current = null; return; }
    const lease = { activationId, owned: freshFocus.current === activationId };
    freshFocus.current = null;
    focusLease.current = lease;
    const release = (event?: Event) => {
      if (event && !isNavigationAttention(event)) return;
      lease.owned = false;
      for (const event of NAVIGATION_ATTENTION_EVENTS) window.removeEventListener(event, release, true);
    };
    for (const event of NAVIGATION_ATTENTION_EVENTS) window.addEventListener(event, release, { capture: true, passive: true });
    return () => {
      release();
    };
  }, [activationId, runtime.visitId]);
  useEffect(() => {
    const intent = captured.current;
    if (!intent || intent.activationId !== activationId || intent.phase === "Retired") return;
    const visitId = runtime.visitId;
    const previous = currentStatus.current;
    const admitted = previous?.visitId === visitId && previous.activationId === intent.activationId;
    if (admitted && previous.failure !== null && previous.sourceIdentity === sourceIdentity) return;
    if (intent.purpose === "RestoreVisit") {
      if (!ready) return;
      const decision = latest.current.input.restoreVisit;
      if (decision && (decision.visitId !== visitId || decision.sourceIdentity !== sourceIdentity || decision.outcome === "Pending")) return;
      if (decision?.outcome === "Restored" || decision?.outcome === "Failed") {
        remember({ ...intent, sourceIdentity, phase: decision.outcome === "Restored" ? "Applied" : "Retired" });
        publishStatus({ visitId, activationId: intent.activationId, sourceIdentity, pending: false,
          // A failed copied-view attempt remains with the reader's navigation failure.
          failure: null });
        return;
      }
    }
    if (!admitted || !operation.current || operation.current.signal.aborted) {
      operation.current?.abort();
      operation.current = new AbortController();
    }
    const controller = operation.current;
    const { signal } = controller;
    const pending: ArrivalStatus = { visitId, activationId: intent.activationId, sourceIdentity, pending: true, failure: null };
    if (!admitted) {
      publishStatus(pending);
      latest.current.input.onAttempt?.(signal, intent.target);
    }
    if (signal.aborted || captured.current?.phase === "Retired") return;
    if (!ready && intent.target.kind !== "invalid_destination") return;
    if (intent.target.kind === "invalid_destination") {
      publishStatus({ ...pending, pending: false, failure: { title: intent.target.reason === "location_too_long" ? "this location link is too long" : "this location link is invalid", error: null } });
      return;
    }
    if (intent.target.kind === "reader_destination" && intent.target.destination.source_identity !== sourceIdentity) {
      const target = intent.target.destination.target;
      const title = target.kind === "range" || target.kind === "pdf_find"
        ? sourceIdentity === null ? "this match is no longer available" : "the document changed. search again to find this passage"
        : sourceIdentity === null ? "couldn’t open that location" : "this location belongs to a different source version";
      publishStatus({ ...pending, pending: false, failure: { title, error: null } });
      return;
    }
    if (intent.sourceIdentity !== null && intent.sourceIdentity !== sourceIdentity) {
      publishStatus({ ...pending, pending: false, failure: { title: sourceIdentity === null ? "couldn’t open that location" : "this location belongs to a different source version", error: null } });
      return;
    }
    const pinnedIntent = { ...intent, sourceIdentity };
    if (intent.sourceIdentity === null && sourceIdentity !== null) {
      remember(pinnedIntent);
    }
    const current = () => {
      const now = workspace();
      const pane = now.state.panes.find((pane) => pane.id === runtime.paneId);
      const newer = now.pendingPaneEntryDeliveryByPaneId.get(runtime.paneId);
      return !signal.aborted && pane?.current_visit.id === visitId &&
        (!newer || newer.activationId === intent.activationId) &&
        captured.current?.activationId === intent.activationId && captured.current.phase !== "Retired" &&
        latest.current.input.sourceIdentity === sourceIdentity;
    };
    publishStatus(pending);
    const run = async () => {
      try {
        let target: SourceArrivalApplyTarget | null;
        if (intent.target.kind === "reader_destination" || intent.target.kind === "chat_destination") target = intent.target;
        else {
          const destination = latest.current.runtime;
          const readingMediaId = destination.routeId === "media" && destination.resourceRef?.startsWith("media:")
            ? destination.resourceRef.slice("media:".length) : null;
          const { data } = await apiFetch<ApiJson<"/resource-items/source-targets/resolve", "post">>(
            "/api/resource-items/source-targets/resolve",
            { method: "POST", body: JSON.stringify({ target: intent.target, reading_media_id: readingMediaId }), signal },
          );
          if (!current()) return;
          const source = data.source_activation;
          // Endpoint queries never change a conversation's source ownership.
          const sameOwner = source?.resource_ref && destination.resourceRef
            ? source.resource_ref === destination.resourceRef
            : data.location.kind === "resource" && source?.kind === "route" && source.href !== null && resolveWorkspaceActivationRouteId(source.href) === resolveWorkspaceActivationRouteId(destination.href);
          if (sameOwner && data.location.kind === "located" && data.location.source_identity !== null &&
              sourceIdentity !== null && data.location.source_identity !== sourceIdentity) {
            publishStatus({ ...pending, pending: false, failure: { title: "this location belongs to a different source version", error: null } });
            return;
          }
          target = data.location.kind === "unavailable" || !sameOwner || (data.location.kind === "located" && sourceIdentity === null)
            ? null : { kind: "source", source: data };
        }
        const outcome = target === null ? "Unavailable" : await latest.current.input.apply(target, {
          activationId: intent.activationId,
          signal,
          restored: intent.phase === "Applied" && intent.sourceIdentity === sourceIdentity,
          mayFocus: (element) => {
            const owner = getInteractionOwner();
            const destinationModal = element && owner?.options.current.kind === "modal" && owner.element?.contains(element);
            return current() && focusLease.current?.activationId === intent.activationId && focusLease.current.owned && workspace().state.active_primary_pane_id === runtime.paneId && (owner === null || Boolean(destinationModal));
          },
        });
        if (!current()) return;
        if (outcome === "Applied" && target?.kind === "source" && target.source.location.kind === "resource") {
          remember(null);
          publishStatus(null);
          return;
        }
        switch (outcome) {
          case "Applied":
            remember({ ...pinnedIntent, phase: "Applied" });
            publishStatus({ ...pending, pending: false });
            break;
          case "Unavailable":
            controller.abort();
            remember({ ...pinnedIntent, phase: "Pending" });
            publishStatus({ ...pending, pending: false, failure: { title: intent.target.kind === "chat_destination" || intent.target.kind === "reader_destination" && (intent.target.destination.target.kind === "range" || intent.target.destination.target.kind === "pdf_find") ? "this match is no longer available" : "couldn’t open that location", error: null } });
            break;
          case "Cancelled":
          case "FailureHandled":
            controller.abort();
            remember({ ...pinnedIntent, phase: "Retired" });
            publishStatus({ ...pending, pending: false });
            break;
          default: assertNever(outcome);
        }
      } catch (error) {
        if (!current() || handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) { setDefect({ error }); return; }
        controller.abort();
        publishStatus({ ...pending, pending: false, failure: { title: "couldn’t open that location", error } });
      }
    };
    void run();
    return () => {
      controller.abort();
    };
    // The stable activation id owns one operation. apply reads current host
    // callbacks; acknowledging the same intent does not create another arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: activation, visit and source identity own the operation
  }, [activationId, ready, restoreOutcome, runtime.visitId, sourceIdentity, workspace, publishStatus, remember]);

  useEffect(() => {
    if (!active || intent?.phase !== "Applied") return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.shiftKey && !event.defaultPrevented && !hasActiveInteractionOwner()) { event.preventDefault(); clear(); }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [active, clear, intent?.phase]);

  if (defect) throw defect.error;
  return {
    pending: status?.visitId === runtime.visitId && status.activationId === activationId && status.pending,
    failure: status?.visitId === runtime.visitId && status.activationId === activationId ? status.failure : null,
    clear,
    dismissFailure,
    supersede,
  };
}
