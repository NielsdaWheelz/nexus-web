import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { cdp, userEvent } from "vitest/browser";
import { renderMediaPane } from "./__tests__/mediaPaneFixture";

it.each([false, true])("positions the actual selected section before saving its exact locator (retry=%s)", async (retry) => {
  const view = await renderMediaPane();
  try {
    const next = await screen.findByRole("button", { name: "Next section" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await waitFor(() => expect(view.secondRequested()).toBe(true));
    expect(await view.pendingIntent(), "a pending source unit was acknowledged as a positioned section").toBeNull();
    if (retry) {
      view.failSecond();
      await userEvent.click(await screen.findByRole("button", { name: "Retry reader" }));
      await waitFor(() => expect(view.secondRequested()).toBe(true));
    }
    view.finishSecond();
    await waitFor(async () => {
      const intent = await view.pendingIntent();
      expect(intent?.desired.locator, "actual section navigation did not save its chosen source locator").toMatchObject({
        kind: "epub", target: view.target, locations: { text_offset: view.targetOffset },
      });
      const viewport = screen.getByRole("region", { name: "Document reading area" });
      const source = screen.getByText("EXACT SECTION TARGET", { exact: true });
      const range = document.createRange();
      range.selectNodeContents(source);
      const target = range.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      expect(target.top, "section cursor was saved before its actual source position").toBeGreaterThanOrEqual(visible.top);
      expect(target.bottom, "section cursor was saved before its actual source position").toBeLessThanOrEqual(visible.bottom);
    });
    await waitFor(() => expect(screen.getByLabelText("Reader pane location")).toHaveTextContent("loc=chapter-two"));
    expect((await view.pendingIntent())?.desired.locator).toMatchObject({ kind: "epub", target: view.target,
      locations: { text_offset: view.targetOffset } });
  } finally { view.close(); }
});


it.each([false, true])("keeps the reader's current source when trusted movement supersedes a held section command (retry: %s)", async (retry) => {
  const view = await renderMediaPane();
  try {
    const next = await screen.findByRole("button", { name: "Next section" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await waitFor(() => expect(view.secondRequested()).toBe(true));
    if (retry) {
      view.failSecond();
      await userEvent.click(await screen.findByRole("button", { name: "Retry reader" }));
      await waitFor(() => expect(view.secondRequested()).toBe(true));
    }
    const viewport = screen.getByRole("region", { name: "Document reading area" });
    expect(viewport).toHaveAttribute("aria-busy", "true");
    const before = viewport.scrollTop;
    const rect = viewport.getBoundingClientRect();
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2, deltaX: 0, deltaY: 140 });
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(before));
    await waitFor(async () => expect((await view.pendingIntent())?.desired.locator).toMatchObject({ kind: "epub", target: { section_id: "chapter-one" } }));
    const afterInput = viewport.scrollTop;
    const savedInput = (await view.pendingIntent())?.desired.locator;
    view.finishSecond();
    await waitFor(() => expect(viewport).toHaveAttribute("aria-busy", "false"));
    const home = screen.queryByText(/^Home source line\./);
    expect(home, "retired section command replaced the reader's current source").not.toBeNull();
    expect(home).toBeVisible();
    expect(viewport.scrollTop, "retired section command moved the trusted reader position").toBe(afterInput);
    expect((await view.pendingIntent())?.desired.locator).toEqual(savedInput);
    expect(screen.getByLabelText("Reader pane location")).not.toHaveTextContent("loc=chapter-two");
  } finally { view.close(); }
});
