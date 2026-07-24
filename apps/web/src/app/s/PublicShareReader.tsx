"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import {
  PDF_WORKER_SRC,
  loadPdfJs,
  loadPdfJsViewer,
  type PdfDocumentLike,
  type PdfDocumentLoadingTaskLike,
  type PdfEventBusLike,
} from "@/components/pdfReaderRuntime";
import {
  publicPdfSource,
  readAllPublicFragments,
  readAllPublicNavigation,
  readPublicAsset,
  readPublicSection,
  readPublicShareBootstrap,
} from "@/lib/sharing/publicClient";
import {
  parsePublicShareFragment,
  type PublicFragmentPage,
  type PublicHighlight,
  type PublicNavigationPage,
  type PublicSection,
  type PublicShareBootstrap,
} from "@/lib/sharing/publicContract";
import {
  clearExactPublicTextHighlight,
  focusPublicHighlightTarget,
  installExactPublicTextHighlight,
  installPublicPdfHighlightOverlay,
} from "@/lib/sharing/publicHighlightRendering";
import styles from "./publicShare.module.css";

type ReaderData =
  | { kind: "ArticleOrTranscript"; page: PublicFragmentPage }
  | { kind: "Epub"; navigation: PublicNavigationPage }
  | { kind: "Pdf" };

type ViewState =
  | { status: "Resolving" }
  | { status: "Unavailable" }
  | {
      status: "Ready";
      token: string;
      bootstrap: PublicShareBootstrap;
      readerData: ReaderData;
    };

export default function PublicShareReader() {
  const [state, setState] = useState<ViewState>({ status: "Resolving" });

  useEffect(() => {
    let activeController: AbortController | null = null;
    let generation = 0;
    let disposed = false;

    const resolveFragment = async () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const requestGeneration = ++generation;
      document.title = "Nexus";
      setState({ status: "Resolving" });
      const token = parsePublicShareFragment(window.location.hash);
      if (!token) {
        if (!disposed && requestGeneration === generation) {
          setState({ status: "Unavailable" });
        }
        return;
      }
      try {
        const bootstrap = await readPublicShareBootstrap(
          token,
          controller.signal
        );
        let readerData: ReaderData;
        switch (bootstrap.reader.kind) {
          case "Article":
          case "Transcript":
            readerData = {
              kind: "ArticleOrTranscript",
              page: await readAllPublicFragments(token, controller.signal),
            };
            break;
          case "Epub":
            readerData = {
              kind: "Epub",
              navigation: await readAllPublicNavigation(
                token,
                controller.signal
              ),
            };
            break;
          case "Pdf":
            readerData = { kind: "Pdf" };
            break;
          default:
            bootstrap.reader satisfies never;
            throw new Error("Unsupported public reader");
        }
        if (
          disposed ||
          controller.signal.aborted ||
          requestGeneration !== generation
        ) {
          return;
        }
        document.title = `${bootstrap.media.title} · Nexus`;
        setState({ status: "Ready", token, bootstrap, readerData });
      } catch (error) {
        if (
          controller.signal.aborted ||
          disposed ||
          requestGeneration !== generation
        ) {
          return;
        }
        console.error("public_share_resolution_failed", {
          reason: error instanceof Error ? error.name : "UnknownError",
        });
        setState({ status: "Unavailable" });
      }
    };

    void resolveFragment();
    window.addEventListener("hashchange", resolveFragment);
    return () => {
      disposed = true;
      generation += 1;
      activeController?.abort();
      window.removeEventListener("hashchange", resolveFragment);
      document.title = "Nexus";
    };
  }, []);

  if (state.status === "Resolving") {
    return <PublicShell><StatusCard>Opening shared reading…</StatusCard></PublicShell>;
  }
  if (state.status === "Unavailable") {
    return (
      <PublicShell>
        <StatusCard>
          <h1>Share unavailable</h1>
          <p>This link is invalid, revoked, or no longer readable.</p>
        </StatusCard>
      </PublicShell>
    );
  }

  const highlight =
    state.bootstrap.subject.kind === "Highlight"
      ? state.bootstrap.subject.highlight
      : null;
  return (
    <PublicShell>
      <header className={styles.header}>
        <div className={styles.brand}>Nexus</div>
        <h1>{state.bootstrap.media.title}</h1>
        {state.bootstrap.media.bylines.length > 0 ? (
          <p className={styles.bylines}>
            {state.bootstrap.media.bylines.join(", ")}
          </p>
        ) : null}
        {state.bootstrap.media.sourceUrl.kind === "Present" ? (
          <a
            className={styles.sourceLink}
            href={state.bootstrap.media.sourceUrl.value}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            View original source
          </a>
        ) : null}
      </header>
      {highlight ? <HighlightCallout highlight={highlight} /> : null}
      <main className={styles.reader}>
        {state.readerData.kind === "ArticleOrTranscript" ? (
          <PublicFragments
            page={state.readerData.page}
            highlight={highlight}
          />
        ) : state.readerData.kind === "Epub" ? (
          <PublicEpub
            token={state.token}
            navigation={state.readerData.navigation}
            highlight={highlight}
          />
        ) : (
          <PublicPdf token={state.token} highlight={highlight} />
        )}
      </main>
      <footer className={styles.footer}>
        Read-only shared view. No Nexus account is required.
      </footer>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: ReactNode }) {
  return <div className={styles.shell}>{children}</div>;
}

function StatusCard({ children }: { children: ReactNode }) {
  return (
    <main className={styles.statusCard} role="status">
      {children}
    </main>
  );
}

function HighlightCallout({ highlight }: { highlight: PublicHighlight }) {
  return (
    <aside
      className={styles.highlightCallout}
      data-highlight-color={highlight.color.toLowerCase()}
      aria-label="Shared highlight"
    >
      <span className={styles.highlightLabel}>Shared highlight</span>
      {highlight.quote.kind === "Present" ? (
        <blockquote>{highlight.quote.value}</blockquote>
      ) : (
        <p>The highlighted area is shown in the document below.</p>
      )}
    </aside>
  );
}

function PublicFragments({
  page,
  highlight,
}: {
  page: PublicFragmentPage;
  highlight: PublicHighlight | null;
}) {
  if (page.kind === "ArticleFragments") {
    const anchor =
      highlight?.anchor.kind === "ArticleText" ? highlight.anchor : null;
    const targetOrdinal = anchor?.fragmentOrdinal ?? null;
    const hasTarget =
      anchor !== null &&
      page.items.some((fragment) => fragment.ordinal === targetOrdinal);
    return (
      <article className={styles.article}>
        {anchor && !hasTarget ? <HighlightUnavailable /> : null}
        {page.items.map((fragment) => {
          const isTarget = fragment.ordinal === targetOrdinal;
          return (
            <section key={fragment.ordinal}>
              <PublicHtmlWithAssets
                html={fragment.htmlSanitized}
                canonicalText={fragment.canonicalText}
                startOffset={isTarget ? anchor?.startOffset : undefined}
                endOffset={isTarget ? anchor?.endOffset : undefined}
                expectedText={
                  isTarget && highlight?.quote.kind === "Present"
                    ? highlight.quote.value
                    : undefined
                }
              />
            </section>
          );
        })}
      </article>
    );
  }

  const anchor =
    highlight?.anchor.kind === "TranscriptText" ? highlight.anchor : null;
  const targetOrdinal = anchor?.segmentOrdinal ?? null;
  const hasTarget =
    anchor !== null &&
    page.items.some((segment) => segment.ordinal === targetOrdinal);
  return (
    <ol className={styles.transcript}>
      {anchor && !hasTarget ? <HighlightUnavailable /> : null}
      {page.items.map((segment) => {
        const isTarget = segment.ordinal === targetOrdinal;
        const exactText =
          isTarget && anchor && highlight?.quote.kind === "Present"
            ? highlightText(
                segment.canonicalText,
                anchor.startOffset,
                anchor.endOffset,
                highlight.quote.value
              )
            : null;
        const isExactTarget = isTarget && exactText !== null;
        return (
          <li
            key={segment.ordinal}
            data-public-highlight-target={
              isExactTarget ? "true" : undefined
            }
            className={isExactTarget ? styles.targetSection : undefined}
            tabIndex={isExactTarget ? -1 : undefined}
            ref={(element) => {
              if (element && isExactTarget) {
                focusPublicHighlightTarget(element);
              }
            }}
          >
            <div className={styles.segmentMeta}>
              {segment.timeRange.kind === "Present"
                ? formatTimestamp(segment.timeRange.value.startMs)
                : null}
              {segment.speaker.kind === "Present"
                ? ` · ${segment.speaker.value}`
                : null}
            </div>
            <p>{exactText ?? segment.canonicalText}</p>
            {isTarget && !isExactTarget ? <HighlightUnavailable /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function PublicEpub({
  token,
  navigation,
  highlight,
}: {
  token: string;
  navigation: PublicNavigationPage;
  highlight: PublicHighlight | null;
}) {
  const highlightedHandle =
    highlight?.anchor.kind === "EpubText"
      ? highlight.anchor.sectionHandle
      : null;
  const [selectedHandle, setSelectedHandle] = useState(
    highlightedHandle ?? navigation.items[0]?.sectionHandle ?? null
  );
  const [section, setSection] = useState<PublicSection | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!selectedHandle) return;
    const controller = new AbortController();
    setSection(null);
    setUnavailable(false);
    readPublicSection(token, selectedHandle, controller.signal)
      .then(setSection)
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [selectedHandle, token]);

  if (navigation.items.length === 0 || !selectedHandle) {
    return <p className={styles.empty}>This book has no readable sections.</p>;
  }
  return (
    <div className={styles.epubLayout}>
      <nav className={styles.toc} aria-label="Book contents">
        {navigation.items.map((item) => (
          <button
            key={item.sectionHandle}
            type="button"
            aria-current={
              item.sectionHandle === selectedHandle ? "location" : undefined
            }
            style={{ paddingInlineStart: `${12 + item.depth * 12}px` }}
            onClick={() => setSelectedHandle(item.sectionHandle)}
          >
            {item.label || `Section ${item.ordinal + 1}`}
          </button>
        ))}
      </nav>
      <article className={styles.epubSection}>
        {unavailable ? (
          <p className={styles.empty}>Section unavailable.</p>
        ) : section ? (
          <PublicHtmlWithAssets
            key={section.sectionHandle}
            token={token}
            html={section.htmlSanitized}
            canonicalText={section.canonicalText}
            startOffset={
              section.sectionHandle === highlightedHandle &&
              highlight?.anchor.kind === "EpubText"
                ? highlight.anchor.startOffset
                : undefined
            }
            endOffset={
              section.sectionHandle === highlightedHandle &&
              highlight?.anchor.kind === "EpubText"
                ? highlight.anchor.endOffset
                : undefined
            }
            expectedText={
              section.sectionHandle === highlightedHandle &&
              highlight?.quote.kind === "Present"
                ? highlight.quote.value
                : undefined
            }
          />
        ) : (
          <p className={styles.empty}>Loading section…</p>
        )}
      </article>
    </div>
  );
}

function PublicHtmlWithAssets({
  token,
  html,
  canonicalText,
  startOffset,
  endOffset,
  expectedText,
}: {
  token?: string;
  html: string;
  canonicalText: string;
  startOffset?: number;
  endOffset?: number;
  expectedText?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [highlightUnavailable, setHighlightUnavailable] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !token) return;
    const controller = new AbortController();
    const objectUrls: string[] = [];
    for (const image of root.querySelectorAll<HTMLImageElement>(
      "img[data-nexus-public-asset-handle]"
    )) {
      const handle = image.dataset.nexusPublicAssetHandle;
      if (!handle) continue;
      void readPublicAsset(token, handle, controller.signal)
        .then((blob) => {
          if (controller.signal.aborted) return;
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.push(objectUrl);
          image.src = objectUrl;
        })
        .catch(() => {
          image.removeAttribute("src");
        });
    }
    return () => {
      controller.abort();
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    };
  }, [html, token]);

  useEffect(() => {
    const root = rootRef.current;
    if (
      !root ||
      startOffset === undefined ||
      endOffset === undefined ||
      expectedText === undefined
    ) {
      setHighlightUnavailable(false);
      return;
    }
    const mark = installExactPublicTextHighlight(root, {
      canonicalText,
      startOffset,
      endOffset,
      expectedText,
    });
    setHighlightUnavailable(mark === null);
    if (mark) focusPublicHighlightTarget(mark);
    return () => {
      clearExactPublicTextHighlight(root);
    };
  }, [canonicalText, endOffset, expectedText, html, startOffset]);

  return (
    <>
      <div ref={rootRef}>
        <HtmlRenderer htmlSanitized={html} headingLevelOffset={1} />
      </div>
      {highlightUnavailable ? <HighlightUnavailable /> : null}
    </>
  );
}

function PublicPdf({
  token,
  highlight,
}: {
  token: string;
  highlight: PublicHighlight | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState(false);
  const [highlightUnavailable, setHighlightUnavailable] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!container || !viewerElement) return;
    let disposed = false;
    let doc: PdfDocumentLike | null = null;
    let task: PdfDocumentLoadingTaskLike | null = null;
    let eventBus: PdfEventBusLike | null = null;
    let focusTarget: ((event: unknown) => void) | null = null;
    let paintTarget: ((event: unknown) => void) | null = null;
    setError(false);
    setHighlightUnavailable(false);

    void (async () => {
      try {
        const [pdfJs, pdfViewer] = await Promise.all([
          loadPdfJs(),
          loadPdfJsViewer(),
        ]);
        if (disposed) return;
        pdfJs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        eventBus = new pdfViewer.EventBus();
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
          textLayerMode: 1,
          enableAutoLinking: false,
        });
        linkService.setViewer(viewer);
        task = pdfJs.getDocument(publicPdfSource(token));
        doc = await task.promise;
        if (disposed) return;
        const pdfHighlight =
          highlight?.anchor.kind === "PdfGeometry"
            ? { anchor: highlight.anchor, color: highlight.color }
            : null;
        const pdfAnchor = pdfHighlight?.anchor ?? null;
        const pdfHighlightColor = pdfHighlight?.color ?? null;
        const targetPage = pdfAnchor?.pageNumber ?? 1;
        if (targetPage > doc.numPages) {
          setHighlightUnavailable(pdfAnchor !== null);
          return;
        }
        focusTarget = () => {
          viewer.currentScaleValue = "page-width";
          viewer.currentPageNumber = targetPage;
        };
        paintTarget = (event: unknown) => {
          if (
            !pdfAnchor ||
            !pdfHighlightColor ||
            !isPageRenderedEvent(event, targetPage)
          )
            return;
          const pageElement = viewerElement.querySelector<HTMLElement>(
            `.page[data-page-number="${targetPage}"]`
          );
          const marker =
            pageElement &&
            installPublicPdfHighlightOverlay({
              pageElement,
              pageView: viewer.getPageView?.(targetPage - 1),
              quads: pdfAnchor.quads,
              color: pdfHighlightColor,
              classes: {
                layer: styles.pdfHighlightLayer,
                rect: styles.pdfHighlightRect,
              },
            });
          setHighlightUnavailable(marker === null);
          if (marker) focusPublicHighlightTarget(marker);
        };
        eventBus.on("pagesloaded", focusTarget);
        eventBus.on("pagerendered", paintTarget);
        linkService.setDocument(doc, null);
        viewer.setDocument(doc);
      } catch (cause) {
        if (!disposed) {
          console.error("public_share_pdf_load_failed", cause);
          setError(true);
        }
      }
    })();

    return () => {
      disposed = true;
      if (eventBus && focusTarget) eventBus.off("pagesloaded", focusTarget);
      if (eventBus && paintTarget) eventBus.off("pagerendered", paintTarget);
      task?.destroy?.();
      void doc?.destroy?.();
    };
  }, [highlight, token]);

  if (error) {
    return <p className={styles.empty}>PDF unavailable.</p>;
  }
  return (
    <>
      {highlightUnavailable ? <HighlightUnavailable /> : null}
      <div className={styles.pdfFrame}>
        <div ref={containerRef} className={styles.pdfContainer}>
          <div ref={viewerRef} className={`pdfViewer ${styles.pdfViewer}`} />
        </div>
      </div>
    </>
  );
}

function HighlightUnavailable() {
  return (
    <p className={styles.highlightUnavailable} role="status">
      Highlight unavailable.
    </p>
  );
}

function highlightText(
  text: string,
  start: number,
  end: number,
  expectedText: string
): ReactNode | null {
  const codepoints = Array.from(text);
  if (start < 0 || end <= start || end > codepoints.length) return null;
  const selectedText = codepoints.slice(start, end).join("");
  if (!selectedText || selectedText !== expectedText) return null;
  return (
    <>
      {codepoints.slice(0, start).join("")}
      <mark>{selectedText}</mark>
      {codepoints.slice(end).join("")}
    </>
  );
}

function isPageRenderedEvent(event: unknown, targetPage: number): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    "pageNumber" in event &&
    event.pageNumber === targetPage
  );
}

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
