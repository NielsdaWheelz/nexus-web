import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch } from "@/__tests__/helpers/fetch";

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
        },
      },
      children: <LibrariesPaneBody />,
    });

    // The system library lists normally.
    expect(await screen.findByText("Oracle Corpus")).toBeInTheDocument();
    expect(screen.getByText("Reading Room")).toBeInTheDocument();

    // The system library carries no menu actions, so it renders no Actions
    // trigger; only the owner-admin sibling does.
    const actionButtons = screen.getAllByRole("button", { name: "Actions" });
    expect(actionButtons).toHaveLength(1);

    // A normal owner-admin library still exposes the full mutation set, proving
    // the suppression is keyed on the capability flags, not the surface.
    await userEvent.click(actionButtons[0]);
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
});
