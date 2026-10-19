"use client";

// One destination owns resolution, positioning and paint. A visit remembers the
// intent before claiming its delivery, so mobile unmount cannot consume it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson } from "@/lib/api/wire";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneRouteModel";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { SourceArrivalTarget, SourceTarget } from "@/lib/resources/sourceTarget";
import type { ReaderDestination } from "@/lib/documentReader/location";
import { getInteractionOwner, hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";

interface ArrivalIntent {
  readonly activationId: string;
  readonly target: SourceArrivalTarget;
  readonly applied: boolean;
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
  | { readonly kind: "reader_destination"; readonly destination: ReaderDestination };

export function useSourceArrival(input: {
  readonly ready: boolean;
  readonly sourceIdentity: string | null;
  readonly apply: (target: SourceArrivalApplyTarget, context: SourceArrivalContext) => Promise<boolean>;
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
  const [status, setStatus] = useState<{ activationId: string; pending: boolean; failure: string | null } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const latest = useRef({ runtime, input });
  latest.current = { runtime, input };
  const operation = useRef<AbortController | null>(null);
  const focusLease = useRef<{ activationId: string; owned: boolean } | null>(null);
  const freshFocus = useRef<string | null>(null);

  const clear = useCallback(() => {
    operation.current?.abort();
    captured.current = null;
    write(null);
    setOwned({ visitId: latest.current.runtime.visitId, intent: null });
    setStatus(null);
  }, [write]);

  useLayoutEffect(() => {
    const delivery = runtime.paneEntryDelivery;
    if (delivery?.entry.kind !== "InspectSource") return;
    const next = { activationId: delivery.activationId, target: delivery.entry.target, applied: false, sourceIdentity: null };
    write(next);
    if (!runtime.claimPaneEntryDelivery(delivery)) return;
    if (mobile && !(next.target.kind === "reader_destination" && next.target.destination.target.kind === "evidence_item")) runtime.closeSecondaryPane({ restoreFocus: false });
    operation.current?.abort();
    freshFocus.current = next.activationId;
    captured.current = next;
    setOwned({ visitId: runtime.visitId, intent: next });
  }, [mobile, runtime, write]);

  const activationId = intent?.activationId ?? null;
  const { ready, sourceIdentity } = input;
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
    if (!intent || (!ready && intent.target.kind !== "invalid_destination")) return;
    if (intent.target.kind === "invalid_destination") {
      operation.current?.abort();
      setStatus({ activationId: intent.activationId, pending: false, failure: "location unavailable" });
      return;
    }
    if (intent.target.kind === "reader_destination" && intent.target.destination.source_identity !== sourceIdentity) {
      operation.current?.abort();
      setStatus({ activationId: intent.activationId, pending: false, failure: sourceIdentity === null ? "location unavailable" : "source changed; choose this location again" });
      return;
    }
    if (intent.sourceIdentity !== null && intent.sourceIdentity !== sourceIdentity) {
      operation.current?.abort();
      setStatus({ activationId: intent.activationId, pending: false, failure: "source changed; reopen the passage to inspect it" });
      return;
    }
    const pinnedIntent = { ...intent, sourceIdentity };
    if (intent.sourceIdentity === null && sourceIdentity !== null) {
      captured.current = pinnedIntent;
      write(pinnedIntent);
      setOwned({ visitId: runtime.visitId, intent: pinnedIntent });
    }
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    const { signal } = controller;
    const visitId = runtime.visitId;
    const current = () => {
      const now = workspace();
      const pane = now.state.panes.find((pane) => pane.id === runtime.paneId);
      const newer = now.pendingPaneEntryDeliveryByPaneId.get(runtime.paneId);
      return !signal.aborted && pane?.current_visit.id === visitId &&
        (!newer || newer.activationId === intent.activationId) &&
        latest.current.input.sourceIdentity === sourceIdentity;
    };
    setStatus({ activationId: intent.activationId, pending: true, failure: null });
    const run = async () => {
      try {
        let target: SourceArrivalApplyTarget | null;
        if (intent.target.kind === "reader_destination") target = intent.target;
        else {
          const { data } = await apiFetch<ApiJson<"/resource-items/source-targets/resolve", "post">>(
            "/api/resource-items/source-targets/resolve",
            { method: "POST", body: JSON.stringify({ target: intent.target }), signal },
          );
          if (!current()) return;
          const destination = latest.current.runtime;
          const source = data.source_activation;
          // Endpoint queries never change a conversation's source ownership.
          const sameOwner = source?.resource_ref && destination.resourceRef
            ? source.resource_ref === destination.resourceRef
            : data.location.kind === "resource" && source?.kind === "route" && source.href !== null && resolveWorkspaceActivationRouteId(source.href) === resolveWorkspaceActivationRouteId(destination.href);
          target = data.location.kind === "unavailable" || !sameOwner || (data.location.kind === "located" && sourceIdentity === null)
            ? null : { kind: "source", source: data };
        }
        const applied = target !== null && await latest.current.input.apply(target, {
          activationId: intent.activationId,
          signal,
          restored: intent.applied && intent.sourceIdentity === sourceIdentity,
          mayFocus: (element) => {
            const owner = getInteractionOwner();
            const destinationModal = element && owner?.options.current.kind === "modal" && owner.element?.contains(element);
            return current() && focusLease.current?.activationId === intent.activationId && focusLease.current.owned && workspace().state.active_primary_pane_id === runtime.paneId && (owner === null || Boolean(destinationModal));
          },
        });
        if (!current()) return;
        if (applied && target?.kind === "source" && target.source.location.kind === "resource") {
          captured.current = null;
          write(null);
          setOwned({ visitId, intent: null });
          setStatus(null);
          return;
        }
        const next = { ...pinnedIntent, applied: Boolean(applied) };
        captured.current = next;
        write(next);
        // Keep the request identity stable; acknowledging it must not restart
        // the effect or abort the persistent destination decoration.
        setOwned({ visitId, intent: next });
        setStatus({ activationId: intent.activationId, pending: false, failure: applied ? null : "location unavailable" });
      } catch (error) {
        if (!current() || handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) { setDefect({ error }); return; }
        setStatus({ activationId: intent.activationId, pending: false, failure: error.status === 404 || error.status === 410 ? "quoted location unavailable" : "the passage could not be opened" });
      }
    };
    void run();
    return () => {
      controller.abort();
    };
    // The stable activation id owns one operation. apply reads current host
    // callbacks; acknowledging the same intent does not create another arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: activation, visit and source identity own the operation
  }, [activationId, ready, runtime.visitId, sourceIdentity, workspace, write]);

  useEffect(() => {
    if (!active || !intent?.applied) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.shiftKey && !event.defaultPrevented && !hasActiveInteractionOwner()) { event.preventDefault(); clear(); }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [active, clear, intent?.applied]);

  if (defect) throw defect.error;
  return {
    pending: status?.activationId === activationId && status.pending,
    failure: status?.activationId === activationId ? status.failure : null,
    clear,
  };
}
