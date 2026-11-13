"use client";

// Local verbs for an owned authored resource (a note, page or highlight in this
// account's store), projected from one local read per menu request: available offline
// and never waiting on server facts. Edits hand the resource's pane an entry; deletion covers
// exactly the state observed for that ref and never reaches another resource. A failed
// local commit stays with the account's writing runtime, which shows it beside the
// affected writing and retries its frozen bytes; deletion waits for that retry.
import { createElement, useCallback, useState, useSyncExternalStore } from "react";
import type { ResourceProjection } from "@nexus/authored/types";
import { useAuthoredStore } from "@/lib/authored/provider";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { deleteResource } from "@/lib/resourceGraph/links";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {highlightSourceHref, localResourceHref, localResourceLabel} from "@/lib/resources/localResource";
import type { ActionDescriptor, ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import type { WorkspacePaneEntry } from "@/lib/workspace/targetActivation";
import { ACTION_CATALOG, BLOCKED_COPY, type ActionId, type Confirmation } from "./catalog";
import { ResourceActionFailure } from "./project";
import { useActionRuntime, useBusyActionIds } from "./ResourceActionsProvider";
import { settleDeletedResourcePanes } from "./settleDeletedResource";
import {useInvokingWorkHistory, workCommand, type WorkIntent} from "@/lib/notes/work";
import {usePaneWorkHistory} from "@/lib/panes/paneChrome";
import {useAccountToday, ACCOUNT_DAY_UNAVAILABLE} from "@/lib/notes/accountDay";
import {WorkConversionError, WorkUnavailableError} from "@nexus/authored/types";

/** Server verbs an owned authored resource's local verbs replace; menus drop the remote copies. */
export const AUTHORED_ACTION_IDS: ReadonlySet<string> = new Set<ActionId>([
  "EditNoteBody", "EditPageTitle", "EditHighlight", "EditHighlightBounds", "EditHighlightAnnotation",
  "DeleteNote", "DeletePage", "DeleteHighlight",
]);
const IDLE = { saving: false, error: null, error_occurrence: null, error_refs: [] as string[], revision: 0 };
const idle = () => IDLE;
const noSubscription = () => () => {};

/**
 * `prepare` reads the local projection once per menu request; nothing stays subscribed.
 * `read.actions` is empty unless `ref` is an owned authored resource (a source stub never is).
 */
export function useAuthoredActions(ref: string | null): {
  readonly prepare: (signal: AbortSignal) => void;
  readonly read: { readonly request: AbortSignal; readonly label: string | null; readonly actions: readonly ActionDescriptor[] } | null;
} {
  const store = useAuthoredStore();
  const writing = useWritingRuntime();
  const { ctx, run } = useActionRuntime();
  const busy = useBusyActionIds(ref);
  const pane = usePaneRuntime();
  const invokingHistory = useInvokingWorkHistory(), paneHistory = usePaneWorkHistory();
  const history = invokingHistory ?? paneHistory, today = useAccountToday();
  const saving = useSyncExternalStore(writing?.subscribe ?? noSubscription, writing?.snapshot ?? idle, idle);
  const [settled, setSettled] = useState<{ request: AbortSignal; ref: string | null; resource: ResourceProjection | null } | null>(null);
  const prepare = useCallback((signal: AbortSignal) => {
    if (ref === null || !/^(note_block|page|highlight):/u.test(ref)) { setSettled({ request: signal, ref, resource: null }); return; }
    // An unreadable local store owns nothing here; the menu keeps the server's verbs.
    void store.query({ kind: "resource", ref }).then(
      (result) => { if (!signal.aborted) setSettled({ request: signal, ref, resource: result.rows[0]?.resource ?? null }); },
      () => { if (!signal.aborted) setSettled({ request: signal, ref, resource: null }); });
  }, [ref, store]);
  const verbs = (resource: ResourceProjection | null, title: string | null): ActionDescriptor[] => {
    if (ref === null || writing === null || resource === null || resource.kind === "source" || title === null) return [];
    const owned = ref;
    const href = localResourceHref(resource);
    const id = parseResourceRef(owned)!.id;

    const command = (actionId: ActionId, execute: (detail: ActionSelectDetail) => unknown,
      options: { tracked: boolean; confirmation: Confirmation | null; blocked?: string }): ActionDescriptor => {
      const entry = ACTION_CATALOG[actionId];
      const label = entry.label;
      const disabledReason = busy.has(actionId) ? BLOCKED_COPY.Busy : options.blocked;
      return {
        kind: "command", id: actionId, label,
        icon: entry.icon && createElement(entry.icon, { "aria-hidden": true }),
        tone: entry.group === "Danger" ? "danger" : "default",
        separatorBefore: entry.group === "Danger" || undefined,
        disabled: disabledReason !== undefined || undefined, disabledReason, waiting: busy.has(actionId) || undefined,
        onSelect: detail => run({ ref: owned, id: actionId, label, feedbackLabel: label.toLowerCase(), title, confirmation: options.confirmation,
          tracked: options.tracked, execute: () => execute(detail) }),
      };
    };
    // An edit whose state lives in the resource's pane: go there and hand it the entry.
    const edit = (actionId: ActionId, entry: WorkspacePaneEntry, destination = href) => command(actionId, ({ openIntent }) => {
      if (destination === null || !ctx.isActive()) return;
      const workspace = ctx.workspace();
      workspace.activateWorkspaceTarget({ target: { href: destination }, entry,
        disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" },
        originPaneId: pane?.paneId ?? workspace.state.active_primary_pane_id });
    }, { tracked: false, confirmation: null });
    // A failed commit for this resource blocks later commands until its own retry lands.
    const pending = saving.error !== null && saving.error_refs.includes(owned) ? "an earlier change isn’t saved yet." : undefined;
    const settle = () => { if (ctx.isActive()) settleDeletedResourcePanes({ workspace: ctx.workspace(), deletedRef: owned, fallbackHref: "/notes" }); };
    const remove = (actionId: "DeleteNote" | "DeletePage" | "DeleteHighlight") => command(actionId, async () => {
      try {
        await deleteResource(writing, { ref: owned });
      } catch (error) {
        if (error instanceof LocalCommitError) {
          // the runtime keeps the frozen delete and its retry beside the affected writing; panes settle whenever it lands.
          void error.completion.then(settle, () => undefined);
          throw new ResourceActionFailure({ fact: "couldn’t delete it yet.", reason: "the change isn’t saved on this device." });
        }
        // deleted elsewhere between choosing and confirming is a refusal; anything else is a defect.
        const current = await (await writing.store).query({ kind: "resource", ref: owned });
        if (current.rows.length > 0) throw error;
        throw new ResourceActionFailure({ fact: "it was already deleted." });
      }
      settle();
    }, { tracked: true, confirmation: ACTION_CATALOG[actionId].confirmation, blocked: pending });

    switch (resource.kind) {
      case "note": {
        const work = resource.work, designation = work?.designation ?? null;
        const recorded = work !== null && (work.task_completed_on !== null || work.habit_dates.length > 0);
        const conversion = "use a new note to change work type while completion history exists.";
        const change = (id: ActionId, intent: WorkIntent | null, blocked?: string) => command(id, async () => {
          if (intent === null) throw new ResourceActionFailure({fact:ACCOUNT_DAY_UNAVAILABLE});
          try {
            if (history) await workCommand(history,intent);
            else {try {await writing.run(intent);} catch (error) {if (error instanceof LocalCommitError) await error.completion; else throw error;}}
          } catch (error) {
            if (error instanceof WorkConversionError) throw new ResourceActionFailure({fact:conversion});
            if (error instanceof WorkUnavailableError) throw new ResourceActionFailure({fact:error.message});
            throw error;
          }
        }, {tracked:true,confirmation:null,blocked:pending ?? (intent === null ? ACCOUNT_DAY_UNAVAILABLE : blocked)});
        const actions: ActionDescriptor[] = [];
        if (designation?.kind === "task") {
          actions.push({...change(designation.enabled ? "StopTask" : "ResumeTask",{kind:"set_work_designation",ref:owned,designation:{kind:"task",enabled:!designation.enabled}}),
            description:designation.enabled ? "completion date is kept" : undefined});
          actions.push(change(work!.task_completed_on === null ? "CompleteTask" : "ReopenTask",today === null ? null : {kind:"set_task_completion",ref:owned,local_date:work!.task_completed_on === null ? today : null,today}));
        } else actions.push(change("MakeTask",{kind:"set_work_designation",ref:owned,designation:{kind:"task",enabled:true}},recorded ? conversion : undefined));
        actions.push(change(designation?.kind === "habit" && designation.enabled ? "StopDaily" : "RepeatDaily",{kind:"set_work_designation",ref:owned,
          designation:{kind:"habit",enabled:!(designation?.kind === "habit" && designation.enabled)}},designation?.kind === "task" && recorded ? conversion : undefined));
        if (history && work?.task_completed_on) actions.push(command("TaskCompletionDate",() => ctx.overlays.open({kind:"TaskCompletion",ref:owned,history}),{tracked:false,confirmation:null}));
        if (history && work !== null && (designation?.kind === "habit" || work.habit_dates.length)) actions.push(command("HabitHistory",() => {
          const date = today ?? work.habit_dates.at(-1);
          if (date === undefined) throw new ResourceActionFailure({fact:ACCOUNT_DAY_UNAVAILABLE});
          ctx.overlays.open({kind:"HabitHistory",ref:owned,local_date:date,history});
        },{tracked:false,confirmation:null,blocked:today === null && !work.habit_dates.length ? ACCOUNT_DAY_UNAVAILABLE : undefined}));
        return [edit("EditNoteBody", { kind: "EditNoteBody", noteBlockId: id }),...actions,remove("DeleteNote")];
      }
      case "page": return [edit("EditPageTitle", { kind: "EditPageTitle", pageId: id }), remove("DeletePage")];
      case "highlight": return [
        {...edit("EditHighlightAnnotation", { kind: "EditHighlightAnnotation", highlightId: id }), label: resource.body_pm_json === null ? "annotate" : "edit annotation"},
        ...(highlightSourceHref(resource)?.startsWith("/media/") ? [edit("EditHighlight", {kind: "EditHighlight", highlightId: id}, highlightSourceHref(resource)), edit("EditHighlightBounds", {kind: "EditHighlightBounds", highlightId: id}, highlightSourceHref(resource))] : []),
        remove("DeleteHighlight"),
      ];
    }
  };
  if (settled === null || settled.ref !== ref) return { prepare, read: null };
  const label = settled.resource !== null && settled.resource.kind !== "source" ? localResourceLabel(settled.resource) : null;
  return { prepare, read: { request: settled.request, label, actions: verbs(settled.resource, label) } };
}
