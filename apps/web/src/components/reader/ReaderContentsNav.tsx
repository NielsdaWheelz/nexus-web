import { type JSX } from "react";
import {
  parseReaderNavigationHrefAnchorId,
  type NormalizedNavigationTocNode,
} from "@/lib/media/readerNavigation";
import styles from "./ReaderContentsNav.module.css";

export default function ReaderContentsNav({
  nodes,
  activeSectionId,
  onNavigate,
}: {
  nodes: NormalizedNavigationTocNode[];
  activeSectionId: string | null;
  onNavigate: (target: { sectionId: string; anchorId: string | null }) => void;
}): JSX.Element {
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
            <ReaderContentsNav
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
