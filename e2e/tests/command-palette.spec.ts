import { test, expect, type Locator, type Page } from "@playwright/test";

function paletteDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Command palette" });
}

function paletteInput(root: Page | Locator): Locator {
  return root.getByRole("combobox", { name: "Search commands" });
}

function paletteListbox(root: Page | Locator): Locator {
  return root.getByRole("listbox");
}

test.describe("command palette", () => {
  test("desktop: open with a query, arrow + Enter run a command", async ({
    page,
  }) => {
    // ?palette=1 is the most robust open path: no modifier-key or platform branch.
    await page.goto("/libraries?palette=1");

    const dialog = paletteDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Clear scope" })).toHaveCount(0);
    const input = paletteInput(dialog);
    await expect(input).toBeFocused();
    await input.click();

    await input.fill("keyboard shortcuts");

    // Querying exposes commands as a listbox of options.
    const listbox = paletteListbox(dialog);
    await expect(listbox.getByRole("option").first()).toBeVisible();
    const keybindingsOption = listbox.getByRole("option", {
      name: /^Keyboard Shortcuts\b/,
    });
    await expect(keybindingsOption).toBeVisible();

    // Drive the active option onto the Keyboard Shortcuts row, then Enter runs it.
    for (let step = 0; step < 12; step += 1) {
      if ((await keybindingsOption.getAttribute("aria-selected")) === "true") {
        break;
      }
      await input.press("ArrowDown");
    }

    await input.press("Enter");

    // Enter executes the active command: the palette closes and the target opens.
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("command palette mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("mobile: open with a query, tapping a result runs it", async ({
    page,
  }) => {
    await page.goto("/libraries?palette=1");

    const dialog = paletteDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Clear scope" })).toHaveCount(0);

    const input = paletteInput(dialog);
    await input.fill("keyboard shortcuts");

    // Tapping a result option executes it: the palette closes and the target opens.
    const keybindingsOption = paletteListbox(dialog).getByRole("option", {
      name: /^Keyboard Shortcuts\b/,
    });
    await expect(keybindingsOption).toBeVisible();
    await keybindingsOption.tap();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
