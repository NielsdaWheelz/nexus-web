// Pdf page space: points from the unrotated page's top-left corner, y down.
// Marks are stored in it; the rendered page is its viewport (scale, rotation).
import type { PageViewport } from "pdfjs-dist";
import type { PdfQuad } from "../model";

const turn = (viewport: PageViewport) =>
  (((viewport.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;

function pageSize(viewport: PageViewport) {
  const sideways = turn(viewport) % 180 !== 0;
  return {
    width: (sideways ? viewport.height : viewport.width) / viewport.scale,
    height: (sideways ? viewport.width : viewport.height) / viewport.scale,
  };
}

function toViewport(
  x: number,
  y: number,
  viewport: PageViewport,
): [number, number] {
  const { width, height } = pageSize(viewport);
  const s = viewport.scale;
  switch (turn(viewport)) {
    case 90:
      return [(height - y) * s, x * s];
    case 180:
      return [(width - x) * s, (height - y) * s];
    case 270:
      return [y * s, (width - x) * s];
    default:
      return [x * s, y * s];
  }
}

export function toPage(
  px: number,
  py: number,
  viewport: PageViewport,
): [number, number] {
  const { width, height } = pageSize(viewport);
  const [x, y] = [px / viewport.scale, py / viewport.scale];
  switch (turn(viewport)) {
    case 90:
      return [y, height - x];
    case 180:
      return [width - x, height - y];
    case 270:
      return [width - y, x];
    default:
      return [x, y];
  }
}

/** Rectangles in page-element pixels. */
export function quadRects(
  quads: readonly PdfQuad[],
  viewport: PageViewport,
): DOMRectReadOnly[] {
  return quads.map((quad) => {
    const points = [
      toViewport(quad.x1, quad.y1, viewport),
      toViewport(quad.x2, quad.y2, viewport),
      toViewport(quad.x3, quad.y3, viewport),
      toViewport(quad.x4, quad.y4, viewport),
    ];
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const [left, top] = [Math.min(...xs), Math.min(...ys)];
    return new DOMRectReadOnly(
      left,
      top,
      Math.max(1, Math.max(...xs) - left),
      Math.max(1, Math.max(...ys) - top),
    );
  });
}

/** A selection on one page as page-space quads, one per line box (top-left, top-right, bottom-right, bottom-left). */
export function rangeQuads(
  range: Range,
  page: HTMLElement,
  viewport: PageViewport,
): PdfQuad[] {
  const origin = page.getBoundingClientRect();
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return [...range.getClientRects()]
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map((rect) => {
      const x = rect.left - origin.left - page.clientLeft;
      const y = rect.top - origin.top - page.clientTop;
      const [ax, ay] = toPage(x, y, viewport);
      const [bx, by] = toPage(x + rect.width, y + rect.height, viewport);
      const [left, right] = [round(Math.min(ax, bx)), round(Math.max(ax, bx))];
      const [top, bottom] = [round(Math.min(ay, by)), round(Math.max(ay, by))];
      return {
        x1: left,
        y1: top,
        x2: right,
        y2: top,
        x3: right,
        y3: bottom,
        x4: left,
        y4: bottom,
      };
    });
}

export function quadContains(quad: PdfQuad, x: number, y: number): boolean {
  const xs = [quad.x1, quad.x2, quad.x3, quad.x4];
  const ys = [quad.y1, quad.y2, quad.y3, quad.y4];
  return (
    x >= Math.min(...xs) &&
    x <= Math.max(...xs) &&
    y >= Math.min(...ys) &&
    y <= Math.max(...ys)
  );
}
