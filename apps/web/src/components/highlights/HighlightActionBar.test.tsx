import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import HighlightActionBar from "./HighlightActionBar";

const highlight: AnchoredReaderRow = { id: "h1", exact: "hello", color: "yellow" };

afterEach(() => {
  vi.restoreAllMocks();
});

function setupExisting(
  overrides: Record<string, unknown> = {},
  presentation: "bar" | "menu" = "bar",
) {
  const handlers = {
    onSelectColor: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onQuoteToNewChat: vi.fn(),
    onQuoteToExistingChat: vi.fn(),
    onToggleEditBounds: vi.fn(),
  };
  render(
    <FeedbackProvider>
      <HighlightActionBar
        variant="existing"
        presentation={presentation}
        highlight={highlight}
        canQuoteToChat
        isReflowable
        isEditingBounds={false}
        {...handlers}
        {...overrides}
      />
    </FeedbackProvider>,
  );
  return handlers;
}

describe("HighlightActionBar — existing", () => {
  it("deletes only after the confirm prompt is accepted", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const handlers = setupExisting();

    await user.click(screen.getByRole("button", { name: "Delete highlight" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(handlers.onDelete).toHaveBeenCalledTimes(1));
  });

  it("does not delete when the confirm prompt is dismissed", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const handlers = setupExisting();

    await user.click(screen.getByRole("button", { name: "Delete highlight" }));
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it("changes color through the picker popover", async () => {
    const user = userEvent.setup();
    const handlers = setupExisting();

    await user.click(screen.getByRole("button", { name: "Highlight color" }));
    await user.click(await screen.findByRole("button", { name: "Green" }));
    await waitFor(() => expect(handlers.onSelectColor).toHaveBeenCalledWith("green"));
  });

  it("toggles edit-bounds", async () => {
    const user = userEvent.setup();
    const handlers = setupExisting();

    await user.click(screen.getByRole("button", { name: "Edit bounds" }));
    expect(handlers.onToggleEditBounds).toHaveBeenCalledTimes(1);
  });

  it("renders the note action only when enabled and fires its handler", async () => {
    const user = userEvent.setup();
    const onAddNote = vi.fn();
    setupExisting({ canAddNote: true, onAddNote });

    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it("omits the note action by default", () => {
    setupExisting();
    expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
  });
});

describe("HighlightActionBar — existing (menu)", () => {
  it("collapses into a single trigger with no inline buttons", () => {
    setupExisting({}, "menu");

    const trigger = screen.getByRole("button", { name: "Highlight actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("button", { name: "Highlight color" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask in new chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask in existing chat…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit bounds" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete highlight" })).toBeNull();
  });

  it("reveals the full action set once opened", async () => {
    const user = userEvent.setup();
    setupExisting({}, "menu");

    await user.click(screen.getByRole("button", { name: "Highlight actions" }));

    expect(screen.getByRole("group", { name: "Highlight color" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ask in new chat" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ask in existing chat…" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Edit bounds" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitem", { name: "Delete highlight" })).toBeInTheDocument();
  });

  it("deletes only after the confirm prompt is accepted", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const handlers = setupExisting({}, "menu");

    await user.click(screen.getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete highlight" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(handlers.onDelete).toHaveBeenCalledTimes(1));
  });

  it("does not delete when the confirm prompt is dismissed", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const handlers = setupExisting({}, "menu");

    await user.click(screen.getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete highlight" }));
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it("toggles edit-bounds", async () => {
    const user = userEvent.setup();
    const handlers = setupExisting({}, "menu");

    await user.click(screen.getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Edit bounds" }));
    expect(handlers.onToggleEditBounds).toHaveBeenCalledTimes(1);
  });

  it("reveals the note action in the menu when enabled", async () => {
    const user = userEvent.setup();
    const onAddNote = vi.fn();
    setupExisting({ canAddNote: true, onAddNote }, "menu");

    await user.click(screen.getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Add note" }));
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it("renders no trigger when there are no actions", () => {
    setupExisting(
      {
        highlight: { id: "h1", exact: "hello", color: "yellow", is_owner: false },
        canQuoteToChat: false,
      },
      "menu",
    );

    expect(screen.queryByRole("button", { name: "Highlight actions" })).toBeNull();
  });
});

describe("HighlightActionBar — selection", () => {
  it("offers color and quotes but never edit-bounds or delete", async () => {
    const user = userEvent.setup();
    const onSelectColor = vi.fn();
    render(
      <FeedbackProvider>
        <HighlightActionBar
          variant="selection"
          selectionColor="yellow"
          canQuoteToChat
          busy={false}
          onSelectColor={onSelectColor}
          onQuoteToNewChat={vi.fn()}
          onQuoteToExistingChat={vi.fn()}
        />
      </FeedbackProvider>,
    );

    expect(screen.getByRole("button", { name: "Ask in new chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete highlight" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit bounds" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Highlight color" }));
    await user.click(await screen.findByRole("button", { name: "Green" }));
    expect(onSelectColor).toHaveBeenCalledWith("green");
  });

  it("renders the note action when enabled and fires its handler", async () => {
    const user = userEvent.setup();
    const onAddNote = vi.fn();
    render(
      <FeedbackProvider>
        <HighlightActionBar
          variant="selection"
          selectionColor="yellow"
          canQuoteToChat
          canAddNote
          busy={false}
          onSelectColor={vi.fn()}
          onAddNote={onAddNote}
          onQuoteToNewChat={vi.fn()}
          onQuoteToExistingChat={vi.fn()}
        />
      </FeedbackProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it("disables every create/quote action while a selection action is busy", async () => {
    const onSelectColor = vi.fn();
    const onQuoteToNewChat = vi.fn();
    const onQuoteToExistingChat = vi.fn();
    render(
      <FeedbackProvider>
        <HighlightActionBar
          variant="selection"
          selectionColor="yellow"
          canQuoteToChat
          busy
          onSelectColor={onSelectColor}
          onQuoteToNewChat={onQuoteToNewChat}
          onQuoteToExistingChat={onQuoteToExistingChat}
        />
      </FeedbackProvider>,
    );

    const color = screen.getByRole("button", { name: "Highlight color" });
    const newChat = screen.getByRole("button", { name: "Ask in new chat" });
    const existingChat = screen.getByRole("button", {
      name: "Ask in existing chat…",
    });
    expect(color).toBeDisabled();
    expect(newChat).toBeDisabled();
    expect(existingChat).toBeDisabled();

    fireEvent.click(color);
    fireEvent.click(newChat);
    fireEvent.click(existingChat);
    expect(onSelectColor).not.toHaveBeenCalled();
    expect(onQuoteToNewChat).not.toHaveBeenCalled();
    expect(onQuoteToExistingChat).not.toHaveBeenCalled();
  });
});
