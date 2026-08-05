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
import { flushSync } from "react-dom";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { PaneViewMenuPublication } from "@/lib/panes/panePublications";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { TargetLinkMouseEvent } from "@/lib/panes/targetLinkActivation";
import type { SurfaceHeaderNavigation } from "@/components/ui/SurfaceHeader";
import { isInteractiveTarget } from "@/lib/ui/interactiveTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
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
  | "action-menu";

export interface MobileChromeVisibleLocks {
  acquire(reason: MobileChromeVisibleLockReason): () => void;
}

export interface MobileChromeReaderScrollportInput {
  readonly sourceKey: string;
  readonly enabled: boolean;
}

export interface PaneChromeFocusReturn {
  focus(paneId: string): Promise<void>;
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
  activateChromeAnchor: (
    event: TargetLinkMouseEvent,
    anchor: HTMLAnchorElement,
  ) => void;
  navigation: SurfaceHeaderNavigation;
  /** Promoted, non-resource pane actions (Companion, Search). */
  actions: readonly PaneHeaderAction[];
  /** Dedicated non-resource pane controls (refresh, route share) as buttons. */
  controls?: ReactNode;
  /** The pane's own non-resource view menu (reader settings, date navigation). */
  viewMenu?: PaneViewMenuPublication;
  /** The pane's resource identity → the canonical resource dropdown. */
  resourceTarget?: ResourceActionSubject;
}

interface StableController {
  setPaneChrome(chrome: MobilePaneChrome | null): void;
  registerSurface(
    surface: HTMLElement,
    role: MobileChromeSurfaceRole,
  ): () => void;
  registerReaderScrollport(
    scrollport: HTMLElement,
    sourceKey: string,
  ): () => void;
  acquire(reason: MobileChromeVisibleLockReason): () => void;
  focusPaneChrome(paneId: string): Promise<void>;
}

interface VolatileChromeState {
  motionPhase: MobileChromeMotionPhase;
  paneChrome: MobilePaneChrome | null;
}

interface MobileChromeSurfaceRegistration {
  readonly role: MobileChromeSurfaceRole;
  readonly surface: HTMLElement;
  readonly observer: MutationObserver;
  settleGeneration: number | null;
  unregister(): void;
}

interface ReaderScrollportRegistration {
  readonly scrollport: HTMLElement;
  readonly sourceKey: string;
  readonly pendingWindowClickCleanups: Set<() => void>;
  unregister(): void;
}

type PrivateVisibleLockReason = "focus-return";
type VisibleLockReason =
  | MobileChromeVisibleLockReason
  | PrivateVisibleLockReason;

const StableControllerContext = createContext<StableController | null>(null);
const VolatileChromeContext = createContext<VolatileChromeState | null>(null);
const COLLAPSE_PROPERTY = "--mobile-chrome-collapse";
const READER_INTERACTION_ROOT = "[data-mobile-reader-interaction-root]";
const READER_TAP_HANDLED = "[data-reader-tap-handled='true']";
const READER_TAP_REVEAL_SURFACE =
  "[data-reader-tap-reveal-surface='true']";

function isInteractiveReaderTap(
  target: EventTarget | null,
  scrollport: HTMLElement,
): boolean {
  const revealSurface = closestElement(target, READER_TAP_REVEAL_SURFACE);
  return isInteractiveTarget(target, revealSurface ?? scrollport);
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
  if (progress === 0) return { kind: "Visible" };
  if (progress === 1) return { kind: "Hidden" };
  const direction =
    state.direction ??
    (state.phase.kind === "Settling" && state.phase.target === "Hidden"
      ? "Down"
      : "Up");
  return { kind: "Tracking", direction };
}

function scrollSnapshot(scrollport: HTMLElement) {
  return {
    scrollTop: scrollport.scrollTop,
    scrollHeight: scrollport.scrollHeight,
    clientHeight: scrollport.clientHeight,
  };
}

function parseCssTimeMs(value: string): number {
  const time = value.trim();
  if (time.endsWith("ms")) return Number.parseFloat(time);
  if (time.endsWith("s")) return Number.parseFloat(time) * 1_000;
  return 0;
}

function transitionDeadlineMs(surface: HTMLElement): number {
  const computed = window.getComputedStyle(surface);
  const properties = computed.transitionProperty.split(",");
  const durations = computed.transitionDuration.split(",").map(parseCssTimeMs);
  const delays = computed.transitionDelay.split(",").map(parseCssTimeMs);
  const count = Math.max(properties.length, durations.length, delays.length);
  let deadlineMs = 0;
  for (let index = 0; index < count; index += 1) {
    const property = properties[index % properties.length]?.trim();
    if (property !== "all" && property !== COLLAPSE_PROPERTY) continue;
    const duration = durations[index % durations.length] ?? 0;
    const delay = delays[index % delays.length] ?? 0;
    deadlineMs = Math.max(deadlineMs, duration + delay);
  }
  return Math.max(0, deadlineMs);
}

function cancelCollapseTransitions(surfaces: readonly HTMLElement[]): void {
  for (const surface of surfaces) {
    for (const animation of surface.getAnimations()) {
      if (
        (animation as Partial<CSSTransition>).transitionProperty ===
        COLLAPSE_PROPERTY
      ) {
        animation.cancel();
      }
    }
  }
}

function primaryUnmodifiedClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function hasLiveSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

function closestElement(
  target: EventTarget | null,
  selector: string,
): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

function readerInteractionRoots(paneId: string): readonly HTMLElement[] {
  const pane = [...document.querySelectorAll<HTMLElement>("[data-pane-id]")].find(
    (candidate) => candidate.dataset.paneId === paneId,
  );
  if (!pane) return [];
  return [
    ...(pane.matches(READER_INTERACTION_ROOT) ? [pane] : []),
    ...pane.querySelectorAll<HTMLElement>(READER_INTERACTION_ROOT),
  ];
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
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
  const visibleLocksRef = useRef<Map<number, VisibleLockReason>>(new Map());
  const chromeFocusLockRef = useRef(false);
  const nextLockIdRef = useRef(0);
  const surfacesRef = useRef(
    new Map<MobileChromeSurfaceRole, MobileChromeSurfaceRegistration>(),
  );
  const readerScrollportRef = useRef<ReaderScrollportRegistration | null>(null);
  const frameRef = useRef<number | null>(null);
  const geometryFrameRef = useRef<number | null>(null);
  const pendingProgressRef = useRef(0);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const settleArmFrameRef = useRef<number | null>(null);
  const settleDeadlineRef = useRef<number | null>(null);
  const settleGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  isMobileRef.current = isMobile;

  const publishPhase = useCallback((phase: MobileChromeMotionPhase) => {
    if (samePhase(publishedPhaseRef.current, phase)) return;
    publishedPhaseRef.current = phase;
    if (!mountedRef.current) return;
    const publish = () => setMotionPhase(phase);
    if (phase.kind === "Tracking" || phase.kind === "Settling") {
      // Collapse progress is written imperatively on the next animation frame.
      // Commit the React-owned phase, inertness, and aria-hidden projection
      // first so moving chrome can never paint as interactive under load.
      flushSync(publish);
      return;
    }
    publish();
  }, []);

  const writeProgress = useCallback((progress: number) => {
    for (const { surface } of surfacesRef.current.values()) {
      surface.style.setProperty(COLLAPSE_PROPERTY, String(progress));
    }
  }, []);

  const cancelFrame = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const cancelGeometryFrame = useCallback(() => {
    if (geometryFrameRef.current === null) return;
    window.cancelAnimationFrame(geometryFrameRef.current);
    geometryFrameRef.current = null;
  }, []);

  const scheduleProgressWrite = useCallback(
    (progress: number) => {
      pendingProgressRef.current = progress;
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        writeProgress(pendingProgressRef.current);
      });
    },
    [writeProgress],
  );

  const cancelScrollIdleTimer = useCallback(() => {
    if (scrollIdleTimerRef.current === null) return;
    window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = null;
  }, []);

  const invalidateSettle = useCallback(() => {
    settleGenerationRef.current += 1;
    for (const registration of surfacesRef.current.values()) {
      registration.settleGeneration = null;
    }
    if (settleArmFrameRef.current !== null) {
      window.cancelAnimationFrame(settleArmFrameRef.current);
      settleArmFrameRef.current = null;
    }
    if (settleDeadlineRef.current !== null) {
      window.clearTimeout(settleDeadlineRef.current);
      settleDeadlineRef.current = null;
    }
  }, []);

  const commit = useCallback(
    (next: MobileChromeMotionState) => {
      motionRef.current = next;
      publishPhase(next.phase);
      scheduleProgressWrite(mobileChromePresentationProgress(next));
    },
    [publishPhase, scheduleProgressWrite],
  );

  const hasPin = useCallback(
    () =>
      isMobileRef.current &&
      (chromeFocusLockRef.current || visibleLocksRef.current.size > 0),
    [],
  );

  const finishSettle = useCallback(
    (generation: number) => {
      if (
        generation !== settleGenerationRef.current ||
        motionRef.current.phase.kind !== "Settling"
      ) {
        return;
      }
      invalidateSettle();
      commit(
        reduceMobileChromeMotion(motionRef.current, {
          kind: "FinishSettle",
        }),
      );
    },
    [commit, invalidateSettle],
  );

  const startSettleDeadline = useCallback(
    (generation: number) => {
      if (
        generation !== settleGenerationRef.current ||
        motionRef.current.phase.kind !== "Settling"
      ) {
        return;
      }
      let deadlineMs = 0;
      for (const { surface } of surfacesRef.current.values()) {
        if (!surface.isConnected) continue;
        deadlineMs = Math.max(deadlineMs, transitionDeadlineMs(surface));
      }
      settleDeadlineRef.current = window.setTimeout(() => {
        settleDeadlineRef.current = null;
        finishSettle(generation);
      }, deadlineMs);
    },
    [finishSettle],
  );

  const beginSettle = useCallback(() => {
    const next = reduceMobileChromeMotion(motionRef.current, { kind: "Settle" });
    if (next === motionRef.current) return;
    invalidateSettle();
    const generation = settleGenerationRef.current;
    commit(next);
    settleArmFrameRef.current = window.requestAnimationFrame(() => {
      settleArmFrameRef.current = null;
      startSettleDeadline(generation);
    });
  }, [commit, invalidateSettle, startSettleDeadline]);

  const interruptSettle = useCallback(
    (preferredSurface?: HTMLElement) => {
      const state = motionRef.current;
      if (state.phase.kind !== "Settling") return state;
      cancelFrame();
      invalidateSettle();
      const surfaces = preferredSurface
        ? [
            preferredSurface,
            ...[...surfacesRef.current.values()]
              .map(({ surface }) => surface)
              .filter((surface) => surface !== preferredSurface),
          ]
        : [...surfacesRef.current.values()].map(({ surface }) => surface);
      let progress: number | null = null;
      for (const surface of surfaces) {
        const candidate = Number.parseFloat(
          window
            .getComputedStyle(surface)
            .getPropertyValue(COLLAPSE_PROPERTY),
        );
        if (!Number.isFinite(candidate)) continue;
        progress = Math.min(1, Math.max(0, candidate));
        break;
      }
      if (progress === null) {
        throw new Error(
          "Mobile chrome surfaces must expose a numeric collapse progress",
        );
      }
      cancelCollapseTransitions(surfaces);
      const next = {
        ...state,
        phase: phaseAtProgress(state, progress),
        progress,
      };
      writeProgress(progress);
      motionRef.current = next;
      publishPhase(next.phase);
      return next;
    },
    [cancelFrame, invalidateSettle, publishPhase, writeProgress],
  );

  const rebaselineReader = useCallback(() => {
    cancelFrame();
    cancelScrollIdleTimer();
    invalidateSettle();
    const scrollport = readerScrollportRef.current?.scrollport;
    let next = scrollport
      ? reduceMobileChromeMotion(initialMobileChromeMotionState(), {
          kind: "Start",
          snapshot: scrollSnapshot(scrollport),
        })
      : initialMobileChromeMotionState();
    if (hasPin()) {
      next = reduceMobileChromeMotion(next, { kind: "Pin" });
    }
    commit(next);
  }, [
    cancelFrame,
    cancelScrollIdleTimer,
    commit,
    hasPin,
    invalidateSettle,
  ]);

  const refreshReaderGeometry = useCallback(
    (scrollport: HTMLElement) => {
      if (
        !isMobileRef.current ||
        readerScrollportRef.current?.scrollport !== scrollport
      ) {
        return;
      }
      const prior = motionRef.current;
      const next = reduceMobileChromeMotion(prior, {
        kind: "RefreshGeometry",
        snapshot: scrollSnapshot(scrollport),
      });
      if (
        samePhase(prior.phase, next.phase) &&
        prior.progress === next.progress
      ) {
        motionRef.current = next;
        return;
      }
      cancelFrame();
      cancelScrollIdleTimer();
      invalidateSettle();
      commit(next);
    },
    [cancelFrame, cancelScrollIdleTimer, commit, invalidateSettle],
  );

  const scheduleReaderGeometryRefresh = useCallback(
    (scrollport: HTMLElement) => {
      if (
        readerScrollportRef.current?.scrollport !== scrollport ||
        geometryFrameRef.current !== null
      ) {
        return;
      }
      geometryFrameRef.current = window.requestAnimationFrame(() => {
        geometryFrameRef.current = null;
        refreshReaderGeometry(scrollport);
      });
    },
    [refreshReaderGeometry],
  );

  const setChromeFocusLock = useCallback(
    (locked: boolean) => {
      if (chromeFocusLockRef.current === locked) return;
      chromeFocusLockRef.current = locked;
      if (locked) {
        cancelFrame();
        cancelScrollIdleTimer();
        invalidateSettle();
        commit(reduceMobileChromeMotion(motionRef.current, { kind: "Pin" }));
        return;
      }
      if (!hasPin()) rebaselineReader();
    },
    [
      cancelFrame,
      cancelScrollIdleTimer,
      commit,
      hasPin,
      invalidateSettle,
      rebaselineReader,
    ],
  );

  const reconcileChromeFocus = useCallback(() => {
    const activeElement = document.activeElement;
    const focused =
      isMobileRef.current &&
      activeElement instanceof HTMLElement &&
      activeElement.isConnected &&
      [...surfacesRef.current.values()].some(
        ({ surface }) =>
          surface.isConnected && surface.contains(activeElement),
      );
    setChromeFocusLock(focused);
  }, [setChromeFocusLock]);

  const acquireLock = useCallback(
    (reason: VisibleLockReason) => {
      const lockId = (nextLockIdRef.current += 1);
      visibleLocksRef.current.set(lockId, reason);
      if (isMobileRef.current) {
        cancelFrame();
        cancelScrollIdleTimer();
        invalidateSettle();
        commit(reduceMobileChromeMotion(motionRef.current, { kind: "Pin" }));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        visibleLocksRef.current.delete(lockId);
        if (!hasPin()) rebaselineReader();
      };
    },
    [
      cancelFrame,
      cancelScrollIdleTimer,
      commit,
      hasPin,
      invalidateSettle,
      rebaselineReader,
    ],
  );

  const acquirePublicLock = useCallback(
    (reason: MobileChromeVisibleLockReason) => acquireLock(reason),
    [acquireLock],
  );

  const handleReaderSample = useCallback(
    (scrollport: HTMLElement) => {
      if (!isMobileRef.current) return;
      reconcileChromeFocus();
      const snapshot = scrollSnapshot(scrollport);
      const prior = motionRef.current;
      if (prior.phase.kind === "Settling") interruptSettle();
      let next = reduceMobileChromeMotion(motionRef.current, {
        kind: "Scroll",
        snapshot,
      });
      if (hasPin()) {
        next = reduceMobileChromeMotion(next, { kind: "Pin" });
      }
      if (next === motionRef.current) return;
      cancelScrollIdleTimer();
      commit(next);
      if (
        next.phase.kind !== "Tracking" ||
        next.progress === 0 ||
        next.progress === 1
      ) {
        return;
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        beginSettle();
      }, SCROLL_IDLE_SETTLE_DELAY_MS);
    },
    [
      beginSettle,
      cancelScrollIdleTimer,
      commit,
      hasPin,
      interruptSettle,
      reconcileChromeFocus,
    ],
  );

  const registerReaderScrollport = useCallback(
    (scrollport: HTMLElement, sourceKey: string) => {
      const existing = readerScrollportRef.current;
      if (existing) {
        throw new Error(
          `Mobile chrome already has an enabled reader scrollport for ${existing.sourceKey}`,
        );
      }
      const pendingWindowClickCleanups = new Set<() => void>();
      const onScroll = () => handleReaderSample(scrollport);
      const onGeometryChange = () =>
        scheduleReaderGeometryRefresh(scrollport);
      const observedContent = new Set<Element>();
      const resizeObserver = new ResizeObserver(onGeometryChange);
      const syncObservedContent = () => {
        const nextObserved = new Set<Element>([
          scrollport,
          ...scrollport.children,
        ]);
        for (const element of observedContent) {
          if (!nextObserved.has(element)) {
            resizeObserver.unobserve(element);
            observedContent.delete(element);
          }
        }
        for (const element of nextObserved) {
          if (observedContent.has(element)) continue;
          observedContent.add(element);
          resizeObserver.observe(element);
        }
      };
      const contentObserver = new MutationObserver(() => {
        syncObservedContent();
        onGeometryChange();
      });
      const visualViewport = window.visualViewport;
      const onClick = (event: MouseEvent) => {
        reconcileChromeFocus();
        if (
          motionRef.current.phase.kind !== "Hidden" ||
          !primaryUnmodifiedClick(event) ||
          event.defaultPrevented ||
          hasLiveSelection() ||
          isInteractiveReaderTap(event.target, scrollport) ||
          closestElement(event.target, READER_TAP_HANDLED)
        ) {
          return;
        }
        let cleanupTimer: number | null = null;
        const cleanup = () => {
          window.removeEventListener("click", onWindowClick);
          if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
          pendingWindowClickCleanups.delete(cleanup);
        };
        const onWindowClick = (windowEvent: MouseEvent) => {
          if (windowEvent !== event) return;
          cleanup();
          reconcileChromeFocus();
          if (
            windowEvent.defaultPrevented ||
            hasLiveSelection() ||
            isInteractiveReaderTap(windowEvent.target, scrollport) ||
            closestElement(windowEvent.target, READER_TAP_HANDLED)
          ) {
            return;
          }
          rebaselineReader();
        };
        pendingWindowClickCleanups.add(cleanup);
        window.addEventListener("click", onWindowClick);
        cleanupTimer = window.setTimeout(cleanup, 0);
      };
      syncObservedContent();
      contentObserver.observe(scrollport, { childList: true });
      scrollport.addEventListener("scroll", onScroll, { passive: true });
      scrollport.addEventListener("click", onClick);
      scrollport.addEventListener("load", onGeometryChange, true);
      window.addEventListener("resize", onGeometryChange);
      visualViewport?.addEventListener("resize", onGeometryChange);

      let unregistered = false;
      const registration: ReaderScrollportRegistration = {
        scrollport,
        sourceKey,
        pendingWindowClickCleanups,
        unregister() {
          if (unregistered) return;
          unregistered = true;
          resizeObserver.disconnect();
          contentObserver.disconnect();
          scrollport.removeEventListener("scroll", onScroll);
          scrollport.removeEventListener("click", onClick);
          scrollport.removeEventListener("load", onGeometryChange, true);
          window.removeEventListener("resize", onGeometryChange);
          visualViewport?.removeEventListener("resize", onGeometryChange);
          for (const cleanup of [...pendingWindowClickCleanups]) cleanup();
          if (readerScrollportRef.current === registration) {
            cancelGeometryFrame();
            readerScrollportRef.current = null;
            rebaselineReader();
          }
        },
      };
      readerScrollportRef.current = registration;
      rebaselineReader();
      return registration.unregister;
    },
    [
      cancelGeometryFrame,
      handleReaderSample,
      rebaselineReader,
      reconcileChromeFocus,
      scheduleReaderGeometryRefresh,
    ],
  );

  const handleTransitionRun = useCallback(
    (registration: MobileChromeSurfaceRegistration, event: TransitionEvent) => {
      if (
        event.target !== registration.surface ||
        event.propertyName !== COLLAPSE_PROPERTY ||
        motionRef.current.phase.kind !== "Settling"
      ) {
        return;
      }
      registration.settleGeneration = settleGenerationRef.current;
    },
    [],
  );

  const handleTransitionEnd = useCallback(
    (registration: MobileChromeSurfaceRegistration, event: TransitionEvent) => {
      const generation = registration.settleGeneration;
      if (
        event.target !== registration.surface ||
        event.propertyName !== COLLAPSE_PROPERTY ||
        motionRef.current.phase.kind !== "Settling" ||
        generation === null ||
        generation !== settleGenerationRef.current
      ) {
        return;
      }
      registration.settleGeneration = null;
      finishSettle(generation);
    },
    [finishSettle],
  );

  const handleTransitionCancel = useCallback(
    (registration: MobileChromeSurfaceRegistration, event: TransitionEvent) => {
      const generation = registration.settleGeneration;
      if (
        event.target !== registration.surface ||
        event.propertyName !== COLLAPSE_PROPERTY ||
        motionRef.current.phase.kind !== "Settling" ||
        generation === null ||
        generation !== settleGenerationRef.current
      ) {
        return;
      }
      registration.settleGeneration = null;
      const sampled = interruptSettle(registration.surface);
      if (
        sampled.phase.kind === "Tracking" &&
        sampled.progress > 0 &&
        sampled.progress < 1
      ) {
        beginSettle();
      }
    },
    [beginSettle, interruptSettle],
  );

  const registerSurface = useCallback(
    (surface: HTMLElement, role: MobileChromeSurfaceRole) => {
      if (surfacesRef.current.has(role)) {
        throw new Error(`Mobile chrome already has an enabled ${role} surface`);
      }
      let unregistered = false;
      const onFocusIn = () => reconcileChromeFocus();
      const onFocusOut = () => queueMicrotask(reconcileChromeFocus);
      const observer = new MutationObserver(() =>
        queueMicrotask(reconcileChromeFocus),
      );
      function onTransitionEnd(event: TransitionEvent) {
        handleTransitionEnd(registration, event);
      }
      function onTransitionRun(event: TransitionEvent) {
        handleTransitionRun(registration, event);
      }
      function onTransitionCancel(event: TransitionEvent) {
        handleTransitionCancel(registration, event);
      }
      const registration: MobileChromeSurfaceRegistration = {
        role,
        surface,
        observer,
        settleGeneration: null,
        unregister() {
          if (unregistered) return;
          unregistered = true;
          surface.removeEventListener("focusin", onFocusIn);
          surface.removeEventListener("focusout", onFocusOut);
          surface.removeEventListener("transitionrun", onTransitionRun);
          surface.removeEventListener("transitionend", onTransitionEnd);
          surface.removeEventListener("transitioncancel", onTransitionCancel);
          observer.disconnect();
          if (surfacesRef.current.get(role) === registration) {
            surfacesRef.current.delete(role);
          }
          reconcileChromeFocus();
        },
      };
      surface.addEventListener("focusin", onFocusIn);
      surface.addEventListener("focusout", onFocusOut);
      surface.addEventListener("transitionrun", onTransitionRun);
      surface.addEventListener("transitionend", onTransitionEnd);
      surface.addEventListener("transitioncancel", onTransitionCancel);
      observer.observe(surface, { childList: true, subtree: true });
      surfacesRef.current.set(role, registration);
      reconcileChromeFocus();
      scheduleProgressWrite(
        mobileChromePresentationProgress(motionRef.current),
      );
      return registration.unregister;
    },
    [
      handleTransitionCancel,
      handleTransitionEnd,
      handleTransitionRun,
      reconcileChromeFocus,
      scheduleProgressWrite,
    ],
  );

  const setPaneChrome = useCallback(
    (chrome: MobilePaneChrome | null) => {
      const active = activePaneRouteRef.current;
      if (
        chrome !== null &&
        (chrome.paneId !== active?.paneId ||
          chrome.routeKey !== active.routeKey)
      ) {
        if (readerInteractionRoots(chrome.paneId).length > 1) {
          throw new Error(
            `Active pane ${chrome.paneId} has more than one mobile reader interaction root`,
          );
        }
        activePaneRouteRef.current = {
          paneId: chrome.paneId,
          routeKey: chrome.routeKey,
        };
        rebaselineReader();
      }
      if (chrome === null) activePaneRouteRef.current = null;
      setPaneChromeState(chrome);
    },
    [rebaselineReader],
  );

  const focusPaneChrome = useCallback(
    async (paneId: string) => {
      const release = acquireLock("focus-return");
      try {
        await nextFrame();
        if (!mountedRef.current) return;
        const appBar = surfacesRef.current.get("AppBar")?.surface ?? null;
        const appBarCommand =
          appBar?.isConnected &&
          appBar.dataset.paneChromeFor === paneId &&
          appBar.closest("[inert]") === null
            ? appBar.querySelector<HTMLElement>("[data-pane-options-trigger]")
            : null;
        const landmark = findPaneLandmarkFocusTarget(paneId);
        const target =
          appBarCommand?.isConnected &&
          appBarCommand.closest("[inert]") === null &&
          !(
            appBarCommand instanceof HTMLButtonElement &&
            appBarCommand.disabled
          )
            ? appBarCommand
            : landmark;
        if (!target) {
          throw new Error(`Pane ${paneId} has no connected focus target`);
        }
        target.focus({ preventScroll: true });
        if (
          document.activeElement !== target &&
          landmark &&
          target !== landmark
        ) {
          landmark.focus({ preventScroll: true });
        }
        if (
          document.activeElement !== target &&
          document.activeElement !== landmark
        ) {
          throw new Error(`Pane ${paneId} rejected every connected focus target`);
        }
        reconcileChromeFocus();
      } finally {
        release();
      }
    },
    [acquireLock, reconcileChromeFocus],
  );

  const activeInteractionRoot = useCallback(() => {
    const paneId = activePaneRouteRef.current?.paneId;
    if (!paneId) return null;
    const roots = readerInteractionRoots(paneId);
    if (roots.length > 1) {
      throw new Error(
        `Active pane ${paneId} has more than one mobile reader interaction root`,
      );
    }
    return roots[0] ?? null;
  }, []);

  useEffect(() => {
    const reconcileInput = () => reconcileChromeFocus();
    const onPointerDown = (event: PointerEvent) => {
      reconcileChromeFocus();
      if (
        !isMobileRef.current ||
        event.button !== 0 ||
        !event.isPrimary ||
        !(event.target instanceof Node)
      ) {
        return;
      }
      const root = activeInteractionRoot();
      if (!root || !root.contains(event.target)) return;
      const activeElement = document.activeElement;
      if (
        !(activeElement instanceof HTMLElement) ||
        ![...surfacesRef.current.values()].some(({ surface }) =>
          surface.contains(activeElement),
        )
      ) {
        return;
      }
      activeElement.blur();
      reconcileChromeFocus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", reconcileInput, true);
    document.addEventListener("keydown", reconcileInput, true);
    document.addEventListener("wheel", reconcileInput, true);
    document.addEventListener("touchstart", reconcileInput, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", reconcileInput, true);
      document.removeEventListener("keydown", reconcileInput, true);
      document.removeEventListener("wheel", reconcileInput, true);
      document.removeEventListener("touchstart", reconcileInput, true);
    };
  }, [activeInteractionRoot, reconcileChromeFocus]);

  useEffect(() => {
    if (previousIsMobileRef.current === isMobile) return;
    previousIsMobileRef.current = isMobile;
    reconcileChromeFocus();
    rebaselineReader();
  }, [isMobile, rebaselineReader, reconcileChromeFocus]);

  const disposeProvider = useCallback(() => {
    mountedRef.current = false;
    readerScrollportRef.current?.unregister();
    for (const registration of [...surfacesRef.current.values()]) {
      registration.unregister();
    }
    visibleLocksRef.current.clear();
    cancelFrame();
    cancelGeometryFrame();
    cancelScrollIdleTimer();
    invalidateSettle();
  }, [
    cancelFrame,
    cancelGeometryFrame,
    cancelScrollIdleTimer,
    invalidateSettle,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return disposeProvider;
  }, [disposeProvider]);

  const stable = useMemo<StableController>(
    () => ({
      setPaneChrome,
      registerSurface,
      registerReaderScrollport,
      acquire: acquirePublicLock,
      focusPaneChrome,
    }),
    [
      acquirePublicLock,
      focusPaneChrome,
      registerReaderScrollport,
      registerSurface,
      setPaneChrome,
    ],
  );
  const volatile = useMemo<VolatileChromeState>(
    () => ({ motionPhase, paneChrome }),
    [motionPhase, paneChrome],
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

export function useMobileChrome(): VolatileChromeState &
  Pick<StableController, "setPaneChrome"> {
  const stable = useStableController("useMobileChrome");
  const volatile = useContext(VolatileChromeContext);
  if (!volatile) {
    throw new Error("useMobileChrome must be used within MobileChromeProvider");
  }
  return { ...volatile, setPaneChrome: stable.setPaneChrome };
}

function useVisibleLocks(
  stable: StableController | null,
): MobileChromeVisibleLocks {
  const releasesRef = useRef(new Set<() => void>());
  const acquire = useCallback(
    (reason: MobileChromeVisibleLockReason) => {
      if (!stable) return () => undefined;
      const releaseProviderLock = stable.acquire(reason);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releasesRef.current.delete(release);
        releaseProviderLock();
      };
      releasesRef.current.add(release);
      return release;
    },
    [stable],
  );
  useEffect(
    () => () => {
      for (const release of [...releasesRef.current]) release();
    },
    [],
  );
  return useMemo(() => ({ acquire }), [acquire]);
}

export function useMobileChromeVisibleLocks(): MobileChromeVisibleLocks {
  return useVisibleLocks(
    useStableController("useMobileChromeVisibleLocks"),
  );
}

/**
 * Collection primitives also render where no mobile chrome exists. They may
 * discover this capability without creating a second chrome owner; when the
 * authenticated shell is present, the returned locks are the provider's real
 * locks.
 */
export function useOptionalMobileChromeVisibleLocks(): MobileChromeVisibleLocks {
  return useVisibleLocks(useContext(StableControllerContext));
}

export function usePaneChromeFocusReturn(): PaneChromeFocusReturn {
  const stable = useStableController("usePaneChromeFocusReturn");
  return useMemo(
    () => ({ focus: stable.focusPaneChrome }),
    [stable.focusPaneChrome],
  );
}

/**
 * Reusable pane content and global player surfaces also render in desktop-only
 * harnesses where mobile chrome is not mounted. They may discover the focus
 * capability without manufacturing another chrome owner.
 */
export function useOptionalPaneChromeFocusReturn(): PaneChromeFocusReturn {
  const stable = useContext(StableControllerContext);
  return useMemo(
    () => ({
      focus:
        stable?.focusPaneChrome ??
        (async (_paneId: string): Promise<void> => undefined),
    }),
    [stable?.focusPaneChrome],
  );
}

export function useMobileChromeReaderScrollport<T extends HTMLElement>(
  input: MobileChromeReaderScrollportInput,
): RefCallback<T> {
  const stable = useStableController("useMobileChromeReaderScrollport");
  const { enabled, sourceKey } = input;
  return useCallback(
    (scrollport) => {
      if (!enabled || scrollport === null) return;
      return stable.registerReaderScrollport(scrollport, sourceKey);
    },
    [enabled, sourceKey, stable],
  );
}

export function useMobileChromeSurface(
  ref: RefObject<HTMLElement | null>,
  role: MobileChromeSurfaceRole,
  enabled: boolean,
): void {
  const stable = useStableController("useMobileChromeSurface");
  useLayoutEffect(() => {
    if (!enabled) return;
    const surface = ref.current;
    if (!surface) return;
    return stable.registerSurface(surface, role);
  }, [enabled, ref, role, stable]);
}
