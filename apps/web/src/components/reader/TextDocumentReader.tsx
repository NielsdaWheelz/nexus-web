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
import { readerScrollKeyDirection, type TrustedScrollDirection } from "@/lib/reader/readerScrollInput";
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
  const pointerScrollActiveRef = useRef(false);
  const lastScrollTopRef = useRef(0);
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

    lastScrollTopRef.current = viewport.scrollTop;
    onViewportReadyRef.current(snapshot());
    const publishScroll = (event: Event) => {
      const nextSnapshot = snapshot();
      const delta = nextSnapshot.scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = nextSnapshot.scrollTop;
      if (pointerScrollActiveRef.current && event.isTrusted && delta !== 0) {
        onTrustedScrollIntentRef.current(
          delta > 0 ? "forward" : "backward",
        );
      }
      onViewportScrollRef.current(nextSnapshot);
    };

    viewport.addEventListener("scroll", publishScroll, { passive: true });
    const publishScrollEnd = () => onViewportScrollEndRef.current?.(snapshot());
    viewport.addEventListener("scrollend", publishScrollEnd);
    return () => {
      viewport.removeEventListener("scroll", publishScroll);
      viewport.removeEventListener("scrollend", publishScrollEnd);
    };
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
