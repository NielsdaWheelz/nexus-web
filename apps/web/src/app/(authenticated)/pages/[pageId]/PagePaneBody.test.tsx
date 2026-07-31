import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import type { PanePrimaryChromePublicationUpdate } from "@/lib/panes/panePublications";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import PagePaneBody from "./PagePaneBody";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_REF = `page:${PAGE_ID}`;

function pageItem(pageId = PAGE_ID) {
  const pageRef = `page:${pageId}`;
  return {
    ref: pageRef,
    scheme: "page",
    id: pageId,
    label: "Today",
    summary: "",
    route: `/pages/${pageId}`,
    activation: {
      resourceRef: pageRef,
      kind: "route",
      href: `/pages/${pageId}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1, outgoing_edges: 1 },
  };
}

function App({
  publish,
  pageId = PAGE_ID,
}: {
  publish: (update: PanePrimaryChromePublicationUpdate) => void;
  pageId?: string;
}) {
  return (
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={"visit" as never} routeKey="page">
        <PaneRuntimeProvider
          paneId="pane"
          visitId={"visit" as never}
          isActive
          href={`/pages/${pageId}`}
          routeId="page"
          pathParams={{ pageId }}
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={vi.fn(() => ({
            kind: "ActivatedExisting" as const,
            paneId: "pane",
          }))}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          <PanePrimaryChromeProvider publish={publish}>
            <PagePaneBody
              pageIdOverride={pageId}
              initialPage={{
                id: pageId,
                title: "Today",
                actionTarget: routeResourceActionSubject({
                  scheme: "page",
                  id: pageId,
                  href: `/pages/${pageId}`,
                }),
                dailyPage: { localDate: "2026-07-26" },
              }}
            />
          </PanePrimaryChromeProvider>
        </PaneRuntimeProvider>
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("PagePaneBody", () => {
  it("does not restore stale filter rows after an A to B to A source replacement", async () => {
    const pageBId = "33333333-3333-4333-8333-333333333333";
    let pageAReads = 0;
    let resolveSecondPageA!: (response: Response) => void;
    let resolvePageB!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = decodeURIComponent(
          new URL(String(input), "http://localhost").pathname,
        );
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        if (path.includes(`page:${pageBId}`)) {
          return await new Promise<Response>((resolve) => {
            resolvePageB = resolve;
          });
        }
        if (path.includes(PAGE_REF)) {
          pageAReads += 1;
          if (pageAReads === 1) {
            return Response.json({
              data: {
                source: {
                  item: pageItem(),
                  content: { kind: "page_title", title: "Page A" },
                },
                ordered_items: [],
              },
            });
          }
          return await new Promise<Response>((resolve) => {
            resolveSecondPageA = resolve;
          });
        }
        return Response.json({ data: [] });
      }),
    );
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    const view = render(<App publish={publish} />);
    const latestSearch = () =>
      publish.mock.calls
        .map(([update]) => update.publication?.search)
        .findLast((search) => search?.kind === "FilterRows");

    await waitFor(() =>
      expect(latestSearch()?.rowStatus.kind).toBe("Complete"),
    );
    view.rerender(<App publish={publish} pageId={pageBId} />);
    await waitFor(() => {
      const search = latestSearch();
      expect(search?.rowStatus).toMatchObject({
        kind: "Partial",
        visibleCount: 0,
        loadedCount: 0,
      });
    });

    const publicationsBeforeReturn = publish.mock.calls.length;
    view.rerender(<App publish={publish} />);
    await waitFor(() => {
      expect(publish.mock.calls.length).toBeGreaterThan(
        publicationsBeforeReturn,
      );
      const search = latestSearch();
      expect(search?.query).toBe("");
      expect(search?.rowStatus).toMatchObject({
        kind: "Partial",
        visibleCount: 0,
        loadedCount: 0,
      });
    });

    await act(async () => {
      resolveSecondPageA(
        Response.json({
          data: {
            source: {
              item: pageItem(),
              content: { kind: "page_title", title: "Page A refreshed" },
            },
            ordered_items: [],
          },
        }),
      );
    });
    await waitFor(() =>
      expect(latestSearch()?.rowStatus.kind).toBe("Complete"),
    );
    await act(async () => {
      resolvePageB(
        Response.json({
          data: {
            source: {
              item: pageItem(pageBId),
              content: { kind: "page_title", title: "Stale Page B" },
            },
            ordered_items: [],
          },
        }),
      );
    });
    expect(screen.queryByDisplayValue("Stale Page B")).not.toBeInTheDocument();
  });

  it("announces a Partial no-match before the surface commits", async () => {
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    let resolveSurface!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/api/notes/dawn-write") {
          return Response.json({ write: null });
        }
        if (path.startsWith("/api/resource-items/")) {
          return await new Promise<Response>((resolve) => {
            resolveSurface = resolve;
          });
        }
        return Response.json({ data: [] });
      }),
    );
    render(<App publish={publish} />);
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.kind === "FilterRows"),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected PagePaneBody to publish FilterRows.");
    }
    act(() => search.onQueryChange("missing"));
    expect(
      await screen.findByText("No matching item found so far."),
    ).toHaveAttribute("role", "status");
    await act(async () => {
      resolveSurface(
        Response.json({
          data: {
            source: {
              item: pageItem(),
              content: { kind: "page_title", title: "Today" },
            },
            ordered_items: [],
          },
        }),
      );
    });
    await screen.findByRole("textbox", { name: "Page title" });
  });

  it("loads the flat surface and retains daily-note composition", async () => {
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/notes/dawn-write") {
        return Response.json({
          write: {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            body_md: "A quiet morning note.",
            generated_at: "2026-07-26T06:00:00.000Z",
            dismissed_at: null,
          },
        });
      }
      return Response.json({
        data: {
          source: {
            item: pageItem(),
            content: { kind: "page_title", title: "Today" },
          },
          ordered_items: [],
        },
      });
      }),
    );

    render(<App publish={publish} />);

    expect(
      await screen.findByRole("textbox", { name: "Page title" }),
    ).toHaveValue("Today");
    expect(
      screen.getByRole("region", { name: "Ordered resources" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add a note" })).toBeVisible();
    expect(await screen.findByTestId("dawn-write-block")).toHaveTextContent(
      "A quiet morning note.",
    );

    await waitFor(() => {
      const actionIds = publish.mock.calls.flatMap(([update]) => {
        const menu = update.publication?.menu;
        if (!menu) return [];
        const actions =
          menu.kind === "ResourceMenu" ? menu.groups.view : menu.actions;
        return actions.map((action) => action.id);
      });
      expect(actionIds).toEqual(
        expect.arrayContaining([
          "ViewAction.Page.OpenYesterday",
          "ViewAction.Page.OpenTomorrow",
        ]),
      );
    });

    const pageSearch = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((search) => search !== undefined);
    if (pageSearch?.kind !== "FilterRows") {
      throw new Error("Expected PagePaneBody to publish FilterRows.");
    }
    expect(pageSearch).toMatchObject({
      kind: "FilterRows",
      query: "",
      inputLabel: "Filter page items",
      placeholder: "Filter items",
    });
    expect(pageSearch).not.toHaveProperty("matchCase");
    expect(pageSearch).not.toHaveProperty("wholeWord");
    expect(pageSearch).not.toHaveProperty("onStep");
    expect(pageSearch).not.toHaveProperty("onShowResults");

    act(() => pageSearch?.onQueryChange("missing"));
    expect(
      await screen.findByText("No items match this filter."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Filtered view is inspection only — clear Filter to edit.",
      ),
    ).toHaveAttribute("role", "status");
    expect(
      screen.getByRole("textbox", { name: "Page title" }),
    ).not.toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Add a note" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add item" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.query === "missing"),
      ).toBeDefined(),
    );
      const updatedSearch = publish.mock.calls
        .map(([update]) => update.publication?.search)
      .findLast((search) => search?.query === "missing");
    if (updatedSearch?.kind !== "FilterRows") {
      throw new Error("Expected PagePaneBody to retain FilterRows.");
    }
    expect(updatedSearch.rowStatus).toMatchObject({
      kind: "Complete",
      visibleCount: 0,
      unit: { singular: "item", plural: "items" },
    });
    expect(updatedSearch.rowStatus).toHaveProperty(
      "totalCount",
      pageSearch.rowStatus.kind === "Complete"
        ? pageSearch.rowStatus.totalCount
        : undefined,
    );
  });
});
