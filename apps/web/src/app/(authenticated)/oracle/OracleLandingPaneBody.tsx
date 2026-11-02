"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Failed, Field } from "@/components/feedback/Fact";
import { Hold } from "@/components/feedback/Feedback";
import { transportVerbs, type Line, type Verbs } from "@/components/feedback/stage";
import { ControlContents } from "@/components/ui/control";
import MediaImage from "@/components/ui/MediaImage";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { MAY_HAVE } from "@/lib/chat/commands";
import {
  QUESTION_MAX,
  createReading,
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

const UNSTARTED = "couldn’t start the reading.";
type Attempt = { id: string; question: string; openIntent: OpenIntent };

/** Ask and list. A refused question is said beneath the input, where consult is the retry; one
 * whose answer never came is held, and its retry resends the frozen attempt: first creation wins. */
export default function OracleLandingPaneBody() {
  const pane = requirePaneRuntime(
    usePaneRuntime(),
    "OracleLandingPaneBody",
  );
  const { ctx } = useActionRuntime();
  const live = useRef(false);
  const draft = useResourceDraft<{
    question: string; attempt: Attempt | null;
    submitting: boolean;
    /** The last refusal, said beneath the input until the question changes. */
    refused: ApiError | null;
    /** Attempts of `attempt` whose answer never came. */
    unknown: number;
  }>("Oracle.Question", () => ({ question: "", attempt: null, submitting: false, refused: null, unknown: 0 }),
    value => ({ changed: value.question !== "", unconfirmed: value.attempt !== null, stopsBrowserWork: false }));
  const guard = useWorkGuard();
  const { question, submitting, refused, unknown } = draft.value;
  const setQuestion = (question: string) => draft.set(value => ({ ...value, question, refused: null }));
  const setSubmitting = (submitting: boolean) => draft.set(value => ({ ...value, submitting }));
  usePaneReturnReady(true);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const fieldId = useId();
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
  /** One send of an attempt, whose id stays frozen until a send lands. A refusal changed nothing: it
   * drops an attempt none of whose sends went unanswered, and leaves one that may have landed held.
   * Anything else a send meets leaves its outcome unknown. */
  const send = async (frozen: Attempt) => {
    // a new attempt starts with no unknown answer of its own
    draft.set(value => ({ ...value, attempt: frozen, refused: null, unknown: frozen.id === value.attempt?.id ? value.unknown : 0 }));
    setSubmitting(true);
    try {
      await openAsyncResult({
        ctx, originPaneId: pane.paneId, intent: frozen.openIntent, subject: frozen.question,
        create: async () => {
          const readingId = await createReading({ id: frozen.id, question: frozen.question });
          if (!ctx.sessionSignal().aborted) draft.set(value => value.attempt?.id !== frozen.id ? value : ({
            ...value, attempt: null, unknown: 0, question: value.question === frozen.question ? "" : value.question,
          }));
          return { target: { href: `/oracle/${readingId}` }, title: "reading started", openLabel: "open reading" };
        },
      });
    } catch (error) {
      if (ctx.sessionSignal().aborted || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        setDefect({ error });
        return;
      }
      draft.set(value => value.attempt?.id !== frozen.id ? value
        : isRefusal(error) ? { ...value, refused: error, attempt: value.unknown === 0 ? null : value.attempt }
        : { ...value, unknown: value.unknown + 1 });
    } finally { if (!ctx.sessionSignal().aborted) setSubmitting(false); }
  };
  /** Consult asks what the field holds: the held attempt again if it asks the same, else a new one. */
  const submit = (intent: OpenIntent) => {
    if (submitting || length === 0 || length > QUESTION_MAX || !live.current) return;
    const prior = draft.read().attempt;
    if (prior && prior.question !== question && !guard.confirmLoss({ scopes: [], ownerIds: [draft.owner] })) return;
    void send(prior?.question === question
      ? { ...prior, openIntent: intent === "new_pane" ? intent : prior.openIntent }
      : { id: crypto.randomUUID(), question, openIntent: intent });
  };
  /** The held slip's retry resends its frozen attempt, whatever the field holds now. */
  const resend = (intent: OpenIntent) => {
    const held = draft.read().attempt;
    if (submitting || held === null || !live.current) return;
    void send({ ...held, openIntent: intent === "new_pane" ? intent : held.openIntent });
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") {
      event.preventDefault();
      submit(activation.intent);
    }
  };
  if (defect) throw defect.error;
  const transport = refused && transportOf(refused);
  const field: { line: Line; verbs?: Verbs } | null = length > QUESTION_MAX ? { line: { fact: `${length - QUESTION_MAX} characters too long.` } }
    : transport ? { line: TRANSPORT_LINES[transport].command(UNSTARTED), verbs: transportVerbs(transport, { signIn: null }) ?? undefined }
    : null;
  const held = draft.value.attempt;

  return (
    <OracleTheme>
      <div className={styles.surface}>
        <div className={styles.landing}>
          <div className={styles.epigraph}>Black Forest Oracle</div>
          <p className={styles.epigraphSub}>
            Ask one question. The oracle will arrange a plate, three passages,
            and a reading drawn from public-domain literature and your library.
          </p>
          <form className={styles.askForm} onSubmit={event => { event.preventDefault(); submit("default"); }}>
            <textarea
              className={styles.askInput}
              placeholder="What am I afraid of? What lies on the other side of this threshold?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              disabled={submitting || !mounted}
              aria-label="Oracle question"
              aria-invalid={field !== null || undefined}
              aria-describedby={field === null ? undefined : fieldId}
            />
            <div className={styles.askMeta}>
              <span className={styles.askCount}>
                {length > QUESTION_MAX ? null : `${QUESTION_MAX - length} left`}
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
                aria-busy={submitting || undefined}
              >
                <ControlContents busy={submitting}>Consult the oracle</ControlContents>
              </button>
            </div>
            {field ? <Field id={fieldId} line={field.line} verbs={field.verbs} /> : null}
          </form>
          {held && unknown > 0 ? <Hold id={held.id} attempt={unknown} line={{ fact: "not sure the reading started.", reason: MAY_HAVE }}
            verbs={[{ label: "retry", commandKey: `ask ${held.id}`, busy: submitting, run: resend }]} /> : null}

          {readings.status === "failed" ? (
            <Failed error={readings.error} noun="readings" retry={{ run: () => void readings.refetch(), busy: readings.retrying }} />
          ) : null}
          {readings.status === "ready" &&
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
                          ? `${folio}, unfinished`
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
          }

          {/* Shared pane anchors are handled by the containing host. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className={styles.skyLink} href="/atlas?layer=readings">
            ✦ View as a sky
          </a>
        </div>
      </div>
    </OracleTheme>
  );
}
