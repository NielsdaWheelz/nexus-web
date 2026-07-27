import { render, screen, waitFor } from "@testing-library/react";
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

function pageItem() {
  return {
    ref: PAGE_REF,
    scheme: "page",
    id: PAGE_ID,
    label: "Today",
    summary: "",
    route: `/pages/${PAGE_ID}`,
    activation: {
      resource_ref: PAGE_REF,
      kind: "route",
      href: `/pages/${PAGE_ID}`,
      unresolved_reason: null,
    },
    missing: false,
    capabilities: {
      user_relation: {
        user_link_source: false,
        user_link_target: "none",
        note_reference_target: false,
      },
      sharing: "None",
      library_placement: "None",
      attachable: false,
      chat_subject: "none",
      readable: "none",
      inspectable: "none",
      citable_result_type: null,
      citation_output_source: false,
      app_search_scope: false,
      conversation_search_scope: false,
      prompt_render: "none",
      expansion_policy: "none",
      expandable: false,
      adjacency_source: true,
      adjacency_target: true,
    },
    version_by_lane: { title: 1, outgoing_edges: 1 },
  };
}

function App({
  publish,
}: {
  publish: (update: PanePrimaryChromePublicationUpdate) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={"visit" as never} routeKey="page">
        <PaneRuntimeProvider
          paneId="pane"
          visitId={"visit" as never}
          isActive
          href={`/pages/${PAGE_ID}`}
          routeId="page"
          pathParams={{ pageId: PAGE_ID }}
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={vi.fn(() => ({ kind: "ActivatedExisting" as const, paneId: "pane" }))}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          <PanePrimaryChromeProvider publish={publish}>
            <PagePaneBody
              pageIdOverride={PAGE_ID}
              initialPage={{
                id: PAGE_ID,
                title: "Today",
                actionTarget: routeResourceActionSubject({
                  scheme: "page",
                  id: PAGE_ID,
                  href: `/pages/${PAGE_ID}`,
                }),
                dailyNote: { localDate: "2026-07-26" },
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
  it("loads the flat surface and retains daily-note composition", async () => {
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
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
    }));

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
  });
});
