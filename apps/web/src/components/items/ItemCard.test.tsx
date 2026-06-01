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

  it("calls onActivate on body click but not on the menu trigger or a linked-chat button", async () => {
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
        expanded
        onActivate={onActivate}
      />,
    );

    await user.click(screen.getByText("selected text"));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "First chat" }));
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("shows linked chats as a scent line when blurred and a clickable list when focused", () => {
    const content = {
      kind: "highlight" as const,
      snippet: { exact: "selected text", color: "blue" as const },
    };
    const linkedItems = [
      { id: "c1", label: "First chat", onActivate: () => {} },
      { id: "c2", label: "Second chat", onActivate: () => {} },
    ];
    const { rerender } = render(<ItemCard content={content} linkedItems={linkedItems} />);

    expect(screen.getByText("First chat · Second chat")).toBeVisible();
    expect(screen.queryByRole("button", { name: "First chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: /linked/ })).toBeNull();

    rerender(<ItemCard content={content} linkedItems={linkedItems} expanded />);

    expect(screen.getByRole("list", { name: "2 linked chats" })).toBeVisible();
    expect(screen.getByRole("button", { name: "First chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Second chat" })).toBeVisible();
    expect(screen.queryByText("First chat · Second chat")).toBeNull();
  });

  it("labels a single focused chat with singular grammar", () => {
    render(
      <ItemCard
        content={{ kind: "highlight", snippet: { exact: "selected text", color: "blue" } }}
        linkedItems={[{ id: "c1", label: "Only chat", onActivate: () => {} }]}
        expanded
      />,
    );

    expect(screen.getByRole("list", { name: "1 linked chat" })).toBeVisible();
  });

  it("renders no linked-chat element when there are none, blurred or focused", () => {
    const content = {
      kind: "highlight" as const,
      snippet: { exact: "selected text", color: "blue" as const },
    };
    const { rerender } = render(<ItemCard content={content} />);

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();

    rerender(<ItemCard content={content} expanded />);

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
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
