"use client";

import { useMemo, useRef, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Pill, { type PillTone } from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import {
  RESOURCE_ACTION_BLOCKED_REASON_COPY,
  useResourceActionMenuModel,
} from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionId } from "@/lib/actions/resourceActions";
import { assertNever } from "@/lib/assertNever";
import type { ImportRef } from "@/lib/imports/importRef";
import {
  importsPendingKey,
  useImports,
} from "@/lib/imports/ImportsProvider";
import type {
  ImportItem,
  MediaRecoveryOffer,
  RecoveryOffer,
} from "@/lib/imports/importsClient";
import { getFileUploadKind } from "@/lib/media/ingestionClient";
import type { MediaKind } from "@/lib/media/kind";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  IMPORT_RECOVERY_PENDING_LABEL,
  IMPORT_RETRY_UPLOAD_LABEL,
  historyMatchLine,
  importAgeLine,
  importKindLabel,
  importOriginalFileFeedback,
  importUploadCommandFeedback,
  importReasonLine,
  importStateLabel,
  importStatusLine,
  isUploadObligation,
} from "@/lib/status/imports";
import styles from "./ImportsWorkspace.module.css";

const RECOVERY_ACTION_ID: Readonly<
  Record<MediaRecoveryOffer["kind"], ResourceActionId>
> = {
  RetrySource: "ResourceOperation.Media.RetryProcessing",
  RepairSource: "ResourceOperation.Media.RepairSource",
  RepairSearch: "ResourceOperation.Media.RepairSearch",
};

const STATE_TONE: Readonly<Record<ImportItem["state"]["kind"], PillTone>> = {
  Active: "info",
  NeedsAttention: "warning",
  Complete: "success",
};

/** The upload this import is still waiting for, if its obligation is the upload. */
function uploadObligation(item: ImportItem): RecoveryOffer | null {
  if (!isUploadObligation(item)) return null;
  return item.capabilities.recovery.kind === "Present"
    ? item.capabilities.recovery.value
    : null;
}

function uploadFileKind(kind: MediaKind): "Pdf" | "Epub" | null {
  switch (kind) {
    case "pdf":
      return "Pdf";
    case "epub":
      return "Epub";
    case "web_article":
    case "podcast_episode":
    case "video":
      return null;
    default:
      return assertNever(kind, "Unreachable media kind");
  }
}

/**
 * The one control a media recovery offer authorizes. The offer the pane read
 * says whether to show it; the resource-action runtime owns the identity it
 * commands and the busy state of that command, so a stale command conflicts on
 * the server instead of acting on work this reader never saw (contract D7).
 */
function MediaRecoveryAction({
  subject,
  offer,
}: {
  readonly subject: ResourceActionSubject;
  readonly offer: MediaRecoveryOffer;
}) {
  const model = useResourceActionMenuModel(subject);
  const descriptor = model.descriptors.find(
    (candidate) => candidate.id === RECOVERY_ACTION_ID[offer.kind],
  );
  if (descriptor === undefined || descriptor.kind !== "command") return null;
  const pending =
    descriptor.disabled === true &&
    descriptor.disabledReason === RESOURCE_ACTION_BLOCKED_REASON_COPY.Busy;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={descriptor.disabled}
      onClick={() => descriptor.onSelect({ triggerEl: null })}
    >
      {pending ? IMPORT_RECOVERY_PENDING_LABEL : descriptor.label}
    </Button>
  );
}

/**
 * The upload obligations, which are not resources: the provider dispatches them
 * under the same per-import, per-command pending key, so two rows can be busy
 * at once and neither disables the other.
 */
function UploadActions({
  item,
  offer,
}: {
  readonly item: ImportItem;
  readonly offer: RecoveryOffer | null;
}) {
  const { pending, dispatchUpload } = useImports();
  const feedback = useFeedback();
  const inputRef = useRef<HTMLInputElement>(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const retryPending = pending.has(importsPendingKey(item.ref, "RetryUpload"));
  const removePending = pending.has(importsPendingKey(item.ref, "RemoveUpload"));

  // A live page replaces its rows, so a refused command reports where the
  // resource-action runtime reports one: the shared feedback surface.
  const dispatch = async (command: Parameters<typeof dispatchUpload>[0]) => {
    try {
      await dispatchUpload(command);
    } catch (error: unknown) {
      try {
        feedback.publish({
          kind: "Hud",
          content: importUploadCommandFeedback(command.kind, error),
        });
      } catch (caught: unknown) {
        setDefect({ error: caught });
      }
    }
  };

  const chooseFile = (file: File) => {
    // An import Nexus can accept bytes for is a PDF or an EPUB; anything else
    // has no upload kind to match, so no file can be the original.
    const expectedKind = uploadFileKind(item.mediaKind);
    if (
      expectedKind === null ||
      file.name !== item.title ||
      getFileUploadKind(file) !== expectedKind
    ) {
      feedback.publish({
        kind: "Hud",
        content: importOriginalFileFeedback(item.title),
      });
      return;
    }
    if (offer === null || offer.kind !== "RetryUpload") return;
    void dispatch({
      kind: "RetryUpload",
      ref: item.ref,
      file,
      expectedGeneration: offer.expectedGeneration,
    });
  };

  const remove = () => {
    if (!window.confirm(`Remove the unfinished import “${item.title}”?`)) return;
    void dispatch({ kind: "RemoveUpload", ref: item.ref });
  };

  if (defect !== null) throw defect.error;

  return (
    <>
      {offer !== null && offer.kind === "RetryUpload" ? (
        <>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            aria-label={`Choose ${item.title} to retry the upload`}
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            disabled={retryPending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) chooseFile(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={retryPending}
            onClick={() => inputRef.current?.click()}
          >
            {retryPending
              ? IMPORT_RECOVERY_PENDING_LABEL
              : IMPORT_RETRY_UPLOAD_LABEL}
          </Button>
        </>
      ) : null}
      {item.capabilities.canRemove ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={removePending}
          onClick={remove}
        >
          {removePending ? IMPORT_RECOVERY_PENDING_LABEL : "Remove"}
        </Button>
      ) : null}
    </>
  );
}

/** Every action one import offers, in one place per row and per inspector. */
export function ImportActions({ item }: { readonly item: ImportItem }) {
  const upload = uploadObligation(item);
  const mediaRef = item.mediaRef.kind === "Present" ? item.mediaRef.value : null;
  const subject = useMemo<ResourceActionSubject | null>(
    () => (mediaRef === null ? null : { ref: mediaRef }),
    [mediaRef],
  );
  const offer =
    item.capabilities.recovery.kind === "Present"
      ? item.capabilities.recovery.value
      : null;
  if (subject === null) {
    return <UploadActions item={item} offer={upload} />;
  }
  return (
    <>
      {offer === null || offer.kind === "RetryUpload" ? null : (
        <MediaRecoveryAction subject={subject} offer={offer} />
      )}
      <ResourceActionMenu
        actionSubject={subject}
        label={`More actions for ${item.title}`}
      />
    </>
  );
}

/**
 * One import: what it is, what it is doing or waiting for, why, and — when the
 * server offered one — the command that recovers it. Selection opens the
 * inspector; the accessible name stays the whole title however it truncates.
 */
export default function ImportRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: ImportItem;
  readonly selected: boolean;
  readonly onSelect: (ref: ImportRef) => void;
}) {
  const display = useRenderEnvironment();
  const reason = importReasonLine(item);
  const matched =
    item.matchedEvent.kind === "Present"
      ? historyMatchLine(item.matchedEvent.value, display)
      : null;
  const age = importAgeLine(item, display, new Date());
  return (
    <ResourceRow
      as="li"
      selected={selected}
      rootProps={{
        "aria-label": item.title,
        "aria-current": selected ? "true" : undefined,
        "data-import-ref": item.ref,
      }}
      primary={{
        kind: "button",
        label: item.title,
        onActivate: () => onSelect(item.ref),
      }}
      title={item.title}
      supporting={
        <>
          <span>{importKindLabel(item.mediaKind)}</span>
          {item.sourceLabel.kind === "Present" ? (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              <span>{item.sourceLabel.value}</span>
            </>
          ) : null}
        </>
      }
      status={
        <span className={styles.rowStatus}>
          <Pill tone={STATE_TONE[item.state.kind]} size="sm">
            {importStateLabel(item.state)}
          </Pill>
          <span className={styles.rowStatusLine}>{importStatusLine(item)}</span>
          {reason === null ? null : (
            <span className={styles.rowReason}>{reason}</span>
          )}
          <time className={styles.rowAge} dateTime={age.dateTime}>
            {age.text}
          </time>
          {matched === null ? null : (
            <span className={styles.rowMatched}>{matched}</span>
          )}
        </span>
      }
      actions={
        <span className={styles.rowActions}>
          <ImportActions item={item} />
        </span>
      }
    />
  );
}
