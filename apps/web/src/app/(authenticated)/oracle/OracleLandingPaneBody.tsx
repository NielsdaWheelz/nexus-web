"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import MediaImage from "@/components/ui/MediaImage";
import { useResource } from "@/lib/api/useResource";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  QUESTION_MAX,
  createReading,
  failureCopy,
  platePath,
  questionLength,
} from "@/lib/oracle/oracle";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { toRoman } from "@/lib/toRoman";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { OracleTheme } from "./ornaments";
import styles from "./oracle.module.css";

export default function OracleLandingPaneBody() {
  const { activateTarget } = requirePaneRuntime(
    usePaneRuntime(),
    "OracleLandingPaneBody",
  );
  usePaneReturnReady(true);
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const errorId = useId();
  // Pane bodies are lazy chunks that remount at hydration: keep the textarea inert
  // until this instance is mounted, so a typed value cannot land on a discarded one.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const readings = useResource<ApiJson<"/oracle/readings", "get">>({
    cacheKey: "oracle-readings",
    path: () => "/api/oracle/readings",
  });

  const length = questionLength(question);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const readingId = await createReading(question);
      activateTarget({
        target: { href: `/oracle/${readingId}` },
        disposition: { kind: "Follow" },
      });
    } catch (error) {
      setSubmitting(false);
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setSubmitError(failureCopy(error, "The reading couldn’t begin"));
      } catch (caught) {
        setDefect({ error: caught });
      }
    }
  };
  if (defect) throw defect.error;

  return (
    <OracleTheme>
      <div className={styles.surface}>
        <div className={styles.landing}>
          <div className={styles.epigraph}>Black Forest Oracle</div>
          <p className={styles.epigraphSub}>
            Ask one question. The oracle will arrange a plate, three passages,
            and a reading drawn from public-domain literature and your library.
          </p>
          <form className={styles.askForm} onSubmit={submit}>
            <textarea
              className={styles.askInput}
              placeholder="What am I afraid of? What lies on the other side of this threshold?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              disabled={submitting || !mounted}
              aria-label="Oracle question"
              aria-invalid={submitError !== null || undefined}
              aria-describedby={submitError === null ? undefined : errorId}
            />
            <div className={styles.askMeta}>
              <span className={styles.askCount} aria-live="polite">
                {QUESTION_MAX - length} remaining
              </span>
              <button
                type="submit"
                className={styles.button}
                disabled={
                  submitting ||
                  !mounted ||
                  length === 0 ||
                  length > QUESTION_MAX
                }
              >
                {submitting ? "Consulting…" : "Consult the oracle"}
              </button>
            </div>
            <FieldFeedback id={errorId} content={submitError} />
          </form>

          {readings.status === "error" ? (
            <FeedbackNotice
              content={failureCopy(
                readings.error,
                "The Aleph couldn’t be loaded",
              )}
              announcement="Assertive"
            />
          ) : (
            readings.status === "ready" &&
            readings.data.data.length > 0 && (
              <div className={styles.aleph}>
                {readings.data.data.map((reading) => {
                  const folio = `Folio ${toRoman(reading.folio_number)}`;
                  return (
                    <button
                      key={reading.id}
                      type="button"
                      className={styles.alephCell}
                      data-status={reading.status}
                      aria-label={
                        reading.status === "failed"
                          ? `${folio} — failed`
                          : `${folio}: ${reading.folio_motto ?? "……"}`
                      }
                      onClick={(event) =>
                        activateTarget({
                          target: { href: `/oracle/${reading.id}` },
                          disposition:
                            workspaceTargetClickIntent(event).disposition,
                        })
                      }
                    >
                      {reading.plate !== null && (
                        <MediaImage
                          kind="static"
                          src={platePath(reading.plate)}
                          alt={`${reading.plate.work_title} — ${reading.plate.attribution}`}
                          fill
                          sizes="(max-width: 768px) 50vw, 25vw"
                          className={styles.alephThumbnail}
                        />
                      )}
                      {(reading.status === "pending" ||
                        reading.status === "streaming") && (
                        <span className={styles.alephGlyph} aria-hidden="true">
                          🜔
                        </span>
                      )}
                      <span className={styles.alephNumber}>
                        {toRoman(reading.folio_number)}
                      </span>
                      <span className={styles.alephMotto}>
                        {reading.folio_motto ?? "……"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )
          )}

          <Link className={styles.skyLink} href="/atlas?layer=readings">
            ✦ View as a sky
          </Link>
        </div>
      </div>
    </OracleTheme>
  );
}
