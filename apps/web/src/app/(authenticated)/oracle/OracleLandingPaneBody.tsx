"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  FieldFeedback,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import OracleAlephGrid from "./OracleAlephGrid";
import OracleThemeWrapper from "./OracleThemeWrapper";
import type { OracleCreateResponse } from "./types";
import styles from "./oracle.module.css";

const QUESTION_MAX = 280;

export default function OracleLandingPaneBody() {
  const paneRouter = usePaneRouter();

  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FeedbackContent | null>(null);
  // Pane bodies are lazy chunks: on a cold load the Suspense boundary suspends and
  // remounts at hydration, so an SSR-visible controlled textarea filled before the
  // chunk lands would have its value stranded/reset. Keep the input inert until this
  // instance is truly mounted (the SearchPaneBody idiom) — a typed value can only
  // land on the live, hydrated instance, and its onChange keeps the controlled state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

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
          headers: { "Idempotency-Key": createRandomId("oracle-read") },
          body: JSON.stringify({ question: cleaned }),
        });
        paneRouter.push(`/oracle/${body.data.reading_id}`);
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        setSubmitError(
          toFeedback(error, {
            fallback: "The oracle could not begin a reading. Please try again.",
          }),
        );
        setSubmitting(false);
      }
    },
    [question, paneRouter],
  );

  const remaining = QUESTION_MAX - question.length;

  return (
    <OracleThemeWrapper>
      <div className={styles.surface}>
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
              disabled={submitting || !mounted}
              aria-label="Oracle question"
            />
            <div className={styles.askMeta}>
              <span className={styles.askCount} aria-live="polite">
                {remaining} remaining
              </span>
              <button
                type="submit"
                className={styles.askSubmit}
                disabled={submitting || !mounted || question.trim().length === 0}
              >
                {submitting ? "Consulting…" : "Consult the oracle"}
              </button>
            </div>
            <FieldFeedback feedback={submitError} />
          </form>

          <OracleAlephGrid />

          <Link className={styles.atlasLink} href="/atlas?layer=readings">
            ✦ View as a sky
          </Link>
        </div>
      </div>
    </OracleThemeWrapper>
  );
}
