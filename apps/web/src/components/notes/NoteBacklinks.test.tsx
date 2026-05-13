import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NoteBacklinks from "./NoteBacklinks";

describe("NoteBacklinks", () => {
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
          { status: 500, headers: { "Content-Type": "application/json" } },
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
});
