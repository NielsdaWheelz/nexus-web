"use client";

// A note (/notes/{id}): its body is the masthead, its links the outline below.
// Source arrivals inspect the acknowledged body without editing or selecting it.
import { useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState, FeedbackStatus, useFeedback, type FeedbackActions, type FeedbackContent } from "@/components/feedback/Feedback";
import type { NoteInspection } from "@/components/notes/NoteEditor";
import { UnavailableTexts } from "@/components/notes/NoteNotices";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { hasUnsavedText, useText } from "@/lib/notes/texts";
import { useOutline } from "@/lib/notes/useOutline";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneParam,
  usePaneRuntime,
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
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const sourceView = useRef<HTMLDivElement | null>(null);
  const { query, queryControls } = useOutlineFilter(outline, ref, "Filter note items");
  usePaneReturnReady(deleted || outline.status !== "loading");

  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
  useEffect(() => {
    if (delivery?.entry.kind !== "EditNoteBody" || outline.status !== "ready") return;
    if (!claim(delivery)) return;
    if (!deleted && delivery.entry.noteBlockId === blockId) outline.focusRow("", "end");
    else
      feedback.offer({ key: "note-entry", announcement: "Polite", content: { tone: "Neutral", title: "This note is no longer available." } });
  }, [blockId, claim, deleted, delivery, feedback, outline]);

  const [inspection, setInspection] = useState<{ view: NoteInspection; bodyText: string; version: number } | null>(null);
  const arrival = useSourceArrival({
    ready: !deleted && outline.status === "ready" && Boolean(text?.acked),
    sourceIdentity: text?.acked ? `${ref}:${text.acked.version}` : null,
    apply: async (arrival, context) => {
      if (arrival.kind !== "source") return false;
      const result = arrival.source;
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
  useResourceInspector({ scheme: "note_block", handle: deleted ? null : blockId, bodies: { linkedItems: connections } });
  const resourceRef = deleted ? undefined : canonicalResourceRef({ scheme: "note_block", id: blockId });
  usePaneChrome(useMemo(() => ({ query: queryControls, resourceRef }), [resourceRef, queryControls]));

  if (deleted) return hasUnsavedText(ref)
    ? <UnavailableTexts kind="note" refs={[ref]} />
    : <FeedbackState content={{ tone: "Neutral", title: "this note is no longer available" }} announcement="Polite" />;
  const unavailable = outline.failure?.status === 403 || outline.failure?.status === 404;
  const stale = isStaleBuild(outline.failure);
  const failure: FeedbackContent | null = outline.failure === null ? null : stale ? STALE_BUILD_FEEDBACK : {
    tone: "Warning",
    title: unavailable ? "this note is no longer available" :
      outline.root ? "couldn’t refresh connections" : "this note couldn’t be loaded",
    message: unavailable ? "it may have been removed or your access may have changed." :
      outline.root ? "the current outline remains in this tab." : undefined,
    requestId: outline.failure.requestId,
  };
  const actions: FeedbackActions | undefined = stale || unavailable
    ? undefined
    : [{ label: outline.root ? "retry refresh" : "retry loading", onClick: outline.reload, busy: outline.retrying }];
  if (failure !== null && (outline.root === null || unavailable || stale))
    return <FeedbackState content={failure} announcement="Polite" actions={actions} />;
  if (!outline.root) return <PaneLoadingState label="Loading note…" announcement="Polite" />;
  return (
    <div ref={sourceView} tabIndex={-1}>
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" actions={actions} />}
      {changedDraft || arrival.failure ? <FeedbackStatus content={{ tone: "Neutral", title: changedDraft ? "location unavailable in current draft" : arrival.failure! }} announcement="Polite" /> : null}
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
