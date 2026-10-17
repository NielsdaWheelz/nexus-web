"use client";

import { useRef } from "react";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
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
import {
  RECOVERY_PENDING_LABEL,
  uploadCommandFeedback,
} from "@/lib/imports/copy";
import { removeUploadSession, uploadIngestFile } from "@/lib/imports/ingest";
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
  const busy = useBusyActionIds(mediaRef).has("Open");
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportOpenAction");
  const { isMobile } = useViewportState();
  const open = async () => {
    const current = await resolveResourceItem(mediaRef);
    if (current.missing || current.activation.kind !== "route") {
      ctx.feedback.publish({
        kind: "Hud",
        content: {
          tone: "Warning",
          title: "couldn’t open this item",
          message: BLOCKED_COPY.TemporarilyUnavailable,
        },
      });
      return;
    }
    activateResource(current.activation, {
      labelHint: item.title,
      disposition: { kind: isMobile ? "Follow" : "Adopt" },
      activateTarget: runtime.activateTarget,
    });
  };
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={() =>
        run({
          ref: mediaRef,
          id: "Open",
          label: "open",
          title: item.title,
          confirmation: null,
          tracked: true,
          execute: open,
        })
      }
    >
      open
    </Button>
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
      {busy ? RECOVERY_PENDING_LABEL : label}
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
  const { ctx, run } = useActionRuntime();
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
        } catch (error) {
          if (
            error instanceof UploadSessionError &&
            error.outcome.kind === "Superseded"
          )
            return;
          ctx.feedback.publish({
            kind: "Hud",
            content: uploadCommandFeedback(id, error),
          });
        }
      },
    });
  const remove = () => {
    if (window.confirm(`Remove the unfinished import “${item.title}”?`))
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
              if (file !== undefined)
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
            {retrying
              ? RECOVERY_PENDING_LABEL
              : ACTION_CATALOG.RetryUpload.label}
          </Button>
        </>
      ) : null}
      <ActionMenu
        label={`More actions for ${item.title}`}
        options={[
          {
            kind: "command",
            id: "Import.RemoveUpload",
            label: removing
              ? RECOVERY_PENDING_LABEL
              : ACTION_CATALOG.RemoveUpload.label,
            tone: "danger",
            disabled: removing,
            disabledReason: removing ? "Removal is in progress." : undefined,
            onSelect: remove,
          },
        ]}
      />
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
      <ResourceActionMenu
        resourceRef={assumeCanonicalResourceRef(`media:${mediaId}`)}
        label={`More actions for ${item.title}`}
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
