import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SearchResultRow from "@/components/search/SearchResultRow";
import type { SearchResultRowViewModel } from "@/lib/search/types";

describe("SearchResultRow", () => {
  it("renders content-first note rows with contextual metadata", () => {
    const row: SearchResultRowViewModel = {
      key: "note_block-note-1",
      href: "/notes/note-1",
      type: "note_block",
      mediaId: null,
      contextRef: {
        type: "note_block",
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        evidenceSpanIds: [],
      },
      typeLabel: "note_block",
      primaryText: "note body text",
      snippetSegments: [],
      sourceMeta: "Deep Work Notes",
      noteBody: "note body text",
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    expect(
      screen.getByRole("link", { name: /note body text/i })
    ).toHaveAttribute("href", "/notes/note-1");
    expect(screen.getByText("note_block")).toBeInTheDocument();
    expect(screen.getByText("Deep Work Notes")).toBeInTheDocument();
  });

  it("uses linked highlight quote as the note row link title", () => {
    const row: SearchResultRowViewModel = {
      key: "note_block-note-1",
      href: "/notes/note-1",
      type: "note_block",
      mediaId: null,
      contextRef: {
        type: "note_block",
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        evidenceSpanIds: [],
      },
      typeLabel: "note_block",
      primaryText: "linked source quote text",
      snippetSegments: [
        { text: "note ", emphasized: false },
        { text: "body", emphasized: true },
      ],
      sourceMeta: "Deep Work Notes",
      noteBody: "note body text",
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    expect(
      screen.getByRole("link", { name: /linked source quote text/i })
    ).toHaveAttribute("href", "/notes/note-1");
    expect(screen.queryByRole("link", { name: /note body/i })).toBeNull();
    expect(screen.getByText("note body text")).toBeInTheDocument();
  });

  it("renders emphasized snippet segments for non-highlight rows", () => {
    const row: SearchResultRowViewModel = {
      key: "content_chunk-chunk-1",
      href: "/media/media-1#evidence-span-1",
      type: "content_chunk",
      mediaId: "b1b2c3d4-e5f6-7890-abcd-ef1234567890",
      contextRef: {
        type: "content_chunk",
        id: "c1b2c3d4-e5f6-7890-abcd-ef1234567890",
        evidenceSpanIds: ["d1b2c3d4-e5f6-7890-abcd-ef1234567890"],
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
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    const emphasized = screen.getByText("match");
    expect(emphasized.tagName).toBe("MARK");
    expect(screen.getByText("p. 12")).toBeInTheDocument();
  });

  it("renders web results as external evidence", () => {
    const row: SearchResultRowViewModel = {
      key: "web_result-result-1",
      href: "https://example.com/report",
      type: "web_result",
      mediaId: null,
      contextRef: {
        type: "web_result",
        id: "provider-result-1",
        evidenceSpanIds: [],
      },
      typeLabel: "web",
      primaryText: "External report",
      snippetSegments: [],
      sourceMeta: "example.com",
      noteBody: null,
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    expect(screen.getByRole("link", { name: /external report/i })).toHaveAttribute(
      "href",
      "https://example.com/report"
    );
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("renders message metadata", () => {
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
      contributorCredits: [],
    };

    render(<SearchResultRow row={row} />);

    expect(screen.getByRole("link", { name: /message #12/i })).toHaveAttribute(
      "href",
      "/conversations/conv-1"
    );
    expect(screen.getByText("message #12")).toBeInTheDocument();
  });
});
