"use client";

import { useEffect, useRef } from "react";
import { Ruling } from "@/components/feedback/Ruling";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { useActiveRegion, type Line } from "@/components/feedback/stage";
import MediaImage from "@/components/ui/MediaImage";
import ReaderCitation from "@/components/ui/ReaderCitation";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { openAsyncResult } from "@/lib/panes/openResult";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

import {
  createReading,
  platePath,
  type OracleReading,
} from "@/lib/oracle/oracle";
import {
  requirePaneRuntime,
  usePaneParam,
  usePaneIsPresented,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { WORK_OBSERVATION_MS } from "@/lib/api/observationPolicy";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { toRoman } from "@/lib/toRoman";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import {
  BorderFrame,
  FleuronBreak,
  IlluminatedCapital,
  OracleTheme,
  Sidenote,
} from "../ornaments";
import styles from "../oracle.module.css";

const PHASE_LABEL = {
  descent: "I. The Descent",
  ordeal: "II. The Ordeal",
  ascent: "III. The Ascent",
} as const;

const UNFINISHED = "this reading didn’t finish.";
/** A failed reading's line, by its code: only what its owner classifies. */
function failureLine(code: Schema<"OracleFailureCode">): Line {
  switch (code) {
    case "cancelled": return { fact: "this reading stopped." };
    case "auth":
    case "quota":
    case "runtime_unavailable": return { fact: UNFINISHED, reason: "the model wasn’t available." };
    case "timeout": return { fact: UNFINISHED, reason: "it ran out of time." };
    case "output_limit": return { fact: UNFINISHED, reason: "it ran too long." };
    case "context_too_large": return { fact: UNFINISHED, reason: "its sources were too long for the model." };
    case "invalid_output":
    case "policy_violation": return { fact: UNFINISHED };
    case "E_ORACLE_CORPUS_NOT_READY":
    case "E_APP_SEARCH_FAILED": return { fact: UNFINISHED, reason: "its source passages weren’t ready." };
    case "E_GENERATION_SOURCE_CHANGED": return { fact: UNFINISHED, reason: "a passage it cited was removed." };
  }
}

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
];

/** "twenty-first of March, MMXXVI" */
function colophonDate(iso: string): string {
  const date = new Date(iso);
  const day = date.getUTCDate();
  const tens = day < 30 ? "twenty" : "thirty";
  const ordinal =
    day < 20
      ? ORDINALS[day - 1]
      : day % 10 === 0
        ? `${tens.slice(0, -1)}ieth`
        : `${tens}-${ORDINALS[(day % 10) - 1]}`;
  const month = date.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return `${ordinal} of ${month}, ${toRoman(date.getUTCFullYear())}`;
}

export default function OracleReadingPaneBody() {
  const readingId = usePaneParam("readingId");
  if (!readingId)
    throw new Error("OracleReadingPaneBody: readingId is required");
  const pane = requirePaneRuntime(usePaneRuntime(), "OracleReadingPaneBody");
  const { ctx } = useActionRuntime();
  const live = useRef(false);
  const retryDraft = useResourceDraft<{
    attempt: { id: string; question: string; openIntent: OpenIntent } | null;
    retrying: boolean;
    unknown: { id: string; attempt: number } | null;
  }>(`Oracle.Retry:${readingId}`, () => ({ attempt: null, retrying: false, unknown: null }),
    value => ({ changed: false, unconfirmed: value.attempt !== null, stopsBrowserWork: false }));
  const { retrying, unknown } = retryDraft.value;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const observing = useObservationDemand(usePaneIsPresented());
  const foreground = useRefreshStamp(observing, 0);
  const speak = useActiveRegion();
  const unfinishedSeen = useRef<string | null>(null);
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const detail = usePaneFreeServerValue<OracleReading>({
    key: `/oracle/readings/${readingId}`,
    enabled: observing,
    stale: String(foreground),
    load: async (signal) =>
      (
        await apiFetch<ApiJson<"/oracle/readings/{reading_id}", "get">>(
          `/api/oracle/readings/${readingId}`,
          { signal },
        )
      ).data,
  });
  const loaded =
    detail.status === "ready" && detail.data.id === readingId
      ? detail.data
      : null;
  const reading = loaded;
  const unfinished = reading?.status === "pending" || reading?.status === "streaming";
  if (unfinished) unfinishedSeen.current = reading.id;
  // justify-polling: oracle publishes prose at completion; its finite detail
  // read follows unfinished work while presented, without a passive stream.
  useIntervalPoll({ enabled: observing && unfinished && detail.status === "ready" && detail.error === null,
    pollIntervalMs: WORK_OBSERVATION_MS, onPoll: () => detail.refetch().catch(() => { /* The read owner retains its failure. */ }) });

  const concordance = usePaneFreeServerValue({
    key: reading?.status === "complete" ? `concordance:${reading.id}` : null,
    enabled: observing,
    stale: "",
    load: (signal) =>
      apiFetch<ApiJson<"/oracle/readings/{reading_id}/concordance", "get">>(
        `/api/oracle/readings/${readingId}/concordance`,
        { signal },
      ),
  });

  usePaneReturnReady(reading !== null || detail.status === "failed");
  usePaneChrome({
    resourceRef:
      reading === null
        ? undefined
        : canonicalResourceRef({ scheme: "oracle_reading", id: readingId }),
  });
  const reload = () => detail.refetch();
  const retryReading = async (intent: OpenIntent) => {
    const current = retryDraft.read();
    if (reading === null || current.retrying) return;
    const frozen = current.attempt === null
      ? { id: crypto.randomUUID(), question: reading.question_text, openIntent: intent }
      : { ...current.attempt, openIntent: intent === "new_pane" ? intent : current.attempt.openIntent };
    retryDraft.set(value => ({ ...value, attempt: frozen, retrying: true }));
    try {
      await openAsyncResult({
        ctx, originPaneId: pane.paneId, intent: frozen.openIntent, subject: frozen.question,
        create: async () => {
          const next = await createReading({ id: frozen.id, question: frozen.question });
          if (!ctx.sessionSignal().aborted) retryDraft.set(value => ({ ...value, attempt: null, unknown: null }));
          return { target: { href: `/oracle/${next}` }, title: "reading started", openLabel: "open reading" };
        },
      });
    } catch (error) {
      if (ctx.sessionSignal().aborted) return;
      if (handleUnauthenticatedApiError(error)) return;
      // the frozen attempt keeps its id until one lands, and the first creation wins, so any retry
      // resends it. a refusal changed nothing and leaves an earlier unknown send held; anything else
      // a send meets leaves its own outcome unknown. fail rethrows a defect.
      if (!isApiError(error) || isSameSystemApiDefect(error)) fail(error, "couldn’t start a new reading.");
      else if (isRefusal(error) && retryDraft.read().unknown === null) {
        retryDraft.set(value => ({ ...value, attempt: null }));
        if (live.current) fail(error, "couldn’t start a new reading.", { label: "retry", commandKey: `read again ${readingId}`, run: intent => void retryReading(intent) });
      } else retryDraft.set(value => ({ ...value, unknown: { id: frozen.id, attempt: (value.unknown?.id === frozen.id ? value.unknown.attempt : 0) + 1 } }));
    } finally { if (!ctx.sessionSignal().aborted) retryDraft.set(value => ({ ...value, retrying: false })); }
  };
  const retryVerb = { label: "retry", commandKey: `read again ${readingId}`, busy: retrying, run: (intent: OpenIntent) => void retryReading(intent) };
  const recovery = unknown ? resendFeedback({ line: { fact: "not sure the reading started.", reason: UNKNOWN_OUTCOME_REASON }, resend: retryVerb }) : null;
  const paragraphs = reading?.interpretation_text?.split(/\n\n+/) ?? [];
  const peers = concordance.status === "ready" ? concordance.data.data : [];
  return (
    <OracleTheme>
      <div className={styles.surface}>
        <article className={styles.reading}>
          <BorderFrame />
          <header className={styles.readingHeader}>
            <div className={styles.folioLine}>
              <span className={styles.folioNumber}>
                {reading ? `Folio ${toRoman(reading.folio_number)}` : "Folio"}
              </span>
              <span className={styles.gold}>·</span>
              <span className={styles.folioTheme}>
                {reading?.folio_theme ?? ""}
              </span>
            </div>
            {reading?.folio_motto && (
              <div className={styles.motto}>{reading.folio_motto}</div>
            )}
            {reading?.folio_motto_gloss && (
              <div className={styles.gloss}>{reading.folio_motto_gloss}</div>
            )}
            {/* The question is the folio's subject; the argument answers it. */}
            <h2 className={styles.question}>{reading?.question_text ?? "…"}</h2>
            {reading?.argument_text && (
              <p className={styles.argument}>{reading.argument_text}</p>
            )}
          </header>

          {reading?.plate && (
            <figure className={styles.plate}>
              <MediaImage
                kind="static"
                src={platePath(reading.plate)}
                alt={`${reading.plate.artist}, ${reading.plate.work_title}`}
                width={reading.plate.width}
                height={reading.plate.height}
                className={styles.plateImage}
                priority
                sizes="(min-width: 768px) 36rem, 100vw"
              />
              <figcaption className={styles.caption}>
                {reading.plate.attribution}
              </figcaption>
            </figure>
          )}

          {/* streaming is history: skeletons until a passage */}
          {(reading?.status === "pending" ||
            (reading?.status === "streaming" &&
              reading.passages.length === 0)) && (
            <div className={styles.skeletons} aria-hidden="true">
              <div className={styles.skeletonPlate} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
            </div>
          )}

          {reading?.passages.map((passage, index) => (
            <div key={passage.phase}>
              {index > 0 && <FleuronBreak />}
              <section className={styles.phase}>
                <p className={styles.phaseLabel}>
                  {PHASE_LABEL[passage.phase]}
                </p>
                <div className={styles.passage}>
                  <blockquote className={styles.quote}>
                    <p>{passage.quote}</p>
                  </blockquote>
                  <p className={styles.attribution}>
                    {passage.attribution}{" "}
                    <span className={styles.locator}>
                      {passage.locator_label}
                    </span>
                    {passage.citation !== null && (
                      <span className={styles.citation}>
                        <ReaderCitation
                          {...passage.citation}
                        />
                      </span>
                    )}
                  </p>
                  <Sidenote>
                    <p>{passage.marginalia}</p>
                  </Sidenote>
                </div>
              </section>
            </div>
          ))}

          {paragraphs.length > 0 && (
            <>
              <FleuronBreak />
              <section className={styles.interpretation}>
                {paragraphs.map((paragraph, index) =>
                  index === 0 ? (
                    <p key={index}>
                      <IlluminatedCapital
                        letter={paragraph.charAt(0)}
                        seed={reading?.question_text ?? ""}
                      />
                      {paragraph.slice(1)}
                    </p>
                  ) : (
                    <p key={index}>{paragraph}</p>
                  ),
                )}
              </section>
            </>
          )}

          {reading !== null && reading.omens.length > 0 && (
            <>
              <FleuronBreak />
              <section className={styles.omens}>
                <p className={styles.smallCaps}>Omens</p>
                <ul>
                  {reading.omens.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {peers.length > 0 && (
            <>
              <FleuronBreak />
              <aside className={styles.concordance}>
                <p className={styles.smallCaps}>Concordance</p>
                <ul>
                  {peers.map((peer) => (
                    <li key={peer.id}>
                      <a
                        href={`/oracle/${peer.id}`}
                        className={styles.concordanceItem}
                      >
                        <span>
                          Folio {toRoman(peer.folio_number)} ·{" "}
                          {peer.folio_theme}
                        </span>
                        <span>{peer.folio_motto}</span>
                        <span className={styles.shareReason}>
                          {[
                            peer.shared_plate && "shared plate",
                            peer.shared_theme && "shared theme",
                            peer.shared_passage_count > 0 &&
                              `${peer.shared_passage_count} shared passage${peer.shared_passage_count === 1 ? "" : "s"}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </aside>
            </>
          )}

          {reading?.status === "complete" && (
            <>
              <FleuronBreak />
              <p className={styles.colophon}>
                Composed on the {colophonDate(reading.created_at)}.
                {reading.plate && ` Plate after ${reading.plate.artist}.`} Set
                in EB Garamond, IM Fell English, and UnifrakturMaguntia.
              </p>
            </>
          )}

          {reading?.status === "failed" && reading.error_code !== null && (
            <section className={styles.errorPanel}>
              {/* A newly observed terminal failure is news; a cold result is not. */}
              <Fact speak={speak && unfinishedSeen.current === reading.id} line={failureLine(reading.error_code)}
                verbs={recovery ? recovery.verbs ?? undefined : [retryVerb]} />
              {unknown && recovery ? <Hold id={unknown.id} attempt={unknown.attempt} {...recovery} /> : null}
            </section>
          )}

          {reading === null && detail.status === "loading" ? <Ruling /> : null}
          {detail.status === "failed" ? detail.error.code === "E_NOT_FOUND" ? <Fact line={{ fact: "this reading doesn’t exist." }} />
            : <Failed error={detail.error} noun="readings" retry={{ run: reload, busy: detail.retrying }} />
            : detail.status === "ready" && detail.error !== null
              ? <Failed error={detail.error} noun="the updated reading" retry={{ run: reload, busy: detail.refreshing }} /> : null}
        </article>
      </div>
    </OracleTheme>
  );
}
