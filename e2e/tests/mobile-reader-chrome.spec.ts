import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspaceE2eDeviceId,
} from "./workspace";

interface MediaSeed {
  media_id: string;
}

interface ArticleSeed extends MediaSeed {
  focus_exact: string;
}

interface AudioSeed extends MediaSeed {
  title: string;
  stream_path: string;
  duration_seconds: number;
}

interface ChromeSurfaceSample {
  phase: string;
  progress: number;
  translateY: number;
  inert: boolean;
  ariaHidden: string | null;
  top: number;
  bottom: number;
  height: number;
}

interface ChromeSample {
  appBar: ChromeSurfaceSample;
  paneToolbar: ChromeSurfaceSample;
  nexus: ChromeSurfaceSample;
  viewportHeight: number;
  scrollTop: number;
  scrollport: {
    top: number;
    bottom: number;
    clientHeight: number;
    scrollHeight: number;
  };
  activeElement: string;
  reducedMotion: boolean;
  href: string;
}

const formats = [
  {
    name: "Web",
    seedFile: "non-pdf-media.json",
    scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
  },
  {
    name: "EPUB",
    seedFile: "epub-media.json",
    scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
    toolbarControlName: "Next section",
  },
  {
    name: "transcript",
    seedFile: "youtube-media.json",
    scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
  },
  {
    name: "PDF",
    seedFile: "pdf-media.json",
    scrollport: (pane: Locator) => pane.getByLabel("PDF document"),
    toolbarControlName: "Next page",
  },
] as const;

function readSeed<T>(file: string): T {
  return JSON.parse(
    readFileSync(path.join(__dirname, "..", ".seed", file), "utf8"),
  ) as T;
}

async function expectOk(
  response: {
    ok(): boolean;
    status(): number;
    statusText(): string;
    text(): Promise<string>;
  },
  operation: string,
): Promise<void> {
  if (response.ok()) {
    return;
  }
  throw new Error(
    `${operation} failed: ${response.status()} ${response.statusText()} ${(await response.text()).slice(0, 400)}`,
  );
}

async function resetReaderProgress(page: Page, mediaId: string): Promise<void> {
  await expectOk(
    await page.request.post("/api/consumption/commands", {
      headers: stateChangingApiHeaders(),
      data: {
        kind: "ResetProgress",
        clientMutationId: randomUUID(),
        mediaId,
      },
    }),
    `ResetProgress(${mediaId})`,
  );
}

async function waitForAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

async function readChromeSample(
  page: Page,
  scrollport: Locator,
): Promise<ChromeSample> {
  const reader = await scrollport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: element.scrollTop,
      geometry: {
        top: rect.top,
        bottom: rect.bottom,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      },
    };
  });
  return page.evaluate((readerState) => {
    const activePane = document.querySelector(
      '[data-pane-id][data-active="true"]',
    );
    const readSurface = (element: Element | null): ChromeSurfaceSample => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("A registered mobile chrome surface is missing.");
      }
      const style = getComputedStyle(element);
      const progress = Number.parseFloat(
        style.getPropertyValue("--mobile-chrome-collapse"),
      );
      if (!Number.isFinite(progress)) {
        throw new Error("Mobile chrome collapse progress is not numeric.");
      }
      const rect = element.getBoundingClientRect();
      return {
        phase: element.dataset.mobileChromePhase ?? "",
        progress,
        translateY:
          style.transform === "none"
            ? 0
            : new DOMMatrixReadOnly(style.transform).m42,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
      };
    };
    return {
      appBar: readSurface(
        document.querySelector("header[data-mobile-chrome-phase]"),
      ),
      paneToolbar: readSurface(
        activePane?.querySelector(
          '[data-testid="pane-shell-chrome"][data-mobile-chrome-phase]',
        ) ?? null,
      ),
      nexus: readSurface(
        document.querySelector(
          'button[aria-label^="Open Nexus,"][data-mobile-chrome-phase]',
        ),
      ),
      viewportHeight: window.innerHeight,
      scrollTop: readerState.top,
      scrollport: readerState.geometry,
      activeElement:
        document.activeElement instanceof HTMLElement
          ? document.activeElement.outerHTML.slice(0, 500)
          : String(document.activeElement),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      href: location.href,
    };
  }, reader);
}

async function expectChromePhase(
  page: Page,
  scrollport: Locator,
  phase: "Visible" | "Hidden" | "Pinned" | "Settling",
): Promise<ChromeSample> {
  await expect
    .poll(
      async () => {
        const sample = await readChromeSample(page, scrollport);
        return [
          sample.appBar.phase,
          sample.paneToolbar.phase,
          sample.nexus.phase,
        ];
      },
      phase === "Settling"
        ? { intervals: [10, 20, 40, 60], timeout: 1_000 }
        : undefined,
    )
    .toEqual([phase, phase, phase]);
  return readChromeSample(page, scrollport);
}

async function dispatchTouchDrag(
  page: Page,
  scrollport: Locator,
  fingerDeltaY: number,
  steps: number,
): Promise<ChromeSample[]> {
  const box = await scrollport.boundingBox();
  if (!box) {
    throw new Error("Reader scrollport has no visible bounding box.");
  }
  const x = box.x + Math.min(box.width - 24, Math.max(24, box.width / 2));
  const startY =
    fingerDeltaY < 0
      ? box.y + Math.min(box.height - 28, Math.max(80, box.height * 0.8))
      : box.y + Math.min(box.height - 100, Math.max(32, box.height * 0.28));
  const cdp = await page.context().newCDPSession(page);
  const point = (y: number) => [
    {
      id: 1,
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    },
  ];
  const samples: ChromeSample[] = [];
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(startY),
    });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(startY + (fingerDeltaY * step) / steps),
      });
      await waitForAnimationFrame(page);
      samples.push(await readChromeSample(page, scrollport));
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
  return samples;
}

async function expectTrustedForwardRetreat(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  const before = await readChromeSample(page, scrollport);
  const samples = await dispatchTouchDrag(page, scrollport, -128, 24);
  const tracking = samples.filter(
    (sample) => sample.appBar.progress > 0.02 && sample.appBar.progress < 0.98,
  );
  expect(
    tracking.length,
    `expected proportional intermediate chrome samples; samples=${JSON.stringify(samples)}`,
  ).toBeGreaterThan(1);
  for (let index = 0; index < samples.length; index += 1) {
    const prior = index === 0 ? before : samples[index - 1];
    const sample = samples[index];
    if (!prior || !sample) {
      throw new Error("Trusted forward samples lost their ordering.");
    }
    expect(
      sample.scrollTop,
      `forward scroll must be monotonic; samples=${JSON.stringify(samples)}`,
    ).toBeGreaterThanOrEqual(prior.scrollTop - 0.5);
    expect(
      sample.appBar.progress,
      `collapse progress must be monotonic; samples=${JSON.stringify(samples)}`,
    ).toBeGreaterThanOrEqual(prior.appBar.progress - 0.01);
    expect(
      Math.abs(sample.scrollport.top - before.scrollport.top),
      "chrome motion must not move the reader viewport top",
    ).toBeLessThan(1);
    expect(
      Math.abs(sample.scrollport.bottom - before.scrollport.bottom),
      "chrome motion must not move the reader viewport bottom",
    ).toBeLessThan(1);
    expect(sample.scrollport.clientHeight).toBe(before.scrollport.clientHeight);
    expect(sample.href).toBe(before.href);
  }
  for (const sample of tracking) {
    const forwardDistance = sample.scrollTop - before.scrollTop;
    const expectedProgress = Math.min(
      1,
      Math.max(0, (forwardDistance - 8) / 64),
    );
    const progress = [
      sample.appBar.progress,
      sample.paneToolbar.progress,
      sample.nexus.progress,
    ];
    expect(
      Math.abs(sample.appBar.progress - expectedProgress),
      `collapse must track (scroll distance - 8px dead zone) / 64px; sample=${JSON.stringify(sample)} before=${JSON.stringify(before)}`,
    ).toBeLessThan(0.12);
    expect(Math.max(...progress) - Math.min(...progress)).toBeLessThan(0.01);
    expect(sample.appBar.phase).toBe("Tracking");
    expect(sample.paneToolbar.phase).toBe("Tracking");
    expect(sample.nexus.phase).toBe("Tracking");
    expect(sample.appBar.translateY).toBeLessThan(0);
    if (sample.paneToolbar.height > 1) {
      expect(sample.paneToolbar.translateY).toBeLessThan(0);
    }
    expect(sample.nexus.translateY).toBeGreaterThan(0);
    expect(sample.appBar.inert).toBe(true);
    expect(sample.paneToolbar.inert).toBe(true);
    expect(sample.nexus.inert).toBe(true);
    expect(sample.appBar.ariaHidden).toBe("true");
    expect(sample.paneToolbar.ariaHidden).toBe("true");
    expect(sample.nexus.ariaHidden).toBe("true");
  }
  expect(samples.at(-1)?.scrollTop ?? before.scrollTop).toBeGreaterThan(
    before.scrollTop,
  );
  const firstHiddenSample = samples.find(
    (sample) => sample.appBar.progress >= 0.99,
  );
  expect(
    firstHiddenSample,
    `expected trusted input to traverse the hidden endpoint; samples=${JSON.stringify(samples)}`,
  ).toBeDefined();
  expect(
    Math.abs(
      (firstHiddenSample?.scrollTop ?? before.scrollTop) -
        before.scrollTop -
        72,
    ),
    "hidden endpoint must follow the 8px dead zone plus 64px collapse travel",
  ).toBeLessThan(12);

  const hidden = await expectChromePhase(page, scrollport, "Hidden");
  expect(hidden.appBar.progress).toBe(1);
  expect(hidden.paneToolbar.progress).toBe(1);
  expect(hidden.nexus.progress).toBe(1);
  expect(hidden.appBar.bottom).toBeLessThanOrEqual(1);
  if (hidden.paneToolbar.height > 1) {
    expect(hidden.paneToolbar.bottom).toBeLessThanOrEqual(1);
  }
  expect(hidden.nexus.top).toBeGreaterThanOrEqual(hidden.viewportHeight - 1);
  for (const surface of [hidden.appBar, hidden.paneToolbar, hidden.nexus]) {
    expect(surface.inert).toBe(true);
    expect(surface.ariaHidden).toBe("true");
  }
}

async function expectTrustedReverseReveal(
  page: Page,
  scrollport: Locator,
  priorReverseDistance: number,
): Promise<void> {
  const hidden = await readChromeSample(page, scrollport);
  const samples = await dispatchTouchDrag(page, scrollport, 128, 64);
  const reverseSamples = samples.filter(
    (sample) => sample.scrollTop < hidden.scrollTop,
  );
  expect(reverseSamples.length).toBeGreaterThan(0);
  for (let index = 1; index < reverseSamples.length; index += 1) {
    const prior = reverseSamples[index - 1];
    const sample = reverseSamples[index];
    if (!prior || !sample) {
      throw new Error("Trusted reverse samples lost their ordering.");
    }
    expect(
      sample.scrollTop,
      `reverse scroll must be monotonic; samples=${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(prior.scrollTop + 0.5);
    expect(
      sample.appBar.progress,
      `reveal progress must be monotonic; samples=${JSON.stringify(samples)}`,
    ).toBeLessThanOrEqual(prior.appBar.progress + 0.01);
  }
  for (const sample of reverseSamples.filter(
    (candidate) =>
      candidate.appBar.progress > 0.02 && candidate.appBar.progress < 0.98,
  )) {
    const reverseDistance =
      priorReverseDistance + hidden.scrollTop - sample.scrollTop;
    const expectedProgress =
      1 - Math.min(1, Math.max(0, (reverseDistance - 8) / 64));
    expect(
      Math.abs(sample.appBar.progress - expectedProgress),
      `reveal must track 1 - (reverse distance - 8px dead zone) / 64px; sample=${JSON.stringify(sample)} hidden=${JSON.stringify(hidden)}`,
    ).toBeLessThan(0.12);
  }
  const firstRevealedSample = reverseSamples.find(
    (sample) => sample.appBar.progress < 0.99,
  );
  expect(
    firstRevealedSample,
    `expected chrome to reveal after the reversal dead zone; samples=${JSON.stringify(samples)}`,
  ).toBeDefined();
  expect(
    priorReverseDistance +
      hidden.scrollTop -
      (firstRevealedSample?.scrollTop ?? hidden.scrollTop),
  ).toBeGreaterThan(8);
  const visible = await expectChromePhase(page, scrollport, "Visible");
  expect(visible.appBar.progress).toBe(0);
  expect(visible.paneToolbar.progress).toBe(0);
  expect(visible.nexus.progress).toBe(0);
  for (const surface of [visible.appBar, visible.paneToolbar, visible.nexus]) {
    expect(surface.inert).toBe(false);
    expect(surface.ariaHidden).toBeNull();
  }
}

async function expectTrustedReverseDeadZone(
  page: Page,
  scrollport: Locator,
): Promise<number> {
  const before = await readChromeSample(page, scrollport);
  const box = await scrollport.boundingBox();
  if (!box) {
    throw new Error("Reader scrollport has no visible bounding box.");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -4);
  await expect
    .poll(() => scrollport.evaluate((element) => element.scrollTop))
    .toBeLessThan(before.scrollTop);
  const sample = await readChromeSample(page, scrollport);
  const reverseDistance = before.scrollTop - sample.scrollTop;
  expect(
    reverseDistance,
    `trusted wheel must produce a measurable delta inside the 8px dead zone; before=${JSON.stringify(before)} sample=${JSON.stringify(sample)}`,
  ).toBeGreaterThan(0);
  expect(reverseDistance).toBeLessThanOrEqual(8);
  expect(sample.appBar.phase).toBe("Hidden");
  expect(sample.paneToolbar.phase).toBe("Hidden");
  expect(sample.nexus.phase).toBe("Hidden");
  expect(sample.appBar.progress).toBe(1);
  expect(sample.paneToolbar.progress).toBe(1);
  expect(sample.nexus.progress).toBe(1);
  return reverseDistance;
}

async function expectTrustedWheelRecovery(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  const hidden = await expectChromePhase(page, scrollport, "Hidden");
  const box = await scrollport.boundingBox();
  if (!box) {
    throw new Error("Reader scrollport has no visible bounding box.");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -96);
  await expect
    .poll(() => scrollport.evaluate((element) => element.scrollTop))
    .toBeLessThan(hidden.scrollTop);
  await expectChromePhase(page, scrollport, "Visible");
}

async function expectTrustedKeyboardTopRecovery(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  const hidden = await expectChromePhase(page, scrollport, "Hidden");
  expect(hidden.scrollTop).toBeGreaterThan(0);
  await scrollport.press("Home");
  await expect
    .poll(() => scrollport.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(1);
  await expectChromePhase(page, scrollport, "Visible");
}

async function expectTrustedSettleLifecycle(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  await page.evaluate(() => {
    const auditWindow = window as typeof window & {
      __nexusMobileChromeTransitionAudit?: {
        runs: number;
        ends: number;
        cancels: number;
        settlingAccessible: boolean;
        listener: EventListener;
      };
    };
    const priorAudit = auditWindow.__nexusMobileChromeTransitionAudit;
    if (priorAudit) {
      document.removeEventListener("transitionrun", priorAudit.listener, true);
      document.removeEventListener("transitionend", priorAudit.listener, true);
      document.removeEventListener(
        "transitioncancel",
        priorAudit.listener,
        true,
      );
    }
    const audit = {
      runs: 0,
      ends: 0,
      cancels: 0,
      settlingAccessible: false,
      listener: ((event: TransitionEvent) => {
        if (
          event.propertyName === "--mobile-chrome-collapse" &&
          event.target instanceof HTMLElement &&
          event.target.matches("[data-mobile-chrome-phase]")
        ) {
          if (event.type === "transitionrun") {
            audit.runs += 1;
            const surfaces = [
              document.querySelector("header[data-mobile-chrome-phase]"),
              document.querySelector(
                '[data-pane-id][data-active="true"] [data-testid="pane-shell-chrome"][data-mobile-chrome-phase]',
              ),
              document.querySelector(
                'button[aria-label^="Open Nexus,"][data-mobile-chrome-phase]',
              ),
            ];
            audit.settlingAccessible =
              surfaces.every(
                (surface) =>
                  surface instanceof HTMLElement &&
                  surface.dataset.mobileChromePhase === "Settling" &&
                  surface.inert &&
                  surface.getAttribute("aria-hidden") === "true",
              );
          } else if (event.type === "transitionend") {
            audit.ends += 1;
          } else if (event.type === "transitioncancel") {
            audit.cancels += 1;
          }
        }
      }) as EventListener,
    };
    auditWindow.__nexusMobileChromeTransitionAudit = audit;
    document.addEventListener("transitionrun", audit.listener, true);
    document.addEventListener("transitionend", audit.listener, true);
    document.addEventListener("transitioncancel", audit.listener, true);
  });

  try {
    const resetAudit = () =>
      page.evaluate(() => {
        const auditWindow = window as typeof window & {
          __nexusMobileChromeTransitionAudit?: {
            runs: number;
            ends: number;
            cancels: number;
            settlingAccessible: boolean;
          };
        };
        const audit = auditWindow.__nexusMobileChromeTransitionAudit;
        if (!audit) {
          throw new Error("Mobile chrome transition audit is not installed.");
        }
        audit.runs = 0;
        audit.ends = 0;
        audit.cancels = 0;
        audit.settlingAccessible = false;
      });
    const readAudit = () =>
      page.evaluate(() => {
        const auditWindow = window as typeof window & {
          __nexusMobileChromeTransitionAudit?: {
            runs: number;
            ends: number;
            cancels: number;
            settlingAccessible: boolean;
          };
        };
        const audit = auditWindow.__nexusMobileChromeTransitionAudit;
        if (!audit) {
          throw new Error("Mobile chrome transition audit is not installed.");
        }
        return {
          runs: audit.runs,
          ends: audit.ends,
          cancels: audit.cancels,
          settlingAccessible: audit.settlingAccessible,
        };
      });
    const waitForTransitionRun = async () => {
      const handle = await page.waitForFunction(
        () => {
          const auditWindow = window as typeof window & {
            __nexusMobileChromeTransitionAudit?: { runs: number };
          };
          return (
            (auditWindow.__nexusMobileChromeTransitionAudit?.runs ?? 0) > 0
          );
        },
        undefined,
        { polling: "raf", timeout: 1_000 },
      );
      await handle.dispose();
    };

    await resetAudit();
    const interruptedSamples = await dispatchTouchDrag(
      page,
      scrollport,
      -32,
      8,
    );
    expect(
      interruptedSamples.some(
        (sample) =>
          sample.appBar.progress > 0.05 && sample.appBar.progress < 0.95,
      ),
      `partial trusted drag must stop between endpoints; samples=${JSON.stringify(interruptedSamples)}`,
    ).toBe(true);
    await waitForTransitionRun();
    const interruptedAudit = await readAudit();
    expect(interruptedAudit.runs).toBeGreaterThan(0);
    expect(interruptedAudit.settlingAccessible).toBe(true);
    await dispatchTouchDrag(page, scrollport, 64, 8);
    const visible = await expectChromePhase(page, scrollport, "Visible");
    for (const surface of [
      visible.appBar,
      visible.paneToolbar,
      visible.nexus,
    ]) {
      expect(surface.inert).toBe(false);
      expect(surface.ariaHidden).toBeNull();
    }
    await expect
      .poll(async () => (await readAudit()).cancels)
      .toBeGreaterThan(0);

    await resetAudit();
    const completedSamples = await dispatchTouchDrag(
      page,
      scrollport,
      -32,
      8,
    );
    expect(
      completedSamples.some(
        (sample) =>
          sample.appBar.progress > 0.05 && sample.appBar.progress < 0.95,
      ),
      `second partial trusted drag must stop between endpoints; samples=${JSON.stringify(completedSamples)}`,
    ).toBe(true);
    await waitForTransitionRun();
    await expectChromePhase(page, scrollport, "Visible");
    await expect
      .poll(async () => (await readAudit()).ends)
      .toBeGreaterThan(0);
    expect(await readAudit()).toMatchObject({ settlingAccessible: true });
  } finally {
    await page.evaluate(() => {
      const auditWindow = window as typeof window & {
        __nexusMobileChromeTransitionAudit?: {
          listener: EventListener;
        };
      };
      const audit = auditWindow.__nexusMobileChromeTransitionAudit;
      if (audit) {
        document.removeEventListener("transitionrun", audit.listener, true);
        document.removeEventListener("transitionend", audit.listener, true);
        document.removeEventListener("transitioncancel", audit.listener, true);
      }
      delete auditWindow.__nexusMobileChromeTransitionAudit;
    });
  }
}

const INTERACTIVE_READER_TARGET = [
  "a[href]",
  "audio[controls]",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
  "video[controls]",
  "[contenteditable]",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='gridcell']",
  "[role='link']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='treeitem']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

async function expectBlankTapReveal(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  const pane = activeWorkspacePane(page);
  const paneId = await pane.getAttribute("data-pane-id");
  if (!paneId) {
    throw new Error("Active pane has no stable pane id.");
  }
  const href = page.url();
  const dialogCount = await page.getByRole("dialog").count();
  const position = await scrollport.evaluate(
    (element, interactiveTargetSelector) => {
      if (!window.getSelection()?.isCollapsed) {
        throw new Error("Blank-canvas tap candidate has a live selection.");
      }
      const rect = element.getBoundingClientRect();
      const xCandidates = [
        12,
        rect.width * 0.25,
        rect.width * 0.5,
        rect.width - 12,
      ];
      const yCandidates = [
        24,
        80,
        rect.height * 0.35,
        rect.height * 0.65,
        rect.height - 24,
      ];
      for (const y of yCandidates) {
        for (const x of xCandidates) {
          if (x <= 0 || y <= 0 || x >= rect.width || y >= rect.height) {
            continue;
          }
          const target = document.elementFromPoint(rect.left + x, rect.top + y);
          const interactive = target
            ? target.closest(interactiveTargetSelector)
            : null;
          if (
            !target ||
            !element.contains(target) ||
            (interactive !== null &&
              interactive !== element &&
              element.contains(interactive)) ||
            target.closest("[data-reader-tap-handled='true']") ||
            target.closest("[data-mobile-chrome-phase]")
          ) {
            continue;
          }
          return {
            x,
            y,
            target: target.outerHTML.slice(0, 300),
          };
        }
      }
      throw new Error(
        `Reader has no verified blank-canvas tap point: ${element.outerHTML.slice(0, 500)}`,
      );
    },
    INTERACTIVE_READER_TARGET,
  );

  expect(
    position.target,
    "blank-canvas target precondition must identify a real reader descendant",
  ).not.toBe("");
  await scrollport.tap({ position });
  await expectChromePhase(page, scrollport, "Visible");
  expect(page.url()).toBe(href);
  await expect(activeWorkspacePane(page)).toHaveAttribute("data-pane-id", paneId);
  await expect(page.getByRole("dialog")).toHaveCount(dialogCount);
  expect(
    await page.evaluate(() => window.getSelection()?.isCollapsed ?? true),
  ).toBe(true);
}

async function readContentGeometry(
  scrollport: Locator,
  content: Locator,
): Promise<{
  clientWidth: number;
  clientHeight: number;
  contentLeft: number;
  contentTop: number;
  contentWidth: number;
  contentHeight: number;
}> {
  const contentHandle = await content.elementHandle();
  if (!contentHandle) {
    throw new Error("Reader content has no element handle.");
  }
  return scrollport.evaluate((element, target) => {
    if (!(target instanceof HTMLElement)) {
      throw new Error("Reader content is not an HTMLElement.");
    }
    const viewport = element.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      contentLeft: rect.left - viewport.left + element.scrollLeft,
      contentTop: rect.top - viewport.top + element.scrollTop,
      contentWidth: rect.width,
      contentHeight: rect.height,
    };
  }, contentHandle);
}

function queryFromExactText(exact: string): string {
  return exact.trim().split(/\s+/).slice(0, 3).join(" ");
}

function toneWav(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const dataSize = sampleRate * durationSeconds;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let sample = 0; sample < dataSize; sample += 1) {
    bytes[44 + sample] =
      128 +
      Math.round(Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 48);
  }
  return bytes;
}

async function removeAudioFromLectern(
  page: Page,
  mediaId: string,
): Promise<void> {
  const response = await page.request.get("/api/lectern");
  await expectOk(response, "GET /api/lectern");
  const payload = (await response.json()) as {
    data: { items: Array<{ itemId: string; mediaId: string }> };
  };
  for (const item of payload.data.items) {
    if (item.mediaId !== mediaId) {
      continue;
    }
    await expectOk(
      await page.request.post("/api/lectern/commands", {
        headers: stateChangingApiHeaders(),
        data: {
          kind: "RemoveItem",
          clientMutationId: randomUUID(),
          itemId: item.itemId,
        },
      }),
      `RemoveItem(${item.itemId})`,
    );
  }
}

async function placeAudioInLectern(page: Page, mediaId: string): Promise<void> {
  await removeAudioFromLectern(page, mediaId);
  await resetReaderProgress(page, mediaId);
  await expectOk(
    await page.request.post("/api/lectern/commands", {
      headers: stateChangingApiHeaders(),
      data: {
        kind: "PlaceItems",
        clientMutationId: randomUUID(),
        mediaIds: [mediaId],
        placement: { kind: "Last" },
      },
    }),
    `PlaceItems(${mediaId})`,
  );
}

async function expectRouteFocusOnLandmark(page: Page): Promise<void> {
  const landmark = activeWorkspacePane(page).locator(
    '[data-pane-focus-landmark="true"]',
  );
  await expect(landmark).toBeFocused();
  expect(
    await page.evaluate(() => {
      const active = document.activeElement;
      return (
        active instanceof Element &&
        active.closest("[data-mobile-chrome-phase]") !== null
      );
    }),
  ).toBe(false);
}

async function expectFocusOnVisibleChromeOrLandmark(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const activePane = document.querySelector(
          '[data-pane-id][data-active="true"]',
        );
        const active = document.activeElement;
        if (
          !activePane ||
          !(active instanceof HTMLElement) ||
          active === document.body ||
          !active.isConnected ||
          active.closest("[inert]")
        ) {
          return {
            valid: false,
            active: active instanceof HTMLElement ? active.outerHTML : null,
          };
        }
        const landmark = active.closest('[data-pane-focus-landmark="true"]');
        const visibleChrome = active.closest(
          '[data-mobile-chrome-phase="Visible"],[data-mobile-chrome-phase="Pinned"]',
        );
        const isFocusableCommand = active.matches(
          "button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,textarea:not(:disabled),[contenteditable],[role='button'],[role='link'],[tabindex]:not([tabindex='-1'])",
        );
        const isGlobalChrome =
          visibleChrome?.matches("header[data-mobile-chrome-phase]") === true ||
          visibleChrome?.matches(
            'button[aria-label^="Open Nexus,"][data-mobile-chrome-phase]',
          ) === true;
        const isActivePaneChrome =
          visibleChrome !== null && activePane.contains(visibleChrome);
        return {
          valid:
            (active === landmark && activePane.contains(landmark)) ||
            (isFocusableCommand &&
              visibleChrome !== null &&
              (isGlobalChrome || isActivePaneChrome)),
          active: active.outerHTML.slice(0, 500),
        };
      }),
    )
    .toMatchObject({ valid: true });
}

async function expectTabSkipsMovingChrome(
  page: Page,
  scrollport: Locator,
): Promise<void> {
  for (const key of [
    "Shift+Tab",
    "Shift+Tab",
    "Shift+Tab",
    "Shift+Tab",
    "Tab",
    "Tab",
    "Tab",
    "Tab",
  ]) {
    await page.keyboard.press(key);
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        insideMovingChrome:
          active instanceof Element &&
          active.closest("[data-mobile-chrome-phase]") !== null,
        active:
          active instanceof HTMLElement
            ? active.outerHTML.slice(0, 500)
            : String(active),
      };
    });
    expect(
      focus.insideMovingChrome,
      `${key} moved focus into hidden chrome: ${focus.active}`,
    ).toBe(false);
  }
  await expectChromePhase(page, scrollport, "Hidden");
}

test.describe("@mobile-chrome trusted mobile reader chrome", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const format of formats) {
    test(`${format.name}: trusted reading gestures retreat and recover synchronized chrome`, async ({
      page,
    }, testInfo: TestInfo) => {
      const seed = readSeed<MediaSeed>(format.seedFile);
      await resetReaderProgress(page, seed.media_id);
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(
          testInfo,
          `mobile-reader-chrome-${format.name.toLowerCase()}`,
        ),
        `/media/${seed.media_id}`,
      );

      const pane = activeWorkspacePane(page);
      const scrollport = format.scrollport(pane);
      await expect(scrollport).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          scrollport.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(128);
      await expect(
        pane.locator('[data-mobile-reader-interaction-root="true"]'),
      ).toHaveCount(1);
      await expectRouteFocusOnLandmark(page);
      await expectChromePhase(page, scrollport, "Visible");

      if (format.name === "transcript") {
        const segmentList = pane.locator('[class*="transcriptSegments"]');
        await expect(segmentList).toBeVisible();
        expect(
          await segmentList.evaluate(
            (element) => getComputedStyle(element).overflowY,
          ),
        ).not.toMatch(/auto|scroll/);
      }

      await expectTrustedForwardRetreat(page, scrollport);
      await expect(page.getByRole("banner")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^Open Nexus,/ }),
      ).toHaveCount(0);
      if ("toolbarControlName" in format) {
        await expect(
          pane.getByRole("button", { name: format.toolbarControlName }),
        ).toHaveCount(0);
      }
      const trustedDeadZone = await expectTrustedReverseDeadZone(
        page,
        scrollport,
      );
      await expectTrustedReverseReveal(page, scrollport, trustedDeadZone);

      if (format.name === "Web") {
        await expectTrustedForwardRetreat(page, scrollport);
        await expectTrustedWheelRecovery(page, scrollport);
        await expectTrustedForwardRetreat(page, scrollport);
        await expectTrustedKeyboardTopRecovery(page, scrollport);
      }
      await expectTrustedForwardRetreat(page, scrollport);
      if (format.name === "Web") {
        await expectTabSkipsMovingChrome(page, scrollport);
      }
      await expectBlankTapReveal(page, scrollport);

      if (format.name === "Web") {
        const article = readSeed<ArticleSeed>(format.seedFile);
        await expectTrustedSettleLifecycle(page, scrollport);
        await expectTrustedForwardRetreat(page, scrollport);
        const readingOrigin = await scrollport.evaluate(
          (element) => element.scrollTop,
        );
        await page.keyboard.press("Control+f");
        const input = pane.getByRole("searchbox", {
          name: "Find in article",
        });
        await expect(input).toBeFocused();
        await input.fill(queryFromExactText(article.focus_exact));
        await expect(
          pane.getByRole("status").filter({ hasText: /match/i }),
        ).toContainText(/match/i);
        await expectChromePhase(page, scrollport, "Pinned");
        await expect
          .poll(() => scrollport.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(readingOrigin + 64);
        await pane
          .getByTestId("pane-search-toolbar")
          .getByRole("button", { name: "Go back to reading position" })
          .click();
        await expectChromePhase(page, scrollport, "Pinned");
        await expect
          .poll(async () =>
            Math.abs(
              (await scrollport.evaluate((element) => element.scrollTop)) -
                readingOrigin,
            ),
          )
          .toBeLessThanOrEqual(1);
        await pane
          .getByTestId("pane-search-toolbar")
          .getByRole("button", { name: "Close search", exact: true })
          .click();
        await expectFocusOnVisibleChromeOrLandmark(page);
        await expectTrustedForwardRetreat(page, scrollport);
      }

      if (format.name === "transcript") {
        const segmentList = pane.locator('[class*="transcriptSegments"]');
        expect(await segmentList.evaluate((element) => element.scrollTop)).toBe(
          0,
        );
        expect(
          await scrollport.evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
      }
    });
  }

  test("reduced motion pins chrome and disabling it rebaselines the next trusted gesture", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<MediaSeed>("non-pdf-media.json");
    await resetReaderProgress(page, seed.media_id);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "mobile-reader-chrome-reduced-motion"),
      `/media/${seed.media_id}`,
    );
    const scrollport =
      activeWorkspacePane(page).getByTestId("document-viewport");
    await expect(scrollport).toBeVisible({ timeout: 20_000 });
    await expectChromePhase(page, scrollport, "Pinned");
    const before = await scrollport.evaluate((element) => element.scrollTop);
    await dispatchTouchDrag(page, scrollport, -128, 24);
    expect(
      await scrollport.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(before);
    await expectChromePhase(page, scrollport, "Pinned");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expectChromePhase(page, scrollport, "Visible");
    await expectTrustedForwardRetreat(page, scrollport);
  });

  test("PDF safe-area composition keeps reader geometry stable while chrome retreats", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<MediaSeed>("pdf-media.json");
    await resetReaderProgress(page, seed.media_id);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: {
          top: 24,
          topMax: 24,
          left: 0,
          leftMax: 0,
          bottom: 18,
          bottomMax: 18,
          right: 0,
          rightMax: 0,
        },
      });
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "mobile-reader-chrome-safe-area"),
        `/media/${seed.media_id}`,
      );
      const pane = activeWorkspacePane(page);
      const scrollport = pane.getByLabel("PDF document");
      const firstPage = pane
        .locator('[data-testid^="pdf-page-surface-"]')
        .first();
      await expect(firstPage).toBeVisible({ timeout: 20_000 });
      const geometry = await readContentGeometry(scrollport, firstPage);
      await expectTrustedForwardRetreat(page, scrollport);
      expect(await readContentGeometry(scrollport, firstPage)).toEqual(
        geometry,
      );
    } finally {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: {
          top: 0,
          topMax: 0,
          left: 0,
          leftMax: 0,
          bottom: 0,
          bottomMax: 0,
          right: 0,
          rightMax: 0,
        },
      });
      await cdp.detach();
    }
  });

  test("active global player preserves reader geometry and close returns focus safely", async ({
    page,
  }, testInfo) => {
    const audio = readSeed<AudioSeed>("activity-audio-media.json");
    const article = readSeed<ArticleSeed>("non-pdf-media.json");
    await page.route(`**${audio.stream_path}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: toneWav(audio.duration_seconds),
      }),
    );
    await placeAudioInLectern(page, audio.media_id);
    await resetReaderProgress(page, article.media_id);
    try {
      await gotoWithWorkspaceSession(
        page,
        workspaceE2eDeviceId(testInfo, "mobile-reader-chrome-player"),
        makeWorkspaceState(
          [
            makeWorkspacePane("pane-player-source", "/lectern"),
            makeWorkspacePane(
              "pane-player-reader",
              `/media/${article.media_id}`,
            ),
          ],
          { activePrimaryPaneId: "pane-player-source" },
        ),
        "/lectern",
      );
      await activeWorkspacePane(page)
        .getByRole("button", { name: `Play ${audio.title}` })
        .click();
      const player = page.getByRole("region", { name: "Media player" });
      await expect(player).toBeVisible();

      await page.getByRole("button", { name: "Open Nexus, 2 tabs" }).tap();
      await page
        .getByRole("dialog", { name: "Nexus" })
        .getByRole("button", {
          name: /E2E linked-items web article seed/,
        })
        .first()
        .tap();

      const scrollport =
        activeWorkspacePane(page).getByTestId("document-viewport");
      await expect(scrollport).toBeVisible({ timeout: 20_000 });
      const geometryBefore = await scrollport.evaluate((element) => ({
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
      }));
      await expectTrustedForwardRetreat(page, scrollport);
      await expect(player).toBeVisible();
      expect(
        await scrollport.evaluate((element) => ({
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
        })),
      ).toEqual(geometryBefore);

      await player
        .getByRole("button", { name: "More player controls" })
        .click();
      await page.getByRole("menuitem", { name: "Close player" }).click();
      await expect(player).toHaveCount(0);
      await expectFocusOnVisibleChromeOrLandmark(page);
      await expectChromePhase(page, scrollport, "Visible");
    } finally {
      await removeAudioFromLectern(page, audio.media_id);
    }
  });
});
