"use client";

// A note (/notes/{id}): its body is the masthead, its links the outline below.
// Source arrivals inspect the acknowledged body without editing or selecting it.
import { useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import type { NoteInspection } from "@/components/notes/NoteEditor";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { useText } from "@/lib/notes/texts";
import { useOutline } from "@/lib/notes/useOutline";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { isDeletedResource } from "@/lib/resourceGraph/links";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  // justify-defect: the note route always carries its id.
  if (!blockId) throw new Error("note route requires a block id");
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotePaneBody");
  const ref = `note_block:${blockId}`;
  const deleted = isDeletedResource(ref);
  const outline = useOutline({ root: ref, dailyDate: null });
  const text = useText(ref);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const sourceView = useRef<HTMLDivElement | null>(null);
  const { query, queryControls } = useOutlineFilter(outline, ref, "Filter note items");
  usePaneReturnReady(deleted || outline.status !== "loading");
  const firstLine = typeof text?.value === "object" ? text.value.body_text.split("\n")[0]!.trim() : "";
  useSetPaneLabel(deleted ? "Deleted note" : text || outline.status === "failed" ? firstLine || "Note" : null);

  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
  useEffect(() => {
    if (delivery?.entry.kind !== "EditNoteBody" || outline.status !== "ready") return;
    if (!claim(delivery)) return;
    if (!deleted && delivery.entry.noteBlockId === blockId) outline.focusRow("", "end");
    else
      feedback.publish({
        kind: "Hud",
        content: { tone: "Neutral", title: "This note is no longer available." },
      });
  }, [blockId, claim, deleted, delivery, feedback, outline]);

  const [inspection, setInspection] = useState<{ view: NoteInspection; bodyText: string; version: number } | null>(null);
  const arrival = useSourceArrival({
    ready: !deleted && outline.status === "ready" && Boolean(text?.acked),
    sourceIdentity: text?.acked ? `${ref}:${text.acked.version}` : null,
    apply: async (result, context) => {
      if (result.location.kind === "resource") {
        if (context.mayFocus()) sourceView.current?.focus({ preventScroll: true });
        return true;
      }
      if (result.location.kind !== "located" || result.location.locator.type !== "note_block_offsets") return false;
      const locator = result.location.locator;
      const saved = text?.acked;
      const shown = text?.value;
      if (!saved || typeof saved.value === "string" || typeof shown !== "object" ||
          locator.block_id !== blockId || locator.body_version !== saved.version ||
          shown.body_text !== saved.value.body_text) return false;
      const exact = Array.from(shown.body_text).slice(locator.start_offset, locator.end_offset).join("");
      if (locator.text_quote_selector?.exact !== exact || context.signal.aborted) return false;
      setInspection({ bodyText: shown.body_text, version: saved.version, view: {
        startOffset: locator.start_offset, endOffset: locator.end_offset,
        activationId: context.activationId, signal: context.signal,
        mayFocus: context.mayFocus, restored: context.restored,
      } });
      context.signal.addEventListener("abort", () => {
        setInspection((current) => current?.view.activationId === context.activationId ? null : current);
      }, { once: true });
      return true;
    },
  });

  const currentInspection = inspection && typeof text?.value === "object" && text.value.body_text === inspection.bodyText && text.acked?.version === inspection.version ? inspection.view : null;
  const changedDraft = (inspection !== null || arrival.failure !== null) && typeof text?.value === "object" && typeof text.acked?.value === "object" && text.value.body_text !== text.acked.value.body_text;

  const connections = useMemo(
    () => <ConnectionsSurface resourceRef={{ scheme: "note_block", id: blockId }} />,
    [blockId],
  );
  useResourceInspector({ scheme: "note_block", handle: blockId, bodies: { linkedItems: connections } });
  const resourceRef = canonicalResourceRef({ scheme: "note_block", id: blockId });
  usePaneChrome(useMemo(() => ({ query: queryControls, resourceRef }), [resourceRef, queryControls]));

  if (deleted) return <p role="status">This note was deleted.</p>;
  if (outline.status === "failed")
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "This note couldn’t be loaded" }}
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: () => void outline.reload() }]}
      />
    );
  if (!outline.root) return <PaneLoadingState label="Loading note…" announcement="Polite" />;
  return (
    <div ref={sourceView} tabIndex={-1}>
      {changedDraft ? <p role="status">location unavailable in current draft</p> : arrival.failure ? <p role="status">{arrival.failure}</p> : null}
      <OutlineEditor
        outline={outline}
        filter={query}
        inspection={currentInspection}
        titleRef={titleRef}
        activateTarget={runtime.activateTarget}
      />
    </div>
  );
}
