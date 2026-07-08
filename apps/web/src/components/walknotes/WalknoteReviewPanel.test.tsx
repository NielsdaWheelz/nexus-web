import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WalknoteReviewPanel from "./WalknoteReviewPanel";
import {
  WalknoteSessionProvider,
  useWalknoteSession,
  type WalknoteWaypoint,
} from "@/lib/walknotes/walknoteSession";

// Stub sessionStorage so Provider can initialize without crashing
function makeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
  };
}

// Stub history for MobileSheet/useDialogOverlay which may push state
let fakeState: unknown = null;

function Harness({
  initialWaypoints = [],
  onClose = () => {},
}: {
  initialWaypoints?: WalknoteWaypoint[];
  onClose?: () => void;
}) {
  const { addWaypoint } = useWalknoteSession();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const id = addWaypoint("media-1", 30_000);
          return id;
        }}
      >
        Add waypoint
      </button>
      <button
        type="button"
        onClick={() => {
          // initialWaypoints are pre-seeded by the provider during render
          void initialWaypoints;
        }}
      >
        Seed
      </button>
      <WalknoteReviewPanel onClose={onClose} />
    </>
  );
}

function renderWithProvider(
  ui: React.ReactElement,
) {
  vi.spyOn(history, "pushState").mockImplementation((state) => {
    fakeState = state;
  });
  vi.spyOn(history, "replaceState").mockImplementation((state) => {
    fakeState = state;
  });
  vi.spyOn(history, "back").mockImplementation(() => {
    fakeState = null;
  });
  vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);

  return render(<WalknoteSessionProvider>{ui}</WalknoteSessionProvider>);
}

describe("WalknoteReviewPanel", () => {
  beforeEach(() => {
    fakeState = null;
    vi.stubGlobal("sessionStorage", makeSessionStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.overflow = "";
  });

  it("renders empty state when no waypoints", () => {
    const onClose = vi.fn();
    renderWithProvider(<WalknoteReviewPanel onClose={onClose} />);

    expect(screen.getByText("No waypoints in this session.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard all waypoints" })).toBeInTheDocument();
  });

  it("shows added waypoints with formatted timestamp", async () => {
    const onClose = vi.fn();
    renderWithProvider(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Add waypoint" }));

    await waitFor(() => {
      // 30_000 ms = 0:00:30
      expect(screen.getByText("00:00:30")).toBeInTheDocument();
    });
  });

  it("lists tap-only waypoints with (tap only) label", async () => {
    const onClose = vi.fn();
    renderWithProvider(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Add waypoint" }));

    await waitFor(() => {
      expect(screen.getByText("(tap only)")).toBeInTheDocument();
    });
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    renderWithProvider(<WalknoteReviewPanel onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close waypoints panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keep/discard toggle changes button label", async () => {
    const onClose = vi.fn();
    renderWithProvider(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Add waypoint" }));

    // Wait for the waypoint to appear
    const discardButton = await screen.findByRole("button", { name: /Discard waypoint/ });
    expect(discardButton).toBeInTheDocument();

    fireEvent.click(discardButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Keep waypoint/ })).toBeInTheDocument();
    });

    // Toggle back
    fireEvent.click(screen.getByRole("button", { name: /Keep waypoint/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Discard waypoint/ })).toBeInTheDocument();
    });
  });

  it("Discard all clears session and calls onClose", async () => {
    const onClose = vi.fn();
    renderWithProvider(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Add waypoint" }));
    await screen.findByText("(tap only)");

    fireEvent.click(screen.getByRole("button", { name: "Discard all waypoints" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Materialize button is disabled when all waypoints are discarded", async () => {
    const onClose = vi.fn();
    renderWithProvider(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Add waypoint" }));

    const discardButton = await screen.findByRole("button", { name: /Discard waypoint/ });
    fireEvent.click(discardButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Materialize/ })).toBeDisabled();
    });
  });
});
