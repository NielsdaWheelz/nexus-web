import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { absent, present } from "@/lib/api/presence";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import {
  buildReaderDocumentStructure,
  projectReaderDocumentPoint,
  projectReaderDocumentRange,
  projectReaderLocalPoint,
  projectReaderLocalRange,
  readerSectionAtPosition,
  readerTextPointOffset,
  type ReaderDocumentProjection,
} from "./readerDocumentPosition";

type CoordinateCorpus = {
  cases: {
    name: string;
    fragments: { fragment_id: string; fragment_idx: number; char_count: number }[];
    sections: { id: string; parent: string | null; start: [string, number]; end: [string, number] | null }[];
    coverage: { start: number; end: number; section: string | null }[];
    points: { point: [string, number]; absolute: number; global: number | null; section: string | null; local: number | null }[];
  }[];
};

describe("canonical reader document positions", () => {
  it("counts each ordered text fragment once and projects exact code-point offsets", () => {
    const documentProjection = {
      kind: "Text",
      fragments: [
        { fragmentId: "opening", length: 4 },
        { fragmentId: "chapter", length: 6 },
      ],
    } as const satisfies ReaderDocumentProjection;

    expect(
      projectReaderDocumentPoint(documentProjection, {
        kind: "Text",
        fragmentId: "chapter",
        offset: 3,
      }),
      "canonical reader position must count each preceding fragment exactly once",
    ).toBe(0.7);
    expect(() => projectReaderDocumentRange(
      documentProjection,
      { kind: "Text", fragmentId: "opening", offset: -4 },
      { kind: "Text", fragmentId: "chapter", offset: 20 },
    )).toThrow(/integer within its fragment/);
    expect(() =>
      projectReaderDocumentPoint(
        {
          kind: "Text",
          fragments: [
            { fragmentId: "repeated", length: 4 },
            { fragmentId: "repeated", length: 6 },
          ],
        },
        { kind: "Text", fragmentId: "repeated", offset: 2 },
      ),
    ).toThrow(/ordered unique/);
  });

  it("shares the independent source-coordinate corpus", () => {
    const coordinateCorpus = JSON.parse(readFileSync(
      new URL("../../../../../testdata/reader-document-position.json", import.meta.url),
      "utf8",
    )) as CoordinateCorpus;
    for (const example of coordinateCorpus.cases) {
      const sections = example.sections.map((section): ReaderNavigationSection => ({
        section_id: section.id,
        label: section.id,
        parent_section_id: section.parent === null ? absent() : present(section.parent),
        target: { fragment_id: section.start[0], offset: section.start[1] },
        extent: section.end === null ? absent() : present({
          start: { fragment_id: section.start[0], offset: section.start[1] },
          end: { fragment_id: section.end[0], offset: section.end[1] },
        }),
        source: "Heading",
        anchor_id: absent(),
      }));
      const structure = buildReaderDocumentStructure({ fragments: example.fragments, sections });
      expect(structure.coverage, example.name).toEqual(example.coverage.map((span) => ({
        start: span.start,
        end: span.end,
        sectionId: span.section === null ? absent() : present(span.section),
      })));
      expect(structure.sections).toHaveLength(example.sections.length);
      for (const expected of example.points) {
        const absolute = readerTextPointOffset(structure, {
          fragment_id: expected.point[0],
          offset: expected.point[1],
        });
        expect(absolute).toBe(expected.absolute);
        expect(structure.length > 0 ? absolute / structure.length : null).toBe(expected.global);
        const current = readerSectionAtPosition(structure, absolute);
        expect(current.kind === "Present" ? current.value.section.section_id : null).toBe(expected.section);
        const local = current.kind === "Present" && current.value.extent.kind === "Present"
          ? projectReaderLocalPoint({
              scope: current.value.extent.value,
              position: absolute,
              documentLength: structure.length,
            })
          : absent<number>();
        if (expected.local === null) expect(local).toEqual(absent());
        else {
          expect(local.kind).toBe("Present");
          if (local.kind === "Present") expect(local.value).toBeCloseTo(expected.local, 12);
        }
      }
    }
  });

  it("rejects invalid canonical points while preserving the exact fragment endpoint", () => {
    const structure = buildReaderDocumentStructure({
      fragments: [{ fragment_id: "source", fragment_idx: 0, char_count: 100 }],
      sections: [],
    });
    for (const offset of [-1, 0.5, 101, Number.NaN]) {
      expect(() => readerTextPointOffset(structure, { fragment_id: "source", offset })).toThrow();
    }
    expect(readerTextPointOffset(structure, { fragment_id: "source", offset: 100 })).toBe(100);
  });

  it("clips local ranges without converting an outside position into a section endpoint", () => {
    const scope = { start: 100, end: 400 };
    expect(projectReaderLocalPoint({ scope, position: 50, documentLength: 1000 })).toEqual(absent());
    expect(projectReaderLocalPoint({ scope, position: 400, documentLength: 1000 })).toEqual(absent());
    expect(projectReaderLocalPoint({ scope, position: 400, documentLength: 400 })).toEqual(present(1));
    expect(projectReaderLocalPoint({ scope: { start: 100, end: 100 }, position: 100, documentLength: 1000 })).toEqual(absent());
    expect(projectReaderLocalRange({ scope, range: { start: 50, end: 250 }, documentLength: 1000 })).toEqual(present({ start: 0, end: 0.5 }));
    expect(projectReaderLocalRange({ scope, range: { start: 400, end: 500 }, documentLength: 1000 })).toEqual(absent());
  });

  it("projects PDF pages independently of pixels and keeps transient ranges monotonic", () => {
    const documentProjection = {
      kind: "Pdf",
      pageCount: 4,
    } as const satisfies ReaderDocumentProjection;

    expect(
      projectReaderDocumentPoint(documentProjection, {
        kind: "Pdf",
        page: 2,
        pageFraction: 0.25,
      }),
    ).toBe(0.3125);
    expect(
      projectReaderDocumentRange(
        documentProjection,
        { kind: "Pdf", page: 4, pageFraction: 0.8 },
        { kind: "Pdf", page: 4, pageFraction: 0.2 },
      ),
    ).toEqual({ start: 0.95, end: 0.95 });
  });

  it("rejects a viewport point from another reader format", () => {
    expect(() =>
      projectReaderDocumentPoint(
        { kind: "Pdf", pageCount: 2 },
        { kind: "Text", fragmentId: "opening", offset: 0 },
      ),
    ).toThrow(/formats differ/);
  });
});
