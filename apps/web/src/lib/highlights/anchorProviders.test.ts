import { describe, expect, it, vi } from "vitest";
import { HtmlAnchorProvider, PdfAnchorProvider } from "./anchorProviders";

describe("anchorProviders", () => {
  it("HtmlAnchorProvider measures anchor positions in viewer-scroll space", () => {
    const viewer = document.createElement("div");
    Object.defineProperty(viewer, "scrollTop", { value: 200, configurable: true });
    vi.spyOn(viewer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 300, 400));

    const contentRoot = document.createElement("div");
    const anchor = document.createElement("span");
    anchor.setAttribute("data-highlight-anchor", "h1");
    contentRoot.appendChild(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 180, 20, 10));

    const provider = new HtmlAnchorProvider();
    const positions = provider.measureViewerAnchorPositions(
      [{ kind: "html", id: "h1" }],
      { contentRoot, viewerScrollContainer: viewer }
    );
    expect(positions.get("h1")).toBe(280);
  });

  it("PdfAnchorProvider projects quads using viewport transform metadata", () => {
    const viewer = document.createElement("div");
    Object.defineProperty(viewer, "scrollTop", { value: 200, configurable: true });
    vi.spyOn(viewer, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 300, 400));

    const contentRoot = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.setAttribute("data-page-number", "2");
    page.setAttribute("data-nexus-page-scale", "2");
    page.setAttribute("data-nexus-page-rotation", "0");
    page.setAttribute("data-nexus-page-viewport-width", "1224");
    page.setAttribute("data-nexus-page-viewport-height", "1584");
    page.setAttribute("data-nexus-page-dpi-scale", "1");
    contentRoot.appendChild(page);
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 140, 300, 400));

    const provider = new PdfAnchorProvider();
    const positions = provider.measureViewerAnchorPositions(
      [
        {
          kind: "pdf",
          id: "pdf-h1",
          pageNumber: 2,
          quads: [
            {
              x1: 72,
              y1: 100,
              x2: 120,
              y2: 100,
              x3: 120,
              y3: 112,
              x4: 72,
              y4: 112,
            },
          ],
        },
      ],
      { contentRoot, viewerScrollContainer: viewer }
    );

    // pageTopInViewer = 140 - 100 + 200 = 240
    // projected quad top = 100 * scale(2) = 200
    expect(positions.get("pdf-h1")).toBe(440);
  });
});

