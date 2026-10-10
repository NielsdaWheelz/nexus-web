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
import { useFeedback } from "@/components/feedback/Feedback";
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { createRandomId } from "@/lib/createRandomId";
import {
  pruneRouteKeyedRecords,
  routeKeyedRecord,
} from "@/lib/panes/paneRouteKeyedRecords";
import {
  resolvePaneRouteModel,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import {
  getSecondaryGroupForSurface,
  companionWidthPx,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  MAX_PANES,
  moveTo,
  newPane,
  newVisit,
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
  type PaneDailyPage,
  type PaneEntryDelivery,
  type WorkspaceTargetActivationRequest,
  type WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import { useWorkspaceSession } from "@/lib/workspace/useWorkspaceSession";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

const MAX_PANE_HISTORY = 12;
const MAX_TOTAL_HISTORY = 48;
const MAX_RECENTLY_CLOSED = 5;

export interface WorkspacePaneLabel {
  text: string;
  source: "hint" | "body";
}
export type WorkspaceAdjacentPaneDirection = "Previous" | "Next";
export type SecondaryPanePatch = Partial<
  Pick<WorkspaceSecondaryPane, "visibility" | "activeSurfaceId" | "widthPx">
>;
/** What a body published about its pane, valid while the pane shows `routeKey`. */
interface Published<T> {
  routeKey: string;
  value: T;
}
interface Data {
  state: WorkspaceState;
  columnWidthPx: number;
  recentlyClosedPanes: readonly ClosedPane[];
  runtimeLabelByPaneId: ReadonlyMap<string, Published<WorkspacePaneLabel>>;
  dailyPageByPaneId: ReadonlyMap<string, Published<PaneDailyPage>>;
  pendingPaneEntryDeliveryByPaneId: ReadonlyMap<string, PaneEntryDelivery>;
  cancelledPaneEntryActivationIds: ReadonlySet<string>;
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
export type WorkspaceStoreValue = Data & WorkspaceStore["commands"];

const routeKeyOf = (pane: WorkspacePane) =>
  resolvePaneRouteModel(pane.currentVisit.href).routeKey;

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
  const isActive = (p: WorkspacePane) => p.id === state.activePrimaryPaneId;
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

function createWorkspaceStore(
  initial: WorkspaceState,
  columnWidthPx: number,
  memento: PaneReturnMemento,
  onPaneLimit: () => void,
) {
  const listeners = new Set<() => void>();
  let mounted = false;
  let data: Data = {
    state: initial,
    columnWidthPx,
    recentlyClosedPanes: [],
    runtimeLabelByPaneId: new Map(),
    dailyPageByPaneId: new Map(),
    pendingPaneEntryDeliveryByPaneId: new Map(),
    cancelledPaneEntryActivationIds: new Set(),
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
    const active = find(data.state.activePrimaryPaneId);
    const href = active?.currentVisit.href ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
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

  /** The one write path: invariants, publications, memento and address follow. */
  function commit(next: WorkspaceState, patch: Partial<Data> = {}): void {
    next = trimHistory(next);
    if (next === data.state && Object.keys(patch).length === 0) return;
    const closed = patch.recentlyClosedPanes ?? data.recentlyClosedPanes;
    const visitOf = new Map(next.panes.map((p) => [p.id, p.currentVisit.id]));
    const deliveries = new Map(
      patch.pendingPaneEntryDeliveryByPaneId ??
        data.pendingPaneEntryDeliveryByPaneId,
    );
    const cancelled = new Set(
      patch.cancelledPaneEntryActivationIds ??
        data.cancelledPaneEntryActivationIds,
    );
    for (const [paneId, delivery] of deliveries) {
      if (visitOf.get(paneId) === delivery.visitId) continue;
      deliveries.delete(paneId);
      cancelled.add(delivery.activationId);
    }
    const labels = patch.runtimeLabelByPaneId ?? data.runtimeLabelByPaneId;
    memento.forget(
      new Set(
        next.panes.flatMap((p) =>
          [p.currentVisit, ...p.history.back, ...p.history.forward].map(
            (visit) => visit.id,
          ),
        ),
      ),
    );
    // A closed pane keeps its records for a reopen.
    const shown = [...next.panes, ...closed.map((c) => c.pane)];
    const routeKeys = new Map(shown.map((p) => [p.id, routeKeyOf(p)]));
    set({
      ...patch,
      state: next,
      runtimeLabelByPaneId: pruneRouteKeyedRecords(labels, routeKeys),
      dailyPageByPaneId: pruneRouteKeyedRecords(data.dailyPageByPaneId, routeKeys),
      pendingPaneEntryDeliveryByPaneId: deliveries,
      cancelledPaneEntryActivationIds: cancelled,
    });
    if (mounted) project();
  }

  function find(paneId: string): WorkspacePane | undefined {
    return data.state.panes.find((p) => p.id === paneId);
  }

  /** Activation moves to `paneId`: the pane losing it may unmount (mobile). */
  function leave(paneId: string): void {
    const { activePrimaryPaneId } = data.state;
    if (activePrimaryPaneId !== paneId) memento.capture(activePrimaryPaneId);
  }

  function activated(state: WorkspaceState, paneId: string): WorkspaceState {
    const pane = find(paneId);
    if (state.activePrimaryPaneId === paneId && pane?.visibility === "visible") {
      return state;
    }
    leave(paneId);
    const next = updatePane(state, paneId, (p) => ({
      ...p,
      visibility: "visible",
    }));
    return { ...next, activePrimaryPaneId: paneId };
  }

  /** Push (a new visit), replace (the pane's own visit id) or traverse (`history`). */
  function moved(
    state: WorkspaceState,
    paneId: string,
    visit: PaneVisit,
    activate: boolean,
    history?: WorkspacePane["history"],
  ): WorkspaceState {
    const push = visit.id !== find(paneId)!.currentVisit.id;
    if (activate) leave(paneId);
    if (push) memento.capture(paneId);
    const next = updatePane(state, paneId, (p) => ({
      ...moveTo(p, visit),
      visibility: activate ? "visible" : p.visibility,
      history:
        history ??
        (push
          ? {
              back: [...p.history.back, p.currentVisit].slice(-MAX_PANE_HISTORY),
              forward: [],
            }
          : p.history),
    }));
    return activate ? { ...next, activePrimaryPaneId: paneId } : next;
  }

  function withSecondary(
    state: WorkspaceState,
    paneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ): WorkspaceState {
    const groupId = getSecondaryGroupForSurface(surfaceId);
    return updatePane(state, paneId, (pane) => {
      const route = resolvePaneRouteModel(pane.currentVisit.href);
      if (!route.groups.includes(groupId)) return pane;
      const kept = pane.secondary?.groupId === groupId ? pane.secondary : null;
      const secondary: WorkspaceSecondaryPane = {
        id: kept?.id ?? createRandomId("secondary-pane"),
        groupId,
        activeSurfaceId: surfaceId,
        widthPx: companionWidthPx(kept?.widthPx ?? null),
        visibility: "visible",
      };
      return { ...pane, secondary };
    });
  }

  /** A link's label until the body publishes its own for that route. */
  function hinted(paneId: string, href: string, hint: string | undefined) {
    const labels = data.runtimeLabelByPaneId;
    const text = hint && collapseWhitespace(hint);
    const routeKey = resolvePaneRouteModel(href).routeKey;
    const existing = labels.get(paneId);
    if (!text || (existing?.routeKey === routeKey && existing.value.source === "body")) {
      return labels;
    }
    const value: WorkspacePaneLabel = { text, source: "hint" };
    return new Map(labels).set(paneId, { routeKey, value });
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
        (p) => p.id === data.state.activePrimaryPaneId,
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
      const activation = request.paneEntryActivation;
      if (plan.kind === "Rejected") {
        if (activation?.entry) {
          const cancelled = new Set(data.cancelledPaneEntryActivationIds);
          set({ cancelledPaneEntryActivationIds: cancelled.add(activation.activationId) });
        }
        onPaneLimit();
        return plan;
      }
      let paneId = plan.paneId;
      let state: WorkspaceState;
      if (plan.kind === "CreatedPane") {
        const pane = newPane(plan.href);
        leave(pane.id);
        const panes = [...data.state.panes];
        panes.splice(panes.findIndex((p) => p.id === paneId) + 1, 0, pane);
        state = { activePrimaryPaneId: pane.id, panes };
        paneId = pane.id;
      } else if (plan.kind === "NavigatedOrigin" || plan.kind === "NavigatedExisting") {
        state = moved(data.state, paneId, newVisit(plan.href), true);
      } else {
        state = activated(data.state, paneId);
      }
      const surface = request.target.secondaryActivation?.surfaceId;
      if (surface) state = withSecondary(state, paneId, surface);
      const deliveries = new Map(data.pendingPaneEntryDeliveryByPaneId);
      const cancelled = new Set(data.cancelledPaneEntryActivationIds);
      if (activation) {
        const previous = deliveries.get(paneId);
        if (previous) cancelled.add(previous.activationId);
        deliveries.delete(paneId);
        const visitId = state.panes.find((p) => p.id === paneId)!.currentVisit.id;
        const { activationId, entry } = activation;
        if (entry) deliveries.set(paneId, { activationId, paneId, visitId, entry });
      }
      commit(state, {
        runtimeLabelByPaneId: hinted(paneId, plan.href, request.target.labelHint),
        pendingPaneEntryDeliveryByPaneId: deliveries,
        cancelledPaneEntryActivationIds: cancelled,
      });
      return { kind: plan.kind, paneId };
    },
    navigatePane(
      paneId: string,
      href: string,
      options: { replace?: boolean; activate?: boolean; labelHint?: string } = {},
    ): void {
      const target = normalizeWorkspaceHref(href);
      const pane = find(paneId);
      if (!target || !pane || pane.currentVisit.href === target) return;
      const visit = options.replace
        ? { id: pane.currentVisit.id, href: target }
        : newVisit(target);
      commit(moved(data.state, paneId, visit, options.activate ?? true), {
        runtimeLabelByPaneId: hinted(paneId, target, options.labelHint),
      });
    },
    goBackPane(paneId: string): void {
      traverse(paneId, true);
    },
    goForwardPane(paneId: string): void {
      traverse(paneId, false);
    },
    closePane(paneId: string): void {
      const index = data.state.panes.findIndex((p) => p.id === paneId);
      if (index < 0) return;
      const recentlyClosedPanes = [
        { pane: data.state.panes[index]!, index },
        ...data.recentlyClosedPanes,
      ].slice(0, MAX_RECENTLY_CLOSED);
      let panes = data.state.panes.filter((p) => p.id !== paneId);
      let active = data.state.activePrimaryPaneId;
      if (panes.length === 0) {
        panes = [newPane(WORKSPACE_DEFAULT_FALLBACK_HREF)];
        active = panes[0]!.id;
      } else if (active === paneId) {
        const visible = (p: WorkspacePane) => p.visibility === "visible";
        active = (
          panes.slice(index).find(visible) ??
          panes.slice(0, index).findLast(visible) ??
          panes[Math.min(index, panes.length - 1)]!
        ).id;
        panes = panes.map((p) =>
          p.id === active ? { ...p, visibility: "visible" } : p,
        );
      }
      commit({ activePrimaryPaneId: active, panes }, { recentlyClosedPanes });
    },
    restoreClosedPane(paneId: string) {
      const closed = data.recentlyClosedPanes.find((c) => c.pane.id === paneId);
      if (!closed) {
        // justify-defect: the command comes from a projected recently-closed row.
        throw new Error(`Recently closed pane not found: ${paneId}`);
      }
      if (data.state.panes.length >= MAX_PANES) {
        return { kind: "Rejected", reason: "PaneLimitReached" } as const;
      }
      leave(paneId);
      const pane = moveTo(closed.pane, closed.pane.currentVisit, true);
      const panes = [...data.state.panes];
      panes.splice(closed.index, 0, { ...pane, visibility: "visible" });
      commit(
        { activePrimaryPaneId: paneId, panes },
        {
          recentlyClosedPanes: data.recentlyClosedPanes.filter(
            (c) => c !== closed,
          ),
        },
      );
      return { kind: "Restored", paneId } as const;
    },
    minimizePane(paneId: string): void {
      const visible = data.state.panes.filter((p) => p.visibility === "visible");
      const index = visible.findIndex((p) => p.id === paneId);
      if (index < 0 || visible.length < 2) return;
      let active = data.state.activePrimaryPaneId;
      if (active === paneId) {
        active = (visible[index + 1] ?? visible[index - 1]!).id;
        leave(active);
      }
      const next = updatePane(data.state, paneId, (p) => ({
        ...p,
        visibility: "minimized",
      }));
      commit({ ...next, activePrimaryPaneId: active });
    },
    /** Stores the user's width; the host clamps it to the column and route. */
    resizePrimaryPane(paneId: string, widthPx: number): void {
      const primaryWidthPx = Math.round(widthPx);
      commit(updatePane(data.state, paneId, (p) => ({ ...p, primaryWidthPx })));
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
        if (getSecondaryGroupForSurface(next.activeSurfaceId) !== next.groupId) {
          return;
        }
        secondary = { ...next, widthPx: companionWidthPx(next.widthPx) };
      }
      commit(updatePane(data.state, pane.id, (p) => ({ ...p, secondary })));
    },
    publishPaneLabel(paneId: string, routeKey: string, label: string | null) {
      const text = label && collapseWhitespace(label);
      const value: WorkspacePaneLabel | null = text
        ? { text, source: "body" }
        : null;
      // Bodies publish null while loading; that must not erase a link's hint.
      const labels = published(
        data.runtimeLabelByPaneId,
        paneId,
        routeKey,
        value,
        (current) => current.source === "body",
      );
      if (labels) set({ runtimeLabelByPaneId: labels });
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
    acknowledgePaneEntryDelivery(delivery: PaneEntryDelivery): void {
      const deliveries = data.pendingPaneEntryDeliveryByPaneId;
      const pending = deliveries.get(delivery.paneId);
      if (pending?.activationId !== delivery.activationId) return;
      const next = new Map(deliveries);
      next.delete(delivery.paneId);
      set({ pendingPaneEntryDeliveryByPaneId: next });
    },
  };

  function traverse(paneId: string, back: boolean): void {
    const pane = find(paneId);
    const { back: b, forward: f } = pane?.history ?? { back: [], forward: [] };
    const visit = back ? b.at(-1) : f[0];
    if (!pane || !visit) return;
    const history = back
      ? { back: b.slice(0, -1), forward: [pane.currentVisit, ...f] }
      : { back: [...b, pane.currentVisit], forward: f.slice(1) };
    commit(moved(data.state, paneId, visit, true, history));
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
        const pane = find(data.state.activePrimaryPaneId);
        const { pathname, search, hash } = window.location;
        const [path] = pane?.currentVisit.href.split("#") ?? [];
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
  const { publish } = useFeedback();
  const [memento] = useState(createPaneReturnMemento);
  const [store] = useState(() =>
    createWorkspaceStore(props.initialState, props.columnWidthPx, memento, () =>
      publish({
        kind: "Hud",
        key: "Workspace.PaneLimitReached",
        content: { tone: "Warning", title: "Pane limit reached" },
      }),
    ),
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

export interface WorkspacePaneLabelDescriptor {
  routeKey: string;
  route: ResolvedPaneRouteModel;
  label: string;
  labelState: "resolved" | "pending";
}

/** The pane's title: its body's (or a link's hint) for this route, else the route default. */
export function resolveWorkspacePaneLabel(
  pane: WorkspacePane,
  labels: WorkspaceStoreValue["runtimeLabelByPaneId"],
): WorkspacePaneLabelDescriptor {
  const route = resolvePaneRouteModel(pane.currentVisit.href);
  const published = routeKeyedRecord(labels, pane.id, route.routeKey);
  return {
    routeKey: route.routeKey,
    route,
    label: published?.value.text ?? route.defaultLabel,
    labelState: published || route.labelMode === "static" ? "resolved" : "pending",
  };
}
