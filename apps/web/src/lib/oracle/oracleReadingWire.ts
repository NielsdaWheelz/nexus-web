/**
 * The sole browser ingress for Oracle reading REST and SSE data.
 *
 * Oracle events are persisted and replayed, so accepting an unknown type or a
 * malformed event control would permanently advance the client cursor past data
 * it did not understand. public payload models own wire shapes; this ingress
 * retains event control and image/citation domain conversions.
 */

import type { Schema } from "@/lib/api/wire";
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

export type OracleImagePayload = Omit<Schema<"OracleReadingImageOut">, "url"> & {
  url: OraclePlateImageSrc;
};

export type OraclePassagePayload = Schema<"OracleReadingPassageOut">;

interface OracleMetaEvent {
  seq: number;
  event_type: "meta";
  payload: Schema<"OracleMetaEventPayload">;
}

interface OracleBindEvent {
  seq: number;
  event_type: "bind";
  payload: Schema<"OracleBindEventPayload">;
}

interface OracleArgumentEvent {
  seq: number;
  event_type: "argument";
  payload: Schema<"OracleTextEventPayload">;
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
  payload: Schema<"OracleTextEventPayload">;
}

interface OracleOmensEvent {
  seq: number;
  event_type: "omens";
  payload: Schema<"OracleOmensEventPayload">;
}

interface OracleDoneEvent {
  seq: number;
  event_type: "done";
  payload:
    | Schema<"OracleCompleteDoneEventPayload">
    | Schema<"OracleFailedDoneEventPayload">;
}

export type OracleReadingEvent =
  | OracleMetaEvent
  | OracleBindEvent
  | OracleArgumentEvent
  | OraclePlateEvent
  | OraclePassageEvent
  | OracleDeltaEvent
  | OracleOmensEvent
  | OracleDoneEvent;

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
  error_code: OracleReadingFailureCode | null;
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

function decodeImage(image: Schema<"OracleReadingImageOut">): OracleImagePayload {
  return { ...image, url: requireOraclePlateImageSrc(image.url) };
}

function decodePassage(
  passage: Schema<"OracleReadingPassageOut">,
  name: string,
): OraclePassagePayload {
  let citation: CitationOut | null = null;
  if (passage.citation !== null) {
    citation = decodeCitationOut(passage.citation);
    if (citation === null) fail(`${name}.citation is invalid`);
  }
  return { ...passage, citation };
}

function decodeEventPayload(
  eventType: (typeof ORACLE_EVENT_TYPES)[number],
  raw: unknown,
  seq: number,
): OracleReadingEvent {
  switch (eventType) {
    case "meta":
      return {
        seq,
        event_type: eventType,
        // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
        payload: raw as Schema<"OracleMetaEventPayload">,
      };
    case "bind":
      return {
        seq,
        event_type: eventType,
        // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
        payload: raw as Schema<"OracleBindEventPayload">,
      };
    case "argument":
    case "delta":
      return {
        seq,
        event_type: eventType,
        // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
        payload: raw as Schema<"OracleTextEventPayload">,
      };
    case "plate":
      return {
        seq,
        event_type: eventType,
        // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
        payload: decodeImage(raw as Schema<"OracleReadingImageOut">),
      };
    case "passage":
      return {
        seq,
        event_type: eventType,
        payload: decodePassage(
          // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
          raw as Schema<"OracleReadingPassageOut">,
          "Oracle passage event",
        ),
      };
    case "omens":
      return {
        seq,
        event_type: eventType,
        // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
        payload: raw as Schema<"OracleOmensEventPayload">,
      };
    case "done":
      return {
        seq,
        event_type: eventType,
        // justify-type-assertion: untyped transport; OracleReadingEventOut validates this named payload before delivery.
        payload: raw as
          | Schema<"OracleCompleteDoneEventPayload">
          | Schema<"OracleFailedDoneEventPayload">,
      };
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
      : decodeOracleReadingFailureCode(detail.error_code);
  const completedAt = nullableInstant(
    detail.completed_at,
    "Oracle reading completed_at",
  );
  const failedAt = nullableInstant(detail.failed_at, "Oracle reading failed_at");
  const passages = expectArray(
    detail.passages,
    (passage, index) =>
      decodePassage(
        // justify-type-assertion: untyped REST parent; OracleReadingDetailOut validates each passage before delivery.
        passage as Schema<"OracleReadingPassageOut">,
        `Oracle passage ${index}`,
      ),
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
    // justify-type-assertion: untyped REST parent; OracleReadingDetailOut validates its image before delivery.
    image:
      detail.image === null
        ? null
        : decodeImage(detail.image as Schema<"OracleReadingImageOut">),
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
