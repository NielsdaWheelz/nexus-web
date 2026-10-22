// The publication model: an immutable text body (or one pdf) under
// one identity, the points and targets that address it, and the one mapping
// between its points and the cursor's wire locator. Offsets are codepoints
// into a unit's canonical text, half-open.
import type { Schema } from "@/lib/api/wire";

export type ReaderDocumentOut =
  Schema<"ReaderTextDocumentOut"> | Schema<"ReaderTranscriptDocumentOut"> | Schema<"ReaderPdfDocumentOut">;
export type Locator = Schema<"CursorWrite">["locator"];
export type CursorSnapshot =
  Schema<"ReaderCursorEmpty"> | Schema<"ReaderCursorPositioned"> | Schema<"ReaderCursorUnresolved">;
export type HighlightColor = Schema<"TypedHighlightOut">["color"];
export type PdfQuad = Schema<"HighlightTargetPdfQuadOut">;
export type SourceIssue =
  Schema<"ReaderTextDocumentOut">["source_issues"][number];
export type DocumentEmbed = Schema<"DocumentEmbedOut">;

export interface TextUnit {
  readonly id: string;
  readonly html: string;
  readonly text: string;
  readonly length: number;
  readonly xPost: Schema<"ReaderXPostOut"> | null;
  readonly hrefPath: string | null;
  readonly time: { readonly startMs: number; readonly endMs: number } | null;
  readonly speaker: string | null;
}
/** A displayed source interval. Insertion never changes the owner's offsets. */
export interface SourceRange {
  readonly unit: string;
  readonly start: number;
  readonly end: number;
  readonly position: number;
}
/** A media time as `m:ss`, or `h:mm:ss` from an hour. */
export const clock = (ms: number) =>
  new Date(ms).toISOString().slice(ms >= 3_600_000 ? 11 : 14, 19);

export interface TextPoint {
  readonly unit: string;
  readonly offset: number;
}
export interface Section {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly at: TextPoint | null;
  readonly anchorId: string | null;
}
export interface TranscriptChapter extends Section {
  readonly startMs: number;
  readonly endMs: number | null;
  readonly searchExtent: { readonly start: TextPoint; readonly end: TextPoint } | null;
}
export interface TocNode {
  readonly id: string;
  readonly label: string;
  readonly at: TextPoint | null;
  readonly sectionId: string | null;
  readonly children: readonly TocNode[];
}
/**
 * Where a pdf's bytes come from: a url pdf.js fetches itself (with same-origin
 * cookies), or the host's own range reads (`bytes=0-` streams the whole file,
 * `bytes=a-b` one chunk), each answered 206 with its Content-Range (the public
 * share's carry no credentials).
 */
export type PdfFile =
  | { readonly url: string; readonly expiresAtMs: number | null }
  | {
      readonly ranges: (
        range: string,
        signal: AbortSignal,
      ) => Promise<Response>;
    };

export type TextDocument = {
  readonly kind: "text";
  readonly format: "web" | "epub" | "transcript";
  readonly identity: string;
  readonly title: string;
  readonly transcriptNavigation: { readonly key: string; readonly chapters: readonly TranscriptChapter[] } | null;
  readonly transcriptCoverage: "full" | "partial" | null;
  readonly units: readonly TextUnit[];
  readonly ranges: readonly SourceRange[];
  readonly xCapture: Schema<"ReaderXCaptureOut"> | null;
  readonly xArticleContent: Schema<"XArticleContent"> | null;
  readonly length: number;
  readonly sections: readonly Section[];
  readonly toc: readonly TocNode[];
  readonly sourceIssues: readonly SourceIssue[];
  readonly embeds: readonly DocumentEmbed[];
};
export type PdfDocument = {
  readonly kind: "pdf";
  readonly identity: string;
  readonly title: string;
  readonly pages: number | null;
  readonly file: PdfFile;
};
/** Identity versions the body; chapter navigation, title and embedded presentation may change. */
export type ReaderDocument = TextDocument | PdfDocument;

export type ReaderPoint =
  | ({ readonly kind: "text" } & TextPoint)
  /** y: 0..1 down the page. */
  | { readonly kind: "pdf"; readonly page: number; readonly y: number };
export type ReaderTarget =
  | { readonly kind: "point"; readonly point: ReaderPoint }
  | {
      readonly kind: "range";
      readonly unit: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "anchor"; readonly unit: string; readonly id: string }
  | { readonly kind: "time"; readonly ms: number }
  | {
      readonly kind: "quads";
      readonly page: number;
      readonly quads: readonly PdfQuad[];
    }
  | { readonly kind: "pdf"; readonly page: number; readonly view: import("./location").PdfView }
  /** A transient match in the current PDF query; never a saved locator. */
  | { readonly kind: "pdfMatch"; readonly page: number; readonly index: number }
  | { readonly kind: "edge"; readonly edge: "start" | "end" };
/** Where the eye is: a point and its pixel offset from the visible reading line.
 * offsetPx is positive below the line and negative above it; never persisted. */
export interface Placement {
  readonly identity: string;
  readonly point: ReaderPoint;
  readonly offsetPx: number;
  readonly zoom: number | null;
}
export interface Viewport {
  readonly identity: string;
  /** At the reading line (the scrollport's scroll-padding-top). */
  readonly primary: ReaderPoint;
  /** The visible band, as document fractions. */
  readonly start: number;
  readonly end: number;
  readonly atEnd: boolean;
  readonly intent: "reader" | "programmatic";
}
export interface Structure {
  /** Codepoints, or pages for a pdf. */
  readonly length: number;
  fraction(point: ReaderPoint): number;
  sectionAt(point: ReaderPoint): Section | null;
  unit(id: string): TextUnit | undefined;
}

export const PDF_ZOOM = { min: 0.5, max: 2, step: 0.25 } as const;
export const clampZoom = (zoom: number) =>
  Math.min(PDF_ZOOM.max, Math.max(PDF_ZOOM.min, zoom));

/** The one wire→model mapping, shared by the hosted, shelf and public sources. */
export function readerDocument(out: ReaderDocumentOut): ReaderDocument {
  if (out.kind === "pdf") {
    const { url, expires_at } = out.file;
    return {
      kind: "pdf",
      identity: out.identity,
      title: out.title,
      pages: out.page_count,
      file: {
        url,
        expiresAtMs: expires_at === null ? null : Date.parse(expires_at),
      },
    };
  }
  const units = out.units.map((unit): TextUnit => {
    const mapped = {
      id: unit.id,
      html: unit.html_sanitized,
      text: unit.canonical_text,
      length: unit.char_count,
      xPost: unit.x_post,
      hrefPath: unit.href_path,
      time:
        unit.t_start_ms === null
          ? null
          : {
              startMs: unit.t_start_ms,
              endMs: unit.t_end_ms ?? unit.t_start_ms,
            },
      speaker: unit.speaker_label,
    };
    return mapped;
  });
  // The wire contains only roots and their direct X context, in stable slot order.
  const ranges: SourceRange[] = [];
  let length = 0;
  const append = (unit: TextUnit, start: number, end: number) => {
    if (end > start || unit.length === 0) ranges.push({ unit: unit.id, start, end, position: length });
    length += end - start;
  };
  const roots = units.filter((unit) => unit.xPost?.parent_unit_id == null);
  for (const root of roots) {
    let offset = 0;
    for (const child of units.filter((unit) => unit.xPost?.parent_unit_id === root.id)) {
      const slot = child.xPost!.insertion_offset ?? root.length;
      if (slot < offset || slot > root.length) throw new Error("source insertion is outside its ordered parent");
      append(root, offset, slot);
      append(child, 0, child.length);
      offset = slot;
    }
    append(root, offset, root.length);
  }
  if (roots.length + units.filter((unit) => roots.some((root) => unit.xPost?.parent_unit_id === root.id)).length !== units.length)
    throw new Error("reader publication contains context beyond one level");
  type PointOut = Schema<"ReaderPointOut">;
  type TocOut = Schema<"ReaderTocNodeOut">;
  const point = (at: PointOut): TextPoint => ({
    unit: at.unit_id,
    offset: at.offset,
  });
  const toc = (node: TocOut): TocNode => ({
    id: node.id,
    label: node.label,
    at: node.at === null ? null : point(node.at),
    sectionId: node.section_id,
    children: node.children.map(toc),
  });
  const transcriptNavigation = out.kind === "transcript" ? {
    key: out.transcript_navigation.key,
    chapters: out.transcript_navigation.chapters.map((chapter): TranscriptChapter => ({
      id: chapter.id, label: chapter.label, depth: 0, anchorId: null,
      startMs: chapter.start_ms, endMs: chapter.end_ms,
      at: chapter.at === null ? null : point(chapter.at),
      searchExtent: chapter.search_extent === null ? null : {
        start: point(chapter.search_extent.start), end: point(chapter.search_extent.end),
      },
    })),
  } : null;
  return {
    kind: "text",
    format: out.kind === "web_article" ? "web" : out.kind,
    identity: out.identity,
    title: out.title,
    units,
    ranges,
    transcriptNavigation,
    transcriptCoverage: out.kind === "transcript" ? out.transcript_coverage : null,
    xCapture: out.x_capture,
    xArticleContent: out.x_article_content,
    length,
    sections: transcriptNavigation?.chapters ?? out.sections.map((section) => ({
      id: section.id,
      label: section.label,
      depth: section.depth,
      at: point(section.at),
      anchorId: section.anchor_id,
    })),
    toc: transcriptNavigation ? transcriptNavigation.chapters.map((chapter) => ({
      id: chapter.id, label: chapter.label, at: chapter.at, sectionId: chapter.id, children: [],
    })) : out.toc_nodes.map(toc),
    sourceIssues: out.source_issues,
    embeds: out.embeds,
  };
}

/** Half-open source coverage; publication order breaks overlaps. */
export function transcriptUnitAtTime(units: readonly TextUnit[], ms: number): TextUnit | null {
  return units.findLast((unit) => unit.time !== null && unit.time.startMs <= ms && ms < unit.time.endMs) ?? null;
}

/** A reading chapter requires unique whole-cue membership, independently of playback. */
export function transcriptChapterAtPoint(doc: TextDocument, point: TextPoint): TranscriptChapter | null {
  const time = doc.units.find((unit) => unit.id === point.unit)?.time;
  if (!time || time.endMs <= time.startMs) return null;
  const chapters = doc.transcriptNavigation?.chapters.filter((chapter) =>
    chapter.endMs !== null && chapter.startMs <= time.startMs && time.endMs <= chapter.endMs,
  ) ?? [];
  return chapters.length === 1 ? chapters[0] : null;
}

export function structureOf(
  doc: ReaderDocument,
  pages: number | null,
): Structure {
  if (doc.kind === "pdf") {
    const length = pages ?? doc.pages ?? 1;
    return {
      length,
      fraction: (p) =>
        p.kind === "pdf" ? Math.min(1, (p.page - 1 + p.y) / length) : 0,
      sectionAt: () => null,
      unit: () => undefined,
    };
  }
  const units = new Map(doc.units.map((unit) => [unit.id, unit]));
  const offset = (p: TextPoint) => {
    const range = doc.ranges.findLast((range) => range.unit === p.unit && range.start <= p.offset);
    return range ? range.position + Math.min(p.offset, range.end) - range.start : 0;
  };
  const sections = doc.sections
    .flatMap((section) => section.at === null ? [] : [{ section, at: offset(section.at) }])
    .sort((a, b) => a.at - b.at);
  return {
    length: doc.length,
    fraction: (p) =>
      p.kind === "text" && doc.length > 0 ? offset(p) / doc.length : 0,
    sectionAt: (p) =>
      p.kind === "text"
        ? doc.transcriptNavigation !== null
          ? transcriptChapterAtPoint(doc, p)
          : (sections.findLast((entry) => entry.at <= offset(p))?.section ?? null)
        : null,
    unit: (id) => units.get(id),
  };
}

/** The cursor's locator at a point: exact offset and fraction; the legacy fields stay null. */
export function locatorAt(
  doc: ReaderDocument,
  structure: Structure,
  point: ReaderPoint,
  extra: { readonly terminal: boolean; readonly zoom: number | null },
): Locator {
  if (point.kind === "pdf") {
    // A pdf's progression is page-local; the end of the document needs no marker.
    return {
      kind: "pdf",
      page: point.page,
      page_progression: point.y,
      zoom: extra.zoom,
      position: null,
    };
  }
  const last = doc.kind === "text" ? doc.ranges.at(-1) : undefined;
  const at =
    extra.terminal && last ? { unit: last.unit, offset: last.end } : point;
  const unit = structure.unit(at.unit);
  const locations = {
    text_offset: at.offset,
    progression: null,
    total_progression: extra.terminal
      ? 1
      : Math.min(1, structure.fraction({ kind: "text", ...at })),
    position: null,
  };
  const text = { quote: null, quote_prefix: null, quote_suffix: null };
  if (unit?.xPost?.owner) {
    return { kind: "x", occurrence_id: at.unit, post_media_id: unit.xPost.owner.media_id,
      source_revision_id: unit.xPost.source_revision_id, locations, text };
  }
  if (doc.kind === "text" && doc.format === "epub") {
    return {
      kind: "epub",
      target: {
        fragment_id: at.unit,
        href_path: unit?.hrefPath ?? "",
        anchor_id: null,
      },
      locations,
      text,
    };
  }
  const kind =
    doc.kind === "text" && doc.format === "transcript" ? "transcript" : "web";
  return { kind, target: { fragment_id: at.unit }, locations, text };
}

/** null: the locator names a unit (or format) this publication does not have. */
export function targetOfLocator(
  doc: ReaderDocument,
  locator: Locator,
): ReaderTarget | null {
  if (locator.kind === "pdf" || doc.kind === "pdf") {
    return locator.kind === "pdf" && doc.kind === "pdf"
      ? {
          kind: "point",
          point: {
            kind: "pdf",
            page: locator.page,
            y: locator.page_progression ?? 0,
          },
        }
      : null;
  }
  const unit = doc.units.find(
    (candidate) => locator.kind === "x"
      ? candidate.id === locator.occurrence_id && candidate.xPost?.owner?.media_id === locator.post_media_id &&
        candidate.xPost.source_revision_id === locator.source_revision_id
      : candidate.id === locator.target.fragment_id,
  );
  if (!unit) return null;
  const offset = locator.locations.text_offset;
  if (
    offset === null &&
    locator.kind === "epub" &&
    locator.target.anchor_id !== null
  ) {
    return {
      kind: "anchor",
      unit: unit.id,
      id: locator.target.anchor_id,
    };
  }
  return {
    kind: "point",
    point: {
      kind: "text",
      unit: unit.id,
      offset: Math.min(offset ?? 0, unit.length),
    },
  };
}
