"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from "react";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { TargetLinkMouseEvent } from "@/lib/panes/targetLinkActivation";
import type { SurfaceHeaderNavigation } from "@/components/ui/SurfaceHeader";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  initialMobileChromeMotionState,
  mobileChromePresentationProgress,
  reduceMobileChromeMotion,
  SCROLL_IDLE_SETTLE_DELAY_MS,
  type MobileChromeMotionPhase,
  type MobileChromeMotionState,
} from "@/lib/workspace/mobileChromeMotion";

export type MobileChromeVisibleLockReason =
  | "reader-restore"
  | "reader-positioning"
  | "pdf-selection"
  | "text-selection"
  | "highlight-navigation"
  | "pane-find"
  | "mobile-secondary"
  | "library-picker"
  | "action-menu"
  | "chrome-focus";

export interface MobileChromeVisibleLocks {
  readonly acquire: (reason: MobileChromeVisibleLockReason) => () => void;
}

export interface MobileChromeReaderScrollportInput {
  readonly sourceKey: string;
  readonly enabled: boolean;
}

export type MobileChromeSurfaceRole =
  | "AppBar"
  | "PaneToolbar"
  | "NexusControl";

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

interface ReaderScrollportRegistration {
  readonly scrollport: HTMLElement;
  readonly sourceKey: string;
  unregister: (() => void) | null;
}

interface StableController {
  readonly setPaneChrome: (chrome: MobilePaneChrome | null) => void;
  readonly registerSurface: (
    surface: HTMLElement,
    role: MobileChromeSurfaceRole,
  ) => () => void;
  readonly registerReaderScrollport: (input: {
    readonly scrollport: HTMLElement;
    readonly sourceKey: string;
  }) => () => void;
  readonly acquireLock: (
    reason: MobileChromeVisibleLockReason,
  ) => () => void;
}

interface VolatileChromeState {
  readonly motionPhase: MobileChromeMotionPhase;
  readonly paneChrome: MobilePaneChrome | null;
  readonly finishSettle: () => void;
}

interface MobileChromeSurfaceRegistration {
  readonly surface: HTMLElement;
  releaseFocusLock: (() => void) | null;
  unregister: (() => void) | null;
}

const StableControllerContext = createContext<StableController | null>(null);
const VolatileChromeContext = createContext<VolatileChromeState | null>(null);
const COLLAPSE_PROPERTY = "--mobile-chrome-collapse";
const CHROME_CONTROL_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='switch']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const BLANK_CANVAS_EXCLUDED_TARGET_SELECTOR = [
  CHROME_CONTROL_SELECTOR,
  "label",
  "audio",
  "video",
  "[data-highlight-id]",
  "[data-highlight-anchor]",
  "[data-active-highlight-ids]",
  ".annotationLayer",
].join(",");

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

function readScrollSnapshot(scrollport: HTMLElement) {
  return {
    scrollTop: scrollport.scrollTop,
    scrollHeight: scrollport.scrollHeight,
    clientHeight: scrollport.clientHeight,
  };
}

function isChromeControl(
  surface: HTMLElement,
  target: EventTarget | null,
): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    surface.contains(target) &&
    target.matches(CHROME_CONTROL_SELECTOR)
  );
}

function hasLiveSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
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
  const visibleLocksRef = useRef<
    Map<number, MobileChromeVisibleLockReason>
  >(new Map());
  const nextLockIdRef = useRef(0);
  const surfacesRef = useRef(
    new Map<MobileChromeSurfaceRole, MobileChromeSurfaceRegistration>(),
  );
  const readerScrollportRef = useRef<ReaderScrollportRegistration | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingProgressRef = useRef(0);
  const settleTimerRef = useRef<number | null>(null);
  const destroyedRef = useRef(false);

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

  const rebaseline = useCallback(
    (pinned: boolean) => {
      cancelFrame();
      cancelSettleTimer();
      let next = initialMobileChromeMotionState();
      const registration = readerScrollportRef.current;
      if (registration) {
        next = reduceMobileChromeMotion(next, {
          kind: "Start",
          snapshot: readScrollSnapshot(registration.scrollport),
        });
      }
      if (pinned) {
        next = reduceMobileChromeMotion(next, { kind: "Pin" });
      }
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

  const sampleReaderScroll = useCallback(
    (registration: ReaderScrollportRegistration) => {
      if (
        !isMobileRef.current ||
        readerScrollportRef.current !== registration
      )
        return;
      const snapshot = readScrollSnapshot(registration.scrollport);
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

  const acquireLock = useCallback(
    (reason: MobileChromeVisibleLockReason) => {
      const lockId = (nextLockIdRef.current += 1);
      const wasUnlocked = visibleLocksRef.current.size === 0;
      visibleLocksRef.current.set(lockId, reason);
      if (wasUnlocked && isMobileRef.current) {
        rebaseline(true);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        visibleLocksRef.current.delete(lockId);
        if (
          visibleLocksRef.current.size === 0 &&
          !destroyedRef.current
        ) {
          rebaseline(prefersReducedMotionRef.current);
        }
      };
    },
    [rebaseline],
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
      registration.releaseFocusLock = acquireLock("chrome-focus");
    },
    [acquireLock],
  );

  const reconcileSurfaceFocus = useCallback(
    (registration: MobileChromeSurfaceRegistration) => {
      if (
        !isMobileRef.current ||
        registration.releaseFocusLock ||
        !isChromeControl(registration.surface, document.activeElement)
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
        rebaseline(
          prefersReducedMotionRef.current ||
            visibleLocksRef.current.size > 0,
        );
      }
      setPaneChromeState(chrome);
    },
    [rebaseline],
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
      const onFocusIn = (event: FocusEvent) => {
        if (isChromeControl(surface, event.target)) {
          acquireSurfaceFocusLock(registration);
        }
      };
      const onFocusOut = (event: FocusEvent) => {
        if (isChromeControl(surface, event.relatedTarget)) return;
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

  const handoffReaderPointerFocus = useCallback((event: PointerEvent) => {
    if (
      !isMobileRef.current ||
      !event.isPrimary ||
      event.button !== 0
    )
      return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    for (const { surface } of surfacesRef.current.values()) {
      if (!surface.contains(activeElement)) continue;
      activeElement.blur();
      return;
    }
  }, []);

  const revealFromBlankCanvasClick = useCallback(
    (
      registration: ReaderScrollportRegistration,
      event: MouseEvent,
    ) => {
      if (
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      queueMicrotask(() => {
        if (
          event.defaultPrevented ||
          !isMobileRef.current ||
          readerScrollportRef.current !== registration ||
          !(target instanceof Element) ||
          !registration.scrollport.contains(target) ||
          target.closest(BLANK_CANVAS_EXCLUDED_TARGET_SELECTOR) ||
          hasLiveSelection() ||
          mobileChromePresentationProgress(motionRef.current) === 0
        )
          return;
        rebaseline(
          prefersReducedMotionRef.current ||
            visibleLocksRef.current.size > 0,
        );
      });
    },
    [rebaseline],
  );

  const registerReaderScrollport = useCallback(
    ({
      scrollport,
      sourceKey,
    }: {
      readonly scrollport: HTMLElement;
      readonly sourceKey: string;
    }) => {
      if (readerScrollportRef.current) {
        throw new Error(
          "Mobile chrome already has an enabled reader scrollport",
        );
      }
      const registration: ReaderScrollportRegistration = {
        scrollport,
        sourceKey,
        unregister: null,
      };
      const onScroll = () => sampleReaderScroll(registration);
      const onPointerDown = (event: PointerEvent) =>
        handoffReaderPointerFocus(event);
      const onClick = (event: MouseEvent) =>
        revealFromBlankCanvasClick(registration, event);
      scrollport.addEventListener("scroll", onScroll, { passive: true });
      scrollport.addEventListener("pointerdown", onPointerDown, {
        passive: true,
      });
      scrollport.addEventListener("click", onClick);
      readerScrollportRef.current = registration;
      rebaseline(
        prefersReducedMotionRef.current ||
          visibleLocksRef.current.size > 0,
      );
      let unregistered = false;
      const unregister = () => {
        if (unregistered) return;
        unregistered = true;
        scrollport.removeEventListener("scroll", onScroll);
        scrollport.removeEventListener("pointerdown", onPointerDown);
        scrollport.removeEventListener("click", onClick);
        if (readerScrollportRef.current === registration) {
          readerScrollportRef.current = null;
          if (!destroyedRef.current) {
            rebaseline(
              prefersReducedMotionRef.current ||
                visibleLocksRef.current.size > 0,
            );
          }
        }
      };
      registration.unregister = unregister;
      return unregister;
    },
    [
      handoffReaderPointerFocus,
      rebaseline,
      revealFromBlankCanvasClick,
      sampleReaderScroll,
    ],
  );

  useEffect(() => {
    if (previousIsMobileRef.current === isMobile) return;
    previousIsMobileRef.current = isMobile;
    if (!isMobile) {
      releaseSurfaceFocusLocks();
    } else {
      for (const registration of surfacesRef.current.values()) {
        reconcileSurfaceFocus(registration);
      }
    }
    rebaseline(
      prefersReducedMotionRef.current || visibleLocksRef.current.size > 0,
    );
  }, [
    isMobile,
    reconcileSurfaceFocus,
    rebaseline,
    releaseSurfaceFocusLocks,
  ]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      prefersReducedMotionRef.current = query.matches;
      rebaseline(query.matches || visibleLocksRef.current.size > 0);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [rebaseline]);

  useEffect(() => {
    destroyedRef.current = false;
    const surfaces = surfacesRef.current;
    const visibleLocks = visibleLocksRef.current;
    return () => {
      destroyedRef.current = true;
      readerScrollportRef.current?.unregister?.();
      for (const registration of [...surfaces.values()]) {
        registration.unregister?.();
      }
      visibleLocks.clear();
      cancelFrame();
      cancelSettleTimer();
    };
  }, [cancelFrame, cancelSettleTimer]);

  const stable = useMemo<StableController>(
    () => ({
      setPaneChrome,
      registerSurface,
      registerReaderScrollport,
      acquireLock,
    }),
    [
      acquireLock,
      registerReaderScrollport,
      registerSurface,
      setPaneChrome,
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

function useStableController(hookName: string): StableController {
  const stable = useContext(StableControllerContext);
  if (!stable) {
    throw new Error(`${hookName} must be used within MobileChromeProvider`);
  }
  return stable;
}

export function useMobileChrome(): Pick<StableController, "setPaneChrome"> &
  VolatileChromeState {
  const stable = useStableController("useMobileChrome");
  const volatile = useContext(VolatileChromeContext);
  if (!volatile) {
    throw new Error("useMobileChrome must be used within MobileChromeProvider");
  }
  return { setPaneChrome: stable.setPaneChrome, ...volatile };
}

export function useMobileChromeReaderScrollport<T extends HTMLElement>(
  input: MobileChromeReaderScrollportInput,
): RefCallback<T> {
  const stable = useStableController("useMobileChromeReaderScrollport");
  return useMemo(() => {
    let unregister: (() => void) | null = null;
    const register: RefCallback<T> = (node) => {
      unregister?.();
      unregister = null;
      if (!node || !input.enabled) return;
      unregister = stable.registerReaderScrollport({
        scrollport: node,
        sourceKey: input.sourceKey,
      });
    };
    return register;
  }, [input.enabled, input.sourceKey, stable]);
}

export function useMobileChromeVisibleLocks(): MobileChromeVisibleLocks {
  const stable = useStableController("useMobileChromeVisibleLocks");
  const releasesRef = useRef(new Set<() => void>());
  const acquire = useCallback(
    (reason: MobileChromeVisibleLockReason) => {
      const releaseLock = stable.acquireLock(reason);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releasesRef.current.delete(release);
        releaseLock();
      };
      releasesRef.current.add(release);
      return release;
    },
    [stable],
  );
  useLayoutEffect(
    () => () => {
      for (const release of [...releasesRef.current]) release();
    },
    [stable],
  );
  return useMemo(() => ({ acquire }), [acquire]);
}

export function useMobileChromeSurface(
  ref: RefObject<HTMLElement | null>,
  role: MobileChromeSurfaceRole,
  enabled: boolean,
): void {
  const stable = useStableController("useMobileChromeSurface");
  useEffect(() => {
    if (!enabled) return;
    const surface = ref.current;
    if (!surface) return;
    return stable.registerSurface(surface, role);
  }, [enabled, ref, role, stable]);
}
