import HtmlRenderer from "@/components/HtmlRenderer";
import {
  type EpubNavigationSection,
  type EpubSectionContent,
  type NormalizedNavigationTocNode,
} from "@/lib/media/epubReader";
import styles from "./page.module.css";

export default function EpubContentPane({
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
  sections: EpubNavigationSection[] | null;
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
  onNavigate: (sectionId: string) => void;
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

  return (
    <div className={styles.epubContainer}>
      {(hasToc || tocWarning) && (
        <div className={styles.tocSection}>
          <div className={styles.tocToggle}>
            Table of Contents
            {tocWarning && !hasToc && <span className={styles.tocWarning}> (unavailable)</span>}
          </div>

          {tocExpanded && hasToc && (
            <div className={styles.tocTree}>
              <TocNodeList
                nodes={toc!}
                activeSectionId={activeSectionId}
                onNavigate={onNavigate}
              />
            </div>
          )}
        </div>
      )}

      {chapterLoading ? (
        <div className={styles.loading}>Loading section...</div>
      ) : activeChapter ? (
        <div
          ref={contentRef}
          className={styles.fragments}
          onClick={onContentClick}
        >
          <HtmlRenderer
            htmlSanitized={renderedHtml}
            className={styles.fragment}
          />
        </div>
      ) : null}
    </div>
  );
}

function TocNodeList({
  nodes,
  activeSectionId,
  onNavigate,
}: {
  nodes: NormalizedNavigationTocNode[];
  activeSectionId: string | null;
  onNavigate: (sectionId: string) => void;
}) {
  return (
    <ul className={styles.tocList}>
      {nodes.map((node) => (
        <li key={node.node_id} className={styles.tocItem}>
          {node.navigable ? (
            <button
              className={`${styles.tocLink} ${
                node.section_id === activeSectionId ? styles.tocActive : ""
              }`}
              onClick={() => node.section_id && onNavigate(node.section_id)}
            >
              {node.label}
            </button>
          ) : (
            <span className={styles.tocLabel}>{node.label}</span>
          )}
          {node.children.length > 0 && (
            <TocNodeList
              nodes={node.children}
              activeSectionId={activeSectionId}
              onNavigate={onNavigate}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
