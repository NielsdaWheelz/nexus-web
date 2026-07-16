import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import AuthorsPaneBody from "./AuthorsPaneBody";

describe("AuthorsPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders directory rows with work-count signals", async () => {
    stubDirectoryFetch();

    render(<AuthorsHarness />);

    expect(
      await screen.findByRole("link", { name: /Ursula K. Le Guin/ }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Italo Calvino/ })).toBeVisible();
    // Work count leads the presenter's signal meta (joined with kind).
    expect(screen.getByText(/12 works/)).toBeVisible();
    expect(screen.getByText(/7 works/)).toBeVisible();
  });

  it("toggles a role facet into the URL and refetches", async () => {
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        requestedUrls.push(url);
        const roleFilter = url.searchParams.get("roles");
        return directoryResponse(
          roleFilter === "translator"
            ? [entry("italo-calvino", "Italo Calvino", 7)]
            : [
                entry("ursula-k-le-guin", "Ursula K. Le Guin", 12),
                entry("italo-calvino", "Italo Calvino", 7),
              ],
        );
      }),
    );

    render(<AuthorsHarness />);

    const roleChip = await screen.findByRole("button", { name: /Translators \(4\)/ });
    expect(roleChip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(roleChip);

    await waitFor(() => {
      const last = requestedUrls[requestedUrls.length - 1];
      expect(last?.searchParams.get("roles")).toBe("translator");
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: /Ursula K. Le Guin/ }),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByRole("button", { name: /Translators \(4\)/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("links each row to the author detail href", async () => {
    stubDirectoryFetch();

    render(<AuthorsHarness />);

    const row = await screen.findByRole("link", { name: /Ursula K. Le Guin/ });
    expect(row).toHaveAttribute("href", "/authors/ursula-k-le-guin");
  });

  it("toggles A–Z sort into the URL and refetches", async () => {
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        requestedUrls.push(url);
        return directoryResponse([entry("ursula-k-le-guin", "Ursula K. Le Guin", 12)]);
      }),
    );

    render(<AuthorsHarness />);

    const sortChip = await screen.findByRole("button", { name: "A–Z" });
    expect(sortChip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(sortChip);

    await waitFor(() => {
      const last = requestedUrls[requestedUrls.length - 1];
      expect(last?.searchParams.get("sort")).toBe("name");
    });
    expect(
      await screen.findByRole("button", { name: "A–Z" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("appends the next page when Load more carries the cursor", async () => {
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        requestedUrls.push(url);
        if (url.searchParams.get("cursor") === "cursor-2") {
          return directoryResponse([entry("italo-calvino", "Italo Calvino", 7)]);
        }
        return directoryResponse(
          [entry("ursula-k-le-guin", "Ursula K. Le Guin", 12)],
          "cursor-2",
        );
      }),
    );

    render(<AuthorsHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(
      await screen.findByRole("link", { name: /Italo Calvino/ }),
    ).toBeVisible();
    // Page 1 row stays (appended, not replaced) and is not duplicated.
    expect(screen.getAllByRole("link", { name: /Ursula K. Le Guin/ })).toHaveLength(1);
    await waitFor(() => {
      const last = requestedUrls[requestedUrls.length - 1];
      expect(last?.searchParams.get("cursor")).toBe("cursor-2");
    });
  });

  it("resets paging when a facet changes, dropping the stale cursor", async () => {
    const requestedUrls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        requestedUrls.push(url);
        // The filtered page has no more rows, so its Load more must disappear.
        if (url.searchParams.get("roles") === "translator") {
          return directoryResponse([entry("italo-calvino", "Italo Calvino", 7)]);
        }
        return directoryResponse(
          [entry("ursula-k-le-guin", "Ursula K. Le Guin", 12)],
          "cursor-2",
        );
      }),
    );

    render(<AuthorsHarness />);

    // Page 1 renders with a Load more affordance (has_more:true).
    expect(await screen.findByRole("button", { name: "Load more" })).toBeVisible();

    fireEvent.click(
      await screen.findByRole("button", { name: /Translators \(4\)/ }),
    );

    // The new filter window has no next cursor → Load more is gone, and no
    // stale page-2 fetch fires against the old cursor.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument();
    });
    expect(
      requestedUrls.some((url) => url.searchParams.get("cursor") === "cursor-2"),
    ).toBe(false);
  });
});

function stubDirectoryFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = requestUrl(path);
      if (url.pathname === "/api/contributors/directory") {
        return directoryResponse([
          entry("ursula-k-le-guin", "Ursula K. Le Guin", 12),
          entry("italo-calvino", "Italo Calvino", 7),
        ]);
      }
      throw new Error(`Unexpected fetch path: ${path}`);
    }),
  );
}

// Stateful harness: the workspace re-renders the pane provider with the next
// href whenever the pane router replaces it, so URL-state edits refetch.
function AuthorsHarness() {
  const [href, setHref] = useState("/authors");
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      isActive={true}
      href={href}
      routeId="authors"
      routeKey={resolvePaneRouteIdentity(href).routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={{}}
      onNavigatePane={(_id, next) => setHref(next)}
      onReplacePane={(_id, next) => setHref(next)}
      onOpenInNewPane={() => {}}
    >
      <AuthorsPaneBody />
    </PaneRuntimeProvider>
  );
}

function requestUrl(path: string): URL {
  return new URL(path, "https://nexus.test");
}

function entry(handle: string, displayName: string, workCount: number) {
  return {
    handle,
    href: `/authors/${handle}`,
    display_name: displayName,
    sort_name: displayName,
    kind: "person",
    status: "verified",
    disambiguation: null,
    work_count: workCount,
    roles: ["author"],
    content_kinds: ["epub"],
  };
}

function directoryResponse(
  entries: ReturnType<typeof entry>[],
  nextCursor: string | null = null,
): Response {
  return jsonResponse({
    data: {
      entries,
      facets: {
        roles: [
          { value: "author", count: 9 },
          { value: "translator", count: 4 },
        ],
        kinds: [{ value: "person", count: 11 }],
        content_kinds: [{ value: "epub", count: 8 }],
        statuses: [{ value: "verified", count: 10 }],
      },
      page: { has_more: nextCursor !== null, next_cursor: nextCursor },
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
