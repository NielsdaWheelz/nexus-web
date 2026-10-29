"use client";
/** A note's canonical body and relationships always read the device corpus. Source
 * arrivals inspect exact canonical text; whole-note arrival admits the loaded
 * resource locally. Neither arrival edits or replaces writing. */
import { matchScopeQuote, normalizeScopeText } from "@nexus/authored/scope";
import { normalizeQuote } from "@nexus/authored/identity";
import { useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import {useLocalOutlineRoot, type LocalOutlineHandle} from "@/components/notes/LocalOutline";
import Button from "@/components/ui/Button";
import type { NoteInspection } from "@/components/notes/NoteEditor";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneEntryDelivery, usePaneParam } from "@/lib/panes/paneRuntime";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");
  const ref = `note_block:${blockId}`;
  const outline = useRef<LocalOutlineHandle | null>(null);
  const [inspection, setInspection] = useState<{ text: string; view: NoteInspection } | null>(null);
  const rootField = useMemo(() => ({label: "note body", inspection: inspection?.view ?? null}), [inspection]);
  const read = useLocalOutlineRoot({rootRef: ref, apiRef: outline, rootField});
  const resource = read.rootRead.resource;
  const [error, setError] = useState<unknown | null>(null);
  usePaneReturnReady(read.rootRead.known || read.error !== null);
  const { delivery, claim } = usePaneEntryDelivery();
  useEffect(() => {
    const handle = outline.current;
    if (delivery?.entry.kind === "EditNoteBody" && read.rootRead.known && !resource) {claim(delivery); return;}
    if (delivery?.entry.kind !== "EditNoteBody" || !resource || !read.rootReady || !handle || !claim(delivery)) return;
    void handle.focusRoot().catch(setError);
  }, [resource, read.rootRead.known, read.rootReady, delivery, claim]);
  const arrival = useSourceArrival({
    ready: resource !== null && read.rootReady,
    sourceIdentity: resource?.body_text ?? null,
    apply: async (arrival, context) => {
      if (!resource || context.signal.aborted) return "Unavailable";
      const restored = context.purpose === "RestoreVisit" || context.restored;
      if (arrival.kind === "resource") {
        if (arrival.resource_ref !== resource.ref) return "Unavailable";
        if (!restored) {
          const handle = outline.current;
          handle?.revealRoot();
          if (context.mayFocus()) await handle?.focusRoot(() => ({anchor: 1, head: 1}), () => !context.signal.aborted && context.mayFocus());
        }
        return "Applied";
      }
      const text = resource.body_text ?? "";
      let range: { startOffset: number; endOffset: number } | null;
      if (arrival.kind === "passage") {
        const passage = arrival.passage;
        if (passage.source_ref !== ref) return "Unavailable";
        const normalized = normalizeScopeText(text);
        const match = matchScopeQuote([{ fragment_id: blockId, start_offset: 0, normalized_text: normalized.normalized_text,
          normalized_start_offset: 0, edits: normalized.edits, start_cut: false, end_cut: false }],
        passage.normalized_exact, passage.prefix, passage.suffix);
        if (!match) return "Unavailable";
        range = notePassageRange(text, match.start_offset, match.end_offset, passage.normalized_exact);
        if (!range) return "Unavailable";
      } else {
        if (arrival.kind !== "source") return "Unavailable";
        const location = arrival.source.location;
        if (location.kind === "resource") {
          if (!restored) {
            const handle = outline.current;
            handle?.revealRoot();
            if (context.mayFocus()) await handle?.focusRoot(() => ({anchor: 1, head: 1}), () => !context.signal.aborted && context.mayFocus());
          }
          return "Applied";
        }
        if (location.kind !== "located" || location.locator.type !== "note_block_offsets" || location.locator.block_id !== blockId) return "Unavailable";
        const locator = location.locator;
        const exact = locator.text_quote_selector?.exact;
        if (typeof exact !== "string" || Array.from(text).slice(locator.start_offset, locator.end_offset).join("") !== exact) return "Unavailable";
        range = { startOffset: locator.start_offset, endOffset: locator.end_offset };
      }
      if (context.signal.aborted) return "Unavailable";
      if (!restored) outline.current?.revealRoot();
      setInspection({ text, view: { text, ...range, activationId: context.activationId, signal: context.signal, mayFocus: context.mayFocus, restored } });
      context.signal.addEventListener("abort", () => setInspection(current => current?.view.activationId === context.activationId ? null : current), { once: true });
      return "Applied";
    },
  });
  const connections = useMemo(() => <ConnectionsSurface resourceRef={{ scheme: "note_block", id: blockId }} />, [blockId]);
  useResourceInspector({ scheme: "note_block", handle: resource ? blockId : null, bodies: { linkedItems: connections } });
  const resourceRef = resource ? canonicalResourceRef({ scheme: "note_block", id: blockId }) : undefined;
  usePaneChrome({resourceRef, editor: resource ? read.rootEditor ?? undefined : undefined, displayTitle: resource ? read.rootTitle ?? undefined : undefined,
    header: resource ? {kind: "Resource", resource: {status: "Ready", creditGroups: []}} : undefined});
  if (!resource) {
    if (read.error) return <div role="alert"><p>couldn’t open this note on this device.</p><Button onClick={read.retry}>retry</Button></div>;
    if (!read.rootRead.known) return <p>opening note…</p>;
    return <p>this note is no longer available.</p>;
  }
  return <div>
    {arrival.failure ? <p role="status">{arrival.failure.title}</p> : null}
    {error ? <p role="alert">{error instanceof Error ? error.message : "couldn’t save this change on this device."}</p> : null}
    {read.view}
  </div>;
}

/** Same projection as text_quote.project_note_match: equal NFD components retain
 * occurrence order through NFC. Refuse a hit that cannot name one exact interval. */
function notePassageRange(text: string, start: number, end: number, exact: string): { startOffset: number; endOffset: number } | null {
  const nfc = text.normalize("NFC");
  if (nfc === text) return normalizeQuote(Array.from(text).slice(start, end).join("")) === exact ? { startOffset: start, endOffset: end } : null;
  const count = (value: string) => {
    const counts = new Map<string, number>();
    for (const component of value.normalize("NFD")) counts.set(component, (counts.get(component) ?? 0) + 1);
    return counts;
  };
  const normalized = Array.from(nfc), raw = Array.from(text);
  const remaining = count(normalized.slice(start, end).join(""));
  const preceding = count(normalized.slice(0, start).join(""));
  let from = raw.length, to = 0;
  for (const [index, char] of raw.entries()) {
    for (const component of char.normalize("NFD")) {
      if (!remaining.has(component)) continue;
      const before = preceding.get(component) ?? 0;
      if (before > 0) preceding.set(component, before - 1);
      else if ((remaining.get(component) ?? 0) > 0) {
        remaining.set(component, remaining.get(component)! - 1);
        from = Math.min(from, index); to = index + 1;
      }
    }
  }
  return normalizeQuote(raw.slice(from, to).join("")) === exact ? { startOffset: from, endOffset: to } : null;
}
