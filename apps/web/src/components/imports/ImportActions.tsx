"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { ACTION_CATALOG, BLOCKED_COPY } from "@/lib/actions/catalog";
import {
  useActionRuntime,
  useBusyActionIds,
} from "@/lib/actions/ResourceActionsProvider";
import {
  UploadSessionError,
  recoverMedia,
  type ImportItem,
  type MediaRecoveryOffer,
} from "@/lib/imports/api";
import { uploadCommandFeedback } from "@/lib/imports/copy";
import { removeUploadSession, uploadIngestFile } from "@/lib/imports/ingest";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { openAsyncResult } from "@/lib/panes/openResult";
import { resolveResourceItem } from "@/lib/resources/items";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { workspaceTargetActivationIntent, type TargetActivationEvent, type OpenIntent } from "@/lib/ui/targetActivation";

/**
 * Readiness keeps the control visible; the item's current activation, read
 * when it is pressed, authorizes it.
 */
export function ImportOpenAction({ item }: { readonly item: ImportItem }) {
  return item.media_id !== null && (item.can_read || item.can_play) ? (
    <OpenMedia item={item} mediaRef={`media:${item.media_id}`} />
  ) : null;
}

function OpenMedia({
  item,
  mediaRef,
}: {
  readonly item: ImportItem;
  readonly mediaRef: string;
}) {
  const { ctx, run } = useActionRuntime();
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const busy = useBusyActionIds(mediaRef).has("Open");
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportOpenAction");
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = (intent: OpenIntent) => openAsyncResult({
    ctx, originPaneId: runtime.paneId, intent,
    subject: item.title,
    create: async () => {
    const current = await resolveResourceItem(mediaRef);
    if (current.missing || current.activation.kind !== "route" || current.activation.href === null) {
      if (mounted.current) setFailure({
        tone: "Warning",
        title: "couldn’t open this item",
        message: BLOCKED_COPY.TemporarilyUnavailable,
      });
      return null;
    }
    if (mounted.current) setFailure(null);
    return { target: { href: current.activation.href, labelHint: item.title }, title: "item available", openLabel: "open item" };
    },
  });
  const activate = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume" || busy) return;
    run({ ref: mediaRef, id: "Open", label: "open", title: item.title,
      confirmation: null, tracked: true, execute: () => open(activation.intent) });
  };
  return (
    <>
    <Button
      variant="secondary"
      size="sm"
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      asChild
    >
      <a href={`/media/${item.media_id}`} data-workspace-rich-target="true" onClick={activate} onKeyDown={activate}>open</a>
    </Button>
    {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" />}
    </>
  );
}

/**
 * The recovery an obligation's offer authorizes, sent with the exact attempt,
 * job or revision this import displays, run as the menu's verb: one busy key
 * for the row, the inspector and the menu, the catalog's failure copy.
 */
function MediaRecovery({
  mediaId,
  offer,
}: {
  readonly mediaId: string;
  readonly offer: MediaRecoveryOffer;
}) {
  const { run } = useActionRuntime();
  const ref = `media:${mediaId}`;
  const busy = useBusyActionIds(ref).has(offer.kind);
  const label = ACTION_CATALOG[offer.kind].label;
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={() =>
        run({
          ref,
          id: offer.kind,
          label,
          title: "",
          confirmation: null,
          tracked: true,
          execute: () => recoverMedia(mediaId, offer),
        })
      }
    >
      {label}
    </Button>
  );
}

/**
 * Retry upload (the session's own id with the original file) and Remove for an
 * unpublished upload, run on the action runtime under the import's ref, so the
 * row and the inspector share one busy key per command. Imports words their
 * refusals itself (the runtime would take an `UploadSessionError` for a
 * defect); a session that moved on (published or replaced elsewhere) is done.
 */
function UploadActions({ item }: { readonly item: ImportItem }) {
  const { run } = useActionRuntime();
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const busy = useBusyActionIds(item.ref);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionId = item.ref.slice("upload:".length);
  const retrying = busy.has("RetryUpload");
  const removing = busy.has("RemoveUpload");
  const send = (
    id: "RetryUpload" | "RemoveUpload",
    command: () => Promise<unknown>,
  ) =>
    run({
      ref: item.ref,
      id,
      label: ACTION_CATALOG[id].label,
      title: item.title,
      confirmation: null,
      tracked: true,
      execute: async () => {
        try {
          await command();
          setFailure(null);
        } catch (error) {
          if (
            error instanceof UploadSessionError &&
            error.outcome.kind === "Superseded"
          ) {
            setFailure(null);
            return;
          }
          setFailure(uploadCommandFeedback(id, error));
        }
      },
    });
  const remove = () => {
    if (!removing && window.confirm(`Remove the unfinished import “${item.title}”?`))
      send("RemoveUpload", () => removeUploadSession(sessionId));
  };
  return (
    <>
      {item.obligations.source?.recovery?.kind === "RetryUpload" ? (
        <>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            // The button beside it is the one tab stop; a clipped control that
            // took focus would paint its ring inside a 1px box (WCAG 2.4.7).
            tabIndex={-1}
            aria-label={
              item.original_filename !== null
                ? `Choose ${item.original_filename} to retry the upload`
                : "Choose the original file to retry the upload"
            }
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              // the session's own id: it advances, or answers what it
              // published; its destinations are the first create's
              if (file !== undefined && !retrying)
                send("RetryUpload", () =>
                  uploadIngestFile({ file, libraryIds: [], id: sessionId }),
                );
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={retrying || undefined}
            aria-busy={retrying || undefined}
            onClick={() => {
              if (!retrying) inputRef.current?.click();
            }}
          >
            {ACTION_CATALOG.RetryUpload.label}
          </Button>
        </>
      ) : null}
      <ActionMenu
        label={`more actions for ${item.title}`}
        source={{ kind: "Immediate", subjectKey: `import:${item.ref}`, title: item.title, content: { sections: [{ id: "Import", label: null, options: [
          {
            kind: "command",
            id: "Import.RemoveUpload",
            label: ACTION_CATALOG.RemoveUpload.label,
            tone: "danger",
            disabled: removing,
            disabledReason: removing ? "Removal is in progress." : undefined,
            onSelect: remove,
          },
        ] }] } }}
      />
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" />}
    </>
  );
}

/** The speaking obligation's command, then open, then the item's menu. */
export function ImportActions({ item }: { readonly item: ImportItem }) {
  const mediaId = item.media_id;
  if (mediaId === null) return <UploadActions item={item} />;
  const offer =
    item.obligations[item.primary === "search" ? "search" : "source"]
      ?.recovery ?? null;
  const metadata = item.obligations.metadata;
  return (
    <>
      {item.primary === "metadata" && metadata !== null ? (
        <MetadataResearchActions
          mediaId={mediaId}
          view={metadata}
          primaryOnly
        />
      ) : offer !== null && offer.kind !== "RetryUpload" ? (
        <MediaRecovery mediaId={mediaId} offer={offer} />
      ) : null}
      <ImportOpenAction item={item} />
      <ContextualActionMenu
        title={item.title} subjectKey={`import:${item.ref}:media:${mediaId}`}
        sections={[]}
        displayedActivation={{ kind: item.can_read || item.can_play ? "route" : "none", href: item.can_read || item.can_play ? `/media/${mediaId}` : null, resource_ref: `media:${mediaId}`, unavailable_reason: null }}
        resourceRef={assumeCanonicalResourceRef(`media:${mediaId}`)}
        label={`more actions for ${item.title}`}
      />
    </>
  );
}

/** Each inspector section invokes only its owner's offered recovery. */
export function ImportObligationActions({
  item,
  obligation,
}: {
  readonly item: ImportItem;
  readonly obligation: "source" | "search";
}) {
  if (item.media_id === null)
    return obligation === "source" ? <UploadActions item={item} /> : null;
  const offer = item.obligations[obligation]?.recovery ?? null;
  return offer === null || offer.kind === "RetryUpload" ? null : (
    <MediaRecovery mediaId={item.media_id} offer={offer} />
  );
}
