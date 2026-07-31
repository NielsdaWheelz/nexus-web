import {
  devices,
  test,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspacePaneButton,
  workspaceE2eDeviceId,
  type WorkspaceState,
} from "./workspace";

// Desktop Nexus is a portal'd ARIA dialog, not a native <dialog>.
function desktopNexusDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Nexus" });
}

function desktopNexusInput(root: Page | Locator): Locator {
  return root.getByRole("combobox", { name: "Find anything" });
}

function desktopNexusListbox(root: Page | Locator): Locator {
  return root.getByRole("listbox");
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

test.describe("desktop Nexus", () => {
  test("Root intent opens over the restored workspace", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-root-nexus"),
      workspaceWithNotesAndSearchPanes(),
      "/?nexus=1&intent=Root",
    );

    const dialog = desktopNexusDialog(page);
    await expect(dialog).toBeVisible();
    await expect(desktopNexusInput(dialog)).toBeFocused();
    const searchActions = dialog.getByRole("button", {
      name: "Actions for Notes",
    });
    await expect(searchActions).toBeVisible();
    await expect(
      desktopNexusListbox(dialog).getByRole("button", {
        name: "Actions for Notes",
      }),
    ).toHaveCount(0);

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

  test("retired WebSearch intent opens the explicit recovery state", async ({
    page,
  }) => {
    await page.goto("/libraries?nexus=1&intent=WebSearch&q=epistemology");

    const dialog = desktopNexusDialog(page);
    await expect(
      dialog.getByRole("heading", { name: "Web Search" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("heading", {
        name: "This link is no longer supported",
      }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open Browse" })).toBeVisible();
    await expect(dialog.getByText("epistemology")).toHaveCount(0);
  });

  for (const viewport of [
    { width: 769, height: 800 },
    { width: 844, height: 390 },
  ] as const) {
    test(`Actions remains pointer reachable at ${viewport.width}x${viewport.height} fine-pointer desktop`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await gotoWithWorkspaceSession(
        page,
        workspaceE2eDeviceId(
          testInfo,
          `e2e-nexus-narrow-actions-${viewport.width}x${viewport.height}`,
        ),
        workspaceWithNotesAndSearchPanes(),
        "/?nexus=1&intent=Root",
      );

      await expect(
        desktopNexusDialog(page).getByRole("button", {
          name: "Actions for Notes",
        }),
      ).toBeVisible();
    });
  }

  test("Home and End remain input-owned while the listbox has no nested controls", async ({ page }) => {
    await page.goto("/libraries?nexus=1&intent=Root");
    const dialog = desktopNexusDialog(page);
    await expect(dialog).toBeVisible();
    const input = desktopNexusInput(dialog);
    await expect(input).toBeFocused();
    await input.fill("Find");
    const listbox = desktopNexusListbox(dialog);
    await expect(listbox.getByRole("option").first()).toBeVisible();
    const activeBefore = await input.getAttribute("aria-activedescendant");
    await input.press("Home");
    await expect(input).toHaveJSProperty("selectionStart", 0);
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      activeBefore ?? "",
    );
    await input.press("End");
    await expect(input).toHaveJSProperty("selectionStart", 4);
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      activeBefore ?? "",
    );
    await expect(
      listbox.getByRole("option").getByRole("button"),
    ).toHaveCount(0);
    await expect(listbox.getByRole("option").getByRole("menuitem")).toHaveCount(0);
  });
});

const DESKTOP_PERFORMANCE_SAMPLE_COUNT = 20;
const DESKTOP_OPEN_INPUT_READY_BUDGET_MS = 50;
const DESKTOP_LOCAL_ROWS_BUDGET_MS = 50;
const DESKTOP_PANE_ACTIVATE_BUDGET_MS = 100;
const DESKTOP_PROVIDERS_BUDGET_MS = 250;
const DESKTOP_PERFORMANCE_TIMEOUT_MS = 180_000;
const DESKTOP_OPEN_INPUT_READY_MEASURE = "nexus-desktop-open-input-ready";
const DESKTOP_LOCAL_ROWS_MEASURE = "nexus-desktop-local-rows";
const DESKTOP_PANE_ACTIVATE_MEASURE = "nexus-desktop-pane-activate";
const DESKTOP_PROVIDERS_MEASURE = "nexus-desktop-providers-first-usable";

type DesktopPerformanceSample = {
  readonly duration: number;
  readonly phase: "Cold" | "Warm" | null;
  readonly source: "Openables" | "Owned" | null;
};

async function desktopMeasureSamples(
  page: Page,
  name: string,
): Promise<DesktopPerformanceSample[]> {
  return page.evaluate((measureName) =>
    performance
      .getEntriesByName(measureName, "measure")
      .map((entry) => {
        const detail = (entry as PerformanceMeasure).detail as
          | {
              phase?: "Cold" | "Warm";
              source?: "Openables" | "Owned";
            }
          | undefined;
        return {
          duration: entry.duration,
          phase: detail?.phase ?? null,
          source: detail?.source ?? null,
        };
      }),
  name);
}

async function waitForDesktopMeasureCount(
  page: Page,
  name: string,
  count: number,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (measureName) =>
            performance.getEntriesByName(measureName, "measure").length,
          name,
        ),
      { message: `expected ${count} ${name} user-timing samples` },
    )
    .toBe(count);
}

test.describe("desktop Nexus performance", () => {
  test("reports truthful cold and warm p95 gates", async ({ page }, testInfo) => {
    test.setTimeout(DESKTOP_PERFORMANCE_TIMEOUT_MS);
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-desktop-nexus-performance"),
      workspaceWithNotesAndSearchPanes(),
      "/notes",
    );
    const trigger = page.getByRole("button", {
      name: "Search or ask anything",
    });

    await trigger.click();
    await expect(desktopNexusDialog(page)).toBeVisible();
    await expect(desktopNexusInput(desktopNexusDialog(page))).toBeFocused();
    await waitForDesktopMeasureCount(page, DESKTOP_OPEN_INPUT_READY_MEASURE, 1);
    await page.keyboard.press("Escape");
    await expect(desktopNexusDialog(page)).toBeHidden();
    await page.evaluate((name) => performance.clearMeasures(name), DESKTOP_OPEN_INPUT_READY_MEASURE);

    for (let sample = 1; sample <= DESKTOP_PERFORMANCE_SAMPLE_COUNT; sample += 1) {
      await trigger.click();
      await waitForDesktopMeasureCount(page, DESKTOP_OPEN_INPUT_READY_MEASURE, sample);
      await page.keyboard.press("Escape");
      await expect(desktopNexusDialog(page)).toBeHidden();
    }
    const openSamples = await desktopMeasureSamples(page, DESKTOP_OPEN_INPUT_READY_MEASURE);

    await trigger.click();
    const dialog = desktopNexusDialog(page);
    const input = desktopNexusInput(dialog);
    await input.fill("n");
    await waitForDesktopMeasureCount(page, DESKTOP_LOCAL_ROWS_MEASURE, 1);
    await waitForDesktopMeasureCount(page, DESKTOP_PROVIDERS_MEASURE, 1);
    const [firstColdProviderSample] = await desktopMeasureSamples(
      page,
      DESKTOP_PROVIDERS_MEASURE,
    );
    expect(firstColdProviderSample).toMatchObject({
      phase: "Cold",
      source: "Openables",
    });
    const coldProviderSamples = [firstColdProviderSample];
    for (
      let sample = 1;
      sample < DESKTOP_PERFORMANCE_SAMPLE_COUNT;
      sample += 1
    ) {
      const coldPage = await page.context().newPage();
      try {
        await coldPage.goto("/notes");
        await coldPage.waitForLoadState("networkidle");
        await coldPage
          .getByRole("button", { name: "Search or ask anything" })
          .click();
        const coldDialog = desktopNexusDialog(coldPage);
        await expect(coldDialog).toBeVisible();
        await desktopNexusInput(coldDialog).fill(
          String.fromCharCode(97 + (sample % 26)),
        );
        await waitForDesktopMeasureCount(
          coldPage,
          DESKTOP_PROVIDERS_MEASURE,
          1,
        );
        const [coldSample] = await desktopMeasureSamples(
          coldPage,
          DESKTOP_PROVIDERS_MEASURE,
        );
        expect(coldSample).toMatchObject({
          phase: "Cold",
          source: "Openables",
        });
        coldProviderSamples.push(coldSample);
      } finally {
        await coldPage.close();
      }
    }
    await page.evaluate((name) => performance.clearMeasures(name), DESKTOP_LOCAL_ROWS_MEASURE);
    for (let sample = 1; sample <= DESKTOP_PERFORMANCE_SAMPLE_COUNT; sample += 1) {
      await input.fill(`nexus-local-${sample}`);
      await waitForDesktopMeasureCount(page, DESKTOP_LOCAL_ROWS_MEASURE, sample);
    }
    const localSamples = await desktopMeasureSamples(page, DESKTOP_LOCAL_ROWS_MEASURE);
    await input.fill("");
    await waitForDesktopMeasureCount(
      page,
      DESKTOP_LOCAL_ROWS_MEASURE,
      DESKTOP_PERFORMANCE_SAMPLE_COUNT + 1,
    );
    const setupProviderSampleCount = (
      await desktopMeasureSamples(page, DESKTOP_PROVIDERS_MEASURE)
    ).length;
    await input.fill("notes");
    await waitForDesktopMeasureCount(
      page,
      DESKTOP_PROVIDERS_MEASURE,
      setupProviderSampleCount + 1,
    );
    await input.fill("libraries");
    await waitForDesktopMeasureCount(
      page,
      DESKTOP_PROVIDERS_MEASURE,
      setupProviderSampleCount + 2,
    );
    await input.fill("");
    await page.evaluate(
      (name) => performance.clearMeasures(name),
      DESKTOP_PROVIDERS_MEASURE,
    );
    for (let sample = 1; sample <= DESKTOP_PERFORMANCE_SAMPLE_COUNT; sample += 1) {
      await input.fill(sample % 2 === 0 ? "notes" : "libraries");
      await waitForDesktopMeasureCount(
        page,
        DESKTOP_PROVIDERS_MEASURE,
        sample,
      );
    }
    const warmProviderSamples = await desktopMeasureSamples(page, DESKTOP_PROVIDERS_MEASURE);
    expect(warmProviderSamples.every((sample) => sample.phase === "Warm")).toBe(true);
    const warmOpenablesSamples = warmProviderSamples.filter(
      (sample) => sample.source === "Openables",
    );
    const warmOwnedSamples = warmProviderSamples.filter(
      (sample) => sample.source === "Owned",
    );

    await input.fill("");
    await expect(dialog.getByRole("option", { name: /^Search\b/ })).toBeVisible();
    for (let sample = 1; sample <= DESKTOP_PERFORMANCE_SAMPLE_COUNT; sample += 1) {
      const target = sample % 2 === 0 ? /^Notes\b/ : /^Search\b/;
      await desktopNexusDialog(page).getByRole("option", { name: target }).click();
      await expect(desktopNexusDialog(page)).toBeHidden();
      await waitForDesktopMeasureCount(
        page,
        DESKTOP_PANE_ACTIVATE_MEASURE,
        sample,
      );
      if (sample < DESKTOP_PERFORMANCE_SAMPLE_COUNT) {
        await trigger.click();
        await expect(desktopNexusDialog(page)).toBeVisible();
      }
    }
    const paneSamples = await desktopMeasureSamples(page, DESKTOP_PANE_ACTIVATE_MEASURE);

    const performanceSummary = {
      conditions: {
        browser: "lockfile Chromium",
        coldProviderSamples: {
          total: coldProviderSamples.length,
          winner: "Openables",
        },
        warmProviderSamples: {
          total: warmProviderSamples.length,
          openables: warmOpenablesSamples.length,
          owned: warmOwnedSamples.length,
        },
        sampleSizePerPhase: DESKTOP_PERFORMANCE_SAMPLE_COUNT,
      },
      measures: {
        "nexus-desktop-open-input-ready": {
          budgetMs: DESKTOP_OPEN_INPUT_READY_BUDGET_MS,
          p95Ms: p95(openSamples.map((sample) => sample.duration)),
          samples: openSamples.length,
        },
        "nexus-desktop-local-rows": {
          budgetMs: DESKTOP_LOCAL_ROWS_BUDGET_MS,
          p95Ms: p95(localSamples.map((sample) => sample.duration)),
          samples: localSamples.length,
        },
        "nexus-desktop-pane-activate": {
          budgetMs: DESKTOP_PANE_ACTIVATE_BUDGET_MS,
          p95Ms: p95(paneSamples.map((sample) => sample.duration)),
          samples: paneSamples.length,
        },
        "nexus-desktop-providers-first-usable": {
          cold: {
            budgetMs: DESKTOP_PROVIDERS_BUDGET_MS,
            p95Ms: p95(coldProviderSamples.map((sample) => sample.duration)),
            samples: coldProviderSamples.length,
          },
          warm: {
            budgetMs: DESKTOP_PROVIDERS_BUDGET_MS,
            p95Ms: p95(warmProviderSamples.map((sample) => sample.duration)),
            samples: warmProviderSamples.length,
            winningSources: {
              openables: warmOpenablesSamples.length,
              owned: warmOwnedSamples.length,
            },
          },
        },
      },
    };
    await testInfo.attach("nexus-desktop-performance.json", {
      body: JSON.stringify(performanceSummary, null, 2),
      contentType: "application/json",
    });
    console.info(`NEXUS_DESKTOP_PERFORMANCE_RESULT ${JSON.stringify(performanceSummary)}`);

    expect(openSamples).toHaveLength(DESKTOP_PERFORMANCE_SAMPLE_COUNT);
    expect(localSamples).toHaveLength(DESKTOP_PERFORMANCE_SAMPLE_COUNT);
    expect(paneSamples).toHaveLength(DESKTOP_PERFORMANCE_SAMPLE_COUNT);
    expect(coldProviderSamples).toHaveLength(DESKTOP_PERFORMANCE_SAMPLE_COUNT);
    expect(warmProviderSamples).toHaveLength(DESKTOP_PERFORMANCE_SAMPLE_COUNT);
    expect(p95(openSamples.map((sample) => sample.duration))).toBeLessThan(
      DESKTOP_OPEN_INPUT_READY_BUDGET_MS,
    );
    expect(p95(localSamples.map((sample) => sample.duration))).toBeLessThan(
      DESKTOP_LOCAL_ROWS_BUDGET_MS,
    );
    expect(p95(paneSamples.map((sample) => sample.duration))).toBeLessThan(
      DESKTOP_PANE_ACTIVATE_BUDGET_MS,
    );
    expect(p95(coldProviderSamples.map((sample) => sample.duration))).toBeLessThan(
      DESKTOP_PROVIDERS_BUDGET_MS,
    );
    expect(p95(warmProviderSamples.map((sample) => sample.duration))).toBeLessThan(
      DESKTOP_PROVIDERS_BUDGET_MS,
    );
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

const NEXUS_TASK_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
  { width: 568, height: 320 },
] as const;

async function expectNexusTaskProjection(
  dialog: Locator,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  await expect(dialog).toBeVisible();
  const projection = await dialog.evaluate((element) => {
    const wrapper = element.parentElement;
    if (!wrapper) {
      throw new Error("Nexus task dialog requires its modal projection.");
    }
    const frame = element.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const expectedTop = visualViewport?.offsetTop ?? 0;
    const expectedLeft = visualViewport?.offsetLeft ?? 0;
    const expectedWidth = visualViewport?.width ?? window.innerWidth;
    const expectedHeight = visualViewport?.height ?? window.innerHeight;
    const wrapperStyle = getComputedStyle(wrapper);
    const frameStyle = getComputedStyle(element);
    return {
      frame: {
        top: frame.top,
        right: frame.right,
        bottom: frame.bottom,
        left: frame.left,
        width: frame.width,
        height: frame.height,
      },
      expected: {
        top: expectedTop,
        right: expectedLeft + expectedWidth,
        bottom: expectedTop + expectedHeight,
        left: expectedLeft,
        width: expectedWidth,
        height: expectedHeight,
      },
      wrapperBackground: wrapperStyle.backgroundColor,
      wrapperBackdrop: wrapper.getAttribute("data-modal-backdrop"),
      wrapperZIndex: wrapperStyle.zIndex,
      nexusZIndex: getComputedStyle(document.documentElement)
        .getPropertyValue("--z-nexus")
        .trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      frameBackground: frameStyle.backgroundColor,
    };
  });

  expect(projection.frame.left).toBeCloseTo(projection.expected.left, 0);
  expect(projection.frame.top).toBeCloseTo(projection.expected.top, 0);
  expect(projection.frame.right).toBeCloseTo(projection.expected.right, 0);
  expect(projection.frame.bottom).toBeCloseTo(projection.expected.bottom, 0);
  expect(projection.frame.width).toBeCloseTo(projection.expected.width, 0);
  expect(projection.frame.height).toBeCloseTo(projection.expected.height, 0);
  expect(projection.frame.width).toBeCloseTo(viewport.width, 0);
  expect(projection.frame.height).toBeCloseTo(viewport.height, 0);
  expect(projection.wrapperBackdrop).toBe("true");
  expect(projection.wrapperBackground).toBe("rgba(0, 0, 0, 0)");
  expect(projection.wrapperZIndex).toBe(projection.nexusZIndex);
  expect(projection.bodyBackground).toMatch(/^rgb\(/);
  expect(projection.frameBackground).toBe(projection.bodyBackground);
  await expect(dialog.locator("[data-grabber]")).toHaveCount(0);
}

interface NexusGeometry {
  readonly wrapper: { x: number; y: number; width: number; height: number };
  readonly button: { x: number; y: number; width: number; height: number };
  readonly counter: { x: number; y: number; width: number; height: number };
  readonly counterBlockStart: number;
  readonly counterInlineEnd: number;
  readonly contentBottomPadding: number;
  readonly viewportHeight: number;
}

async function nexusGeometry(
  page: Page,
  paneCount: number,
): Promise<NexusGeometry> {
  const button = page.getByRole("button", {
    name:
      paneCount === 1
        ? "Open Nexus, 1 tab"
        : `Open Nexus, ${paneCount} tabs`,
  });
  await expect(button).toBeVisible();
  const wrapper = page.getByTestId("nexus-wrapper");
  const counter = button.getByText(String(paneCount), { exact: true });
  const content = activeWorkspacePane(page).getByTestId("pane-shell-body");
  await expect(counter).toHaveCount(1);
  const [wrapperElement, buttonElement, counterElement, contentElement] =
    await Promise.all([
      wrapper.elementHandle(),
      button.elementHandle(),
      counter.elementHandle(),
      content.elementHandle(),
  ]);
  if (
    !wrapperElement ||
    !buttonElement ||
    !counterElement ||
    !contentElement
  ) {
    throw new Error("Nexus geometry requires connected control elements.");
  }
  return page.evaluate(
    ({ wrapperElement, buttonElement, counterElement, contentElement }) => {
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const buttonRect = buttonElement.getBoundingClientRect();
      const counterRect = counterElement.getBoundingClientRect();
      return {
        wrapper: rect(wrapperElement),
        button: rect(buttonElement),
        counter: rect(counterElement),
        counterBlockStart: counterRect.top - buttonRect.top,
        counterInlineEnd: buttonRect.right - counterRect.right,
        contentBottomPadding: Number.parseFloat(
          getComputedStyle(contentElement).paddingBottom,
        ),
        viewportHeight: window.innerHeight,
      };
    },
    {
      wrapperElement,
      buttonElement,
      counterElement,
      contentElement,
    },
  );
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

test.describe("mobile Nexus task", () => {
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
    const paneBody = activeWorkspacePane(page).getByTestId("pane-shell-body");
    const nexusClearance = await paneBody.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    );
    expect(nexusClearance).toBeGreaterThan(0);
    await expect(trigger).toBeVisible();
    await trigger.tap();

    const dialog = nexusDialog(page);
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        paneBody.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).paddingBottom),
        ),
      )
      .toBe(0);
    await expect(dialog.getByRole("heading", { name: "Nexus" })).toBeFocused();
    await expect(dialog.getByRole("searchbox")).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Places" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Quick" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Open" })).toBeVisible();

    await dialog.getByRole("button", { name: "Search Open tab" }).tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      activeWorkspacePane(page).getByTestId("pane-shell-root"),
    ).toBeFocused();

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

  test("covers phone portrait and landscape visual viewports with an opaque task canvas", async ({
    page,
  }, testInfo) => {
    for (const viewport of NEXUS_TASK_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(
          testInfo,
          `e2e-nexus-task-${viewport.width}x${viewport.height}`,
        ),
        "/libraries",
      );

      const trigger = page.getByRole("button", {
        name: "Open Nexus, 1 tab",
      });
      const wrapper = page.getByTestId("nexus-wrapper");
      const mountedControl = wrapper.locator("button");
      const paneBody = activeWorkspacePane(page).getByTestId("pane-shell-body");
      const closedClearance = await paneBody.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom),
      );
      expect(closedClearance).toBeGreaterThan(0);
      await expect(trigger).toBeVisible();
      await trigger.tap();

      const dialog = nexusDialog(page);
      await expectNexusTaskProjection(dialog, viewport);
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(0);
      await expect(wrapper).toHaveCount(1);
      await expect(mountedControl).toBeHidden();
      await expect(mountedControl).toHaveAttribute("aria-hidden", "true");
      await expect(mountedControl).toHaveAttribute("inert", "");

      const deviceScaleFactor = await page.evaluate(
        () => window.devicePixelRatio,
      );
      const captureTask = async (
        variant: "default" | "reduced-motion" | "forced-colors",
      ) => {
        const artifactName = [
          "nexus-task",
          `${viewport.width}x${viewport.height}-css-px`,
          `dpr-${String(deviceScaleFactor).replace(".", "-")}`,
          variant,
        ].join("-");
        const artifactPath = testInfo.outputPath(`${artifactName}.png`);
        await page.screenshot({
          path: artifactPath,
          animations: "disabled",
        });
        await testInfo.attach(artifactName, {
          path: artifactPath,
          contentType: "image/png",
        });
      };

      await captureTask("default");
      if (viewport.width === 390 && viewport.height === 844) {
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(
          await page.evaluate(() =>
            window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          ),
        ).toBe(true);
        await captureTask("reduced-motion");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.emulateMedia({ forcedColors: "active" });
        expect(
          await page.evaluate(() =>
            window.matchMedia("(forced-colors: active)").matches,
          ),
        ).toBe(true);
        await captureTask("forced-colors");
        await page.emulateMedia({ forcedColors: "none" });
      }

      const findButton = dialog.getByRole("button", {
        name: "Find anything…",
      });
      const finalOpenPaneRow = dialog
        .locator('[data-switchboard-row-id^="OpenPane:"]')
        .last();
      await finalOpenPaneRow.scrollIntoViewIfNeeded();
      await expect(finalOpenPaneRow).toBeVisible();
      await expect(findButton).toBeVisible();
      const [rowBox, findBox] = await Promise.all([
        finalOpenPaneRow.boundingBox(),
        findButton.boundingBox(),
      ]);
      if (!rowBox || !findBox) {
        throw new Error("Visible Nexus rows and Find require bounding boxes.");
      }
      expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(findBox.y + 1);

      const box = await dialog.boundingBox();
      if (!box) throw new Error("Visible Nexus task requires a bounding box.");
      await page.mouse.move(box.x + box.width / 2, box.y + 24);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 24);
      await page.mouse.up();
      await expect(dialog).toBeVisible();

      await dialog.getByRole("button", { name: "Done" }).tap();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeVisible();
      await expect(trigger).toBeFocused();
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(closedClearance);
    }
  });

  test("Nexus row actions dismiss before the task and restore their trigger", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-action-menu-ordering"),
      workspaceWithNotesAndSearchPanes(),
      "/notes",
    );

    await page.getByRole("button", { name: "Open Nexus, 2 tabs" }).tap();
    const nexus = nexusDialog(page);
    const actions = nexus.getByRole("button", {
      name: "Actions for Notes",
    });
    const menu = page.getByRole("menu", { name: "Actions for Notes" });
    const nexusProjection = nexus.locator("..");
    const nexusUrl = page.url();

    await actions.tap();
    await expect(menu).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(nexus).not.toHaveAttribute("inert");
    await expect(nexusProjection).not.toHaveAttribute("data-suspended");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(page).toHaveURL(nexusUrl);
    await expect(actions).toBeFocused();

    await actions.tap();
    await expect(menu).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(nexus).not.toHaveAttribute("inert");
    await expect(nexusProjection).not.toHaveAttribute("data-suspended");
    await page.goBack();
    await expect(menu).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(page).toHaveURL(nexusUrl);
    await expect(actions).toBeFocused();
  });

  test("browser Back pops one Nexus page before dismissing Root", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-back"),
      "/libraries",
    );

    const trigger = page.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await trigger.tap();
    const dialog = nexusDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Find anything…" }).tap();
    await expect(dialog.getByRole("heading", { name: "Find" })).toBeVisible();
    await dialog
      .getByRole("searchbox", { name: "Find anything" })
      .fill("stats");

    const urlBeforeBack = page.url();
    await page.goBack();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Nexus" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Find" })).toHaveCount(0);
    await expect(page).toHaveURL(urlBeforeBack);

    await page.goBack();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(urlBeforeBack);
    await expect(trigger).toBeFocused();
  });

  test("dirty Add guard confirms browser Back, Escape, and visible Back", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-nested-confirmation"),
      "/libraries",
    );

    const trigger = page.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await trigger.tap();
    const nexus = nexusDialog(page);
    await nexus.getByRole("button", { name: "Import" }).tap();
    const links = nexus.getByRole("textbox", { name: "Links" });
    await links.fill("https://example.com/article");

    const confirmation = page.getByRole("dialog", {
      name: "Discard unfinished work?",
    });
    const urlBeforeExit = page.url();

    await page.goBack();
    await expect(confirmation).toBeVisible();
    const suspendedNexus = page.locator(
      '[role="dialog"][aria-label="Nexus"]',
    );
    await expect(suspendedNexus).toHaveAttribute("inert", "");
    await expect(suspendedNexus).not.toHaveAttribute("aria-modal");
    await expect(suspendedNexus.locator("..")).toHaveAttribute(
      "data-suspended",
      "true",
    );
    await expect
      .poll(() =>
        suspendedNexus.evaluate(
          (element) =>
            getComputedStyle(element).backgroundColor !==
            "rgba(0, 0, 0, 0)",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        confirmation.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const topmost = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return topmost !== null && element.contains(topmost);
        }),
      )
      .toBe(true);

    await confirmation
      .getByRole("button", { name: "Keep working" })
      .tap();
    await expect(confirmation).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(links).toHaveValue("https://example.com/article");
    await expect(page).toHaveURL(urlBeforeExit);

    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "Keep working" })
      .tap();
    await expect(confirmation).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(links).toHaveValue("https://example.com/article");
    await expect(page).toHaveURL(urlBeforeExit);

    await nexus.getByRole("button", { name: "Back", exact: true }).tap();
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "Keep working" })
      .tap();
    await expect(confirmation).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(links).toHaveValue("https://example.com/article");
    await expect(page).toHaveURL(urlBeforeExit);

    await nexus
      .getByRole("button", { name: "Close Add content" })
      .tap();
    await page
      .getByRole("dialog", { name: "Discard unfinished work?" })
      .getByRole("button", { name: "Discard" })
      .tap();
    await expect(nexus).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(urlBeforeExit);
  });

  test("rotation and mobile-desktop breakpoint changes preserve Find and query", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-orientation"),
      "/libraries",
    );
    await page.getByRole("button", { name: "Open Nexus, 1 tab" }).tap();
    const nexus = nexusDialog(page);
    await nexus.getByRole("button", { name: "Find anything…" }).tap();
    await nexus
      .getByRole("searchbox", { name: "Find anything" })
      .fill("stats");

    await page.setViewportSize({ width: 568, height: 320 });
    await expectNexusTaskProjection(nexus, { width: 568, height: 320 });
    await expect(
      nexus.getByRole("searchbox", { name: "Find anything" }),
    ).toHaveValue("stats");

    await page.setViewportSize({ width: 1200, height: 800 });
    const desktop = nexusDialog(page);
    await expect(desktop).toBeVisible();
    await expect(
      desktop.getByRole("combobox", { name: "Find anything" }),
    ).toHaveValue("stats");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = nexusDialog(page);
    await expectNexusTaskProjection(mobile, { width: 390, height: 844 });
    await expect(
      mobile.getByRole("searchbox", { name: "Find anything" }),
    ).toHaveValue("stats");
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

  test("keeps target, counter, anchor, and obstruction geometry fixed across tab counts", async ({
    page,
  }, testInfo) => {
    for (const rootFontSize of [16, 32] as const) {
      const measurements: NexusGeometry[] = [];
      for (const paneCount of [1, 9, 12] as const) {
        const panes = Array.from({ length: paneCount }, (_, index) =>
          makeWorkspacePane(`pane-${index}`, "/notes"),
        );
        await gotoWithWorkspaceSession(
          page,
          workspaceE2eDeviceId(
            testInfo,
            `e2e-nexus-geometry-${rootFontSize}-${paneCount}`,
          ),
          makeWorkspaceState(panes, {
            activePrimaryPaneId: panes[0]!.id,
          }),
          "/notes",
        );
        await page.evaluate((fontSize) => {
          document.documentElement.style.fontSize = `${fontSize}px`;
        }, rootFontSize);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        measurements.push(await nexusGeometry(page, paneCount));
      }

      const [expected, ...rest] = measurements;
      expect(expected).toBeDefined();
      expect(expected!.wrapper.width).toBeCloseTo(48, 1);
      expect(expected!.wrapper.height).toBeCloseTo(48, 1);
      expect(expected!.button.width).toBeCloseTo(48, 1);
      expect(expected!.button.height).toBeCloseTo(48, 1);
      expect(expected!.counterBlockStart).toBeCloseTo(1, 1);
      expect(expected!.counterInlineEnd).toBeCloseTo(1, 1);
      expect(expected!.contentBottomPadding).toBe(
        Math.ceil(expected!.viewportHeight - expected!.wrapper.y),
      );
      for (const measurement of rest) {
        expect(measurement).toEqual(expected);
      }
    }
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
