"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import MediaImage from "@/components/ui/MediaImage";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
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
import { openAsyncResult } from "@/lib/panes/openResult";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { toRoman } from "@/lib/toRoman";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { OracleTheme } from "./ornaments";
import styles from "./oracle.module.css";

export default function OracleLandingPaneBody() {
  const pane = requirePaneRuntime(
    usePaneRuntime(),
    "OracleLandingPaneBody",
  );
  const { ctx } = useActionRuntime();
  const live = useRef(false);
  const attempt = useRef<{ id: string; question: string; openIntent: OpenIntent } | null>(null);
  usePaneReturnReady(true);
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const errorId = useId();
  // Pane bodies are lazy chunks that remount at hydration: keep the textarea inert
  // until this instance is mounted, so a typed value cannot land on a discarded one.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); live.current = true; return () => { live.current = false; }; }, []);
  const readings = usePaneFreeServerValue({
    key: "oracle-readings",
    stale: "",
    load: (signal) =>
      apiFetch<ApiJson<"/oracle/readings", "get">>("/api/oracle/readings", {
        signal,
      }),
  });

  const length = questionLength(question);
  const submit = async (intent: OpenIntent) => {
    if (submitting || length === 0 || length > QUESTION_MAX || !live.current) return;
    const prior = attempt.current;
    const frozen = prior?.question === question
      ? { ...prior, openIntent: intent === "new_pane" ? intent : prior.openIntent }
      : { id: crypto.randomUUID(), question, openIntent: intent };
    attempt.current = frozen;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await openAsyncResult({
        ctx, originPaneId: pane.paneId, intent: frozen.openIntent, subject: frozen.question,
        create: async () => {
          const readingId = await createReading({ id: frozen.id, question: frozen.question });
          if (live.current) attempt.current = null;
          return { target: { href: `/oracle/${readingId}` }, title: "reading started", openLabel: "open reading" };
        },
      });
    } catch (error) {
      if (!live.current || ctx.sessionSignal().aborted) return;
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setSubmitError(failureCopy(error, "The reading couldn’t begin"));
      } catch (caught) {
        setDefect({ error: caught });
      }
    } finally { if (live.current) setSubmitting(false); }
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") {
      event.preventDefault();
      void submit(activation.intent);
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
          <form className={styles.askForm} onSubmit={event => { event.preventDefault(); void submit("default"); }}>
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
                onClick={submitGesture}
                onKeyDown={submitGesture}
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

          {readings.status === "failed" ? (
            <FeedbackNotice
              content={failureCopy(
                readings.error,
                "The Aleph couldn’t be loaded",
              )}
              announcement="Assertive"
              actions={[{ label: "retry", onClick: readings.refetch, busy: readings.retrying }]}
            />
          ) : (
            readings.status === "ready" &&
            readings.data.data.length > 0 && (
              <div className={styles.aleph}>
                {readings.data.data.map((reading) => {
                  const folio = `Folio ${toRoman(reading.folio_number)}`;
                  return (
                    <a
                      key={reading.id}
                      href={`/oracle/${reading.id}`}
                      className={styles.alephCell}
                      data-status={reading.status}
                      aria-label={
                        reading.status === "failed"
                          ? `${folio} — failed`
                          : `${folio}: ${reading.folio_motto ?? "……"}`
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
                    </a>
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
