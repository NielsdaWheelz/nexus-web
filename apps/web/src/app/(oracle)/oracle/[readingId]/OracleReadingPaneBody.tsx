"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { ApiError, apiFetch } from "@/lib/api/client";
import { parseSSEJsonStream, type SSEJsonEvent } from "@/lib/api/sse";
import { fetchStreamToken } from "@/lib/api/streamToken";
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

interface ImagePayload {
  source_url: string;
  attribution_text: string;
  artist: string;
  work_title: string;
  year: string | null;
  width: number;
  height: number;
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
  image: ImagePayload | null;
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

type OracleStreamEvent = {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
};

const ORACLE_RECONNECT_DELAY_MS = 1000;
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
    image: detail.image,
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
    case "plate":
      return { ...state, cursor, image: event.payload as unknown as ImagePayload };
    case "passage": {
      const incoming = event.payload as unknown as PassagePayload;
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
        ? (event.payload.lines as string[])
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

class OracleStreamHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Oracle stream request failed");
    this.name = "OracleStreamHttpError";
    this.status = status;
  }
}

class OracleStreamParseError extends Error {
  constructor() {
    super("Oracle stream data could not be parsed");
    this.name = "OracleStreamParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toOracleStreamEvent(event: SSEJsonEvent): OracleStreamEvent | null {
  const seq = Number(event.id);
  if (!Number.isSafeInteger(seq) || seq <= 0 || !isRecord(event.data)) {
    return null;
  }
  return {
    seq,
    event_type: event.type,
    payload: event.data,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryableOracleStreamError(error: unknown): boolean {
  if (error instanceof OracleStreamParseError) return false;
  if (error instanceof OracleStreamHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

async function streamEvents(
  streamBaseUrl: string,
  token: string,
  readingId: string,
  cursor: number,
  onEvent: (event: OracleStreamEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(
    `${streamBaseUrl}/stream/oracle-readings/${readingId}/events`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
        ...(cursor > 0 ? { "Last-Event-ID": String(cursor) } : {}),
      },
      signal,
    },
  );
  if (!response.ok) {
    throw new OracleStreamHttpError(response.status);
  }
  if (response.body === null) {
    throw new OracleStreamParseError();
  }

  let terminalEventSeen = false;

  try {
    await parseSSEJsonStream(
      response.body,
      (jsonEvent) => {
        const event = toOracleStreamEvent(jsonEvent);
        if (!event) return;
        onEvent(event);
        if (event.event_type === "done" || event.event_type === "error") {
          terminalEventSeen = true;
        }
      },
      () => {},
    );
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return terminalEventSeen;
    }
    throw error instanceof Error &&
      (error.message.startsWith("SSE event exceeds maximum size") ||
        error.message.startsWith("Failed to parse SSE data as JSON"))
      ? new OracleStreamParseError()
      : error;
  }

  return terminalEventSeen;
}

async function streamEventsWithReconnect(
  readingId: string,
  initialCursor: number,
  onEvent: (event: OracleStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let cursor = initialCursor;
  let reconnectAttempts = 0;
  while (!signal.aborted) {
    try {
      const token = await fetchStreamToken();
      const terminalEventSeen = await streamEvents(
        token.stream_base_url,
        token.token,
        readingId,
        cursor,
        (event) => {
          cursor = event.seq;
          reconnectAttempts = 0;
          onEvent(event);
        },
        signal,
      );
      if (terminalEventSeen) return;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      if (!isRetryableOracleStreamError(error)) throw error;
    }

    reconnectAttempts += 1;
    if (reconnectAttempts >= ORACLE_RECONNECT_MAX_ATTEMPTS) {
      throw new Error("Oracle stream reconnect budget exhausted");
    }

    await delay(ORACLE_RECONNECT_DELAY_MS, signal);
  }
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

function toRoman(year: number): string {
  const lookup: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = year;
  let out = "";
  for (const [value, symbol] of lookup) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
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
    initialDetail !== null ? stateFromDetail(initialDetail) : initialState(),
  );
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [retryError, setRetryError] = useState<FeedbackContent | null>(null);
  const [retryingReading, setRetryingReading] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const headlineRef = useStickyHeadline(state.folioMotto ?? null);

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
      const body = await apiFetch<{ data: OracleCreateResponse }>("/api/oracle/readings", {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      router.push(`/oracle/${body.data.reading_id}`);
    } catch (error) {
      setRetryError(
        toFeedback(error, { fallback: "The retry could not begin. Please try again." }),
      );
      setRetryingReading(false);
    }
  }, [retryingReading, router, state.question]);

  useEffect(() => {
    setState(initialDetail !== null ? stateFromDetail(initialDetail) : initialState());
    setLoadError(null);
    setRetryError(null);
    setRetryingReading(false);
    const controller = new AbortController();
    let cancelled = false;
    let loadedDetail = false;

    (async () => {
      try {
        let next: ReadingState;
        if (initialDetail !== null) {
          next = stateFromDetail(initialDetail);
          loadedDetail = true;
          if (!cancelled) setState(next);
        } else {
          const detail = await apiFetch<{ data: ReadingDetail }>(
            `/api/oracle/readings/${readingId}`,
          );
          if (cancelled) return;
          loadedDetail = true;
          next = stateFromDetail(detail.data);
          setState(next);
        }

        if (next.status !== "pending" && next.status !== "streaming") return;

        await streamEventsWithReconnect(
          readingId,
          next.cursor,
          (event) => {
            if (cancelled) return;
            setState((current) => applyEvent(current, event));
          },
          controller.signal,
        );
      } catch (error) {
        if (cancelled) return;
        if (!isAbortError(error)) {
          setLoadError(
            toFeedback(error, {
              fallback: loadedDetail ? STREAM_ERROR_MESSAGE : LOAD_ERROR_MESSAGE,
            }),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialDetail, readingId, retryNonce]);

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
    <div data-theme="oracle" className={styles.surface}>
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
            <Image
              src={state.image.source_url}
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
