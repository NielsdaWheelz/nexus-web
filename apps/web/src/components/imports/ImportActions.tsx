"use client";

import { useRef, useState } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { ACTION_CATALOG, BLOCKED_COPY } from "@/lib/actions/catalog";
import {
  useActionRuntime,
  useBusyActionIds,
} from "@/lib/actions/ResourceActionsProvider";
import { useThrowLater } from "@/lib/api/serverState";
import {
  recoverMedia,
  type ImportItem,
  type MediaRecoveryOffer,
} from "@/lib/imports/api";
import {
  RETRY_UPLOAD_LABEL,
  uploadCommandFeedback,
} from "@/lib/imports/copy";
import {
  pendingKey,
  useImports,
  type UploadCommand,
} from "@/lib/imports/ImportsProvider";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import { activateResource } from "@/lib/resources/activation";
import { resolveResourceItem } from "@/lib/resources/items";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

/**
 * Readiness keeps the control visible; the item's current activation, read
 * when it is pressed, authorizes it.
 */
export function ImportOpenAction({ item }: { readonly item: ImportItem }) {
  return item.media_ref !== null &&
    (item.readiness.can_read || item.readiness.can_play) ? (
    <OpenMedia item={item} mediaRef={item.media_ref} />
  ) : null;
}

function OpenMedia({
  item,
  mediaRef,
}: {
  readonly item: ImportItem;
  readonly mediaRef: string;
}) {
  const { run } = useActionRuntime();
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const busy = useBusyActionIds(mediaRef).has("Open");
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportOpenAction");
  const { isMobile } = useViewportState();
  return (
    <>
    <Button
      variant="secondary"
      size="sm"
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (busy) return;
        run({
          ref: mediaRef,
          id: "Open",
          label: "open",
          title: item.title,
          confirmation: null,
          tracked: true,
          execute: async () => {
            const current = await resolveResourceItem(mediaRef);
            if (current.missing || current.activation.kind !== "route") {
              setFailure({
                  tone: "Warning",
                  title: "couldn’t open this item",
                  message: BLOCKED_COPY.TemporarilyUnavailable,
              });
              return;
            }
            setFailure(null);
            activateResource(current.activation, {
              labelHint: item.title,
              disposition: { kind: isMobile ? "Follow" : "Adopt" },
              activateTarget: runtime.activateTarget,
            });
          },
        });
      }}
    >
      open
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
      onClick={() => {
        if (busy) return;
        run({
          ref,
          id: offer.kind,
          label,
          title: "",
          confirmation: null,
          tracked: true,
          execute: () => recoverMedia(mediaId, offer),
        });
      }}
    >
      {label}
    </Button>
  );
}

function MediaActions({
  item,
  mediaRef,
}: {
  readonly item: ImportItem;
  readonly mediaRef: string;
}) {
  const mediaId = mediaRef.slice("media:".length);
  const key =
    item.state.kind !== "Complete" && item.state.stage === "Index"
      ? "search"
      : "source";
  const offer = item.obligations[key]?.recovery ?? null;
  const metadata = item.obligations.metadata;
  const metadataPrimary =
    item.state.kind !== "Complete" && item.state.stage === "Metadata";
  return (
    <>
      {metadataPrimary && metadata !== null ? (
        <MetadataResearchActions mediaId={mediaId} view={metadata} primaryOnly />
      ) : offer !== null && offer.kind !== "RetryUpload" ? (
        <MediaRecovery mediaId={mediaId} offer={offer} />
      ) : null}
      <ImportOpenAction item={item} />
      <ResourceActionMenu
        resourceRef={assumeCanonicalResourceRef(mediaRef)}
        label={`More actions for ${item.title}`}
      />
    </>
  );
}

/**
 * Retry upload and Remove for an unpublished upload. The provider dispatches
 * them under one pending key per import and command, which the row and the
 * inspector both read; a refusal stays beside the originating control.
 */
function UploadActions({ item }: { readonly item: ImportItem }) {
  const { pending, dispatchUpload } = useImports();
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const fail = useThrowLater();
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionId = item.ref.slice("upload:".length);
  const source = item.obligations.source;
  const recovery = source !== null ? source.recovery : null;
  const offer = recovery?.kind === "RetryUpload" ? recovery : null;
  const retrying = pending.has(pendingKey({ kind: "RetryUpload", sessionId }));
  const removing = pending.has(pendingKey({ kind: "RemoveUpload", sessionId }));
  const run = (command: UploadCommand) =>
    dispatchUpload(command).then(() => setFailure(null)).catch((error: unknown) => {
      try {
        const content = uploadCommandFeedback(command.kind, error);
        setFailure(content);
      } catch (defect) {
        fail({ error: defect });
      }
    });
  const choose = (file: File) => {
    if (offer === null || retrying) return;
    void run({ kind: "RetryUpload", sessionId, file });
  };
  const remove = () => {
    if (removing) return;
    if (!window.confirm(`Remove the unfinished import “${item.title}”?`))
      return;
    void run({ kind: "RemoveUpload", sessionId });
  };
  return (
    <>
      {offer === null ? null : (
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
            disabled={retrying}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) choose(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={retrying || undefined}
            aria-busy={retrying || undefined}
            onClick={() => { if (!retrying) inputRef.current?.click(); }}
          >
            {RETRY_UPLOAD_LABEL}
          </Button>
        </>
      )}
      {item.capabilities.can_remove ? (
        <ActionMenu
          label={`More actions for ${item.title}`}
          options={[
            {
              kind: "command",
              id: "Import.RemoveUpload",
              label: "Remove import",
              tone: "danger",
              disabled: removing,
              disabledReason: removing ? "Removal is in progress." : undefined,
              onSelect: remove,
            },
          ]}
        />
      ) : null}
      {failure === null ? null : <FeedbackNotice content={failure} announcement="Polite" />}
    </>
  );
}

/** Every action one import offers, the same in its row and its inspector. */
export function ImportActions({ item }: { readonly item: ImportItem }) {
  return item.media_ref !== null ? (
    <MediaActions item={item} mediaRef={item.media_ref} />
  ) : (
    <UploadActions item={item} />
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
  if (item.media_ref === null)
    return obligation === "source" ? <UploadActions item={item} /> : null;
  const offer = item.obligations[obligation]?.recovery ?? null;
  return offer === null || offer.kind === "RetryUpload" ? null : (
    <MediaRecovery mediaId={item.media_ref.slice("media:".length)} offer={offer} />
  );
}
