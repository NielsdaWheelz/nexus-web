import { useRef, useState, type CSSProperties } from "react";
import { render, screen } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { READER_CAPACITY, readerCapacityNotice } from "@/lib/reader/readerCapacity";
import { readerPublicationMemberResponse } from "@/lib/reader/readerPublicationMemberResponse";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { useReaderContents } from "@/lib/reader/useReaderContents";
import { pdfReaderSession } from "../__tests__/pdfReaderSession";
import { onePagePdf } from "../__tests__/pdfFixtures";
import MarginRail from "./MarginRail";
import PublicationSectionControls from "./PublicationSectionControls";
import ReaderApparatusDetails from "./ReaderApparatusDetails";
import ReaderApparatusPreview from "./ReaderApparatusPreview";
import ReaderContentsPage from "./ReaderContentsPage";
import ReaderDocumentMapOverviewRail from "./ReaderDocumentMapOverviewRail";
import PublicationEvidence from "./document-map/PublicationEvidence";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const TERMINAL = readerCapacityNotice("Content").message;
const runtimes: HostedReaderProgressRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  vi.unstubAllGlobals();
});

/** The API's terminal oversize refusal: 422, no Retry-After, naming the limit. */
function contentTooLarge(limit: string): Response {
  return new Response(JSON.stringify({ error: {
    code: "E_READER_CONTENT_TOO_LARGE", message: "Reader content exceeds its qualified bound",
    details: { limit, limit_value: 262_144, measured: 524_288 },
  } }), { status: 422, headers: { "Content-Type": "application/json" } });
}

/** A selected PDF publication whose every retained query is refused as oversize. */
async function refusingPdfSession() {
  const pdf = onePagePdf("Refused source");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const fixture = await pdfReaderSession({ kind: "pdf", media_id: MEDIA, reader_generation: 7,
    title: "Refused source", reader_contract_version: 1, page_count: 1,
    document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size,
      sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") } });
  const read = fixture.read;
  const refused: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    const selected = read(path);
    if (selected !== null) return selected;
    refused.push(path);
    return contentTooLarge("index_bytes");
  });
  await fixture.load();
  return { session: fixture.session, refused, close: () => fixture.close() };
}

it("renders a terminal oversize refusal in the margin rail without offering a retry", async () => {
  await page.viewport(1280, 800);
  const fixture = await refusingPdfSession();
  function Reader() {
    const content = useRef<HTMLDivElement>(null);
    return <div style={{ position: "relative", width: 1200, height: 400, "--reader-measure": "600px", "--reader-margin-width": "220px" } as CSSProperties}>
      <div style={{ width: 1200, height: 400, overflow: "auto" }}><div ref={content} /></div>
      <MarginRail session={fixture.session} contentRef={content} layoutKey={0} readTextParts={() => []}
        isPdf isMobile={false} filters={{ highlight: true, citation: true, link: true, synapse: true }}
        refreshToken={0} hasMarginFacts onOpenSidecar={() => {}}
        onActivateItem={async () => ({ kind: "Located" })} onDismissSynapse={async () => {}}
        onDefect={(defect) => { if (defect !== null) throw defect.error; }} />
    </div>;
  }
  const view = render(<Reader />);
  try {
    expect(await screen.findByText(TERMINAL)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry margin" }),
      "a permanent oversize refusal offered to replay itself").not.toBeInTheDocument();
    expect(fixture.refused, "the margin replayed a refusal the API had already decided").toHaveLength(1);
  } finally { view.unmount(); fixture.close(); }
});

it("renders a terminal oversize refusal in the document-map overview without offering a retry", async () => {
  const fixture = await refusingPdfSession();
  const view = render(<div style={{ height: 400, display: "flex", justifyContent: "flex-end" }}>
    <ReaderDocumentMapOverviewRail marginFilters={{ highlight: true, citation: true, link: true, synapse: true }}
      onHasMarginFacts={() => {}} session={fixture.session} refreshToken={0}
      visibleRange={{ start: 0.25, end: 0.5 }} resourceId={MEDIA}
      onActivateMarker={async () => ({ kind: "Located" })}
      onDefect={(defect) => { if (defect !== null) throw defect.error; }} />
  </div>);
  try {
    expect(await screen.findByText(TERMINAL)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry overview" }),
      "a permanent oversize refusal offered to replay itself").not.toBeInTheDocument();
  } finally { view.unmount(); fixture.close(); }
});

it("renders a terminal oversize refusal in the evidence pane without offering a retry", async () => {
  const fixture = await refusingPdfSession();
  function Evidence() {
    const filters = useEvidenceFilters();
    return <PublicationEvidence session={fixture.session} filters={filters} refreshToken={0}
      activeSourceKey={null} activeItemId={null} followGeneration={0} selectedDetail={null}
      onSelect={() => {}} onActivateObject={() => {}} onLocate={async () => ({ kind: "Unavailable" })}
      onHover={() => {}} onRemoveEdge={async () => {}} onDismissSynapse={async () => {}}
      onDefect={(defect) => { if (defect !== null) throw defect.error; }} />;
  }
  const view = render(<Evidence />);
  try {
    expect(await screen.findByText(TERMINAL)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry evidence" }),
      "a permanent oversize refusal offered to replay itself").not.toBeInTheDocument();
  } finally { view.unmount(); fixture.close(); }
});

it("renders a terminal oversize refusal in the source-note preview without offering a retry", async () => {
  const fixture = await refusingPdfSession();
  const view = render(<ReaderApparatusPreview session={fixture.session} stableKey="note"
    classNames={{ container: "", meta: "", body: "" }} onDefect={(defect) => { if (defect !== null) throw defect.error; }} />);
  try {
    const shown = await screen.findByText(TERMINAL);
    expect(shown).toBeVisible();
    expect(shown.textContent, "a permanent oversize refusal invited the reader to reopen the note").toBe(TERMINAL);
  } finally { view.unmount(); fixture.close(); }
});

it("renders a terminal oversize refusal in the source-note details without offering a retry", async () => {
  const fixture = await refusingPdfSession();
  const view = render(<ReaderApparatusDetails session={fixture.session} stableKey="note" locateOnOpen={false}
    renderActions={() => null} onBack={() => {}} onLocate={async () => ({ kind: "Unavailable" })}
    onDefect={(defect) => { if (defect !== null) throw defect.error; }} />);
  try {
    expect(await screen.findByText(TERMINAL)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry source note" }),
      "a permanent oversize refusal offered to replay itself").not.toBeInTheDocument();
  } finally { view.unmount(); fixture.close(); }
});

/** A selected EPUB publication whose index and section context are refused as oversize. */
async function refusingTextSession() {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  runtimes.push(runtime);
  const contentsRef = { key: "index/contents-0.json", bytes: 64, sha256: "b".repeat(64) };
  const descriptor = await readerPublicationMemberResponse({ media_id: MEDIA, reader_generation: 7,
    reader_contract_version: 1, kind: "epub", title: "Refused book", canonical_length: 1, unit_count: 1,
    first_unit_ref: { key: "units/0.json", bytes: 1, sha256: "a".repeat(64) },
    contents_ref: contentsRef, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return descriptor.clone();
    if (path.endsWith("/offline-reader-state")) {
      return Response.json({ data: { accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } } });
    }
    return contentTooLarge("index_bytes");
  });
  const session = createDocumentReaderSession({ mediaId: MEDIA, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(MEDIA) });
  await session.load(new AbortController().signal, { fresh: null, cold: null });
  return { session, contentsRef, close: () => session.close() };
}

it("renders a terminal oversize refusal in the contents page without offering a retry", async () => {
  const fixture = await refusingTextSession();
  function Contents() {
    const [selected, setSelected] = useState<string | null>(null);
    const contents = useReaderContents({ session: fixture.session, first: fixture.contentsRef, enabled: true });
    return <ReaderContentsPage contents={contents} activeSectionId={selected} onNavigate={setSelected} />;
  }
  const view = render(<Contents />);
  try {
    expect(await screen.findByText(TERMINAL)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry contents" }),
      "a permanent oversize refusal offered to replay itself").not.toBeInTheDocument();
  } finally { view.unmount(); fixture.close(); }
});

it("renders a terminal oversize refusal in the section controls without offering a retry", async () => {
  const fixture = await refusingTextSession();
  const point = { kind: "epub" as const, target: { section_id: "chapter", href_path: "Text/chapter.xhtml", anchor_id: null },
    locations: { text_offset: 0, progression: null, total_progression: null, position: null },
    text: { quote: null, quote_prefix: null, quote_suffix: null } };
  const view = render(<PublicationSectionControls session={fixture.session} point={point}
    onNavigate={() => {}} onContents={null} />);
  try {
    expect(await screen.findByText(TERMINAL)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry sections" }),
      "a permanent oversize refusal offered to replay itself").not.toBeInTheDocument();
  } finally { view.unmount(); fixture.close(); }
});
