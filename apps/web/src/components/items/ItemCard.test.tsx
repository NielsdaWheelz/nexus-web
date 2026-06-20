import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import ItemCard from "./ItemCard";

// Drives showFullText the way ReaderDocumentMapHighlightsLens does, so a click on the
// card's own show-more toggle flips it. Width-constrained so a long snippet
// overflows the 6-line clamp (clamp geometry is real in the Chromium project).
function ExpandableHighlightCard({ exact }: { exact: string }) {
  const [showFullText, setShowFullText] = useState(false);
  return (
    <div style={{ width: 180 }}>
      <ItemCard
        content={{ kind: "highlight", snippet: { exact, color: "yellow" } }}
        showFullText={showFullText}
        onToggleFullText={() => setShowFullText((value) => !value)}
        onActivate={() => {}}
      />
    </div>
  );
}

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

  it("calls onActivate on body click but not on an action control or a linked-chat button", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onLinkedActivate = vi.fn();
    render(
      <ItemCard
        content={{
          kind: "highlight",
          snippet: { exact: "selected text", color: "green" },
        }}
        actions={<button type="button">Delete</button>}
        linkedItems={[{ id: "c1", label: "First chat", onActivate: onLinkedActivate }]}
        onActivate={onActivate}
      />,
    );

    await user.click(screen.getByText("selected text"));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "First chat" }));
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("keeps unavailable card activation inert without disabling secondary controls", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onAction = vi.fn();
    const onLinkedActivate = vi.fn();

    render(
      <ItemCard
        content={{ kind: "resource", title: "Unavailable document" }}
        unavailable
        testId="unavailable-card"
        actions={<button type="button" onClick={onAction}>Remove</button>}
        linkedItems={[{ id: "c1", label: "Related chat", onActivate: onLinkedActivate }]}
        onActivate={onActivate}
      />,
    );

    const primary = screen.getByRole("button", { name: "Unavailable document" });
    expect(primary).toBeDisabled();

    await user.click(primary);
    fireEvent.click(screen.getByTestId("unavailable-card"));
    expect(onActivate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Related chat" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onLinkedActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("always renders linked chats as a clickable list, with no scent line", () => {
    render(
      <ItemCard
        content={{ kind: "highlight", snippet: { exact: "selected text", color: "blue" } }}
        linkedItems={[
          { id: "c1", label: "First chat", onActivate: () => {} },
          { id: "c2", label: "Second chat", onActivate: () => {} },
        ]}
      />,
    );

    expect(screen.getByRole("list", { name: "2 linked chats" })).toBeVisible();
    expect(screen.getByRole("button", { name: "First chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Second chat" })).toBeVisible();
    expect(screen.queryByText("First chat · Second chat")).toBeNull();
  });

  it("labels a single linked chat with singular grammar", () => {
    render(
      <ItemCard
        content={{ kind: "highlight", snippet: { exact: "selected text", color: "blue" } }}
        linkedItems={[{ id: "c1", label: "Only chat", onActivate: () => {} }]}
      />,
    );

    expect(screen.getByRole("list", { name: "1 linked chat" })).toBeVisible();
  });

  it("renders no linked-chat element when there are none", () => {
    render(
      <ItemCard
        content={{ kind: "highlight", snippet: { exact: "selected text", color: "blue" } }}
      />,
    );

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("toggles a show-more control when the snippet overflows the clamp", async () => {
    const user = userEvent.setup();
    render(<ExpandableHighlightCard exact={"overflowing ".repeat(120).trim()} />);

    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByRole("button", { name: "Show more" })).toBeVisible();
  });

  it("renders no show-more control for a snippet that fits the clamp", async () => {
    render(<ExpandableHighlightCard exact="short" />);

    await screen.findByText("short");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Show more|Show less/ })).toBeNull();
    });
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
