"use client";

// Mobile chrome: the top bar, the active pane's contextual row and the Nexus
// control retreat while the reader reads forward and return on intent. This
// module alone writes their motion: `--mobile-chrome-collapse` (p), `inert`
// (p > 0) and `data-mobile-chrome-phase` on every registered surface, in the
// same task, so moving chrome is never interactive and all of it moves as one.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { SurfaceHeaderNavigation } from "@/components/ui/SurfaceHeader";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { PaneCompanionAction } from "@/lib/panes/paneChrome";
import type { TargetLinkMouseEvent } from "@/lib/panes/targetLinkActivation";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { isInteractiveTarget } from "@/lib/ui/interactiveTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { baseline, scrolled, SHOWN, type Motion } from "./chromeMotion";

/** The active pane's header and commands, published by its PaneShell for the top bar. */
export interface MobilePaneChrome {
  readonly paneId: string;
  readonly identityId: string;
  readonly header: PaneHeaderModel;
  readonly activateChromeAnchor: (event: TargetLinkMouseEvent, anchor: HTMLAnchorElement) => void;
  readonly navigation: SurfaceHeaderNavigation;
  /** The only header action outside More. */
  readonly companionAction?: PaneCompanionAction;
  readonly paneActions: readonly ActionDescriptor[];
  readonly menuActions: readonly ActionDescriptor[];
  readonly actionSubject?: ResourceActionSubject;
}

export interface MobileChrome {
  /** Shown and interactive until every hold is released; the last release re-measures. */
  hold(): () => void;
  /** A reader's scroll element; on mobile the newest registered one drives motion. */
  registerReaderScrollport(scrollport: HTMLElement): () => void;
  /** Next frame: focus the pane's More trigger, else its landmark. */
  focusPaneChrome(paneId: string): void;
}

/** Visible and Pinned are interactive; the others are inert. */
type Phase = "Visible" | "Tracking" | "Settling" | "Hidden" | "Pinned";

const IDLE_SETTLE_MS = 120;

function createMobileChrome() {
  let mobile = false;
  let motion: Motion = SHOWN;
  let holds = 0;
  let idleTimer = 0;
  let tweenFrame = 0;
  const surfaces = new Set<HTMLElement>();
  const scrollports: HTMLElement[] = [];
  let paneChrome: MobilePaneChrome | null = null;
  const paneChromeListeners = new Set<() => void>();

  const driver = () => (mobile ? (scrollports.at(-1) ?? null) : null);
  const inSurface = (node: Node | null) =>
    node !== null && [...surfaces].some((surface) => surface.contains(node));
  const pinned = () => mobile && (holds > 0 || inSurface(document.activeElement));
  // Rubber-band overscroll is not reading.
  const topOf = (port: HTMLElement) =>
    Math.min(Math.max(0, port.scrollTop), Math.max(0, port.scrollHeight - port.clientHeight));

  function paint() {
    const p = motion.p;
    const phase: Phase = pinned()
      ? "Pinned"
      : tweenFrame
        ? "Settling"
        : p === 0
          ? "Visible"
          : p === 1
            ? "Hidden"
            : "Tracking";
    for (const surface of surfaces) {
      surface.style.setProperty("--mobile-chrome-collapse", String(p));
      surface.dataset.mobileChromePhase = phase;
      surface.inert = p > 0;
    }
  }

  function stop() {
    window.clearTimeout(idleTimer);
    cancelAnimationFrame(tweenFrame);
    idleTimer = tweenFrame = 0;
  }

  /** Shown, measured from wherever the driving reader is now. */
  function reset() {
    stop();
    const port = driver();
    motion = port ? baseline(topOf(port)) : SHOWN;
    paint();
  }

  // A stopped half-retreat glides to its nearer end; the next sample stops it where it is.
  function settle() {
    const from = motion.p;
    const to = from < 0.5 ? 0 : 1;
    const style = getComputedStyle(document.documentElement);
    const ms = Number.parseFloat(style.getPropertyValue("--duration-fast")) || 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = ms > 0 ? Math.min(1, Math.max(0, now - start) / ms) : 1;
      motion = { ...motion, p: t === 1 ? to : from + (to - from) * (1 - (1 - t) ** 3) };
      tweenFrame = t === 1 ? 0 : requestAnimationFrame(step);
      paint();
    };
    tweenFrame = requestAnimationFrame(step);
  }

  function sample(port: HTMLElement) {
    if (port !== driver()) return;
    stop();
    motion = pinned() ? baseline(topOf(port)) : scrolled(motion, topOf(port));
    paint();
    if (motion.p > 0 && motion.p < 1) idleTimer = window.setTimeout(settle, IDLE_SETTLE_MS);
  }

  /** A plain tap on the reader's own canvas brings hidden or moving chrome back. */
  function reveal(port: HTMLElement, event: MouseEvent) {
    if (
      port !== driver() ||
      motion.p === 0 ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      isInteractiveTarget(event.target, port) ||
      window.getSelection()?.isCollapsed === false
    ) {
      return;
    }
    reset();
  }

  function hold() {
    holds += 1;
    reset();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      holds -= 1;
      if (holds === 0) reset();
    };
  }

  return {
    hold,
    registerReaderScrollport(port: HTMLElement) {
      const onScroll = () => sample(port);
      // Decided after the whole dispatch, so every handler (React's at the document) has had its say.
      // The listener on the scrollport itself also keeps iOS dispatching taps on plain text.
      const onClick = (event: MouseEvent) => window.setTimeout(() => reveal(port, event), 0);
      port.addEventListener("scroll", onScroll, { passive: true });
      port.addEventListener("click", onClick);
      scrollports.push(port);
      reset();
      return () => {
        port.removeEventListener("scroll", onScroll);
        port.removeEventListener("click", onClick);
        const index = scrollports.indexOf(port);
        if (index !== -1) scrollports.splice(index, 1);
        reset();
      };
    },
    focusPaneChrome(paneId: string) {
      const release = hold();
      requestAnimationFrame(() => {
        const target = findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
        target?.focus({ preventScroll: true });
        if (document.activeElement !== target) {
          findPaneLandmarkFocusTarget(paneId)?.focus({ preventScroll: true });
        }
        release();
      });
    },
    registerSurface(surface: HTMLElement) {
      surfaces.add(surface);
      paint();
      return () => {
        surfaces.delete(surface);
        surface.style.removeProperty("--mobile-chrome-collapse");
        delete surface.dataset.mobileChromePhase;
        surface.inert = false;
      };
    },
    setMobile(next: boolean) {
      if (next === mobile) return;
      mobile = next;
      reset();
    },
    /** A press on the reader's pane releases a focused chrome control (WebKit keeps focus on taps). */
    listen() {
      const release = (event: PointerEvent) => {
        const port = driver();
        const focused = document.activeElement;
        if (
          !port ||
          event.button !== 0 ||
          !event.isPrimary ||
          !(event.target instanceof Node) ||
          !(focused instanceof HTMLElement) ||
          !inSurface(focused) ||
          inSurface(event.target) ||
          !port.closest("[data-pane-id]")?.contains(event.target)
        ) {
          return;
        }
        focused.blur();
        reset();
      };
      document.addEventListener("pointerdown", release, true);
      return () => {
        stop();
        document.removeEventListener("pointerdown", release, true);
      };
    },
    setPaneChrome(next: MobilePaneChrome | null) {
      paneChrome = next;
      for (const listener of paneChromeListeners) listener();
    },
    subscribePaneChrome(listener: () => void) {
      paneChromeListeners.add(listener);
      return () => {
        paneChromeListeners.delete(listener);
      };
    },
    paneChrome: () => paneChrome,
  };
}

const MobileChromeContext = createContext<ReturnType<typeof createMobileChrome> | null>(null);

export function MobileChromeProvider({ children }: { children: ReactNode }) {
  const [chrome] = useState(createMobileChrome);
  const isMobile = useIsMobileViewport();
  useLayoutEffect(() => chrome.setMobile(isMobile), [chrome, isMobile]);
  useEffect(() => chrome.listen(), [chrome]);
  return <MobileChromeContext value={chrome}>{children}</MobileChromeContext>;
}

function useController() {
  const chrome = useContext(MobileChromeContext);
  if (!chrome) throw new Error("mobile chrome hooks require MobileChromeProvider");
  return chrome;
}

export const useMobileChrome: () => MobileChrome = useController;

/** Registers a moving surface while `enabled`; the module owns its motion attributes. */
export function useMobileChromeSurface(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  const chrome = useController();
  useLayoutEffect(() => {
    const surface = ref.current;
    return enabled && surface ? chrome.registerSurface(surface) : undefined;
  }, [chrome, ref, enabled]);
}

/** Keeps the chrome shown while `active`. */
export function useMobileChromeHold(active: boolean): void {
  const chrome = useController();
  useEffect(() => (active ? chrome.hold() : undefined), [chrome, active]);
}

/** Publishes the mounted active pane's chrome for the top bar while non-null. */
export function usePublishMobilePaneChrome(value: MobilePaneChrome | null): void {
  const chrome = useController();
  useLayoutEffect(() => {
    if (!value) return;
    chrome.setPaneChrome(value);
    return () => {
      if (chrome.paneChrome() === value) chrome.setPaneChrome(null);
    };
  }, [chrome, value]);
}

export function useMobilePaneChrome(): MobilePaneChrome | null {
  const chrome = useController();
  return useSyncExternalStore(chrome.subscribePaneChrome, chrome.paneChrome, () => null);
}
