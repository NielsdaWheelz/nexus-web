"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import MediaImage from "@/components/ui/MediaImage";
import ReaderCitation from "@/components/ui/ReaderCitation";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useGenerationRun } from "@/lib/api/useGenerationRun";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { createRandomId } from "@/lib/createRandomId";
import { toRoman } from "@/lib/toRoman";
import { useResource } from "@/lib/api/useResource";
import {
  decodeOracleCreateResponse,
  decodeOracleReadingDetailResponse,
  decodeOracleStreamEvent,
  type OracleImagePayload,
  type OraclePassagePayload,
  type OracleReadingDetail,
  type OracleReadingEvent,
  type OracleReadingPhase,
  type ReadOracleReadingFailureCode,
} from "@/lib/oracle/oracleReadingWire";
import {
  usePaneParam,
  usePaneReturnReady,
  requirePaneRuntime,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import BorderFrame from "../BorderFrame";
import IlluminatedCapital from "../IlluminatedCapital";
import OracleConcordance, { FleuronBreak } from "../OracleConcordance";
import OracleThemeWrapper from "../OracleThemeWrapper";
import Sidenote from "./Sidenote";
import styles from "../oracle.module.css";

type Phase = OracleReadingPhase;

const PHASE_ORDER: readonly Phase[] = ["descent", "ordeal", "ascent"] as const;

const PHASE_LABEL: Record<Phase, string> = {
  descent: "I. The Descent",
  ordeal: "II. The Ordeal",
  ascent: "III. The Ascent",
};

type PassagePayload = OraclePassagePayload;

interface ReadingState {
  question: string;
  folioNumber: number | null;
  folioMotto: string | null;
  folioMottoGloss: string | null;
  folioTheme: string | null;
  argument: string | null;
  createdAt: string | null;
  status: "pending" | "streaming" | "complete" | "failed";
  image: OracleImagePayload | null;
  passages: PassagePayload[];
  delta: string;
  omens: string[];
  errorCode: ReadOracleReadingFailureCode | null;
  cursor: number;
}

type OracleStreamEvent = OracleReadingEvent;

const ORACLE_RECONNECT_MAX_ATTEMPTS = 3;
const STREAM_ERROR_MESSAGE =
  "The reading stream could not reconnect. Please retry.";

function oracleDetailErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "The reading was interrupted",
        message: "This reading is no longer available.",
        requestId: error.requestId,
      };
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "The reading was interrupted",
        message: "Check your connection and retry.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

function oracleRetryErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "The retry couldn’t begin",
        message: "Check your connection and retry.",
        requestId: error.requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title: "The oracle is busy",
        message: "Wait a moment, then retry.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

const initialState = (): ReadingState => ({
  question: "",
  folioNumber: null,
  folioMotto: null,
  folioMottoGloss: null,
  folioTheme: null,
  argument: null,
  createdAt: null,
  status: "pending",
  image: null,
  passages: [],
  delta: "",
  omens: [],
  errorCode: null,
  cursor: 0,
});

function stateFromDetail(detail: OracleReadingDetail): ReadingState {
  let next: ReadingState = {
    ...initialState(),
    question: detail.question_text,
    folioNumber: detail.folio_number,
    folioMotto: detail.folio_motto,
    folioMottoGloss: detail.folio_motto_gloss,
    folioTheme: detail.folio_theme,
    argument: detail.argument_text,
    createdAt: detail.created_at,
    status: detail.status,
    image: detail.image,
    passages: [...detail.passages].sort(
      (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
    ),
    errorCode: detail.error_code,
  };
  for (const event of detail.events) {
    next = applyEvent(next, event);
  }
  return next;
}

function applyEvent(
  state: ReadingState,
  event: OracleStreamEvent,
): ReadingState {
  if (event.seq !== state.cursor + 1) {
    throw new Error(
      `Invalid SSE payload for Oracle reading: expected event ${state.cursor + 1}, received ${event.seq}`,
    );
  }
  const cursor = event.seq;
  switch (event.event_type) {
    case "meta": {
      return {
        ...state,
        cursor,
        question: event.payload.question,
        folioNumber: event.payload.folio_number,
        status: "streaming",
      };
    }
    case "bind":
      return {
        ...state,
        cursor,
        folioMotto: event.payload.folio_motto,
        folioMottoGloss: event.payload.folio_motto_gloss,
        folioTheme: event.payload.folio_theme,
      };
    case "argument":
      return { ...state, cursor, argument: event.payload.text };
    case "plate": {
      return {
        ...state,
        cursor,
        image: event.payload,
      };
    }
    case "passage": {
      const incoming = event.payload;
      const next = state.passages
        .filter((p) => p.phase !== incoming.phase)
        .concat(incoming);
      next.sort(
        (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
      );
      return { ...state, cursor, passages: next };
    }
    case "delta":
      return { ...state, cursor, delta: event.payload.text };
    case "omens":
      return { ...state, cursor, omens: [...event.payload.lines] };
    case "done": {
      if (event.payload.status === "failed") {
        return {
          ...state,
          cursor,
          status: "failed",
          errorCode: event.payload.error_code,
        };
      }
      return { ...state, cursor, status: "complete" };
    }
    case "historical_done":
      return {
        ...state,
        cursor,
        status: "failed",
        errorCode: event.payload.error_code,
      };
  }
}

async function loadReadingDetail(
  readingId: string,
  signal: AbortSignal,
): Promise<OracleReadingDetail> {
  const detail = await apiFetch<unknown>(
    `/api/oracle/readings/${readingId}`,
    { signal },
  );
  return decodeOracleReadingDetailResponse(detail);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ORDINAL_ONES = [
  "zeroth",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
];

const ORDINAL_TEENS = [
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

function ordinalEnglish(day: number): string {
  if (day < 10) return ORDINAL_ONES[day]!;
  if (day < 20) return ORDINAL_TEENS[day - 10]!;
  if (day === 20) return "twentieth";
  if (day === 30) return "thirtieth";
  const tens = day < 30 ? "twenty" : "thirty";
  return `${tens}-${ORDINAL_ONES[day % 10]!}`;
}

function oracleFailureFeedback(
  errorCode: ReadOracleReadingFailureCode | null,
): FeedbackContent {
  if (errorCode === null) {
    throw new Error("Failed Oracle reading has no terminal error code");
  }
  switch (errorCode) {
    case "auth":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading service could not authenticate. Please try again later.",
      };
    case "quota":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading service has reached its usage limit. Please try again later.",
      };
    case "timeout":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading took too long to complete. Please start a new reading.",
      };
    case "output_limit":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading was too long to complete. Please start a new reading.",
      };
    case "invalid_output":
    case "policy_violation":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading could not be completed. Please start a new reading.",
      };
    case "runtime_unavailable":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading service is temporarily unavailable. Please try again later.",
      };
    case "capacity_unavailable":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The reading service is busy. Please try again shortly.",
      };
    case "context_too_large":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message:
          "The reading could not be completed. Start a new reading with a simpler question.",
      };
    case "cancelled":
      return {
        tone: "Danger",
        title: "The reading was cancelled.",
        message: "Start a new reading when you’re ready.",
      };
    case "E_ORACLE_CORPUS_NOT_READY":
    case "E_APP_SEARCH_FAILED":
      return {
        tone: "Danger",
        title: "The reading could not finish.",
        message: "The oracle’s source material is not ready. Start a new reading later.",
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title: "The oracle is busy.",
        message: "Wait a moment, then start a new reading.",
      };
    case "E_GENERATION_SOURCE_CHANGED":
      return {
        tone: "Danger",
        title: "The source material changed.",
        message: "Start a new reading from the current material.",
      };
    case "defect":
    case "E_INTERNAL":
    case "E_BILLING_REQUIRED":
    case "E_TOKEN_BUDGET_EXCEEDED":
    case "budget_exceeded":
    case "invalid_structured_output":
    case "refused":
    case "incomplete":
    case "rate_limited":
    case "provider_unavailable":
    case "stream_interrupted":
      return {
        tone: "Danger",
        title: "This earlier reading could not finish.",
        message: "Start a new reading under the current generation system.",
      };
    default: {
      const exhaustive: never = errorCode;
      throw new Error(`Unsupported Oracle terminal error code: ${exhaustive}`);
    }
  }
}

export default function OracleReadingPaneBody() {
  const readingId = usePaneParam("readingId");
  const paneRuntime = requirePaneRuntime(
    usePaneRuntime(),
    "OracleReadingPaneBody",
  );
  if (!readingId)
    throw new Error("OracleReadingPaneBody: readingId param is required");

  const [state, setState] = useState<ReadingState>(initialState);
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [retryError, setRetryError] = useState<FeedbackContent | null>(null);
  const [committedReadingId, setCommittedReadingId] = useState<string | null>(
    null,
  );
  const [retryingReading, setRetryingReading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const streamCursorRef = useRef({ readingId, cursor: 0 });
  const detailResource = useResource<OracleReadingDetail>({
    cacheKey: `${readingId}:${retryNonce}`,
    load: (signal) => loadReadingDetail(readingId, signal),
  });
  const streamSeed = useMemo(() => {
    if (
      detailResource.status === "ready" &&
      detailResource.data.id === readingId
    ) {
      return stateFromDetail(detailResource.data);
    }
    return null;
  }, [detailResource, readingId]);
  usePaneReturnReady(committedReadingId === readingId || loadError !== null);
  // The question is the reading's exact identity. A failed load never resolves
  // one, so the terminal state falls back to the route label rather than
  // leaving the pane's title pending forever.
  useSetPaneLabel(state.question || (loadError === null ? null : "Reading"));

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setCommittedReadingId(null);
    setRetryNonce((current) => current + 1);
  }, []);

  const retryFailedReading = useCallback(async () => {
    const question = state.question.trim();
    if (!question || retryingReading) return;
    setRetryingReading(true);
    setRetryError(null);
    try {
      const raw = await apiFetch<unknown>(
        "/api/oracle/readings",
        {
          method: "POST",
          headers: { "Idempotency-Key": createRandomId("oracle-read") },
          body: JSON.stringify({ question }),
        },
      );
      const body = decodeOracleCreateResponse(raw);
      paneRuntime.activateTarget({
        target: { href: `/oracle/${body.reading_id}` },
        disposition: { kind: "Follow" },
      });
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setRetryError(oracleRetryErrorMessage(error));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
      setRetryingReading(false);
    }
  }, [paneRuntime, retryingReading, state.question]);

  useEffect(() => {
    setState(initialState());
    setLoadError(null);
    setRetryError(null);
    setRetryingReading(false);
  }, [readingId, retryNonce]);

  useEffect(() => {
    if (
      detailResource.status === "idle" ||
      detailResource.status === "loading"
    ) {
      return;
    }
    if (detailResource.status === "error") {
      try {
        setLoadError(oracleDetailErrorMessage(detailResource.error));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
      return;
    }
    if (detailResource.data.id !== readingId) {
      return;
    }
    setLoadError(null);
    setState(stateFromDetail(detailResource.data));
    setCommittedReadingId(readingId);
  }, [detailResource, readingId]);

  const shouldStream =
    streamSeed !== null &&
    (streamSeed.status === "pending" || streamSeed.status === "streaming");

  useEffect(() => {
    streamCursorRef.current = {
      readingId,
      cursor: streamSeed?.cursor ?? 0,
    };
  }, [readingId, streamSeed]);

  const onStreamEvent = useCallback(
    (event: OracleStreamEvent) => {
      const cursor = streamCursorRef.current;
      if (cursor.readingId !== readingId || event.seq !== cursor.cursor + 1) {
        throw new Error(
          `Invalid SSE payload for Oracle reading: expected event ${cursor.cursor + 1}, received ${event.seq}`,
        );
      }
      cursor.cursor = event.seq;
      setState((current) => applyEvent(current, event));
    },
    [readingId],
  );

  const { phase: streamPhase } = useGenerationRun<OracleStreamEvent>({
    kind: "oracle-readings",
    id: shouldStream ? readingId : null,
    decode: decodeOracleStreamEvent,
    isTerminal: (event) =>
      event.event_type === "done" || event.event_type === "historical_done",
    onEvent: onStreamEvent,
    resume: shouldStream
      ? {
          lastEventId:
            streamSeed.cursor > 0 ? String(streamSeed.cursor) : undefined,
        }
      : undefined,
    reconnect: { max: ORACLE_RECONNECT_MAX_ATTEMPTS },
  });

  useEffect(() => {
    if (streamPhase === "failed") {
      setLoadError({ tone: "Danger", title: STREAM_ERROR_MESSAGE });
    }
  }, [streamPhase]);

  const activateCitation = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      if (target) dispatchReaderSourceActivation(target);
      if (event?.defaultPrevented) return;
      const activated = activateResource(activation, {
        labelHint: target?.label,
        activateTarget: paneRuntime.activateTarget,
        disposition: event
          ? workspaceTargetClickIntent(event).disposition
          : { kind: "Follow" },
      });
      if (activated) event?.preventDefault();
    },
    [paneRuntime],
  );

  usePanePrimaryChrome({
    actionSubject:
      (detailResource.status === "ready" &&
        detailResource.data.id === readingId) ||
      committedReadingId === readingId
        ? {
            ref: canonicalResourceRef({
              scheme: "oracle_reading",
              id: readingId,
            }),
          }
        : undefined,
  });

  const showSkeletons =
    state.status === "pending" ||
    (state.status === "streaming" && state.passages.length === 0);

  const interpretationParagraphs =
    state.delta.length > 0 ? state.delta.split(/\n\n+/) : [];

  const created = state.createdAt !== null ? new Date(state.createdAt) : null;
  const colophonDate =
    created !== null
      ? `${ordinalEnglish(created.getUTCDate())} of ${MONTHS[created.getUTCMonth()]!}, ${toRoman(created.getUTCFullYear())}`
      : null;

  if (defect) throw defect.error;

  return (
    <OracleThemeWrapper>
      <div className={styles.surface}>
        <article className={styles.reading}>
          <BorderFrame />

          <header className={styles.readingHeader}>
            <div className={styles.foliumHeader}>
              <span className={styles.foliumNumber}>
                {state.folioNumber !== null
                  ? `Folio ${toRoman(state.folioNumber)}`
                  : "Folio"}
              </span>
              <span className={styles.foliumDot}>·</span>
              <span className={styles.foliumTheme}>
                {state.folioTheme ?? ""}
              </span>
            </div>
            {state.folioMotto !== null && (
              <div className={styles.foliumMotto}>{state.folioMotto}</div>
            )}
            {state.folioMottoGloss !== null && (
              <div className={styles.foliumGloss}>{state.folioMottoGloss}</div>
            )}
            {/* The question the reader asked is the folium's authored subject:
                the argument answers it and a shared reading must stay
                self-contained. Route identity is the chrome title above. */}
            <h2 className={styles.readingQuestion}>{state.question || "…"}</h2>
            {state.argument !== null && state.argument.length > 0 && (
              <p className={styles.argument}>{state.argument}</p>
            )}
          </header>

          {state.image !== null && (
            <figure className={styles.plate}>
              <MediaImage
                kind="owned"
                src={state.image.url}
                alt={`${state.image.artist}, ${state.image.work_title}`}
                width={state.image.width}
                height={state.image.height}
                className={styles.plateImage}
                priority
                sizes="(min-width: 768px) 36rem, 100vw"
              />
              <figcaption className={styles.plateCaption}>
                {state.image.attribution_text}
              </figcaption>
            </figure>
          )}

          {showSkeletons && (
            <div className={styles.skeletons} aria-hidden="true">
              <div className={styles.skeletonPlate} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
            </div>
          )}

          {state.passages.map((passage, index) => (
            <div key={passage.phase}>
              {index > 0 && <FleuronBreak />}
              <section className={styles.passageBlock}>
                <p className={styles.passagePhase}>
                  {PHASE_LABEL[passage.phase]}
                </p>
                <div className={styles.passage}>
                  <blockquote className={styles.quote}>
                    <p>{passage.exact_snippet}</p>
                  </blockquote>
                  <p className={styles.attribution}>
                    {passage.attribution_text}{" "}
                    <span className={styles.locator}>
                      {passage.locator_label}
                    </span>
                    {passage.citation !== null && (
                      <span className={styles.passageCitation}>
                        <ReaderCitation
                          {...toReaderCitationData(passage.citation)}
                          onActivate={activateCitation}
                        />
                      </span>
                    )}
                  </p>
                  <Sidenote>
                    <p>{passage.marginalia_text}</p>
                  </Sidenote>
                </div>
              </section>
            </div>
          ))}

          {interpretationParagraphs.length > 0 && (
            <>
              <FleuronBreak />
              <section className={styles.interpretation}>
                {interpretationParagraphs.map((paragraph, index) =>
                  index === 0 && paragraph.length > 0 ? (
                    <p key={index}>
                      <IlluminatedCapital
                        letter={paragraph.charAt(0)}
                        seed={state.question}
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

          {state.omens.length > 0 && (
            <>
              <FleuronBreak />
              <section className={styles.omens}>
                <p className={styles.omensLabel}>Omens</p>
                <ul>
                  {state.omens.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {state.status === "complete" && (
            <OracleConcordance readingId={readingId} status={state.status} />
          )}

          {colophonDate !== null && state.status === "complete" && (
            <>
              <FleuronBreak />
              <p className={styles.colophon}>
                Composed on the {colophonDate}.
                {state.image !== null && ` Plate after ${state.image.artist}.`}{" "}
                Set in EB Garamond, IM Fell English, and UnifrakturMaguntia.
              </p>
            </>
          )}

          {state.status === "failed" && (
            <section className={styles.errorPanel}>
              <FeedbackNotice
                content={oracleFailureFeedback(state.errorCode)}
                announcement="Assertive"
              />
              {retryError !== null && (
                <FeedbackNotice
                  content={retryError}
                  announcement="Assertive"
                />
              )}
              <button
                type="button"
                className={styles.errorAction}
                onClick={retryFailedReading}
                disabled={retryingReading}
              >
                {retryingReading ? "Retrying…" : "Retry reading"}
              </button>
            </section>
          )}

          {loadError !== null && state.status !== "complete" && (
            <section className={styles.errorPanel}>
              <FeedbackNotice
                content={loadError}
                announcement="Assertive"
              />
              <button
                type="button"
                className={styles.errorAction}
                onClick={retryLoad}
              >
                Retry
              </button>
            </section>
          )}
        </article>
      </div>
    </OracleThemeWrapper>
  );
}
