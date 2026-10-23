"use client";

// the shell owns placement and shown/current rectangular envelopes. stationary
// frames supply endpoint extent; animated surfaces supply computed visibility.
// one ordered pass places controls/nexus, writes pane and reader geometry, then
// notifies consumers. tap visibility changes occlusion, never endpoint extent.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { isTextEntryTarget } from "@/lib/ui/eventTarget";

export type MobileTopSurfaceId = "Header" | "Controls";
export type MobileBottomSurfaceId = "Nexus" | "Player" | "Feedback";
type GeometryChange = "Occlusion" | "Layout";

export interface MobileViewport {
  registerTopSurface(id: MobileTopSurfaceId, frame: HTMLElement, chromeSurface: HTMLElement | null): () => void;
  registerBottomSurface(id: MobileBottomSurfaceId, frame: HTMLElement, chromeSurface: HTMLElement | null): () => void;
  registerContentSurface(element: HTMLElement): () => void;
  registerReaderScrollport(element: HTMLElement, geometryChanged: (reason: GeometryChange) => void): () => void;
  refreshGeometry(): void;
  /** The newest report wins; releasing it restores the one before. */
  reportMobileOverlayKeyboardInset(px: number): () => void;
  /** Called after every pass, with current visible obstruction published. */
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

type Surface = { frame: HTMLElement; chromeSurface: HTMLElement | null };
type ReaderGeometry = {
  width: number;
  height: number;
  insetTop: number;
  insetBottom: number;
  occlusionTop: number;
  occlusionBottom: number;
};
const READER_PROPERTIES = [
  "--reader-content-inset-top",
  "--reader-content-inset-bottom",
  "--reader-occlusion-top",
  "--reader-occlusion-bottom",
];

/** frames are untransformed; zero-sized/suppressed surfaces cover nothing. */
function surfaceBox(surface: Surface | undefined): DOMRect | null {
  const box = surface?.frame.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 ? box : null;
}

/** hidden targets still obstruct during fade-out, until css visibility changes. */
function surfaceVisible(surface: Surface): boolean {
  const style = getComputedStyle(surface.chromeSurface ?? surface.frame);
  return style.display !== "none" && style.visibility === "visible";
}

/** conservative full-width envelopes, projected into the actual local canvas. */
function envelope(boxes: DOMRect[], port: DOMRect, edge: "Top" | "Bottom"): number {
  let extent = 0;
  for (const box of boxes) {
    if (box.right <= port.left || box.left >= port.right || box.bottom <= port.top || box.top >= port.bottom) continue;
    extent = Math.max(extent, edge === "Top" ? box.bottom - port.top : port.bottom - box.top);
  }
  return Math.ceil(Math.min(port.height, extent));
}

function createMobileViewport() {
  const surfaces = new Map<MobileTopSurfaceId | MobileBottomSurfaceId, Surface>();
  const contents = new Set<HTMLElement>();
  const readers = new Map<HTMLElement, {
    geometryChanged: (reason: GeometryChange) => void;
    geometry: ReaderGeometry | null;
  }>();
  const keyboard: { px: number }[] = [];
  const listeners = new Set<() => void>();
  let frame = 0;
  let observer: ResizeObserver | null = null; // created on first use: never on the server
  // padding written into a content surface must not read back as a resize.
  const observe = (element: HTMLElement) =>
    (observer ??= new ResizeObserver(schedule)).observe(element, { box: "border-box" });

  function measure() {
    const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const safe = Math.ceil(readMobileCssLength("var(--viewport-safe-bottom)"));
    const keyboardPx = keyboard.at(-1)?.px ?? 0;
    const root = document.documentElement.style;
    const feedbackBox = surfaceBox(surfaces.get("Feedback"));
    const feedbackBand = envelope(feedbackBox ? [feedbackBox] : [], viewport, "Bottom");
    // flow feedback already contains platform protection and shortens the app.
    root.setProperty("--mobile-canvas-safe-bottom", `${Math.max(0, safe - feedbackBand)}px`);
    const headerBox = surfaceBox(surfaces.get("Header"));
    root.setProperty("--mobile-header-height", `${headerBox?.height ?? 0}px`);
    const controls = surfaces.get("Controls");
    if (controls) {
      const origin = controls.frame.offsetParent?.getBoundingClientRect().top ?? 0;
      controls.frame.style.setProperty("--mobile-controls-top", `${Math.max(0, (headerBox?.bottom ?? origin) - origin)}px`);
    }
    const playerBox = surfaceBox(surfaces.get("Player"));
    const nexusOffset = Math.max(safe, envelope([playerBox, feedbackBox].filter(box => box !== null), viewport, "Bottom"));
    root.setProperty("--mobile-nexus-bottom-offset", `${nexusOffset}px`);
    root.setProperty("--mobile-overlay-keyboard-inset", `${keyboardPx}px`);

    // placement writes above precede these reads, including nexus and controls.
    const shownTop: DOMRect[] = [];
    const visibleTop: DOMRect[] = [];
    const shownBottom: DOMRect[] = [];
    const visibleBottom: DOMRect[] = [];
    for (const [id, surface] of surfaces) {
      const box = surfaceBox(surface);
      if (!box) continue;
      const top = id === "Header" || id === "Controls";
      (top ? shownTop : shownBottom).push(box);
      if (surfaceVisible(surface)) (top ? visibleTop : visibleBottom).push(box);
    }
    const platformBand = new DOMRect(0, viewport.height - Math.max(safe, keyboardPx), viewport.width, Math.max(safe, keyboardPx));
    shownBottom.push(platformBand);
    visibleBottom.push(platformBand);
    root.setProperty("--mobile-content-bottom-clearance", `${envelope(visibleBottom, viewport, "Bottom")}px`);
    for (const element of contents) {
      const box = element.getBoundingClientRect();
      element.style.setProperty("--mobile-pane-content-offset", `${envelope(shownTop, box, "Top")}px`);
      element.style.setProperty("--mobile-content-bottom-clearance", `${envelope(visibleBottom, box, "Bottom")}px`);
    }

    const changed: { notify: (reason: GeometryChange) => void; reason: GeometryChange }[] = [];
    for (const [element, reader] of readers) {
      const box = element.getBoundingClientRect();
      const before = reader.geometry;
      if (!element.closest('[data-reader-composition="true"]') || box.width <= 0 || box.height <= 0) {
        for (const property of READER_PROPERTIES) element.style.removeProperty(property);
        reader.geometry = null;
        if (before) changed.push({ notify: reader.geometryChanged, reason: "Layout" });
        continue;
      }
      const next = {
        width: box.width,
        height: box.height,
        insetTop: envelope(shownTop, box, "Top"),
        insetBottom: envelope(shownBottom, box, "Bottom"),
        occlusionTop: envelope(visibleTop, box, "Top"),
        occlusionBottom: envelope(visibleBottom, box, "Bottom"),
      };
      element.style.setProperty("--reader-content-inset-top", `${next.insetTop}px`);
      element.style.setProperty("--reader-content-inset-bottom", `${next.insetBottom}px`);
      element.style.setProperty("--reader-occlusion-top", `${next.occlusionTop}px`);
      element.style.setProperty("--reader-occlusion-bottom", `${next.occlusionBottom}px`);
      reader.geometry = next;
      const layout = !before || before.width !== next.width || before.height !== next.height
        || before.insetTop !== next.insetTop || before.insetBottom !== next.insetBottom;
      if (layout || before.occlusionTop !== next.occlusionTop || before.occlusionBottom !== next.occlusionBottom) {
        changed.push({ notify: reader.geometryChanged, reason: layout ? "Layout" : "Occlusion" });
      }
    }
    for (const { notify, reason } of changed) notify(reason);
    for (const listener of listeners) listener();
  }

  function schedule() {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  }

  function refreshGeometry() {
    cancelAnimationFrame(frame);
    frame = 0;
    measure();
  }

  function registerSurface(id: MobileTopSurfaceId | MobileBottomSurfaceId, element: HTMLElement, chromeSurface: HTMLElement | null) {
    const surface = { frame: element, chromeSurface };
    surfaces.set(id, surface);
    observe(element);
    const transition = (event: TransitionEvent) => {
      if (event.target === chromeSurface) schedule();
    };
    chromeSurface?.addEventListener("transitionend", transition);
    chromeSurface?.addEventListener("transitioncancel", transition);
    refreshGeometry();
    return () => {
      observer?.unobserve(element);
      chromeSurface?.removeEventListener("transitionend", transition);
      chromeSurface?.removeEventListener("transitioncancel", transition);
      if (surfaces.get(id) !== surface) return;
      surfaces.delete(id);
      if (id === "Controls") element.style.removeProperty("--mobile-controls-top");
      refreshGeometry();
    };
  }

  return {
    registerTopSurface: registerSurface,
    registerBottomSurface: registerSurface,
    refreshGeometry,
    registerContentSurface(element: HTMLElement) {
      contents.add(element);
      observe(element);
      refreshGeometry();
      return () => {
        contents.delete(element);
        observer?.unobserve(element);
        element.style.removeProperty("--mobile-pane-content-offset");
        element.style.removeProperty("--mobile-content-bottom-clearance");
        refreshGeometry();
      };
    },
    registerReaderScrollport(element: HTMLElement, geometryChanged: (reason: GeometryChange) => void) {
      readers.set(element, { geometryChanged, geometry: null });
      observe(element);
      refreshGeometry();
      return () => {
        readers.delete(element);
        observer?.unobserve(element);
        for (const property of READER_PROPERTIES) element.style.removeProperty(property);
        refreshGeometry();
      };
    },
    reportMobileOverlayKeyboardInset(px: number) {
      const report = { px: Math.ceil(px) };
      keyboard.push(report);
      refreshGeometry();
      return () => {
        const index = keyboard.indexOf(report);
        if (index === -1) return;
        keyboard.splice(index, 1);
        refreshGeometry();
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
      // env() can change without resizing the window, including with no player.
      const insets = document.createElement("div");
      insets.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;width:var(--viewport-safe-top);height:var(--viewport-safe-bottom)";
      document.body.append(insets);
      observe(insets);
      window.addEventListener("resize", schedule);
      visual?.addEventListener("resize", schedule);
      visual?.addEventListener("scroll", schedule);
      return () => {
        observer?.unobserve(insets);
        insets.remove();
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
  useEffect(() => viewport.listen(), [viewport]);
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
