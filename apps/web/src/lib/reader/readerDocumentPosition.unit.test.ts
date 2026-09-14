import { describe, expect, it } from "vitest";
import {
  projectReaderDocumentPoint,
  projectReaderDocumentRange,
  type ReaderDocumentProjection,
} from "./readerDocumentPosition";

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
    expect(
      projectReaderDocumentRange(
        documentProjection,
        { kind: "Text", fragmentId: "opening", offset: -4 },
        { kind: "Text", fragmentId: "chapter", offset: 20 },
      ),
    ).toEqual({ start: 0, end: 1 });
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
