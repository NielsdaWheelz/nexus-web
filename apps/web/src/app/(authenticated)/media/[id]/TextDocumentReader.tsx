import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  RefObject,
  TouchEvent,
  WheelEvent,
} from "react";
import { useCallback, useEffect, useRef } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import { useMobileChromeReaderScrollport } from "@/lib/workspace/mobileChrome";
import styles from "./page.module.css";

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
      status: "empty";
      message: string;
    }
  | {
      status: "error";
      message: string;
    }
  | {
      status: "ready";
      renderedHtml: string;
    };

export default function TextDocumentReader({
  mediaId,
  mobileChromeSourceKey,
  mobileChromeEnabled,
  beforeContent,
  readerRootRef,
  contentRef,
  textViewportRef,
  textEndRef,
  readerSurfaceClassName,
  readerSurfaceStyle,
  focusMode,
  hyphenation,
  contentState,
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
}: {
  mediaId: string;
  mobileChromeSourceKey: string;
  mobileChromeEnabled: boolean;
  beforeContent?: ReactNode;
  readerRootRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  textViewportRef: RefObject<HTMLDivElement | null>;
  textEndRef: RefObject<HTMLElement | null>;
  readerSurfaceClassName: string;
  readerSurfaceStyle: CSSProperties;
  focusMode: string;
  hyphenation: string;
  contentState: TextDocumentContentState;
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
}) {
  const mobileChromeViewportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: mobileChromeSourceKey,
      enabled: mobileChromeEnabled,
    });
  const setTextViewportNode = useCallback(
    (node: HTMLDivElement | null) => {
      textViewportRef.current = node;
      mobileChromeViewportRef(node);
    },
    [mobileChromeViewportRef, textViewportRef],
  );
  const onViewportReadyRef = useRef(onViewportReady);
  const onViewportScrollRef = useRef(onViewportScroll);
  const onTrustedScrollIntentRef = useRef(onTrustedScrollIntent);
  const lastTouchYRef = useRef<number | null>(null);
  const pointerScrollActiveRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  onViewportReadyRef.current = onViewportReady;
  onViewportScrollRef.current = onViewportScroll;
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
      onViewportScrollRef.current(nextSnapshot);
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
    <div className={styles.readerFrame}>
      <div
        ref={setTextViewportNode}
        className={styles.documentViewport}
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
          className={readerSurfaceClassName}
          style={readerSurfaceStyle}
          data-focus-mode={focusMode}
          data-hyphenation={hyphenation}
        >
          <div className={styles.readerContentInner}>
            {contentState.status === "error" ? (
              <div className={styles.error}>{contentState.message}</div>
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
                  htmlSanitized={contentState.renderedHtml}
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
