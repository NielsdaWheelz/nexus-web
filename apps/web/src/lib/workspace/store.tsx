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
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  clampPaneWidth,
  createDefaultWorkspaceState,
  createPaneId,
  normalizePaneTitle,
  normalizeWorkspaceHref,
  type WorkspacePaneStateV4,
  type WorkspaceStateV4,
} from "@/lib/workspace/schema";
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
  resolvePaneRoute,
  type PaneChromeDescriptor,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteRegistry";

type HistoryMode = "replace" | "push";

type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceStateV4 }
  | { type: "activate_pane"; paneId: string }
  | {
      type: "open_pane";
      panes: WorkspacePaneStateV4[];
      afterPaneId: string | null;
      activate: boolean;
    }
  | { type: "navigate_pane"; paneId: string; href: string; activate: boolean }
  | { type: "close_pane"; paneId: string }
  | { type: "resize_pane"; paneId: string; widthPx: number }
  | { type: "minimize_pane"; paneId: string }
  | { type: "restore_pane"; paneId: string };

function ensureActivePaneId(state: WorkspaceStateV4): WorkspaceStateV4 {
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

function workspaceReducer(state: WorkspaceStateV4, action: WorkspaceAction): WorkspaceStateV4 {
  switch (action.type) {
    case "hydrate":
      return ensureActivePaneId(action.state);

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
        const paneToOpen = { ...pane, visibility: "visible" as const };
        const resourceRef = resolvePaneRoute(paneToOpen.href).resourceRef;
        const existingPane = resourceRef
          ? panes.find((item) => resolvePaneRoute(item.href).resourceRef === resourceRef)
          : undefined;

        if (existingPane) {
          panes = panes.map((item) =>
            item.id === existingPane.id
              ? { ...item, href: paneToOpen.href, widthPx: paneToOpen.widthPx, visibility: "visible" }
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

      return ensureActivePaneId({ ...state, panes, activePaneId });
    }

    case "navigate_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              href: action.href,
              visibility: action.activate ? "visible" : p.visibility,
            }
          : p
      );
      return ensureActivePaneId({
        ...state,
        panes,
        activePaneId: action.activate ? action.paneId : state.activePaneId,
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
        p.id === action.paneId ? { ...p, widthPx: clampPaneWidth(action.widthPx) } : p
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

function buildPanesForOpen(href: string): WorkspacePaneStateV4[] {
  const route = resolvePaneRoute(href);
  const mainId = createPaneId();
  return [
    {
      id: mainId,
      href,
      widthPx: route.definition?.defaultWidthPx ?? 480,
      visibility: "visible",
    },
  ];
}

export type WorkspacePaneTitleSource = "runtime_page" | "route";

interface WorkspacePaneTitleInput {
  id: string;
  href: string;
}

export interface WorkspacePaneTitleDescriptor {
  chrome: PaneChromeDescriptor | undefined;
  route: ResolvedPaneRoute;
  title: string;
  titleSource: WorkspacePaneTitleSource;
}

export function resolveWorkspacePaneTitle(
  pane: WorkspacePaneTitleInput,
  runtimeTitleByPaneId: ReadonlyMap<string, string>
): WorkspacePaneTitleDescriptor {
  const route = resolvePaneRoute(pane.href);
  const chrome = route.definition?.getChrome?.({
    href: pane.href,
    params: route.params,
  });
  const runtimeTitle = normalizePaneTitle(runtimeTitleByPaneId.get(pane.id));
  if (runtimeTitle) {
    return { chrome, route, title: runtimeTitle, titleSource: "runtime_page" };
  }
  return {
    chrome,
    route,
    title: normalizePaneTitle(chrome?.title) ?? normalizePaneTitle(route.staticTitle) ?? "Pane",
    titleSource: "route",
  };
}

// ---------------------------------------------------------------------------
// Store context + provider
// ---------------------------------------------------------------------------

interface WorkspaceStoreValue {
  state: WorkspaceStateV4;
  runtimeTitleByPaneId: ReadonlyMap<string, string>;
  activatePane: (paneId: string) => void;
  openPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  navigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean },
  ) => void;
  closePane: (paneId: string) => void;
  resizePane: (paneId: string, widthPx: number) => void;
  minimizePane: (paneId: string) => void;
  restorePane: (paneId: string) => void;
  publishPaneTitle: (paneId: string, title: string | null) => void;
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
  const [runtimeTitleByPaneId, setRuntimeTitleByPaneId] = useState<Map<string, string>>(
    () => new Map()
  );
  const historyModeRef = useRef<HistoryMode>("replace");
  const skipSyncRef = useRef(false);
  const readyRef = useRef(false);
  const lastDecodeTelemetryRef = useRef("");
  const lastEncodeTelemetryRef = useRef("");
  const paneHrefByIdRef = useRef<Map<string, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatchAndSync = useCallback(
    (action: WorkspaceAction, historyMode: HistoryMode = "replace") => {
      historyModeRef.current = historyMode;
      dispatch(action);
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
      historyModeRef.current = "push";
      dispatch({ type: "open_pane", panes, afterPaneId: null, activate: true });
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
  }, [publishDecodeTelemetry]);

  // --- Prune stale title caches when panes change ---
  useEffect(() => {
    const livePaneIds = new Set<string>();
    const nextHrefById = new Map<string, string>();
    const changedHrefIds = new Set<string>();

    for (const pane of state.panes) {
      livePaneIds.add(pane.id);
      nextHrefById.set(pane.id, pane.href);
      const prev = paneHrefByIdRef.current.get(pane.id);
      if (prev && prev !== pane.href) changedHrefIds.add(pane.id);
    }
    paneHrefByIdRef.current = nextHrefById;

    setRuntimeTitleByPaneId((prev) => {
      let changed = false;
      const next = new Map<string, string>();
      for (const [id, title] of prev) {
        if (!livePaneIds.has(id) || changedHrefIds.has(id)) { changed = true; continue; }
        next.set(id, title);
      }
      return changed || next.size !== prev.size ? next : prev;
    });

  }, [state.panes]);

  // --- Sync state → URL ---
  useEffect(() => {
    if (typeof window === "undefined" || !readyRef.current || !mounted) return;
    if (skipSyncRef.current) { skipSyncRef.current = false; return; }

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
    if (href !== currentHref) {
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
    (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => {
      const href = normalizeWorkspaceHref(input.href);
      if (!href) return;
      const panes = buildPanesForOpen(href);
      dispatchAndSync(
        { type: "open_pane", panes, afterPaneId: input.openerPaneId ?? null, activate: input.activate ?? true },
        "push"
      );
    },
    [dispatchAndSync]
  );

  const navigatePane = useCallback(
    (paneId: string, href: string, options?: { replace?: boolean; activate?: boolean }) => {
      const normalized = normalizeWorkspaceHref(href);
      if (!normalized) return;
      dispatchAndSync(
        {
          type: "navigate_pane",
          paneId,
          href: normalized,
          activate: options?.activate ?? true,
        },
        options?.replace ? "replace" : "push"
      );
    },
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
    (paneId: string, title: string | null) => {
      const pane = stateRef.current.panes.find((p) => p.id === paneId);
      if (!pane) return;

      const normalized = normalizePaneTitle(title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (normalized ? existing === normalized : !existing) return prev;
        const next = new Map(prev);
        if (!normalized) { next.delete(paneId); } else { next.set(paneId, normalized); }
        return next;
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

export { workspaceReducer };
