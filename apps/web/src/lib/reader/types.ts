/**
 * Reader profile and persisted resume-state types.
 *
 * Backend contract assumptions:
 * - GET /api/me/reader-profile returns { data: ReaderProfile }
 * - PATCH /api/me/reader-profile accepts Partial<ReaderProfile>
 * - GET /api/media/{id}/reader-state returns { data: ReaderResumeState | null }
 * - PUT /api/media/{id}/reader-state accepts ReaderResumeState | null
 */

export type ReaderTheme = "light" | "dark";
export type ReaderFontFamily = "serif" | "sans";
export type ReaderFocusMode = "off" | "distraction_free" | "paragraph" | "sentence";
export type ReaderHyphenation = "auto" | "off";

export interface ReaderProfile {
  theme: ReaderTheme;
  font_family: ReaderFontFamily;
  font_size_px: number;
  line_height: number;
  column_width_ch: number;
  focus_mode: ReaderFocusMode;
  hyphenation: ReaderHyphenation;
}

export const DEFAULT_READER_PROFILE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: "off",
  hyphenation: "auto",
};

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

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return isFiniteNumber(value) ? value : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: string[]): boolean {
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function parseNullableStringField(value: unknown): { ok: boolean; value: string | null } {
  if (value === null || value === undefined) {
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
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  const normalized = normalizeNullableNumber(value);
  if (normalized === null || !predicate(normalized)) {
    return { ok: false, value: null };
  }
  return { ok: true, value: normalized };
}

function parseLocations(value: unknown): ReaderResumeLocations | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["text_offset", "progression", "total_progression", "position"])) {
    return null;
  }
  const textOffset = parseNullableNumberField(
    record.text_offset,
    (candidate) => Number.isInteger(candidate) && candidate >= 0
  );
  const progression = parseNullableNumberField(
    record.progression,
    (candidate) => candidate >= 0 && candidate <= 1
  );
  const totalProgression = parseNullableNumberField(
    record.total_progression,
    (candidate) => candidate >= 0 && candidate <= 1
  );
  const position = parseNullableNumberField(
    record.position,
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

function parseTextContext(value: unknown): ReaderResumeTextContext | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["quote", "quote_prefix", "quote_suffix"])) {
    return null;
  }
  const quote = parseNullableStringField(record.quote);
  const quotePrefix = parseNullableStringField(record.quote_prefix);
  const quoteSuffix = parseNullableStringField(record.quote_suffix);
  if (!quote.ok || !quotePrefix.ok || !quoteSuffix.ok) {
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
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const kind = normalizeString(record.kind);
  if (kind === null) {
    return null;
  }

  if (kind === "pdf") {
    if (!hasOnlyKeys(record, ["kind", "page", "page_progression", "zoom", "position"])) {
      return null;
    }
    const page = parseNullableNumberField(
      record.page,
      (candidate) => Number.isInteger(candidate) && candidate >= 1
    );
    const pageProgression = parseNullableNumberField(
      record.page_progression,
      (candidate) => candidate >= 0 && candidate <= 1
    );
    const zoom = parseNullableNumberField(
      record.zoom,
      (candidate) => candidate >= 0.25 && candidate <= 4
    );
    const position = parseNullableNumberField(
      record.position,
      (candidate) => Number.isInteger(candidate) && candidate >= 1
    );
    if (!page.ok || page.value === null || !pageProgression.ok || !zoom.ok || !position.ok) {
      return null;
    }
    return {
      kind,
      page: page.value,
      page_progression: pageProgression.value,
      zoom: zoom.value,
      position: position.value,
    };
  }

  const target = record.target;
  const locations = parseLocations(record.locations);
  const text = parseTextContext(record.text);
  if (typeof target !== "object" || target === null || locations === null || text === null) {
    return null;
  }

  const targetRecord = target as Record<string, unknown>;
  if (kind === "web" || kind === "transcript") {
    if (!hasOnlyKeys(record, ["kind", "target", "locations", "text"])) {
      return null;
    }
    if (!hasOnlyKeys(targetRecord, ["fragment_id"])) {
      return null;
    }
    const fragmentId = parseRequiredStringField(targetRecord.fragment_id);
    if (!fragmentId.ok || fragmentId.value === null) {
      return null;
    }
    return {
      kind,
      target: { fragment_id: fragmentId.value },
      locations,
      text,
    };
  }

  if (kind === "epub") {
    if (!hasOnlyKeys(record, ["kind", "target", "locations", "text"])) {
      return null;
    }
    if (!hasOnlyKeys(targetRecord, ["section_id", "href_path", "anchor_id"])) {
      return null;
    }
    const sectionId = parseRequiredStringField(targetRecord.section_id);
    const hrefPath = parseRequiredStringField(targetRecord.href_path);
    const anchorId = parseNullableStringField(targetRecord.anchor_id);
    if (
      !sectionId.ok ||
      sectionId.value === null ||
      !hrefPath.ok ||
      hrefPath.value === null ||
      !anchorId.ok
    ) {
      return null;
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

  return null;
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
  return reflowableReaderResumeStatesEqual(
    left as ReflowableReaderResumeState,
    right as ReflowableReaderResumeState
  );
}
