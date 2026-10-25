"use client";

// A visit retains selected files, upload attempts and its current position. Hiding
// it leaves the pipeline running; visit/account loss stops future browser work.
// Upload is server-owned; each uploaded file then links to the owner in one local
// commit. A failed local commit retries its frozen command, never a fresh link.
import { useRef } from "react";
import { Paperclip } from "lucide-react";
import Button from "@/components/ui/Button";
import { FeedbackNotice, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { captureErrorFeedback } from "@/lib/imports/copy";
import { createUploadAttempt, getFileUploadError, reviewUploadAttempt, uploadIngestFile, type UploadAttempt } from "@/lib/imports/ingest";
import { UploadSessionError } from "@/lib/imports/api";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { createLink } from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";

interface Task {
  readonly files: readonly { file: File; upload: UploadAttempt }[];
  index: number;
  mediaId: string | null;
  running: boolean;
  unconfirmed: boolean;
  failure: FeedbackContent | null;
  /** The frozen retry of a link whose local commit failed. */
  retryLink: (() => Promise<unknown>) | null;
}

export function useConnectionAttachments(selfRef: string) {
  const feedback = useFeedback();
  const { ctx } = useActionRuntime();
  const writing = useWritingRuntime();
  const guard = useWorkGuard();
  const scope = usePaneVisitWorkScope();
  const workspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const owner = useResourceDraft<{ task: Task | null; defect: { error: unknown } | null }>(`ConnectionAttachments:${selfRef}`, () => ({ task: null, defect: null }), value => {
    const task = value.task;
    // Work remains until the last file is linked, including its link commit and any held retry.
    const remaining = task !== null && task.index < task.files.length;
    return { changed: remaining || task?.failure != null, unconfirmed: task?.unconfirmed ?? false, stopsBrowserWork: task?.running === true && remaining };
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const publish = () => owner.set(value => ({ ...value }));

  async function run(task: Task) {
    if (task.running || owner.read().task !== task || writing === null) return;
    const controller = new AbortController();
    const account = ctx.sessionSignal();
    const abort = () => controller.abort();
    account.addEventListener("abort", abort, { once: true });
    if (account.aborted) controller.abort();
    const owned = () => workspace().state.panes.some(pane => [pane.current_visit, ...pane.history.back, ...pane.history.forward]
      .some(visit => visit.id === scope.visitId && resolvePaneRouteModel(visit.href).routeKey === scope.routeKey));
    const stop = subscribeWorkspace(() => { if (!owned()) controller.abort(); });
    task.running = true;
    task.failure = null;
    publish();
    try {
      while (task.index < task.files.length && !controller.signal.aborted) {
        const item = task.files[task.index]!;
        if (task.mediaId === null) {
          task.unconfirmed = true;
          publish();
          const uploaded = await uploadIngestFile({ file: item.file, attempt: item.upload, signal: controller.signal });
          if (controller.signal.aborted || owner.read().task !== task) return;
          task.unconfirmed = false;
          if (!uploaded.available) {
            task.failure = { tone: "Warning", title: "this item was saved, then removed" };
            publish();
            return;
          }
          task.mediaId = uploaded.mediaId;
          publish();
        }
        if (task.retryLink !== null) {
          // The frozen retry stays held until it lands; a second failure keeps it.
          await task.retryLink();
          task.retryLink = null;
        } else {
          // Linking never waits for a server label: a remote owner keeps its stub label, else its literal ref.
          const local = /^(note_block|page|highlight):/u.test(selfRef) ? null
            : (await (await writing.store).query({ kind: "resource", ref: selfRef })).rows[0]?.resource.title ?? selfRef;
          if (controller.signal.aborted || owner.read().task !== task) return;
          await createLink(writing, { source_ref: selfRef, target_ref: `media:${task.mediaId}`,
            source_label: local, target_label: item.file.name, after: null });
        }
        if (account.aborted || owner.read().task !== task) return;
        task.index += 1;
        task.mediaId = null;
        publish();
      }
      if (!controller.signal.aborted && owner.read().task === task) owner.set({ task: null, defect: null });
    } catch (error) {
      // A failed commit keeps its frozen retry even when this visit's browser work stops.
      if (error instanceof LocalCommitError) task.retryLink = error.retry;
      if (account.aborted || owner.read().task !== task || controller.signal.aborted) return;
      if (task.retryLink !== null) {
        task.failure = { tone: "Warning", title: "file saved; couldn’t link it on this device", message: "keep this page open. retry saving." };
        return;
      }
      if (error instanceof UploadSessionError && error.outcome.kind !== "Unresolved") task.unconfirmed = false;
      if (handleUnauthenticatedApiError(error)) return;
      try { task.failure = task.mediaId === null ? captureErrorFeedback(error, "AddAttachment")
        : { tone: "Warning", title: "file saved; link not made", message: "check your connection, then link it again." }; }
      catch (defect) { owner.set(value => ({ ...value, defect: { error: defect } })); }
    } finally {
      stop();
      account.removeEventListener("abort", abort);
      task.running = false;
      if (!account.aborted && owner.read().task === task) publish();
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function attachFiles(files: File[]) {
    const prior = owner.read().task;
    // A held local retry blocks every later command; it must land before new files link.
    if (prior?.running || prior?.retryLink || writing === null) return;
    const accepted: Task["files"][number][] = [];
    for (const file of files) {
      const invalid = getFileUploadError(file);
      if (invalid) feedback.receipt({ tone: "Warning", title: "file wasn’t added", message: invalid });
      else accepted.push({ file, upload: createUploadAttempt() });
    }
    if (!accepted.length) return;
    if (prior !== null && !guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] })) return;
    const task: Task = { files: accepted, index: 0, mediaId: null, running: false, unconfirmed: false, failure: null, retryLink: null };
    owner.set({ task, defect: null });
    void run(task);
  }
  if (owner.value.defect !== null) throw owner.value.defect.error;
  const { task } = owner.value;
  const upload = task?.files[task.index]?.upload;
  return {
    attaching: task?.running ?? false,
    dropProps: {
      onDragOver: (event: React.DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); },
      onDrop: (event: React.DragEvent<HTMLElement>) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); event.stopPropagation(); attachFiles(files); } },
    },
    control: <>
      <Button type="button" iconOnly aria-label="Upload and link file" onClick={() => fileInputRef.current?.click()} disabled={task?.running || writing === null} aria-busy={task?.running} icon={<Paperclip size={14} aria-hidden="true" />} />
      <input ref={fileInputRef} type="file" multiple hidden tabIndex={-1} onChange={event => attachFiles(Array.from(event.currentTarget.files ?? []))} />
      {task?.failure ? <FeedbackNotice content={task.failure} announcement="Polite" actions={[{
        label: task.retryLink ? "retry saving" : task.mediaId !== null ? "link again" : upload?.expired ? "choose the file again" : upload?.review_required ? "review and save" : "check save",
        onClick: () => {
          if (task.retryLink === null && task.mediaId === null && upload?.expired) { fileInputRef.current?.click(); return; }
          if (task.retryLink === null && task.mediaId === null && upload !== undefined) reviewUploadAttempt(upload);
          void run(task);
        } }]} /> : null}
    </>,
  };
}
