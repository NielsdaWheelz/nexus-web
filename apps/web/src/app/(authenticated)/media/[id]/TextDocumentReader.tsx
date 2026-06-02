import type {
  CSSProperties,
  MouseEvent,
  PointerEvent,
  RefObject,
} from "react";
import { useEffect, useRef } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import styles from "./page.module.css";

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

export interface DocumentScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export default function TextDocumentReader({
  mediaId,
  readerRootRef,
  contentRef,
  readerSurfaceClassName,
  readerSurfaceStyle,
  focusMode,
  hyphenation,
  contentState,
  onDocumentScroll,
  onContentClick,
  onContentPointerOver,
  onContentPointerOut,
  onInternalLinkClick,
}: {
  mediaId: string;
  readerRootRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  readerSurfaceClassName: string;
  readerSurfaceStyle: CSSProperties;
  focusMode: string;
  hyphenation: string;
  contentState: TextDocumentContentState;
  onDocumentScroll: (snapshot: DocumentScrollSnapshot) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  onInternalLinkClick?: (href: string | null) => boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const onDocumentScrollRef = useRef(onDocumentScroll);
  onDocumentScrollRef.current = onDocumentScroll;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const publishScroll = () => {
      onDocumentScrollRef.current({
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      });
    };

    viewport.addEventListener("scroll", publishScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", publishScroll);
  }, []);

  function handleRenderedContentClick(event: MouseEvent<HTMLDivElement>) {
    if (onInternalLinkClick) {
      const target = event.target;
      if (target instanceof Element) {
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

    onContentClick(event);
  }

  return (
    <div className={styles.readerFrame}>
      <div
        ref={viewportRef}
        className={styles.documentViewport}
        data-testid="document-viewport"
        data-pane-content="true"
      >
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
              >
                <HtmlRenderer
                  htmlSanitized={contentState.renderedHtml}
                  className={styles.fragment}
                  mediaId={mediaId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
