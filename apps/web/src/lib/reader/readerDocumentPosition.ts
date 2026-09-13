import type { ReaderResumeState } from "./types";

export type ReaderDocumentPoint =
  | { kind: "Text"; fragmentId: string; offset: number }
  | { kind: "Pdf"; page: number; pageFraction: number };

export type ReaderPositionIntent =
  | "Reader"
  | "Restore"
  | "Preview"
  | "Return";

export interface ReaderSemanticViewport {
  sourceKey: string;
  layoutGeneration: number;
  intent: ReaderPositionIntent;
  primaryLocator: ReaderResumeState;
  visibleStart: ReaderDocumentPoint;
  visibleEnd: ReaderDocumentPoint;
  atEnd: boolean;
}

export interface ReaderDocumentOverviewRange {
  start: number;
  end: number;
}

export type ReaderDocumentProjection =
  | {
      kind: "Text";
      fragments: readonly {
        fragmentId: string;
        length: number;
      }[];
    }
  | { kind: "Pdf"; pageCount: number };

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function projectTextPoint(
  documentProjection: Extract<ReaderDocumentProjection, { kind: "Text" }>,
  point: Extract<ReaderDocumentPoint, { kind: "Text" }>,
): number {
  let prefixLength = 0;
  let pointFragmentLength: number | null = null;
  const fragmentIds = new Set<string>();
  for (const fragment of documentProjection.fragments) {
    if (
      fragmentIds.has(fragment.fragmentId) ||
      !Number.isInteger(fragment.length) ||
      fragment.length < 0
    ) {
      throw new Error(
        "Text document projection requires ordered unique fragments with canonical lengths.",
      );
    }
    fragmentIds.add(fragment.fragmentId);
    if (fragment.fragmentId === point.fragmentId) {
      pointFragmentLength = fragment.length;
    } else if (pointFragmentLength === null) {
      prefixLength += fragment.length;
    }
  }
  const totalLength = documentProjection.fragments.reduce(
    (total, fragment) => total + fragment.length,
    0,
  );
  if (totalLength <= 0) {
    throw new Error("Text document projection requires canonical text.");
  }
  if (pointFragmentLength === null) {
    throw new Error("Text point fragment is absent from the document projection.");
  }
  if (!Number.isFinite(point.offset)) {
    throw new Error("Text point offset must be finite.");
  }
  return clampUnit(
    (prefixLength + Math.min(pointFragmentLength, Math.max(0, point.offset))) /
      totalLength,
  );
}

function projectPdfPoint(
  documentProjection: Extract<ReaderDocumentProjection, { kind: "Pdf" }>,
  point: Extract<ReaderDocumentPoint, { kind: "Pdf" }>,
): number {
  if (
    !Number.isInteger(documentProjection.pageCount) ||
    documentProjection.pageCount <= 0
  ) {
    throw new Error("PDF document projection requires a positive page count.");
  }
  if (!Number.isInteger(point.page) || !Number.isFinite(point.pageFraction)) {
    throw new Error("PDF points require an integer page and finite fraction.");
  }
  const page = Math.min(
    documentProjection.pageCount,
    Math.max(1, point.page),
  );
  const pageFraction = clampUnit(point.pageFraction);
  return clampUnit(
    (page - 1 + pageFraction) / documentProjection.pageCount,
  );
}

export function projectReaderDocumentPoint(
  documentProjection: ReaderDocumentProjection,
  point: ReaderDocumentPoint,
): number {
  if (documentProjection.kind === "Text") {
    if (point.kind !== "Text") {
      throw new Error("Reader point and document projection formats differ.");
    }
    return projectTextPoint(documentProjection, point);
  }
  if (point.kind !== "Pdf") {
    throw new Error("Reader point and document projection formats differ.");
  }
  return projectPdfPoint(documentProjection, point);
}

export function projectReaderDocumentRange(
  documentProjection: ReaderDocumentProjection,
  visibleStart: ReaderDocumentPoint,
  visibleEnd: ReaderDocumentPoint,
): ReaderDocumentOverviewRange {
  const start = projectReaderDocumentPoint(documentProjection, visibleStart);
  const projectedEnd = projectReaderDocumentPoint(
    documentProjection,
    visibleEnd,
  );
  return { start, end: Math.max(start, projectedEnd) };
}
