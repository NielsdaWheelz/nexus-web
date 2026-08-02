import { Component, useCallback, useState, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const {
  confirmAndDeleteMedia,
  onMetadataRetryUnconfirmed,
  publish,
  push,
  retryMediaMetadata,
  runSourceProcessingAction,
} = vi.hoisted(() => ({
  confirmAndDeleteMedia: vi.fn(),
  onMetadataRetryUnconfirmed: vi.fn(),
  publish: vi.fn(),
  push: vi.fn(),
  retryMediaMetadata: vi.fn(),
  runSourceProcessingAction: vi.fn(),
}));

vi.mock("@/lib/media/mediaLibraries", () => ({ confirmAndDeleteMedia }));

vi.mock("@/lib/media/sourceActions", () => ({
  runSourceProcessingAction,
}));

vi.mock("@/lib/media/ingestionClient", () => ({ retryMediaMetadata }));

vi.mock("@/components/feedback/Feedback", () => ({
  useFeedback: () => ({ publish }),
}));

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneRouter: () => ({ push }),
}));

vi.mock("@/lib/auth/UnauthenticatedApiBoundary", () => ({
  handleUnauthenticatedApiError: () => false,
}));

import { useDocumentActions } from "./useDocumentActions";

class TestBoundary extends Component<
  { children: ReactNode },
  { caught: { error: unknown } | null }
> {
  state = { caught: null as { error: unknown } | null };

  static getDerivedStateFromError(error: unknown) {
    return { caught: { error } };
  }

  render() {
    return this.state.caught === null ? (
      this.props.children
    ) : (
      <output aria-label="document action boundary">caught</output>
    );
  }
}

function Probe({
  operation = "Delete",
}: {
  operation?: "Delete" | "Retry" | "RetryMetadata";
}) {
  const [metadataRetryBlocked, setMetadataRetryBlocked] = useState(false);
  const handleMetadataRetryUnconfirmed = useCallback(
    (content: Parameters<typeof onMetadataRetryUnconfirmed>[0]) => {
      onMetadataRetryUnconfirmed(content);
      setMetadataRetryBlocked(true);
    },
    [],
  );
  const actions = useDocumentActions({
    media: {
      id: "media-1",
      title: "Document",
      capabilities: { can_retry: true, can_retry_metadata: true },
    },
    onProcessingRestarted: vi.fn(),
    metadataRetryBlocked,
    onMetadataRetryUnconfirmed: handleMetadataRetryUnconfirmed,
  });
  return (
    <button
      onClick={() =>
        void (operation === "Delete"
          ? actions.handleDelete()
          : operation === "Retry"
            ? actions.handleRetry()
            : actions.handleRetryMetadata())
      }
    >
      {operation}
    </button>
  );
}

function renderProbe(operation?: "Delete" | "Retry" | "RetryMetadata") {
  return render(
    <TestBoundary>
      <Probe operation={operation} />
    </TestBoundary>,
  );
}

describe("useDocumentActions defect routing", () => {
  beforeEach(() => {
    confirmAndDeleteMedia.mockReset();
    onMetadataRetryUnconfirmed.mockReset();
    publish.mockReset();
    push.mockReset();
    retryMediaMetadata.mockReset();
    runSourceProcessingAction.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    [
      "E_RETRY_INVALID_STATE",
      "The source state changed. Review its current status before trying again.",
    ],
    ["E_RETRY_NOT_ALLOWED", "This source can’t be retried. Add a new source instead."],
  ])("keeps modeled source conflict %s local", async (code, message) => {
    runSourceProcessingAction.mockRejectedValue(
      new ApiError(409, code, "modeled conflict", "req-media-action"),
    );
    renderProbe("Retry");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith({
      kind: "Hud",
      key: "media-retry:media-1",
      content: {
        tone: "Danger",
        title: "Processing retry wasn’t started",
        message,
        requestId: "req-media-action",
      },
    });
    expect(screen.queryByLabelText("document action boundary")).toBeNull();
  });

  it("routes an unknown endpoint code to the render boundary", async () => {
    confirmAndDeleteMedia.mockRejectedValue(
      new ApiError(409, "E_NEW_DELETE_CONFLICT", "new contract"),
    );
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByLabelText("document action boundary"),
    ).toBeInTheDocument();
    expect(publish).not.toHaveBeenCalled();
  });

  it("preserves a falsey thrown defect in explicit owner state", async () => {
    confirmAndDeleteMedia.mockRejectedValue(false);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByLabelText("document action boundary"),
    ).toBeInTheDocument();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["E_NETWORK", "E_UPSTREAM_TIMEOUT"])(
    "contains an unconfirmed metadata retry after %s without a duplicate POST",
    async (code) => {
      retryMediaMetadata.mockRejectedValue(
        new ApiError(0, code, "ambiguous response", "req-metadata"),
      );
      renderProbe("RetryMetadata");

      fireEvent.click(screen.getByRole("button", { name: "RetryMetadata" }));

      await vi.waitFor(() =>
        expect(onMetadataRetryUnconfirmed).toHaveBeenCalledWith({
          tone: "Warning",
          title: "Metadata request couldn’t be confirmed",
          message: "Its status is being checked. Don’t start it again yet.",
          requestId: "req-metadata",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "RetryMetadata" }));

      expect(retryMediaMetadata).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
    },
  );
});
