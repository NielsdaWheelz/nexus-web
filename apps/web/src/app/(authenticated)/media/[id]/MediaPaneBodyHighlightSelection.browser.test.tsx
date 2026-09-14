import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it.each([false, true])("preserves a newer text selection across an earlier highlight acknowledgment and accepts its next write (duplicate: %s)", async (duplicateHighlight) => {
  const view = await renderMediaPane({ duplicateHighlight });
  try {
    view.finishSecond();
    const next = await screen.findByRole("button", { name: "Next section" });
    await waitFor(() => expect(next).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("region", { name: "Document reading area" })).toHaveAttribute("aria-busy", "false"));
    const source = screen.getByText(/^Home source line\./);
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!(text instanceof Text)) throw new Error("Rendered source has no text");
    const selection = document.getSelection();
    if (selection === null) throw new Error("Chromium selection is unavailable");
    const earlier = document.createRange(); earlier.setStart(text, 0); earlier.setEnd(text, 4);
    selection.removeAllRanges(); selection.addRange(earlier);
    document.dispatchEvent(new Event("selectionchange"));
    expect(source, "initial selected source retired before its action").toBeInTheDocument();
    expect(selection.toString(), "initial source selection was not established").toBe("Home");
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(view.highlightWrites).toHaveLength(1));
    const later = document.createRange(); later.setStart(text, 5); later.setEnd(text, 11);
    selection.removeAllRanges(); selection.addRange(later);
    document.dispatchEvent(new Event("selectionchange"));
    await act(async () => view.finishHighlight());
    await waitFor(() => {
      expect(selection.toString(), "earlier highlight acknowledgment erased the newer selection").toBe("source");
      const highlight = screen.queryByRole("button", { name: "Highlight" });
      expect(highlight, "earlier highlight acknowledgment discarded the newer selection actions").not.toBeNull();
      expect(highlight).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(view.highlightWrites, "earlier completion kept the new selection locked").toHaveLength(2));
    expect(view.highlightWrites.map((highlight) => highlight.exact)).toEqual(["Home", "source"]);
    await act(async () => view.finishHighlight());
    await waitFor(() => expect(selection.toString()).toBe(""));
  } finally { view.close(); }
});
