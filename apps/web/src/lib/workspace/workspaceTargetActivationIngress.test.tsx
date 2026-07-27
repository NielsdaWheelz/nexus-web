import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingWorkspaceTargetActivationRequests,
  parseWorkspaceTargetActivationIngressRequest,
  parseWorkspaceTargetActivationMessage,
  requestWorkspaceTargetActivation,
  setWorkspaceTargetActivationReceiverReady,
} from "./workspaceTargetActivationIngress";

const request = {
  target: {
    href: "/media/11111111-1111-4111-8111-111111111111",
    labelHint: "  A title  ",
  },
  disposition: { kind: "Follow" as const },
  modality: "Programmatic" as const,
};
const minimalRequest = {
  target: { href: "/lectern" },
  disposition: { kind: "Follow" as const },
  modality: "Programmatic" as const,
};

describe("workspace target activation ingress", () => {
  afterEach(() => {
    setWorkspaceTargetActivationReceiverReady(false);
    consumePendingWorkspaceTargetActivationRequests();
    vi.restoreAllMocks();
  });

  it("accepts only the exact request shape and normalizes its target once", () => {
    expect(parseWorkspaceTargetActivationIngressRequest(request)).toEqual({
      ...request,
      target: { ...request.target, labelHint: "A title" },
    });
    expect(
      parseWorkspaceTargetActivationIngressRequest({
        ...request,
        originPaneId: "pane-1",
      }),
    ).toBeNull();
    expect(
      parseWorkspaceTargetActivationIngressRequest({
        ...request,
        target: { ...request.target, href: "/not-a-pane-route" },
      }),
    ).toBeNull();
    expect(
      parseWorkspaceTargetActivationIngressRequest({
        ...request,
        target: { ...request.target, secondaryActivation: { kind: "Surface" } },
      }),
    ).toBeNull();
  });

  it("round-trips queued minimal requests through the strict parser", () => {
    (
      window as unknown as Record<string, unknown>
    ).__nexusPendingWorkspaceTargetActivationQueue = [minimalRequest];
    expect(consumePendingWorkspaceTargetActivationRequests()).toEqual([
      minimalRequest,
    ]);
    expect(
      requestWorkspaceTargetActivation({
        ...request,
        disposition: { kind: "Unknown" } as never,
      }),
    ).toBe(false);
    expect(consumePendingWorkspaceTargetActivationRequests()).toEqual([]);
  });

  it("posts one typed request from a nested workspace frame", () => {
    const postMessage = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation(() => undefined);
    setWorkspaceTargetActivationReceiverReady(true);

    expect(requestWorkspaceTargetActivation(minimalRequest)).toBe(true);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(parseWorkspaceTargetActivationMessage(postMessage.mock.calls[0]?.[0])).toEqual(
      minimalRequest,
    );
  });
});
