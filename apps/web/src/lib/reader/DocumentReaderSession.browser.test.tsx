import { useEffect, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReaderContentBoundary from "@/components/reader/ReaderContentBoundary";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession, type DocumentReaderSession } from "./DocumentReaderSession";
import { useDocumentReaderSession } from "./useDocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";
import { parseReaderResumeState, readerResumeStatesEqual, type ReaderResumeState } from "./types";
import { expectRecord } from "@/lib/validation";

let hostedAccountId = crypto.randomUUID();
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

type ReaderFormatCase = {
  readonly kind: "web_article" | "epub" | "pdf";
  readonly expectedDocument: string;
  readonly expectedRestore: string;
};

const FORMAT_CASES: readonly ReaderFormatCase[] = [
  {
    kind: "web_article",
    expectedDocument: "WebArticle:Restored paragraph",
    expectedRestore: "web:33333333-3333-4333-8333-333333333333",
  },
  {
    kind: "epub",
    expectedDocument: "Epub:Chapter two",
    expectedRestore: "epub:chapter-2",
  },
  {
    kind: "pdf",
    expectedDocument: "Pdf:/api/media/11111111-1111-4111-8111-111111111111/reader-publications/1/assets/document.pdf",
    expectedRestore: "pdf:7",
  },
];

function locatorFor(candidate: ReaderFormatCase): ReaderResumeState {
  if (candidate.kind === "pdf") {
    return {
      kind: "pdf",
      page: 7,
      page_progression: 0.25,
      zoom: null,
      position: 7,
    };
  }
  const locations = {
    text_offset: 0,
    progression: 0,
    total_progression: 0,
    position: 1,
  };
  const text = { quote: null, quote_prefix: null, quote_suffix: null };
  return candidate.kind === "epub"
    ? {
        kind: "epub",
        target: {
          section_id: "chapter-2",
          href_path: "chapter-2.xhtml",
          anchor_id: null,
        },
        locations,
        text,
      }
    : {
        kind: "web",
        target: { fragment_id: "33333333-3333-4333-8333-333333333333" },
        locations,
        text,
      };
}

function describeLocator(locator: ReaderResumeState | null): string {
  return locator === null ? "none" : locator.kind === "pdf" ? `pdf:${locator.page}`
    : locator.kind === "epub" ? `epub:${locator.target.section_id}`
      : locator.kind === "web" ? `web:${locator.target.fragment_id}` : "none";
}

function json(data: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify({ data }));
  return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
}

async function member(key: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { bytes, hash, ref: { key, bytes: bytes.byteLength,
    sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") } };
}
function representation(value: Awaited<ReturnType<typeof member>>, generation: number): Response {
  return new Response(value.bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(value.bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...value.hash))}:`, "X-Nexus-Reader-Generation": String(generation),
  } });
}

let hostedRequestCounts = new Map<string, number>();
async function installHostedReader(candidate: ReaderFormatCase, options: {
  emptyProgress?: boolean; readerStateFailures?: number; malformedReaderState?: boolean;
} = {}) {
  hostedRequestCounts = new Map();
  const accountId = crypto.randomUUID();
  hostedAccountId = accountId;
  const faults = { readerStateFailures: options.readerStateFailures ?? 0, malformedReaderState: options.malformedReaderState ?? false, generation: 1,
    revision: options.emptyProgress ? 0 : 3, locator: options.emptyProgress ? null : locatorFor(candidate) };
  const publications = await Promise.all([1, 2].map(async (generation) => {
    const units = await Promise.all([0, 1].map(async (ordinal) => {
      const text = candidate.kind === "epub" ? ordinal === 0 ? "Chapter one" : "Chapter two" : ordinal === 0 ? "Opening paragraph" : "Restored paragraph";
      const canonicalText = generation === 2 ? `${text} replaced` : text;
      return member(`units/${ordinal}.json`, {
        fragment_id: ordinal === 0 ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
        fragment_idx: ordinal, fragment_document_start_cp: ordinal === 0 ? 0 : 32, fragment_length_cp: canonicalText.length,
        document_word_start: ordinal * 2, starts_in_word: false,
        epub_target: candidate.kind === "epub" ? { section_id: `chapter-${ordinal + 1}`, href_path: `chapter-${ordinal + 1}.xhtml`, anchor_id: null } : null,
        document_embeds: [], start_cp: 0, end_cp: canonicalText.length, render_start_cp: 0, render_end_cp: canonicalText.length,
        canonical_text: canonicalText, word_boundaries: [0, canonicalText.length], assets: [], table_contexts: [],
        render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] }, { kind: "Text", parent: 0, text: canonicalText }],
      });
    }));
    const descriptor = await member("descriptor.json", {
      media_id: MEDIA_ID, reader_generation: generation, reader_contract_version: 1, title: "Reader proof", kind: candidate.kind,
      ...(candidate.kind === "pdf" ? { document_asset_ref: { key: "assets/document.pdf", bytes: 10, sha256: "0".repeat(64) }, page_count: 12 }
        : { first_unit_ref: units[0]!.ref, contents_ref: null, table_metadata_ref: null,
          index_ref: { key: "index/0.json", bytes: 1, sha256: "0".repeat(64) }, unit_count: 2, canonical_length: 64 }),
    });
    return { units, descriptor };
  }));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const path = new URL(request?.url ?? String(input), window.location.origin).pathname;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    hostedRequestCounts.set(`${method} ${path}`, (hostedRequestCounts.get(`${method} ${path}`) ?? 0) + 1);
    if (path.endsWith("/reader-publication")) return representation(publications[faults.generation - 1]!.descriptor, faults.generation);
    if (path.endsWith("/offline-reader-state")) {
      if (method === "GET" && faults.malformedReaderState) return json({ state: "Unmodeled" });
      if (method === "GET" && faults.readerStateFailures > 0) {
        faults.readerStateFailures -= 1;
        return new Response("Synthetic upstream failure", { status: 502 });
      }
      if (method === "PUT") {
        const body = expectRecord(JSON.parse(String(init?.body)), "reader write");
        expect(body.baseRevision).toBe(faults.revision);
        expect(body.expectedReaderGeneration).toBe(faults.generation);
        const locator = parseReaderResumeState(body.locator);
        if (locator === null) throw new Error("The reader submitted an invalid locator");
        if (!readerResumeStatesEqual(locator, faults.locator)) faults.revision += 1;
        faults.locator = locator;
      }
      return json({ accountId, readerGeneration: faults.generation, cursor: faults.locator === null
        ? { state: "Empty", revision: faults.revision }
        : { state: "Positioned", source: { kind: "Publication", reader_generation: faults.generation },
          revision: faults.revision, locator: faults.locator } });
    }
    const selected = path.match(/\/reader-publications\/(\d+)\/(.*)$/);
    if (selected !== null) {
      const generation = Number(selected[1]); const publication = publications[generation - 1];
      if (publication === undefined) throw new Error(`Unexpected generation: ${generation}`);
      if (selected[2] === "resolve") {
        const target = JSON.parse(String(init?.body)).target;
        const ordinal = target.kind === "Unit" ? target.unit_key === "units/0.json" ? 0 : 1
          : target.kind === "Navigation" ? target.target_id === "chapter-1" ? 0 : 1
          : target.locator.target.fragment_id === "22222222-2222-4222-8222-222222222222" || target.locator.target.section_id === "chapter-1" ? 0 : 1;
        const unit = publication.units[ordinal]!;
        const fields = { unit_ref: unit.ref, ordinal, previous_ref: ordinal === 0 ? null : publication.units[0]!.ref,
          next_ref: ordinal === 0 ? publication.units[1]!.ref : null,
          fragment_id: ordinal === 0 ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333" };
        return json(target.kind === "Unit"
          ? { kind: "Unit", ...fields, start_cp: 0, end_cp: JSON.parse(new TextDecoder().decode(unit.bytes)).end_cp }
          : { kind: "Text", ...fields, locator: target.kind === "Locator" ? target.locator : locatorFor(candidate), offset_cp: 0, local_offset_cp: 0 });
      }
      const unit = publication.units.find((unit) => unit.ref.key === selected[2]);
      if (unit !== undefined) return representation(unit, generation);
    }
    throw new Error(`Unexpected hosted reader request: ${method} ${path}`);
  });
  return faults;
}

function readerOwner() {
  const runtime = new HostedReaderProgressRuntime(hostedAccountId, () => {});
  const source = createHostedReaderSource({ accountId: hostedAccountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY });
  const session = createDocumentReaderSession({ mediaId: MEDIA_ID, source, progress: runtime.createPort(MEDIA_ID), capacity: READER_CAPACITY });
  return { session, close() { session.close(); runtime.close(); } };
}

function ProductionCompositionHarness({ candidate, initialEpubSectionId = null }: {
  candidate: ReaderFormatCase; initialEpubSectionId?: string | null;
}) {
  const [owner, setOwner] = useState<ReturnType<typeof readerOwner> | null>(null);
  useEffect(() => { const acquired = readerOwner(); setOwner(acquired); return () => acquired.close(); }, []);
  return owner === null ? <p>Loading reader</p> : <Reader session={owner.session} candidate={candidate} initialEpubSectionId={initialEpubSectionId} />;
}
function Reader({ session, candidate, initialEpubSectionId }: {
  session: DocumentReaderSession; candidate: ReaderFormatCase; initialEpubSectionId: string | null;
}) {
  const [readable, setReadable] = useState(true);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const composition = useDocumentReaderSession({ session, loadCacheKey: readable ? `session:${candidate.kind}` : null,
    initialTargets: { fresh: null, cold: initialEpubSectionId === null ? null : { kind: "Navigation", target_id: initialEpubSectionId } },
    retireUnits: () => true,
    progress: {
      capability: readable ? { state: "Readable", mediaId: MEDIA_ID, locatorKind: candidate.kind === "pdf" ? "pdf" : candidate.kind === "epub" ? "epub" : "web" } : { state: "Unavailable" },
      isPaneActive: true, handleUnauthenticatedError: () => false, reportDefect: (error) => { throw error; },
      captureCurrentLocator: () => null, applyCursor: async () => "applied", onTerminalWriteAcknowledged: () => {}, previewLease: { isActive: () => false },
    },
    ...(candidate.kind === "pdf" ? { pdf: { sourceCacheKey: "selected-pdf", sourceRefreshToken: 0 } } : {}),
  });
  const snapshot = composition.progress.initialSnapshot;
  const locator = snapshot?.state === "Positioned" ? snapshot.locator : null;
  const restored = describeLocator(locator);
  return <main>
    <p>progress:{composition.progress.status}</p><p>revision:{snapshot?.revision ?? "none"}</p>
    <p>text:{composition.unitRequest.status}</p><p>pdf-document:{composition.pdfDocument.status}</p>
    <ReaderContentBoundary defect={composition.contentDefect} ready={composition.units.length > 0} retry={composition.retryUnit}>
      {composition.units.map((item) => <p key={item.address.unit_ref.key}>{candidate.kind === "epub" ? "Epub" : "WebArticle"}:{item.unit.canonical_text}</p>)}
      {composition.pdfDocument.status === "ready" ? <p>Pdf:{composition.pdfDocument.data.url}</p> : null}
      <p>{restored}</p>
    </ReaderContentBoundary>
    <button onClick={() => {
      if (locator === null) return;
      const moved = locator.kind === "pdf" ? { ...locator, page_progression: 0.5 }
        : { ...locator, locations: { ...locator.locations, text_offset: 1 } };
      void session.progress.capture(MEDIA_ID, moved).then(() => session.progress.flush(MEDIA_ID)).then((saved) => {
        if (saved.kind === "Canonical" && saved.snapshot.state === "Positioned") setSavedRevision(saved.snapshot.revision);
      });
    }}>Save position</button>
    <p>{savedRevision === null ? "Not saved" : `Saved revision ${savedRevision}`}</p>
    <button onClick={() => setReadable((value) => !value)}>Toggle capability</button>
  </main>;
}

afterEach(() => vi.unstubAllGlobals());

describe("hosted DocumentReaderSession format and restore parity", () => {
  for (const candidate of FORMAT_CASES) {
    it(`loads ${candidate.kind} content and its canonical restore locator`, async () => {
      const server = await installHostedReader(candidate);
      render(<ProductionCompositionHarness candidate={candidate} />);
      expect(await screen.findByText(candidate.expectedDocument)).toBeVisible();
      // Content and canonical progress settle in separate commits; the saved
      // revision below is only reachable once the restore locator is published.
      expect(await screen.findByText(candidate.expectedRestore)).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Save position" }));
      expect(await screen.findByText("Saved revision 4")).toBeVisible();
      const initial = locatorFor(candidate);
      expect(server.locator, "reader write lost the exact moved locator").toEqual(initial.kind === "pdf"
        ? { ...initial, page_progression: 0.5 }
        : { ...initial, locations: { ...initial.locations, text_offset: 1 } });
    });
  }
  it("loads an explicit cold EPUB target once when canonical progress is empty", async () => {
    const candidate = FORMAT_CASES[1]!;
    await installHostedReader(candidate, { emptyProgress: true });
    render(<ProductionCompositionHarness candidate={candidate} initialEpubSectionId="chapter-2" />);
    expect(await screen.findByText("Epub:Chapter two")).toBeVisible();
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-publications/1/units/0.json`) ?? 0).toBe(0);
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-publications/1/units/1.json`)).toBe(1);
  });
  for (const candidate of FORMAT_CASES) {
    it(`production composition owns initial ${candidate.kind} progress and source wiring`, async () => {
      await installHostedReader(candidate);
      render(<ProductionCompositionHarness candidate={candidate} />);
      expect(await screen.findByText(candidate.expectedDocument)).toBeVisible();
      expect(await screen.findByText("progress:ready")).toBeVisible();
      expect(screen.getByText(candidate.kind === "pdf" ? "text:idle" : "text:ready")).toBeVisible();
      expect(screen.getByText(candidate.kind === "pdf" ? "pdf-document:ready" : "pdf-document:idle")).toBeVisible();
      expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-publication`)).toBe(1);
      expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/offline-reader-state`)).toBe(1);
    });
  }
  it("recovers progress and content together when the composed load succeeds on a retryable attempt", async () => {
    const candidate = FORMAT_CASES[0]!;
    await installHostedReader(candidate, { readerStateFailures: 1 });
    render(<ProductionCompositionHarness candidate={candidate} />);
    expect(await screen.findByText(candidate.expectedDocument, {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByText("progress:ready")).toBeVisible();
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/offline-reader-state`)).toBe(2);
  });
  it("recovers an exhausted composed read through its reader boundary", async () => {
    const candidate = FORMAT_CASES[0]!;
    const faults = await installHostedReader(candidate, { readerStateFailures: Number.MAX_SAFE_INTEGER });
    render(<ProductionCompositionHarness candidate={candidate} />);
    expect(await screen.findByText("The reader couldn’t load this part.", {}, { timeout: 4000 })).toBeVisible();
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/offline-reader-state`)).toBe(3);
    faults.readerStateFailures = 0;
    await userEvent.click(screen.getByRole("button", { name: "Retry reader" }));
    expect(await screen.findByText(candidate.expectedDocument, {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByText("progress:ready")).toBeVisible();
  }, 20_000);
  it("re-reads canonical progress when the same capability is re-established", async () => {
    const candidate = FORMAT_CASES[0]!;
    const server = await installHostedReader(candidate);
    render(<ProductionCompositionHarness candidate={candidate} />);
    expect(await screen.findByText("revision:3")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Toggle capability" }));
    expect(await screen.findByText("progress:loading")).toBeVisible();
    server.revision = 4;
    await userEvent.click(screen.getByRole("button", { name: "Toggle capability" }));
    await waitFor(() => expect(screen.queryByText("revision:3")).not.toBeInTheDocument());
    expect(await screen.findByText("progress:ready")).toBeVisible();
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/offline-reader-state`) ?? 0).toBeGreaterThanOrEqual(2);
  });
  it("publishes a malformed same-system payload as a reader defect with a reachable retry", async () => {
    const candidate = FORMAT_CASES[0]!;
    const faults = await installHostedReader(candidate, { malformedReaderState: true });
    render(<ProductionCompositionHarness candidate={candidate} />);
    expect(await screen.findByText("The reader couldn’t load this part.", {}, { timeout: 4000 })).toBeVisible();
    expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/offline-reader-state`)).toBe(1);
    faults.malformedReaderState = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry reader" }));
    expect(await screen.findByText(candidate.expectedDocument)).toBeVisible();
  });
  it("keeps exact EPUB members in the selected generation and selects replacements only on reopen", async () => {
    const candidate = FORMAT_CASES[1]!;
    const faults = await installHostedReader(candidate);
    const owner = readerOwner();
    const nextOwner = readerOwner();
    const signal = new AbortController().signal;
    try {
      await owner.session.load(signal, { fresh: null, cold: null });
      const read = async (session: DocumentReaderSession) => {
        const address = await session.resolve({ kind: "Unit", unit_key: "units/1.json" }, signal);
        if (address.kind !== "Unit") throw new Error("Expected the exact selected unit");
        const acquired = session.acquireUnit(address);
        if (acquired.kind !== "Acquired") throw new Error("Expected an admitted unit");
        try {
          const result = await acquired.lease.promise;
          if (result.kind !== "Unit") throw new Error("Expected the selected unit bytes");
          return result.unit.canonical_text;
        } finally { acquired.lease.release(); }
      };
      expect(await read(owner.session)).toBe("Chapter two");
      faults.generation = 2;
      expect(await read(owner.session), "current alias substituted the open reader's exact source").toBe("Chapter two");
      expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-publications/1/units/1.json`)).toBe(1);
      await nextOwner.session.load(signal, { fresh: null, cold: null });
      expect(await read(nextOwner.session)).toBe("Chapter two replaced");
    } finally { owner.close(); nextOwner.close(); }
  });
  it("keeps PDF asset access bound to the selected generation across explicit opens", async () => {
    const candidate = FORMAT_CASES[2]!;
    const faults = await installHostedReader(candidate);
    const owner = readerOwner();
    const signal = new AbortController().signal;
    try {
      await owner.session.load(signal, { fresh: null, cold: null });
      const first = await owner.session.openPdf(signal);
      faults.generation = 2;
      expect(await owner.session.openPdf(signal)).toEqual(first);
      expect(first.url).toContain("/reader-publications/1/assets/document.pdf");
      expect(hostedRequestCounts.get(`GET /api/media/${MEDIA_ID}/reader-publication`)).toBe(1);
    } finally { owner.close(); }
  });
});
