"use client";
/** A note's canonical body and relationships always read the device corpus. Source
 * arrivals inspect exact canonical text; whole-note arrival admits the loaded
 * resource locally. Neither arrival edits or replaces writing. */
import { matchScopeQuote, normalizeScopeText } from "@nexus/authored/scope";
import {bodyPassageRange} from "@/lib/notes/inspection";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAuthoredStorageFailure, LocalCommitError } from "@/lib/notes/runtime";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import {useLocalOutlineRoot, type LocalOutlineHandle} from "@/components/notes/LocalOutline";
import {useOutcome} from "@/components/feedback/Feedback";
import {Fact} from "@/components/feedback/Fact";
import type { NoteInspection } from "@/components/notes/NoteEditor";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneEntryDelivery, usePaneParam, usePaneSearchParams } from "@/lib/panes/paneRuntime";
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
  const entering = usePaneSearchParams().get("via") ?? undefined;
  const read = useLocalOutlineRoot({rootRef: ref, apiRef: outline, rootField, entering});
  const resource = read.rootRead.resource;
  const {say} = useOutcome();
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  usePaneReturnReady(read.ready || read.error !== null || read.rootRead.known && !resource);
  const { delivery, claim } = usePaneEntryDelivery();
  useEffect(() => {
    const handle = outline.current;
    if (delivery?.entry.kind === "EditNoteBody" && read.rootRead.known && !resource) {claim(delivery); return;}
    if (delivery?.entry.kind !== "EditNoteBody" || !resource || !read.rootReady || !handle || !claim(delivery)) return;
    void handle.focusRoot().catch(error => {
      if (isAuthoredStorageFailure(error)) say({fact: "couldn’t start writing in this note."});
      else if (!(error instanceof LocalCommitError)) setDefect({error});
    });
  }, [resource, read.rootRead.known, read.rootReady, delivery, claim, say]);
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
        range = bodyPassageRange(text, match.start_offset, match.end_offset, passage.normalized_exact);
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
  // An arrival's failure is its command's outcome: one slip, retracted when it clears.
  const arrivalFailure = arrival.failure?.title ?? null;
  useEffect(() => arrivalFailure === null ? undefined : say({fact: arrivalFailure}), [arrivalFailure, say]);
  if (defect) throw defect.error;
  if (!resource) {
    // Until the root is known, the outline's view owns the empty region: its ruling or its failure.
    if (!read.rootRead.known) return <>{read.view}</>;
    return <Fact line={{fact: "this note is no longer available."}}/>;
  }
  return <div>
    {read.view}
  </div>;
}
