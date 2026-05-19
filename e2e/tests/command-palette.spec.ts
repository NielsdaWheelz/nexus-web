import { test, expect, type Locator, type Page } from "@playwright/test";

function paletteDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Command palette" });
}

function paletteInput(page: Page): Locator {
  return page.getByRole("combobox", { name: "Search commands" });
}

function paletteListbox(page: Page): Locator {
  return page.locator("#palette-listbox");
}

function workspacePaneButton(page: Page, name: RegExp | string): Locator {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("command palette", () => {
  test("desktop: open with a query shows one flat ranked list, arrow + Enter run a command", async ({
    page,
  }) => {
    // ?palette=1 is the most robust open path: no modifier-key or platform branch.
    await page.goto("/libraries?palette=1");

    const dialog = paletteDialog(page);
    await expect(dialog).toBeVisible();
    const input = paletteInput(page);
    await expect(input).toBeFocused();

    await input.fill("keyboard shortcuts");

    // Querying state is one flat listbox of options — no resting-state sections.
    const listbox = paletteListbox(page);
    await expect(listbox.getByRole("option").first()).toBeVisible();
    await expect(listbox.getByRole("group")).toHaveCount(0);
    await expect(listbox.getByRole("heading")).toHaveCount(0);

    // ArrowDown moves the active option, tracked by aria-activedescendant.
    const keybindingsOption = listbox.locator("#palette-option-nav-keybindings");
    await expect(keybindingsOption).toBeVisible();
    await input.press("ArrowDown");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      /^palette-option-/,
    );
    await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);

    // Drive the active option onto the Keyboard Shortcuts row, then Enter runs it.
    for (let step = 0; step < 12; step += 1) {
      if (
        (await input.getAttribute("aria-activedescendant")) ===
        "palette-option-nav-keybindings"
      ) {
        break;
      }
      await input.press("ArrowDown");
    }
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      "palette-option-nav-keybindings",
    );

    await input.press("Enter");

    // Enter executes the active command: the palette closes and the target opens.
    await expect(dialog).toBeHidden();
    await expect(workspacePaneButton(page, /^Keyboard Shortcuts\b/)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("desktop: Escape closes the palette", async ({ page }) => {
    await page.goto("/libraries?palette=1");

    const dialog = paletteDialog(page);
    await expect(dialog).toBeVisible();

    await paletteInput(page).press("Escape");

    await expect(dialog).toBeHidden();
  });
});

test.describe("command palette mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("mobile: pane trigger opens a full-screen dialog, tapping a result runs it", async ({
    page,
  }) => {
    await page.goto("/libraries");

    // The mobile pane header carries the palette trigger button.
    const trigger = page.getByRole("button", { name: "Open command palette" });
    await expect(trigger).toBeVisible();
    await trigger.tap();

    // A full-screen dialog opens, sized to the phone viewport.
    const dialog = paletteDialog(page);
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    if (dialogBox) {
      expect(dialogBox.width).toBe(390);
    }

    const input = paletteInput(page);
    await input.fill("keyboard shortcuts");

    // Tapping a result option executes it: the palette closes and the target opens.
    const keybindingsOption = paletteListbox(page).locator(
      "#palette-option-nav-keybindings",
    );
    await expect(keybindingsOption).toBeVisible();
    await keybindingsOption.tap();

    await expect(dialog).toBeHidden();
    await expect(workspacePaneButton(page, /^Keyboard Shortcuts\b/)).toBeVisible({
      timeout: 15_000,
    });
  });
});
