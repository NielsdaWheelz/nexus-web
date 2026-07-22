"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { SurfaceHeaderNavigation } from "@/components/ui/SurfaceHeader";

export type PaneMobileChromeLockReason =
  | "reader-restore"
  | "pdf-selection"
  | "text-selection"
  | "highlight-navigation"
  | "mobile-secondary"
  | "library-picker"
  | "action-menu";

export interface PaneMobileChromeController {
  onDocumentScroll: (snapshot: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }) => void;
  acquireVisibleLock: (reason: PaneMobileChromeLockReason) => () => void;
}

/** The active pane's chrome, published by the mounted PaneShell for the mobile top bar. */
export interface MobilePaneChrome {
  paneId: string;
  identityId: string;
  header: PaneHeaderModel;
  navigation: SurfaceHeaderNavigation;
  options: readonly ActionDescriptor[];
}

/**
 * The hide-on-scroll controller is split into two contexts so the volatile
 * `hidden`/`paneChrome` state — which flips on every scroll and chrome publish —
 * does not re-render the heavy reader bodies that only need the stable controller
 * methods. Readers consume {@link usePaneMobileChromeController} (stable only);
 * the mobile top bar consumes {@link useMobileChrome} (stable + volatile).
 */
interface StableController extends PaneMobileChromeController {
  setPaneChrome: (chrome: MobilePaneChrome | null) => void;
}

interface VolatileChromeState {
  hidden: boolean;
  paneChrome: MobilePaneChrome | null;
}

const StableControllerContext = createContext<StableController | null>(null);
const VolatileChromeContext = createContext<VolatileChromeState | null>(null);

// Hide after a deliberate downward scroll; reveal on upward scroll or near the top.
const SCROLL_DELTA_EPSILON_PX = 1;
const HIDE_TOLERANCE_PX = 24;
const REVEAL_TOLERANCE_PX = 16;
// Scroll policy, deliberately independent from the CSS top-bar height.
const TOP_ALWAYS_VISIBLE_SCROLL_PX = 60;

export function MobileChromeProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobileViewport();
  const [hidden, setHidden] = useState(false);
  const [visibleLockCount, setVisibleLockCount] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [paneChrome, setPaneChrome] = useState<MobilePaneChrome | null>(null);

  const lastScrollTopRef = useRef(0);
  const scrollDirectionRef = useRef<"down" | "up" | null>(null);
  const directionStartRef = useRef(0);
  const visibleLocksRef = useRef<Map<number, PaneMobileChromeLockReason>>(new Map());
  const nextLockIdRef = useRef(0);

  const showNow = useCallback(() => {
    setHidden(false);
    scrollDirectionRef.current = null;
    directionStartRef.current = lastScrollTopRef.current;
  }, []);

  // Reveal the bar when switching panes or leaving mobile.
  const activePaneId = paneChrome?.paneId ?? null;
  useEffect(() => {
    setHidden(false);
    scrollDirectionRef.current = null;
    directionStartRef.current = 0;
    lastScrollTopRef.current = 0;
  }, [isMobile, activePaneId]);

  // Pin reduced-motion users' bar permanently visible.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
      if (query.matches) setHidden(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const onDocumentScroll = useCallback(
    (snapshot: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
      if (!isMobile || prefersReducedMotion) return;
      const maxScrollTop = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
      const scrollTop = Math.min(Math.max(0, snapshot.scrollTop), maxScrollTop);
      const delta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      if (scrollTop <= TOP_ALWAYS_VISIBLE_SCROLL_PX) {
        setHidden(false);
        scrollDirectionRef.current = null;
        directionStartRef.current = scrollTop;
        return;
      }
      if (Math.abs(delta) < SCROLL_DELTA_EPSILON_PX) return;

      const direction = delta > 0 ? "down" : "up";
      if (scrollDirectionRef.current !== direction) {
        scrollDirectionRef.current = direction;
        directionStartRef.current = scrollTop;
        return;
      }
      const distance = Math.abs(scrollTop - directionStartRef.current);
      if (direction === "down" && distance >= HIDE_TOLERANCE_PX) setHidden(true);
      else if (direction === "up" && distance >= REVEAL_TOLERANCE_PX) setHidden(false);
    },
    [isMobile, prefersReducedMotion],
  );

  const acquireVisibleLock = useCallback(
    (reason: PaneMobileChromeLockReason) => {
      if (!isMobile) return () => {};
      const lockId = (nextLockIdRef.current += 1);
      visibleLocksRef.current.set(lockId, reason);
      setVisibleLockCount(visibleLocksRef.current.size);
      showNow();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        visibleLocksRef.current.delete(lockId);
        setVisibleLockCount(visibleLocksRef.current.size);
        if (visibleLocksRef.current.size === 0) showNow();
      };
    },
    [isMobile, showNow],
  );

  const stable = useMemo<StableController>(
    () => ({ onDocumentScroll, acquireVisibleLock, setPaneChrome }),
    [onDocumentScroll, acquireVisibleLock],
  );

  const volatile = useMemo<VolatileChromeState>(
    () => ({
      hidden: hidden && visibleLockCount === 0 && !prefersReducedMotion,
      paneChrome,
    }),
    [hidden, visibleLockCount, prefersReducedMotion, paneChrome],
  );

  return (
    <StableControllerContext.Provider value={stable}>
      <VolatileChromeContext.Provider value={volatile}>{children}</VolatileChromeContext.Provider>
    </StableControllerContext.Provider>
  );
}

/** Full chrome state (stable controller + volatile hidden/paneChrome) for the mobile top bar. */
export function useMobileChrome(): StableController & VolatileChromeState {
  const stable = useContext(StableControllerContext);
  const volatile = useContext(VolatileChromeContext);
  if (!stable || !volatile) throw new Error("useMobileChrome must be used within MobileChromeProvider");
  return { ...stable, ...volatile };
}

/**
 * Stable controller for pane bodies (scroll publication + visible locks). Excludes
 * the volatile state so heavy readers do not re-render on hide/reveal or chrome publish.
 */
export function usePaneMobileChromeController(): PaneMobileChromeController {
  const stable = useContext(StableControllerContext);
  if (!stable) throw new Error("usePaneMobileChromeController must be used within MobileChromeProvider");
  return stable;
}
