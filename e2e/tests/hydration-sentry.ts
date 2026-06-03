import { expect, type ConsoleMessage, type Page } from "@playwright/test";

const HYDRATION_PATTERNS = [
  /Minified React error #418/i,
  /react\.dev\/errors\/418/i,
  /Hydration failed/i,
  /Text content does not match/i,
  /Text content did not match/i,
  /server rendered HTML didn't match/i,
  /Expected server HTML/i,
  /nextjs\.org\/docs\/messages\/react-hydration-error/i,
  /validateDOMNesting/i,
];

function isHydrationDiagnostic(message: string): boolean {
  return HYDRATION_PATTERNS.some((pattern) => pattern.test(message));
}

export interface HydrationSentry {
  expectClean(label?: string): Promise<void>;
  dispose(): void;
}

export async function installHydrationSentry(page: Page): Promise<HydrationSentry> {
  const messages: string[] = [];
  await page.addInitScript((patterns) => {
    const regexes = patterns.map((pattern) => new RegExp(pattern, "i"));
    const win = window as typeof window & { __nexusHydrationDiagnostics?: string[] };
    win.__nexusHydrationDiagnostics = [];
    const capture = (args: unknown[]) => {
      const text = args.map((arg) => String(arg)).join(" ");
      if (regexes.some((regex) => regex.test(text))) {
        win.__nexusHydrationDiagnostics?.push(text);
      }
    };
    const originalError = console.error.bind(console);
    const originalWarn = console.warn.bind(console);
    console.error = (...args: unknown[]) => {
      capture(args);
      originalError(...args);
    };
    console.warn = (...args: unknown[]) => {
      capture(args);
      originalWarn(...args);
    };
  }, HYDRATION_PATTERNS.map((pattern) => pattern.source));

  const onConsole = (message: ConsoleMessage) => {
    if (isHydrationDiagnostic(message.text())) {
      messages.push(message.text());
    }
  };
  const onPageError = (error: Error) => {
    if (isHydrationDiagnostic(error.message)) {
      messages.push(error.message);
    }
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return {
    async expectClean(label?: string) {
      await page.waitForTimeout(250);
      const pageMessages = await page.evaluate(() => {
        const win = window as typeof window & { __nexusHydrationDiagnostics?: string[] };
        return win.__nexusHydrationDiagnostics ?? [];
      });
      const allMessages = [...messages, ...pageMessages];
      expect(allMessages, label ?? "hydration diagnostics").toEqual([]);
    },
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}
