import { describe, expect, it } from "vitest";
import {
  planWorkspaceTargetActivation,
  type WorkspaceTargetActivationPane,
} from "@/lib/workspace/targetActivation";

// Risk: reader chat-launch disposition (spec §5.1, AC-1/AC-2). Oracle: the
// documented disposition contract — a "new chat" launch (Fork) always starts an
// independent pane even when a provisional /conversations/new pane is already
// open, while an existing-chat launch (Adopt) reuses the chosen conversation's
// canonical pane. The reader launch's Fork-vs-Adopt choice is what these gate.

const readerPane: WorkspaceTargetActivationPane = {
  paneId: "reader",
  href: "/media/11111111-1111-4111-8111-111111111111",
  minimized: false,
};
const newChatPane: WorkspaceTargetActivationPane = {
  paneId: "new-chat",
  href: "/conversations/new",
  minimized: false,
};

describe("planWorkspaceTargetActivation — reader chat launch disposition", () => {
  it("Fork creates a new pane even when a matching /conversations/new pane is open (AC-1)", () => {
    const plan = planWorkspaceTargetActivation({
      originPaneId: "reader",
      target: {
        href: "/conversations/new#mediaId=11111111-1111-4111-8111-111111111111&highlightId=22222222-2222-4222-8222-222222222222",
        labelHint: "Chat",
      },
      disposition: { kind: "Fork" },
      panes: [readerPane, newChatPane],
      maxPanes: 6,
    });
    expect(plan).toMatchObject({
      kind: "CreateAfterOrigin",
      originPaneId: "reader",
    });
  });

  it("Adopt would instead reuse the open /conversations/new pane — the behavior the New launch no longer uses", () => {
    const plan = planWorkspaceTargetActivation({
      originPaneId: "reader",
      target: {
        href: "/conversations/new#mediaId=11111111-1111-4111-8111-111111111111&highlightId=22222222-2222-4222-8222-222222222222",
        labelHint: "Chat",
      },
      disposition: { kind: "Adopt" },
      panes: [readerPane, newChatPane],
      maxPanes: 6,
    });
    expect(plan).toMatchObject({
      kind: "NavigateExisting",
      paneId: "new-chat",
    });
  });

  it("Fork at the pane limit rejects with the existing workspace result (AC-1 §5.1)", () => {
    const plan = planWorkspaceTargetActivation({
      originPaneId: "reader",
      target: {
        href: "/conversations/new#mediaId=11111111-1111-4111-8111-111111111111&highlightId=22222222-2222-4222-8222-222222222222",
        labelHint: "Chat",
      },
      disposition: { kind: "Fork" },
      panes: [readerPane, newChatPane],
      maxPanes: 2,
    });
    expect(plan).toEqual({ kind: "Reject", reason: "PaneLimitReached" });
  });

  it("Adopt reuses the chosen conversation's canonical pane (AC-2)", () => {
    const conversationPane: WorkspaceTargetActivationPane = {
      paneId: "chat-c1",
      href: "/conversations/c1",
      minimized: false,
    };
    const plan = planWorkspaceTargetActivation({
      originPaneId: "reader",
      target: {
        href: "/conversations/c1#mediaId=11111111-1111-4111-8111-111111111111&highlightId=22222222-2222-4222-8222-222222222222",
        labelHint: "Chat",
      },
      disposition: { kind: "Adopt" },
      panes: [readerPane, conversationPane],
      maxPanes: 6,
    });
    expect(plan).toMatchObject({ kind: "NavigateExisting", paneId: "chat-c1" });
  });

  it("Adopt opens a pane for a chosen conversation that has none, without duplicating one (AC-2)", () => {
    const plan = planWorkspaceTargetActivation({
      originPaneId: "reader",
      target: {
        href: "/conversations/c9#mediaId=11111111-1111-4111-8111-111111111111&highlightId=22222222-2222-4222-8222-222222222222",
        labelHint: "Chat",
      },
      disposition: { kind: "Adopt" },
      panes: [readerPane, newChatPane],
      maxPanes: 6,
    });
    expect(plan).toMatchObject({
      kind: "CreateAfterOrigin",
      originPaneId: "reader",
    });
  });
});
