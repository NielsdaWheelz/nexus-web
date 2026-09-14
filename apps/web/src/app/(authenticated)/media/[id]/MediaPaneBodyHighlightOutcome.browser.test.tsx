import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it.each([
  { duplicateHighlight: false, retireDetail: true },
  { duplicateHighlight: true, retireDetail: true },
  { duplicateHighlight: true, retireDetail: false },
])("preserves the acknowledged chat source when its optional detail retires or fails (%j)", async ({ duplicateHighlight, retireDetail }) => {
  const view = await renderMediaPane({ existingHighlight: true, duplicateHighlight, highlightDetailFailure: !retireDetail });
  try {
    view.finishSecond();
    await screen.findByRole("button", { name: "Next section" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Document reading area" })).toHaveAttribute("aria-busy", "false"));
    const mark = await screen.findByText("line", { exact: true });
    expect(mark).toHaveTextContent("line");
    const source = screen.getByText(/^Home source/);
    const text = document.createTreeWalker(source, NodeFilter.SHOW_TEXT).nextNode();
    if (!(text instanceof Text)) throw new Error("Rendered source has no text");
    const selection = document.getSelection();
    if (selection === null) throw new Error("Chromium selection is unavailable");
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Ask" }));
    await waitFor(() => expect(view.highlightWrites).toHaveLength(1));
    if (retireDetail) {
      await userEvent.click(mark);
      await screen.findByRole("menu", { name: "Highlight actions" });
    }
    await act(async () => view.finishHighlight());
    if (!retireDetail) await screen.findByText("The reader couldn’t load this part.", {}, { timeout: 5000 });
    const acknowledgedId = view.highlightWrites[0].id;
    await waitFor(() => expect(screen.getByLabelText("Activated reader destination"),
      "retired detail discarded the acknowledged highlight's chat action").toHaveTextContent(
      `/conversations/new#mediaId=${view.mediaId}&highlightId=${acknowledgedId}`));
    if (retireDetail) expect(screen.getByRole("menu", { name: "Highlight actions" }), "old acknowledgment replaced the selected highlight actions").toBeVisible();
    else expect(screen.getByRole("button", { name: "Retry reader" }), "duplicate detail failure lost its existing recovery action").toBeVisible();
  } finally { view.close(); }
});
