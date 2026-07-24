import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import SearchPaneBody from "./SearchPaneBody";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { SEARCH_KINDS, SEARCH_KIND_LABELS } from "@/lib/search/kinds";
import {
  consumeSearchInputFocus,
  requestSearchInputFocus,
} from "@/lib/search/pendingSearchFocus";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import {
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);
const SEARCH_HREF = "/search?q=return";
const SEARCH_ROUTE_KEY = resolvePaneRouteIdentity(SEARCH_HREF).routeKey;

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stateful pane-runtime harness: holds the pane href in state and lets
 * `paneRouter.replace(...)` update it (mirroring the real workspace). This closes
 * the loop so chip add/remove actually re-derives `query` from the URL — without
 * mocking any internal module.
 */
function StatefulSearchPane({ initialHref }: { initialHref: string }) {
  const [href, setHref] = useState(initialHref);
  return (
    <PaneReturnMementoProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={href}
        routeId="search"
        routeKey={resolvePaneRouteIdentity(href).routeKey}
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        onNavigatePane={vi.fn()}
        onReplacePane={(_paneId: string, nextHref: string) => {
          setHref(nextHref);
        }}
        onOpenInNewPane={vi.fn()}
        onSetPaneLabel={vi.fn()}
      >
        <SearchPaneBody />
      </PaneRuntimeProvider>
    </PaneReturnMementoProvider>
  );
}

function renderSearch(initialHref: string) {
  render(<StatefulSearchPane initialHref={initialHref} />);
}

function searchNote(id: string, bodyText: string) {
  return {
    type: "note_block",
    id,
    score: 0.9,
    snippet: bodyText,
    title: bodyText,
    source_label: "note",
    media_id: null,
    media_kind: null,
    resource_ref: `note_block:${id}`,
    activation: {
      resourceRef: `note_block:${id}`,
      kind: "route",
      href: `/notes/${id}`,
      unresolvedReason: null,
    },
    citation_target: `note_block:${id}`,
    context_ref: { type: "note_block", id },
    body_text: bodyText,
    highlight_excerpt: null,
    locator: {
      type: "note_block_offsets",
      block_id: id,
      start_offset: 0,
      end_offset: bodyText.length,
    },
  };
}

function stubEmptySearch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/search") {
        return jsonResponse({ results: [], page: { next_cursor: null } });
      }
      // ContributorFilter etc. — tolerate any incidental contributor lookups.
      if (path.startsWith("/api/contributors")) {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Drain any pending focus request so it can't leak into the next test.
  consumeSearchInputFocus();
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("SearchPaneBody filter chips", () => {
  it("restores the captured result controller before initial search can settle again", async () => {
    const cursors: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/search") {
          const cursor = url.searchParams.get("cursor");
          cursors.push(cursor);
          return jsonResponse(
            cursor === "cursor-2"
              ? {
                  results: [searchNote("second", "Restored second page")],
                  page: { next_cursor: null },
                }
              : {
                  results: [searchNote("first", "Restored first page")],
                  page: { next_cursor: "cursor-2" },
                },
          );
        }
        if (url.pathname.startsWith("/api/contributors")) {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected fetch call: ${url.pathname}`);
      }),
    );
    let commands!: PaneReturnMementoCommands;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    let resourceGeneration = 0;
    const journey = () => (
      <PaneReturnJourneyHarness
        href={SEARCH_HREF}
        paneId="pane-1"
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publish}
      >
        <SearchPaneBody />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());
    expect(
      await screen.findByRole("link", { name: "Restored first page" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("link", { name: "Restored second page" }),
    ).toBeVisible();
    commands.capturePane({
      paneId: "pane-1",
      visitId: RETURN_JOURNEY_VISIT_ID,
      routeKey: SEARCH_ROUTE_KEY,
      modality: "Programmatic",
    });

    resourceGeneration += 1;
    view.rerender(journey());

    expect(
      screen.getAllByRole("link", { name: "Restored first page" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("link", { name: "Restored second page" }),
    ).toHaveLength(1);
    await waitFor(() => expect(cursors).toEqual([null, "cursor-2"]));
  });

  it("adds a format filter as a removable applied chip, then removes it", async () => {
    stubEmptySearch();
    renderSearch("/search?q=test");

    // No applied-filter group before any filter is added.
    expect(
      screen.queryByRole("group", { name: "Applied filters" }),
    ).not.toBeInTheDocument();

    // Open the "+ Format" menu and pick PDFs.
    await userEvent.click(screen.getByRole("button", { name: "+ Format" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "PDFs" }));

    const group = await screen.findByRole("group", { name: "Applied filters" });
    expect(within(group).getByText("PDFs")).toBeInTheDocument();

    // Remove it via the chip's Remove control.
    await userEvent.click(within(group).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Applied filters" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("clears every applied filter via Clear all", async () => {
    stubEmptySearch();
    renderSearch("/search?q=test&formats=pdf,epub");

    const group = await screen.findByRole("group", { name: "Applied filters" });
    expect(within(group).getByText("PDFs")).toBeInTheDocument();
    expect(within(group).getByText("EPUBs")).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Clear all" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Applied filters" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("offers Clear filters on a zero-result search with active filters", async () => {
    stubEmptySearch();
    renderSearch("/search?q=test&formats=pdf");

    // Empty results + an active filter ⇒ the recovery affordance appears.
    const clearFilters = await screen.findByRole("button", {
      name: "Clear filters",
    });
    expect(screen.getByText("No results found.")).toBeInTheDocument();

    await userEvent.click(clearFilters);

    // Filters cleared: no applied-filter group and no recovery button remain.
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Applied filters" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Clear filters" }),
    ).not.toBeInTheDocument();
  });

  it("composes rapid deselect-all kind changes with the typed draft", async () => {
    stubEmptySearch();
    renderSearch("/search");
    const user = userEvent.setup();

    for (const kind of SEARCH_KINDS) {
      await user.click(
        within(screen.getByRole("group", { name: "Result kinds" })).getByRole(
          "button",
          {
          name: SEARCH_KIND_LABELS[kind],
          },
        ),
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("group", { name: "Result kinds" })).getByRole(
            "button",
            { name: SEARCH_KIND_LABELS[kind] },
          ),
        ).toHaveAttribute("aria-pressed", "false"),
      );
    }

    const input = screen.getByLabelText("Search content");
    await user.type(input, "e2e non-pdf");

    await waitFor(() => {
      expect(screen.getByLabelText("Search content")).toHaveValue(
        "e2e non-pdf",
      );
      const kinds = screen.getByRole("group", { name: "Result kinds" });
      for (const kind of SEARCH_KINDS) {
        expect(
          within(kinds).getByRole("button", {
            name: SEARCH_KIND_LABELS[kind],
          }),
        ).toHaveAttribute("aria-pressed", "false");
      }
      expect(screen.getByText("No results found.")).toBeInTheDocument();
    });
  });
});

// The Launcher "Go to Authors"/"Search" commands set a one-shot focus request before
// navigating; SearchPaneBody consumes it on the mount flip and focuses the box only for
// a blank landing. Ordinary arrivals (no request) and text landings must not grab focus.
describe("SearchPaneBody navigated-landing focus", () => {
  it("focuses the search box on a requested blank landing", async () => {
    stubEmptySearch();
    requestSearchInputFocus(); // the Launcher navigation just declared intent to type
    renderSearch("/search?kinds=people");

    const input = await screen.findByLabelText("Search content");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("does not focus when the landing carries a query", async () => {
    stubEmptySearch();
    requestSearchInputFocus();
    renderSearch("/search?q=foo");

    const input = await screen.findByLabelText("Search content");
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("foo");
    // Let the mount-flip effect + its rAF run; focus must stay off the box.
    await nextFrame();
    await nextFrame();
    expect(input).not.toHaveFocus();
  });

  it("does not focus a blank landing that no navigation requested (restore / back-forward)", async () => {
    stubEmptySearch();
    renderSearch("/search?kinds=people"); // no requestSearchInputFocus()

    const input = await screen.findByLabelText("Search content");
    await waitFor(() => expect(input).toBeEnabled());
    await nextFrame();
    await nextFrame();
    expect(input).not.toHaveFocus();
  });
});
