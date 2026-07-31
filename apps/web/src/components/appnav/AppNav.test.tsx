import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import AppNav from "./AppNav";
import {
  NEXUS_OPEN_REQUESTED_EVENT,
} from "@/lib/nexus/events";
import type { NexusOpenIntent } from "@/lib/nexus/model";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
  MAX_PANES,
} from "@/lib/workspace/schema";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";

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
  const {
    state,
    closePane,
    pendingPaneEntryDeliveryByPaneId,
  } = useWorkspaceStore();
  const panes = getWorkspacePrimaryPanes(state);
  const active = panes.find(({ id }) => id === state.activePrimaryPaneId);
  return (
    <>
      <output data-testid="workspace-probe" data-pane-count={panes.length}>
        {active?.currentVisit.href}
      </output>
      <output data-testid="workspace-entry-probe">
        {JSON.stringify(
          Array.from(pendingPaneEntryDeliveryByPaneId.values())[0]?.entry ??
            null,
        )}
      </output>
      <button
        type="button"
        onClick={() => {
          const candidate = panes.find(({ id }) => id !== active?.id);
          if (candidate) closePane(candidate.id);
        }}
      >
        Close test pane
      </button>
    </>
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
      <AuthenticatedAccountProvider
        account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
      >
        <FeedbackProvider>
          <KeybindingsProvider>
            <MobileChromeProvider>
            <PaneReturnMementoProvider>
              <WorkspaceStoreProvider
                workspacePrimaryMetrics={workspacePrimaryMetrics}
                initialState={createDefaultWorkspaceState(
                  initialHref,
                  workspacePrimaryMetrics,
                )}
              >
                <AppNav />
                <WorkspaceProbe />
              </WorkspaceStoreProvider>
            </PaneReturnMementoProvider>
            </MobileChromeProvider>
          </KeybindingsProvider>
        </FeedbackProvider>
      </AuthenticatedAccountProvider>,
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
      "Browse",
      "Podcasts",
      "Chats",
      "Notes",
      "Stats",
      "Atlas",
      "Oracle",
    ]);
    expect(screen.queryByText("Library")).not.toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Nexus — Home" })).toHaveAttribute(
      "href",
      "/lectern",
    );

    expect(screen.getByRole("link", { name: "Libraries" })).toHaveAttribute(
      "aria-current",
      "page",
    );
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

  it("follows in place and reactivates an exact existing destination pane", async () => {
    renderNav();

    fireEvent.click(screen.getByRole("link", { name: "Podcasts" }));
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent(
        "/podcasts",
      );
    });
    expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
      "data-pane-count",
      "1",
    );

    fireEvent.click(screen.getByRole("link", { name: "Podcasts" }), {
      detail: 1,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
        "data-pane-count",
        "2",
      );
    });

    fireEvent.click(screen.getByRole("link", { name: "Libraries" }));
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent(
        "/libraries",
      );
    });
    expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
      "data-pane-count",
      "2",
    );
  });

  it("keeps Home and Expand as distinct targets while collapsed", async () => {
    renderNav();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse navigation" }),
    );

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
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent(
        "/lectern",
      );
    });
  });

  it("opens Nexus from the command bar", () => {
    const onOpen = vi.fn();
    window.addEventListener(NEXUS_OPEN_REQUESTED_EVENT, onOpen);
    renderNav();

    fireEvent.click(
      screen.getByRole("button", { name: "Search or ask anything" }),
    );

    expect(onOpen).toHaveBeenCalledTimes(1);
    const detail = (onOpen.mock.calls[0]![0] as CustomEvent<NexusOpenIntent>)
      .detail;
    expect(detail).toEqual({ kind: "Root" });
    window.removeEventListener(NEXUS_OPEN_REQUESTED_EVENT, onOpen);
  });

  it("renders Quick Note then Today between the command bar and Places", async () => {
    renderNav();

    const navigation = screen.getByRole("navigation", { name: "Primary" });
    const daily = within(navigation).getByRole("group", { name: "Daily" });
    expect(within(daily).getAllByRole("button")).toHaveLength(2);
    const quickNote = within(navigation).getByRole("button", {
      name: "Quick Note",
    });
    const today = within(navigation).getByRole("button", { name: "Today" });
    const places = within(navigation).getByRole("link", { name: "Lectern" });

    expect(
      quickNote.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      today.compareDocumentPosition(places) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getComputedStyle(quickNote).minHeight).toBe("48px");
    expect(getComputedStyle(today).minHeight).toBe("48px");

    fireEvent.click(today);
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent(
        "/daily/",
      );
    });
  });

  it("offers an exact-identity Quick Note retry when the desktop rail reaches the pane cap", async () => {
    renderNav();
    const podcasts = screen.getByRole("link", { name: "Podcasts" });
    for (let index = 1; index < MAX_PANES; index += 1) {
      fireEvent.click(podcasts, { detail: 1, shiftKey: true });
    }
    await waitFor(() =>
      expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
        "data-pane-count",
        String(MAX_PANES),
      ),
    );
    const noteId = "11111111-1111-4111-8111-111111111111";
    const clientMutationId = "22222222-2222-4222-8222-222222222222";
    let generated = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      generated += 1;
      if (generated === 1) return noteId;
      if (generated === 2) return clientMutationId;
      return `33333333-3333-4333-8333-${String(generated).padStart(12, "0")}`;
    });

    fireEvent.click(screen.getByRole("button", { name: "Quick Note" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(screen.getByTestId("workspace-entry-probe")).toHaveTextContent(
      "null",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close test pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent(
        /^\/daily\/\d{4}-\d{2}-\d{2}$/,
      ),
    );
    expect(screen.getByTestId("workspace-entry-probe")).toHaveTextContent(
      noteId,
    );
    expect(screen.getByTestId("workspace-entry-probe")).toHaveTextContent(
      clientMutationId,
    );
  });

  it("opens source-first Add from the + button", () => {
    const onOpen = vi.fn();
    window.addEventListener(NEXUS_OPEN_REQUESTED_EVENT, onOpen);
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Add content" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    const detail = (onOpen.mock.calls[0]![0] as CustomEvent<NexusOpenIntent>)
      .detail;
    expect(detail).toEqual({
      kind: "Add",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
      },
    });
    window.removeEventListener(NEXUS_OPEN_REQUESTED_EVENT, onOpen);
  });

  it("opens an account menu with Settings and Sign Out", async () => {
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(
      await screen.findByRole("menuitem", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Sign Out" }),
    ).toBeInTheDocument();
  });

  it("restores the Account trigger after selecting already-active Settings", async () => {
    renderNav({}, "/settings");
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.click(account);

    const settings = await screen.findByRole("menuitem", { name: "Settings" });
    fireEvent.click(settings);

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Settings" }),
      ).not.toBeInTheDocument();
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
      expect(screen.getByTestId("workspace-probe")).toHaveTextContent(
        "/settings",
      );
    });
    expect(account).not.toHaveFocus();
  });

  it("does not restore the Account trigger when Shift-clicking current Settings forks", async () => {
    renderNav({}, "/settings");
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.click(account);

    const settings = await screen.findByRole("menuitem", { name: "Settings" });
    fireEvent.click(settings, { detail: 1, shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
        "data-pane-count",
        "2",
      );
    });
    expect(account).not.toHaveFocus();
  });

  it("restores the Account trigger when pane-cap rejection keeps Settings unchanged", async () => {
    renderNav({}, "/settings");
    const podcasts = screen.getByRole("link", { name: "Podcasts" });
    for (let index = 1; index < MAX_PANES; index += 1) {
      fireEvent.click(podcasts, { detail: 1, shiftKey: true });
    }
    await waitFor(() => {
      expect(screen.getByTestId("workspace-probe")).toHaveAttribute(
        "data-pane-count",
        String(MAX_PANES),
      );
    });

    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.click(account);
    const settings = await screen.findByRole("menuitem", { name: "Settings" });
    fireEvent.click(settings, { detail: 1, shiftKey: true });

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Settings" }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => expect(account).toHaveFocus());
  });

  it("rail ::before has no grain background-image (feTurbulence removed)", () => {
    renderNav();
    const rail = screen.getByRole("navigation", { name: "Primary" });
    const style = getComputedStyle(rail, "::before");
    expect(style.backgroundImage).not.toContain("feTurbulence");
  });
});
