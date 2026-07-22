import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspaceE2eDeviceId,
  type WorkspaceState,
} from "./workspace";

// The launcher is rendered as a portal'd <div role="dialog" aria-label="Launcher">
// (LauncherSurface on desktop, LauncherSheet via MobileSheet on mobile) — NOT a native
// <dialog> element. getByRole("dialog") matches the ARIA role regardless of element tag,
// so this locator is correct for both shells.
function launcherDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Launcher" });
}

// The omni-input is a role=combobox named "Search, add, or ask" (renamed from the old
// palette "Search commands"); selectors keyed on the aria-label are stable across panels.
function launcherInput(root: Page | Locator): Locator {
  return root.getByRole("combobox", { name: "Search, add, or ask" });
}

function launcherListbox(root: Page | Locator): Locator {
  return root.getByRole("listbox");
}

// Row accessible name is `${title} ${subtitle?} ${shortcut?}` (no section tag): the
// "Keyboard Shortcuts" command has no subtitle, so its name is just the title.
function keyboardShortcutsOption(root: Page | Locator): Locator {
  // Exact name targets the nav command only; once /settings/keybindings has been
  // visited it also appears as a recent row ("Keyboard Shortcuts /settings/…"),
  // so a loose match would resolve to two options on a retry.
  return launcherListbox(root).getByRole("option", {
    name: "Keyboard Shortcuts",
    exact: true,
  });
}

async function expectKeyboardShortcutsPage(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/settings\/keybindings$/);
  await expect(
    page.getByRole("button", { name: "Reset to defaults" }),
  ).toBeVisible({ timeout: 15_000 });
}

// Seeds the workspace with a second open pane (/search → "Search") on top of
// the visited route, so the launcher's open-tabs section contains a Search row.
function workspaceWithSearchPane(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-libraries", "/libraries"),
      makeWorkspacePane("pane-search", "/search"),
    ],
    { activePrimaryPaneId: "pane-libraries" },
  );
}

test.describe("launcher", () => {
  test("desktop: Add aliases open the source workbench without a chooser", async ({
    page,
  }) => {
    await page.goto("/libraries?launcher=1");

    const launcher = launcherDialog(page);
    const input = launcherInput(launcher);
    await input.fill("upload file");
    await launcher.getByRole("option", { name: /^Upload file/ }).click();

    const add = page.getByRole("dialog", { name: "Add content" });
    await expect(
      add.getByRole("heading", { name: "Add content" }),
    ).toBeVisible();
    await expect(
      add.getByRole("button", { name: "Choose PDF or EPUB" }),
    ).toBeFocused();
    await expect(
      add.getByRole("option", { name: /^Add from URL/ }),
    ).toHaveCount(0);

    await add.getByRole("button", { name: "Back" }).click();
    const root = launcherDialog(page);
    await launcherInput(root).fill("import opml");
    await root.getByRole("option", { name: /^Import OPML/ }).click();

    const opml = page.getByRole("dialog", { name: "Import OPML" });
    await expect(
      opml.getByRole("heading", { name: "Import OPML" }),
    ).toBeVisible();
    await expect(opml.getByLabel("Choose OPML file")).toBeAttached();
    await expect(opml.getByRole("tab")).toHaveCount(0);
  });

  test("desktop: the removed Add lane deep link falls back to Launcher root", async ({
    page,
  }) => {
    await page.goto("/libraries?launcher=1&lane=add");

    const launcher = launcherDialog(page);
    await expect(launcherInput(launcher)).toBeVisible();
    await expect(
      launcher.getByRole("button", { name: "Add", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Add content" })).toHaveCount(
      0,
    );
  });

  test("desktop: open with a query, arrow + Enter run a command", async ({
    page,
  }) => {
    // ?launcher=1 is the most robust open path: no modifier-key or platform branch.
    await page.goto("/libraries?launcher=1");

    const dialog = launcherDialog(page);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Clear scope" }),
    ).toHaveCount(0);
    const input = launcherInput(dialog);
    await expect(input).toBeFocused();
    await input.click();

    await input.fill("keyboard shortcuts");

    // Querying exposes commands as a listbox of options.
    const listbox = launcherListbox(dialog);
    await expect(listbox.getByRole("option").first()).toBeVisible();
    const keybindingsOption = keyboardShortcutsOption(dialog);
    await expect(keybindingsOption).toBeVisible();

    // Drive the active option onto the Keyboard Shortcuts row, then Enter runs it.
    for (let step = 0; step < 12; step += 1) {
      if ((await keybindingsOption.getAttribute("aria-selected")) === "true") {
        break;
      }
      await input.press("ArrowDown");
    }

    await input.press("Enter");

    // Enter executes the active command: the launcher closes and the target opens.
    await expect(dialog).toBeHidden();
    await expectKeyboardShortcutsPage(page);
  });

  test("desktop: inline close button removes the open-tab row without dismissing the launcher", async ({
    page,
  }, testInfo) => {
    // Seed two panes so the open-tabs section is populated; the launcher opens
    // immediately via ?launcher=1 on top of the seeded workspace session.
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-launcher"),
      workspaceWithSearchPane(),
      "/libraries?launcher=1",
    );

    const dialog = launcherDialog(page);
    await expect(dialog).toBeVisible();

    const listbox = launcherListbox(dialog);
    const searchTab = listbox.getByRole("option", {
      name: /Search.*Switch to open tab/i,
    });
    await expect(searchTab).toHaveCount(1);

    // The deleted close-row pattern must not return: no row's accessible name
    // should start with "Close " (close lives only on the inline button).
    await expect(listbox.getByRole("option", { name: /^Close / })).toHaveCount(
      0,
    );

    // The inline close button lives inside the row and carries its own aria-label.
    const closeButton = searchTab.getByRole("button", { name: /^Close / });
    await expect(closeButton).toBeVisible();

    await closeButton.click();

    // Trailing action keeps the launcher open and removes the row from the list.
    await expect(dialog).toBeVisible();
    await expect(searchTab).toHaveCount(0);
  });
});

test.describe("launcher mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("mobile: open with a query, tapping a result runs it", async ({
    page,
  }) => {
    await page.goto("/libraries?launcher=1");

    const dialog = launcherDialog(page);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Clear scope" }),
    ).toHaveCount(0);

    const input = launcherInput(dialog);
    await input.fill("keyboard shortcuts");

    // Tapping a result option executes it: the launcher closes and the target opens.
    const keybindingsOption = keyboardShortcutsOption(dialog);
    await expect(keybindingsOption).toBeVisible();
    await keybindingsOption.tap();

    await expect(dialog).toBeHidden();
    await expectKeyboardShortcutsPage(page);
  });

  test("mobile: tapping the inline close button removes the open-tab row without dismissing the launcher", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-launcher"),
      workspaceWithSearchPane(),
      "/libraries?launcher=1",
    );

    const dialog = launcherDialog(page);
    await expect(dialog).toBeVisible();

    const listbox = launcherListbox(dialog);
    const searchTab = listbox.getByRole("option", {
      name: /Search.*Switch to open tab/i,
    });
    await expect(searchTab).toHaveCount(1);
    await expect(listbox.getByRole("option", { name: /^Close / })).toHaveCount(
      0,
    );

    const closeButton = searchTab.getByRole("button", { name: /^Close / });
    await expect(closeButton).toBeVisible();
    await closeButton.tap();

    await expect(dialog).toBeVisible();
    await expect(searchTab).toHaveCount(0);
  });
});
