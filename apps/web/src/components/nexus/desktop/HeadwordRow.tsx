import type { NexusRow } from "@/lib/nexus/model";
import { rowPrimaryText } from "@/lib/nexus/rowText";
import { rowFacts } from "@/lib/nexus/rows";
import { ExcerptText } from "@/components/resources/ResourceBody";
import { NexusConcordance, rowEvidence, titleMatch, windowed } from "../NexusRow";
import styles from "./Headword.module.css";

/** The desktop line owns its single-line type; evidence and actions keep their existing owners. */
export default function HeadwordRow({ row, query, sideHead }: { row: NexusRow; query: string; sideHead: string }) {
  const title = rowPrimaryText(row);
  // The passage's work label owns its semantic qualifier.
  const facts = rowFacts(row.class === "Passage" ? { ...row, matchMethod: null } : row);
  const reason = row.action.kind === "Unavailable" ? row.action.reason : null;
  if (row.class === "Passage") return <>
    <span className={styles.sideHead} aria-hidden="true">{sideHead}</span>
    <span className={styles.passage}>
      {reason ? <span className={styles.gloss}>{reason}</span> : <NexusConcordance row={row} />}
      <span className={styles.work}>{row.matchMethod === "semantic" ? "related · " : ""}{title}{facts ? ` · ${facts}` : ""}</span>
    </span>
  </>;
  const inline = titleMatch(row, title, query);
  const evidence = rowEvidence(row, title);
  const shown = evidence && reason === null ? windowed(evidence) : null;
  const Glyph = row.icon;
  return <>
    <span className={styles.sideHead} aria-hidden="true">{sideHead}</span>
    <span className={styles.sign} aria-hidden="true"><Glyph size={16} /></span>
    <span className={styles.text}>
      <span className={styles.headword} title={title}><bdi>{inline ? <ExcerptText excerpt={inline.excerpt} match={inline} /> : title}</bdi></span>
      <span className={styles.gloss}>{shown ? <ExcerptText excerpt={shown.excerpt} match={shown} /> : [facts, reason].filter(Boolean).join(" · ")}</span>
    </span>
  </>;
}
