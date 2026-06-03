import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOraclePlateImageSrc } from "@/lib/media/oraclePlateImage";
import OracleConcordance from "../OracleConcordance";
import OracleReadingPaneBody, { type ReadingDetail } from "./OracleReadingPaneBody";

const streamMocks = vi.hoisted(() => ({
  fetchStreamToken: vi.fn(),
  sseClientDirect: vi.fn(() => vi.fn()),
}));

vi.mock("next/navigation", () => ({
  __esModule: true,
  default: {},
  usePathname: () => "/oracle/reading-1",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@/lib/api/streamToken", () => ({
  fetchStreamToken: streamMocks.fetchStreamToken,
}));

vi.mock("@/lib/api/sse-client", () => ({
  sseClientDirect: streamMocks.sseClientDirect,
}));

describe("OracleReadingPaneBody", () => {
  beforeEach(() => {
    streamMocks.fetchStreamToken.mockReset();
    streamMocks.fetchStreamToken.mockResolvedValue({
      token: "stream-token-1",
      stream_base_url: "https://stream.example.test",
    });
    streamMocks.sseClientDirect.mockReset();
    streamMocks.sseClientDirect.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears stale reading state when the reading id changes", async () => {
    const secondDetail = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings/reading-1") {
          return jsonResponse({
            data: readingDetail({
              id: "reading-1",
              question: "What keeps the first lamp lit?",
              folioNumber: 1,
            }),
          });
        }
        if (path === "/api/oracle/readings/reading-2") {
          return secondDetail.promise;
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const { rerender } = render(<OracleReadingPaneBody readingId="reading-1" />);

    expect(await screen.findByRole("heading", { name: "What keeps the first lamp lit?" }))
      .toBeVisible();

    rerender(<OracleReadingPaneBody readingId="reading-2" />);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "What keeps the first lamp lit?" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "…" })).toBeVisible();

    secondDetail.resolve(
      jsonResponse({
        data: readingDetail({
          id: "reading-2",
          question: "Where does the second path open?",
          folioNumber: 2,
        }),
      }),
    );

    expect(await screen.findByRole("heading", { name: "Where does the second path open?" }))
      .toBeVisible();
  });

  it("streams pending readings through the shared SSE client", async () => {
    render(
      <OracleReadingPaneBody
        readingId="reading-1"
        initialDetail={readingDetail({
          id: "reading-1",
          question: "What is still forming?",
          folioNumber: 1,
          status: "streaming",
        })}
      />,
    );

    await waitFor(() => {
      expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1);
    });
    const sseCalls = streamMocks.sseClientDirect.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(sseCalls[0]?.[0]).toMatchObject({
      url: "https://stream.example.test/stream/oracle-readings/reading-1/events",
      lastEventId: undefined,
      maxReconnects: 3,
    });
  });

  it("does not start a stream for a reading load that became stale", async () => {
    const firstDetail = deferred<Response>();
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/oracle/readings/reading-1") {
        return firstDetail.promise;
      }
      if (path === "/api/oracle/readings/reading-2") {
        return jsonResponse({
          data: readingDetail({
            id: "reading-2",
            question: "Where does the second path open?",
            folioNumber: 2,
          }),
        });
      }
      throw new Error(`Unexpected fetch path: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<OracleReadingPaneBody readingId="reading-1" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/oracle/readings/reading-1",
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
          method: "GET",
          signal: expect.any(AbortSignal),
        }),
      );
    });

    rerender(<OracleReadingPaneBody readingId="reading-2" />);
    firstDetail.resolve(
      jsonResponse({
        data: readingDetail({
          id: "reading-1",
          question: "What keeps the first lamp lit?",
          folioNumber: 1,
          status: "streaming",
        }),
      }),
    );

    expect(await screen.findByRole("heading", { name: "Where does the second path open?" }))
      .toBeVisible();
    await waitFor(() => {
      expect(streamMocks.fetchStreamToken).not.toHaveBeenCalled();
      expect(streamMocks.sseClientDirect).not.toHaveBeenCalled();
    });
  });

  it("renders the owned plate URL from the backend", async () => {
    const plateUrl = buildOraclePlateImageSrc("123e4567-e89b-12d3-a456-426614174000");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings/reading-1") {
          return jsonResponse({
            data: readingDetail({
              id: "reading-1",
              question: "What keeps the lamp lit?",
              folioNumber: 1,
              image: {
                url: plateUrl,
                attribution_text: "Test Engraver, The Test Plate.",
                artist: "Test Engraver",
                work_title: "The Test Plate",
                year: "1860",
                width: 800,
                height: 1200,
              },
            }),
          });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(<OracleReadingPaneBody readingId="reading-1" />);

    const plate = await screen.findByRole("img", {
      name: "Test Engraver, The Test Plate",
    });
    expect(plate).toHaveAttribute("src", plateUrl);
  });

  it("renders failed readings through feedback-safe copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings/reading-1") {
          return jsonResponse({
            data: readingDetail({
              id: "reading-1",
              question: "What did the provider say?",
              folioNumber: 1,
              status: "failed",
              errorCode: "E_LLM_BAD_REQUEST",
              errorMessage: "raw provider invalid_request_error detail",
            }),
          });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(<OracleReadingPaneBody readingId="reading-1" />);

    expect(await screen.findByText("The reading could not finish.")).toBeVisible();
    expect(
      screen.getByText(
        "The reading could not be completed. Start a new reading with a simpler question.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("raw provider invalid_request_error detail")).not.toBeInTheDocument();
  });

  it("clears concordance immediately when the reading status is no longer complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings/reading-1/concordance") {
          return jsonResponse({
            data: [concordanceEntry({ id: "reading-2", motto: "In limine" })],
          });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const { rerender } = render(
      <OracleConcordance readingId="reading-1" status="complete" />,
    );

    expect(await screen.findByText("Concordance")).toBeInTheDocument();
    expect(screen.getByText("In limine")).toBeInTheDocument();

    rerender(<OracleConcordance readingId="reading-1" status="streaming" />);

    expect(screen.queryByText("Concordance")).not.toBeInTheDocument();
    expect(screen.queryByText("In limine")).not.toBeInTheDocument();
  });

  it("aborts stale concordance loads when the reading id changes", async () => {
    const firstConcordance = deferred<Response>();
    const secondConcordance = deferred<Response>();
    const signals: Record<string, AbortSignal> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/oracle/readings/reading-1/concordance") {
          signals.reading1 = init?.signal as AbortSignal;
          return firstConcordance.promise;
        }
        if (path === "/api/oracle/readings/reading-2/concordance") {
          signals.reading2 = init?.signal as AbortSignal;
          return secondConcordance.promise;
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const { rerender } = render(
      <OracleConcordance readingId="reading-1" status="complete" />,
    );

    await waitFor(() => {
      expect(signals.reading1).toBeDefined();
    });

    rerender(<OracleConcordance readingId="reading-2" status="complete" />);

    await waitFor(() => {
      expect(signals.reading2).toBeDefined();
    });
    expect(signals.reading1.aborted).toBe(true);

    firstConcordance.resolve(
      jsonResponse({
        data: [concordanceEntry({ id: "reading-stale", motto: "Stale motto" })],
      }),
    );
    secondConcordance.resolve(
      jsonResponse({
        data: [concordanceEntry({ id: "reading-fresh", motto: "Fresh motto" })],
      }),
    );

    expect(await screen.findByText("Fresh motto")).toBeInTheDocument();
    expect(screen.queryByText("Stale motto")).not.toBeInTheDocument();
  });
});

function readingDetail(input: {
  id: string;
  question: string;
  folioNumber: number;
  image?: ReadingDetail["image"];
  status?: ReadingDetail["status"];
  errorCode?: string | null;
  errorMessage?: string | null;
}): ReadingDetail {
  return {
    id: input.id,
    folio_number: input.folioNumber,
    folio_motto: "Audentes Fortuna Iuvat",
    folio_motto_gloss: "Fortune favors the bold.",
    folio_theme: "Of Courage",
    argument_text: "Of a path through shadow.",
    question_text: input.question,
    status: input.status ?? "complete",
    image: input.image ?? null,
    passages: [],
    events: [],
    created_at: "2026-05-01T12:00:00Z",
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function concordanceEntry(input: { id: string; motto: string }) {
  return {
    id: input.id,
    folio_number: 2,
    folio_motto: input.motto,
    folio_theme: "Threshold",
    shared_plate: false,
    shared_theme: true,
    shared_passage_count: 0,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
