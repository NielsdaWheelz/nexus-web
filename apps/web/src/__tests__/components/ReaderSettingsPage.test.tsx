import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReaderSettingsPage from "@/app/(authenticated)/settings/reader/page";
import { useReaderProfile } from "@/lib/reader";
import { DEFAULT_READER_PROFILE } from "@/lib/reader/types";

vi.mock("@/lib/reader", () => ({
  useReaderProfile: vi.fn(),
}));

describe("ReaderSettingsPage", () => {
  const mockSave = vi.fn();
  const mockUpdateTheme = vi.fn();

  beforeEach(() => {
    vi.mocked(useReaderProfile).mockReturnValue({
      profile: DEFAULT_READER_PROFILE,
      loading: false,
      error: null,
      saving: false,
      load: vi.fn(),
      save: mockSave,
      updateTheme: mockUpdateTheme,
      updateFontFamily: vi.fn(),
      updateFontSize: vi.fn(),
      updateLineHeight: vi.fn(),
      updateColumnWidth: vi.fn(),
      updateFocusMode: vi.fn(),
      updateDefaultViewMode: vi.fn(),
    });
  });

  it("renders reader settings page with theme and font controls", async () => {
    render(<ReaderSettingsPage />);

    expect(screen.getByRole("heading", { name: /reader/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^theme$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^font$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/font size \(\d+px\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/line height \(\d+\.?\d*\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/column width \(\d+ ch\)/i)).toBeInTheDocument();
  });

  it("calls updateTheme when theme select changes", async () => {
    render(<ReaderSettingsPage />);

    const themeSelect = screen.getByLabelText(/theme/i);
    await userEvent.selectOptions(themeSelect, "dark");

    await waitFor(() => {
      expect(mockUpdateTheme).toHaveBeenCalledWith("dark");
    });
  });

  it("shows backend-supported font and view mode options only", () => {
    render(<ReaderSettingsPage />);

    const fontSelect = screen.getByLabelText(/^font$/i);
    const fontOptionValues = Array.from(
      fontSelect.querySelectorAll("option")
    ).map((opt) => opt.getAttribute("value"));
    expect(fontOptionValues).toEqual(["serif", "sans"]);

    const viewSelect = screen.getByLabelText(/default view/i);
    const viewOptionValues = Array.from(
      viewSelect.querySelectorAll("option")
    ).map((opt) => opt.getAttribute("value"));
    expect(viewOptionValues).toEqual(["scroll", "paged"]);
  });
});
