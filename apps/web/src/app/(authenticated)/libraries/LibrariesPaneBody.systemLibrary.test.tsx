import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  definePaneReturnGeometry,
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch } from "@/__tests__/helpers/fetch";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PaneReturnMementoCommands } from "@/lib/workspace/paneReturnMemento";

// A system-protected library (e.g. the Oracle Corpus) carries system_key and
// reports every can_* capability false. It must list like any other library but
// expose no rename/delete/share affordances. With the dossier re-homed inline
// (machine-output-in-place), a system library now carries no menu actions at
// all, so it renders no Actions trigger. A sibling owner-admin library proves
// the gate is per-library, not a blanket suppression. The list is served
// entirely from the bootstrap seed, so any client fetch is a failure signal.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LibrariesPaneBody (system library protection)", () => {
  it("offers no menu actions on a system library", async () => {
    stubFetch(async () => {
      throw new Error("unexpected client fetch; the seed is the source");
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": {
          data: [
            {
              id: "lib-oracle",
              name: "Oracle Corpus",
              owner_user_id: "user-1",
              is_default: false,
              role: "admin",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              system_key: "oracle_corpus",
              can_rename: false,
              can_delete: false,
              can_edit_entries: false,
            },
            {
              id: "lib-user",
              name: "Reading Room",
              owner_user_id: "user-1",
              is_default: false,
              role: "admin",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              system_key: null,
              can_rename: true,
              can_delete: true,
              can_edit_entries: true,
            },
          ],
          page: { has_more: false, next_cursor: null },
        },
      },
      children: <LibrariesPaneBody />,
    });

    // The system library lists normally.
    expect(await screen.findByText("Oracle Corpus")).toBeInTheDocument();
    expect(screen.getByText("Reading Room")).toBeInTheDocument();

    // The system library carries no menu actions, so it renders no actions
    // trigger; only the owner-admin sibling does.
    const actionButton = screen.getByRole("button", {
      name: "More actions for Reading Room",
    });

    // A normal owner-admin library still exposes the full mutation set, proving
    // the suppression is keyed on the capability flags, not the surface.
    await userEvent.click(actionButton);
    const userMenu = await screen.findByRole("menu");
    expect(
      within(userMenu).getByRole("menuitem", { name: "Edit library" }),
    ).toBeInTheDocument();
    expect(
      within(userMenu).getByRole("menuitem", { name: "Delete library" }),
    ).toBeInTheDocument();
    expect(
      within(userMenu).queryByRole("menuitem", { name: "Intelligence" }),
    ).not.toBeInTheDocument();
  });

  it("restores both loaded pages without another page-one request", async () => {
    const user = userEvent.setup();
    const firstPage = library("lib-first", "First-page library");
    const secondPage = library("lib-second", "Second-page library");
    const replacement = library("lib-replacement", "Replacement first page");
    let firstPageRequestCount = 0;
    stubFetch(async (input) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost",
      );
      if (url.pathname !== "/api/libraries") {
        throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
      }
      if (url.searchParams.get("cursor") === "cursor-2") {
        return Response.json({
          data: [secondPage],
          page: { has_more: false, next_cursor: null },
        });
      }
      firstPageRequestCount += 1;
      return Response.json({
        data: [replacement],
        page: { has_more: false, next_cursor: null },
      });
    });

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = "/libraries";
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = (resourceGeneration: number) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={
          resourceGeneration === 0
            ? {
                "libraries:0": {
                  data: [firstPage],
                  page: { has_more: true, next_cursor: "cursor-2" },
                },
              }
            : {}
        }
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
      >
        <LibrariesPaneBody />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(0));

    expect(await screen.findByText(firstPage.name)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Load more libraries" }),
    );
    expect(await screen.findByText(secondPage.name)).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(sourceScrollport, {
      "lib-first": 0,
      "lib-second": 120,
    });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(1));

    const restoredScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(restoredScrollport, {
      "lib-first": 0,
      "lib-second": 120,
    });
    expect(screen.getByText(firstPage.name)).toBeInTheDocument();
    expect(screen.getByText(secondPage.name)).toBeInTheDocument();
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    const restoredSecondTitle = screen.getByText(secondPage.name);
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the scoped semantic-anchor attributes are the observable restoration contract under test.
    const restoredSecondRow = restoredSecondTitle.closest<HTMLElement>(
      "[data-collection-row-id]",
    );
    expect(restoredSecondRow).toHaveAttribute(
      "data-collection-row-id",
      "lib-second",
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: row ids are collision-safe only together with their nearest published scope.
    expect(restoredSecondRow?.closest("[data-pane-return-scope]")).toHaveAttribute(
      "data-pane-return-scope",
      "Libraries.Items",
    );
    expect(restoredSecondRow?.getBoundingClientRect().top).toBe(20);
    await waitFor(() => expect(firstPageRequestCount).toBe(0));
    expect(screen.queryByText(replacement.name)).not.toBeInTheDocument();
    expect(screen.getAllByText(firstPage.name)).toHaveLength(1);
    expect(screen.getAllByText(secondPage.name)).toHaveLength(1);
  });

  it("does not recapture stale libraries while create reconciliation is pending", async () => {
    const user = userEvent.setup();
    const staleLibrary = library("lib-stale", "Stale library");
    const freshLibrary = library("lib-fresh", "Fresh library");
    let resolveCreate!: (response: Response) => void;
    const pendingCreate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const unresolvedRefresh = new Promise<Response>(() => {});
    let refreshRequestCount = 0;
    stubFetch(async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost",
      );
      if (url.pathname !== "/api/libraries") {
        throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
      }
      if (init?.method === "POST") {
        return pendingCreate;
      }
      refreshRequestCount += 1;
      if (refreshRequestCount === 1) {
        return unresolvedRefresh;
      }
      return Response.json({
        data: [freshLibrary],
        page: { has_more: false, next_cursor: null },
      });
    });

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = "/libraries";
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = (resourceGeneration: number) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={
          resourceGeneration === 0
            ? {
                "libraries:0": {
                  data: [staleLibrary],
                  page: { has_more: false, next_cursor: null },
                },
              }
            : {}
        }
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
      >
        <LibrariesPaneBody />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(0));

    expect(await screen.findByText(staleLibrary.name)).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("New library name..."),
      "Created library",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(commands).not.toBeNull());

    await act(async () => {
      resolveCreate(
        Response.json({
          data: {
            id: "lib-created",
            name: "Created library",
            color: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        }),
      );
      await Promise.resolve();
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });
    await waitFor(() => expect(refreshRequestCount).toBe(1));

    view.rerender(journey(1));

    expect(await screen.findByText(freshLibrary.name)).toBeInTheDocument();
    expect(refreshRequestCount).toBe(2);
    expect(screen.queryByText(staleLibrary.name)).not.toBeInTheDocument();
  });
});

function library(id: string, name: string) {
  return {
    id,
    name,
    owner_user_id: "user-1",
    is_default: false,
    role: "admin",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    system_key: null,
    can_rename: true,
    can_delete: true,
    can_edit_entries: true,
  };
}
