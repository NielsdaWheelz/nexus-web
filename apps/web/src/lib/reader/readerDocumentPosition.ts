import type { ReaderResumeState } from "./types";
import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  MediaNavigation,
  ReaderNavigationSection,
  ReaderNavigationTextPoint,
} from "@/lib/media/readerNavigation";

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

interface ReaderTextDocumentIndex {
  readonly length: number;
  readonly fragmentOffsets: ReadonlyMap<string, { start: number; length: number }>;
}

export interface ReaderPositionedSection {
  readonly section: ReaderNavigationSection;
  readonly start: number;
  readonly extent: Presence<ReaderDocumentOverviewRange>;
  readonly depth: number;
}

export interface ReaderDocumentStructure extends ReaderTextDocumentIndex {
  readonly sections: readonly ReaderPositionedSection[];
  readonly coverage: readonly {
    start: number;
    end: number;
    sectionId: Presence<string>;
  }[];
}

function indexTextFragments(
  fragments: Extract<ReaderDocumentProjection, { kind: "Text" }>["fragments"],
): ReaderTextDocumentIndex {
  const fragmentOffsets = new Map<string, { start: number; length: number }>();
  let length = 0;
  for (const fragment of fragments) {
    if (
      fragmentOffsets.has(fragment.fragmentId) ||
      !Number.isSafeInteger(fragment.length) ||
      fragment.length < 0
    ) {
      throw new Error("Text document projection requires ordered unique fragments with canonical lengths.");
    }
    fragmentOffsets.set(fragment.fragmentId, { start: length, length: fragment.length });
    length += fragment.length;
  }
  return { length, fragmentOffsets };
}

export function readerTextPointOffset(
  document: ReaderTextDocumentIndex,
  point: ReaderNavigationTextPoint,
): number {
  const fragment = document.fragmentOffsets.get(point.fragment_id);
  if (!fragment) throw new Error("Text point fragment is absent from the document projection.");
  if (!Number.isSafeInteger(point.offset) || point.offset < 0 || point.offset > fragment.length) {
    throw new Error("Canonical text point must be an integer within its fragment.");
  }
  return fragment.start + point.offset;
}

export function buildReaderDocumentStructure(
  navigation: Pick<MediaNavigation, "fragments" | "sections">,
): ReaderDocumentStructure {
  const index = indexTextFragments(navigation.fragments.map((fragment) => ({
    fragmentId: fragment.fragment_id,
    length: fragment.char_count,
  })));
  const sourceSections = new Map(navigation.sections.map((section) => [section.section_id, section]));
  const boundaries = new Set([0, index.length]);
  const sections = navigation.sections.map((section): ReaderPositionedSection => {
    const start = readerTextPointOffset(index, section.target);
    boundaries.add(start);
    const extent = section.extent.kind === "Present"
      ? present({ start, end: readerTextPointOffset(index, section.extent.value.end) })
      : absent<ReaderDocumentOverviewRange>();
    if (extent.kind === "Present") boundaries.add(extent.value.end);
    let depth = 0;
    let parent = section.parent_section_id;
    while (parent.kind === "Present") {
      const ancestor = sourceSections.get(parent.value);
      if (!ancestor) throw new Error("Section parent is absent from the document structure.");
      depth += 1;
      parent = ancestor.parent_section_id;
    }
    return { section, start, extent, depth };
  });
  const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
  const coverage: ReaderDocumentStructure["coverage"][number][] = [];
  for (let index = 0; index + 1 < orderedBoundaries.length; index += 1) {
    const start = orderedBoundaries[index]!;
    const end = orderedBoundaries[index + 1]!;
    let current: ReaderPositionedSection | undefined;
    for (const candidate of sections) {
      if (candidate.extent.kind === "Absent") continue;
      const extent = candidate.extent.value;
      if (extent.start > start || extent.end <= start) continue;
      const currentLength = current?.extent.kind === "Present"
        ? current.extent.value.end - current.extent.value.start
        : Infinity;
      const candidateLength = extent.end - extent.start;
      if (
        !current ||
        candidate.depth > current.depth ||
        (candidate.depth === current.depth && (
          candidateLength < currentLength ||
          (candidateLength === currentLength && candidate.section.section_id < current.section.section_id)
        ))
      ) current = candidate;
    }
    coverage.push({ start, end, sectionId: current ? present(current.section.section_id) : absent() });
  }
  return { ...index, sections, coverage };
}

export function readerSectionAtPosition(
  structure: ReaderDocumentStructure,
  position: number,
): Presence<ReaderPositionedSection> {
  const interval = position === structure.length
    ? structure.coverage.at(-1)
    : structure.coverage.find((span) => span.start <= position && position < span.end);
  if (!interval || interval.sectionId.kind === "Absent") return absent();
  const sectionId = interval.sectionId.value;
  const section = structure.sections.find((candidate) => candidate.section.section_id === sectionId);
  if (!section) throw new Error("Coverage refers to an absent section.");
  return present(section);
}

export function projectReaderLocalPoint({
  scope,
  position,
  documentLength,
}: {
  scope: ReaderDocumentOverviewRange;
  position: number;
  documentLength: number;
}): Presence<number> {
  if (
    scope.end <= scope.start ||
    position < scope.start ||
    position > scope.end ||
    (position === scope.end && position !== documentLength)
  ) return absent();
  return present((position - scope.start) / (scope.end - scope.start));
}

export function projectReaderLocalRange({
  scope,
  range,
  documentLength,
}: {
  scope: ReaderDocumentOverviewRange;
  range: ReaderDocumentOverviewRange;
  documentLength: number;
}): Presence<ReaderDocumentOverviewRange> {
  if (range.start === range.end) {
    const point = projectReaderLocalPoint({ scope, position: range.start, documentLength });
    return point.kind === "Present" ? present({ start: point.value, end: point.value }) : absent();
  }
  const start = Math.max(scope.start, range.start);
  const end = Math.min(scope.end, range.end);
  if (end <= start) return absent();
  return present({
    start: (start - scope.start) / (scope.end - scope.start),
    end: (end - scope.start) / (scope.end - scope.start),
  });
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function projectTextPoint(
  documentProjection: Extract<ReaderDocumentProjection, { kind: "Text" }>,
  point: Extract<ReaderDocumentPoint, { kind: "Text" }>,
): number {
  const index = indexTextFragments(documentProjection.fragments);
  if (index.length <= 0) {
    throw new Error("Text document projection requires canonical text.");
  }
  return readerTextPointOffset(index, {
    fragment_id: point.fragmentId,
    offset: point.offset,
  }) / index.length;
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
