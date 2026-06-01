import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ItemCard from "./ItemCard";

describe("ItemCard", () => {
  it("renders the highlight exact text via the mark", () => {
    render(
      <ItemCard
        content={{
          kind: "highlight",
          snippet: { exact: "selected text", color: "yellow" },
        }}
      />,
    );

    expect(screen.getByText("selected text").tagName).toBe("MARK");
  });

  it("renders a placeholder instead of a mark when the highlight text is empty", () => {
    render(
      <ItemCard
        content={{
          kind: "highlight",
          snippet: { exact: "", color: "yellow" },
        }}
      />,
    );

    expect(screen.getByText("No selectable text").tagName).not.toBe("MARK");
  });

  it("calls onActivate on body click but not on the menu trigger or a linked-item button", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onLinkedActivate = vi.fn();
    render(
      <ItemCard
        content={{
          kind: "highlight",
          snippet: { exact: "selected text", color: "green" },
        }}
        actions={[{ id: "del", label: "Delete", onSelect: () => {} }]}
        linkedItems={[{ id: "c1", label: "First chat", onActivate: onLinkedActivate }]}
        linkedItemsSummary="1 linked chat"
        onActivate={onActivate}
      />,
    );

    await user.click(screen.getByText("selected text"));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "1 linked chat" }));
    await user.click(screen.getByRole("button", { name: "First chat" }));
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("renders linked items inside a details disclosure", async () => {
    const user = userEvent.setup();
    const onLinkedActivate = vi.fn();
    render(
      <ItemCard
        content={{
          kind: "highlight",
          snippet: { exact: "selected text", color: "blue" },
        }}
        linkedItems={[
          { id: "c1", label: "First chat", onActivate: onLinkedActivate },
          { id: "c2", label: "Second chat", onActivate: () => {} },
        ]}
      />,
    );

    const summary = screen.getByRole("button", { name: "2 linked" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveAttribute("aria-controls");

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "First chat" }));
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
  });

  it("renders the resource title", () => {
    render(<ItemCard content={{ kind: "resource", title: "Some document" }} />);

    expect(screen.getByText("Some document")).toBeVisible();
  });

  it("does not render an inert body button when activation is omitted", () => {
    render(<ItemCard content={{ kind: "resource", title: "Static document" }} />);

    expect(screen.queryByRole("button", { name: "Static document" })).toBeNull();
    expect(screen.getByText("Static document")).toBeVisible();
  });
});
