import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import LinkedItemRow from "@/components/LinkedItemRow";

describe("LinkedItemRow", () => {
  it("keeps the row itself clickable and hoverable", async () => {
    const onClick = vi.fn();
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    const user = userEvent.setup();

    render(
      <LinkedItemRow
        highlight={{
          id: "highlight-1",
          color: "yellow",
          exact: "Highlighted passage from the article",
          annotation: null,
        }}
        isFocused={false}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
    );

    const row = screen.getByRole("button", { pressed: false });
    expect(row).toHaveTextContent("Highlighted passage from the article");

    await user.hover(row);
    expect(onMouseEnter).toHaveBeenCalledWith("highlight-1");

    await user.click(row);
    expect(onClick).toHaveBeenCalledWith("highlight-1");

    await user.unhover(row);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
  });

  it("shows compact status affordances for note and linked chats", () => {
    render(
      <LinkedItemRow
        highlight={{
          id: "highlight-2",
          color: "blue",
          exact: "Compact preview",
          annotation: { id: "annotation-1", body: "has note" },
          linked_conversations: [
            { conversation_id: "conversation-1", title: "Open thread" },
            { conversation_id: "conversation-2", title: "Follow-up" },
          ],
        }}
        isFocused
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent("Compact preview");
    expect(screen.getByTitle("Has note")).toBeInTheDocument();
    expect(screen.getByTitle("2 linked chats")).toHaveTextContent("2");
  });

  it("does not render inline note text, linked conversation rows, or row action chrome", () => {
    render(
      <LinkedItemRow
        highlight={{
          id: "highlight-3",
          color: "green",
          exact: "Clean rail row",
          annotation: { id: "annotation-3", body: "This note moved to the inspector." },
          linked_conversations: [{ conversation_id: "conversation-3", title: "Context thread" }],
        }}
        isFocused={false}
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
      />
    );

    expect(screen.getByText("Clean rail row")).toBeInTheDocument();
    expect(screen.queryByText("This note moved to the inspector.")).not.toBeInTheDocument();
    expect(screen.queryByText("Context thread")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });
});
