"use client";

import { useMemo, useRef } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { RESOURCE_ACTION_BLOCKED_REASON_COPY } from "@/lib/actions/resourceActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import { useThrowLater } from "@/lib/api/serverState";
import {
  publishImportsInvalidation,
  type ImportItem,
  type RecoveryOffer,
} from "@/lib/imports/api";
import {
  RECOVERY_PENDING_LABEL,
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
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

type MediaOffer = Exclude<RecoveryOffer, { kind: "RetryUpload" }>;

const MEDIA_ACTION = {
  RetrySource: "ResourceOperation.Media.RetryProcessing",
  RepairSource: "ResourceOperation.Media.RepairSource",
  RepairSearch: "ResourceOperation.Media.RepairSearch",
} as const;

/** Readiness keeps the control visible; a current canonical snapshot authorizes it. */
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
  const subject = useMemo(
    () => ({ ref: assumeCanonicalResourceRef(mediaRef) }),
    [mediaRef],
  );
  const model = useResourceActionMenuModel(subject);
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportOpenAction");
  const { isMobile } = useViewportState();
  const action = model.descriptors.find(
    (candidate) => candidate.id === "ResourceAction.Open",
  );
  const activation = model.activation;
  const available =
    activation?.kind === "route" &&
    action?.kind === "command" &&
    !action.disabled;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={!available}
      title={
        available
          ? undefined
          : (action?.disabledReason ??
            model.triggerDisabledReason ??
            "Refresh actions to open this item.")
      }
      onClick={() => {
        if (!available || activation === null) return;
        activateResource(activation, {
          labelHint: item.title,
          disposition: { kind: isMobile ? "Follow" : "Adopt" },
          activateTarget: runtime.activateTarget,
        });
      }}
    >
      open
    </Button>
  );
}

/**
 * The row and action snapshot refresh independently. Only invoke a descriptor
 * whose exact owner identity is the one this import displays.
 */
function MediaRecovery({
  subject,
  offer,
}: {
  readonly subject: ResourceActionSubject;
  readonly offer: MediaOffer;
}) {
  const model = useResourceActionMenuModel(subject);
  const action = model.descriptors.find(
    (candidate) => candidate.id === MEDIA_ACTION[offer.kind],
  );
  const capability = model.capabilities.find((candidate) =>
    offer.kind === "RepairSearch"
      ? candidate.kind === "SearchRecovery"
      : candidate.kind === "SourceRecovery",
  );
  const current =
    capability?.kind === "SourceRecovery" ||
    capability?.kind === "SearchRecovery"
      ? capability.offer
      : undefined;
  const matches =
    offer.kind === "RetrySource"
      ? current?.kind === "RetrySource" &&
        current.input === offer.input &&
        current.expected_attempt_id === offer.expected_attempt_id
      : offer.kind === "RepairSource"
        ? current?.kind === "RepairSource" &&
          current.input === offer.input &&
          current.expected_attempt_id === offer.expected_attempt_id &&
          current.expected_job_id === offer.expected_job_id
        : current?.kind === "RepairSearch" &&
          current.input === offer.input &&
          current.expected_revision === offer.expected_revision &&
          current.expected_job_id === offer.expected_job_id;
  if (model.status === "Ready" && !matches) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          publishImportsInvalidation();
          model.refresh();
        }}
      >
        refresh status
      </Button>
    );
  }
  if (action === undefined || action.kind !== "command") return null;
  const busy =
    action.disabled === true &&
    action.disabledReason === RESOURCE_ACTION_BLOCKED_REASON_COPY.Busy;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={action.disabled && !busy}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (action.disabled) return;
        action.onSelect({ triggerEl: event.currentTarget });
      }}
    >
      {busy ? RECOVERY_PENDING_LABEL : action.label}
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
  const subject = useMemo(
    () => ({ ref: assumeCanonicalResourceRef(mediaRef) }),
    [mediaRef],
  );
  const key =
    item.state.kind !== "Complete" && item.state.stage === "Index"
      ? "search"
      : "source";
  const obligation = item.obligations[key];
  const offer = obligation !== null ? obligation.recovery : null;
  const metadata = item.obligations.metadata;
  const metadataPrimary =
    item.state.kind !== "Complete" && item.state.stage === "Metadata";
  return (
    <>
      {metadataPrimary && metadata !== null ? (
        <MetadataResearchActions
          mediaId={mediaRef.slice("media:".length)}
          view={metadata}
          primaryOnly
        />
      ) : offer != null && offer.kind !== "RetryUpload" ? (
        <MediaRecovery subject={subject} offer={offer} />
      ) : null}
      <ImportOpenAction item={item} />
      <ResourceActionMenu
        actionSubject={subject}
        label={`More actions for ${item.title}`}
      />
    </>
  );
}

/**
 * Retry upload and Remove for an unpublished upload. The provider dispatches
 * them under one pending key per import and command, which the row and the
 * inspector both read; a refusal is a HUD notice.
 */
function UploadActions({ item }: { readonly item: ImportItem }) {
  const { pending, dispatchUpload } = useImports();
  const feedback = useFeedback();
  const fail = useThrowLater();
  const inputRef = useRef<HTMLInputElement>(null);
  const handle = item.ref.slice("upload:".length);
  const source = item.obligations.source;
  const recovery = source !== null ? source.recovery : null;
  const offer = recovery?.kind === "RetryUpload" ? recovery : null;
  const retrying = pending.has(pendingKey({ kind: "RetryUpload", handle }));
  const removing = pending.has(pendingKey({ kind: "RemoveUpload", handle }));
  const run = (command: UploadCommand) =>
    dispatchUpload(command).catch((error: unknown) => {
      try {
        const content = uploadCommandFeedback(command.kind, error);
        feedback.publish({ kind: "Hud", content });
      } catch (defect) {
        fail({ error: defect });
      }
    });
  const choose = (file: File) => {
    if (offer === null) return;
    void run({
      kind: "RetryUpload",
      handle,
      file,
      expectedGeneration: offer.expected_generation,
    });
  };
  const remove = () => {
    if (!window.confirm(`Remove the unfinished import “${item.title}”?`))
      return;
    void run({ kind: "RemoveUpload", handle });
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
            disabled={retrying}
            onClick={() => inputRef.current?.click()}
          >
            {retrying ? RECOVERY_PENDING_LABEL : RETRY_UPLOAD_LABEL}
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
              label: removing ? RECOVERY_PENDING_LABEL : "Remove import",
              tone: "danger",
              disabled: removing,
              disabledReason: removing ? "Removal is in progress." : undefined,
              onSelect: remove,
            },
          ]}
        />
      ) : null}
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
  const mediaRef = item.media_ref;
  const subject = useMemo(
    () =>
      mediaRef !== null ? { ref: assumeCanonicalResourceRef(mediaRef) } : null,
    [mediaRef],
  );
  if (subject === null)
    return obligation === "source" ? <UploadActions item={item} /> : null;
  const slot = item.obligations[obligation];
  if (slot === null || slot.recovery === null) return null;
  const offer = slot.recovery;
  return offer.kind === "RetryUpload" ? null : (
    <MediaRecovery subject={subject} offer={offer} />
  );
}
