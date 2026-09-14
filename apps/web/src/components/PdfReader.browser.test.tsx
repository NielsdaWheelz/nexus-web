import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
  useMobileChromeVisibleLocks,
} from "@/lib/workspace/mobileChrome";
import { createHostedPdfReaderDecorations } from "@/app/(authenticated)/media/[id]/hostedPdfReaderDecorations";
import { useHostedPdfPageHighlights } from "@/app/(authenticated)/media/[id]/useHostedPdfPageHighlights";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { createHostedReaderProgressPort } from "@/lib/reader/ReaderProgressPort";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { useDocumentReaderSession } from "@/lib/reader/useDocumentReaderSession";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { PdfHighlightOut } from "@/lib/reader/ReaderDecorations";
import PdfReader, {
  type PdfReaderResourceState,
  type PdfHighlightNavigationRequest,
  type PdfReaderControlActions,
  type PdfReaderVisibleLockReason,
} from "./PdfReader";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const EXACT = "selected quote";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function onePagePdf(text: string): Blob {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n%NEXUS\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = body.length;
  body += "xref\n0 6\n0000000000 65535 f \n";
  body += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Blob([body], { type: "application/pdf" });
}

function committedHighlight(): PdfHighlightOut {
  return {
    id: "committed-highlight",
    anchor: {
      type: "pdf_page_geometry",
      media_id: MEDIA_ID,
      page_number: 1,
      quads: [
        {
          x1: 70,
          y1: 60,
          x2: 230,
          y2: 60,
          x3: 230,
          y3: 80,
          x4: 70,
          y4: 80,
        },
      ],
    },
    color: "green",
    exact: EXACT,
    prefix: "Alpha ",
    suffix: " Omega",
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
    author_user_id: "22222222-2222-4222-8222-222222222222",
    is_owner: true,
  };
}

function installPdfBff(pdfUrl: string, creation?: Promise<Response>) {
  const creationStarted = deferred<void>();
  const reconciliationStarted = deferred<void>();
  const reconciliation = deferred<Response>();
  let highlightMutated = false;
  let highlightWrite: {
    exact: string;
    page_number: number;
    quads: unknown[];
  } | null = null;

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();

      if (url.pathname === `/api/media/${MEDIA_ID}` && method === "GET") {
        return json({ id: MEDIA_ID, title: "PDF proof", kind: "pdf" });
      }
      if (
        url.pathname === `/api/media/${MEDIA_ID}/reader-state` &&
        method === "GET"
      ) {
        return json({ state: "Empty", revision: 0 });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/file` && method === "GET") {
        return json({
          url: pdfUrl,
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      if (
        url.pathname === `/api/media/${MEDIA_ID}/pdf-highlights` &&
        method === "GET"
      ) {
        // Reads before the committed mutation are empty; the read AFTER the
        // mutation is the reconciliation read the proof holds pending.
        if (!highlightMutated) {
          return json({ page_number: 1, highlights: [] });
        }
        reconciliationStarted.resolve();
        return reconciliation.promise;
      }
      if (
        url.pathname === `/api/media/${MEDIA_ID}/pdf-highlights` &&
        method === "POST"
      ) {
        const body = request
          ? await request.clone().json()
          : JSON.parse(String(init?.body));
        highlightWrite = body as typeof highlightWrite;
        creationStarted.resolve();
        const response = await (creation ?? json(committedHighlight()));
        highlightMutated = true;
        return response;
      }
      throw new Error(
        `Unexpected PDF BFF request: ${method} ${url.pathname}${url.search}`,
      );
    },
  );

  return {
    creationStarted: creationStarted.promise,
    reconciliationStarted: reconciliationStarted.promise,
    readHighlightWrite: () => highlightWrite,
    finishReconciliation() {
      reconciliation.resolve(json({ page_number: 1, highlights: [] }));
    },
  };
}

function textNodeContaining(root: HTMLElement, value: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(value)) {
      return node as Text;
    }
  }
  throw new Error(`Rendered PDF text layer omitted ${JSON.stringify(value)}.`);
}

/**
 * Drives PdfReader through the production owners: the composed
 * `useDocumentReaderSession` supplies the signed-URL resource and the hosted
 * `useHostedPdfPageHighlights` hook supplies page highlights behind the same
 * render-readiness gate MediaPaneBody uses (`onResourceStateChange` feedback).
 */
function PdfReaderHarness({
  navigationProof = false,
  onAddNote,
}: {
  navigationProof?: boolean;
  onAddNote?: ComponentProps<typeof PdfReader>["onAddNote"];
}) {
  const [navigation, setNavigation] = useState<PdfHighlightNavigationRequest | null>(null);
  const [arrival, setArrival] = useState("none");
  const [resumeArrival, setResumeArrival] = useState("none");
  const navigationId = useRef(0);
  const controlsRef = useRef<PdfReaderControlActions | null>(null);
  const [highlightRefresh, setHighlightRefresh] = useState(0);
  const [resourceState, setResourceState] = useState<PdfReaderResourceState>({
    pageNumber: 1,
    numPages: 0,
    loading: true,
    error: null,
  });
  const session = useMemo(
    () =>
      createDocumentReaderSession({
        mediaId: MEDIA_ID,
        source: createHostedReaderSource(),
        progress: createHostedReaderProgressPort(),
      }),
    [],
  );
  const decorations = useMemo(
    () => createHostedPdfReaderDecorations(MEDIA_ID),
    [],
  );
  const composition = useDocumentReaderSession({
    session,
    progress: {
      capability: { state: "Readable", mediaId: MEDIA_ID, locatorKind: "pdf" },
      isPaneActive: true,
      handleUnauthenticatedError: () => false,
      captureCurrentLocator: () => null,
      applyCursor: async () => "applied",
      onTerminalWriteAcknowledged: () => undefined,
      previewLease: { isActive: () => false },
    },
    navigation: { cacheKey: null, expectedKind: null },
    loadCacheKey: `${MEDIA_ID}:reader-session`,
    initialEpubTarget: null,
    pdf: {
      sourceCacheKey: `${MEDIA_ID}:pdf-source:0`,
      sourceRefreshToken: 0,
    },
  });
  const pageHighlights = useHostedPdfPageHighlights({
    mediaId: MEDIA_ID,
    enabled: true,
    decorations,
    resourceState,
    refreshToken: highlightRefresh,
  });
  // Same publish guard as MediaPaneBody's handlePdfResourceStateChange: only
  // adopt a genuinely different resource state.
  const handleResourceStateChange = useCallback(
    (nextState: PdfReaderResourceState) => {
      setResourceState((current) =>
        current.pageNumber === nextState.pageNumber &&
        current.numPages === nextState.numPages &&
        current.loading === nextState.loading &&
        current.error === nextState.error
          ? current
          : nextState,
      );
    },
    [],
  );
  const isMobile = useIsMobileViewport();
  const locks = useMobileChromeVisibleLocks();
  const scrollPositioner = useReaderScrollPositioner();
  const additionalViewportRef = useMobileChromeReaderScrollport<HTMLDivElement>(
    {
      sourceKey: MEDIA_ID,
      enabled: false,
    },
  );
  const acquireMobileChromeVisibleLock = useCallback(
    (reason: PdfReaderVisibleLockReason) => locks.acquire(reason),
    [locks],
  );
  // Production (MediaPaneBody) passes identity-stable handlers; an unstable
  // handler would re-run PdfReader's document bootstrap on every host render.
  const handleAuthenticationError = useCallback(() => false, []);
  const requestSignedUrlRefresh = useCallback(() => undefined, []);
  const handleHighlightsMutated = useCallback(
    () => setHighlightRefresh((value) => value + 1),
    [],
  );
  const jump = (top: number) => {
    const requestId = ++navigationId.current;
    setArrival("pending");
    setNavigation({ highlightId: "source", pageNumber: 1, requestId,
      quads: [{ x1: 70, y1: top, x2: 130, y2: top, x3: 130, y3: top + 10, x4: 70, y4: top + 10 }],
      isCurrent: () => requestId === navigationId.current });
  };
  return (
    <>
      {navigationProof ? <>
        <button onClick={() => jump(2_000)}>unreachable source</button>
        <button onClick={() => jump(650)}>lower source</button>
        <button onClick={() => {
          const requestId = ++navigationId.current;
          setNavigation(null);
          setResumeArrival("pending");
          void controlsRef.current!.applyResumeState({ kind: "pdf", page: 1, page_progression: 0, zoom: null, position: 1 }, () => requestId === navigationId.current)
            .then((positioned) => setResumeArrival(positioned ? "visible" : "failed"));
        }}>return to page beginning</button>
        <output aria-label="PDF source arrival">{arrival}</output>
        <output aria-label="PDF resume arrival">{resumeArrival}</output>
      </> : null}
      <div style={{ height: navigationProof ? 320 : 640, width: 800 }}>
    <PdfReader
      mediaId={MEDIA_ID}
      resources={{
        signedUrl: composition.pdfDocument,
        pageHighlights,
        requestSignedUrlRefresh,
      }}
      decorations={decorations}
      onAddNote={onAddNote}
      onHighlightsMutated={handleHighlightsMutated}
      onResourceStateChange={handleResourceStateChange}
      isMobile={isMobile}
      mobileChromeEnabled={false}
      additionalViewportRef={additionalViewportRef}
      acquireMobileChromeVisibleLock={acquireMobileChromeVisibleLock}
      scrollPositioner={scrollPositioner}
      handleAuthenticationError={handleAuthenticationError}
      navigateToHighlight={navigation}
      onHighlightNavigationComplete={(positioned) => { setArrival(positioned ? "visible" : "failed"); setNavigation(null); }}
      onControlsReady={(controls) => { controlsRef.current = controls; }}
    />
      </div>
    </>
  );
}

it("keeps a committed PDF highlight visible while BFF reconciliation is pending", async () => {
  await page.viewport(1_280, 800);
  const pdfUrl = URL.createObjectURL(onePagePdf(`Alpha ${EXACT} Omega`));
  const bff = installPdfBff(pdfUrl);
  let foreignTextLayer: HTMLDivElement | null = null;

  try {
    render(
      <MobileViewportProvider>
        <MobileChromeProvider>
          <ShareControllerProvider>
            <PdfReaderHarness />
          </ShareControllerProvider>
        </MobileChromeProvider>
      </MobileViewportProvider>,
    );

    const textLayer = await screen.findByTestId(
      "pdf-page-text-layer-1",
      {},
      { timeout: 10_000 },
    );
    const textNode = textNodeContaining(textLayer, EXACT);
    const start = textNode.data.indexOf(EXACT);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + EXACT.length);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Chromium did not expose the document Selection.");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    await screen.findByRole("button", {
      name: "Highlight",
    });

    foreignTextLayer = document.createElement("div");
    foreignTextLayer.className = "textLayer";
    foreignTextLayer.textContent = "foreign reader quote";
    document.body.append(foreignTextLayer);
    const foreignRange = document.createRange();
    foreignRange.selectNodeContents(foreignTextLayer);
    selection.removeAllRanges();
    selection.addRange(foreignRange);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Highlight" })).toBeNull();
    });
    expect(selection.toString()).toBe("foreign reader quote");
    foreignTextLayer.remove();
    foreignTextLayer = null;

    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const highlightButton = await screen.findByRole("button", {
      name: "Highlight",
    });
    await page.viewport(1_120, 720);
    expect(highlightButton).toBeVisible();

    await userEvent.click(highlightButton);
    await userEvent.click(await screen.findByRole("button", { name: "Green" }));
    await bff.reconciliationStarted;

    const highlightWrite = bff.readHighlightWrite();
    expect(highlightWrite).not.toBeNull();
    expect(highlightWrite?.exact).toBe(EXACT);
    expect(highlightWrite?.page_number).toBe(1);
    expect(highlightWrite?.quads.length).toBeGreaterThan(0);

    const committedOverlay = screen.queryByTestId(
      "pdf-highlight-committed-highlight-0",
    );
    expect(
      committedOverlay,
      "Committed PDF highlight disappeared before BFF reconciliation completed.",
    ).not.toBeNull();
    expect(committedOverlay!).toBeVisible();
  } finally {
    foreignTextLayer?.remove();
    bff.finishReconciliation();
    URL.revokeObjectURL(pdfUrl);
  }
});


it("acknowledges PDF navigation only after the source geometry is visible and returns to its exact page locus", async () => {
  await page.viewport(1_280, 800);
  const pdfUrl = URL.createObjectURL(onePagePdf("A known 612 by 792 point source page"));
  const bff = installPdfBff(pdfUrl);
  try {
    render(<MobileViewportProvider><MobileChromeProvider><ShareControllerProvider>
      <PdfReaderHarness navigationProof />
    </ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>);
    await screen.findByTestId("pdf-page-text-layer-1", {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "unreachable source" }));
    await waitFor(() => expect(screen.getByLabelText("PDF source arrival")).toHaveTextContent("failed"));
    fireEvent.click(screen.getByRole("button", { name: "lower source" }));
    await waitFor(() => expect(screen.getByLabelText("PDF source arrival")).toHaveTextContent("visible"));
    const viewport = screen.getByRole("region", { name: "PDF document" }).getBoundingClientRect();
    const canvas = screen.getByTestId("pdf-page-canvas-1").getBoundingClientRect();
    const sourceCenter = canvas.top + canvas.height * 655 / 792;
    expect(sourceCenter).toBeGreaterThanOrEqual(viewport.top);
    expect(sourceCenter).toBeLessThanOrEqual(viewport.bottom);
    const beforeDecoration = screen.getByRole("region", { name: "PDF document" }).scrollTop;
    act(() => dispatchReaderPulse({
      mediaId: MEDIA_ID,
      locator: { ...committedHighlight().anchor, exact: EXACT },
      snippet: null,
      highlightBehavior: "pulse",
      focusBehavior: "preserve_position",
    }));
    await screen.findByTestId("pdf-highlight-reader-pulse-1-0");
    expect(screen.getByRole("region", { name: "PDF document" }).scrollTop).toBe(beforeDecoration);
    fireEvent.click(screen.getByRole("button", { name: "return to page beginning" }));
    await waitFor(() => expect(screen.getByLabelText("PDF resume arrival")).toHaveTextContent("visible"));
    const pageBeginning = screen.getByTestId("pdf-page-canvas-1").getBoundingClientRect().top;
    expect(pageBeginning).toBeGreaterThanOrEqual(viewport.top - 1);
    expect(pageBeginning).toBeLessThan(viewport.bottom);
  } finally {
    bff.finishReconciliation();
    URL.revokeObjectURL(pdfUrl);
  }
});

it("preserves the annotation caret when pending PDF highlight creation completes", async () => {
  await page.viewport(1_280, 800);
  const pdfUrl = URL.createObjectURL(onePagePdf(`Alpha ${EXACT} Omega`));
  const response = deferred<Response>();
  const bff = installPdfBff(pdfUrl, response.promise);
  let creation: Promise<{ id: string } | null> | null = null;

  try {
    render(
      <MobileViewportProvider>
        <MobileChromeProvider>
          <ShareControllerProvider>
            <PdfReaderHarness
              onAddNote={(session) => { creation = session.creation; }}
            />
            <div
              role="textbox"
              aria-label="Highlight note"
              contentEditable
              suppressContentEditableWarning
            >
              annotation draft
            </div>
          </ShareControllerProvider>
        </MobileChromeProvider>
      </MobileViewportProvider>,
    );
    const textLayer = await screen.findByTestId(
      "pdf-page-text-layer-1",
      {},
      { timeout: 10_000 },
    );
    const textNode = textNodeContaining(textLayer, EXACT);
    const start = textNode.data.indexOf(EXACT);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + EXACT.length);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Chromium did not expose the document Selection.");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Note" }));
    await bff.creationStarted;

    const annotation = screen.getByRole("textbox", { name: "Highlight note" });
    annotation.focus();
    const caret = document.createRange();
    caret.selectNodeContents(annotation);
    caret.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caret);

    expect(
      creation,
      "the PDF note action did not publish its pending highlight",
    ).not.toBeNull();
    response.resolve(json(committedHighlight()));
    await creation;
    expect(annotation).toHaveFocus();
    expect(
      selection.rangeCount,
      "completing the PDF highlight erased the annotation's live caret",
    ).toBe(1);
    expect(
      annotation.contains(selection.getRangeAt(0).commonAncestorContainer),
    ).toBe(true);
    await userEvent.keyboard(" survives");
    expect(annotation).toHaveTextContent("annotation draft survives");
  } finally {
    response.resolve(json(committedHighlight()));
    bff.finishReconciliation();
    URL.revokeObjectURL(pdfUrl);
  }
});
