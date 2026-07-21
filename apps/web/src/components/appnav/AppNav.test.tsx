import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import AppNav from "./AppNav";
import { OPEN_LAUNCHER_EVENT, type OpenLauncherDetail } from "@/lib/launcher/launcherEvents";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
} from "@/lib/workspace/schema";
import { useWorkspaceStore, WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const COLLAPSE_KEY = "nexus.nav.collapsed";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function mockMatchMedia(matchesMobile: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width") ? matchesMobile : false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList,
  );
}

function WorkspaceProbe() {
  const { state } = useWorkspaceStore();
  const panes = getWorkspacePrimaryPanes(state);
  const active = panes.find(({ id }) => id === state.activePrimaryPaneId);
  return (
    <output data-testid="workspace-probe" data-pane-count={panes.length}>
      {active?.href}
    </output>
  );
}

// Seed the real workspace store so the single active pane sits on /libraries —
// the same fixture the old internal store mock hard-coded.
function renderNav(
  renderEnvironment: Partial<RenderEnvironment> = {},
  initialHref = "/libraries",
): RenderResult {
  return render(
    withRenderEnvironment(
      <KeybindingsProvider>
        <MobileChromeProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={workspacePrimaryMetrics}
            initialState={createDefaultWorkspaceState(initialHref, workspacePrimaryMetrics)}
          >
            <AppNav />
            <WorkspaceProbe />
          </WorkspaceStoreProvider>
        </MobileChromeProvider>
      </KeybindingsProvider>,
      renderEnvironment,
    ),
  );
}

describe("AppNav (desktop rail)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("innerWidth", 1280); // desktop surface drives useIsMobileViewport=false
    mockMatchMedia(false);
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the one flat destination order and marks the active one", () => {
    renderNav();

    const navigation = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual([
      "Nexus — Home",
      "Lectern",
      "Libraries",
      "Podcasts",
      "Chats",
      "Notes",
      "Atlas",
      "Oracle",
    ]);
    expect(screen.queryByText("Library")).not.toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Nexus — Home" })).toHaveAttribute(
      "href",
      "/lectern",
    );

    expect(screen.getByRole("link", { name: "Libraries" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Oracle" })).toHaveAttribute(
      "data-presentation",
      "accent",
    );
  });

  it("keeps Libraries visibly active while reading media", () => {
    renderNav({}, "/media/11111111-1111-4111-8111-111111111111");

    expect(screen.getByRole("link", { name: "Libraries" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("reactivates an exact existing destination pane instead of duplicating it", async () => {
    renderNav();

    fireEvent.click(screen.getByRole("link", { name: "Podcasts" }));
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent("/podcasts");
    });
    expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
      "data-pane-count",
      "2",
    );

    fireEvent.click(screen.getByRole("link", { name: "Libraries" }));
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent("/libraries");
    });
    expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
      "data-pane-count",
      "2",
    );
  });

  it("keeps Home and Expand as distinct targets while collapsed", async () => {
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

    expect(localStorage.getItem(COLLAPSE_KEY)).toBe("1");
    const expand = screen.getByRole("button", { name: "Expand navigation" });
    expect(expand).toBeInTheDocument();
    expect(getComputedStyle(expand).position).toBe("static");
    // Visible labels are hidden when collapsed, but the accessible name must survive.
    expect(screen.getByRole("link", { name: "Libraries" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Oracle" })).toBeInTheDocument();
    // Same for the brand: the "Nexus" wordmark is CSS-hidden (not unmounted),
    // yet the brand link keeps its accessible name.
    expect(screen.getByText("Nexus")).not.toBeVisible();
    const home = screen.getByRole("link", { name: "Nexus — Home" });
    expect(home).toBeInTheDocument();
    expect(getComputedStyle(home).pointerEvents).not.toBe("none");

    fireEvent.click(home);
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent("/lectern");
    });
  });

  it("opens the launcher from the command bar (no lane seed)", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_LAUNCHER_EVENT, onOpen);
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Search or ask anything" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const detail = (onOpen.mock.calls[0]![0] as CustomEvent<OpenLauncherDetail>).detail;
    // The plain command button opens the blended launcher — it must not seed a lane.
    expect(detail?.lane).toBeUndefined();
    window.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen);
  });

  it("opens the launcher on the add lane from the + button", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_LAUNCHER_EVENT, onOpen);
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Add content" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const detail = (onOpen.mock.calls[0]![0] as CustomEvent<OpenLauncherDetail>).detail;
    expect(detail?.lane).toBe("add");
    window.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen);
  });

  it("opens an account menu with Settings and Sign Out", async () => {
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeInTheDocument();
  });

  it("restores the Account trigger after selecting already-active Settings", async () => {
    renderNav({}, "/settings");
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.click(account);

    const settings = await screen.findByRole("menuitem", { name: "Settings" });
    fireEvent.click(settings);

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
    });
    await waitFor(() => expect(account).toHaveFocus());
  });

  it("does not restore the Account trigger when Settings opens another pane", async () => {
    renderNav();
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.click(account);

    const settings = await screen.findByRole("menuitem", { name: "Settings" });
    settings.focus();
    fireEvent.click(settings);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent("/settings");
    });
    expect(account).not.toHaveFocus();
  });

  it("rail ::before has no grain background-image (feTurbulence removed)", () => {
    renderNav();
    const rail = screen.getByRole("navigation", { name: "Primary" });
    const style = getComputedStyle(rail, "::before");
    expect(style.backgroundImage).not.toContain("feTurbulence");
  });
});

describe("AppNav (mobile sheet)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("innerWidth", 390); // mobile viewport drives useIsMobileViewport=true
    mockMatchMedia(true);
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hands focus to the launcher when its event closes an open NavSheet", async () => {
    renderNav({ initialViewport: "mobile" });

    // Open the sheet via the mobile top-bar brand button.
    const opener = screen.getByRole("button", { name: "Open navigation" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    const launcherFocusTarget = document.createElement("button");
    document.body.append(launcherFocusTarget);
    launcherFocusTarget.focus();

    // The sheet owns this handoff: it closes without restoring its opener, so
    // the launcher can retain focus instead of stacking or losing focus.
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_LAUNCHER_EVENT));
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument(),
    );
    expect(launcherFocusTarget).toHaveFocus();
    launcherFocusTarget.remove();
  });

  it("projects the same ordered destinations as the desktop rail", () => {
    renderNav({ initialViewport: "mobile" });
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const sheet = screen.getByRole("dialog", { name: "Navigation" });
    expect(
      within(sheet)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim()),
    ).toEqual([
      "Nexus",
      "Lectern",
      "Libraries",
      "Podcasts",
      "Chats",
      "Notes",
      "Atlas",
      "Oracle",
      "Settings",
    ]);
    expect(within(sheet).getByRole("link", { name: "Oracle" })).toHaveAttribute(
      "data-presentation",
      "accent",
    );
  });

  it("restores the mobile opener after selecting the already-active destination", async () => {
    renderNav({ initialViewport: "mobile" });
    const opener = screen.getByRole("button", { name: "Open navigation" });
    opener.focus();
    fireEvent.click(opener);

    const activeDestination = screen.getByRole("link", { name: "Libraries" });
    expect(activeDestination).toHaveAttribute("aria-current", "page");
    fireEvent.click(activeDestination);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    });
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
