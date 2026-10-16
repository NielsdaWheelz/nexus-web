"use client";

// One pdf in pdf.js's viewer. Positions are page-relative (page, y down the
// page), so they survive zoom. Links and destinations inside the pdf become
// reader jumps. A failed open refreshes the file once and reopens at the
// last placement; a host's range read that fails later ends the open with
// Retry. Marks are page-space quads drawn under the text layer.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type * as PdfJs from "pdfjs-dist";
import type {
  PDFDataRangeTransport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PageViewport,
} from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { DocumentReaderViewProps } from "../DocumentReader";
import type {
  PdfDocument,
  PdfFile,
  Placement,
  ReaderPoint,
  ReaderTarget,
} from "../model";
import type { NavOutcome } from "../navigator";
import type { PdfState, ReaderRuntime, SurfaceHandle } from "../runtime";
import { useReaderSelection } from "../selection";
import { measureScrollport, nextFrame, useScrollport } from "../scrollport";
import { createPdfFind } from "./find";
import { quadContains, quadRects, rangeQuads, toPage } from "./geometry";
import { loadPdfJs, PDF_ASSETS } from "./pdfjs";
import styles from "../documentReader.module.css";

interface Live {
  readonly viewer: PDFViewer;
  /** The viewer's own destination jump, before the reader took the link service over. */
  readonly goTo: (dest: string | unknown[]) => Promise<void>;
}

const MARK = "data-reader-mark";
const PASSAGE = "data-reader-passage";
const INSPECTION = "data-reader-inspection";
/** pdf.js leaves this much of the container's width beside a page fitted to it. */
const PAGE_WIDTH_PADDING_PX = 40;

/** `#page=4`, `#nameddest=intro`, or a bare named destination. */
function hashTarget(hash: string): ReaderTarget | null {
  const params = new URLSearchParams(hash);
  const named = params.get("nameddest");
  if (named) return { kind: "pdfDest", dest: named };
  const page = Number(params.get("page"));
  if (Number.isInteger(page) && page >= 1)
    return { kind: "point", point: { kind: "pdf", page, y: 0 } };
  return hash && !hash.includes("=")
    ? { kind: "pdfDest", dest: decodeURIComponent(hash) }
    : null;
}

/**
 * A host's own range reads as pdf.js's transport, read as pdf.js reads a url:
 * `bytes=0-` streams the whole file in, and a chunk needed before the stream
 * reaches it is read by range. A failed range read goes to `fail`: pdf.js
 * would wait for it forever.
 */
async function hostRanges(
  pdfjs: typeof PdfJs,
  ranges: (range: string, signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
  fail: (error: unknown) => void,
): Promise<PDFDataRangeTransport> {
  // pdf.js aborts the transport when it drops the document.
  const dropped = new AbortController();
  const live = AbortSignal.any([signal, dropped.signal]);
  const read = async (range: string) => {
    const response = await ranges(range, live);
    const size = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (response.status !== 206 || size === null)
      throw new Error(`pdf range answered ${response.status}`);
    return { response, size: Number(size[1]) };
  };
  const whole = await read("bytes=0-");
  const transport = new pdfjs.PDFDataRangeTransport(whole.size, null);
  transport.abort = () => dropped.abort();
  transport.requestDataRange = (begin, end) =>
    void read(`bytes=${begin}-${end - 1}`)
      .then(async ({ response }) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        transport.onDataRange(begin, bytes);
      })
      .catch((error: unknown) => {
        if (!live.aborted) fail(error);
      });
  const pump = async () => {
    const stream = whole.response.body!.getReader();
    let part = await stream.read();
    while (!part.done) {
      transport.onDataProgressiveRead(part.value);
      part = await stream.read();
    }
    transport.onDataProgressiveDone();
  };
  // justify-ignore-error: a stream cut short leaves the rest to range reads,
  // as pdf.js's own whole-file read does.
  void pump().catch(() => undefined);
  return transport;
}

const pageOf = (target: EventTarget | null) =>
  target instanceof Element
    ? target.closest<HTMLElement>(".page[data-page-number]")
    : null;

function pageView(viewer: PDFViewer | undefined, page: number) {
  // justify-type-assertion: pdf.js types getPageView as any; it returns a PDFPageView.
  return viewer?.getPageView(page - 1) as
    { div: HTMLElement; viewport: PageViewport } | undefined;
}

/** The zoom a position keeps: null while fitted to the width, so it fits wherever it reopens. */
const chosenZoom = (viewer: PDFViewer) =>
  viewer.currentScaleValue === "page-width" ? null : viewer.currentScale;

const readingLine = (port: HTMLElement) =>
  port.getBoundingClientRect().top +
  (Number.parseFloat(getComputedStyle(port).scrollPaddingTop) || 0);

export default function PdfSurface({
  runtime,
  doc,
  view,
  scrollIndicator,
}: {
  readonly runtime: ReaderRuntime;
  readonly doc: PdfDocument;
  readonly view: DocumentReaderViewProps;
  readonly scrollIndicator: RefObject<HTMLDivElement | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const hovered = useRef("");
  const [status, setStatus] = useState<"opening" | "open" | "failed">(
    "opening",
  );
  const [attempt, setAttempt] = useState(0);
  const readPosition = () => runtime.getState().pdf;
  const position = useSyncExternalStore(runtime.subscribe, readPosition, readPosition);
  const { decorations, activePassage, inspection, isMobile } = view;
  const selectionInput = useReaderSelection(container, {
    identity: doc.identity,
    textSelector: ".textLayer",
    capture(selection) {
      if (selection.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      const page = pageOf(range.startContainer.parentElement);
      if (!page || !host.current?.contains(page) || pageOf(range.endContainer.parentElement) !== page)
        return null;
      const number = Number(page.dataset.pageNumber);
      const shown = pageView(live.current?.viewer, number);
      if (!shown) return null;
      const quads = rangeQuads(range, page, shown.viewport);
      const exact = selection.toString().trim();
      return quads.length && exact ? {
        identity: doc.identity,
        anchor: { kind: "pdf", page: number, quads, exact },
        quote: exact,
      } : null;
    },
    onSelection: view.onSelection,
  });

  const capture = useCallback((): {
    placement: Omit<Placement, "identity"> & {
      point: Extract<ReaderPoint, { kind: "pdf" }>;
    };
    band: [number, number];
    atEnd: boolean;
  } | null => {
    const viewer = live.current?.viewer;
    const port = container.current;
    if (!viewer || !port || viewer.pagesCount === 0) return null;
    const bounds = port.getBoundingClientRect();
    const line = readingLine(port);
    let primary: { page: number; y: number } | null = null;
    let first: number | null = null;
    let last = 0;
    const pages = viewer.pagesCount;
    // The first page reaching below the viewport's top (pages stack in order;
    // pdf.js's current page lags a scroll).
    let [lo, hi] = [1, pages];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rect = pageView(viewer, mid)?.div.getBoundingClientRect();
      if (rect && rect.bottom >= bounds.top) hi = mid;
      else lo = mid + 1;
    }
    for (let page = lo; page <= pages; page += 1) {
      const rect = pageView(viewer, page)?.div.getBoundingClientRect();
      if (!rect || rect.bottom < bounds.top) continue;
      if (rect.top > bounds.bottom) break;
      const at = (y: number) =>
        page - 1 + Math.min(1, Math.max(0, (y - rect.top) / rect.height));
      first ??= at(bounds.top);
      last = at(bounds.bottom);
      // pdf.js page borders overlap; the later page at the reading line owns that overlap.
      if (rect.bottom > line && (!primary || rect.top <= line))
        primary = { page, y: Math.max(0, (line - rect.top) / rect.height) };
    }
    if (!primary || first === null) return null;
    const atEnd = port.scrollHeight - port.clientHeight - port.scrollTop <= 2;
    return {
      placement: {
        point: { kind: "pdf", ...primary },
        offsetPx: 0,
        zoom: chosenZoom(viewer),
      },
      band: [first / pages, atEnd ? 1 : last / pages],
      atEnd,
    };
  }, []);

  // The widest page at scale 1, measured once per opened pdf.
  const natural = useRef<{ viewer: PDFViewer; px: number } | null>(null);
  const pdfState = useCallback((page: number): PdfState | null => {
    const viewer = live.current?.viewer;
    if (!viewer) return null;
    if (natural.current?.viewer !== viewer) {
      const widths = Array.from(
        { length: viewer.pagesCount },
        (_, i) => viewer.getPageView(i)?.viewport.width ?? 0,
      );
      natural.current = {
        viewer,
        px: Math.max(0, ...widths) / viewer.currentScale,
      };
    }
    const zoom = chosenZoom(viewer);
    const port = container.current!;
    return {
      page,
      pages: viewer.pagesCount,
      zoom,
      scale: viewer.currentScale,
      // Fitted, a pane this wide shows the widest page at scale 1; zoomed, at the zoom.
      widthPx: Math.ceil(
        natural.current.px * (zoom ?? 1) +
          PAGE_WIDTH_PADDING_PX +
          port.offsetWidth -
          port.clientWidth,
      ),
    };
  }, []);

  const measure = useCallback(() => {
    const measured = capture();
    if (!measured) return;
    const state = pdfState(measured.placement.point.page);
    if (!state) return;
    const { placement, band, atEnd } = measured;
    runtime.viewport(
      { primary: placement.point, start: band[0], end: band[1], atEnd },
      state,
    );
  }, [capture, pdfState, runtime]);
  useScrollport(container, runtime, measure, scrollIndicator);

  const paint = useCallback(
    (page: number) => {
      const shown = pageView(live.current?.viewer, page);
      if (!shown) return;
      for (const old of shown.div.querySelectorAll(`[${MARK}],[${PASSAGE}],[${INSPECTION}]`)) old.remove();
      const current = viewRef.current.decorations;
      const below = shown.div.querySelector(".textLayer");
      for (const mark of current?.identity === doc.identity ? current.marks : []) {
        if (mark.anchor.kind !== "pdf" || mark.anchor.page !== page) continue;
        for (const rect of quadRects(mark.anchor.quads, shown.viewport)) {
          const element = document.createElement("div");
          element.className = `${styles.pdfMark} hl-${mark.color}`;
          element.toggleAttribute("data-focused", mark.id === current?.focused);
          element.toggleAttribute("data-hovered", mark.id === current?.hovered);
          element.setAttribute(MARK, mark.id);
          element.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:var(--highlight-${mark.color})`;
          shown.div.insertBefore(element, below);
        }
      }
      const passage = viewRef.current.activePassage;
      if (passage?.identity === doc.identity && passage.anchor.kind === "pdf" && passage.anchor.page === page) {
        for (const rect of quadRects(passage.anchor.quads, shown.viewport)) {
          const element = document.createElement("div");
          element.className = styles.pdfMark;
          element.setAttribute(PASSAGE, "");
          element.setAttribute("data-focused", "");
          element.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          shown.div.insertBefore(element, below);
        }
      }
      const inspected = viewRef.current.inspection;
      if (inspected?.identity === doc.identity && inspected.pages.includes(page)) {
        const element = document.createElement("div");
        element.className = styles.pdfInspection;
        element.setAttribute(INSPECTION, "page");
        element.style.cssText = "inset:0";
        shown.div.insertBefore(element, below);
      }
      for (const anchor of inspected?.identity === doc.identity ? inspected.anchors : []) {
        if (anchor.kind !== "pdf" || anchor.page !== page) continue;
        for (const rect of quadRects(anchor.quads, shown.viewport)) {
          const element = document.createElement("div");
          element.className = styles.pdfInspection;
          element.setAttribute(INSPECTION, inspected!.precision);
          element.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          shown.div.insertBefore(element, below);
        }
      }
    },
    [doc.identity],
  );

  useLayoutEffect(() => {
    const viewer = live.current?.viewer;
    if (!viewer || status !== "open") return;
    for (let page = 1; page <= viewer.pagesCount; page += 1) paint(page);
  }, [decorations, activePassage, inspection, paint, status]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let task: PDFDocumentLoadingTask | null = null;
    let refit: ResizeObserver | null = null;
    let detach = () => {};
    /** Scale and restore the measured reading line under the navigator's fence. */
    const scaleTo = (viewer: PDFViewer, value: string) => {
      const placement = handle.capture();
      void runtime.reflow({
        placement: placement && {
          ...placement,
          zoom: value === "page-width" ? null : Number(value),
        },
        change: () => { viewer.currentScaleValue = value; },
      });
    };

    async function open(file: PdfFile, refreshed: boolean): Promise<void> {
      const { pdfjs, viewer: lib } = await loadPdfJs();
      if (signal.aborted) return;
      host.current!.replaceChildren();
      const eventBus = new lib.EventBus();
      const links = new lib.PDFLinkService({
        eventBus,
        externalLinkTarget: lib.LinkTarget.BLANK,
        externalLinkRel: "noopener noreferrer nofollow",
      });
      const goTo = links.goToDestination.bind(links);
      links.goToDestination = async (dest) =>
        void (await runtime.inspect({ target: { kind: "pdfDest", dest } }));
      links.goToPage = (page) =>
        void runtime.inspect({
          target: { kind: "point", point: { kind: "pdf", page: Number(page), y: 0 } },
        });
      links.setHash = (hash) => {
        const target = hashTarget(hash);
        if (target) void runtime.inspect({ target });
      };
      const named = links.executeNamedAction.bind(links);
      links.executeNamedAction = (action) => {
        const pages = {
          FirstPage: 1,
          LastPage: links.pagesCount,
          NextPage: links.page + 1,
          PrevPage: links.page - 1,
        };
        const page = pages[action as keyof typeof pages];
        if (page === undefined) named(action);
        else
          void runtime.inspect({
            target: { kind: "point", point: { kind: "pdf", page, y: 0 } },
          });
      };
      const find = createPdfFind(lib, eventBus, runtime);
      const viewer = new lib.PDFViewer({
        container: container.current!,
        viewer: host.current!,
        eventBus,
        linkService: links,
        findController: find.controller,
        textLayerMode: 1,
        // Only the pdf's own links are links; url-like text stays text.
        enableAutoLinking: false,
      });
      links.setViewer(viewer);
      let pdf: PDFDocumentProxy;
      try {
        task = pdfjs.getDocument({
          ...("ranges" in file
            ? { range: await hostRanges(pdfjs, file.ranges, signal, fail) }
            : { url: file.url, withCredentials: false }),
          // Fetching ahead only outruns an expiring url (d15); a copy loads what
          // is read, and a share's stream reads its whole file.
          disableAutoFetch: "ranges" in file || file.expiresAtMs === null,
          ...PDF_ASSETS,
        });
        pdf = await task.promise;
        if (signal.aborted) return;
        const initialized = new Promise<void>((resolve) =>
          eventBus.on("pagesinit", () => resolve(), { once: true }),
        );
        links.setDocument(pdf, null);
        viewer.setDocument(pdf);
        await initialized;
      } catch (error) {
        if (signal.aborted) return;
        if (refreshed) throw error;
        void task?.destroy();
        // An expired or revoked file url: one fresh file, then give up.
        return open(await runtime.source.refreshPdf(signal), true);
      }
      if (signal.aborted) return;
      viewer.currentScaleValue = "page-width";
      // Fitted stays fitted when the pane resizes (pdf.js refits only on assignment).
      refit = new ResizeObserver(() => {
        if (viewer.currentScaleValue === "page-width")
          scaleTo(viewer, "page-width");
      });
      refit.observe(container.current!);
      eventBus.on("pagechanging", () => requestAnimationFrame(measure));
      eventBus.on("pagerendered", ({ pageNumber }: { pageNumber: number }) =>
        paint(pageNumber),
      );
      eventBus.on("scalechanging", () => requestAnimationFrame(() => {
        measure();
        for (let page = 1; page <= viewer.pagesCount; page += 1) paint(page);
      }));
      live.current = { viewer, goTo };
      setStatus("open");
      const key = `${doc.identity}:${pdf.fingerprints[0]}:${attempt}`;
      detach = runtime.attach({
        ...handle,
        find: find.attach(viewer, pdf, key),
      });
      measure();
    }

    async function settle(
      to: Placement | ReaderTarget,
      signal: AbortSignal,
    ): Promise<NavOutcome> {
      const port = container.current!;
      const before = port.scrollTop;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (signal.aborted) return { kind: "Cancelled" };
        const aim = place(to);
        if (aim === null)
          return { kind: "Unavailable", reason: "TargetUnavailable" };
        port.scrollTop += aim;
        await nextFrame(signal);
        if (signal.aborted) return { kind: "Cancelled" };
        const off = place(to);
        const max = port.scrollHeight - port.clientHeight;
        if (
          off !== null &&
          (Math.abs(off) <= 2 ||
            (off > 0 && port.scrollTop >= max - 1) ||
            (off < 0 && port.scrollTop <= 0))
        ) {
          return {
            kind:
              Math.abs(port.scrollTop - before) < 1 ? "Unchanged" : "Arrived",
          };
        }
      }
      return { kind: "Unavailable", reason: "PositioningFailed" };
    }

    /** How far the target sits below where it belongs, in px; null when this pdf has no such place. */
    function place(to: Placement | ReaderTarget): number | null {
      const port = container.current!;
      const viewer = live.current?.viewer;
      if (!("offsetPx" in to) && to.kind === "edge") {
        return to.edge === "start" ? -port.scrollTop : port.scrollHeight;
      }
      let at: ReaderPoint | null = null;
      if ("offsetPx" in to || to.kind === "point") at = to.point;
      else if (to.kind === "quads") {
        const viewport = pageView(viewer, to.page)?.viewport;
        const top =
          viewport &&
          Math.min(...quadRects(to.quads, viewport).map((rect) => rect.top));
        // A little above the first quad, so the passage reads in context.
        if (viewport && top !== undefined)
          at = {
            kind: "pdf",
            page: to.page,
            y: Math.max(0, top / viewport.height - 0.05),
          };
      }
      const rect =
        at?.kind === "pdf"
          ? pageView(viewer, at.page)?.div.getBoundingClientRect()
          : null;
      if (!rect || at?.kind !== "pdf") return null;
      const want =
        "offsetPx" in to
          ? readingLine(port) + to.offsetPx
          : readingLine(port);
      return rect.top + at.y * rect.height - want;
    }

    const handle: Omit<SurfaceHandle, "find"> = {
      identity: doc.identity,
      measurePassage(passage) {
        const bounds = measureScrollport(container.current);
        if (!bounds || passage.identity !== doc.identity || passage.anchor.kind !== "pdf") return null;
        const shown = pageView(live.current?.viewer, passage.anchor.page);
        if (!shown?.div.isConnected) return null;
        const origin = shown.div.getBoundingClientRect();
        const lines = quadRects(passage.anchor.quads, shown.viewport)
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => new DOMRect(
            origin.left + shown.div.clientLeft + rect.left,
            origin.top + shown.div.clientTop + rect.top,
            rect.width, rect.height,
          ));
        if (!lines.length) return null;
        const left = Math.min(...lines.map((rect) => rect.left));
        const top = Math.min(...lines.map((rect) => rect.top));
        const right = Math.max(...lines.map((rect) => rect.right));
        const bottom = Math.max(...lines.map((rect) => rect.bottom));
        return {
          rect: new DOMRect(left, top, right - left, bottom - top),
          lines,
          bounds,
        };
      },
      measureBounds() {
        return measureScrollport(container.current);
      },
      focusSource() {
        container.current?.focus({ preventScroll: true });
      },
      capture() {
        const measured = capture();
        return measured && { ...measured.placement, identity: doc.identity };
      },
      async position(to, signal) {
        if (signal.aborted) return { kind: "Cancelled" };
        if ("identity" in to && to.identity !== doc.identity) {
          return { kind: "Unavailable", reason: "SourceChanged" };
        }
        const scale =
          "offsetPx" in to && (to.zoom === null ? "page-width" : String(to.zoom));
        if (scale && scale !== live.current!.viewer.currentScaleValue) {
          live.current!.viewer.currentScaleValue = scale;
          await nextFrame(signal);
          if (signal.aborted) return { kind: "Cancelled" };
        }
        if (!("offsetPx" in to) && to.kind === "pdfDest") {
          await live.current!.goTo(
            typeof to.dest === "string" ? to.dest : [...to.dest],
          );
          if (signal.aborted) return { kind: "Cancelled" };
          await nextFrame(signal);
          return signal.aborted ? { kind: "Cancelled" } : { kind: "Arrived" };
        }
        if (!("offsetPx" in to) && to.kind === "pdfMatch") {
          // One navigation request owns page arrival, text readiness and the match.
          const point = (y: number): ReaderTarget => ({
            kind: "point",
            point: { kind: "pdf", page: to.page, y },
          });
          const arrival = await settle(point(0), signal);
          if (signal.aborted || arrival.kind === "Cancelled") return { kind: "Cancelled" };
          if (arrival.kind === "Unavailable") return arrival;
          for (let frame = 0; frame < 60; frame += 1) {
            if (signal.aborted) return { kind: "Cancelled" };
            const viewer = live.current?.viewer;
            const selected = viewer?.findController?.selected;
            if (selected?.pageIdx !== to.page - 1 || selected.matchIdx !== to.index)
              return { kind: "Cancelled" };
            const page = pageView(viewer, to.page)?.div;
            const match = page?.querySelector(".textLayer .highlight.selected");
            if (page && match) {
              const box = page.getBoundingClientRect();
              const top = match.getBoundingClientRect().top - box.top;
              const placement = await settle(point(Math.max(0, top / box.height - 0.05)), signal);
              if (signal.aborted || placement.kind === "Cancelled") return { kind: "Cancelled" };
              if (placement.kind === "Unavailable") return placement;
              return { kind: arrival.kind === "Arrived" || placement.kind === "Arrived" ? "Arrived" : "Unchanged" };
            }
            await nextFrame(signal);
          }
          if (signal.aborted) return { kind: "Cancelled" };
          return { kind: "Unavailable", reason: "TargetUnavailable" };
        }
        return settle(to, signal);
      },
      setZoom(zoom) {
        const viewer = live.current?.viewer;
        if (!viewer || zoom === viewer.currentScale) return;
        scaleTo(viewer, String(zoom));
      },
    };

    /** Ends this open: Retry shows, and every read stops. */
    const fail = (error: unknown) => {
      if (signal.aborted) return;
      console.error("pdf_open_failed", error);
      setStatus("failed");
      controller.abort();
    };
    setStatus("opening");
    open(doc.file, false).catch(fail);
    return () => {
      controller.abort();
      refit?.disconnect();
      detach();
      live.current = null;
      void task?.destroy();
    };
  }, [attempt, capture, doc.file, doc.identity, measure, paint, runtime]);

  /** Marks under a pointer, topmost first, hit-tested in page space (they sit under the text layer). */
  function marks(event: React.MouseEvent, kind: "activate" | "hover") {
    if (kind === "activate" && !document.getSelection()?.isCollapsed) return;
    const page = pageOf(event.target);
    const number = Number(page?.dataset.pageNumber);
    const shown = page && pageView(live.current?.viewer, number);
    const current = viewRef.current.decorations;
    const origin = page?.getBoundingClientRect();
    const [x, y] =
      shown && origin
        ? toPage(
            event.clientX - origin.left - page.clientLeft,
            event.clientY - origin.top - page.clientTop,
            shown.viewport,
          )
        : [NaN, NaN];
    const marks = (current?.identity === doc.identity ? current.marks : [])
      .filter(
        ({ anchor }) =>
          anchor.kind === "pdf" &&
          anchor.page === number &&
          anchor.quads.some((quad) => quadContains(quad, x, y)),
      );
    const ids = marks.map((mark) => mark.id);
    if (kind === "hover" && ids.join(" ") === hovered.current) return;
    hovered.current = ids.join(" ");
    if (ids.length || kind === "hover") {
      viewRef.current.onMarks?.(kind === "hover" ? { kind, ids } : {
        kind, identity: doc.identity, marks,
        input: event.detail === 0 ? "keyboard" : selectionInput.current,
      });
    }
  }

  return (
    <div className={styles.pdfFrame}>
      {position ? <p
        className={styles.live}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Page {position.page} of {position.pages}
      </p> : null}
      {status === "opening" ? (
        <p role="status" className={styles.note}>
          Loading PDF…
        </p>
      ) : null}
      {status === "failed" ? (
        <p role="alert" className={styles.note}>
          This PDF could not be opened.{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      <div
        ref={container}
        className={styles.pdfScrollport}
        role="region"
        aria-label="PDF document"
        tabIndex={-1}
        data-pane-content="true"
        onClick={(event) => marks(event, "activate")}
        onMouseMove={
          view.onMarks && !isMobile
            ? (event) => marks(event, "hover")
            : undefined
        }
      >
        {view.before}
        <div ref={host} className="pdfViewer" />
      </div>
    </div>
  );
}
