"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, FileText, Link, Plus, Upload, X } from "lucide-react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import LibraryDestinationField from "@/components/libraries/LibraryDestinationField";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Textarea from "@/components/ui/Textarea";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { isLibraryDestinationDefect } from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import { libraryRequestErrorMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import {
  libraryPlacementDestinationKey,
  type LibraryPlacementDestinationKey,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import type { NexusTarget } from "@/lib/nexus/model";
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

interface AddPanelProps {
  session: AddContentSessionController;
  dismissalConfirmation: AddDismissalConfirmation;
  onBack(): void;
  onClose(): void;
  onKeepWorking(): void;
  onConfirmDismissal(): void;
  onOpen(target: NexusTarget): void;
  onDefect(error: unknown): void;
}

export function resolveAddPanelInitialFocus(
  container: HTMLElement,
  isMobile: boolean,
  state: Pick<AddSessionState, "initialFocus">,
): HTMLElement | null {
  const heading = container.querySelector<HTMLElement>('[data-add-heading="true"]');
  if (isMobile) return heading;
  const requested = state.initialFocus === "File" ? "file" : "url";
  return container.querySelector<HTMLElement>(`[data-add-focus="${requested}"]`) ??
    container.querySelector<HTMLElement>('[data-add-focus="queue"]') ??
    container.querySelector<HTMLElement>('[data-add-focus="add-more"]') ?? heading;
}

type PlacementEditor = {
  kind: "Row" | "BulkAdd" | "BulkRemove";
  mediaIds: readonly string[];
  title: string;
  anchorEl: HTMLElement;
};
type EditorError = { content: FeedbackContent; onRetry: (() => void) | null };

function itemSource(item: AddItem) {
  return item.kind === "Invalid" || item.kind === "Accepted" ? item.source : item.intent.source;
}

function itemLabel(item: AddItem): string {
  const source = itemSource(item);
  return source.kind === "Url" ? source.url : "file" in source ? source.file.name : source.name;
}

function itemStatus(item: AddItem): string {
  switch (item.kind) {
    case "Invalid": return "Not ready";
    case "Draft": return "Ready to add";
    case "Queued": return item.intent.source.kind === "File" ? "Preparing…" : "Saving…";
    case "Submitting": return `${item.phase}…`;
    case "Rejected": return "Not added";
    case "AcceptanceUnresolved":
      return item.reason === "StatusUnknown" ? "Acceptance status unknown" : "Upload didn’t complete";
    case "Accepted": {
      const prefix = item.result.duplicate ? "Already in Nexus" : "Saved";
      if (item.result.kind === "PublishedUpload") return prefix;
      if (item.result.sourceAttemptStatus === "failed") return `${prefix} · processing failed`;
      switch (item.result.processingStatus) {
        case "pending":
        case "extracting": return `${prefix} · processing`;
        case "ready_for_reading": return `${prefix} · ready`;
        case "failed": return `${prefix} · processing failed`;
        default: return assertNever(item.result.processingStatus, "Unreachable processing status");
      }
    }
  }
}

function librariesForPlacement(placement: PlacementState | undefined): readonly LibraryPlacementOption[] {
  if (!placement) return [];
  switch (placement.kind) {
    case "Ready":
    case "Updating":
    case "Uncertain":
    case "Refused": return placement.libraries;
    case "Queued": return librariesForPlacement(placement.previous ?? undefined);
    case "Loading":
    case "LoadFailed":
    case "Unavailable": return [];
  }
}

function mutationLabel(state: AddSessionState): string {
  if (state.mutation.kind === "Idle") return "";
  const operation = state.mutation.operation;
  if ((operation.kind === "Submit" && operation.itemIds.length === 1) ||
      operation.kind === "ReconcileAcceptance") {
    const upload = state.items.find((item) => item.kind === "Submitting" && item.intent.source.kind === "File");
    if (upload?.kind === "Submitting") return `${upload.phase}…`;
  }
  switch (operation.kind) {
    case "Submit": return `Adding ${operation.itemIds.length} ${operation.itemIds.length === 1 ? "item" : "items"}…`;
    case "ReconcileAcceptance": return "Checking…";
    case "CreateDestination": return "Creating library…";
    case "Placement": return "Updating libraries…";
  }
}

function feedbackStatus(feedback: FeedbackContent): string {
  return [feedback.title, feedback.message, feedback.requestId ? `Request ID: ${feedback.requestId}` : undefined]
    .filter(Boolean).join(" ");
}

function isSupportedDrop(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export default function AddPanel({
  session, dismissalConfirmation, onBack, onClose, onKeepWorking,
  onConfirmDismissal, onOpen, onDefect,
}: AddPanelProps): React.ReactElement {
  const { state } = session;
  const id = useId();
  const busy = state.mutation.kind === "Running";
  const creatingDestination = busy && state.mutation.kind === "Running" &&
    state.mutation.operation.kind === "CreateDestination";
  const drafts = state.items.filter((item): item is Extract<AddItem, { kind: "Draft" }> => item.kind === "Draft");
  const accepted = state.items.filter((item): item is Extract<AddItem, { kind: "Accepted" }> => item.kind === "Accepted");
  const uniqueAcceptedMediaIds = [...new Set(accepted.map((item) => item.result.mediaId))];
  const [sourceExpanded, setSourceExpanded] = useState(state.items.length === 0 || state.urlInput.text.trim() !== "");
  const [dragActive, setDragActive] = useState(false);
  const [placementEditor, setPlacementEditor] = useState<PlacementEditor | null>(null);
  const [creationError, setCreationError] = useState<EditorError | null>(null);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceFocusRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const addMoreRef = useRef<HTMLButtonElement>(null);
  const keepWorkingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dismissalConfirmation) requestAnimationFrame(() => keepWorkingRef.current?.focus());
  }, [dismissalConfirmation]);

  function runSessionCommand(command: () => Promise<void>) {
    void command().catch(onDefect);
  }
  function focusQueue() {
    requestAnimationFrame(() => queueRef.current?.focus());
  }
  function reviewUrls(event: React.FormEvent) {
    event.preventDefault();
    if (!session.reviewUrls()) return;
    setSourceExpanded(false);
    focusQueue();
  }
  function stageFiles({ files, input }: { files: readonly File[]; input?: HTMLInputElement }) {
    if (!session.stageFiles(files)) return;
    if (input) input.value = "";
    setSourceExpanded(false);
    focusQueue();
  }
  function removeItem(itemId: string) {
    const index = state.items.findIndex((item) => item.id === itemId);
    const focusId = state.items[index + 1]?.id ?? state.items[index - 1]?.id;
    session.removeItem(itemId);
    requestAnimationFrame(() => {
      const target = focusId && queueRef.current?.querySelector<HTMLElement>(
        `[data-add-item-id="${focusId}"] button:not(:disabled)`,
      );
      if (target) target.focus();
      else (addMoreRef.current ?? sourceFocusRef.current)?.focus();
    });
  }
  function openPlacementEditor(editor: PlacementEditor) {
    setCreationError(null);
    setPlacementEditor(editor);
    runSessionCommand(() => session.refreshPlacements(editor.mediaIds));
  }
  async function createDestination(name: string): Promise<LibraryDestinationSelection> {
    try {
      return await session.createDestination(name);
    } catch (error) {
      if (isLibraryDestinationDefect(error)) onDefect(error);
      throw error;
    }
  }
  async function createAndAdd(name: string, mediaIds: readonly string[]) {
    setCreationError(null);
    try {
      await session.createAndPlace({ name, mediaIds });
    } catch (error) {
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      try {
        const content = libraryRequestErrorMessage(error, { title: "Library couldn’t be created", request: "LibraryCreate" });
        setCreationError({
          content,
          onRetry: isApiError(error) && apiTransportFeedback(error, content.title) !== null
            ? () => { void createAndAdd(name, mediaIds); } : null,
        });
      } catch (defect) {
        onDefect(defect);
      }
    }
  }
  function destinationField(label: string, selected: readonly LibraryDestinationSelection[], onChange: (next: readonly LibraryDestinationSelection[]) => void) {
    return (
      <LibraryDestinationField
        label={label}
        emptyLabel="No additional libraries"
        selected={selected}
        onChange={onChange}
        interaction={creatingDestination ? { kind: "Creating" } : busy ? { kind: "Disabled" } : { kind: "Enabled" }}
        onCreateDestination={createDestination}
        layer="palette"
      />
    );
  }

  const editorPlacements = placementEditor?.mediaIds.map((mediaId) => state.placementByMediaId.get(mediaId))
    .filter((placement) => placementEditor.kind === "Row" || placement?.kind !== "Unavailable") ?? [];
  const loadingPlacements = editorPlacements.some((placement) => !placement || placement.kind === "Loading" || placement.kind === "Queued");
  const failure = editorPlacements.find((placement) => placement?.kind === "Uncertain") ??
    editorPlacements.find((placement) => placement?.kind === "LoadFailed" || placement?.kind === "Refused" || placement?.kind === "Unavailable");
  const placementError: EditorError | null = failure &&
    (failure.kind === "Uncertain" || failure.kind === "LoadFailed" || failure.kind === "Refused" || failure.kind === "Unavailable")
      ? {
          content: failure.feedback,
          onRetry: failure.kind === "Uncertain" && placementEditor
            ? () => runSessionCommand(() => session.retryPlacements(placementEditor.mediaIds))
            : failure.kind === "LoadFailed" && placementEditor
              ? () => runSessionCommand(() => session.refreshPlacements(placementEditor.mediaIds)) : null,
        } : null;
  const activePlacement = editorPlacements.find((placement) => placement?.kind === "Updating" || placement?.kind === "Queued");
  const pendingDestinationKey = activePlacement?.kind === "Updating" || activePlacement?.kind === "Queued"
    ? libraryPlacementDestinationKey(activePlacement.command.destination) : null;
  const presentedPlacements = new Map<LibraryPlacementDestinationKey, LibraryPlacementOption>();
  for (const placement of editorPlacements) {
    for (const option of librariesForPlacement(placement)) {
      if (placementEditor?.kind !== "Row") {
        const relation = placementEditor?.kind === "BulkAdd" ? "Absent" : "Direct";
        if (option.availability.kind !== "Available" || option.relation.kind !== relation) continue;
      }
      const key = libraryPlacementDestinationKey(option.destination);
      if (!presentedPlacements.has(key)) presentedPlacements.set(key, option);
    }
  }
  const activePlacementMediaIds = state.mutation.kind === "Running" && state.mutation.operation.kind === "Placement"
    ? new Set(state.mutation.operation.mediaIds) : new Set<string>();
  const unknown = state.items.filter((item) => item.kind === "AcceptanceUnresolved").length;
  const attention = state.items.filter((item) => item.kind === "Invalid" || item.kind === "Rejected").length;
  const liveStatus = busy ? mutationLabel(state) : state.intakeFeedback ? feedbackStatus(state.intakeFeedback)
    : state.urlInput.feedback ? feedbackStatus(state.urlInput.feedback)
      : `${drafts.length} ready, ${accepted.length} accepted, ${unknown} status unknown, ${attention} need attention.`;

  const sourceEntry = (
    <section className={styles.sourceEntry} aria-label="Add sources">
      <form className={styles.urlForm} onSubmit={reviewUrls}>
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
          aria-describedby={state.urlInput.feedback ? `${id}-url-feedback` : `${id}-url-help`}
          onChange={(event) => session.setUrlText(event.target.value)}
          placeholder="Paste links to articles, videos, PDFs, or EPUBs"
          rows={3}
        />
        <div className={styles.sourceActions}>
          <p id={state.urlInput.feedback ? `${id}-url-feedback` : `${id}-url-help`}>
            {state.urlInput.feedback?.title ?? "One per line, or paste text containing links."}
          </p>
          <Button type="submit" variant="primary" size="sm" disabled={busy || !state.urlInput.text.trim()}>
            Review links
          </Button>
        </div>
      </form>
      <div
        className={`${styles.fileDrop}${dragActive ? ` ${styles.fileDropActive}` : ""}`}
        onDragEnter={(event) => {
          if (!isSupportedDrop(event) || busy) return;
          event.preventDefault();
          dragDepthRef.current += 1;
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!isSupportedDrop(event) || busy) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!isSupportedDrop(event)) return;
          event.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragActive(false);
        }}
        onDrop={(event) => {
          if (!isSupportedDrop(event) || busy) return;
          event.preventDefault();
          dragDepthRef.current = 0;
          setDragActive(false);
          stageFiles({ files: Array.from(event.dataTransfer.files) });
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          className={styles.fileInput}
          aria-label="Choose PDF or EPUB files"
          disabled={busy}
          onChange={(event) => stageFiles({ files: Array.from(event.target.files ?? []), input: event.currentTarget })}
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
      {state.items.length === 0 || drafts.length === 0
        ? destinationField("Libraries", state.defaultDestinations, session.setDefaultDestinations) : null}
    </section>
  );

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <Button variant="ghost" size="sm" iconOnly onClick={onBack} aria-label="Back">
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <div className={styles.heading}>
          <h2 ref={headingRef} tabIndex={-1} data-add-heading="true">Add content</h2>
          <p>Review sources, then add them when you are ready.</p>
        </div>
        <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Close Add content">
          <X size={16} aria-hidden="true" />
        </Button>
      </header>
      <div className={styles.body}>
        {state.items.length === 0 || sourceExpanded ? sourceEntry : (
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
              `Libraries for all ${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`,
              state.defaultDestinations, session.setDefaultDestinations,
            )}
          </section>
        ) : null}
        {state.intakeFeedback ? <p className={styles.intakeFeedback}>{state.intakeFeedback.title}</p> : null}
        {state.items.length > 0 ? (
          <div ref={queueRef} className={styles.queue} tabIndex={-1} data-add-focus="queue" aria-label="Items to add">
            {state.items.map((item) => {
              const feedback = item.kind === "Invalid" || item.kind === "Rejected" || item.kind === "AcceptanceUnresolved" ? item.feedback : null;
              const feedbackId = feedback ? `${id}-${item.id}-feedback` : undefined;
              const mediaId = item.kind === "Accepted" ? item.result.mediaId : null;
              const label = itemLabel(item);
              return (
                <article key={item.id} className={styles.queueItem} data-add-item-id={item.id} aria-describedby={feedbackId}>
                  <div className={styles.itemIcon} aria-hidden="true">
                    {itemSource(item).kind === "File" ? <FileText size={16} /> : <Link size={16} />}
                  </div>
                  <div className={styles.itemMain}>
                    <span className={styles.itemLabel} title={label}>{label}</span>
                    <span className={styles.itemStatus}>{itemStatus(item)}</span>
                    {mediaId && activePlacementMediaIds.has(mediaId) ? (
                      <span className={styles.placementStatus}>Updating libraries…</span>
                    ) : null}
                    {feedback ? (
                      <span id={feedbackId} className={styles.itemFeedback} data-tone={feedback.tone}>{feedbackStatus(feedback)}</span>
                    ) : null}
                  </div>
                  <div className={styles.itemActions}>
                    {item.kind === "Draft" ? destinationField("Libraries", item.intent.destinations,
                      (next) => session.setItemDestinations(item.id, next)) : null}
                    {item.kind === "Rejected" ? (
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => session.restageItem(item.id)}>Restage</Button>
                    ) : null}
                    {item.kind === "AcceptanceUnresolved" ? (
                      <>
                        <Button variant="secondary" size="sm" disabled={busy}
                          onClick={() => runSessionCommand(() => session.reconcileAcceptance(item.id))}>
                          {item.reason === "UploadIncomplete" ? "Retry upload" : "Check status"}
                        </Button>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => session.restageItem(item.id)}>Restage as new</Button>
                      </>
                    ) : null}
                    {mediaId ? (
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => onOpen({ kind: "InternalHref", href: `/media/${mediaId}` })}>Open</Button>
                    ) : null}
                    {item.kind === "Accepted" ? (
                      <Button variant="secondary" size="sm" disabled={busy}
                        onClick={(event) => openPlacementEditor({
                          kind: "Row", mediaIds: [item.result.mediaId], title: `Libraries for ${label}`, anchorEl: event.currentTarget,
                        })}>
                        Libraries
                      </Button>
                    ) : null}
                    {item.kind === "Invalid" || item.kind === "Draft" || item.kind === "Rejected" || item.kind === "AcceptanceUnresolved" ? (
                      <Button variant="ghost" size="sm" iconOnly disabled={busy} onClick={() => removeItem(item.id)} aria-label={`Remove ${label}`}>
                        <X size={14} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {accepted.length > 0 ? (
          <section className={styles.acceptedSummary} aria-label="Added items">
            <p>{accepted.length} {accepted.length === 1 ? "item" : "items"} added</p>
            <div>
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={(event) => openPlacementEditor({
                  kind: "BulkAdd", mediaIds: uniqueAcceptedMediaIds, title: "Add all to libraries", anchorEl: event.currentTarget,
                })}>
                Add all to…
              </Button>
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={(event) => openPlacementEditor({
                  kind: "BulkRemove", mediaIds: uniqueAcceptedMediaIds, title: "Remove all from libraries", anchorEl: event.currentTarget,
                })}>
                Remove all from…
              </Button>
            </div>
          </section>
        ) : null}
      </div>
      <div className={styles.liveStatus} role="status" aria-live="polite">{liveStatus}</div>
      <footer className={styles.footer}>
        <Button variant="primary" size="md" loading={busy} onClick={() => {
          if (busy) return;
          if (drafts.length > 0) runSessionCommand(session.submit);
          else onClose();
        }}>
          {busy ? mutationLabel(state) : drafts.length > 0
            ? `Add ${drafts.length} ${drafts.length === 1 ? "item" : "items"}` : "Done"}
        </Button>
      </footer>
      <Dialog
        open={dismissalConfirmation !== null}
        historyDismiss
        title={dismissalConfirmation?.kind === "Stop" ? "Stop active work?" : "Discard unfinished work?"}
        onClose={onKeepWorking}
      >
        {dismissalConfirmation ? (
          <div className={styles.confirmationBody}>
            <p>{dismissalConfirmation.kind === "Stop"
              ? "Server changes that already committed may remain; unfinished upload bytes may not."
              : "Unsubmitted sources and unresolved outcomes will be lost."}</p>
            <div className={styles.confirmationActions}>
              <Button ref={keepWorkingRef} variant="secondary" size="sm" onClick={onKeepWorking}>Keep working</Button>
              <Button variant="danger" size="sm" onClick={onConfirmDismissal}>{dismissalConfirmation.actionLabel}</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
      <LibraryChooserSurface
        active={placementEditor !== null}
        onClose={() => { setPlacementEditor(null); setCreationError(null); }}
        layer="palette"
        anchor={() => placementEditor?.anchorEl ?? null}
        returnFocusFallback={() => headingRef.current}
        title={placementEditor?.title ?? "Libraries"}
        focusKey={placementEditor?.anchorEl}
      >
        {placementEditor ? (
          <LibraryEntryEditor
            placements={[...presentedPlacements.values()]}
            loading={loadingPlacements}
            busy={busy}
            creating={creatingDestination}
            pendingDestinationKey={pendingDestinationKey}
            error={creationError ?? placementError}
            onToggle={(destination) => {
              const option = presentedPlacements.get(libraryPlacementDestinationKey(destination));
              if (!option || option.relation.kind === "Inherited") return;
              setCreationError(null);
              runSessionCommand(() => session.runPlacement({
                mediaIds: placementEditor.mediaIds,
                command: { kind: option.relation.kind === "Absent" ? "Add" : "Remove", destination },
              }));
            }}
            onCreateLibrary={placementEditor.kind === "BulkRemove" || editorPlacements.length === 0 ? null
              : (name) => { void createAndAdd(name, placementEditor.mediaIds); }}
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
