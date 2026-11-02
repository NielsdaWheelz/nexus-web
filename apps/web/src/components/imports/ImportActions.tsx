"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import type { CommandVerb } from "@/components/feedback/stage";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import { ACTION_CATALOG, BLOCKED_COPY } from "@/lib/actions/catalog";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { transportOf } from "@/lib/api/failure";
import { UploadSessionError, recoverMedia, type ImportItem, type MediaRecoveryOffer } from "@/lib/imports/api";
import { UPLOAD_COMMAND_FACT, retryUploadRefusal, type UploadCommand } from "@/lib/imports/copy";
import { createUploadAttempt, removeUploadSession, uploadIngestFile } from "@/lib/imports/ingest";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { paneForkLink } from "@/lib/panes/paneForkLink";
import { useTouchCapable } from "@/lib/renderEnvironment/provider";
import { openAsyncResult } from "@/lib/panes/openResult";
import { resolveResourceItem } from "@/lib/resources/items";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { prepareActionSelect, type ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./Imports.module.css";

type Command = Extract<ActionDescriptor, { kind: "command" }>;

/** Readiness offers Open; its fresh activation still authorizes the navigation. */
function useOpenAction(item: ImportItem): Command | null {
  const { ctx, run } = useActionRuntime();
  const outcome = useOutcome();
  const mediaRef = item.media_id === null ? null : `media:${item.media_id}`;
  const busy = useBusyActionIds(mediaRef).has("Open");
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportOpenAction");
  const open = (ref: string, intent: OpenIntent) => openAsyncResult({
    ctx, originPaneId: runtime.paneId, intent, subject: item.title,
    create: async () => {
      const current = await resolveResourceItem(ref);
      if (current.missing || current.activation.kind !== "route" || current.activation.href === null) {
        outcome.say({ fact: `couldn’t open "${item.title}".`, reason: "it isn’t available." });
        return null;
      }
      return { target: { href: current.activation.href, labelHint: item.title }, title: "ready to open", openLabel: "open" };
    },
  });
  return mediaRef !== null && (item.can_read || item.can_play) ? {
    kind: "command", id: "Open", label: ACTION_CATALOG.Open.label, icon: <ACTION_CATALOG.Open.icon size={16} aria-hidden="true" />, disabled: busy,
    disabledReason: busy ? BLOCKED_COPY.Busy : undefined,
    onSelect: ({ openIntent }) => run({
      ref: mediaRef, id: "Open", label: ACTION_CATALOG.Open.label, title: item.title,
      confirmation: null, tracked: true, execute: () => open(mediaRef, openIntent),
    }),
  } : null;
}

function OpenControl({ item, action }: { readonly item: ImportItem; readonly action: Command }) {
  const activate = (event: TargetActivationEvent) => {
    const detail = prepareActionSelect(event, null);
    if (detail && !action.disabled) action.onSelect(detail);
  };
  return <ButtonLink href={`/media/${item.media_id}`}
    aria-disabled={action.disabled || undefined} aria-busy={action.disabled || undefined}
    data-workspace-rich-target="true" onClick={activate} onKeyDown={activate}
  >{action.label}</ButtonLink>;
}

/** The row and inspector share the same Open command, including modifier intent. */
export function ImportOpenAction({ item }: { readonly item: ImportItem }) {
  const action = useOpenAction(item);
  return action ? <OpenControl item={item} action={action} /> : null;
}

/** Exact offered attempt/job/revision, shared busy identity and catalog wording. */
function useRecoveryAction(mediaId: string | null, offer: MediaRecoveryOffer | null): Command | null {
  const { run } = useActionRuntime();
  const ref = mediaId === null ? null : `media:${mediaId}`;
  const busy = useBusyActionIds(ref);
  if (mediaId === null || ref === null || offer === null) return null;
  const { label, icon: Icon } = ACTION_CATALOG[offer.kind];
  return {
    kind: "command", id: offer.kind, label, icon: <Icon size={16} aria-hidden="true" />, disabled: busy.has(offer.kind),
    disabledReason: busy.has(offer.kind) ? BLOCKED_COPY.Busy : undefined,
    onSelect: () => run({
      ref, id: offer.kind, label, title: "", confirmation: null, tracked: true,
      execute: () => recoverMedia(mediaId, offer),
    }),
  };
}

function RecoveryControl({ action }: { readonly action: Command }) {
  return <Button aria-disabled={action.disabled || undefined} aria-busy={action.disabled || undefined}
    onClick={event => { if (!action.disabled) action.onSelect({ triggerEl: event.currentTarget, openIntent: "default" }); }}
  >{action.label}</Button>;
}

/**
 * Upload retries retain the session's id and selected file; removal is idempotent.
 * File selection is synchronous with activation. Cancellation submits nothing. A command whose
 * answer was lost is held until a resend lands; a removal's also leaves with its row.
 */
function useUploadActions(item: ImportItem) {
  const { run } = useActionRuntime();
  const outcome = useOutcome();
  const [unsure, setUnsure] = useState<{ readonly command: UploadCommand; readonly attempt: number } | null>(null);
  const busy = useBusyActionIds(item.ref);
  const inputRef = useRef<HTMLInputElement>(null);
  if (item.media_id !== null) return { input: null, retry: null, remove: null, held: null };
  const sessionId = item.ref.slice("upload:".length);
  const retrying = busy.has("RetryUpload");
  const removing = busy.has("RemoveUpload");
  const chooseFile = () => { if (!retrying) inputRef.current?.click(); };
  const again: Readonly<Record<UploadCommand, CommandVerb>> = {
    RetryUpload: { label: "retry", commandKey: `${item.ref} RetryUpload`, run: chooseFile, busy: retrying },
    RemoveUpload: { label: "retry", commandKey: `${item.ref} RemoveUpload`, run: () => sendRemove(), busy: removing },
  };
  const send = (id: UploadCommand, command: () => Promise<unknown>) => run({
    ref: item.ref, id, label: ACTION_CATALOG[id].label, title: item.title,
    confirmation: null, tracked: true,
    execute: async () => {
      try {
        await command();
        setUnsure(null);
      } catch (error) {
        if (error instanceof UploadSessionError) {
          setUnsure(null);
          // Removal settles its one declared outcome itself (ingest.ts); any other is a defect.
          if (id === "RemoveUpload") throw error;
          const refusal = retryUploadRefusal(error);
          if (refusal !== null) outcome.say(refusal.line, refusal.retry ? [again.RetryUpload] : undefined);
          return;
        }
        const transport = isApiError(error) && !isSameSystemApiDefect(error) ? transportOf(error) : null;
        if (transport === "Offline" || transport === "Unavailable") {
          setUnsure((current) => ({ command: id, attempt: current?.command === id ? current.attempt + 1 : 0 }));
          return;
        }
        setUnsure(null);
        outcome.fail(error, UPLOAD_COMMAND_FACT[id], again[id]);
      }
    },
  });
  const sendRemove = () => send("RemoveUpload", () => removeUploadSession(sessionId));
  const retry: Command | null = item.obligations.source?.recovery?.kind === "RetryUpload" ? {
    kind: "command", id: "RetryUpload", label: ACTION_CATALOG.RetryUpload.label, icon: <ACTION_CATALOG.RetryUpload.icon size={16} aria-hidden="true" />,
    disabled: retrying, disabledReason: retrying ? BLOCKED_COPY.Busy : undefined,
    onSelect: chooseFile,
  } : null;
  const remove: Command = {
    kind: "command", id: "RemoveUpload", label: ACTION_CATALOG.RemoveUpload.label, icon: <ACTION_CATALOG.RemoveUpload.icon size={16} aria-hidden="true" />,
    tone: "danger", disabled: removing, disabledReason: removing ? "removing." : undefined,
    onSelect: () => {
      if (!removing && window.confirm(`Remove the unfinished import “${item.title}”?`)) sendRemove();
    },
  };
  const input = retry === null ? null : <input ref={inputRef} className="sr-only" type="file" tabIndex={-1}
    aria-label={item.original_filename !== null ? `Choose ${item.original_filename} to retry the upload` : "choose the file again to continue"}
    accept=".pdf,.epub,application/pdf,application/epub+zip"
    onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file !== undefined && !retrying)
        send("RetryUpload", () => uploadIngestFile({ file, attempt: createUploadAttempt(sessionId) }));
    }}
  />;
  const held = unsure === null ? null : <Hold id={`${item.ref} ${unsure.command}`} attempt={unsure.attempt}
    line={{ fact: unsure.command === "RetryUpload" ? "not sure the upload finished." : "not sure this import was removed.", reason: "it may have gone through." }}
    verbs={[again[unsure.command]]} />;
  return { input, retry, remove, held };
}

/** Commands and feedback survive CSS promotion; the row owns its overflow ref. */
export function useImportActions({ item, triggerRef, returnFocus }: {
  readonly item: ImportItem;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const pane = usePaneRuntime();
  const touch = useTouchCapable();
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { triggerRef.current = node; }, [triggerRef]);
  useActionFocusRecovery(shortcutsRef, returnFocus);
  const open = useOpenAction(item);
  const sourceOffer = item.obligations.source?.recovery ?? null;
  const searchOffer = item.obligations.search?.recovery ?? null;
  const browserOffer = sourceOffer?.kind === "BrowserCapture" ? sourceOffer : null;
  const source = useRecoveryAction(item.media_id, sourceOffer?.kind === "RetryUpload" || sourceOffer?.kind === "BrowserCapture" ? null : sourceOffer);
  const search = useRecoveryAction(item.media_id, searchOffer?.kind === "RetryUpload" || searchOffer?.kind === "BrowserCapture" ? null : searchOffer);
  const upload = useUploadActions(item);
  const recovery = item.primary === "search" ? search : source;
  const metadata = item.obligations.metadata;
  const commands = [open, source, search].filter((action): action is Command => action !== null);
  const shortcuts = <div ref={shortcutsRef} className={styles.rowActions} data-import-shortcuts="">
    {upload.input}
    {item.primary === "metadata" && item.media_id !== null && metadata !== null
      ? <MetadataResearchActions mediaId={item.media_id} view={metadata} primaryOnly />
      : browserOffer && item.primary === "source" ? <span data-import-shortcut=""><ButtonLink href={browserOffer.source_url} target="_blank" rel="noopener noreferrer">open source in new tab</ButtonLink></span>
      : recovery ? <span data-import-shortcut=""><RecoveryControl action={recovery} /></span> : null}
    {open ? <span data-import-shortcut=""><OpenControl item={item} action={open} /></span> : null}
    {upload.retry ? <span data-import-shortcut=""><RecoveryControl action={upload.retry} /></span> : null}
  </div>;
  const menu = item.media_id === null ? <ActionMenu
    triggerRef={setTrigger} returnFocusTo={returnFocus} label={`more actions for ${item.title}`}
    source={{ kind: "Immediate", subjectKey: `import:${item.ref}`, title: item.title,
      content: { sections: [{ id: "Import", label: null,
        options: [upload.retry, upload.remove].filter((action): action is Command => action !== null),
      }] },
    }}
  /> : <ContextualActionMenu
    triggerRef={setTrigger} returnFocusTo={returnFocus}
    title={item.title} subjectKey={`import:${item.ref}:media:${item.media_id}`}
    sections={[{ id: "View", actions: commands }]}
    omitResourceActions={commands.map(action => action.id)}
    navigation={{
      key: `import:${item.ref}:/media/${item.media_id}:${item.can_read || item.can_play}`,
      fork: touch && pane && (item.can_read || item.can_play)
        ? paneForkLink({ runtime: pane, target: { href: `/media/${item.media_id}`, labelHint: item.title }, disabledReason: null }) : null,
    }}
    resourceRef={assumeCanonicalResourceRef(`media:${item.media_id}`)} label={`more actions for ${item.title}`}
  />;
  return { shortcuts, menu, held: upload.held };
}

/** Each inspector section invokes only its owner's offered recovery. */
export function ImportObligationActions({ item, obligation }: {
  readonly item: ImportItem;
  readonly obligation: "source" | "search";
}) {
  const offer = item.obligations[obligation]?.recovery ?? null;
  const action = useRecoveryAction(item.media_id, offer?.kind === "RetryUpload" || offer?.kind === "BrowserCapture" ? null : offer);
  if (offer?.kind === "BrowserCapture") return <ButtonLink href={offer.source_url} target="_blank" rel="noopener noreferrer">open source in new tab</ButtonLink>;
  if (item.media_id === null) return obligation === "source" ? <UploadActions item={item} /> : null;
  return action ? <RecoveryControl action={action} /> : null;
}

function UploadActions({ item }: { readonly item: ImportItem }) {
  const { input, retry, remove, held } = useUploadActions(item);
  return <>{input}{retry ? <RecoveryControl action={retry} /> : null}
    <ActionMenu label={`more actions for ${item.title}`}
      source={{ kind: "Immediate", subjectKey: `import:${item.ref}`, title: item.title,
        content: { sections: [{ id: "Import", label: null, options: remove ? [remove] : [] }] },
      }}
    />{held}</>;
}
