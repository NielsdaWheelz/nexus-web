import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ReaderContentArea from "@/components/ReaderContentArea";
import { useReaderContext } from "@/lib/reader";
import { DEFAULT_READER_PROFILE } from "@/lib/reader/types";

const THEME_SENTINELS = {
  light: {
    "--reader-bg": "#f8fafc",
    "--reader-text": "#1f2937",
  },
  dark: {
    "--reader-bg": "#1e1e2e",
    "--reader-text": "#cdd6f4",
  },
  sepia: {
    "--reader-bg": "#f4ecd8",
    "--reader-text": "#5c4b37",
  },
} as const;

vi.mock("@/lib/reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reader")>();
  return {
    ...actual,
    useReaderContext: vi.fn(),
  };
});

describe("ReaderContentArea", () => {
  beforeEach(() => {
    vi.mocked(useReaderContext).mockReturnValue({
      profile: { ...DEFAULT_READER_PROFILE, theme: "light" },
      loading: false,
      error: null,
    });
  });

  it("applies reader theme data attribute", () => {
    render(
      <ReaderContentArea>
        <span>Test content</span>
      </ReaderContentArea>
    );

    const root = screen.getByText("Test content").closest("[data-reader-theme]");
    expect(root).toHaveAttribute("data-reader-theme", "light");
    expect(screen.getByText("Test content")).toBeInTheDocument();
  });

  it("applies dark theme class when profile theme is dark", () => {
    vi.mocked(useReaderContext).mockReturnValue({
      profile: { ...DEFAULT_READER_PROFILE, theme: "dark" },
      loading: false,
      error: null,
    });

    render(
      <ReaderContentArea>
        <span>Dark content</span>
      </ReaderContentArea>
    );

    const root = screen.getByText("Dark content").closest("[data-reader-theme='dark']");
    expect(root).toBeInTheDocument();
  });

  it.each(["light", "dark", "sepia"] as const)(
    "defines full reader token set for %s theme",
    (theme) => {
      vi.mocked(useReaderContext).mockReturnValue({
        profile: { ...DEFAULT_READER_PROFILE, theme },
        loading: false,
        error: null,
      });

      render(
        <ReaderContentArea>
          <span>Token content</span>
        </ReaderContentArea>
      );

      const root = screen
        .getByText("Token content")
        .closest("[data-reader-theme]") as HTMLElement;
      const computed = getComputedStyle(root);
      const requiredTokens = [
        "--reader-bg",
        "--reader-bg-secondary",
        "--reader-surface",
        "--reader-text",
        "--reader-text-secondary",
        "--reader-text-muted",
        "--reader-border",
        "--reader-border-subtle",
        "--reader-accent",
        "--reader-accent-hover",
      ];

      for (const token of requiredTokens) {
        expect(
          computed.getPropertyValue(token).trim(),
          `expected ${token} to be defined for ${theme}`
        ).not.toBe("");
      }

      for (const [token, value] of Object.entries(THEME_SENTINELS[theme])) {
        expect(
          computed.getPropertyValue(token).trim(),
          `expected ${token} to map to the ${theme} palette`
        ).toBe(value);
      }
    }
  );

  it("keeps a full-width themed root with a constrained inner content column", () => {
    render(
      <div style={{ width: "1200px" }}>
        <ReaderContentArea>
          <span>Wide content</span>
        </ReaderContentArea>
      </div>
    );

    const root = screen
      .getByText("Wide content")
      .closest("[data-reader-theme]") as HTMLElement;
    const content = root.firstElementChild as HTMLElement;
    const rootComputed = getComputedStyle(root);
    const contentComputed = getComputedStyle(content);
    const rootWidth = root.getBoundingClientRect().width;
    const contentWidth = content.getBoundingClientRect().width;

    expect(rootWidth).toBeGreaterThan(contentWidth);
    expect(contentComputed.maxWidth).not.toBe("none");
    expect(rootComputed.minHeight).toBe("100%");
  });
});
