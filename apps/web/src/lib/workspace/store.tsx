"use client";

// The client workspace: one external store owns the state and every command
// applies synchronously, so the address, the return memento, the save and the
// next command all see the same state. React reads it with useSyncExternalStore.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { createRandomId } from "@/lib/createRandomId";
import { conversationEndpoint } from "@/lib/chat/view";
import { useWorkGuard, type WorkGuard, type WorkScope } from "@/lib/unsavedWork";
import {
  pruneRouteKeyedRecords,
  routeKeyedRecord,
} from "@/lib/panes/paneRouteKeyedRecords";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import {
  getSecondaryGroupForSurface,
  companionWidthPx,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  moveTo,
  newPane,
  newVisit,
  normalizeVisitTitleHint,
  replaceVisit,
  type ClosedPane,
  type PaneVisit,
  type WorkspacePane,
  type WorkspaceSecondaryPane,
  type WorkspaceState,
} from "@/lib/workspace/model";
import {
  createPaneReturnMemento,
  PaneReturnMementoContext,
  type PaneReturnMemento,
} from "@/lib/workspace/paneReturnMemento";
import {
  planWorkspaceTarget,
  paneEntryWorkOwnerId,
  type PaneDailyPage,
  type PaneEntryDelivery,
  type WorkspaceTargetActivationRequest,
  type WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import { useWorkspaceSession } from "@/lib/workspace/useWorkspaceSession";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

const PENDING_ENTRY = "Workspace.ComposeEntry";
export type WorkspaceNavigationResult = "committed" | "unchanged" | "cancelled";

const MAX_PANE_HISTORY = 12;
const MAX_TOTAL_HISTORY = 48;
const MAX_RECENTLY_CLOSED = 5;

export type WorkspaceAdjacentPaneDirection = "Previous" | "Next";
export interface WorkspaceSelection {
  paneId: string;
  visitId: string;
}
export interface PaneViewHrefUpdate extends WorkspaceSelection {
  href: string;
  arrival: "preserve" | "clear";
}
export type SecondaryPanePatch = Partial<
  Pick<WorkspaceSecondaryPane, "visibility" | "active_surface_id" | "width_px">
>;
/** What a body published about its pane, valid while the pane shows `routeKey`. */
interface Published<T> {
  routeKey: string;
  value: T;
}
interface Data {
  state: WorkspaceState;
  /** Session-local: leaving a foreground source permanently revokes its async opening. */
  readonly foregroundGeneration: number;
  columnWidthPx: number;
  recentlyClosedPanes: readonly ClosedPane[];
  dailyPageByPaneId: ReadonlyMap<string, Published<PaneDailyPage>>;
  pendingPaneEntryDeliveryByPaneId: ReadonlyMap<string, PaneEntryDelivery>;
  /** A destination owns focus after its initiating overlay has closed. */
  pendingPaneFocus: WorkspaceSelection | null;
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
export type WorkspaceStoreValue = Data & WorkspaceStore["commands"];

const routeKeyOf = (pane: WorkspacePane) =>
  resolvePaneRouteModel(pane.current_visit.href).routeKey;

function foregroundKey(state: WorkspaceState): string {
  const pane = state.panes.find((p) => p.id === state.active_primary_pane_id)!;
  const route = resolvePaneRouteModel(pane.current_visit.href);
  return `${pane.id}:${pane.current_visit.id}:${route.id}:${route.pathname}`;
}

function updatePane(
  state: WorkspaceState,
  paneId: string,
  change: (pane: WorkspacePane) => WorkspacePane,
): WorkspaceState {
  const panes = state.panes.map((p) => (p.id === paneId ? change(p) : p));
  return { ...state, panes };
}

/** I4: all panes' history <= 48, dropping oldest first, inactive panes first. */
function trimHistory(state: WorkspaceState): WorkspaceState {
  const size = (p: WorkspacePane) =>
    p.history.back.length + p.history.forward.length;
  let excess = state.panes.reduce((n, p) => n + size(p), 0) - MAX_TOTAL_HISTORY;
  if (excess <= 0) return state;
  const isActive = (p: WorkspacePane) => p.id === state.active_primary_pane_id;
  const trimmed = new Map<string, WorkspacePane>();
  for (const pane of [
    ...state.panes.filter((p) => !isActive(p)),
    ...state.panes.filter(isActive),
  ]) {
    const drop = Math.min(excess, size(pane));
    if (drop === 0) continue;
    excess -= drop;
    const { back, forward } = pane.history;
    const fromBack = Math.min(drop, back.length);
    const history = {
      back: back.slice(fromBack),
      forward: forward.slice(0, forward.length - (drop - fromBack)),
    };
    trimmed.set(pane.id, { ...pane, history });
  }
  return { ...state, panes: state.panes.map((p) => trimmed.get(p.id) ?? p) };
}

function reachableVisits(state: WorkspaceState): Map<string, string> {
  return new Map(state.panes.flatMap(pane =>
    [pane.current_visit, ...pane.history.back, ...pane.history.forward].map(visit =>
      [visit.id, resolvePaneRouteModel(visit.href).routeKey] as const)));
}

/** Closing navigation retains no authored memory, including on a later reopen. */
function withoutPane(state: WorkspaceState, paneId: string): WorkspaceState {
  const index = state.panes.findIndex(pane => pane.id === paneId);
  if (index < 0) return state;
  let panes = state.panes.filter(pane => pane.id !== paneId);
  let active = state.active_primary_pane_id;
  if (panes.length === 0) {
    panes = [newPane(WORKSPACE_DEFAULT_FALLBACK_HREF)];
    active = panes[0]!.id;
  } else if (active === paneId) {
    const visible = (pane: WorkspacePane) => pane.visibility === "visible";
    active = (panes.slice(index).find(visible) ?? panes.slice(0, index).findLast(visible) ?? panes[Math.min(index, panes.length - 1)]!).id;
    panes = panes.map(pane => pane.id === active ? { ...pane, visibility: "visible" } : pane);
  }
  return { active_primary_pane_id: active, panes };
}

function createWorkspaceStore(
  initial: WorkspaceState,
  columnWidthPx: number,
  memento: PaneReturnMemento,
  guard: WorkGuard,
) {
  const listeners = new Set<() => void>();
  let mounted = false;
  let data: Data = {
    state: initial,
    foregroundGeneration: 0,
    columnWidthPx,
    recentlyClosedPanes: [],
    dailyPageByPaneId: new Map(),
    pendingPaneFocus: null,
    pendingPaneEntryDeliveryByPaneId: new Map(initial.panes.flatMap((pane) => {
      const target = sourceTargetFromHref(pane.current_visit.href);
      return target ? [[pane.id, {
        activationId: crypto.randomUUID(), paneId: pane.id,
        visitId: pane.current_visit.id, entry: { kind: "InspectSource" as const, target },
      }]] : [];
    })),
  };
  let value: Data & typeof commands;

  function set(patch: Partial<Data>): void {
    data = { ...data, ...patch };
    value = { ...data, ...commands };
    for (const listener of listeners) listener();
  }

  // The address bar names the active pane. A null history state goes through
  // Next's patched replaceState, which keeps its router's url in step (L2).
  // Next patches it in a passive effect that can run after the first commit's
  // layout effects; then write the bare entry and re-project a frame later.
  function project(force = false): void {
    const active = find(data.state.active_primary_pane_id);
    const href = active?.current_visit.href ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
    const { pathname, search, hash } = window.location;
    if (!force && href === `${pathname}${search}${hash}`) return;
    if (Object.hasOwn(window.history, "replaceState")) {
      window.history.replaceState(null, "", href);
      return;
    }
    const { state } = window.history;
    History.prototype.replaceState.call(window.history, state, "", href);
    requestAnimationFrame(() => {
      if (Object.hasOwn(window.history, "replaceState")) project(true);
    });
  }

  function admit(next: WorkspaceState, ownerIds: readonly string[] = []): boolean {
    const reachable = reachableVisits(next);
    const scopes: WorkScope[] = data.state.panes
      .filter(pane => !next.panes.some(current => current.id === pane.id))
      .map(pane => ({ kind: "pane", paneId: pane.id }));
    for (const [visitId, routeKey] of reachableVisits(data.state)) {
      if (reachable.get(visitId) !== routeKey) scopes.push({ kind: "visit", visitId, routeKey });
    }
    return guard.confirmLoss({ scopes, ownerIds });
  }

  function retainedEntry(visit: PaneVisit): PaneEntryDelivery | null {
    // justify-type-assertion: only this store writes this private visit-data key.
    return memento.read(visit.id, resolvePaneRouteModel(visit.href).routeKey, PENDING_ENTRY) as PaneEntryDelivery | null;
  }

  /** Admission has succeeded: capture, retire, arrive, then publish synchronously. */
  function commit(next: WorkspaceState, patch: Partial<Data> = {}, sourceArrival: string | null = null): void {
    if (next === data.state && Object.keys(patch).length === 0) return;
    for (const pane of data.state.panes) {
      const current = next.panes.find(value => value.id === pane.id);
      if ((pane.id === data.state.active_primary_pane_id && next.active_primary_pane_id !== pane.id) ||
        (current && (current.current_visit.id !== pane.current_visit.id || routeKeyOf(current) !== routeKeyOf(pane)))) {
        memento.capture(pane.id);
      }
    }
    const closed = patch.recentlyClosedPanes ?? data.recentlyClosedPanes;
    const visitOf = new Map(next.panes.map((p) => [p.id, p.current_visit.id]));
    const deliveries = new Map(
      patch.pendingPaneEntryDeliveryByPaneId ??
        data.pendingPaneEntryDeliveryByPaneId,
    );
    for (const [paneId, delivery] of deliveries) {
      if (visitOf.get(paneId) !== delivery.visitId) deliveries.delete(paneId);
    }
    memento.forget(reachableVisits(next));
    if (sourceArrival !== null) memento.prepareSourceArrival(sourceArrival);
    for (const pane of next.panes) {
      const entry = retainedEntry(pane.current_visit);
      if (entry) deliveries.set(pane.id, entry);
    }
    // A closed pane keeps its records for a reopen.
    const shown = [...next.panes, ...closed.map((c) => c.pane)];
    const routeKeys = new Map(shown.map((p) => [p.id, routeKeyOf(p)]));
    const foregroundGeneration = (patch.foregroundGeneration ?? data.foregroundGeneration) +
      (foregroundKey(data.state) === foregroundKey(next) ? 0 : 1);
    let focus = patch.pendingPaneFocus === undefined ? data.pendingPaneFocus : patch.pendingPaneFocus;
    if (focus && (visitOf.get(focus.paneId) !== focus.visitId || next.active_primary_pane_id !== focus.paneId ||
      (patch.pendingPaneFocus === undefined && foregroundGeneration !== data.foregroundGeneration))) focus = null;
    set({
      ...patch,
      state: next,
      foregroundGeneration,
      dailyPageByPaneId: pruneRouteKeyedRecords(data.dailyPageByPaneId, routeKeys),
      pendingPaneEntryDeliveryByPaneId: deliveries,
      pendingPaneFocus: focus,
    });
    if (mounted) project();
  }

  function find(paneId: string): WorkspacePane | undefined {
    return data.state.panes.find((p) => p.id === paneId);
  }

  function selection(): WorkspaceSelection {
    const pane = find(data.state.active_primary_pane_id)!;
    return { paneId: pane.id, visitId: pane.current_visit.id };
  }

  function activated(state: WorkspaceState, paneId: string): WorkspaceState {
    const pane = find(paneId);
    if (state.active_primary_pane_id === paneId && pane?.visibility === "visible") {
      return state;
    }
    const next = updatePane(state, paneId, (p) => ({
      ...p,
      visibility: "visible",
    }));
    return { ...next, active_primary_pane_id: paneId };
  }

  /** Push (a new visit), replace (the pane's own visit id) or traverse (`history`). */
  function moved(
    state: WorkspaceState,
    paneId: string,
    visit: PaneVisit,
    activate: boolean,
    history?: WorkspacePane["history"],
  ): WorkspaceState {
    const push = visit.id !== find(paneId)!.current_visit.id;
    const next = updatePane(state, paneId, (p) => ({
      ...moveTo(p, visit),
      visibility: activate ? "visible" : p.visibility,
      history:
        history ??
        (push
          ? {
              back: [...p.history.back, p.current_visit].slice(-MAX_PANE_HISTORY),
              forward: [],
            }
          : p.history),
    }));
    return activate ? { ...next, active_primary_pane_id: paneId } : next;
  }

  function withSecondary(
    state: WorkspaceState,
    paneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ): WorkspaceState {
    const groupId = getSecondaryGroupForSurface(surfaceId);
    return updatePane(state, paneId, (pane) => {
      const route = resolvePaneRouteModel(pane.current_visit.href);
      if (!route.groups.includes(groupId)) return pane;
      const kept = pane.secondary?.group_id === groupId ? pane.secondary : null;
      const secondary: WorkspaceSecondaryPane = {
        id: kept?.id ?? createRandomId("secondary-pane"),
        group_id: groupId,
        active_surface_id: surfaceId,
        width_px: companionWidthPx(kept?.width_px ?? null),
        visibility: "visible",
      };
      return { ...pane, secondary };
    });
  }

  /** The records with `paneId`'s publication for `routeKey`, or null when unchanged. */
  function published<T>(
    records: ReadonlyMap<string, Published<T>>,
    paneId: string,
    routeKey: string,
    value: T | null,
    removable: (current: T) => boolean,
  ): ReadonlyMap<string, Published<T>> | null {
    const pane = find(paneId);
    const current = routeKeyedRecord(records, paneId, routeKey)?.value ?? null;
    if (!pane || routeKeyOf(pane) !== routeKey) return null;
    if (JSON.stringify(current) === JSON.stringify(value)) return null;
    if (value === null && !removable(current!)) return null;
    const next = new Map(records);
    if (value === null) next.delete(paneId);
    else next.set(paneId, { routeKey, value });
    return next;
  }

  /** Also restores a minimized pane. */
  function activatePane(paneId: string): void {
    if (find(paneId)) commit(activated(data.state, paneId));
  }

  const commands = {
    activatePane,
    restorePane: activatePane,
    activateAdjacentPane(input: { direction: WorkspaceAdjacentPaneDirection }) {
      const visible = data.state.panes.filter((p) => p.visibility === "visible");
      const index = visible.findIndex(
        (p) => p.id === data.state.active_primary_pane_id,
      );
      const pane = visible[index + (input.direction === "Next" ? 1 : -1)];
      if (!pane) return { kind: "Unchanged" } as const;
      commit(activated(data.state, pane.id));
      return { kind: "Activated", paneId: pane.id } as const;
    },
    activateWorkspaceTarget(
      request: WorkspaceTargetActivationRequest,
    ): WorkspaceTargetActivationResult {
      const plan = planWorkspaceTarget(
        data.state,
        data.dailyPageByPaneId,
        request,
      );
      let paneId = plan.paneId;
      let state: WorkspaceState;
      if (plan.kind === "CreatedPane") {
        const pane = newPane(plan.href);
        const panes = [...data.state.panes];
        panes.splice(panes.findIndex((p) => p.id === paneId) + 1, 0, pane);
        state = { active_primary_pane_id: pane.id, panes };
        paneId = pane.id;
      } else if (plan.kind === "NavigatedOrigin" || plan.kind === "NavigatedExisting") {
        const visit = plan.kind === "NavigatedOrigin" && request.originHistory === "replace"
          ? replaceVisit(find(paneId)!.current_visit, plan.href)
          : newVisit(plan.href);
        state = moved(data.state, paneId, visit, true);
      } else {
        state = activated(data.state, paneId);
      }
      const hint = request.target.labelHint;
      if (hint !== undefined) {
        const pane = state.panes.find(current => current.id === paneId)!;
        const visit = replaceVisit(pane.current_visit, pane.current_visit.href, hint);
        if (visit.title_hint !== pane.current_visit.title_hint) {
          state = updatePane(state, paneId, current => ({ ...current, current_visit: visit }));
        }
      }
      const surface = request.target.secondaryActivation?.surfaceId;
      if (surface) state = withSecondary(state, paneId, surface);
      const deliveries = new Map(data.pendingPaneEntryDeliveryByPaneId);
      const target = sourceTargetFromHref(plan.href, true);
      const entry = request.entry ?? (target ? { kind: "InspectSource" as const, target } : null);
      state = trimHistory(state);
      const visit = state.panes.find(current => current.id === paneId)!.current_visit;
      const previous = retainedEntry(visit);
      const ownerIds = [...(request.discardOwnerIds ?? []), ...(entry && previous ? [paneEntryWorkOwnerId(previous)] : [])];
      if (!admit(state, ownerIds)) return { kind: "Cancelled" };
      if (plan.kind === "CreatedPane") {
        const sourcePlan = planWorkspaceTarget(data.state, data.dailyPageByPaneId, { ...request, disposition: { kind: "Follow" } });
        if (sourcePlan.kind === "ActivatedExisting" || sourcePlan.kind === "NavigatedExisting" || sourcePlan.kind === "Unchanged") {
          const sourcePane = find(sourcePlan.paneId)!;
          memento.forkReadingView(sourcePane.current_visit.id, routeKeyOf(sourcePane), visit.id, resolvePaneRouteModel(visit.href).routeKey);
        }
      }
      if (entry) {
        const delivery = { activationId: crypto.randomUUID(), paneId, visitId: visit.id, entry };
        if (entry.kind === "ComposeChat" || entry.kind === "ComposePage") {
          const scope = { kind: "visit" as const, visitId: visit.id, routeKey: resolvePaneRouteModel(visit.href).routeKey };
          memento.write(visit.id, scope.routeKey, PENDING_ENTRY, delivery);
          memento.retainWorkOwner({
            id: paneEntryWorkOwnerId(delivery), scope,
            read: () => ({ changed: (entry.kind === "ComposeChat" ? entry.text : entry.title) !== "", unconfirmed: false, stopsBrowserWork: false }),
            subscribe: () => () => {},
          });
        } else if (previous) {
          memento.write(visit.id, resolvePaneRouteModel(visit.href).routeKey, PENDING_ENTRY, null);
        }
        if (previous) memento.forgetWorkOwner(paneEntryWorkOwnerId(previous));
        deliveries.set(paneId, delivery);
      }
      commit(state, {
        pendingPaneEntryDeliveryByPaneId: deliveries,
        pendingPaneFocus: { paneId, visitId: visit.id },
      }, entry?.kind === "InspectSource" ? visit.id : null);
      return { kind: plan.kind, paneId };
    },
    /** Persist a chat view without navigating or inferring another source arrival. */
    updatePaneViewHref(input: PaneViewHrefUpdate): boolean {
      const pane = find(input.paneId);
      const href = normalizeWorkspaceHref(input.href);
      if (!pane || pane.current_visit.id !== input.visitId || !href) return false;
      const currentRoute = resolvePaneRouteModel(pane.current_visit.href);
      const nextRoute = resolvePaneRouteModel(href);
      if (currentRoute.id !== "conversation" || nextRoute.id !== "conversation" ||
        currentRoute.resourceKey === null || currentRoute.resourceKey !== nextRoute.resourceKey) return false;
      const next = parseWorkspaceHref(href)!;
      if (conversationEndpoint(next.searchParams).kind !== "Endpoint") return false;
      if (input.arrival === "preserve") {
        const current = parseWorkspaceHref(pane.current_visit.href)!;
        const unchanged = new URL(next);
        current.searchParams.delete("leaf");
        unchanged.searchParams.delete("leaf");
        current.searchParams.sort();
        unchanged.searchParams.sort();
        if (current.href !== unchanged.href) return false;
      } else {
        next.searchParams.delete("message");
        next.hash = "";
      }
      const updatedHref = `${next.pathname}${next.search}${next.hash}`;
      const deliveries = new Map(data.pendingPaneEntryDeliveryByPaneId);
      if (input.arrival === "clear") deliveries.delete(pane.id);
      const state = updatePane(data.state, pane.id, current => ({
        ...current, current_visit: { ...current.current_visit, href: updatedHref },
      }));
      if (!admit(state)) return false;
      commit(state, {
        pendingPaneEntryDeliveryByPaneId: deliveries,
        foregroundGeneration: data.foregroundGeneration +
          (input.arrival === "clear" && data.state.active_primary_pane_id === pane.id ? 1 : 0),
      });
      return true;
    },
    /** Compare-and-clear the exact request; repeated activation can keep the same visit. */
    claimPaneFocus(expected: WorkspaceSelection): boolean {
      if (data.pendingPaneFocus !== expected) return false;
      set({ pendingPaneFocus: null });
      return true;
    },
    navigatePane(
      paneId: string,
      href: string,
      options: { replace?: boolean; activate?: boolean; labelHint?: string; discardOwnerIds?: readonly string[] } = {},
    ): WorkspaceNavigationResult {
      const target = normalizeWorkspaceHref(href);
      const pane = find(paneId);
      if (!target || !pane) return "unchanged";
      if (pane.current_visit.href === target) {
        return guard.confirmLoss({ scopes: [], ownerIds: options.discardOwnerIds ?? [] }) ? "unchanged" : "cancelled";
      }
      const visit = options.replace
        ? replaceVisit(pane.current_visit, target, options.labelHint)
        : newVisit(target, options.labelHint);
      const state = trimHistory(moved(data.state, paneId, visit, options.activate ?? true));
      if (!admit(state, options.discardOwnerIds)) return "cancelled";
      const deliveries = new Map(data.pendingPaneEntryDeliveryByPaneId);
      const arrival = sourceTargetFromHref(target, true);
      if (arrival) {
        deliveries.set(paneId, {
          activationId: crypto.randomUUID(), paneId, visitId: visit.id,
          entry: { kind: "InspectSource", target: arrival },
        });
      }
      else deliveries.delete(paneId);
      commit(state, { pendingPaneEntryDeliveryByPaneId: deliveries }, arrival ? visit.id : null);
      return "committed";
    },
    goBackPane(paneId: string, options: { discardOwnerIds?: readonly string[] } = {}): WorkspaceNavigationResult {
      return traverse(paneId, true, options.discardOwnerIds);
    },
    goForwardPane(paneId: string, options: { discardOwnerIds?: readonly string[] } = {}): WorkspaceNavigationResult {
      return traverse(paneId, false, options.discardOwnerIds);
    },
    movePane(input: { paneId: string; beforePaneId: string | null }): boolean {
      const { panes } = data.state;
      const index = panes.findIndex((pane) => pane.id === input.paneId);
      if (index < 0 || input.beforePaneId === input.paneId) return false;
      const before = input.beforePaneId === null
        ? panes.length
        : panes.findIndex((pane) => pane.id === input.beforePaneId);
      if (before < 0) return false;
      const destination = before > index ? before - 1 : before;
      if (destination === index) return false;
      const next = [...panes];
      const [pane] = next.splice(index, 1);
      next.splice(destination, 0, pane!);
      commit({ ...data.state, panes: next });
      return true;
    },
    closePane(paneId: string, options: { discardOwnerIds?: readonly string[] } = {}): WorkspaceSelection | null {
      const index = data.state.panes.findIndex((p) => p.id === paneId);
      if (index < 0) return selection();
      const recentlyClosedPanes = [
        { pane: data.state.panes[index]!, index },
        ...data.recentlyClosedPanes,
      ].slice(0, MAX_RECENTLY_CLOSED);
      const state = withoutPane(data.state, paneId);
      if (!admit(state, options.discardOwnerIds)) return null;
      commit(state, { recentlyClosedPanes });
      return selection();
    },
    /** A deletion's display cleanup is one loss decision over every affected pane. */
    settleDeletedPanes(input: {
      paneIds: readonly string[];
      fallbackPaneId: string | null;
      fallbackHref: string;
    }): WorkspaceNavigationResult {
      const href = normalizeWorkspaceHref(input.fallbackHref);
      if (!href) return "unchanged";
      let next = data.state;
      for (const paneId of input.paneIds) {
        const pane = next.panes.find(current => current.id === paneId);
        if (!pane) continue;
        next = paneId === input.fallbackPaneId
          ? moved(next, paneId, replaceVisit(pane.current_visit, href), true)
          : withoutPane(next, paneId);
      }
      next = trimHistory(next);
      if (!admit(next)) return "cancelled";
      const closed = data.state.panes.flatMap((pane, index) =>
        input.paneIds.includes(pane.id) && pane.id !== input.fallbackPaneId ? [{ pane, index }] : []);
      commit(next, { recentlyClosedPanes: [...closed, ...data.recentlyClosedPanes].slice(0, MAX_RECENTLY_CLOSED) });
      return "committed";
    },
    restoreClosedPane(paneId: string): WorkspaceNavigationResult {
      const closed = data.recentlyClosedPanes.find((c) => c.pane.id === paneId);
      if (!closed) {
        // justify-defect: the command comes from a projected recently-closed row.
        throw new Error(`Recently closed pane not found: ${paneId}`);
      }
      const pane = moveTo(closed.pane, closed.pane.current_visit, true);
      const panes = [...data.state.panes];
      panes.splice(closed.index, 0, { ...pane, visibility: "visible" });
      const state = trimHistory({ active_primary_pane_id: paneId, panes });
      if (!admit(state)) return "cancelled";
      commit(state, { recentlyClosedPanes: data.recentlyClosedPanes.filter(current => current !== closed) });
      return "committed";
    },
    minimizePane(paneId: string): WorkspaceSelection {
      const visible = data.state.panes.filter((p) => p.visibility === "visible");
      const index = visible.findIndex((p) => p.id === paneId);
      if (index < 0 || visible.length < 2) return selection();
      let active = data.state.active_primary_pane_id;
      if (active === paneId) {
        active = (visible[index + 1] ?? visible[index - 1]!).id;
      }
      const next = updatePane(data.state, paneId, (p) => ({
        ...p,
        visibility: "minimized",
      }));
      commit({ ...next, active_primary_pane_id: active });
      return selection();
    },
    /** Stores the user's width; the host clamps it to the column and route. */
    resizePrimaryPane(paneId: string, widthPx: number): void {
      commit(updatePane(data.state, paneId, (p) => ({ ...p, primary_width_px: Math.round(widthPx) })));
    },
    requestSecondarySurface(
      paneId: string,
      surfaceId: WorkspaceSecondarySurfaceId,
    ): void {
      commit(withSecondary(data.state, paneId, surfaceId));
    },
    /** Collapse, retarget or resize an Inspector; null detaches it. */
    updateSecondaryPane(
      secondaryPaneId: string,
      patch: SecondaryPanePatch | null,
    ): void {
      const pane = data.state.panes.find(
        (p) => p.secondary?.id === secondaryPaneId,
      );
      if (!pane?.secondary) return;
      let secondary: WorkspaceSecondaryPane | null = null;
      if (patch) {
        const next = { ...pane.secondary, ...patch };
        if (getSecondaryGroupForSurface(next.active_surface_id) !== next.group_id) {
          return;
        }
        secondary = { ...next, width_px: companionWidthPx(next.width_px) };
      }
      commit(updatePane(data.state, pane.id, (p) => ({ ...p, secondary })));
    },
    setVisitTitleHint(input: {
      paneId: string;
      visitId: string;
      titleKey: string;
      title: string | null;
    }): void {
      const pane = find(input.paneId);
      if (!pane || pane.current_visit.id !== input.visitId ||
        resolvePaneRouteModel(pane.current_visit.href).titleKey !== input.titleKey) return;
      const title_hint = normalizeVisitTitleHint(input.title);
      if (pane.current_visit.title_hint === title_hint) return;
      commit(updatePane(data.state, pane.id, (current) => ({
        ...current,
        current_visit: { ...current.current_visit, title_hint },
      })));
    },
    publishPaneDailyPage(
      paneId: string,
      routeKey: string,
      page: PaneDailyPage | null,
    ) {
      const pages = published(
        data.dailyPageByPaneId,
        paneId,
        routeKey,
        page,
        () => true,
      );
      if (pages) set({ dailyPageByPaneId: pages });
    },
    /** Removes a pending delivery; true only for the one call that removed it. */
    claimPaneEntryDelivery(delivery: PaneEntryDelivery): boolean {
      const deliveries = data.pendingPaneEntryDeliveryByPaneId;
      const pending = deliveries.get(delivery.paneId);
      if (pending?.activationId !== delivery.activationId) return false;
      const next = new Map(deliveries);
      next.delete(delivery.paneId);
      const pane = find(delivery.paneId);
      if (pane && retainedEntry(pane.current_visit)?.activationId === delivery.activationId) {
        memento.write(delivery.visitId, routeKeyOf(pane), PENDING_ENTRY, null);
        memento.forgetWorkOwner(paneEntryWorkOwnerId(delivery));
      }
      set({ pendingPaneEntryDeliveryByPaneId: next });
      return true;
    },
  };

  function traverse(paneId: string, back: boolean, ownerIds: readonly string[] = []): WorkspaceNavigationResult {
    const pane = find(paneId);
    const { back: b, forward: f } = pane?.history ?? { back: [], forward: [] };
    const visit = back ? b.at(-1) : f[0];
    if (!pane || !visit) return "unchanged";
    const history = back
      ? { back: b.slice(0, -1), forward: [pane.current_visit, ...f] }
      : { back: [...b, pane.current_visit], forward: f.slice(1) };
    const next = trimHistory(moved(data.state, paneId, visit, true, history));
    if (!admit(next, ownerIds)) return "cancelled";
    commit(next);
    return "committed";
  }

  value = { ...data, ...commands };
  return {
    commands,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    value: () => value,
    setColumnWidth(px: number): void {
      if (px !== data.columnWidthPx) set({ columnWidthPx: px });
    },
    /** After hydration: fold the location hash into the active pane, then own the address. */
    mount(): () => void {
      // Another path's entry (Back onto a fragment) never moves the active
      // pane (L8); the address goes back to naming it.
      const foldHash = () => {
        const pane = find(data.state.active_primary_pane_id);
        const { pathname, search, hash } = window.location;
        const [path] = pane?.current_visit.href.split("#") ?? [];
        if (path !== `${pathname}${search}`) {
          if (mounted) project();
        } else if (pane && hash) {
          commands.navigatePane(pane.id, `${path}${hash}`, { replace: true });
        }
      };
      foldHash();
      mounted = true;
      project();
      window.addEventListener("hashchange", foldHash);
      window.addEventListener("popstate", foldHash);
      return () => {
        mounted = false;
        window.removeEventListener("hashchange", foldHash);
        window.removeEventListener("popstate", foldHash);
      };
    },
  };
}

const StoreContext = createContext<WorkspaceStore | null>(null);

export function WorkspaceStoreProvider(props: {
  initialState: WorkspaceState;
  columnWidthPx: number;
  children: ReactNode;
}) {
  const guard = useWorkGuard();
  const [memento] = useState(() => createPaneReturnMemento(guard));
  const [store] = useState(() =>
    createWorkspaceStore(props.initialState, props.columnWidthPx, memento, guard),
  );
  useLayoutEffect(
    () => store.setColumnWidth(props.columnWidthPx),
    [store, props.columnWidthPx],
  );
  // After every child's layout effect (the nexus url ingress runs first).
  useLayoutEffect(() => store.mount(), [store]);
  useWorkspaceSession(store);
  return (
    <StoreContext value={store}>
      <PaneReturnMementoContext value={memento}>
        {props.children}
      </PaneReturnMementoContext>
    </StoreContext>
  );
}

export function useWorkspaceStore(): WorkspaceStoreValue {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useWorkspaceStore requires WorkspaceStoreProvider");
  return useSyncExternalStore(store.subscribe, store.value, store.value);
}

/** The workspace as it is when called, without re-rendering on its changes: for code
 *  that acts on the workspace, not code that renders it. */
export function useLatestWorkspace(): () => WorkspaceStoreValue {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useLatestWorkspace requires WorkspaceStoreProvider");
  return store.value;
}

/** Observe workspace commits before a destination consumes its delivery. */
export function useSubscribeWorkspace(): WorkspaceStore["subscribe"] {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useSubscribeWorkspace requires WorkspaceStoreProvider");
  return store.subscribe;
}
