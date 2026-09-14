import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import HtmlRenderer from "@/components/HtmlRenderer";
import TextDocumentReader from "@/components/reader/TextDocumentReader";
import ReaderApparatusDetails from "@/components/reader/ReaderApparatusDetails";
import type { ReaderContentDefect } from "@/components/reader/ReaderContentBoundary";
import { ResourceCache } from "@/lib/api/resourceCache";
import { useResource } from "@/lib/api/useResource";
import { usePaneFind } from "@/lib/panes/usePaneFind";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { createMediaFindPreviewLease } from "@/app/(authenticated)/media/[id]/mediaFindPreviewLease";
import { createDocumentReaderSession, type ReaderSessionLoad } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";
import { useDocumentReaderWindow, type ReaderWindowUnit } from "./useDocumentReaderWindow";
import { prepareReaderUnit, type PreparedReaderUnit } from "./publicationDom";
import { createPublicationFindAdapter, type PublicationFindPart } from "./publicationFind";
import { locatePublicationApparatus } from "./publicationApparatus";
import { useReaderScrollPositioner } from "./paneScroll";

/**
 * A real source/session/cache/window/controller over three declared external
 * units. Content residency and query leases are separate pools, so a proof
 * names the bound it intends to exhaust.
 */
export async function renderPublicationFind(
  pools: { readonly maxUnits: number; readonly maxQueryLeases: number },
  holdPrefixCommit = false, holdLocation = false,
) {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const member = async (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash };
  };
  const members = await Promise.all(["HOME", "BEA", "CON"].map(async (text, ordinal) => {
    const start = [0, 4, 7][ordinal];
    const artifact = await member({ fragment_id: mediaId, fragment_idx: 0,
      fragment_document_start_cp: 0, fragment_length_cp: 10, document_word_start: 0, starts_in_word: ordinal > 0,
      epub_target: null, document_embeds: [], start_cp: start, end_cp: start + text.length,
      render_start_cp: start, render_end_cp: start + text.length, canonical_text: text,
      word_boundaries: [], assets: [], table_contexts: [],
      render_nodes: [{ kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] }, { kind: "Text", parent: 0, text }],
    });
    return { ...artifact, start, end: start + text.length, ref: { key: `units/${ordinal}.json`, bytes: artifact.bytes.byteLength,
      sha256: Array.from(artifact.hash, (value) => value.toString(16).padStart(2, "0")).join("") } };
  }));
  const descriptor = await member({ media_id: mediaId, reader_generation: 7, reader_contract_version: 1,
    kind: "web_article", title: "Retained match", canonical_length: 10, unit_count: 3,
    first_unit_ref: members[0].ref, contents_ref: null, table_metadata_ref: null, index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) },
  });
  const representation = (artifact: typeof descriptor) => new Response(artifact.bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(artifact.bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...artifact.hash))}:`, "X-Nexus-Reader-Generation": "7",
  } });
  const json = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  const locator = { kind: "web" as const, target: { fragment_id: mediaId },
    locations: { text_offset: 4, progression: null, total_progression: null, position: null },
    text: { quote: null, quote_prefix: null, quote_suffix: null } };
  let completeTail: ((response: Response) => void) | null = null;
  let completeLocation: ((response: Response) => void) | null = null;
  let locationHeld = holdLocation;
  const location = () => json({ kind: "Text",
    range: { unit_key: members[1].ref.key, fragment_id: mediaId, start_cp: 4, end_cp: 7 } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) return json({ accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } });
    if (path.endsWith("/apparatus/lookup")) return json({
      id: mediaId, stable_key: "prefix-note", kind: "footnote_ref", confidence: "exact",
      label_excerpt: "Source note", label_codepoints: 11, label_source_id: mediaId,
      body_excerpt: null, body_codepoints: null, body_source_id: null, has_targets: false,
      source_range: { unit_key: members[1].ref.key, fragment_id: mediaId, start_cp: 4, end_cp: 7 }, pdf_page: null,
    });
    if (path.endsWith(`/apparatus/${mediaId}/location`)) {
      if (locationHeld) return new Promise<Response>((resolve) => { completeLocation = resolve; });
      return location();
    }
    if (path.endsWith("/section-context")) return json({ current: {
      section_id: "EntireResource", label: "Authored heading", ordinal: 0, unit_key: members[0].ref.key,
      fragment_id: mediaId, start_offset: 0, end_offset: 10, href_path: null, anchor_id: null,
    }, previous: null, next: null, section_position: 1, section_count: 1 });
    if (path.endsWith("/find")) {
      const query = JSON.parse(String(init?.body)).query;
      return json({ occurrences: [{ section_id: null, section_label: null,
      fragment_id: mediaId, fragment_idx: 0, start_offset: 4, end_offset: query === "BEA" ? 7 : 10,
      snippet: [{ text: query, emphasized: true }], locator }], next_cursor: null });
    }
    if (path.endsWith("/resolve")) {
      const target = JSON.parse(String(init?.body)).target;
      const ordinal = target.kind === "Locator" ? 1 : members.findIndex((item) => item.ref.key === target.unit_key);
      const item = members[ordinal];
      const address = { unit_ref: item.ref, ordinal, previous_ref: members[ordinal - 1]?.ref ?? null, next_ref: members[ordinal + 1]?.ref ?? null };
      return json(target.kind === "Locator" ? { kind: "Text", ...address, locator: target.locator,
        fragment_id: mediaId, offset_cp: 4, local_offset_cp: 0 }
        : { kind: "Unit", ...address, fragment_id: mediaId, start_cp: item.start, end_cp: item.end });
    }
    if (path.endsWith("/units/2.json")) return new Promise<Response>((resolve) => { completeTail = resolve; });
    const item = members.find((entry) => path.endsWith(`/${entry.ref.key}`));
    if (item !== undefined) return representation(item);
    throw new Error(`Find escaped its retained source: ${path}`);
  });
  const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, ...pools } };
  const session = createDocumentReaderSession({ mediaId, capacity,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }), progress: runtime.createPort(mediaId) });
  function Reader() {
    const viewport = useRef<HTMLDivElement | null>(null);
    const readerRoot = useRef<HTMLDivElement | null>(null);
    const contentRoot = useRef<HTMLDivElement | null>(null);
    const end = useRef<HTMLElement | null>(null);
    const locationCommand = useRef<{ current: boolean } | null>(null);
    const views = useRef(new Map<ReaderWindowUnit["lease"], { item: ReaderWindowUnit; view: PreparedReaderUnit }>());
    const pending = useRef<{ item: ReaderWindowUnit; resolve: (part: PublicationFindPart) => void } | null>(null);
    const operation = useMemo(() => new AbortController(), []);
    const [prefixCommitted, setPrefixCommitted] = useState(!holdPrefixCommit);
    const [previewSettlement, setPreviewSettlement] = useState("Idle");
    const [navigationSettlement, setNavigationSettlement] = useState("Idle");
    const [locationSettlement, setLocationSettlement] = useState("Idle");
    const [sourceNoteOpen, setSourceNoteOpen] = useState(false);
    const [trustedInput, setTrustedInput] = useState(false);
    const onDefect = useCallback((defect: ReaderContentDefect | null) => { if (defect !== null) throw defect.error; }, []);
    const [prepared, setPrepared] = useState<readonly { item: ReaderWindowUnit; view: PreparedReaderUnit }[]>([]);
    const initial = useResource<ReaderSessionLoad>({ cacheKey: mediaId, load: (signal) => session.load(signal, { fresh: null, cold: null }) });
    const window = useDocumentReaderWindow({ session, initial, retryInitial: () => {}, retireUnits(items) {
      for (const item of items) { views.current.get(item.lease)?.view.release(); views.current.delete(item.lease); }
      return true;
    } });
    useLayoutEffect(() => {
      for (const item of window.units) {
        if (views.current.has(item.lease)) continue;
        const view = prepareReaderUnit({ session, unit: item.unit, unitKey: item.address.unit_ref.key, highlights: [], headingLevelOffset: 0 });
        if (view.kind !== "Ready") throw new Error("Fixture reader exhausted DOM admission");
        views.current.set(item.lease, { item, view: view.value });
      }
      setPrepared([...views.current.values()]);
    }, [window.units]);
    useLayoutEffect(() => {
      if (pending.current === null) return;
      const entry = views.current.get(pending.current.item.lease);
      if (entry === undefined || !entry.view.root.isConnected) return;
      pending.current.resolve({ item: entry.item, root: entry.view.root, cursor: entry.view.cursor });
      pending.current = null;
    }, [prepared, prefixCommitted]);
    const scrollPositioner = useReaderScrollPositioner();
    const previewLease = useMemo(createMediaFindPreviewLease, []);
    const selected = initial.status === "ready" && "document" in initial.data ? initial.data.document.descriptor : null;
    const waitForUnit = useCallback((item: ReaderWindowUnit, signal: AbortSignal): Promise<PublicationFindPart> => {
      const ready = views.current.get(item.lease);
      if (ready?.view.root.isConnected) return Promise.resolve({ item, root: ready.view.root, cursor: ready.view.cursor });
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => { if (pending.current === waiter) pending.current = null; reject(signal.reason); };
        const waiter = { item, resolve: (part: PublicationFindPart) => { signal.removeEventListener("abort", abort); resolve(part); } };
        pending.current = waiter;
        signal.addEventListener("abort", abort, { once: true });
        if (holdPrefixCommit) setPreviewSettlement("Waiting for commit");
      });
    }, []);
    const adapter = useMemo(() => selected === null ? null : createPublicationFindAdapter({ session, descriptor: selected,
      window: { navigate: window.navigate, loadNeighbor: window.loadNeighbor }, scrollPositioner, previewLease,
      focusViewport: () => viewport.current?.focus(),
      getRendered: () => viewport.current === null ? null : { viewport: viewport.current,
        parts: [...views.current.values()].map(({ item, view }) => ({ item, root: view.root, cursor: view.cursor })) },
      waitForUnit: async (item, signal) => ({ kind: "Rendered", part: await waitForUnit(item, signal) }),
    }), [selected, window.navigate, window.loadNeighbor, scrollPositioner, previewLease, waitForUnit]);
    useEffect(() => () => { adapter?.release(); }, [adapter]);
    useEffect(() => () => operation.abort(), [operation]);
    useLayoutEffect(() => () => { for (const entry of views.current.values()) entry.view.release(); views.current.clear(); }, []);
    const locate = useCallback(async (itemId: string, stableKey: string, signal: AbortSignal) => {
      const command = { current: true };
      locationCommand.current = command;
      const result = await locatePublicationApparatus({ session, itemId, stableKey, signal, commandIsCurrent: () => command.current, locatePdf: null,
        navigate: window.navigate, waitForUnit: async (item, signal) => { await waitForUnit(item, signal); return null; },
        getRenderedUnit: (lease) => {
          const prepared = views.current.get(lease);
          return prepared === undefined || viewport.current === null ? null : {
            root: prepared.view.root, cursor: prepared.view.cursor, unit: prepared.item.unit, viewport: viewport.current,
          };
        }, scrollPositioner, pulse: () => { throw new Error("Declared source note has no inline marker"); },
        reportMovement: async (value) => { await session.progress.capture(mediaId, value); },
      });
      setLocationSettlement(result.kind);
      return result;
    }, [scrollPositioner, waitForUnit, window.navigate]);
    const find = usePaneFind({ capability: adapter === null ? { kind: "Unavailable" } : { kind: "Available", adapter } });
    const controller = find.kind === "Available" ? find.controller : null;
    return <>
      {holdLocation ? <div style={{ width: 320, height: 160, display: "flex" }}>
        <TextDocumentReader mediaId={mediaId} scrollPositioner={scrollPositioner}
          readerRootRef={readerRoot} contentRef={contentRoot} textViewportRef={viewport} textEndRef={end}
          readerThemeClassName="" readerSurfaceStyle={{ minHeight: 1200 }} focusMode="off" hyphenation="auto"
          contentState={{ status: "ready", preparedRoots: prepared.map(({ item, view }) => ({ key: item.address.unit_ref.key, root: view.root })) }}
          onViewportReady={() => {}} onViewportScroll={() => {}}
          onTrustedScrollIntent={() => {
            if (locationCommand.current !== null) locationCommand.current.current = false;
            setTrustedInput(true);
          }} endContent={null} onContentClick={() => {}} onContentPointerOver={() => {}}
          onContentPointerOut={() => {}} onContentFocus={() => {}} onContentBlur={() => {}} />
      </div> : <div ref={viewport} aria-label="Reader viewport" tabIndex={-1} style={{ width: 320, height: 160, overflow: "auto" }}>
        {prepared.filter(({ item }) => prefixCommitted || item.address.ordinal !== 1)
          .map(({ item, view }) => <HtmlRenderer key={item.address.unit_ref.key} preparedRoot={view.root} />)}
      </div>}
      {sourceNoteOpen && <ReaderApparatusDetails session={session} stableKey="prefix-note" locateOnOpen={true} renderActions={() => null}
        onBack={() => setSourceNoteOpen(false)} onLocate={locate} onDefect={onDefect} />}
      {(holdPrefixCommit || holdLocation) && <>
        <button onClick={async () => {
          if (adapter === null) throw new Error("Retained source is not ready");
          const request = { sourceKey: adapter.sourceKey, sessionId: 1, signal: operation.signal };
          await adapter.prepare(request);
          const result = await adapter.find({ ...request, queryId: 1, query: "BEA", scopeId: "EntireResource", matchCase: false, wholeWord: false });
          if (result.kind !== "Ready") throw new Error("Declared prefix match unavailable");
          try {
            const receipt = await adapter.preview({ ...request, queryId: 1, key: result.initialActiveKey });
            setPreviewSettlement(receipt.kind);
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
            setPreviewSettlement("Superseded");
          } finally { result.releaseRows?.(); }
        }}>Preview uncommitted prefix</button>
        <button onClick={() => setSourceNoteOpen(true)}>Open source note link</button>
        <button onClick={async () => {
          await window.loadNeighbor("Previous");
          const result = await window.navigate({ kind: "Unit", unit_key: members[0].ref.key });
          if (locationSettlement !== "Idle" || pending.current !== null) {
            await session.progress.capture(mediaId, { ...locator, locations: { ...locator.locations, text_offset: 0 } });
          }
          setNavigationSettlement(result.kind);
        }}>Navigate home</button>
        <button onClick={() => setPrefixCommitted(true)}>Commit prefix</button>
        <output aria-label="Preview settlement">{previewSettlement}</output>
        <output aria-label="Location settlement">{locationSettlement}</output>
        <output aria-label="Navigation settlement">{navigationSettlement}</output>
        <output aria-label="Resident units">{window.units.map((item) => item.unit.canonical_text).join(", ")}</output>
        <output aria-label="Trusted reader input">{String(trustedInput)}</output>
      </>}
      <button onClick={() => { controller?.onOpen(); controller?.onQueryChange("BEACON"); }}>Find beacon</button>
      <button onClick={() => controller?.onQueryChange("BEA")}>Find prefix</button>
      <button onClick={() => { if (controller?.result.kind === "Failed") controller.result.onRetry(); }}>Retry find</button>
      <output aria-label="Find state">{controller?.result.kind ?? "Loading"}</output>
      <output aria-label="Find scopes">{controller?.scope.kind === "Selectable" ? controller.scope.options.map((scope) => scope.label).join(", ") : "Entire resource"}</output>
      <output aria-label="Return state">{controller?.returnToReadingPosition.kind ?? "Unavailable"}</output>
      <button disabled={controller?.returnToReadingPosition.kind !== "Available"} onClick={() => {
        if (controller?.returnToReadingPosition.kind === "Available") controller.returnToReadingPosition.onReturn();
      }}>Return to reading</button>
    </>;
  }
  const view = render(<MobileChromeProvider><Reader /></MobileChromeProvider>);
  return {
    pendingIntent: async () => {
      const intent = await runtime.store.next(accountId);
      if (intent === null) return null;
      if (intent.desired.locator.kind !== "web") throw new Error("Expected the fixture's web cursor");
      return { ...intent, desired: { ...intent.desired, locator: intent.desired.locator } };
    },
    tailRequested: () => completeTail !== null,
    locationRequested: () => completeLocation !== null,
    finishLocation: () => { locationHeld = false; completeLocation?.(location()); },
    finishTail: () => completeTail?.(representation(members[2])),
    close() { completeTail?.(representation(members[2])); completeLocation?.(location()); view.unmount(); session.close(); runtime.close(); vi.unstubAllGlobals(); },
  };
}
