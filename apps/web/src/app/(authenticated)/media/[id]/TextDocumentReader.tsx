import type {
  CSSProperties,
  MouseEvent,
  PointerEvent,
  RefObject,
  UIEvent,
} from "react";
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
  onDocumentScroll: (event: UIEvent<HTMLDivElement>) => void;
  onContentClick: (event: MouseEvent<HTMLDivElement>) => void;
  onContentPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  onContentPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  onInternalLinkClick?: (href: string | null) => boolean;
}) {
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
        className={styles.documentViewport}
        data-testid="document-viewport"
        data-pane-content="true"
        onScroll={onDocumentScroll}
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
