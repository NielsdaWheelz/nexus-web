import { useId } from "react";
import {
  parseReaderNavigationHrefAnchorId,
  type NormalizedNavigationTocNode,
} from "@/lib/media/readerNavigation";
import styles from "./page.module.css";

export default function ReaderContentsNav({
  nodes,
  activeSectionId,
  expanded,
  warning,
  onNavigate,
}: {
  nodes: NormalizedNavigationTocNode[];
  activeSectionId: string | null;
  expanded: boolean;
  warning: boolean;
  onNavigate: (target: { sectionId: string; anchorId: string | null }) => void;
}) {
  const labelId = useId();
  const hasNodes = nodes.length > 0;

  return (
    <nav className={styles.tocSection} aria-labelledby={labelId}>
      <div id={labelId} className={styles.tocHeading}>
        Contents
        {warning && !hasNodes ? (
          <span className={styles.tocWarning}> (unavailable)</span>
        ) : null}
      </div>

      {expanded && hasNodes ? (
        <div className={styles.tocTree}>
          <TocNodeList
            nodes={nodes}
            activeSectionId={activeSectionId}
            onNavigate={onNavigate}
          />
        </div>
      ) : null}
    </nav>
  );
}

function TocNodeList({
  nodes,
  activeSectionId,
  onNavigate,
}: {
  nodes: NormalizedNavigationTocNode[];
  activeSectionId: string | null;
  onNavigate: (target: { sectionId: string; anchorId: string | null }) => void;
}) {
  return (
    <ul className={styles.tocList}>
      {nodes.map((node) => (
        <li key={node.id} className={styles.tocItem}>
          {node.navigable ? (
            <button
              className={`${styles.tocLink} ${
                node.section_id === activeSectionId ? styles.tocActive : ""
              }`}
              aria-current={
                node.section_id === activeSectionId ? "location" : undefined
              }
              onClick={() => {
                if (node.section_id) {
                  onNavigate({
                    sectionId: node.section_id,
                    anchorId: parseReaderNavigationHrefAnchorId(node.href),
                  });
                }
              }}
            >
              {node.label}
            </button>
          ) : (
            <span className={styles.tocLabel}>{node.label}</span>
          )}
          {node.children.length > 0 ? (
            <TocNodeList
              nodes={node.children}
              activeSectionId={activeSectionId}
              onNavigate={onNavigate}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
