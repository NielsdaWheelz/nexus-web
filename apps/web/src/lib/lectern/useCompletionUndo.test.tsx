import { Component, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { assumeMediaId } from "@/lib/lectern/contract";

const {
  canonicalInstall,
  lecternResource,
  onCanonicalInstall,
  publish,
  resolve,
  setUnread,
  placeItems,
  undoCompletion,
} = vi.hoisted(() => ({
  canonicalInstall: { listener: null as null | ((event: unknown) => void) },
  lecternResource: {
    current: { status: "loading" } as
      | { status: "loading" }
      | { status: "ready"; data: { items: Array<{ mediaId: string }> } },
  },
  onCanonicalInstall: vi.fn(),
  publish: vi.fn(),
  resolve: vi.fn(),
  setUnread: vi.fn(),
  placeItems: vi.fn(),
  undoCompletion: vi.fn(),
}));

vi.mock("@/components/feedback/Feedback", () => ({
  useFeedback: () => ({ publish, resolve, suppress: vi.fn() }),
}));

vi.mock("@/lib/lectern/LecternProvider", () => ({
  useLectern: () => ({
    resource: lecternResource.current,
    onCanonicalInstall,
    setUnread,
    placeItems,
    undoCompletion,
    getCanonicalSnapshot: () => ({ items: [] }),
  }),
}));

vi.mock("@/lib/auth/UnauthenticatedApiBoundary", () => ({
  handleUnauthenticatedApiError: () => false,
}));

import {
  CompletionUndoFeedbackOwner,
  completionUndoRestoreFeedbackKey,
  useCompletionUndo,
} from "./useCompletionUndo";

class TestBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <output aria-label="completion boundary">{this.state.error.message}</output>
    ) : (
      this.props.children
    );
  }
}

function Probe() {
  const offerUndo = useCompletionUndo();
  return (
    <button
      onClick={() =>
        offerUndo({
          mediaId: assumeMediaId("11111111-1111-4111-8111-111111111111"),
          preCompletionSnapshot: { items: [] },
          completedItemId: null,
          completionHandle: { kind: "Absent" },
        })
      }
    >
      Offer Undo
    </button>
  );
}

describe("useCompletionUndo defect routing", () => {
  beforeEach(() => {
    publish.mockReset();
    resolve.mockReset();
    onCanonicalInstall.mockReset();
    canonicalInstall.listener = null;
    lecternResource.current = { status: "loading" };
    onCanonicalInstall.mockImplementation((listener) => {
      canonicalInstall.listener = listener;
      return () => {
        canonicalInstall.listener = null;
      };
    });
    setUnread.mockReset();
    placeItems.mockReset();
    undoCompletion.mockReset();
  });

  it("publishes one action HUD without caller timing and boundaries an unknown Undo code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    setUnread.mockRejectedValue(
      new ApiError(409, "E_NEW_COMPLETION_FAILURE", "unknown completion failure"),
    );
    try {
      render(
        <TestBoundary>
          <Probe />
        </TestBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Offer Undo" }));

      expect(publish).toHaveBeenCalledOnce();
      const signal = publish.mock.calls[0]?.[0];
      expect(signal).toMatchObject({
        kind: "Hud",
        content: { tone: "Success", title: "Marked as finished" },
        actions: [{ label: "Undo" }],
      });
      expect(signal).not.toHaveProperty("duration");

      await act(async () => signal.actions[0].onClick());
      await waitFor(() =>
        expect(screen.getByLabelText("completion boundary")).toHaveTextContent(
          "unknown completion failure",
        ),
      );
      expect(publish).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resolves stale restore feedback when an external canonical install restores the media", () => {
    const mediaId = assumeMediaId("11111111-1111-4111-8111-111111111111");
    render(<CompletionUndoFeedbackOwner />);

    act(() => {
      canonicalInstall.listener?.({
        kind: "snapshot",
        snapshot: { items: [{ mediaId }] },
        unreadMediaIds: [],
      });
    });

    expect(resolve).toHaveBeenCalledWith(
      completionUndoRestoreFeedbackKey(mediaId),
    );
  });

  it("resolves stale restore feedback already satisfied by the ready resource", () => {
    const mediaId = assumeMediaId("22222222-2222-4222-8222-222222222222");
    lecternResource.current = {
      status: "ready",
      data: { items: [{ mediaId }] },
    };

    render(<CompletionUndoFeedbackOwner />);

    expect(resolve).toHaveBeenCalledWith(
      completionUndoRestoreFeedbackKey(mediaId),
    );
  });
});
