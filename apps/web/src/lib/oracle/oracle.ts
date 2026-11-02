// The oracle transport: ask, and follow one reading until it leaves pending.
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
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

/** Until L6's atlas migrates (L7): a failed oracle read as content, its domain code ahead of the
 * transport's line. A defect throws. */
export function failureCopy(error: unknown, title: string): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  if (error.code === "E_NOT_FOUND") return { tone: "Warning", title: "this reading doesn’t exist." };
  const { fact, reason } = TRANSPORT_LINES[transportOf(error)].command(title);
  return { tone: "Warning", title: fact, message: reason };
}
