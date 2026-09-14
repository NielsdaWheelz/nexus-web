import { unicodeMetadata as metadata } from "./__tests__/readerFixtures";
import { expect, it } from "vitest";
import {
  OfflineReadingControllerRuntime,
  OfflineReadingRejectedError,
} from "./runtime";
import { createWebKitOfflineReadingTransport } from "./transport";
import type { ReadingCommand } from "./contract";

it("retains an initial native open request until the document consumer subscribes", async () => {
  const mediaId = metadata.manifest.mediaId;
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(frame: string) {
      const command = JSON.parse(frame) as ReadingCommand;
      if (command.kind !== "ConnectOffline")
        throw new Error("Unexpected startup command");
      queueMicrotask(() => {
        port.onmessage?.({
          data: JSON.stringify({
            protocolVersion: 1,
            requestId: command.requestId,
            outcome: {
              kind: "Connected",
              snapshot: {
                binding: {
                  kind: "Present",
                  value: {
                    accountId: "018f2e74-5efc-7d9e-8a3a-142857142857",
                    authorizationRequired: false,
                  },
                },
                networkPolicy: "UnmeteredOnly",
                items: [
                  {
                    mediaId,
                    title: metadata.manifest.title,
                    mediaKind: "WebArticle",
                    availability: {
                      kind: "Ready",
                      sizeBytes: metadata.manifest.entries.reduce(
                        (sum, entry) => sum + entry.sizeBytes,
                        0,
                      ),
                      installedAt: "2026-09-13T00:00:00Z",
                      readerGeneration: metadata.manifest.readerGeneration,
                      readerRevisionKey: metadata.manifest.readerRevisionKey,
                      progress: {
                        kind: "Canonical",
                        snapshot: { state: "Empty", revision: 0 },
                      },
                    },
                  },
                ],
              },
            },
          }),
        });
        port.onmessage?.({
          data: JSON.stringify({
            protocolVersion: 1,
            event: { kind: "OpenReadingRequested", mediaId },
          }),
        });
      });
    },
  };
  const transport = createWebKitOfflineReadingTransport({
    nexusOfflineReading: port,
  });
  if (transport === null) throw new Error("Missing native fixture port");
  const controller = new OfflineReadingControllerRuntime(transport);
  await controller.connect("Offline");
  const opened: string[] = [];
  const stop = controller.subscribeOpenRequest((value) => opened.push(value));
  expect(
    opened,
    "initial native open request was lost before the shelf subscribed",
  ).toEqual([mediaId]);
  stop();
  controller.subscribeOpenRequest((value) => opened.push(value))();
  expect(opened).toEqual([mediaId]);
  const retiredReceiver = port.onmessage;
  controller.dispose();
  retiredReceiver?.({
    data: JSON.stringify({
      protocolVersion: 1,
      event: { kind: "OpenReadingRequested", mediaId },
    }),
  });
  expect(opened).toEqual([mediaId]);
  expect(controller.getSnapshot()).toBeNull();
  expect(port.onmessage).toBeNull();
});

it("publishes a rejected native handshake before the document mounts", async () => {
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(frame: string) {
      const command = JSON.parse(frame) as ReadingCommand;
      queueMicrotask(() =>
        port.onmessage?.({
          data: JSON.stringify({
            protocolVersion: 1,
            requestId: command.requestId,
            outcome: { kind: "Rejected", code: "Busy" },
          }),
        }),
      );
    },
  };
  const transport = createWebKitOfflineReadingTransport({
    nexusOfflineReading: port,
  });
  if (transport === null) throw new Error("Missing native fixture port");
  const controller = new OfflineReadingControllerRuntime(transport);
  await expect(controller.connect("Offline")).rejects.toBeInstanceOf(
    OfflineReadingRejectedError,
  );
  expect(controller.getDefect()).toMatchObject({ code: "Busy" });
  expect(controller.getSnapshot()).toBeNull();
  controller.dispose();
});
