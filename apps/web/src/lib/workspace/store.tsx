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
  type Dispatch,
} from "react";
import {
  MAX_PANE_GROUPS,
  MAX_TABS_PER_GROUP,
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  createDefaultWorkspaceState,
  createWorkspaceId,
  normalizeWorkspaceHref,
  type WorkspacePaneGroupStateV2,
  type WorkspaceStateV2,
  type WorkspaceTabStateV2,
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

type HistoryMode = "replace" | "push";

interface WorkspaceStoreMeta {
  lastDecodeError: WorkspaceDecodeResult["errorCode"];
  lastEncodeError: WorkspaceEncodeResult["errorCode"];
}

interface OpenTabOptions {
  groupId?: string;
  activate?: boolean;
  historyMode?: HistoryMode;
}

interface OpenGroupWithTabOptions {
  historyMode?: HistoryMode;
}

interface NavigateTabOptions {
  replace?: boolean;
}

interface WorkspaceStoreValue {
  state: WorkspaceStateV2;
  meta: WorkspaceStoreMeta;
  activateGroup: (groupId: string) => void;
  activateTab: (groupId: string, tabId: string) => void;
  openTab: (href: string, options?: OpenTabOptions) => void;
  openGroupWithTab: (href: string, options?: OpenGroupWithTabOptions) => void;
  navigateTab: (
    groupId: string,
    tabId: string,
    href: string,
    options?: NavigateTabOptions
  ) => void;
  closeTab: (groupId: string, tabId: string) => void;
  closeGroup: (groupId: string) => void;
  setGroupWidth: (groupId: string, widthPx: number) => void;
  replaceState: (nextState: WorkspaceStateV2) => void;
}

type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceStateV2 }
  | { type: "activate_group"; groupId: string }
  | { type: "activate_tab"; groupId: string; tabId: string }
  | {
      type: "open_tab";
      href: string;
      groupId?: string;
      activate: boolean;
    }
  | { type: "open_group_with_tab"; href: string }
  | { type: "navigate_tab"; groupId: string; tabId: string; href: string }
  | { type: "close_tab"; groupId: string; tabId: string }
  | { type: "close_group"; groupId: string }
  | { type: "set_group_width"; groupId: string; widthPx: number };

const WorkspaceStoreContext = createContext<WorkspaceStoreValue | null>(null);

function ensureActiveGroup(state: WorkspaceStateV2): WorkspaceStateV2 {
  if (!state.groups.length) {
    return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
  }
  const active = state.groups.find((group) => group.id === state.activeGroupId);
  if (active) {
    return state;
  }
  return {
    ...state,
    activeGroupId: state.groups[0]?.id ?? state.activeGroupId,
  };
}

function ensureActiveTab(group: WorkspacePaneGroupStateV2): WorkspacePaneGroupStateV2 {
  if (!group.tabs.length) {
    return group;
  }
  if (group.tabs.some((tab) => tab.id === group.activeTabId)) {
    return group;
  }
  return { ...group, activeTabId: group.tabs[0]?.id ?? group.activeTabId };
}

function evictToMaxTabs(tabs: WorkspaceTabStateV2[], maxTabs: number): WorkspaceTabStateV2[] {
  if (tabs.length <= maxTabs) {
    return tabs;
  }
  return tabs.slice(tabs.length - maxTabs);
}

function openTabInGroup(
  group: WorkspacePaneGroupStateV2,
  href: string,
  activate: boolean
): WorkspacePaneGroupStateV2 {
  const nextTab = { id: createWorkspaceId("tab"), href };
  const nextTabs = evictToMaxTabs([...group.tabs, nextTab], MAX_TABS_PER_GROUP);
  const activeTabId = activate ? nextTab.id : group.activeTabId;
  return ensureActiveTab({
    ...group,
    tabs: nextTabs,
    activeTabId,
  });
}

function openGroupWithSingleTab(state: WorkspaceStateV2, href: string): WorkspaceStateV2 {
  const nextTabId = createWorkspaceId("tab");
  const nextGroupId = createWorkspaceId("group");
  const nextGroup: WorkspacePaneGroupStateV2 = {
    id: nextGroupId,
    activeTabId: nextTabId,
    tabs: [{ id: nextTabId, href }],
  };

  let groups = [...state.groups, nextGroup];
  if (groups.length > MAX_PANE_GROUPS) {
    const activeId = state.activeGroupId;
    const dropIdx = groups.findIndex((group) => group.id !== activeId);
    const removeIdx = dropIdx >= 0 ? dropIdx : 0;
    groups = groups.filter((_, idx) => idx !== removeIdx);
  }

  return ensureActiveGroup({
    ...state,
    groups,
    activeGroupId: nextGroupId,
  });
}

function workspaceReducer(state: WorkspaceStateV2, action: WorkspaceAction): WorkspaceStateV2 {
  switch (action.type) {
    case "hydrate":
      return ensureActiveGroup(action.state);
    case "activate_group": {
      if (!state.groups.some((group) => group.id === action.groupId)) {
        return state;
      }
      return { ...state, activeGroupId: action.groupId };
    }
    case "activate_tab": {
      const groups = state.groups.map((group) => {
        if (group.id !== action.groupId) {
          return group;
        }
        if (!group.tabs.some((tab) => tab.id === action.tabId)) {
          return group;
        }
        return { ...group, activeTabId: action.tabId };
      });
      return ensureActiveGroup({
        ...state,
        groups,
        activeGroupId: action.groupId,
      });
    }
    case "open_tab": {
      const targetGroupId = action.groupId ?? state.activeGroupId;
      if (!state.groups.some((group) => group.id === targetGroupId)) {
        return openGroupWithSingleTab(state, action.href);
      }
      const groups = state.groups.map((group) =>
        group.id === targetGroupId ? openTabInGroup(group, action.href, action.activate) : group
      );
      return ensureActiveGroup({
        ...state,
        groups,
        activeGroupId: action.activate ? targetGroupId : state.activeGroupId,
      });
    }
    case "open_group_with_tab":
      return openGroupWithSingleTab(state, action.href);
    case "navigate_tab": {
      const groups = state.groups.map((group) => {
        if (group.id !== action.groupId) {
          return group;
        }
        if (!group.tabs.some((tab) => tab.id === action.tabId)) {
          return group;
        }
        return {
          ...group,
          tabs: group.tabs.map((tab) =>
            tab.id === action.tabId ? { ...tab, href: action.href } : tab
          ),
          activeTabId: action.tabId,
        };
      });
      return ensureActiveGroup({
        ...state,
        groups,
        activeGroupId: action.groupId,
      });
    }
    case "close_tab": {
      const groups: WorkspacePaneGroupStateV2[] = [];
      let nextActiveGroupId = state.activeGroupId;
      for (const group of state.groups) {
        if (group.id !== action.groupId) {
          groups.push(group);
          continue;
        }
        const nextTabs = group.tabs.filter((tab) => tab.id !== action.tabId);
        if (nextTabs.length === 0) {
          continue;
        }
        const nextGroup = ensureActiveTab({
          ...group,
          tabs: nextTabs,
          activeTabId:
            group.activeTabId === action.tabId ? nextTabs[0]?.id ?? group.activeTabId : group.activeTabId,
        });
        groups.push(nextGroup);
      }
      if (groups.length === 0) {
        return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
      }
      if (!groups.some((group) => group.id === nextActiveGroupId)) {
        nextActiveGroupId = groups[0]?.id ?? nextActiveGroupId;
      }
      return ensureActiveGroup({
        ...state,
        groups,
        activeGroupId: nextActiveGroupId,
      });
    }
    case "close_group": {
      if (state.groups.length <= 1) {
        return state;
      }
      const groups = state.groups.filter((group) => group.id !== action.groupId);
      if (!groups.length) {
        return state;
      }
      return ensureActiveGroup({
        ...state,
        groups,
        activeGroupId:
          state.activeGroupId === action.groupId
            ? groups[0]?.id ?? state.activeGroupId
            : state.activeGroupId,
      });
    }
    case "set_group_width": {
      const groups = state.groups.map((group) =>
        group.id === action.groupId
          ? {
              ...group,
              widthPx: Math.round(action.widthPx),
            }
          : group
      );
      return { ...state, groups };
    }
    default:
      return state;
  }
}

function getWindowLocationState(): WorkspaceDecodeResult {
  if (typeof window === "undefined") {
    return {
      state: createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF),
      source: "fallback",
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
  const [meta, setMeta] = useState<WorkspaceStoreMeta>({
    lastDecodeError: null,
    lastEncodeError: null,
  });
  const historyModeRef = useRef<HistoryMode>("replace");
  const skipSyncRef = useRef(false);
  const readyRef = useRef(false);
  const lastDecodeTelemetryRef = useRef<string>("");
  const lastEncodeTelemetryRef = useRef<string>("");

  const setHistoryMode = useCallback((mode: HistoryMode) => {
    historyModeRef.current = mode;
  }, []);

  const dispatchAndSync = useCallback(
    (action: WorkspaceAction, historyMode: HistoryMode = "replace") => {
      setHistoryMode(historyMode);
      dispatch(action);
    },
    [setHistoryMode]
  );

  const publishDecodeTelemetry = useCallback((decoded: WorkspaceDecodeResult) => {
    const key = `${decoded.source}:${decoded.errorCode ?? "ok"}`;
    if (lastDecodeTelemetryRef.current === key) {
      return;
    }
    lastDecodeTelemetryRef.current = key;
    emitWorkspaceTelemetry({
      type: "decode",
      status: decoded.errorCode
        ? decoded.source === "fallback"
          ? "fallback"
          : "error"
        : "ok",
      errorCode: decoded.errorCode,
    });
  }, []);

  useEffect(() => {
    const decoded = getWindowLocationState();
    dispatch({ type: "hydrate", state: decoded.state });
    setMeta((prev) => ({ ...prev, lastDecodeError: decoded.errorCode }));
    publishDecodeTelemetry(decoded);
    setMounted(true);
  }, [publishDecodeTelemetry]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (readyRef.current) {
      return;
    }
    readyRef.current = true;
    const handlePopState = () => {
      const decoded = getWindowLocationState();
      skipSyncRef.current = true;
      dispatch({ type: "hydrate", state: decoded.state });
      setMeta((prev) => ({ ...prev, lastDecodeError: decoded.errorCode }));
      publishDecodeTelemetry(decoded);
    };
    const enqueueOpenPaneHref = (href: string) => {
      const normalizedHref = normalizePaneHref(href) ?? normalizeWorkspaceHref(href);
      if (!normalizedHref) {
        return;
      }
      historyModeRef.current = "push";
      dispatch({ type: "open_group_with_tab", href: normalizedHref });
    };
    const handleOpenPaneEvent = (event: Event) => {
      const customEvent = event as CustomEvent<OpenInAppPaneDetail>;
      const href = customEvent.detail?.href;
      if (!href) {
        return;
      }
      enqueueOpenPaneHref(href);
    };
    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if (!isOpenInAppPaneMessage(event.data)) {
        return;
      }
      enqueueOpenPaneHref(event.data.href);
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
    window.addEventListener("message", handleWindowMessage);
    setPaneGraphReady(true);
    for (const queuedHref of consumePendingPaneOpenQueue()) {
      enqueueOpenPaneHref(queuedHref);
    }

    return () => {
      readyRef.current = false;
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
      window.removeEventListener("message", handleWindowMessage);
      setPaneGraphReady(false);
    };
  }, [publishDecodeTelemetry]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!readyRef.current) {
      return;
    }
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
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
      emitWorkspaceTelemetry({
        type: "encode",
        status: errorCode ? "error" : "ok",
        errorCode,
      });
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

  const activateGroup = useCallback(
    (groupId: string) => {
      dispatchAndSync({ type: "activate_group", groupId }, "replace");
    },
    [dispatchAndSync]
  );

  const activateTab = useCallback(
    (groupId: string, tabId: string) => {
      dispatchAndSync({ type: "activate_tab", groupId, tabId }, "replace");
    },
    [dispatchAndSync]
  );

  const openTab = useCallback(
    (href: string, options?: OpenTabOptions) => {
      const normalizedHref = normalizeWorkspaceHref(href);
      if (!normalizedHref) {
        return;
      }
      dispatchAndSync(
        {
          type: "open_tab",
          href: normalizedHref,
          groupId: options?.groupId,
          activate: options?.activate ?? true,
        },
        options?.historyMode ?? "push"
      );
    },
    [dispatchAndSync]
  );

  const openGroupWithTab = useCallback(
    (href: string, options?: OpenGroupWithTabOptions) => {
      const normalizedHref = normalizeWorkspaceHref(href);
      if (!normalizedHref) {
        return;
      }
      dispatchAndSync(
        {
          type: "open_group_with_tab",
          href: normalizedHref,
        },
        options?.historyMode ?? "push"
      );
    },
    [dispatchAndSync]
  );

  const navigateTab = useCallback(
    (groupId: string, tabId: string, href: string, options?: NavigateTabOptions) => {
      const normalizedHref = normalizeWorkspaceHref(href);
      if (!normalizedHref) {
        return;
      }
      dispatchAndSync(
        {
          type: "navigate_tab",
          groupId,
          tabId,
          href: normalizedHref,
        },
        options?.replace ? "replace" : "push"
      );
    },
    [dispatchAndSync]
  );

  const closeTab = useCallback(
    (groupId: string, tabId: string) => {
      dispatchAndSync({ type: "close_tab", groupId, tabId }, "replace");
    },
    [dispatchAndSync]
  );

  const closeGroup = useCallback(
    (groupId: string) => {
      dispatchAndSync({ type: "close_group", groupId }, "replace");
    },
    [dispatchAndSync]
  );

  const setGroupWidth = useCallback(
    (groupId: string, widthPx: number) => {
      dispatchAndSync({ type: "set_group_width", groupId, widthPx }, "replace");
    },
    [dispatchAndSync]
  );

  const replaceState = useCallback(
    (nextState: WorkspaceStateV2) => {
      dispatchAndSync({ type: "hydrate", state: nextState }, "replace");
    },
    [dispatchAndSync]
  );

  const value = useMemo<WorkspaceStoreValue>(
    () => ({
      state,
      meta,
      activateGroup,
      activateTab,
      openTab,
      openGroupWithTab,
      navigateTab,
      closeTab,
      closeGroup,
      setGroupWidth,
      replaceState,
    }),
    [
      activateGroup,
      activateTab,
      closeGroup,
      closeTab,
      meta,
      navigateTab,
      openGroupWithTab,
      openTab,
      replaceState,
      setGroupWidth,
      state,
    ]
  );

  if (!mounted) {
    return null;
  }

  return <WorkspaceStoreContext.Provider value={value}>{children}</WorkspaceStoreContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStoreValue {
  const value = useContext(WorkspaceStoreContext);
  if (!value) {
    throw new Error("useWorkspaceStore must be used inside WorkspaceStoreProvider");
  }
  return value;
}

export function useWorkspaceDispatchOnly(): Dispatch<WorkspaceAction> {
  const value = useWorkspaceStore();
  return ((action: WorkspaceAction) => {
    if (action.type === "hydrate") {
      value.replaceState(action.state);
      return;
    }
    if (action.type === "activate_group") {
      value.activateGroup(action.groupId);
      return;
    }
    if (action.type === "activate_tab") {
      value.activateTab(action.groupId, action.tabId);
      return;
    }
    if (action.type === "open_tab") {
      value.openTab(action.href, {
        groupId: action.groupId,
        activate: action.activate,
      });
      return;
    }
    if (action.type === "open_group_with_tab") {
      value.openGroupWithTab(action.href);
      return;
    }
    if (action.type === "navigate_tab") {
      value.navigateTab(action.groupId, action.tabId, action.href);
      return;
    }
    if (action.type === "close_tab") {
      value.closeTab(action.groupId, action.tabId);
      return;
    }
    if (action.type === "close_group") {
      value.closeGroup(action.groupId);
      return;
    }
    if (action.type === "set_group_width") {
      value.setGroupWidth(action.groupId, action.widthPx);
    }
  }) as Dispatch<WorkspaceAction>;
}

export { workspaceReducer };

