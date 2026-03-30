import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsWorkspaceHost from "@/components/workspace/SettingsWorkspaceHost";

const mockPathname = vi.hoisted(() => ({ value: "/settings" }));
const mockSearch = vi.hoisted(() => ({ value: "" }));
const mockIsMobile = vi.hoisted(() => ({ value: false }));

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () =>
    ({
      toString: () => mockSearch.value,
      get: (key: string) => new URLSearchParams(mockSearch.value).get(key),
      getAll: (key: string) => new URLSearchParams(mockSearch.value).getAll(key),
      has: (key: string) => new URLSearchParams(mockSearch.value).has(key),
      entries: () => new URLSearchParams(mockSearch.value).entries(),
      keys: () => new URLSearchParams(mockSearch.value).keys(),
      values: () => new URLSearchParams(mockSearch.value).values(),
      forEach: (callback: (value: string, key: string) => void) =>
        new URLSearchParams(mockSearch.value).forEach(callback),
      [Symbol.iterator]: () => new URLSearchParams(mockSearch.value)[Symbol.iterator](),
    }) as URLSearchParams,
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockIsMobile.value,
}));

describe("SettingsWorkspaceHost", () => {
  beforeEach(() => {
    mockPathname.value = "/settings";
    mockSearch.value = "";
    mockIsMobile.value = false;
  });

  it("renders settings in pane shell with fixed chrome and scrolling body", () => {
    render(<SettingsWorkspaceHost />);

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();

    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    expect(body.contains(chrome)).toBe(false);
    expect(body).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });
  });

  it("uses explicit desktop pane width instead of full-width flex sizing", () => {
    render(<SettingsWorkspaceHost />);

    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 480px"));
    expect(paneShell).not.toHaveAttribute(
      "style",
      expect.stringContaining("width: 100%")
    );
  });

  it("shows one full-width active pane on mobile", () => {
    mockIsMobile.value = true;

    render(<SettingsWorkspaceHost />);

    expect(screen.getByText("Integrations")).toBeInTheDocument();
    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
  });
});
