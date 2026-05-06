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
      mediaId: null,
      contextRef: null,
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
      mediaId: "media-1",
      contextRef: {
        type: "content_chunk",
        id: "chunk-1",
        evidenceSpanIds: ["span-1"],
      },
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
    expect(screen.getByRole("link", { name: "Ask with evidence" })).toHaveAttribute(
      "href",
      "/conversations/new?scope=media%3Amedia-1&context=content_chunk%3Achunk-1%3Aspan-1"
    );
  });

  it("renders message metadata without duplicate score text", () => {
    const row: SearchResultRowViewModel = {
      key: "message-msg-1",
      href: "/conversations/conv-1",
      type: "message",
      mediaId: null,
      contextRef: null,
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
