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
    const longExact = "A".repeat(72);
    const expectedPreview = `${"A".repeat(60)}…`;

    render(
      <LinkedItemRow
        highlight={{
          id: "h-1",
          color: "yellow",
          exact: longExact,
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

    expect(screen.getByText(expectedPreview)).toBeInTheDocument();
    // Annotation body is now shown inline on line 2
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

    // Quote-to-chat is now in ActionMenu
    const actionsButton = screen.getByRole("button", { name: "Actions" });
    await user.click(actionsButton);
    const quoteItem = await screen.findByRole("menuitem", { name: "Quote to chat" });
    await user.click(quoteItem);

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

  it("does not trigger row click when opening actions with keyboard", async () => {
    const onClick = vi.fn();
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
        onSendToChat={vi.fn()}
      />
    );

    const actionsButton = screen.getByRole("button", { name: "Actions" });
    actionsButton.focus();
    await user.keyboard("{Enter}");

    expect(onClick).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("menuitem", { name: "Quote to chat" })
    ).toBeInTheDocument();
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
});
