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
  normalizeWorkspaceHref,
  type WorkspacePaneStateV3,
  type WorkspaceStateV3,
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
  normalizePaneHref,
  setPaneGraphReady,
  type OpenInAppPaneDetail,
} from "@/lib/panes/openInAppPane";
import {
  createResourceTitleCacheEntry,
  loadResourceTitleCacheFromStorage,
  normalizePaneTitle,
  pruneResourceTitleCache,
  RESOURCE_TITLE_CACHE_TTL_MS,
  saveResourceTitleCacheToStorage,
  type PaneOpenHint,
  type ResourceTitleCacheEntry,
} from "@/lib/workspace/paneDescriptor";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";
import { apiFetch } from "@/lib/api/client";

type HistoryMode = "replace" | "push";

type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceStateV3 }
  | { type: "activate_pane"; paneId: string }
  | { type: "open_pane"; panes: WorkspacePaneStateV3[]; afterPaneId: string | null; activate: boolean }
  | { type: "navigate_pane"; paneId: string; href: string }
  | { type: "close_pane"; paneId: string }
  | { type: "resize_pane"; paneId: string; widthPx: number };

function ensureActivePaneId(state: WorkspaceStateV3): WorkspaceStateV3 {
  if (!state.panes.length) {
    return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
  }
  if (state.panes.some((p) => p.id === state.activePaneId)) {
    return state;
  }
  return { ...state, activePaneId: state.panes[0]!.id };
}

function workspaceReducer(state: WorkspaceStateV3, action: WorkspaceAction): WorkspaceStateV3 {
  switch (action.type) {
    case "hydrate":
      return ensureActivePaneId(action.state);

    case "activate_pane": {
      if (!state.panes.some((p) => p.id === action.paneId)) {
        return state;
      }
      return { ...state, activePaneId: action.paneId };
    }

    case "open_pane": {
      let panes = state.panes;
      if (panes.length + action.panes.length > MAX_PANES) {
        // Drop oldest non-active panes to make room
        const keep = MAX_PANES - action.panes.length;
        panes = panes.filter((p) => p.id === state.activePaneId).concat(
          panes.filter((p) => p.id !== state.activePaneId).slice(-(keep - 1))
        );
      }
      const insertIdx = action.afterPaneId
        ? panes.findIndex((p) => p.id === action.afterPaneId) + 1
        : panes.length;
      const next = [...panes.slice(0, insertIdx), ...action.panes, ...panes.slice(insertIdx)];
      const activePaneId = action.activate ? action.panes[0]!.id : state.activePaneId;
      return ensureActivePaneId({ ...state, panes: next, activePaneId });
    }

    case "navigate_pane": {
      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, href: action.href } : p
      );
      return { ...state, panes, activePaneId: action.paneId };
    }

    case "close_pane": {
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      if (!panes.length) {
        return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
      }
      let { activePaneId } = state;
      if (activePaneId === action.paneId) {
        const closedIdx = state.panes.findIndex((p) => p.id === action.paneId);
        activePaneId = panes[Math.min(closedIdx, panes.length - 1)]?.id ?? panes[0]!.id;
      }
      return ensureActivePaneId({ ...state, panes, activePaneId });
    }

    case "resize_pane": {
      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, widthPx: clampPaneWidth(action.widthPx) } : p
      );
      return { ...state, panes };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Build pane for an open action
// ---------------------------------------------------------------------------

function buildPanesForOpen(href: string): WorkspacePaneStateV3[] {
  const route = resolvePaneRoute(href);
  const mainId = createPaneId();
  return [
    {
      id: mainId,
      href,
      widthPx: route.definition?.defaultWidthPx ?? 480,
    },
  ];
}

// ---------------------------------------------------------------------------
// Store context + provider
// ---------------------------------------------------------------------------

interface WorkspaceStoreValue {
  state: WorkspaceStateV3;
  runtimeTitleByPaneId: ReadonlyMap<string, string>;
  openHintByPaneId: ReadonlyMap<string, PaneOpenHint>;
  resourceTitleByRef: ReadonlyMap<string, ResourceTitleCacheEntry>;
  activatePane: (paneId: string) => void;
  openPane: (input: { href: string; openerPaneId?: string | null; activate?: boolean }) => void;
  navigatePane: (paneId: string, href: string, options?: { replace?: boolean }) => void;
  closePane: (paneId: string) => void;
  resizePane: (paneId: string, widthPx: number) => void;
  publishPaneTitle: (
    paneId: string,
    title: string | null,
    options?: { resourceRef?: string | null }
  ) => void;
}

const WorkspaceStoreContext = createContext<WorkspaceStoreValue | null>(null);
const COMMAND_PALETTE_RECENTS_PATH = "/api/me/command-palette-recents";

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
  const [openHintByPaneId, setOpenHintByPaneId] = useState<Map<string, PaneOpenHint>>(
    () => new Map()
  );
  const [resourceTitleByRef, setResourceTitleByRef] = useState<
    Map<string, ResourceTitleCacheEntry>
  >(() => loadResourceTitleCacheFromStorage(Date.now()));
  const historyModeRef = useRef<HistoryMode>("replace");
  const skipSyncRef = useRef(false);
  const readyRef = useRef(false);
  const lastDecodeTelemetryRef = useRef("");
  const lastEncodeTelemetryRef = useRef("");
  const paneHrefByIdRef = useRef<Map<string, string>>(new Map());
  const pendingRecentHrefByPaneIdRef = useRef<Map<string, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  const openHintRef = useRef(openHintByPaneId);
  openHintRef.current = openHintByPaneId;

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

  const upsertResourceTitle = useCallback((resourceRef: string, title: string) => {
    const ref = resourceRef.trim();
    const normalized = normalizePaneTitle(title);
    if (!ref || !normalized) return;
    setResourceTitleByRef((prev) => {
      const nowMs = Date.now();
      const next = pruneResourceTitleCache(prev, nowMs);
      const entry = createResourceTitleCacheEntry(normalized, nowMs, RESOURCE_TITLE_CACHE_TTL_MS);
      if (!entry) return next;
      next.set(ref, entry);
      return next;
    });
  }, []);

  const setOpenHint = useCallback((paneId: string, hint: PaneOpenHint) => {
    const titleHint = normalizePaneTitle(hint.titleHint) ?? undefined;
    const resourceRef =
      typeof hint.resourceRef === "string" && hint.resourceRef.trim().length > 0
        ? hint.resourceRef.trim()
        : undefined;
    if (!titleHint && !resourceRef) return;
    setOpenHintByPaneId((prev) => {
      const next = new Map(prev);
      next.set(paneId, { titleHint, resourceRef });
      return next;
    });
    if (titleHint && resourceRef) {
      upsertResourceTitle(resourceRef, titleHint);
    }
  }, [upsertResourceTitle]);

  const postCommandPaletteRecent = useCallback(
    (href: string, titleSnapshot?: string | null) => {
      const title = normalizePaneTitle(titleSnapshot);
      const body = title ? { href, title_snapshot: title } : { href };
      void apiFetch(COMMAND_PALETTE_RECENTS_PATH, {
        method: "POST",
        body: JSON.stringify(body),
      }).catch(() => {});
    },
    []
  );

  const recordUserDrivenRecent = useCallback(
    (paneId: string, href: string, titleSnapshot?: string | null) => {
      pendingRecentHrefByPaneIdRef.current.set(paneId, href);
      postCommandPaletteRecent(href, titleSnapshot);
    },
    [postCommandPaletteRecent]
  );

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
      const href = normalizePaneHref(detail.href) ?? normalizeWorkspaceHref(detail.href);
      if (!href) return;
      const panes = buildPanesForOpen(href);
      const targetPaneId = panes[0]!.id;
      const titleHint = normalizePaneTitle(detail.titleHint) ?? undefined;
      const resourceRef =
        typeof detail.resourceRef === "string" && detail.resourceRef.trim().length > 0
          ? detail.resourceRef.trim()
          : undefined;
      if (titleHint || resourceRef) {
        setOpenHint(targetPaneId, { titleHint, resourceRef });
      }
      recordUserDrivenRecent(targetPaneId, href, titleHint);
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
        resourceRef: event.data.resourceRef,
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
  }, [publishDecodeTelemetry, recordUserDrivenRecent, setOpenHint]);

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

    setOpenHintByPaneId((prev) => {
      let changed = false;
      const next = new Map<string, PaneOpenHint>();
      for (const [id, hint] of prev) {
        if (!livePaneIds.has(id) || changedHrefIds.has(id)) { changed = true; continue; }
        next.set(id, hint);
      }
      return changed || next.size !== prev.size ? next : prev;
    });

    pendingRecentHrefByPaneIdRef.current = new Map(
      Array.from(pendingRecentHrefByPaneIdRef.current.entries()).filter(
        ([paneId, href]) =>
          livePaneIds.has(paneId) && nextHrefById.get(paneId) === href
      )
    );
  }, [state.panes]);

  // --- Persist resource title cache ---
  useEffect(() => {
    saveResourceTitleCacheToStorage(resourceTitleByRef, Date.now());
  }, [resourceTitleByRef]);

  // --- Sync state → URL ---
  useEffect(() => {
    if (typeof window === "undefined" || !readyRef.current) return;
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
  }, [state]);

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
      recordUserDrivenRecent(panes[0]!.id, href);
      if (input.openerPaneId) {
        // Title hints are set by the opener's publishPaneTitle, not here
      }
      dispatchAndSync(
        { type: "open_pane", panes, afterPaneId: input.openerPaneId ?? null, activate: input.activate ?? true },
        "push"
      );
    },
    [dispatchAndSync, recordUserDrivenRecent]
  );

  const navigatePane = useCallback(
    (paneId: string, href: string, options?: { replace?: boolean }) => {
      const normalized = normalizeWorkspaceHref(href);
      if (!normalized) return;
      recordUserDrivenRecent(paneId, normalized);
      dispatchAndSync(
        { type: "navigate_pane", paneId, href: normalized },
        options?.replace ? "replace" : "push"
      );
    },
    [dispatchAndSync, recordUserDrivenRecent]
  );

  const closePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "close_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const resizePane = useCallback(
    (paneId: string, widthPx: number) => dispatchAndSync({ type: "resize_pane", paneId, widthPx }, "replace"),
    [dispatchAndSync]
  );

  const publishPaneTitle = useCallback(
    (paneId: string, title: string | null, options?: { resourceRef?: string | null }) => {
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

      if (!normalized) return;
      const resourceRef = options?.resourceRef ?? openHintRef.current.get(paneId)?.resourceRef ?? null;
      if (resourceRef) upsertResourceTitle(resourceRef, normalized);
      const pendingHref = pendingRecentHrefByPaneIdRef.current.get(paneId);
      if (pendingHref && pendingHref === pane.href) {
        pendingRecentHrefByPaneIdRef.current.delete(paneId);
        postCommandPaletteRecent(pane.href, normalized);
      }
    },
    [postCommandPaletteRecent, upsertResourceTitle]
  );

  const value = useMemo<WorkspaceStoreValue>(
    () => ({
      state,
      runtimeTitleByPaneId,
      openHintByPaneId,
      resourceTitleByRef,
      activatePane,
      openPane,
      navigatePane,
      closePane,
      resizePane,
      publishPaneTitle,
    }),
    [
      state, runtimeTitleByPaneId, openHintByPaneId, resourceTitleByRef,
      activatePane, openPane, navigatePane, closePane,
      resizePane, publishPaneTitle,
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
