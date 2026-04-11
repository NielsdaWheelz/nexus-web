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
import { Search } from "lucide-react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/CommandPalette";
import SurfaceHeader, { type SurfaceHeaderOption } from "@/components/ui/SurfaceHeader";
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
    setOverrides?.(overrides);
  });
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
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const [chromeOverrides, setChromeOverrides] = useState<PaneChromeOverrides>({});

  const effectiveToolbar = chromeOverrides.toolbar ?? toolbar;
  const effectiveActions = chromeOverrides.actions ?? actions;
  const effectiveOptions = chromeOverrides.options ?? options;

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    []
  );

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

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = widthPx;
      const doc = event.currentTarget.ownerDocument;
      const cleanup = () => {
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        doc.removeEventListener("mousemove", handleMouseMove);
        doc.removeEventListener("mouseup", handleMouseUp);
        resizeCleanupRef.current = null;
      };
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = Math.min(maxWidthPx, Math.max(minWidthPx, startWidth + delta));
        onResizePane(paneId, nextWidth);
      };
      const handleMouseUp = () => {
        cleanup();
      };

      doc.body.style.cursor = "col-resize";
      doc.body.style.userSelect = "none";
      doc.addEventListener("mousemove", handleMouseMove);
      doc.addEventListener("mouseup", handleMouseUp);
      resizeCleanupRef.current = cleanup;
    },
    [maxWidthPx, minWidthPx, onResizePane, paneId, widthPx]
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onResizePane(paneId, Math.max(minWidthPx, widthPx - 16));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onResizePane(paneId, Math.min(maxWidthPx, widthPx + 16));
      } else if (event.key === "Home") {
        event.preventDefault();
        onResizePane(paneId, minWidthPx);
      } else if (event.key === "End") {
        event.preventDefault();
        onResizePane(paneId, maxWidthPx);
      }
    },
    [maxWidthPx, minWidthPx, onResizePane, paneId, widthPx]
  );

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
                >
                  <Search size={18} strokeWidth={2} />
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
