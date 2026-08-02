import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDiscoveryTargetHandle } from "@/lib/browse/contract";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import AcquisitionControl, {
  type AcquisitionCommand,
} from "./AcquisitionControl";

const mocks = vi.hoisted(() => ({
  apiCommand204: vi.fn(),
  feedbackPublish: vi.fn(),
  stopPreviewAudio: vi.fn(),
}));

vi.mock("@/components/feedback/Feedback", () => ({
  FeedbackNotice: () => null,
  useFeedback: () => ({ publish: mocks.feedbackPublish }),
}));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...original,
    apiCommand204: mocks.apiCommand204,
    isApiError: (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error,
    isSameSystemApiDefect: () => false,
  };
});

vi.mock("@/lib/auth/UnauthenticatedApiBoundary", () => ({
  handleUnauthenticatedApiError: () => false,
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  usePlayerCommands: () => ({
    stopPreviewAudio: mocks.stopPreviewAudio,
  }),
}));

vi.mock("@/components/libraries/LibraryDestinationPicker", () => ({
  default: ({
    onChange,
    selected,
  }: {
    onChange(value: readonly { id: string; name: string }[]): void;
    selected: readonly { id: string; name: string }[];
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...selected.filter((destination) => destination.id !== "library-a"),
            { id: "library-a", name: "Library A" },
          ])
        }
      >
        Select Library A
      </button>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...selected.filter((destination) => destination.id !== "library-b"),
            { id: "library-b", name: "Library B" },
          ])
        }
      >
        Select Library B
      </button>
    </>
  ),
}));

vi.mock("./PodcastReplacementDialog", () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm(): void }) =>
    open ? (
      <button type="button" onClick={onConfirm}>
        Replace and subscribe
      </button>
    ) : null,
}));

const target = parseDiscoveryTargetHandle(`ndt1.eA.${"A".repeat(43)}`);
const visitId = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

function renderControl(ui: ReactNode) {
  return render(
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={visitId} routeKey="browse-preview:test">
        {ui}
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>,
  );
}

describe("AcquisitionControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
        .mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
        .mockReturnValueOnce("33333333-3333-4333-8333-333333333333"),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns a subscribed Podcast control into an explicit staged Library add", async () => {
    const commit = vi.fn().mockResolvedValue({
      href: "/podcasts/podcast-1",
    });

    renderControl(
      <AcquisitionControl
        kind="Subscribe"
        subscribed
        commit={commit}
        onCommitted={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Subscribed" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select Library A" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add to Libraries, also add to 1 named Library",
      }),
    );

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ namedLibraryIds: ["library-a"] }),
    );
  });

  it("retains the frozen destination snapshot and uses a fresh key for replacement confirmation", async () => {
    const commands: AcquisitionCommand[] = [];
    const commit = vi.fn(async (command: AcquisitionCommand) => {
      commands.push(command);
      if (commands.length === 1) {
        throw {
          code: "E_PODCAST_REPLACES_EPISODES",
          details: {
            conflicts: [
              {
                libraryId: "library-a",
                libraryName: "Library A",
                episodeCount: 2,
              },
            ],
            conflictFingerprint: "conflict-1",
          },
        };
      }
      return { href: "/podcasts/podcast-1" };
    });

    renderControl(
      <AcquisitionControl
        kind="Subscribe"
        previewTarget={target}
        commit={commit}
        onCommitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Library A" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Subscribe, also add/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace and subscribe" }),
    );

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commands[0]!.namedLibraryIds).toEqual(["library-a"]);
    expect(commands[1]!.namedLibraryIds).toEqual(["library-a"]);
    expect(commands[1]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    expect(commands[1]!.replacementConfirmation).toEqual({
      kind: "Present",
      value: { conflictFingerprint: "conflict-1" },
    });
  });

  it("releases the replacement modal on delivery-unknown and retries the confirmed command with its frozen key", async () => {
    const commands: AcquisitionCommand[] = [];
    const commit = vi.fn(async (command: AcquisitionCommand) => {
      commands.push(command);
      if (commands.length === 1) {
        throw {
          code: "E_PODCAST_REPLACES_EPISODES",
          details: {
            conflicts: [
              {
                libraryId: "library-a",
                libraryName: "Library A",
                episodeCount: 2,
              },
            ],
            conflictFingerprint: "conflict-1",
          },
        };
      }
      if (commands.length === 2) {
        // Delivery unknown on the confirmed, destructive replacement: the
        // command may already have committed, so the retry must reuse its key.
        throw { code: "E_NETWORK" };
      }
      return { href: "/podcasts/podcast-1" };
    });

    renderControl(
      <AcquisitionControl
        kind="Subscribe"
        previewTarget={target}
        commit={commit}
        onCommitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Library A" }));
    fireEvent.click(screen.getByRole("button", { name: /Subscribe, also add/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace and subscribe" }),
    );

    const retry = await screen.findByRole("button", { name: /^Retry Subscribe/ });
    // The modal is released so the frozen-key retry is reachable, not trapped.
    expect(
      screen.queryByRole("button", { name: "Replace and subscribe" }),
    ).not.toBeInTheDocument();

    fireEvent.click(retry);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(3));

    // Confirmation mints one fresh key; the delivery-unknown retry reuses it so
    // the server's replay returns the frozen response instead of double-removing.
    expect(commands[1]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    expect(commands[2]!.idempotencyKey).toBe(commands[1]!.idempotencyKey);
    expect(commands[2]!.replacementConfirmation).toEqual({
      kind: "Present",
      value: { conflictFingerprint: "conflict-1" },
    });
  });

  it("commits acquisition when preview-position transfer fails and reports nonfatal feedback", async () => {
    mocks.stopPreviewAudio.mockReturnValue({
      positionMs: 12_345,
      durationMs: { kind: "Present", value: 60_000 },
    });
    mocks.apiCommand204.mockRejectedValue({
      code: "E_NETWORK",
      requestId: "req-preview",
    });
    const onCommitted = vi.fn();

    renderControl(
      <AcquisitionControl
        kind="Add"
        previewTarget={target}
        commit={vi.fn().mockResolvedValue({
          href: "/media/media-1",
          mediaId: "media-1",
        })}
        onCommitted={onCommitted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(onCommitted).toHaveBeenCalledWith("/media/media-1"),
    );
    expect(mocks.apiCommand204).toHaveBeenCalledWith(
      "/api/media/media-1/preview-position",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          positionMs: 12_345,
          durationMs: { kind: "Present", value: 60_000 },
        }),
      }),
    );
    expect(mocks.feedbackPublish).toHaveBeenCalledWith({
      kind: "Hud",
      content: {
        tone: "Warning",
        title: "Added without preview position",
        message: "The preview listening position couldn’t be transferred.",
        requestId: "req-preview",
      },
    });
  });

  it("treats a modeled network rejection as Delivery unknown and retries the frozen command with the same key", async () => {
    let failNext = true;
    const commands: AcquisitionCommand[] = [];
    const commit = vi.fn(async (command: AcquisitionCommand) => {
      commands.push(command);
      if (failNext) {
        failNext = false;
        throw { code: "E_NETWORK" };
      }
      return { href: "/media/media-1", mediaId: "media-1" };
    });
    const onCommitted = vi.fn();

    renderControl(
      <AcquisitionControl
        kind="Add"
        previewTarget={target}
        commit={commit}
        onCommitted={onCommitted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByRole("button", { name: "Retry Add" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry Add" }));

    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

  it("refetches writable destinations after a permission change, prunes only unauthorized selections, and requires resubmit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          {
            id: "library-a",
            name: "Library A renamed",
            color: null,
            created_at: "2026-07-29T00:00:00Z",
            updated_at: "2026-07-29T00:00:00Z",
          },
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );
    const commands: AcquisitionCommand[] = [];
    const commit = vi.fn(async (command: AcquisitionCommand) => {
      commands.push(command);
      if (commands.length === 1) {
        throw { code: "E_LIBRARY_FORBIDDEN" };
      }
      return { href: "/podcasts/podcast-1" };
    });

    renderControl(
      <AcquisitionControl
        kind="Subscribe"
        previewTarget={target}
        commit={commit}
        onCommitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Library A" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Library B" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Subscribe, also add to 2 named Libraries",
      }),
    );

    expect(
      await screen.findByRole("button", {
        name: "Subscribe, also add to 1 named Library",
      }),
    ).toBeEnabled();
    expect(commit).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Subscribe, also add to 1 named Library",
      }),
    );
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));

    expect(commands[0]!.namedLibraryIds).toEqual(["library-a", "library-b"]);
    expect(commands[1]!.namedLibraryIds).toEqual(["library-a"]);
    expect(commands[1]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
  });

  it("keeps staged destinations when permission review cannot load and retries review without resubmitting acquisition", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "library-a",
              name: "Library A",
              color: null,
              created_at: "2026-07-29T00:00:00Z",
              updated_at: "2026-07-29T00:00:00Z",
            },
          ],
          page: { has_more: false, next_cursor: null },
        }),
      );
    const commit = vi
      .fn()
      .mockRejectedValueOnce({ code: "E_LIBRARY_FORBIDDEN" })
      .mockResolvedValueOnce({ href: "/podcasts/podcast-1" });

    renderControl(
      <AcquisitionControl
        kind="Subscribe"
        previewTarget={target}
        commit={commit}
        onCommitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Library A" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Subscribe, also add to 1 named Library",
      }),
    );

    const review = await screen.findByRole("button", {
      name: "Retry destination review",
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", {
        name: "Subscribe, also add to 1 named Library",
      }),
    ).toBeDisabled();

    fireEvent.click(review);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Subscribe, also add to 1 named Library",
        }),
      ).toBeEnabled(),
    );
    expect(commit).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Subscribe, also add to 1 named Library",
      }),
    );
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
  });

  it("closes and disables destination selection when the target is unavailable", async () => {
    renderControl(
      <AcquisitionControl
        kind="Add"
        previewTarget={target}
        commit={vi.fn().mockRejectedValue({ code: "E_NOT_FOUND" })}
        onCommitted={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Also add to Libraries" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled(),
    );
    expect(
      screen.getByRole("button", { name: "Also add to Libraries" }),
    ).toBeDisabled();
  });

  it("does not offer Retry when dispatch is cancelled before a promise exists", async () => {
    const commit = vi.fn(() => {
      throw new DOMException("Owner cancelled", "AbortError");
    });

    renderControl(
      <AcquisitionControl
        kind="Add"
        previewTarget={target}
        commit={commit}
        onCommitted={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: "Retry Add" }),
    ).not.toBeInTheDocument();
  });
});
