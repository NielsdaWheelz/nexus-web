import { expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { cdp, page, userEvent } from "vitest/browser";
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

it("retries the exact section after external DOM preparation fails without acknowledging an unpositioned source", async () => {
  const view = await renderMediaPane();
  const createElementNS = document.createElementNS.bind(document);
  // eslint-disable-next-line no-restricted-syntax -- justify-eslint-override: refuse the external browser DOM operation while retaining the real reader and immutable source bytes
  const refused = vi.spyOn(document, "createElementNS").mockImplementation((namespace, name, options) => {
    if (namespace === "http://www.w3.org/1999/xhtml" && name === "pre") {
      throw new DOMException("Source element creation is unavailable", "NotSupportedError");
    }
    return createElementNS(namespace, name, options);
  });
  try {
    const next = await screen.findByRole("button", { name: "Next section" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await waitFor(() => expect(view.secondRequested()).toBe(true));
    view.finishSecond();
    await screen.findByRole("button", { name: "Retry reader" });
    expect(await view.pendingIntent(), "failed source preparation acknowledged an unpositioned section").toBeNull();
    // Restore the external DOM operation. The immutable member is unchanged.
    refused.mockRestore();
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: the semantic failure can replace the first render-failure button before the native click
    await page.getByRole("button", { name: "Retry reader" }).click();
    await waitFor(async () => {
      expect((await view.pendingIntent())?.desired.locator,
        "preparation retry lost the exact section command").toMatchObject({
          kind: "epub", target: view.target, locations: { text_offset: view.targetOffset },
        });
      const viewport = screen.getByRole("region", { name: "Document reading area" }).getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(screen.getByText("EXACT SECTION TARGET", { exact: true }));
      const source = range.getBoundingClientRect();
      expect(source.top, "preparation retry saved before positioning its source").toBeGreaterThanOrEqual(viewport.top);
      expect(source.bottom, "preparation retry saved before positioning its source").toBeLessThanOrEqual(viewport.bottom);
    });
    expect(screen.getByLabelText("Reader pane location")).toHaveTextContent("loc=chapter-two");
  } finally { refused.mockRestore(); view.close(); }
});

it("retries Find preview and return after external DOM preparation fails while preserving its reading origin", async () => {
  const view = await renderMediaPane();
  const createElementNS = document.createElementNS.bind(document);
  let refusedElement: string | null = "pre";
  // eslint-disable-next-line no-restricted-syntax -- justify-eslint-override: refuse the external browser DOM operation while retaining the real reader and immutable source bytes
  const refused = vi.spyOn(document, "createElementNS").mockImplementation((namespace, name, options) => {
    if (namespace === "http://www.w3.org/1999/xhtml" && name === refusedElement) {
      throw new DOMException("Source element creation is unavailable", "NotSupportedError");
    }
    return createElementNS(namespace, name, options);
  });
  try {
    const homeBefore = await screen.findByText(/^Home source line\./);
    const initialTop = homeBefore.getBoundingClientRect().top - screen.getByRole("region", { name: "Document reading area" }).getBoundingClientRect().top;
    await userEvent.click(screen.getByRole("button", { name: "More", exact: true }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Find", exact: true }));
    await userEvent.fill(await screen.findByRole("searchbox", { name: "Find in book" }), "EXACT SECTION TARGET");
    await waitFor(() => expect(view.secondRequested()).toBe(true));
    view.finishSecond();
    await screen.findByRole("button", { name: "Retry reader" });
    expect(screen.queryByText("Find request unavailable. Retry."),
      "source preparation defect became Find availability").not.toBeInTheDocument();
    expect(await view.pendingIntent(), "failed Find preparation changed the durable reading position").toBeNull();
    refusedElement = null;
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: the semantic failure can replace the first render-failure button before the native click
    await page.getByRole("button", { name: "Retry reader" }).click();
    await waitFor(() => {
      const active = CSS.highlights.get("nexus-find-active");
      expect(active === undefined ? [] : [...active].map((range) => range.toString()),
        "Find defect retry did not reprepare and preview its exact source").toEqual(["EXACT SECTION TARGET"]);
      const viewport = screen.getByRole("region", { name: "Document reading area" }).getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(screen.getByText("EXACT SECTION TARGET", { exact: true }));
      const source = range.getBoundingClientRect();
      expect(source.top).toBeGreaterThanOrEqual(viewport.top);
      expect(source.bottom).toBeLessThanOrEqual(viewport.bottom);
    });
    expect(await view.pendingIntent(), "Find preview replaced the durable reading origin").toBeNull();
    expect(screen.queryByText(/^Home source line\./), "return preparation must use a retired source root").not.toBeInTheDocument();
    refusedElement = "p";
    await userEvent.click(screen.getByRole("button", { name: "Go back to reading position" }));
    await screen.findByRole("button", { name: "Retry reader" });
    expect(screen.queryByText("Find request unavailable. Retry."),
      "return preparation defect became Find availability").not.toBeInTheDocument();
    refusedElement = null;
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: the semantic failure can replace the first render-failure button before the native click
    await page.getByRole("button", { name: "Retry reader" }).click();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Go back to reading position" }),
      "Find retry lost its return command").not.toBeInTheDocument());
    const home = screen.getByText(/^Home source line\./);
    const viewport = screen.getByRole("region", { name: "Document reading area" }).getBoundingClientRect();
    expect(Math.abs(home.getBoundingClientRect().top - viewport.top - initialTop),
      "Find return retry lost the original source geometry").toBeLessThanOrEqual(2);
    expect(await view.pendingIntent()).toBeNull();
  } finally { refused.mockRestore(); view.close(); }
});
