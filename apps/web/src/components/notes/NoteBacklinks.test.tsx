import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NoteBacklinks from "./NoteBacklinks";
import type { EdgeOut } from "@/lib/resourceGraph/edges";

const BLOCK_A = "11111111-1111-4111-8111-111111111111";
const BLOCK_B = "22222222-2222-4222-8222-222222222222";

function edge(overrides: Partial<EdgeOut>): EdgeOut {
  return {
    id: "edge-1",
    kind: "context",
    origin: "note_body",
    source_ref: `note_block:${BLOCK_A}`,
    target_ref: "page:33333333-3333-4333-8333-333333333333",
    ordinal: null,
    snapshot: null,
    source_label: "This block",
    source_missing: false,
    target_label: "Linked page",
    target_missing: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("NoteBacklinks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows API errors instead of an empty connections state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "E_INTERNAL", message: "boom", request_id: "req-1" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connections could not be loaded.",
    );
    expect(
      screen.queryByText("No connected objects yet."),
    ).not.toBeInTheDocument();
  });

  it("aborts stale reads and renders the latest object's connection", async () => {
    const requests: Array<{
      path: string;
      signal: AbortSignal | null;
      resolve: (response: Response) => void;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            requests.push({
              path: String(input),
              signal: init?.signal ?? null,
              resolve,
            });
          }),
      ),
    );

    const { rerender } = render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    rerender(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_B }} />,
    );

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].path).toContain(
      encodeURIComponent(`note_block:${BLOCK_B}`),
    );

    requests[1].resolve(
      Response.json({
        data: [
          edge({
            id: "edge-new",
            source_ref: `note_block:${BLOCK_B}`,
            target_label: "New page",
          }),
        ],
      }),
    );
    requests[0].resolve(
      Response.json({
        data: [
          edge({
            id: "edge-old",
            source_ref: `note_block:${BLOCK_A}`,
            target_label: "Old page",
          }),
        ],
      }),
    );

    expect(await screen.findByText("New page")).toBeInTheDocument();
    expect(screen.queryByText("Old page")).not.toBeInTheDocument();
  });

  it("renders the endpoint that is not the viewed object and disables missing ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            // Viewed object is the TARGET here, so the SOURCE is the connection.
            edge({
              id: "edge-incoming",
              source_ref: "media:44444444-4444-4444-8444-444444444444",
              source_label: "Citing media",
              target_ref: `note_block:${BLOCK_A}`,
              target_missing: false,
            }),
            edge({
              id: "edge-missing",
              source_ref: `note_block:${BLOCK_A}`,
              target_label: "Deleted page",
              target_missing: true,
            }),
          ],
        }),
      ),
    );

    render(
      <NoteBacklinks objectRef={{ objectType: "note_block", objectId: BLOCK_A }} />,
    );

    expect(await screen.findByText("Citing media")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Deleted page/ }),
    ).toBeDisabled();
  });
});
