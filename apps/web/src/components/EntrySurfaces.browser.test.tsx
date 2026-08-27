import type { CSSProperties } from "react";
import { render, screen, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import AndroidPage from "@/app/android/page";
import LoginPageClient from "@/app/login/LoginPageClient";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import AuthSurface from "@/components/auth/AuthSurface";
import EntryCanvas from "@/components/EntryCanvas";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { parseAuthReturnTarget } from "@/lib/auth/redirects";

/**
 * Risk: entry content becomes clipped, horizontally scrollable, too small to
 * operate, or low-contrast when the same DOM crosses desktop, mobile, zoom,
 * and Android safe-area geometry. The approved cutover and WCAG contrast math
 * are the independent oracles; auth behavior belongs to the auth proof.
 */

const DEFAULT_VIEWPORT = { width: 1_024, height: 768 } as const;
const REFLOW_VIEWPORTS = [
  { name: "390x844 mobile", width: 390, height: 844 },
  { name: "360x640 compact mobile", width: 360, height: 640 },
  { name: "844x390 short landscape", width: 844, height: 390 },
  { name: "200%-equivalent reflow", width: 720, height: 450 },
] as const;
const ENTRY_VIEWPORTS = [
  { name: "1440x900 wide", width: 1_440, height: 900 },
  ...REFLOW_VIEWPORTS,
] as const;
const SAFE_INSETS = {
  top: 53,
  right: 41,
  bottom: 59,
  left: 37,
} as const;

const GEOMETRY_FORM_STYLE = {
  display: "flex",
  width: "100%",
  flexDirection: "column",
  gap: "var(--space-3)",
} satisfies CSSProperties;

const FIELD_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
} satisfies CSSProperties;

const SCROLL_PROBE_STYLE = {
  display: "flex",
  minHeight: "48rem",
  flexDirection: "column",
  justifyContent: "space-between",
} satisfies CSSProperties;

function AuthGeometryProbe() {
  return (
    <AuthSurface
      title="Sign in"
      description="Private workspace. No public registration."
    >
      <form aria-label="Entry geometry" style={GEOMETRY_FORM_STYLE}>
        <label htmlFor="entry-geometry-email" style={FIELD_STYLE}>
          <span>Email</span>
          <Input id="entry-geometry-email" size="lg" autoComplete="email" />
        </label>
        <Button size="lg">Continue</Button>
      </form>
    </AuthSurface>
  );
}

function ScrollProbe() {
  return (
    <EntryCanvas>
      <main aria-label="Scrollable entry" style={SCROLL_PROBE_STYLE}>
        <p>Entry start</p>
        <Button asChild variant="ghost" size="lg">
          <a href="/privacy">Terminal action</a>
        </Button>
      </main>
    </EntryCanvas>
  );
}

function setSafeAreaInsets(insets: typeof SAFE_INSETS) {
  for (const [edge, value] of Object.entries(insets)) {
    document.documentElement.style.setProperty(
      `--viewport-safe-${edge}`,
      `${value}px`,
    );
  }
}

function expectMinimumTarget(element: HTMLElement, caseName: string) {
  const { width, height } = element.getBoundingClientRect();
  expect(
    Math.min(width, height),
    `${caseName}: expected a 48px minimum target; received ${width}px by ${height}px`,
  ).toBeGreaterThanOrEqual(48);
}

function expectNoHorizontalOverflow(caseName: string) {
  expect(
    document.documentElement.scrollWidth,
    `${caseName}: document width ${document.documentElement.scrollWidth}px exceeds viewport ${window.innerWidth}px`,
  ).toBeLessThanOrEqual(window.innerWidth);
}

function parseRgb(color: string): readonly [number, number, number] {
  const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/u.exec(
    color,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Unsupported computed color: ${color}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance(color: string): number {
  const channels = parseRgb(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrast(
  foreground: string,
  background: string,
  minimum: number,
  caseName: string,
) {
  const ratio = contrastRatio(foreground, background);
  expect(
    ratio,
    `${caseName}: computed ${ratio.toFixed(2)}:1 from ${foreground} on ${background}`,
  ).toBeGreaterThanOrEqual(minimum);
}

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  for (const edge of Object.keys(SAFE_INSETS)) {
    document.documentElement.style.removeProperty(`--viewport-safe-${edge}`);
  }
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

describe("entry surface geometry", () => {
  it("projects one calm identity and reflows its task without shrinking controls or clipping content", async () => {
    await page.viewport(1_440, 900);
    render(<AuthGeometryProbe />);

    expect(screen.getByText("Nexus")).toBeVisible();
    const descriptor = screen.getByText("A private instrument for attention.");
    expect(descriptor).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();

    const form = screen.getByRole("form", { name: "Entry geometry" });
    const input = screen.getByRole("textbox", { name: "Email" });
    const continueButton = screen.getByRole("button", { name: "Continue" });
    const wideDescriptor = descriptor.getBoundingClientRect();
    const wideForm = form.getBoundingClientRect();

    expect(
      wideDescriptor.right,
      "1440x900: the flexible identity column must precede the compact task column",
    ).toBeLessThan(wideForm.left);
    expect(
      wideForm.width,
      "1440x900: the task column must stay within its 20–24rem measure",
    ).toBeGreaterThanOrEqual(320);
    expect(wideForm.width).toBeLessThanOrEqual(384);
    expectMinimumTarget(input, "1440x900 email");
    expectMinimumTarget(continueButton, "1440x900 primary action");
    expectNoHorizontalOverflow("1440x900");

    for (const viewport of REFLOW_VIEWPORTS) {
      await page.viewport(viewport.width, viewport.height);
      const stackedDescriptor = descriptor.getBoundingClientRect();
      const stackedForm = form.getBoundingClientRect();

      expect(
        stackedDescriptor.bottom,
        `${viewport.name}: identity must stack before the task`,
      ).toBeLessThan(stackedForm.top);
      expect(
        Math.abs(
          stackedDescriptor.left +
            stackedDescriptor.width / 2 -
            (stackedForm.left + stackedForm.width / 2),
        ),
        `${viewport.name}: identity and task must share the centered column`,
      ).toBeLessThanOrEqual(1);
      expect(
        stackedForm.width,
        `${viewport.name}: task exceeded the 24rem measure`,
      ).toBeLessThanOrEqual(384);
      expect(stackedForm.left).toBeGreaterThanOrEqual(0);
      expect(stackedForm.right).toBeLessThanOrEqual(viewport.width);
      expectMinimumTarget(input, `${viewport.name} email`);
      expectMinimumTarget(continueButton, `${viewport.name} primary action`);
      expectNoHorizontalOverflow(viewport.name);
    }
  });

  it("keeps every actual login footer link operable inside its responsive task column", async () => {
    for (const viewport of ENTRY_VIEWPORTS) {
      await page.viewport(viewport.width, viewport.height);
      const view = render(
        <LoginPageClient
          nextPath={parseAuthReturnTarget("/lectern")}
          isShell={false}
        />,
      );

      const footer = screen.getByRole("navigation", { name: "Login links" });
      expect(getComputedStyle(footer).justifyContent).toBe(
        viewport.width >= 960 ? "flex-start" : "center",
      );
      for (const link of within(footer).getAllByRole("link")) {
        expectMinimumTarget(
          link,
          `${viewport.name} login ${link.textContent ?? "footer"} link`,
        );
      }
      expectNoHorizontalOverflow(`${viewport.name} login`);

      view.unmount();
    }
  });

  it("keeps the actual Android release column centered, operable, and focus-reachable at every entry viewport", async () => {
    for (const viewport of ENTRY_VIEWPORTS) {
      await page.viewport(viewport.width, viewport.height);
      const view = render(<AndroidPage />);

      const main = screen.getByRole("main");
      const column = main.getBoundingClientRect();
      expect(
        column.width,
        `${viewport.name}: Android exceeded its 32rem measure`,
      ).toBeLessThanOrEqual(512);
      expect(
        Math.abs(column.left + column.width / 2 - window.innerWidth / 2),
        `${viewport.name}: Android did not remain centered`,
      ).toBeLessThanOrEqual(1);
      expect(column.left).toBeGreaterThanOrEqual(0);
      expect(column.right).toBeLessThanOrEqual(viewport.width);

      const download = screen.getByRole("link", { name: "Download APK" });
      const terminal = screen.getByRole("link", { name: "Terms" });
      expectMinimumTarget(download, `${viewport.name} Android download`);
      expectMinimumTarget(terminal, `${viewport.name} Android terminal link`);
      expectNoHorizontalOverflow(`${viewport.name} Android`);

      if (viewport.height <= 640) {
        expect(
          terminal.getBoundingClientRect().bottom,
          `${viewport.name}: terminal link must begin below the short viewport so focus proves scrolling`,
        ).toBeGreaterThan(window.innerHeight);
      }
      for (let step = 0; step < 7; step += 1) {
        await userEvent.tab();
      }
      expect(terminal).toHaveFocus();
      const visibleTerminal = terminal.getBoundingClientRect();
      expect(visibleTerminal.top).toBeGreaterThanOrEqual(0);
      expect(visibleTerminal.bottom).toBeLessThanOrEqual(window.innerHeight);

      view.unmount();
    }
  });

  it("spends all four canonical safe insets and scrolls terminal content into the safe rectangle", async () => {
    await page.viewport(360, 640);
    setSafeAreaInsets(SAFE_INSETS);
    render(<ScrollProbe />);

    const content = screen.getByRole("main", { name: "Scrollable entry" });
    const initialContent = content.getBoundingClientRect();
    expect(initialContent.top).toBeCloseTo(SAFE_INSETS.top, 0);
    expect(initialContent.left).toBeCloseTo(SAFE_INSETS.left, 0);
    expect(initialContent.right).toBeCloseTo(
      window.innerWidth - SAFE_INSETS.right,
      0,
    );

    const terminal = screen.getByRole("link", { name: "Terminal action" });
    await userEvent.tab();
    expect(terminal).toHaveFocus();
    const visibleTerminal = terminal.getBoundingClientRect();
    expect(visibleTerminal.bottom).toBeLessThanOrEqual(
      window.innerHeight - SAFE_INSETS.bottom,
    );
    expect(content.getBoundingClientRect().top).toBeLessThan(
      initialContent.top,
    );
    expectMinimumTarget(terminal, "safe-area terminal action");
    expectNoHorizontalOverflow("360x640 with four safe insets");
  });

  it.each([
    { routeName: "Privacy", Page: PrivacyPage },
    { routeName: "Terms", Page: TermsPage },
  ])(
    "keeps the actual $routeName utility safe and terminally reachable",
    async ({ routeName, Page }) => {
      await page.viewport(360, 640);
      setSafeAreaInsets(SAFE_INSETS);
      const view = render(<Page />);

      const article = screen.getByRole("article");
      const initialArticle = article.getBoundingClientRect();
      expect(
        initialArticle.left,
        `${routeName}: unsafe leading edge`,
      ).toBeGreaterThanOrEqual(SAFE_INSETS.left);
      expect(
        initialArticle.right,
        `${routeName}: unsafe trailing edge`,
      ).toBeLessThanOrEqual(window.innerWidth - SAFE_INSETS.right);

      const terminal = screen.getByRole("link", { name: "Return to sign in" });
      expect(
        terminal.getBoundingClientRect().bottom,
        `${routeName}: terminal action must begin below the short viewport`,
      ).toBeGreaterThan(window.innerHeight);
      await userEvent.tab();
      expect(terminal).toHaveFocus();
      const visibleTerminal = terminal.getBoundingClientRect();
      expect(visibleTerminal.top).toBeGreaterThanOrEqual(SAFE_INSETS.top);
      expect(visibleTerminal.bottom).toBeLessThanOrEqual(
        window.innerHeight - SAFE_INSETS.bottom,
      );
      expectMinimumTarget(terminal, `${routeName} terminal action`);
      expectNoHorizontalOverflow(`${routeName} 360x640 with safe insets`);

      view.unmount();
    },
  );

  it.each(["dark", "light"] as const)(
    "keeps required identity, action, link, and focus colors above WCAG contrast floors in $theme",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(390, 844);
      render(
        <LoginPageClient
          nextPath={parseAuthReturnTarget("/lectern")}
          isShell={false}
        />,
      );

      const descriptor = screen.getByText(
        "A private instrument for attention.",
      );
      const continueButton = screen.getByRole("button", {
        name: "Continue with Google",
      });
      const privacyLink = screen.getByRole("link", { name: "Privacy" });
      await userEvent.tab();
      expect(continueButton).toHaveFocus();

      const canvas = getComputedStyle(document.body).backgroundColor;
      const descriptorColor = getComputedStyle(descriptor).color;
      const buttonStyle = getComputedStyle(continueButton);
      const linkColor = getComputedStyle(privacyLink).color;

      expectContrast(descriptorColor, canvas, 4.5, `${theme} descriptor text`);
      expectContrast(linkColor, canvas, 4.5, `${theme} footer link`);
      expectContrast(
        buttonStyle.color,
        buttonStyle.backgroundColor,
        4.5,
        `${theme} primary action text`,
      );
      expect(buttonStyle.outlineStyle).toBe("solid");
      expect(buttonStyle.outlineWidth).toBe("2px");
      expectContrast(
        buttonStyle.outlineColor,
        canvas,
        3,
        `${theme} keyboard focus ring`,
      );
    },
  );
});
