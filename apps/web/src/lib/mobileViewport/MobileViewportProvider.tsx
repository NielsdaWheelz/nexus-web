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
} from "react";
import {
  resolveContentBottomClearancePx,
  resolveContentSurfaceBottomClearancePx,
  resolveNexusBottomOffsetPx,
  type MobileBottomSurfaceId,
  type MobileBottomSurfaceRect,
} from "@/lib/mobileViewport/model";
import { readMobileCssLength } from "@/lib/mobileViewport/readMobileCssLength";
import { isTextEntryTarget } from "@/lib/ui/isTextEntryTarget";

export type { MobileBottomSurfaceId } from "@/lib/mobileViewport/model";

export interface MobileViewportCapability {
  registerBottomSurface(
    id: MobileBottomSurfaceId,
    element: HTMLElement,
  ): () => void;
  registerContentSurface(element: HTMLElement): () => void;
  reportMobileOverlayKeyboardInset(px: number): () => void;
  subscribeContentBottomClearance(listener: () => void): () => void;
}

interface BottomSurfaceRegistration {
  element: HTMLElement;
  observer: ResizeObserver;
}

interface MobileOverlayKeyboardReport {
  id: number;
  insetPx: number;
}

const MobileViewportContext = createContext<MobileViewportCapability | null>(
  null,
);
const RootTextEntryFocusContext = createContext<boolean | null>(null);

const CONTENT_BOTTOM_CLEARANCE = "--mobile-content-bottom-clearance";

function measureBottomSurface(
  registration: BottomSurfaceRegistration | undefined,
): MobileBottomSurfaceRect | null {
  if (!registration) return null;
  const rect = registration.element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function MobileViewportProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const bottomSurfacesRef = useRef(
    new Map<MobileBottomSurfaceId, BottomSurfaceRegistration>(),
  );
  const contentSurfacesRef = useRef(new Map<HTMLElement, ResizeObserver>());
  const keyboardReportsRef = useRef<MobileOverlayKeyboardReport[]>([]);
  const keyboardInsetPxRef = useRef(0);
  const nextKeyboardReportIdRef = useRef(0);
  const clearanceListenersRef = useRef(new Set<() => void>());
  const frameRef = useRef<number | null>(null);
  const [rootTextEntryFocused, setRootTextEntryFocused] = useState(false);

  // One ordered pass: the flow Player places Nexus, the placed Nexus sets the
  // protected full-window band, and that band projects into every registered
  // content surface. Reading each rectangle after the write it depends on lets
  // the pass converge without a second frame.
  const measure = useCallback(() => {
    const root = document.documentElement;
    const viewportHeightPx = window.innerHeight;
    const safeBottomPx = readMobileCssLength("var(--viewport-safe-bottom)");
    const overlayKeyboardInsetPx = keyboardInsetPxRef.current;

    const nexusBottomOffsetPx = resolveNexusBottomOffsetPx({
      viewportHeightPx,
      safeBottomPx,
      playerRect: measureBottomSurface(bottomSurfacesRef.current.get("Player")),
    });
    root.style.setProperty(
      "--mobile-nexus-bottom-offset",
      `${nexusBottomOffsetPx}px`,
    );

    const contentBottomClearancePx = resolveContentBottomClearancePx({
      viewportHeightPx,
      safeBottomPx,
      nexusRect: measureBottomSurface(bottomSurfacesRef.current.get("Nexus")),
      overlayKeyboardInsetPx,
    });
    root.style.setProperty(
      CONTENT_BOTTOM_CLEARANCE,
      `${contentBottomClearancePx}px`,
    );
    root.style.setProperty(
      "--mobile-overlay-keyboard-inset",
      `${overlayKeyboardInsetPx}px`,
    );

    for (const element of contentSurfacesRef.current.keys()) {
      element.style.setProperty(
        CONTENT_BOTTOM_CLEARANCE,
        `${resolveContentSurfaceBottomClearancePx({
          viewportHeightPx,
          contentBottomClearancePx,
          surfaceBottomPx: element.getBoundingClientRect().bottom,
        })}px`,
      );
    }

    for (const listener of clearanceListenersRef.current) listener();
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  const registerBottomSurface = useCallback(
    (id: MobileBottomSurfaceId, element: HTMLElement) => {
      const surfaces = bottomSurfacesRef.current;
      if (surfaces.has(id)) {
        // justify-defect: each bottom-surface identity has one active shell
        // projection.
        throw new Error(`Duplicate active mobile bottom surface: ${id}`);
      }
      const observer = new ResizeObserver(scheduleMeasure);
      surfaces.set(id, { element, observer });
      observer.observe(element, { box: "border-box" });
      measure();
      return () => {
        const registration = surfaces.get(id);
        if (registration?.element !== element) return;
        registration.observer.disconnect();
        surfaces.delete(id);
        measure();
      };
    },
    [measure, scheduleMeasure],
  );

  const registerContentSurface = useCallback(
    (element: HTMLElement) => {
      const surfaces = contentSurfacesRef.current;
      if (surfaces.has(element)) {
        // justify-defect: each mobile content surface has one registration
        // owned by its layout owner.
        throw new Error("Duplicate active mobile content surface");
      }
      // Border-box: the terminal padding this pass writes into the surface must
      // not read back as a resize and schedule a pass that changes nothing.
      const observer = new ResizeObserver(scheduleMeasure);
      surfaces.set(element, observer);
      observer.observe(element, { box: "border-box" });
      measure();
      return () => {
        if (!surfaces.delete(element)) return;
        observer.disconnect();
        element.style.removeProperty(CONTENT_BOTTOM_CLEARANCE);
        measure();
      };
    },
    [measure, scheduleMeasure],
  );

  const reportMobileOverlayKeyboardInset = useCallback(
    (px: number) => {
      if (!Number.isFinite(px) || px < 0) {
        // justify-defect: mobile modal lifecycle reports the owned keyboard
        // geometry hook's nonnegative finite result.
        throw new Error(
          "Mobile overlay keyboard inset must be nonnegative and finite",
        );
      }
      const report = {
        id: nextKeyboardReportIdRef.current++,
        insetPx: Math.ceil(px),
      };
      const reports = keyboardReportsRef.current;
      reports.push(report);
      keyboardInsetPxRef.current = report.insetPx;
      measure();
      return () => {
        const index = reports.findIndex(
          (candidate) => candidate.id === report.id,
        );
        if (index === -1) return;
        const ownedPublishedInset = index === reports.length - 1;
        reports.splice(index, 1);
        if (!ownedPublishedInset) return;
        keyboardInsetPxRef.current = reports[reports.length - 1]?.insetPx ?? 0;
        measure();
      };
    },
    [measure],
  );

  const subscribeContentBottomClearance = useCallback((listener: () => void) => {
    clearanceListenersRef.current.add(listener);
    return () => {
      clearanceListenersRef.current.delete(listener);
    };
  }, []);

  const capability = useMemo<MobileViewportCapability>(
    () => ({
      registerBottomSurface,
      registerContentSurface,
      reportMobileOverlayKeyboardInset,
      subscribeContentBottomClearance,
    }),
    [
      registerBottomSurface,
      registerContentSurface,
      reportMobileOverlayKeyboardInset,
      subscribeContentBottomClearance,
    ],
  );

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", scheduleMeasure);
    visualViewport?.addEventListener("resize", scheduleMeasure);
    visualViewport?.addEventListener("scroll", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      visualViewport?.removeEventListener("resize", scheduleMeasure);
      visualViewport?.removeEventListener("scroll", scheduleMeasure);
    };
  }, [scheduleMeasure]);

  useEffect(() => {
    let mounted = true;
    const readFocus = (target: EventTarget | null) => {
      setRootTextEntryFocused(
        isTextEntryTarget(target) &&
          target instanceof Element &&
          target.closest("[data-modal-backdrop='true']") === null,
      );
    };
    const onFocusIn = (event: FocusEvent) => readFocus(event.target);
    const onFocusOut = () => {
      queueMicrotask(() => {
        if (mounted) readFocus(document.activeElement);
      });
    };

    readFocus(document.activeElement);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      mounted = false;
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      for (const registration of bottomSurfacesRef.current.values()) {
        registration.observer.disconnect();
      }
      bottomSurfacesRef.current.clear();
      for (const [element, observer] of contentSurfacesRef.current) {
        observer.disconnect();
        element.style.removeProperty(CONTENT_BOTTOM_CLEARANCE);
      }
      contentSurfacesRef.current.clear();
      keyboardReportsRef.current = [];
      keyboardInsetPxRef.current = 0;
      clearanceListenersRef.current.clear();
      const root = document.documentElement;
      root.style.removeProperty(CONTENT_BOTTOM_CLEARANCE);
      root.style.removeProperty("--mobile-nexus-bottom-offset");
      root.style.removeProperty("--mobile-overlay-keyboard-inset");
    },
    [],
  );

  return (
    <RootTextEntryFocusContext.Provider value={rootTextEntryFocused}>
      <MobileViewportContext.Provider value={capability}>
        {children}
      </MobileViewportContext.Provider>
    </RootTextEntryFocusContext.Provider>
  );
}

export function useMobileViewport(): MobileViewportCapability {
  const capability = useContext(MobileViewportContext);
  if (!capability) {
    throw new Error(
      "useMobileViewport must be used inside MobileViewportProvider",
    );
  }
  return capability;
}

/** Preserve inactive mounted overlays without weakening active ownership. */
export function useActiveMobileViewport(
  active: boolean,
): MobileViewportCapability | null {
  const capability = useContext(MobileViewportContext);
  if (active && !capability) {
    throw new Error(
      "Active mobile overlay must be used inside MobileViewportProvider",
    );
  }
  return capability;
}

export function useRootTextEntryFocused(): boolean {
  const focused = useContext(RootTextEntryFocusContext);
  if (focused === null) {
    throw new Error(
      "useRootTextEntryFocused must be used inside MobileViewportProvider",
    );
  }
  return focused;
}
