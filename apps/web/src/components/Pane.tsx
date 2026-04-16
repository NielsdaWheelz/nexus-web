"use client";

import {
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import styles from "./Pane.module.css";
import SurfaceHeader, {
  type SurfaceHeaderOption,
} from "@/components/ui/SurfaceHeader";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useMobileChromeVisibility } from "@/lib/ui/useMobileChromeVisibility";
import { SplitSurfaceOverlayContext } from "@/components/workspace/SplitSurfaceContext";

interface PaneProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: React.ReactNode;
  options?: SurfaceHeaderOption[];
  headerActions?: React.ReactNode;
  headerMeta?: React.ReactNode;
  header?: React.ReactNode;
  toolbar?: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  onClose?: () => void;
  contentClassName?: string;
  fluid?: boolean;
}

type PaneStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

export default function Pane({
  children,
  title,
  subtitle,
  options,
  headerActions,
  headerMeta,
  header,
  toolbar,
  defaultWidth = 480,
  minWidth = 280,
  maxWidth = 900,
  onClose,
  contentClassName,
  fluid = false,
}: PaneProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [mobileChromeHeight, setMobileChromeHeight] = useState(0);
  const isMobileViewport = useIsMobileViewport();
  const insideOverlay = useContext(SplitSurfaceOverlayContext);
  const paneRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const hasChrome = Boolean(header || title || toolbar) && !insideOverlay;
  const { mobileChromeHidden, onContentScroll } = useMobileChromeVisibility(
    isMobileViewport,
    hasChrome,
  );

  useEffect(() => {
    if (!isMobileViewport || !chromeRef.current || !hasChrome) {
      setMobileChromeHeight(0);
      return;
    }
    const target = chromeRef.current;
    const update = () => {
      setMobileChromeHeight(Math.max(0, Math.round(target.getBoundingClientRect().height)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasChrome, isMobileViewport, toolbar, title, header]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!paneRef.current) return;
        const paneRect = paneRef.current.getBoundingClientRect();
        const newWidth = moveEvent.clientX - paneRect.left;
        const clampedWidth = Math.min(maxWidth, Math.max(minWidth, newWidth));
        setWidth(clampedWidth);
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [minWidth, maxWidth]
  );
  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setWidth((current) => Math.max(minWidth, current - 16));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setWidth((current) => Math.min(maxWidth, current + 16));
      } else if (event.key === "Home") {
        event.preventDefault();
        setWidth(minWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        setWidth(maxWidth);
      }
    },
    [maxWidth, minWidth]
  );

  const paneClasses = `${styles.pane} ${fluid ? styles.fluid : ""} ${
    isMobileViewport
      ? mobileChromeHidden
        ? styles.mobileChromeHidden
        : styles.mobileChromeVisible
      : ""
  }`.trim();

  const paneStyle: PaneStyle = fluid ? {} : { width };
  if (isMobileViewport && mobileChromeHeight > 0) {
    paneStyle["--mobile-pane-chrome-height"] = `${mobileChromeHeight}px`;
  }

  return (
    <div
      ref={paneRef}
      className={paneClasses}
      style={Object.keys(paneStyle).length > 0 ? paneStyle : undefined}
      data-mobile-chrome-hidden={mobileChromeHidden ? "true" : "false"}
      data-testid="pane"
    >
      {hasChrome && (
        <div
          ref={chromeRef}
          className={styles.chrome}
          data-pane-chrome="true"
          data-testid="pane-chrome"
        >
          {header
            ? header
            : title && (
                <SurfaceHeader
                  title={title}
                  subtitle={subtitle}
                  options={options}
                  actions={
                    <>
                      {headerActions}
                      {onClose && (
                        <button
                          type="button"
                          className={styles.closeBtn}
                          onClick={onClose}
                          aria-label="Close pane"
                        >
                          ×
                        </button>
                      )}
                    </>
                  }
                  meta={headerMeta}
                />
              )}
          {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
        </div>
      )}
      <div
        className={`${styles.content} ${contentClassName ?? ""}`.trim()}
        data-pane-content="true"
        data-testid="pane-content"
        onScroll={onContentScroll}
      >
        {children}
      </div>
      {!fluid && (
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize pane"
          tabIndex={0}
          onMouseDown={handleMouseDown}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </div>
  );
}
