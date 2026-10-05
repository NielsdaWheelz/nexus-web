// The publication model: one immutable document of units (or one pdf) under
// one identity, the points and targets that address it, and the one mapping
// between its points and the cursor's wire locator. Offsets are codepoints
// into a unit's canonical text, half-open.
import type { Schema } from "@/lib/api/wire";

export type ReaderDocumentOut =
  Schema<"ReaderTextDocumentOut"> | Schema<"ReaderPdfDocumentOut">;
export type Locator = Schema<"CursorWrite">["locator"];
export type CursorSnapshot =
  Schema<"ReaderCursorEmpty"> | Schema<"ReaderCursorPositioned">;
export type HighlightColor = Schema<"ReaderEvidenceHighlightOut">["color"];
export type PdfQuad = Schema<"HighlightTargetPdfQuadOut">;
export type SourceIssue =
  Schema<"ReaderTextDocumentOut">["source_issues"][number];
export type DocumentEmbed = Schema<"DocumentEmbedOut">;

export interface TextUnit {
  readonly id: string;
  readonly html: string;
  readonly text: string;
  readonly length: number;
  /** Document codepoint offset of the unit's first codepoint. */
  readonly start: number;
  readonly hrefPath: string | null;
  readonly time: { readonly startMs: number; readonly endMs: number } | null;
  readonly speaker: string | null;
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
  readonly at: TextPoint;
  readonly anchorId: string | null;
}
export interface TocNode {
  readonly id: string;
  readonly label: string;
  readonly at: TextPoint | null;
  readonly sectionId: string | null;
  readonly children: readonly TocNode[];
}
export interface PdfFile {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number | null;
}

export type TextDocument = {
  readonly kind: "text";
  readonly format: "web" | "epub" | "transcript";
  readonly identity: string;
  readonly title: string;
  readonly units: readonly TextUnit[];
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
  | { readonly kind: "pdfDest"; readonly dest: string | readonly unknown[] }
  | { readonly kind: "edge"; readonly edge: "start" | "end" };
/** Where the eye is: a point and its pixel offset below the scrollport top. */
export interface Placement {
  readonly identity: string;
  readonly point: ReaderPoint;
  readonly topPx: number;
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
  unitAtTime(ms: number): TextUnit | undefined;
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
        headers: {},
        expiresAtMs: expires_at === null ? null : Date.parse(expires_at),
      },
    };
  }
  let start = 0;
  const units = out.units.map((unit): TextUnit => {
    const mapped = {
      id: unit.id,
      html: unit.html_sanitized,
      text: unit.canonical_text,
      length: unit.char_count,
      start,
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
    start += unit.char_count;
    return mapped;
  });
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
  return {
    kind: "text",
    format: out.kind === "web_article" ? "web" : out.kind,
    identity: out.identity,
    title: out.title,
    units,
    length: start,
    sections: out.sections.map((section) => ({
      id: section.id,
      label: section.label,
      depth: section.depth,
      at: point(section.at),
      anchorId: section.anchor_id,
    })),
    toc: out.toc_nodes.map(toc),
    sourceIssues: out.source_issues,
    embeds: out.embeds,
  };
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
      unitAtTime: () => undefined,
    };
  }
  const units = new Map(doc.units.map((unit) => [unit.id, unit]));
  const offset = (p: TextPoint) => (units.get(p.unit)?.start ?? 0) + p.offset;
  const sections = doc.sections
    .map((section) => ({ section, at: offset(section.at) }))
    .sort((a, b) => a.at - b.at);
  return {
    length: doc.length,
    fraction: (p) =>
      p.kind === "text" && doc.length > 0 ? offset(p) / doc.length : 0,
    sectionAt: (p) =>
      p.kind === "text"
        ? (sections.findLast((entry) => entry.at <= offset(p))?.section ?? null)
        : null,
    unit: (id) => units.get(id),
    unitAtTime: (ms) =>
      doc.units.findLast(
        (unit) => unit.time !== null && unit.time.startMs <= ms,
      ) ?? doc.units[0],
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
  const last = doc.kind === "text" ? doc.units.at(-1) : undefined;
  const at =
    extra.terminal && last ? { unit: last.id, offset: last.length } : point;
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
  if (doc.kind === "text" && doc.format === "epub") {
    return {
      kind: "epub",
      target: {
        fragment_id: at.unit,
        href_path: unit?.hrefPath ?? "",
        anchor_id: { kind: "Absent" },
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
    (candidate) => candidate.id === locator.target.fragment_id,
  );
  if (!unit) return null;
  const offset = locator.locations.text_offset;
  if (
    offset === null &&
    locator.kind === "epub" &&
    locator.target.anchor_id.kind === "Present"
  ) {
    return {
      kind: "anchor",
      unit: unit.id,
      id: locator.target.anchor_id.value,
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
