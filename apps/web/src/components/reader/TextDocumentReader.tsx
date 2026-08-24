import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  Ref,
  RefObject,
  TouchEvent,
  WheelEvent,
} from "react";
import { useEffect, useMemo, useRef } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import { composeRefs } from "@/lib/ui/composeRefs";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import styles from "./textDocumentReader.module.css";

export type ReaderViewportSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type TrustedScrollDirection = "forward" | "backward";

/**
 * The hosted decoration port. The leaf's `renderedHtml` input is undecorated
 * canonical HTML; a hosted composition supplies this port to layer highlights
 * and inert embed projections over it after load. Offline (and any host that
 * omits the port) renders the canonical HTML as-is.
 */
export interface TextReaderContentDecorator {
  decorate(canonicalHtml: string): string;
}

type TextDocumentContentState =
  | {
      status: "loading";
      message: string;
    }
  | {
      status: "empty";
      message: string;
    }
  | {
      status: "error";
      message: string;
      /** Re-runs the owning document load; absent when nothing can retry. */
      retry?: () => void;
    }
  | {
      status: "ready";
      /** Undecorated canonical HTML; decoration is applied via `decorator`. */
      renderedHtml: string;
    };

export default function TextDocumentReader({
  mediaId,
  additionalViewportRef,
  scrollPositioner,
  beforeContent,
  readerRootRef,
  contentRef,
  textViewportRef,
  textEndRef,
  readerThemeClassName,
  readerSurfaceStyle,
  focusMode,
  hyphenation,
  contentState,
  decorator,
  onViewportReady,
  onViewportScroll,
  onTrustedScrollIntent,
  endContent,
  onContentClick,
  onContentPointerOver,
  onContentPointerOut,
  onContentFocus,
  onContentBlur,
  onInternalLinkClick,
  onCanonicalPosition,
  canonicalLength,
  initialCanonicalOffset,
}: {
  mediaId: string;
  additionalViewportRef?: Ref<HTMLDivElement>;
  scrollPositioner: ReaderScrollPositioner;
  beforeContent?: ReactNode;
  readerRootRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  textViewportRef: RefObject<HTMLDivElement | null>;
  textEndRef: RefObject<HTMLElement | null>;
  readerThemeClassName: string;
  readerSurfaceStyle: CSSProperties;
  focusMode: string;
  hyphenation: string;
  contentState: TextDocumentContentState;
  /** Hosted decoration over canonical HTML; omitted hosts render undecorated. */
  decorator?: TextReaderContentDecorator;
  onViewportReady: (snapshot: ReaderViewportSnapshot) => void;
  onViewportScroll: (snapshot: ReaderViewportSnapshot) => void;
  onTrustedScrollIntent: (direction: TrustedScrollDirection) => void;
  endContent: ReactNode;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  onContentFocus: (event: FocusEvent<HTMLDivElement>) => void;
  onContentBlur: (event: FocusEvent<HTMLDivElement>) => void;
  onInternalLinkClick?: (href: string | null) => boolean;
  onCanonicalPosition?: (offset: number) => void;
  canonicalLength?: number;
  initialCanonicalOffset?: number;
}) {
  const viewportRef = useMemo(
    () =>
      additionalViewportRef
        ? composeRefs<HTMLDivElement>(textViewportRef, additionalViewportRef)
        : textViewportRef,
    [additionalViewportRef, textViewportRef],
  );
  const canonicalHtml =
    contentState.status === "ready" ? contentState.renderedHtml : null;
  const presentedHtml = useMemo(
    () =>
      canonicalHtml === null
        ? null
        : decorator === undefined
          ? canonicalHtml
          : decorator.decorate(canonicalHtml),
    [canonicalHtml, decorator],
  );
  const onViewportReadyRef = useRef(onViewportReady);
  const onViewportScrollRef = useRef(onViewportScroll);
  const onTrustedScrollIntentRef = useRef(onTrustedScrollIntent);
  const lastTouchYRef = useRef<number | null>(null);
  const pointerScrollActiveRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const canonicalPositionRef = useRef(onCanonicalPosition);
  const canonicalLengthRef = useRef(canonicalLength);
  const initialCanonicalOffsetRef = useRef(initialCanonicalOffset);
  onViewportReadyRef.current = onViewportReady;
  onViewportScrollRef.current = onViewportScroll;
  onTrustedScrollIntentRef.current = onTrustedScrollIntent;
  canonicalPositionRef.current = onCanonicalPosition;
  canonicalLengthRef.current = canonicalLength;
  initialCanonicalOffsetRef.current = initialCanonicalOffset;

  useEffect(() => {
    const viewport = textViewportRef.current;
    if (!viewport) {
      return;
    }

    const snapshot = (): ReaderViewportSnapshot => ({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });

    const initialOffset = initialCanonicalOffsetRef.current;
    const activeCanonicalLength = canonicalLengthRef.current;
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (
      initialOffset !== undefined &&
      initialOffset > 0 &&
      activeCanonicalLength !== undefined &&
      activeCanonicalLength > 0 &&
      maximum > 0
    ) {
      viewport.scrollTop = Math.round(
        (Math.min(initialOffset, activeCanonicalLength) / activeCanonicalLength) * maximum,
      );
    }
    lastScrollTopRef.current = viewport.scrollTop;
    onViewportReadyRef.current(snapshot());
    const publishScroll = (event: Event) => {
      const nextSnapshot = snapshot();
      const delta = nextSnapshot.scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = nextSnapshot.scrollTop;
      onViewportScrollRef.current(nextSnapshot);
      const publishCanonical = canonicalPositionRef.current;
      const activeCanonicalLength = canonicalLengthRef.current;
      if (publishCanonical && activeCanonicalLength !== undefined) {
        const maximum = Math.max(0, nextSnapshot.scrollHeight - nextSnapshot.clientHeight);
        publishCanonical(
          maximum > 0 ? Math.round((nextSnapshot.scrollTop / maximum) * activeCanonicalLength) : 0,
        );
      }
      if (pointerScrollActiveRef.current && event.isTrusted && delta !== 0) {
        onTrustedScrollIntentRef.current(
          delta > 0 ? "forward" : "backward",
        );
      }
    };

    viewport.addEventListener("scroll", publishScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", publishScroll);
  }, [mediaId, textViewportRef]);

  function publishTrustedScrollIntent(direction: TrustedScrollDirection) {
    onTrustedScrollIntentRef.current(direction);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.isTrusted) return;
    if (event.deltaY === 0) return;
    publishTrustedScrollIntent(event.deltaY > 0 ? "forward" : "backward");
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (!event.isTrusted) return;
    lastTouchYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    if (!event.isTrusted) return;
    const touchY = event.touches[0]?.clientY;
    const previousTouchY = lastTouchYRef.current;
    lastTouchYRef.current = touchY ?? null;
    if (
      touchY === undefined ||
      previousTouchY === null ||
      touchY === previousTouchY
    ) {
      return;
    }
    publishTrustedScrollIntent(
      touchY < previousTouchY ? "forward" : "backward",
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.isTrusted) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "PageDown" ||
      event.key === "End" ||
      ((event.key === " " || event.key === "Spacebar") && !event.shiftKey)
    ) {
      publishTrustedScrollIntent("forward");
      return;
    }
    if (
      event.key === "ArrowUp" ||
      event.key === "PageUp" ||
      event.key === "Home" ||
      ((event.key === " " || event.key === "Spacebar") && event.shiftKey)
    ) {
      publishTrustedScrollIntent("backward");
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    pointerScrollActiveRef.current =
      event.isTrusted && event.target === event.currentTarget;
  }

  function handleRenderedContentClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target;
    let delegatedToContentClick = false;
    if (target instanceof Element) {
      target
        .closest(
          "[data-active-highlight-ids], [data-highlight-anchor], [data-reader-apparatus-item-id]",
        )
        ?.setAttribute("data-reader-tap-handled", "true");
      const apparatusEl = target.closest("[data-reader-apparatus-item-id]");
      if (apparatusEl) {
        onContentClick(event);
        delegatedToContentClick = true;
        if (event.defaultPrevented) {
          return;
        }
      }

      if (onInternalLinkClick) {
        const anchorEl = target.closest("a[href]");
        if (
          anchorEl instanceof HTMLAnchorElement &&
          onInternalLinkClick(anchorEl.getAttribute("href"))
        ) {
          event.preventDefault();
          return;
        }
      }
    }

    if (!delegatedToContentClick) {
      onContentClick(event);
    }
  }

  return (
    <div
      className={`${styles.readerFrame} ${styles.textDocumentReaderFrame} ${readerThemeClassName}`}
    >
      <div
        ref={viewportRef}
        className={`${styles.documentViewport} ${styles.textDocumentViewport}`}
        data-testid="document-viewport"
        data-initial-canonical-offset={initialCanonicalOffset ?? undefined}
        data-pane-content="true"
        tabIndex={0}
        role="region"
        aria-label="Document reading area"
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onPointerDown={handlePointerDown}
        onPointerUp={() => {
          pointerScrollActiveRef.current = false;
        }}
        onPointerCancel={() => {
          pointerScrollActiveRef.current = false;
        }}
        onKeyDown={handleKeyDown}
      >
        {beforeContent}
        <div
          ref={readerRootRef}
          className={styles.readerContentRoot}
          style={readerSurfaceStyle}
          data-focus-mode={focusMode}
          data-hyphenation={hyphenation}
        >
          <div className={styles.readerContentInner}>
            {contentState.status === "error" ? (
              <div className={styles.error}>
                {contentState.message}
                {contentState.retry ? (
                  <button
                    type="button"
                    className={styles.errorRetry}
                    onClick={contentState.retry}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : contentState.status === "loading" ? (
              <div className={styles.loading}>{contentState.message}</div>
            ) : contentState.status === "empty" ? (
              <div className={styles.empty}>
                <p>{contentState.message}</p>
              </div>
            ) : (
              <div
                ref={contentRef}
                className={styles.fragments}
                onClick={handleRenderedContentClick}
                onPointerOver={onContentPointerOver}
                onPointerOut={onContentPointerOut}
                onFocus={onContentFocus}
                onBlur={onContentBlur}
              >
                <HtmlRenderer
                  htmlSanitized={presentedHtml ?? ""}
                  className={styles.fragment}
                  mediaId={mediaId}
                  scrollPositioner={scrollPositioner}
                  headingLevelOffset={1}
                />
              </div>
            )}
            {contentState.status === "ready" ? (
              <section ref={textEndRef} className={styles.readerEndcap}>
                {endContent}
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
