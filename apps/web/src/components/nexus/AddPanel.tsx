"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { ArrowLeft, FileText, Link, Plus, Upload, X } from "lucide-react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import LibraryDestinationField from "@/components/libraries/LibraryDestinationField";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Textarea from "@/components/ui/Textarea";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { isLibraryDestinationDefect } from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import {
  libraryPlacementDestinationKey,
  type LibraryPlacementDestinationKey,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import { libraryRequestErrorMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import type { NexusTarget } from "@/lib/nexus/model";
import { pluralize } from "@/lib/text/pluralize";
import type {
  AddContentSessionController,
  AddItem,
  AddSessionState,
  PlacementState,
} from "./useAddContentSession";
import styles from "./AddPanel.module.css";

export type AddDismissalConfirmation = {
  kind: "Discard" | "Stop";
  actionLabel: string;
} | null;

/** Desktop focuses the Links box (or what replaced it); mobile the heading. */
export function resolveAddPanelInitialFocus(
  container: HTMLElement,
  isMobile: boolean,
): HTMLElement | null {
  const heading = container.querySelector<HTMLElement>(
    '[data-add-heading="true"]',
  );
  if (isMobile) return heading;
  return (
    container.querySelector<HTMLElement>('[data-add-focus="url"]') ??
    container.querySelector<HTMLElement>('[data-add-focus="queue"]') ??
    container.querySelector<HTMLElement>('[data-add-focus="add-more"]') ??
    heading
  );
}

/** The one leave-Add question, asked by the panel and its defect boundary. */
export function AddDismissalDialog({
  confirmation,
  onKeepWorking,
  onConfirm,
  keepWorkingRef,
}: {
  readonly confirmation: AddDismissalConfirmation;
  readonly onKeepWorking: () => void;
  readonly onConfirm: () => void;
  readonly keepWorkingRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Dialog
      open={confirmation !== null}
      title={
        confirmation?.kind === "Stop"
          ? "Stop active work?"
          : "Discard unfinished work?"
      }
      onClose={onKeepWorking}
    >
      {confirmation ? (
        <div className={styles.confirmationBody}>
          <p>
            {confirmation.kind === "Stop"
              ? "Server changes that already committed may remain; unfinished upload bytes may not."
              : "Unsubmitted sources and unresolved outcomes will be lost."}
          </p>
          <div className={styles.confirmationActions}>
            <Button
              ref={keepWorkingRef}
              variant="secondary"
              size="sm"
              onClick={onKeepWorking}
            >
              Keep working
            </Button>
            <Button variant="danger" size="sm" onClick={onConfirm}>
              {confirmation.actionLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

type PlacementEditor = {
  kind: "Row" | "BulkAdd" | "BulkRemove";
  mediaIds: readonly string[];
  title: string;
  anchorEl: HTMLElement;
};
type EditorError = { content: FeedbackContent; onRetry: (() => void) | null };

function itemSource(item: AddItem) {
  return item.kind === "Invalid" || item.kind === "Accepted"
    ? item.source
    : item.intent.source;
}

function itemLabel(item: AddItem): string {
  const source = itemSource(item);
  if (source.kind === "Url") return source.url;
  return "file" in source ? source.file.name : source.name;
}

function itemStatus(item: AddItem): string {
  switch (item.kind) {
    case "Invalid":
      return "Not ready";
    case "Draft":
      return "Ready to add";
    case "Queued":
      return item.intent.source.kind === "File" ? "Preparing…" : "Saving…";
    case "Submitting":
      return `${item.phase}…`;
    case "Rejected":
      return "Not added";
    case "AcceptanceUnresolved":
      return item.reason === "StatusUnknown"
        ? "Acceptance status unknown"
        : "Upload didn’t complete";
    case "Accepted": {
      const prefix = item.result.duplicate ? "Already in Nexus" : "Saved";
      const processing = item.result.processing;
      if (processing === null) return prefix;
      return `${prefix} · ${processing === "failed" ? "processing failed" : processing}`;
    }
  }
}

/** The inventory a placement state can still show while it changes. */
function placementLibraries(
  placement: PlacementState | undefined,
): readonly LibraryPlacementOption[] {
  switch (placement?.kind) {
    case "Ready":
    case "Updating":
    case "Uncertain":
    case "Refused":
      return placement.libraries;
    case "Queued":
      return placementLibraries(placement.previous ?? undefined);
    default:
      return [];
  }
}

function mutationLabel(state: AddSessionState): string {
  if (state.mutation.kind === "Idle") return "";
  const operation = state.mutation.operation;
  // One upload in flight names its phase rather than the batch.
  if (
    (operation.kind === "Submit" && operation.itemIds.length === 1) ||
    operation.kind === "ReconcileAcceptance"
  ) {
    const upload = state.items.find(
      (item) =>
        item.kind === "Submitting" && item.intent.source.kind === "File",
    );
    if (upload?.kind === "Submitting") return `${upload.phase}…`;
  }
  switch (operation.kind) {
    case "Submit":
      return `Adding ${pluralize(operation.itemIds.length, "item")}…`;
    case "ReconcileAcceptance":
      return "Checking…";
    case "CreateDestination":
      return "Creating library…";
    case "Placement":
      return "Updating libraries…";
  }
}

function feedbackStatus(feedback: FeedbackContent): string {
  const request = feedback.requestId
    ? `Request ID: ${feedback.requestId}`
    : undefined;
  return [feedback.title, feedback.message, request].filter(Boolean).join(" ");
}

function isFileDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * The Add page: stage links and files, choose their libraries, send them, and
 * file what was accepted. Every command goes to the session; its defects go to
 * `onDefect`, which the boundary turns into "Add needs attention".
 */
export default function AddPanel({
  session,
  dismissalConfirmation,
  onBack,
  onClose,
  onKeepWorking,
  onConfirmDismissal,
  onOpen,
  onDefect,
}: {
  session: AddContentSessionController;
  dismissalConfirmation: AddDismissalConfirmation;
  onBack(): void;
  onClose(): void;
  onKeepWorking(): void;
  onConfirmDismissal(): void;
  onOpen(target: NexusTarget): void;
  onDefect(error: unknown): void;
}): React.ReactElement {
  const { state } = session;
  const id = useId();
  const operation =
    state.mutation.kind === "Running" ? state.mutation.operation : null;
  const busy = operation !== null;
  const creatingDestination = operation?.kind === "CreateDestination";
  const drafts = state.items.filter((item) => item.kind === "Draft");
  const accepted = state.items.filter(
    (item): item is Extract<AddItem, { kind: "Accepted" }> =>
      item.kind === "Accepted",
  );
  const acceptedMediaIds = [
    ...new Set(accepted.map((item) => item.result.mediaId)),
  ];
  const [sourceExpanded, setSourceExpanded] = useState(
    state.items.length === 0 || state.urlInput.text.trim() !== "",
  );
  const [dragActive, setDragActive] = useState(false);
  const [editor, setEditor] = useState<PlacementEditor | null>(null);
  const [creationError, setCreationError] = useState<EditorError | null>(null);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceFocusRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const addMoreRef = useRef<HTMLButtonElement>(null);
  const keepWorkingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dismissalConfirmation) {
      requestAnimationFrame(() => keepWorkingRef.current?.focus());
    }
  }, [dismissalConfirmation]);

  function run(command: () => Promise<void>) {
    void command().catch(onDefect);
  }
  function collapseToQueue() {
    setSourceExpanded(false);
    requestAnimationFrame(() => queueRef.current?.focus());
  }
  function stageFiles(files: readonly File[], input?: HTMLInputElement) {
    if (!session.stageFiles(files)) return;
    if (input) input.value = "";
    collapseToQueue();
  }
  /** Removing a row moves focus to its neighbour, else back to the sources. */
  function removeItem(itemId: string) {
    const index = state.items.findIndex((item) => item.id === itemId);
    const focusId = state.items[index + 1]?.id ?? state.items[index - 1]?.id;
    session.removeItem(itemId);
    requestAnimationFrame(() => {
      const target =
        focusId &&
        queueRef.current?.querySelector<HTMLElement>(
          `[data-add-item-id="${focusId}"] button:not(:disabled)`,
        );
      if (target) target.focus();
      else (addMoreRef.current ?? sourceFocusRef.current)?.focus();
    });
  }
  function openEditor(next: PlacementEditor) {
    setCreationError(null);
    setEditor(next);
    run(() => session.refreshPlacements(next.mediaIds));
  }
  async function createDestination(
    name: string,
  ): Promise<LibraryDestinationSelection> {
    try {
      return await session.createDestination(name);
    } catch (error) {
      if (isLibraryDestinationDefect(error)) onDefect(error);
      throw error;
    }
  }
  /** Create-and-add; a transport failure offers Retry of the same name. */
  async function createAndAdd(name: string, mediaIds: readonly string[]) {
    setCreationError(null);
    try {
      await session.createAndPlace({ name, mediaIds });
    } catch (error) {
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      try {
        const content = libraryRequestErrorMessage(error, {
          title: "Library couldn’t be created",
          request: "LibraryCreate",
        });
        const retryable =
          isApiError(error) &&
          apiTransportFeedback(error, content.title) !== null;
        setCreationError({
          content,
          onRetry: retryable ? () => void createAndAdd(name, mediaIds) : null,
        });
      } catch (defect) {
        onDefect(defect);
      }
    }
  }
  function destinationField(
    label: string,
    selected: readonly LibraryDestinationSelection[],
    onChange: (next: readonly LibraryDestinationSelection[]) => void,
  ) {
    return (
      <LibraryDestinationField
        label={label}
        emptyLabel="No additional libraries"
        selected={selected}
        onChange={onChange}
        interaction={
          creatingDestination
            ? { kind: "Creating" }
            : busy
              ? { kind: "Disabled" }
              : { kind: "Enabled" }
        }
        onCreateDestination={createDestination}
      />
    );
  }

  // The editor shows the inventory its targets share: every library for one
  // row, or for a bulk command only those the command can change.
  const editorPlacements =
    editor?.mediaIds
      .map((mediaId) => state.placementByMediaId.get(mediaId))
      .filter(
        (placement) =>
          editor.kind === "Row" || placement?.kind !== "Unavailable",
      ) ?? [];
  const loadingPlacements = editorPlacements.some(
    (placement) =>
      !placement || placement.kind === "Loading" || placement.kind === "Queued",
  );
  const failure =
    editorPlacements.find((placement) => placement?.kind === "Uncertain") ??
    editorPlacements.find(
      (placement) =>
        placement?.kind === "LoadFailed" ||
        placement?.kind === "Refused" ||
        placement?.kind === "Unavailable",
    );
  let placementError: EditorError | null = null;
  if (editor && failure && "feedback" in failure) {
    const retry =
      failure.kind === "Uncertain"
        ? () => run(() => session.retryPlacements(editor.mediaIds))
        : failure.kind === "LoadFailed"
          ? () => run(() => session.refreshPlacements(editor.mediaIds))
          : null;
    placementError = { content: failure.feedback, onRetry: retry };
  }
  const changing = editorPlacements.find(
    (placement) =>
      placement?.kind === "Updating" || placement?.kind === "Queued",
  );
  const pendingDestinationKey =
    changing?.kind === "Updating" || changing?.kind === "Queued"
      ? libraryPlacementDestinationKey(changing.command.destination)
      : null;
  const presented = new Map<
    LibraryPlacementDestinationKey,
    LibraryPlacementOption
  >();
  for (const placement of editorPlacements) {
    for (const option of placementLibraries(placement)) {
      if (editor?.kind !== "Row") {
        const relation = editor?.kind === "BulkAdd" ? "Absent" : "Direct";
        if (
          option.availability.kind !== "Available" ||
          option.relation.kind !== relation
        ) {
          continue;
        }
      }
      const key = libraryPlacementDestinationKey(option.destination);
      if (!presented.has(key)) presented.set(key, option);
    }
  }
  const placingMediaIds = new Set(
    operation?.kind === "Placement" ? operation.mediaIds : [],
  );
  const unknown = state.items.filter(
    (item) => item.kind === "AcceptanceUnresolved",
  ).length;
  const attention = state.items.filter(
    (item) => item.kind === "Invalid" || item.kind === "Rejected",
  ).length;
  const intake = state.intakeFeedback ?? state.urlInput.feedback;
  const liveStatus = busy
    ? mutationLabel(state)
    : intake
      ? feedbackStatus(intake)
      : `${drafts.length} ready, ${accepted.length} accepted, ${unknown} status unknown, ${attention} need attention.`;
  const urlHintId = state.urlInput.feedback
    ? `${id}-url-feedback`
    : `${id}-url-help`;
  const dragEvents = {
    onDragEnter: (event: React.DragEvent) => {
      if (!isFileDrag(event) || busy) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!isFileDrag(event) || busy) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!isFileDrag(event) || busy) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      stageFiles(Array.from(event.dataTransfer.files));
    },
  };

  const sourceEntry = (
    <section className={styles.sourceEntry} aria-label="Add sources">
      <form
        className={styles.urlForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (session.reviewUrls()) collapseToQueue();
        }}
      >
        <label htmlFor={`${id}-urls`}>Links</label>
        <Textarea
          ref={sourceFocusRef}
          id={`${id}-urls`}
          data-add-focus="url"
          size="sm"
          className={styles.urlTextarea}
          value={state.urlInput.text}
          disabled={busy}
          aria-invalid={state.urlInput.feedback ? true : undefined}
          aria-describedby={urlHintId}
          onChange={(event) => session.setUrlText(event.target.value)}
          placeholder="Paste links to articles, videos, PDFs, or EPUBs"
          rows={3}
        />
        <div className={styles.sourceActions}>
          <p id={urlHintId}>
            {state.urlInput.feedback?.title ??
              "One per line, or paste text containing links."}
          </p>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={busy || !state.urlInput.text.trim()}
          >
            Review links
          </Button>
        </div>
      </form>
      <div
        className={`${styles.fileDrop}${dragActive ? ` ${styles.fileDropActive}` : ""}`}
        {...dragEvents}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          className={styles.fileInput}
          aria-label="Choose PDF or EPUB files"
          disabled={busy}
          onChange={(event) =>
            stageFiles(
              Array.from(event.target.files ?? []),
              event.currentTarget,
            )
          }
        />
        <Button
          data-add-focus="file"
          variant="secondary"
          size="sm"
          disabled={busy}
          leadingIcon={<Upload size={15} aria-hidden="true" />}
          onClick={() => fileInputRef.current?.click()}
        >
          Choose PDF or EPUB
        </Button>
        <span>or drop files here · PDF up to 100 MB · EPUB up to 50 MB</span>
      </div>
      {drafts.length === 0
        ? destinationField(
            "Libraries",
            state.defaultDestinations,
            session.setDefaultDestinations,
          )
        : null}
    </section>
  );

  function row(item: AddItem) {
    const feedback =
      item.kind === "Invalid" ||
      item.kind === "Rejected" ||
      item.kind === "AcceptanceUnresolved"
        ? item.feedback
        : null;
    const feedbackId = feedback ? `${id}-${item.id}-feedback` : undefined;
    const mediaId = item.kind === "Accepted" ? item.result.mediaId : null;
    const label = itemLabel(item);
    const removable =
      item.kind === "Invalid" ||
      item.kind === "Draft" ||
      item.kind === "Rejected" ||
      item.kind === "AcceptanceUnresolved";
    return (
      <article
        key={item.id}
        className={styles.queueItem}
        data-add-item-id={item.id}
        aria-describedby={feedbackId}
      >
        <div className={styles.itemIcon} aria-hidden="true">
          {itemSource(item).kind === "File" ? (
            <FileText size={16} />
          ) : (
            <Link size={16} />
          )}
        </div>
        <div className={styles.itemMain}>
          <span className={styles.itemLabel} title={label}>
            {label}
          </span>
          <span className={styles.itemStatus}>{itemStatus(item)}</span>
          {mediaId && placingMediaIds.has(mediaId) ? (
            <span className={styles.placementStatus}>Updating libraries…</span>
          ) : null}
          {feedback ? (
            <span
              id={feedbackId}
              className={styles.itemFeedback}
              data-tone={feedback.tone}
            >
              {feedbackStatus(feedback)}
            </span>
          ) : null}
        </div>
        <div className={styles.itemActions}>
          {item.kind === "Draft"
            ? destinationField("Libraries", item.intent.destinations, (next) =>
                session.setItemDestinations(item.id, next),
              )
            : null}
          {item.kind === "Rejected" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => session.restageItem(item.id)}
            >
              Restage
            </Button>
          ) : null}
          {item.kind === "AcceptanceUnresolved" ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => run(() => session.reconcileAcceptance(item.id))}
              >
                {item.reason === "UploadIncomplete"
                  ? "Retry upload"
                  : "Check status"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => session.restageItem(item.id)}
              >
                Restage as new
              </Button>
            </>
          ) : null}
          {mediaId ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  onOpen({ kind: "InternalHref", href: `/media/${mediaId}` })
                }
              >
                Open
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={(event) =>
                  openEditor({
                    kind: "Row",
                    mediaIds: [mediaId],
                    title: `Libraries for ${label}`,
                    anchorEl: event.currentTarget,
                  })
                }
              >
                Libraries
              </Button>
            </>
          ) : null}
          {removable ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              disabled={busy}
              onClick={() => removeItem(item.id)}
              aria-label={`Remove ${label}`}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </article>
    );
  }
  const bulk = (
    kind: "BulkAdd" | "BulkRemove",
    title: string,
    text: string,
  ) => (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      onClick={(event) =>
        openEditor({
          kind,
          mediaIds: acceptedMediaIds,
          title,
          anchorEl: event.currentTarget,
        })
      }
    >
      {text}
    </Button>
  );

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <div className={styles.heading}>
          <h2 ref={headingRef} tabIndex={-1} data-add-heading="true">
            Add content
          </h2>
          <p>Review sources, then add them when you are ready.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onClose}
          aria-label="Close Add content"
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.body}>
        {state.items.length === 0 || sourceExpanded ? (
          sourceEntry
        ) : (
          <Button
            ref={addMoreRef}
            data-add-focus="add-more"
            variant="ghost"
            size="sm"
            className={styles.addMore}
            disabled={busy}
            leadingIcon={<Plus size={15} aria-hidden="true" />}
            onClick={() => {
              setSourceExpanded(true);
              requestAnimationFrame(() => sourceFocusRef.current?.focus());
            }}
          >
            Add more
          </Button>
        )}
        {drafts.length > 0 ? (
          <section className={styles.draftToolbar} aria-label="Draft filing">
            {destinationField(
              `Libraries for all ${pluralize(drafts.length, "draft")}`,
              state.defaultDestinations,
              session.setDefaultDestinations,
            )}
          </section>
        ) : null}
        {state.intakeFeedback ? (
          <p className={styles.intakeFeedback}>{state.intakeFeedback.title}</p>
        ) : null}
        {state.items.length > 0 ? (
          <div
            ref={queueRef}
            className={styles.queue}
            tabIndex={-1}
            data-add-focus="queue"
            aria-label="Items to add"
          >
            {state.items.map(row)}
          </div>
        ) : null}
        {accepted.length > 0 ? (
          <section className={styles.acceptedSummary} aria-label="Added items">
            <p>{pluralize(accepted.length, "item")} added</p>
            <div>
              {bulk("BulkAdd", "Add all to libraries", "Add all to…")}
              {bulk(
                "BulkRemove",
                "Remove all from libraries",
                "Remove all from…",
              )}
            </div>
          </section>
        ) : null}
      </div>
      <div className={styles.liveStatus} role="status" aria-live="polite">
        {liveStatus}
      </div>
      <footer className={styles.footer}>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          onClick={() => {
            if (busy) return;
            if (drafts.length > 0) run(session.submit);
            else onClose();
          }}
        >
          {busy
            ? mutationLabel(state)
            : drafts.length > 0
              ? `Add ${pluralize(drafts.length, "item")}`
              : "Done"}
        </Button>
      </footer>
      <AddDismissalDialog
        confirmation={dismissalConfirmation}
        onKeepWorking={onKeepWorking}
        onConfirm={onConfirmDismissal}
        keepWorkingRef={keepWorkingRef}
      />
      <LibraryChooserSurface
        active={editor !== null}
        onClose={() => {
          setEditor(null);
          setCreationError(null);
        }}
        anchor={() => editor?.anchorEl ?? null}
        returnFocusFallback={() => headingRef.current}
        title={editor?.title ?? "Libraries"}
        focusKey={editor?.anchorEl}
      >
        {editor ? (
          <LibraryEntryEditor
            placements={[...presented.values()]}
            loading={loadingPlacements}
            busy={busy}
            creating={creatingDestination}
            pendingDestinationKey={pendingDestinationKey}
            error={creationError ?? placementError}
            onToggle={(destination) => {
              const option = presented.get(
                libraryPlacementDestinationKey(destination),
              );
              if (!option || option.relation.kind === "Inherited") return;
              setCreationError(null);
              const kind = option.relation.kind === "Absent" ? "Add" : "Remove";
              run(() =>
                session.runPlacement({
                  mediaIds: editor.mediaIds,
                  command: { kind, destination },
                }),
              );
            }}
            onCreateLibrary={
              editor.kind === "BulkRemove" || editorPlacements.length === 0
                ? null
                : (name) => void createAndAdd(name, editor.mediaIds)
            }
            selectedGroupLabel="In these libraries"
            otherGroupLabel="Other libraries"
            searchLabel="Search or create a library"
            searchPlaceholder="Search or create"
            listLabel="Library options"
            emptyInventory="No eligible libraries."
          />
        ) : null}
      </LibraryChooserSurface>
    </div>
  );
}
