"use client";

// A note (/notes/{id}): its body is the masthead, its links the outline below.
// `#passage-{anchor}` and chat citations pulse a range of the body; EditNoteBody focuses
// the body's end. Labelled by the body's first line.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackState, useFeedback, type FeedbackActions, type FeedbackContent } from "@/components/feedback/Feedback";
import type { NotePulse } from "@/components/notes/NoteEditor";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isStaleBuild, STALE_BUILD_COPY } from "@/lib/api/client";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { useText } from "@/lib/notes/texts";
import { useOutline } from "@/lib/notes/useOutline";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneHash,
  usePaneParam,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePassageResolution } from "@/lib/reader/passageResolution";
import { consumePendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import { useNotePulseHighlight, type NotePulseTarget } from "@/lib/reader/pulseEvent";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  // justify-defect: the note route always carries its id.
  if (!blockId) throw new Error("note route requires a block id");
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotePaneBody");
  const ref = `note_block:${blockId}`;
  const outline = useOutline({ root: ref, dailyDate: null });
  const text = useText(ref);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const { query, queryControls } = useOutlineFilter(outline, ref, "Filter note items");
  usePaneReturnReady(outline.status !== "loading");
  const firstLine = typeof text?.value === "object" ? text.value.body_text.split("\n")[0]!.trim() : "";
  useSetPaneLabel(text || outline.status === "failed" ? firstLine || "Note" : null);

  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
  useEffect(() => {
    if (delivery?.entry.kind !== "EditNoteBody" || outline.status !== "ready") return;
    if (!claim(delivery)) return;
    if (delivery.entry.noteBlockId === blockId) outline.focusRow("", "end");
    else
      feedback.offer({ key: "note-entry", announcement: "Polite", content: { tone: "Neutral", title: "This note is no longer available." } });
  }, [blockId, claim, delivery, feedback, outline]);

  const [pulse, setPulse] = useState<NotePulse | null>(null);
  const pulseAt = useCallback(
    (target: Pick<NotePulseTarget, "startOffset" | "endOffset">) =>
      setPulse((current) => ({
        startOffset: target.startOffset,
        endOffset: target.endOffset,
        serial: (current?.serial ?? 0) + 1,
      })),
    [],
  );
  useNotePulseHighlight((target) => {
    if (target.blockId === blockId) pulseAt(target);
  });
  useEffect(() => {
    const pending = consumePendingNoteActivation(blockId);
    if (pending) pulseAt(pending);
  }, [blockId, pulseAt]);
  const hash = usePaneHash();
  const passage = usePassageResolution({ hash, ownerScheme: "note_block", ownerId: blockId });
  const appliedHash = useRef<string | null>(null);
  useEffect(() => {
    if (!hash) appliedHash.current = null;
    if (passage.status !== "ready" || passage.data?.kind !== "NoteTextOffsets") return;
    if (appliedHash.current === hash) return;
    appliedHash.current = hash;
    pulseAt({ startOffset: passage.data.start_offset, endOffset: passage.data.end_offset });
    const query = runtime.searchParams.size ? `?${runtime.searchParams}` : "";
    runtime.router.replace(runtime.pathname + query);
  }, [hash, passage, pulseAt, runtime]);

  const connections = useMemo(
    () => <ConnectionsSurface resourceRef={{ scheme: "note_block", id: blockId }} />,
    [blockId],
  );
  useResourceInspector({ scheme: "note_block", handle: blockId, bodies: { linkedItems: connections } });
  const resourceRef = canonicalResourceRef({ scheme: "note_block", id: blockId });
  usePaneChrome(useMemo(() => ({ query: queryControls, resourceRef }), [resourceRef, queryControls]));

  const unavailable = outline.failure?.status === 403 || outline.failure?.status === 404;
  const stale = isStaleBuild(outline.failure);
  const failure: FeedbackContent | null = outline.failure === null ? null : {
    tone: "Warning",
    title: stale ? "the app needs to reload" : unavailable ? "this note is no longer available" :
      outline.root ? "this note couldn’t refresh" : "this note couldn’t be loaded",
    message: stale ? STALE_BUILD_COPY : unavailable ? "it may have been removed or your access may have changed." :
      outline.root ? "the current outline remains in this tab." : undefined,
    requestId: outline.failure.requestId,
  };
  const actions: FeedbackActions | undefined = stale
    ? [{ label: "reload app", onClick: () => window.location.reload() }]
    : unavailable ? undefined : [{ label: "retry loading", onClick: outline.reload, busy: outline.retrying }];
  if (failure !== null && (outline.root === null || unavailable || stale))
    return <FeedbackState content={failure} announcement="Polite" actions={actions} />;
  if (!outline.root) return <PaneLoadingState label="Loading note…" announcement="Polite" />;
  return (
    <>
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" actions={actions} />}
      {passage.status === "ready" && passage.data === null ? (
        <FeedbackNotice content={{ tone: "Neutral", title: "this passage is no longer available" }} announcement="Polite" />
      ) : null}
      {passage.status === "failed" ? <FeedbackNotice content={{ tone: "Warning", title: "this passage couldn’t be opened", requestId: passage.error.requestId }} announcement="Polite" actions={[{ label: "retry passage", onClick: passage.refetch, busy: passage.retrying }]} /> : null}
      <OutlineEditor
        outline={outline}
        filter={query}
        pulse={pulse}
        titleRef={titleRef}
        activateTarget={runtime.activateTarget}
      />
    </>
  );
}
