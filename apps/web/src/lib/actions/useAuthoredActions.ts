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
import { localResourceHref } from "@/lib/resources/localResource";
import type { ActionDescriptor, ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import type { WorkspacePaneEntry } from "@/lib/workspace/targetActivation";
import { ACTION_CATALOG, BLOCKED_COPY, type ActionId, type Confirmation } from "./catalog";
import { ResourceActionFailure } from "./project";
import { useActionRuntime, useBusyActionIds } from "./ResourceActionsProvider";
import { settleDeletedResourcePanes } from "./settleDeletedResource";

/** Server verbs an owned authored resource's local verbs replace; menus drop the remote copies. */
export const AUTHORED_ACTION_IDS: ReadonlySet<string> = new Set<ActionId>([
  "EditNoteBody", "EditPageTitle", "EditHighlight", "EditHighlightBounds", "HighlightNote",
  "DeleteNote", "DeletePage", "DeleteHighlight",
]);
const IDLE = { saving: false, error: null, error_refs: [] as string[], revision: 0 };
const idle = () => IDLE;
const noSubscription = () => () => {};

/**
 * `prepare` reads the local projection once per menu request; nothing stays subscribed.
 * `read.actions` is empty unless `ref` is an owned authored resource (a source stub never is).
 */
export function useAuthoredActions(ref: string | null, title: string): {
  readonly prepare: (signal: AbortSignal) => void;
  readonly read: { readonly request: AbortSignal; readonly actions: readonly ActionDescriptor[] } | null;
} {
  const store = useAuthoredStore();
  const writing = useWritingRuntime();
  const { ctx, run } = useActionRuntime();
  const busy = useBusyActionIds(ref);
  const pane = usePaneRuntime();
  const saving = useSyncExternalStore(writing?.subscribe ?? noSubscription, writing?.snapshot ?? idle, idle);
  const [settled, setSettled] = useState<{ request: AbortSignal; ref: string | null; resource: ResourceProjection | null } | null>(null);
  const prepare = useCallback((signal: AbortSignal) => {
    if (ref === null || !/^(note_block|page|highlight):/u.test(ref)) { setSettled({ request: signal, ref, resource: null }); return; }
    // An unreadable local store owns nothing here; the menu keeps the server's verbs.
    void store.query({ kind: "resource", ref }).then(
      (result) => { if (!signal.aborted) setSettled({ request: signal, ref, resource: result.rows[0]?.resource ?? null }); },
      () => { if (!signal.aborted) setSettled({ request: signal, ref, resource: null }); });
  }, [ref, store]);
  const verbs = (resource: ResourceProjection | null): ActionDescriptor[] => {
    if (ref === null || writing === null || resource === null || resource.kind === "source") return [];
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
        icon: createElement(entry.icon, { size: 16, "aria-hidden": true }),
        tone: entry.group === "Danger" ? "danger" : "default",
        separatorBefore: entry.group === "Danger" || undefined,
        disabled: disabledReason !== undefined || undefined, disabledReason,
        onSelect: detail => run({ ref: owned, id: actionId, label, title, confirmation: options.confirmation,
          tracked: options.tracked, execute: () => execute(detail) }),
      };
    };
    // An edit whose state lives in the resource's pane: go there and hand it the entry.
    const edit = (actionId: ActionId, entry: WorkspacePaneEntry) => command(actionId, ({ openIntent }) => {
      if (href === null || !ctx.isActive()) return;
      const workspace = ctx.workspace();
      workspace.activateWorkspaceTarget({ target: { href }, entry,
        disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" },
        originPaneId: pane?.paneId ?? workspace.state.active_primary_pane_id });
    }, { tracked: false, confirmation: null });
    // A failed commit for this resource blocks later commands until its own retry lands.
    const pending = saving.error !== null && saving.error_refs.includes(owned) ? "couldn’t save on this device. retry saving first." : undefined;
    const settle = () => { if (ctx.isActive()) settleDeletedResourcePanes({ workspace: ctx.workspace(), deletedRef: owned, fallbackHref: "/notes" }); };
    const remove = (actionId: "DeleteNote" | "DeletePage" | "DeleteHighlight") => command(actionId, async () => {
      try {
        await deleteResource(writing, { ref: owned });
      } catch (error) {
        if (error instanceof LocalCommitError) {
          // the runtime keeps the frozen delete and its retry beside the affected writing; panes settle whenever it lands.
          void error.completion.then(settle, () => undefined);
          throw new ResourceActionFailure({ tone: "Warning", title: "couldn’t save on this device", message: "keep this page open. retry saving." });
        }
        // deleted elsewhere between choosing and confirming is a refusal; anything else is a defect.
        const current = await (await writing.store).query({ kind: "resource", ref: owned });
        if (current.rows.length > 0) throw error;
        throw new ResourceActionFailure({ tone: "Neutral", title: "this item is no longer on this device" });
      }
      settle();
    }, { tracked: true, confirmation: ACTION_CATALOG[actionId].confirmation, blocked: pending });

    switch (resource.kind) {
      case "note": return [edit("EditNoteBody", { kind: "EditNoteBody", noteBlockId: id }), remove("DeleteNote")];
      case "page": return [edit("EditPageTitle", { kind: "EditPageTitle", pageId: id }), remove("DeletePage")];
      case "highlight": return [
        // a highlight's pane entries address its media reader, which places text and pdf bounds alike.
        ...href?.startsWith("/media/") ? [
          edit("EditHighlight", { kind: "EditHighlight", highlightId: id }),
          edit("HighlightNote", { kind: "EditHighlightNote", highlightId: id, noteBlockId: null }),
          edit("EditHighlightBounds", { kind: "EditHighlightBounds", highlightId: id }),
        ] : [],
        remove("DeleteHighlight"),
      ];
    }
  };
  if (settled === null || settled.ref !== ref) return { prepare, read: null };
  return { prepare, read: { request: settled.request, actions: verbs(settled.resource) } };
}
