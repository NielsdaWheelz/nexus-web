"use client";

import { useEffect, useRef, useState } from "react";
import { PDF_WORKER_SRC, loadPdfJs, loadPdfJsViewer } from "@/components/pdfReaderRuntime";
import type { Schema } from "@/lib/api/wire";
import {
  isValidPdfRect,
  projectPdfQuadToViewportRect,
} from "@/lib/highlights/coordinateTransforms";
import { deriveViewportTransformFromPageView } from "@/lib/highlights/pdfPageViewport";
import styles from "./publicShare.module.css";

/**
 * The shared PDF in pdf.js, fetched in ranges with the token header and no credentials, at page
 * width on the highlight's page, its quads painted in the highlight color and focused.
 */
export default function PublicPdf(props: {
  token: string;
  highlight: Schema<"PublicHighlightOut"> | null;
}) {
  const { token, highlight } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"Ok" | "HighlightUnavailable" | "Failed">("Ok");

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;
    const anchor = highlight?.anchor.kind === "Pdf" ? highlight.anchor : null;
    let disposed = false;
    let destroy: (() => unknown) | undefined;
    setStatus("Ok");

    const open = async () => {
      const [pdfJs, pdfViewer] = await Promise.all([loadPdfJs(), loadPdfJsViewer()]);
      if (disposed) return;
      pdfJs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      const eventBus = new pdfViewer.EventBus();
      const linkService = new pdfViewer.PDFLinkService({
        eventBus,
        externalLinkTarget: pdfViewer.LinkTarget?.BLANK ?? null,
        externalLinkRel: "noopener noreferrer",
      });
      const viewer = new pdfViewer.PDFViewer({
        container,
        viewer: viewerElement,
        eventBus,
        linkService,
        enableAutoLinking: false,
      });
      linkService.setViewer(viewer);
      const task = pdfJs.getDocument({
        url: "/api/public/resource-share/file",
        httpHeaders: { "X-Nexus-Share-Token": token },
        withCredentials: false,
        disableAutoFetch: true,
      });
      destroy = () => task.destroy?.();
      const doc = await task.promise;
      if (disposed) return;
      // A page past the end opens the document at its start, without the highlight.
      const start = anchor && anchor.page_number <= doc.numPages ? anchor.page_number : 1;
      if (anchor && start !== anchor.page_number) setStatus("HighlightUnavailable");
      eventBus.on("pagesloaded", () => {
        viewer.currentScaleValue = "page-width";
        viewer.currentPageNumber = start;
      });
      // Each render of the highlight's page repaints its quads, or reports them off the page.
      eventBus.on("pagerendered", (event) => {
        const { pageNumber } = event as { pageNumber: number };
        if (disposed || !anchor || !highlight || pageNumber !== anchor.page_number) return;
        const pageView = viewer.getPageView?.(pageNumber - 1);
        const { width = 0, height = 0, scale = 1 } = pageView?.viewport ?? {};
        const transform = deriveViewportTransformFromPageView(pageView, scale);
        const rects = transform
          ? anchor.quads.map((quad) => projectPdfQuadToViewportRect(quad, transform))
          : [];
        const fits = rects.every(
          (r) =>
            isValidPdfRect(r) &&
            r.left >= 0 &&
            r.top >= 0 &&
            r.left + r.width <= width + 0.01 &&
            r.top + r.height <= height + 0.01,
        );
        const page = viewerElement.querySelector(`.page[data-page-number="${pageNumber}"]`);
        if (!page || rects.length === 0 || !fits) {
          setStatus("HighlightUnavailable");
          return;
        }
        for (const stale of page.querySelectorAll(`.${styles.pdfRect}`)) stale.remove();
        const marks = rects.map(({ left, top, width: w, height: h }) => {
          const mark = document.createElement("div");
          mark.className = `${styles.pdfRect} hl-${highlight.color}`;
          mark.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
          return mark;
        });
        page.append(...marks);
        marks[0].tabIndex = -1;
        marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
        marks[0].focus({ preventScroll: true });
        setStatus("Ok");
      });
      linkService.setDocument(doc, null);
      viewer.setDocument(doc);
    };
    open().catch((cause: unknown) => {
      if (disposed) return;
      console.error("public_share_pdf_load_failed", cause);
      setStatus("Failed");
    });
    return () => {
      disposed = true;
      void destroy?.();
    };
  }, [highlight, token]);

  if (status === "Failed") return <p className={styles.note}>PDF unavailable.</p>;
  return (
    <>
      {status === "HighlightUnavailable" ? (
        <p className={styles.note} role="status">
          Highlight unavailable.
        </p>
      ) : null}
      {/* pdf.js requires an absolutely positioned container; the frame gives it its box. */}
      <div className={styles.pdf}>
        <div ref={containerRef}>
          <div ref={viewerRef} className="pdfViewer" />
        </div>
      </div>
    </>
  );
}
