import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import AuthorPaneBody from "./AuthorPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 2–10, Acceptance 3/6/7/8/9). Author works is a revisioned
 * keyset collection reached through a view-blind route seed, so these proofs
 * cover the risks that seam creates: painting the canonical seed for a
 * deep-linked sort, committing a superseded view's page, and requesting a
 * collection the URL rejected.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const HANDLE = "ada-lovelace";
const noop = () => {};

// Three works whose publication order, title order, and reverse title order all
// differ, so no committed order is ambiguous about the view that produced it.
const MERIDIAN = {
  title: "Meridian drift",
  href: "https://example.test/meridian",
  contentKind: "article",
  date: "2026-03-01",
  roleFacts: [{ creditedName: "Ada Lovelace", role: "author", rawRole: null }],
  actionTarget: { kind: "External", href: "https://example.test/meridian" },
};
const ZEBRA = {
  title: "Zebra migrations",
  href: "https://example.test/zebra",
  contentKind: "article",
  date: "2010-01-01",
  roleFacts: [{ creditedName: "Ada Lovelace", role: "author", rawRole: null }],
  actionTarget: { kind: "External", href: "https://example.test/zebra" },
};
const AURORA = {
  title: "Aurora physics",
  href: "https://example.test/aurora",
  contentKind: "article",
  date: "1998-06-01",
  roleFacts: [{ creditedName: "Ada Lovelace", role: "author", rawRole: null }],
  actionTarget: { kind: "External", href: "https://example.test/aurora" },
};
const PUBLISHED_NEWEST = [MERIDIAN, ZEBRA, AURORA];
const TITLE_ASC = [AURORA, MERIDIAN, ZEBRA];
const TITLE_DESC = [ZEBRA, MERIDIAN, AURORA];

const WORKS = `/api/contributors/${HANDLE}/works`;
const CANONICAL_REQUEST = `${WORKS}?limit=100`;
const TITLE_ASC_REQUEST = `${WORKS}?sort=title&direction=asc&limit=100`;
const TITLE_DESC_REQUEST = `${WORKS}?sort=title&direction=desc&limit=100`;

const CONTRIBUTOR_REF = "contributor:33333333-3333-4333-8333-333333333333";
const AUTHOR_DETAIL = {
  data: {
    handle: HANDLE,
    href: `/authors/${HANDLE}`,
    displayName: "Ada Lovelace",
    otherNames: [],
    canRename: false,
    actionTarget: {
      kind: "Resource",
      ref: CONTRIBUTOR_REF,
      activation: {
        resourceRef: CONTRIBUTOR_REF,
        kind: "route",
        href: `/authors/${HANDLE}`,
        unresolvedReason: null,
      },
      missing: false,
    },
  },
};

function titles(items: readonly (typeof MERIDIAN)[]): string[] {
  return items.map((item) => item.title);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function worksPage(items: readonly (typeof MERIDIAN)[]) {
  return Response.json({
    data: {
      items,
      collectionRevision: 3,
      nextCursor: { kind: "Absent" },
    },
  });
}

/**
 * The author works collection as the API contract defines it: the default order
 * omits both view keys, `title` accepts either direction, and every other pair —
 * including the explicitly written default — is an invalid request.
 */
function stubAuthorWorks(titleAscPage?: Promise<Response>) {
  const requests: string[] = [];
  const signals = new Map<string, AbortSignal>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const request = `${url.pathname}${url.search}`;
      requests.push(request);
      if (init?.signal) signals.set(request, init.signal);
      if (url.pathname === `/api/contributors/${HANDLE}`) {
        return Response.json(AUTHOR_DETAIL);
      }
      if (url.pathname !== WORKS) {
        throw new Error(`Unexpected author request: ${url.pathname}`);
      }
      const sort = url.searchParams.get("sort");
      const direction = url.searchParams.get("direction");
      if (sort === null && direction === null) {
        return worksPage(PUBLISHED_NEWEST);
      }
      if (sort === "title" && direction === "asc") {
        return titleAscPage ?? worksPage(TITLE_ASC);
      }
      if (sort === "title" && direction === "desc") {
        return worksPage(TITLE_DESC);
      }
      return Response.json(
        {
          error: {
            code: "E_INVALID_REQUEST",
            message: "Unsupported works view",
          },
        },
        { status: 400 },
      );
    }),
  );
  return { requests, signals };
}

function worksRequests(requests: readonly string[]): string[] {
  return requests.filter((request) => request.startsWith(WORKS));
}

function AuthorPane({
  initialHref,
  replaced,
}: {
  readonly initialHref: string;
  readonly replaced: string[];
}) {
  const [href, setHref] = useState(initialHref);
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  return (
    <MobileChromeProvider>
      <FeedbackProvider>
        <ShareControllerProvider>
          <LibraryPlacementControllerProvider>
            <PaneReturnMementoProvider>
              <PaneRuntimeProvider
                paneId="pane"
                visitId={VISIT_ID}
                isActive
                href={href}
                routeId="author"
                routeKey={routeKey}
                pathParams={{ handle: HANDLE }}
                canGoBack={false}
                canGoForward={false}
                onNavigatePane={noop}
                onReplacePane={(_paneId, nextHref) => {
                  replaced.push(nextHref);
                  setHref(nextHref);
                }}
                onActivateWorkspaceTarget={() => ({
                  kind: "ActivatedExisting" as const,
                  paneId: "pane",
                })}
                onGoBackPane={noop}
                onGoForwardPane={noop}
              >
                <div data-pane-id="pane" data-active="true">
                  <PaneShell
                    paneId="pane"
                    routeKey={routeKey}
                    routeHeader={{
                      kind: "section",
                      destinationId: "authors",
                      defaultFolio: "none",
                    }}
                    label="Ada Lovelace"
                    returnMementoEnabled
                    queryNavigation="in-place"
                    sizing={{
                      primaryWidthPx: 720,
                      primaryMinWidthPx: 320,
                      primaryMaxWidthPx: 1_400,
                      renderedPrimarySlotWidthPx: 720,
                      renderedPrimarySlotMinWidthPx: 320,
                      renderedPrimarySlotMaxWidthPx: 1_400,
                      fixedChromeWidthPx: 0,
                      storedWidthCorrectionPx: null,
                    }}
                    bodyMode="standard"
                    onResizePrimaryPane={noop}
                    isActive
                  >
                    <AuthorPaneBody />
                  </PaneShell>
                </div>
              </PaneRuntimeProvider>
            </PaneReturnMementoProvider>
          </LibraryPlacementControllerProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>
  );
}

function workTitles(): string[] {
  return within(screen.getByRole("list", { name: "Works" }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

function sortControl(): HTMLElement {
  return screen.getByRole("combobox", { name: "Sort by" });
}

describe("Author works domain view", () => {
  it("replaces the pane URL with the selected sort, requests exactly that view, and keeps the filter text, open filter row, and prior rows until the new page commits", async () => {
    const titleAsc = deferred<Response>();
    const { requests } = stubAuthorWorks(titleAsc.promise);
    const replaced: string[] = [];

    render(
      <AuthorPane initialHref={`/authors/${HANDLE}`} replaced={replaced} />,
    );

    await screen.findByRole("link", { name: "Meridian drift" });
    expect(workTitles()).toEqual(titles(PUBLISHED_NEWEST));

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filterInput = await screen.findByRole("searchbox", {
      name: "Filter works",
    });
    await userEvent.type(filterInput, "r");

    await userEvent.selectOptions(sortControl(), "title-asc");

    await waitFor(() =>
      expect(replaced).toEqual([`/authors/${HANDLE}?sort=title&direction=asc`]),
    );
    await waitFor(() =>
      expect(worksRequests(requests)).toEqual([
        CANONICAL_REQUEST,
        TITLE_ASC_REQUEST,
      ]),
    );
    expect(screen.getByRole("searchbox", { name: "Filter works" })).toHaveValue(
      "r",
    );
    expect(workTitles()).toEqual(titles(PUBLISHED_NEWEST));

    titleAsc.resolve(worksPage(TITLE_ASC));

    await waitFor(() => expect(workTitles()).toEqual(titles(TITLE_ASC)));
    expect(screen.getByRole("searchbox", { name: "Filter works" })).toHaveValue(
      "r",
    );
    await waitFor(() => expect(sortControl()).toHaveFocus());
  });

  it("abandons a superseded view's in-flight page and commits only the latest requested view", async () => {
    const superseded = deferred<Response>();
    const { requests, signals } = stubAuthorWorks(superseded.promise);
    const replaced: string[] = [];

    render(
      <AuthorPane initialHref={`/authors/${HANDLE}`} replaced={replaced} />,
    );

    await screen.findByRole("link", { name: "Meridian drift" });
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.selectOptions(sortControl(), "title-asc");
    await waitFor(() => expect(requests).toContain(TITLE_ASC_REQUEST));

    await userEvent.selectOptions(sortControl(), "title-desc");

    // Requesting another view abandons the in-flight page at the transport, so
    // the superseded response can never reach the committed rows.
    await waitFor(() =>
      expect(signals.get(TITLE_ASC_REQUEST)?.aborted).toBe(true),
    );
    await waitFor(() => expect(workTitles()).toEqual(titles(TITLE_DESC)));
    expect(worksRequests(requests)).toEqual([
      CANONICAL_REQUEST,
      TITLE_ASC_REQUEST,
      TITLE_DESC_REQUEST,
    ]);

    superseded.resolve(worksPage(TITLE_ASC));

    await userEvent.selectOptions(sortControl(), "published-newest");
    await waitFor(() => expect(workTitles()).toEqual(titles(PUBLISHED_NEWEST)));
  });

  it("restores the selected sort option and commits its exact view over the view-blind route seed when the pane mounts at a non-default href", async () => {
    const { requests } = stubAuthorWorks();
    const replaced: string[] = [];

    render(
      <AuthorPane
        initialHref={`/authors/${HANDLE}?sort=title&direction=asc`}
        replaced={replaced}
      />,
    );

    await screen.findByRole("link", { name: "Aurora physics" });
    expect(workTitles()).toEqual(titles(TITLE_ASC));
    // The route seed composes the author detail with the canonical works page
    // and names no view; only the requested view's own page may commit.
    expect(worksRequests(requests)).toEqual([
      CANONICAL_REQUEST,
      TITLE_ASC_REQUEST,
    ]);
    expect(replaced).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(sortControl()).toHaveDisplayValue("Title — A–Z");
  });

  it("renders the invalid works view with a reset action and issues no works request for an explicitly written default sort pair", async () => {
    const { requests } = stubAuthorWorks();
    const replaced: string[] = [];

    render(
      <AuthorPane
        initialHref={`/authors/${HANDLE}?sort=published&direction=desc`}
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid works view");
    expect(requests).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual([`/authors/${HANDLE}`]));
    await screen.findByRole("link", { name: "Meridian drift" });
    expect(worksRequests(requests)).toEqual([CANONICAL_REQUEST]);
  });

  it("announces one active control while collapsed, keeps the domain view when Escape clears the text, and returns to the default view on Clear filters", async () => {
    const { requests } = stubAuthorWorks();
    const replaced: string[] = [];

    render(
      <AuthorPane
        initialHref={`/authors/${HANDLE}?sort=title&direction=asc`}
        replaced={replaced}
      />,
    );

    await screen.findByRole("link", { name: "Aurora physics" });
    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter works" }),
      "aurora",
    );
    expect(workTitles()).toEqual(["Aurora physics"]);

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("searchbox", { name: "Filter works" })).toBeNull();
    expect(replaced).toEqual([]);
    expect(workTitles()).toEqual(titles(TITLE_ASC));

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(
      await screen.findByRole("searchbox", { name: "Filter works" }),
    ).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(replaced).toEqual([`/authors/${HANDLE}`]));
    await waitFor(() => expect(workTitles()).toEqual(titles(PUBLISHED_NEWEST)));
    expect(worksRequests(requests)).toEqual([
      CANONICAL_REQUEST,
      TITLE_ASC_REQUEST,
      CANONICAL_REQUEST,
    ]);
    await waitFor(() => expect(sortControl()).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});
