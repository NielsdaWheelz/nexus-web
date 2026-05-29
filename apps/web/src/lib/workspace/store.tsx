"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  MAX_PANES,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  createEmptyPaneHistory,
  createPaneId,
  normalizePaneTitle,
  trimWorkspacePaneHistory,
  type WorkspacePaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  clampPaneWidth,
  getDefaultPaneWidthPx,
  resolvePaneTransitionWidth,
} from "@/lib/workspace/paneWidth";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import {
  buildWorkspaceUrl,
  decodeWorkspaceStateFromUrl,
  type WorkspaceDecodeResult,
  type WorkspaceEncodeResult,
} from "@/lib/workspace/urlCodec";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  consumePendingPaneOpenQueue,
  isOpenInAppPaneMessage,
  NEXUS_OPEN_PANE_EVENT,
  setPaneGraphReady,
  type OpenInAppPaneDetail,
} from "@/lib/panes/openInAppPane";
import {
  hasSamePaneResource,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";
import {
  resolvePaneRoute,
  type PaneChromeDescriptor,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteRegistry";
import { useWorkspaceSession } from "./useWorkspaceSession";

type HistoryMode = "replace" | "push";
type PaneNavigationMode = "replace" | "push";

type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceState }
  | { type: "activate_pane"; paneId: string }
  | {
      type: "open_pane";
      panes: WorkspacePaneState[];
      afterPaneId: string | null;
      activate: boolean;
      mode: PaneNavigationMode;
    }
  | {
      type: "navigate_pane";
      paneId: string;
      href: string;
      activate: boolean;
      mode: PaneNavigationMode;
    }
  | { type: "go_back_pane"; paneId: string }
  | { type: "go_forward_pane"; paneId: string }
  | { type: "close_pane"; paneId: string }
  | { type: "resize_pane"; paneId: string; widthPx: number }
  | { type: "minimize_pane"; paneId: string }
  | { type: "restore_pane"; paneId: string };

function ensureActivePaneId(state: WorkspaceState): WorkspaceState {
  if (!state.panes.length) {
    return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
  }
  if (
    state.panes.some((p) => p.id === state.activePaneId && p.visibility === "visible")
  ) {
    return state;
  }
  const firstVisiblePane = state.panes.find((p) => p.visibility === "visible");
  if (firstVisiblePane) {
    return { ...state, activePaneId: firstVisiblePane.id };
  }
  return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
}

function trimAndEnsureActivePaneId(state: WorkspaceState): WorkspaceState {
  return ensureActivePaneId(trimWorkspacePaneHistory(state));
}

function applyPaneHrefTransition(
  pane: WorkspacePaneState,
  href: string,
  mode: PaneNavigationMode
): WorkspacePaneState {
  if (pane.href === href) {
    return pane;
  }
  return {
    ...pane,
    href,
    widthPx: resolvePaneTransitionWidth(
      pane.href,
      href,
      pane.widthPx,
      hasSamePaneResource(pane.href, href)
    ),
    history:
      mode === "push"
        ? { back: [...pane.history.back, pane.href], forward: [] }
        : pane.history,
  };
}

function isNeutralWorkspaceRestoreIntent(state: WorkspaceState): boolean {
  if (state.panes.length !== 1) {
    return false;
  }
  const pane = state.panes[0];
  return (
    pane?.visibility === "visible" &&
    state.activePaneId === pane.id &&
    pane.href === WORKSPACE_DEFAULT_FALLBACK_HREF
  );
}

export function mergeRestoredWorkspaceWithUrlIntent(
  restored: WorkspaceState,
  urlIntent: WorkspaceState
): WorkspaceState {
  if (isNeutralWorkspaceRestoreIntent(urlIntent)) {
    return restored;
  }

  const requestedPane = urlIntent.panes.find(
    (pane) => pane.id === urlIntent.activePaneId && pane.visibility === "visible"
  );
  if (!requestedPane) {
    return restored;
  }

  const existingPane = restored.panes.find((pane) =>
    hasSamePaneResource(pane.href, requestedPane.href)
  );
  if (existingPane) {
    return trimAndEnsureActivePaneId({
      ...restored,
      activePaneId: existingPane.id,
      panes: restored.panes.map((pane) =>
        pane.id === existingPane.id
          ? {
              ...applyPaneHrefTransition(pane, requestedPane.href, "replace"),
              visibility: "visible" as const,
            }
          : pane
      ),
    });
  }

  const requestedPaneId = restored.panes.some((pane) => pane.id === requestedPane.id)
    ? createPaneId()
    : requestedPane.id;
  const paneToAppend: WorkspacePaneState = {
    ...requestedPane,
    id: requestedPaneId,
    visibility: "visible",
  };
  const retainedPaneCount = Math.max(0, MAX_PANES - 1);
  const panes =
    restored.panes.length >= MAX_PANES
      ? restored.panes.slice(Math.max(0, restored.panes.length - retainedPaneCount))
      : restored.panes;

  return trimAndEnsureActivePaneId({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId: requestedPaneId,
    panes: [...panes, paneToAppend],
  });
}

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "hydrate":
      return trimAndEnsureActivePaneId(action.state);

    case "activate_pane": {
      if (
        !state.panes.some((p) => p.id === action.paneId && p.visibility === "visible")
      ) {
        return state;
      }
      return { ...state, activePaneId: action.paneId };
    }

    case "open_pane": {
      let panes = state.panes;
      let activePaneId = state.activePaneId;

      for (const pane of action.panes) {
        const paneToOpen = {
          ...pane,
          widthPx: clampPaneWidth(pane.widthPx, pane.href),
          visibility: "visible" as const,
        };
        const existingPane = panes.find((item) =>
          hasSamePaneResource(item.href, paneToOpen.href)
        );

        if (existingPane) {
          panes = panes.map((item) =>
            item.id === existingPane.id
              ? {
                  ...applyPaneHrefTransition(item, paneToOpen.href, action.mode),
                  visibility: "visible" as const,
                }
              : item
          );
          if (action.activate) {
            activePaneId = existingPane.id;
          }
          continue;
        }

        if (panes.length + 1 > MAX_PANES) {
          const keep = MAX_PANES - 1;
          panes = panes.filter((p) => p.id === activePaneId).concat(
            panes.filter((p) => p.id !== activePaneId).slice(-(keep - 1))
          );
        }
        const insertIdx = action.afterPaneId
          ? panes.findIndex((p) => p.id === action.afterPaneId) + 1
          : panes.length;
        panes = [...panes.slice(0, insertIdx), paneToOpen, ...panes.slice(insertIdx)];
        if (action.activate) {
          activePaneId = paneToOpen.id;
        }
      }

      return trimAndEnsureActivePaneId({ ...state, panes, activePaneId });
    }

    case "navigate_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...applyPaneHrefTransition(p, action.href, action.mode),
              visibility: action.activate ? "visible" : p.visibility,
            }
          : p
      );
      return trimAndEnsureActivePaneId({
        ...state,
        panes,
        activePaneId: action.activate ? action.paneId : state.activePaneId,
      });
    }

    case "go_back_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      const href = pane?.history.back[pane.history.back.length - 1];
      if (!pane || !href) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              href,
              widthPx: resolvePaneTransitionWidth(
                p.href,
                href,
                p.widthPx,
                hasSamePaneResource(p.href, href)
              ),
              visibility: "visible" as const,
              history: {
                back: p.history.back.slice(0, -1),
                forward: [p.href, ...p.history.forward],
              },
            }
          : p
      );
      return trimAndEnsureActivePaneId({
        ...state,
        activePaneId: action.paneId,
        panes,
      });
    }

    case "go_forward_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      const href = pane?.history.forward[0];
      if (!pane || !href) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              href,
              widthPx: resolvePaneTransitionWidth(
                p.href,
                href,
                p.widthPx,
                hasSamePaneResource(p.href, href)
              ),
              visibility: "visible" as const,
              history: {
                back: [...p.history.back, p.href],
                forward: p.history.forward.slice(1),
              },
            }
          : p
      );
      return trimAndEnsureActivePaneId({
        ...state,
        activePaneId: action.paneId,
        panes,
      });
    }

    case "close_pane": {
      const closedIdx = state.panes.findIndex((p) => p.id === action.paneId);
      if (closedIdx < 0) {
        return state;
      }
      let panes = state.panes.filter((p) => p.id !== action.paneId);
      if (!panes.length) {
        return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
      }
      let { activePaneId } = state;
      if (
        activePaneId === action.paneId ||
        !panes.some((p) => p.id === activePaneId && p.visibility === "visible")
      ) {
        let replacementPane = panes.slice(closedIdx).find((p) => p.visibility === "visible");
        if (!replacementPane) {
          for (let i = Math.min(closedIdx - 1, panes.length - 1); i >= 0; i -= 1) {
            const candidate = panes[i];
            if (candidate?.visibility === "visible") {
              replacementPane = candidate;
              break;
            }
          }
        }
        if (replacementPane) {
          activePaneId = replacementPane.id;
        } else {
          const restoredPane = panes[Math.min(closedIdx, panes.length - 1)] ?? panes[0]!;
          activePaneId = restoredPane.id;
          panes = panes.map((p) =>
            p.id === activePaneId ? { ...p, visibility: "visible" } : p
          );
        }
      }
      return ensureActivePaneId({ ...state, panes, activePaneId });
    }

    case "resize_pane": {
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? { ...p, widthPx: clampPaneWidth(action.widthPx, p.href) }
          : p
      );
      return { ...state, panes };
    }

    case "minimize_pane": {
      const paneIndex = state.panes.findIndex((p) => p.id === action.paneId);
      const pane = state.panes[paneIndex];
      if (!pane || pane.visibility === "minimized") {
        return state;
      }
      if (state.panes.filter((p) => p.visibility === "visible").length <= 1) {
        return state;
      }

      let activePaneId = state.activePaneId;
      if (pane.id === state.activePaneId) {
        let replacementPane = state.panes
          .slice(paneIndex + 1)
          .find((p) => p.visibility === "visible");
        if (!replacementPane) {
          for (let i = paneIndex - 1; i >= 0; i -= 1) {
            const candidate = state.panes[i];
            if (candidate?.visibility === "visible") {
              replacementPane = candidate;
              break;
            }
          }
        }
        if (!replacementPane) {
          return state;
        }
        activePaneId = replacementPane.id;
      }

      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, visibility: "minimized" as const } : p
      );
      return { ...state, activePaneId, panes };
    }

    case "restore_pane": {
      if (!state.panes.some((p) => p.id === action.paneId)) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, visibility: "visible" as const } : p
      );
      return { ...state, activePaneId: action.paneId, panes };
    }
  }

  const exhaustiveAction: never = action;
  return exhaustiveAction;
}

// ---------------------------------------------------------------------------
// Build pane for an open action
// ---------------------------------------------------------------------------

function buildPanesForOpen(href: string): WorkspacePaneState[] {
  const mainId = createPaneId();
  return [
    {
      id: mainId,
      href,
      widthPx: getDefaultPaneWidthPx(href),
      visibility: "visible",
      history: createEmptyPaneHistory(),
    },
  ];
}

function findPaneIdForOpen(
  panes: WorkspacePaneState[],
  paneToOpen: WorkspacePaneState
): string {
  return (
    panes.find((item) => hasSamePaneResource(item.href, paneToOpen.href))?.id ??
    paneToOpen.id
  );
}

function upsertPaneTitleRecord(
  current: Map<string, WorkspacePaneTitleRecord>,
  paneId: string,
  record: WorkspacePaneTitleRecord
): Map<string, WorkspacePaneTitleRecord> {
  const existing = current.get(paneId);
  if (
    existing?.title === record.title &&
    existing.source === record.source &&
    existing.resourceKey === record.resourceKey
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(paneId, record);
  return next;
}

interface WorkspacePaneTitleInput {
  id: string;
  href: string;
}

export type WorkspacePaneTitleSource = "hint" | "runtime";

export interface WorkspacePaneTitleRecord {
  title: string;
  source: WorkspacePaneTitleSource;
  resourceKey: string;
}

export interface WorkspacePaneTitleDescriptor {
  chrome: PaneChromeDescriptor | undefined;
  resourceKey: string;
  route: ResolvedPaneRoute;
  title: string;
  titleState: "resolved" | "pending";
  titleSource: WorkspacePaneTitleSource | "static" | "fallback";
}

export function resolveWorkspacePaneTitle(
  pane: WorkspacePaneTitleInput,
  runtimeTitleByPaneId: ReadonlyMap<string, WorkspacePaneTitleRecord>
): WorkspacePaneTitleDescriptor {
  const route = resolvePaneRoute(pane.href);
  const { resourceKey } = resolvePaneRouteIdentity(pane.href);
  const chrome = route.definition?.getChrome?.({
    href: pane.href,
    params: route.params,
  });
  const titleRecord = runtimeTitleByPaneId.get(pane.id);
  if (titleRecord?.resourceKey === resourceKey) {
    const title = normalizePaneTitle(titleRecord.title);
    if (title) {
      return {
        chrome,
        resourceKey,
        route,
        title,
        titleState: "resolved",
        titleSource: titleRecord.source,
      };
    }
  }
  return {
    chrome,
    resourceKey,
    route,
    title: normalizePaneTitle(chrome?.title) ?? normalizePaneTitle(route.staticTitle) ?? "Pane",
    titleState: route.titleMode === "dynamic" ? "pending" : "resolved",
    titleSource: route.titleMode === "dynamic" ? "fallback" : "static",
  };
}

// ---------------------------------------------------------------------------
// Store context + provider
// ---------------------------------------------------------------------------

interface WorkspaceStoreValue {
  state: WorkspaceState;
  runtimeTitleByPaneId: ReadonlyMap<string, WorkspacePaneTitleRecord>;
  activatePane: (paneId: string) => void;
  openPane: (input: {
    href: string;
    openerPaneId?: string | null;
    activate?: boolean;
    replace?: boolean;
    titleHint?: string;
  }) => void;
  navigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean; titleHint?: string },
  ) => void;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizePane: (paneId: string, widthPx: number) => void;
  minimizePane: (paneId: string) => void;
  restorePane: (paneId: string) => void;
  publishPaneTitle: (input: {
    paneId: string;
    resourceKey: string;
    title: string | null;
  }) => void;
}

const WorkspaceStoreContext = createContext<WorkspaceStoreValue | null>(null);
function getWindowLocationState(): WorkspaceDecodeResult {
  if (typeof window === "undefined") {
    return {
      state: createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF),
      source: "inferred",
      errorCode: null,
    };
  }
  return decodeWorkspaceStateFromUrl(
    window.location.pathname,
    new URLSearchParams(window.location.search),
    {
      hash: window.location.hash,
      baseOrigin:
        window.location.origin && window.location.origin !== "null"
          ? window.location.origin
          : undefined,
    }
  );
}

export function WorkspaceStoreProvider({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [state, dispatch] = useReducer(
    workspaceReducer,
    null,
    () => createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF)
  );
  const [, setMeta] = useState<{
    lastDecodeError: WorkspaceDecodeResult["errorCode"];
    lastEncodeError: WorkspaceEncodeResult["errorCode"];
  }>({ lastDecodeError: null, lastEncodeError: null });
  const [runtimeTitleByPaneId, setRuntimeTitleByPaneId] = useState<
    Map<string, WorkspacePaneTitleRecord>
  >(() => new Map());
  const historyModeRef = useRef<HistoryMode>("replace");
  const skipSyncRef = useRef(false);
  const readyRef = useRef(false);
  const lastDecodeTelemetryRef = useRef("");
  const lastEncodeTelemetryRef = useRef("");
  const pendingTitleHintByResourceKeyRef = useRef<Map<string, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;

  const applyRestoredState = useCallback(
    (restored: WorkspaceState, urlIntent: WorkspaceState) =>
      dispatch({
        type: "hydrate",
        state: mergeRestoredWorkspaceWithUrlIntent(restored, urlIntent),
      }),
    []
  );
  useWorkspaceSession(state, mounted, applyRestoredState);

  const dispatchAndSync = useCallback(
    (action: WorkspaceAction, historyMode: HistoryMode = "replace") => {
      if (historyMode === "push" || historyModeRef.current !== "push") {
        historyModeRef.current = historyMode;
      }
      dispatch(action);
    },
    []
  );

  const publishPaneTitleHint = useCallback(
    (paneId: string, href: string, titleHint: string | undefined) => {
      if (!titleHint) {
        return;
      }
      const title = normalizePaneTitle(titleHint);
      if (!title) {
        return;
      }
      const record = {
        title,
        source: "hint" as const,
        resourceKey: resolvePaneRouteIdentity(href).resourceKey,
      };
      pendingTitleHintByResourceKeyRef.current.set(record.resourceKey, record.title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (existing?.source === "runtime" && existing.resourceKey === record.resourceKey) {
          return prev;
        }
        return upsertPaneTitleRecord(prev, paneId, record);
      });
    },
    []
  );

  const publishDecodeTelemetry = useCallback((decoded: WorkspaceDecodeResult) => {
    const key = `${decoded.source}:${decoded.errorCode ?? "ok"}`;
    if (lastDecodeTelemetryRef.current === key) return;
    lastDecodeTelemetryRef.current = key;
    emitWorkspaceTelemetry({
      type: "decode",
      status: decoded.errorCode
        ? decoded.source === "fallback" ? "fallback" : "error"
        : "ok",
      errorCode: decoded.errorCode,
    });
  }, []);

  // --- Hydrate from URL on mount ---
  useEffect(() => {
    const decoded = getWindowLocationState();
    dispatch({ type: "hydrate", state: decoded.state });
    setMeta((prev) => ({ ...prev, lastDecodeError: decoded.errorCode }));
    publishDecodeTelemetry(decoded);
    setMounted(true);
  }, [publishDecodeTelemetry]);

  // --- Event listeners: popstate, open-pane events ---
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (readyRef.current) return;
    readyRef.current = true;

    const handlePopState = () => {
      const decoded = getWindowLocationState();
      skipSyncRef.current = true;
      dispatch({ type: "hydrate", state: decoded.state });
      setMeta((prev) => ({ ...prev, lastDecodeError: decoded.errorCode }));
      publishDecodeTelemetry(decoded);
    };

    const handleOpenPaneDetail = (detail: OpenInAppPaneDetail) => {
      const href = normalizeWorkspaceHref(detail.href);
      if (!href) return;
      const panes = buildPanesForOpen(href);
      const targetPaneId = findPaneIdForOpen(stateRef.current.panes, panes[0]!);
      publishPaneTitleHint(targetPaneId, href, detail.titleHint);
      dispatchAndSync(
        {
          type: "open_pane",
          panes,
          afterPaneId: null,
          activate: true,
          mode: "push",
        },
        "push"
      );
    };

    const handleOpenPaneEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenInAppPaneDetail>).detail;
      if (detail?.href) handleOpenPaneDetail(detail);
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      if (!isOpenInAppPaneMessage(event.data)) return;
      handleOpenPaneDetail({
        href: event.data.href,
        titleHint: event.data.titleHint,
      });
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
    window.addEventListener("message", handleWindowMessage);
    setPaneGraphReady(true);
    for (const queued of consumePendingPaneOpenQueue()) {
      handleOpenPaneDetail(queued);
    }

    return () => {
      readyRef.current = false;
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
      window.removeEventListener("message", handleWindowMessage);
      setPaneGraphReady(false);
    };
  }, [dispatchAndSync, publishDecodeTelemetry, publishPaneTitleHint]);

  // --- Prune stale title caches when panes change ---
  useEffect(() => {
    const currentResourceKeyByPaneId = new Map<string, string>();
    for (const pane of state.panes) {
      currentResourceKeyByPaneId.set(
        pane.id,
        resolvePaneRouteIdentity(pane.href).resourceKey,
      );
    }

    setRuntimeTitleByPaneId((prev) => {
      let changed = false;
      const next = new Map<string, WorkspacePaneTitleRecord>();
      for (const [id, record] of prev) {
        if (record.resourceKey !== currentResourceKeyByPaneId.get(id)) {
          changed = true;
          continue;
        }
        next.set(id, record);
      }
      return changed || next.size !== prev.size ? next : prev;
    });

  }, [state.panes]);

  // --- Apply title hints to the live pane after open-pane de-duplication ---
  useEffect(() => {
    const pending = pendingTitleHintByResourceKeyRef.current;
    if (pending.size === 0) {
      return;
    }

    const paneByResourceKey = new Map(
      state.panes.map((pane) => [resolvePaneRouteIdentity(pane.href).resourceKey, pane]),
    );
    const records: Array<{ paneId: string; record: WorkspacePaneTitleRecord }> = [];
    for (const [resourceKey, title] of pending) {
      const pane = paneByResourceKey.get(resourceKey);
      pending.delete(resourceKey);
      if (!pane) continue;
      records.push({
        paneId: pane.id,
        record: { title, source: "hint", resourceKey },
      });
    }
    if (records.length === 0) {
      return;
    }

    setRuntimeTitleByPaneId((prev) => {
      let next = prev;
      for (const { paneId, record } of records) {
        const existing = next.get(paneId);
        if (existing?.source === "runtime" && existing.resourceKey === record.resourceKey) {
          continue;
        }
        next = upsertPaneTitleRecord(next, paneId, record);
      }
      return next;
    });
  }, [state.panes]);

  // --- Sync state → URL ---
  useEffect(() => {
    if (typeof window === "undefined" || !readyRef.current || !mounted) return;
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
      historyModeRef.current = "replace";
      return;
    }

    const { href, errorCode } = buildWorkspaceUrl(state, {
      baseOrigin:
        window.location.origin && window.location.origin !== "null"
          ? window.location.origin
          : undefined,
    });
    setMeta((prev) => ({ ...prev, lastEncodeError: errorCode }));
    const encodeKey = errorCode ?? "ok";
    if (lastEncodeTelemetryRef.current !== encodeKey) {
      lastEncodeTelemetryRef.current = encodeKey;
      emitWorkspaceTelemetry({ type: "encode", status: errorCode ? "error" : "ok", errorCode });
    }

    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!errorCode && href !== currentHref) {
      if (historyModeRef.current === "push") {
        window.history.pushState({}, "", href);
      } else {
        window.history.replaceState({}, "", href);
      }
    }
    historyModeRef.current = "replace";
  }, [mounted, state]);

  // --- Stable callbacks ---

  const activatePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "activate_pane", paneId }, "replace"),
    [dispatchAndSync]
  );

  const openPane = useCallback(
    (input: {
      href: string;
      openerPaneId?: string | null;
      activate?: boolean;
      replace?: boolean;
      titleHint?: string;
    }) => {
      const href = normalizeWorkspaceHref(input.href);
      if (!href) return;
      const panes = buildPanesForOpen(href);
      const targetPaneId = findPaneIdForOpen(stateRef.current.panes, panes[0]!);
      publishPaneTitleHint(targetPaneId, href, input.titleHint);
      const mode = input.replace ? "replace" : "push";
      dispatchAndSync(
        {
          type: "open_pane",
          panes,
          afterPaneId: input.openerPaneId ?? null,
          activate: input.activate ?? true,
          mode,
        },
        mode
      );
    },
    [dispatchAndSync, publishPaneTitleHint]
  );

  const navigatePane = useCallback(
    (
      paneId: string,
      href: string,
      options?: { replace?: boolean; activate?: boolean; titleHint?: string },
    ) => {
      const normalized = normalizeWorkspaceHref(href);
      if (!normalized) return;
      publishPaneTitleHint(paneId, normalized, options?.titleHint);
      dispatchAndSync(
        {
          type: "navigate_pane",
          paneId,
          href: normalized,
          activate: options?.activate ?? true,
          mode: options?.replace ? "replace" : "push",
        },
        options?.replace ? "replace" : "push"
      );
    },
    [dispatchAndSync, publishPaneTitleHint]
  );

  const goBackPane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "go_back_pane", paneId }, "replace"),
    [dispatchAndSync]
  );

  const goForwardPane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "go_forward_pane", paneId }, "replace"),
    [dispatchAndSync]
  );

  const closePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "close_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const resizePane = useCallback(
    (paneId: string, widthPx: number) =>
      dispatchAndSync({ type: "resize_pane", paneId, widthPx }, "replace"),
    [dispatchAndSync]
  );

  const minimizePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "minimize_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const restorePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "restore_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const publishPaneTitle = useCallback(
    (input: { paneId: string; resourceKey: string; title: string | null }) => {
      const { paneId, resourceKey, title } = input;
      const pane = stateRef.current.panes.find((p) => p.id === paneId);
      if (!pane) return;
      if (resolvePaneRouteIdentity(pane.href).resourceKey !== resourceKey) return;

      const normalized = normalizePaneTitle(title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (!normalized) {
          if (existing?.source !== "runtime" || existing.resourceKey !== resourceKey) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(paneId);
          return next;
        }
        return upsertPaneTitleRecord(prev, paneId, {
          title: normalized,
          source: "runtime",
          resourceKey,
        });
      });

    },
    []
  );

  const value = useMemo<WorkspaceStoreValue>(
    () => ({
      state,
      runtimeTitleByPaneId,
      activatePane,
      openPane,
      navigatePane,
      goBackPane,
      goForwardPane,
      closePane,
      resizePane,
      minimizePane,
      restorePane,
      publishPaneTitle,
    }),
    [
      state,
      runtimeTitleByPaneId,
      activatePane,
      openPane,
      navigatePane,
      goBackPane,
      goForwardPane,
      closePane,
      resizePane,
      minimizePane,
      restorePane,
      publishPaneTitle,
    ]
  );

  if (!mounted) return null;

  return <WorkspaceStoreContext.Provider value={value}>{children}</WorkspaceStoreContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStoreValue {
  const value = useContext(WorkspaceStoreContext);
  if (!value) {
    throw new Error("useWorkspaceStore must be used inside WorkspaceStoreProvider");
  }
  return value;
}
