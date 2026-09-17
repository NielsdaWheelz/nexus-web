/**
 * The sole browser ingress for Oracle reading REST and SSE data.
 *
 * Oracle events are persisted and replayed, so accepting an unknown type or a
 * malformed payload would permanently advance the client cursor past data it
 * did not understand. This decoder therefore accepts exactly the backend-owned
 * grammar and returns a closed discriminated union.
 */

import { decodeCitationOut, type CitationOut } from "@/lib/conversations/citationOut";
import {
  requireOraclePlateImageSrc,
  type OraclePlateImageSrc,
} from "@/lib/media/oraclePlateImage";
import {
  expectArray,
  expectCanonicalUuid,
  expectExactRecord,
  expectInteger,
  expectIsoInstant,
  expectNonemptyString,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export const ORACLE_READING_FAILURE_CODES = [
  "auth",
  "quota",
  "timeout",
  "output_limit",
  "invalid_output",
  "policy_violation",
  "runtime_unavailable",
  "capacity_unavailable",
  "context_too_large",
  "cancelled",
  "E_ORACLE_CORPUS_NOT_READY",
  "E_APP_SEARCH_FAILED",
  "E_GENERATION_SOURCE_CHANGED",
  "E_RATE_LIMITED",
] as const;

export type OracleReadingFailureCode =
  (typeof ORACLE_READING_FAILURE_CODES)[number];
export const HISTORICAL_ORACLE_READING_FAILURE_CODES = [
  "defect",
  "E_INTERNAL",
  "E_BILLING_REQUIRED",
  "E_TOKEN_BUDGET_EXCEEDED",
  "budget_exceeded",
  "invalid_structured_output",
  "refused",
  "incomplete",
  "rate_limited",
  "provider_unavailable",
  "stream_interrupted",
] as const;
export type HistoricalOracleReadingFailureCode =
  (typeof HISTORICAL_ORACLE_READING_FAILURE_CODES)[number];
export type ReadOracleReadingFailureCode =
  | OracleReadingFailureCode
  | HistoricalOracleReadingFailureCode;
export type OracleReadingStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "failed";
export type OracleReadingPhase = "descent" | "ordeal" | "ascent";

const ORACLE_PHASES = ["descent", "ordeal", "ascent"] as const;
const ORACLE_STATUSES = ["pending", "streaming", "complete", "failed"] as const;
const ORACLE_EVENT_TYPES = [
  "meta",
  "bind",
  "argument",
  "plate",
  "passage",
  "delta",
  "omens",
  "done",
  "historical_done",
] as const;

const ORACLE_FOLIO_THEMES = [
  "Of Time",
  "Of Death",
  "Of the Threshold",
  "Of Vanity",
  "Of Solitude",
  "Of Love",
  "Of Fortune",
  "Of Memory",
  "Of the Self",
  "Of the Other",
  "Of Fear",
  "Of Courage",
  "Of Faith",
  "Of Doubt",
  "Of Power",
  "Of Wisdom",
  "Of the Body",
  "Of the Soul",
  "Of Origins",
  "Of Endings",
  "Of Silence",
  "Of the Word",
  "Of Justice",
  "Of Mercy",
] as const;

type OracleFolioTheme = (typeof ORACLE_FOLIO_THEMES)[number];

export interface OracleImagePayload {
  url: OraclePlateImageSrc;
  attribution_text: string;
  artist: string;
  work_title: string;
  year: string | null;
  width: number;
  height: number;
}

export interface OraclePassagePayload {
  phase: OracleReadingPhase;
  source_kind: "user_media" | "public_domain";
  exact_snippet: string;
  locator_label: string;
  attribution_text: string;
  marginalia_text: string;
  deep_link: string | null;
  citation: CitationOut | null;
}

interface OracleMetaEvent {
  seq: number;
  event_type: "meta";
  payload: { question: string; folio_number: number };
}

interface OracleBindEvent {
  seq: number;
  event_type: "bind";
  payload: {
    folio_motto: string;
    folio_motto_gloss: string | null;
    folio_theme: OracleFolioTheme;
  };
}

interface OracleArgumentEvent {
  seq: number;
  event_type: "argument";
  payload: { text: string };
}

interface OraclePlateEvent {
  seq: number;
  event_type: "plate";
  payload: OracleImagePayload;
}

interface OraclePassageEvent {
  seq: number;
  event_type: "passage";
  payload: OraclePassagePayload;
}

interface OracleDeltaEvent {
  seq: number;
  event_type: "delta";
  payload: { text: string };
}

interface OracleOmensEvent {
  seq: number;
  event_type: "omens";
  payload: { lines: readonly [string, string, string] };
}

interface OracleDoneEvent {
  seq: number;
  event_type: "done";
  payload:
    | { status: "complete"; error_code: null }
    | { status: "failed"; error_code: OracleReadingFailureCode };
}

interface HistoricalOracleDoneEvent {
  seq: number;
  event_type: "historical_done";
  payload: {
    status: "failed";
    error_code: HistoricalOracleReadingFailureCode;
  };
}

export type OracleReadingEvent =
  | OracleMetaEvent
  | OracleBindEvent
  | OracleArgumentEvent
  | OraclePlateEvent
  | OraclePassageEvent
  | OracleDeltaEvent
  | OracleOmensEvent
  | OracleDoneEvent
  | HistoricalOracleDoneEvent;

export interface OracleReadingDetail {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_motto_gloss: string | null;
  folio_theme: OracleFolioTheme | null;
  argument_text: string | null;
  question_text: string;
  status: OracleReadingStatus;
  image: OracleImagePayload | null;
  passages: OraclePassagePayload[];
  events: OracleReadingEvent[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_code: ReadOracleReadingFailureCode | null;
}

export interface OracleCreateResponse {
  reading_id: string;
  folio_number: number;
  status: "pending";
}

function fail(message: string): never {
  throw new TypeError(`Invalid Oracle reading wire: ${message}`);
}

function positiveInteger(value: unknown, name: string): number {
  const integer = expectInteger(value, name);
  if (integer <= 0) fail(`${name} must be positive`);
  return integer;
}

function boundedString(
  value: unknown,
  name: string,
  minLength: number,
  maxLength: number,
): string {
  const decoded = expectString(value, name);
  if (decoded.length < minLength || decoded.length > maxLength) {
    fail(`${name} must contain ${minLength} to ${maxLength} characters`);
  }
  return decoded;
}

function nullableBoundedString(
  value: unknown,
  name: string,
  minLength: number,
  maxLength: number,
): string | null {
  const decoded = expectNullableString(value, name);
  return decoded === null
    ? null
    : boundedString(decoded, name, minLength, maxLength);
}

function nullableInstant(value: unknown, name: string): string | null {
  return value === null ? null : expectIsoInstant(value, name);
}

export function decodeOracleReadingFailureCode(
  value: unknown,
): OracleReadingFailureCode {
  return expectOneOf(
    value,
    ORACLE_READING_FAILURE_CODES,
    "Oracle failure code",
  );
}

export function decodeHistoricalOracleReadingFailureCode(
  value: unknown,
): HistoricalOracleReadingFailureCode {
  return expectOneOf(
    value,
    HISTORICAL_ORACLE_READING_FAILURE_CODES,
    "historical Oracle failure code",
  );
}

function decodeReadOracleReadingFailureCode(
  value: unknown,
): ReadOracleReadingFailureCode {
  try {
    return decodeOracleReadingFailureCode(value);
  } catch {
    return decodeHistoricalOracleReadingFailureCode(value);
  }
}

function decodeImage(value: unknown, name: string): OracleImagePayload {
  const image = expectExactRecord(
    value,
    [
      "url",
      "attribution_text",
      "artist",
      "work_title",
      "year",
      "width",
      "height",
    ],
    name,
  );
  return {
    url: requireOraclePlateImageSrc(
      expectNonemptyString(image.url, `${name}.url`),
    ),
    attribution_text: expectNonemptyString(
      image.attribution_text,
      `${name}.attribution_text`,
    ),
    artist: expectNonemptyString(image.artist, `${name}.artist`),
    work_title: expectNonemptyString(image.work_title, `${name}.work_title`),
    year: expectNullableString(image.year, `${name}.year`),
    width: positiveInteger(image.width, `${name}.width`),
    height: positiveInteger(image.height, `${name}.height`),
  };
}

function decodePassage(value: unknown, name: string): OraclePassagePayload {
  const passage = expectExactRecord(
    value,
    [
      "phase",
      "source_kind",
      "exact_snippet",
      "locator_label",
      "attribution_text",
      "marginalia_text",
      "deep_link",
      "citation",
    ],
    name,
  );
  let citation: CitationOut | null = null;
  if (passage.citation !== null) {
    citation = decodeCitationOut(passage.citation);
    if (citation === null) fail(`${name}.citation is invalid`);
  }
  return {
    phase: expectOneOf(passage.phase, ORACLE_PHASES, `${name}.phase`),
    source_kind: expectOneOf(
      passage.source_kind,
      ["user_media", "public_domain"] as const,
      `${name}.source_kind`,
    ),
    exact_snippet: expectNonemptyString(
      passage.exact_snippet,
      `${name}.exact_snippet`,
    ),
    locator_label: expectNonemptyString(
      passage.locator_label,
      `${name}.locator_label`,
    ),
    attribution_text: expectNonemptyString(
      passage.attribution_text,
      `${name}.attribution_text`,
    ),
    marginalia_text: expectNonemptyString(
      passage.marginalia_text,
      `${name}.marginalia_text`,
    ),
    deep_link: expectNullableString(passage.deep_link, `${name}.deep_link`),
    citation,
  };
}

function decodeEventPayload(
  eventType: (typeof ORACLE_EVENT_TYPES)[number],
  raw: unknown,
  seq: number,
): OracleReadingEvent {
  switch (eventType) {
    case "meta": {
      const payload = expectExactRecord(
        raw,
        ["question", "folio_number"],
        "Oracle meta event",
      );
      return {
        seq,
        event_type: eventType,
        payload: {
          question: boundedString(payload.question, "Oracle question", 1, 280),
          folio_number: positiveInteger(
            payload.folio_number,
            "Oracle folio number",
          ),
        },
      };
    }
    case "bind": {
      const payload = expectExactRecord(
        raw,
        ["folio_motto", "folio_motto_gloss", "folio_theme"],
        "Oracle bind event",
      );
      return {
        seq,
        event_type: eventType,
        payload: {
          folio_motto: boundedString(
            payload.folio_motto,
            "Oracle folio motto",
            1,
            80,
          ),
          folio_motto_gloss: nullableBoundedString(
            payload.folio_motto_gloss,
            "Oracle folio motto gloss",
            1,
            120,
          ),
          folio_theme: expectOneOf(
            payload.folio_theme,
            ORACLE_FOLIO_THEMES,
            "Oracle folio theme",
          ),
        },
      };
    }
    case "argument":
    case "delta": {
      const payload = expectExactRecord(raw, ["text"], `Oracle ${eventType} event`);
      return {
        seq,
        event_type: eventType,
        payload: { text: expectNonemptyString(payload.text, `Oracle ${eventType} text`) },
      };
    }
    case "plate":
      return {
        seq,
        event_type: eventType,
        payload: decodeImage(raw, "Oracle plate event"),
      };
    case "passage":
      return {
        seq,
        event_type: eventType,
        payload: decodePassage(raw, "Oracle passage event"),
      };
    case "omens": {
      const payload = expectExactRecord(raw, ["lines"], "Oracle omens event");
      const lines = expectArray(
        payload.lines,
        (line, index) => expectNonemptyString(line, `Oracle omen ${index}`),
        "Oracle omens",
      );
      if (lines.length !== 3) fail("Oracle omens must contain exactly three lines");
      return {
        seq,
        event_type: eventType,
        payload: { lines: [lines[0]!, lines[1]!, lines[2]!] },
      };
    }
    case "done": {
      const payload = expectExactRecord(
        raw,
        ["status", "error_code"],
        "Oracle done event",
      );
      if (payload.status === "complete") {
        if (payload.error_code !== null) {
          fail("complete Oracle done event carries an error code");
        }
        return {
          seq,
          event_type: eventType,
          payload: { status: "complete", error_code: null },
        };
      }
      if (payload.status !== "failed") fail("Oracle done status is unknown");
      return {
        seq,
        event_type: eventType,
        payload: {
          status: "failed",
          error_code: decodeOracleReadingFailureCode(payload.error_code),
        },
      };
    }
    case "historical_done": {
      const payload = expectExactRecord(
        raw,
        ["status", "error_code"],
        "historical Oracle done event",
      );
      if (payload.status !== "failed") {
        fail("historical Oracle done status must be failed");
      }
      return {
        seq,
        event_type: eventType,
        payload: {
          status: "failed",
          error_code: decodeHistoricalOracleReadingFailureCode(
            payload.error_code,
          ),
        },
      };
    }
  }
}

export function decodeOracleStreamEvent(
  type: string,
  data: unknown,
  eventId: string,
): OracleReadingEvent {
  try {
    const seq = Number(eventId);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      fail("SSE event id must be a positive safe integer");
    }
    const eventType = expectOneOf(
      type,
      ORACLE_EVENT_TYPES,
      "Oracle SSE event type",
    );
    return decodeEventPayload(eventType, data, seq);
  } catch (error) {
    throw new Error("Invalid SSE payload for Oracle reading", { cause: error });
  }
}

function decodePersistedEvent(value: unknown, index: number): OracleReadingEvent {
  const event = expectExactRecord(
    value,
    ["seq", "event_type", "payload"],
    `Oracle event ${index}`,
  );
  const seq = positiveInteger(event.seq, `Oracle event ${index}.seq`);
  const eventType = expectOneOf(
    event.event_type,
    ORACLE_EVENT_TYPES,
    `Oracle event ${index}.event_type`,
  );
  return decodeEventPayload(eventType, event.payload, seq);
}

export function decodeOracleReadingDetail(value: unknown): OracleReadingDetail {
  const detail = expectExactRecord(
    value,
    [
      "id",
      "folio_number",
      "folio_motto",
      "folio_motto_gloss",
      "folio_theme",
      "argument_text",
      "question_text",
      "status",
      "image",
      "passages",
      "events",
      "created_at",
      "started_at",
      "completed_at",
      "failed_at",
      "error_code",
    ],
    "Oracle reading detail",
  );
  const status = expectOneOf(
    detail.status,
    ORACLE_STATUSES,
    "Oracle reading status",
  );
  const events = expectArray(
    detail.events,
    decodePersistedEvent,
    "Oracle reading events",
  );
  const errorCode =
    detail.error_code === null
      ? null
      : decodeReadOracleReadingFailureCode(detail.error_code);
  const completedAt = nullableInstant(
    detail.completed_at,
    "Oracle reading completed_at",
  );
  const failedAt = nullableInstant(detail.failed_at, "Oracle reading failed_at");
  const passages = expectArray(
    detail.passages,
    (passage, index) => decodePassage(passage, `Oracle passage ${index}`),
    "Oracle reading passages",
  );
  const phases = passages.map((passage) => passage.phase);
  if (new Set(phases).size !== phases.length) {
    fail("Oracle reading contains duplicate passage phases");
  }
  if (phases.some((phase, index) => ORACLE_PHASES[index] !== phase)) {
    fail("Oracle reading passages are not in canonical phase order");
  }

  return {
    id: expectCanonicalUuid(detail.id, "Oracle reading id"),
    folio_number: positiveInteger(detail.folio_number, "Oracle folio number"),
    folio_motto: nullableBoundedString(
      detail.folio_motto,
      "Oracle folio motto",
      1,
      80,
    ),
    folio_motto_gloss: nullableBoundedString(
      detail.folio_motto_gloss,
      "Oracle folio motto gloss",
      1,
      120,
    ),
    folio_theme:
      detail.folio_theme === null
        ? null
        : expectOneOf(
            detail.folio_theme,
            ORACLE_FOLIO_THEMES,
            "Oracle folio theme",
          ),
    argument_text: expectNullableString(
      detail.argument_text,
      "Oracle argument text",
    ),
    question_text: boundedString(
      detail.question_text,
      "Oracle question text",
      1,
      280,
    ),
    status,
    image:
      detail.image === null
        ? null
        : decodeImage(detail.image, "Oracle reading image"),
    passages,
    events,
    created_at: expectIsoInstant(detail.created_at, "Oracle reading created_at"),
    started_at: nullableInstant(detail.started_at, "Oracle reading started_at"),
    completed_at: completedAt,
    failed_at: failedAt,
    error_code: errorCode,
  };
}

export function decodeOracleReadingDetailResponse(value: unknown): OracleReadingDetail {
  const envelope = expectExactRecord(value, ["data"], "Oracle detail response");
  return decodeOracleReadingDetail(envelope.data);
}

export function decodeOracleCreateResponse(value: unknown): OracleCreateResponse {
  const envelope = expectExactRecord(value, ["data"], "Oracle create response");
  const data = expectExactRecord(
    envelope.data,
    ["reading_id", "folio_number", "status"],
    "Oracle create response data",
  );
  if (data.status !== "pending") {
    fail("new Oracle reading status must be pending");
  }
  return {
    reading_id: expectCanonicalUuid(data.reading_id, "Oracle reading id"),
    folio_number: positiveInteger(data.folio_number, "Oracle folio number"),
    status: data.status,
  };
}
