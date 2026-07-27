import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingWorkspaceTargetActivationRequests,
  parseWorkspaceTargetActivationMessage,
  setWorkspaceTargetActivationReceiverReady,
  type WorkspaceTargetActivationIngressRequest,
} from "@/lib/workspace/workspaceTargetActivationIngress";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  dispatchTarget,
  PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
  targetNavigates,
  type LauncherDispatchCtx,
} from "./dispatch";

function dispatchCtx(): LauncherDispatchCtx {
  const shareOptions = {
    returnFocusTo: () => null,
    returnFocusFallback: { kind: "Absent" as const },
  };
  return {
    androidShell: false,
    feedback: { show: vi.fn() } as never,
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

function openedTargets(): {
  readonly details: WorkspaceTargetActivationIngressRequest[];
  readonly stop: () => void;
} {
  const details: WorkspaceTargetActivationIngressRequest[] = [];
  const originalPostMessage = window.parent.postMessage.bind(window.parent);
  const postMessage = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(
      (...args: Parameters<typeof window.parent.postMessage>) => {
        const parsed = parseWorkspaceTargetActivationMessage(args[0]);
        if (parsed !== null) details.push(parsed);
        return originalPostMessage(...args);
      },
    );
  return {
    details,
    stop: () => {
      details.push(...consumePendingWorkspaceTargetActivationRequests());
      postMessage.mockRestore();
    },
  };
}

beforeEach(() => {
  setWorkspaceTargetActivationReceiverReady(true);
});

afterEach(() => {
  setWorkspaceTargetActivationReceiverReady(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Launcher resource action dispatch", () => {
  it("opens an explicit resource subject through the shared activation outcome", async () => {
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      href: "/media/11111111-1111-4111-8111-111111111111",
    });
    const panes = openedTargets();

    try {
      await dispatchTarget(
        { kind: "ResourceOpen", subject, labelHint: "A resource" },
        dispatchCtx(),
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      );
    } finally {
      panes.stop();
    }

    expect(panes.details).toEqual([
      {
        target: {
          href: "/media/11111111-1111-4111-8111-111111111111",
          labelHint: "A resource",
        },
        disposition: { kind: "Follow" },
        modality: "Programmatic",
      },
    ]);
    expect(
      targetNavigates({
        kind: "ResourceOpen",
        subject,
        labelHint: "A resource",
      }),
    ).toBe(true);
  });

  it("shares an explicit resource subject through the shared Share outcome", async () => {
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      href: "/media/11111111-1111-4111-8111-111111111111",
    });
    const ctx = dispatchCtx();
    const options = ctx.shareOptions();

    await dispatchTarget(
      { kind: "ResourceShare", subject },
      ctx,
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
    );

    expect(ctx.openShare).toHaveBeenCalledWith(
      { kind: "Resource", ref: subject.ref },
      options,
    );
    expect(
      targetNavigates({ kind: "ResourceShare", subject }),
    ).toBe(true);
  });

  it("creates a resource-context conversation and opens that conversation", async () => {
    const ref = assumeCanonicalResourceRef(
      "media:11111111-1111-4111-8111-111111111111",
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: "conversation-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const panes = openedTargets();

    try {
      await dispatchTarget(
        { kind: "ResourceChat", ref },
        dispatchCtx(),
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      );
    } finally {
      panes.stop();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ initial_context_refs: [ref] }),
      }),
    );
    expect(panes.details).toEqual([
      {
        target: { href: "/conversations/conversation-1", labelHint: "Chat" },
        disposition: { kind: "Adopt" },
        modality: "Programmatic",
      },
    ]);
    expect(targetNavigates({ kind: "ResourceChat", ref })).toBe(true);
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
    const panes = openedTargets();

    const first = dispatchTarget(
      { kind: "ResourceChat", ref },
      dispatchCtx(),
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
    );
    const second = dispatchTarget(
      { kind: "ResourceChat", ref },
      dispatchCtx(),
      PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
    );
    resolveFetch?.(
      new Response(JSON.stringify({ data: { id: "conversation-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    try {
      await Promise.all([first, second]);
    } finally {
      panes.stop();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(panes.details.map((detail) => detail.target.href)).toEqual([
      "/conversations/conversation-1",
    ]);
  });

  it("preserves generic Ask as a draft conversation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const panes = openedTargets();

    try {
      await dispatchTarget(
        { kind: "Ask", text: "A general question" },
        dispatchCtx(),
        PROGRAMMATIC_LAUNCHER_TARGET_ACTIVATION,
      );
    } finally {
      panes.stop();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(panes.details).toEqual([
      {
        target: {
          href: "/conversations/new?draft=A%20general%20question",
          labelHint: "New chat",
        },
        disposition: { kind: "Follow" },
        modality: "Programmatic",
      },
    ]);
  });

  it("threads Shift-pointer Fork to launcher targets", async () => {
    const panes = openedTargets();

    try {
      await dispatchTarget(
        {
          kind: "href",
          href: "/libraries",
          externalShell: false,
          labelHint: "Libraries",
        },
        dispatchCtx(),
        { disposition: { kind: "Fork" }, modality: "Pointer" },
      );
    } finally {
      panes.stop();
    }

    expect(panes.details).toEqual([
      {
        target: { href: "/libraries", labelHint: "Libraries" },
        disposition: { kind: "Fork" },
        modality: "Pointer",
      },
    ]);
  });

  it("keeps ordinary resource Chat as Adopt but preserves explicit Fork", async () => {
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
    const panes = openedTargets();

    try {
      await dispatchTarget(
        { kind: "ResourceChat", ref },
        dispatchCtx(),
        { disposition: { kind: "Fork" }, modality: "Pointer" },
      );
    } finally {
      panes.stop();
    }

    expect(panes.details).toEqual([
      {
        target: { href: "/conversations/conversation-1", labelHint: "Chat" },
        disposition: { kind: "Fork" },
        modality: "Pointer",
      },
    ]);
  });
});
