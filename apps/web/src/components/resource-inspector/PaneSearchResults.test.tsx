import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import PaneSearchResults from "@/components/resource-inspector/PaneSearchResults";
import type {
  PaneFindResult,
  PaneFindResultKey,
  PaneSearchPublication,
} from "@/lib/panes/paneSearch";

function resultKey(value: string): PaneFindResultKey {
  // justify-type-assertion: tests mint opaque result keys from distinct fixture values.
  return value as PaneFindResultKey;
}

type FindPublication = Extract<
  PaneSearchPublication,
  { kind: "FindOccurrences" }
>;

function publicationFor(
  result: PaneFindResult,
  onActivate: FindPublication["onActivate"] = () => {},
  partialSourceLabel?: string,
): FindPublication {
  return {
    kind: "FindOccurrences",
    query: "river",
    partialSourceLabel,
    inputLabel: "Find in document",
    placeholder: "Find in this document",
    onOpen: () => {},
    onQueryChange: () => {},
    onDismiss: () => {},
    result,
    scope: { kind: "EntireResource" },
    matchCase: false,
    wholeWord: false,
    onMatchCaseChange: () => {},
    onWholeWordChange: () => {},
    onStep: () => {},
    onActivate,
    onShowResults: () => {},
    resultsExpanded: true,
    returnToReadingPosition: { kind: "Unavailable" },
  };
}

function ResultsHarness() {
  const [activated, setActivated] = useState("None");
  const first = resultKey("first");
  const second = resultKey("second");
  return (
    <>
      <PaneSearchResults
        publication={publicationFor(
          {
            kind: "Ready",
            completeness: "Complete",
            rows: [
              {
                key: first,
                context: ["Chapter 1", "Opening"],
                snippet: [
                  { text: "Before ", emphasized: false },
                  { text: "<river>", emphasized: true },
                  { text: " after", emphasized: false },
                ],
              },
              {
                key: second,
                context: ["Chapter 2"],
                snippet: [{ text: "Another river", emphasized: true }],
              },
            ],
            activeKey: first,
          },
          (key) => setActivated(key),
        )}
      />
      <output aria-label="Activated occurrence">{activated}</output>
    </>
  );
}

function FailedHarness() {
  const [retryState, setRetryState] = useState("None");
  return (
    <>
      <PaneSearchResults
        publication={publicationFor({
          kind: "Failed",
          message: "The document text could not be read.",
          onRetry: () => setRetryState("Retry requested"),
        })}
      />
      <output aria-label="Retry state">{retryState}</output>
    </>
  );
}

describe("PaneSearchResults", () => {
  it("renders ordered, exact occurrence rows with context and semantic emphasis", async () => {
    const user = userEvent.setup();
    render(<ResultsHarness />);

    const list = screen.getByRole("list", { name: "Search results" });
    const rows = screen.getAllByRole("listitem");
    expect(list).toContainElement(rows[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[1]).not.toHaveAttribute("aria-current");
    expect(screen.getAllByText("<river>", { selector: "mark" })).toHaveLength(2);
    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
    expect(screen.getByText("Opening")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Go to match: 2 of 2: Chapter 2: Another river",
      }),
    );
    expect(
      screen.getByRole("status", { name: "Activated occurrence" }),
    ).toHaveTextContent("second");
  });

  it("labels the active occurrence without making display text its identity", () => {
    render(<ResultsHarness />);

    expect(
      screen.getByRole("button", {
        name: "Current match: 1 of 2: Chapter 1, Opening: Before <river> after",
      }),
    ).toBeInTheDocument();
  });

  it("renders partial, excessive, and failed result states with useful next steps", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <PaneSearchResults
          publication={publicationFor(
            {
              kind: "NoMatches",
              completeness: "Partial",
            },
            () => {},
            "available transcript",
          )}
        />
        <output aria-label="Retry state">None</output>
      </>,
    );
    expect(
      screen.getByText(
        "No matches in the available transcript. Results are incomplete.",
      ),
    ).toBeInTheDocument();

    rerender(
      <>
        <PaneSearchResults
          publication={publicationFor({
            kind: "TooManyMatches",
            threshold: 500,
          })}
        />
        <output aria-label="Retry state">None</output>
      </>,
    );
    expect(
      screen.getByText("More than 500 matches. Refine your search to see results."),
    ).toBeInTheDocument();

    rerender(<FailedHarness />);
    expect(
      screen.getByText("Search failed. The document text could not be read."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("status", { name: "Retry state" })).toHaveTextContent(
      "Retry requested",
    );
  });
});
