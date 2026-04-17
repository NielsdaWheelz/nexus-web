"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/CommandPalette";
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
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [chromeOverrides, setChromeOverrides] = useState<PaneChromeOverrides>(
    EMPTY_PANE_CHROME_OVERRIDES
  );

  const effectiveToolbar = chromeOverrides.toolbar ?? toolbar;
  const effectiveActions = chromeOverrides.actions ?? actions;
  const effectiveOptions = chromeOverrides.options ?? options;

  // Reset mobile chrome state when leaving mobile.
  useEffect(() => {
    if (!isMobile) {
      setMobileChromeHidden(false);
      lastScrollTopRef.current = 0;
    }
  }, [isMobile]);

  // Track chrome height for padding offset.
  useEffect(() => {
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
  }, [isMobile, title, subtitle, effectiveToolbar]);

  // Hide chrome on scroll-down, restore on scroll-up.
  const handleBodyScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!isMobile) {
        return;
      }
      const scrollTop = event.currentTarget.scrollTop;
      const previous = lastScrollTopRef.current;
      const delta = scrollTop - previous;
      lastScrollTopRef.current = scrollTop;

      if (scrollTop <= 24) {
        setMobileChromeHidden(false);
        return;
      }
      if (delta >= 10) {
        setMobileChromeHidden(true);
        return;
      }
      if (delta <= -10) {
        setMobileChromeHidden(false);
      }
    },
    [isMobile]
  );

  const shellClass = `${styles.paneShell} ${
    isMobile
      ? mobileChromeHidden
        ? styles.mobileChromeHidden
        : styles.mobileChromeVisible
      : ""
  }`.trim();

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
      data-pane-shell="true"
      data-active={isActive ? "true" : "false"}
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
                  className={styles.commandPaletteButton}
                  onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
                  aria-label="Commands"
                  aria-haspopup="dialog"
                >
                  Commands
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
        onScroll={handleBodyScroll}
      >
        <PaneChromeOverrideContext.Provider value={setChromeOverrides}>
          {children}
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
