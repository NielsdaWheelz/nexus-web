"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FeedbackNotice,
  FieldFeedback,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./oracle.module.css";

interface OracleSummary {
  id: string;
  folio_number: number;
  folio_title: string | null;
  question_text: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  failed_at: string | null;
}

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

export default function OracleLandingPaneBody() {
  const paneRuntime = usePaneRuntime();

  const [recent, setRecent] = useState<OracleSummary[] | null>(null);
  const [recentError, setRecentError] = useState<FeedbackContent | null>(null);
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ data: OracleSummary[] }>("/api/oracle/readings")
      .then((body) => {
        if (active) setRecent(body.data);
      })
      .catch((error) => {
        if (!active) return;
        setRecentError(
          toFeedback(error, { fallback: "Recent readings could not be loaded." }),
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const navigateTo = useCallback(
    (href: string) => {
      if (paneRuntime) {
        paneRuntime.router.push(href);
      } else {
        window.location.assign(href);
      }
    },
    [paneRuntime],
  );

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
        navigateTo(`/oracle/${body.data.reading_id}`);
      } catch (error) {
        setSubmitError(
          toFeedback(error, {
            fallback: "The oracle could not begin a reading. Please try again.",
          }),
        );
        setSubmitting(false);
      }
    },
    [question, navigateTo],
  );

  const openReading = useCallback(
    (id: string) => {
      navigateTo(`/oracle/${id}`);
    },
    [navigateTo],
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

        <section className={styles.recent}>
          <h2 className={styles.recentTitle}>Recent readings</h2>
          {recentError !== null && (
            <FeedbackNotice feedback={recentError} className={styles.oracleFeedback} />
          )}
          {recent !== null && recent.length === 0 && (
            <p className={styles.recentEmpty}>No prior readings yet.</p>
          )}
          {recent !== null && recent.length > 0 && (
            <ul className={styles.recentList}>
              {recent.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={styles.recentItem}
                    onClick={() => openReading(row.id)}
                  >
                    <span className={styles.recentMain}>
                      <span className={styles.recentFolio}>
                        <span className={styles.recentFolioNumber}>
                          Folio {toRoman(row.folio_number)}
                        </span>
                        <span className={styles.recentFolioDot}>·</span>
                        {row.folio_title !== null && row.folio_title.length > 0 ? (
                          <span className={styles.recentFolioTitle}>
                            {row.folio_title}
                          </span>
                        ) : (
                          <span className={styles.recentFolioTitlePending}>……</span>
                        )}
                      </span>
                      <span className={styles.recentQuestionLine}>
                        {row.question_text}
                      </span>
                    </span>
                    <span className={styles.recentStatus}>{row.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
