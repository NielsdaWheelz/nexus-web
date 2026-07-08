"use client";

import { usePaneRouter } from "@/lib/panes/paneRuntime";
import { FeedbackNotice, toFeedback } from "@/components/feedback/Feedback";
import { useResource } from "@/lib/api/useResource";
import MediaImage from "@/components/ui/MediaImage";
import { requireOraclePlateImageSrc } from "@/lib/media/oraclePlateImage";
import { toRoman } from "@/lib/toRoman";
import styles from "./oracle.module.css";

interface OracleSummary {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_theme: string | null;
  plate_thumbnail_url: string | null;
  plate_alt_text: string | null;
  question_text: string;
  status: string;
}

export default function OracleAlephGrid() {
  const paneRouter = usePaneRouter();
  const readingsResource = useResource<{ data: OracleSummary[] }>({
    cacheKey: "oracle-readings",
    path: () => "/api/oracle/readings",
  });

  if (readingsResource.status === "error") {
    return (
      <FeedbackNotice
        feedback={toFeedback(readingsResource.error, {
          fallback: "The Aleph could not be loaded.",
        })}
        className={styles.oracleFeedback}
      />
    );
  }

  const readings = readingsResource.status === "ready" ? readingsResource.data.data : null;

  if (readings === null || readings.length === 0) return null;

  return (
    <div className={styles.alephGrid}>
      {readings.map((row) => {
        const failed = row.status === "failed";
        const pending = row.status === "pending" || row.status === "streaming";
        const motto = row.folio_motto ?? "……";

        if (failed) {
          return (
            <div
              key={row.id}
              className={`${styles.alephCell} ${styles.alephCellFailed}`}
              aria-label={`Folio ${toRoman(row.folio_number)} — failed`}
            >
              <span className={styles.alephCellNumber}>{toRoman(row.folio_number)}</span>
              <span className={styles.alephCellMotto} aria-hidden="true">……</span>
            </div>
          );
        }

        const plateSrc =
          !pending && row.plate_thumbnail_url !== null
            ? requireOraclePlateImageSrc(row.plate_thumbnail_url)
            : null;

        return (
          <button
            key={row.id}
            type="button"
            className={`${styles.alephCell}${pending ? ` ${styles.alephCellPending}` : ""}`}
            onClick={() => paneRouter.push(`/oracle/${row.id}`)}
            aria-label={`Folio ${toRoman(row.folio_number)}: ${motto}`}
          >
            {plateSrc !== null && (
              <MediaImage
                kind="owned"
                src={plateSrc}
                alt={row.plate_alt_text ?? ""}
                fill
                sizes="(max-width: 768px) 50vw, 25vw"
                className={styles.alephThumbnail}
              />
            )}
            {pending && (
              <span className={styles.alephCellPendingGlyph} aria-hidden="true">🜔</span>
            )}
            <span className={styles.alephCellNumber}>{toRoman(row.folio_number)}</span>
            <span className={styles.alephCellMotto}>{motto}</span>
          </button>
        );
      })}
    </div>
  );
}
