import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";

const routerRefresh = vi.fn<() => void>();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

function stubRouter(): ReturnType<typeof useRouter> {
  return {
    back: vi.fn(),
    forward: vi.fn(),
    refresh: routerRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  };
}

function renderBoundary(children: ReactNode) {
  return render(
    <AuthenticatedWorkspaceErrorBoundary>{children}</AuthenticatedWorkspaceErrorBoundary>,
  );
}

function Bomb(): ReactNode {
  throw new Error("bootstrap failed");
}

beforeEach(() => {
  routerRefresh.mockReset();
  vi.mocked(useRouter).mockReturnValue(stubRouter());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthenticatedWorkspaceErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    renderBoundary(<p>workspace</p>);
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces a crashed subtree with a focused, labelled alert region", async () => {
    renderBoundary(<Bomb />);
    const region = screen.getByRole("alert");
    expect(region).toHaveAccessibleName("The workspace couldn’t load");
    expect(region).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(region).toHaveFocus());
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("retries with a new server request: router.refresh plus boundary reset in one transition", async () => {
    // First render throws; after the boundary resets, the child renders clean —
    // standing in for the refreshed Server Component tree.
    let shouldThrow = true;
    function HealsAfterRefresh(): ReactNode {
      if (shouldThrow) {
        throw new Error("bootstrap failed");
      }
      return <p>workspace</p>;
    }

    renderBoundary(<HealsAfterRefresh />);
    shouldThrow = false;

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("workspace")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches again when the retried subtree still fails", async () => {
    renderBoundary(<Bomb />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("does not catch errors thrown outside its subtree", () => {
    function Outside(): ReactNode {
      throw new Error("outside");
    }
    const [outer] = [
      () =>
        render(
          <>
            <AuthenticatedWorkspaceErrorBoundary>
              <p>inside</p>
            </AuthenticatedWorkspaceErrorBoundary>
            <Outside />
          </>,
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
      routerRefresh.mockImplementation(() => setCrash(false));
      return (
        <AuthenticatedWorkspaceErrorBoundary>
          {crash ? <Bomb /> : <p>restored</p>}
        </AuthenticatedWorkspaceErrorBoundary>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("restored")).toBeInTheDocument();
  });
});
