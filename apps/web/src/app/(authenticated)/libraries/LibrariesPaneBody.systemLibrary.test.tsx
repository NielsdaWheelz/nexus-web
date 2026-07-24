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

const OWNER_USER_HANDLE =
  "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

// A system-protected library (e.g. the Oracle Corpus) carries systemKey and
// reports every mutation capability false. It must list like any other library,
// retain its member-only Share surface, and expose no rename/delete controls. A
// sibling owner-admin library proves the mutation gate is per-library. The list is served
// entirely from the bootstrap seed, so any client fetch is a failure signal.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LibrariesPaneBody (system library protection)", () => {
  it("offers Share but no mutation actions on a system library", async () => {
    stubFetch(async (input) => {
      const raw = input instanceof Request ? input.url : String(input);
      if (new URL(raw, "http://localhost").pathname === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
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
              color: null,
              ownerUserHandle: OWNER_USER_HANDLE,
              isDefault: false,
              role: "admin",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              systemKey: "oracle_corpus",
              canRename: false,
              canDelete: false,
              canEditEntries: false,
              canManageMembers: false,
              canTransferOwnership: false,
            },
            {
              id: "lib-user",
              name: "Reading Room",
              color: null,
              ownerUserHandle: OWNER_USER_HANDLE,
              isDefault: false,
              role: "admin",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              systemKey: null,
              canRename: true,
              canDelete: true,
              canEditEntries: true,
              canManageMembers: true,
              canTransferOwnership: true,
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

    const systemActionButton = screen.getByRole("button", {
      name: "More actions for Oracle Corpus",
    });
    await userEvent.click(systemActionButton);
    const systemMenu = await screen.findByRole("menu");
    expect(
      within(systemMenu).getByRole("menuitem", { name: "Share…" }),
    ).toBeInTheDocument();
    expect(
      within(systemMenu).queryByRole("menuitem", { name: "Settings" }),
    ).not.toBeInTheDocument();
    expect(
      within(systemMenu).queryByRole("menuitem", { name: "Delete library" }),
    ).not.toBeInTheDocument();

    const actionButton = screen.getByRole("button", {
      name: "More actions for Reading Room",
    });

    // A normal owner-admin library still exposes the full mutation set, proving
    // the suppression is keyed on the capability flags, not the surface.
    await userEvent.click(actionButton);
    const userMenu = await screen.findByRole("menu");
    expect(
      within(userMenu).getByRole("menuitem", { name: "Settings" }),
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
      if (url.pathname === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
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
      if (url.pathname === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
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
          data: library("lib-created", "Created library"),
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
    color: null,
    ownerUserHandle: OWNER_USER_HANDLE,
    isDefault: false,
    role: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    systemKey: null,
    canRename: true,
    canDelete: true,
    canEditEntries: true,
    canManageMembers: true,
    canTransferOwnership: true,
  };
}
