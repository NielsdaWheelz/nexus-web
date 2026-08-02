import { Component, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const { createLink, deleteLink, publish, resolve } = vi.hoisted(() => ({
  createLink: vi.fn(),
  deleteLink: vi.fn(),
  publish: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/lib/resourceGraph/links", () => ({
  createLink,
  deleteLink,
}));

vi.mock("@/components/feedback/Feedback", () => ({
  useFeedback: () => ({ publish, resolve, suppress: vi.fn() }),
}));

vi.mock("@/lib/auth/UnauthenticatedApiBoundary", () => ({
  handleUnauthenticatedApiError: () => false,
}));

import { useLinkComposer } from "./useLinkComposer";

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
      <output aria-label="link boundary">{this.state.error.message}</output>
    ) : (
      this.props.children
    );
  }
}

function Probe() {
  const composer = useLinkComposer({ onLinked: vi.fn() });
  return (
    <>
      <button
        onClick={() =>
          composer.openLink({
            source: { kind: "resource", ref: "media:source" },
            sourceRef: "media:source",
          })
        }
      >
        Open Link
      </button>
      <button
        onClick={() =>
          void composer.confirm(
            { kind: "resource", ref: "media:target" },
            "Target",
          )
        }
      >
        Confirm Link
      </button>
      {composer.failure ? (
        <div role="alert">
          {composer.failure.content.title}
          <button onClick={composer.failure.actions[0].onClick}>
            {composer.failure.actions[0].label}
          </button>
        </div>
      ) : null}
    </>
  );
}

describe("useLinkComposer defect routing", () => {
  beforeEach(() => {
    createLink.mockReset();
    deleteLink.mockReset();
    publish.mockReset();
    resolve.mockReset();
  });

  it("keeps a modeled create failure local with exact Retry", async () => {
    createLink.mockRejectedValue(new ApiError(0, "E_NETWORK", "offline"));
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Link outcome not confirmed",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reuses the frozen client mutation id when create Retry replays", async () => {
    createLink
      .mockRejectedValueOnce(new ApiError(0, "E_NETWORK", "offline"))
      .mockResolvedValueOnce({ created: false, connection: {} });
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));
    await screen.findByRole("alert");
    const firstMutationId = createLink.mock.calls[0]?.[0].clientMutationId;

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(createLink).toHaveBeenCalledTimes(2));

    expect(firstMutationId).toMatch(/^link-/);
    expect(createLink.mock.calls[1]?.[0].clientMutationId).toBe(firstMutationId);
  });

  it("keeps uncertain Undo durable and treats not-found on Retry as resolved", async () => {
    createLink.mockResolvedValue({
      created: true,
      connection: { edge_id: "edge-1" },
    });
    deleteLink
      .mockRejectedValueOnce(new ApiError(0, "E_NETWORK", "response lost", "req-undo"))
      .mockRejectedValueOnce(new ApiError(404, "E_NOT_FOUND", "already absent"));
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    publish.mock.calls[0]?.[0].actions[0].onClick();
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    const persistent = publish.mock.calls[1]?.[0];
    expect(persistent).toMatchObject({
      kind: "Persistent",
      content: { title: "Removal outcome not confirmed" },
    });

    persistent.actions[0].onClick();
    await waitFor(() => expect(deleteLink).toHaveBeenCalledTimes(2));
    expect(resolve).toHaveBeenCalledWith("reader-link-undo:edge-1");
  });

  it("captures an unknown endpoint code and throws it during render", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    createLink.mockRejectedValue(
      new ApiError(409, "E_NEW_LINK_FAILURE", "unknown link failure"),
    );
    try {
      render(
        <TestBoundary>
          <Probe />
        </TestBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open Link" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm Link" }));

      await waitFor(() =>
        expect(screen.getByLabelText("link boundary")).toHaveTextContent(
          "unknown link failure",
        ),
      );
      expect(publish).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
