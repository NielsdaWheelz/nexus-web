import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NoteBacklinks from "./NoteBacklinks";

describe("NoteBacklinks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows API errors instead of an empty backlinks state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "E_INTERNAL",
              message: "boom",
              request_id: "req-1",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      ),
    );

    render(
      <NoteBacklinks
        objectRef={{
          objectType: "note_block",
          objectId: "11111111-1111-4111-8111-111111111111",
        }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backlinks could not be loaded.",
    );
    expect(screen.queryByText("No linked objects yet.")).not.toBeInTheDocument();
  });

  it("aborts stale backlink reads and renders the latest object", async () => {
    const requests: Array<{
      path: string;
      signal: AbortSignal | null;
      resolve: (response: Response) => void;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((resolve) => {
          requests.push({
            path: String(input),
            signal: init?.signal ?? null,
            resolve,
          });
        });
      }),
    );

    const { rerender } = render(
      <NoteBacklinks
        objectRef={{
          objectType: "note_block",
          objectId: "11111111-1111-4111-8111-111111111111",
        }}
      />,
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    rerender(
      <NoteBacklinks
        objectRef={{
          objectType: "note_block",
          objectId: "22222222-2222-4222-8222-222222222222",
        }}
      />,
    );

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].path).toContain(
      "object_id=22222222-2222-4222-8222-222222222222",
    );

    requests[1].resolve(
      Response.json({
        data: {
          links: [
            {
              id: "link-new",
              relationType: "references",
              a: {
                objectType: "note_block",
                objectId: "22222222-2222-4222-8222-222222222222",
                label: "Current block",
                route: "/pages/page-2",
              },
              b: {
                objectType: "page",
                objectId: "page-2",
                label: "New page",
                route: "/pages/page-2",
              },
            },
          ],
        },
      }),
    );
    requests[0].resolve(
      Response.json({
        data: {
          links: [
            {
              id: "link-old",
              relationType: "references",
              a: {
                objectType: "note_block",
                objectId: "11111111-1111-4111-8111-111111111111",
                label: "Previous block",
                route: "/pages/page-1",
              },
              b: {
                objectType: "page",
                objectId: "page-1",
                label: "Old page",
                route: "/pages/page-1",
              },
            },
          ],
        },
      }),
    );

    expect(await screen.findByText("New page")).toBeInTheDocument();
    expect(screen.queryByText("Old page")).not.toBeInTheDocument();
  });
});
