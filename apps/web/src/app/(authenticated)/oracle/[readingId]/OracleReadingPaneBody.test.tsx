import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OracleReadingPaneBody, { type ReadingDetail } from "./OracleReadingPaneBody";

describe("OracleReadingPaneBody", () => {
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

  it("uses the backend-provided proxied plate URL without double wrapping it", async () => {
    const proxiedUrl =
      "/api/media/image?url=https%3A%2F%2Fimages.example.com%2Foracle-plate.jpg";
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
                source_url: proxiedUrl,
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
    expect(plate).toHaveAttribute("src", proxiedUrl);
    expect(plate.getAttribute("src")).not.toContain(
      "/api/media/image?url=%2Fapi%2Fmedia%2Fimage",
    );
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
    folio_title: "The Solitary Lamp",
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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
