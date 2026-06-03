import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ActionBar from "@/components/ui/ActionBar";

describe("ActionBar", () => {
  it("renders each option as a named icon button and invokes its onSelect", async () => {
    const user = userEvent.setup();
    const onQuote = vi.fn();
    render(
      <ActionBar
        label="Highlight actions"
        options={[
          { id: "quote-new", label: "Quote to new chat", icon: <span aria-hidden>q</span>, onSelect: onQuote },
          { id: "delete", label: "Delete highlight", icon: <span aria-hidden>x</span>, tone: "danger", separatorBefore: true, onSelect: vi.fn() },
        ]}
      />,
    );

    const group = screen.getByRole("group", { name: "Highlight actions" });
    const quoteButton = screen.getByRole("button", { name: "Quote to new chat" });
    expect(group).toContainElement(quoteButton);
    expect(quoteButton).toHaveAttribute("title", "Quote to new chat");

    await user.click(quoteButton);
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote).toHaveBeenCalledWith({ triggerEl: quoteButton });
    expect(screen.getByRole("button", { name: "Delete highlight" })).toBeInTheDocument();
  });

  it("does not invoke disabled actions", () => {
    const onDelete = vi.fn();
    render(
      <ActionBar
        options={[
          { id: "delete", label: "Delete highlight", icon: <span aria-hidden>x</span>, disabled: true, onSelect: onDelete },
          {
            id: "color",
            label: "Highlight color",
            icon: <span aria-hidden>c</span>,
            disabled: true,
            render: () => <button type="button">Apply green</button>,
          },
        ]}
      />,
    );

    const deleteButton = screen.getByRole("button", { name: "Delete highlight" });
    const colorButton = screen.getByRole("button", { name: "Highlight color" });
    expect(deleteButton).toBeDisabled();
    expect(colorButton).toBeDisabled();

    fireEvent.click(deleteButton);
    fireEvent.click(colorButton);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Apply green" })).not.toBeInTheDocument();
  });

  it("keeps action clicks inside the bar", async () => {
    const user = userEvent.setup();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <ActionBar
          options={[
            { id: "rename", label: "Rename fork", icon: <span aria-hidden>r</span>, onSelect: vi.fn() },
            {
              id: "color",
              label: "Highlight color",
              icon: <span aria-hidden>c</span>,
              render: () => <button type="button">Apply green</button>,
            },
          ]}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Rename fork" }));
    await user.click(screen.getByRole("button", { name: "Highlight color" }));
    expect(onParentClick).not.toHaveBeenCalled();
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
    let triggerEl: HTMLButtonElement | null = null;
    render(
      <ActionBar
        options={[
          {
            id: "color",
            label: "Highlight color",
            icon: <span aria-hidden>c</span>,
            render: ({ closeMenu, triggerEl: trigger }) => {
              triggerEl = trigger;
              return (
                <button type="button" onClick={closeMenu}>
                  Apply green
                </button>
              );
            },
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Highlight color" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(await screen.findByRole("button", { name: "Apply green" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(triggerEl).toBe(trigger);

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
