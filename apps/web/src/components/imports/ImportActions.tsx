"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import { ACTION_CATALOG, BLOCKED_COPY } from "@/lib/actions/catalog";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { UploadSessionError, recoverMedia, type ImportItem, type MediaRecoveryOffer } from "@/lib/imports/api";
import { uploadCommandFeedback } from "@/lib/imports/copy";
import { createUploadAttempt, removeUploadSession, uploadIngestFile } from "@/lib/imports/ingest";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { openAsyncResult } from "@/lib/panes/openResult";
import { resolveResourceItem } from "@/lib/resources/items";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { prepareActionSelect, type ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./Imports.module.css";

type Command = Extract<ActionDescriptor, { kind: "command" }>;

/** Readiness offers Open; its fresh activation still authorizes the navigation. */
function useOpenAction(item: ImportItem) {
  const { ctx, run } = useActionRuntime();
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const mediaRef = item.media_id === null ? null : `media:${item.media_id}`;
  const busy = useBusyActionIds(mediaRef).has("Open");
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportOpenAction");
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = (ref: string, intent: OpenIntent) => openAsyncResult({
    ctx, originPaneId: runtime.paneId, intent, subject: item.title,
    create: async () => {
      const current = await resolveResourceItem(ref);
      if (current.missing || current.activation.kind !== "route" || current.activation.href === null) {
        if (mounted.current) setFailure({
          tone: "Warning", title: "couldn’t open this item", message: BLOCKED_COPY.TemporarilyUnavailable,
        });
        return null;
      }
      if (mounted.current) setFailure(null);
      return { target: { href: current.activation.href, labelHint: item.title }, title: "item available", openLabel: "open item" };
    },
  });
  const action: Command | null = mediaRef !== null && (item.can_read || item.can_play) ? {
    kind: "command", id: "Open", label: "open", disabled: busy,
    disabledReason: busy ? BLOCKED_COPY.Busy : undefined,
    onSelect: ({ openIntent }) => run({
      ref: mediaRef, id: "Open", label: "open", title: item.title,
      confirmation: null, tracked: true, execute: () => open(mediaRef, openIntent),
    }),
  } : null;
  return { action, feedback: failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" /> };
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
  const { action, feedback } = useOpenAction(item);
  return <>{action ? <OpenControl item={item} action={action} /> : null}{feedback}</>;
}

/** Exact offered attempt/job/revision, shared busy identity and catalog wording. */
function useRecoveryAction(mediaId: string | null, offer: MediaRecoveryOffer | null): Command | null {
  const { run } = useActionRuntime();
  const ref = mediaId === null ? null : `media:${mediaId}`;
  const busy = useBusyActionIds(ref);
  if (mediaId === null || ref === null || offer === null) return null;
  const label = ACTION_CATALOG[offer.kind].label;
  return {
    kind: "command", id: offer.kind, label, disabled: busy.has(offer.kind),
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
 * File selection is synchronous with activation. Cancellation submits nothing.
 */
function useUploadActions(item: ImportItem) {
  const { run } = useActionRuntime();
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const busy = useBusyActionIds(item.ref);
  const inputRef = useRef<HTMLInputElement>(null);
  if (item.media_id !== null) return { input: null, retry: null, remove: null, feedback: null };
  const sessionId = item.ref.slice("upload:".length);
  const retrying = busy.has("RetryUpload");
  const removing = busy.has("RemoveUpload");
  const send = (id: "RetryUpload" | "RemoveUpload", command: () => Promise<unknown>) => run({
    ref: item.ref, id, label: ACTION_CATALOG[id].label, title: item.title,
    confirmation: null, tracked: true,
    execute: async () => {
      try {
        await command();
        setFailure(null);
      } catch (error) {
        if (error instanceof UploadSessionError && error.outcome.kind === "Superseded") {
          setFailure(null);
          return;
        }
        setFailure(uploadCommandFeedback(id, error));
      }
    },
  });
  const retry: Command | null = item.obligations.source?.recovery?.kind === "RetryUpload" ? {
    kind: "command", id: "RetryUpload", label: ACTION_CATALOG.RetryUpload.label,
    disabled: retrying, disabledReason: retrying ? BLOCKED_COPY.Busy : undefined,
    onSelect: () => { if (!retrying) inputRef.current?.click(); },
  } : null;
  const remove: Command = {
    kind: "command", id: "RemoveUpload", label: ACTION_CATALOG.RemoveUpload.label,
    tone: "danger", disabled: removing, disabledReason: removing ? "Removal is in progress." : undefined,
    onSelect: () => {
      if (!removing && window.confirm(`Remove the unfinished import “${item.title}”?`))
        send("RemoveUpload", () => removeUploadSession(sessionId));
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
  return { input, retry, remove, feedback: failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" /> };
}

/** Commands and feedback survive CSS promotion; the row owns its overflow ref. */
export function useImportActions({ item, triggerRef, returnFocus }: {
  readonly item: ImportItem;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { triggerRef.current = node; }, [triggerRef]);
  useActionFocusRecovery(shortcutsRef, returnFocus);
  const open = useOpenAction(item);
  const sourceOffer = item.obligations.source?.recovery ?? null;
  const searchOffer = item.obligations.search?.recovery ?? null;
  const source = useRecoveryAction(item.media_id, sourceOffer?.kind === "RetryUpload" ? null : sourceOffer);
  const search = useRecoveryAction(item.media_id, searchOffer?.kind === "RetryUpload" ? null : searchOffer);
  const upload = useUploadActions(item);
  const recovery = item.primary === "search" ? search : source;
  const metadata = item.obligations.metadata;
  const commands = [open.action, source, search].filter((action): action is Command => action !== null);
  const shortcuts = <div ref={shortcutsRef} className={styles.rowActions} data-import-shortcuts="">
    {upload.input}
    {item.primary === "metadata" && item.media_id !== null && metadata !== null
      ? <MetadataResearchActions mediaId={item.media_id} view={metadata} primaryOnly />
      : recovery ? <span data-import-shortcut=""><RecoveryControl action={recovery} /></span> : null}
    {open.action ? <span data-import-shortcut=""><OpenControl item={item} action={open.action} /></span> : null}
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
    displayedActivation={{ kind: item.can_read || item.can_play ? "route" : "none",
      href: item.can_read || item.can_play ? `/media/${item.media_id}` : null,
      resource_ref: `media:${item.media_id}`, unavailable_reason: null }}
    resourceRef={assumeCanonicalResourceRef(`media:${item.media_id}`)} label={`more actions for ${item.title}`}
  />;
  return { shortcuts, menu, feedback: open.feedback || upload.feedback ? <>{open.feedback}{upload.feedback}</> : null };
}

/** Each inspector section invokes only its owner's offered recovery. */
export function ImportObligationActions({ item, obligation }: {
  readonly item: ImportItem;
  readonly obligation: "source" | "search";
}) {
  const offer = item.obligations[obligation]?.recovery ?? null;
  const action = useRecoveryAction(item.media_id, offer?.kind === "RetryUpload" ? null : offer);
  if (item.media_id === null) return obligation === "source" ? <UploadActions item={item} /> : null;
  return action ? <RecoveryControl action={action} /> : null;
}

function UploadActions({ item }: { readonly item: ImportItem }) {
  const { input, retry, remove, feedback } = useUploadActions(item);
  return <>{input}{retry ? <RecoveryControl action={retry} /> : null}
    <ActionMenu label={`more actions for ${item.title}`}
      source={{ kind: "Immediate", subjectKey: `import:${item.ref}`, title: item.title,
        content: { sections: [{ id: "Import", label: null, options: remove ? [remove] : [] }] },
      }}
    />{feedback}</>;
}
