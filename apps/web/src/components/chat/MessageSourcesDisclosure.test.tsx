import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as renderBase, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import MessageSourcesDisclosure from "./MessageSourcesDisclosure";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const activateWorkspaceTarget = vi.fn(() => ({ kind: "CreatedPane" as const, paneId: "pane-2" }));

function render(node: React.ReactNode) {
  return renderBase(
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <PaneRuntimeProvider
          paneId="pane-1"
          visitId={assumePaneVisitId("00000000-0000-4000-8000-000000000001")}
          isActive
          href="/conversations/conversation-1"
          routeId="conversation"
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={activateWorkspaceTarget}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          {node}
        </PaneRuntimeProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>,
  );
}

function makeActivation(href: string): ResourceActivation {
  return {
    resourceRef: "media:11111111-1111-4111-8111-111111111111",
    kind: "route",
    href,
    unresolvedReason: null,
  };
}

function makeCitation(overrides: Partial<ReaderCitationData> = {}): ReaderCitationData {
  return {
    index: 1,
    preview: { title: "Source title", meta: ["Section label"] },
    activation: makeActivation("/media/media-1"),
    target: null,
    ...overrides,
  };
}

describe("MessageSourcesDisclosure", () => {
  beforeEach(() => {
    activateWorkspaceTarget.mockClear();
  });
  it("renders nothing when citations array is empty", () => {
    render(<MessageSourcesDisclosure citations={[]} />);
    expect(screen.queryByRole("list", { name: "Sources" })).toBeNull();
  });

  it("renders an ordered list with aria-label Sources (AC-4)", () => {
    render(
      <MessageSourcesDisclosure
        citations={[makeCitation()]}
      />,
    );
    expect(screen.getByRole("list", { name: "Sources" })).toBeInTheDocument();
  });

  it("renders citation title in the list entry (AC-4)", () => {
    render(
      <MessageSourcesDisclosure
        citations={[makeCitation({ preview: { title: "My Source" } })]}
      />,
    );
    expect(screen.getByText("My Source")).toBeInTheDocument();
  });

  it("renders section label when present", () => {
    render(
      <MessageSourcesDisclosure
        citations={[
          makeCitation({ preview: { title: "Book", meta: ["Chapter 3"] } }),
        ]}
      />,
    );
    expect(screen.getByText(/Chapter 3/)).toBeInTheDocument();
  });

  it("clicking an entry calls onCitationActivate with correct activation and target (AC-8)", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    const activation = makeActivation("/media/media-1");
    render(
      <MessageSourcesDisclosure
        citations={[makeCitation({ activation })]}
        onCitationActivate={onActivate}
      />,
    );

    await user.click(screen.getByText("Sources (1)"));
    await user.click(screen.getByRole("link", { name: /1\. Source title/ }));

    expect(onActivate).toHaveBeenCalledWith(activation, null, expect.anything());
    expect(onActivate).toHaveBeenCalledOnce();
    expect(activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
        target: { href: "/media/media-1" },
      disposition: { kind: "Follow" },
      modality: "Programmatic",
    });
  });

  it("forks a Shift-pointer rich source exactly once", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<MessageSourcesDisclosure citations={[makeCitation()]} onCitationActivate={onActivate} />);

    await user.click(screen.getByText("Sources (1)"));
    fireEvent.click(screen.getByRole("link", { name: /1\. Source title/ }), {
      shiftKey: true,
      detail: 1,
    });

    expect(activateWorkspaceTarget).toHaveBeenCalledOnce();
    expect(activateWorkspaceTarget).toHaveBeenCalledWith(expect.objectContaining({
      disposition: { kind: "Fork" },
    }));
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("keeps Shift-keyboard rich source activation as Follow", async () => {
    const user = userEvent.setup();
    render(<MessageSourcesDisclosure citations={[makeCitation()]} />);

    await user.click(screen.getByText("Sources (1)"));
    fireEvent.click(screen.getByRole("link", { name: /1\. Source title/ }), {
      shiftKey: true,
      detail: 0,
    });

    expect(activateWorkspaceTarget).toHaveBeenCalledWith(expect.objectContaining({
      disposition: { kind: "Follow" },
      modality: "Programmatic",
    }));
  });

  it("renders multiple citations as separate list items", () => {
    render(
      <MessageSourcesDisclosure
        citations={[
          makeCitation({ index: 1, preview: { title: "First" } }),
          makeCitation({ index: 2, preview: { title: "Second" } }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("renders a button when only activationTarget (no href) (AC-8)", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();

    const target: ReaderSourceTarget = {
      kind: "media",
      source: "message_retrieval",
      media_id: "media-1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "frag-1",
        start_offset: 0,
        end_offset: 10,
      },
      snippet: null,
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      href: null,
      evidence_span_id: null,
    };
    const activation: ResourceActivation = {
      resourceRef: "media:media-1",
      kind: "none",
      href: null,
      unresolvedReason: "no-route",
    };

    render(
      <MessageSourcesDisclosure
        citations={[makeCitation({ activation, target })]}
        onCitationActivate={onActivate}
      />,
    );

    await user.click(screen.getByText("Sources (1)"));
    await user.click(screen.getByRole("button", { name: /1\. Source title/ }));
    expect(onActivate).toHaveBeenCalledWith(
      activation,
      expect.objectContaining({ kind: "media", media_id: "media-1" }),
      expect.anything(),
    );
  });

  it("uses a closed native Sources (N) disclosure", () => {
    render(<MessageSourcesDisclosure citations={[makeCitation(), makeCitation({ index: 2 })]} />);
    // eslint-disable-next-line testing-library/no-node-access -- asserts the native disclosure's default closed state
    const disclosure = screen.getByText("Sources (2)").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    // eslint-disable-next-line testing-library/no-node-access -- verifies the native summary element, not a custom button facade
    expect(screen.getByText("Sources (2)").closest("summary")).not.toBeNull();
  });

  it.each([
    ["external", makeActivation("https://example.com/source")],
    ["unsupported", makeActivation("/api/podcasts/export/opml")],
  ])("leaves a %s source native with no workspace activation", async (_kind, activation) => {
    const user = userEvent.setup();
    let browserOwned = false;
    const recordBrowserOwnership = (event: MouseEvent) => {
      browserOwned = !event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", recordBrowserOwnership);
    try {
      render(<MessageSourcesDisclosure citations={[makeCitation({ activation })]} />);
      await user.click(screen.getByText("Sources (1)"));
      fireEvent.click(screen.getByRole("link", { name: /1\. Source title/ }));
    } finally {
      document.removeEventListener("click", recordBrowserOwnership);
    }

    expect(browserOwned).toBe(true);
    expect(activateWorkspaceTarget).not.toHaveBeenCalled();
  });
});
