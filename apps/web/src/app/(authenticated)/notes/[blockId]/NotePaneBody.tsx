"use client";
/** A note's canonical body and relationships always read the device corpus. Source
 * arrivals inspect exact canonical text; they never edit or replace writing. */
import { matchScopeQuote, normalizeScopeText } from "@nexus/authored/scope";
import { normalizeQuote } from "@nexus/authored/identity";
import { useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import LocalOutline, {type LocalOutlineHandle} from "@/components/notes/LocalOutline";
import type { NoteInspection } from "@/components/notes/NoteEditor";
import { useAuthoredQuery } from "@/lib/notes/hooks";
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
  const read = useAuthoredQuery({ kind: "resource", ref });
  const resource = read.data?.rows[0]?.resource ?? null;
  const sourceView = useRef<HTMLDivElement>(null);
  const outline = useRef<LocalOutlineHandle | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  usePaneReturnReady(read.data !== null || read.error !== null);
  const { delivery, claim } = usePaneEntryDelivery();
  useEffect(() => {
    const handle = outline.current;
    if (delivery?.entry.kind !== "EditNoteBody" || !resource || !handle || !claim(delivery)) return;
    void handle.focusRoot().catch(setError);
  }, [resource, delivery, claim]);
  const [inspection, setInspection] = useState<{ text: string; view: NoteInspection } | null>(null);
  const arrival = useSourceArrival({
    ready: resource !== null,
    sourceIdentity: resource?.body_text ?? null,
    apply: async (arrival, context) => {
      if (!resource || context.signal.aborted) return "Unavailable";
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
        if (location.kind === "resource") { if (context.mayFocus()) sourceView.current?.focus({ preventScroll: true }); return "Applied"; }
        if (location.kind !== "located" || location.locator.type !== "note_block_offsets" || location.locator.block_id !== blockId) return "Unavailable";
        const locator = location.locator;
        const exact = locator.text_quote_selector?.exact;
        if (typeof exact !== "string" || Array.from(text).slice(locator.start_offset, locator.end_offset).join("") !== exact) return "Unavailable";
        range = { startOffset: locator.start_offset, endOffset: locator.end_offset };
      }
      setInspection({ text, view: { text, ...range, activationId: context.activationId, signal: context.signal, mayFocus: context.mayFocus, restored: context.restored } });
      context.signal.addEventListener("abort", () => setInspection(current => current?.view.activationId === context.activationId ? null : current), { once: true });
      return "Applied";
    },
  });
  const connections = useMemo(() => <ConnectionsSurface resourceRef={{ scheme: "note_block", id: blockId }} />, [blockId]);
  useResourceInspector({ scheme: "note_block", handle: resource ? blockId : null, bodies: { linkedItems: connections } });
  const resourceRef = resource ? canonicalResourceRef({ scheme: "note_block", id: blockId }) : undefined;
  usePaneChrome(useMemo(() => ({ resourceRef }), [resourceRef]));
  if (read.error) return <p role="alert">couldn’t open this note on this device.</p>;
  if (!read.data) return <p>opening note…</p>;
  if (!resource) return <p>this note is no longer available.</p>;
  return <div ref={sourceView} tabIndex={-1}>
    {arrival.failure ? <p role="status">{arrival.failure.title}</p> : null}
    {error ? <p role="alert">{error instanceof Error ? error.message : "couldn’t save this change on this device."}</p> : null}
    <LocalOutline rootRef={ref} apiRef={outline} rootField={{label: "edit note", inspection: inspection?.text === resource.body_text ? inspection.view : null}} />
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
