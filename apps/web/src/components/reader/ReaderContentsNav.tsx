import type { Presence } from "@/lib/api/presence";
import type { ReaderNavigationSection, ReaderNavigationTextPoint, ReaderNavigationTocNode } from "@/lib/media/readerNavigation";
import styles from "./ReaderContentsNav.module.css";

export default function ReaderContentsNav({
  nodes,
  sections,
  activeSectionId,
  onNavigate,
}: {
  nodes: readonly ReaderNavigationTocNode[];
  sections: readonly ReaderNavigationSection[];
  activeSectionId: Presence<string>;
  onNavigate: (point: ReaderNavigationTextPoint) => void;
}) {
  return (
    <ul className={styles.tocList}>
      {nodes.map((node) => {
        const sectionId = node.section_id;
        const target = node.target;
        const current = sectionId.kind === "Present" && activeSectionId.kind === "Present" && sectionId.value === activeSectionId.value;
        const section = sectionId.kind === "Present" ? sections.find((candidate) => candidate.section_id === sectionId.value) : undefined;
        const children = node.children.length > 0 ? (
          <ReaderContentsNav nodes={node.children} sections={sections} activeSectionId={activeSectionId} onNavigate={onNavigate} />
        ) : null;
        return (
          <li key={node.id} className={styles.tocItem}>
            {target.kind === "Present" ? (
              <>
                <button type="button" className={`${styles.tocLink} ${current ? styles.tocActive : ""}`} aria-current={current ? "location" : undefined} onClick={() => onNavigate(target.value)}>
                  {node.label}
                  {section?.source === "InferredNumberedEntry" ? <small className={styles.inferred}>numbered entry (inferred)</small> : null}
                </button>
                {children}
              </>
            ) : children ? (
              <details open>
                <summary className={styles.tocGroup}>{node.label}</summary>
                {children}
              </details>
            ) : <span className={styles.tocLabel}>{node.label}</span>}
          </li>
        );
      })}
    </ul>
  );
}
