import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";

function stubRouter(overrides: Partial<AppRouterInstance> = {}): AppRouterInstance {
  return {
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    ...overrides,
  } as AppRouterInstance;
}

function renderBoundary(children: ReactNode, router: AppRouterInstance) {
  return render(
    <AppRouterContext.Provider value={router}>
      <AuthenticatedWorkspaceErrorBoundary>{children}</AuthenticatedWorkspaceErrorBoundary>
    </AppRouterContext.Provider>,
  );
}

function Bomb(): ReactNode {
  throw new Error("bootstrap failed");
}

describe("AuthenticatedWorkspaceErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when nothing throws", () => {
    renderBoundary(<p>workspace</p>, stubRouter());
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces a crashed subtree with a focused, labelled alert region", async () => {
    renderBoundary(<Bomb />, stubRouter());
    const region = screen.getByRole("alert");
    expect(region).toHaveAccessibleName("The workspace couldn’t load");
    expect(region).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(region).toHaveFocus());
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("retries with a new server request: router.refresh plus boundary reset in one transition", async () => {
    const router = stubRouter();

    // First render throws; after the boundary resets, the child renders clean —
    // standing in for the refreshed Server Component tree.
    let shouldThrow = true;
    function HealsAfterRefresh(): ReactNode {
      if (shouldThrow) {
        throw new Error("bootstrap failed");
      }
      return <p>workspace</p>;
    }

    renderBoundary(<HealsAfterRefresh />, router);
    shouldThrow = false;

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("workspace")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches again when the retried subtree still fails", async () => {
    const router = stubRouter();
    renderBoundary(<Bomb />, router);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("does not catch errors thrown outside its subtree", () => {
    function Outside(): ReactNode {
      throw new Error("outside");
    }
    const [outer] = [
      () =>
        render(
          <AppRouterContext.Provider value={stubRouter()}>
            <>
              <AuthenticatedWorkspaceErrorBoundary>
                <p>inside</p>
              </AuthenticatedWorkspaceErrorBoundary>
              <Outside />
            </>
          </AppRouterContext.Provider>,
        ),
    ];
    expect(outer).toThrow("outside");
  });
});

// The boundary must reset via state, not remount-by-key: a key change would
// also discard workspace state below it. This exercises reset directly.
describe("reset contract", () => {
  it("clears hasError through onReset and re-renders children", async () => {
    function Harness() {
      const [crash, setCrash] = useState(true);
      return (
        <AppRouterContext.Provider
          value={stubRouter({
            refresh: () => {
              setCrash(false);
            },
          })}
        >
          <AuthenticatedWorkspaceErrorBoundary>
            {crash ? <Bomb /> : <p>restored</p>}
          </AuthenticatedWorkspaceErrorBoundary>
        </AppRouterContext.Provider>
      );
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("restored")).toBeInTheDocument();
  });
});
