import { describe, expect, it } from "vitest";
import { measureMaxRenderedPdfPageWidthPx } from "@/lib/highlights/pdfPageViewport";

function page(widthPx: number): HTMLElement {
  const element = document.createElement("div");
  element.className = "page";
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width: widthPx,
      height: 100,
      top: 0,
      right: widthPx,
      bottom: 100,
      left: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

describe("measureMaxRenderedPdfPageWidthPx", () => {
  it("returns the ceiled widest rendered page width", () => {
    const root = document.createElement("div");
    root.append(page(612.2), page(700.1), page(500));

    expect(measureMaxRenderedPdfPageWidthPx(root)).toBe(701);
  });

  it("falls back to stored page width attributes", () => {
    const root = document.createElement("div");
    const element = page(0);
    element.setAttribute("data-nexus-page-viewport-width", "734.4");
    root.append(element);

    expect(measureMaxRenderedPdfPageWidthPx(root)).toBe(735);
  });

  it("ignores invalid widths", () => {
    const root = document.createElement("div");
    root.append(page(0), page(Number.NaN));

    expect(measureMaxRenderedPdfPageWidthPx(root)).toBeNull();
  });

  it("returns null for empty roots", () => {
    expect(measureMaxRenderedPdfPageWidthPx(document.createElement("div"))).toBeNull();
  });
});
