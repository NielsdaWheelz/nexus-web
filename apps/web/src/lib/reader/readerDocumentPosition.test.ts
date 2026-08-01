import { describe, expect, it } from "vitest";
import {
  projectReaderDocumentPoint,
  projectReaderDocumentRange,
  type ReaderDocumentProjection,
} from "./readerDocumentPosition";

describe("reader document position projection", () => {
  it("counts each ordered text fragment once and preserves exact offsets", () => {
    const documentProjection = {
      kind: "Text",
      fragments: [
        { fragmentId: "fragment-a", length: 4 },
        { fragmentId: "fragment-b", length: 6 },
      ],
    } as const satisfies ReaderDocumentProjection;

    expect(
      projectReaderDocumentPoint(documentProjection, {
        kind: "Text",
        fragmentId: "fragment-b",
        offset: 0,
      }),
    ).toBe(0.4);
    expect(
      projectReaderDocumentPoint(documentProjection, {
        kind: "Text",
        fragmentId: "fragment-b",
        offset: 3,
      }),
    ).toBe(0.7);
  });

  it("clamps text endpoints and rejects a repeated fragment projection", () => {
    const documentProjection = {
      kind: "Text",
      fragments: [{ fragmentId: "fragment-a", length: 8 }],
    } as const satisfies ReaderDocumentProjection;

    expect(
      projectReaderDocumentRange(
        documentProjection,
        { kind: "Text", fragmentId: "fragment-a", offset: -4 },
        { kind: "Text", fragmentId: "fragment-a", offset: 20 },
      ),
    ).toEqual({ start: 0, end: 1 });
    expect(() =>
      projectReaderDocumentPoint(
        {
          kind: "Text",
          fragments: [
            { fragmentId: "fragment-a", length: 8 },
            { fragmentId: "fragment-a", length: 8 },
          ],
        },
        { kind: "Text", fragmentId: "fragment-a", offset: 0 },
      ),
    ).toThrow(/ordered unique/);
  });

  it("uses one-based page plus full-page fraction independently of page pixels", () => {
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
        { kind: "Pdf", page: 0, pageFraction: -1 },
        { kind: "Pdf", page: 8, pageFraction: 2 },
      ),
    ).toEqual({ start: 0, end: 1 });
  });

  it("keeps a reversed transient range monotonic without moving its start", () => {
    const documentProjection = {
      kind: "Pdf",
      pageCount: 2,
    } as const satisfies ReaderDocumentProjection;

    expect(
      projectReaderDocumentRange(
        documentProjection,
        { kind: "Pdf", page: 2, pageFraction: 0.8 },
        { kind: "Pdf", page: 2, pageFraction: 0.2 },
      ),
    ).toEqual({ start: 0.9, end: 0.9 });
  });

  it("rejects a point from the wrong format instead of guessing", () => {
    expect(() =>
      projectReaderDocumentPoint(
        { kind: "Pdf", pageCount: 2 },
        { kind: "Text", fragmentId: "fragment-a", offset: 0 },
      ),
    ).toThrow(/format/);
  });
});
