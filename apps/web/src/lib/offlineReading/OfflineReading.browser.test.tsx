import { fireEvent, render, screen, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { decodeOfflineReaderDocument } from "./packageContract";
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
import type { ReaderResumeState } from "@/lib/reader/types";
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
  initialLocator: ReaderResumeState | null = null;
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
                  target: { fragment_id: "018f2e74-5efc-7e2f-8a3a-142857142857" },
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
        target: { fragment_id: "018f2e74-5efc-7e1e-8a3a-142857142857", href_path: "EPUB/chapter-1.xhtml", anchor_id: { kind: "Absent" as const } },
        locations: { text_offset: offset, progression: 0.5, total_progression: 0.5, position: 1 },
        text: { quote: "Read locally", quote_prefix: null, quote_suffix: null },
      };
    }
    return {
      kind: "web" as const,
      target: { fragment_id: "018f2e74-5efc-7e2f-8a3a-142857142857" },
      locations: { text_offset: offset, progression: 0.5, total_progression: 0.5, position: 1 },
      text: { quote: "local copy", quote_prefix: null, quote_suffix: null },
    };
  }

  private positionedSnapshot(kind: "Pdf" | "Epub" | "WebArticle", offset: number) {
    return { state: "Positioned" as const, revision: 2, locator: this.locator(kind, offset) };
  }

  private openProgress(kind: "Pdf" | "Epub" | "WebArticle") {
    if (this.initialLocator !== null) return { kind: "Canonical" as const, snapshot: { state: "Positioned" as const, revision: 2, locator: this.initialLocator } };
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
    const validWeb = JSON.parse(contractVector().readerDocuments.find((document) => document.id === "web-text-only")!.utf8);
    const validEpub = JSON.parse(contractVector().readerDocuments.find((document) => document.id === "epub-with-local-asset")!.utf8);
    for (const candidate of [
      { ...validWeb, fragments: [] },
      { ...validWeb, fragments: [{ ...validWeb.fragments[0], htmlSanitized: '<img src="assets/local.png">' }, validWeb.fragments[1]] },
      { ...validEpub, fragments: [{ ...validEpub.fragments[0], html_sanitized: "<!-- hidden --><p>Read locally.</p>" }] },
    ]) expect(() => decodeOfflineReaderDocument(JSON.stringify(candidate))).toThrow();
    const emptyText = decodeOfflineReaderDocument(JSON.stringify({
      ...validEpub,
      navigation: {
        ...validEpub.navigation,
        fragments: [{ ...validEpub.navigation.fragments[0], char_count: 0 }],
        sections: validEpub.navigation.sections.map((section: { extent: { value: { start: unknown; end: { fragment_id: string } } } }) => ({
          ...section, extent: { kind: "Present", value: { ...section.extent.value, end: { ...section.extent.value.end, offset: 0 } } },
        })),
      },
      fragments: [{ ...validEpub.fragments[0], html_sanitized: "", canonical_text: "", char_count: 0, word_count: 0, asset_paths: [] }],
    }));
    expect(emptyText.kind).toBe("Epub");
    if (emptyText.kind === "Epub") expect(emptyText.fragments[0]!.word_count).toBe(0);
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

  it("uses exact canonical geometry for map jumps, return, reflow and trusted offline saves", async () => {
    await page.viewport(640, 800);
    const boundary = new NativeReadingBoundary();
    const fragmentId = "018f2e74-5efc-7e1e-8a3a-142857142857";
    // Independent source arithmetic: 4 + (320 * 6 - 1) + 1 = 1924.
    // The image adds layout height and zero canonical characters; the wolf is one codepoint.
    const canonical = `one\n${"alpha ".repeat(320).trim()}\ntwo\nexact 🐺 destination\n${"omega ".repeat(80).trim()}`;
    expect(Array.from(canonical)).toHaveLength(2427);
    const source = JSON.parse(contractVector().readerDocuments.find((entry) => entry.id === "epub-with-local-asset")!.utf8);
    source.fragments[0] = {
      ...source.fragments[0],
      html_sanitized: `<h2>one</h2><p>${"alpha ".repeat(320).trim()}</p><img src="assets/cover.svg" width="320" height="400" alt="source image"><h2>two</h2><p>exact 🐺 destination</p><p>${"omega ".repeat(80).trim()}</p>`,
      canonical_text: canonical, char_count: 2427, word_count: 405,
    };
    source.navigation.fragments[0].char_count = 2427;
    source.navigation.sections = [
      { section_id: "one", anchor_id: { kind: "Absent" }, label: "chapter one", parent_section_id: { kind: "Absent" }, source: "Publisher", target: { fragment_id: fragmentId, offset: 0 }, extent: { kind: "Present", value: { start: { fragment_id: fragmentId, offset: 0 }, end: { fragment_id: fragmentId, offset: 1924 } } } },
      { section_id: "two", anchor_id: { kind: "Absent" }, label: "chapter two", parent_section_id: { kind: "Absent" }, source: "Publisher", target: { fragment_id: fragmentId, offset: 1924 }, extent: { kind: "Present", value: { start: { fragment_id: fragmentId, offset: 1924 }, end: { fragment_id: fragmentId, offset: 2427 } } } },
    ];
    source.navigation.toc_nodes = [
      { id: "one", label: "chapter one", section_id: { kind: "Present", value: "one" }, children: [] },
      { id: "two", label: "chapter two", section_id: { kind: "Present", value: "two" }, children: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(source), { status: 200 })));
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Plane Notes EPUB" }));
    const viewport = await screen.findByTestId("document-viewport");
    Object.assign(viewport.style, { height: "240px", maxHeight: "240px", width: "380px", overflowY: "auto" });
    await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const originalTop = viewport.scrollTop;
    await userEvent.click(screen.getByRole("button", { name: "document map" }));
    await userEvent.click(screen.getByRole("button", { name: "chapter two" }));
    const heading = screen.getByRole("heading", { name: "two" });
    await vi.waitFor(() => {
      const target = heading.getBoundingClientRect();
      const window = viewport.getBoundingClientRect();
      expect(target.top).toBeGreaterThanOrEqual(window.top);
      expect(target.bottom).toBeLessThan(window.bottom);
    });
    expect(boundary.savedLocators).toHaveLength(0);
    await userEvent.click(await screen.findByRole("button", { name: "return to reading position" }));
    await vi.waitFor(() => expect(Math.abs(viewport.scrollTop - originalTop)).toBeLessThanOrEqual(1));
    expect(boundary.savedLocators).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "chapter two" }));
    await screen.findByRole("button", { name: "return to reading position" });
    // Leave one native arrow step before the known chapter glyph. The oracle
    // below checks the actual glyph against the browser's reading line.
    const prepared = new Promise<void>((resolve) => viewport.addEventListener("scrollend", () => resolve(), { once: true }));
    viewport.scrollTop -= 40;
    await prepared;
    viewport.focus();
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(boundary.savedLocators).toHaveLength(1));
    expect(boundary.savedLocators[0], "offline reading must persist the exact canonical source offset").toMatchObject({
      kind: "epub",
      target: { fragment_id: fragmentId, anchor_id: { kind: "Absent" } },
      locations: { text_offset: 1924 },
      text: { quote: expect.stringContaining("exact 🐺 destination") },
    });
    const headingText = document.createRange();
    headingText.selectNodeContents(heading);
    const readingLine = viewport.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(viewport).scrollPaddingTop);
    expect(headingText.getBoundingClientRect().bottom).toBeGreaterThan(readingLine);
    expect(headingText.getBoundingClientRect().top).toBeLessThan(viewport.getBoundingClientRect().bottom);
    const precedingText = document.createRange();
    precedingText.selectNodeContents(screen.getByText("alpha ".repeat(320).trim()));
    expect(precedingText.getBoundingClientRect().bottom).toBeLessThanOrEqual(readingLine);
    expect(screen.queryByRole("button", { name: "return to reading position" })).not.toBeInTheDocument();
    const headingTop = heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.style.width = "520px";
    await vi.waitFor(() => expect(Math.abs(heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top - headingTop), "reflow must retain the exact source anchor").toBeLessThanOrEqual(1));
    fireEvent.scroll(viewport);
    expect(boundary.savedLocators).toHaveLength(1);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(boundary.savedLocators.at(-1)).toMatchObject({ locations: { text_offset: 2427 } }));
    expect(screen.getByRole("button", { name: "Current position, 100% through document" })).toBeVisible();
    const savesAtEnd = boundary.savedLocators.length;
    viewport.style.width = "420px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    fireEvent.scroll(viewport);
    expect(boundary.savedLocators).toHaveLength(savesAtEnd);
    expect(screen.getByRole("button", { name: "Current position, 100% through document" })).toBeVisible();
    await userEvent.keyboard("{PageUp}");
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Current position, 100% through document" })).not.toBeInTheDocument());
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => {
      expect(boundary.savedLocators.length).toBeGreaterThan(savesAtEnd);
      expect(boundary.savedLocators.at(-1)).toMatchObject({ locations: { text_offset: 2427 } });
    });
    boundary.rejectNextSave = true;
    await userEvent.keyboard("{PageUp}");
    expect(await screen.findByText(/could not be stored on this device/u)).toBeVisible();
    const beforeNoScrollEnd = boundary.savedLocators.length;
    Object.assign(viewport.style, { height: "auto", maxHeight: "none" });
    await page.viewport(640, 4000);
    await vi.waitFor(() => expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight));
    await screen.findByText("document 0%");
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => {
      expect(boundary.savedLocators).toHaveLength(beforeNoScrollEnd + 1);
      expect(boundary.savedLocators.at(-1)).toMatchObject({ locations: { text_offset: 2427 } });
    });
    expect(viewport.scrollTop).toBe(0);
    controller.dispose();
    view.unmount();
  });

  it.each(["", "later text"])("restores distinct image-only source anchors with canonical tail %j", async (tail) => {
    await page.viewport(390, 720);
    const boundary = new NativeReadingBoundary();
    const source = JSON.parse(contractVector().readerDocuments.find((entry) => entry.id === "epub-with-local-asset")!.utf8);
    const fragment = source.fragments[0];
    Object.assign(fragment, {
      html_sanitized: `<figure id="first" role="img" aria-label="first plate">${"<br>".repeat(30)}</figure><figure id="second" role="img" aria-label="second plate">${"<br>".repeat(30)}</figure><p>${tail}</p>`,
      canonical_text: tail, char_count: tail.length, word_count: tail ? 2 : 0, asset_paths: [],
    });
    source.navigation.fragments[0].char_count = tail.length;
    source.navigation.sections = ["first", "second"].map((id) => ({
      section_id: id, anchor_id: { kind: "Present", value: id }, label: `${id} illustration`,
      parent_section_id: { kind: "Absent" }, source: "Publisher",
      target: { fragment_id: fragment.fragment_id, offset: 0 },
      extent: { kind: "Present", value: { start: { fragment_id: fragment.fragment_id, offset: 0 }, end: { fragment_id: fragment.fragment_id, offset: 0 } } },
    }));
    source.navigation.toc_nodes = ["first", "second"].map((id) => ({ id, label: `${id} illustration`, section_id: { kind: "Present", value: id }, children: [] }));
    boundary.initialLocator = {
      kind: "epub", target: { fragment_id: fragment.fragment_id, href_path: fragment.href_path, anchor_id: { kind: "Present", value: "second" } },
      locations: { text_offset: null, progression: null, total_progression: null, position: null },
      text: { quote: null, quote_prefix: null, quote_suffix: null },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(source), { status: 200 })));
    const controller = new OfflineReadingControllerRuntime(boundary);
    const view = render(<OfflineReadingShelf controller={controller} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Plane Notes EPUB" }));
    const viewport = await screen.findByTestId("document-viewport");
    await vi.waitFor(() => {
      expect(viewport.clientHeight, "offline reading must own a bounded inner viewport").toBeGreaterThan(0);
      expect(viewport.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    });
    const bodyScroll = window.scrollY;
    await vi.waitFor(() => {
      const target = screen.getByRole("img", { name: "second plate" }).getBoundingClientRect();
      const window = viewport.getBoundingClientRect();
      expect(target.top).toBeGreaterThanOrEqual(window.top - 1);
      expect(target.top).toBeLessThan(window.bottom);
    });
    const originalTop = viewport.scrollTop;
    await userEvent.click(screen.getByRole("button", { name: "document map" }));
    expect(screen.getByText(tail ? "position unavailable" : "text position unavailable")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "first illustration" }));
    await vi.waitFor(() => {
      const target = screen.getByRole("img", { name: "first plate" }).getBoundingClientRect();
      const window = viewport.getBoundingClientRect();
      expect(target.top).toBeGreaterThanOrEqual(window.top - 1);
      expect(target.top).toBeLessThan(window.bottom);
    });
    await userEvent.click(await screen.findByRole("button", { name: "return to reading position" }));
    await vi.waitFor(() => expect(Math.abs(viewport.scrollTop - originalTop)).toBeLessThanOrEqual(1));
    expect(window.scrollY, "offline reading must keep the page fixed during source navigation").toBe(bodyScroll);
    expect(boundary.savedLocators).toHaveLength(0);
    controller.dispose();
    view.unmount();
  });

  it("rejects ambiguous source anchors and preserves departure and excursion when arrival or return fails", async () => {
    await page.viewport(640, 800);
    const boundary = new NativeReadingBoundary();
    const source = JSON.parse(contractVector().readerDocuments.find((entry) => entry.id === "epub-with-local-asset")!.utf8);
    const ids = ["018f2e74-5efc-7e1e-8a3a-142857142857", "018f2e74-5efc-7e1e-8a3a-142857142858", "018f2e74-5efc-7e1e-8a3a-142857142859"];
    source.fragments = ids.map((id, index) => ({
      ...source.fragments[0], fragment_id: id, fragment_idx: index, href_path: `EPUB/plate-${index}.xhtml`,
      html_sanitized: `${"<br>".repeat(30)}<figure id="plate">${index === 1 ? `<a href="#" data-nexus-fragment-id="${ids[2]}" data-nexus-anchor-id="plate">ambiguous source</a>` : ""}<span role="img" aria-label="plate ${index}">${"<br>".repeat(30)}</span></figure>${index === 2 ? '<a name="plate"></a>' : ""}`,
      canonical_text: index === 1 ? "ambiguous source" : "", char_count: index === 1 ? 16 : 0, word_count: index === 1 ? 2 : 0, document_word_start: index === 2 ? 2 : 0, asset_paths: [],
    }));
    source.navigation.fragments = ids.map((id, index) => ({ fragment_id: id, fragment_idx: index, char_count: index === 1 ? 16 : 0 }));
    source.navigation.sections = ids.map((id, index) => ({
      section_id: `plate-${index}`, label: `illustration ${index}`, anchor_id: index === 2 ? { kind: "Absent" } : { kind: "Present", value: "plate" },
      parent_section_id: { kind: "Absent" }, source: "Publisher", target: { fragment_id: id, offset: 0 },
      extent: { kind: "Present", value: { start: { fragment_id: id, offset: 0 }, end: { fragment_id: id, offset: index === 1 ? 16 : 0 } } },
    }));
    source.navigation.toc_nodes = ids.map((_, index) => ({ id: `plate-${index}`, label: `illustration ${index}`, section_id: { kind: "Present", value: `plate-${index}` }, children: [] }));
    boundary.initialLocator = {
      kind: "epub", target: { fragment_id: ids[0]!, href_path: "EPUB/plate-0.xhtml", anchor_id: { kind: "Present", value: "plate" } },
      locations: { text_offset: null, progression: null, total_progression: null, position: null },
      text: { quote: null, quote_prefix: null, quote_suffix: null },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(source), { status: 200 })));
    const controller = new OfflineReadingControllerRuntime(boundary);
    const reader = (height: number | null) => <><style>{`[data-testid="document-viewport"] { height: ${height === null ? "auto" : `${height}px`} !important; max-height: ${height === null ? "none" : `${height}px`} !important; width: 380px; overflow-y: auto; }`}</style><OfflineReadingShelf controller={controller} /></>;
    const view = render(reader(240));
    await userEvent.click(await screen.findByRole("button", { name: "Open Plane Notes EPUB" }));
    await vi.waitFor(() => expect(screen.getByTestId("document-viewport").scrollTop).toBeGreaterThan(100));
    const originalTop = screen.getByTestId("document-viewport").scrollTop;
    await userEvent.click(screen.getByRole("button", { name: "document map" }));
    await userEvent.click(screen.getByRole("button", { name: "illustration 1" }));
    await screen.findByRole("img", { name: "plate 1" });
    await screen.findByRole("button", { name: "return to reading position" });
    const previewTop = screen.getByTestId("document-viewport").scrollTop;
    await userEvent.click(screen.getByRole("link", { name: "ambiguous source" }));
    await screen.findByText("The exact destination is unavailable in this rendered copy.");
    await screen.findByRole("img", { name: "plate 1" });
    await vi.waitFor(() => expect(Math.abs(screen.getByTestId("document-viewport").scrollTop - previewTop)).toBeLessThanOrEqual(1));
    expect(screen.getByRole("button", { name: "return to reading position" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "illustration 1" }));
    await vi.waitFor(() => expect(screen.queryByText("The exact destination is unavailable in this rendered copy.")).not.toBeInTheDocument());
    view.rerender(reader(null));
    await page.viewport(640, 4000);
    await vi.waitFor(() => {
      const viewport = screen.getByTestId("document-viewport");
      expect(viewport.clientHeight).toBeGreaterThanOrEqual(viewport.scrollHeight);
    });
    await userEvent.click(screen.getByRole("button", { name: "return to reading position" }));
    await screen.findByText("The exact destination is unavailable in this rendered copy.");
    await screen.findByRole("img", { name: "plate 1" });
    expect(screen.getByRole("button", { name: "return to reading position" })).toBeVisible();
    await page.viewport(640, 800);
    view.rerender(reader(240));
    await vi.waitFor(() => {
      const viewport = screen.getByTestId("document-viewport");
      expect(viewport.clientHeight).toBe(240);
      const source = screen.getByRole("link", { name: "ambiguous source" }).getBoundingClientRect();
      expect(source.top, "passive reflow must keep the same source glyph visible").toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
      expect(source.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    });
    await userEvent.click(screen.getByRole("button", { name: "return to reading position" }));
    await screen.findByRole("img", { name: "plate 0" });
    await vi.waitFor(() => expect(Math.abs(screen.getByTestId("document-viewport").scrollTop - originalTop)).toBeLessThanOrEqual(1));
    expect(screen.queryByRole("button", { name: "return to reading position" })).not.toBeInTheDocument();
    expect(boundary.savedLocators).toHaveLength(0);
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
        return new Response(reader.utf8, {
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
    await userEvent.click(screen.getByRole("button", { name: "document map" }));
    await userEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(await screen.findByText("Fragment stays exact.")).toBeVisible();
    expect(boundary.savedLocators).toHaveLength(0);
    const webMediaId = contractVector().validPackages.find(
      (candidate) => candidate.package.manifest.mediaKind === "WebArticle",
    )!.package.manifest.mediaId;
    boundary.emitConflict(webMediaId, false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(screen.queryByRole("button", { name: "Use saved location from Nexus" })).not.toBeInTheDocument();
    boundary.emitConflict(webMediaId, true);
    expect(await screen.findByRole("button", { name: "Use saved location from Nexus" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep this device's location" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^https:\/\/appassets\.androidplatform\.net\/nexus-offline\/lease\//u);

    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    await userEvent.click(screen.getByRole("button", { name: "Open Plane Notes EPUB" }));
    await userEvent.click(await screen.findByRole("button", { name: "document map" }));
    expect(within(screen.getByRole("navigation", { name: "Map scope" })).getByRole("button", { name: "Chapter 1" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Opening" }));
    expect(boundary.savedLocators).toHaveLength(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.startsWith("https://appassets.androidplatform.net/nexus-offline/lease/"))).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    view.unmount();
    boundary.progressMode = "Pending";
    controller = new OfflineReadingControllerRuntime(boundary);
    view = render(<OfflineReadingShelf controller={controller} />);
    expect(await screen.findByText("Signal on the Train")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(await screen.findByTestId("document-viewport")).toBeVisible();
    expect(boundary.savedLocators).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Downloads" }));

    boundary.progressMode = "Conflict";
    await userEvent.click(screen.getByRole("button", { name: "Open Signal on the Train" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/different saved locations/u);
    await userEvent.click(
      screen.getByRole("button", { name: "Keep this device's location" }),
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
