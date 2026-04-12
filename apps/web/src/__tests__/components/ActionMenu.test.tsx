import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActionMenu from "@/components/ui/ActionMenu";

describe("ActionMenu", () => {
  it("stays open when the page scrolls", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[
          { id: "edit", label: "Edit", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();

    window.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    });
  });

  it("closes when clicking outside the menu", async () => {
    const user = userEvent.setup();

    render(
      <ActionMenu
        options={[{ id: "edit", label: "Edit", onSelect: vi.fn() }]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();

    await user.click(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Edit" })
      ).not.toBeInTheDocument();
    });
  });
});
