import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import PdfReader, { type PdfHighlightOut } from "./PdfReader";

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
  let servedInitialHighlights = false;

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();

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
        if (!servedInitialHighlights) {
          servedInitialHighlights = true;
          return json({ page_number: 1, highlights: [] });
        }
        reconciliationStarted.resolve();
        return reconciliation.promise;
      }
      if (
        url.pathname === `/api/media/${MEDIA_ID}/pdf-highlights` &&
        method === "POST"
      ) {
        return json(committedHighlight());
      }
      throw new Error(
        `Unexpected PDF BFF request: ${method} ${url.pathname}${url.search}`,
      );
    },
  );

  return {
    reconciliationStarted: reconciliationStarted.promise,
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

it("keeps a committed PDF highlight visible while BFF reconciliation is pending", async () => {
  const pdfUrl = URL.createObjectURL(onePagePdf(`Alpha ${EXACT} Omega`));
  const bff = installPdfBff(pdfUrl);

  try {
    render(
      <MobileViewportProvider>
        <MobileChromeProvider>
          <ShareControllerProvider>
            <PdfReader mediaId={MEDIA_ID} mobileChromeEnabled={false} />
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

    await userEvent.click(
      await screen.findByRole("button", { name: "Colour" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Green" }),
    );
    await bff.reconciliationStarted;

    const committedOverlay = screen.queryByTestId(
      "pdf-highlight-committed-highlight-0",
    );
    expect(
      committedOverlay,
      "Committed PDF highlight disappeared before BFF reconciliation completed.",
    ).not.toBeNull();
    expect(committedOverlay!).toBeVisible();
  } finally {
    bff.finishReconciliation();
    URL.revokeObjectURL(pdfUrl);
  }
});
