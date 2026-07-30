import { describe, expect, it, vi } from "vitest";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import {
  findFirstVisibleCanonicalOffset,
  measureCanonicalTextAnchorViewportDelta,
  resolveCanonicalTextAnchor,
  resolveCanonicalTextRanges,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "./paneTextAnchor";

function html(content: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = content;
  return root;
}

describe("canonical text provenance resolution", () => {
  it("resolves an NFC-composed occurrence to every contributing DOM range", () => {
    const root = html("<p><span>e</span><em>\u0301</em></p>");
    const first = root.querySelector("span")!.firstChild as Text;
    const second = root.querySelector("em")!.firstChild as Text;
    const cursor = buildCanonicalCursor(root);

    const start = resolveCanonicalTextAnchor(cursor, 0, "Forward");
    const end = resolveCanonicalTextAnchor(cursor, 1, "Backward");
    const ranges = resolveCanonicalTextRanges(cursor, 0, 1);

    expect(start).toEqual({ node: first, rawUtf16Offset: 0 });
    expect(end).toEqual({ node: second, rawUtf16Offset: 1 });
    expect(ranges?.map((range) => range.toString())).toEqual(["e", "\u0301"]);
  });

  it("excludes a reordered combining mark from the preceding canonical range", () => {
    const root = html("<p><span>a\u0315</span><em>\u0300</em></p>");
    const first = root.querySelector("span")!.firstChild as Text;
    const second = root.querySelector("em")!.firstChild as Text;
    const cursor = buildCanonicalCursor(root);

    const composed = resolveCanonicalTextRanges(cursor, 0, 1);
    const reordered = resolveCanonicalTextRanges(cursor, 1, 2);

    expect(
      composed?.map((range) => ({
        node: range.startContainer,
        text: range.toString(),
      })),
    ).toEqual([
      { node: first, text: "a" },
      { node: second, text: "\u0300" },
    ]);
    expect(
      reordered?.map((range) => ({
        node: range.startContainer,
        text: range.toString(),
      })),
    ).toEqual([{ node: first, text: "\u0315" }]);
  });

  it("maps canonical whitespace to its complete raw run and block boundaries by affinity", () => {
    const root = html("<p>A   B</p><p>C</p>");
    const first = root.querySelector("p")!.firstChild as Text;
    const second = root.querySelectorAll("p")[1]!.firstChild as Text;
    const cursor = buildCanonicalCursor(root);

    const whitespace = resolveCanonicalTextRanges(cursor, 1, 2);
    const beforeBlock = resolveCanonicalTextAnchor(cursor, 3, "Backward");
    const afterBlock = resolveCanonicalTextAnchor(cursor, 4, "Forward");

    expect(whitespace?.map((range) => range.toString())).toEqual(["   "]);
    expect(beforeBlock).toEqual({ node: first, rawUtf16Offset: 5 });
    expect(afterBlock).toEqual({ node: second, rawUtf16Offset: 0 });
  });

  it("keeps canonical codepoint offsets exact across astral UTF-16 spans", () => {
    const root = html("<p>A🎉B</p>");
    const node = root.querySelector("p")!.firstChild as Text;
    const cursor = buildCanonicalCursor(root);

    const range = resolveCanonicalTextRanges(cursor, 1, 2);
    const end = resolveCanonicalTextAnchor(cursor, 2, "Backward");

    expect(range?.map((value) => value.toString())).toEqual(["🎉"]);
    expect(end).toEqual({ node, rawUtf16Offset: 3 });
  });

  it("rejects invalid or synthetic-only ranges", () => {
    const cursor = buildCanonicalCursor(html("<p>A</p><p>B</p>"));

    expect(resolveCanonicalTextRanges(cursor, -1, 1)).toBeNull();
    expect(resolveCanonicalTextRanges(cursor, 1, 1)).toBeNull();
    expect(resolveCanonicalTextRanges(cursor, 1, 2)).toBeNull();
  });

  it("measures and restores the exact anchor delta and horizontal position", () => {
    const root = html("<p>Exact origin</p>");
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: 300,
    });
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 8,
    });
    container.getBoundingClientRect = () =>
      ({ top: 40 } as DOMRect);
    const rangeRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 125 } as DOMRect);

    expect(
      measureCanonicalTextAnchorViewportDelta(container, cursor, 2),
    ).toBe(85);

    rangeRect.mockImplementation(
      () => ({ top: 470 - container.scrollTop }) as DOMRect,
    );
    expect(
      restoreCanonicalTextAnchorViewportPosition(
        container,
        cursor,
        2,
        85,
        19,
      ),
    ).toBe(true);
    expect(container.scrollTop).toBe(345);
    expect(container.scrollLeft).toBe(19);
  });

  it("finds the first visible codepoint inside a partially scrolled long text node", () => {
    const root = html("<p>abcdefghij</p>");
    const paragraph = root.querySelector("p")!;
    paragraph.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 200,
        left: 0,
        right: 300,
      }) as DOMRect;
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 200,
        left: 0,
        right: 300,
        height: 100,
      }) as DOMRect;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Range) {
        const top = this.startOffset * 20;
        return {
          top,
          bottom: top + 18,
          left: 10,
          right: 20,
          width: 10,
          height: 18,
        } as DOMRect;
      },
    );

    expect(findFirstVisibleCanonicalOffset(container, cursor)).toBe(5);
  });

  it("scrolls an exact collapsed anchor without an element fallback", () => {
    const root = html("<p>Exact target</p>");
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: 50,
    });
    container.getBoundingClientRect = () =>
      ({ top: 100 } as DOMRect);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 145,
      width: 0,
      height: 0,
    } as DOMRect);

    expect(
      scrollToExactCanonicalTextAnchor(container, cursor, 2),
    ).toBe(true);
    expect(container.scrollTop).toBe(39);
  });
});
