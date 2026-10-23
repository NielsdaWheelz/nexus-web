"use client";

// One pdf in pdf.js's viewer. Positions are page-relative (page, y down the
// page), so they survive zoom. Links and destinations inside the pdf become
// reader jumps. A failed open refreshes the file once and reopens at the
// last placement; a host's range read that fails later ends the open with
// Retry. Marks are page-space quads drawn under the text layer. That layer's
// focusability belongs to reading; its interactive descendants own their clicks.
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { isInteractiveTarget } from "@/lib/ui/eventTarget";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import type * as PdfJs from "pdfjs-dist";
import type {
  PDFDataRangeTransport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from "pdfjs-dist";
import type { PDFPageView, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { DocumentReaderViewProps } from "../DocumentReader";
import type {
  PdfDocument,
  PdfFile,
  Placement,
  ReaderPoint,
  ReaderTarget,
} from "../model";
import type { NavOutcome } from "../navigator";
import type { ReaderDestination } from "../location";
import { activateReaderDestination } from "../navigation";
import type { PdfState, ReaderRuntime, SurfaceHandle } from "../runtime";
import { useReaderSelection } from "../selection";
import { measureScrollport, readScrollport, nextFrame, useScrollport } from "../scrollport";
import { createPdfFind } from "./find";
import { pageSize, quadContains, quadRects, rangeQuads, toPage } from "./geometry";
import { loadPdfJs, PDF_ASSETS } from "./pdfjs";
import { preparePdfDestination, type PreparedPdfDestination, type PdfSourceView } from "./destination";
import styles from "../documentReader.module.css";

interface Live {
  readonly viewer: PDFViewer;
  readonly pdf: PDFDocumentProxy;
}

const MARK = "data-reader-mark";
const PASSAGE = "data-reader-passage";
const INSPECTION = "data-reader-inspection";
/** pdf.js leaves this much of the container's width beside a page fitted to it. */
const PAGE_WIDTH_PADDING_PX = 40;

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
  return viewer?.getPageView(page - 1) as PDFPageView | undefined;
}

/** The zoom a position keeps: null while fitted to the width, so it fits wherever it reopens. */
const chosenZoom = (viewer: PDFViewer) =>
  viewer.currentScaleValue === "page-width" ? null : viewer.currentScale;

export default function PdfSurface({
  runtime,
  doc,
  view,
  scrollIndicator,
  feedback,
}: {
  readonly runtime: ReaderRuntime;
  readonly doc: PdfDocument;
  readonly view: DocumentReaderViewProps;
  readonly scrollIndicator: RefObject<HTMLDivElement | null>;
  readonly feedback: RefObject<HTMLDivElement | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const cachedPlacement = useRef<Placement | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const destinations = useRef(new WeakMap<HTMLAnchorElement, ReaderDestination | null>());
  const [locationUnavailable, setLocationUnavailable] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const hovered = useRef("");
  const [status, setStatus] = useState<
    { kind: "Opening" | "Open" } | { kind: "Failed"; retrying: boolean }
  >({ kind: "Opening" });
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
      const end = pageOf(range.endContainer.parentElement);
      if (!page || !end || !host.current?.contains(page) || !host.current.contains(end)) return null;
      if (end !== page) return { kind: "Rejected", reason: "CrossPage" };
      const number = Number(page.dataset.pageNumber);
      const shown = pageView(live.current?.viewer, number);
      if (!shown) return null;
      const quads = rangeQuads(range, page, shown.viewport);
      const exact = selection.toString().trim();
      return quads.length && exact ? {
        kind: "Captured",
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
    const snapshot = readScrollport(port);
    if (!snapshot) return null;
    const { bounds, readingLine: line } = snapshot;
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

  const measure = useCallback((cause: "Observation" | "Geometry") => {
    const measured = capture();
    if (!measured) return;
    const state = pdfState(measured.placement.point.page);
    if (!state) return;
    const { placement, band, atEnd } = measured;
    cachedPlacement.current = { ...placement, identity: doc.identity };
    runtime.viewport(
      { primary: placement.point, start: band[0], end: band[1], atEnd },
      placement,
      cause,
      state,
    );
  }, [capture, doc.identity, pdfState, runtime]);
  const geometryChanged = useScrollport(container, runtime, measure, {
    placement: cachedPlacement,
    change() {
      const viewer = live.current?.viewer;
      if (viewer?.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
      measure("Geometry");
    },
  }, scrollIndicator, feedback);

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
    if (!viewer || status.kind !== "Open") return;
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
      links.goToPage = (page) =>
        void runtime.inspect({
          target: { kind: "pdf", page: Number(page), view: { kind: "page_top", zoom: chosenZoom(viewer) } },
        });
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
            target: { kind: "pdf", page, view: { kind: "page_top", zoom: chosenZoom(viewer) } },
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
      eventBus.on("textlayerrendered", ({ pageNumber }: { pageNumber: number }) => {
        pageView(viewer, pageNumber)?.div.querySelector(".textLayer")?.setAttribute("data-reader-input-boundary", "");
      });
      links.setViewer(viewer);
      let pdf: PDFDocumentProxy;
      let sourceView: PdfSourceView = { zoom: null, left: 0, top: 0 };
      const prepared = new Map<HTMLAnchorElement, PreparedPdfDestination>();
      const refreshLinks = () => {
        sourceView = { ...sourceView, zoom: chosenZoom(viewer) };
        for (const [anchor, target] of prepared) {
          if (!anchor.isConnected) { prepared.delete(anchor); continue; }
          const destination = { source_identity: doc.identity, target: target(sourceView) };
          const href = runtime.navigation?.href(destination);
          destinations.current.set(anchor, destination);
          anchor.setAttribute("data-workspace-rich-target", "true");
          anchor.removeAttribute("aria-busy");
          if (href) anchor.href = href;
          else if (runtime.navigation) anchor.removeAttribute("href");
        }
      };
      links.goToDestination = async (raw) => {
        const target = await preparePdfDestination(pdf, raw);
        if (signal.aborted) return;
        if (target) void runtime.inspect({ target: target({ ...sourceView, zoom: chosenZoom(viewer) }) });
        else setLocationUnavailable(true);
      };
      eventBus.on("updateviewarea", ({ location }: { location: { left: number; top: number } }) => {
        sourceView = { zoom: chosenZoom(viewer), left: location.left, top: location.top };
        refreshLinks();
      });
      eventBus.on("annotationlayerrendered", ({ pageNumber }: { pageNumber: number }) => {
        const page = pageView(viewer, pageNumber)?.div;
        if (!page) return;
        const anchors = [...page.querySelectorAll<HTMLAnchorElement>("[data-internal-link] a")];
        const original = new Map(anchors.map((anchor) => [anchor, anchor.getAttribute("href")]));
        for (const anchor of anchors) {
          destinations.current.set(anchor, null);
          anchor.removeAttribute("href");
          anchor.setAttribute("aria-busy", "true");
        }
        void pdf.getPage(pageNumber).then((page) => page.getAnnotations({ intent: "display" })).then(async (annotations: unknown[]) => {
          for (const anchor of anchors) {
            if (signal.aborted || !anchor.isConnected) return;
            const annotation = annotations.find((item): item is { id: string; dest?: unknown; action?: string } =>
              typeof item === "object" && item !== null && "id" in item && item.id === anchor.dataset.elementId);
            let target: PreparedPdfDestination | null = null;
            const action = annotation?.action;
            if (action && ["FirstPage", "LastPage", "NextPage", "PrevPage"].includes(action))
              target = (source) => ({ kind: "pdf", page: Math.max(1, Math.min(viewer.pagesCount,
                action === "FirstPage" ? 1 : action === "LastPage" ? viewer.pagesCount : viewer.currentPageNumber + (action === "NextPage" ? 1 : -1))),
                view: { kind: "page_top", zoom: source.zoom } });
            else if (annotation?.dest !== undefined) target = await preparePdfDestination(pdf, annotation.dest);
            else {
              destinations.current.delete(anchor);
              const href = original.get(anchor);
              if (href) anchor.setAttribute("href", href);
              anchor.removeAttribute("aria-busy");
              continue;
            }
            if (signal.aborted || !anchor.isConnected) return;
            if (target) {
              prepared.set(anchor, target);
              const href = original.get(anchor);
              if (!runtime.navigation && href) anchor.setAttribute("href", href);
            } else {
              anchor.removeAttribute("aria-busy");
              anchor.setAttribute("aria-disabled", "true");
            }
          }
          refreshLinks();
        }).catch((error: unknown) => {
          if (!signal.aborted) { console.error("pdf_destination_failed", error); setLocationUnavailable(true); }
        });
      });
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
      refit = new ResizeObserver(() => geometryChanged("Layout"));
      refit.observe(container.current!);
      eventBus.on("pagechanging", () => { refreshLinks(); requestAnimationFrame(() => measure("Geometry")); });
      eventBus.on("pagerendered", ({ pageNumber }: { pageNumber: number }) =>
        paint(pageNumber),
      );
      eventBus.on("scalechanging", () => requestAnimationFrame(() => {
        refreshLinks();
        measure("Geometry");
        for (let page = 1; page <= viewer.pagesCount; page += 1) paint(page);
      }));
      live.current = { viewer, pdf };
      setStatus({ kind: "Open" });
      const key = `${doc.identity}:${pdf.fingerprints[0]}:${attempt}`;
      detach = runtime.attach({
        ...handle,
        find: find.attach(viewer, pdf, key),
      });
      measure("Geometry");
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
      const snapshot = readScrollport(port);
      if (!snapshot) return null;
      const want = snapshot.readingLine + ("offsetPx" in to ? to.offsetPx : 0);
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
        if (!("offsetPx" in to) && (to.kind === "pdf" || to.kind === "quads")) {
          const { viewer, pdf } = live.current!;
          const shown = pageView(viewer, to.page);
          if (!shown || to.page < 1 || to.page > pdf.numPages) return { kind: "Unavailable", reason: "TargetUnavailable" };
          const page = await pdf.getPage(to.page);
          if (signal.aborted) return { kind: "Cancelled" };
          // Lazy pages initially borrow page one's geometry. Use this page's real crop/rotation before positioning.
          if (!shown.pdfPage) shown.setPdfPage(page);
        }
        const scale =
          "offsetPx" in to && (to.zoom === null ? "page-width" : String(to.zoom));
        if (scale && scale !== live.current!.viewer.currentScaleValue) {
          live.current!.viewer.currentScaleValue = scale;
          await nextFrame(signal);
          if (signal.aborted) return { kind: "Cancelled" };
        }
        if (!("offsetPx" in to) && to.kind === "pdf") {
          const viewer = live.current!.viewer;
          const page = pageView(viewer, to.page);
          if (!page || to.page < 1 || to.page > viewer.pagesCount) return { kind: "Unavailable", reason: "TargetUnavailable" };
          const view = to.view;
          const points = view.kind === "xyz" || view.kind === "fit_width" ? [[view.left, view.top]]
            : view.kind === "fit_height" ? [[view.left, 0]]
            : view.kind === "fit_rect" ? [[view.left, view.bottom], [view.right, view.top]] : [];
          const multiplier = (view.kind === "xyz" || view.kind === "page_top") && view.zoom !== null ? view.zoom / viewer.currentScale : 1;
          if (![page.viewport.width * multiplier, page.viewport.height * multiplier].every(Number.isFinite) ||
            points.some(([x, y]) => page.viewport.convertToViewportPoint(x, y).some((coordinate) => !Number.isFinite(coordinate * multiplier))) ||
            view.kind === "fit_rect" && (![view.right - view.left, view.top - view.bottom].every(Number.isFinite) || !Number.isFinite(Math.min(container.current!.clientWidth / (view.right - view.left), container.current!.clientHeight / (view.top - view.bottom)))))
            return { kind: "Unavailable", reason: "TargetUnavailable" };
          if (view.kind === "page_top") {
            viewer.currentScaleValue = view.zoom === null ? "page-width" : String(view.zoom);
            await nextFrame(signal);
            return settle({ kind: "point", point: { kind: "pdf", page: to.page, y: 0 } }, signal);
          }
          if (view.kind === "xyz" && view.zoom === null || view.kind === "fit_width") viewer.currentScaleValue = "page-width";
          const destArray = view.kind === "xyz" ? [to.page - 1, { name: "XYZ" }, view.left, view.top, view.zoom]
            : view.kind === "fit_width" ? [to.page - 1, { name: "XYZ" }, view.left, view.top, null]
            : view.kind === "fit_height" ? [to.page - 1, { name: "FitV" }, view.left]
            : view.kind === "fit_rect" ? [to.page - 1, { name: "FitR" }, view.left, view.bottom, view.right, view.top]
            : [to.page - 1, { name: "Fit" }];
          viewer.scrollPageIntoView({ pageNumber: to.page, destArray });
          await nextFrame(signal);
          return signal.aborted ? { kind: "Cancelled" } : { kind: "Arrived" };
        }
        if (!("offsetPx" in to) && to.kind === "quads") {
          const viewport = pageView(live.current!.viewer, to.page)?.viewport;
          if (!viewport) return { kind: "Unavailable", reason: "TargetUnavailable" };
          const { width, height } = pageSize(viewport);
          if (to.quads.some((quad) => [quad.x1, quad.x2, quad.x3, quad.x4].some((x) => x < 0 || x > width) ||
            [quad.y1, quad.y2, quad.y3, quad.y4].some((y) => y < 0 || y > height)))
            return { kind: "Unavailable", reason: "TargetUnavailable" };
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
        if (!viewer || zoom === chosenZoom(viewer)) return;
        scaleTo(viewer, zoom === null ? "page-width" : String(zoom));
      },
    };

    /** Ends this open: Retry shows, and every read stops. */
    const fail = (error: unknown) => {
      if (signal.aborted) return;
      console.error("pdf_open_failed", error);
      setStatus({ kind: "Failed", retrying: false });
      controller.abort();
    };
    setStatus((current) => current.kind === "Failed" ? { ...current, retrying: true } : { kind: "Opening" });
    open(doc.file, false).catch(fail);
    return () => {
      controller.abort();
      refit?.disconnect();
      detach();
      live.current = null;
      void task?.destroy();
    };
  }, [attempt, capture, doc.file, doc.identity, measure, paint, runtime, geometryChanged]);

  /** Marks under a pointer, topmost first, hit-tested in page space (they sit under the text layer). */
  function marks(event: React.MouseEvent, kind: "activate" | "hover") {
    // pdf.js makes the text layer focusable; only controls inside it own text clicks.
    const reading = event.target instanceof Element ? event.target.closest("[data-reader-input-boundary]") : null;
    const boundary = reading && event.currentTarget.contains(reading) ? reading : event.currentTarget;
    if (kind === "activate" && (
      event.defaultPrevented || event.button !== 0 || event.altKey ||
      event.ctrlKey || event.metaKey || event.shiftKey ||
      document.getSelection()?.isCollapsed === false ||
      isInteractiveTarget(event.target, boundary)
    )) return;
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
    const onMarks = viewRef.current.onMarks;
    if (onMarks && (ids.length || kind === "hover")) {
      if (kind === "activate") event.preventDefault();
      onMarks(kind === "hover" ? { kind, ids } : {
        kind, identity: doc.identity, marks,
        input: event.detail === 0 ? "keyboard" : selectionInput.current,
      });
    }
  }

  function openLink(event: TargetActivationEvent & { target: EventTarget | null; stopPropagation(): void }) {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("[data-internal-link] a") : null;
    if (!anchor || !destinations.current.has(anchor)) return;
    // pdf.js installs a target onclick that drops modifiers. Preserve the anchor's native default,
    // but never let that handler run after this owner has classified the event.
    event.stopPropagation();
    const destination = destinations.current.get(anchor);
    if (destination) activateReaderDestination(runtime, destination, event);
    else {
      const activation = workspaceTargetActivationIntent(event);
      if (activation.kind !== "Unowned") { event.preventDefault(); if (activation.kind === "Open") setLocationUnavailable(true); }
    }
  }

  return (
    <div className={styles.pdfFrame}>
      {locationUnavailable && feedback.current ? createPortal(<FeedbackNotice content={{ tone: "Danger", title: "location unavailable" }} announcement={view.announcement ?? "Polite"} />, feedback.current) : null}
      {position ? <p
        className={styles.live}
        role={view.announcement === "None" ? undefined : "status"}
        aria-live={view.announcement === "None" ? "off" : "polite"}
        aria-atomic="true"
      >
        Page {position.page} of {position.pages}
      </p> : null}
      {status.kind === "Opening" ? (
        <div className={`${styles.feedback} ${styles.readerState}`}>
          <FeedbackState content={{ tone: "Neutral", title: "opening pdf…" }} announcement={view.announcement ?? "Polite"} />
        </div>
      ) : null}
      {status.kind === "Failed" ? (
        <div className={`${styles.feedback} ${styles.readerState}`}>
          <FeedbackState
            content={{ tone: "Danger", title: "couldn’t open this pdf" }}
            announcement={view.announcement ?? "Polite"}
            actions={[{ label: "retry", onClick: () => setAttempt((n) => n + 1), busy: status.retrying }]}
            returnFocus={() => container.current}
          />
        </div>
      ) : null}
      <div
        ref={container}
        className={styles.pdfScrollport}
        role="region"
        aria-label="PDF document"
        tabIndex={-1}
        data-pane-content="true"
        onClickCapture={openLink}
        onKeyDownCapture={openLink}
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
