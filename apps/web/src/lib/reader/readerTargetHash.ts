import { apiFetch } from "@/lib/api/client";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { decodePdfHighlightQuad, type PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import {
  expectExactRecord,
  expectInteger,
  expectRecord,
  expectString,
} from "@/lib/validation";

export type ReaderTargetKind =
  | "evidence"
  | "fragment"
  | "highlight"
  | "page"
  | "loc"
  | "t";

export interface ReaderTarget {
  kind: ReaderTargetKind | "source";
  value: string;
  origin: "hash" | "pulse" | "manual";
}

interface TextOffsets {
  fragmentId: string;
  startOffset: number;
  endOffset: number;
}

export type ResolvedHighlightReaderTarget =
  | ({ kind: "WebTextOffsets" } & TextOffsets)
  | ({ kind: "EpubTextOffsets"; sectionId: string } & TextOffsets)
  | ({
      kind: "TranscriptTextOffsets";
      timeRange: Presence<{ startMs: number; endMs: number }>;
    } & TextOffsets)
  | {
      kind: "PdfPageGeometry";
      sourceSha256: string;
      pageNumber: number;
      quads: PdfHighlightQuad[];
    }
  /**
   * An intact highlight whose geometry no published source binary accounts
   * for. Its authored text and notes remain readable; only the position is
   * withheld, so the reader offers the explicit reanchoring choice instead of
   * reporting a missing highlight.
   */
  | { kind: "UnresolvedSource" };

const KINDS: readonly ReaderTargetKind[] = [
  "evidence",
  "fragment",
  "highlight",
  "page",
  "loc",
  "t",
];

export function parseReaderTargetHash(
  hash: string,
): { kind: ReaderTargetKind; value: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const dash = raw.indexOf("-");
  if (dash <= 0 || dash === raw.length - 1) return null;
  const kind = raw.slice(0, dash);
  const value = raw.slice(dash + 1);
  if (!KINDS.includes(kind as ReaderTargetKind)) return null;
  if (value.length === 0 || /\s/.test(value)) return null;
  if (kind === "page") {
    if (!/^[0-9]+$/.test(value) || value === "0") return null;
  } else if (kind === "t") {
    if (!/^[0-9]+$/.test(value)) return null;
  }
  return { kind: kind as ReaderTargetKind, value };
}

function decodeBoundedInteger(
  raw: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = expectInteger(raw, name);
  if (value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside its supported range`);
  }
  return value;
}

function decodeTextOffsets(
  row: Record<string, unknown>,
  name: string,
): TextOffsets {
  const fragmentId = expectString(row.fragment_id, `${name}.fragment_id`);
  if (!fragmentId) {
    throw new TypeError(`${name}.fragment_id must not be empty`);
  }
  const startOffset = decodeBoundedInteger(
    row.start_offset,
    `${name}.start_offset`,
    0,
    2 ** 31 - 1,
  );
  const endOffset = decodeBoundedInteger(
    row.end_offset,
    `${name}.end_offset`,
    0,
    2 ** 31 - 1,
  );
  if (startOffset >= endOffset) {
    throw new TypeError(`${name} offsets must form a non-empty range`);
  }
  return { fragmentId, startOffset, endOffset };
}

export function decodeResolvedHighlightReaderTarget(
  raw: unknown,
): ResolvedHighlightReaderTarget {
  const envelope = expectExactRecord(
    raw,
    ["data"],
    "highlight reader target response",
  );
  const value = expectRecord(envelope.data, "highlight reader target");
  const kind = expectString(value.kind, "highlight reader target.kind");

  if (kind === "WebTextOffsets") {
    const row = expectExactRecord(
      value,
      ["kind", "fragment_id", "start_offset", "end_offset"],
      "highlight reader target",
    );
    return { kind, ...decodeTextOffsets(row, "highlight reader target") };
  }
  if (kind === "EpubTextOffsets") {
    const row = expectExactRecord(
      value,
      [
        "kind",
        "section_id",
        "fragment_id",
        "start_offset",
        "end_offset",
      ],
      "highlight reader target",
    );
    const sectionId = expectString(
      row.section_id,
      "highlight reader target.section_id",
    );
    if (!sectionId) {
      throw new TypeError(
        "highlight reader target.section_id must not be empty",
      );
    }
    return {
      kind,
      sectionId,
      ...decodeTextOffsets(row, "highlight reader target"),
    };
  }
  if (kind === "TranscriptTextOffsets") {
    const row = expectExactRecord(
      value,
      [
        "kind",
        "fragment_id",
        "start_offset",
        "end_offset",
        "time_range",
      ],
      "highlight reader target",
    );
    const timeRange = decodePresence(row.time_range, (rawTimeRange) => {
      const range = expectExactRecord(
        rawTimeRange,
        ["start_ms", "end_ms"],
        "highlight reader target.time_range.value",
      );
      const startMs = decodeBoundedInteger(
        range.start_ms,
        "highlight reader target.time_range.value.start_ms",
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const endMs = decodeBoundedInteger(
        range.end_ms,
        "highlight reader target.time_range.value.end_ms",
        0,
        Number.MAX_SAFE_INTEGER,
      );
      if (startMs >= endMs) {
        throw new TypeError(
          "highlight reader target time range must be non-empty",
        );
      }
      return { startMs, endMs };
    });
    return {
      kind,
      timeRange,
      ...decodeTextOffsets(row, "highlight reader target"),
    };
  }
  if (kind === "PdfPageGeometry") {
    const row = expectExactRecord(
      value,
      ["kind", "source_sha256", "page_number", "quads"],
      "highlight reader target",
    );
    if (typeof row.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.source_sha256)) {
      throw new TypeError("highlight reader target.source_sha256 must be a SHA-256 digest");
    }
    if (!Array.isArray(row.quads) || row.quads.length < 1 || row.quads.length > 512) {
      throw new TypeError(
        "highlight reader target.quads must contain 1 to 512 quads",
      );
    }
    return {
      kind,
      sourceSha256: row.source_sha256,
      pageNumber: decodeBoundedInteger(
        row.page_number,
        "highlight reader target.page_number",
        1,
        2 ** 31 - 1,
      ),
      quads: row.quads.map((raw, index) => decodePdfHighlightQuad(raw, `highlight reader target.quads[${index}]`)),
    };
  }
  if (kind === "UnresolvedSource") {
    expectExactRecord(value, ["kind"], "highlight reader target");
    return { kind };
  }
  throw new TypeError(`Unsupported highlight reader target kind: ${kind}`);
}

export async function fetchResolvedHighlightReaderTarget(
  highlightId: string,
  signal?: AbortSignal,
): Promise<ResolvedHighlightReaderTarget> {
  return decodeResolvedHighlightReaderTarget(
    await apiFetch<unknown>(
      `/api/highlights/${encodeURIComponent(highlightId)}/reader-target`,
      { cache: "no-store", signal },
    ),
  );
}
