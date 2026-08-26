import { useCallback, useMemo, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { PdfHighlightOut } from "@/lib/reader/ReaderDecorations";
import PdfReader, {
  type PdfReaderResourceState,
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

function installPdfBff(pdfUrl: string) {
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
        highlightMutated = true;
        return json(committedHighlight());
      }
      throw new Error(
        `Unexpected PDF BFF request: ${method} ${url.pathname}${url.search}`,
      );
    },
  );

  return {
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
function PdfReaderHarness() {
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
    initialEpubSectionId: null,
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
  return (
    <PdfReader
      mediaId={MEDIA_ID}
      resources={{
        signedUrl: composition.pdfDocument,
        pageHighlights,
        requestSignedUrlRefresh,
      }}
      decorations={decorations}
      onHighlightsMutated={handleHighlightsMutated}
      onResourceStateChange={handleResourceStateChange}
      isMobile={isMobile}
      mobileChromeEnabled={false}
      additionalViewportRef={additionalViewportRef}
      acquireMobileChromeVisibleLock={acquireMobileChromeVisibleLock}
      scrollPositioner={scrollPositioner}
      handleAuthenticationError={handleAuthenticationError}
    />
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
