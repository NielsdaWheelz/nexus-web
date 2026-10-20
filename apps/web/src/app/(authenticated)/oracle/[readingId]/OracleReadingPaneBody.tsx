"use client";

import { useResourceComposer } from "@/components/resources/ResourceDisclosure";

import { useEffect, useRef, useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import MediaImage from "@/components/ui/MediaImage";
import ReaderCitation from "@/components/ui/ReaderCitation";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { openAsyncResult } from "@/lib/panes/openResult";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  createReading,
  failureCopy,
  platePath,
  watchReading,
  type OracleReading,
} from "@/lib/oracle/oracle";
import {
  requirePaneRuntime,
  usePaneParam,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import {
  toReaderCitationData,
} from "@/lib/resourceGraph/citations";
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

const RETRY_LATER = "Please try again later.";
const START_AGAIN = "Please start a new reading.";
const FAILURE_COPY: Record<Schema<"OracleFailureCode">, string> = {
  auth: `The reading service could not authenticate. ${RETRY_LATER}`,
  quota: `The reading service has reached its usage limit. ${RETRY_LATER}`,
  timeout: `The reading took too long to complete. ${START_AGAIN}`,
  output_limit: `The reading was too long to complete. ${START_AGAIN}`,
  invalid_output: `The reading could not be completed. ${START_AGAIN}`,
  policy_violation: `The reading could not be completed. ${START_AGAIN}`,
  runtime_unavailable: `The reading service is temporarily unavailable. ${RETRY_LATER}`,
  context_too_large:
    "The reading could not be completed. Start a new reading with a simpler question.",
  cancelled: "Start a new reading when you’re ready.",
  E_ORACLE_CORPUS_NOT_READY:
    "The oracle’s source material is not ready. Start a new reading later.",
  E_APP_SEARCH_FAILED:
    "The oracle’s source material is not ready. Start a new reading later.",
  E_GENERATION_SOURCE_CHANGED: "Start a new reading from the current material.",
};

function failureFeedback(code: Schema<"OracleFailureCode">): FeedbackContent {
  const title =
    code === "cancelled"
      ? "The reading was cancelled."
      : code === "E_GENERATION_SOURCE_CHANGED"
        ? "The source material changed."
        : "The reading could not finish.";
  return { tone: "Danger", title, message: FAILURE_COPY[code] };
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
  const attempt = useRef<{ id: string; question: string; openIntent: OpenIntent } | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [loads, setLoads] = useState(0);
  // Stream frames replace the loaded reading; each frame is the whole reading.
  const [streamed, setStreamed] = useState<OracleReading | null>(null);
  const [lost, setLost] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const detail = usePaneFreeServerValue<OracleReading>({
    key: readingId,
    stale: "",
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
  const reading = streamed?.id === readingId ? streamed : loaded;
  const unfinishedId =
    reading?.status === "pending" || reading?.status === "streaming"
      ? reading.id
      : null;

  useEffect(() => {
    if (unfinishedId === null) return;
    let live = true;
    const stop = watchReading(
      unfinishedId,
      (next) => {
        if (!live) return;
        setStreamed(next);
        setLost(false);
      },
      () => live && setLost(true),
    );
    return () => {
      live = false;
      stop();
    };
  }, [unfinishedId, loads]);

  const concordance = usePaneFreeServerValue({
    key: reading?.status === "complete" ? `concordance:${reading.id}` : null,
    stale: "",
    load: (signal) =>
      apiFetch<ApiJson<"/oracle/readings/{reading_id}/concordance", "get">>(
        `/api/oracle/readings/${readingId}/concordance`,
        { signal },
      ),
  });

  const loadError: FeedbackContent | null =
    detail.status === "failed"
      ? failureCopy(detail.error, "The reading was interrupted")
      : lost
        ? {
            tone: "Danger",
            title: "The reading stream could not reconnect. Please retry.",
          }
        : null;
  usePaneReturnReady(reading !== null || loadError !== null);
  const insertion = useResourceComposer(reading ? {kind:"resource",ref:`oracle_reading:${readingId}`} : null, `oracle:${readingId}`, "add item");
  usePaneChrome({
    menuActions: insertion.action ? [insertion.action] : [],
    resourceRef:
      reading === null
        ? undefined
        : canonicalResourceRef({ scheme: "oracle_reading", id: readingId }),
  });
  if (defect) throw defect.error;

  const reload = () => {
    detail.refetch();
    setLoads((count) => count + 1);
  };
  const retryReading = async (intent: OpenIntent) => {
    if (reading === null || retrying) return;
    const frozen = attempt.current === null
      ? { id: crypto.randomUUID(), question: reading.question_text, openIntent: intent }
      : { ...attempt.current, openIntent: intent === "new_pane" ? intent : attempt.current.openIntent };
    attempt.current = frozen;
    setRetrying(true);
    setRetryError(null);
    try {
      await openAsyncResult({
        ctx, originPaneId: pane.paneId, intent: frozen.openIntent, disposition: "Follow", subject: frozen.question,
        create: async () => {
          const next = await createReading({ id: frozen.id, question: frozen.question });
          if (live.current) attempt.current = null;
          return { target: { href: `/oracle/${next}` }, title: "reading started", openLabel: "open reading" };
        },
      });
    } catch (error) {
      if (!live.current || ctx.sessionSignal().aborted) return;
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setRetryError(failureCopy(error, "The retry couldn’t begin"));
      } catch (caught) {
        setDefect({ error: caught });
      }
    } finally { if (live.current) setRetrying(false); }
  };
  const paragraphs = reading?.interpretation_text?.split(/\n\n+/) ?? [];
  const peers = concordance.status === "ready" ? concordance.data.data : [];
  return (
    <OracleTheme>
      <div className={styles.surface}>
        {insertion.content}
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
                          {...toReaderCitationData(passage.citation)}
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
              <FeedbackNotice
                content={failureFeedback(reading.error_code)}
                announcement="Assertive"
                actions={[{ label: "start a new reading", onClick: intent => void retryReading(intent), busy: retrying }]}
              />
              {retryError !== null && (
                <FeedbackNotice content={retryError} announcement="Assertive" />
              )}

            </section>
          )}

          {loadError !== null && reading?.status !== "complete" && (
            <section className={styles.errorPanel}>
              <FeedbackNotice
                content={loadError}
                announcement="Assertive"
                actions={[{ label: "reconnect reading", onClick: reload, busy: detail.status === "failed" ? detail.retrying : detail.status === "ready" && detail.refreshing }]}
              />
            </section>
          )}
        </article>
      </div>
    </OracleTheme>
  );
}
