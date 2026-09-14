import {
  unicodeMetadata as metadata,
  unicodeMembers as wire,
} from "./__tests__/readerFixtures";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import OfflineReadingShelf from "@/offline-reading/OfflineReadingShelf";
import { createWebKitOfflineReadingTransport } from "./transport";
import type { ReadingCommand, ReadingSnapshot } from "./contract";
import { OfflineReadingControllerRuntime } from "./runtime";

afterEach(() => vi.unstubAllGlobals());

it("keeps the native document connection through effect replay and reads exact publication parts", async () => {
  const base =
    "https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/";
  const saved: ReadingCommand[] = [];
  let nativeState: "Disconnected" | "Connecting" | "Connected" = "Disconnected";
  let connectCount = 0;
  let releaseConnect: (() => void) | null = null;
  const snapshot: ReadingSnapshot = {
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
        mediaId: metadata.manifest.mediaId,
        title: metadata.manifest.title,
        mediaKind: "WebArticle",
        availability: {
          kind: "Ready",
          sizeBytes: 4096,
          installedAt: "2026-08-13T10:00:00Z",
          readerGeneration: metadata.manifest.readerGeneration,
          readerRevisionKey: metadata.manifest.readerRevisionKey,
          progress: {
            kind: "Canonical",
            snapshot: { state: "Empty", revision: 0 },
          },
        },
      },
    ],
  };
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(frame: string) {
      const command = JSON.parse(frame) as ReadingCommand;
      const outcome =
        command.kind === "ConnectOffline"
          ? ++connectCount === 1 && nativeState === "Disconnected"
            ? { kind: "Connected", snapshot }
            : { kind: "Rejected", code: "Busy" }
          : command.kind === "OpenReading"
            ? {
                kind: "OpenedReading",
                leaseId: "018f2e74-5efc-7d8e-8a3a-142857142857",
                readerGeneration: metadata.manifest.readerGeneration,
                readerRevisionKey: metadata.manifest.readerRevisionKey,
                readerUrl: `${base}descriptor.json`,
                installedAt: "2026-08-13T10:00:00Z",
                progress: {
                  kind: "Canonical",
                  snapshot: { state: "Empty", revision: 0 },
                },
              }
            : command.kind === "SaveReaderProgress"
              ? {
                  kind: "ReaderProgressSaved",
                  result: {
                    kind: "DurablyPending",
                    view: {
                      kind: "Pending",
                      source: {
                        kind: "Publication",
                        reader_generation: command.readerGeneration,
                      },
                      baseline: { state: "Empty", revision: 0 },
                      device: command.locator,
                    },
                  },
                }
              : command.kind === "CloseReading"
                ? { kind: "Accepted" }
                : (() => {
                    throw new Error(
                      `Unexpected native command ${command.kind}`,
                    );
                  })();
      if (command.kind === "SaveReaderProgress") saved.push(command);
      // The physical port delivers to its CURRENT handler, including a reply
      // whose requester retired before native reconciliation completed.
      const reply = () =>
        port.onmessage?.({
          data: JSON.stringify({
            protocolVersion: 1,
            requestId: command.requestId,
            outcome,
          }),
        });
      if (command.kind === "ConnectOffline" && outcome.kind === "Connected") {
        nativeState = "Connecting";
        releaseConnect = () => {
          nativeState = "Connected";
          reply();
        };
      } else queueMicrotask(reply);
    },
  };
  const transport = createWebKitOfflineReadingTransport({
    nexusOfflineReading: port,
  });
  if (transport === null) throw new Error("Fixture native port is missing");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(base))
      throw new Error("Downloaded reader attempted a hosted request");
    const body = (wire.members as Record<string, string>)[
      url.slice(base.length)
    ];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).length),
      },
    });
  });
  const controller = new OfflineReadingControllerRuntime(transport);
  const connecting = controller.connect("Offline");
  const view = render(
    <ResourceCacheProvider
      value={{}}
      publicationLimits={READER_CAPACITY.cache}
    >
      <OfflineReadingShelf controller={controller} />
    </ResourceCacheProvider>,
    { reactStrictMode: true },
  );
  expect(
    connectCount,
    "React replay reopened the native document connection",
  ).toBe(1);
  if (releaseConnect === null)
    throw new Error("Native connect was not requested");
  (releaseConnect as () => void)();
  await connecting;
  const open = await screen.findByRole("button", {
    name: `Open ${metadata.manifest.title}`,
  });
  await userEvent.click(open);
  expect(await screen.findByText("café 🧠")).toBeVisible();
  await userEvent.click(
    await screen.findByRole("button", { name: "cat" }),
  );
  await vi.waitFor(() =>
    expect(
      saved,
      "adopted native navigation did not capture its original source position",
    ).toContainEqual(
      expect.objectContaining({
        kind: "SaveReaderProgress",
        readerGeneration: 7,
        locator: expect.objectContaining({
          kind: "web",
          target: { fragment_id: metadata.fragment_id },
          locations: expect.objectContaining({ text_offset: 7 }),
        }),
      }),
    ),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Downloads" }),
  );
  expect(
    await screen.findByRole("button", {
      name: `Open ${metadata.manifest.title}`,
    }),
  ).toHaveFocus();
  view.unmount();
  expect(connectCount).toBe(1);
  controller.dispose();
});

it("keeps a refused local upgrade and removal visible until the native command succeeds", async () => {
  const commands: string[] = [];
  const snapshot: ReadingSnapshot = {
    binding: {
      kind: "Present",
      value: {
        accountId: "018f2e74-5efc-7d9e-8a3a-142857142857",
        authorizationRequired: true,
      },
    },
    networkPolicy: "UnmeteredOnly",
    items: [
      {
        mediaId: metadata.manifest.mediaId,
        title: metadata.manifest.title,
        mediaKind: "WebArticle",
        availability: { kind: "UpgradeRequired" },
      },
    ],
  };
  let refuseRemove = true;
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(frame: string) {
      const command = JSON.parse(frame) as ReadingCommand;
      commands.push(command.kind);
      const outcome =
        command.kind === "ConnectOffline"
          ? { kind: "Connected", snapshot }
          : command.kind === "Retry" ||
              (command.kind === "Remove" && refuseRemove)
            ? { kind: "Rejected", code: "Busy" }
            : command.kind === "Remove"
              ? { kind: "Accepted" }
              : command.kind === "GetSnapshot"
                ? { kind: "Snapshot", snapshot: { ...snapshot, items: [] } }
                : (() => {
                    throw new Error(
                      `Unexpected native command ${command.kind}`,
                    );
                  })();
      queueMicrotask(() =>
        port.onmessage?.({
          data: JSON.stringify({
            protocolVersion: 1,
            requestId: command.requestId,
            outcome,
          }),
        }),
      );
    },
  };
  const transport = createWebKitOfflineReadingTransport({
    nexusOfflineReading: port,
  });
  if (transport === null) throw new Error("Native fixture port missing");
  const controller = new OfflineReadingControllerRuntime(transport);
  await controller.connect("Offline");
  const view = render(
    <ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}>
      <OfflineReadingShelf controller={controller} />
    </ResourceCacheProvider>,
  );
  expect(await screen.findByText(/needs a local update/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: `Open ${metadata.manifest.title}` }),
  ).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Retry" }),
  );
  expect(
    await screen.findByText("Offline reading is busy. Try again in a moment."),
  ).toBeVisible();
  expect(commands).toContain("Retry");
  await userEvent.click(
    screen.getByRole("button", { name: `Remove ${metadata.manifest.title}` }),
  );
  expect(
    await screen.findByText(/discard this device's unsynced position/),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove downloaded copy" }),
  );
  expect(
    await screen.findByText("Offline reading is busy. Try again in a moment."),
  ).toBeVisible();
  expect(
    () => screen.getByRole("dialog"),
    "refused native removal discarded its confirmation",
  ).not.toThrow();
  refuseRemove = false;
  await userEvent.click(
    screen.getByRole("button", { name: "Remove downloaded copy" }),
  );
  await expect.element(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(commands.filter((kind) => kind === "Remove")).toHaveLength(2);
  expect(commands).not.toContain("ConnectHosted");
  view.unmount();
  controller.dispose();
});

it("names which local update a saved copy is waiting on", async () => {
  // One item per unconverted disposition. The three sentences must stay
  // distinguishable: a shelf that collapses them tells a user out of space to
  // wait, and a user whose copy the converter refused to wait forever.
  const snapshot: ReadingSnapshot = {
    binding: {
      kind: "Present",
      value: {
        accountId: "018f2e74-5efc-7d9e-8a3a-142857142857",
        authorizationRequired: false,
      },
    },
    networkPolicy: "AnyConnected",
    items: [
      {
        mediaId: "018f2e74-5efc-7d9e-8a3a-000000000001",
        title: "Converting copy",
        mediaKind: "WebArticle",
        availability: { kind: "UpgradeRequired" },
      },
      {
        mediaId: "018f2e74-5efc-7d9e-8a3a-000000000002",
        title: "Crowded copy",
        mediaKind: "Epub",
        availability: { kind: "UpgradeBlockedByStorage" },
      },
      {
        mediaId: "018f2e74-5efc-7d9e-8a3a-000000000003",
        title: "Refused copy",
        mediaKind: "Pdf",
        availability: { kind: "UpgradeFailed" },
      },
    ],
  };
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(frame: string) {
      const command = JSON.parse(frame) as ReadingCommand;
      if (command.kind !== "ConnectOffline") {
        throw new Error(`Unexpected native command ${command.kind}`);
      }
      queueMicrotask(() =>
        port.onmessage?.({
          data: JSON.stringify({
            protocolVersion: 1,
            requestId: command.requestId,
            outcome: { kind: "Connected", snapshot },
          }),
        }),
      );
    },
  };
  const transport = createWebKitOfflineReadingTransport({
    nexusOfflineReading: port,
  });
  if (transport === null) throw new Error("Native fixture port missing");
  const controller = new OfflineReadingControllerRuntime(transport);
  await controller.connect("Offline");
  const view = render(
    <ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}>
      <OfflineReadingShelf controller={controller} />
    </ResourceCacheProvider>,
  );
  expect(
    await screen.findByText(
      "This saved copy needs a local update before it can open. Your copy and position are preserved.",
    ),
  ).toBeVisible();
  expect(
    await screen.findByText(
      "The local update needs more free space. Your copy and position are preserved.",
    ),
  ).toBeVisible();
  expect(
    await screen.findByText(
      "This app cannot yet update this saved copy. Your copy and position are preserved.",
    ),
  ).toBeVisible();
  for (const title of ["Converting copy", "Crowded copy", "Refused copy"]) {
    expect(
      screen.queryByRole("button", { name: `Open ${title}` }),
      `${title} offered Open without a converted publication`,
    ).toBeNull();
  }
  expect(
    screen.getAllByRole("button", { name: "Retry" }),
    "an unconverted copy lost its retry",
  ).toHaveLength(3);
  view.unmount();
  controller.dispose();
});
