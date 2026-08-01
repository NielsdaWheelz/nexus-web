import { describe, expect, it, vi } from "vitest";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import type { ReaderScrollCommands } from "@/lib/reader/paneScroll";
import {
  captureVisibleCanonicalTextRange,
  findFirstVisibleCanonicalOffset,
  measureCanonicalTextAnchorViewportDelta,
  resolveCanonicalTextAnchor,
  resolveCanonicalTextRanges,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "./paneTextAnchor";

const scrollCommands: ReaderScrollCommands = {
  setTop(scrollport, top) {
    scrollport.scrollTop = Math.max(0, top);
  },
  adjustTop(scrollport, delta) {
    scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
  },
  reveal(scrollport, target) {
    const scrollportRect = scrollport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (targetRect.top < scrollportRect.top) {
      this.adjustTop(scrollport, targetRect.top - scrollportRect.top);
    } else if (targetRect.bottom > scrollportRect.bottom) {
      this.adjustTop(scrollport, targetRect.bottom - scrollportRect.bottom);
    }
  },
};

function html(content: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = content;
  return root;
}

describe("canonical text provenance resolution", () => {
  it("captures exact half-open visible endpoints in one canonical coordinate", () => {
    const root = html("<p>abcd</p><p>efgh</p>");
    document.body.append(root);
    const [first, second] = root.querySelectorAll("p");
    const firstNode = first.firstChild as Text;
    const secondNode = second.firstChild as Text;
    first.getBoundingClientRect = () =>
      ({ top: 0, bottom: 80, left: 0, right: 300 }) as DOMRect;
    second.getBoundingClientRect = () =>
      ({ top: 120, bottom: 200, left: 0, right: 300 }) as DOMRect;
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ top: 50, bottom: 170, left: 0, right: 300 }) as DOMRect;
    const rangeRect = function (this: Range): DOMRect {
      const node = this.startContainer;
      const top =
        (node === firstNode ? 0 : node === secondNode ? 120 : 1_000) +
        this.startOffset * 20;
      return {
        top,
        bottom: top + 18,
        left: 10,
        right: 20,
        width: 10,
        height: 18,
      } as DOMRect;
    };
    const boundingRectSpy = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(rangeRect);
    const clientRectsSpy = vi
      .spyOn(Range.prototype, "getClientRects")
      .mockImplementation(function (this: Range) {
        const rectangles = [rangeRect.call(this)];
        return Object.assign(rectangles, {
          item: (index: number) => rectangles[index] ?? null,
        }) as unknown as DOMRectList;
      });

    expect(captureVisibleCanonicalTextRange(container, cursor)).toEqual({
      startOffset: 2,
      endOffset: 8,
    });
    boundingRectSpy.mockRestore();
    clientRectsSpy.mockRestore();
  });

  it("uses exact surrounding canonical boundaries for a non-text viewport", () => {
    const root = html("<p>before</p><img alt='figure'><p>after</p>");
    document.body.append(root);
    const [before, after] = root.querySelectorAll("p");
    before.getBoundingClientRect = () =>
      ({ top: 0, bottom: 50, left: 0, right: 300 }) as DOMRect;
    after.getBoundingClientRect = () =>
      ({ top: 250, bottom: 300, left: 0, right: 300 }) as DOMRect;
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, left: 0, right: 300 }) as DOMRect;

    expect(captureVisibleCanonicalTextRange(container, cursor)).toEqual({
      startOffset: 6,
      endOffset: 7,
    });
  });

  it("finds surrounding boundaries when one tall parent spans the viewport", () => {
    const root = html("<div>before<img alt='figure'>after</div>");
    document.body.append(root);
    const [before, after] = Array.from(
      root.querySelector("div")!.childNodes,
    ).filter((node): node is Text => node instanceof Text);
    root.querySelector("div")!.getBoundingClientRect = () =>
      ({ top: 0, bottom: 300, left: 0, right: 300 }) as DOMRect;
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, left: 0, right: 300 }) as DOMRect;
    const rangeRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Range) {
        return (
          this.startContainer === before
            ? { top: 20, bottom: 40, left: 10, right: 20 }
            : this.startContainer === after
              ? { top: 240, bottom: 260, left: 10, right: 20 }
              : { top: 0, bottom: 0, left: 0, right: 0 }
        ) as DOMRect;
      });
    const rangeClientRects = vi
      .spyOn(Range.prototype, "getClientRects")
      .mockImplementation(function (this: Range) {
        const rectangles = [this.getBoundingClientRect()];
        return Object.assign(rectangles, {
          item: (index: number) => rectangles[index] ?? null,
        }) as unknown as DOMRectList;
      });

    expect(captureVisibleCanonicalTextRange(container, cursor)).toEqual({
      startOffset: 6,
      endOffset: 6,
    });
    rangeRect.mockRestore();
    rangeClientRects.mockRestore();
  });

  it("bounds layout reads for a large vertical reader", () => {
    const root = document.createElement("div");
    root.innerHTML = Array.from(
      { length: 2_048 },
      (_, index) => `<p data-index="${index}">x</p>`,
    ).join("");
    let parentLayoutReads = 0;
    for (const paragraph of root.querySelectorAll("p")) {
      const index = Number(paragraph.dataset.index);
      paragraph.getBoundingClientRect = () => {
        parentLayoutReads += 1;
        return {
          top: index * 10,
          bottom: index * 10 + 10,
          left: 0,
          right: 300,
        } as DOMRect;
      };
    }
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ top: 10_240, bottom: 10_250, left: 0, right: 300 }) as DOMRect;
    const rangeRect = function (this: Range): DOMRect {
      const index = Number(this.startContainer.parentElement?.dataset.index);
      return {
        top: index * 10,
        bottom: index * 10 + 10,
        left: 0,
        right: 300,
      } as DOMRect;
    };
    const boundingRectSpy = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(rangeRect);
    const clientRectsSpy = vi
      .spyOn(Range.prototype, "getClientRects")
      .mockImplementation(function (this: Range) {
        const rectangles = [rangeRect.call(this)];
        return Object.assign(rectangles, {
          item: (index: number) => rectangles[index] ?? null,
        }) as unknown as DOMRectList;
      });

    expect(captureVisibleCanonicalTextRange(container, cursor)).not.toBeNull();
    expect(parentLayoutReads).toBeLessThan(32);

    boundingRectSpy.mockRestore();
    clientRectsSpy.mockRestore();
  });

  it("does not fabricate a viewport for a document without canonical text", () => {
    const root = html("<img alt='figure'>");
    const cursor = buildCanonicalCursor(root);
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 200, left: 0, right: 300 }) as DOMRect;

    expect(captureVisibleCanonicalTextRange(container, cursor)).toBeNull();
  });

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
    container.getBoundingClientRect = () => ({ top: 40 }) as DOMRect;
    const rangeRect = vi
      .spyOn(Range.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 125 } as DOMRect);

    expect(measureCanonicalTextAnchorViewportDelta(container, cursor, 2)).toBe(
      85,
    );

    rangeRect.mockImplementation(
      () => ({ top: 470 - container.scrollTop }) as DOMRect,
    );
    expect(
      restoreCanonicalTextAnchorViewportPosition(
        scrollCommands,
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
    container.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 145,
      width: 0,
      height: 0,
    } as DOMRect);

    expect(
      scrollToExactCanonicalTextAnchor(scrollCommands, container, cursor, 2),
    ).toBe(true);
    expect(container.scrollTop).toBe(39);
  });
});
