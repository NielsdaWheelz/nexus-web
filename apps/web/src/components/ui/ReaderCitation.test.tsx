import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ReaderCitation from "@/components/ui/ReaderCitation";
import type { ReaderCitationPreview } from "@/lib/conversations/readerCitation";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import type {
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { Component } from "react";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";

const activateWorkspaceTarget =
  vi.fn<
    NonNullable<
      ComponentProps<typeof PaneRuntimeProvider>["onActivateWorkspaceTarget"]
    >
  >(() => ({
    kind: "CreatedPane" as const,
    paneId: "pane-2",
  }));

class ReaderCitationBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <p role="alert">Citation defect reached boundary</p>
    );
  }
}

function renderCitation(
  preview: ReaderCitationPreview,
  options: {
    activation?: ResourceActivation;
    target?: ReaderSourceTarget | null;
    onActivate?: (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: ReactMouseEvent,
    ) => void;
  } = {},
) {
  const onActivate = options.onActivate ?? vi.fn();
  const view = render(
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <PaneRuntimeProvider
          paneId="pane-1"
          visitId={assumePaneVisitId("00000000-0000-4000-8000-000000000001")}
          isActive
          href="/libraries"
          routeId="libraries"
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={activateWorkspaceTarget}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          <ReaderCitationBoundary>
            <ReaderCitation
              index={1}
              preview={preview}
              activation={
                options.activation ?? {
                  resourceRef: "media:media-1",
                  kind: "route",
                  href: "/media/media-1",
                  unresolvedReason: null,
                }
              }
              target={options.target ?? null}
              onActivate={onActivate}
            />
          </ReaderCitationBoundary>
        </PaneRuntimeProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>,
  );
  return { ...view, onActivate };
}

describe("ReaderCitation summary abstract", () => {
  beforeEach(() => {
    activateWorkspaceTarget.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("owns an internal rich click with one workspace activation and one pulse callback", () => {
    const { onActivate } = renderCitation({ title: "Source title" });

    fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }));

    expect(activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/media/media-1" },
      disposition: { kind: "Follow" },
      modality: "Programmatic",
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("preserves pointer Shift as a sibling-pane activation", () => {
    const { onActivate } = renderCitation({ title: "Source title" });

    fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }), {
      detail: 1,
      shiftKey: true,
    });

    expect(activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/media/media-1" },
      disposition: { kind: "Fork" },
      modality: "Programmatic",
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("delegates to its activation owner when no pane runtime is available", () => {
    const onActivate = vi.fn(
      (
        _activation: ResourceActivation,
        _target: ReaderSourceTarget | null,
        event?: ReactMouseEvent,
      ) => event?.preventDefault(),
    );
    render(
      <FeedbackProvider>
        <ReaderCitation
          index={1}
          preview={{ title: "Source title" }}
          activation={{
            resourceRef: "media:media-1",
            kind: "route",
            href: "/media/media-1",
            unresolvedReason: null,
          }}
          target={null}
          onActivate={onActivate}
        />
      </FeedbackProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }), {
      detail: 1,
      shiftKey: true,
    });

    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("opens an artifact revision on its canonical standalone route", () => {
    const revisionRef =
      "artifact_revision:44444444-4444-4444-8444-444444444444";
    const href =
      `/artifacts/${encodeURIComponent("artifact:55555555-5555-4555-8555-555555555555")}` +
      `?revision=${encodeURIComponent(revisionRef)}`;
    renderCitation(
      { title: "Revision source" },
      {
        activation: {
          resourceRef: revisionRef,
          kind: "route",
          href,
          unresolvedReason: null,
        },
      },
    );

    fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }));

    expect(activateWorkspaceTarget).toHaveBeenCalledOnce();
    const activation = activateWorkspaceTarget.mock.calls[0]?.[0];
    expect(activation?.target).toEqual({ href });
    expect(activation?.target).not.toHaveProperty("secondaryActivation");
  });

  it.each([
    ["external", "https://example.com/source"],
    ["unsupported", "/api/podcasts/export/opml"],
  ])(
    "leaves a %s citation native with no workspace activation",
    (_kind, href) => {
      let browserOwned = false;
      const recordBrowserOwnership = (event: MouseEvent) => {
        browserOwned = !event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener("click", recordBrowserOwnership);
      try {
        renderCitation(
          { title: "Native source" },
          {
            activation: {
              resourceRef: "media:media-1",
              kind: "route",
              href,
              unresolvedReason: null,
            },
          },
        );
        fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }));
      } finally {
        document.removeEventListener("click", recordBrowserOwnership);
      }

      expect(browserOwned).toBe(true);
      expect(activateWorkspaceTarget).not.toHaveBeenCalled();
    },
  );
  it("shows the per-media summary abstract on hover when present", async () => {
    const user = userEvent.setup();
    renderCitation({
      title: "Source title",
      summary: "A concise per-media abstract.",
      excerpt: "matched source text",
    });

    await user.hover(screen.getByRole("link", { name: "Open citation 1" }));

    await waitFor(() => {
      expect(
        screen.getByText("A concise per-media abstract."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("matched source text")).toBeInTheDocument();
  });

  it("renders nothing for the abstract when summary is absent", async () => {
    const user = userEvent.setup();
    renderCitation({
      title: "Source title",
      excerpt: "matched source text",
    });

    await user.hover(screen.getByRole("link", { name: "Open citation 1" }));

    await waitFor(() => {
      expect(screen.getByText("matched source text")).toBeInTheDocument();
    });
    expect(screen.queryByText(/abstract/i)).not.toBeInTheDocument();
  });

  it("keeps finite clipboard failure inline with exact retry ownership", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    renderCitation({ title: "Source title", copyText: "Citation text" });

    await user.hover(screen.getByRole("link", { name: "Open citation 1" }));
    await user.click(await screen.findByRole("button", { name: "Copy citation" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Citation wasn’t copied");
    expect(screen.getByLabelText("HUD feedback")).toBeEmptyDOMElement();
    expect(
      screen.getByLabelText("Detached feedback announcements"),
    ).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Copy citation" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByLabelText("HUD feedback")).toHaveTextContent(
        "Citation copied",
      ),
    );
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("routes an unknown clipboard defect through the render boundary", async () => {
    const user = userEvent.setup();
    const defect = new TypeError("unexpected clipboard defect");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(defect);
    const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
    renderCitation({ title: "Source title", copyText: "Citation text" });

    await user.hover(screen.getByRole("link", { name: "Open citation 1" }));
    await user.click(await screen.findByRole("button", { name: "Copy citation" }));

    expect(await screen.findByText("Citation defect reached boundary")).toBeVisible();
    expect(screen.queryByText("Citation wasn’t copied")).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });
});
