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
import Button from "@/components/ui/Button";
import { useResizeHandle } from "@/components/workspace/useResizeHandle";
import styles from "./PaneShell.module.css";

export type PaneBodyMode = "standard" | "document" | "contained";

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

function fallbackCopyText(value: string): void {
  if (typeof document === "undefined") return;
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

function copyText(value: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).catch(() => fallbackCopyText(value));
    return;
  }
  fallbackCopyText(value);
}

const PaneChromeOverrideContext = createContext<
  ((overrides: PaneChromeOverrides) => void) | null
>(null);

export type PaneMobileChromeLockReason =
  | "reader-restore"
  | "pdf-selection"
  | "text-selection"
  | "highlight-navigation"
  | "highlights-inspector"
  | "library-picker"
  | "action-menu";

export interface PaneMobileChromeController {
  onDocumentScroll: (snapshot: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }) => void;
  acquireVisibleLock: (reason: PaneMobileChromeLockReason) => () => void;
}

const PaneMobileChromeControllerContext =
  createContext<PaneMobileChromeController | null>(null);

const MOBILE_CHROME_SCROLL_DELTA_EPSILON_PX = 1;
const MOBILE_CHROME_HIDE_TOLERANCE_PX = 24;
const MOBILE_CHROME_REVEAL_TOLERANCE_PX = 16;

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

export function usePaneMobileChromeController(): PaneMobileChromeController | null {
  return useContext(PaneMobileChromeControllerContext);
}

type PaneShellStyle = CSSProperties & {
  "--mobile-pane-chrome-height"?: string;
};

interface PaneShellProps {
  paneId: string;
  href?: string;
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
  href = "/",
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
  const mobileChromeVisibleLocksRef = useRef<Map<number, PaneMobileChromeLockReason>>(
    new Map()
  );
  const nextMobileChromeLockIdRef = useRef(0);
  const releaseActionMenuLockRef = useRef<(() => void) | null>(null);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const [mobileChromeVisibleLockCount, setMobileChromeVisibleLockCount] = useState(0);
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
    mobileChromeVisibleLockCount === 0 &&
    !prefersReducedMotion;

  const showMobileChromeNow = useCallback(() => {
    setMobileChromeHidden(false);
    mobileChromeScrollDirectionRef.current = null;
    mobileChromeDirectionStartRef.current = lastScrollTopRef.current;
  }, []);

  // Reset mobile chrome state when leaving mobile document mode.
  useEffect(() => {
    if (!isMobileDocumentPane) {
      setMobileChromeHidden(false);
      mobileChromeVisibleLocksRef.current.clear();
      setMobileChromeVisibleLockCount(0);
      releaseActionMenuLockRef.current = null;
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
    (snapshot: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
      if (!isMobileDocumentPane || prefersReducedMotion) {
        return;
      }
      const maxScrollTop = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
      const scrollTop = Math.min(Math.max(0, snapshot.scrollTop), maxScrollTop);
      const previous = lastScrollTopRef.current;
      const delta = scrollTop - previous;
      lastScrollTopRef.current = scrollTop;

      if (scrollTop <= mobileChromeHeight) {
        setMobileChromeHidden(false);
        mobileChromeScrollDirectionRef.current = null;
        mobileChromeDirectionStartRef.current = scrollTop;
        return;
      }

      if (Math.abs(delta) < MOBILE_CHROME_SCROLL_DELTA_EPSILON_PX) {
        return;
      }

      const direction = delta > 0 ? "down" : "up";
      if (mobileChromeScrollDirectionRef.current !== direction) {
        mobileChromeScrollDirectionRef.current = direction;
        mobileChromeDirectionStartRef.current = scrollTop;
        return;
      }

      const directionDistance = Math.abs(scrollTop - mobileChromeDirectionStartRef.current);

      if (direction === "down" && directionDistance >= MOBILE_CHROME_HIDE_TOLERANCE_PX) {
        setMobileChromeHidden(true);
        return;
      }

      if (direction === "up" && directionDistance >= MOBILE_CHROME_REVEAL_TOLERANCE_PX) {
        setMobileChromeHidden(false);
      }
    },
    [isMobileDocumentPane, mobileChromeHeight, prefersReducedMotion]
  );

  const acquireMobileChromeVisibleLock = useCallback(
    (reason: PaneMobileChromeLockReason) => {
      const lockId = nextMobileChromeLockIdRef.current + 1;
      nextMobileChromeLockIdRef.current = lockId;
      mobileChromeVisibleLocksRef.current.set(lockId, reason);
      setMobileChromeVisibleLockCount(mobileChromeVisibleLocksRef.current.size);
      showMobileChromeNow();

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        mobileChromeVisibleLocksRef.current.delete(lockId);
        setMobileChromeVisibleLockCount(mobileChromeVisibleLocksRef.current.size);
        if (mobileChromeVisibleLocksRef.current.size === 0) {
          showMobileChromeNow();
        }
      };
    },
    [showMobileChromeNow]
  );

  const mobileChromeController = useMemo<PaneMobileChromeController>(
    () => ({
      onDocumentScroll: handleDocumentScroll,
      acquireVisibleLock: acquireMobileChromeVisibleLock,
    }),
    [acquireMobileChromeVisibleLock, handleDocumentScroll]
  );

  const handleOptionsOpenChange = useCallback(
    (open: boolean) => {
      if (!isMobileDocumentPane) {
        releaseActionMenuLockRef.current?.();
        releaseActionMenuLockRef.current = null;
        return;
      }
      if (!open) {
        releaseActionMenuLockRef.current?.();
        releaseActionMenuLockRef.current = null;
        return;
      }
      releaseActionMenuLockRef.current?.();
      releaseActionMenuLockRef.current =
        acquireMobileChromeVisibleLock("action-menu");
    },
    [acquireMobileChromeVisibleLock, isMobileDocumentPane]
  );
  const copyPaneLink = useCallback(() => {
    const link =
      typeof window === "undefined"
        ? href
        : new URL(href, window.location.origin).toString();
    copyText(link);
  }, [href]);
  const paneMenuOptions = useMemo<SurfaceHeaderOption[]>(() => {
    const routeOptions = effectiveOptions ?? [];
    const contextualOptions = routeOptions.map((option, index) =>
      index === 0
        ? { ...option, separatorBefore: option.separatorBefore ?? true }
        : option
    );
    return [
      {
        id: "copy-pane-link",
        label: "Copy pane link",
        onSelect: copyPaneLink,
      },
      ...contextualOptions,
    ];
  }, [copyPaneLink, effectiveOptions]);

  const shellClass = effectiveMobileChromeHidden
    ? `${styles.paneShell} ${styles.mobileChromeHidden}`
    : styles.paneShell;

  const shellStyle: PaneShellStyle = isMobile
    ? { width: "100%", minWidth: "100%", maxWidth: "100%" }
    : { width: `${widthPx}px`, minWidth: `${minWidthPx}px`, maxWidth: `${maxWidthPx}px` };
  if (isMobile && mobileChromeHeight > 0) {
    shellStyle["--mobile-pane-chrome-height"] = `${mobileChromeHeight}px`;
  }

  let bodyStyle: CSSProperties;
  switch (bodyMode) {
    case "standard":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
    case "document":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
    case "contained":
      bodyStyle = {
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        ...(isMobile && { overscrollBehavior: "contain" }),
      };
      break;
    default: {
      const exhaustive: never = bodyMode;
      throw new Error(`Unhandled pane body mode: ${exhaustive}`);
    }
  }

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
          options={paneMenuOptions}
          actions={
            isMobile ? (
              <>
                {effectiveActions}
                <Button
                  variant="secondary"
                  size="md"
                  iconOnly
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
                </Button>
              </>
            ) : (
              effectiveActions
            )
          }
          onBack={onBack}
          onOptionsOpenChange={handleOptionsOpenChange}
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
          <PaneMobileChromeControllerContext.Provider
            value={bodyMode === "document" ? mobileChromeController : null}
          >
            {children}
          </PaneMobileChromeControllerContext.Provider>
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
