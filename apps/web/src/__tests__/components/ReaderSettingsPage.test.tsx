import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReaderSettingsPage from "@/app/(authenticated)/settings/reader/page";
import { useReaderContext } from "@/lib/reader";
import { DEFAULT_READER_PROFILE } from "@/lib/reader/types";

vi.mock("@/lib/reader", () => ({
  useReaderContext: vi.fn(),
}));

describe("ReaderSettingsPage", () => {
  const mockUpdateTheme = vi.fn();

  beforeEach(() => {
    vi.mocked(useReaderContext).mockReturnValue({
      profile: DEFAULT_READER_PROFILE,
      loading: false,
      error: null,
      saving: false,
      updateTheme: mockUpdateTheme,
      updateFontFamily: vi.fn(),
      updateFontSize: vi.fn(),
      updateLineHeight: vi.fn(),
      updateColumnWidth: vi.fn(),
      updateFocusMode: vi.fn(),
    });
  });

  it("renders reader settings page with theme, font, and focus controls", async () => {
    render(<ReaderSettingsPage />);

    expect(screen.getByRole("heading", { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^theme$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^font$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/font size \(\d+px\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/line height \(\d+\.?\d*\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/column width \(\d+ ch\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/focus mode/i)).toBeInTheDocument();
  });

  it("calls updateTheme when theme select changes", async () => {
    render(<ReaderSettingsPage />);

    const themeSelect = screen.getByLabelText(/theme/i);
    await userEvent.selectOptions(themeSelect, "dark");

    await waitFor(() => {
      expect(mockUpdateTheme).toHaveBeenCalledWith("dark");
    });
  });

  it("shows backend-supported font and theme options only", () => {
    render(<ReaderSettingsPage />);

    const fontSelect = screen.getByLabelText(/^font$/i);
    const fontOptionValues = Array.from(
      fontSelect.querySelectorAll("option")
    ).map((opt) => opt.getAttribute("value"));
    expect(fontOptionValues).toEqual(["serif", "sans"]);

    const themeSelect = screen.getByLabelText(/^theme$/i);
    const themeOptionValues = Array.from(
      themeSelect.querySelectorAll("option")
    ).map((opt) => opt.getAttribute("value"));
    expect(themeOptionValues).toEqual(["light", "dark"]);
  });
});
