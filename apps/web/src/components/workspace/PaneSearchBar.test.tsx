import { createRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import PaneSearchBar from "@/components/workspace/PaneSearchBar";
import type {
  PaneFindResultKey,
  PaneSearchPublication,
} from "@/lib/panes/paneSearch";

function resultKey(value: string): PaneFindResultKey {
  // justify-type-assertion: tests mint opaque result keys from distinct fixture values.
  return value as PaneFindResultKey;
}

function FilterHarness() {
  const [query, setQuery] = useState("draft");
  const [open, setOpen] = useState(true);
  if (!open) {
    return <p>Search closed</p>;
  }
  const publication: PaneSearchPublication = {
    kind: "FilterRows",
    query,
    inputLabel: "Filter library",
    placeholder: "Filter this library",
    onQueryChange: setQuery,
    onDismiss: () => setQuery(""),
    rowStatus: {
      kind: "Complete",
      visibleCount: query.length === 0 ? 4 : 1,
      totalCount: 4,
      unit: { singular: "item", plural: "items" },
    },
    activeDomainControlCount: 0,
    filters: <button type="button">Unread only</button>,
    controls: <button type="button">Newest first</button>,
  };
  return (
    <>
      <PaneSearchBar publication={publication} onClose={() => setOpen(false)} />
      <output aria-label="Current query">{query}</output>
    </>
  );
}

function FindHarness() {
  const [query, setQuery] = useState("river");
  const [scope, setScope] = useState("entire");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [lastAction, setLastAction] = useState("None");
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const first = resultKey("first");
  const second = resultKey("second");
  const publication: PaneSearchPublication = {
    kind: "FindOccurrences",
    query,
    inputLabel: "Find in document",
    placeholder: "Find in this document",
    onOpen: () => {},
    onQueryChange: setQuery,
    onDismiss: () => setQuery(""),
    result: {
      kind: "Ready",
      completeness: "Complete",
      rows: [
        {
          key: first,
          context: ["Chapter 1"],
          snippet: [{ text: "river", emphasized: true }],
        },
        {
          key: second,
          context: ["Chapter 2"],
          snippet: [{ text: "river", emphasized: true }],
        },
      ],
      activeKey: first,
    },
    scope: {
      kind: "Selectable",
      selectedId: scope,
      options: [
        { kind: "EntireResource", id: "entire", label: "Entire document" },
        { kind: "Narrow", id: "chapter", label: "Current chapter" },
      ],
      onChange: setScope,
    },
    matchCase,
    wholeWord,
    onMatchCaseChange: setMatchCase,
    onWholeWordChange: setWholeWord,
    onStep: (direction) => setLastAction(direction),
    onActivate: () => {},
    onShowResults: (trigger) => {
      setResultsExpanded(true);
      setLastAction(`Opened from ${trigger?.textContent?.trim() ?? "unknown"}`);
    },
    resultsExpanded,
    returnToReadingPosition: {
      kind: "Available",
      onReturn: () => setLastAction("Returned"),
    },
  };
  return (
    <>
      <PaneSearchBar
        publication={publication}
        onClose={() => setLastAction("Closed")}
      />
      <output aria-label="Last action">{lastAction}</output>
    </>
  );
}

function PartialFindHarness() {
  const publication: PaneSearchPublication = {
    kind: "FindOccurrences",
    query: "missing",
    partialSourceLabel: "available transcript",
    inputLabel: "Find in transcript",
    placeholder: "Find in transcript",
    onOpen: () => {},
    onQueryChange: () => {},
    onDismiss: () => {},
    result: { kind: "NoMatches", completeness: "Partial" },
    scope: { kind: "EntireResource" },
    matchCase: false,
    wholeWord: false,
    onMatchCaseChange: () => {},
    onWholeWordChange: () => {},
    onStep: () => {},
    onActivate: () => {},
    onShowResults: () => {},
    resultsExpanded: false,
    returnToReadingPosition: { kind: "Unavailable" },
  };
  return <PaneSearchBar publication={publication} onClose={() => {}} />;
}

describe("PaneSearchBar", () => {
  it("keeps FilterRows limited to query and domain-owned controls", async () => {
    const user = userEvent.setup();
    const inputRef = createRef<HTMLInputElement>();
    render(
      <>
        <PaneSearchBar
          ref={inputRef}
          publication={{
            kind: "FilterRows",
            query: "",
            inputLabel: "Filter library",
            placeholder: "Filter this library",
            onQueryChange: () => {},
            onDismiss: () => {},
            rowStatus: {
              kind: "Complete",
              visibleCount: 4,
              totalCount: 4,
              unit: { singular: "item", plural: "items" },
            },
            activeDomainControlCount: 0,
            filters: <button type="button">Unread only</button>,
          }}
          onClose={() => {}}
        />
      </>,
    );

    const input = screen.getByRole("searchbox", { name: "Filter library" });
    expect(inputRef.current).toBe(input);
    expect(input).toHaveAttribute("placeholder", "Filter this library");
    expect(screen.getByRole("button", { name: "Unread only" })).toBeInTheDocument();
    expect(screen.queryByText("Match case")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next match" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Results" })).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "notes");
  });

  it("updates a filter query and dismisses the whole interaction on Escape", async () => {
    const user = userEvent.setup();
    render(<FilterHarness />);

    const input = screen.getByRole("searchbox", { name: "Filter library" });
    await user.clear(input);
    await user.type(input, "history");
    expect(screen.getByRole("status", { name: "Current query" })).toHaveTextContent(
      "history",
    );

    await user.click(screen.getByRole("button", { name: "Unread only" }));
    await user.keyboard("{Escape}");
    expect(screen.getByText("Search closed")).toBeInTheDocument();
  });

  it("announces debounced Partial and Complete filter counts without visible chrome", async () => {
    const publication: Extract<PaneSearchPublication, { kind: "FilterRows" }> =
      {
        kind: "FilterRows",
        query: "needle",
        inputLabel: "Filter episodes",
        placeholder: "Filter",
        onQueryChange: () => {},
        onDismiss: () => {},
        rowStatus: {
          kind: "Partial",
          visibleCount: 1,
          loadedCount: 8,
          unit: { singular: "episode", plural: "episodes" },
        },
        activeDomainControlCount: 0,
      };
    const view = render(
      <PaneSearchBar publication={publication} onClose={() => {}} />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
    expect(status).toHaveClass("sr-only");
    await expect
      .poll(() => status.textContent)
      .toBe("1 matching episode among 8 loaded; loading remaining episodes.");

    view.rerender(
      <PaneSearchBar
        publication={{
          ...publication,
          rowStatus: {
            kind: "Complete",
            visibleCount: 0,
            totalCount: 12,
            unit: { singular: "episode", plural: "episodes" },
          },
        }}
        onClose={() => {}}
      />,
    );
    await expect
      .poll(() => status.textContent)
      .toBe("0 matching episodes of 12 total.");
  });

  it("presents Find controls, keyboard stepping, results, and return as one interaction", async () => {
    const user = userEvent.setup();
    render(<FindHarness />);

    const input = screen.getByRole("searchbox", { name: "Find in document" });
    expect(input).toHaveAttribute("aria-keyshortcuts", "Enter Shift+Enter Escape");
    expect(
      screen.getByText("1 of 2 matches", { selector: "[role='status']" }),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Scope" }),
      "chapter",
    );
    expect(screen.getByRole("combobox", { name: "Scope" })).toHaveValue("chapter");

    await user.click(screen.getByRole("checkbox", { name: "Match case" }));
    await user.click(screen.getByRole("checkbox", { name: "Whole word" }));
    expect(screen.getByRole("checkbox", { name: "Match case" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Whole word" })).toBeChecked();

    await user.click(input);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status", { name: "Last action" })).toHaveTextContent(
      "Next",
    );
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByRole("status", { name: "Last action" })).toHaveTextContent(
      "Previous",
    );
    expect(
      screen.getByText(/Wrapped to last match\./, {
        selector: "[role='status']",
      }),
    ).toBeInTheDocument();

    const results = screen.getByRole("button", { name: "Results" });
    expect(results).toHaveAttribute("aria-expanded", "false");
    await user.click(results);
    expect(results).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status", { name: "Last action" })).toHaveTextContent(
      "Opened from Results",
    );

    await user.click(
      screen.getByRole("button", { name: "Go back to reading position" }),
    );
    expect(screen.getByRole("status", { name: "Last action" })).toHaveTextContent(
      "Returned",
    );
  });

  it("does not move the document from a failed result and exposes Retry", async () => {
    const user = userEvent.setup();
    const publication: PaneSearchPublication = {
      kind: "FindOccurrences",
      query: "river",
      inputLabel: "Find in document",
      placeholder: "Find in this document",
      onOpen: () => {},
      onQueryChange: () => {},
      onDismiss: () => {},
      result: {
        kind: "Failed",
        message: "The document text could not be read.",
        onRetry: () => {},
      },
      scope: { kind: "EntireResource" },
      matchCase: false,
      wholeWord: false,
      onMatchCaseChange: () => {},
      onWholeWordChange: () => {},
      onStep: () => {},
      onActivate: () => {},
      onShowResults: () => {},
      resultsExpanded: false,
      returnToReadingPosition: { kind: "Unavailable" },
    };
    render(<PaneSearchBar publication={publication} onClose={() => {}} />);

    expect(
      screen.getByText("Search failed. The document text could not be read.", {
        selector: "[role='status']",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Results" })).toBeDisabled();

    await user.click(screen.getByRole("searchbox", { name: "Find in document" }));
    await user.keyboard("{Enter}");
  });

  it("names the partial transcript when zero available matches exist", () => {
    render(<PartialFindHarness />);

    expect(
      screen.getByText(
        "No matches in the available transcript; results are incomplete",
        { selector: "[role='status']" },
      ),
    ).toBeInTheDocument();
  });
});
