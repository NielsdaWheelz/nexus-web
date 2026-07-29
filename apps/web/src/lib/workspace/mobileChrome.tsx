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
  type RefObject,
} from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { TargetLinkMouseEvent } from "@/lib/panes/targetLinkActivation";
import type { SurfaceHeaderNavigation } from "@/components/ui/SurfaceHeader";
import {
  initialMobileChromeMotionState,
  mobileChromePresentationProgress,
  reduceMobileChromeMotion,
  SCROLL_IDLE_SETTLE_DELAY_MS,
  type MobileChromeMotionPhase,
  type MobileChromeMotionState,
  type MobileChromeScrollSnapshot,
} from "@/lib/workspace/mobileChromeMotion";

export type { MobileChromeScrollSnapshot } from "@/lib/workspace/mobileChromeMotion";

export type PaneMobileChromeLockReason =
  | "reader-restore"
  | "pdf-selection"
  | "text-selection"
  | "highlight-navigation"
  | "mobile-secondary"
  | "library-picker"
  | "action-menu"
  | "chrome-focus";

export type MobileChromeSurfaceRole =
  | "AppBar"
  | "PaneToolbar"
  | "NexusControl";

export interface PaneMobileChromeController {
  startReaderScroll: (snapshot: MobileChromeScrollSnapshot) => void;
  updateReaderScroll: (snapshot: MobileChromeScrollSnapshot) => void;
  beginReaderPointerInteraction: () => void;
  acquireVisibleLock: (reason: PaneMobileChromeLockReason) => () => void;
}

/** The active pane's chrome, published by the mounted PaneShell for the mobile top bar. */
export interface MobilePaneChrome {
  paneId: string;
  routeKey: string;
  identityId: string;
  header: PaneHeaderModel;
  activateIdentityAnchor: (
    event: TargetLinkMouseEvent,
    anchor: HTMLAnchorElement,
  ) => void;
  navigation: SurfaceHeaderNavigation;
  actions: readonly PaneHeaderAction[];
  options: readonly ActionDescriptor[];
}

interface StableController extends PaneMobileChromeController {
  setPaneChrome: (chrome: MobilePaneChrome | null) => void;
  registerSurface: (
    surface: HTMLElement,
    role: MobileChromeSurfaceRole,
  ) => () => void;
}

interface VolatileChromeState {
  motionPhase: MobileChromeMotionPhase;
  paneChrome: MobilePaneChrome | null;
  finishSettle: () => void;
}

interface MobileChromeSurfaceRegistration {
  surface: HTMLElement;
  releaseFocusLock: (() => void) | null;
  unregister: (() => void) | null;
}

const StableControllerContext = createContext<StableController | null>(null);
const VolatileChromeContext = createContext<VolatileChromeState | null>(null);
const COLLAPSE_PROPERTY = "--mobile-chrome-collapse";

function initialPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function samePhase(
  left: MobileChromeMotionPhase,
  right: MobileChromeMotionPhase,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "Tracking" && right.kind === "Tracking") {
    return left.direction === right.direction;
  }
  if (left.kind === "Settling" && right.kind === "Settling") {
    return left.target === right.target;
  }
  return true;
}

function phaseAtProgress(
  state: MobileChromeMotionState,
  progress: number,
): MobileChromeMotionPhase {
  if (state.direction != null)
    return { kind: "Tracking", direction: state.direction };
  return progress === 0 ? { kind: "Visible" } : { kind: "Hidden" };
}

export function MobileChromeProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobileViewport();
  const [paneChrome, setPaneChromeState] = useState<MobilePaneChrome | null>(
    null,
  );
  const [motionPhase, setMotionPhase] = useState<MobileChromeMotionPhase>({
    kind: "Visible",
  });
  const motionRef = useRef(initialMobileChromeMotionState());
  const publishedPhaseRef = useRef<MobileChromeMotionPhase>({
    kind: "Visible",
  });
  const activePaneRouteRef = useRef<{
    paneId: string;
    routeKey: string;
  } | null>(null);
  const isMobileRef = useRef(isMobile);
  const previousIsMobileRef = useRef(isMobile);
  const prefersReducedMotionRef = useRef(initialPrefersReducedMotion());
  const visibleLocksRef = useRef<Map<number, PaneMobileChromeLockReason>>(
    new Map(),
  );
  const nextLockIdRef = useRef(0);
  const surfacesRef = useRef(
    new Map<MobileChromeSurfaceRole, MobileChromeSurfaceRegistration>(),
  );
  const frameRef = useRef<number | null>(null);
  const pendingProgressRef = useRef(0);
  const settleTimerRef = useRef<number | null>(null);

  isMobileRef.current = isMobile;

  const publishPhase = useCallback((phase: MobileChromeMotionPhase) => {
    if (samePhase(publishedPhaseRef.current, phase)) return;
    publishedPhaseRef.current = phase;
    setMotionPhase(phase);
  }, []);

  const writeProgress = useCallback((progress: number) => {
    for (const { surface } of surfacesRef.current.values()) {
      surface.style.setProperty(COLLAPSE_PROPERTY, String(progress));
    }
  }, []);

  const cancelFrame = useCallback(() => {
    if (frameRef.current == null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const scheduleProgressWrite = useCallback(
    (progress: number) => {
      pendingProgressRef.current = progress;
      if (frameRef.current != null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        writeProgress(pendingProgressRef.current);
      });
    },
    [writeProgress],
  );

  const cancelSettleTimer = useCallback(() => {
    if (settleTimerRef.current == null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }, []);

  const commit = useCallback(
    (next: MobileChromeMotionState) => {
      motionRef.current = next;
      publishPhase(next.phase);
      scheduleProgressWrite(mobileChromePresentationProgress(next));
    },
    [publishPhase, scheduleProgressWrite],
  );

  const reset = useCallback(
    (pinned: boolean) => {
      cancelFrame();
      cancelSettleTimer();
      const next = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
        kind: pinned ? "Pin" : "Unpin",
      });
      commit(next);
    },
    [cancelFrame, cancelSettleTimer, commit],
  );

  const interruptSettle = useCallback(() => {
    const state = motionRef.current;
    if (state.phase.kind !== "Settling") return state;
    cancelFrame();
    const registration = surfacesRef.current.get("AppBar");
    if (!registration)
      throw new Error("Mobile chrome settling requires an AppBar surface");
    const progress = Number.parseFloat(
      window
        .getComputedStyle(registration.surface)
        .getPropertyValue(COLLAPSE_PROPERTY),
    );
    if (!Number.isFinite(progress)) {
      throw new Error(
        "Mobile chrome surfaces must expose a numeric collapse progress",
      );
    }
    const next = {
      ...state,
      phase: phaseAtProgress(state, progress),
      progress: Math.min(1, Math.max(0, progress)),
    };
    writeProgress(next.progress);
    motionRef.current = next;
    publishPhase(next.phase);
    return next;
  }, [cancelFrame, publishPhase, writeProgress]);

  const finishSettle = useCallback(() => {
    if (motionRef.current.phase.kind !== "Settling") return;
    const next = reduceMobileChromeMotion(motionRef.current, {
      kind: "FinishSettle",
    });
    motionRef.current = next;
    publishPhase(next.phase);
  }, [publishPhase]);

  const startReaderScroll = useCallback(
    (snapshot: MobileChromeScrollSnapshot) => {
      if (!isMobileRef.current) return;
      cancelFrame();
      cancelSettleTimer();
      let next = reduceMobileChromeMotion(initialMobileChromeMotionState(), {
        kind: "Start",
        snapshot,
      });
      if (prefersReducedMotionRef.current || visibleLocksRef.current.size > 0) {
        next = reduceMobileChromeMotion(next, { kind: "Pin" });
      }
      commit(next);
    },
    [cancelFrame, cancelSettleTimer, commit],
  );

  const updateReaderScroll = useCallback(
    (snapshot: MobileChromeScrollSnapshot) => {
      if (!isMobileRef.current) return;
      const prior = motionRef.current;
      const candidate = reduceMobileChromeMotion(prior, {
        kind: "Scroll",
        snapshot,
      });
      if (candidate === prior) return;
      const interrupted = interruptSettle();
      let next =
        interrupted === prior
          ? candidate
          : reduceMobileChromeMotion(interrupted, { kind: "Scroll", snapshot });
      const pinned =
        prefersReducedMotionRef.current || visibleLocksRef.current.size > 0;

      if (pinned) {
        cancelFrame();
        cancelSettleTimer();
        next = reduceMobileChromeMotion(next, { kind: "Pin" });
        commit(next);
        return;
      }

      cancelSettleTimer();
      commit(next);
      if (
        next.phase.kind === "Pinned" ||
        next.progress === 0 ||
        next.progress === 1
      )
        return;
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        commit(reduceMobileChromeMotion(motionRef.current, { kind: "Settle" }));
      }, SCROLL_IDLE_SETTLE_DELAY_MS);
    },
    [cancelFrame, cancelSettleTimer, commit, interruptSettle],
  );

  const acquireVisibleLock = useCallback(
    (reason: PaneMobileChromeLockReason) => {
      if (!isMobileRef.current) return () => {};
      const lockId = (nextLockIdRef.current += 1);
      const wasUnlocked = visibleLocksRef.current.size === 0;
      visibleLocksRef.current.set(lockId, reason);
      if (wasUnlocked) {
        cancelFrame();
        cancelSettleTimer();
        commit(reduceMobileChromeMotion(motionRef.current, { kind: "Pin" }));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        visibleLocksRef.current.delete(lockId);
        if (visibleLocksRef.current.size === 0) {
          const next = reduceMobileChromeMotion(motionRef.current, {
            kind: "Unpin",
          });
          cancelFrame();
          cancelSettleTimer();
          commit(next);
        }
      };
    },
    [cancelFrame, cancelSettleTimer, commit],
  );

  const releaseSurfaceFocusLock = useCallback(
    (registration: MobileChromeSurfaceRegistration) => {
      const release = registration.releaseFocusLock;
      if (!release) return;
      registration.releaseFocusLock = null;
      release();
    },
    [],
  );

  const acquireSurfaceFocusLock = useCallback(
    (registration: MobileChromeSurfaceRegistration) => {
      if (!isMobileRef.current || registration.releaseFocusLock) return;
      registration.releaseFocusLock = acquireVisibleLock("chrome-focus");
    },
    [acquireVisibleLock],
  );

  const reconcileSurfaceFocus = useCallback(
    (registration: MobileChromeSurfaceRegistration) => {
      if (
        !isMobileRef.current ||
        registration.releaseFocusLock ||
        !(document.activeElement instanceof HTMLElement) ||
        !registration.surface.contains(document.activeElement)
      )
        return;
      acquireSurfaceFocusLock(registration);
    },
    [acquireSurfaceFocusLock],
  );

  const releaseSurfaceFocusLocks = useCallback(() => {
    for (const registration of surfacesRef.current.values()) {
      releaseSurfaceFocusLock(registration);
    }
  }, [releaseSurfaceFocusLock]);

  const setPaneChrome = useCallback(
    (chrome: MobilePaneChrome | null) => {
      const active = activePaneRouteRef.current;
      if (
        chrome != null &&
        (chrome.paneId !== active?.paneId ||
          chrome.routeKey !== active.routeKey)
      ) {
        activePaneRouteRef.current = {
          paneId: chrome.paneId,
          routeKey: chrome.routeKey,
        };
        reset(
          !isMobileRef.current ||
            prefersReducedMotionRef.current ||
            visibleLocksRef.current.size > 0,
        );
      }
      setPaneChromeState(chrome);
    },
    [reset],
  );

  const registerSurface = useCallback(
    (surface: HTMLElement, role: MobileChromeSurfaceRole) => {
      if (surfacesRef.current.has(role)) {
        throw new Error(`Mobile chrome already has an enabled ${role} surface`);
      }
      const registration: MobileChromeSurfaceRegistration = {
        surface,
        releaseFocusLock: null,
        unregister: null,
      };
      const onFocusIn = () => acquireSurfaceFocusLock(registration);
      const onFocusOut = (event: FocusEvent) => {
        if (
          event.relatedTarget instanceof Node &&
          registration.surface.contains(event.relatedTarget)
        )
          return;
        releaseSurfaceFocusLock(registration);
      };
      surface.addEventListener("focusin", onFocusIn);
      surface.addEventListener("focusout", onFocusOut);
      surfacesRef.current.set(role, registration);
      reconcileSurfaceFocus(registration);
      scheduleProgressWrite(
        mobileChromePresentationProgress(motionRef.current),
      );
      let unregistered = false;
      const unregister = () => {
        if (unregistered) return;
        unregistered = true;
        surface.removeEventListener("focusin", onFocusIn);
        surface.removeEventListener("focusout", onFocusOut);
        releaseSurfaceFocusLock(registration);
        if (surfacesRef.current.get(role) === registration)
          surfacesRef.current.delete(role);
      };
      registration.unregister = unregister;
      return unregister;
    },
    [
      acquireSurfaceFocusLock,
      reconcileSurfaceFocus,
      releaseSurfaceFocusLock,
      scheduleProgressWrite,
    ],
  );

  const beginReaderPointerInteraction = useCallback(() => {
    if (!isMobileRef.current) return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    for (const { surface } of surfacesRef.current.values()) {
      if (!surface.contains(activeElement)) continue;
      activeElement.blur();
      return;
    }
  }, []);

  useEffect(() => {
    if (previousIsMobileRef.current === isMobile) return;
    previousIsMobileRef.current = isMobile;
    if (!isMobile) releaseSurfaceFocusLocks();
    reset(
      !isMobile ||
        prefersReducedMotionRef.current ||
        visibleLocksRef.current.size > 0,
    );
    if (isMobile) {
      for (const registration of surfacesRef.current.values()) {
        reconcileSurfaceFocus(registration);
      }
    }
  }, [isMobile, reconcileSurfaceFocus, releaseSurfaceFocusLocks, reset]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      if (query.matches === prefersReducedMotionRef.current) return;
      prefersReducedMotionRef.current = query.matches;
      reset(
        query.matches ||
          !isMobileRef.current ||
          visibleLocksRef.current.size > 0,
      );
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [reset]);

  useEffect(
    () => () => {
      for (const registration of [...surfacesRef.current.values()]) {
        registration.unregister?.();
      }
      cancelFrame();
      cancelSettleTimer();
    },
    [cancelFrame, cancelSettleTimer],
  );

  const stable = useMemo<StableController>(
    () => ({
      startReaderScroll,
      updateReaderScroll,
      beginReaderPointerInteraction,
      acquireVisibleLock,
      setPaneChrome,
      registerSurface,
    }),
    [
      acquireVisibleLock,
      beginReaderPointerInteraction,
      registerSurface,
      setPaneChrome,
      startReaderScroll,
      updateReaderScroll,
    ],
  );

  const volatile = useMemo<VolatileChromeState>(
    () => ({ motionPhase, paneChrome, finishSettle }),
    [finishSettle, motionPhase, paneChrome],
  );

  return (
    <StableControllerContext.Provider value={stable}>
      <VolatileChromeContext.Provider value={volatile}>
        {children}
      </VolatileChromeContext.Provider>
    </StableControllerContext.Provider>
  );
}

export function useMobileChrome(): StableController & VolatileChromeState {
  const stable = useContext(StableControllerContext);
  const volatile = useContext(VolatileChromeContext);
  if (!stable || !volatile)
    throw new Error("useMobileChrome must be used within MobileChromeProvider");
  return { ...stable, ...volatile };
}

export function usePaneMobileChromeController(): PaneMobileChromeController {
  const stable = useContext(StableControllerContext);
  if (!stable)
    throw new Error(
      "usePaneMobileChromeController must be used within MobileChromeProvider",
    );
  return stable;
}

export function useMobileChromeSurface(
  ref: RefObject<HTMLElement | null>,
  role: MobileChromeSurfaceRole,
  enabled: boolean,
) {
  const stable = useContext(StableControllerContext);
  if (!stable)
    throw new Error(
      "useMobileChromeSurface must be used within MobileChromeProvider",
    );
  useEffect(() => {
    if (!enabled) return;
    const surface = ref.current;
    if (!surface) return;
    return stable.registerSurface(surface, role);
  }, [enabled, ref, role, stable]);
}
