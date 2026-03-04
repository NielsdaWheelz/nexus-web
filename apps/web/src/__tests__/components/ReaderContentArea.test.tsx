import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ReaderContentArea from "@/components/ReaderContentArea";
import { useReaderContext } from "@/lib/reader";
import { DEFAULT_READER_PROFILE } from "@/lib/reader/types";

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
});
