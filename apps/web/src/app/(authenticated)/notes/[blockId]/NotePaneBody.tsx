"use client";

// A note (/notes/{id}): its body is the masthead, its links the outline below.
// `#passage-{anchor}` and chat citations pulse a range of the body; EditNoteBody focuses
// the body's end. Labelled by the body's first line.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import type { NotePulse } from "@/components/notes/NoteEditor";
import OutlineEditor, { useOutlineFilter } from "@/components/notes/OutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
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
      feedback.publish({
        kind: "Hud",
        content: { tone: "Neutral", title: "This note is no longer available." },
      });
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
    <>
      {passage.status === "ready" && passage.data === null ? (
        <p role="status">This passage is no longer available.</p>
      ) : null}
      {passage.status === "failed" ? <p role="alert">The passage could not be opened.</p> : null}
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
