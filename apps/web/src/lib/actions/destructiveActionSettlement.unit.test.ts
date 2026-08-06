import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  observeCanonicalResourceMissing,
  publishObservedDestructiveActionCommit,
  settleDestructiveAction,
} from "@/lib/actions/destructiveActionSettlement";
import { conversationIndexSnapshot } from "@/lib/conversations/indexRevision";
import { libraryPlacementSnapshot } from "@/lib/libraries/placementRevision";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

const ambiguousErrors = [
  new ApiError(0, "E_NETWORK", "Network request failed"),
  new ApiError(502, "E_UPSTREAM", "Backend service unavailable"),
  new ApiError(504, "E_UPSTREAM_TIMEOUT", "Backend service timed out"),
] as const;

afterEach(() => vi.unstubAllGlobals());

describe("settleDestructiveAction", () => {
  it("accepts an acknowledged command without observing or replaying it", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const observeMissing = vi.fn();

    await expect(
      settleDestructiveAction({ command, observeMissing }),
    ).resolves.toEqual({ kind: "Committed", evidence: "Acknowledged" });
    expect(command).toHaveBeenCalledTimes(1);
    expect(observeMissing).not.toHaveBeenCalled();
  });

  it.each(ambiguousErrors)(
    "accepts %s only when a fresh snapshot witnesses missing",
    async (commandError) => {
      const command = vi.fn().mockRejectedValue(commandError);
      const observeMissing = vi.fn().mockResolvedValue(true);

      await expect(
        settleDestructiveAction({ command, observeMissing }),
      ).resolves.toEqual({
        kind: "Committed",
        evidence: "ObservedMissing",
      });
      expect(command).toHaveBeenCalledTimes(1);
      expect(observeMissing).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the command error when the subject is authoritatively present", async () => {
    const commandError = ambiguousErrors[0];

    await expect(
      settleDestructiveAction({
        command: vi.fn().mockRejectedValue(commandError),
        observeMissing: vi.fn().mockResolvedValue(false),
      }),
    ).resolves.toEqual({ kind: "NotCommitted", commandError });
  });

  it("returns an explicit unconfirmed outcome when observation is also ambiguous", async () => {
    const commandError = ambiguousErrors[1];
    const observationError = ambiguousErrors[2];
    const command = vi.fn().mockRejectedValue(commandError);

    await expect(
      settleDestructiveAction({
        command,
        observeMissing: vi.fn().mockRejectedValue(observationError),
      }),
    ).resolves.toEqual({
      kind: "Unconfirmed",
      commandError,
      observationError,
    });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ApiError(403, "E_FORBIDDEN", "Forbidden"),
    new ApiError(500, "E_INTERNAL", "Contract defect"),
    new TypeError("invalid response"),
  ])("does not observe or relabel a definitive failure: %s", async (error) => {
    const observeMissing = vi.fn();

    await expect(
      settleDestructiveAction({
        command: vi.fn().mockRejectedValue(error),
        observeMissing,
      }),
    ).rejects.toBe(error);
    expect(observeMissing).not.toHaveBeenCalled();
  });

  it("propagates an observation defect instead of calling it unconfirmed", async () => {
    const observationError = new TypeError("snapshot identity drift");

    await expect(
      settleDestructiveAction({
        command: vi.fn().mockRejectedValue(ambiguousErrors[0]),
        observeMissing: vi.fn().mockRejectedValue(observationError),
      }),
    ).rejects.toBe(observationError);
  });

  it("observes one exact strict missing snapshot through the read-only retry transport", async () => {
    const ref = assumeCanonicalResourceRef(
      "library:11111111-1111-4111-8111-111111111111",
    );
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            snapshots: [
              {
                ref,
                activation: {
                  resourceRef: ref,
                  kind: "none",
                  href: null,
                  unresolvedReason: "Missing",
                },
                missing: true,
                factsRevision: "0".repeat(64),
                capabilities: [],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(observeCanonicalResourceMissing(ref)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      refs: [ref],
    });
  });

  it("publishes only the projection whose acknowledged client publication was lost", () => {
    const placementBefore = libraryPlacementSnapshot().revision;
    const conversationsBefore = conversationIndexSnapshot().revision;

    publishObservedDestructiveActionCommit("RemoveMedia");
    publishObservedDestructiveActionCommit("DeleteLibrary");
    expect(libraryPlacementSnapshot().revision).toBe(placementBefore + 2);
    expect(conversationIndexSnapshot().revision).toBe(conversationsBefore);

    publishObservedDestructiveActionCommit("DeleteConversation");
    expect(libraryPlacementSnapshot().revision).toBe(placementBefore + 2);
    expect(conversationIndexSnapshot().revision).toBe(conversationsBefore + 1);
  });
});
