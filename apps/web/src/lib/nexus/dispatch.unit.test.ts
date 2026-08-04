import { describe, expect, it } from "vitest";
import {
  dispatchNexusTarget,
  settleNexusDispatch,
  type NexusDispatchCtx,
} from "./dispatch";

const ACTIVATION = {
  disposition: { kind: "Follow" as const },
  modality: "Pointer" as const,
};

function unexpected(capability: string): never {
  throw new Error(`unexpected Nexus dispatch capability: ${capability}`);
}

function dispatchContext(
  overrides: Partial<NexusDispatchCtx> = {},
): NexusDispatchCtx {
  return {
    androidShell: false,
    feedback: {
      publish: () => unexpected("feedback.publish"),
      resolve: () => unexpected("feedback.resolve"),
      suppress: () => unexpected("feedback.suppress"),
    },
    activePaneId: "pane-a",
    activateWorkspaceTarget: () =>
      unexpected("activateWorkspaceTarget"),
    panes: [
      {
        id: "pane-a",
        href: "/notes",
        visibility: "visible",
        label: "Notes",
      },
    ],
    activatePane: () => unexpected("activatePane"),
    restorePane: () => unexpected("restorePane"),
    closePane: () => unexpected("closePane"),
    requestPaneSearch: () => unexpected("requestPaneSearch"),
    openShare: () => unexpected("openShare"),
    shareOptions: () => unexpected("shareOptions"),
    openDailyPage: () => unexpected("openDailyPage"),
    resumeCurrentPlayback: () => unexpected("resumeCurrentPlayback"),
    ...overrides,
  };
}

describe("Nexus dispatch timing contract", () => {
  it("settles a followed exact-pane activation inside the initiating call", () => {
    const events: string[] = [];
    const context = dispatchContext({
      activatePane: (paneId) => events.push(`activated:${paneId}`),
    });

    const result = dispatchNexusTarget(
      { kind: "PaneOpen", paneId: "pane-a" },
      context,
      ACTIVATION,
    );

    expect(
      events,
      "exact-pane activation escaped the initiating dispatch call",
    ).toEqual(["activated:pane-a"]);
    expect(
      result,
      "followed exact-pane dispatch returned an asynchronous wrapper",
    ).toEqual({ kind: "NavigationAccepted" });
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("settles an asynchronous dispatch result through the common Promise boundary", async () => {
    const events: string[] = [];
    const settled = settleNexusDispatch(() => {
      // The run executes eagerly inside the initiating call; only its async
      // result crosses the shared Promise boundary that settleNexusDispatch owns.
      events.push("ran");
      return Promise.resolve({ kind: "Stayed" as const });
    });

    expect(events).toEqual(["ran"]);
    await expect(settled).resolves.toEqual({ kind: "Stayed" });
  });
});
