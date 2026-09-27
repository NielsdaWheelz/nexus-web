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
import {
  isReaderScrollbarSeekStart,
  readerScrollKeyIntent,
  type TrustedScrollDirection,
} from "@/lib/reader/readerScrollInput";
import type { ReaderNavigationSeekOperation } from "@/lib/reader/useReaderNavigation";
import styles from "./textDocumentReader.module.css";

export type ReaderViewportSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

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
  onViewportScrollEnd,
  onTrustedScrollIntent,
  onSeekBoundary,
  onBeginScrollbarSeek,
  endContent,
  onContentClick,
  onContentPointerOver,
  onContentPointerOut,
  onContentFocus,
  onContentBlur,
  onInternalLinkClick,
}: {
  mediaId: string;
  additionalViewportRef?: Ref<HTMLDivElement>;
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
  onViewportScrollEnd?: (snapshot: ReaderViewportSnapshot) => void;
  onTrustedScrollIntent: (direction: TrustedScrollDirection) => void;
  onSeekBoundary: (edge: "Start" | "End") => void;
  onBeginScrollbarSeek: () => ReaderNavigationSeekOperation | null;
  endContent: ReactNode;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  onContentFocus: (event: FocusEvent<HTMLDivElement>) => void;
  onContentBlur: (event: FocusEvent<HTMLDivElement>) => void;
  onInternalLinkClick?: (link: HTMLAnchorElement) => boolean;
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
  const onViewportScrollEndRef = useRef(onViewportScrollEnd);
  const onTrustedScrollIntentRef = useRef(onTrustedScrollIntent);
  const lastTouchYRef = useRef<number | null>(null);
  const scrollbarSeekRef = useRef<{
    operation: ReaderNavigationSeekOperation;
    viewport: HTMLElement;
    top: number;
    left: number;
  } | null>(null);
  onViewportReadyRef.current = onViewportReady;
  onViewportScrollRef.current = onViewportScroll;
  onViewportScrollEndRef.current = onViewportScrollEnd;
  onTrustedScrollIntentRef.current = onTrustedScrollIntent;

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

    onViewportReadyRef.current(snapshot());
    let settleTimer: number | undefined;
    const publishScrollEnd = () => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = undefined;
      onViewportScrollEndRef.current?.(snapshot());
    };
    const publishScroll = () => {
      const nextSnapshot = snapshot();
      onViewportScrollRef.current(nextSnapshot);
      if (!("onscrollend" in viewport) && onViewportScrollEndRef.current) {
        if (settleTimer !== undefined) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(publishScrollEnd, 200);
      }
    };

    viewport.addEventListener("scroll", publishScroll, { passive: true });
    viewport.addEventListener("scrollend", publishScrollEnd);
    return () => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      viewport.removeEventListener("scroll", publishScroll);
      viewport.removeEventListener("scrollend", publishScrollEnd);
    };
  }, [mediaId, textViewportRef]);

  useEffect(() => {
    const finish = (cancelled: boolean) => {
      const seek = scrollbarSeekRef.current;
      if (!seek) return;
      scrollbarSeekRef.current = null;
      const displaced = seek.viewport.scrollTop !== seek.top || seek.viewport.scrollLeft !== seek.left;
      if (cancelled) void seek.operation.cancel(displaced);
      else void seek.operation.settle({ kind: displaced ? "Arrived" : "Unchanged" });
    };
    const onPointerUp = () => finish(false);
    const onPointerCancel = () => finish(true);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      finish(true);
    };
  }, [mediaId]);

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
    const intent = readerScrollKeyIntent(event.nativeEvent);
    if (intent?.kind === "Traverse") publishTrustedScrollIntent(intent.direction);
    else if (intent?.kind === "Seek") {
      event.preventDefault();
      onSeekBoundary(intent.edge);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isReaderScrollbarSeekStart(event.nativeEvent, event.currentTarget)) return;
    const operation = onBeginScrollbarSeek();
    if (!operation) {
      event.preventDefault();
      return;
    }
    scrollbarSeekRef.current = {
      operation,
      viewport: event.currentTarget,
      top: event.currentTarget.scrollTop,
      left: event.currentTarget.scrollLeft,
    };
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
      const anchorEl = target.closest("a[href]");
      // A note body may carry apparatus identity around independently authored
      // links. Only a marker inside the link owns that link's disclosure action.
      if (anchorEl instanceof HTMLAnchorElement && apparatusEl && !anchorEl.contains(apparatusEl)) {
        if (onInternalLinkClick?.(anchorEl)) event.preventDefault();
        return;
      }
      if (apparatusEl) {
        onContentClick(event);
        delegatedToContentClick = true;
        if (event.defaultPrevented) {
          return;
        }
      }

      if (onInternalLinkClick) {
        if (
          anchorEl instanceof HTMLAnchorElement &&
          onInternalLinkClick(anchorEl)
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
        data-pane-content="true"
        tabIndex={0}
        role="region"
        aria-label="Document reading area"
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onPointerDown={handlePointerDown}
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
