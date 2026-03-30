import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RoutePaneWorkspaceHost from "@/components/workspace/RoutePaneWorkspaceHost";

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

describe("RoutePaneWorkspaceHost", () => {
  beforeEach(() => {
    mockPathname.value = "/settings";
    mockSearch.value = "";
    mockIsMobile.value = false;
  });

  it("renders settings in pane shell with fixed chrome and scrolling body", () => {
    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();

    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    expect(body.contains(chrome)).toBe(false);
    expect(body).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });
  });

  it("uses explicit desktop pane width instead of full-width flex sizing", () => {
    render(<RoutePaneWorkspaceHost />);

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

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByText("Integrations")).toBeInTheDocument();
    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
  });

  it("renders search in pane shell with fixed chrome and scrolling body", () => {
    mockPathname.value = "/search";

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByText("Query")).toBeInTheDocument();

    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    expect(body.contains(chrome)).toBe(false);
    expect(body).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });
  });

  it("uses explicit desktop pane width for search", () => {
    mockPathname.value = "/search";

    render(<RoutePaneWorkspaceHost />);

    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 480px"));
    expect(paneShell).not.toHaveAttribute(
      "style",
      expect.stringContaining("width: 100%")
    );
  });

  it("shows one full-width active search pane on mobile", () => {
    mockPathname.value = "/search";
    mockIsMobile.value = true;

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByText("Query")).toBeInTheDocument();
    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
  });

  it("renders discover in pane shell with fixed chrome and scrolling body", () => {
    mockPathname.value = "/discover";

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByRole("heading", { name: "Discover" })).toBeInTheDocument();
    expect(screen.getByText("Content Lanes")).toBeInTheDocument();

    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    expect(body.contains(chrome)).toBe(false);
    expect(body).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });
  });

  it("uses explicit desktop pane width for discover", () => {
    mockPathname.value = "/discover";

    render(<RoutePaneWorkspaceHost />);

    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 480px"));
    expect(paneShell).not.toHaveAttribute(
      "style",
      expect.stringContaining("width: 100%")
    );
  });

  it("shows one full-width active discover pane on mobile", () => {
    mockPathname.value = "/discover";
    mockIsMobile.value = true;

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByText("Content Lanes")).toBeInTheDocument();
    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
  });

  it("renders conversations in pane shell with fixed chrome and scrolling body", async () => {
    mockPathname.value = "/conversations";

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(
      screen.queryByText("This route is not available in the pane workspace yet.")
    ).not.toBeInTheDocument();

    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    expect(body.contains(chrome)).toBe(false);
    expect(body).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });
  });

  it("uses explicit desktop pane width for conversations", () => {
    mockPathname.value = "/conversations";

    render(<RoutePaneWorkspaceHost />);

    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 560px"));
    expect(paneShell).not.toHaveAttribute(
      "style",
      expect.stringContaining("width: 100%")
    );
  });

  it("shows one full-width active conversations pane on mobile", () => {
    mockPathname.value = "/conversations";
    mockIsMobile.value = true;

    render(<RoutePaneWorkspaceHost />);

    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
    const paneWrap = paneShell?.parentElement as HTMLElement | null;
    expect(paneWrap).toBeTruthy();
    const paneShellWidth = paneShell?.getBoundingClientRect().width ?? 0;
    const paneWrapWidth = paneWrap?.getBoundingClientRect().width ?? 0;
    expect(paneShellWidth).toBeLessThanOrEqual(paneWrapWidth + 0.5);
    const paneStripWidth = screen.getByTestId("pane-strip").getBoundingClientRect().width;
    expect(Math.abs(paneWrapWidth - paneStripWidth)).toBeLessThanOrEqual(0.5);
    expect(screen.getByTestId("conversations-pane-body")).toHaveStyle({ minHeight: "100%" });
  });
});
