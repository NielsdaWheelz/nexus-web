import { afterEach, describe, expect, it, vi } from "vitest";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import {
  dispatchNexusTarget,
  materializeNexusTarget,
  PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
  type NexusDispatchCtx,
} from "./dispatch";
import type { NexusTarget } from "./model";

function context(input?: {
  result?: WorkspaceTargetActivationResult;
}): NexusDispatchCtx & {
  activateWorkspaceTarget: ReturnType<typeof vi.fn>;
} {
  return {
    androidShell: false,
    feedback: { show: vi.fn() } as never,
    activePaneId: "pane-origin",
    activateWorkspaceTarget: vi.fn(
      (_request: WorkspaceTargetActivationRequest) =>
        input?.result ??
        ({ kind: "CreatedPane", paneId: "pane-created" } as const),
    ),
    placeItems: vi.fn(),
    panes: [
      {
        id: "pane-a",
        href: "/libraries",
        label: "Libraries",
        visibility: "visible",
      },
    ],
    activatePane: vi.fn(),
    restorePane: vi.fn(),
    closePane: vi.fn(),
    requestPaneSearch: vi.fn(() => false),
    openShare: vi.fn(),
    openDailyPage: vi.fn((target, _activation) => ({
      localDate:
        target.date.kind === "LocalDate" ? target.date.value : "2026-07-30",
      activationId: "daily-activation",
      activation:
        input?.result ??
        ({ kind: "CreatedPane", paneId: "pane-created" } as const),
    })),
    shareOptions: () => ({
      returnFocusTo: () => null,
      returnFocusFallback: { kind: "Absent" },
    }),
    resumeCurrentPlayback: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Nexus dispatch", () => {
  it("carries Follow and Fork through internal and exact-pane activation", async () => {
    const ctx = context();
    await dispatchNexusTarget(
      {
        kind: "InternalHref",
        href: "/notes",
        labelHint: "Notes",
      },
      ctx,
      { disposition: { kind: "Follow" }, modality: "Keyboard" },
    );
    await dispatchNexusTarget(
      { kind: "PaneOpen", paneId: "pane-a" },
      ctx,
      { disposition: { kind: "Fork" }, modality: "Pointer" },
    );

    expect(ctx.activateWorkspaceTarget).toHaveBeenNthCalledWith(1, {
      originPaneId: "pane-origin",
      target: { href: "/notes", labelHint: "Notes" },
      disposition: { kind: "Follow" },
      modality: "Keyboard",
    });
    expect(ctx.activateWorkspaceTarget).toHaveBeenNthCalledWith(2, {
      originPaneId: "pane-origin",
      target: { href: "/libraries", labelHint: "Libraries" },
      disposition: { kind: "Fork" },
      modality: "Pointer",
    });
  });

  it("retains the exact rejected target for pane-cap recovery", async () => {
    const ctx = context({
      result: { kind: "Rejected", reason: "PaneLimitReached" },
    });
    await expect(
      dispatchNexusTarget(
        {
          kind: "InternalHref",
          href: "/libraries",
          labelHint: "Libraries",
        },
        ctx,
        { disposition: { kind: "Adopt" }, modality: "Programmatic" },
      ),
    ).resolves.toEqual({
      kind: "NavigationRejected",
      reason: "PaneLimitReached",
      target: {
        kind: "InternalHref",
        href: "/libraries",
        labelHint: "Libraries",
      },
    });
  });

  it("preserves captured Follow and Fork for desktop resource Chat", async () => {
    const ref = assumeCanonicalResourceRef(`media:11111111-1111-4111-8111-111111111111`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { id: "conversation-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const ctx = context();
    await dispatchNexusTarget(
      { kind: "ResourceChat", ref },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
    await dispatchNexusTarget(
      { kind: "ResourceChat", ref },
      ctx,
      { disposition: { kind: "Fork" }, modality: "Pointer" },
    );

    expect(ctx.activateWorkspaceTarget).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ disposition: { kind: "Follow" } }),
    );
    expect(ctx.activateWorkspaceTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ disposition: { kind: "Fork" } }),
    );
  });

  it("projects resource Open through the shared resource owner", async () => {
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      href: "/media/11111111-1111-4111-8111-111111111111",
    });
    const ctx = context();

    await expect(
      dispatchNexusTarget(
        { kind: "ResourceOpen", subject, labelHint: "A resource" },
        ctx,
        PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "NavigationAccepted" });
  });

  it("routes workflow targets through the controller without side effects in components", async () => {
    const ctx = context();
    const activation = {
      disposition: { kind: "Fork" as const },
      modality: "Keyboard" as const,
    };
    const workflows: NexusTarget[] = [
      {
        kind: "OpenAdd",
        seed: {
          kind: "Content",
          initialFocus: "Url",
          initialDestinations: [],
        },
      },
      { kind: "CreatePage", titleDraft: "" },
      { kind: "CreateLibrary", nameDraft: "" },
      { kind: "ChooseCreate", initialDraft: "Project Ideas" },
      { kind: "ChooseBrowse", query: "Project Ideas" },
      { kind: "ManageTabs" },
    ];
    for (const target of workflows) {
      await expect(
        dispatchNexusTarget(target, ctx, activation),
      ).resolves.toEqual({
        kind: "WorkflowRequested",
        target,
        activation,
      });
    }
    expect(ctx.activateWorkspaceTarget).not.toHaveBeenCalled();
  });

  it("routes Today view and append through the one OpenDailyPage capability", async () => {
    const ctx = context();
    const activation = {
      disposition: { kind: "Adopt" as const },
      modality: "Pointer" as const,
    };

    await dispatchNexusTarget(
      materializeNexusTarget({
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: { kind: "View" },
      }, { accountId: "account-1", calendarTimeZone: "UTC" }),
      ctx,
      activation,
    );
    await dispatchNexusTarget(
      materializeNexusTarget({
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: { kind: "AppendNote", initialText: "Project Ideas" },
      }, { accountId: "account-1", calendarTimeZone: "UTC" }),
      ctx,
      activation,
    );

    expect(ctx.openDailyPage).toHaveBeenNthCalledWith(
      1,
      {
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: { kind: "View" },
      },
      activation,
    );
    expect(ctx.openDailyPage).toHaveBeenNthCalledWith(
      2,
      {
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: {
          kind: "AppendNote",
          initialText: "Project Ideas",
          noteId: expect.any(String),
          clientMutationId: expect.any(String),
        },
      },
      activation,
    );
  });

  it("retains and retries one frozen daily AppendNote target after pane rejection", async () => {
    const rejected = context({
      result: { kind: "Rejected", reason: "PaneLimitReached" },
    });
    const activation = {
      disposition: { kind: "Adopt" as const },
      modality: "Programmatic" as const,
    };

    const target = materializeNexusTarget(
      {
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: { kind: "AppendNote", initialText: "Project Ideas" },
      },
      { accountId: "account-1", calendarTimeZone: "UTC" },
    );
    const outcome = await dispatchNexusTarget(
      target,
      rejected,
      activation,
    );

    expect(outcome).toMatchObject({
      kind: "NavigationRejected",
      target: {
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: {
          kind: "AppendNote",
          initialText: "Project Ideas",
          noteId: expect.any(String),
          clientMutationId: expect.any(String),
        },
      },
    });
    if (outcome.kind !== "NavigationRejected") {
      throw new Error("Expected rejected daily activation");
    }

    const accepted = context();
    await dispatchNexusTarget(outcome.target, accepted, activation);

    expect(accepted.openDailyPage).toHaveBeenCalledWith(
      outcome.target,
      activation,
    );
  });

  it("materializes one AppendNote replay identity and reuses it through dispatch", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const target = materializeNexusTarget(
      {
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: { kind: "AppendNote", initialText: "Project Ideas" },
      },
      { accountId: "account-1", calendarTimeZone: "UTC" },
    );
    const ctx = context();

    await dispatchNexusTarget(
      target,
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );

    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
    expect(ctx.openDailyPage).toHaveBeenCalledWith(
      {
        kind: "OpenDailyPage",
        date: { kind: "LocalDate", value: "2026-07-30" },
        entry: {
          kind: "AppendNote",
          initialText: "Project Ideas",
          noteId: "11111111-1111-4111-8111-111111111111",
          clientMutationId: "22222222-2222-4222-8222-222222222222",
        },
      },
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
  });

  it("accepts pane Search only when the active pane consumes the request", async () => {
    const ctx = context();
    vi.mocked(ctx.requestPaneSearch)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(
      dispatchNexusTarget(
        { kind: "PaneSearch" },
        ctx,
        PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "Stayed" });
    await expect(
      dispatchNexusTarget(
        { kind: "PaneSearch" },
        ctx,
        PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "NavigationAccepted" });
  });

  it("keeps conversation, queue, share, and pane mutations in the dispatch owner", async () => {
    const ctx = context();
    await dispatchNexusTarget(
      { kind: "Ask", text: "why now?" },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
    await dispatchNexusTarget(
      { kind: "NewConversation", initialDraft: "draft" },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
    await dispatchNexusTarget(
      {
        kind: "QueueAdd",
        mediaId: "11111111-1111-4111-8111-111111111111",
        title: "Story",
      },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
    await dispatchNexusTarget(
      {
        kind: "Share",
        target: {
          kind: "Resource",
          ref: assumeCanonicalResourceRef(
            "media:11111111-1111-4111-8111-111111111111",
          ),
        },
      },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
    await dispatchNexusTarget(
      { kind: "PaneClose", paneId: "pane-a" },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );

    expect(ctx.activateWorkspaceTarget).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          href: "/conversations/new?draft=why%20now%3F",
          labelHint: "New chat",
        },
      }),
    );
    expect(ctx.activateWorkspaceTarget).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          href: "/conversations/new?draft=draft",
          labelHint: "New chat",
        },
      }),
    );
    expect(ctx.placeItems).toHaveBeenCalledWith({
      mediaIds: ["11111111-1111-4111-8111-111111111111"],
      placement: { kind: "Last" },
    });
    expect(ctx.openShare).toHaveBeenCalledTimes(1);
    expect(ctx.closePane).toHaveBeenCalledWith("pane-a");
  });

  it("routes a typed Browse kind and resumes only through the player owner", async () => {
    const ctx = context();
    await dispatchNexusTarget(
      {
        kind: "Browse",
        query: "design systems",
        browseKind: "Podcast",
      },
      ctx,
      PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
    );
    await expect(
      dispatchNexusTarget(
        { kind: "ResumeCurrentPlayback" },
        ctx,
        PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "Stayed" });

    expect(ctx.activateWorkspaceTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          href: "/browse?q=design+systems&kind=Podcast",
          labelHint: "Browse",
        },
      }),
    );
    expect(ctx.resumeCurrentPlayback).toHaveBeenCalledTimes(1);
  });
});
