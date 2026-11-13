"use client";

import { useCallback, type RefObject } from "react";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { ACTION_CATALOG, BLOCKED_COPY } from "@/lib/actions/catalog";
import type { ActionCommand } from "@/lib/actions/project";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { dismissImports, recoverMedia, type ImportItem, type MediaRecoveryOffer } from "@/lib/imports/api";
import { useImportCommands } from "@/lib/imports/commands";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { assertNever } from "@/lib/assertNever";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

export type Command = Extract<ActionDescriptor, { kind: "command" }>;

/** The speaking slot alone offers a row recovery, and only while raised. */
export function importRecovery(item: ImportItem): MediaRecoveryOffer | null {
  if (item.classification !== "NeedsAttention" || item.media_id === null) return null;
  switch (item.primary) {
    case null: case "metadata": return null;
    case "source": case "search": {
      const offer = item.obligations[item.primary]?.recovery ?? null;
      return offer?.kind === "RetryUpload" ? null : offer;
    }
    default: return assertNever(item.primary);
  }
}

/** Exact source-owner expectation, run by each caller on the common action runtime. */
export function recoveryCommand(mediaId: string, offer: MediaRecoveryOffer): ActionCommand {
  const { label } = ACTION_CATALOG[offer.kind];
  return { ref: `media:${mediaId}`, id: offer.kind, label, feedbackLabel: offer.kind === "RepairSearch" ? "rebuild" : "retry", title: "",
    confirmation: null, tracked: true, execute: () => recoverMedia(mediaId, offer) };
}

function useRecoveryAction(mediaId: string | null, offer: MediaRecoveryOffer | null): Command | null {
  const { run } = useActionRuntime();
  const busy = useBusyActionIds(mediaId === null ? null : `media:${mediaId}`);
  if (mediaId === null || offer === null) return null;
  const { label, icon: Glyph } = ACTION_CATALOG[offer.kind];
  return { kind: "command", id: offer.kind, label, icon: <Glyph aria-hidden="true" />, disabled: busy.has(offer.kind),
    disabledReason: busy.has(offer.kind) ? BLOCKED_COPY.Busy : undefined,
    onSelect: () => run(recoveryCommand(mediaId, offer)) };
}

export function useDismissAction(item: ImportItem): Command | null {
  const { run } = useActionRuntime();
  const ref = item.media_id === null ? null : `media:${item.media_id}`;
  const busy = useBusyActionIds(ref).has("Dismiss");
  if (ref === null || item.dismissal === null) return null;
  const through = item.dismissal.through;
  return { kind: "command", id: "Dismiss", label: ACTION_CATALOG.Dismiss.label, icon: null, disabled: busy,
    disabledReason: busy ? BLOCKED_COPY.Busy : undefined,
    onSelect: () => run({ ref, id: "Dismiss", label: ACTION_CATALOG.Dismiss.label, feedbackLabel: "dismiss", title: item.title,
      confirmation: null, tracked: true, execute: () => dismissImports([{ ref: item.ref, through }]) }) };
}

export function importDetailsAction(item: ImportItem, onSelect: (ref: string, trigger: HTMLElement | null) => void): Command {
  return { kind: "command", id: "ImportDetails", label: ACTION_CATALOG.ImportDetails.label, icon: null,
    onSelect: ({ triggerEl }) => onSelect(item.ref, triggerEl) };
}

export function ImportCommandControl({ action, label = action.label }: { readonly action: Command; readonly label?: string }) {
  return <Button aria-disabled={action.disabled || undefined} aria-busy={action.disabled || undefined}
    onClick={event => { if (!action.disabled) action.onSelect({ triggerEl: event.currentTarget, openIntent: "default" }); }}
  >{label}</Button>;
}

/** The visit owns uploads; a chooser remains synchronous with explicit activation. */
function useUploadActions(item: ImportItem) {
  const commands = useImportCommands();
  const busy = useBusyActionIds(item.ref);
  if (item.media_id !== null) return { retry: null, remove: null };
  const retrying = busy.has("RetryUpload");
  const removing = busy.has("RemoveUpload");
  const retry: Command | null = item.classification === "NeedsAttention" && item.obligations.source?.recovery?.kind === "RetryUpload" ? {
    kind: "command", id: "RetryUpload", label: ACTION_CATALOG.RetryUpload.label, icon: <ACTION_CATALOG.RetryUpload.icon aria-hidden="true" />,
    disabled: retrying, disabledReason: retrying ? BLOCKED_COPY.Busy : undefined,
    onSelect: () => commands.retryUpload(item),
  } : null;
  const remove: Command = {
    kind: "command", id: "RemoveUpload", label: ACTION_CATALOG.RemoveUpload.label, icon: null,
    tone: "danger", disabled: removing, disabledReason: removing ? "removing." : undefined,
    onSelect: () => { if (!removing && window.confirm(`remove the unfinished import “${item.title}”?`)) commands.removeUpload(item); },
  };
  return { retry, remove };
}

/** One row shortcut, followed by the work's ordinary contextual menu. */
export function useImportActions({ item, onSelect, triggerRef, returnFocus }: {
  readonly item: ImportItem;
  readonly onSelect: (ref: string, trigger: HTMLElement | null) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { triggerRef.current = node; }, [triggerRef]);
  const identity = item.can_read || item.can_play ? item.title : item.pointer ?? item.title;
  const recovery = useRecoveryAction(item.media_id, importRecovery(item));
  const dismiss = useDismissAction(item);
  const upload = useUploadActions(item);
  const details = importDetailsAction(item, onSelect);
  const actions = [details, recovery, dismiss].filter((action): action is Command => action !== null);
  const attention = item.classification === "NeedsAttention";
  const metadata = item.obligations.metadata;
  const shortcut = !attention ? null : item.primary === "metadata" && item.media_id !== null && metadata !== null
    ? <MetadataResearchActions mediaId={item.media_id} title={item.title} view={metadata} />
    : upload.retry ? <ImportCommandControl action={upload.retry} label="choose it again" />
    : recovery ? <ImportCommandControl action={recovery} label={recovery.id === "RepairSearch" ? "rebuild" : "retry"} />
    : item.media_id === null && upload.remove ? <ImportCommandControl action={upload.remove} label="remove" />
    : dismiss ? <ImportCommandControl action={dismiss} label="dismiss" /> : null;
  const menu = item.media_id === null ? <ActionMenu
    triggerRef={setTrigger} returnFocusTo={returnFocus} label={`more actions for ${identity}`}
    source={{ kind: "Immediate", subjectKey: `import:${item.ref}`, title: identity,
      content: { sections: [{ id: "Import", label: null,
        options: [details, upload.retry, upload.remove].filter((action): action is Command => action !== null),
      }] },
    }}
  /> : <ContextualActionMenu
    triggerRef={setTrigger} returnFocusTo={returnFocus}
    title={identity} subjectKey={`import:${item.ref}`}
    sections={[{ id: "Occurrence", actions }]}
    omitResourceActions={recovery ? [recovery.id] : []}
    navigation={null} resourceRef={assumeCanonicalResourceRef(`media:${item.media_id}`)} label={`more actions for ${identity}`}
  />;
  return { shortcut, menu };
}

/** Each detail fact invokes its own slot's recovery, even when another slot speaks. */
export function ImportObligationActions({ item, obligation }: {
  readonly item: ImportItem;
  readonly obligation: "source" | "search";
}) {
  const offer = item.obligations[obligation]?.recovery ?? null;
  const action = useRecoveryAction(item.media_id, offer?.kind === "RetryUpload" ? null : offer);
  if (item.media_id === null) return obligation === "source" ? <UploadActions item={item} /> : null;
  return action ? <ImportCommandControl action={action} label={offer?.kind === "RepairSearch" ? "rebuild" : "retry"} /> : null;
}

function UploadActions({ item }: { readonly item: ImportItem }) {
  const { retry, remove } = useUploadActions(item);
  return retry ? <ImportCommandControl action={retry} label="choose it again" />
    : remove ? <ImportCommandControl action={remove} label="remove" /> : null;
}
