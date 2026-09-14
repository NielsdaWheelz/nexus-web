import { afterEach, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import "@/app/globals.css";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { READER_CAPACITY } from "./readerCapacity";
import { prepareReaderUnit } from "./publicationDom";
import { pulsePublicationSource } from "./publicationSourcePulse";

afterEach(async () => { vi.unstubAllGlobals(); await cdp().send("Emulation.setEmulatedMedia", { features: [] }); });

it.each(["no-preference", "reduce"])("pulses only verified visible text and retires admitted rectangles with motion preference %s", async (motion) => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const accountId = crypto.randomUUID();
  const text = "unrelated prefix\nEXACT CITED FIRST LINE\nEXACT CITED SECOND LINE\nunrelated suffix";
  const start = text.indexOf("EXACT");
  const end = text.indexOf("\nunrelated suffix");
  const encode = async (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { bytes, hash };
  };
  const member = await encode({ fragment_id: mediaId, fragment_idx: 0, fragment_document_start_cp: 0,
    fragment_length_cp: text.length, document_word_start: 0, starts_in_word: false, epub_target: null,
    document_embeds: [], start_cp: 0, end_cp: text.length, render_start_cp: 0, render_end_cp: text.length,
    canonical_text: text.replaceAll("\n", " "), word_boundaries: [], assets: [], table_contexts: [], render_nodes: [
      { kind: "Element", parent: null, namespace: "html", name: "pre", attributes: [] },
      { kind: "Text", parent: 0, text },
    ] });
  const reference = { key: "units/0.json", bytes: member.bytes.byteLength,
    sha256: Array.from(member.hash, (value) => value.toString(16).padStart(2, "0")).join("") };
  const descriptor = await encode({ media_id: mediaId, reader_generation: 7, reader_contract_version: 1,
    kind: "web_article", title: "Selected source", canonical_length: text.length, unit_count: 1,
    first_unit_ref: reference, contents_ref: null, table_metadata_ref: null,
    index_ref: { key: "index/0.json", bytes: 1, sha256: "a".repeat(64) } });
  const representation = (value: typeof member) => new Response(value.bytes, { headers: {
    "Content-Type": "application/json", "Content-Length": String(value.bytes.byteLength),
    "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...value.hash))}:`, "X-Nexus-Reader-Generation": "7",
  } });
  const json = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  const locator = { type: "web_text_offsets" as const, media_id: mediaId, fragment_id: mediaId,
    start_offset: start, end_offset: end,
    text_quote_selector: { exact: text.slice(start, end), prefix: "unrelated prefix\n", suffix: "\nunrelated suffix" } };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/reader-publication")) return representation(descriptor);
    if (path.endsWith("/offline-reader-state")) return json({ accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } });
    if (path.endsWith("/units/0.json")) return representation(member);
    if (path.endsWith("/reader-publications/7/resolve")) {
      expect(JSON.parse(String(init?.body))).toEqual({ target: { kind: "SourceRange", locator } });
      return json({ kind: "SourceRange", unit_ref: reference, ordinal: 0, previous_ref: null, next_ref: null,
        fragment_id: mediaId, range: { unit_key: reference.key, fragment_id: mediaId, start_cp: start, end_cp: end },
        locator: { kind: "web", target: { fragment_id: mediaId },
          locations: { text_offset: start, progression: null, total_progression: null, position: null },
          text: { quote: null, quote_prefix: null, quote_suffix: null } } });
    }
    throw new Error(`Source pulse escaped its selected publication: ${path}`);
  });
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(mediaId) });
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:20px;top:20px;width:340px;font:16px/24px monospace";
  document.body.append(container);
  try {
    await session.load(new AbortController().signal, { fresh: null, cold: null });
    const acquired = session.acquireUnit({ unit_ref: reference, ordinal: 0, previous_ref: null, next_ref: null });
    if (acquired.kind !== "Acquired" || session.sourceRange === null) throw new Error("Source pulse prerequisites unavailable");
    const loaded = await acquired.lease.promise;
    if (loaded.kind !== "Unit") throw new Error("Source unit was not admitted");
    const prepared = prepareReaderUnit({ session, unit: loaded.unit, unitKey: reference.key, highlights: [], headingLevelOffset: 0 });
    if (prepared.kind !== "Ready") throw new Error("Source DOM was not admitted");
    const view = prepared.value;
    container.append(view.root);
    view.root.querySelector("pre")!.style.cssText = "margin:0;font:inherit";
    const baseline = session.residency;
    try {
      const source = await session.sourceRange(locator, new AbortController().signal);
      if (source.kind !== "Acquired" || source.lease.result.kind !== "SourceRange") throw new Error("Verified source unavailable");
      expect(session.residency.payloadBytes, "verified quote has no retained reservation").toBeGreaterThan(baseline.payloadBytes);
      const sourceNode = view.root.querySelector("pre")!.firstChild!;
      const exact = document.createRange(); exact.setStart(sourceNode, start); exact.setEnd(sourceNode, end);
      const sourceRects = [...exact.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      expect(sourceRects.length).toBeGreaterThanOrEqual(2);
      // Half of the first cited line and all of the second are visible. Neither
      // neighboring uncited line belongs to the cue.
      const viewport = new DOMRect(20, sourceRects[0].top + sourceRects[0].height / 2, 340, 48);
      const expected = sourceRects.map((rect) => ({ left: Math.max(rect.left, viewport.left), top: Math.max(rect.top, viewport.top),
        right: Math.min(rect.right, viewport.right), bottom: Math.min(rect.bottom, viewport.bottom) }))
        .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
      const controller = new AbortController();
      const pulse = pulsePublicationSource({ parts: [{ unitKey: reference.key, fragmentId: mediaId, renderStart: 0, root: view.root, cursor: view.cursor }],
        range: source.lease.result.range, viewport, lease: source.lease, signal: controller.signal });
      if ("kind" in pulse) throw new Error("Ordinary source cue exhausted admission");
      const nodes = [...view.root.querySelectorAll<HTMLElement>("[data-nexus-reader-overlay='source-pulse']")];
      expect(nodes.length, "source cue lost its exact visible range").toBe(expected.length);
      for (const [index, node] of nodes.entries()) {
        const rect = node.getBoundingClientRect();
        expect({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, "source cue painted an uncited range").toEqual(expected[index]);
      }
      expect(view.root.textContent).toBe(text);
      expect(session.residency.domNodes - baseline.domNodes).toBe(nodes.length);
      if (motion === "reduce") {
        const animation = nodes[0].getAnimations()[0];
        if (animation === undefined) throw new Error("Reduced-motion source has no visible cue lifetime");
        await animation.ready;
        const duration = animation.effect?.getTiming().duration;
        if (typeof duration !== "number") throw new Error("Source cue duration is not finite");
        await vi.waitFor(() => expect(Number(animation.currentTime)).toBeGreaterThan(duration / 2));
        expect(nodes[0].isConnected, "reduced-motion source cue disappeared before a visible frame").toBe(true);
        expect(Number(getComputedStyle(nodes[0]).opacity), "reduced-motion source cue faded while presented").toBeCloseTo(0.65);
      }
      expect(await pulse.finished, "source cue never completed its actual animation").toBe(true);
      expect(nodes.every((node) => !node.isConnected)).toBe(true);
      source.lease.release();
      expect(session.residency, "source cue did not return to its pre-query occupancy").toEqual(baseline);

      const cancelled = await session.sourceRange(locator, new AbortController().signal);
      if (cancelled.kind !== "Acquired" || cancelled.lease.result.kind !== "SourceRange") throw new Error("Second verified source unavailable");
      const cancel = new AbortController();
      const second = pulsePublicationSource({ parts: [{ unitKey: reference.key, fragmentId: mediaId, renderStart: 0, root: view.root, cursor: view.cursor }],
        range: cancelled.lease.result.range, viewport, lease: cancelled.lease, signal: cancel.signal });
      if ("kind" in second) throw new Error("Second source cue exhausted admission");
      cancel.abort();
      expect(await second.finished).toBe(false);
      expect(view.root.querySelector("[data-nexus-reader-overlay='source-pulse']"), "cancelled source retained its cue DOM").toBeNull();
      cancelled.lease.release();
      expect(session.residency).toEqual(baseline);
    } finally { view.release(); acquired.lease.release(); }
  } finally { container.remove(); session.close(); runtime.close(); }
});
