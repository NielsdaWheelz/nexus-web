import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByLabelText("Has annotation")).toBeInTheDocument();

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
});
