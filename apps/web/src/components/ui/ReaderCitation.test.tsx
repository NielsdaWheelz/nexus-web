import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ReaderCitation from "@/components/ui/ReaderCitation";
import type { ReaderCitationPreview } from "@/lib/conversations/readerCitation";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";

const activateWorkspaceTarget = vi.fn(() => ({ kind: "CreatedPane" as const, paneId: "pane-2" }));

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
    <PaneReturnMementoProvider><FeedbackProvider><PaneRuntimeProvider
      paneId="pane-1" visitId={assumePaneVisitId("00000000-0000-4000-8000-000000000001")}
      isActive href="/libraries" routeId="libraries" canGoBack={false} canGoForward={false}
      onNavigatePane={vi.fn()} onReplacePane={vi.fn()} onActivateWorkspaceTarget={activateWorkspaceTarget}
      onGoBackPane={vi.fn()} onGoForwardPane={vi.fn()}
    ><ReaderCitation
      index={1}
      preview={preview}
      activation={options.activation ?? {
        resourceRef: "media:media-1",
        kind: "route",
        href: "/media/media-1",
        unresolvedReason: null,
      }}
      target={options.target ?? null}
      onActivate={onActivate}
    /></PaneRuntimeProvider></FeedbackProvider></PaneReturnMementoProvider>,
  );
  return { ...view, onActivate };
}

describe("ReaderCitation summary abstract", () => {
  beforeEach(() => {
    activateWorkspaceTarget.mockClear();
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

  it("carries an artifact revision dossier activation once", () => {
    renderCitation(
      { title: "Revision source" },
      {
        activation: {
          resourceRef: "artifact_revision:44444444-4444-4444-8444-444444444444",
          kind: "route",
          href: "/notes/note-1",
          unresolvedReason: null,
        },
      },
    );

    fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }));

    expect(activateWorkspaceTarget).toHaveBeenCalledOnce();
    expect(activateWorkspaceTarget).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        href: "/notes/note-1",
        secondaryActivation: {
          kind: "DossierRevision",
          surfaceId: "resource-dossier",
          revisionRef: "artifact_revision:44444444-4444-4444-8444-444444444444",
        },
      },
    }));
  });

  it.each([
    ["external", "https://example.com/source"],
    ["unsupported", "/api/podcasts/export/opml"],
  ])("leaves a %s citation native with no workspace activation", (_kind, href) => {
    let browserOwned = false;
    const recordBrowserOwnership = (event: MouseEvent) => {
      browserOwned = !event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", recordBrowserOwnership);
    try {
      renderCitation({ title: "Native source" }, {
        activation: {
          resourceRef: "media:media-1",
          kind: "route",
          href,
          unresolvedReason: null,
        },
      });
      fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }));
    } finally {
      document.removeEventListener("click", recordBrowserOwnership);
    }

    expect(browserOwned).toBe(true);
    expect(activateWorkspaceTarget).not.toHaveBeenCalled();
  });
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
});
