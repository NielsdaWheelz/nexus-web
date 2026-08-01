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
  resolveMobileViewportProjection,
  type MobileFixedObstructionId,
  type MobileFixedObstructionRect,
} from "@/lib/mobileViewport/model";
import { isTextEntryTarget } from "@/lib/ui/isTextEntryTarget";

export type { MobileFixedObstructionId } from "@/lib/mobileViewport/model";

export interface MobileViewportCapability {
  registerFixedObstruction(
    id: MobileFixedObstructionId,
    element: HTMLElement,
  ): () => void;
  reportMobileOverlayKeyboardInset(px: number): () => void;
  subscribeContentBottomClearance(listener: () => void): () => void;
}

interface FixedRegistration {
  element: HTMLElement;
  observer: ResizeObserver;
}

interface FixedMeasurements {
  viewportHeightPx: number;
  rects: ReadonlyMap<MobileFixedObstructionId, MobileFixedObstructionRect>;
}

interface MobileOverlayKeyboardReport {
  id: number;
  insetPx: number;
}

const MobileViewportContext =
  createContext<MobileViewportCapability | null>(null);
const RootTextEntryFocusContext = createContext<boolean | null>(null);

function measurementsEqual(
  left: FixedMeasurements,
  right: FixedMeasurements,
): boolean {
  if (
    left.viewportHeightPx !== right.viewportHeightPx ||
    left.rects.size !== right.rects.size
  ) {
    return false;
  }
  for (const [id, rect] of left.rects) {
    const other = right.rects.get(id);
    if (
      !other ||
      rect.top !== other.top ||
      rect.bottom !== other.bottom ||
      rect.width !== other.width ||
      rect.height !== other.height
    ) {
      return false;
    }
  }
  return true;
}

export function MobileViewportProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const registrationsRef = useRef(
    new Map<MobileFixedObstructionId, FixedRegistration>(),
  );
  const [fixedMeasurements, setFixedMeasurements] =
    useState<FixedMeasurements>({
      viewportHeightPx: 0,
      rects: new Map(),
    });
  const [mobileOverlayKeyboardInsetPx, setMobileOverlayKeyboardInsetPx] =
    useState(0);
  const [rootTextEntryFocused, setRootTextEntryFocused] = useState(false);
  const mobileOverlayKeyboardReportsRef = useRef<
    MobileOverlayKeyboardReport[]
  >([]);
  const contentBottomClearanceListenersRef = useRef(new Set<() => void>());
  const nextMobileOverlayKeyboardReportIdRef = useRef(0);

  const measureFixedObstructions = useCallback(() => {
    const rects = new Map<
      MobileFixedObstructionId,
      MobileFixedObstructionRect
    >();
    for (const [id, registration] of registrationsRef.current) {
      const rect = registration.element.getBoundingClientRect();
      rects.set(id, {
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    }
    const next = {
      viewportHeightPx: window.innerHeight,
      rects,
    };
    setFixedMeasurements((current) =>
      measurementsEqual(current, next) ? current : next,
    );
  }, []);

  const registerFixedObstruction = useCallback(
    (id: MobileFixedObstructionId, element: HTMLElement) => {
      if (registrationsRef.current.has(id)) {
        // justify-defect: each closed obstruction identity has one active shell
        // projection.
        throw new Error(`Duplicate active mobile fixed obstruction: ${id}`);
      }
      const observer = new ResizeObserver(measureFixedObstructions);
      registrationsRef.current.set(id, { element, observer });
      observer.observe(element);
      measureFixedObstructions();
      return () => {
        const registration = registrationsRef.current.get(id);
        if (registration?.element !== element) {
          return;
        }
        registration.observer.disconnect();
        registrationsRef.current.delete(id);
        measureFixedObstructions();
      };
    },
    [measureFixedObstructions],
  );

  const reportMobileOverlayKeyboardInset = useCallback((px: number) => {
    if (!Number.isFinite(px) || px < 0) {
      // justify-defect: mobile modal lifecycle reports the owned keyboard
      // geometry hook's nonnegative finite result.
      throw new Error(
        "Mobile overlay keyboard inset must be nonnegative and finite",
      );
    }
    const report = {
      id: nextMobileOverlayKeyboardReportIdRef.current++,
      insetPx: Math.ceil(px),
    };
    mobileOverlayKeyboardReportsRef.current.push(report);
    setMobileOverlayKeyboardInsetPx(report.insetPx);
    return () => {
      const reports = mobileOverlayKeyboardReportsRef.current;
      const index = reports.findIndex((candidate) => candidate.id === report.id);
      if (index === -1) {
        return;
      }
      const ownedPublishedInset = index === reports.length - 1;
      reports.splice(index, 1);
      if (ownedPublishedInset) {
        setMobileOverlayKeyboardInsetPx(
          reports[reports.length - 1]?.insetPx ?? 0,
        );
      }
    };
  }, []);

  const subscribeContentBottomClearance = useCallback(
    (listener: () => void) => {
      contentBottomClearanceListenersRef.current.add(listener);
      return () => {
        contentBottomClearanceListenersRef.current.delete(listener);
      };
    },
    [],
  );

  const capability = useMemo<MobileViewportCapability>(
    () => ({
      registerFixedObstruction,
      reportMobileOverlayKeyboardInset,
      subscribeContentBottomClearance,
    }),
    [
      registerFixedObstruction,
      reportMobileOverlayKeyboardInset,
      subscribeContentBottomClearance,
    ],
  );
  // `fixedMeasurements` is identity-stable across renders (the setter returns the
  // current object when measurements are equal), so memoizing keeps `projection`
  // referentially stable until an input actually changes — the CSS-var
  // useLayoutEffect below then only runs on real change, not every render.
  const projection = useMemo(
    () =>
      resolveMobileViewportProjection({
        viewportHeightPx: fixedMeasurements.viewportHeightPx,
        fixedObstructions: fixedMeasurements.rects,
        mobileOverlayKeyboardInsetPx,
      }),
    [fixedMeasurements, mobileOverlayKeyboardInsetPx],
  );

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--mobile-content-bottom-clearance",
      `max(var(--viewport-safe-bottom), ${projection.contentBottomClearancePx}px)`,
    );
    root.style.setProperty(
      "--mobile-nexus-bottom-offset",
      `max(var(--viewport-safe-bottom), ${projection.playerBottomClearancePx}px)`,
    );
    root.style.setProperty(
      "--mobile-overlay-keyboard-inset",
      `${projection.overlayKeyboardInsetPx}px`,
    );
    for (const listener of contentBottomClearanceListenersRef.current) {
      listener();
    }
  }, [projection]);

  useLayoutEffect(() => {
    if (!registrationsRef.current.has("Nexus")) {
      return;
    }
    const frame = requestAnimationFrame(measureFixedObstructions);
    return () => cancelAnimationFrame(frame);
  }, [measureFixedObstructions, projection.playerBottomClearancePx]);

  useEffect(() => {
    window.addEventListener("resize", measureFixedObstructions);
    return () => {
      window.removeEventListener("resize", measureFixedObstructions);
    };
  }, [measureFixedObstructions]);

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
      for (const registration of registrationsRef.current.values()) {
        registration.observer.disconnect();
      }
      registrationsRef.current.clear();
      mobileOverlayKeyboardReportsRef.current = [];
      contentBottomClearanceListenersRef.current.clear();
      const root = document.documentElement;
      root.style.removeProperty("--mobile-content-bottom-clearance");
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
