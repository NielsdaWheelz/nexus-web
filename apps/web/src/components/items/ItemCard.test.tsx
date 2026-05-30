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
          prefix: "Before ",
          exact: "selected text",
          suffix: " after",
          color: "yellow",
        }}
      />,
    );

    expect(screen.getByText("selected text").tagName).toBe("MARK");
  });

  it("calls onActivate on body click but not on the menu trigger or a linked-item button", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onLinkedActivate = vi.fn();
    render(
      <ItemCard
        content={{ kind: "highlight", exact: "selected text", color: "green" }}
        actions={[{ id: "del", label: "Delete", onSelect: () => {} }]}
        linkedItems={[{ id: "c1", label: "First chat", onActivate: onLinkedActivate }]}
        onActivate={onActivate}
      />,
    );

    await user.click(screen.getByText("selected text"));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("1 linked"));
    await user.click(screen.getByRole("button", { name: "First chat" }));
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("renders linked items inside a details disclosure", async () => {
    const user = userEvent.setup();
    const onLinkedActivate = vi.fn();
    render(
      <ItemCard
        content={{ kind: "highlight", exact: "selected text", color: "blue" }}
        linkedItems={[
          { id: "c1", label: "First chat", onActivate: onLinkedActivate },
          { id: "c2", label: "Second chat", onActivate: () => {} },
        ]}
      />,
    );

    const summary = screen.getByText("2 linked");
    expect(summary.tagName).toBe("SUMMARY");

    await user.click(summary);
    await user.click(screen.getByRole("button", { name: "First chat" }));
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
  });

  it("renders the resource title", () => {
    render(<ItemCard content={{ kind: "resource", title: "Some document" }} />);

    expect(screen.getByText("Some document")).toBeVisible();
  });
});
