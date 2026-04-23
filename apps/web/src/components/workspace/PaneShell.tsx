"use client";

import { Search } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import SurfaceHeader, { type SurfaceHeaderOption } from "@/components/ui/SurfaceHeader";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import styles from "./PaneShell.module.css";

export type PaneBodyMode = "standard" | "document";

// ---------------------------------------------------------------------------
// Chrome override — lets body components push toolbar/options/meta into the
// PaneShell chrome without routing through the workspace store.
// ---------------------------------------------------------------------------

interface PaneChromeOverrides {
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: SurfaceHeaderOption[];
  meta?: React.ReactNode;
}

const EMPTY_PANE_CHROME_OVERRIDES: PaneChromeOverrides = {};

const PaneChromeOverrideContext = createContext<
  ((overrides: PaneChromeOverrides) => void) | null
>(null);

const PaneChromeScrollContext = createContext<((scrollTop: number) => void) | null>(null);
const PaneChromeVisibilityContext = createContext<{
  setMobileChromeLockedVisible: (locked: boolean) => void;
  showMobileChrome: () => void;
} | null>(null);

/**
 * Call from a body component rendered inside PaneShell to push toolbar,
 * options, meta, or actions into the pane chrome. Uses useLayoutEffect so the
 * chrome is ready before the browser paints.
 */
export function usePaneChromeOverride(overrides: PaneChromeOverrides): void {
  const setOverrides = useContext(PaneChromeOverrideContext);
  useLayoutEffect(() => {
    if (!setOverrides) {
      return;
    }
    setOverrides(overrides);
    return () => {
      setOverrides(EMPTY_PANE_CHROME_OVERRIDES);
    };
  }, [overrides, setOverrides]);
}

export function usePaneChromeScrollHandler(): ((scrollTop: number) => void) | null {
  return useContext(PaneChromeScrollContext);
}

export function usePaneMobileChromeVisibility():
  | {
      setMobileChromeLockedVisible: (locked: boolean) => void;
      showMobileChrome: () => void;
    }
  | null {
  return useContext(PaneChromeVisibilityContext);
}

type PaneShellStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

interface PaneShellProps {
  paneId: string;
  title: string;
  subtitle?: React.ReactNode;
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: SurfaceHeaderOption[];
  onBack?: () => void;
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  bodyMode: PaneBodyMode;
  onResizePane: (paneId: string, widthPx: number) => void;
  isActive?: boolean;
  isMobile?: boolean;
  children: React.ReactNode;
}

export default function PaneShell({
  paneId,
  title,
  subtitle,
  toolbar,
  actions,
  options,
  onBack,
  widthPx,
  minWidthPx,
  maxWidthPx,
  bodyMode,
  onResizePane,
  isActive = false,
  isMobile = false,
  children,
}: PaneShellProps) {
  const { handleResizeMouseDown, handleResizeKeyDown } = useResizeHandle({
    paneId,
    widthPx,
    minWidthPx,
    maxWidthPx,
    onResizePane,
  });
  const chromeRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const mobileChromeScrollDirectionRef = useRef<"down" | "up" | null>(null);
  const mobileChromeDirectionStartRef = useRef(0);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const [mobileChromeLockedVisible, setMobileChromeLockedVisible] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [chromeOverrides, setChromeOverrides] = useState<PaneChromeOverrides>(
    EMPTY_PANE_CHROME_OVERRIDES
  );

  const isMobileDocumentPane = isMobile && bodyMode === "document";
  const effectiveToolbar = chromeOverrides.toolbar ?? toolbar;
  const effectiveActions = chromeOverrides.actions ?? actions;
  const effectiveOptions = chromeOverrides.options ?? options;
  const effectiveMobileChromeHidden =
    isMobileDocumentPane &&
    mobileChromeHidden &&
    !mobileChromeLockedVisible &&
    !prefersReducedMotion;

  // Reset mobile chrome state when leaving mobile document mode.
  useEffect(() => {
    if (!isMobileDocumentPane) {
      setMobileChromeHidden(false);
      setMobileChromeLockedVisible(false);
      lastScrollTopRef.current = 0;
      mobileChromeScrollDirectionRef.current = null;
      mobileChromeDirectionStartRef.current = 0;
    }
  }, [isMobileDocumentPane]);

  // Pin reduced-motion mobile document panes visible at the shell level.
  useEffect(() => {
    if (!isMobileDocumentPane) {
      setPrefersReducedMotion(false);
      return;
    }
    if (typeof window.matchMedia !== "function") {
      setPrefersReducedMotion(false);
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(mediaQuery.matches);
      if (mediaQuery.matches) {
        setMobileChromeHidden(false);
        mobileChromeScrollDirectionRef.current = null;
        mobileChromeDirectionStartRef.current = 0;
      }
    };
    update();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => {
        mediaQuery.removeEventListener("change", update);
      };
    }
    mediaQuery.addListener(update);
    return () => {
      mediaQuery.removeListener(update);
    };
  }, [isMobileDocumentPane]);

  // Track the chrome height for the stable document top reservation.
  useLayoutEffect(() => {
    if (!isMobile || !chromeRef.current) {
      setMobileChromeHeight(0);
      return;
    }
    const node = chromeRef.current;
    const update = () => {
      setMobileChromeHeight(Math.max(0, Math.round(node.getBoundingClientRect().height)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobile]);

  // Hide after deliberate downward scroll past the reserved top space; reveal
  // on upward scroll or when the reader returns near the top.
  const handleDocumentScroll = useCallback(
    (scrollTop: number) => {
      if (!isMobileDocumentPane || prefersReducedMotion) {
        return;
      }
      const previous = lastScrollTopRef.current;
      const delta = scrollTop - previous;
      lastScrollTopRef.current = scrollTop;

      if (scrollTop <= mobileChromeHeight) {
        setMobileChromeHidden(false);
        mobileChromeScrollDirectionRef.current = null;
        mobileChromeDirectionStartRef.current = scrollTop;
        return;
      }

      if (Math.abs(delta) < 1) {
        return;
      }

      const direction = delta > 0 ? "down" : "up";
      if (mobileChromeScrollDirectionRef.current !== direction) {
        mobileChromeScrollDirectionRef.current = direction;
        mobileChromeDirectionStartRef.current = scrollTop;
        return;
      }

      const directionDistance = Math.abs(scrollTop - mobileChromeDirectionStartRef.current);

      if (direction === "down" && directionDistance >= 24) {
        setMobileChromeHidden(true);
        return;
      }

      if (direction === "up" && directionDistance >= 16) {
        setMobileChromeHidden(false);
      }
    },
    [isMobileDocumentPane, mobileChromeHeight, prefersReducedMotion]
  );
  const showMobileChrome = useCallback(() => {
    setMobileChromeHidden(false);
    mobileChromeScrollDirectionRef.current = null;
    mobileChromeDirectionStartRef.current = lastScrollTopRef.current;
  }, []);
  const paneChromeVisibility = useMemo(
    () => ({ setMobileChromeLockedVisible, showMobileChrome }),
    [showMobileChrome]
  );

  const shellClass = effectiveMobileChromeHidden
    ? `${styles.paneShell} ${styles.mobileChromeHidden}`
    : styles.paneShell;

  const shellStyle: PaneShellStyle = isMobile
    ? { width: "100%", minWidth: "100%", maxWidth: "100%" }
    : { width: `${widthPx}px`, minWidth: `${minWidthPx}px`, maxWidth: `${maxWidthPx}px` };
  if (isMobile && mobileChromeHeight > 0) {
    shellStyle["--mobile-pane-chrome-height"] = `${mobileChromeHeight}px`;
  }

  const bodyStyle: CSSProperties =
    bodyMode === "document"
      ? {
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
          ...(isMobile && { overscrollBehavior: "contain" }),
        }
      : {
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          ...(isMobile && { overscrollBehavior: "contain" }),
        };

  return (
    <section
      className={shellClass}
      data-testid="pane-shell-root"
      data-pane-shell="true"
      data-active={isActive ? "true" : "false"}
      data-mobile-chrome-hidden={
        effectiveMobileChromeHidden ? "true" : "false"
      }
      data-mobile={isMobile ? "true" : "false"}
      style={shellStyle}
    >
      <div
        ref={chromeRef}
        className={styles.chrome}
        data-testid="pane-shell-chrome"
        data-pane-chrome-focus="true"
        tabIndex={-1}
      >
        <SurfaceHeader
          title={title}
          subtitle={subtitle}
          meta={chromeOverrides.meta}
          options={effectiveOptions}
          actions={
            isMobile ? (
              <>
                {effectiveActions}
                <button
                  type="button"
                  className={styles.mobileSearchButton}
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent(OPEN_COMMAND_PALETTE_EVENT)
                    )
                  }
                  aria-label="Search"
                  aria-haspopup="dialog"
                >
                  <Search size={16} aria-hidden="true" />
                </button>
              </>
            ) : (
              effectiveActions
            )
          }
          onBack={onBack}
        />
        {effectiveToolbar ? <div className={styles.toolbar}>{effectiveToolbar}</div> : null}
      </div>
      <div
        className={styles.body}
        data-testid="pane-shell-body"
        data-body-mode={bodyMode}
        data-pane-content="true"
        style={bodyStyle}
      >
        <PaneChromeOverrideContext.Provider value={setChromeOverrides}>
          <PaneChromeVisibilityContext.Provider value={paneChromeVisibility}>
            <PaneChromeScrollContext.Provider value={handleDocumentScroll}>
              {children}
            </PaneChromeScrollContext.Provider>
          </PaneChromeVisibilityContext.Provider>
        </PaneChromeOverrideContext.Provider>
      </div>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label={`Resize pane ${title}`}
        aria-orientation="vertical"
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
      />
    </section>
  );
}
