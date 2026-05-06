"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
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
  const router = useRouter();
  const [entries, setEntries] = useState<ConcordanceEntry[] | null>(null);

  useEffect(() => {
    if (status !== "complete") return;
    let active = true;
    apiFetch<{ data: ConcordanceEntry[] }>(
      `/api/oracle/readings/${readingId}/concordance`,
    )
      .then((body) => {
        if (active) setEntries(body.data);
      })
      .catch(() => {
        // concordance is supplementary — silently suppress errors
      });
    return () => {
      active = false;
    };
  }, [readingId, status]);

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
              onClick={() => router.push(`/oracle/${entry.id}`)}
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
