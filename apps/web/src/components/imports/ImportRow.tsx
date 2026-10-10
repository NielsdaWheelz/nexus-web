"use client";

import { useMemo, useRef } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import { RESOURCE_ACTION_BLOCKED_REASON_COPY } from "@/lib/actions/resourceActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import { useThrowLater } from "@/lib/api/serverState";
import type { ImportItem, RecoveryOffer } from "@/lib/imports/api";
import {
  KIND_LABEL,
  RECOVERY_PENDING_LABEL,
  RETRY_UPLOAD_LABEL,
  ageLine,
  matchLine,
  originalFileFeedback,
  reasonLine,
  stateBadge,
  statusLine,
  uploadCommandFeedback,
} from "@/lib/imports/copy";
import { getFileUploadKind, type UploadFileKind } from "@/lib/imports/ingest";
import {
  pendingKey,
  useImports,
  type UploadCommand,
} from "@/lib/imports/ImportsProvider";
import type { MediaKind } from "@/lib/media/kind";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import styles from "./Imports.module.css";

type MediaOffer = Exclude<RecoveryOffer, { kind: "RetryUpload" }>;

const MEDIA_ACTION = {
  RetrySource: "ResourceOperation.Media.RetryProcessing",
  RepairSource: "ResourceOperation.Media.RepairSource",
  RepairSearch: "ResourceOperation.Media.RepairSearch",
} as const;

/** The upload kind a file must have to be this import's original. */
const UPLOAD_KIND: Readonly<Record<MediaKind, UploadFileKind | null>> = {
  pdf: "Pdf",
  epub: "Epub",
  web_article: null,
  podcast_episode: null,
  video: null,
};

/**
 * The one control a media offer authorizes. The resource-action runtime owns
 * the identity it commands and its busy state, so a stale command conflicts
 * on the server instead of acting on work this reader never saw.
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
  if (action === undefined || action.kind !== "command") return null;
  const busy =
    action.disabled === true &&
    action.disabledReason === RESOURCE_ACTION_BLOCKED_REASON_COPY.Busy;
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={action.disabled}
      onClick={() => action.onSelect({ triggerEl: null })}
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
  const offer = item.capabilities.recovery;
  return (
    <>
      {offer.kind === "Present" && offer.value.kind !== "RetryUpload" ? (
        <MediaRecovery subject={subject} offer={offer.value} />
      ) : null}
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
  const recovery = item.capabilities.recovery;
  const offer =
    recovery.kind === "Present" && recovery.value.kind === "RetryUpload"
      ? recovery.value
      : null;
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
    const kind = UPLOAD_KIND[item.media_kind];
    if (
      kind === null ||
      file.name !== item.title ||
      getFileUploadKind(file) !== kind
    ) {
      feedback.publish({
        kind: "Hud",
        content: originalFileFeedback(item.title),
      });
      return;
    }
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
            aria-label={`Choose ${item.title} to retry the upload`}
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
        <Button
          variant="secondary"
          size="sm"
          aria-label={removing ? undefined : `Remove ${item.title}`}
          disabled={removing}
          onClick={remove}
        >
          {removing ? RECOVERY_PENDING_LABEL : "Remove"}
        </Button>
      ) : null}
    </>
  );
}

/** Every action one import offers, the same in its row and its inspector. */
export function ImportActions({ item }: { readonly item: ImportItem }) {
  return item.media_ref.kind === "Present" ? (
    <MediaActions item={item} mediaRef={item.media_ref.value} />
  ) : (
    <UploadActions item={item} />
  );
}

/**
 * One import: what it is, what it is doing or waiting for, why, and the
 * command that recovers it when the server offers one. Selecting it opens the
 * inspector; the accessible name stays the whole title however it truncates.
 */
export default function ImportRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: ImportItem;
  readonly selected: boolean;
  readonly onSelect: (ref: string) => void;
}) {
  const display = useRenderEnvironment();
  const now = new Date();
  const badge = stateBadge(item);
  const reason = reasonLine(item);
  const age = ageLine(item, display, now);
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
          <span>{KIND_LABEL[item.media_kind]}</span>
          {item.source_label.kind === "Present" ? (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              <span>{item.source_label.value}</span>
            </>
          ) : null}
        </>
      }
      status={
        <span className={styles.rowStatus}>
          <Pill tone={badge.tone} size="sm">
            {badge.label}
          </Pill>
          <span className={styles.rowStatusLine}>{statusLine(item)}</span>
          {reason === null ? null : (
            <span className={styles.rowReason}>{reason}</span>
          )}
          <time className={styles.rowAge} dateTime={age.dateTime}>
            {age.text}
          </time>
          {item.matched_event.kind === "Present" ? (
            <span className={styles.rowMatched}>
              {matchLine(item.matched_event.value, display, now)}
            </span>
          ) : null}
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
