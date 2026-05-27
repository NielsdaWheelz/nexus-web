import type { MouseEvent } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import {
  type EpubSectionContent,
  type NormalizedNavigationTocNode,
  type ReaderNavigationSection,
} from "@/lib/media/readerNavigation";
import {
  resolveEpubInternalLinkTarget,
} from "./epubHelpers";
import ReaderContentsNav from "./ReaderContentsNav";
import styles from "./page.module.css";

export default function EpubContentPane({
  mediaId,
  sections,
  activeChapter,
  activeSectionId,
  chapterLoading,
  epubError,
  toc,
  tocWarning,
  tocExpanded,
  contentRef,
  renderedHtml,
  onContentClick,
  onNavigate,
}: {
  mediaId: string;
  sections: ReaderNavigationSection[] | null;
  activeChapter: EpubSectionContent | null;
  activeSectionId: string | null;
  chapterLoading: boolean;
  epubError: string | null;
  toc: NormalizedNavigationTocNode[] | null;
  tocWarning: boolean;
  tocExpanded: boolean;
  contentRef: React.RefObject<HTMLDivElement | null>;
  renderedHtml: string;
  onContentClick: (e: React.MouseEvent) => void;
  onNavigate: (sectionId: string, anchorId?: string | null) => void;
}) {
  if (epubError && epubError !== "processing") {
    return (
      <div className={styles.error}>
        {epubError}
      </div>
    );
  }

  if (!sections) {
    return <div className={styles.loading}>Loading EPUB navigation...</div>;
  }

  if (sections.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No sections available for this EPUB.</p>
      </div>
    );
  }

  const hasToc = toc !== null && toc.length > 0;

  function handleContentClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as Element;
    const anchorEl = target.closest("a[href]");
    if (!(anchorEl instanceof HTMLAnchorElement)) {
      onContentClick(event);
      return;
    }

    const linkTarget = resolveEpubInternalLinkTarget(
      anchorEl.getAttribute("href"),
      activeSectionId,
      sections
    );
    if (!linkTarget) {
      onContentClick(event);
      return;
    }

    event.preventDefault();
    onNavigate(linkTarget.sectionId, linkTarget.anchorId);
  }

  return (
    <div className={styles.epubContainer}>
      {(hasToc || tocWarning) && (
        <ReaderContentsNav
          nodes={toc ?? []}
          activeSectionId={activeSectionId}
          expanded={tocExpanded}
          warning={tocWarning}
          onNavigate={onNavigate}
        />
      )}

      {chapterLoading ? (
        <div className={styles.loading}>Loading section...</div>
      ) : activeChapter ? (
        <div
          ref={contentRef}
          className={styles.fragments}
          onClick={handleContentClick}
        >
          <HtmlRenderer
            htmlSanitized={renderedHtml}
            className={styles.fragment}
            mediaId={mediaId}
          />
        </div>
      ) : null}
    </div>
  );
}
