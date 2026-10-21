"use client";

// mobile reader taps toggle the active pane's top bar and controls and the nexus button.
// this module owns their visibility target, inertness and motion attributes;
// css interpolates them without changing reading geometry. scrolling never
// changes the target. command holds show immediately and leave controls shown.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { listenForReaderTap } from "./readerTap";
import "./chrome.css";

export interface MobileChrome {
  /** shown immediately and interactive until every hold is released; release leaves shown. */
  hold(): () => void;
  /** a fresh reader starts shown; on mobile the newest registered one accepts taps. */
  registerReaderScrollport(scrollport: HTMLElement): () => void;
  /** Next frame: focus the pane's More trigger, else its landmark. */
  focusPaneChrome(paneId: string): void;
  /** toggle the active mobile reader unless an explicit hold owns its controls. */
  toggleReaderChrome(): void;
}

type MobileChromeState = "Shown" | "Hidden" | "Held" | null;

function createMobileChrome() {
  let mobile = false;
  let shown = true;
  let holds = 0;
  const surfaces = new Set<HTMLElement>();
  const scrollports: HTMLElement[] = [];
  const stateListeners = new Set<() => void>();

  const driver = () => (mobile ? (scrollports.at(-1) ?? null) : null);
  const inSurface = (node: Node | null) =>
    node !== null && [...surfaces].some((surface) => surface.contains(node));

  function paintSurface(surface: HTMLElement, motion: "Animated" | "Instant") {
    surface.dataset.mobileChromeVisibility = shown ? "Shown" : "Hidden";
    surface.dataset.mobileChromeMotion = motion;
    surface.inert = !shown;
  }

  function notifyState() {
    for (const listener of stateListeners) listener();
  }

  function paint(motion: "Animated" | "Instant") {
    for (const surface of surfaces) paintSurface(surface, motion);
    notifyState();
  }

  function show() {
    shown = true;
    paint("Instant");
  }

  function toggleReaderChrome() {
    const port = driver();
    if (!port || holds > 0) return;
    if (shown && inSurface(document.activeElement)) {
      const paneId = port.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
      findPaneLandmarkFocusTarget(paneId)?.focus({ preventScroll: true });
      if (inSurface(document.activeElement)) return;
    }
    shown = !shown;
    paint("Animated");
  }

  function hold() {
    holds += 1;
    show();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      holds -= 1;
      notifyState();
    };
  }

  return {
    hold,
    toggleReaderChrome,
    registerReaderScrollport(port: HTMLElement) {
      const release = listenForReaderTap(port, () => {
        if (port === driver()) toggleReaderChrome();
      });
      scrollports.push(port);
      show();
      return () => {
        release();
        const index = scrollports.indexOf(port);
        if (index !== -1) scrollports.splice(index, 1);
        show();
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
      paintSurface(surface, "Instant");
      return () => {
        surfaces.delete(surface);
        delete surface.dataset.mobileChromeVisibility;
        delete surface.dataset.mobileChromeMotion;
        surface.inert = false;
      };
    },
    setMobile(next: boolean) {
      if (next === mobile) return;
      mobile = next;
      show();
    },
    subscribeState(listener: () => void) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    state: (): MobileChromeState => !driver() ? null : holds > 0 ? "Held" : shown ? "Shown" : "Hidden",
  };
}

const MobileChromeContext = createContext<ReturnType<typeof createMobileChrome> | null>(null);

export function MobileChromeProvider({ children }: { children: ReactNode }) {
  const [chrome] = useState(createMobileChrome);
  const isMobile = useIsMobileViewport();
  useLayoutEffect(() => chrome.setMobile(isMobile), [chrome, isMobile]);
  return <MobileChromeContext value={chrome}>{children}</MobileChromeContext>;
}

function useController() {
  const chrome = useContext(MobileChromeContext);
  if (!chrome) throw new Error("mobile chrome hooks require MobileChromeProvider");
  return chrome;
}

export const useMobileChrome: () => MobileChrome = useController;

/** the active reader's visibility target; independent of css transition progress. */
export function useMobileChromeState(): MobileChromeState {
  const chrome = useController();
  return useSyncExternalStore(chrome.subscribeState, chrome.state, () => null);
}

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
  useLayoutEffect(() => (active ? chrome.hold() : undefined), [chrome, active]);
}
