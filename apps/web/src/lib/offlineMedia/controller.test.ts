import { ApiError } from "@/lib/api/client";
import { describe, expect, it, vi } from "vitest";
import { OfflineMediaClientStore } from "./clientStore";
import { OfflineMediaControllerRuntime } from "./controller";
import type { OfflineDownloadSpecReader } from "./controller";
import {
  OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS,
  type OfflineMediaCommand,
} from "./contract";
import type { OfflineMediaTransport } from "./transport";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";

class FakeTransport implements OfflineMediaTransport {
  readonly commands: OfflineMediaCommand[] = [];
  private listener: ((message: unknown) => void) | null = null;

  start = (listener: (message: unknown) => void) => {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  };

  send = (command: OfflineMediaCommand) => {
    this.commands.push(command);
  };

  reply(
    command: OfflineMediaCommand,
    outcome: Record<string, unknown>,
  ): void {
    this.listener?.({
      requestId: command.requestId,
      protocolVersion: 1,
      outcome,
    });
  }

  event(event: Record<string, unknown>): void {
    this.listener?.({ protocolVersion: 1, ...event });
  }
}

function runtime(
  readDownloadSpec: OfflineDownloadSpecReader = vi.fn(async () => ({
    kind: "ProgressiveAudio" as const,
    mediaId: MEDIA_ID,
    title: "Episode",
    sourceUrl: "https://example.test/episode.mp3",
  })),
  handleUnauthenticated = vi.fn(() => false),
) {
  const store = new OfflineMediaClientStore();
  const transport = new FakeTransport();
  const showError = vi.fn();
  const onFatal = vi.fn();
  let request = 0;
  const controller = new OfflineMediaControllerRuntime(
    ACCOUNT_ID,
    store,
    transport,
    readDownloadSpec,
    "https://nexus.test",
    showError,
    onFatal,
    handleUnauthenticated,
    vi.fn(),
    () =>
      `00000000-0000-4000-8000-${(++request).toString().padStart(12, "0")}`,
  );
  return {
    controller,
    store,
    transport,
    showError,
    onFatal,
    handleUnauthenticated,
  };
}

async function connect(
  controller: OfflineMediaControllerRuntime,
  transport: FakeTransport,
): Promise<void> {
  const connected = controller.connect();
  transport.reply(transport.commands[0], {
    kind: "Connected",
    items: [],
    networkPolicy: "UnmeteredOnly",
  });
  await connected;
}

describe("OfflineMediaController", () => {
  it("gives expired-session recovery precedence over the spec deadline", async () => {
    vi.useFakeTimers();
    const expiredSession = new ApiError(
      401,
      "E_UNAUTHENTICATED",
      "Session expired",
    );
    const handleUnauthenticated = vi.fn(() => true);
    const { controller, store, transport, showError } = runtime(
      (_mediaId, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(expiredSession), {
            once: true,
          });
        }),
      handleUnauthenticated,
    );
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");

    const enqueue = controller.enqueue(MEDIA_ID);
    await vi.advanceTimersByTimeAsync(OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS);
    await enqueue;

    expect(handleUnauthenticated).toHaveBeenCalledWith(
      expiredSession,
    );
    expect(showError).not.toHaveBeenCalled();
    expect(store.getItem(MEDIA_ID)).toEqual({ kind: "Absent" });
  });

  it("classifies the real AbortSignal deadline with exact timeout feedback", async () => {
    vi.useFakeTimers();
    const { controller, store, transport, showError } = runtime(
      (_mediaId, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");

    const enqueue = controller.enqueue(MEDIA_ID);
    await vi.advanceTimersByTimeAsync(OFFLINE_DOWNLOAD_SPEC_DEADLINE_MS);
    await enqueue;

    expect(store.getItem(MEDIA_ID)).toEqual({ kind: "Absent" });
    expect(showError).toHaveBeenCalledWith(
      "Preparing the download took too long. Try again.",
    );
  });

  it("reports durable storage failure separately from insufficient space", async () => {
    const { controller, store, transport, showError } = runtime();
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");

    const enqueue = controller.enqueue(MEDIA_ID);
    await Promise.resolve();
    transport.reply(transport.commands[1], {
      kind: "Rejected",
      code: "StorageUnavailable",
    });
    await enqueue;

    expect(showError).toHaveBeenCalledWith(
      "Device storage is unavailable. Try again.",
    );
    expect(store.getItem(MEDIA_ID)).toEqual({ kind: "Absent" });
  });

  it("publishes Resolving immediately and fences a canceled spec completion", async () => {
    let complete:
      | ((value: {
          kind: "ProgressiveAudio";
          mediaId: string;
          title: string;
          sourceUrl: string;
        }) => void)
      | undefined;
    const spec = new Promise<{
      kind: "ProgressiveAudio";
      mediaId: string;
      title: string;
      sourceUrl: string;
    }>((resolve) => {
      complete = resolve;
    });
    const { controller, store, transport } = runtime(() => spec);
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");

    const enqueue = controller.enqueue(MEDIA_ID);
    expect(store.getItem(MEDIA_ID)).toEqual({
      kind: "Present",
      value: { kind: "Resolving" },
    });
    await controller.cancel(MEDIA_ID);
    complete?.({
      kind: "ProgressiveAudio",
      mediaId: MEDIA_ID,
      title: "Episode",
      sourceUrl: "https://example.test/episode.mp3",
    });
    await enqueue;

    expect(store.getItem(MEDIA_ID)).toEqual({ kind: "Absent" });
    expect(transport.commands.map((command) => command.kind)).toEqual([
      "Connect",
    ]);
  });

  it("strictly resolves a spec once, then waits for the native pushed state", async () => {
    const { controller, store, transport } = runtime();
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");

    const enqueue = controller.enqueue(MEDIA_ID);
    await Promise.resolve();
    const command = transport.commands[1];
    expect(command.kind).toBe("Enqueue");
    transport.reply(command, { kind: "Accepted" });
    await enqueue;
    transport.event({
      kind: "StateChanged",
      mediaId: MEDIA_ID,
      state: {
        kind: "Present",
        value: {
          kind: "Ready",
          sizeBytes: 10,
          contentType: "audio/mpeg",
          updatedAt: "2026-07-30T19:00:00Z",
        },
      },
    });

    expect(controller.resolveStreamUrl(MEDIA_ID, "https://remote.test")).toBe(
      `https://nexus.test/_native/offline-media/${MEDIA_ID}`,
    );
  });

  it("clears account-session state and ignores late resolving work on dispose", async () => {
    let complete: (() => void) | undefined;
    const { controller, store, transport } = runtime(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              kind: "ProgressiveAudio",
              mediaId: MEDIA_ID,
              title: "Episode",
              sourceUrl: "https://example.test/episode.mp3",
            });
        }),
    );
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");
    const enqueue = controller.enqueue(MEDIA_ID);

    controller.dispose();
    complete?.();
    await enqueue;

    expect(store.getInventory()).toEqual([]);
    expect(transport.commands).toHaveLength(1);
  });

  it("keeps a pushed native state when StateChanged arrives before Accepted", async () => {
    const { controller, store, transport } = runtime();
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");
    const enqueue = controller.enqueue(MEDIA_ID);
    await Promise.resolve();
    const command = transport.commands[1];

    transport.event({
      kind: "StateChanged",
      mediaId: MEDIA_ID,
      state: {
        kind: "Present",
        value: { kind: "Queued", reason: "Capacity" },
      },
    });
    transport.reply(command, { kind: "Accepted" });
    await enqueue;

    expect(store.getItem(MEDIA_ID)).toEqual({
      kind: "Present",
      value: { kind: "Queued", reason: "Capacity" },
    });
  });

  it("sends native Cancel when StateChanged races ahead of Enqueue Accepted", async () => {
    const { controller, store, transport } = runtime();
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");
    const enqueue = controller.enqueue(MEDIA_ID);
    await Promise.resolve();
    const enqueueCommand = transport.commands[1];
    transport.event({
      kind: "StateChanged",
      mediaId: MEDIA_ID,
      state: {
        kind: "Present",
        value: { kind: "Queued", reason: "Capacity" },
      },
    });

    const cancel = controller.cancel(MEDIA_ID);
    const cancelCommand = transport.commands[2];
    expect(cancelCommand).toMatchObject({ kind: "Cancel", mediaId: MEDIA_ID });
    transport.reply(cancelCommand, { kind: "Accepted" });
    await cancel;
    transport.reply(enqueueCommand, { kind: "Accepted" });
    await enqueue;
  });

  it("sends native Cancel once Enqueue was sent even before a push or reply", async () => {
    const { controller, store, transport } = runtime();
    await connect(controller, transport);
    store.noteTitle(MEDIA_ID, "Episode");
    const enqueue = controller.enqueue(MEDIA_ID);
    await Promise.resolve();
    const enqueueCommand = transport.commands[1];
    expect(enqueueCommand.kind).toBe("Enqueue");

    const cancel = controller.cancel(MEDIA_ID);
    const cancelCommand = transport.commands[2];
    expect(cancelCommand).toMatchObject({ kind: "Cancel", mediaId: MEDIA_ID });
    transport.reply(cancelCommand, { kind: "Accepted" });
    await cancel;
    expect(store.getItem(MEDIA_ID)).toEqual({ kind: "Absent" });
    transport.reply(enqueueCommand, { kind: "Accepted" });
    await enqueue;
    expect(store.getItem(MEDIA_ID)).toEqual({ kind: "Absent" });
  });
});
