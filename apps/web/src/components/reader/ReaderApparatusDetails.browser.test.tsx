import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import ReaderApparatusDetails from "./ReaderApparatusDetails";

afterEach(() => vi.unstubAllGlobals());

it("reads a source note's attested target body one Unicode page at a time", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const targetId = "22222222-2222-4222-8222-222222222222";
  const accountId = crypto.randomUUID();
  const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxQueryLeases: 1, maxDomNodes: 24 } };
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId, capacity,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, capacity.cache), capacity }), progress: runtime.createPort(mediaId) });
  const reference = { key: "units/0.json", bytes: 1, sha256: "a".repeat(64) };
  const descriptor = new TextEncoder().encode(JSON.stringify({ media_id: mediaId, reader_generation: 2, reader_contract_version: 1,
    kind: "web_article", title: "Selected source", canonical_length: 4, unit_count: 1, first_unit_ref: reference,
    contents_ref: null, table_metadata_ref: null, index_ref: { ...reference, key: "index/0.json" } }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", descriptor));
  const json = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return new Response(descriptor, { headers: {
      "Content-Type": "application/json", "Content-Length": String(descriptor.byteLength),
      "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`, "X-Nexus-Reader-Generation": "2",
    } });
    if (path.endsWith("/offline-reader-state")) return json({ accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } });
    if (path.endsWith("/reader-publications/2/apparatus/lookup")) return json({
      id: mediaId, stable_key: "original-marker", kind: "footnote_ref", confidence: "exact",
      label_excerpt: null, label_codepoints: null, label_source_id: null,
      body_excerpt: "🧠écd", body_codepoints: 4, body_source_id: targetId,
      has_targets: false, source_range: null, pdf_page: null,
    });
    if (path.endsWith(`/reader-publications/2/apparatus/${mediaId}/text`)) {
      return json({ field: "Body", offset_cp: 0, text: "marker's own body", total_codepoints: 17, next_offset_cp: null });
    }
    if (path.endsWith(`/reader-publications/2/apparatus/${targetId}/text`)) {
      const query = JSON.parse(String(init?.body));
      if (query.offset_cp === 0) return json({ field: "Body", offset_cp: 0, text: "🧠é", total_codepoints: 4, next_offset_cp: 2 });
      if (query.offset_cp === 2) return json({ field: "Body", offset_cp: 2, text: "cd", total_codepoints: 4, next_offset_cp: null });
      throw new Error("Text continuation changed original Unicode coordinates");
    }
    throw new Error(`Source detail escaped its selected publication: ${path}`);
  });
  let view: ReturnType<typeof render> | null = null;
  try {
    await session.load(new AbortController().signal, { fresh: null, cold: null });
    view = render(<ReaderApparatusDetails session={session} stableKey="original-marker" locateOnOpen={false}
      renderActions={(subject) => <output aria-label="Current source ref">{subject.ref}</output>} onBack={() => {}}
      onLocate={async () => { throw new Error("Text paging attempted source navigation"); }} onDefect={() => {}} />);
    await screen.findByText("🧠écd");
    await userEvent.click(screen.getByRole("button", { name: "Read full note" }));
    await screen.findByRole("heading", { name: "Source note" });
    expect(screen.getByRole("region", { name: "Source note details" }),
      "source note detail substituted its owner's body for the attested target").toHaveTextContent("🧠é");
    expect(screen.queryByText("🧠écd")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next text page" }));
    await screen.findByText("cd");
    expect(screen.getByLabelText("Current source ref")).toHaveTextContent(`reader_apparatus_item:${targetId}`);
    expect(screen.queryByText("🧠é"), "text pages accumulated outside the page lease").not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next text page" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Beginning of text" }));
    await screen.findByText("🧠é");
  } finally { view?.unmount(); session.close(); runtime.close(); }
});
