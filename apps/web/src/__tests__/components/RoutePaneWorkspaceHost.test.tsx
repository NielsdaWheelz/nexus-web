import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("renders /conversations/[id] as adjacent chat and linked-items panes on desktop", () => {
    mockPathname.value = "/conversations/conv-123";
    mockSearch.value =
      "attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line";

    render(<RoutePaneWorkspaceHost />);

    expect(screen.queryByText("This route is not available in the pane workspace yet.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Linked items" })).toBeInTheDocument();

    const paneBodies = screen.getAllByTestId("pane-shell-body");
    expect(paneBodies).toHaveLength(2);
    const paneChromes = screen.getAllByTestId("pane-shell-chrome");
    expect(paneBodies[0]?.contains(paneChromes[0] ?? null)).toBe(false);
    expect(paneBodies[1]?.contains(paneChromes[1] ?? null)).toBe(false);
    expect(paneBodies[1]).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });

    const mainPaneShell = paneBodies[0]?.closest('[data-pane-shell="true"]');
    const linkedPaneShell = paneBodies[1]?.closest('[data-pane-shell="true"]');
    expect(mainPaneShell).toHaveAttribute("style", expect.stringContaining("width: 560px"));
    expect(linkedPaneShell).toHaveAttribute("style", expect.stringContaining("width: 360px"));
    expect(screen.getByText("quoted line")).toBeInTheDocument();
  });

  it("uses global mobile tab switching between chat and linked items for /conversations/[id]", async () => {
    mockPathname.value = "/conversations/conv-123";
    mockSearch.value =
      "attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line";
    mockIsMobile.value = true;
    const user = userEvent.setup();

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Linked items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Context" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open panes" }));
    await user.click(screen.getByRole("button", { name: "Linked items" }));

    expect(screen.getByRole("heading", { name: "Linked items" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-transcript")).not.toBeInTheDocument();
  });

  it("keeps linked items reopenable after closing in mobile pane switcher", async () => {
    mockPathname.value = "/conversations/conv-123";
    mockSearch.value =
      "attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line";
    mockIsMobile.value = true;
    const user = userEvent.setup();

    render(<RoutePaneWorkspaceHost />);

    await user.click(screen.getByRole("button", { name: "Open panes" }));
    expect(screen.getByRole("button", { name: "Linked items" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Linked items" }));
    expect(screen.getByRole("button", { name: "Linked items" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Linked items" }));
    expect(screen.getByRole("heading", { name: "Linked items" })).toBeInTheDocument();
  });

  it("renders libraries in pane shell with fixed chrome and scrolling body", () => {
    mockPathname.value = "/libraries";

    render(<RoutePaneWorkspaceHost />);

    const chrome = screen.getByTestId("pane-shell-chrome");
    expect(within(chrome).getByRole("heading", { name: "Libraries" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("New library name...")).toBeInTheDocument();

    const body = screen.getByTestId("pane-shell-body");
    expect(body.contains(chrome)).toBe(false);
    expect(body).toHaveStyle({ overflowY: "auto", overflowX: "hidden" });
  });

  it("uses explicit desktop pane width for libraries", () => {
    mockPathname.value = "/libraries";

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

  it("shows one full-width active libraries pane on mobile", () => {
    mockPathname.value = "/libraries";
    mockIsMobile.value = true;

    render(<RoutePaneWorkspaceHost />);

    expect(screen.getByPlaceholderText("New library name...")).toBeInTheDocument();
    const paneShell = screen
      .getByTestId("pane-shell-body")
      .closest('[data-pane-shell="true"]');
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("min-width: 100%"));
    expect(paneShell).toHaveAttribute("style", expect.stringContaining("max-width: 100%"));
  });
});
