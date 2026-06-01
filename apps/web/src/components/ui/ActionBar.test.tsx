import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ActionBar from "@/components/ui/ActionBar";

describe("ActionBar", () => {
  it("renders each option as a named icon button and invokes its onSelect", async () => {
    const user = userEvent.setup();
    const onQuote = vi.fn();
    render(
      <ActionBar
        options={[
          { id: "quote-new", label: "Quote to new chat", icon: <span aria-hidden>q</span>, onSelect: onQuote },
          { id: "delete", label: "Delete highlight", icon: <span aria-hidden>x</span>, tone: "danger", separatorBefore: true, onSelect: vi.fn() },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Quote to new chat" }));
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete highlight" })).toBeInTheDocument();
  });

  it("reflects pressed state via aria-pressed", () => {
    render(
      <ActionBar
        options={[
          { id: "edit-bounds", label: "Cancel edit bounds", icon: <span aria-hidden>e</span>, pressed: true, onSelect: vi.fn() },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel edit bounds" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens an anchored popover for a render option and dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(
      <ActionBar
        options={[
          {
            id: "color",
            label: "Highlight color",
            icon: <span aria-hidden>c</span>,
            render: ({ closeMenu }) => (
              <button type="button" onClick={closeMenu}>
                Apply green
              </button>
            ),
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Highlight color" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(await screen.findByRole("button", { name: "Apply green" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Apply green" })).not.toBeInTheDocument(),
    );
  });

  it("renders nothing when there are no options", () => {
    render(<ActionBar options={[]} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});
