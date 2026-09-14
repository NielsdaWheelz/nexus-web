import { expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it("keeps the existing source and paint when an acknowledged highlight's replacement cannot be prepared", async () => {
  const view = await renderMediaPane({ existingHighlight: true });
  const createElementNS = document.createElementNS.bind(document);
  let refuseSource = false;
  // eslint-disable-next-line no-restricted-syntax -- justify-eslint-override: refuse the external browser DOM operation while retaining the real reader and immutable source bytes
  const refused = vi.spyOn(document, "createElementNS").mockImplementation((namespace, name, options) => {
    if (refuseSource && namespace === "http://www.w3.org/1999/xhtml" && name === "p") {
      throw new DOMException("Source element creation is unavailable", "NotSupportedError");
    }
    return createElementNS(namespace, name, options);
  });
  try {
    view.finishSecond();
    const originalPaint = await screen.findByText("line", { exact: true });
    const originalSource = screen.getByText(/^Home source/);
    expect(originalSource).toBeVisible();
    expect(originalPaint).toBeVisible();
    refuseSource = true;
    const before = originalSource.getBoundingClientRect().top;
    const text = document.createTreeWalker(originalSource, NodeFilter.SHOW_TEXT).nextNode();
    if (!(text instanceof Text)) throw new Error("Rendered source has no text");
    const selection = document.getSelection();
    if (selection === null) throw new Error("Chromium selection is unavailable");
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(view.highlightWrites).toHaveLength(1));
    await act(async () => view.finishHighlight());
    const retry = await screen.findByRole("button", { name: "Retry reader" });
    expect(screen.queryByText(/^Home source/), "failed repaint retired its existing readable source").toBe(originalSource);
    expect(originalSource).toBeVisible();
    expect(screen.getByText("line", { exact: true }), "failed repaint retired its existing highlight paint").toBe(originalPaint);
    expect(originalPaint).toBeVisible();
    expect(view.highlightWrites[0].exact, "paint failure lost the acknowledged authored selection").toBe("Home");
    refuseSource = false;
    await userEvent.click(retry);
    const created = await screen.findByText("Home", { exact: true });
    expect(created, "explicit retry did not paint the acknowledged highlight").toBeVisible();
    expect(screen.getByText("line", { exact: true })).toBeVisible();
    expect(originalSource, "successful replacement kept the old source mounted").not.toBeInTheDocument();
    expect(originalPaint).not.toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the exact authored paragraph supplies the visible before/after source-position geometry
    const replacement = created.closest("p");
    if (replacement === null) throw new Error("Replacement highlight lost its authored paragraph");
    expect(Math.abs(replacement.getBoundingClientRect().top - before),
      "replacement retry displaced the reading source").toBeLessThanOrEqual(2);
    expect(view.highlightWrites).toHaveLength(1);
    await userEvent.click(created);
    await screen.findByRole("menu", { name: "Highlight actions" });
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open", exact: true }));
    await waitFor(() => expect(screen.getByLabelText("Activated reader destination"),
      "replacement paint activated another highlight identity").toHaveTextContent(
        `/media/${view.mediaId}?highlight=${view.highlightWrites[0].id}`));
  } finally { refused.mockRestore(); view.close(); }
});
