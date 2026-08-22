import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentReaderSession,
  type LoadedReaderDocument,
} from "./DocumentReaderSession";
import { useDocumentReaderSession } from "./useDocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { createHostedReaderProgressPort } from "./ReaderProgressPort";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

type ReaderFormatCase = {
  readonly kind: "web_article" | "epub" | "pdf";
  readonly expectedDocument: string;
  readonly expectedRestore: string;
};

const FORMAT_CASES: readonly ReaderFormatCase[] = [
  {
    kind: "web_article",
    expectedDocument: "WebArticle:Restored paragraph",
    expectedRestore: "web:fragment-2",
  },
  {
    kind: "epub",
    expectedDocument: "Epub:Chapter two",
    expectedRestore: "epub:chapter-2",
  },
  {
    kind: "pdf",
    expectedDocument: "Pdf:https://files.example.test/document.pdf",
    expectedRestore: "pdf:7",
  },
];

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function upstreamFailure(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "E_UPSTREAM", message: "Synthetic upstream failure" },
    }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}

let hostedRequestCounts = new Map<string, number>();
let hostedReaderStateRevision = 2;

function locatorFor(candidate: ReaderFormatCase): Record<string, unknown> {
  if (candidate.kind === "pdf") {
    return {
      kind: "pdf",
      page: 7,
      page_progression: 0.25,
      zoom: null,
      position: 7,
    };
  }
  const locations = {
    text_offset: 0,
    progression: 0,
    total_progression: 0,
    position: 1,
  };
  const text = { quote: null, quote_prefix: null, quote_suffix: null };
  return candidate.kind === "epub"
    ? {
        kind: "epub",
        target: {
          section_id: "chapter-2",
          href_path: "chapter-2.xhtml",
          anchor_id: null,
        },
        locations,
        text,
      }
    : {
        kind: "web",
        target: { fragment_id: "fragment-2" },
        locations,
        text,
      };
}

interface HostedReaderFaults {
  /** Remaining GET /reader-state responses to fail with a retryable 502. */
  readerStateFailures: number;
  /** Serve a malformed (same-system defect) reader-state payload. */
  malformedReaderState: boolean;
}

function installHostedReader(
  candidate: ReaderFormatCase,
  options: {
    readonly emptyProgress?: boolean;
    readonly readerStateFailures?: number;
    readonly malformedReaderState?: boolean;
  } = {},
): HostedReaderFaults {
  hostedRequestCounts = new Map();
  hostedReaderStateRevision = 2;
  const faults: HostedReaderFaults = {
    readerStateFailures: options.readerStateFailures ?? 0,
    malformedReaderState: options.malformedReaderState ?? false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      hostedRequestCounts.set(
        `${method} ${url.pathname}`,
        (hostedRequestCounts.get(`${method} ${url.pathname}`) ?? 0) + 1,
      );
      if (url.pathname === `/api/media/${MEDIA_ID}`) {
        return json({
          id: MEDIA_ID,
          title: "Reader proof",
          kind: candidate.kind,
        });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/reader-state`) {
        if (method === "GET" && faults.malformedReaderState) {
          return json({ state: "Unmodeled" });
        }
        if (method === "GET" && faults.readerStateFailures > 0) {
          faults.readerStateFailures -= 1;
          return upstreamFailure();
        }
        if (method === "GET" && options.emptyProgress === true) {
          return json({ state: "Empty", revision: 0 });
        }
        if (method === "GET") {
          hostedReaderStateRevision += 1;
        }
        return json({
          state: "Positioned",
          revision: method === "PUT" ? 4 : hostedReaderStateRevision,
          locator: locatorFor(candidate),
        });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/fragments`) {
        return json([
          {
            id: "fragment-1",
            media_id: MEDIA_ID,
            idx: 0,
            html_sanitized: "<p>Opening paragraph</p>",
            canonical_text: "Opening paragraph",
            document_embeds: [],
            created_at: "2026-08-01T12:00:00.000Z",
          },
          {
            id: "fragment-2",
            media_id: MEDIA_ID,
            idx: 1,
            html_sanitized: "<p>Restored paragraph</p>",
            canonical_text: "Restored paragraph",
            document_embeds: [],
            created_at: "2026-08-01T12:00:00.000Z",
          },
        ]);
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/navigation`) {
        return json({
          media_id: MEDIA_ID,
          kind: candidate.kind === "web_article" ? "web_article" : "epub",
          fragments: [
            {
              fragment_id: "fragment-1",
              fragment_idx: 0,
              char_count: 11,
            },
            {
              fragment_id: "fragment-2",
              fragment_idx: 1,
              char_count: 11,
            },
          ],
          sections: [
            {
              section_id: "chapter-1",
              label: "Chapter one",
              ordinal: 0,
              fragment_id: "fragment-1",
              fragment_idx: 0,
              level: 1,
              depth: 0,
              start_offset: 0,
              end_offset: 11,
              href_path: "chapter-1.xhtml",
              href_fragment: null,
              anchor_id: null,
            },
            {
              section_id: "chapter-2",
              label: "Chapter two",
              ordinal: 1,
              fragment_id: "fragment-2",
              fragment_idx: 1,
              level: 1,
              depth: 0,
              start_offset: 0,
              end_offset: 11,
              href_path: "chapter-2.xhtml",
              href_fragment: null,
              anchor_id: null,
            },
          ],
          toc_nodes: [],
          landmarks: [],
          page_list: [],
        });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/sections/chapter-2`) {
        return json({
          section_id: "chapter-2",
          label: "Chapter two",
          fragment_id: "fragment-2",
          fragment_idx: 1,
          href_path: "chapter-2.xhtml",
          anchor_id: null,
          source_node_id: null,
          source: "spine",
          ordinal: 1,
          prev_section_id: "chapter-1",
          next_section_id: null,
          html_sanitized: "<p>Chapter two</p>",
          canonical_text: "Chapter two",
          char_count: 11,
          word_count: 2,
          document_word_start: 0,
          created_at: "2026-08-01T12:00:00.000Z",
        });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/sections/chapter-1`) {
        return json({
          section_id: "chapter-1",
          label: "Chapter one",
          fragment_id: "fragment-1",
          fragment_idx: 0,
          href_path: "chapter-1.xhtml",
          anchor_id: null,
          source_node_id: null,
          source: "spine",
          ordinal: 0,
          prev_section_id: null,
          next_section_id: "chapter-2",
          html_sanitized: "<p>Chapter one</p>",
          canonical_text: "Chapter one",
          char_count: 11,
          word_count: 2,
          document_word_start: 0,
          created_at: "2026-08-01T12:00:00.000Z",
        });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/file`) {
        return json({
          url: "https://files.example.test/document.pdf",
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected hosted reader request: ${url.pathname}`);
    }),
  );
  return faults;
}

function describeDocument(document: LoadedReaderDocument): string {
  switch (document.kind) {
    case "WebArticle":
      return `${document.kind}:${document.activeFragment.canonical_text}`;
    case "Epub":
      return `${document.kind}:${document.section.canonical_text}`;
    case "Pdf":
      return `${document.kind}:${document.document.url}`;
  }
}

function describeRestore(
  document: LoadedReaderDocument,
  locator: unknown,
): string {
  if (!locator || typeof locator !== "object" || !("kind" in locator)) {
    return "none";
  }
  if (locator.kind === "pdf" && "page" in locator) {
    return `${locator.kind}:${String(locator.page)}`;
  }
  if (locator.kind === "epub" && "target" in locator) {
    const target = locator.target as { section_id?: unknown };
    return `${locator.kind}:${String(target.section_id)}`;
  }
  if (locator.kind === "web" && "target" in locator) {
    const target = locator.target as { fragment_id?: unknown };
    return `${locator.kind}:${String(target.fragment_id)}`;
  }
  return "none";
}

function SessionHarness() {
  const session = useMemo(
    () =>
      createDocumentReaderSession({
        mediaId: MEDIA_ID,
        source: createHostedReaderSource(),
        progress: createHostedReaderProgressPort(),
      }),
    [],
  );
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof session.load>
  > | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void session.load(controller.signal).then(setResult);
    return () => controller.abort();
  }, [session]);

  if (result === null) return <p>Loading reader</p>;
  if (result.progress.kind !== "Canonical") {
    throw new Error("Hosted reader returned non-canonical progress");
  }
  const snapshot = result.progress.snapshot;
  return (
    <main>
      <p>{describeDocument(result.document)}</p>
      <p>
        {describeRestore(
          result.document,
          snapshot.state === "Positioned" ? snapshot.locator : null,
        )}
      </p>
      <button
        type="button"
        onClick={() => {
          if (snapshot.state !== "Positioned") return;
          void session.progress
            .save(MEDIA_ID, snapshot.locator)
            .then((saved) => {
              if (saved.kind === "Canonical") {
                setSavedRevision(saved.snapshot.revision);
              }
            });
        }}
      >
        Save position
      </button>
      <p>
        {savedRevision === null
          ? "Not saved"
          : `Saved revision ${savedRevision}`}
      </p>
    </main>
  );
}

function ProductionCompositionHarness({
  candidate,
  initialEpubSectionId = null,
}: {
  candidate: ReaderFormatCase;
  initialEpubSectionId?: string | null;
}) {
  const [readyTextPublications, setReadyTextPublications] = useState(0);
  const [readable, setReadable] = useState(true);
  const session = useMemo(
    () =>
      createDocumentReaderSession({
        mediaId: MEDIA_ID,
        source: createHostedReaderSource(),
        progress: createHostedReaderProgressPort(),
      }),
    [],
  );
  const composition = useDocumentReaderSession({
    session,
    progress: {
      capability: readable
        ? {
            state: "Readable",
            mediaId: MEDIA_ID,
            locatorKind:
              candidate.kind === "pdf"
                ? "pdf"
                : candidate.kind === "epub"
                  ? "epub"
                  : "web",
          }
        : { state: "Unavailable" },
      isPaneActive: true,
      handleUnauthenticatedError: () => false,
      captureCurrentLocator: () => null,
      applyCursor: async () => "applied",
      onTerminalWriteAcknowledged: () => undefined,
      previewLease: { isActive: () => false },
    },
    navigation: {
      cacheKey:
        candidate.kind === "pdf" ? null : `navigation:${candidate.kind}`,
      expectedKind: candidate.kind === "pdf" ? null : candidate.kind,
    },
    loadCacheKey: readable ? `session:${candidate.kind}` : null,
    initialEpubSectionId,
    pdf: {
      sourceCacheKey: `pdf-source:${candidate.kind}`,
      sourceRefreshToken: 0,
    },
  });
  useEffect(() => {
    if (composition.textDocument.status === "ready") {
      setReadyTextPublications((count) => count + 1);
    }
  }, [composition.textDocument]);

  return (
    <main>
      <p>progress:{composition.progress.status}</p>
      <p>navigation:{composition.navigation.status}</p>
      <p>text:{composition.textDocument.status}</p>
      <p>pdf-document:{composition.pdfDocument.status}</p>
      <p>ready-text-publications:{readyTextPublications}</p>
      <p>
        revision:
        {composition.progress.initialSnapshot?.revision ?? "none"}
      </p>
      <button type="button" onClick={composition.progress.retryLoad}>
        Retry reader load
      </button>
      <button type="button" onClick={() => setReadable((value) => !value)}>
        Toggle capability
      </button>
    </main>
  );
}

class DefectBoundary extends Component<
  { children: ReactNode },
  { defect: boolean }
> {
  state = { defect: false };

  static getDerivedStateFromError(): { defect: boolean } {
    return { defect: true };
  }

  render() {
    return this.state.defect ? <p>reader-defect-boundary</p> : this.props.children;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("hosted DocumentReaderSession format and restore parity", () => {
  for (const candidate of FORMAT_CASES) {
    it(`loads ${candidate.kind} content and its canonical restore locator`, async () => {
      installHostedReader(candidate);
      render(<SessionHarness />);

      expect(await screen.findByText(candidate.expectedDocument)).toBeVisible();
      expect(screen.getByText(candidate.expectedRestore)).toBeVisible();
      await userEvent.click(
        screen.getByRole("button", { name: "Save position" }),
      );
      expect(await screen.findByText("Saved revision 4")).toBeVisible();
    });
  }

  it("loads an explicit cold EPUB target once when canonical progress is empty", async () => {
    const candidate = FORMAT_CASES[1];
    if (candidate === undefined) throw new Error("EPUB proof case is absent");
    installHostedReader(candidate, { emptyProgress: true });
    render(
      <ProductionCompositionHarness
        candidate={candidate}
        initialEpubSectionId="chapter-2"
      />,
    );

    expect(await screen.findByText("progress:ready")).toBeVisible();
    expect(await screen.findByText("navigation:ready")).toBeVisible();
    expect(
      hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/sections/chapter-1`) ?? 0,
    ).toBe(0);
    expect(
      hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/sections/chapter-2`) ?? 0,
    ).toBe(1);
  });

  for (const candidate of FORMAT_CASES) {
    it(`production composition owns initial ${candidate.kind} progress and source wiring`, async () => {
      installHostedReader(candidate);
      render(<ProductionCompositionHarness candidate={candidate} />);

      expect(await screen.findByText("progress:ready")).toBeVisible();
      if (candidate.kind === "pdf") {
        expect(screen.getByText("navigation:idle")).toBeVisible();
        expect(screen.getByText("text:idle")).toBeVisible();
        expect(await screen.findByText("pdf-document:ready")).toBeVisible();
      } else {
        expect(await screen.findByText("navigation:ready")).toBeVisible();
        expect(
          screen.getByText(
            candidate.kind === "web_article" ? "text:ready" : "text:idle",
          ),
        ).toBeVisible();
        expect(screen.getByText("pdf-document:idle")).toBeVisible();
        if (candidate.kind === "web_article") {
          expect(
            await screen.findByText("ready-text-publications:1"),
          ).toBeVisible();
        }
      }
      expect(
        hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}`),
      ).toBe(1);
      expect(
        hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-state`),
      ).toBe(1);
      expect(
        hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/navigation`) ?? 0,
      ).toBe(candidate.kind === "pdf" ? 0 : 1);
      expect(
        hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/fragments`) ?? 0,
      ).toBe(candidate.kind === "web_article" ? 1 : 0);
      expect(
        hostedRequestCounts.get(
          `GET /api/media/${MEDIA_ID}/sections/chapter-2`,
        ) ?? 0,
      ).toBe(candidate.kind === "epub" ? 1 : 0);
      expect(
        hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/file`) ?? 0,
      ).toBe(candidate.kind === "pdf" ? 1 : 0);
    });
  }

  it("recovers progress and content together when the composed load succeeds on a retryable attempt", async () => {
    const candidate = FORMAT_CASES[0];
    if (candidate === undefined) throw new Error("web proof case is absent");
    installHostedReader(candidate, { readerStateFailures: 1 });
    render(<ProductionCompositionHarness candidate={candidate} />);

    // The first reader-state read fails with a retryable upstream error; the
    // composed load retries transparently and BOTH channels settle ready —
    // the progress screen must never latch load_failed over healthy content.
    expect(
      await screen.findByText("progress:ready", undefined, { timeout: 4_000 }),
    ).toBeVisible();
    expect(await screen.findByText("text:ready")).toBeVisible();
    expect(
      hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-state`),
    ).toBe(2);
  });

  it("retries the composed load as one identity from the progress retry action", async () => {
    const candidate = FORMAT_CASES[0];
    if (candidate === undefined) throw new Error("web proof case is absent");
    const faults = installHostedReader(candidate, {
      readerStateFailures: Number.MAX_SAFE_INTEGER,
    });
    render(<ProductionCompositionHarness candidate={candidate} />);

    expect(
      await screen.findByText("progress:load_failed", undefined, {
        timeout: 8_000,
      }),
    ).toBeVisible();
    // The document channel failed with it — one failure identity.
    expect(await screen.findByText("text:error")).toBeVisible();
    expect(await screen.findByText("navigation:error")).toBeVisible();

    faults.readerStateFailures = 0;
    await userEvent.click(
      screen.getByRole("button", { name: "Retry reader load" }),
    );

    // One retry recovers BOTH channels: the session transaction re-runs.
    expect(
      await screen.findByText("progress:ready", undefined, { timeout: 4_000 }),
    ).toBeVisible();
    expect(await screen.findByText("text:ready")).toBeVisible();
    expect(await screen.findByText("navigation:ready")).toBeVisible();
  }, 20_000);

  it("re-reads canonical progress when the same capability is re-established", async () => {
    const candidate = FORMAT_CASES[0];
    if (candidate === undefined) throw new Error("web proof case is absent");
    installHostedReader(candidate);
    render(<ProductionCompositionHarness candidate={candidate} />);

    expect(await screen.findByText("progress:ready")).toBeVisible();
    expect(
      hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-state`),
    ).toBe(1);

    expect(screen.getByText("revision:3")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Toggle capability" }),
    );
    expect(await screen.findByText("progress:loading")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Toggle capability" }),
    );

    // Re-establishment must re-read canonical state (a fresh CAS base), not
    // adopt the memoized composed snapshot: the server has moved past
    // revision 3, and the re-established authority must reflect that.
    expect(
      await screen.findByText("progress:ready", undefined, { timeout: 4_000 }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("revision:3")).not.toBeInTheDocument(),
    );
    expect(
      hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-state`) ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("routes a malformed same-system reader payload to the render defect boundary", async () => {
    const candidate = FORMAT_CASES[0];
    if (candidate === undefined) throw new Error("web proof case is absent");
    installHostedReader(candidate, { malformedReaderState: true });
    render(
      <DefectBoundary>
        <ProductionCompositionHarness candidate={candidate} />
      </DefectBoundary>,
    );

    // A same-system contract violation is a defect thrown during render, not
    // a retriable error state or a silent progress failure.
    expect(
      await screen.findByText("reader-defect-boundary", undefined, {
        timeout: 4_000,
      }),
    ).toBeVisible();
  });

  it("reuses the composed EPUB section once, then honors explicit source invalidation", async () => {
    const candidate = FORMAT_CASES[1];
    if (candidate === undefined) throw new Error("EPUB proof case is absent");
    installHostedReader(candidate);
    const session = createDocumentReaderSession({
      mediaId: MEDIA_ID,
      source: createHostedReaderSource(),
      progress: createHostedReaderProgressPort(),
    });
    const signal = new AbortController().signal;

    await session.load(signal);
    await session.loadEpubSection("chapter-2", signal);
    expect(
      hostedRequestCounts.get(
        `GET /api/media/${MEDIA_ID}/sections/chapter-2`,
      ),
    ).toBe(1);

    await session.loadNavigation(signal);
    await session.loadEpubSection("chapter-2", signal);
    expect(
      hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/navigation`),
    ).toBe(2);
    expect(
      hostedRequestCounts.get(
        `GET /api/media/${MEDIA_ID}/sections/chapter-2`,
      ),
    ).toBe(2);
  });

  it("never serves the pre-invalidation composed section after explicit source invalidation", async () => {
    const candidate = FORMAT_CASES[1];
    if (candidate === undefined) throw new Error("EPUB proof case is absent");
    installHostedReader(candidate);
    const session = createDocumentReaderSession({
      mediaId: MEDIA_ID,
      source: createHostedReaderSource(),
      progress: createHostedReaderProgressPort(),
    });
    const signal = new AbortController().signal;

    // The composed load fetches chapter-2 (restore target) once and keeps a
    // one-shot grant for it; the reader's first request is for a DIFFERENT
    // section, so the grant stays unused.
    await session.load(signal);
    expect(
      hostedRequestCounts.get(
        `GET /api/media/${MEDIA_ID}/sections/chapter-2`,
      ) ?? 0,
    ).toBe(1);
    await session.loadEpubSection("chapter-1", signal);

    // Explicit source invalidation, then a request for the composed section:
    // the session must fetch replaced content, never the pre-invalidation
    // cached payload the unused grant still holds.
    await session.loadNavigation(signal);
    await session.loadEpubSection("chapter-2", signal);
    expect(
      hostedRequestCounts.get(
        `GET /api/media/${MEDIA_ID}/sections/chapter-2`,
      ) ?? 0,
    ).toBe(2);
  });

  it("reuses the composed PDF access grant once, then refreshes it explicitly", async () => {
    const candidate = FORMAT_CASES[2];
    if (candidate === undefined) throw new Error("PDF proof case is absent");
    installHostedReader(candidate);
    const session = createDocumentReaderSession({
      mediaId: MEDIA_ID,
      source: createHostedReaderSource(),
      progress: createHostedReaderProgressPort(),
    });
    const signal = new AbortController().signal;

    await session.load(signal);
    await session.openPdf(signal);
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/file`)).toBe(1);

    await session.openPdf(signal);
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/file`)).toBe(2);
  });
});
