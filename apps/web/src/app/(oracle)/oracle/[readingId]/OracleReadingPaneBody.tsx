"use client";

import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import MediaImage from "@/components/ui/MediaImage";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";
import { isAbortError } from "@/lib/errors";
import {
  parseOraclePlateImageSrc,
  requireOraclePlateImageSrc,
  type OraclePlateImageSrc,
} from "@/lib/media/oraclePlateImage";
import { toRoman } from "@/lib/toRoman";
import { useResource } from "@/lib/api/useResource";
import { isRecord } from "@/lib/validation";
import type { OracleCreateResponse } from "../types";
import { useStickyHeadline } from "../../OracleShell";
import BorderFrame from "../BorderFrame";
import IlluminatedCapital from "../IlluminatedCapital";
import OracleConcordance from "../OracleConcordance";
import Sidenote from "./Sidenote";
import styles from "../oracle.module.css";

type Phase = "descent" | "ordeal" | "ascent";

const PHASE_ORDER: readonly Phase[] = ["descent", "ordeal", "ascent"] as const;

const PHASE_LABEL: Record<Phase, string> = {
  descent: "I. The Descent",
  ordeal: "II. The Ordeal",
  ascent: "III. The Ascent",
};

interface ApiImagePayload {
  url: string;
  attribution_text: string;
  artist: string;
  work_title: string;
  year: string | null;
  width: number;
  height: number;
}

interface ImagePayload extends Omit<ApiImagePayload, "url"> {
  url: OraclePlateImageSrc;
}

interface PassagePayload {
  phase: Phase;
  source_kind: "user_media" | "public_domain";
  exact_snippet: string;
  locator_label: string;
  attribution_text: string;
  marginalia_text: string;
  deep_link: string | null;
}

export interface ReadingDetail {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_motto_gloss: string | null;
  folio_theme: string | null;
  argument_text: string | null;
  question_text: string;
  status: "pending" | "streaming" | "complete" | "failed";
  image: ApiImagePayload | null;
  passages: PassagePayload[];
  events: { seq: number; event_type: string; payload: Record<string, unknown> }[];
  created_at: string;
  error_code: string | null;
  error_message: string | null;
}

interface ReadingState {
  question: string;
  folioNumber: number | null;
  folioMotto: string | null;
  folioMottoGloss: string | null;
  folioTheme: string | null;
  argument: string | null;
  createdAt: string | null;
  status: "pending" | "streaming" | "complete" | "failed";
  image: ImagePayload | null;
  passages: PassagePayload[];
  delta: string;
  omens: string[];
  error: { code: string; message: string } | null;
  cursor: number;
}

type OracleStreamEvent = {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
};

const ORACLE_RECONNECT_MAX_ATTEMPTS = 3;
const LOAD_ERROR_MESSAGE = "The reading could not be loaded. Please retry.";
const STREAM_ERROR_MESSAGE =
  "The reading stream could not reconnect. Please retry.";

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
  error: null,
  cursor: 0,
});

function stringPayloadValue(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function nullableStringPayloadValue(
  payload: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = payload[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isPhase(value: unknown): value is Phase {
  return value === "descent" || value === "ordeal" || value === "ascent";
}

function parseImagePayload(payload: Record<string, unknown>): ImagePayload | null {
  const url = stringPayloadValue(payload, "url");
  const attributionText = stringPayloadValue(payload, "attribution_text");
  const artist = stringPayloadValue(payload, "artist");
  const workTitle = stringPayloadValue(payload, "work_title");
  const year = nullableStringPayloadValue(payload, "year");
  const width = payload.width;
  const height = payload.height;
  if (
    url === null ||
    attributionText === null ||
    artist === null ||
    workTitle === null ||
    year === undefined ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  const plateUrl = parseOraclePlateImageSrc(url);
  if (plateUrl === null) return null;
  return {
    url: plateUrl,
    attribution_text: attributionText,
    artist,
    work_title: workTitle,
    year,
    width,
    height,
  };
}

function normalizeDetailImagePayload(image: ApiImagePayload | null): ImagePayload | null {
  if (image === null) return null;
  return {
    ...image,
    url: requireOraclePlateImageSrc(image.url),
  };
}

function parsePassagePayload(payload: Record<string, unknown>): PassagePayload | null {
  const phase = payload.phase;
  const sourceKind = payload.source_kind;
  const exactSnippet = stringPayloadValue(payload, "exact_snippet");
  const locatorLabel = stringPayloadValue(payload, "locator_label");
  const attributionText = stringPayloadValue(payload, "attribution_text");
  const marginaliaText = stringPayloadValue(payload, "marginalia_text");
  const deepLink = nullableStringPayloadValue(payload, "deep_link");
  if (
    !isPhase(phase) ||
    (sourceKind !== "user_media" && sourceKind !== "public_domain") ||
    exactSnippet === null ||
    locatorLabel === null ||
    attributionText === null ||
    marginaliaText === null ||
    deepLink === undefined
  ) {
    return null;
  }
  return {
    phase,
    source_kind: sourceKind,
    exact_snippet: exactSnippet,
    locator_label: locatorLabel,
    attribution_text: attributionText,
    marginalia_text: marginaliaText,
    deep_link: deepLink,
  };
}

function stateFromDetail(detail: ReadingDetail): ReadingState {
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
    image: normalizeDetailImagePayload(detail.image),
    passages: [...detail.passages].sort(
      (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
    ),
    error:
      detail.error_code !== null
        ? {
            code: detail.error_code,
            message: detail.error_message ?? "",
          }
        : null,
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
  if (event.seq <= state.cursor) return state;
  const cursor = event.seq;
  switch (event.event_type) {
    case "meta": {
      const question = String(event.payload.question ?? state.question);
      const rawFolio = event.payload.folio_number;
      const folioNumber = typeof rawFolio === "number" ? rawFolio : state.folioNumber;
      return { ...state, cursor, question, folioNumber, status: "streaming" };
    }
    case "bind":
      return {
        ...state,
        cursor,
        folioMotto: typeof event.payload.folio_motto === "string" ? event.payload.folio_motto : state.folioMotto,
        folioMottoGloss: typeof event.payload.folio_motto_gloss === "string" ? event.payload.folio_motto_gloss : null,
        folioTheme: typeof event.payload.folio_theme === "string" ? event.payload.folio_theme : state.folioTheme,
      };
    case "argument":
      return { ...state, cursor, argument: String(event.payload.text ?? "") };
    case "plate": {
      const image = parseImagePayload(event.payload);
      return image === null ? { ...state, cursor } : { ...state, cursor, image };
    }
    case "passage": {
      const incoming = parsePassagePayload(event.payload);
      if (incoming === null) return { ...state, cursor };
      const next = state.passages
        .filter((p) => p.phase !== incoming.phase)
        .concat(incoming);
      next.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
      return { ...state, cursor, passages: next };
    }
    case "delta":
      return { ...state, cursor, delta: String(event.payload.text ?? "") };
    case "omens": {
      const lines = Array.isArray(event.payload.lines)
        ? event.payload.lines.filter((line) => typeof line === "string")
        : [];
      return { ...state, cursor, omens: lines };
    }
    case "error":
      return {
        ...state,
        cursor,
        status: "failed",
        error: {
          code: String(event.payload.code ?? "E_UNKNOWN"),
          message: String(event.payload.message ?? ""),
        },
      };
    case "done":
      return {
        ...state,
        cursor,
        status: state.error !== null ? "failed" : "complete",
      };
    default:
      return { ...state, cursor };
  }
}

class OracleStreamParseError extends Error {
  constructor(message = "Invalid SSE payload for oracle reading") {
    super(message);
    this.name = "OracleStreamParseError";
  }
}

function decodeOracleStreamEvent(
  type: string,
  data: unknown,
  eventId: string,
): OracleStreamEvent {
  const seq = Number(eventId);
  if (!Number.isSafeInteger(seq) || seq <= 0 || !isRecord(data)) {
    throw new OracleStreamParseError();
  }
  return {
    seq,
    event_type: type,
    payload: data,
  };
}

async function streamEventsWithReconnect(
  readingId: string,
  initialCursor: number,
  onEvent: (event: OracleStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const firstToken = await fetchStreamToken();
  if (signal.aborted) {
    return;
  }

  let firstStreamToken: string | null = firstToken.token;
  let nextEventId = "";

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortStream: (() => void) | null = null;
    function settle(callback: () => void) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback();
    }
    function handleAbort() {
      abortStream?.();
      settle(() => resolve());
    }
    abortStream = sseClientDirect<OracleStreamEvent>({
      url: `${firstToken.stream_base_url}/stream/oracle-readings/${readingId}/events`,
      streamToken: async () => {
        if (firstStreamToken !== null) {
          const token = firstStreamToken;
          firstStreamToken = null;
          return token;
        }
        return (await fetchStreamToken()).token;
      },
      decode: (type, data) => decodeOracleStreamEvent(type, data, nextEventId),
      isTerminal: (event) =>
        event.event_type === "done" || event.event_type === "error",
      onEvent: (event) => {
        nextEventId = "";
        onEvent(event);
      },
      onError: (error) => settle(() => reject(error)),
      onComplete: () => settle(() => resolve()),
      onLastEventId: (eventId) => {
        nextEventId = eventId;
      },
      signal,
      lastEventId: initialCursor > 0 ? String(initialCursor) : undefined,
      maxReconnects: ORACLE_RECONNECT_MAX_ATTEMPTS,
    });
    if (!settled) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }
  });
}

async function loadReadingDetail(
  readingId: string,
  signal: AbortSignal,
): Promise<ReadingDetail> {
  const detail = await apiFetch<{ data: ReadingDetail }>(
    `/api/oracle/readings/${readingId}`,
    { signal },
  );
  return detail.data;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ORDINAL_ONES = [
  "zeroth", "first", "second", "third", "fourth",
  "fifth", "sixth", "seventh", "eighth", "ninth",
];

const ORDINAL_TEENS = [
  "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth",
  "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
];

function ordinalEnglish(day: number): string {
  if (day < 10) return ORDINAL_ONES[day]!;
  if (day < 20) return ORDINAL_TEENS[day - 10]!;
  if (day === 20) return "twentieth";
  if (day === 30) return "thirtieth";
  const tens = day < 30 ? "twenty" : "thirty";
  return `${tens}-${ORDINAL_ONES[day % 10]!}`;
}


function FleuronBreak() {
  return (
    <div className={styles.fleuronBreak} aria-hidden="true">
      <span className={styles.fleuronBreakGlyph}>❦</span>
    </div>
  );
}

function oracleFailureFeedback(error: ReadingState["error"]): FeedbackContent {
  let message: string;
  switch (error?.code) {
    case "E_LLM_NO_KEY":
      message = "A model key is needed before the oracle can complete a reading.";
      break;
    case "E_LLM_BAD_REQUEST":
      message = "The reading could not be completed. Start a new reading with a simpler question.";
      break;
    default:
      message = "The reading could not be completed. Please start a new reading.";
  }
  return {
    severity: "error",
    title: "The reading could not finish.",
    message,
  };
}

export default function OracleReadingPaneBody({
  readingId,
  initialDetail = null,
}: {
  readingId: string;
  initialDetail?: ReadingDetail | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<ReadingState>(() =>
    initialDetail?.id === readingId
      ? stateFromDetail(initialDetail)
      : initialState(),
  );
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [retryError, setRetryError] = useState<FeedbackContent | null>(null);
  const [retryingReading, setRetryingReading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const headlineRef = useStickyHeadline(state.folioMotto ?? null);
  const seededDetail = initialDetail?.id === readingId ? initialDetail : null;
  const detailResource = useResource<ReadingDetail>({
    cacheKey: seededDetail === null ? `${readingId}:${retryNonce}` : null,
    load: (signal) => loadReadingDetail(readingId, signal),
  });
  const streamSeed = useMemo(() => {
    if (seededDetail !== null) {
      return stateFromDetail(seededDetail);
    }
    if (
      detailResource.status === "ready" &&
      detailResource.data.id === readingId
    ) {
      return stateFromDetail(detailResource.data);
    }
    return null;
  }, [detailResource, readingId, seededDetail]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setRetryNonce((current) => current + 1);
  }, []);

  const retryFailedReading = useCallback(async () => {
    const question = state.question.trim();
    if (!question || retryingReading) return;
    setRetryingReading(true);
    setRetryError(null);
    try {
      const body = await apiFetch<{ data: OracleCreateResponse }>(
        "/api/oracle/readings",
        {
          method: "POST",
          body: JSON.stringify({ question }),
        },
      );
      router.push(`/oracle/${body.data.reading_id}`);
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      setRetryError(
        toFeedback(error, {
          fallback: "The retry could not begin. Please try again.",
        }),
      );
      setRetryingReading(false);
    }
  }, [retryingReading, router, state.question]);

  useEffect(() => {
    setState(
      seededDetail !== null ? stateFromDetail(seededDetail) : initialState(),
    );
    setLoadError(null);
    setRetryError(null);
    setRetryingReading(false);
  }, [readingId, retryNonce, seededDetail]);

  useEffect(() => {
    if (
      detailResource.status === "idle" ||
      detailResource.status === "loading"
    ) {
      return;
    }
    if (detailResource.status === "error") {
      setLoadError(
        toFeedback(detailResource.error, {
          fallback: LOAD_ERROR_MESSAGE,
        }),
      );
      return;
    }
    if (detailResource.data.id !== readingId) {
      return;
    }
    setLoadError(null);
    setState(stateFromDetail(detailResource.data));
  }, [detailResource, readingId]);

  useEffect(() => {
    if (
      streamSeed === null ||
      (streamSeed.status !== "pending" && streamSeed.status !== "streaming")
    ) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        if (cancelled || controller.signal.aborted) {
          return;
        }

        await streamEventsWithReconnect(
          readingId,
          streamSeed.cursor,
          (event) => {
            if (cancelled) return;
            setState((current) => applyEvent(current, event));
          },
          controller.signal,
        );
      } catch (error) {
        if (cancelled) return;
        if (!isAbortError(error)) {
          if (handleUnauthenticatedApiError(error)) return;
          setLoadError(
            toFeedback(error, {
              fallback: STREAM_ERROR_MESSAGE,
            }),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [readingId, streamSeed]);

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

  return (
    <div className={styles.surface}>
      <article className={styles.reading}>
        <BorderFrame />

        <header className={styles.readingHeader}>
          <div className={styles.foliumHeader}>
            <span className={styles.foliumNumber}>
              {state.folioNumber !== null ? `Folio ${toRoman(state.folioNumber)}` : "Folio"}
            </span>
            <span className={styles.foliumDot}>·</span>
            <span className={styles.foliumTheme}>{state.folioTheme ?? ""}</span>
          </div>
          {state.folioMotto !== null && (
            <div
              className={styles.foliumMotto}
              ref={headlineRef as React.RefObject<HTMLDivElement>}
            >
              {state.folioMotto}
            </div>
          )}
          {state.folioMottoGloss !== null && (
            <div className={styles.foliumGloss}>{state.folioMottoGloss}</div>
          )}
          <h1 className={styles.readingQuestion}>
            {state.question || "…"}
          </h1>
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
              <p className={styles.passagePhase}>{PHASE_LABEL[passage.phase]}</p>
              <div className={styles.passage}>
                <blockquote className={styles.quote}>
                  <p>{passage.exact_snippet}</p>
                </blockquote>
                <p className={styles.attribution}>
                  {passage.attribution_text}{" "}
                  <span className={styles.locator}>{passage.locator_label}</span>
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
              {state.image !== null && ` Plate after ${state.image.artist}.`}
              {" "}Set in EB Garamond, IM Fell English, and UnifrakturMaguntia.
            </p>
          </>
        )}

        {state.status === "failed" && state.error !== null && (
          <section className={styles.errorPanel}>
            <FeedbackNotice
              feedback={oracleFailureFeedback(state.error)}
              className={styles.oracleFeedback}
            />
            {retryError !== null && (
              <FeedbackNotice feedback={retryError} className={styles.oracleFeedback} />
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
              feedback={{
                ...loadError,
                title: "The reading was interrupted.",
                message: loadError.title,
              }}
              className={styles.oracleFeedback}
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
  );
}
