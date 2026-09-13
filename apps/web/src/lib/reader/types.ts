/**
 * Reader profile and persisted resume-state types.
 *
 * Backend contract assumptions (served through the BFF mirror of the FastAPI
 * paths):
 * - GET /me/reader-profile returns { data: ReaderProfile } (exactly seven
 *   fields; the backend service owns the defaults — there is no frontend
 *   default profile)
 * - PATCH /me/reader-profile accepts any non-empty Partial<ReaderProfile>
 * - Reader cursor GET/PUT snapshots live in `readerProgress.ts`; the locator
 *   inside them is the `ReaderResumeState` decoded here.
 */

export type ReaderTheme = "light" | "dark";
export type ReaderFontFamily = "serif" | "sans";
export type ReaderFocusMode = "off" | "distraction_free" | "paragraph" | "sentence";
export type ReaderHyphenation = "auto" | "off";

export const READER_THEMES = ["light", "dark"] as const satisfies readonly ReaderTheme[];
export const READER_FONT_FAMILIES = [
  "serif",
  "sans",
] as const satisfies readonly ReaderFontFamily[];
export const READER_FOCUS_MODES = [
  "off",
  "distraction_free",
  "paragraph",
  "sentence",
] as const satisfies readonly ReaderFocusMode[];
export const READER_HYPHENATIONS = [
  "auto",
  "off",
] as const satisfies readonly ReaderHyphenation[];

export interface ReaderProfile {
  theme: ReaderTheme;
  font_family: ReaderFontFamily;
  font_size_px: number;
  line_height: number;
  column_width_ch: number;
  focus_mode: ReaderFocusMode;
  hyphenation: ReaderHyphenation;
}

const READER_THEME_SET: ReadonlySet<string> = new Set(READER_THEMES);
const READER_FONT_FAMILY_SET: ReadonlySet<string> = new Set(READER_FONT_FAMILIES);
const READER_FOCUS_MODE_SET: ReadonlySet<string> = new Set(READER_FOCUS_MODES);
const READER_HYPHENATION_SET: ReadonlySet<string> = new Set(READER_HYPHENATIONS);

export function isReaderTheme(value: unknown): value is ReaderTheme {
  return typeof value === "string" && READER_THEME_SET.has(value);
}

export function isReaderFontFamily(value: unknown): value is ReaderFontFamily {
  return typeof value === "string" && READER_FONT_FAMILY_SET.has(value);
}

export function isReaderFocusMode(value: unknown): value is ReaderFocusMode {
  return typeof value === "string" && READER_FOCUS_MODE_SET.has(value);
}

export function isReaderHyphenation(value: unknown): value is ReaderHyphenation {
  return typeof value === "string" && READER_HYPHENATION_SET.has(value);
}

export interface ReaderResumeLocations {
  text_offset: number | null;
  progression: number | null;
  total_progression: number | null;
  position: number | null;
}

export interface ReaderResumeTextContext {
  quote: string | null;
  quote_prefix: string | null;
  quote_suffix: string | null;
}

export interface PdfReaderResumeState {
  kind: "pdf";
  page: number;
  page_progression: number | null;
  zoom: number | null;
  position: number | null;
}

export interface WebReaderResumeState {
  kind: "web";
  target: {
    fragment_id: string;
  };
  locations: ReaderResumeLocations;
  text: ReaderResumeTextContext;
}

export interface TranscriptReaderResumeState {
  kind: "transcript";
  target: {
    fragment_id: string;
  };
  locations: ReaderResumeLocations;
  text: ReaderResumeTextContext;
}

export interface EpubReaderResumeState {
  kind: "epub";
  target: {
    section_id: string;
    href_path: string;
    anchor_id: string | null;
  };
  locations: ReaderResumeLocations;
  text: ReaderResumeTextContext;
}

export type ReaderResumeState =
  | PdfReaderResumeState
  | WebReaderResumeState
  | TranscriptReaderResumeState
  | EpubReaderResumeState;

export type ReflowableReaderResumeState =
  | WebReaderResumeState
  | TranscriptReaderResumeState
  | EpubReaderResumeState;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: string[]): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key))
  );
}

function parseNullableStringField(value: unknown): { ok: boolean; value: string | null } {
  if (value === null) {
    return { ok: true, value: null };
  }
  const normalized = normalizeString(value);
  return normalized === null ? { ok: false, value: null } : { ok: true, value: normalized };
}

function parseRequiredStringField(value: unknown): { ok: boolean; value: string | null } {
  const parsed = parseNullableStringField(value);
  if (!parsed.ok || parsed.value === null) {
    return { ok: false, value: null };
  }
  return parsed;
}

function parseNullableNumberField(
  value: unknown,
  predicate: (candidate: number) => boolean
): { ok: boolean; value: number | null } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isFiniteNumber(value) || !predicate(value)) {
    return { ok: false, value: null };
  }
  return { ok: true, value };
}

function parseLocations(value: unknown): ReaderResumeLocations | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!hasExactKeys(value, ["text_offset", "progression", "total_progression", "position"])) {
    return null;
  }
  const textOffset = parseNullableNumberField(
    value.text_offset,
    (candidate) => Number.isInteger(candidate) && candidate >= 0
  );
  const progression = parseNullableNumberField(
    value.progression,
    (candidate) => candidate >= 0 && candidate <= 1
  );
  const totalProgression = parseNullableNumberField(
    value.total_progression,
    (candidate) => candidate >= 0 && candidate <= 1
  );
  const position = parseNullableNumberField(
    value.position,
    (candidate) => Number.isInteger(candidate) && candidate >= 1
  );
  if (!textOffset.ok || !progression.ok || !totalProgression.ok || !position.ok) {
    return null;
  }
  const locations: ReaderResumeLocations = {
    text_offset: textOffset.value,
    progression: progression.value,
    total_progression: totalProgression.value,
    position: position.value,
  };
  return locations;
}

export const QUOTE_MAX_CODE_POINTS = 256;
export const QUOTE_CONTEXT_MAX_CODE_POINTS = 128;

function withinCodePointBound(value: string | null, maxCodePoints: number): boolean {
  return value === null || [...value].length <= maxCodePoints;
}

function parseTextContext(value: unknown): ReaderResumeTextContext | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!hasExactKeys(value, ["quote", "quote_prefix", "quote_suffix"])) {
    return null;
  }
  const quote = parseNullableStringField(value.quote);
  const quotePrefix = parseNullableStringField(value.quote_prefix);
  const quoteSuffix = parseNullableStringField(value.quote_suffix);
  if (!quote.ok || !quotePrefix.ok || !quoteSuffix.ok) {
    return null;
  }
  if (
    !withinCodePointBound(quote.value, QUOTE_MAX_CODE_POINTS) ||
    !withinCodePointBound(quotePrefix.value, QUOTE_CONTEXT_MAX_CODE_POINTS) ||
    !withinCodePointBound(quoteSuffix.value, QUOTE_CONTEXT_MAX_CODE_POINTS)
  ) {
    return null;
  }
  const text: ReaderResumeTextContext = {
    quote: quote.value,
    quote_prefix: quotePrefix.value,
    quote_suffix: quoteSuffix.value,
  };

  if (text.quote === null && (text.quote_prefix !== null || text.quote_suffix !== null)) {
    return null;
  }

  return text;
}

export function isPdfReaderResumeState(
  value: ReaderResumeState | null | undefined
): value is PdfReaderResumeState {
  return value?.kind === "pdf";
}

export function isReflowableReaderResumeState(
  value: ReaderResumeState | null | undefined
): value is ReflowableReaderResumeState {
  return value?.kind === "web" || value?.kind === "transcript" || value?.kind === "epub";
}

export function parseReaderResumeState(value: unknown): ReaderResumeState | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("Invalid reader state payload");
  }

  const kind = normalizeString(value.kind);
  if (kind === null) {
    throw new Error("Invalid reader state payload");
  }

  if (kind === "pdf") {
    if (!hasExactKeys(value, ["kind", "page", "page_progression", "zoom", "position"])) {
      throw new Error("Invalid reader state payload");
    }
    const page = parseNullableNumberField(
      value.page,
      (candidate) => Number.isInteger(candidate) && candidate >= 1
    );
    const pageProgression = parseNullableNumberField(
      value.page_progression,
      (candidate) => candidate >= 0 && candidate <= 1
    );
    const zoom = parseNullableNumberField(
      value.zoom,
      (candidate) => candidate >= 0.25 && candidate <= 4
    );
    const position = parseNullableNumberField(
      value.position,
      (candidate) => Number.isInteger(candidate) && candidate >= 1
    );
    if (!page.ok || page.value === null || !pageProgression.ok || !zoom.ok || !position.ok) {
      throw new Error("Invalid reader state payload");
    }
    return {
      kind,
      page: page.value,
      page_progression: pageProgression.value,
      zoom: zoom.value,
      position: position.value,
    };
  }

  const target = value.target;
  const locations = parseLocations(value.locations);
  const text = parseTextContext(value.text);
  if (!isRecord(target) || locations === null || text === null) {
    throw new Error("Invalid reader state payload");
  }

  if (kind === "web" || kind === "transcript") {
    if (!hasExactKeys(value, ["kind", "target", "locations", "text"])) {
      throw new Error("Invalid reader state payload");
    }
    if (!hasExactKeys(target, ["fragment_id"])) {
      throw new Error("Invalid reader state payload");
    }
    const fragmentId = parseRequiredStringField(target.fragment_id);
    if (!fragmentId.ok || fragmentId.value === null) {
      throw new Error("Invalid reader state payload");
    }
    return {
      kind,
      target: { fragment_id: fragmentId.value },
      locations,
      text,
    };
  }

  if (kind === "epub") {
    if (!hasExactKeys(value, ["kind", "target", "locations", "text"])) {
      throw new Error("Invalid reader state payload");
    }
    if (!hasExactKeys(target, ["section_id", "href_path", "anchor_id"])) {
      throw new Error("Invalid reader state payload");
    }
    const sectionId = parseRequiredStringField(target.section_id);
    const hrefPath = parseRequiredStringField(target.href_path);
    const anchorId = parseNullableStringField(target.anchor_id);
    if (
      !sectionId.ok ||
      sectionId.value === null ||
      !hrefPath.ok ||
      hrefPath.value === null ||
      !anchorId.ok
    ) {
      throw new Error("Invalid reader state payload");
    }
    return {
      kind,
      target: {
        section_id: sectionId.value,
        href_path: hrefPath.value,
        anchor_id: anchorId.value,
      },
      locations,
      text,
    };
  }

  throw new Error("Invalid reader state payload");
}

function reflowableReaderResumeStatesEqual(
  left: ReflowableReaderResumeState,
  right: ReflowableReaderResumeState
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "epub" && right.kind === "epub"
      ? left.target.section_id === right.target.section_id &&
        left.target.href_path === right.target.href_path &&
        left.target.anchor_id === right.target.anchor_id
      : left.kind !== "epub" &&
        right.kind !== "epub" &&
        left.target.fragment_id === right.target.fragment_id) &&
    left.locations.text_offset === right.locations.text_offset &&
    left.locations.progression === right.locations.progression &&
    left.locations.total_progression === right.locations.total_progression &&
    left.locations.position === right.locations.position &&
    left.text.quote === right.text.quote &&
    left.text.quote_prefix === right.text.quote_prefix &&
    left.text.quote_suffix === right.text.quote_suffix
  );
}

export function readerResumeStatesEqual(
  left: ReaderResumeState | null,
  right: ReaderResumeState | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "pdf" && right.kind === "pdf") {
    return (
      left.page === right.page &&
      left.page_progression === right.page_progression &&
      left.zoom === right.zoom &&
      left.position === right.position
    );
  }
  if (isReflowableReaderResumeState(left) && isReflowableReaderResumeState(right)) {
    return reflowableReaderResumeStatesEqual(left, right);
  }
  return false;
}
