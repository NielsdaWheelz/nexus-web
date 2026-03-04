"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  consumePendingPaneOpenQueue,
  NEXUS_OPEN_PANE_EVENT,
  isOpenInAppPaneMessage,
  normalizePaneHref,
  setPaneGraphReady,
  type OpenInAppPaneDetail,
} from "@/lib/panes/openInAppPane";

export const PANE_GRAPH_STORAGE_KEY = "nexus.paneGraph.v1";
const MAX_PANES = 8;

export interface PaneGraphNode {
  id: string;
  href: string;
  title: string;
}

interface PaneGraphStorage {
  schemaVersion: "1";
  panes: PaneGraphNode[];
}

interface PaneGraphStoreValue {
  panes: PaneGraphNode[];
  openPane: (href: string) => boolean;
  closePane: (paneId: string) => void;
  navigatePane: (paneId: string, href: string) => boolean;
  replacePane: (paneId: string, href: string) => boolean;
}

const PaneGraphContext = createContext<PaneGraphStoreValue | null>(null);
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function createPaneId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `pane-${crypto.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `pane-${Date.now()}-${random}`;
}

function paneTitleFromHref(href: string): string {
  try {
    const parsed = new URL(href, "http://localhost");
    const cleanPath = parsed.pathname.replace(/^\/+/, "");
    if (!cleanPath) {
      return "home";
    }
    const [root, id] = cleanPath.split("/");
    if (root === "conversations") {
      return id ? `chat ${id.slice(0, 8)}` : "new chat";
    }
    if (root === "media") {
      return id ? `media ${id.slice(0, 8)}` : "media";
    }
    if (root === "libraries") {
      return id ? `library ${id.slice(0, 8)}` : "libraries";
    }
    return cleanPath.replaceAll("/", " / ");
  } catch {
    return "pane";
  }
}

function appendPane(prev: PaneGraphNode[], normalizedHref: string): PaneGraphNode[] {
  const next = [
    ...prev,
    {
      id: createPaneId(),
      href: normalizedHref,
      title: paneTitleFromHref(normalizedHref),
    } satisfies PaneGraphNode,
  ];
  if (next.length > MAX_PANES) {
    return next.slice(next.length - MAX_PANES);
  }
  return next;
}

function safeReadPaneGraph(): PaneGraphNode[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(PANE_GRAPH_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as PaneGraphStorage;
    if (parsed.schemaVersion !== "1" || !Array.isArray(parsed.panes)) {
      return [];
    }
    return parsed.panes
      .filter((pane) => typeof pane?.id === "string" && typeof pane?.href === "string")
      .map((pane) => {
        const normalizedHref = normalizePaneHref(pane.href);
        if (!normalizedHref) {
          return null;
        }
        return {
          id: pane.id,
          href: normalizedHref,
          title: paneTitleFromHref(normalizedHref),
        } satisfies PaneGraphNode;
      })
      .filter((pane): pane is PaneGraphNode => pane !== null)
      .slice(0, MAX_PANES);
  } catch {
    return [];
  }
}

function persistPaneGraph(panes: PaneGraphNode[]): void {
  if (typeof window === "undefined") {
    return;
  }
  const payload: PaneGraphStorage = {
    schemaVersion: "1",
    panes,
  };
  try {
    window.localStorage.setItem(PANE_GRAPH_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // best effort persistence only
  }
}

export function PaneGraphProvider({ children }: { children: React.ReactNode }) {
  const [panes, setPanes] = useState<PaneGraphNode[]>(() => safeReadPaneGraph());

  const openPane = useCallback((href: string): boolean => {
    const normalizedHref = normalizePaneHref(href);
    if (!normalizedHref) {
      return false;
    }

    setPanes((prev) => appendPane(prev, normalizedHref));
    return true;
  }, []);

  const closePane = useCallback((paneId: string) => {
    setPanes((prev) => prev.filter((pane) => pane.id !== paneId));
  }, []);

  const navigatePane = useCallback((paneId: string, href: string): boolean => {
    const normalizedHref = normalizePaneHref(href);
    if (!normalizedHref) {
      return false;
    }
    setPanes((prev) =>
      prev.map((pane) =>
        pane.id === paneId
          ? {
              ...pane,
              href: normalizedHref,
              title: paneTitleFromHref(normalizedHref),
            }
          : pane
      )
    );
    return true;
  }, []);

  const replacePane = useCallback((paneId: string, href: string): boolean => {
    return navigatePane(paneId, href);
  }, [navigatePane]);

  useEffect(() => {
    persistPaneGraph(panes);
  }, [panes]);

  useIsomorphicLayoutEffect(() => {
    const handleOpenPaneEvent = (event: Event) => {
      const customEvent = event as CustomEvent<OpenInAppPaneDetail>;
      const href = customEvent.detail?.href;
      if (!href) {
        return;
      }
      openPane(href);
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if (!isOpenInAppPaneMessage(event.data)) {
        return;
      }
      openPane(event.data.href);
    };

    window.addEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
    window.addEventListener("message", handleWindowMessage);
    setPaneGraphReady(true);
    for (const queuedHref of consumePendingPaneOpenQueue()) {
      openPane(queuedHref);
    }
    return () => {
      setPaneGraphReady(false);
      window.removeEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
      window.removeEventListener("message", handleWindowMessage);
    };
  }, [openPane]);

  const value = useMemo<PaneGraphStoreValue>(
    () => ({
      panes,
      openPane,
      closePane,
      navigatePane,
      replacePane,
    }),
    [panes, openPane, closePane, navigatePane, replacePane]
  );

  return <PaneGraphContext.Provider value={value}>{children}</PaneGraphContext.Provider>;
}

export function usePaneGraphStore(): PaneGraphStoreValue {
  const value = useContext(PaneGraphContext);
  if (!value) {
    throw new Error("usePaneGraphStore must be used inside PaneGraphProvider");
  }
  return value;
}
