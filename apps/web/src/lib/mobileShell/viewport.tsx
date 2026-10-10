"use client";

// Bottom geometry on mobile. Player and persistent Feedback place the Nexus
// control; the Nexus band, the safe area and an open modal's keyboard are what
// terminal content must clear. One pass writes, in dependency order:
//   --mobile-nexus-bottom-offset      max(safe, band(Player), band(Feedback))
//   --mobile-content-bottom-clearance max(safe, band(Nexus), keyboard)   (root)
//   --mobile-overlay-keyboard-inset   the newest keyboard report
// and, on each content surface, the part of that clearance flow layout below
// the surface has not already spent.
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { usePersistentFeedbackElement } from "@/components/feedback/Feedback";
import { isTextEntryTarget } from "@/lib/ui/isTextEntryTarget";

export type MobileBottomSurfaceId = "Nexus" | "Player" | "Feedback";

export interface MobileViewport {
  registerBottomSurface(id: MobileBottomSurfaceId, element: HTMLElement): () => void;
  registerContentSurface(element: HTMLElement): () => void;
  /** The newest report wins; releasing it restores the one before. */
  reportMobileOverlayKeyboardInset(px: number): () => void;
  /** Called after every pass. */
  subscribeContentBottomClearance(listener: () => void): () => void;
}

/** A CSS length expression (a `globals.css` token) in CSS pixels; 0 when it does not resolve. */
export function readMobileCssLength(cssLength: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;visibility:hidden;width:calc(${cssLength})`;
  document.body.append(probe);
  const px = Number.parseFloat(getComputedStyle(probe).width);
  probe.remove();
  return Number.isFinite(px) ? Math.max(0, px) : 0;
}

/** How far up from the window bottom a surface covers. */
function band(element: HTMLElement | undefined, viewportPx: number): number {
  const box = element?.getBoundingClientRect();
  if (!box || box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= viewportPx) {
    return 0;
  }
  return Math.ceil(Math.min(viewportPx, viewportPx - box.top));
}

function createMobileViewport() {
  const bottoms = new Map<MobileBottomSurfaceId, HTMLElement>();
  const contents = new Set<HTMLElement>();
  const keyboard: { px: number }[] = [];
  const listeners = new Set<() => void>();
  let frame = 0;
  let observer: ResizeObserver | null = null; // created on first use: never on the server
  // Border box: the padding a pass writes into a content surface must not read back as a resize.
  const observe = (element: HTMLElement) =>
    (observer ??= new ResizeObserver(schedule)).observe(element, { box: "border-box" });

  function measure() {
    const viewportPx = window.innerHeight;
    const safe = Math.ceil(readMobileCssLength("var(--viewport-safe-bottom)"));
    const keyboardPx = keyboard.at(-1)?.px ?? 0;
    const root = document.documentElement.style;
    const nexusOffset = Math.max(
      safe,
      band(bottoms.get("Player"), viewportPx),
      band(bottoms.get("Feedback"), viewportPx),
    );
    root.setProperty("--mobile-nexus-bottom-offset", `${nexusOffset}px`);
    // Read after the write above: the Nexus control sits on that offset.
    const clearance = Math.max(safe, band(bottoms.get("Nexus"), viewportPx), keyboardPx);
    root.setProperty("--mobile-content-bottom-clearance", `${clearance}px`);
    root.setProperty("--mobile-overlay-keyboard-inset", `${keyboardPx}px`);
    for (const element of contents) {
      const below = Math.max(0, viewportPx - element.getBoundingClientRect().bottom);
      const local = Math.max(0, Math.ceil(clearance - below));
      element.style.setProperty("--mobile-content-bottom-clearance", `${local}px`);
    }
    for (const listener of listeners) listener();
  }

  function schedule() {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  }

  return {
    registerBottomSurface(id: MobileBottomSurfaceId, element: HTMLElement) {
      bottoms.set(id, element);
      observe(element);
      measure();
      return () => {
        if (bottoms.get(id) !== element) return;
        bottoms.delete(id);
        observer?.unobserve(element);
        measure();
      };
    },
    registerContentSurface(element: HTMLElement) {
      contents.add(element);
      observe(element);
      measure();
      return () => {
        contents.delete(element);
        observer?.unobserve(element);
        element.style.removeProperty("--mobile-content-bottom-clearance");
        measure();
      };
    },
    reportMobileOverlayKeyboardInset(px: number) {
      const report = { px: Math.ceil(px) };
      keyboard.push(report);
      measure();
      return () => {
        const index = keyboard.indexOf(report);
        if (index === -1) return;
        keyboard.splice(index, 1);
        measure();
      };
    },
    subscribeContentBottomClearance(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listen() {
      const visual = window.visualViewport;
      window.addEventListener("resize", schedule);
      visual?.addEventListener("resize", schedule);
      visual?.addEventListener("scroll", schedule);
      return () => {
        cancelAnimationFrame(frame);
        frame = 0;
        window.removeEventListener("resize", schedule);
        visual?.removeEventListener("resize", schedule);
        visual?.removeEventListener("scroll", schedule);
      };
    },
  };
}

const MobileViewportContext = createContext<MobileViewport | null>(null);

export function MobileViewportProvider({ children }: { children: ReactNode }) {
  const [viewport] = useState(createMobileViewport);
  const feedback = usePersistentFeedbackElement();
  useEffect(() => viewport.listen(), [viewport]);
  useLayoutEffect(
    () => (feedback ? viewport.registerBottomSurface("Feedback", feedback) : undefined),
    [viewport, feedback],
  );
  return <MobileViewportContext value={viewport}>{children}</MobileViewportContext>;
}

export function useMobileViewport(): MobileViewport {
  const viewport = useContext(MobileViewportContext);
  if (!viewport) throw new Error("useMobileViewport requires MobileViewportProvider");
  return viewport;
}

/** A text field outside every modal layer has focus: the root owns the soft keyboard. */
export function useRootTextEntryFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const read = () => {
      const target = document.activeElement;
      setFocused(isTextEntryTarget(target) && target?.closest("[data-modal-backdrop='true']") === null);
    };
    const later = () => queueMicrotask(read);
    read();
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return focused;
}
