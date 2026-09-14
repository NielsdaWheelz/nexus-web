import { useState } from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { page } from "vitest/browser";
import MediaPaneBody from "../MediaPaneBody";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import { PaneRouteErrorBoundary } from "@/components/workspace/PaneRouteErrorBoundary";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import ActivityCaptureLifecycle from "@/lib/consumption/ActivityCaptureLifecycle";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ArtworkProvider } from "@/lib/media/ArtworkProvider";
import { ARTWORK_CAPACITY } from "@/lib/media/artworkCapacity";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { HostedReaderProgressProvider } from "@/lib/reader/HostedReaderProgressProvider";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { ReaderIntentStore } from "@/lib/reader/readerIntentStore";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import type { LinkFragmentSelectionSource } from "@/lib/resourceGraph/links";
import type { Highlight } from "@/lib/highlights/highlightContract";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { ResourceOverlaysProvider } from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId, createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";

/** Real hosted media composition; only the HTTP publication/account origin is external. */
export async function renderMediaPane(options: {
  existingHighlight?: boolean; duplicateHighlight?: boolean; highlightDetailFailure?: boolean;
  /** `stuck` answers every association page with the cursor it was given. */
  stanceAssociations?: "empty" | "stuck"; stanceWriteFails?: boolean;
} = {}) {
  await page.viewport(1000, 800);
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const fragments = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const prefix = "Earlier source line.\n".repeat(40);
  const chapterTexts = ["Home source line.\n".repeat(90), prefix + "EXACT SECTION TARGET\n" + "Later source line.\n".repeat(40)].map((text) => text.trimEnd());
  const targets = [
    { section_id: "chapter-one", href_path: "Text/chapter1.xhtml", anchor_id: "home" },
    { section_id: "chapter-two", href_path: "Text/chapter2.xhtml", anchor_id: "exact" },
  ];
  const FIGURE = { key: "assets/figure.png", bytes: 12, sha256: "b".repeat(64) };
  const encode = async (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash };
  };
  const members = await Promise.all(chapterTexts.map(async (text, ordinal) => {
    const value = await encode({ fragment_id: fragments[ordinal], fragment_idx: ordinal,
      fragment_document_start_cp: ordinal === 0 ? 0 : chapterTexts[0].length, fragment_length_cp: text.length,
      document_word_start: 0, starts_in_word: false, epub_target: targets[ordinal], document_embeds: [],
      start_cp: 0, end_cp: text.length, render_start_cp: 0, render_end_cp: text.length, canonical_text: text.replaceAll("\n", " "),
      word_boundaries: [], table_contexts: [],
      assets: ordinal === 0 ? [{ kind: "Captured", member: FIGURE, media_type: "image/png", package_href: null }] : [],
      render_nodes: ordinal === 0 ? [
        { kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] },
        { kind: "Text", parent: 0, text },
        { kind: "Element", parent: null, namespace: "html", name: "img", attributes: [
          { namespace: null, name: "src", value: `nexus-reader-member:${FIGURE.key}` },
          { namespace: null, name: "alt", value: "authored figure" },
        ] },
      ] : [
        { kind: "Element", parent: null, namespace: "html", name: "pre", attributes: [] },
        { kind: "Text", parent: 0, text: prefix },
        { kind: "Element", parent: 0, namespace: "html", name: "span", attributes: [] },
        { kind: "Text", parent: 2, text: "EXACT SECTION TARGET" },
        { kind: "Text", parent: 0, text: text.slice(prefix.length + "EXACT SECTION TARGET".length) },
      ] });
    return { ...value, ref: { key: `units/${ordinal}.json`, bytes: value.bytes.byteLength,
      sha256: Array.from(value.hash, (byte) => byte.toString(16).padStart(2, "0")).join("") } };
  }));
  const descriptor = await encode({ media_id: mediaId, reader_generation: 7, reader_contract_version: 1, kind: "epub", title: "Exact reader composition",
    canonical_length: chapterTexts.reduce((sum, text) => sum + text.length, 0), unit_count: 2,
    first_unit_ref: members[0].ref, contents_ref: null, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } });
  const representation = (value: typeof descriptor) => new Response(value.bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(value.bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...value.hash))}:`, "X-Nexus-Reader-Generation": "7",
  } });
  const endpoint = (ref: string, label: string) => {
    const [scheme, endpointId] = ref.split(":");
    const href = scheme === "media" ? `/media/${endpointId}` : `/media/${mediaId}?highlight=${endpointId}`;
    return { ref, scheme, id: endpointId, label: scheme === "media" ? "Exact reader composition" : label,
      description: null, href, missing: false,
      activation: { resource_ref: ref, kind: "route", href, unresolved_reason: null } };
  };
  const connection = (sourceRef: string, targetRef: string, kind: string, label: string) => ({
    edge_id: crypto.randomUUID(), direction: kind === "context" ? "undirected" : "outgoing", kind, origin: "user",
    snapshot: null, source_order_key: null, target_order_key: null, ordinal: null, source_ref: sourceRef, target_ref: targetRef,
    source: endpoint(sourceRef, label), target: endpoint(targetRef, label), other: endpoint(targetRef, label),
    citation: null, link_note: null, created_at: "2026-09-14T00:00:00Z",
  });
  const json = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  const section = (ordinal: number) => ({ section_id: targets[ordinal].section_id, label: ordinal === 0 ? "Home" : "Exact section", ordinal,
    unit_key: members[ordinal].ref.key, fragment_id: fragments[ordinal], start_offset: ordinal === 0 ? 0 : prefix.length,
    end_offset: chapterTexts[ordinal].length, href_path: targets[ordinal].href_path, anchor_id: targets[ordinal].anchor_id });
  const counts = { contents: 0, embeds: 0, highlights: 0, source_references: 0, generated_citations: 0, links: 0, synapses: 0 };
  let secondHeld = true;
  const pendingSecond: ((response: Response) => void)[] = [];
  const highlightWrites: Highlight[] = [];
  const existingHighlight: Highlight | null = options.existingHighlight ? {
    id: crypto.randomUUID(), color: "blue", exact: "line", prefix: "", suffix: "",
    anchor: { type: "fragment_offsets", media_id: mediaId, fragment_id: fragments[0], start_offset: 12, end_offset: 16 },
    created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", author_user_id: accountId,
    is_owner: true, linked_conversations: [], linked_note_blocks: [],
  } : null;
  const highlightRows = existingHighlight === null ? [] : [existingHighlight];
  const pendingHighlights: (() => void)[] = [];
  const linkWrites: { source: LinkFragmentSelectionSource }[] = [];
  const stanceWrites: { source_ref: string; target_ref: string; kind: string }[] = [];
  const associationRequests: (string | null)[] = [];
  const pendingLinks: { finish: () => void; fail: () => void }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/resource-items/targets/search") return json({ targets: [{ kind: "resource", existingLinkId: null,
      item: { ref: `media:${mediaId}`, scheme: "media", id: mediaId, label: "Exact reader composition", summary: "", route: `/media/${mediaId}`, missing: false,
        activation: { resourceRef: `media:${mediaId}`, kind: "route", href: `/media/${mediaId}`, unresolvedReason: null }, versionByLane: {},
        capabilities: { userRelation: { userLinkSource: true, userLinkTarget: "direct", noteReferenceTarget: false },
          sharing: "None", libraryPlacement: "None", attachable: false, chatSubject: "none", readable: "none", inspectable: "none",
          citableResultType: null, citationOutputSource: false, appSearchScope: false, conversationSearchScope: false,
          promptRender: "none", expansionPolicy: "none", expandable: false, adjacencySource: true, adjacencyTarget: true } },
    }], nextCursor: null });
    if (path === "/api/resource-graph/links" && init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      if (request.source.kind !== "fragment_selection") throw new Error("This source fixture links text selections");
      linkWrites.push(request);
      const source = request.source;
      const fragment = fragments.indexOf(source.fragment_id);
      const created: Highlight = { id: source.highlight_id, color: source.color,
        exact: chapterTexts[fragment].replaceAll("\n", " ").slice(source.start_offset, source.end_offset), prefix: "", suffix: "",
        anchor: { type: "fragment_offsets", media_id: mediaId, fragment_id: source.fragment_id,
          start_offset: source.start_offset, end_offset: source.end_offset },
        created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", author_user_id: accountId,
        is_owner: true, linked_conversations: [], linked_note_blocks: [],
      };
      highlightRows.push(created);
      const sourceRef = `highlight:${source.highlight_id}`;
      const targetRef = `media:${mediaId}`;
      const result = { created: true, created_source_ref: sourceRef,
        connection: connection(sourceRef, targetRef, "context", created.exact) };
      return new Promise<Response>((resolve, reject) => pendingLinks.push({
        finish: () => resolve(json(result)), fail: () => reject(new TypeError("Link response connection interrupted")),
      }));
    }
    const fragmentOrdinal = fragments.findIndex((fragmentId) => path === `/api/fragments/${fragmentId}/highlights`);
    if (fragmentOrdinal >= 0 && init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      const existing = highlightRows.find((row) => row.anchor.fragment_id === fragments[fragmentOrdinal] &&
        row.anchor.start_offset === request.start_offset && row.anchor.end_offset === request.end_offset);
      if (existing !== undefined) return new Response(JSON.stringify({ error: {
        code: "E_HIGHLIGHT_CONFLICT", message: "This selection already exists.",
        details: { existing_highlight_id: existing.id },
      } }), { status: 409, headers: { "Content-Type": "application/json" } });
      const source = chapterTexts[fragmentOrdinal].replaceAll("\n", " ");
      const created: Highlight = { id: crypto.randomUUID(), color: request.color,
        exact: source.slice(request.start_offset, request.end_offset), prefix: "", suffix: "",
        anchor: { type: "fragment_offsets", media_id: mediaId, fragment_id: fragments[fragmentOrdinal],
          start_offset: request.start_offset, end_offset: request.end_offset },
        created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", author_user_id: accountId,
        is_owner: true, linked_conversations: [], linked_note_blocks: [],
      };
      highlightWrites.push(created);
      highlightRows.push(created);
      // The duplicate case models another writer committing this exact span
      // after the initial paint read and before this create reaches the server.
      return new Promise<Response>((resolve) => pendingHighlights.push(() => resolve(options.duplicateHighlight
        ? new Response(JSON.stringify({ error: { code: "E_HIGHLIGHT_CONFLICT", message: "This selection already exists.",
          details: { existing_highlight_id: created.id } } }), { status: 409, headers: { "Content-Type": "application/json" } })
        : json(created))));
    }
    const selectedHighlight = highlightRows.find((highlight) => path === `/api/highlights/${highlight.id}`);
    if (selectedHighlight !== undefined) return options.highlightDetailFailure && selectedHighlight !== existingHighlight
      ? new Response("highlight detail gateway unavailable", { status: 502 }) : json(selectedHighlight);
    if (path === "/api/resource-items/action-snapshots/resolve") {
      const { refs } = JSON.parse(String(init?.body));
      return json({ snapshots: refs.map((ref: string) => ({ ref, missing: false, factsRevision: "a".repeat(64),
        activation: { resourceRef: ref, kind: "route", href: `/media/${mediaId}?highlight=${ref.slice("highlight:".length)}`, unresolvedReason: null },
        capabilities: [{ kind: "Open", availability: { kind: "Available" } }] })) });
    }
    if (path === `/api/media/${mediaId}`) return json({ id: mediaId, kind: "epub", title: "Exact reader composition", canonical_source_url: null,
      processing_status: "ready_for_reading", source_progress: { kind: "Absent" }, transcript_state: null, transcript_coverage: null, transcript_origin: { kind: "Absent" },
      retrieval_status: "ready", retrieval_status_reason: null, failure_stage: null, last_error_code: null, playback_source: null,
      listening_state: null, episode_state: null, chapters: [], capabilities: {
        can_read: true, can_highlight: true, can_quote: true, can_search: true, can_play: false, can_download_file: false, can_delete: false,
        can_retry: false, can_refresh_source: false, can_retry_metadata: false, can_repair_source: false, can_repair_search: false,
        can_edit_authors: false, can_read_embeds: false,
      }, document_embed_summary: null, contributors: [], author_mode: "automatic", published_date: null, publisher: null, language: "en",
      description: null, description_html: null, description_text: null, metadata_enriched_at: null, read_state: "unread", progress_fraction: null,
      progress_resettable: false, last_engaged_at: null, playerDescriptor: { kind: "Absent" }, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z" });
    if (path === "/api/me/reader-profile") return json({ theme: "light", font_family: "serif", font_size_px: 18, line_height: 1.6, column_width_ch: 65, focus_mode: "off", hyphenation: "off" });
    if (path === "/api/lectern") return json({ items: [] });
    if (path === "/api/consumption/activity") return new Response(null, { status: 204 });
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) {
      if (init?.method === "PUT") return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return json({ accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } });
    }
    if (path.endsWith("/reader-publications/7/find")) {
      const { query } = JSON.parse(String(init?.body));
      return json({ occurrences: query === "EXACT SECTION TARGET" ? [{
        section_id: "chapter-two", section_label: "Exact section", fragment_id: fragments[1], fragment_idx: 1,
        start_offset: prefix.length, end_offset: prefix.length + "EXACT SECTION TARGET".length,
        snippet: [{ text: "EXACT SECTION TARGET", emphasized: true }],
        locator: { kind: "epub", target: targets[1],
          locations: { text_offset: prefix.length, progression: null, total_progression: null, position: null },
          text: { quote: null, quote_prefix: null, quote_suffix: null } },
      }] : [], next_cursor: null });
    }
    if (path.endsWith("/reader-publications/7/resolve")) {
      const { target } = JSON.parse(String(init?.body));
      const ordinal = target.kind === "Navigation" ? Number(target.target_id === "chapter-two")
        : target.kind === "Locator" ? Number(target.locator.target.section_id === "chapter-two")
          : target.unit_key === members[1].ref.key ? 1 : 0;
      const address = { unit_ref: members[ordinal].ref, ordinal, previous_ref: members[ordinal - 1]?.ref ?? null, next_ref: members[ordinal + 1]?.ref ?? null };
      if (target.kind === "Unit") return json({ kind: "Unit", ...address, fragment_id: fragments[ordinal], start_cp: 0, end_cp: chapterTexts[ordinal].length });
      const offset = ordinal === 0 ? 0 : prefix.length;
      return json({ kind: "Text", ...address, fragment_id: fragments[ordinal], offset_cp: offset, local_offset_cp: offset,
        locator: { kind: "epub", target: targets[ordinal], locations: { text_offset: offset, progression: null, total_progression: null, position: null },
          text: { quote: null, quote_prefix: null, quote_suffix: null } } });
    }
    if (path.endsWith("/units/0.json")) return representation(members[0]);
    if (path.endsWith("/units/1.json")) {
      if (secondHeld) return new Promise<Response>((resolve) => { pendingSecond.push(resolve); });
      return representation(members[1]);
    }
    if (path.endsWith("/section-context")) {
      const { locator } = JSON.parse(String(init?.body));
      const ordinal = Number(locator.target.section_id === "chapter-two");
      return json({ current: section(ordinal), previous: ordinal === 0 ? null : section(0), next: ordinal === 0 ? section(1) : null,
        section_position: ordinal + 1, section_count: 2 });
    }
    if (path.endsWith("/highlights")) {
      const { unit_key } = JSON.parse(String(init?.body));
      const ordinal = members.findIndex((member) => member.ref.key === unit_key);
      return json({ items: highlightRows.filter((highlight) => highlight.anchor.fragment_id === fragments[ordinal])
        .map(({ id, color, anchor, created_at, author_user_id, is_owner }) => ({ id, color,
          start_offset: anchor.start_offset, end_offset: anchor.end_offset, created_at, author_user_id, is_owner })), next_cursor: null });
    }
    if (path.endsWith("/evidence/associations")) {
      const { after } = JSON.parse(String(init?.body));
      associationRequests.push(after);
      // A walk that is not bounded by the client must fail this fixture rather
      // than spin: the defect under proof is an unbounded foreground read.
      if (associationRequests.length > 6) throw new Error("Stance association walk exceeded this fixture's bound");
      if (options.stanceAssociations !== "stuck") return json({ items: [], next_cursor: null });
      return json({ items: [{ relationship: "AuthoredIn", object: {
        kind: "Media", ref: `media:${mediaId}`, label_excerpt: "Source", label_codepoints: 6,
        excerpt: null, excerpt_codepoints: null,
        activation: { resource_ref: `media:${mediaId}`, kind: "route", href: `/media/${mediaId}`, unresolved_reason: null },
      } }], next_cursor: "cursor-1" });
    }
    if (path === "/api/resource-graph/stances" && init?.method === "PUT") {
      stanceWrites.push(JSON.parse(String(init.body)));
      if (options.stanceWriteFails) return new Response(JSON.stringify({ error: {
        code: "E_UPSTREAM", message: "The stance service is unavailable." } }), {
        status: 502, headers: { "Content-Type": "application/json" } });
      const write = stanceWrites[stanceWrites.length - 1];
      return json({ connection: connection(write.source_ref, write.target_ref, write.kind, "line") });
    }
    if (path.endsWith("/evidence/overview")) return json({ bucket_count: JSON.parse(String(init?.body)).bucket_count, buckets: [], unavailable_counts: counts });
    if (path.endsWith("/evidence/gutter")) return json({ items: [], total_count: 0, next_cursor: null });
    throw new Error(`Unexpected composed reader request: ${path}`);
  });
  const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 720 };
  const intents = new ReaderIntentStore();
  function Pane({ readerOpen = true }: { readerOpen?: boolean }) {
    const [href, setHref] = useState(`/media/${mediaId}`);
    const [activatedHref, setActivatedHref] = useState("");
    return <RenderEnvironmentProvider value={{ androidShell: false, platform: "linux", displayLocale: "en-US", displayTimeZone: "UTC",
      currentInstant: "2026-09-14T00:00:00Z", currentLocalDate: "2026-09-14", initialViewport: "desktop" }}>
      <AuthenticatedAccountProvider account={{ accountId, calendarTimeZone: "UTC" }}>
        <ActivityCaptureLifecycle accountId={accountId} />
        <ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}><ArtworkProvider limits={ARTWORK_CAPACITY}>
          <ReaderProvider initialProfile={{ theme: "light", font_family: "serif", font_size_px: 18, line_height: 1.6, column_width_ch: 65, focus_mode: "off", hyphenation: "off" }}>
            <MobileChromeProvider><FeedbackProvider><ShareControllerProvider><LibraryPlacementControllerProvider><PaneReturnMementoProvider>
              <KeybindingsProvider><WorkspaceStoreProvider initialState={createDefaultWorkspaceState(`/media/${mediaId}`, metrics)} workspacePrimaryMetrics={metrics}>
                <HostedReaderProgressProvider accountId={accountId}><LecternProvider><OfflineMediaProvider accountId={accountId} transport={null}>
                  <ResourceOverlaysProvider><GlobalPlayerProvider><ResourceActionRuntimeProvider>
                    <PaneRuntimeProvider paneId="reader-pane" visitId={assumePaneVisitId("00000000-0000-4000-8000-000000000001")}
                      isActive href={href} routeId="media" pathParams={{ id: mediaId }} canGoBack={false} canGoForward={false}
                      onNavigatePane={(_paneId, nextHref) => setHref(nextHref)} onReplacePane={(_paneId, nextHref) => setHref(nextHref)}
                      onActivateWorkspaceTarget={(request) => { setActivatedHref(request.target.href); return { kind: "ActivatedExisting", paneId: "reader-pane" }; }} onGoBackPane={() => {}} onGoForwardPane={() => {}}>
                      <output aria-label="Reader pane location">{href}</output>
                      <output aria-label="Activated reader destination">{activatedHref}</output>
                      <div data-pane-id="reader-pane" data-active="true" style={{ position: "fixed", inset: "40px", width: 720, height: 420, display: "flex" }}>
                        {/* The workspace host wraps every pane in this boundary; a pane defect must land here, not on the window. */}
                        <PaneRouteErrorBoundary paneId="reader-pane" visitId={assumePaneVisitId("00000000-0000-4000-8000-000000000001")}
                          resetKey={`reader-pane:${resolvePaneRouteIdentity(href).routeKey}`} slotMinWidth="720px" isActive>
                        <PaneShell paneId="reader-pane" routeKey={resolvePaneRouteIdentity(href).routeKey} routeHeader={{ kind: "Resource", pendingLabel: "Media" }} label="Exact reader composition"
                          returnMementoEnabled={false} queryNavigation="in-place" sizing={{ primaryWidthPx: 720, primaryMinWidthPx: 320, primaryMaxWidthPx: 1400,
                            renderedPrimarySlotWidthPx: 720, renderedPrimarySlotMinWidthPx: 320, renderedPrimarySlotMaxWidthPx: 1400, fixedChromeWidthPx: 0,
                            storedWidthCorrectionPx: null }} bodyMode="document" onResizePrimaryPane={() => {}} isActive>{readerOpen ? <MediaPaneBody /> : null}</PaneShell>
                        </PaneRouteErrorBoundary>
                      </div>
                    </PaneRuntimeProvider>
                  </ResourceActionRuntimeProvider></GlobalPlayerProvider></ResourceOverlaysProvider>
                </OfflineMediaProvider></LecternProvider></HostedReaderProgressProvider>
              </WorkspaceStoreProvider></KeybindingsProvider>
            </PaneReturnMementoProvider></LibraryPlacementControllerProvider></ShareControllerProvider></FeedbackProvider></MobileChromeProvider>
          </ReaderProvider>
        </ArtworkProvider></ResourceCacheProvider>
      </AuthenticatedAccountProvider>
    </RenderEnvironmentProvider>;
  }
  const view = render(<Pane />, { reactStrictMode: true });
  return { mediaId, accountId, figure: FIGURE, fragmentId: fragments[1], target: targets[1], targetOffset: prefix.length,
    linkWrites, finishLink() { pendingLinks.shift()?.finish(); }, failLink() { pendingLinks.shift()?.fail(); },
    highlightWrites, existingHighlight, finishHighlight() { pendingHighlights.shift()?.(); },
    stanceWrites, associationRequests,
    retireReader() { view.rerender(<Pane readerOpen={false} />); },
    pendingIntent: () => intents.next(accountId), secondRequested: () => pendingSecond.length > 0,
    failSecond() {
      for (const finish of pendingSecond.splice(0)) finish(new Response(JSON.stringify({ error: {
        code: "E_INTERNAL", message: "The selected source read failed." } }), {
        status: 500, headers: { "Content-Type": "application/json" },
      }));
    },
    finishSecond() { secondHeld = false; for (const finish of pendingSecond.splice(0)) finish(representation(members[1])); },
    close() { view.unmount(); for (const finish of pendingSecond.splice(0)) finish(representation(members[1]));
      for (const finish of pendingHighlights.splice(0)) finish();
      for (const pending of pendingLinks.splice(0)) pending.finish(); vi.unstubAllGlobals(); },
  };
}
