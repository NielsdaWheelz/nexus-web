import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPaneBody from "./SearchPaneBody";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

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
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId="search"
      resourceRef={null}
      resourceKey={resolvePaneRouteIdentity(href).resourceKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onNavigatePane={vi.fn()}
      onReplacePane={(_paneId: string, nextHref: string) => {
        setHref(nextHref);
      }}
      onOpenInNewPane={vi.fn()}
      onSetPaneTitle={vi.fn()}
    >
      <SearchPaneBody />
    </PaneRuntimeProvider>
  );
}

function renderSearch(initialHref: string) {
  render(<StatefulSearchPane initialHref={initialHref} />);
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
});

describe("SearchPaneBody filter chips", () => {
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
});
