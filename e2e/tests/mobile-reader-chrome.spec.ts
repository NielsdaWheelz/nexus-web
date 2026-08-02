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
  quote_highlight_id: string;
  focus_exact: string;
}

interface AudioSeed extends MediaSeed {
  title: string;
  stream_path: string;
  duration_seconds: number;
}

interface ChromeSurfaceSample {
  present: boolean;
  phase: string;
  progress: number;
  specifiedProgress: number | null;
  translateY: number;
  inert: boolean;
  ariaHidden: string | null;
  top: number;
  bottom: number;
  height: number;
}

interface ChromeSample {
  recordedAt: number;
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

interface ChromeGestureRecording {
  samples: ChromeSample[];
  scrollEvents: ChromeSample[];
  transitionEvents: Array<{
    type: string;
    recordedAt: number;
  }>;
  touchStartAt: number | null;
  touchMoveAt: number | null;
  touchEndAt: number | null;
}

interface SettleAccessibilityFailure {
  origin: "transitionrun" | "animation-frame";
  recordedAt: number;
  surfaces: Array<{
    role: "AppBar" | "PaneToolbar" | "NexusControl";
    phase: string | null;
    inert: boolean | null;
    ariaHidden: string | null;
  }>;
}

function chromeSurfaces(
  sample: ChromeSample,
  expectPaneToolbar = false,
): ChromeSurfaceSample[] {
  if (expectPaneToolbar && !sample.paneToolbar.present) {
    throw new Error(
      `The required PaneToolbar surface disappeared: ${JSON.stringify(sample)}`,
    );
  }
  return [
    sample.appBar,
    ...(sample.paneToolbar.present ? [sample.paneToolbar] : []),
    sample.nexus,
  ];
}

const formats = [
  {
    name: "Web",
    seedFile: "non-pdf-media.json",
    scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
    expectsPaneToolbar: false,
    hasBlankTapSurface: true,
  },
  {
    name: "EPUB",
    seedFile: "epub-media.json",
    scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
    expectsPaneToolbar: true,
    toolbarControlName: "Next section",
    hasBlankTapSurface: true,
  },
  {
    name: "transcript",
    seedFile: "youtube-media.json",
    scrollport: (pane: Locator) => pane.getByTestId("document-viewport"),
    expectsPaneToolbar: false,
    hasBlankTapSurface: false,
  },
  {
    name: "PDF",
    seedFile: "pdf-media.json",
    scrollport: (pane: Locator) => pane.getByLabel("PDF document"),
    expectsPaneToolbar: true,
    toolbarControlName: "Next page",
    hasBlankTapSurface: true,
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

async function waitForScrollportSettle(scrollport: Locator): Promise<void> {
  await scrollport.evaluate(
    (element) =>
      new Promise<void>((resolve, reject) => {
        const stableWindowMs = 200;
        const deadline = performance.now() + 5_000;
        let prior = element.scrollTop;
        let stableSince = performance.now();
        const sample = (now: number) => {
          const current = element.scrollTop;
          if (Math.abs(current - prior) > 0.5) {
            stableSince = now;
          }
          prior = current;
          if (now - stableSince >= stableWindowMs) {
            resolve();
            return;
          }
          if (now >= deadline) {
            reject(
              new Error(
                "Reader scrollport did not settle after trusted input.",
              ),
            );
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
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
    const readSurface = (
      element: Element | null,
      optional = false,
    ): ChromeSurfaceSample => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("A registered mobile chrome surface is missing.");
      }
      const style = getComputedStyle(element);
      const progress = Number.parseFloat(
        style.getPropertyValue("--mobile-chrome-collapse"),
      );
      const specifiedProgress = Number.parseFloat(
        element.style.getPropertyValue("--mobile-chrome-collapse"),
      );
      if (!Number.isFinite(progress)) {
        throw new Error("Mobile chrome collapse progress is not numeric.");
      }
      const rect = element.getBoundingClientRect();
      return {
        present: !optional || rect.height > 1,
        phase: element.dataset.mobileChromePhase ?? "",
        progress,
        specifiedProgress: Number.isFinite(specifiedProgress)
          ? specifiedProgress
          : null,
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
      recordedAt: performance.now(),
      appBar: readSurface(
        document.querySelector("header[data-mobile-chrome-phase]"),
      ),
      paneToolbar: readSurface(
        activePane?.querySelector(
          '[data-testid="pane-shell-chrome"][data-mobile-chrome-phase]',
        ) ?? null,
        true,
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
  expectPaneToolbar = false,
): Promise<ChromeSample> {
  await expect
    .poll(
      async () => {
        const sample = await readChromeSample(page, scrollport);
        return chromeSurfaces(sample, expectPaneToolbar).every(
          (surface) => surface.phase === phase,
        );
      },
      phase === "Settling"
        ? { intervals: [10, 20, 40, 60], timeout: 1_000 }
        : undefined,
    )
    .toBe(true);
  const sample = await readChromeSample(page, scrollport);
  chromeSurfaces(sample, expectPaneToolbar);
  return sample;
}

async function startChromeGestureRecording(scrollport: Locator): Promise<void> {
  await scrollport.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("The mobile chrome scrollport is not an HTMLElement.");
    }
    type Recorder = ChromeGestureRecording & {
      frame: number;
      scrollport: HTMLElement;
      readSample(): ChromeSample;
      onScroll(): void;
      onTouchStart(): void;
      onTouchMove(): void;
      onTouchEnd(): void;
      onTransition(event: Event): void;
    };
    const recorderWindow = window as typeof window & {
      __nexusMobileChromeGestureRecorder?: Recorder;
    };
    if (recorderWindow.__nexusMobileChromeGestureRecorder) {
      throw new Error("A mobile chrome gesture recorder is already active.");
    }

    const readSample = (): ChromeSample => {
      const rect = element.getBoundingClientRect();
      const activePane = document.querySelector(
        '[data-pane-id][data-active="true"]',
      );
      const readSurface = (
        surface: Element | null,
        optional = false,
      ): ChromeSurfaceSample => {
        if (!(surface instanceof HTMLElement)) {
          throw new Error("A registered mobile chrome surface is missing.");
        }
        const style = getComputedStyle(surface);
        const progress = Number.parseFloat(
          style.getPropertyValue("--mobile-chrome-collapse"),
        );
        const specifiedProgress = Number.parseFloat(
          surface.style.getPropertyValue("--mobile-chrome-collapse"),
        );
        if (!Number.isFinite(progress)) {
          throw new Error("Mobile chrome collapse progress is not numeric.");
        }
        const surfaceRect = surface.getBoundingClientRect();
        return {
          present: !optional || surfaceRect.height > 1,
          phase: surface.dataset.mobileChromePhase ?? "",
          progress,
          specifiedProgress: Number.isFinite(specifiedProgress)
            ? specifiedProgress
            : null,
          translateY:
            style.transform === "none"
              ? 0
              : new DOMMatrixReadOnly(style.transform).m42,
          inert: surface.inert,
          ariaHidden: surface.getAttribute("aria-hidden"),
          top: surfaceRect.top,
          bottom: surfaceRect.bottom,
          height: surfaceRect.height,
        };
      };
      return {
        recordedAt: performance.now(),
        appBar: readSurface(
          document.querySelector("header[data-mobile-chrome-phase]"),
        ),
        paneToolbar: readSurface(
          activePane?.querySelector(
            '[data-testid="pane-shell-chrome"][data-mobile-chrome-phase]',
          ) ?? null,
          true,
        ),
        nexus: readSurface(
          document.querySelector(
            'button[aria-label^="Open Nexus,"][data-mobile-chrome-phase]',
          ),
        ),
        viewportHeight: window.innerHeight,
        scrollTop: element.scrollTop,
        scrollport: {
          top: rect.top,
          bottom: rect.bottom,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        },
        activeElement:
          document.activeElement instanceof HTMLElement
            ? [
                document.activeElement.tagName.toLowerCase(),
                document.activeElement.id
                  ? `#${document.activeElement.id}`
                  : "",
                document.activeElement.getAttribute("role")
                  ? `[role="${document.activeElement.getAttribute("role")}"]`
                  : "",
                document.activeElement.dataset.testid
                  ? `[data-testid="${document.activeElement.dataset.testid}"]`
                  : "",
              ].join("")
            : String(document.activeElement),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        href: location.href,
      };
    };

    const recorder: Recorder = {
      samples: [],
      scrollEvents: [],
      transitionEvents: [],
      touchStartAt: null,
      touchMoveAt: null,
      touchEndAt: null,
      frame: 0,
      scrollport: element,
      readSample,
      onScroll: () => {
        recorder.scrollEvents.push(readSample());
      },
      onTouchStart: () => {
        recorder.touchStartAt = performance.now();
        recorder.touchMoveAt = null;
        recorder.touchEndAt = null;
      },
      onTouchMove: () => {
        recorder.touchMoveAt ??= performance.now();
      },
      onTouchEnd: () => {
        recorder.touchEndAt = performance.now();
      },
      onTransition: (event) => {
        if (
          event instanceof TransitionEvent &&
          event.propertyName === "--mobile-chrome-collapse" &&
          event.target instanceof HTMLElement &&
          event.target.matches("[data-mobile-chrome-phase]")
        ) {
          recorder.transitionEvents.push({
            type: event.type,
            recordedAt: performance.now(),
          });
        }
      },
    };
    const recordFrame = () => {
      recorder.samples.push(readSample());
      recorder.frame = requestAnimationFrame(recordFrame);
    };
    element.addEventListener("scroll", recorder.onScroll, { passive: true });
    element.addEventListener("touchstart", recorder.onTouchStart, true);
    element.addEventListener("touchmove", recorder.onTouchMove, true);
    element.addEventListener("touchend", recorder.onTouchEnd, true);
    element.addEventListener("touchcancel", recorder.onTouchEnd, true);
    document.addEventListener("transitionrun", recorder.onTransition, true);
    document.addEventListener("transitionend", recorder.onTransition, true);
    document.addEventListener("transitioncancel", recorder.onTransition, true);
    recorder.samples.push(readSample());
    recorder.frame = requestAnimationFrame(recordFrame);
    recorderWindow.__nexusMobileChromeGestureRecorder = recorder;
  });
}

async function stopChromeGestureRecording(
  scrollport: Locator,
): Promise<ChromeGestureRecording> {
  return scrollport.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("The mobile chrome scrollport is not an HTMLElement.");
    }
    type Recorder = ChromeGestureRecording & {
      frame: number;
      scrollport: HTMLElement;
      readSample(): ChromeSample;
      onScroll(): void;
      onTouchStart(): void;
      onTouchMove(): void;
      onTouchEnd(): void;
      onTransition(event: Event): void;
    };
    const recorderWindow = window as typeof window & {
      __nexusMobileChromeGestureRecorder?: Recorder;
    };
    const recorder = recorderWindow.__nexusMobileChromeGestureRecorder;
    if (!recorder || recorder.scrollport !== element) {
      throw new Error("The mobile chrome gesture recorder is missing.");
    }
    cancelAnimationFrame(recorder.frame);
    element.removeEventListener("scroll", recorder.onScroll);
    element.removeEventListener("touchstart", recorder.onTouchStart, true);
    element.removeEventListener("touchmove", recorder.onTouchMove, true);
    element.removeEventListener("touchend", recorder.onTouchEnd, true);
    element.removeEventListener("touchcancel", recorder.onTouchEnd, true);
    document.removeEventListener("transitionrun", recorder.onTransition, true);
    document.removeEventListener("transitionend", recorder.onTransition, true);
    document.removeEventListener(
      "transitioncancel",
      recorder.onTransition,
      true,
    );
    recorder.samples.push(recorder.readSample());
    delete recorderWindow.__nexusMobileChromeGestureRecorder;
    return {
      samples: recorder.samples,
      scrollEvents: recorder.scrollEvents,
      transitionEvents: recorder.transitionEvents,
      touchStartAt: recorder.touchStartAt,
      touchMoveAt: recorder.touchMoveAt,
      touchEndAt: recorder.touchEndAt,
    };
  });
}

async function assertRecordedTouchBoundary(
  scrollport: Locator,
  boundary: "touchMoveAt" | "touchEndAt",
): Promise<void> {
  const observation = await scrollport.evaluate((element, boundaryName) => {
    const recorderWindow = window as typeof window & {
      __nexusMobileChromeGestureRecorder?: ChromeGestureRecording & {
        scrollport: HTMLElement;
      };
    };
    const recorder = recorderWindow.__nexusMobileChromeGestureRecorder;
    return {
      recordedAt: recorder?.[boundaryName] ?? null,
      recorderPresent: recorder !== undefined,
      sameScrollport: recorder?.scrollport === element,
      scrollportConnected: element.isConnected,
    };
  }, boundary);
  expect(
    observation,
    `CDP acknowledged ${boundary}, but the exact reader recorder did not observe it; observation=${JSON.stringify(observation)}`,
  ).toMatchObject({
    recorderPresent: true,
    sameScrollport: true,
    scrollportConnected: true,
    recordedAt: expect.any(Number),
  });
}

function expectContinuousTrustedGesture(
  recording: ChromeGestureRecording,
  allowTransitionDuringTouch: boolean,
  expectPaneToolbar: boolean,
): void {
  const { touchStartAt, touchMoveAt, touchEndAt } = recording;
  if (
    touchStartAt === null ||
    touchMoveAt === null ||
    touchEndAt === null ||
    touchMoveAt < touchStartAt ||
    touchMoveAt > touchEndAt
  ) {
    throw new Error(
      `trusted drag lost its ordered native touch lifecycle; recording=${JSON.stringify(recording)}`,
    );
  }
  const cadenceWindowStart = allowTransitionDuringTouch
    ? (recording.transitionEvents.find(
        ({ type, recordedAt }) =>
          type === "transitionrun" && recordedAt >= touchStartAt,
      )?.recordedAt ?? touchStartAt)
    : touchStartAt;
  const activeScrollEventTimes = recording.scrollEvents
    .map(({ recordedAt }) => recordedAt)
    .filter(
      (recordedAt) =>
        recordedAt >= cadenceWindowStart && recordedAt <= touchEndAt,
    );
  expect(
    activeScrollEventTimes.length,
    `trusted drag must publish multiple native scroll events; recording=${JSON.stringify(recording)}`,
  ).toBeGreaterThan(1);
  const scrollGaps = activeScrollEventTimes
    .slice(1)
    .map((recordedAt, index) => recordedAt - activeScrollEventTimes[index]!);
  expect(
    Math.max(...scrollGaps),
    `trusted drag cadence must stay below the 120ms idle-settle boundary; recording=${JSON.stringify(recording)}`,
  ).toBeLessThan(120);
  if (!allowTransitionDuringTouch) {
    expect(
      recording.transitionEvents.filter(
        ({ recordedAt }) =>
          recordedAt >= touchStartAt && recordedAt <= touchEndAt,
      ),
      `continuous drag must not enter settle; recording=${JSON.stringify(recording)}`,
    ).toEqual([]);
    expect(
      recording.samples
        .filter(
          ({ recordedAt }) =>
            recordedAt >= touchStartAt && recordedAt <= touchEndAt,
        )
        .some((sample) =>
          chromeSurfaces(sample, expectPaneToolbar).some(
            (surface) => surface.phase === "Settling",
          ),
        ),
      `continuous drag must not sample a settle phase; recording=${JSON.stringify(recording)}`,
    ).toBe(false);
  }
}

async function dispatchTouchDrag(
  page: Page,
  scrollport: Locator,
  fingerDeltaY: number,
  steps: number,
  options: {
    afterTouchStart?: () => Promise<void>;
    allowTransitionDuringTouch?: boolean;
    driveWithTouchEvents?: boolean;
    expectPaneToolbar?: boolean;
    followUpDrag?: {
      fingerDeltaY: number;
      steps: number;
      afterTouchStart?: () => Promise<void>;
    };
    stopBeforeTouchEnd?: boolean;
  } = {},
): Promise<ChromeGestureRecording> {
  const box = await scrollport.boundingBox();
  if (!box) {
    throw new Error("Reader scrollport has no visible bounding box.");
  }
  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }));
  const rawX = box.x + Math.min(box.width - 24, Math.max(24, box.width / 2));
  const x = Math.round(Math.min(viewport.width - 2, Math.max(1, rawX)));
  const startYFor = (deltaY: number) => {
    const roundedDeltaY = Math.round(deltaY);
    const rawStartY =
      roundedDeltaY < 0
        ? box.y + Math.min(box.height - 28, Math.max(80, box.height * 0.8))
        : box.y + Math.min(box.height - 100, Math.max(32, box.height * 0.28));
    const minStartY = 1 - Math.min(0, roundedDeltaY);
    const maxStartY = viewport.height - 2 - Math.max(0, roundedDeltaY);
    return Math.round(Math.min(maxStartY, Math.max(minStartY, rawStartY)));
  };
  const roundedDeltaY = Math.round(fingerDeltaY);
  const startY = startYFor(roundedDeltaY);
  const point = (y: number, pointX = x) => [
    {
      id: 1,
      x: pointX,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    },
  ];
  await startChromeGestureRecording(scrollport);
  let cdp: CDPSession | null = null;
  let recording: ChromeGestureRecording | null = null;
  let touchActive = false;
  try {
    cdp = await page.context().newCDPSession(page);
    if (options.driveWithTouchEvents || options.afterTouchStart) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: point(startY),
      });
      touchActive = true;
      await options.afterTouchStart?.();
      for (let step = 1; step <= steps; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point(startY + (fingerDeltaY * step) / steps),
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 8);
        });
      }
      if (options.stopBeforeTouchEnd) {
        // A physical partial drag can decelerate to rest before lift. Keep the
        // finger down for less than the 120 ms idle boundary and refresh the
        // stationary touch point so Chromium does not manufacture a fling.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 80);
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point(startY + fingerDeltaY),
        });
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      touchActive = false;
      if (options.followUpDrag) {
        const followUpDeltaY = Math.round(options.followUpDrag.fingerDeltaY);
        const followUpStartY = startYFor(followUpDeltaY);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: point(followUpStartY),
        });
        touchActive = true;
        await options.followUpDrag.afterTouchStart?.();
        for (let step = 1; step <= options.followUpDrag.steps; step += 1) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: point(
              followUpStartY +
                (followUpDeltaY * step) / options.followUpDrag.steps,
            ),
          });
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 8);
          });
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        touchActive = false;
      }
    } else {
      // Headless Chromium's touch-flavored synthesizeScrollGesture emits the
      // touch boundary but no touch moves or native scroll events. Preserve
      // the trusted touch lifecycle explicitly, then let Chromium's compositor
      // publish the continuous scroll stream. Issuing each move through a
      // Node/CDP round trip can pause longer than the product's 120 ms idle
      // boundary under host load, manufacturing a settle that no continuous
      // physical drag contains.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: point(startY),
      });
      touchActive = true;
      await cdp.send("Input.synthesizeScrollGesture", {
        x,
        y: startY,
        // Mouse-source scroll distance has the same sign as the equivalent
        // finger delta: a negative distance advances the document, while a
        // positive distance reverses toward the top.
        yDistance: roundedDeltaY,
        speed: Math.max(
          1,
          Math.round(Math.abs(roundedDeltaY) / (steps * 0.008)),
        ),
        gestureSourceType: "mouse",
        preventFling: true,
      });
      // The explicit boundary otherwise has no touch movement, so Chromium
      // classifies the lift as a tap and dispatches a click that reveals the
      // reader chrome. Cross the platform touch slop after the compositor
      // stream, and prove that Chromium observed the move before lifting.
      const touchSlopDeltaX = x <= viewport.width / 2 ? 48 : -48;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(startY, x + touchSlopDeltaX),
      });
      // Input.dispatchTouchEvent acknowledges after Chromium has dispatched
      // the boundary. Inspect the exact recorder synchronously: polling on a
      // future animation frame adds scheduler timing without adding proof.
      await assertRecordedTouchBoundary(scrollport, "touchMoveAt");
      await waitForAnimationFrame(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      touchActive = false;
    }
    await assertRecordedTouchBoundary(scrollport, "touchEndAt");
  } finally {
    try {
      if (touchActive && cdp) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        touchActive = false;
      }
    } finally {
      try {
        recording = await stopChromeGestureRecording(scrollport);
      } finally {
        await cdp?.detach();
      }
    }
  }
  expectContinuousTrustedGesture(
    recording,
    options.allowTransitionDuringTouch === true,
    options.expectPaneToolbar === true,
  );
  return recording;
}

async function expectTrustedForwardRetreat(
  page: Page,
  scrollport: Locator,
  expectPaneToolbar = false,
  requireFreshTopPin = false,
): Promise<void> {
  const before = await readChromeSample(page, scrollport);
  chromeSurfaces(before, expectPaneToolbar);
  if (requireFreshTopPin) {
    expect(
      before.scrollTop,
      `fresh top-pin proof must start at the real reader top; before=${JSON.stringify(before)}`,
    ).toBeLessThanOrEqual(0.5);
  }
  const recording = await dispatchTouchDrag(
    page,
    scrollport,
    -128,
    requireFreshTopPin ? 64 : 24,
    { driveWithTouchEvents: true, expectPaneToolbar },
  );
  const { samples, scrollEvents } = recording;
  const tracking = samples
    .map((sample, index) => ({ index, sample }))
    .filter(
      ({ sample }) =>
        sample.appBar.progress > 0.02 && sample.appBar.progress < 0.98,
    );
  expect(
    tracking.length,
    `expected proportional intermediate chrome samples; samples=${JSON.stringify(samples)}`,
  ).toBeGreaterThan(1);
  const topPinnedEvents = scrollEvents.filter(
    (sample) => sample.scrollTop <= 8,
  );
  for (const sample of topPinnedEvents) {
    for (const surface of chromeSurfaces(sample, expectPaneToolbar)) {
      expect(surface.phase).toBe("Visible");
      expect(surface.progress).toBe(0);
    }
  }
  if (requireFreshTopPin) {
    const positiveTopPinEvents = topPinnedEvents.filter(
      (sample) => sample.scrollTop > 0,
    );
    expect(
      positiveTopPinEvents.length,
      `fresh trusted input must produce a native sample inside the 8px top pin; recording=${JSON.stringify(recording)}`,
    ).toBeGreaterThan(0);
    const firstBeyondTopPinIndex = scrollEvents.findIndex(
      (sample) => sample.scrollTop > 8,
    );
    expect(
      firstBeyondTopPinIndex,
      `fresh trusted input must cross the 8px top pin; recording=${JSON.stringify(recording)}`,
    ).toBeGreaterThan(0);
    const firstBeyondTopPin = scrollEvents[firstBeyondTopPinIndex];
    const priorNativeSample = scrollEvents[firstBeyondTopPinIndex - 1];
    if (!firstBeyondTopPin || !priorNativeSample) {
      throw new Error("Fresh top-pin samples lost their ordering.");
    }
    expect(priorNativeSample.scrollTop).toBeLessThanOrEqual(8);
    expect(
      firstBeyondTopPin.appBar.progress,
      `the first native sample beyond 8px must not lead exact 64px collapse travel; sample=${JSON.stringify(firstBeyondTopPin)}`,
    ).toBeLessThanOrEqual((firstBeyondTopPin.scrollTop - 8) / 64 + 0.01);
    expect(
      firstBeyondTopPin.appBar.progress,
      `the first native sample beyond 8px must not lag its prior native top-pin sample; prior=${JSON.stringify(priorNativeSample)} sample=${JSON.stringify(firstBeyondTopPin)}`,
    ).toBeGreaterThanOrEqual(
      Math.max(0, (priorNativeSample.scrollTop - 8) / 64) - 0.01,
    );
  }
  const hasFreshTopPinBaseline = topPinnedEvents.length > 0;
  const forwardBaseline = topPinnedEvents.at(-1)?.scrollTop ?? before.scrollTop;
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
  for (const { index, sample } of tracking) {
    const prior = index === 0 ? before : (samples[index - 1] ?? before);
    // The recorder RAF is armed before touch; a scroll schedules the provider's
    // coalesced writer behind it. A real top-pin sample resets direction and
    // proves the exact dead zone. Away from top, reducer direction is correctly
    // retained across gestures, so the envelope allows either same-direction
    // travel (no new dead zone) or reversal travel (one dead zone).
    const priorProgressFloor = Math.min(
      1,
      Math.max(0, (prior.scrollTop - forwardBaseline - 8) / 64),
    );
    const currentProgressCeiling = Math.min(
      1,
      Math.max(
        0,
        (sample.scrollTop -
          forwardBaseline -
          (hasFreshTopPinBaseline ? 8 : 0)) /
          64,
      ),
    );
    const surfaces = chromeSurfaces(sample, expectPaneToolbar);
    const progress = surfaces.map((surface) => surface.progress);
    const specifiedProgressCandidates = surfaces.map(
      (surface) => surface.specifiedProgress,
    );
    expect(
      specifiedProgressCandidates.every((candidate) => candidate !== null),
      `tracking must have one explicitly written collapse value; sample=${JSON.stringify(sample)}`,
    ).toBe(true);
    const specifiedProgress = specifiedProgressCandidates.filter(
      (candidate): candidate is number => candidate !== null,
    );
    expect(
      sample.appBar.progress,
      `collapse must not lag beyond one coalesced RAF plus the top-pin baseline; sample=${JSON.stringify(sample)} prior=${JSON.stringify(prior)} before=${JSON.stringify(before)}`,
    ).toBeGreaterThanOrEqual(priorProgressFloor - 0.01);
    expect(
      sample.appBar.progress,
      `collapse must not lead the current 8px dead-zone / 64px-travel bound; sample=${JSON.stringify(sample)} prior=${JSON.stringify(prior)} before=${JSON.stringify(before)}`,
    ).toBeLessThanOrEqual(currentProgressCeiling + 0.01);
    expect(
      Math.max(...specifiedProgress) - Math.min(...specifiedProgress),
      `one RAF writer must specify one collapse value; sample=${JSON.stringify(sample)}`,
    ).toBeLessThan(0.000_001);
    expect(
      Math.max(...progress) - Math.min(...progress),
      `computed collapse must remain synchronized; sample=${JSON.stringify(sample)}`,
    ).toBeLessThan(0.01);
    for (const surface of surfaces) {
      expect(
        surface.phase,
        `translated chrome must publish Tracking atomically with inertness and collapse progress; sample=${JSON.stringify(sample)}`,
      ).toBe("Tracking");
      expect(surface.inert).toBe(true);
      expect(surface.ariaHidden).toBe("true");
    }
    expect(sample.appBar.translateY).toBeLessThan(0);
    if (sample.paneToolbar.present) {
      expect(sample.paneToolbar.translateY).toBeLessThan(0);
    }
    expect(sample.nexus.translateY).toBeGreaterThan(0);
  }
  expect(samples.at(-1)?.scrollTop ?? before.scrollTop).toBeGreaterThan(
    before.scrollTop,
  );
  // Progress is written directly in the provider's coalesced RAF, while the
  // descriptive React phase can commit on the following frame under load.
  // Prove the reducer threshold against the visual endpoint itself; the
  // expectChromePhase assertion below independently proves that phase and
  // accessibility state converge on Hidden.
  const firstCollapsedIndex = samples.findIndex((sample) =>
    chromeSurfaces(sample, expectPaneToolbar).every(
      (surface) => surface.specifiedProgress === 1 && surface.progress === 1,
    ),
  );
  const firstCollapsedSample =
    firstCollapsedIndex < 0 ? undefined : samples[firstCollapsedIndex];
  expect(
    firstCollapsedSample,
    `expected trusted input to traverse the fully collapsed endpoint; samples=${JSON.stringify(samples)}`,
  ).toBeDefined();
  const thresholdWindowStartFrame =
    firstCollapsedIndex < 2
      ? before
      : (samples[firstCollapsedIndex - 2] ?? before);
  const firstCollapsedDistance =
    (firstCollapsedSample?.scrollTop ?? before.scrollTop) - before.scrollTop;
  const thresholdWindowStartDistance =
    thresholdWindowStartFrame.scrollTop - before.scrollTop;
  const earliestHiddenThresholdDistance =
    forwardBaseline - before.scrollTop + (hasFreshTopPinBaseline ? 8 : 0) + 64;
  const latestHiddenThresholdDistance =
    forwardBaseline - before.scrollTop + 8 + 64;
  expect(
    firstCollapsedDistance,
    hasFreshTopPinBaseline
      ? "hidden endpoint must not precede the fresh 8px dead zone plus 64px collapse travel"
      : "hidden endpoint must not precede 64px of collapse travel",
  ).toBeGreaterThanOrEqual(earliestHiddenThresholdDistance);
  expect(
    thresholdWindowStartDistance,
    "hidden endpoint threshold must overlap the reducer-history envelope despite coalesced publication",
  ).toBeLessThanOrEqual(latestHiddenThresholdDistance);

  const hidden = await expectChromePhase(
    page,
    scrollport,
    "Hidden",
    expectPaneToolbar,
  );
  expect(hidden.appBar.progress).toBe(1);
  expect(hidden.nexus.progress).toBe(1);
  expect(hidden.appBar.bottom).toBeLessThanOrEqual(1);
  if (hidden.paneToolbar.present) {
    expect(hidden.paneToolbar.progress).toBe(1);
    expect(hidden.paneToolbar.bottom).toBeLessThanOrEqual(1);
  }
  expect(hidden.nexus.top).toBeGreaterThanOrEqual(hidden.viewportHeight - 1);
  for (const surface of chromeSurfaces(hidden, expectPaneToolbar)) {
    expect(surface.inert).toBe(true);
    expect(surface.ariaHidden).toBe("true");
  }
  await waitForScrollportSettle(scrollport);
}

async function expectTrustedHandledAnnotationTap(
  page: Page,
  scrollport: Locator,
  highlightId: string,
): Promise<void> {
  await expectChromePhase(page, scrollport, "Hidden");
  const annotation = activeWorkspacePane(page)
    .locator(`[data-active-highlight-ids~="${highlightId}"]`)
    .first();
  await expect(annotation).toBeVisible();
  const box = await annotation.boundingBox();
  if (!box) {
    throw new Error(
      "The seeded reader annotation has no visible bounding box.",
    );
  }
  const href = page.url();
  const beforeTop = await scrollport.evaluate((element) => element.scrollTop);

  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  await expect(annotation).toHaveAttribute("data-reader-tap-handled", "true");
  await expect(
    page.getByRole("group", { name: "Highlight actions" }),
  ).toBeVisible();
  const pinned = await expectChromePhase(page, scrollport, "Pinned");
  for (const surface of chromeSurfaces(pinned)) {
    expect(surface.progress).toBe(0);
    expect(surface.inert).toBe(false);
    expect(surface.ariaHidden).toBeNull();
  }
  expect(page.url()).toBe(href);
  expect(
    Math.abs(
      (await scrollport.evaluate((element) => element.scrollTop)) - beforeTop,
    ),
  ).toBeLessThanOrEqual(1);

  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("group", { name: "Highlight actions" }),
  ).toHaveCount(0);
  await expectChromePhase(page, scrollport, "Visible");
  await expectTrustedForwardRetreat(page, scrollport);
}

async function expectTrustedReverseReveal(
  page: Page,
  scrollport: Locator,
  priorReverseDistance: number,
  expectPaneToolbar = false,
): Promise<void> {
  const hidden = await readChromeSample(page, scrollport);
  chromeSurfaces(hidden, expectPaneToolbar);
  const { samples, scrollEvents } = await dispatchTouchDrag(
    page,
    scrollport,
    128,
    64,
    { driveWithTouchEvents: true, expectPaneToolbar },
  );
  const reverseMotionAt = (recordedAt: number) => {
    let lastScrollTop = hidden.scrollTop;
    let direction: "Up" | "Down" | null = "Up";
    let reversalDistancePx = priorReverseDistance;
    for (const event of scrollEvents) {
      if (event.recordedAt > recordedAt) break;
      if (event.scrollTop <= 8) {
        lastScrollTop = event.scrollTop;
        direction = null;
        reversalDistancePx = 0;
        continue;
      }
      const delta = event.scrollTop - lastScrollTop;
      if (Math.abs(delta) < 1) continue;
      const nextDirection = delta > 0 ? "Down" : "Up";
      reversalDistancePx =
        direction === nextDirection
          ? reversalDistancePx + Math.abs(delta)
          : Math.abs(delta);
      direction = nextDirection;
      lastScrollTop = event.scrollTop;
    }
    return { direction, reversalDistancePx };
  };
  const revealProgressFor = (motion: ReturnType<typeof reverseMotionAt>) =>
    motion.direction === "Up"
      ? 1 - Math.min(1, Math.max(0, (motion.reversalDistancePx - 8) / 64))
      : 1;
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
    const index = samples.indexOf(sample);
    const prior = index <= 0 ? hidden : (samples[index - 1] ?? hidden);
    const priorMotion = reverseMotionAt(prior.recordedAt);
    const currentMotion = reverseMotionAt(sample.recordedAt);
    const priorProgressCeiling = revealProgressFor(priorMotion);
    const currentProgressFloor = revealProgressFor(currentMotion);
    expect(
      sample.appBar.progress,
      `reveal must not lead the current 8px dead-zone / 64px-travel bound; sample=${JSON.stringify(sample)} prior=${JSON.stringify(prior)} currentMotion=${JSON.stringify(currentMotion)} hidden=${JSON.stringify(hidden)}`,
    ).toBeGreaterThanOrEqual(currentProgressFloor - 0.01);
    expect(
      sample.appBar.progress,
      `reveal must not lag beyond one coalesced RAF; sample=${JSON.stringify(sample)} prior=${JSON.stringify(prior)} priorMotion=${JSON.stringify(priorMotion)} hidden=${JSON.stringify(hidden)}`,
    ).toBeLessThanOrEqual(priorProgressCeiling + 0.01);
  }
  const firstRevealedSample = reverseSamples.find(
    (sample) => sample.appBar.progress < 0.99,
  );
  expect(
    firstRevealedSample,
    `expected chrome to reveal after the reversal dead zone; samples=${JSON.stringify(samples)}`,
  ).toBeDefined();
  const firstRevealMotion = reverseMotionAt(firstRevealedSample!.recordedAt);
  expect(
    firstRevealMotion.direction,
    `chrome must reveal only while native scroll travels upward; motion=${JSON.stringify(firstRevealMotion)} samples=${JSON.stringify(samples)} scrollEvents=${JSON.stringify(scrollEvents)}`,
  ).toBe("Up");
  expect(
    firstRevealMotion.reversalDistancePx,
    `chrome must consume the exact native 8px reversal dead zone; motion=${JSON.stringify(firstRevealMotion)} samples=${JSON.stringify(samples)} scrollEvents=${JSON.stringify(scrollEvents)}`,
  ).toBeGreaterThan(8);
  const visible = await expectChromePhase(
    page,
    scrollport,
    "Visible",
    expectPaneToolbar,
  );
  expect(visible.appBar.progress).toBe(0);
  expect(visible.nexus.progress).toBe(0);
  if (visible.paneToolbar.present) {
    expect(visible.paneToolbar.progress).toBe(0);
  }
  for (const surface of chromeSurfaces(visible, expectPaneToolbar)) {
    expect(surface.inert).toBe(false);
    expect(surface.ariaHidden).toBeNull();
  }
  await waitForScrollportSettle(scrollport);
}

async function expectTrustedReverseDeadZone(
  page: Page,
  scrollport: Locator,
  expectPaneToolbar = false,
): Promise<number> {
  await waitForScrollportSettle(scrollport);
  const before = await readChromeSample(page, scrollport);
  const box = await scrollport.boundingBox();
  if (!box) {
    throw new Error("Reader scrollport has no visible bounding box.");
  }
  await startChromeGestureRecording(scrollport);
  let recording: ChromeGestureRecording | null = null;
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -4);
    await expect
      .poll(() => scrollport.evaluate((element) => element.scrollTop))
      .toBeLessThan(before.scrollTop);
    // A wheel tick may publish across more than one compositor frame. Sample
    // only after it is still so the carried reversal distance and the next
    // trusted drag share one exact scroll baseline.
    await waitForScrollportSettle(scrollport);
  } finally {
    recording = await stopChromeGestureRecording(scrollport);
  }
  if (!recording) {
    throw new Error("Trusted wheel recording was not captured.");
  }
  const sample = await readChromeSample(page, scrollport);
  chromeSurfaces(sample, expectPaneToolbar);
  let lastScrollTop = before.scrollTop;
  let direction: "Up" | "Down" | null = "Down";
  let reverseDistance = 0;
  for (const event of recording.scrollEvents) {
    if (event.scrollTop <= 8) {
      lastScrollTop = event.scrollTop;
      direction = null;
      reverseDistance = 0;
      continue;
    }
    const delta = event.scrollTop - lastScrollTop;
    if (Math.abs(delta) < 1) continue;
    const nextDirection = delta > 0 ? "Down" : "Up";
    reverseDistance =
      direction === nextDirection
        ? reverseDistance + Math.abs(delta)
        : Math.abs(delta);
    direction = nextDirection;
    lastScrollTop = event.scrollTop;
  }
  expect(
    direction,
    `trusted wheel must finish upward; recording=${JSON.stringify(recording)}`,
  ).toBe("Up");
  expect(
    reverseDistance,
    `trusted wheel must produce measurable reducer-path distance inside the 8px dead zone; before=${JSON.stringify(before)} sample=${JSON.stringify(sample)} recording=${JSON.stringify(recording)}`,
  ).toBeGreaterThan(0);
  expect(reverseDistance).toBeLessThanOrEqual(8);
  expect(sample.appBar.phase).toBe("Hidden");
  expect(sample.nexus.phase).toBe("Hidden");
  expect(sample.appBar.progress).toBe(1);
  expect(sample.nexus.progress).toBe(1);
  if (sample.paneToolbar.present) {
    expect(sample.paneToolbar.phase).toBe("Hidden");
    expect(sample.paneToolbar.progress).toBe(1);
  }
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
  expectPaneToolbar: boolean,
  proveInterruption = true,
): Promise<void> {
  chromeSurfaces(await readChromeSample(page, scrollport), expectPaneToolbar);
  await page.evaluate((requiresPaneToolbar) => {
    const auditWindow = window as typeof window & {
      __nexusMobileChromeTransitionAudit?: {
        runs: number;
        ends: number;
        cancels: number;
        allSettleFramesAccessible: boolean;
        accessibilityFailures: SettleAccessibilityFailure[];
        settleFrames: number;
        maxComputedSpread: number;
        maxSpecifiedSpread: number;
        maxTransformError: number;
        events: Array<{ type: string; recordedAt: number }>;
        frame: number;
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
      cancelAnimationFrame(priorAudit.frame);
    }
    const audit = {
      runs: 0,
      ends: 0,
      cancels: 0,
      allSettleFramesAccessible: true,
      accessibilityFailures: [] as SettleAccessibilityFailure[],
      settleFrames: 0,
      maxComputedSpread: 0,
      maxSpecifiedSpread: 0,
      maxTransformError: 0,
      events: [] as Array<{ type: string; recordedAt: number }>,
      frame: 0,
      listener: ((event: TransitionEvent) => {
        if (
          event.propertyName === "--mobile-chrome-collapse" &&
          event.target instanceof HTMLElement &&
          event.target.matches("[data-mobile-chrome-phase]")
        ) {
          if (event.type === "transitionrun") {
            audit.runs += 1;
          } else if (event.type === "transitionend") {
            audit.ends += 1;
          } else if (event.type === "transitioncancel") {
            audit.cancels += 1;
          }
          audit.events.push({
            type: event.type,
            recordedAt: performance.now(),
          });
        }
      }) as EventListener,
    };
    const sampleSettleFrame = () => {
      const appBar = document.querySelector("header[data-mobile-chrome-phase]");
      const paneToolbar = document.querySelector(
        '[data-pane-id][data-active="true"] [data-testid="pane-shell-chrome"][data-mobile-chrome-phase]',
      );
      const nexus = document.querySelector(
        'button[aria-label^="Open Nexus,"][data-mobile-chrome-phase]',
      );
      const presentPaneToolbar =
        paneToolbar instanceof HTMLElement &&
        paneToolbar.getBoundingClientRect().height > 1
          ? paneToolbar
          : null;
      const registrations = [
        {
          role: "AppBar" as const,
          surface: appBar instanceof HTMLElement ? appBar : null,
        },
        ...(requiresPaneToolbar || presentPaneToolbar
          ? [
              {
                role: "PaneToolbar" as const,
                surface: presentPaneToolbar,
              },
            ]
          : []),
        {
          role: "NexusControl" as const,
          surface: nexus instanceof HTMLElement ? nexus : null,
        },
      ];
      if (
        registrations.some(
          ({ surface }) => surface?.dataset.mobileChromePhase === "Settling",
        )
      ) {
        const accessibility = registrations.map(({ role, surface }) => ({
          role,
          phase: surface?.dataset.mobileChromePhase ?? null,
          inert: surface?.inert ?? null,
          ariaHidden: surface?.getAttribute("aria-hidden") ?? null,
        }));
        const accessible = accessibility.every(
          ({ phase, inert, ariaHidden }) =>
            phase === "Settling" && inert === true && ariaHidden === "true",
        );
        audit.settleFrames += 1;
        audit.allSettleFramesAccessible =
          audit.allSettleFramesAccessible && accessible;
        if (!accessible) {
          audit.accessibilityFailures.push({
            origin: "animation-frame",
            recordedAt: performance.now(),
            surfaces: accessibility,
          });
        }
        const surfaces = registrations.flatMap(({ surface }) =>
          surface ? [surface] : [],
        );
        if (surfaces.length !== registrations.length) {
          audit.frame = requestAnimationFrame(sampleSettleFrame);
          return;
        }
        const computed = surfaces.map((surface) =>
          Number.parseFloat(
            getComputedStyle(surface).getPropertyValue(
              "--mobile-chrome-collapse",
            ),
          ),
        );
        const specified = surfaces.map((surface) =>
          Number.parseFloat(
            surface.style.getPropertyValue("--mobile-chrome-collapse"),
          ),
        );
        if (
          computed.every(Number.isFinite) &&
          specified.every(Number.isFinite)
        ) {
          const appBarSurface = surfaces[0]!;
          const nexusSurface = surfaces.at(-1)!;
          const appBarRect = appBarSurface.getBoundingClientRect();
          const nexusWrapper = nexusSurface.parentElement;
          if (!(nexusWrapper instanceof HTMLElement)) {
            throw new Error("Nexus has no stable geometry wrapper.");
          }
          const nexusWrapperRect = nexusWrapper.getBoundingClientRect();
          const transformY = (surface: HTMLElement) => {
            const transform = getComputedStyle(surface).transform;
            return transform === "none"
              ? 0
              : new DOMMatrixReadOnly(transform).m42;
          };
          const paneTransformError = presentPaneToolbar
            ? Math.abs(
                transformY(presentPaneToolbar) +
                  computed[1]! *
                    (appBarRect.height +
                      presentPaneToolbar.getBoundingClientRect().height),
              )
            : 0;
          const nexusProgress = computed.at(-1)!;
          audit.maxComputedSpread = Math.max(
            audit.maxComputedSpread,
            Math.max(...computed) - Math.min(...computed),
          );
          audit.maxSpecifiedSpread = Math.max(
            audit.maxSpecifiedSpread,
            Math.max(...specified) - Math.min(...specified),
          );
          audit.maxTransformError = Math.max(
            audit.maxTransformError,
            Math.abs(
              transformY(appBarSurface) + computed[0]! * appBarRect.height,
            ),
            paneTransformError,
            Math.abs(
              transformY(nexusSurface) -
                nexusProgress * (window.innerHeight - nexusWrapperRect.top),
            ),
          );
        }
      }
      audit.frame = requestAnimationFrame(sampleSettleFrame);
    };
    auditWindow.__nexusMobileChromeTransitionAudit = audit;
    document.addEventListener("transitionrun", audit.listener, true);
    document.addEventListener("transitionend", audit.listener, true);
    document.addEventListener("transitioncancel", audit.listener, true);
    audit.frame = requestAnimationFrame(sampleSettleFrame);
  }, expectPaneToolbar);

  try {
    const resetAudit = () =>
      page.evaluate(() => {
        const auditWindow = window as typeof window & {
          __nexusMobileChromeTransitionAudit?: {
            runs: number;
            ends: number;
            cancels: number;
            allSettleFramesAccessible: boolean;
            accessibilityFailures: SettleAccessibilityFailure[];
            settleFrames: number;
            maxComputedSpread: number;
            maxSpecifiedSpread: number;
            maxTransformError: number;
            events: Array<{ type: string; recordedAt: number }>;
          };
        };
        const audit = auditWindow.__nexusMobileChromeTransitionAudit;
        if (!audit) {
          throw new Error("Mobile chrome transition audit is not installed.");
        }
        audit.runs = 0;
        audit.ends = 0;
        audit.cancels = 0;
        audit.allSettleFramesAccessible = true;
        audit.accessibilityFailures = [];
        audit.settleFrames = 0;
        audit.maxComputedSpread = 0;
        audit.maxSpecifiedSpread = 0;
        audit.maxTransformError = 0;
        audit.events = [];
      });
    const readAudit = () =>
      page.evaluate(() => {
        const auditWindow = window as typeof window & {
          __nexusMobileChromeTransitionAudit?: {
            runs: number;
            ends: number;
            cancels: number;
            allSettleFramesAccessible: boolean;
            accessibilityFailures: SettleAccessibilityFailure[];
            settleFrames: number;
            maxComputedSpread: number;
            maxSpecifiedSpread: number;
            maxTransformError: number;
            events: Array<{ type: string; recordedAt: number }>;
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
          allSettleFramesAccessible: audit.allSettleFramesAccessible,
          accessibilityFailures: audit.accessibilityFailures,
          settleFrames: audit.settleFrames,
          maxComputedSpread: audit.maxComputedSpread,
          maxSpecifiedSpread: audit.maxSpecifiedSpread,
          maxTransformError: audit.maxTransformError,
          events: audit.events,
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
    const expectSynchronizedSettle = (
      audit: Awaited<ReturnType<typeof readAudit>>,
      scenario: string,
    ) => {
      expect(
        audit.settleFrames,
        `${scenario} must sample the live settle timeline`,
      ).toBeGreaterThan(0);
      expect(
        audit.allSettleFramesAccessible,
        `${scenario} must keep every chrome surface inert and aria-hidden throughout settle; failures=${JSON.stringify(audit.accessibilityFailures)}`,
      ).toBe(true);
      expect(
        audit.maxSpecifiedSpread,
        `${scenario} must retain one specified collapse value`,
      ).toBeLessThan(0.000_001);
      expect(
        audit.maxComputedSpread,
        `${scenario} must keep computed collapse synchronized`,
      ).toBeLessThan(0.01);
      expect(
        audit.maxTransformError,
        `${scenario} transforms must follow their computed collapse value`,
      ).toBeLessThanOrEqual(1);
    };

    await resetAudit();
    const interruptionRecording = await dispatchTouchDrag(
      page,
      scrollport,
      proveInterruption ? -64 : -32,
      8,
      {
        // The interruption proof must arm its next touch immediately after
        // touchend, before the idle settle task can start. Preserve explicit
        // trusted boundaries so both gestures stay in one CDP lifecycle.
        driveWithTouchEvents: true,
        expectPaneToolbar,
        allowTransitionDuringTouch: true,
        ...(proveInterruption
          ? {
              followUpDrag: {
                // Clear Chromium's touch slop and create native reverse
                // scrolling without forcing either endpoint. The sampled
                // interrupted state must remain the owner of the next settle.
                fingerDeltaY: 24,
                steps: 4,
                afterTouchStart: async () => {
                  await waitForTransitionRun();
                },
              },
            }
          : {}),
        stopBeforeTouchEnd: true,
      },
    );
    const interruptedSamples = interruptionRecording.samples;
    expect(
      interruptedSamples.some(
        (sample) =>
          sample.appBar.progress > 0.05 && sample.appBar.progress < 0.95,
      ),
      `partial trusted drag must stop between endpoints; samples=${JSON.stringify(interruptedSamples)}`,
    ).toBe(true);
    if (!proveInterruption) {
      await waitForTransitionRun();
      await waitForAnimationFrame(page);
      await expectChromePhase(page, scrollport, "Visible", expectPaneToolbar);
      await expect
        .poll(async () => (await readAudit()).ends)
        .toBeGreaterThan(0);
      expectSynchronizedSettle(
        await readAudit(),
        "completed PaneToolbar settle",
      );
      return;
    }
    const { touchStartAt, touchEndAt } = interruptionRecording;
    if (touchStartAt === null || touchEndAt === null) {
      throw new Error(
        `settle interruption lost its trusted touch boundaries; recording=${JSON.stringify(interruptionRecording)}`,
      );
    }
    const firstNativeScrollAt = interruptionRecording.scrollEvents.find(
      ({ recordedAt }) => recordedAt >= touchStartAt,
    )?.recordedAt;
    expect(
      firstNativeScrollAt,
      `settle interruption must produce native scrolling; recording=${JSON.stringify(interruptionRecording)}`,
    ).toBeDefined();
    const interruptionAudit = await readAudit();
    const settleStartedAt = interruptionAudit.events
      .filter(
        ({ type, recordedAt }) =>
          type === "transitionrun" &&
          recordedAt < (firstNativeScrollAt ?? Number.NEGATIVE_INFINITY),
      )
      .at(-1)?.recordedAt;
    expect(
      settleStartedAt,
      `stationary trusted touch must observe a live idle settle before native scrolling; recording=${JSON.stringify(interruptionRecording)}`,
    ).toBeDefined();
    expect(
      interruptionAudit.events.every(
        ({ type, recordedAt }) =>
          (type !== "transitionend" && type !== "transitioncancel") ||
          settleStartedAt === undefined ||
          recordedAt < settleStartedAt ||
          recordedAt >= (firstNativeScrollAt ?? Number.POSITIVE_INFINITY),
      ),
      `the idle settle must remain live from trusted touchstart until native scrolling; recording=${JSON.stringify(interruptionRecording)}`,
    ).toBe(true);
    expect(
      interruptionAudit.events.some(
        ({ type, recordedAt }) =>
          type === "transitioncancel" &&
          firstNativeScrollAt !== undefined &&
          recordedAt >= firstNativeScrollAt &&
          recordedAt <= touchEndAt,
      ),
      `native scrolling must cancel the live CSS settle before touchend; recording=${JSON.stringify(interruptionRecording)}`,
    ).toBe(true);
    for (const sample of interruptionRecording.samples) {
      for (const surface of chromeSurfaces(sample, expectPaneToolbar)) {
        if (surface.phase !== "Tracking" && surface.phase !== "Settling") {
          continue;
        }
        expect(
          surface.inert,
          `moving chrome must remain inert during settle interruption; sample=${JSON.stringify(sample)}`,
        ).toBe(true);
        expect(
          surface.ariaHidden,
          `moving chrome must remain aria-hidden during settle interruption; sample=${JSON.stringify(sample)}`,
        ).toBe("true");
      }
    }
    const terminalTrackingSample = interruptionRecording.samples
      .filter(
        (sample) =>
          sample.recordedAt >=
            (firstNativeScrollAt ?? Number.POSITIVE_INFINITY) &&
          sample.recordedAt <= touchEndAt &&
          sample.appBar.phase === "Tracking",
      )
      .at(-1);
    expect(
      terminalTrackingSample,
      `interrupted native motion must publish a terminal tracking sample; recording=${JSON.stringify(interruptionRecording)}`,
    ).toBeDefined();
    const expectedEndpoint =
      terminalTrackingSample!.appBar.progress < 0.5 ? "Visible" : "Hidden";
    const endpoint = await expectChromePhase(
      page,
      scrollport,
      expectedEndpoint,
      expectPaneToolbar,
    );
    const endpointIsHidden = expectedEndpoint === "Hidden";
    for (const surface of chromeSurfaces(endpoint, expectPaneToolbar)) {
      expect(surface.inert).toBe(endpointIsHidden);
      expect(surface.ariaHidden).toBe(endpointIsHidden ? "true" : null);
    }
    await expect
      .poll(async () => (await readAudit()).cancels)
      .toBeGreaterThan(0);
    await expect.poll(async () => (await readAudit()).ends).toBeGreaterThan(0);
    expectSynchronizedSettle(
      await readAudit(),
      "interrupted settle through cancellation",
    );
    if (endpointIsHidden) {
      await expectTrustedWheelRecovery(page, scrollport);
    }
    const visible = await expectChromePhase(
      page,
      scrollport,
      "Visible",
      expectPaneToolbar,
    );
    for (const surface of chromeSurfaces(visible, expectPaneToolbar)) {
      expect(surface.inert).toBe(false);
      expect(surface.ariaHidden).toBeNull();
    }

    await resetAudit();
    const { samples: completedSamples } = await dispatchTouchDrag(
      page,
      scrollport,
      -32,
      8,
      { expectPaneToolbar },
    );
    expect(
      completedSamples.some(
        (sample) =>
          sample.appBar.progress > 0.05 && sample.appBar.progress < 0.95,
      ),
      `second partial trusted drag must stop between endpoints; samples=${JSON.stringify(completedSamples)}`,
    ).toBe(true);
    await waitForTransitionRun();
    await waitForAnimationFrame(page);
    await expectChromePhase(page, scrollport, "Visible", expectPaneToolbar);
    await expect.poll(async () => (await readAudit()).ends).toBeGreaterThan(0);
    const completedAudit = await readAudit();
    expectSynchronizedSettle(completedAudit, "completed settle");
  } finally {
    await page.evaluate(() => {
      const auditWindow = window as typeof window & {
        __nexusMobileChromeTransitionAudit?: {
          frame: number;
          listener: EventListener;
        };
      };
      const audit = auditWindow.__nexusMobileChromeTransitionAudit;
      if (audit) {
        document.removeEventListener("transitionrun", audit.listener, true);
        document.removeEventListener("transitionend", audit.listener, true);
        document.removeEventListener("transitioncancel", audit.listener, true);
        cancelAnimationFrame(audit.frame);
      }
      delete auditWindow.__nexusMobileChromeTransitionAudit;
    });
  }
}

const INTERACTIVE_READER_TARGET = [
  "a[href]",
  "audio[controls]",
  "button",
  "iframe",
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
const READER_TAP_REVEAL_SURFACE = "[data-reader-tap-reveal-surface='true']";

async function expectBlankTapReveal(
  page: Page,
  scrollport: Locator,
  expectPaneToolbar = false,
  expectRevealSurface = false,
): Promise<void> {
  await expectChromePhase(page, scrollport, "Hidden", expectPaneToolbar);
  const pane = activeWorkspacePane(page);
  const paneId = await pane.getAttribute("data-pane-id");
  if (!paneId) {
    throw new Error("Active pane has no stable pane id.");
  }
  const href = page.url();
  const dialogCount = await page.getByRole("dialog").count();
  await expect(scrollport).toBeVisible();
  const point = await scrollport.evaluate(
    (element, { interactiveTargetSelector, revealSurfaceSelector }) => {
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
          const clientX = rect.left + x;
          const clientY = rect.top + y;
          const target = document.elementFromPoint(clientX, clientY);
          const revealSurface = target
            ? target.closest(revealSurfaceSelector)
            : null;
          const interactiveBoundary = revealSurface ?? element;
          const interactive = target
            ? target.closest(interactiveTargetSelector)
            : null;
          if (
            !target ||
            !element.contains(target) ||
            (interactive !== null &&
              interactive !== interactiveBoundary &&
              interactiveBoundary.contains(interactive)) ||
            target.closest("[data-reader-tap-handled='true']") ||
            target.closest("[data-mobile-chrome-phase]")
          ) {
            continue;
          }
          return {
            clientX,
            clientY,
            target: target.outerHTML.slice(0, 300),
          };
        }
      }
      throw new Error(
        `Reader has no verified blank-canvas tap point: ${element.outerHTML.slice(0, 500)}`,
      );
    },
    {
      interactiveTargetSelector: INTERACTIVE_READER_TARGET,
      revealSurfaceSelector: READER_TAP_REVEAL_SURFACE,
    },
  );

  expect(
    point.target,
    "blank-canvas target precondition must identify a real reader descendant",
  ).not.toBe("");
  await page.evaluate(
    ({ interactiveTargetSelector, revealSurfaceSelector }) => {
      type ClickSnapshot = {
        target: string;
        defaultPrevented: boolean;
        interactive: string | null;
        classifiedInteractive: boolean;
        revealSurface: string | null;
        handled: string | null;
      };
      type BlankTapAudit = {
        captured: ClickSnapshot | null;
        bubbled: ClickSnapshot | null;
        captureListener: EventListener;
        bubbleListener: EventListener;
      };
      const auditWindow = window as typeof window & {
        __nexusBlankTapAudit?: BlankTapAudit;
      };
      const prior = auditWindow.__nexusBlankTapAudit;
      if (prior) {
        document.removeEventListener("click", prior.captureListener, true);
        window.removeEventListener("click", prior.bubbleListener);
      }
      const snapshot = (event: Event): ClickSnapshot => {
        const target = event.target instanceof Element ? event.target : null;
        const revealSurface = target?.closest(revealSurfaceSelector) ?? null;
        const interactive = target?.closest(interactiveTargetSelector) ?? null;
        return {
          target: target?.outerHTML.slice(0, 300) ?? String(event.target),
          defaultPrevented: event.defaultPrevented,
          interactive: interactive?.outerHTML.slice(0, 300) ?? null,
          classifiedInteractive:
            interactive !== null &&
            (revealSurface === null ||
              (interactive !== revealSurface &&
                revealSurface.contains(interactive))),
          revealSurface: revealSurface?.outerHTML.slice(0, 300) ?? null,
          handled:
            target
              ?.closest("[data-reader-tap-handled='true']")
              ?.outerHTML.slice(0, 300) ?? null,
        };
      };
      const audit: BlankTapAudit = {
        captured: null,
        bubbled: null,
        captureListener: ((event: Event) => {
          audit.captured = snapshot(event);
        }) as EventListener,
        bubbleListener: ((event: Event) => {
          audit.bubbled = snapshot(event);
        }) as EventListener,
      };
      document.addEventListener("click", audit.captureListener, true);
      window.addEventListener("click", audit.bubbleListener);
      auditWindow.__nexusBlankTapAudit = audit;
    },
    {
      interactiveTargetSelector: INTERACTIVE_READER_TARGET,
      revealSurfaceSelector: READER_TAP_REVEAL_SURFACE,
    },
  );
  await page.touchscreen.tap(point.clientX, point.clientY);
  const clickAudit = await page.evaluate(() => {
    const auditWindow = window as typeof window & {
      __nexusBlankTapAudit?: {
        captured: unknown;
        bubbled: unknown;
        captureListener: EventListener;
        bubbleListener: EventListener;
      };
    };
    const audit = auditWindow.__nexusBlankTapAudit;
    if (!audit) {
      throw new Error("Blank-tap click audit is missing.");
    }
    document.removeEventListener("click", audit.captureListener, true);
    window.removeEventListener("click", audit.bubbleListener);
    delete auditWindow.__nexusBlankTapAudit;
    return {
      captured: audit.captured,
      bubbled: audit.bubbled,
    };
  });
  if (expectRevealSurface) {
    for (const [stage, snapshot] of Object.entries(clickAudit)) {
      expect(
        snapshot,
        `PDF ${stage} click must resolve through its passive reader-surface boundary`,
      ).toMatchObject({
        defaultPrevented: false,
        classifiedInteractive: false,
        handled: null,
        revealSurface: expect.stringContaining(
          "data-reader-tap-reveal-surface",
        ),
      });
    }
  }
  try {
    await expectChromePhase(page, scrollport, "Visible", expectPaneToolbar);
  } catch (error) {
    throw new Error(
      `trusted blank-canvas tap did not reveal chrome; point=${JSON.stringify(point)} click=${JSON.stringify(clickAudit)} after=${JSON.stringify(await readChromeSample(page, scrollport))}; cause=${String(error)}`,
    );
  }
  expect(page.url()).toBe(href);
  await expect(activeWorkspacePane(page)).toHaveAttribute(
    "data-pane-id",
    paneId,
  );
  await expect(page.getByRole("dialog")).toHaveCount(dialogCount);
  expect(
    await page.evaluate(() => window.getSelection()?.isCollapsed === true),
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
  await expect(landmark).toHaveAttribute("tabindex", "-1");
  await expect(landmark).toHaveAccessibleName(/\S/);
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
      await expectChromePhase(
        page,
        scrollport,
        "Visible",
        format.expectsPaneToolbar,
      );
      if (format.expectsPaneToolbar) {
        await expect(
          pane.getByRole("button", { name: format.toolbarControlName }),
        ).toBeVisible();
      }

      if (format.name === "transcript") {
        const segmentList = pane.locator('[class*="transcriptSegments"]');
        await expect(segmentList).toBeVisible();
        expect(
          await segmentList.evaluate(
            (element) => getComputedStyle(element).overflowY,
          ),
        ).not.toMatch(/auto|scroll/);
      }

      await expectTrustedForwardRetreat(
        page,
        scrollport,
        format.expectsPaneToolbar,
        format.name === "Web",
      );
      await expect(page.getByRole("banner")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^Open Nexus,/ }),
      ).toHaveCount(0);
      if ("toolbarControlName" in format) {
        await expect(
          pane.getByRole("button", { name: format.toolbarControlName }),
        ).toHaveCount(0);
      }
      if (format.name === "Web") {
        const article = readSeed<ArticleSeed>(format.seedFile);
        await expectTrustedHandledAnnotationTap(
          page,
          scrollport,
          article.quote_highlight_id,
        );
      }
      const trustedDeadZone = await expectTrustedReverseDeadZone(
        page,
        scrollport,
        format.expectsPaneToolbar,
      );
      await expectTrustedReverseReveal(
        page,
        scrollport,
        trustedDeadZone,
        format.expectsPaneToolbar,
      );

      if (format.name === "Web") {
        await expectTrustedForwardRetreat(page, scrollport);
        await expectTrustedWheelRecovery(page, scrollport);
        await expectTrustedForwardRetreat(page, scrollport);
        await expectTrustedKeyboardTopRecovery(page, scrollport);
      }
      await expectTrustedForwardRetreat(
        page,
        scrollport,
        format.expectsPaneToolbar,
      );
      if (format.name === "Web") {
        await expectTabSkipsMovingChrome(page, scrollport);
      }
      if (format.hasBlankTapSurface) {
        await expectBlankTapReveal(
          page,
          scrollport,
          format.expectsPaneToolbar,
          format.name === "PDF",
        );
      } else {
        const transcriptTapPoint = await scrollport.evaluate((element) => {
          const scrollportRect = element.getBoundingClientRect();
          const button = [
            ...element.querySelectorAll<HTMLElement>("button"),
          ].find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return (
              rect.top >= scrollportRect.top &&
              rect.bottom <= scrollportRect.bottom &&
              rect.height > 0 &&
              rect.width > 0
            );
          });
          if (!button) {
            throw new Error(
              "Transcript has no fully visible interactive segment.",
            );
          }
          const rect = button.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        });
        await page.touchscreen.tap(transcriptTapPoint.x, transcriptTapPoint.y);
        await expectChromePhase(
          page,
          scrollport,
          "Hidden",
          format.expectsPaneToolbar,
        );
      }

      if (format.name === "Web") {
        const article = readSeed<ArticleSeed>(format.seedFile);
        await expectTrustedSettleLifecycle(page, scrollport, false);
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
          .getByTestId("pane-contextual-row")
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
          .getByTestId("pane-contextual-row")
          .getByRole("button", { name: "Close search", exact: true })
          .click();
        await expectFocusOnVisibleChromeOrLandmark(page);
        await expectTrustedForwardRetreat(page, scrollport);
      }
      if (format.name === "EPUB") {
        await expectTrustedSettleLifecycle(page, scrollport, true, false);
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
      await expectTrustedForwardRetreat(page, scrollport, true);
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
    const safeLeft = 144;
    const safeRight = 32;
    const safeBottom = 15;
    await page.setViewportSize({ width: 780, height: 360 });
    const audio = readSeed<AudioSeed>("activity-audio-media.json");
    const article = readSeed<ArticleSeed>("non-pdf-media.json");
    await page.route(`**${audio.stream_path}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: toneWav(120),
      }),
    );
    await placeAudioInLectern(page, audio.media_id);
    await resetReaderProgress(page, article.media_id);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: {
        top: 0,
        topMax: 0,
        left: safeLeft,
        leftMax: safeLeft,
        bottom: safeBottom,
        bottomMax: safeBottom,
        right: safeRight,
        rightMax: safeRight,
      },
    });
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

      const progress = player
        .locator(':scope > span[aria-hidden="true"]')
        .first();
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const [playerRect, progressRect, rowPadding, controlRects] =
        await Promise.all([
          player.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, bottom: rect.bottom };
          }),
          progress.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          }),
          player.locator(":scope > :nth-child(2)").evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              left: Number.parseFloat(style.paddingLeft),
              right: Number.parseFloat(style.paddingRight),
            };
          }),
          player
            .locator(
              'button, a[href], input, select, textarea, [role="button"]',
            )
            .evaluateAll((elements) =>
              elements
                .map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    name:
                      element.getAttribute("aria-label") ??
                      element.textContent?.trim() ??
                      element.tagName,
                    left: rect.left,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                  };
                })
                .filter((rect) => rect.width > 0 && rect.height > 0),
            ),
        ]);
      expect(playerRect.left).toBeCloseTo(0, 0);
      expect(playerRect.right).toBeCloseTo(viewport.width, 0);
      expect(playerRect.bottom).toBeCloseTo(viewport.height, 0);
      expect(progressRect.left).toBeCloseTo(playerRect.left, 0);
      expect(progressRect.right).toBeCloseTo(playerRect.right, 0);
      expect(rowPadding).toEqual({ left: safeLeft, right: safeRight });
      expect(controlRects.length).toBeGreaterThan(0);
      for (const rect of controlRects) {
        expect(rect.left).toBeGreaterThanOrEqual(safeLeft - 1);
        expect(rect.right).toBeLessThanOrEqual(
          viewport.width - safeRight + 1,
        );
        expect(
          rect.bottom,
          `${rect.name} intersects the bottom safe edge`,
        ).toBeLessThanOrEqual(viewport.height - safeBottom);
      }

      await page.getByRole("button", { name: "Open Nexus, 2 tabs" }).tap();
      await page
        .getByRole("dialog", { name: "Nexus" })
        .getByRole("region", { name: "Open" })
        .getByRole("button", { name: /^Media\b/ })
        .tap();
      await expect(page.getByRole("dialog", { name: "Nexus" })).toHaveCount(0);
      await expect(player).toBeVisible();

      const scrollport =
        activeWorkspacePane(page).getByTestId("document-viewport");
      await expect(scrollport).toBeVisible({ timeout: 20_000 });
      await waitForAnimationFrame(page);
      await waitForAnimationFrame(page);
      await expect
        .poll(async () => {
          const [readerBottom, playerTop] = await Promise.all([
            scrollport.evaluate(
              (element) => element.getBoundingClientRect().bottom,
            ),
            player.evaluate((element) => element.getBoundingClientRect().top),
          ]);
          return Math.abs(readerBottom - playerTop);
        })
        .toBeLessThanOrEqual(1);
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
      await expect(
        page
          .locator(
            'header[data-pane-chrome-for="pane-player-reader"][data-mobile-chrome-phase]',
          )
          .locator("[data-pane-options-trigger]"),
      ).toBeFocused();
      const pinned = await expectChromePhase(page, scrollport, "Pinned");
      for (const surface of chromeSurfaces(pinned)) {
        expect(surface.progress).toBe(0);
        expect(surface.inert).toBe(false);
        expect(surface.ariaHidden).toBeNull();
      }
      await expectTrustedForwardRetreat(page, scrollport);
    } finally {
      try {
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
      } finally {
        await cdp.detach();
        await removeAudioFromLectern(page, audio.media_id);
      }
    }
  });
});
