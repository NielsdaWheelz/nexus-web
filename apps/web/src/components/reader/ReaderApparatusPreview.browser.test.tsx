import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import ReaderApparatusPreview from "./ReaderApparatusPreview";

afterEach(() => vi.unstubAllGlobals());

it("retires a held source-note preview without clearing its replacement or dropping live read charges", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxQueryLeases: 2 } };
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
  const summary = (key: string) => json({ id: mediaId, kind: "footnote", confidence: "exact", stable_key: key,
    label_excerpt: null, label_codepoints: null, label_source_id: null,
    body_excerpt: `Source ${key}`, body_codepoints: `Source ${key}`.length, body_source_id: mediaId,
    has_targets: false, source_range: null, pdf_page: null });
  const heldResponse: { finish: ((response: Response) => void) | null } = { finish: null };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return new Response(descriptor, { headers: {
      "Content-Type": "application/json", "Content-Length": String(descriptor.byteLength),
      "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...digest))}:`, "X-Nexus-Reader-Generation": "2",
    } });
    if (path.endsWith("/offline-reader-state")) return json({ accountId, readerGeneration: 2, cursor: { state: "Empty", revision: 0 } });
    if (path.endsWith("/reader-publications/2/apparatus/lookup")) {
      const query = JSON.parse(String(init?.body));
      if (query.stable_key === "retired") return new Promise<Response>((resolve) => { heldResponse.finish = resolve; });
      return summary(query.stable_key);
    }
    throw new Error(`Preview escaped its selected source: ${path}`);
  });
  const signal = new AbortController().signal;
  const onDefect = () => {};
  const preview = (key: string) => <ReaderApparatusPreview session={session} stableKey={key}
    classNames={{ container: "", meta: "", body: "" }} onDefect={onDefect} />;
  let view: ReturnType<typeof render> | null = null;
  try {
    await session.load(signal, { fresh: null, cold: null });
    view = render(preview("first"));
    await screen.findByText("Source first");
    view.rerender(preview("retired"));
    await vi.waitFor(() => expect(heldResponse.finish).not.toBeNull());
    view.rerender(preview("replacement"));
    await screen.findByText("Source replacement");
    if (session.overlays === null) throw new Error("Hosted apparatus capability unavailable");
    expect(await session.overlays({ kind: "ApparatusLookup", request: { stable_key: "probe" } }, signal),
      "retired physical read lost its reservation before settlement").toEqual({ kind: "Capacity", reason: "Leases" });
    heldResponse.finish!(summary("retired"));
    heldResponse.finish = null;
    await vi.waitFor(async () => {
      const probe = await session.overlays!({ kind: "ApparatusLookup", request: { stable_key: "probe" } }, signal);
      expect(probe.kind).toBe("Acquired");
      if (probe.kind === "Acquired") probe.lease.release();
    });
    expect(screen.getByRole("group", { name: "Source note preview" }),
      "retired preview cleared its replacement source").toHaveTextContent("Source replacement");
    expect(screen.queryByText("Source retired")).not.toBeInTheDocument();
    const oldRoot = screen.getByRole("group", { name: "Source note preview" });
    view.unmount(); view = null;
    expect(oldRoot.textContent, "retired source DOM retained an uncharged excerpt").toBe("");
  } finally { view?.unmount(); heldResponse.finish?.(summary("retired")); session.close(); runtime.close(); }
});
