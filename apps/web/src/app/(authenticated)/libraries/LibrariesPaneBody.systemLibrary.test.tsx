import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch } from "@/__tests__/helpers/fetch";

// A system-protected library (e.g. the Oracle Corpus) carries system_key and
// reports every can_* capability false. It must list like any other library but
// expose no rename/delete/share affordances — only the read-only Intelligence
// action. A sibling owner-admin library proves the gate is per-library, not a
// blanket suppression. The list is served entirely from the bootstrap seed, so
// any client fetch is a failure signal.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LibrariesPaneBody (system library protection)", () => {
  it("offers only the read-only action on a system library", async () => {
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

    // Rows render in seed order: [0] = Oracle Corpus (system), [1] = Reading Room.
    const actionButtons = screen.getAllByRole("button", { name: "Actions" });

    // Opening the system library's action menu offers Intelligence only.
    await userEvent.click(actionButtons[0]);
    const systemMenu = await screen.findByRole("menu");
    expect(
      within(systemMenu).getByRole("menuitem", { name: "Intelligence" }),
    ).toBeInTheDocument();
    expect(
      within(systemMenu).queryByRole("menuitem", { name: "Edit library" }),
    ).not.toBeInTheDocument();
    expect(
      within(systemMenu).queryByRole("menuitem", { name: "Delete library" }),
    ).not.toBeInTheDocument();

    // Close the system menu before opening the sibling's.
    await userEvent.keyboard("{Escape}");

    // A normal owner-admin library still exposes the full mutation set, proving
    // the suppression is keyed on the capability flags, not the surface.
    await userEvent.click(actionButtons[1]);
    const userMenu = await screen.findByRole("menu");
    expect(
      within(userMenu).getByRole("menuitem", { name: "Edit library" }),
    ).toBeInTheDocument();
    expect(
      within(userMenu).getByRole("menuitem", { name: "Delete library" }),
    ).toBeInTheDocument();
  });
});
