import { describe, expect, it } from "vitest";
import type { LecternResult } from "@/lib/lectern/contract";
import {
  dispatchNexusTarget,
  settleNexusDispatch,
  type NexusDispatchCtx,
} from "./dispatch";

const MEDIA_ID = "00000000-0000-4000-8000-000000000001";
const ACTIVATION = {
  disposition: { kind: "Follow" as const },
  modality: "Pointer" as const,
};

function unexpected(capability: string): never {
  throw new Error(`unexpected Nexus dispatch capability: ${capability}`);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (complete === undefined) {
        throw new Error("deferred completion was not initialized");
      }
      complete(value);
    },
  };
}

function dispatchContext(
  overrides: Partial<NexusDispatchCtx> = {},
): NexusDispatchCtx {
  return {
    androidShell: false,
    feedback: {
      show: () => unexpected("feedback.show"),
      dismissByDedupeKey: () => unexpected("feedback.dismissByDedupeKey"),
      suppressDedupeKey: () => unexpected("feedback.suppressDedupeKey"),
    },
    activePaneId: "pane-a",
    activateWorkspaceTarget: () =>
      unexpected("activateWorkspaceTarget"),
    placeItems: async () => unexpected("placeItems"),
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

  it("settles an asynchronous target through the common Promise boundary", async () => {
    const events: string[] = [];
    const placement = deferred<LecternResult>();
    const context = dispatchContext({
      placeItems: ({ mediaIds }) => {
        events.push(`placement:${mediaIds.join(",")}`);
        return placement.promise;
      },
      feedback: {
        show: (feedback) => events.push(`feedback:${feedback.title}`),
        dismissByDedupeKey: () => unexpected("feedback.dismissByDedupeKey"),
        suppressDedupeKey: () => unexpected("feedback.suppressDedupeKey"),
      },
    });

    const settled = settleNexusDispatch(() =>
      dispatchNexusTarget(
        { kind: "QueueAdd", mediaId: MEDIA_ID, title: "Queued reading" },
        context,
        ACTIVATION,
      ),
    );

    expect(events).toEqual([`placement:${MEDIA_ID}`]);
    placement.resolve({
      outcome: { kind: "Placed", itemIds: [] },
      lectern: { items: [] },
    });

    await expect(settled).resolves.toEqual({ kind: "Stayed" });
    expect(events).toEqual([
      `placement:${MEDIA_ID}`,
      "feedback:Added to Lectern",
    ]);
  });
});
