import {
  unicodeMetadata as unicode,
  unicodeMembers as unicodeWire,
  epubMetadata as epub,
  epubMembers as epubWire,
  pdfMetadata as pdf,
  pdfMembers as pdfWire,
} from "./__tests__/readerFixtures";
import "pdfjs-dist/web/pdf_viewer.css";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadingCommand, ReadingSnapshot } from "./contract";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import type { ReaderResumeState } from "@/lib/reader/types";
import {
  OfflineReadingProvider,
  useOfflineReadingCapability,
} from "./OfflineReadingProvider";
import {
  OfflineReadingControllerRuntime,
  type OfflineReadingTransport,
} from "./runtime";
import { createWebKitOfflineReadingTransport } from "./transport";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import OfflineReadingShelf from "@/offline-reading/OfflineReadingShelf";

const ACCOUNT = "018f2e74-5efc-7d9e-8a3a-142857142857";
const LEASE = "018f2e74-5efc-7d8e-8a3a-142857142857";
const BASE =
  "https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/";
const packages = [
  {
    metadata: unicode,
    wire: unicodeWire,
    kind: "WebArticle" as const,
    encoding: "utf8",
  },
  { metadata: epub, wire: epubWire, kind: "Epub" as const, encoding: "utf8" },
  { metadata: pdf, wire: pdfWire, kind: "Pdf" as const, encoding: "base64" },
];
const SOURCE = { kind: "Publication" as const, reader_generation: 7 };
const EMPTY = {
  kind: "Canonical" as const,
  snapshot: { state: "Empty" as const, revision: 0 },
};
function webLocator(offset: 0 | 7): ReaderResumeState {
  return {
    kind: "web",
    target: { fragment_id: unicode.fragment_id },
    locations: {
      text_offset: offset,
      progression: offset / 10,
      total_progression: offset / 10,
      position: 1,
    },
    text: {
      quote: offset === 0 ? "café 🧠" : "cat",
      quote_prefix: null,
      quote_suffix: null,
    },
  };
}
const CONFLICT: ReaderProgressView = {
  kind: "Conflict",
  source: SOURCE,
  canonical: {
    state: "Positioned",
    source: SOURCE,
    revision: 31,
    locator: webLocator(0),
  },
  device: webLocator(7),
};

// This external native peer serves the actual frozen producer members and the
// existing one-document connection/lease protocol. No Nexus collaborator is replaced.
class NativeReadingBoundary implements OfflineReadingTransport {
  #listener: ((message: unknown) => void) | null = null;
  #connected = false;
  selected = packages[0]!;
  progress: ReaderProgressView = EMPTY;
  rejectNextSave = false;
  rejectNextChoice = false;
  readonly saved: ReadingCommand[] = [];
  readonly choices: ReadingCommand[] = [];
  readonly leaseCommands: string[] = [];
  readonly hostedCommands: string[] = [];
  #snapshot: ReadingSnapshot;

  constructor(empty = false) {
    this.#snapshot = {
      binding: {
        kind: "Present",
        value: { accountId: ACCOUNT, authorizationRequired: false },
      },
      networkPolicy: "UnmeteredOnly",
      items: empty
        ? []
        : packages.map(({ metadata, kind }) => ({
            mediaId: metadata.manifest.mediaId,
            title: metadata.manifest.title,
            mediaKind: kind,
            availability: {
              kind: "Ready",
              sizeBytes: metadata.manifest.entries.reduce(
                (n, entry) => n + entry.sizeBytes,
                0,
              ),
              installedAt: "2026-08-13T10:00:00Z",
              readerGeneration: 7,
              readerRevisionKey: metadata.manifest.readerRevisionKey,
              progress: EMPTY,
            },
          })),
    };
  }
  start(listener: (message: unknown) => void) {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = null;
    };
  }
  emitOpenRequest(mediaId: string) {
    this.#listener?.({
      protocolVersion: 1,
      event: { kind: "OpenReadingRequested", mediaId },
    });
  }
  emitProgress(progress: ReaderProgressView) {
    this.progress = progress;
    this.#snapshot = {
      ...this.#snapshot,
      items: this.#snapshot.items.map((item) =>
        item.mediaId === this.selected.metadata.manifest.mediaId &&
        item.availability.kind === "Ready"
          ? { ...item, availability: { ...item.availability, progress } }
          : item,
      ),
    };
    this.#listener?.({
      protocolVersion: 1,
      event: { kind: "SnapshotChanged", snapshot: this.#snapshot },
    });
  }
  async fetch(input: RequestInfo | URL): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(BASE))
      throw new Error("Downloaded reader attempted a hosted request");
    const key = url.slice(BASE.length);
    const encoded = (this.selected.wire.members as Record<string, string>)[key];
    if (encoded === undefined) return new Response("missing", { status: 404 });
    const body =
      this.selected.encoding === "base64"
        ? Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(encoded);
    const entry = this.selected.metadata.manifest.entries.find(
      (entry) => entry.path === key,
    );
    return new Response(body, {
      headers: {
        "Content-Type": entry?.mediaType ?? "application/json",
        "Content-Length": String(body.length),
      },
    });
  }
  send(command: ReadingCommand) {
    let outcome: unknown;
    switch (command.kind) {
      case "ConnectOffline":
        outcome = this.#connected
          ? { kind: "Rejected", code: "Busy" }
          : { kind: "Connected", snapshot: this.#snapshot };
        this.#connected = true;
        break;
      case "OpenReading": {
        const selected = packages.find(
          (item) => item.metadata.manifest.mediaId === command.mediaId,
        );
        if (selected === undefined) throw new Error("Fixture media missing");
        this.selected = selected;
        this.leaseCommands.push(`Open:${command.mediaId}`);
        this.emitProgress(this.progress);
        outcome = {
          kind: "OpenedReading",
          leaseId: LEASE,
          readerGeneration: 7,
          readerRevisionKey: selected.metadata.manifest.readerRevisionKey,
          readerUrl: `${BASE}descriptor.json`,
          installedAt: "2026-08-13T10:00:00Z",
          progress: this.progress,
        };
        break;
      }
      case "CloseReading":
        this.leaseCommands.push(`Close:${command.leaseId}`);
        outcome = { kind: "Accepted" };
        break;
      case "SaveReaderProgress":
        this.saved.push(command);
        if (this.rejectNextSave) {
          this.rejectNextSave = false;
          outcome = { kind: "Rejected", code: "Failed" };
        } else {
          this.progress = {
            kind: "Pending",
            source: SOURCE,
            baseline: { state: "Empty", revision: 0 },
            device: command.locator,
          };
          outcome = {
            kind: "ReaderProgressSaved",
            result: { kind: "DurablyPending", view: this.progress },
          };
        }
        break;
      case "ResolveReaderProgress":
        this.choices.push(command);
        if (this.rejectNextChoice) {
          this.rejectNextChoice = false;
          outcome = { kind: "Rejected", code: "Busy" };
        } else {
          if (command.expected.kind !== "Conflict")
            throw new Error("Choice lost its actual native conflict");
          this.progress =
            command.choice === "Canonical"
              ? { kind: "Canonical", snapshot: command.expected.canonical }
              : {
                  kind: "Pending",
                  source: SOURCE,
                  baseline: command.expected.canonical,
                  device: command.expected.device,
                };
          outcome = {
            kind: "ReaderProgressSaved",
            result:
              this.progress.kind === "Canonical"
                ? this.progress
                : { kind: "DurablyPending", view: this.progress },
          };
        }
        break;
      case "OpenHosted":
        this.hostedCommands.push(command.kind);
        outcome = { kind: "Accepted" };
        break;
      case "LogoutAndPurge":
        this.#snapshot = {
          ...this.#snapshot,
          binding: { kind: "Absent" },
          items: [],
        };
        outcome = { kind: "Accepted" };
        break;
      case "GetSnapshot":
        outcome = { kind: "Snapshot", snapshot: this.#snapshot };
        break;
      default:
        throw new Error(`Unexpected fixture command ${command.kind}`);
    }
    queueMicrotask(() =>
      this.#listener?.({
        protocolVersion: 1,
        requestId: command.requestId,
        outcome,
      }),
    );
  }
}

async function openShelf(boundary: NativeReadingBoundary) {
  const controller = new OfflineReadingControllerRuntime(boundary);
  await controller.connect("Offline");
  const view = render(
    <ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}>
      <OfflineReadingShelf controller={controller} />
    </ResourceCacheProvider>,
  );
  return { controller, view };
}
afterEach(() => vi.unstubAllGlobals());

describe("downloaded publication composition", () => {
  it("keeps failed native saves visible and resolves the exact source conflict selected by the reader", async () => {
    const boundary = new NativeReadingBoundary();
    vi.stubGlobal("fetch", boundary.fetch.bind(boundary));
    const { controller, view } = await openShelf(boundary);
    await userEvent.click(
      await screen.findByRole("button", {
        name: `Open ${unicode.manifest.title}`,
      }),
    );
    expect(await screen.findByText("café 🧠")).toBeVisible();
    boundary.rejectNextSave = true;
    await userEvent.click(
      await screen.findByRole("button", { name: "cat" }),
    );
    expect(
      await screen.findByText(/could not be stored on this device/),
    ).toBeVisible();
    expect(boundary.saved[0]).toMatchObject({
      readerGeneration: 7,
      locator: {
        kind: "web",
        target: { fragment_id: unicode.fragment_id },
        locations: { text_offset: 7 },
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "cat" }),
    );
    expect(
      await screen.findByText("Position saved on this device"),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const choice of ["Canonical", "Device"] as const) {
      boundary.emitProgress(CONFLICT);
      const label =
        choice === "Canonical"
          ? "Use saved location from Nexus"
          : "Keep this device's location";
      const button = await screen.findByRole("button", {
        name: label,
      });
      if (choice === "Canonical") {
        boundary.rejectNextChoice = true;
        await userEvent.click(button);
        expect(
          await screen.findByText(/could not be stored on this device/),
        ).toBeVisible();
        expect(
          screen.getByRole("button", { name: label }),
        ).toBeVisible();
      }
      await userEvent.click(button);
      await vi.waitFor(() =>
        expect(
          boundary.choices.at(-1),
          "native conflict choice lost the displayed source or selected side",
        ).toMatchObject({
          kind: "ResolveReaderProgress",
          choice,
          expected: CONFLICT,
          readerGeneration: 7,
          readerRevisionKey: unicode.manifest.readerRevisionKey,
        }),
      );
      await expect
        .element(screen.queryByRole("button", { name: label }))
        .not.toBeInTheDocument();
      // The chosen saved location must resolve inside this downloaded copy:
      // its part stays mounted and no location notice is raised.
      await vi.waitFor(() =>
        expect(
          within(
            screen.getByRole("region", { name: "Document reading area" }),
          ).getByText(choice === "Canonical" ? "café 🧠" : "cat"),
        ).toBeVisible(),
      );
      expect(screen.queryByText(/saved location is unavailable/)).toBeNull();
      expect(screen.queryByText(/does not contain that location/)).toBeNull();
    }
    for (const kind of ["ContentChanged", "SourceUnavailable"] as const) {
      boundary.emitProgress({
        kind,
        source: SOURCE,
        baseline: { state: "Empty", revision: 0 },
        device: webLocator(7),
      });
      expect(
        await screen.findByText(
          kind === "ContentChanged"
            ? /A newer source version exists/
            : /source was deleted or is unavailable/,
        ),
      ).toBeVisible();
      if (kind === "ContentChanged")
        expect(
          screen.getByRole("button", { name: "Continue reading" }),
        ).toBeVisible();
    }
    view.unmount();
    controller.dispose();
  });

  it("reads the downloaded fragment continuously and shows its packaged figure", async () => {
    const boundary = new NativeReadingBoundary();
    vi.stubGlobal("fetch", boundary.fetch.bind(boundary));
    const { controller, view } = await openShelf(boundary);
    await userEvent.click(
      await screen.findByRole("button", {
        name: `Open ${unicode.manifest.title}`,
      }),
    );
    const reading = await screen.findByRole("region", {
      name: "Document reading area",
    });
    expect(await within(reading).findByText("café 🧠")).toBeVisible();
    // The next unit of the same fragment arrives from reading, not a button.
    expect(
      await within(reading).findByText("cat"),
      "the downloaded fragment stopped at its first unit",
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Next part" })).toBeNull();
    expect(
      within(reading).getByRole("img", { name: "red pixel" }),
      "the packaged figure rendered without its archived member",
    ).toHaveAttribute("src", `${BASE}assets/web/0123456789abcdef`);
    view.unmount();
    controller.dispose();
  });

  it("closes the actual lease before an app link opens the retained epub source", async () => {
    const boundary = new NativeReadingBoundary();
    vi.stubGlobal("fetch", boundary.fetch.bind(boundary));
    const { controller, view } = await openShelf(boundary);
    await userEvent.click(
      await screen.findByRole("button", {
        name: `Open ${unicode.manifest.title}`,
      }),
    );
    expect(await screen.findByText("café 🧠")).toBeVisible();
    boundary.emitOpenRequest(epub.manifest.mediaId);
    await vi.waitFor(() =>
      expect(boundary.leaseCommands).toEqual([
        `Open:${unicode.manifest.mediaId}`,
        `Close:${LEASE}`,
        `Open:${epub.manifest.mediaId}`,
      ]),
    );
    expect(
      await screen.findByRole("button", { name: /Chapter\s+One/u }),
    ).toBeVisible();
    view.unmount();
    controller.dispose();
  });

  it("renders the real retained pdf and returns keyboard focus to its downloaded row", async () => {
    const boundary = new NativeReadingBoundary();
    vi.stubGlobal("fetch", boundary.fetch.bind(boundary));
    const { controller, view } = await openShelf(boundary);
    const button = await screen.findByRole("button", {
      name: `Open ${pdf.manifest.title}`,
    });
    await userEvent.click(button);
    expect(await screen.findByText("Page 1 of 1")).toBeVisible();
    expect(await screen.findByText("Retained PDF source")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Downloads" }),
    );
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Open ${pdf.manifest.title}`,
        }),
      ).toHaveFocus(),
    );
    view.unmount();
    controller.dispose();
  });

  it("keeps an empty shelf local and makes sign-out confirmation keyboard-contained", async () => {
    const boundary = new NativeReadingBoundary(true);
    vi.stubGlobal("fetch", () => {
      throw new Error("Empty shelf attempted network I/O");
    });
    const { controller, view } = await openShelf(boundary);
    expect(
      await screen.findByRole("heading", {
        name: "Nothing downloaded for offline reading",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await vi.waitFor(() =>
      expect(boundary.hostedCommands).toEqual(["OpenHosted"]),
    );
    const trigger = screen.getByRole("button", {
      name: "Remove offline data and sign out",
    });
    trigger.focus();
    await userEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", {
        name: "Remove all offline data and sign out?",
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove data and sign out" }),
    );
    expect(await screen.findByText("Offline data removed")).toBeVisible();
    expect(screen.getByText(/Reconnect to Nexus to sign in/)).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
    view.unmount();
    controller.dispose();
  });

  it("shows a typed local read failure and leaves a usable return action", async () => {
    const boundary = new NativeReadingBoundary();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("gone", { status: 404 })),
    );
    const { controller, view } = await openShelf(boundary);
    await userEvent.click(
      await screen.findByRole("button", {
        name: `Open ${unicode.manifest.title}`,
      }),
    );
    expect(
      await screen.findByText(/This downloaded copy could not be opened/),
    ).toBeVisible();
    expect(screen.queryByText("Opening verified copy…")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Back to downloads" }),
    );
    expect(
      await screen.findByRole("button", {
        name: `Open ${unicode.manifest.title}`,
      }),
    ).toBeVisible();
    view.unmount();
    controller.dispose();
  });
});

describe("offline reading bridge framing", () => {
  it("surfaces every framing failure instead of dropping or passing it through", () => {
    const port = {
      onmessage: null as ((event: { readonly data: unknown }) => void) | null,
      postMessage: vi.fn(),
    };
    const transport = createWebKitOfflineReadingTransport({
      nexusOfflineReading: port,
    });
    expect(transport).not.toBeNull();
    const messages: unknown[] = [];
    const defects: Error[] = [];
    const stop = transport!.start(
      (message) => messages.push(message),
      (error) => defects.push(error),
    );

    port.onmessage!({ data: { protocolVersion: 1 } });
    port.onmessage!({ data: '{"protocolVersion":1,"protocolVersion":1}' });
    port.onmessage!({ data: `{"pad":"${"x".repeat(70_000)}"}` });
    port.onmessage!({ data: '{"protocolVersion":1}' });

    expect(messages).toEqual([{ protocolVersion: 1 }]);
    expect(defects).toHaveLength(3);
    expect(defects[1]!.message).toMatch(/Duplicate JSON key/u);
    expect(defects[2]!.message).toMatch(/64-KiB/u);
    stop();
  });

  it("refuses to post a command larger than the shared 64-KiB frame bound", () => {
    const port = {
      onmessage: null as ((event: { readonly data: unknown }) => void) | null,
      postMessage: vi.fn(),
    };
    const transport = createWebKitOfflineReadingTransport({
      nexusOfflineReading: port,
    })!;
    expect(() =>
      transport.send({
        kind: "Enqueue",
        protocolVersion: 1,
        requestId: "018f2e74-5efc-7d8e-8a3a-142857142857",
        mediaId: "018f2e74-5efc-7d0d-8a3a-142857142857",
        readerGeneration: 1,
        requestedTitle: "x".repeat(70_000),
        mediaKind: "Pdf",
      }),
    ).toThrow(/64-KiB/u);
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("settles the pending request and reports a defect when a reply cannot be decoded", async () => {
    class MalformedBoundary implements OfflineReadingTransport {
      #listener: ((message: unknown) => void) | null = null;

      start(listener: (message: unknown) => void) {
        this.#listener = listener;
        return () => {
          this.#listener = null;
        };
      }

      send(command: ReadingCommand) {
        queueMicrotask(() =>
          this.#listener?.({
            protocolVersion: 1,
            requestId: command.requestId,
            outcome: { kind: "NotAReplyKind" },
          }),
        );
      }
    }

    const controller = new OfflineReadingControllerRuntime(
      new MalformedBoundary(),
    );
    const defects: Error[] = [];
    controller.subscribeDefect((error) => defects.push(error));

    await expect(controller.connect("Offline")).rejects.toThrow(
      /Unsupported offline reading reply/u,
    );
    expect(defects).toHaveLength(1);
    expect(controller.getSnapshot()).toBeNull();
    controller.dispose();
  });
});

describe("hosted offline reading capability", () => {
  const HOSTED_ACCOUNT = "018f2e74-5efc-7d9e-8a3a-142857142857";
  const OTHER_ACCOUNT = "018f2e74-5efc-7d9e-8a3a-142857142858";

  class HostedBoundary implements OfflineReadingTransport {
    #listener: ((message: unknown) => void) | null = null;
    readonly connects: string[] = [];
    outcome: (requestId: string) => unknown;

    constructor(
      boundAccountId: string | null,
      rejectCode: string | null = null,
    ) {
      this.outcome = () =>
        rejectCode !== null
          ? { kind: "Rejected", code: rejectCode }
          : {
              kind: "Connected",
              snapshot: {
                binding:
                  boundAccountId === null
                    ? { kind: "Absent" }
                    : {
                        kind: "Present",
                        value: {
                          accountId: boundAccountId,
                          authorizationRequired: false,
                        },
                      },
                networkPolicy: "UnmeteredOnly",
                items: [],
              },
            };
    }

    start(listener: (message: unknown) => void) {
      this.#listener = listener;
      return () => {
        this.#listener = null;
      };
    }

    send(command: ReadingCommand) {
      if (command.kind === "ConnectHosted")
        this.connects.push(command.requestId);
      queueMicrotask(() =>
        this.#listener?.({
          protocolVersion: 1,
          requestId: command.requestId,
          outcome: this.outcome(command.requestId),
        }),
      );
    }
  }

  function CapabilityProbe() {
    const capability = useOfflineReadingCapability();
    return <p data-testid="reading-capability">{capability.kind}</p>;
  }

  it("keeps the workspace mounted and degrades when the hosted connect is rejected", async () => {
    // A rolled-back server, an expired WebView session or a device that is
    // simply offline replies Rejected. Installed copies must stay readable and
    // the workspace must stay mounted.
    const boundary = new HostedBoundary(null, "AuthorizationRequired");
    const view = render(
      <FeedbackProvider>
        <OfflineReadingProvider accountId={HOSTED_ACCOUNT} transport={boundary}>
          <p>Workspace</p>
          <CapabilityProbe />
        </OfflineReadingProvider>
      </FeedbackProvider>,
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("reading-capability")).toHaveTextContent(
        "Unavailable",
      ),
    );
    expect(screen.getByText("Workspace")).toBeVisible();
    expect(
      (
        await screen.findAllByText(
          /Reconnect to Nexus to authorize offline downloads/u,
        )
      ).length,
    ).toBeGreaterThan(0);
    view.unmount();
  });

  it("refuses a snapshot bound to another account", async () => {
    const boundary = new HostedBoundary(OTHER_ACCOUNT);
    const view = render(
      <FeedbackProvider>
        <OfflineReadingProvider accountId={HOSTED_ACCOUNT} transport={boundary}>
          <CapabilityProbe />
        </OfflineReadingProvider>
      </FeedbackProvider>,
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("reading-capability")).toHaveTextContent(
        "Unavailable",
      ),
    );
    view.unmount();
  });

  it("re-attests the native binding when the hosted account changes", async () => {
    const boundary = new HostedBoundary(HOSTED_ACCOUNT);
    const view = render(
      <FeedbackProvider>
        <OfflineReadingProvider accountId={HOSTED_ACCOUNT} transport={boundary}>
          <CapabilityProbe />
        </OfflineReadingProvider>
      </FeedbackProvider>,
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId("reading-capability")).toHaveTextContent(
        "Ready",
      ),
    );
    expect(boundary.connects).toHaveLength(1);

    const switched = new HostedBoundary(OTHER_ACCOUNT);
    view.rerender(
      <FeedbackProvider>
        <OfflineReadingProvider accountId={OTHER_ACCOUNT} transport={switched}>
          <CapabilityProbe />
        </OfflineReadingProvider>
      </FeedbackProvider>,
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId("reading-capability")).toHaveTextContent(
        "Ready",
      ),
    );
    expect(switched.connects).toHaveLength(1);
    view.unmount();
  });
});
