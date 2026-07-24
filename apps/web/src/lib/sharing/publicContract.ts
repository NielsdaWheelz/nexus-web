import { isRecord } from "@/lib/validation";

export type Presence<T> =
  | { kind: "Absent" }
  | { kind: "Present"; value: T };

export type PublicHighlightAnchor =
  | {
      kind: "ArticleText";
      fragmentOrdinal: number;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "EpubText";
      sectionHandle: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      kind: "TranscriptText";
      segmentOrdinal: number;
      startOffset: number;
      endOffset: number;
      timeRange: Presence<{ startMs: number; endMs: number }>;
    }
  | {
      kind: "PdfGeometry";
      pageNumber: number;
      quads: PublicPdfQuad[];
    };

export interface PublicPdfQuad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

export interface PublicHighlight {
  quote: Presence<string>;
  color: "Yellow" | "Green" | "Blue" | "Pink" | "Purple";
  anchor: PublicHighlightAnchor;
}

export interface PublicShareBootstrap {
  version: "V1";
  subject:
    | { kind: "Media" }
    | { kind: "Highlight"; highlight: PublicHighlight };
  media: {
    title: string;
    mediaKind: "Article" | "Epub" | "Pdf" | "Video" | "PodcastEpisode";
    sourceUrl: Presence<string>;
    bylines: string[];
  };
  reader:
    | { kind: "Article" }
    | { kind: "Epub" }
    | { kind: "Pdf"; byteLength: number; filename: string }
    | {
        kind: "Transcript";
        sourceKind: "Video" | "PodcastEpisode";
        durationMs: Presence<number>;
      };
}

export type PublicFragmentPage =
  | {
      kind: "ArticleFragments";
      items: Array<{
        ordinal: number;
        htmlSanitized: string;
        canonicalText: string;
      }>;
      nextCursor: Presence<string>;
    }
  | {
      kind: "TranscriptSegments";
      items: Array<{
        ordinal: number;
        canonicalText: string;
        timeRange: Presence<{ startMs: number; endMs: number }>;
        speaker: Presence<string>;
      }>;
      nextCursor: Presence<string>;
    };

export interface PublicNavigationPage {
  items: Array<{
    ordinal: number;
    label: string;
    depth: number;
    sectionHandle: string;
  }>;
  nextCursor: Presence<string>;
}

export interface PublicSection {
  ordinal: number;
  sectionHandle: string;
  htmlSanitized: string;
  canonicalText: string;
}

const TOKEN_RE = /^nxshr1_[A-Za-z0-9_-]{43}$/;
const SECTION_RE = /^nxps1_[A-Za-z0-9_-]{48}$/;
const CURSOR_RE = /^nxpc1_[A-Za-z0-9_-]{48}$/;
const MAX_SAFE_UINT = Number.MAX_SAFE_INTEGER;

export class PublicShareContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: same-system public wire drift is an implementation defect.
    super(message);
    this.name = "PublicShareContractDefect";
  }
}

export function parsePublicShareFragment(hash: string): string | null {
  const match = /^#share=(nxshr1_[A-Za-z0-9_-]{43})$/.exec(hash);
  return match && TOKEN_RE.test(match[1]) ? match[1] : null;
}

export function decodePublicShareBootstrap(raw: unknown): PublicShareBootstrap {
  const data = envelope(raw);
  exact(data, ["version", "subject", "media", "reader"], "bootstrap");
  if (data.version !== "V1") defect("bootstrap.version");
  const media = record(data.media, "bootstrap.media");
  exact(media, ["title", "media_kind", "source_url", "bylines"], "bootstrap.media");
  const title = boundedString(media.title, 1, 1024, "media.title");
  const mediaKind = oneOf(
    media.media_kind,
    ["Article", "Epub", "Pdf", "Video", "PodcastEpisode"] as const,
    "media.media_kind"
  );
  if (!Array.isArray(media.bylines) || media.bylines.length > 32) {
    defect("media.bylines");
  }
  const bylines = media.bylines.map((value, index) =>
    boundedString(value, 1, 512, `media.bylines[${index}]`)
  );
  const sourceUrl = presence(media.source_url, (value) => {
    const url = boundedBytes(value, 2048, "media.source_url");
    if (url.length === 0) defect("media.source_url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return defect("media.source_url");
    }
    const hostname = parsed.hostname.toLowerCase();
    const labels = hostname.split(".");
    const blockedSuffix =
      hostname === "localhost" ||
      [
        ".example",
        ".home",
        ".internal",
        ".invalid",
        ".lan",
        ".local",
        ".localhost",
        ".test",
      ].some((suffix) => hostname.endsWith(suffix));
    const isIpLiteral =
      hostname.startsWith("[") ||
      /^\d+$/.test(hostname) ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
    const isCanonicalYoutube =
      /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      labels.length < 2 ||
      labels.some(
        (label) =>
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
      ) ||
      blockedSuffix ||
      isIpLiteral ||
      (parsed.search !== "" && !isCanonicalYoutube) ||
      parsed.href !== url
    ) {
      defect("media.source_url");
    }
    return url;
  });
  const subject = decodeSubject(data.subject);
  const reader = decodeReader(data.reader);
  if (
    (mediaKind === "Article" && reader.kind !== "Article") ||
    (mediaKind === "Epub" && reader.kind !== "Epub") ||
    (mediaKind === "Pdf" && reader.kind !== "Pdf") ||
    ((mediaKind === "Video" || mediaKind === "PodcastEpisode") &&
      reader.kind !== "Transcript")
  ) {
    defect("bootstrap media/reader mismatch");
  }
  return { version: "V1", subject, media: { title, mediaKind, sourceUrl, bylines }, reader };
}

export function decodePublicFragmentPage(raw: unknown): PublicFragmentPage {
  const data = envelope(raw);
  const kind = data.kind;
  exact(data, ["kind", "items", "page_info"], "fragment page");
  const nextCursor = pageInfo(data.page_info);
  if (!Array.isArray(data.items)) defect("fragment page.items");
  if (kind === "ArticleFragments") {
    return {
      kind,
      items: data.items.map((rawItem, index) => {
        const item = record(rawItem, `article.items[${index}]`);
        exact(item, ["ordinal", "html_sanitized", "canonical_text"], "article item");
        return {
          ordinal: int32(item.ordinal, "article.ordinal"),
          htmlSanitized: boundedBytes(item.html_sanitized, 2 * 1024 * 1024, "article.html"),
          canonicalText: boundedBytes(item.canonical_text, 2 * 1024 * 1024, "article.text"),
        };
      }),
      nextCursor,
    };
  }
  if (kind === "TranscriptSegments") {
    return {
      kind,
      items: data.items.map((rawItem, index) => {
        const item = record(rawItem, `transcript.items[${index}]`);
        exact(
          item,
          ["ordinal", "canonical_text", "time_range", "speaker"],
          "transcript item"
        );
        return {
          ordinal: int32(item.ordinal, "transcript.ordinal"),
          canonicalText: boundedBytes(
            item.canonical_text,
            2 * 1024 * 1024,
            "transcript.text"
          ),
          timeRange: presence(item.time_range, decodeTimeRange),
          speaker: presence(item.speaker, (value) =>
            boundedString(value, 0, 512, "transcript.speaker")
          ),
        };
      }),
      nextCursor,
    };
  }
  return defect("fragment page.kind");
}

export function decodePublicNavigationPage(raw: unknown): PublicNavigationPage {
  const data = envelope(raw);
  exact(data, ["kind", "items", "page_info"], "navigation");
  if (data.kind !== "EpubNavigation" || !Array.isArray(data.items)) {
    defect("navigation");
  }
  return {
    items: data.items.map((rawItem, index) => {
      const item = record(rawItem, `navigation.items[${index}]`);
      exact(item, ["ordinal", "label", "depth", "section_handle"], "navigation item");
      const sectionHandle = boundedString(
        item.section_handle,
        54,
        54,
        "navigation.section_handle"
      );
      if (!SECTION_RE.test(sectionHandle)) defect("navigation.section_handle");
      return {
        ordinal: int32(item.ordinal, "navigation.ordinal"),
        label: boundedString(item.label, 0, 512, "navigation.label"),
        depth: int32(item.depth, "navigation.depth"),
        sectionHandle,
      };
    }),
    nextCursor: pageInfo(data.page_info),
  };
}

export function decodePublicSection(raw: unknown): PublicSection {
  const data = envelope(raw);
  exact(
    data,
    ["kind", "ordinal", "section_handle", "html_sanitized", "canonical_text"],
    "section"
  );
  if (data.kind !== "EpubSection") defect("section.kind");
  const sectionHandle = boundedString(data.section_handle, 54, 54, "section.handle");
  if (!SECTION_RE.test(sectionHandle)) defect("section.handle");
  return {
    ordinal: int32(data.ordinal, "section.ordinal"),
    sectionHandle,
    htmlSanitized: boundedBytes(data.html_sanitized, 4 * 1024 * 1024, "section.html"),
    canonicalText: boundedBytes(data.canonical_text, 4 * 1024 * 1024, "section.text"),
  };
}

function decodeSubject(
  raw: unknown
): PublicShareBootstrap["subject"] {
  const value = record(raw, "subject");
  if (value.kind === "Media") {
    exact(value, ["kind"], "subject.Media");
    return { kind: "Media" };
  }
  if (value.kind === "Highlight") {
    exact(value, ["kind", "highlight"], "subject.Highlight");
    return { kind: "Highlight", highlight: decodeHighlight(value.highlight) };
  }
  return defect("subject.kind");
}

function decodeHighlight(raw: unknown): PublicHighlight {
  const value = record(raw, "highlight");
  exact(value, ["quote", "color", "anchor"], "highlight");
  return {
    quote: presence(value.quote, (quote) =>
      boundedBytes(quote, 65_536, "highlight.quote")
    ),
    color: oneOf(
      value.color,
      ["Yellow", "Green", "Blue", "Pink", "Purple"] as const,
      "highlight.color"
    ),
    anchor: decodeAnchor(value.anchor),
  };
}

function decodeAnchor(raw: unknown): PublicHighlightAnchor {
  const value = record(raw, "highlight.anchor");
  switch (value.kind) {
    case "ArticleText":
      exact(
        value,
        ["kind", "fragment_ordinal", "start_offset", "end_offset"],
        "ArticleText"
      );
      return offsetAnchor("ArticleText", value, {
        fragmentOrdinal: int32(value.fragment_ordinal, "fragment_ordinal"),
      });
    case "EpubText": {
      exact(
        value,
        ["kind", "section_handle", "start_offset", "end_offset"],
        "EpubText"
      );
      const sectionHandle = boundedString(value.section_handle, 54, 54, "section_handle");
      if (!SECTION_RE.test(sectionHandle)) defect("section_handle");
      return offsetAnchor("EpubText", value, { sectionHandle });
    }
    case "TranscriptText":
      exact(
        value,
        [
          "kind",
          "segment_ordinal",
          "start_offset",
          "end_offset",
          "time_range",
        ],
        "TranscriptText"
      );
      return offsetAnchor("TranscriptText", value, {
        segmentOrdinal: int32(value.segment_ordinal, "segment_ordinal"),
        timeRange: presence(value.time_range, decodeTimeRange),
      });
    case "PdfGeometry":
      exact(value, ["kind", "page_number", "quads"], "PdfGeometry");
      if (
        !Array.isArray(value.quads) ||
        value.quads.length < 1 ||
        value.quads.length > 512
      ) {
        defect("PdfGeometry.quads");
      }
      return {
        kind: "PdfGeometry",
        pageNumber: positiveInt32(value.page_number, "page_number"),
        quads: value.quads.map(decodeQuad),
      };
    default:
      return defect("highlight.anchor.kind");
  }
}

function offsetAnchor<T extends "ArticleText" | "EpubText" | "TranscriptText", E>(
  kind: T,
  value: Record<string, unknown>,
  extra: E
): Extract<PublicHighlightAnchor, { kind: T }> {
  const startOffset = int32(value.start_offset, "start_offset");
  const endOffset = int32(value.end_offset, "end_offset");
  if (startOffset >= endOffset) defect("highlight offsets");
  return { kind, startOffset, endOffset, ...extra } as Extract<
    PublicHighlightAnchor,
    { kind: T }
  >;
}

function decodeQuad(raw: unknown): PublicPdfQuad {
  const value = record(raw, "PDF quad");
  const keys = ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"] as const;
  exact(value, [...keys], "PDF quad");
  return Object.fromEntries(
    keys.map((key) => [key, finite(value[key], `quad.${key}`)])
  ) as unknown as PublicPdfQuad;
}

function decodeReader(raw: unknown): PublicShareBootstrap["reader"] {
  const value = record(raw, "reader");
  switch (value.kind) {
    case "Article":
      exact(value, ["kind"], "reader.Article");
      return { kind: "Article" };
    case "Epub":
      exact(value, ["kind"], "reader.Epub");
      return { kind: "Epub" };
    case "Pdf":
      exact(value, ["kind", "byte_length", "filename"], "reader.Pdf");
      return {
        kind: "Pdf",
        byteLength: safeUint(value.byte_length, "reader.byte_length", true),
        filename: boundedString(value.filename, 1, 255, "reader.filename"),
      };
    case "Transcript":
      exact(value, ["kind", "source_kind", "duration_ms"], "reader.Transcript");
      return {
        kind: "Transcript",
        sourceKind: oneOf(
          value.source_kind,
          ["Video", "PodcastEpisode"] as const,
          "reader.source_kind"
        ),
        durationMs: presence(value.duration_ms, (duration) =>
          safeUint(duration, "reader.duration_ms")
        ),
      };
    default:
      return defect("reader.kind");
  }
}

function decodeTimeRange(raw: unknown): { startMs: number; endMs: number } {
  const value = record(raw, "time range");
  exact(value, ["start_ms", "end_ms"], "time range");
  const startMs = safeUint(value.start_ms, "time.start_ms");
  const endMs = safeUint(value.end_ms, "time.end_ms");
  if (startMs >= endMs) defect("time range order");
  return { startMs, endMs };
}

function pageInfo(raw: unknown): Presence<string> {
  const value = record(raw, "page_info");
  exact(value, ["next_cursor"], "page_info");
  return presence(value.next_cursor, (cursor) => {
    const decoded = boundedString(cursor, 54, 54, "next_cursor");
    if (!CURSOR_RE.test(decoded)) defect("next_cursor");
    return decoded;
  });
}

function envelope(raw: unknown): Record<string, unknown> {
  const value = record(raw, "response");
  exact(value, ["data"], "response");
  return record(value.data, "response.data");
}

function presence<T>(
  raw: unknown,
  decodeValue: (value: unknown) => T
): Presence<T> {
  const value = record(raw, "Presence");
  if (value.kind === "Absent") {
    exact(value, ["kind"], "Presence.Absent");
    return { kind: "Absent" };
  }
  if (value.kind === "Present") {
    exact(value, ["kind", "value"], "Presence.Present");
    return { kind: "Present", value: decodeValue(value.value) };
  }
  return defect("Presence.kind");
}

function record(raw: unknown, path: string): Record<string, unknown> {
  if (!isRecord(raw)) defect(path);
  return raw;
}

function exact(
  value: Record<string, unknown>,
  keys: string[],
  path: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    defect(`${path} fields`);
  }
}

function boundedString(
  raw: unknown,
  min: number,
  max: number,
  path: string
): string {
  if (typeof raw !== "string") defect(path);
  const length = Array.from(raw).length;
  if (length < min || length > max) defect(path);
  return raw;
}

function boundedBytes(raw: unknown, max: number, path: string): string {
  const value = boundedString(raw, 0, Number.MAX_SAFE_INTEGER, path);
  if (new TextEncoder().encode(value).byteLength > max) defect(path);
  return value;
}

function safeUint(raw: unknown, path: string, positive = false): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < (positive ? 1 : 0) ||
    raw > MAX_SAFE_UINT
  ) {
    defect(path);
  }
  return raw;
}

function int32(raw: unknown, path: string): number {
  const value = safeUint(raw, path);
  if (value > 2_147_483_647) defect(path);
  return value;
}

function positiveInt32(raw: unknown, path: string): number {
  const value = int32(raw, path);
  if (value < 1) defect(path);
  return value;
}

function finite(raw: unknown, path: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) defect(path);
  return raw;
}

function oneOf<const T extends readonly string[]>(
  raw: unknown,
  values: T,
  path: string
): T[number] {
  if (typeof raw !== "string" || !values.includes(raw)) defect(path);
  return raw as T[number];
}

function defect(path: string): never {
  throw new PublicShareContractDefect(`Invalid public sharing contract at ${path}`);
}
