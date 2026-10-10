// The oracle transport: ask, and follow one reading until it leaves pending.
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { sseClientDirect } from "@/lib/api/sse-client";
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

/** One press is one key; the server trims. Resolves to the new reading's id. */
export async function createReading(question: string): Promise<string> {
  const body = await apiFetch<ApiJson<"/oracle/readings", "post">>(
    "/api/oracle/readings",
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ question }),
    },
  );
  return body.data.reading_id;
}

/**
 * Each frame is the whole reading; the last one is complete or failed. A reading
 * that is gone, or a stream that stays down, is reported once as lost.
 */
export function watchReading(
  id: string,
  onState: (reading: OracleReading) => void,
  onLost: () => void,
): () => void {
  return sseClientDirect<OracleReading, OracleReading>({
    path: `/stream/oracle-readings/${encodeURIComponent(id)}/events`,
    decode: (type, reading) => {
      if (type !== "state" && type !== "done")
        throw new Error(`Unknown SSE event type: ${type}`);
      return reading;
    },
    isTerminal: (reading) =>
      reading.status === "complete" || reading.status === "failed",
    onEvent: onState,
    onError: onLost,
  });
}

/** A lost connection or a missing reading is a modeled failure; anything else is a defect. */
export function failureCopy(error: unknown, title: string): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const message =
    error.code === "E_NETWORK"
      ? "Check your connection and retry."
      : error.code === "E_NOT_FOUND"
        ? "This reading is no longer available."
        : null;
  if (message === null) throw error;
  return { tone: "Danger", title, message, requestId: error.requestId };
}
