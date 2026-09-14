import { expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it.each([false, true])("keeps the replacement Link selection and dialog across the older result (lost response: %s)", async (lostResponse) => {
  const view = await renderMediaPane();
  try {
    view.finishSecond();
    const next = await screen.findByRole("button", { name: "Next section" });
    await waitFor(() => expect(next).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("region", { name: "Document reading area" })).toHaveAttribute("aria-busy", "false"));
    const source = screen.getByText(/^Home source line\./);
    const text = document.createTreeWalker(source, NodeFilter.SHOW_TEXT).nextNode();
    if (!(text instanceof Text)) throw new Error("Rendered source has no text");
    const selection = document.getSelection();
    if (selection === null) throw new Error("Chromium selection is unavailable");
    const first = document.createRange(); first.setStart(text, 0); first.setEnd(text, 4);
    selection.removeAllRanges(); selection.addRange(first);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Link" }));
    await userEvent.fill(await screen.findByRole("combobox", { name: "Link search" }), "Exact");
    await userEvent.click(await screen.findByRole("option", { name: /Exact reader composition/ }));
    await waitFor(() => expect(view.linkWrites).toHaveLength(1));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link" })).not.toBeInTheDocument());
    const second = document.createRange(); second.setStart(text, 5); second.setEnd(text, 11);
    selection.removeAllRanges(); selection.addRange(second);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Link" }));
    const current = screen.getByRole("dialog", { name: "Link" });
    expect(selection.toString(), "replacement Link lost its source before the old response").toBe("source");
    await act(async () => lostResponse ? view.failLink() : view.finishLink());
    await waitFor(() => {
      expect(current, "earlier Link response closed the replacement dialog").toBeInTheDocument();
      expect(within(current).getByRole("combobox", { name: "Link search" })).toBeEnabled();
    });
    expect(current).toBeVisible();
    expect(selection.toString(), "earlier Link response erased the replacement selection").toBe("source");
    expect(within(current).queryByRole("button", { name: "Retry" }), "earlier Link failure replaced the current dialog's outcome").not.toBeInTheDocument();
    if (lostResponse) expect(within(screen.getByRole("region", { name: "Persistent feedback" })).getByText("Link outcome not confirmed")).toBeVisible();
    else expect(within(screen.getByRole("region", { name: "HUD feedback" })).getByText("Linked to Exact reader composition")).toBeVisible();
    await userEvent.click(within(current).getByRole("option", { name: /Exact reader composition/ }));
    await waitFor(() => expect(view.linkWrites, "old Link completion left the next confirmation locked").toHaveLength(2));
    expect(view.linkWrites.map(({ source: selected }) => [selected.start_offset, selected.end_offset])).toEqual([[0, 4], [5, 11]]);
    const currentRange = selection.getRangeAt(0);
    expect(currentRange.startContainer).toBe(text);
    expect(currentRange.startOffset).toBe(5);
    expect(currentRange.endContainer).toBe(text);
    expect(currentRange.endOffset).toBe(11);
    await act(async () => view.finishLink());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link" })).not.toBeInTheDocument());
    expect(selection.toString()).toBe("");
  } finally { view.close(); }
});
