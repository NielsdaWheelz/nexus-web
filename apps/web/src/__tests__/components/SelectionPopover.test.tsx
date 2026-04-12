import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import SelectionPopover from "@/components/SelectionPopover";

function createContainerRef(): RefObject<HTMLElement | null> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { current: container };
}

describe("SelectionPopover", () => {
  it("shows ask-in-chat action when onQuoteToChat is provided", async () => {
    const onCreateHighlight = vi.fn();
    const onQuoteToChat = vi.fn();
    const user = userEvent.setup();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToChat={onQuoteToChat}
        onDismiss={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Ask in chat" }));

    expect(onQuoteToChat).toHaveBeenCalledTimes(1);
    expect(onQuoteToChat).toHaveBeenCalledWith("yellow");
    expect(onCreateHighlight).not.toHaveBeenCalled();
  });

  it("passes the currently selected color to ask-in-chat", async () => {
    const onCreateHighlight = vi.fn();
    const onQuoteToChat = vi.fn();
    const user = userEvent.setup();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToChat={onQuoteToChat}
        onDismiss={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Blue" }));
    await user.click(screen.getByRole("button", { name: "Ask in chat" }));

    expect(onCreateHighlight).toHaveBeenCalledWith("blue");
    expect(onQuoteToChat).toHaveBeenCalledWith("blue");
  });

  it("hides ask-in-chat when no quote callback is provided", () => {
    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Ask in chat" })).not.toBeInTheDocument();
  });
});
