"use client";

// The Media Abstract (A11 §252): the Media Dossier's compact, read-only,
// current-only MediaIntelligence display — no Generate control, no history,
// visually subordinate to the Dossier's own build state. Renders the typed
// `Building | Ready | Stale | Failed | NotAvailable` union exhaustively; it is
// never the Dossier's build machinery, only a subordinate projection.
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { MediaAbstract as MediaAbstractValue } from "@/lib/dossiers/dossierControllerTypes";
import styles from "./DossierSurface.module.css";

export default function MediaAbstract({
  abstract,
}: {
  abstract: MediaAbstractValue;
}) {
  switch (abstract.kind) {
    case "Building":
      return (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.abstractLabel}>Abstract</span>
          <span className={styles.abstractStale}>Preparing…</span>
        </section>
      );
    case "Ready":
      return (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.abstractLabel}>Abstract</span>
          <MarkdownMessage content={abstract.summaryMd} />
        </section>
      );
    case "Stale":
      return (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.abstractLabel}>Abstract · outdated</span>
          <MarkdownMessage content={abstract.summaryMd} />
        </section>
      );
    case "Failed":
      return (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.abstractLabel}>Abstract</span>
          <span className={styles.abstractStale}>Unavailable.</span>
        </section>
      );
    case "NotAvailable":
      return null;
    default: {
      const exhaustive: never = abstract;
      throw new Error(`Unhandled media abstract: ${JSON.stringify(exhaustive)}`);
    }
  }
}
