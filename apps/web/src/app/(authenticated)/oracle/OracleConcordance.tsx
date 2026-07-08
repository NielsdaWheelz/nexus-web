"use client";

import { usePaneRouter } from "@/lib/panes/paneRuntime";
import { useResource } from "@/lib/api/useResource";
import { toRoman } from "@/lib/toRoman";
import styles from "./oracle.module.css";

function FleuronBreak() {
  return (
    <div className={styles.fleuronBreak} aria-hidden="true">
      <span className={styles.fleuronBreakGlyph}>❦</span>
    </div>
  );
}

interface ConcordanceEntry {
  id: string;
  folio_number: number;
  folio_motto: string;
  folio_theme: string | null;
  shared_plate: boolean;
  shared_theme: boolean;
  shared_passage_count: number;
}

function shareReasonText(entry: ConcordanceEntry): string {
  const parts: string[] = [];
  if (entry.shared_plate) parts.push("shared plate");
  if (entry.shared_theme) parts.push("shared theme");
  if (entry.shared_passage_count > 0)
    parts.push(
      entry.shared_passage_count === 1
        ? "1 shared passage"
        : `${entry.shared_passage_count} shared passages`,
    );
  return parts.join(" · ");
}

export default function OracleConcordance({
  readingId,
  status,
}: {
  readingId: string;
  status: string;
}) {
  const paneRouter = usePaneRouter();
  if (status !== "complete") return null;

  return (
    <OracleConcordanceEntries
      key={readingId}
      readingId={readingId}
      onOpen={(id) => paneRouter.push(`/oracle/${id}`)}
    />
  );
}

function OracleConcordanceEntries({
  readingId,
  onOpen,
}: {
  readingId: string;
  onOpen: (id: string) => void;
}) {
  const concordanceResource = useResource<{ data: ConcordanceEntry[] }>({
    cacheKey: readingId,
    path: (id) => `/api/oracle/readings/${id}/concordance`,
  });
  const entries =
    concordanceResource.status === "ready" ? concordanceResource.data.data : null;
  if (entries === null || entries.length === 0) return null;

  return (
    <>
    <FleuronBreak />
    <aside className={styles.concordance}>
      <p className={styles.omensLabel}>Concordance</p>
      <ul className={styles.concordanceList}>
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={styles.concordanceItem}
              onClick={() => onOpen(entry.id)}
            >
              <span>Folio {toRoman(entry.folio_number)} · {entry.folio_theme ?? "—"}</span>
              <span className={styles.concordanceMotto}>{entry.folio_motto}</span>
              <span className={styles.concordanceShareReason}>{shareReasonText(entry)}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
    </>
  );
}
