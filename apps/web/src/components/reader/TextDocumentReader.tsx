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
import { readerScrollKeyDirection } from "@/lib/reader/readerScrollInput";
import styles from "./textDocumentReader.module.css";

export type ReaderViewportSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type TrustedScrollDirection = "forward" | "backward";

type TextDocumentContentState =
  | {
      status: "loading";
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
      renderedHtml: string;
      preparedRoots?: never;
    }
  | {
      status: "ready";
      renderedHtml?: never;
      preparedRoots: readonly { key: string; root: HTMLElement }[];
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
  busy = false,
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
  /** A source request can remain pending while existing content is readable. */
  busy?: boolean;
  onViewportReady: (snapshot: ReaderViewportSnapshot) => void;
  onViewportScroll: (snapshot: ReaderViewportSnapshot) => void;
  onTrustedScrollIntent: (direction: TrustedScrollDirection) => void;
  endContent: ReactNode;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  onContentFocus: (event: FocusEvent<HTMLDivElement>) => void;
  onContentBlur: (event: FocusEvent<HTMLDivElement>) => void;
  onInternalLinkClick?: (href: string | null, anchor: HTMLAnchorElement) => boolean;
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
      onViewportScrollRef.current(nextSnapshot);
    };

    viewport.addEventListener("scroll", publishScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", publishScroll);
  }, [mediaId, textViewportRef]);

  function publishTrustedScrollIntent(direction: TrustedScrollDirection) {
    onTrustedScrollIntentRef.current(direction);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.isTrusted || event.ctrlKey) return;
    if (event.deltaY === 0) return;
    publishTrustedScrollIntent(event.deltaY > 0 ? "forward" : "backward");
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (!event.isTrusted) return;
    lastTouchYRef.current = event.touches.length === 1
      ? event.touches[0]?.clientY ?? null
      : null;
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    if (!event.isTrusted) return;
    if (event.touches.length !== 1) {
      lastTouchYRef.current = null;
      return;
    }
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
    const direction = readerScrollKeyDirection(event.nativeEvent);
    if (direction !== null) publishTrustedScrollIntent(direction);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    pointerScrollActiveRef.current =
      event.isTrusted && event.pointerType !== "touch" && event.target === event.currentTarget;
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
          onInternalLinkClick(anchorEl.getAttribute("href"), anchorEl)
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
        aria-busy={busy || contentState.status === "loading"}
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
                {contentState.preparedRoots !== undefined ? contentState.preparedRoots.map(({ key, root }) => (
                  <HtmlRenderer
                    key={key}
                    preparedRoot={root}
                    className={styles.fragment}
                    mediaId={mediaId}
                    scrollPositioner={scrollPositioner}
                  />
                )) : (
                  <HtmlRenderer
                    htmlSanitized={contentState.renderedHtml}
                    className={styles.fragment}
                    mediaId={mediaId}
                    scrollPositioner={scrollPositioner}
                    headingLevelOffset={1}
                  />
                )}
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
