import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SearchResultRow from "@/components/search/SearchResultRow";
import type { SearchResultRowViewModel } from "@/lib/search/resultRowAdapter";

describe("SearchResultRow", () => {
  it("renders content-first annotation rows with contextual metadata", () => {
    const row: SearchResultRowViewModel = {
      key: "annotation-ann-1",
      href: "/media/media-1?fragment=frag-12&highlight=hl-1",
      type: "annotation",
      typeLabel: "annotation",
      primaryText: "needle exact quote",
      snippetSegments: [],
      sourceMeta: "Deep Work Notes — Cal Newport — 2016-01-05",
      annotationBody: "annotation body text",
      highlightSnippet: {
        prefix: "this is before",
        exact: "needle exact quote",
        suffix: "this is after",
      },
      scoreLabel: "score 0.91",
    };

    render(<SearchResultRow row={row} />);

    expect(
      screen.getByRole("link", { name: /needle exact quote/i })
    ).toHaveAttribute("href", "/media/media-1?fragment=frag-12&highlight=hl-1");
    expect(screen.getByText("annotation")).toBeInTheDocument();
    expect(screen.getByText("Deep Work Notes — Cal Newport — 2016-01-05")).toBeInTheDocument();
    expect(screen.getByText("annotation body text")).toBeInTheDocument();
  });

  it("renders emphasized snippet segments for non-highlight rows", () => {
    const row: SearchResultRowViewModel = {
      key: "fragment-frag-1",
      href: "/media/media-1?fragment=frag-1",
      type: "fragment",
      typeLabel: "fragment",
      primaryText: "before match after",
      snippetSegments: [
        { text: "before ", emphasized: false },
        { text: "match", emphasized: true },
        { text: " after", emphasized: false },
      ],
      sourceMeta: "Deep Work Notes — Cal Newport",
      annotationBody: null,
      highlightSnippet: null,
      scoreLabel: "score 0.42",
    };

    render(<SearchResultRow row={row} />);

    const emphasized = screen.getByText("match");
    expect(emphasized.tagName).toBe("MARK");
    expect(screen.getByText("fragment")).toBeInTheDocument();
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
      annotationBody: null,
      highlightSnippet: null,
      scoreLabel: "score 0.31",
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
