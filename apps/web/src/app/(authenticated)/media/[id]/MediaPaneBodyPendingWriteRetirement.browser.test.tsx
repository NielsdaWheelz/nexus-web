import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { cdp, page } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it("releases closed text source DOM while its acknowledged Ask write is still pending", async () => {
  const view = await renderMediaPane();
  try {
    view.finishSecond();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next section" })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole("region", { name: "Document reading area" })).toHaveAttribute("aria-busy", "false"));
    const retired = (() => {
      const source = screen.getByText(/^Home source line\./);
      const text = document.createTreeWalker(source, NodeFilter.SHOW_TEXT).nextNode();
      if (!(text instanceof Text)) throw new Error("Rendered source has no text");
      const selection = document.getSelection();
      if (selection === null) throw new Error("Chromium selection is unavailable");
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return new WeakRef(source);
    })();
    expect(retired.deref()?.isConnected).toBe(true);
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: a selector-backed browser locator cannot retain the retired source in Vitest completion diagnostics
    await page.getByRole("button", { name: "Ask" }).click();
    await waitFor(() => expect(view.highlightWrites).toHaveLength(1));
    view.retireReader();
    expect(screen.queryByRole("region", { name: "Document reading area" })).not.toBeInTheDocument();
    await cdp().send("HeapProfiler.collectGarbage");
    expect(retired.deref(), "pending highlight Ask retained the retired source DOM").toBeUndefined();
    await act(async () => view.finishHighlight());
    await waitFor(() => expect(screen.getByLabelText("Activated reader destination"),
      "closing the source discarded its acknowledged Ask destination").toHaveTextContent(
      `/conversations/new#mediaId=${view.mediaId}&highlightId=${view.highlightWrites[0].id}`));
  } finally { view.close(); }
});
