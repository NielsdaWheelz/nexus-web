import {
  devices,
  test,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspacePaneButton,
  workspaceE2eDeviceId,
  type WorkspaceState,
} from "./workspace";

// Desktop Launcher is a portal'd ARIA dialog, not a native <dialog>.
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

function workspaceWithNotesAndSearchPanes(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-notes", "/notes"),
      makeWorkspacePane("pane-search", "/search"),
    ],
    { activePrimaryPaneId: "pane-notes" },
  );
}

test.describe("launcher", () => {
  test("desktop: root Launcher intent opens over the restored workspace", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-root-launcher"),
      workspaceWithNotesAndSearchPanes(),
      "/?launcher=1&lane=browse&q=kafka",
    );

    const dialog = launcherDialog(page);
    await expect(dialog).toBeVisible();
    await expect(launcherInput(dialog)).toHaveValue("kafka");
    await expect(
      dialog.getByRole("button", { name: "Browse" }),
    ).toHaveAttribute("aria-pressed", "true");

    await expect(workspacePaneButton(page, /^Notes\b/)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Lectern\b/)).toHaveCount(0);
    await expect(
      page
        .getByRole("toolbar", { name: "Workspace panes" })
        .getByRole("button", { name: /^Close / }),
    ).toHaveCount(2);
    await expect(page).toHaveURL(/\/notes$/);
  });

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

    // Drive the active descendant one committed option at a time. React owns
    // the selection state, so a burst of ArrowDown events can all observe the
    // same render and must not be used as a keyboard-navigation oracle.
    const options = listbox.getByRole("option");
    const optionIds = await options.evaluateAll((elements) =>
      elements.map((element) => element.id),
    );
    const keybindingsOptionId = await keybindingsOption.getAttribute("id");
    const keybindingsOptionIndex = optionIds.indexOf(keybindingsOptionId ?? "");
    expect(keybindingsOptionIndex).toBeGreaterThanOrEqual(0);

    await input.press("Home");
    await expect(input).toHaveAttribute("aria-activedescendant", optionIds[0]!);
    for (let step = 0; step < keybindingsOptionIndex; step += 1) {
      await input.press("ArrowDown");
      await expect(input).toHaveAttribute(
        "aria-activedescendant",
        optionIds[step + 1]!,
      );
    }

    await expect(keybindingsOption).toHaveAttribute("aria-selected", "true");
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

const PERFORMANCE_SETUP_ITERATIONS = 5;
const PERFORMANCE_SAMPLE_COUNT = 50;
const OPENABLES_SAMPLE_COUNT = 100;
const PERFORMANCE_CPU_SLOWDOWN = 4;
const PERFORMANCE_TEST_TIMEOUT_MS = 180_000;
const NEXUS_INTERACTION_BUDGET_MS = 100;
const NEXUS_OPENABLES_BUDGET_MS = 250;
const SIXTY_HZ_FRAME_MS = 1000 / 60;

function nexusDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Nexus" });
}

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return (
    ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
}

async function measureCount(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (measureName) =>
      performance.getEntriesByName(measureName, "measure").length,
    name,
  );
}

async function waitForMeasureCount(
  page: Page,
  name: string,
  count: number,
): Promise<void> {
  await expect
    .poll(() => measureCount(page, name), {
      message: `expected ${count} ${name} user-timing samples`,
    })
    .toBe(count);
}

async function measureDurations(page: Page, name: string): Promise<number[]> {
  return page.evaluate(
    (measureName) =>
      performance
        .getEntriesByName(measureName, "measure")
        .map((entry) => entry.duration),
    name,
  );
}

test.describe("mobile Nexus Switchboard", () => {
  test.use({
    viewport: devices["Pixel 7"].viewport,
    userAgent: devices["Pixel 7"].userAgent,
    deviceScaleFactor: devices["Pixel 7"].deviceScaleFactor,
    isMobile: devices["Pixel 7"].isMobile,
    hasTouch: devices["Pixel 7"].hasTouch,
  });

  test("switches, closes, and restores exact panes from one local-first root", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-tabs"),
      workspaceWithNotesAndSearchPanes(),
      "/notes",
    );

    const trigger = page.getByRole("button", {
      name: "Open Nexus, 2 tabs",
    });
    await expect(trigger).toBeVisible();
    await trigger.tap();

    const dialog = nexusDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Nexus" })).toBeFocused();
    await expect(dialog.getByRole("searchbox")).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Places" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Quick" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Open" })).toBeVisible();

    await dialog.getByRole("button", { name: "Search Open tab" }).tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);

    await page.getByRole("button", { name: "Open Nexus, 2 tabs" }).tap();
    await nexusDialog(page)
      .getByRole("button", { name: "Actions for Search" })
      .tap();
    await page.getByRole("menuitem", { name: "Close Search" }).tap();

    const openDialog = nexusDialog(page);
    await expect(openDialog).toBeVisible();
    await expect(
      openDialog.getByRole("heading", { name: "Recently closed" }),
    ).toBeVisible();
    await expect(
      openDialog.getByRole("button", { name: "Search Closed tab" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Nexus, 1 tab" }),
    ).toBeHidden();

    await openDialog.getByRole("button", { name: "Search Closed tab" }).tap();
    await expect(openDialog).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      page.getByRole("button", { name: "Open Nexus, 2 tabs" }),
    ).toBeVisible();
  });

  test("Find is explicit, focuses on entry, and retrieves Find-only Places", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-find"),
      "/libraries",
    );
    await page.getByRole("button", { name: "Open Nexus, 1 tab" }).tap();

    const dialog = nexusDialog(page);
    await dialog.getByRole("button", { name: "Find anything…" }).tap();
    const input = dialog.getByRole("searchbox", { name: "Find anything" });
    await expect(input).toBeFocused();

    await input.fill("s");
    await expect(
      dialog.getByRole("button", { name: "Stats Place" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "All", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    await dialog.getByRole("button", { name: "Stats Place" }).tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/stats$/);
  });

  test("production user-timing meets the local interaction gates", async ({
    page,
  }, testInfo) => {
    test.setTimeout(PERFORMANCE_TEST_TIMEOUT_MS);
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-performance"),
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-notes", "/notes"),
          makeWorkspacePane("pane-libraries", "/libraries"),
        ],
        { activePrimaryPaneId: "pane-notes" },
      ),
      "/notes",
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: PERFORMANCE_CPU_SLOWDOWN,
    });
    try {
      const trigger = page.getByRole("button", {
        name: "Open Nexus, 2 tabs",
      });
      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await trigger.tap();
        await expect(nexusDialog(page)).toBeVisible();
        await waitForMeasureCount(page, "nexus-open", iteration + 1);
        await nexusDialog(page).getByRole("button", { name: "Done" }).tap();
        await expect(nexusDialog(page)).toBeHidden();
      }
      await page.evaluate(() => performance.clearMeasures("nexus-open"));

      for (let sample = 1; sample <= PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        await trigger.tap();
        await expect(nexusDialog(page)).toBeVisible();
        await waitForMeasureCount(page, "nexus-open", sample);
        await nexusDialog(page).getByRole("button", { name: "Done" }).tap();
        await expect(nexusDialog(page)).toBeHidden();
      }
      const openSamples = await measureDurations(page, "nexus-open");

      await trigger.tap();
      const dialog = nexusDialog(page);
      await dialog.getByRole("button", { name: "Find anything…" }).tap();
      const input = dialog.getByRole("searchbox", { name: "Find anything" });
      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await input.fill(iteration % 2 === 0 ? "notes" : "libraries");
        await waitForMeasureCount(page, "nexus-local-find", iteration + 1);
      }
      await page.evaluate(() => performance.clearMeasures("nexus-local-find"));
      for (let sample = 1; sample <= PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        await input.fill(sample % 2 === 0 ? "notes" : "libraries");
        await waitForMeasureCount(page, "nexus-local-find", sample);
      }
      const findSamples = await measureDurations(page, "nexus-local-find");

      await expect
        .poll(() => measureCount(page, "nexus-openables"), {
          message: "expected the warm openables request to commit",
        })
        .toBeGreaterThan(0);
      await page.evaluate(() => performance.clearMeasures("nexus-openables"));
      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await input.fill(iteration % 2 === 0 ? "n" : "l");
        await waitForMeasureCount(page, "nexus-openables", iteration + 1);
      }
      await page.evaluate(() => performance.clearMeasures("nexus-openables"));
      for (let sample = 1; sample <= OPENABLES_SAMPLE_COUNT; sample += 1) {
        await input.fill(sample % 2 === 0 ? "n" : "l");
        await waitForMeasureCount(page, "nexus-openables", sample);
      }
      const openablesSamples = await measureDurations(page, "nexus-openables");

      await dialog.getByRole("button", { name: "Back", exact: true }).tap();
      await dialog.getByRole("button", { name: "Done" }).tap();

      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await trigger.tap();
        await nexusDialog(page)
          .getByRole("button", { name: /^(Notes|Libraries) Open tab$/ })
          .tap();
        await expect(nexusDialog(page)).toBeHidden();
        await waitForMeasureCount(page, "nexus-pane-activate", iteration + 1);
      }
      await page.evaluate(() =>
        performance.clearMeasures("nexus-pane-activate"),
      );
      for (let sample = 1; sample <= PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        await trigger.tap();
        await nexusDialog(page)
          .getByRole("button", { name: /^(Notes|Libraries) Open tab$/ })
          .tap();
        await expect(nexusDialog(page)).toBeHidden();
        await waitForMeasureCount(page, "nexus-pane-activate", sample);
      }

      const activateSamples = await measureDurations(
        page,
        "nexus-pane-activate",
      );
      const performanceSummary = {
        conditions: {
          browser: "lockfile Chromium",
          cpuSlowdown: PERFORMANCE_CPU_SLOWDOWN,
          device: "Pixel 7",
          setupIterations: PERFORMANCE_SETUP_ITERATIONS,
        },
        measures: {
          "nexus-local-find": {
            budgetMs: SIXTY_HZ_FRAME_MS,
            p95Ms: p95(findSamples),
            samples: findSamples.length,
          },
          "nexus-open": {
            budgetMs: NEXUS_INTERACTION_BUDGET_MS,
            p95Ms: p95(openSamples),
            samples: openSamples.length,
          },
          "nexus-openables": {
            budgetMs: NEXUS_OPENABLES_BUDGET_MS,
            p95Ms: p95(openablesSamples),
            samples: openablesSamples.length,
          },
          "nexus-pane-activate": {
            budgetMs: NEXUS_INTERACTION_BUDGET_MS,
            p95Ms: p95(activateSamples),
            samples: activateSamples.length,
          },
        },
      };
      await testInfo.attach("nexus-performance.json", {
        body: JSON.stringify(performanceSummary, null, 2),
        contentType: "application/json",
      });
      console.info(
        `NEXUS_PERFORMANCE_RESULT ${JSON.stringify(performanceSummary)}`,
      );
      expect(openSamples).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
      expect(findSamples).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
      expect(activateSamples).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
      expect(openablesSamples).toHaveLength(OPENABLES_SAMPLE_COUNT);
      expect(
        p95(openSamples),
        `nexus-open p95: ${p95(openSamples).toFixed(2)}ms`,
      ).toBeLessThan(NEXUS_INTERACTION_BUDGET_MS);
      expect(
        p95(findSamples),
        `nexus-local-find p95: ${p95(findSamples).toFixed(2)}ms`,
      ).toBeLessThan(SIXTY_HZ_FRAME_MS);
      expect(
        p95(activateSamples),
        `nexus-pane-activate p95: ${p95(activateSamples).toFixed(2)}ms`,
      ).toBeLessThan(NEXUS_INTERACTION_BUDGET_MS);
      expect(
        p95(openablesSamples),
        `nexus-openables p95: ${p95(openablesSamples).toFixed(2)}ms`,
      ).toBeLessThan(NEXUS_OPENABLES_BUDGET_MS);
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
    }
  });
});
