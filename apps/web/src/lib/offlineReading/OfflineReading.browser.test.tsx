import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeOfflineReaderDocument, offlineEpubSection } from "./packageContract";
import {
  type ReadingCommand,
  type ReadingSnapshot,
} from "./contract";
import { OfflineReaderSource } from "./OfflineReaderAdapters";
import { OfflineReadingProvider, useOfflineReadingCapability } from "./OfflineReadingProvider";
import {
  OfflineReadingControllerRuntime,
  type OfflineReadingTransport,
} from "./runtime";
import { createWebKitOfflineReadingTransport } from "./transport";
import type { OpenedOfflineReading } from "./runtime";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import OfflineReadingShelf from "@/offline-reading/OfflineReadingShelf";
import reviewedContractVector from "../../../../../testdata/offline-reading-contract-v1.json";

const LEASE_READER_URL =
  "https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/reader.json";

function leasedCopy(): OpenedOfflineReading {
  return {
    leaseId: "018f2e74-5efc-7d8e-8a3a-142857142857",
    readerGeneration: 1,
    readerRevisionKey: "a".repeat(64),
    readerUrl: LEASE_READER_URL,
    progress: { kind: "Canonical", snapshot: { state: "Empty", revision: 0 } },
    installedAt: "2026-08-13T10:00:00Z",
  };
}

interface ContractVector {
  readonly readerDocuments: readonly {
    readonly id: string;
    readonly utf8: string;
    readonly package?: string;
    readonly expect: { readonly kind: "Accept" | "Reject" };
  }[];
  readonly validPackages: readonly {
    readonly name: string;
    readonly package: {
      readonly manifest: {
        readonly mediaId: string;
        readonly mediaKind: "Pdf" | "Epub" | "WebArticle";
        readonly title: string;
        readonly readerGeneration: number;
        readonly readerRevisionKey: string;
        readonly entries: readonly { readonly path: string }[];
      };
    };
    readonly presentation: {
      readonly downloadedCopyLabel: string;
      readonly webTextOnlyNotice?: string;
    };
  }[];
  readonly invalidPackageCases: readonly {
    readonly name: string;
    readonly base: string;
    readonly patch: readonly {
      readonly op: string;
      readonly path: string;
      readonly value?: unknown;
    }[];
  }[];
}

function contractVector(): ContractVector {
  return reviewedContractVector as ContractVector;
}

function twoPagePdf(): Blob {
  const first = "BT\n/F1 18 Tf\n72 720 Td\n(Offline PDF one) Tj\nET\n";
  const second = "BT\n/F1 18 Tf\n72 720 Td\n(Offline PDF two) Tj\nET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${first.length} >>\nstream\n${first}endstream`,
    `<< /Length ${second.length} >>\nstream\n${second}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n%NEXUS\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset = body.length;
  body += "xref\n0 8\n0000000000 65535 f \n";
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Blob([body], { type: "application/pdf" });
}

class NativeReadingBoundary implements OfflineReadingTransport {
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #packages = contractVector().validPackages;
  readonly savedLocators: unknown[] = [];
  readonly resolvedChoices: string[] = [];
  readonly leaseCommands: string[] = [];
  readonly hostedCommands: string[] = [];
  openedMediaKind: "Pdf" | "Epub" | "WebArticle" | null = null;
  rejectNextSave = false;
  progressMode: "Snapshot" | "Pending" | "Conflict" | "ContentChanged" | "SourceUnavailable" = "Snapshot";
  #snapshot: ReadingSnapshot = {
    binding: {
      kind: "Present" as const,
      value: {
        accountId: "018f2e74-5efc-7d9e-8a3a-142857142857",
        authorizationRequired: false,
      },
    },
    networkPolicy: "UnmeteredOnly" as const,
    items: this.#packages.map(({ package: { manifest } }, index) => ({
      mediaId: manifest.mediaId,
      title: manifest.title,
      mediaKind: manifest.mediaKind,
      availability: {
        kind: "Ready" as const,
        sizeBytes: 1024 + index,
        installedAt: "2026-08-13T10:00:00Z",
        readerGeneration: manifest.readerGeneration,
        readerRevisionKey: manifest.readerRevisionKey,
        progress:
          index === 2
            ? {
                kind: "Pending" as const,
                baseline: { state: "Empty" as const, revision: 0 },
                device: {
                  kind: "web" as const,
                  target: { fragment_id: "intro" },
                  locations: {
                    text_offset: 0,
                    progression: 0,
                    total_progression: 0,
                    position: 1,
                  },
                  text: { quote: null, quote_prefix: null, quote_suffix: null },
                },
              }
            : {
                kind: "Canonical" as const,
                snapshot: { state: "Empty" as const, revision: 0 },
              },
      },
    })),
  };

  constructor(startEmpty = false) {
    if (startEmpty) {
      this.#snapshot = { ...this.#snapshot, items: [] };
    }
  }

  start(listener: (message: unknown) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitConflict(mediaId: string, matchingLease: boolean) {
    const manifest = this.#packages.find(
      (candidate) => candidate.package.manifest.mediaId === mediaId,
    )?.package.manifest;
    if (manifest === undefined) throw new Error("fixture media is absent");
    this.#snapshot = {
      ...this.#snapshot,
      items: this.#snapshot.items.map((item) => item.mediaId === mediaId && item.availability.kind === "Ready"
        ? {
            ...item,
            availability: {
              ...item.availability,
              readerGeneration: matchingLease
                ? manifest.readerGeneration
                : manifest.readerGeneration + 1,
              readerRevisionKey: manifest.readerRevisionKey,
              progress: {
                kind: "Conflict" as const,
                canonical: this.positionedSnapshot(manifest.mediaKind, 8),
                device: this.locator(manifest.mediaKind, 14),
              },
            },
          }
        : item),
    };
    const event = {
      protocolVersion: 1,
      event: { kind: "SnapshotChanged", snapshot: this.#snapshot },
    };
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  emitAuthorizationRequired() {
    if (this.#snapshot.binding.kind !== "Present") return;
    this.#snapshot = {
      ...this.#snapshot,
      binding: {
        kind: "Present",
        value: { ...this.#snapshot.binding.value, authorizationRequired: true },
      },
    };
    const event = {
      protocolVersion: 1,
      event: { kind: "SnapshotChanged", snapshot: this.#snapshot },
    };
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  emitOpenRequest(mediaId: string) {
    const event = {
      protocolVersion: 1,
      event: { kind: "OpenReadingRequested", mediaId },
    };
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  send(command: ReadingCommand) {
    let outcome: unknown;
    if (command.kind === "ConnectOffline") {
      outcome = { kind: "Connected", snapshot: this.#snapshot };
    } else if (command.kind === "OpenReading") {
      this.leaseCommands.push(`Open:${command.mediaId}`);
      const item = this.#packages.find(
        ({ package: { manifest } }) => manifest.mediaId === command.mediaId,
      );
      if (!item) throw new Error("fixture media is absent");
      this.openedMediaKind = item.package.manifest.mediaKind;
      const progress = this.openProgress(item.package.manifest.mediaKind);
      this.#snapshot = {
        ...this.#snapshot,
        items: this.#snapshot.items.map((candidate) =>
          candidate.mediaId === command.mediaId && candidate.availability.kind === "Ready"
            ? {
                ...candidate,
                availability: { ...candidate.availability, progress },
              }
            : candidate,
        ),
      };
      const event = {
        protocolVersion: 1,
        event: { kind: "SnapshotChanged", snapshot: this.#snapshot },
      };
      queueMicrotask(() => {
        for (const listener of this.#listeners) listener(event);
      });
      outcome = {
        kind: "OpenedReading",
        leaseId: "018f2e74-5efc-7d8e-8a3a-142857142857",
        readerGeneration: item.package.manifest.readerGeneration,
        readerRevisionKey: item.package.manifest.readerRevisionKey,
        readerUrl:
          "https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/reader.json",
        progress,
        installedAt: "2026-08-13T10:00:00Z",
      };
    } else if (command.kind === "CloseReading") {
      this.leaseCommands.push(`Close:${command.leaseId}`);
      outcome = { kind: "Accepted" };
    } else if (command.kind === "SaveReaderProgress") {
      if (this.rejectNextSave) {
        this.rejectNextSave = false;
        outcome = { kind: "Rejected", code: "Failed" };
      } else {
        this.savedLocators.push(command.locator);
        outcome = {
          kind: "ReaderProgressSaved",
          result: {
            kind: "DurablyPending",
            view: {
              kind: "Pending",
              baseline: { state: "Empty", revision: 0 },
              device: command.locator,
            },
          },
        };
      }
    } else if (command.kind === "ResolveReaderProgress") {
      this.resolvedChoices.push(command.choice);
      outcome = {
        kind: "ReaderProgressSaved",
        result: command.choice === "Canonical"
          ? {
              kind: "Canonical",
              snapshot: this.positionedSnapshot(this.openedMediaKind ?? "WebArticle", 8),
            }
          : {
              kind: "DurablyPending",
              view: {
                kind: "Pending",
                baseline: { state: "Empty", revision: 0 },
                device: this.locator(this.openedMediaKind ?? "WebArticle", 14),
              },
            },
      };
    } else if (command.kind === "OpenHosted") {
      this.hostedCommands.push(command.kind);
      outcome = { kind: "Accepted" };
    } else if (command.kind === "LogoutAndPurge") {
      this.#snapshot = {
        binding: { kind: "Absent" },
        networkPolicy: this.#snapshot.networkPolicy,
        items: [],
      };
      outcome = { kind: "Accepted" };
    } else if (command.kind === "Remove") {
      this.#snapshot = {
        ...this.#snapshot,
        items: this.#snapshot.items.filter((item) => item.mediaId !== command.mediaId),
      };
      outcome = { kind: "Accepted" };
    } else if (command.kind === "GetSnapshot") {
      outcome = { kind: "Snapshot", snapshot: this.#snapshot };
    } else {
      outcome = { kind: "Accepted" };
    }
    const reply = {
      protocolVersion: 1,
      requestId: command.requestId,
      outcome,
    };
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(reply);
    });
  }

  private locator(kind: "Pdf" | "Epub" | "WebArticle", offset: number) {
    if (kind === "Pdf") {
      return { kind: "pdf" as const, page: 2, page_progression: 0.5, zoom: null, position: 2 };
    }
    if (kind === "Epub") {
      return {
        kind: "epub" as const,
        target: { section_id: "chapter-1", href_path: "EPUB/chapter-1.xhtml", anchor_id: null },
        locations: { text_offset: offset, progression: 0.5, total_progression: 0.5, position: 1 },
        text: { quote: "Read locally", quote_prefix: null, quote_suffix: null },
      };
    }
    return {
      kind: "web" as const,
      target: { fragment_id: "intro" },
      locations: { text_offset: offset, progression: 0.5, total_progression: 0.5, position: 1 },
      text: { quote: "local copy", quote_prefix: null, quote_suffix: null },
    };
  }

  private positionedSnapshot(kind: "Pdf" | "Epub" | "WebArticle", offset: number) {
    return { state: "Positioned" as const, revision: 2, locator: this.locator(kind, offset) };
  }

  private openProgress(kind: "Pdf" | "Epub" | "WebArticle") {
    if (this.progressMode === "Snapshot") {
      return { kind: "Canonical" as const, snapshot: { state: "Empty" as const, revision: 0 } };
    }
    if (this.progressMode === "Conflict") {
      return {
        kind: "Conflict" as const,
        canonical: this.positionedSnapshot(kind, 8),
        device: this.locator(kind, 14),
      };
    }
    return {
      kind: this.progressMode,
      baseline: { state: "Empty" as const, revision: 0 },
      device: this.locator(kind, 14),
    };
  }
}

describe("offline-reading package and shell boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("consumes the shared reader-document vectors with their reviewed verdicts", async () => {
    for (const vector of contractVector().readerDocuments) {
      if (vector.expect.kind === "Accept") {
        expect(decodeOfflineReaderDocument(vector.utf8), vector.id).toBeTruthy();
        continue;
      }
      if (vector.package === undefined) {
        expect(() => decodeOfflineReaderDocument(vector.utf8), vector.id).toThrow();
        continue;
      }
      // Relational reject vectors name the package they belong to. The verdict
      // is decided by the real offline reader source, which loads the package's
      // reader document under the manifest's own media identity: a decode
      // failure and an identity mismatch are both rejections of the product
      // boundary, and neither may be swallowed.
      const packageVector = contractVector().validPackages.find(
        (candidate) => candidate.name === vector.package,
      );
      expect(packageVector, vector.id).toBeTruthy();
      const manifest = packageVector!.package.manifest;
      const source = new OfflineReaderSource(
        manifest.mediaId,
        leasedCopy(),
        async () =>
          new Response(vector.utf8, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      await expect(
        source.loadDescriptor(manifest.mediaId, new AbortController().signal),
        vector.id,
      ).rejects.toThrow();
    }
  });

  it("rejects the shared declared-asset mutation for a text-only web article", () => {
    const mutation = contractVector().invalidPackageCases.find(
      (candidate) => candidate.name === "reject-web-article-declared-local-asset",
    );
    expect(mutation).toBeTruthy();
    const extraEntry = mutation!.patch.find(
      (patch) => patch.op === "add" && patch.path === "/package/manifest/entries/-",
    )?.value as { readonly path: string } | undefined;
    expect(extraEntry?.path).toBe("assets/cover.svg");

    // A downloaded web article is text and semantic structure only: the real
    // decoder must reject a reader document that carries the local asset this
    // shared mutation declares.
    const article = JSON.parse(
      contractVector().readerDocuments.find((document) => document.id === "web-text-only")!.utf8,
    ) as { fragments: Array<Record<string, unknown>> };
    article.fragments[0]!.htmlSanitized =
      `<p>Read locally.</p><img src="${extraEntry!.path}" alt="Cover">`;
    expect(() => decodeOfflineReaderDocument(JSON.stringify(article))).toThrow();
  });

  it("fails closed on relational and sanitizer mutations around the reviewed vectors", () => {
    const validWeb = JSON.parse(
      contractVector().readerDocuments.find((document) => document.id === "web-text-only")!.utf8,
    ) as Record<string, unknown> & {
      fragments: Array<Record<string, unknown>>;
      navigation: Array<Record<string, unknown>>;
    };
    const validEpub = JSON.parse(
      contractVector().readerDocuments.find((document) => document.id === "epub-with-local-asset")!.utf8,
    ) as Record<string, unknown> & {
      sections: Array<Record<string, unknown>>;
      navigation: Array<Record<string, unknown>>;
    };
    const mutated = [
      { ...validWeb, fragments: [] },
      { ...validWeb, navigation: [{ fragmentId: "missing", label: "Missing" }] },
      {
        ...validWeb,
        fragments: [{ ...validWeb.fragments[0], htmlSanitized: '<img src="assets/local.png">' }],
      },
      {
        ...validWeb,
        fragments: [validWeb.fragments[0], { ...validWeb.fragments[0], ordinal: 1 }],
      },
      { ...validEpub, sections: [] },
      {
        ...validEpub,
        sections: [{ ...validEpub.sections[0], endOffset: 9_999 }],
      },
      {
        ...validEpub,
        sections: [{ ...validEpub.sections[0], htmlSanitized: "<!-- hidden --><p>Read locally.</p>", assetPaths: [] }],
      },
      {
        ...validEpub,
        navigation: [{ sectionId: "missing", label: "Missing" }],
      },
    ];
    for (const candidate of mutated) {
      expect(() => decodeOfflineReaderDocument(JSON.stringify(candidate))).toThrow();
    }

    const emptyText = decodeOfflineReaderDocument(JSON.stringify({
      ...validEpub,
      sections: [{
        ...validEpub.sections[0],
        htmlSanitized: "",
        canonicalText: "",
        assetPaths: [],
        startOffset: 0,
        endOffset: 0,
      }],
    }));
    expect(emptyText.kind).toBe("Epub");
    if (emptyText.kind === "Epub") {
      expect(offlineEpubSection(emptyText, "chapter-1").word_count).toBe(0);
    }
  });

  it("closes the active lease before an App Link opens another downloaded copy", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const boundary = new NativeReadingBoundary();
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);
    const packages = contractVector().validPackages;
    const first = packages[0]!.package.manifest;
    const second = packages[1]!.package.manifest;

    expect(await screen.findByText(first.title)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: `Open ${first.title}` }));
    await expect.element(await screen.findByText(/Downloaded copy · saved/u)).toBeVisible();
    boundary.emitOpenRequest(second.mediaId);

    await vi.waitFor(() => expect(boundary.leaseCommands).toEqual([
      `Open:${first.mediaId}`,
      "Close:018f2e74-5efc-7d8e-8a3a-142857142857",
      `Open:${second.mediaId}`,
    ]));
    controller.dispose();
    view.unmount();
  });

  it("returns keyboard focus to the downloaded row after closing its reader", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/document.pdf")) {
        return new Response(twoPagePdf(), { status: 200, headers: { "Content-Type": "application/pdf" } });
      }
      const reader = contractVector().readerDocuments.find((document) => document.id === "pdf-minimal");
      if (!reader) throw new Error("PDF fixture is absent");
      return new Response(reader.utf8, { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const boundary = new NativeReadingBoundary();
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);
    const title = contractVector().validPackages[0]!.package.manifest.title;

    expect(await screen.findByText(title)).toBeVisible();
    const openButton = screen.getByRole("button", { name: `Open ${title}` });
    await userEvent.click(openButton);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: `Open ${title}` })).toHaveFocus());

    controller.dispose();
    view.unmount();
  });

  it("keeps the initial empty shelf honest, local, and reconnectable", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("remote fetch forbidden")));
    vi.stubGlobal("fetch", fetchSpy);
    const boundary = new NativeReadingBoundary(true);
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Nothing downloaded for offline reading",
      }),
    ).toBeVisible();
    expect(screen.getByText(/Reconnect to Nexus to save a document/u)).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await vi.waitFor(() => expect(boundary.hostedCommands).toEqual(["OpenHosted"]));

    controller.dispose();
    view.unmount();
  });

  it("keeps post-sign-out UI honest, keyboard-contained, and reconnectable", async () => {
    const boundary = new NativeReadingBoundary();
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);

    expect(await screen.findByText("Signal on the Train")).toBeVisible();
    const trigger = screen.getByRole("button", { name: "Remove offline data and sign out" });
    trigger.focus();
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Remove all offline data and sign out?",
    });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Remove data and sign out" }));
    expect(await screen.findByText("Offline data removed")).toBeVisible();
    expect(screen.getByText(/Reconnect to Nexus to sign in/u)).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await vi.waitFor(() => expect(boundary.hostedCommands).toEqual(["OpenHosted"]));

    controller.dispose();
    view.unmount();
  });

  it("cold-connects, discloses local-copy limits, opens, and confirms destructive removal", async () => {
    const requests: string[] = [];
    const boundary = new NativeReadingBoundary();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url.endsWith("/document.pdf")) {
          return new Response(twoPagePdf(), { status: 200, headers: { "Content-Type": "application/pdf" } });
        }
        const readerId = boundary.openedMediaKind === "Epub"
          ? "epub-with-local-asset"
          : boundary.openedMediaKind === "Pdf"
            ? "pdf-minimal"
            : "web-text-only";
        const reader = contractVector().readerDocuments.find((document) => document.id === readerId);
        if (!url.startsWith("https://appassets.androidplatform.net/nexus-offline/lease/") || !reader) {
          throw new Error(`Unexpected offline request: ${url}`);
        }
        let readerBody = reader.utf8;
        if (reader.id === "epub-with-local-asset") {
          const epub = JSON.parse(readerBody) as {
            navigation: Array<{ sectionId: string; label: string }>;
            sections: Array<{
              sectionId: string;
              ordinal: number;
              anchorId: string | null;
              startOffset: number;
              endOffset: number;
              htmlSanitized: string;
            }>;
          };
          epub.sections[0]!.htmlSanitized = epub.sections[0]!.htmlSanitized.replace(
            "<p>Read locally.</p>",
            '<a href="#local-end" data-nexus-section-id="chapter-1">Jump within chapter</a><p id="local-end">Read locally.</p>',
          );
          epub.navigation.push({ sectionId: "chapter-2", label: "Chapter 2" });
          epub.sections.push({
            ...epub.sections[0]!,
            sectionId: "chapter-2",
            ordinal: 1,
            anchorId: "local-end",
            startOffset: 10,
            endOffset: 23,
          });
          readerBody = JSON.stringify(epub);
        }
        return new Response(readerBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    let controller = new OfflineReadingControllerRuntime(boundary);
    let view = render(<OfflineReadingShelf controller={controller} />);

    expect(await screen.findByText("Signal on the Train")).toBeVisible();
    await expect
      .element(await screen.findByText("Text-only copy; images not included"))
      .toBeVisible();
    boundary.emitAuthorizationRequired();
    await expect.element(await screen.findByText(/authorize future downloads/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Signal on the Train" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Signal on the Train",
      }),
    ).toBeVisible();
    await expect
      .element(await screen.findByText(/Downloaded copy · saved Aug/))
      .toBeVisible();
    expect(await screen.findByText("A local copy keeps the prose available.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Introduction" }));
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(1));
    expect(boundary.savedLocators[0]).toMatchObject({
      kind: "web",
      target: { fragment_id: "intro" },
      locations: { text_offset: 0 },
    });
    const webMediaId = contractVector().validPackages.find(
      (candidate) => candidate.package.manifest.mediaKind === "WebArticle",
    )!.package.manifest.mediaId;
    boundary.emitConflict(webMediaId, false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(
      screen.queryByRole("button", { name: "Use saved location from Nexus · Introduction" }),
    ).not.toBeInTheDocument();
    boundary.emitConflict(webMediaId, true);
    // TB-11: both spec-quoted choices, qualified by the chapter each side
    // points at, and never phrased as latest/furthest.
    expect(
      await screen.findByRole("button", { name: "Use saved location from Nexus · Introduction" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Keep this device's location · Introduction" }),
    ).toBeVisible();
    boundary.rejectNextSave = true;
    await userEvent.click(screen.getByRole("button", { name: "Introduction" }));
    expect(await screen.findByText(/could not be stored on this device/u)).toBeVisible();
    // Offline search is an explicit non-goal: the shelf reader offers no Find.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const webViewport = screen.getByTestId("document-viewport");
    Object.defineProperties(webViewport, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.scroll(webViewport);
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(2));
    expect(boundary.savedLocators[1]).toMatchObject({
      kind: "web",
      locations: { text_offset: expect.any(Number) },
    });
    expect(
      (boundary.savedLocators[1] as { locations: { text_offset: number } }).locations.text_offset,
    ).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^https:\/\/appassets\.androidplatform\.net\/nexus-offline\/lease\//u);

    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    await userEvent.click(screen.getByRole("button", { name: "Open Plane Notes EPUB" }));
    expect(await screen.findByRole("button", { name: "Chapter 1" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Chapter 2" }));
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(3));
    expect(screen.getByTestId("document-viewport")).toHaveAttribute(
      "data-initial-canonical-offset",
      "10",
    );
    expect(boundary.savedLocators[2]).toMatchObject({
      kind: "epub",
      target: { section_id: "chapter-2", anchor_id: "local-end" },
      locations: { text_offset: 10 },
    });
    await userEvent.click(screen.getByRole("button", { name: "Chapter 1" }));
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(4));
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    await userEvent.click(screen.getByRole("link", { name: "Jump within chapter" }));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(5));
    expect(boundary.savedLocators[4]).toMatchObject({
      kind: "epub",
      target: { section_id: "chapter-1", anchor_id: "local-end" },
      locations: { text_offset: 0 },
    });
    Element.prototype.scrollIntoView = originalScrollIntoView;
    const epubViewport = screen.getByTestId("document-viewport");
    Object.defineProperties(epubViewport, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.scroll(epubViewport);
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(6));
    expect(boundary.savedLocators[5]).toMatchObject({
      kind: "epub",
      target: {
        section_id: "chapter-1",
        href_path: "EPUB/chapter-1.xhtml",
        anchor_id: null,
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.startsWith("https://appassets.androidplatform.net/nexus-offline/lease/"))).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    view.unmount();
    boundary.progressMode = "Pending";
    controller = new OfflineReadingControllerRuntime(boundary);
    view = render(<OfflineReadingShelf controller={controller} />);
    expect(await screen.findByText("Signal on the Train")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(await screen.findByTestId("document-viewport")).toHaveAttribute(
      "data-initial-canonical-offset",
      "14",
    );
    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    boundary.progressMode = "Conflict";
    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/different saved locations/u);
    await userEvent.click(
      screen.getByRole("button", { name: "Keep this device's location · Introduction" }),
    );
    await vi.waitFor(() => expect(boundary.resolvedChoices).toEqual(["Device"]));
    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    boundary.progressMode = "ContentChanged";
    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A newer source version exists. This downloaded copy and its position remain only on this device.",
    );
    expect(screen.getByRole("button", { name: "Continue reading" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove downloaded copy" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    boundary.progressMode = "SourceUnavailable";
    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/deleted or is unavailable/u);
    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    boundary.progressMode = "Pending";
    await userEvent.click(screen.getByRole("button", { name: "Open Plane Notes PDF" }));
    expect(await screen.findByText("Page 2 of 2")).toBeVisible();
    await vi.waitFor(() => expect(requests.some((url) => url.endsWith("/document.pdf"))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    await userEvent.click(screen.getByRole("button", { name: "Remove Signal on the Train" }));
    await expect
      .element(screen.getByText("Remove downloaded copy?"))
      .toBeVisible();
    await expect
      .element(screen.getByText(/discard this device's unsynced position/))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove downloaded copy" }));
    await vi.waitFor(() => expect(screen.queryByText("Signal on the Train")).not.toBeInTheDocument());

    controller.dispose();
    view.unmount();
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

    const controller = new OfflineReadingControllerRuntime(new MalformedBoundary());
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

    constructor(boundAccountId: string | null, rejectCode: string | null = null) {
      this.outcome = () =>
        rejectCode !== null
          ? { kind: "Rejected", code: rejectCode }
          : {
              kind: "Connected",
              snapshot: {
                binding: boundAccountId === null
                  ? { kind: "Absent" }
                  : {
                      kind: "Present",
                      value: { accountId: boundAccountId, authorizationRequired: false },
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
      if (command.kind === "ConnectHosted") this.connects.push(command.requestId);
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
      expect(screen.getByTestId("reading-capability")).toHaveTextContent("Unavailable"),
    );
    expect(screen.getByText("Workspace")).toBeVisible();
    expect(
      (await screen.findAllByText(/Reconnect to Nexus to authorize offline downloads/u)).length,
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
      expect(screen.getByTestId("reading-capability")).toHaveTextContent("Unavailable"),
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
      expect(screen.getByTestId("reading-capability")).toHaveTextContent("Ready"),
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
      expect(screen.getByTestId("reading-capability")).toHaveTextContent("Ready"),
    );
    expect(switched.connects).toHaveLength(1);
    view.unmount();
  });
});

describe("opening a downloaded copy that cannot be read", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows one typed reason with valid actions instead of an endless spinner", async () => {
    // The native lease answers, but the package entry does not verify. TB-04:
    // one typed reason and a valid action; never a permanent "Opening…" state.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const boundary = new NativeReadingBoundary();
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);
    const title = contractVector().validPackages[0]!.package.manifest.title;

    expect(await screen.findByText(title)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: `Open ${title}` }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be opened/u);
    expect(screen.queryByText("Opening verified copy…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Back to downloads" }));
    expect(await screen.findByRole("button", { name: `Open ${title}` })).toBeVisible();

    controller.dispose();
    view.unmount();
  });
});
