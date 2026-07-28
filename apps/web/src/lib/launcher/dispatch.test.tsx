import { afterEach, describe, expect, it, vi } from "vitest";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import {
  dispatchTarget,
  PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
  targetNavigates,
  type LauncherDispatchCtx,
} from "./dispatch";

function dispatchCtx(input?: {
  result?: WorkspaceTargetActivationResult;
}): LauncherDispatchCtx & {
  activateWorkspaceTarget: ReturnType<typeof vi.fn>;
} {
  const shareOptions = {
    returnFocusTo: () => null,
    returnFocusFallback: { kind: "Absent" as const },
  };
  return {
    androidShell: false,
    feedback: { show: vi.fn() } as never,
    activePaneId: "pane-origin",
    activateWorkspaceTarget: vi.fn(
      (_request: WorkspaceTargetActivationRequest) =>
        input?.result ??
        ({ kind: "CreatedPane", paneId: "pane-created" } as const),
    ),
    defaultLibraryIds: [],
    placeItems: vi.fn(),
    panes: [],
    activatePane: vi.fn(),
    restorePane: vi.fn(),
    closePane: vi.fn(),
    openShare: vi.fn(),
    shareOptions: () => shareOptions,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Launcher dispatch activation outcomes", () => {
  it("opens a resource through the shell-owned workspace capability", async () => {
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      href: "/media/11111111-1111-4111-8111-111111111111",
    });
    const ctx = dispatchCtx();

    const outcome = await dispatchTarget(
      { kind: "ResourceOpen", subject, labelHint: "A resource" },
      ctx,
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
    );

    expect(outcome).toEqual({ kind: "NavigationAccepted" });
    expect(ctx.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-origin",
      target: {
        href: "/media/11111111-1111-4111-8111-111111111111",
        labelHint: "A resource",
      },
      disposition: { kind: "Follow" },
      modality: "Programmatic",
    });
    expect(targetNavigates({ kind: "ResourceOpen", subject })).toBe(true);
  });

  it("returns the rejected canonical target without using message ingress", async () => {
    const ctx = dispatchCtx({
      result: { kind: "Rejected", reason: "PaneLimitReached" },
    });
    const target = {
      kind: "href" as const,
      href: "/libraries",
      externalShell: false,
      labelHint: "Libraries",
    };

    await expect(
      dispatchTarget(target, ctx, {
        disposition: { kind: "Adopt" },
        modality: "Pointer",
      }),
    ).resolves.toEqual({
      kind: "NavigationRejected",
      reason: "PaneLimitReached",
      target: { href: "/libraries", labelHint: "Libraries" },
    });
  });

  it("shares through the shared Share owner and reports accepted projection", async () => {
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      href: "/media/11111111-1111-4111-8111-111111111111",
    });
    const ctx = dispatchCtx();
    const options = ctx.shareOptions();

    await expect(
      dispatchTarget(
        { kind: "ResourceShare", subject },
        ctx,
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "NavigationAccepted" });
    expect(ctx.openShare).toHaveBeenCalledWith(
      { kind: "Resource", ref: subject.ref },
      options,
    );
  });

  it("creates a resource-context conversation and adopts it", async () => {
    const ref = assumeCanonicalResourceRef(
      "media:11111111-1111-4111-8111-111111111111",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { id: "conversation-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const ctx = dispatchCtx();

    await expect(
      dispatchTarget(
        { kind: "ResourceChat", ref },
        ctx,
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "NavigationAccepted" });
    expect(ctx.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-origin",
      target: { href: "/conversations/conversation-1", labelHint: "Chat" },
      disposition: { kind: "Adopt" },
      modality: "Programmatic",
    });
  });

  it("guards rapid resource Chat re-entry by canonical ref", async () => {
    const ref = assumeCanonicalResourceRef(
      "media:11111111-1111-4111-8111-111111111111",
    );
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = dispatchCtx();

    const first = dispatchTarget(
      { kind: "ResourceChat", ref },
      ctx,
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
    );
    const second = dispatchTarget(
      { kind: "ResourceChat", ref },
      ctx,
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
    );
    resolveFetch?.(
      new Response(JSON.stringify({ data: { id: "conversation-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(await Promise.all([first, second])).toEqual([
      { kind: "NavigationAccepted" },
      { kind: "Stayed" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.activateWorkspaceTarget).toHaveBeenCalledOnce();
  });

  it("threads the caller modality and Fork disposition", async () => {
    const ctx = dispatchCtx();
    await dispatchTarget(
      {
        kind: "href",
        href: "/libraries",
        externalShell: false,
        labelHint: "Libraries",
      },
      ctx,
      { disposition: { kind: "Fork" }, modality: "Pointer" },
    );

    expect(ctx.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-origin",
      target: { href: "/libraries", labelHint: "Libraries" },
      disposition: { kind: "Fork" },
      modality: "Pointer",
    });
  });

  it("reports nonnavigating actions as Stayed", async () => {
    const ctx = dispatchCtx();
    await expect(
      dispatchTarget(
        { kind: "pane-close", paneId: "pane-a" },
        ctx,
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      ),
    ).resolves.toEqual({ kind: "Stayed" });
    expect(ctx.closePane).toHaveBeenCalledWith("pane-a");
    expect(ctx.activateWorkspaceTarget).not.toHaveBeenCalled();
  });
});
