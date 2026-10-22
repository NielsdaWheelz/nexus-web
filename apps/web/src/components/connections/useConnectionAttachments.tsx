"use client";

// A visit retains selected files, upload/link ids and its current position.
// Hiding it leaves the pipeline running. Actual visit/account loss stops future
// browser work; uploaded media and the shared queue's admitted links survive.
import { useRef } from "react";
import { Paperclip } from "lucide-react";
import Button from "@/components/ui/Button";
import { FeedbackNotice, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { captureErrorFeedback } from "@/lib/imports/copy";
import { createUploadAttempt, getFileUploadError, reviewUploadAttempt, uploadIngestFile, type UploadAttempt } from "@/lib/imports/ingest";
import { UploadSessionError } from "@/lib/imports/api";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { isWriteRejection } from "@/lib/notes/writes";
import { createLink } from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";

interface Task {
  readonly files: readonly { file: File; upload: UploadAttempt; linkId: string }[];
  index: number;
  mediaId: string | null;
  running: boolean;
  unconfirmed: boolean;
  failure: FeedbackContent | null;
}

export function useConnectionAttachments(selfRef: string) {
  const feedback = useFeedback();
  const { ctx } = useActionRuntime();
  const guard = useWorkGuard();
  const scope = usePaneVisitWorkScope();
  const workspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const owner = useResourceDraft<{ task: Task | null; defect: { error: unknown } | null }>(`ConnectionAttachments:${selfRef}`, () => ({ task: null, defect: null }), value => {
    const task = value.task;
    const remaining = task !== null && (task.mediaId === null || task.index < task.files.length - 1);
    return { changed: remaining || task?.failure != null, unconfirmed: task?.unconfirmed ?? false, stopsBrowserWork: task?.running === true && remaining };
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const publish = () => owner.set(value => ({ ...value }));

  async function run(task: Task) {
    if (task.running || owner.read().task !== task) return;
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
          if (!uploaded.available) {
            task.unconfirmed = false;
            task.failure = { tone: "Warning", title: "this item was saved, then removed" };
            publish();
            return;
          }
          task.mediaId = uploaded.mediaId;
          task.unconfirmed = false;
          publish();
        }
        // Once queued, this exact link belongs to the tab's write owner.
        const result = await createLink({ link_id: item.linkId, source: { kind: "resource", ref: selfRef },
          target: { kind: "resource", ref: `media:${task.mediaId}` }, position: null });
        if (account.aborted) return;
        feedback.receipt({ tone: result.created ? "Success" : "Info", title: result.created ? "linked" : "already linked" });
        if (controller.signal.aborted || owner.read().task !== task) return;
        task.index += 1;
        task.mediaId = null;
        publish();
      }
      if (!controller.signal.aborted && owner.read().task === task) owner.set({ task: null, defect: null });
    } catch (error) {
      if (controller.signal.aborted || owner.read().task !== task) return;
      if (error instanceof UploadSessionError && error.outcome.kind !== "Unresolved") task.unconfirmed = false;
      if (handleUnauthenticatedApiError(error)) return;
      // The link's answered defect may have landed: the retry resends this same link id.
      if (task.mediaId !== null && !isWriteRejection(error))
        task.failure = { tone: "Danger", title: "Attachment wasn’t added", message: "the file is saved; its link wasn’t confirmed. retry sends the same link." };
      else try { task.failure = captureErrorFeedback(error, "AddAttachment"); }
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
    if (prior?.running) return;
    const accepted: Task["files"][number][] = [];
    for (const file of files) {
      const invalid = getFileUploadError(file);
      if (invalid) feedback.offer({ key: "connection-attachment", announcement: "Polite", content: { tone: "Warning", title: "file wasn’t added", message: invalid } });
      else accepted.push({ file, upload: createUploadAttempt(), linkId: crypto.randomUUID() });
    }
    if (!accepted.length) return;
    if (prior !== null && !guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] })) return;
    const task: Task = { files: accepted, index: 0, mediaId: null, running: false, unconfirmed: false, failure: null };
    owner.set({ task, defect: null });
    void run(task);
  }
  if (owner.value.defect !== null) throw owner.value.defect.error;
  const { task } = owner.value;
  return {
    attaching: task?.running ?? false,
    dropProps: {
      onDragOver: (event: React.DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); },
      onDrop: (event: React.DragEvent<HTMLElement>) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); event.stopPropagation(); attachFiles(files); } },
    },
    control: <>
      <Button type="button" iconOnly aria-label="Upload and link file" onClick={() => fileInputRef.current?.click()} disabled={task?.running} aria-busy={task?.running} icon={<Paperclip size={14} aria-hidden="true" />} />
      <input ref={fileInputRef} type="file" multiple hidden tabIndex={-1} onChange={event => attachFiles(Array.from(event.currentTarget.files ?? []))} />
      {task?.failure ? <FeedbackNotice content={task.failure} announcement="Polite" actions={[{ label: task.files[task.index]?.upload.expired ? "choose the file again" : task.files[task.index]?.upload.review_required ? "review and save" : "check save", onClick: () => {
        const upload = task.files[task.index]?.upload;
        if (upload?.expired) { fileInputRef.current?.click(); return; }
        if (upload !== undefined) reviewUploadAttempt(upload);
        void run(task);
      } }]} /> : null}
    </>,
  };
}
