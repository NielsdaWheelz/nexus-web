"use client";
/** A note's canonical body and relationships always read the device corpus. Source
 * arrivals inspect exact canonical text; they never edit or replace writing. */
import { useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import LocalOutline, {type LocalOutlineHandle} from "@/components/notes/LocalOutline";
import type { NoteInspection } from "@/components/notes/NoteEditor";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { OutlineHistory } from "@/lib/notes/structure";
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
  const runtime = useWritingRuntime();
  const read = useAuthoredQuery({ kind: "resource", ref });
  const resource = read.data?.rows[0]?.resource ?? null;
  const sourceView = useRef<HTMLDivElement>(null);
  const outline = useRef<LocalOutlineHandle | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const history = useMemo(() => runtime ? new OutlineHistory(runtime, setError) : null, [runtime]);
  useEffect(() => () => history?.close(), [history]);
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
      if (arrival.kind !== "source" || !resource) return "Unavailable";
      const location = arrival.source.location;
      if (location.kind === "resource") { if (context.mayFocus()) sourceView.current?.focus({ preventScroll: true }); return "Applied"; }
      if (location.kind !== "located" || location.locator.type !== "note_block_offsets" || location.locator.block_id !== blockId) return "Unavailable";
      const locator = location.locator, text = resource.body_text ?? "";
      const exact = locator.text_quote_selector?.exact;
      if (typeof exact !== "string" || Array.from(text).slice(locator.start_offset, locator.end_offset).join("") !== exact || context.signal.aborted) return "Unavailable";
      setInspection({ text, view: { startOffset: locator.start_offset, endOffset: locator.end_offset, activationId: context.activationId, signal: context.signal, mayFocus: context.mayFocus, restored: context.restored } });
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
    <LocalOutline rootRef={ref} apiRef={outline} session={history ?? undefined} rootEditor={owner => <BoundNoteEditor noteRef={ref} label="edit note" session={owner.history}
      inspection={inspection?.text === resource.body_text ? inspection.view : null}
      structuralKeys={owner.structuralKeys} onEditorReady={owner.onEditorReady} onSelectionChange={owner.onSelectionChange} onSplit={owner.onSplit}/>} />
  </div>;
}
