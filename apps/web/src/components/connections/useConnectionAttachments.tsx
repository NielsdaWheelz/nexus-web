"use client";

// A visit retains selected files, upload attempts and its current position. Hiding
// it leaves the pipeline running; visit/account loss stops future browser work.
// Upload is server-owned; each uploaded file then links to the owner in one local
// commit. A failed local commit retries its frozen command, never a fresh link.
// What a stopped file still owes holds the task under the loss guard, with its one
// verb, and so does an upload whose answer was lost. A refused replay preserves
// an unsettled confirmation; a permanent publication fence retires it. A first
// refusal or guard-read failure ends the task,
// and its slip carries the retry. A link step that fails other than in local storage is
// a defect.
import { useRef } from "react";
import * as Icon from "@/lib/ui/icons";
import Button from "@/components/ui/Button";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import type { Line, Verbs } from "@/components/feedback/stage";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { captureErrorLine } from "@/lib/imports/copy";
import { readAcquisitionGuard } from "@/lib/libraries/api";
import { createUploadAttempt, getFileUploadError, reviewUploadAttempt, uploadIngestFile, type UploadAttempt } from "@/lib/imports/ingest";
import { UploadSessionError } from "@/lib/imports/api";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError, isAuthoredStorageFailure } from "@/lib/notes/runtime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { createLink } from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";

/** What the current file still owes, whose outcome only its retry can settle. */
type Owed =
  /** The link's local commit failed and may still land; `retryLink` replays it. */
  | "LinkUnsure"
  /** Saved, then local storage refused its link; linking again is safe. */
  | "Unlinked"
  /** The upload's acceptance is unknown; sending the same attempt again converges. */
  | "AddUnsure";

interface Task {
  readonly id: string;
  readonly files: readonly { file: File; upload: UploadAttempt }[];
  index: number;
  mediaId: string | null;
  running: boolean;
  unconfirmed: boolean;
  owed: Owed | null;
  /** Keys the held line's speech: a failed retry speaks again. */
  attempt: number;
  /** The frozen retry of a link whose local commit failed. */
  retryLink: (() => Promise<unknown>) | null;
}

const quoted = (name: string) => `“${name}”`;
/** One fact for every file an attach leaves out. */
const notAdded = (names: readonly string[]) => names.length === 1 ? `${quoted(names[0]!)} wasn’t added.` : `${names.length} files weren’t added.`;

function owedLine(owed: Owed, name: string): Line {
  switch (owed) {
    case "LinkUnsure": return { fact: `not sure ${quoted(name)} linked.`, reason: UNKNOWN_OUTCOME_REASON };
    case "Unlinked": return { fact: `${quoted(name)} was saved but isn’t linked.` };
    case "AddUnsure": return { fact: `not sure ${quoted(name)} was added.`, reason: UNKNOWN_OUTCOME_REASON };
  }
}

export function useConnectionAttachments(selfRef: string) {
  const { say, fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const { ctx } = useActionRuntime();
  const writing = useWritingRuntime();
  const guard = useWorkGuard();
  const scope = usePaneVisitWorkScope();
  const workspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const account = ctx.sessionSignal();
  const owned = () => !account.aborted && workspace().state.panes.some(pane => [pane.current_visit, ...pane.history.back, ...pane.history.forward]
    .some(visit => visit.id === scope.visitId && resolvePaneRouteModel(visit.href).routeKey === scope.routeKey));
  const owner = useResourceDraft<{ task: Task | null; defect: { error: unknown } | null }>(`ConnectionAttachments:${selfRef}`, () => ({ task: null, defect: null }), value => {
    const task = value.task;
    // Work remains until the last file is linked, including its link commit and any held retry.
    const remaining = task !== null && task.index < task.files.length;
    return { changed: remaining, unconfirmed: task?.unconfirmed ?? false, stopsBrowserWork: task?.running === true && remaining };
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const publish = () => owner.set(value => ({ ...value }));
  const owe = (task: Task, owed: Owed) => {
    task.attempt = task.owed === owed ? task.attempt + 1 : 0;
    task.owed = owed;
  };

  /** The files from the current one on weren't added: the task ends, and the slip's verb resumes it. */
  function endWithRefusal(task: Task, error: unknown) {
    const names = task.files.slice(task.index).map(({ file }) => file.name);
    const upload = task.files[task.index]!.upload;
    task.owed = null;
    owner.set({ task: null, defect: null });
    const resume = { label: "retry", commandKey: `ConnectionAttachments.resume:${task.id}`, run: () => {
      if (!owned() || owner.read().task !== null || writing === null) return;
      reviewUploadAttempt(upload);
      owner.set({ task, defect: null });
      void run(task);
    } };
    if (!(error instanceof UploadSessionError)) { fail(error, notAdded(names), resume); return; }
    const reason = captureErrorLine(error).reason;
    const kind = error.outcome.kind;
    const verbs: Verbs | undefined = upload.expired ? [{ label: "choose file", commandKey: `ConnectionAttachments.choose:${task.id}`, run: () => fileInputRef.current?.click() }]
      : kind === "BytesMissing" || kind === "LibraryForbidden" ? [resume] : undefined;
    say({ fact: notAdded(names), reason }, verbs);
  }

  async function run(task: Task) {
    if (!owned() || task.running || owner.read().task !== task || writing === null) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    account.addEventListener("abort", abort, { once: true });
    if (account.aborted) controller.abort();
    const stop = subscribeWorkspace(() => { if (!owned()) controller.abort(); });
    task.running = true;
    publish();
    try {
      while (task.index < task.files.length && !controller.signal.aborted) {
        const item = task.files[task.index]!;
        if (task.mediaId === null) {
          let prepared = item.upload.guard;
          if (prepared === null) {
            try { prepared = await readAcquisitionGuard([], controller.signal); }
            catch (error) {
              if (account.aborted || owner.read().task !== task || controller.signal.aborted) return;
              try { endWithRefusal(task, error); }
              catch (defect) { owner.set(value => ({ ...value, defect: { error: defect } })); }
              return;
            }
          }
          task.unconfirmed = true;
          publish();
          const uploaded = await uploadIngestFile({ file: item.file, attempt: item.upload, guard: prepared, signal: controller.signal });
          if (controller.signal.aborted || owner.read().task !== task) return;
          task.unconfirmed = false;
          if (!uploaded.available) {
            say({ fact: `${quoted(item.file.name)} was saved, then removed.` });
            task.index += 1;
            task.owed = null;
            publish();
            continue;
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
        task.owed = null;
        publish();
      }
      if (!controller.signal.aborted && owner.read().task === task) owner.set({ task: null, defect: null });
    } catch (error) {
      // A failed commit keeps its frozen retry even when this visit's browser work stops.
      if (error instanceof LocalCommitError) {
        task.retryLink = error.retry;
        void error.completion.then(() => {
          if (account.aborted || owner.read().task !== task || task.retryLink !== error.retry || task.running) return;
          task.retryLink = null; task.owed = null; task.index++; task.mediaId = null;
          publish();
          if (owned()) void run(task);
        }, () => {});
      }
      if (account.aborted || owner.read().task !== task || controller.signal.aborted) return;
      if (task.retryLink !== null) { owe(task, "LinkUnsure"); return; }
      const confirmationUnsettled = task.files[task.index]!.upload.confirmation_unsettled;
      task.unconfirmed = confirmationUnsettled || (error instanceof UploadSessionError
        ? error.outcome.kind === "Unresolved" : outcomeUnknown(error));
      if (handleUnauthenticatedApiError(error)) return;
      if (task.mediaId !== null && isAuthoredStorageFailure(error)) owe(task, "Unlinked");
      else if (task.mediaId !== null) owner.set(value => ({ ...value, defect: { error } }));
      else if (task.unconfirmed) owe(task, "AddUnsure");
      else try { endWithRefusal(task, error); }
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
    if (!owned() || prior?.running || prior?.retryLink || writing === null) return;
    const accepted: Task["files"][number][] = [];
    const refused: { name: string; reason: string }[] = [];
    for (const file of files) {
      const reason = getFileUploadError(file);
      if (reason === null) accepted.push({ file, upload: createUploadAttempt() });
      else refused.push({ name: file.name, reason });
    }
    if (refused.length) {
      const reason = refused[0]!.reason;
      say({ fact: notAdded(refused.map(({ name }) => name)), reason: refused.every(file => file.reason === reason) ? reason : undefined });
    }
    if (!accepted.length) return;
    if (prior !== null && !guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] })) return;
    const task: Task = { id: crypto.randomUUID(), files: accepted, index: 0, mediaId: null, running: false, unconfirmed: false, owed: null, attempt: 0, retryLink: null };
    owner.set({ task, defect: null });
    void run(task);
  }
  if (owner.value.defect !== null) throw owner.value.defect.error;
  const { task } = owner.value;
  return {
    dropProps: {
      onDragOver: (event: React.DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); },
      onDrop: (event: React.DragEvent<HTMLElement>) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); event.stopPropagation(); attachFiles(files); } },
    },
    control: <>
      <Button type="button" iconOnly aria-label="Upload and link file" onClick={() => fileInputRef.current?.click()} disabled={task?.running || task?.retryLink != null || writing === null} aria-busy={task?.running} icon={<Icon.Upload size={14} aria-hidden="true" />} />
      <input ref={fileInputRef} type="file" multiple hidden tabIndex={-1} onChange={event => attachFiles(Array.from(event.currentTarget.files ?? []))} />
      {task?.owed ? <Hold id={`ConnectionAttachments:${task.id}:${task.owed}`} attempt={task.attempt}
        {...(task.owed === "AddUnsure" ? resendFeedback({
          line: owedLine(task.owed, task.files[task.index]!.file.name),
          resend: {label: "retry", commandKey: `ConnectionAttachments.retry:${task.id}`, run: () => void run(task), busy: task.running},
        }) : {line: owedLine(task.owed, task.files[task.index]!.file.name),
          verbs: [{label: "retry", commandKey: `ConnectionAttachments.retry:${task.id}`, run: () => void run(task), busy: task.running}] as const})} /> : null}
    </>,
  };
}
