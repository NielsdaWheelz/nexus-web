import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch } from "@/__tests__/helpers/fetch";

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
});
