"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
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

function toRoman(n: number): string {
  const lookup: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = n;
  let out = "";
  for (const [value, symbol] of lookup) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

export default function OracleAlephGrid() {
  const router = useRouter();
  const [readings, setReadings] = useState<OracleSummary[] | null>(null);
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ data: OracleSummary[] }>("/api/oracle/readings")
      .then((body) => {
        if (active) setReadings(body.data);
      })
      .catch((error) => {
        if (active)
          setLoadError(toFeedback(error, { fallback: "The Aleph could not be loaded." }));
      });
    return () => {
      active = false;
    };
  }, []);

  if (loadError !== null) {
    return <FeedbackNotice feedback={loadError} className={styles.oracleFeedback} />;
  }

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

        return (
          <button
            key={row.id}
            type="button"
            className={`${styles.alephCell}${pending ? ` ${styles.alephCellPending}` : ""}`}
            onClick={() => router.push(`/oracle/${row.id}`)}
            aria-label={`Folio ${toRoman(row.folio_number)}: ${motto}`}
          >
            {!pending && row.plate_thumbnail_url !== null && (
              <Image
                src={row.plate_thumbnail_url}
                alt={row.plate_alt_text ?? ""}
                fill
                sizes="140px"
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
