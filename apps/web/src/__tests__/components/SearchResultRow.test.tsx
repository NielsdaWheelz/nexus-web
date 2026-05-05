import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SearchResultRow from "@/components/search/SearchResultRow";
import type { SearchResultRowViewModel } from "@/lib/search/resultRowAdapter";

describe("SearchResultRow", () => {
  it("renders content-first note rows with contextual metadata", () => {
    const row: SearchResultRowViewModel = {
      key: "note_block-note-1",
      href: "/notes/note-1",
      type: "note_block",
      typeLabel: "note_block",
      primaryText: "note body text",
      snippetSegments: [],
      sourceMeta: "Deep Work Notes",
      noteBody: "note body text",
      scoreLabel: "score 0.91",
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    expect(
      screen.getByRole("link", { name: /note body text/i })
    ).toHaveAttribute("href", "/notes/note-1");
    expect(screen.getByText("note_block")).toBeInTheDocument();
    expect(screen.getByText("Deep Work Notes")).toBeInTheDocument();
  });

  it("renders emphasized snippet segments for non-highlight rows", () => {
    const row: SearchResultRowViewModel = {
      key: "content_chunk-chunk-1",
      href: "/media/media-1?evidence=span-1&page=12",
      type: "content_chunk",
      typeLabel: "p. 12",
      primaryText: "before match after",
      snippetSegments: [
        { text: "before ", emphasized: false },
        { text: "match", emphasized: true },
        { text: " after", emphasized: false },
      ],
      sourceMeta: "Deep Work Notes — Cal Newport",
      noteBody: null,
      scoreLabel: "score 0.42",
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    const emphasized = screen.getByText("match");
    expect(emphasized.tagName).toBe("MARK");
    expect(screen.getByText("p. 12")).toBeInTheDocument();
  });

  it("renders message metadata without duplicate score text", () => {
    const row: SearchResultRowViewModel = {
      key: "message-msg-1",
      href: "/conversations/conv-1",
      type: "message",
      typeLabel: "message",
      primaryText: "Message #12",
      snippetSegments: [],
      sourceMeta: "message #12",
      noteBody: null,
      scoreLabel: "score 0.31",
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    expect(screen.getByRole("link", { name: /message #12/i })).toHaveAttribute(
      "href",
      "/conversations/conv-1"
    );
    expect(screen.getByText("message #12")).toBeInTheDocument();
    expect(screen.getAllByText("score 0.31")).toHaveLength(1);
  });
});
