"use client";

// One destination owns resolution, positioning and paint. A visit remembers the
// intent before claiming its delivery, so mobile unmount cannot consume it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson } from "@/lib/api/wire";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneRouteModel";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { SourceTarget, SourceTargetKey } from "@/lib/resources/sourceTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";

interface ArrivalIntent {
  readonly activationId: string;
  readonly target: SourceTargetKey;
  readonly applied: boolean;
  readonly sourceIdentity: string | null;
}
const ARRIVAL = definePaneVisitDataKey<ArrivalIntent>("Source.Inspection");

export interface SourceArrivalContext {
  readonly activationId: string;
  readonly signal: AbortSignal;
  readonly restored: boolean;
  mayFocus(): boolean;
}

export function useSourceArrival(input: {
  readonly ready: boolean;
  readonly sourceIdentity: string | null;
  readonly apply: (target: SourceTarget, context: SourceArrivalContext) => Promise<boolean>;
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
    if (mobile) runtime.closeSecondaryPane({ restoreFocus: false });
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
    const release = () => {
      lease.owned = false;
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
    };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    return () => {
      release();
    };
  }, [activationId, runtime.visitId]);
  useEffect(() => {
    if (!intent || !ready) return;
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
        const { data } = await apiFetch<ApiJson<"/resource-items/source-targets/resolve", "post">>(
          "/api/resource-items/source-targets/resolve",
          { method: "POST", body: JSON.stringify({ target: intent.target }), signal },
        );
        if (!current()) return;
        const destination = latest.current.runtime;
        const source = data.source_activation;
        // Whole resources need no publication. Their route is authoritative
        // even for a contributor handle or an artifact revision's current head.
        // Located paint still requires the bound publication and exact owner.
        const sameOwner = data.location.kind === "resource"
          ? source?.kind === "route" && source.href !== null && resolveWorkspaceActivationRouteId(source.href) === resolveWorkspaceActivationRouteId(destination.href)
          : source?.resource_ref === destination.resourceRef;
        const unavailable = data.location.kind === "unavailable" || !sameOwner || (data.location.kind === "located" && sourceIdentity === null);
        const applied = !unavailable && await latest.current.input.apply(data, {
          activationId: intent.activationId,
          signal,
          restored: intent.applied && intent.sourceIdentity === sourceIdentity,
          mayFocus: () => current() && focusLease.current?.activationId === intent.activationId && focusLease.current.owned && workspace().state.active_primary_pane_id === runtime.paneId && !hasActiveInteractionOwner(),
        });
        if (!current()) return;
        if (applied && data.location.kind === "resource") {
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
        setStatus({ activationId: intent.activationId, pending: false, failure: applied ? null : "quoted location unavailable" });
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
