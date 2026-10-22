// native playwright owns fixtures and verdicts. every campaign page is created
// through newPage, which awaits CPU throttling before any app navigation. callers
// own custom contexts. uncontrolled popups invalidate the measurement and cannot
// be hidden by a case's expected-failure annotation. literal choreography stays
// wall-clock; configuration owns scaled deadlines.
import { test as base, type BrowserContext, type Page } from "@playwright/test";
import { readLabContext } from "./context";

const lab = readLabContext();

export const test = base.extend<{
  newPage: (context: BrowserContext) => Promise<Page>;
}>({
  newPage: async ({ actionTimeout, navigationTimeout }, provide, testInfo) => {
    let uncontrolledPopup = false;
    await provide(async (context) => {
      const page = await context.newPage();
      page.setDefaultTimeout(actionTimeout);
      page.setDefaultNavigationTimeout(navigationTimeout);
      if (lab.client_cpu_throttle !== null) {
        page.on("popup", () => { uncontrolledPopup = true; });
        const session = await context.newCDPSession(page);
        await session.send("Emulation.setCPUThrottlingRate", { rate: lab.client_cpu_throttle });
      }
      return page;
    });
    if (uncontrolledPopup) {
      testInfo.expectedStatus = "passed";
      throw new Error("uncontrolled popup invalidates client throttling; use awaited newPage");
    }
  },
  page: async ({ context, newPage }, provide) => {
    await provide(await newPage(context));
  },
});
