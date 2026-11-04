// The oracle transport: ask, and follow one reading until it leaves pending.

import { apiFetch } from "@/lib/api/client";
import { openStream } from "@/lib/api/stream";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type OracleReading = Schema<"OracleReadingOut">;
export type OracleReadingSummary = Schema<"OracleReadingSummaryOut">;
export type OraclePlate = Schema<"OraclePlateOut">;

export const QUESTION_MAX = 280;

/**
 * Code points once Unicode White_Space is trimmed from both ends, as the server
 * counts them (String.trim would also strip U+FEFF and keep U+0085).
 */
export function questionLength(question: string): number {
  return Array.from(
    question.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""),
  ).length;
}

/** Plates are static assets; a key never changes its bytes. */
export function platePath(plate: OraclePlate): string {
  return `/oracle-plates/${plate.key}.jpg`;
}

/** A logical attempt keeps its resource id across delivery retries; first creation wins. */
export async function createReading(attempt: { readonly id: string; readonly question: string }): Promise<string> {
  const body = await apiFetch<ApiJson<"/oracle/readings", "post">>(
    "/api/oracle/readings",
    {
      method: "POST",
      body: JSON.stringify(attempt),
    },
  );
  return body.data.reading_id;
}

/**
 * Each frame is the whole reading; the last one is complete or failed. A reading
 * that is gone, or a stream that stays down, is reported once as lost. A stream
 * suspended for admission resumes on its cursor, so it reports nothing.
 */
export function watchReading(
  id: string,
  onState: (reading: OracleReading) => void,
  onLost: (error: Error) => void,
): () => void {
  return openStream<OracleReading, OracleReading>({
    path: `/api/stream/oracle-readings/${encodeURIComponent(id)}/events`,
    decode: (type, reading) => {
      if (type !== "state" && type !== "done")
        throw new Error(`Unknown oracle event type: ${type}`);
      return reading;
    },
    isTerminal: (reading) =>
      reading.status === "complete" || reading.status === "failed",
    onEvent: onState,
    onError: onLost,
    onSuspended: () => {},
  });
}
