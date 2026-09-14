import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import PublicationSectionControls from "@/components/reader/PublicationSectionControls";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";

it("uses retained section positions and adjacency while the content lease count is full", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const target = { section_id: "empty-heading", href_path: "Text/chapter.xhtml", anchor_id: "empty" };
  const point = { kind: "epub" as const, target,
    locations: { text_offset: 0, progression: null, total_progression: null, position: null },
    text: { quote: null, quote_prefix: null, quote_suffix: null } };
  const member = async (key: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash, ref: { key, bytes: bytes.byteLength,
      sha256: Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("") } };
  };
  const unit = await member("units/0.json", { fragment_id: mediaId, fragment_idx: 0,
    fragment_document_start_cp: 0, fragment_length_cp: 1, document_word_start: 0, starts_in_word: false,
    epub_target: target, document_embeds: [], start_cp: 0, end_cp: 1, render_start_cp: 0, render_end_cp: 1,
    canonical_text: "a", word_boundaries: [0, 1], assets: [], table_contexts: [],
    render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] }, { kind: "Text", parent: 0, text: "a" }],
  });
  const descriptor = await member("descriptor.json", { media_id: mediaId, reader_generation: 7,
    reader_contract_version: 1, kind: "epub", title: "Retained reader", canonical_length: 1, unit_count: 1,
    first_unit_ref: unit.ref, contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  });
  const representation = ({ bytes, hash }: typeof descriptor) => new Response(bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...hash))}:`, "X-Nexus-Reader-Generation": "7",
  } });
  const section = (section_id: string, ordinal: number) => ({ section_id, ordinal, label: section_id,
    unit_key: unit.ref.key, fragment_id: mediaId, start_offset: 0, end_offset: 0,
    href_path: target.href_path, anchor_id: section_id });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) return Response.json({ data: { accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } } });
    if (path.endsWith("/units/0.json")) return representation(unit);
    if (path.endsWith("/reader-publications/7/section-context")) {
      expect(JSON.parse(String(init?.body))).toEqual({ locator: point });
      const bytes = new TextEncoder().encode(JSON.stringify({ data: {
        current: section("empty-heading", 100), previous: section("prelude", 5), next: section("appendix", 900), section_position: 2, section_count: 3,
      } }));
      return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
    }
    throw new Error(`Section controls escaped the selected publication: ${path}`);
  });
  const session = createDocumentReaderSession({ mediaId,
    capacity: { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxUnits: 1 } },
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(mediaId),
  });
  await session.load(new AbortController().signal, { fresh: null, cold: null });
  const content = session.acquireUnit({ unit_ref: unit.ref, ordinal: 0, previous_ref: null, next_ref: null });
  if (content.kind !== "Acquired") throw new Error("Fixture content was not admitted");
  await content.lease.promise;
  function Controls() {
    const [destination, setDestination] = useState("");
    return <><PublicationSectionControls session={session} point={point} onNavigate={setDestination} onContents={() => setDestination("contents")} />
      <output aria-label="Destination">{destination}</output></>;
  }
  const view = render(<Controls />);
  try {
    expect(await screen.findByLabelText("Section 2 of 3")).toHaveTextContent("2 / 3");
    await userEvent.click(screen.getByRole("button", { name: "Next section" }));
    expect(screen.getByLabelText("Destination")).toHaveTextContent("appendix");
    await userEvent.click(screen.getByRole("button", { name: "Previous section" }));
    expect(screen.getByLabelText("Destination")).toHaveTextContent("prelude");
    await userEvent.click(screen.getByRole("button", { name: "Contents" }));
    expect(screen.getByLabelText("Destination")).toHaveTextContent("contents");
  } finally { view.unmount(); session.close(); runtime.close(); vi.unstubAllGlobals(); }
});
