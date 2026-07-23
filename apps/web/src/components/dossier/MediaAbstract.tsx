"use client";

// The Media Abstract (A11 §252): the Media Dossier's compact, read-only,
// current-only MediaIntelligence display — no Generate control, no history,
// visually subordinate to the Dossier's own build state. Renders the typed
// `Building | Ready | Stale | Failed | NotAvailable` union exhaustively; it is
// never the Dossier's build machinery, only a subordinate projection.
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import MachineText from "@/components/ui/MachineText";
import type { MediaAbstract as MediaAbstractValue } from "@/lib/dossiers/dossierControllerTypes";
import styles from "./DossierSurface.module.css";

export default function MediaAbstract({
  abstract,
  onViewEvidence,
}: {
  abstract: MediaAbstractValue;
  onViewEvidence: () => void;
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
          <MachineText origin={{ label: "Media abstract" }}>
            <MarkdownMessage content={abstract.summaryMd} />
          </MachineText>
          <button
            type="button"
            className={styles.abstractAction}
            onClick={onViewEvidence}
          >
            View evidence
          </button>
        </section>
      );
    case "Stale":
      return (
        <section className={styles.abstract} aria-label="Media abstract">
          <span className={styles.abstractLabel}>Abstract · outdated</span>
          <MachineText origin={{ label: "Media abstract" }}>
            <MarkdownMessage content={abstract.summaryMd} />
          </MachineText>
          <button
            type="button"
            className={styles.abstractAction}
            onClick={onViewEvidence}
          >
            View evidence
          </button>
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
