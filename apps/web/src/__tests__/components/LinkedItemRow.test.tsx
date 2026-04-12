import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LinkedItemRow from "@/components/LinkedItemRow";

describe("LinkedItemRow", () => {
  it("keeps focus/scroll/quote hooks intact for shared row interactions", async () => {
    const onClick = vi.fn();
    const onMouseEnter = vi.fn();
    const onMouseLeave = vi.fn();
    const onSendToChat = vi.fn();

    render(
      <LinkedItemRow
        highlight={{
          id: "h-1",
          color: "yellow",
          exact: "Highlighted passage from the article",
          annotation: { id: "ann-1", body: "has note" },
        }}
        isFocused={false}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onSendToChat={onSendToChat}
      />
    );

    const user = userEvent.setup();
    const row = screen
      .getAllByRole("button")
      .find((element) => element.getAttribute("aria-pressed") !== null);
    if (!row) {
      throw new Error("Expected linked-item row button to be rendered");
    }

    expect(screen.getByText("Highlighted passage from the article")).toBeInTheDocument();
    expect(screen.getByText("has note")).toBeInTheDocument();

    await user.hover(row);
    expect(onMouseEnter).toHaveBeenCalledWith("h-1");

    await user.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith("h-1");

    row.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);

    await user.unhover(row);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);

    // Quote-to-chat is a visible icon button on the row
    const chatButton = screen.getByRole("button", { name: "Send to chat" });
    await user.click(chatButton);

    expect(onSendToChat).toHaveBeenCalledTimes(1);
    expect(onSendToChat).toHaveBeenCalledWith("h-1");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("omits action menu when no callbacks or options given", () => {
    render(
      <LinkedItemRow
        highlight={{
          id: "h-2",
          color: "blue",
          exact: "Short exact text",
          annotation: null,
        }}
        isFocused
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Actions" })
    ).not.toBeInTheDocument();
  });

  it("shows placeholder when no annotation", () => {
    render(
      <LinkedItemRow
        highlight={{
          id: "h-3",
          color: "green",
          exact: "Some text",
          annotation: null,
        }}
        isFocused={false}
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
      />
    );

    expect(screen.getByText("Add a note\u2026")).toBeInTheDocument();
  });

  it("does not trigger row click when clicking chat button", async () => {
    const onClick = vi.fn();
    const onSendToChat = vi.fn();
    const user = userEvent.setup();

    render(
      <LinkedItemRow
        highlight={{
          id: "h-keyboard-actions",
          color: "yellow",
          exact: "Keyboard action row",
          annotation: null,
        }}
        isFocused={false}
        onClick={onClick}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onSendToChat={onSendToChat}
      />
    );

    const chatButton = screen.getByRole("button", { name: "Send to chat" });
    await user.click(chatButton);

    expect(onClick).not.toHaveBeenCalled();
    expect(onSendToChat).toHaveBeenCalledWith("h-keyboard-actions");
  });

  it("enters inline edit on annotation click and saves on blur", async () => {
    const onAnnotationSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <LinkedItemRow
        highlight={{
          id: "h-4",
          color: "yellow",
          exact: "Some text",
          annotation: null,
        }}
        isFocused={false}
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onAnnotationSave={onAnnotationSave}
      />
    );

    // Click placeholder to edit
    await user.click(screen.getByText("Add a note\u2026"));

    const textarea = screen.getByLabelText("Annotation");
    expect(textarea).toBeInTheDocument();

    await user.type(textarea, "My note");
    // Blur triggers save
    textarea.blur();

    await waitFor(() => {
      expect(onAnnotationSave).toHaveBeenCalledWith("h-4", "My note");
    });
  });

  it("cancels inline edit on Escape", async () => {
    const onAnnotationSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <LinkedItemRow
        highlight={{
          id: "h-5",
          color: "pink",
          exact: "Some text",
          annotation: { id: "ann-5", body: "existing note" },
        }}
        isFocused={false}
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onAnnotationSave={onAnnotationSave}
      />
    );

    // Click annotation to edit
    await user.click(screen.getByText("existing note"));

    const textarea = screen.getByLabelText("Annotation");
    await user.clear(textarea);
    await user.type(textarea, "changed");
    await user.keyboard("{Escape}");

    // Should not save, and textarea should be gone
    expect(onAnnotationSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Annotation")).not.toBeInTheDocument();
    // Original text is restored
    expect(screen.getByText("existing note")).toBeInTheDocument();
  });

  it("saves on Cmd+Enter", async () => {
    const onAnnotationSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <LinkedItemRow
        highlight={{
          id: "h-6",
          color: "blue",
          exact: "Some text",
          annotation: null,
        }}
        isFocused={false}
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onAnnotationSave={onAnnotationSave}
      />
    );

    await user.click(screen.getByText("Add a note\u2026"));
    const textarea = screen.getByLabelText("Annotation");
    await user.type(textarea, "quick note");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(onAnnotationSave).toHaveBeenCalledWith("h-6", "quick note");
    });
  });

  it("renders linked conversations and opens selected conversation", async () => {
    const onOpenConversation = vi.fn();
    const user = userEvent.setup();

    render(
      <LinkedItemRow
        highlight={{
          id: "h-7",
          color: "yellow",
          exact: "Some text",
          annotation: null,
          linked_conversations: [
            { conversation_id: "conv-1", title: "Open thread" },
            { conversation_id: "conv-2", title: "Follow-up" },
          ],
        }}
        isFocused={false}
        onClick={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onOpenConversation={onOpenConversation}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open thread" }));
    expect(onOpenConversation).toHaveBeenCalledWith("conv-1", "Open thread");
    expect(screen.getByRole("button", { name: "Follow-up" })).toBeInTheDocument();
  });
});
