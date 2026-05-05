"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  FieldFeedback,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import OracleAlephGrid from "./OracleAlephGrid";
import styles from "./oracle.module.css";

interface OracleCreateResponse {
  reading_id: string;
  folio_number: number;
  status: string;
  stream: {
    token: string;
    stream_base_url: string;
    event_url: string;
    expires_at: string;
  };
}

const QUESTION_MAX = 280;

export default function OracleLandingPaneBody() {
  const router = useRouter();

  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FeedbackContent | null>(null);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const cleaned = question.trim();
      if (cleaned.length === 0 || cleaned.length > QUESTION_MAX) {
        setSubmitError({
          severity: "error",
          title:
            cleaned.length === 0
              ? "Ask one question."
              : `Question must be ${QUESTION_MAX} characters or fewer.`,
        });
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const body = await apiFetch<{ data: OracleCreateResponse }>("/api/oracle/readings", {
          method: "POST",
          body: JSON.stringify({ question: cleaned }),
        });
        router.push(`/oracle/${body.data.reading_id}`);
      } catch (error) {
        setSubmitError(
          toFeedback(error, {
            fallback: "The oracle could not begin a reading. Please try again.",
          }),
        );
        setSubmitting(false);
      }
    },
    [question, router],
  );

  const remaining = QUESTION_MAX - question.length;

  return (
    <div data-theme="oracle" className={styles.surface}>
      <div className={styles.landing}>
        <div className={styles.epigraph}>Black Forest Oracle</div>
        <p className={styles.epigraphSub}>
          Ask one question. The oracle will arrange a plate, three passages,
          and a reading drawn from public-domain literature and your library.
        </p>

        <form className={styles.askForm} onSubmit={handleSubmit}>
          <textarea
            className={styles.askInput}
            placeholder="What am I afraid of? What lies on the other side of this threshold?"
            maxLength={QUESTION_MAX}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            disabled={submitting}
            aria-label="Oracle question"
          />
          <div className={styles.askMeta}>
            <span className={styles.askCount} aria-live="polite">
              {remaining} remaining
            </span>
            <button
              type="submit"
              className={styles.askSubmit}
              disabled={submitting || question.trim().length === 0}
            >
              {submitting ? "Consulting…" : "Consult the oracle"}
            </button>
          </div>
          <FieldFeedback feedback={submitError} />
        </form>

        <OracleAlephGrid />
      </div>
    </div>
  );
}
