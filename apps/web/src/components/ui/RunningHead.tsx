"use client";

import { formatFolio, type Folio } from "@/lib/ui/folio";
import styles from "./RunningHead.module.css";

interface RunningHeadProps {
  standingHead: string; // section, rendered uppercase small-caps by CSS
  folio?: Folio; // flush-right; defaults to { kind: "none" }
  folioPending?: boolean; // skeleton while the count/title resolves
}

const NONE_FOLIO: Folio = { kind: "none" };

/**
 * RunningHead — the hairline periodical furniture at the top of a pane: the
 * section standing head flush-left, a typed folio flush-right. Domain-free: it
 * receives a resolved string + a typed Folio and imports no route/workspace/API
 * layer, so the primitive boundary stays intact. The `<h1>` for the page lives
 * in SectionOpener / the reader body — the standing head is a `<p>` label.
 */
export default function RunningHead({
  standingHead,
  folio = NONE_FOLIO,
  folioPending = false,
}: RunningHeadProps) {
  const folioText = formatFolio(folio);

  return (
    <div className={styles.runningHead} data-running-head="true">
      <p className={styles.standing}>{standingHead}</p>
      {folioPending ? (
        <span className={styles.folio} aria-busy="true">
          <span className={styles.folioSkeleton} aria-hidden="true" />
          <span className="sr-only">Loading…</span>
        </span>
      ) : folioText ? (
        <span className={styles.folio}>{folioText}</span>
      ) : null}
    </div>
  );
}
